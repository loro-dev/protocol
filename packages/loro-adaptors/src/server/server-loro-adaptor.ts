import { LoroDoc, VersionVector } from "loro-crdt";
import {
  CrdtType,
  MessageType,
  JoinResponseOk,
} from "loro-protocol";
import type { CrdtServerAdaptor } from "../types";

export class LoroServerAdaptor implements CrdtServerAdaptor {
  readonly crdtType = CrdtType.Loro;

  createEmpty(): Uint8Array {
    const doc = new LoroDoc();
    const snapshot = doc.export({ mode: "snapshot" });
    doc.free();
    return snapshot;
  }

  handleJoinRequest(
    documentData: Uint8Array,
    clientVersion: Uint8Array,
  ): {
    response: JoinResponseOk;
    updates?: Uint8Array[];
  } {
    const doc = new LoroDoc();
    let serverVersion: undefined | VersionVector;
    try {
      if (documentData.length > 0) {
        doc.import(documentData);
      }

      serverVersion = doc.version();
      let updates: Uint8Array[] | undefined;

      if (clientVersion.length > 0) {
        const clientVV = VersionVector.decode(clientVersion);
        const updateData = doc.export({
          mode: "update",
          from: clientVV,
        });
        updates = [updateData];
      } else {
        updates = [documentData];
      }

      const response: JoinResponseOk = {
        type: MessageType.JoinResponseOk,
        crdt: this.crdtType,
        roomId: "",
        permission: "write",
        version: serverVersion.encode(),
      };

      return { response, updates };
    } finally {
      doc.free();
      serverVersion?.free();
    }
  }

  applyUpdates(
    documentData: Uint8Array,
    updates: Uint8Array[],
  ): Uint8Array {
    const doc = new LoroDoc();
    try {
      if (documentData.length > 0) {
        doc.import(documentData);
      }
      for (const update of updates) {
        if (update.length > 0) {
          doc.import(update);
        }
      }
      return doc.export({ mode: "snapshot" });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Invalid update", { cause: error });
    } finally {
      doc.free();
    }
  }

  getVersion(documentData: Uint8Array): Uint8Array {
    const doc = new LoroDoc();
    let version: undefined | VersionVector;
    try {
      if (documentData.length > 0) {
        doc.import(documentData);
      }
      version = doc.version();
      return version.encode();
    } finally {
      doc.free();
      version?.free();
    }
  }

  merge(documents: Uint8Array[]): Uint8Array {
    const doc = new LoroDoc();
    try {
      for (const docData of documents) {
        if (docData.length > 0) {
          doc.import(docData);
        }
      }
      return doc.export({ mode: "snapshot" });
    } finally {
      doc.free();
    }
  }
}
