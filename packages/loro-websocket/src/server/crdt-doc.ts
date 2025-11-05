import { EphemeralStore, LoroDoc, VersionVector } from "loro-crdt";
import { CrdtType } from "loro-protocol";
import { EloDoc } from "./elo-doc";

/**
 * Backfill: the server sending a client just the updates it is missing
 * so the client can catch up from its known version to the room’s current
 * state without a full resync.
 *
 * - Loro: compute deltas from the client's VersionVector.
 * - Elo (E2EE): select encrypted delta-span containers the client hasn't seen;
 *   the server never decrypts and only indexes headers.
 * - Ephemeral: no version vector; send current store state.
 */
export interface CrdtDoc {
  getVersion(): Uint8Array;
  computeBackfill(clientVersion: Uint8Array): Uint8Array[] | null;
  applyUpdates(
    updates: Uint8Array[]
  ): { ok: true } | { ok: false; error: string };
  shouldPersist(): boolean;
  exportSnapshot(): Uint8Array | null;
  importSnapshot(data: Uint8Array): void;
  allowBackfillWhenNoOtherClients(): boolean;
}

export type CrdtDocConstructor = () => CrdtDoc;

const registry = new Map<CrdtType, CrdtDocConstructor>();

export function registerCrdtDoc(type: CrdtType, ctor: CrdtDocConstructor) {
  registry.set(type, ctor);
}

export function getCrdtDocConstructor(
  type: CrdtType
): CrdtDocConstructor | undefined {
  return registry.get(type);
}

export function unregisterCrdtDoc(type: CrdtType): void {
  registry.delete(type);
}

// Default implementations

class LoroCrdtDoc implements CrdtDoc {
  private doc: LoroDoc;
  constructor() {
    this.doc = new LoroDoc();
  }
  getVersion(): Uint8Array {
    return this.doc.version().encode();
  }
  computeBackfill(clientVersion: Uint8Array): Uint8Array[] | null {
    try {
      const start = clientVersion?.length
        ? VersionVector.decode(clientVersion)
        : undefined;
      if (start && this.doc.version().compare(start) === 0) {
        return null;
      }
      const bytes = start
        ? this.doc.export({ mode: "update", from: start })
        : this.doc.export({ mode: "update" });
      return [bytes];
    } catch {
      return [this.doc.export({ mode: "update" })];
    }
  }
  applyUpdates(updates: Uint8Array[]) {
    try {
      for (const u of updates) this.doc.import(u);
      return { ok: true } as const;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) } as const;
    }
  }
  shouldPersist(): boolean {
    return true;
  }
  exportSnapshot(): Uint8Array | null {
    return this.doc.export({ mode: "snapshot" });
  }
  importSnapshot(data: Uint8Array): void {
    this.doc.import(data);
  }
  allowBackfillWhenNoOtherClients(): boolean {
    // Gate backfill to reduce reconnection flakiness as before
    return false;
  }
}

class LoroEphemeralCrdtDoc implements CrdtDoc {
  private store: EphemeralStore;
  constructor() {
    this.store = new EphemeralStore();
  }
  getVersion(): Uint8Array {
    // Ephemeral store has no version vector
    return new Uint8Array();
  }
  computeBackfill(_clientVersion: Uint8Array): Uint8Array[] | null {
    // Always return full ephemeral state for backfill
    const data = this.store.encodeAll();
    return data && data.length ? [data] : null;
  }
  applyUpdates(updates: Uint8Array[]) {
    try {
      for (const u of updates) this.store.apply(u);
      return { ok: true } as const;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) } as const;
    }
  }
  shouldPersist(): boolean {
    return false;
  }
  exportSnapshot(): Uint8Array | null {
    return null;
  }
  importSnapshot(_data: Uint8Array): void {}
  allowBackfillWhenNoOtherClients(): boolean {
    return false;
  }
}

class LoroPersistentStoreCrdtDoc implements CrdtDoc {
  private store: EphemeralStore;
  constructor() {
    this.store = new EphemeralStore();
  }
  getVersion(): Uint8Array {
    return new Uint8Array();
  }
  computeBackfill(_clientVersion: Uint8Array): Uint8Array[] | null {
    const data = this.store.encodeAll();
    return data && data.length ? [data] : null;
  }
  applyUpdates(updates: Uint8Array[]) {
    try {
      for (const u of updates) this.store.apply(u);
      return { ok: true } as const;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) } as const;
    }
  }
  shouldPersist(): boolean {
    return true;
  }
  exportSnapshot(): Uint8Array | null {
    const data = this.store.encodeAll();
    return data.length ? data : null;
  }
  importSnapshot(data: Uint8Array): void {
    if (data.length) {
      this.store.apply(data);
    }
  }
  allowBackfillWhenNoOtherClients(): boolean {
    return false;
  }
}

class EloCrdtDoc implements CrdtDoc {
  private elo: EloDoc;
  constructor() {
    this.elo = new EloDoc();
  }
  getVersion(): Uint8Array {
    return this.elo.getVersionBytes();
  }
  computeBackfill(clientVersion: Uint8Array): Uint8Array[] | null {
    const batches = this.elo.selectBackfillBatches(clientVersion);
    return batches.length ? batches : null;
  }
  applyUpdates(updates: Uint8Array[]) {
    for (const batch of updates) {
      const res = this.elo.indexBatch(batch);
      if (!res.ok) return res;
    }
    return { ok: true } as const;
  }
  shouldPersist(): boolean {
    return false;
  }
  exportSnapshot(): Uint8Array | null {
    return null;
  }
  importSnapshot(_data: Uint8Array): void {}
  allowBackfillWhenNoOtherClients(): boolean {
    return true;
  }
}

// Register default CRDT doc implementations
registerCrdtDoc(CrdtType.Loro, () => new LoroCrdtDoc());
registerCrdtDoc(CrdtType.LoroEphemeralStore, () => new LoroEphemeralCrdtDoc());
registerCrdtDoc(
  CrdtType.LoroEphemeralStorePersisted,
  () => new LoroPersistentStoreCrdtDoc()
);
registerCrdtDoc(CrdtType.Elo, () => new EloCrdtDoc());
