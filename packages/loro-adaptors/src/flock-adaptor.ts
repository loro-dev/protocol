import { Flock, decodeVersionVector, encodeVersionVector } from "@loro-dev/flock";
import {
  CrdtType,
  JoinResponseOk,
} from "loro-protocol";
import type { CrdtAdaptorContext, CrdtDocAdaptor } from "./types";

type FlockVersion = ReturnType<Flock["version"]>;
type FlockExportBundle = Awaited<ReturnType<Flock["exportJson"]>>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function compareVersions(
  a: FlockVersion,
  b: FlockVersion
): -1 | 0 | 1 | undefined {
  let greater = false;
  let less = false;
  const peers = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const peer of peers) {
    const left = a[peer];
    const right = b[peer];
    const leftCounter = left?.logicalCounter ?? 0;
    const rightCounter = right?.logicalCounter ?? 0;
    if (leftCounter > rightCounter) {
      greater = true;
    } else if (leftCounter < rightCounter) {
      less = true;
    } else {
      const leftTime = left?.physicalTime ?? 0;
      const rightTime = right?.physicalTime ?? 0;
      if (leftTime > rightTime) greater = true;
      else if (leftTime < rightTime) less = true;
    }
    if (greater && less) return undefined;
  }
  if (greater) return 1;
  if (less) return -1;
  return 0;
}

function serializeBundle(bundle: FlockExportBundle): Uint8Array {
  return encoder.encode(JSON.stringify(bundle));
}

function deserializeBundle(bytes: Uint8Array): FlockExportBundle {
  if (!bytes.length) return { version: 0, entries: {} };
  try {
    const parsed = JSON.parse(decoder.decode(bytes));
    if (parsed && typeof parsed === "object") {
      return parsed as FlockExportBundle;
    }
  } catch {
    // ignore malformed payloads
  }
  return { version: 0, entries: {} };
}

export interface FlockAdaptorConfig {
  onImportError?: (error: Error, data: Uint8Array[]) => void;
  onUpdateError?: (
    updates: Uint8Array[],
    errorCode: number,
    reason?: string
  ) => void;
}

/**
 * Bridges a Flock replica with the loro-adaptors {@link CrdtDocAdaptor} interface.
 */
export class FlockAdaptor implements CrdtDocAdaptor {
  readonly crdtType = CrdtType.Flock;

  private readonly flock: Flock;
  private readonly config: FlockAdaptorConfig;
  private ctx?: CrdtAdaptorContext;
  private unsubscribe?: () => void;
  private destroyed = false;
  private initServerVersion?: FlockVersion;
  private hasReachedServerVersion = false;
  private lastExportVersion: FlockVersion;
  private readonly reachServerVersionPromise: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
  };

  constructor(flock: Flock, config: FlockAdaptorConfig = {}) {
    this.flock = flock;
    this.config = config;
    this.lastExportVersion = this.flock.version();

    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.reachServerVersionPromise = { promise, resolve, reject };
  }

  waitForReachingServerVersion(): Promise<void> {
    return this.reachServerVersionPromise.promise;
  }

  getDoc(): Flock {
    return this.flock;
  }

  cmpVersion(versionBytes: Uint8Array): 0 | 1 | -1 | undefined {
    try {
      const remote = decodeVersionVector(versionBytes);
      return compareVersions(this.flock.version(), remote);
    } catch {
      return undefined;
    }
  }

  setCtx(ctx: CrdtAdaptorContext): void {
    this.ctx = ctx;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.unsubscribe = this.flock.subscribe(async batch => {
      if (this.destroyed) return;
      if (batch.source !== "local") return;
      if (!this.ctx) return;
      const exported = await this.flock.exportJson({ from: this.lastExportVersion, peerId: this.flock.peerId() });
      const update = serializeBundle(exported);
      this.lastExportVersion = this.flock.version();
      this.ctx.send([update]);
    });
  }

  getVersion(): Uint8Array {
    return encodeVersionVector(this.flock.version());
  }

  getAlternativeVersion(): Uint8Array | undefined {
    return undefined;
  }

  onUpdateError(
    updates: Uint8Array[],
    errorCode: number,
    reason?: string
  ): void {
    this.config.onUpdateError?.(updates, errorCode, reason);
  }

  async handleJoinOk(res: JoinResponseOk): Promise<void> {
    if (this.destroyed) return;
    try {
      const serverVersion = decodeVersionVector(res.version);
      this.initServerVersion = serverVersion;
      const comparison = compareVersions(this.flock.inclusiveVersion(), serverVersion);
      if (comparison != null && comparison >= 0) {
        this.markReachedServerVersion();
      }

      if (!res.version.length) {
        const snapshot = serializeBundle(this.flock.exportJson());
        this.lastExportVersion = (this.flock.version());
        this.ctx?.send([snapshot]);
        return;
      }

      if (comparison == null || comparison === 1) {
        const delta = serializeBundle(this.flock.exportJson(serverVersion));
        this.lastExportVersion = (this.flock.version());
        this.ctx?.send([delta]);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.ctx?.onJoinFailed(err.message);
      this.reachServerVersionPromise.reject(err);
      throw err;
    }
  }

  applyUpdate(updates: Uint8Array[]): void {
    if (this.destroyed || !updates.length) return;
    for (const update of updates) {
      try {
        const bundle = deserializeBundle(update);
        this.flock.importJson(bundle);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.config.onImportError?.(err, [update]);
        this.ctx?.onImportError(err, [update]);
      }
    }
    this.lastExportVersion = (this.flock.version());
    if (this.initServerVersion && !this.hasReachedServerVersion) {
      const comparison = compareVersions(
        this.flock.inclusiveVersion(),
        this.initServerVersion
      );
      if (comparison != null && comparison >= 0) {
        this.markReachedServerVersion();
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.ctx = undefined;
  }

  private markReachedServerVersion(): void {
    if (this.hasReachedServerVersion) return;
    this.hasReachedServerVersion = true;
    this.reachServerVersionPromise.resolve();
  }
}
