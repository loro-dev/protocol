import type { CrdtServerAdaptor } from "loro-adaptors";
import {
  CrdtType,
  JoinResponseOk,
  MessageType,
} from "loro-protocol";
import { EloDoc } from "./elo-doc";


export class EloServerAdaptor implements CrdtServerAdaptor {
  readonly crdtType = CrdtType.Elo;

  createEmpty(): Uint8Array {
    return new Uint8Array();
  }

  handleJoinRequest(
    documentData: Uint8Array,
    clientVersion: Uint8Array,
  ): {
    response: JoinResponseOk;
    updates?: Uint8Array[];
  } {
    const doc = new EloDoc();
    const load = doc.loadFromEncodedState(documentData);
    if (!load.ok) {
      console.warn("[ELO] failed to load indexed state:", load.error);
    }

    const response: JoinResponseOk = {
      type: MessageType.JoinResponseOk,
      crdt: this.crdtType,
      roomId: "",
      permission: "write",
      version: doc.getVersionBytes(),
    };

    const updates = doc.selectBackfillBatches(clientVersion);

    return {
      response,
      updates: updates.length ? updates : undefined,
    };
  }

  applyUpdates(
    documentData: Uint8Array,
    updates: Uint8Array[],
  ): Uint8Array {
    const doc = new EloDoc();
    const load = doc.loadFromEncodedState(documentData);
    if (!load.ok) {
      throw new Error(load.error, { cause: load.error });
    }

    const broadcastUpdates: Uint8Array[] = [];

    for (const update of updates) {
      if (!update.length) continue;
      const res = doc.indexBatch(update);
      if (!res.ok) {
        throw new Error(res.error, { cause: res.error });
      }
      broadcastUpdates.push(update);
    }

    const newDocumentData = doc.exportIndexedRecords();
    return newDocumentData;
  }

  getVersion(documentData: Uint8Array): Uint8Array {
    const doc = new EloDoc();
    const load = doc.loadFromEncodedState(documentData);
    if (!load.ok) {
      console.warn("[ELO] failed to load indexed state:", load.error);
      return new Uint8Array();
    }
    return doc.getVersionBytes();
  }

  merge(documents: Uint8Array[]): Uint8Array {
    const doc = new EloDoc();
    for (const data of documents) {
      if (!data.length) continue;
      const res = doc.indexBatch(data);
      if (!res.ok) {
        console.warn("[ELO] failed to merge indexed state:", res.error);
      }
    }
    return doc.exportIndexedRecords();
  }
}
