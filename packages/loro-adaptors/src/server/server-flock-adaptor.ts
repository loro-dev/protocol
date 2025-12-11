import { Flock, decodeVersionVector, encodeVersionVector } from "@loro-dev/flock";
import type {
  ExportBundle as FlockExportBundle,
  VersionVector as FlockVersion,
} from "@loro-dev/flock";
import {
  CrdtType,
  JoinResponseOk,
  MessageType,
} from "loro-protocol";
import type { CrdtServerAdaptor } from "../types";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function serializeBundle(bundle: FlockExportBundle): Uint8Array {
  return encoder.encode(JSON.stringify(bundle ?? {}));
}

function deserializeBundle(bytes: Uint8Array): FlockExportBundle {
  if (!bytes.length) {
    return { version: 0, entries: {} };
  }
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

function importSnapshot(flock: Flock, data: Uint8Array): void {
  if (!data.length) return;
  const bundle = deserializeBundle(data);
  const result = flock.importJson(bundle);
  if (result instanceof Promise) {
    throw new TypeError("Asynchronous import is not supported for snapshots");
  }
  return;
}

function exportBundle(
  flock: Flock,
  from?: FlockVersion,
): FlockExportBundle {
  const result =
    from !== undefined ? flock.exportJson(from) : flock.exportJson();
  if (result instanceof Promise) {
    throw new TypeError(
      "Asynchronous export is not supported in the server adaptor",
    );
  }
  return result;
}

export class FlockServerAdaptor implements CrdtServerAdaptor {
  readonly crdtType = CrdtType.Flock;

  createEmpty(): Uint8Array {
    const flock = new Flock();
    return serializeBundle(exportBundle(flock));
  }

  handleJoinRequest(
    documentData: Uint8Array,
    clientVersion: Uint8Array,
  ): {
    response: JoinResponseOk;
    updates?: Uint8Array[];
  } {
    const flock = new Flock();
    importSnapshot(flock, documentData);

    const serverVersion = encodeVersionVector(flock.version());
    let updates: Uint8Array[] | undefined;

    if (clientVersion.length > 0) {
      const clientVV = decodeVersionVector(clientVersion);
      const delta = exportBundle(flock, clientVV);
      updates = [serializeBundle(delta)];
    } else if (documentData.length > 0) {
      updates = [documentData];
    }

    const response: JoinResponseOk = {
      type: MessageType.JoinResponseOk,
      crdt: this.crdtType,
      roomId: "",
      permission: "write",
      version: serverVersion,
    };

    return { response, updates };
  }

  applyUpdates(
    documentData: Uint8Array,
    updates: Uint8Array[],
  ): Uint8Array {

    const flock = new Flock();
    const broadcastUpdates: Uint8Array[] = [];

    try {
      importSnapshot(flock, documentData);
      for (const update of updates) {
        if (!update.length) continue;
        const bundle = deserializeBundle(update);
        const maybeReport = flock.importJson(bundle);
        if (maybeReport instanceof Promise) {
          throw new TypeError(
            "Asynchronous import is not supported for update payloads",
          );
        }
        if ((maybeReport.accepted ?? 0) > 0) {
          broadcastUpdates.push(update);
        }
      }

      return serializeBundle(exportBundle(flock));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Invalid update", { cause: error });
    }
  }

  getVersion(documentData: Uint8Array): Uint8Array {
    const flock = new Flock();
    importSnapshot(flock, documentData);
    return encodeVersionVector(flock.version());
  }

  merge(documents: Uint8Array[]): Uint8Array {
    const flock = new Flock();
    for (const snapshot of documents) {
      if (!snapshot.length) continue;
      const bundle = deserializeBundle(snapshot);
      const report = flock.importJson(bundle);
      if (report instanceof Promise) {
        throw new TypeError(
          "Asynchronous import is not supported when merging snapshots",
        );
      }
      // Report value is unused beyond validation.
    }
    return serializeBundle(exportBundle(flock));
  }
}
