import { LoroDoc, VersionVector } from "loro-crdt";
import { CrdtType, JoinError, JoinResponseOk, UpdateError } from "loro-protocol";
import type { CrdtAdaptorContext, CrdtDocAdaptor } from "./types";

export interface LoroAdaptorConfig {
  recordTimestamp?: boolean;
  changeMergeInterval?: number;
  peerId?: number | bigint | string;
  onImportError?: (error: Error, data: Uint8Array[]) => void;
  onUpdateError?: (error: UpdateError) => void;
}

export class LoroAdaptor implements CrdtDocAdaptor {
  readonly crdtType = CrdtType.Loro;

  private doc: LoroDoc;
  private config: LoroAdaptorConfig;
  private ctx?: CrdtAdaptorContext;
  private localUpdateUnsubscribe?: () => void;
  private destroyed = false;
  private initServerVersion?: VersionVector;
  private reachServerVersionPromise: { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void };
  private hasReachedServerVersion = false;

  constructor(doc?: LoroDoc, config: LoroAdaptorConfig = {}) {
    this.doc = doc || new LoroDoc();
    this.config = config;

    if (config.peerId !== undefined) {
      const pid = typeof config.peerId === "string" ? Number(config.peerId) : config.peerId;
      this.doc.setPeerId(pid);
    }
    if (config.recordTimestamp !== undefined) {
      this.doc.setRecordTimestamp(config.recordTimestamp);
    }
    if (config.changeMergeInterval !== undefined) {
      this.doc.setChangeMergeInterval(config.changeMergeInterval);
    }
    {
      let resolve!: () => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res; reject = rej;
      });
      this.reachServerVersionPromise = { promise, resolve, reject };
      void this.reachServerVersionPromise.promise.then(() => {
        this.hasReachedServerVersion = true;
      });
    }
  }

  waitForReachingServerVersion(): Promise<void> {
    return this.reachServerVersionPromise.promise;
  }

  cmpVersion(v: Uint8Array): 0 | 1 | -1 | undefined {
    const vv = VersionVector.decode(v);
    return this.doc.version().compare(vv) as 0 | 1 | -1 | undefined;
  }

  handleJoinErr?: ((err: JoinError) => Promise<void>) | undefined;

  getDoc(): LoroDoc {
    return this.doc;
  }

  setCtx(ctx: CrdtAdaptorContext): void {
    this.ctx = ctx;
    this.localUpdateUnsubscribe = this.doc.subscribeLocalUpdates(updates => {
      if (!this.destroyed && this.ctx) {
        this.ctx.send([updates]);
      }
    });
  }

  getVersion(): Uint8Array {
    // TODO: NOTE: should we treat frontiers as a special version in the CrdtDocAdaptor?
    return this.doc.version().encode();
  }

  getAlternativeVersion(_currentVersion: Uint8Array): Uint8Array | undefined {
    return undefined;
  }

  async handleJoinOk(res: JoinResponseOk): Promise<void> {
    if (this.destroyed) return;

    try {
      let serverVersion: VersionVector;

      if (res.version.length > 0) {
        try {
          serverVersion = VersionVector.decode(res.version);
          this.initServerVersion = serverVersion;
        } catch {
          throw new Error("Invalid version format received");
        }

        const comparison = this.doc.version().compare(serverVersion);
        if (comparison != null && comparison >= 0) {
          this.reachServerVersionPromise.resolve();
        }

        if (comparison == null || comparison === 1) {
          const updates = this.doc.export({ mode: "update", from: serverVersion });
          this.ctx?.send([updates]);
        }
      } else {
        const updates = this.doc.export({ mode: "snapshot" });
        this.ctx?.send([updates]);
      }
    } catch (error) {
      this.ctx!.onJoinFailed(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  applyUpdate(updates: Uint8Array[]): void {
    if (this.destroyed || !updates?.length) return;

    try {
      const status = this.doc.importBatch(updates);
      if (status.pending == null) {
        // Pending updates may occur when concurrent changes happen
      }
    } catch (error) {
      this.ctx!.onImportError(error instanceof Error ? error : new Error(String(error)), updates);
    }

    if (this.initServerVersion && !this.hasReachedServerVersion) {
      const comparison = this.doc.version().compare(this.initServerVersion);
      if (comparison != null && comparison >= 0) {
        this.reachServerVersionPromise.resolve();
      }
    }
  }

  handleUpdateError(error: UpdateError): void {
    if (this.config.onUpdateError) {
      this.config.onUpdateError(error);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.localUpdateUnsubscribe) {
      this.localUpdateUnsubscribe();
      this.localUpdateUnsubscribe = undefined;
    }
    this.ctx = undefined;
  }
}

export function createLoroAdaptor(config: LoroAdaptorConfig = {}): LoroAdaptor {
  return new LoroAdaptor(new LoroDoc(), config);
}

export function createLoroAdaptorFromDoc(doc: LoroDoc, config: LoroAdaptorConfig = {}): LoroAdaptor {
  return new LoroAdaptor(doc, config);
}

