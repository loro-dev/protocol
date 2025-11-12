import { EphemeralStore } from "loro-crdt";
import {
  CrdtType,
  MessageType,
  JoinResponseOk,
} from "loro-protocol";
import type { CrdtServerAdaptor } from "../types";

export interface LoroPersistentStoreServerAdaptorConfig {
  timeout?: number;
}

export class LoroPersistentStoreServerAdaptor implements CrdtServerAdaptor {
  readonly crdtType = CrdtType.LoroEphemeralStorePersisted;
  private readonly timeout: number;

  constructor(config: LoroPersistentStoreServerAdaptorConfig = {}) {
    this.timeout = config.timeout ?? 10_000;
  }

  createEmpty(): Uint8Array {
    const store = new EphemeralStore(this.timeout);
    try {
      return store.encodeAll();
    } finally {
      store.inner.free();
    }
  }

  handleJoinRequest(
    documentData: Uint8Array,
    _clientVersion: Uint8Array,
  ): { response: JoinResponseOk, updates?: Uint8Array[] } {
    const response: JoinResponseOk = {
      type: MessageType.JoinResponseOk,
      crdt: this.crdtType,
      roomId: "",
      permission: "write",
      version: new Uint8Array(),
    };

    const updates = documentData.length > 0 ? [documentData] : undefined;
    return { response, updates };
  }

  applyUpdates(
    documentData: Uint8Array,
    updates: Uint8Array[],
  ): Uint8Array {
    const store = new EphemeralStore(this.timeout);
    if (documentData.length > 0) {
      store.apply(documentData);
    }
    for (const update of updates) {
      if (update.length > 0) {
        store.apply(update);
      }
    }

    const newDocumentData = store.encodeAll();
    return newDocumentData;
  }

  getVersion(_documentData: Uint8Array): Uint8Array {
    return new Uint8Array();
  }

  merge(documents: Uint8Array[]): Uint8Array {
    const store = new EphemeralStore(this.timeout);
    for (const data of documents) {
      if (data.length > 0) {
        store.apply(data);
      }
    }
    try {
      return store.encodeAll();
    } finally {
      store.destroy();
      store.inner.free();
    }
  }
}

