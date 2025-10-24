import { Flock } from "@loro-dev/flock";
import type {
  ExportBundle as FlockExportBundle,
  ImportReport as FlockImportReport,
  VersionVector as FlockVersion,
} from "@loro-dev/flock";
import {
  CrdtType,
  JoinResponseOk,
  MessageType,
  Permission,
  UpdateError,
  UpdateErrorCode,
} from "loro-protocol";
import type { CrdtServerAdaptor } from "../types";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function serializeBundle(bundle: FlockExportBundle): Uint8Array {
  return encoder.encode(JSON.stringify(bundle ?? {}));
}

function deserializeBundle(bytes: Uint8Array): FlockExportBundle {
  if (!bytes.length) {
    return {};
  }
  try {
    const parsed = JSON.parse(decoder.decode(bytes));
    if (parsed && typeof parsed === "object") {
      return parsed as FlockExportBundle;
    }
  } catch {
    // ignore malformed payloads
  }
  return {};
}

function serializeVersion(version: FlockVersion | undefined): Uint8Array {
  return encoder.encode(JSON.stringify(version ?? {}));
}

function deserializeVersion(bytes: Uint8Array): FlockVersion {
  if (!bytes.length) {
    return {};
  }
  try {
    const parsed = JSON.parse(decoder.decode(bytes));
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const next: FlockVersion = {};
    for (const [peer, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const entry = value as { logicalCounter?: unknown; physicalTime?: unknown };
      const logicalCounter =
        typeof entry.logicalCounter === "number" &&
        Number.isFinite(entry.logicalCounter)
          ? Math.trunc(entry.logicalCounter)
          : 0;
      const physicalTime =
        typeof entry.physicalTime === "number" &&
        Number.isFinite(entry.physicalTime)
          ? entry.physicalTime
          : 0;
      next[peer] = { logicalCounter, physicalTime };
    }
    return next;
  } catch {
    return {};
  }
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
    permission: Permission,
  ): {
    response: JoinResponseOk;
    updates?: Uint8Array[];
  } {
    const flock = new Flock();
    importSnapshot(flock, documentData);

    const serverVersion = serializeVersion(flock.version());
    let updates: Uint8Array[] | undefined;

    if (clientVersion.length > 0) {
      const clientVV = deserializeVersion(clientVersion);
      const delta = exportBundle(flock, clientVV);
      updates = [serializeBundle(delta)];
    } else if (documentData.length > 0) {
      updates = [documentData];
    }

    const response: JoinResponseOk = {
      type: MessageType.JoinResponseOk,
      crdt: this.crdtType,
      roomId: "",
      permission,
      version: serverVersion,
    };

    return { response, updates };
  }

  applyUpdates(
    documentData: Uint8Array,
    updates: Uint8Array[],
    permission: Permission,
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
        const report = maybeReport as FlockImportReport;
        if ((report.accepted ?? 0) > 0) {
          broadcastUpdates.push(update);
        }
      }

      const newDocumentData = serializeBundle(exportBundle(flock));
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
    }
  }

  getVersion(documentData: Uint8Array): Uint8Array {
    const flock = new Flock();
    importSnapshot(flock, documentData);
    return serializeVersion(flock.version());
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

export const flockServerAdaptor = new FlockServerAdaptor();
