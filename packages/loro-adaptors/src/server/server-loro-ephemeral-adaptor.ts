import { EphemeralStore } from "loro-crdt";
import {
  CrdtType,
  Permission,
  MessageType,
  JoinResponseOk,
  UpdateError,
  UpdateErrorCode,
} from "loro-protocol";
import type { CrdtServerAdaptor } from "../types";

export interface LoroEphemeralServerAdaptorConfig {
  timeout?: number;
}

export class LoroEphemeralServerAdaptor implements CrdtServerAdaptor {
  readonly crdtType = CrdtType.LoroEphemeralStore;
  private readonly timeout: number;

  constructor(config: LoroEphemeralServerAdaptorConfig = {}) {
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
    permission: Permission
  ): {
    response: JoinResponseOk;
    updates?: Uint8Array[];
  } {
    const response: JoinResponseOk = {
      type: MessageType.JoinResponseOk,
      crdt: this.crdtType,
      roomId: "",
      permission,
      version: new Uint8Array(),
    };

    const updates = documentData.length > 0 ? [documentData] : undefined;
    return { response, updates };
  }

  applyUpdates(
    documentData: Uint8Array,
    updates: Uint8Array[],
    permission: Permission
  ): {
    success: boolean;
    newDocumentData?: Uint8Array;
    error?: UpdateError;
    broadcastUpdates?: Uint8Array[];
  } {
    if (permission === "read") {
      return {
        success: false,
        error: {
          type: MessageType.UpdateError,
          crdt: this.crdtType,
          roomId: "",
          code: UpdateErrorCode.PermissionDenied,
          message: "Read-only permission, cannot apply updates",
        },
      };
    }

    const store = new EphemeralStore(this.timeout);
    const broadcastUpdates: Uint8Array[] = [];

    try {
      if (documentData.length > 0) {
        store.apply(documentData);
      }
      for (const update of updates) {
        if (update.length > 0) {
          store.apply(update);
          broadcastUpdates.push(update);
        }
      }

      const newDocumentData = store.encodeAll();

      return {
        success: true,
        newDocumentData,
        broadcastUpdates:
          broadcastUpdates.length > 0 ? broadcastUpdates : undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          type: MessageType.UpdateError,
          crdt: this.crdtType,
          roomId: "",
          code: UpdateErrorCode.InvalidUpdate,
          message: error instanceof Error ? error.message : "Invalid update",
        },
      };
    } finally {
      store.destroy();
      store.inner.free();
    }
  }

  getVersion(_documentData: Uint8Array): Uint8Array {
    return new Uint8Array();
  }

  getSize(documentData: Uint8Array): number {
    return documentData.length;
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

export const loroEphemeralServerAdaptor = new LoroEphemeralServerAdaptor();
