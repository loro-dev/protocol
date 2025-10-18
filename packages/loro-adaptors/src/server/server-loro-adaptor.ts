import { LoroDoc, VersionVector } from "loro-crdt";
import {
  CrdtType,
  Permission,
  MessageType,
  JoinResponseOk,
  UpdateError,
  UpdateErrorCode,
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
    permission: Permission
  ): {
    response: JoinResponseOk;
    updates?: Uint8Array[];
  } {
    const doc = new LoroDoc();
    try {
      if (documentData.length > 0) {
        doc.import(documentData);
      }

      const serverVersion = doc.version();
      let updates: Uint8Array[] | undefined;

      if (clientVersion.length > 0) {
        try {
          const clientVV = VersionVector.decode(clientVersion);
          const comparison = serverVersion.compare(clientVV);

          if (comparison && comparison > 0) {
            const updateData = doc.export({
              mode: "update",
              from: clientVV,
            });
            updates = [updateData];
          }
        } catch {
          const snapshot = doc.export({ mode: "snapshot" });
          updates = [snapshot];
        }
      } else {
        const snapshot = doc.export({ mode: "snapshot" });
        updates = [snapshot];
      }

      const response: JoinResponseOk = {
        type: MessageType.JoinResponseOk,
        crdt: this.crdtType,
        roomId: "",
        permission,
        version: serverVersion.encode(),
      };

      return { response, updates };
    } finally {
      doc.free();
    }
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
    const doc = new LoroDoc();
    const broadcastUpdates: Uint8Array[] = [];

    try {
      if (documentData.length > 0) {
        doc.import(documentData);
      }
      for (const update of updates) {
        if (update.length > 0) {
          const importResult = doc.import(update);
          if (importResult.success) {
            broadcastUpdates.push(update);
          }
        }
      }

      const newDocumentData = doc.export({ mode: "snapshot" });

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
      doc.free();
    }
  }

  getVersion(documentData: Uint8Array): Uint8Array {
    const doc = new LoroDoc();
    try {
      if (documentData.length > 0) {
        doc.import(documentData);
      }
      return doc.version().encode();
    } finally {
      doc.free();
    }
  }

  getSize(documentData: Uint8Array): number {
    return documentData.length;
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

export const loroServerAdaptor = new LoroServerAdaptor();
