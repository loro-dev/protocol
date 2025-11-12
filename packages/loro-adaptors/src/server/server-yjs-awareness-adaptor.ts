import {
  CrdtType,
  MessageType,
  JoinResponseOk,
} from "loro-protocol";
import type { CrdtServerAdaptor } from "../types";

export class YjsAwarenessServerAdaptor implements CrdtServerAdaptor {
  readonly crdtType = CrdtType.YjsAwareness;

  createEmpty(): Uint8Array {
    return new Uint8Array();
  }

  handleJoinRequest(
    documentData: Uint8Array,
    _clientVersion: Uint8Array,
  ): {
    response: JoinResponseOk;
    updates?: Uint8Array[];
  } {
    return {
      response: {
        type: MessageType.JoinResponseOk,
        crdt: this.crdtType,
        roomId: "",
        permission: "write",
        version: new Uint8Array(),
      },
      updates: documentData.length > 0 ? [documentData] : undefined,
    };
  }

  applyUpdates(
    documentData: Uint8Array,
    updates: Uint8Array[],
  ): Uint8Array {
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

    return merged;
  }

  getVersion(_documentData: Uint8Array): Uint8Array {
    return new Uint8Array();
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
