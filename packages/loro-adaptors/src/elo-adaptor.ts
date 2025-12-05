import { LoroDoc, VersionVector, decodeImportBlobMeta } from "loro-crdt";
import {
  CrdtType,
  JoinResponseOk,
  Ack,
  RoomError,
  UpdateStatusCode,
} from "loro-protocol";
import type { CrdtAdaptorContext, CrdtDocAdaptor } from "./types";
import {
  encodeEloContainer,
  encryptDeltaSpan,
  encryptSnapshot,
  decryptEloRecord,
  EloRecordKind,
} from "loro-protocol";

// Minimal placeholder to avoid requiring DOM lib in this package
interface CryptoKey { }

export interface EloAdaptorConfig {
  getPrivateKey: (
    keyId?: string
  ) => Promise<{ keyId: string; key: CryptoKey | Uint8Array }>;
  ivFactory?: () => Uint8Array;
  onDecryptError?: (
    err: Error,
    meta: { kind: "delta" | "snapshot"; keyId: string }
  ) => void;
  onAck?: (ack: Ack) => void;
  onUpdateStatus?: (ack: Ack) => void;
  onRoomError?: (err: RoomError) => void;
  onUpdateError?: (ack: Ack) => void; // legacy naming
}

export class EloAdaptor implements CrdtDocAdaptor {
  readonly crdtType = CrdtType.Elo;

  private doc: LoroDoc;
  private ctx?: CrdtAdaptorContext;
  private destroyed = false;
  private config: EloAdaptorConfig;
  private localUpdateUnsubscribe?: () => void;
  private initServerVersion?: VersionVector;
  private hasReachedServerVersion = false;
  private reachServerVersionPromise: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
  };
  private lastSentVV?: Record<string, number>;

  // Overloads to allow (config) or (doc, config)
  constructor(doc: LoroDoc, config: EloAdaptorConfig);
  constructor(config: EloAdaptorConfig);
  constructor(
    docOrConfig: LoroDoc | EloAdaptorConfig,
    maybeConfig?: EloAdaptorConfig
  ) {
    if (docOrConfig instanceof LoroDoc) {
      this.doc = docOrConfig;
      this.config = maybeConfig as EloAdaptorConfig;
    } else {
      this.doc = new LoroDoc();
      this.config = docOrConfig;
    }
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.reachServerVersionPromise = { promise, resolve, reject };
    void this.reachServerVersionPromise.promise.then(() => {
      this.hasReachedServerVersion = true;
    });
  }

  getDoc(): LoroDoc {
    return this.doc;
  }
  waitForReachingServerVersion(): Promise<void> {
    return this.reachServerVersionPromise.promise;
  }
  cmpVersion(v: Uint8Array): 0 | 1 | -1 | undefined {
    const vv = VersionVector.decode(v);
    return this.doc.version().compare(vv) as 0 | 1 | -1 | undefined;
  }

  setCtx(ctx: CrdtAdaptorContext): void {
    this.ctx = ctx;
    this.localUpdateUnsubscribe = this.doc.subscribeLocalUpdates(updates => {
      if (this.destroyed || !this.ctx) return;
      // Use the emitted local update blob as plaintext; derive header span from blob meta.
      void (async () => {
        try {
          let startVVObj: Record<string, number> | undefined;
          let endVVObj: Record<string, number> | undefined;
          try {
            const meta = decodeImportBlobMeta(updates, false);
            const start = meta.partialStartVersionVector;
            const end = meta.partialEndVersionVector;
            startVVObj = vvToObject(start);
            endVVObj = vvToObject(end);
          } catch {
            // Fallback: treat as generic forward delta packaging
          }

          const spans = computeSpansFromVV(
            startVVObj ?? this.lastSentVV ?? {},
            endVVObj ?? vvToObject(this.doc.version())
          );

          if (spans.length === 1) {
            const { keyId, key } = await this.config.getPrivateKey();
            const [span] = spans;
            if (!span) {
              throw new Error(
                "Expected delta span when packaging single update"
              );
            }
            const peerIdBytes = new TextEncoder().encode(String(span.peer));
            const iv = this.config.ivFactory
              ? this.config.ivFactory()
              : undefined;
            const { record } = await encryptDeltaSpan(
              updates,
              {
                peerId: peerIdBytes,
                start: span.start,
                end: span.start + span.length,
                keyId,
                iv,
              },
              key
            );
            const container = encodeEloContainer([record]);
            this.ctx?.send([container]);
            this.lastSentVV = endVVObj ?? vvToObject(this.doc.version());
            return;
          }

          // Otherwise, fall back to forward-delta packaging by exporting ranges
          const sent = await this.packageAndSendForwardDeltas(
            startVVObj,
            endVVObj
          );
          if (!sent) {
            await this.sendSnapshot();
          }
        } catch (err) {
          // Surface failure to host.
          console.error("ELO adaptor failed to package/send update", err);
        }
      })();
    });
  }

  getVersion(): Uint8Array {
    return this.doc.version().encode();
  }

  getAlternativeVersion(_currentVersion: Uint8Array): Uint8Array | undefined {
    return undefined;
  }

  async handleJoinOk(res: JoinResponseOk): Promise<void> {
    if (this.destroyed) return;
    try {
      const serverVersion =
        res.version.length > 0 ? VersionVector.decode(res.version) : undefined;
      this.initServerVersion = serverVersion;

      // Compute initial spans using version vectors only (avoid vvToFrontiers due to possible incomplete oplog)
      const startJson: Record<string, number> = serverVersion
        ? vvToObject(serverVersion)
        : {};
      this.lastSentVV = startJson;
      const sent = await this.packageAndSendForwardDeltas(startJson);
      if (!sent) {
        // Only send snapshot if there is no server baseline. If the server has a version
        // ahead of us, we should wait for backfill rather than sending our local snapshot.
        const sv = serverVersion ?? null;
        if (sv === null) {
          await this.sendSnapshot();
        } else {
          const cmp = this.doc.version().compare(sv);
          if (cmp != null && cmp >= 0) {
            await this.sendSnapshot();
          }
        }
      }
      if (!serverVersion) {
        // No server baseline; after sending initial state, consider ourselves at or beyond server
        this.reachServerVersionPromise.resolve();
        return;
      }

      const comparison = this.doc.version().compare(serverVersion);
      if (comparison != null && comparison >= 0) {
        this.reachServerVersionPromise.resolve();
      }
    } catch (error) {
      this.ctx!.onJoinFailed(
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  applyUpdate(updates: Uint8Array[]): void {
    if (this.destroyed || !updates?.length) return;
    for (const containerBytes of updates) {
      try {
        this.importEloContainer(containerBytes).catch(err => {
          this.ctx?.onImportError(
            err instanceof Error ? err : new Error(String(err)),
            [containerBytes]
          );
        });
      } catch (error) {
        this.ctx?.onImportError(
          error instanceof Error ? error : new Error(String(error)),
          [containerBytes]
        );
      }
    }
    if (this.initServerVersion && !this.hasReachedServerVersion) {
      const cmp = this.doc.version().compare(this.initServerVersion);
      if (cmp != null && cmp >= 0) {
        this.reachServerVersionPromise.resolve();
      }
    }
  }

  handleAck(ack: Ack): void {
    this.config.onAck?.(ack);
    if (ack.status !== UpdateStatusCode.Ok) {
      this.config.onUpdateStatus?.(ack);
      this.config.onUpdateError?.(ack);
    }
  }

  handleRoomError(err: RoomError): void {
    this.config.onRoomError?.(err);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.localUpdateUnsubscribe?.();
    this.localUpdateUnsubscribe = undefined;
    this.ctx = undefined;
  }

  private async sendSnapshot(): Promise<void> {
    const { keyId, key } = await this.config.getPrivateKey();
    const mode = "snapshot";
    const plaintext = this.doc.export({ mode });
    const vvObj = vvToObject(this.doc.version());
    const encoder = new TextEncoder();
    const vvEntries: Array<{ peerId: Uint8Array; counter: number }> =
      Object.keys(vvObj).map(peer => ({
        peerId: encoder.encode(peer),
        counter: vvObj[peer],
      }));
    const iv = this.config.ivFactory ? this.config.ivFactory() : undefined;
    const { record } = await encryptSnapshot(
      plaintext,
      { vv: vvEntries, keyId, iv },
      key
    );
    const container = encodeEloContainer([record]);
    this.ctx?.send([container]);
  }

  private async packageAndSendForwardDeltas(
    startVV?: Record<string, number>,
    endVVOverride?: Record<string, number>
  ): Promise<boolean> {
    // Compute spans using only version vectors: for each peer, [start, end)
    const start: Record<string, number> = startVV ?? this.lastSentVV ?? {};
    const end: Record<string, number> =
      endVVOverride ?? vvToObject(this.doc.version());
    const spans = computeSpansFromVV(start, end);
    if (spans.length === 0) return false;

    const { keyId, key } = await this.config.getPrivateKey();
    const records: Uint8Array[] = [];
    for (const s of spans) {
      const peer = s.peer;
      const startCounter = s.start;
      const length = s.length;
      const endCounter = startCounter + length;
      const peerIdBytes = new TextEncoder().encode(String(peer));
      const plaintext = this.doc.export({
        mode: "updates-in-range",
        spans: [
          {
            id: { peer: toPeerIdString(peer), counter: startCounter },
            len: length,
          },
        ],
      });
      const iv = this.config.ivFactory ? this.config.ivFactory() : undefined;
      const { record } = await encryptDeltaSpan(
        plaintext,
        {
          peerId: peerIdBytes,
          start: startCounter,
          end: endCounter,
          keyId,
          iv,
        },
        key
      );
      records.push(record);
    }

    if (records.length === 0) return false;
    const container = encodeEloContainer(records);
    this.ctx?.send([container]);
    this.lastSentVV = end;
    return true;
  }

  private async importEloContainer(containerBytes: Uint8Array): Promise<void> {
    const { decodeEloContainer, parseEloRecordHeader } = await import(
      "loro-protocol"
    );
    const records = decodeEloContainer(containerBytes);
    for (const rec of records) {
      const header = parseEloRecordHeader(rec);
      try {
        const out = await decryptEloRecord(
          rec,
          async keyId => (await this.config.getPrivateKey(keyId)).key
        );
        // TODO: should we handle pending updates here?
        if (out.kind === EloRecordKind.Snapshot) {
          this.doc.import(out.plaintext);
        } else {
          this.doc.import(out.plaintext);
        }
      } catch (err) {
        this.config.onDecryptError?.(
          err instanceof Error ? err : new Error(String(err)),
          {
            kind: header.kind === EloRecordKind.Snapshot ? "snapshot" : "delta",
            keyId: header.keyId,
          }
        );
      }
    }
  }
}

// Compute spans from start and end version vectors represented as plain objects
// start/end: { [peerId: string]: counter }
function computeSpansFromVV(
  start: Record<string, number>,
  end: Record<string, number>
): Array<{ peer: string; start: number; length: number }> {
  const peers = new Set<string>([...Object.keys(start), ...Object.keys(end)]);
  const spans: Array<{ peer: string; start: number; length: number }> = [];
  for (const peer of peers) {
    const s = start[peer] ?? 0;
    const e = end[peer] ?? 0;
    if (e > s) {
      spans.push({ peer, start: s, length: e - s });
    }
  }
  return spans;
}

// Convert arbitrary string peer id into Loro PeerID template (numeric string)
function toPeerIdString(peer: string): `${number}` {
  if (!/^\d+$/.test(peer)) {
    throw new Error(`Invalid PeerID: ${peer}`);
  }
  return peer as `${number}`;
}

function vvToObject(vvLike: VersionVector): Record<string, number> {
  const json = vvLike.toJSON();
  const out: Record<string, number> = {};
  for (const [peer, counter] of json.entries()) {
    const k = String(peer);
    const num = typeof counter === "number" ? counter : Number(counter);
    if (!Number.isNaN(num)) out[k] = num;
  }
  return out;
}
