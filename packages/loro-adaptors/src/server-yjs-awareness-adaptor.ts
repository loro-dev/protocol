import {
  CrdtType,
  Permission,
  MessageType,
  JoinResponseOk,
  UpdateError,
  UpdateErrorCode,
} from "loro-protocol";
import type { CrdtServerAdaptor } from "./types";

export class YjsAwarenessServerAdaptor implements CrdtServerAdaptor {
  readonly crdtType = CrdtType.YjsAwareness;

  createEmpty(): Uint8Array {
    return new Uint8Array();
  }

  handleJoinRequest(
    documentData: Uint8Array,
    _clientVersion: Uint8Array,
    permission: Permission
  ): {
    response: JoinResponseOk;
    updates?: Uint8Array[];
  } {
    const updates = documentData.length > 0 ? [documentData] : undefined;

    const response: JoinResponseOk = {
      type: MessageType.JoinResponseOk,
      crdt: this.crdtType,
      roomId: "",
      permission,
      version: new Uint8Array(),
    };

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

    try {
      let total = documentData.length;
      for (const u of updates) total += u.length;
      const merged = new Uint8Array(total);
      let offset = 0;
      if (documentData.length) {
        merged.set(documentData, 0);
        offset += documentData.length;
      }
      for (const u of updates) {
        if (u.length) {
          merged.set(u, offset);
          offset += u.length;
        }
      }

      return {
        success: true,
        newDocumentData: merged,
        broadcastUpdates: updates.length > 0 ? updates : undefined,
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
    }
  }

  getVersion(_documentData: Uint8Array): Uint8Array {
    return new Uint8Array();
  }

  getSize(documentData: Uint8Array): number {
    return documentData.length;
  }

  merge(documents: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const d of documents) total += d.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const d of documents) {
      if (d.length) {
        out.set(d, offset);
        offset += d.length;
      }
    }
    return out;
  }
}

export const yjsAwarenessServerAdaptor = new YjsAwarenessServerAdaptor();
