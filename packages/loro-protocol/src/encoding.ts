import { BytesReader, BytesWriter } from "./bytes";
import {
  CrdtType,
  JoinErrorCode,
  UpdateErrorCode,
  MessageType,
  ProtocolMessage,
  JoinRequest,
  JoinResponseOk,
  JoinError,
  DocUpdate,
  DocUpdateV2,
  DocUpdateFragmentHeader,
  DocUpdateFragment,
  UpdateError,
  UpdateErrorV2,
  Ack,
  Leave,
  MAX_MESSAGE_SIZE,
  hexToBytes,
  bytesToHex,
  HexString,
} from "./protocol";

const validCrdtTypes = [
  CrdtType.Loro,
  CrdtType.LoroEphemeralStore,
  CrdtType.LoroEphemeralStorePersisted,
  CrdtType.Yjs,
  CrdtType.YjsAwareness,
  CrdtType.Elo,
  CrdtType.Flock,
];

const MAX_ROOM_ID_LENGTH = 128;

function isCrdtType(x: unknown): x is CrdtType {
  return (
    typeof x === "string" &&
    (x === CrdtType.Loro ||
      x === CrdtType.LoroEphemeralStore ||
      x === CrdtType.LoroEphemeralStorePersisted ||
      x === CrdtType.Yjs ||
      x === CrdtType.YjsAwareness ||
      x === CrdtType.Flock ||
      x === CrdtType.Elo)
  );
}

function isMessageType(x: number): x is MessageType {
  return (
    x === MessageType.JoinRequest ||
    x === MessageType.JoinResponseOk ||
    x === MessageType.JoinError ||
    x === MessageType.DocUpdate ||
    x === MessageType.DocUpdateFragmentHeader ||
    x === MessageType.DocUpdateFragment ||
    x === MessageType.UpdateError ||
    x === MessageType.Leave ||
    x === MessageType.DocUpdateV2 ||
    x === MessageType.Ack ||
    x === MessageType.UpdateErrorV2
  );
}

function isJoinErrorCode(x: number): x is JoinErrorCode {
  return (
    x === JoinErrorCode.Unknown ||
    x === JoinErrorCode.VersionUnknown ||
    x === JoinErrorCode.AuthFailed ||
    x === JoinErrorCode.AppError
  );
}

function isUpdateErrorCode(x: number): x is UpdateErrorCode {
  return (
    x === UpdateErrorCode.Unknown ||
    x === UpdateErrorCode.PermissionDenied ||
    x === UpdateErrorCode.InvalidUpdate ||
    x === UpdateErrorCode.PayloadTooLarge ||
    x === UpdateErrorCode.RateLimited ||
    x === UpdateErrorCode.FragmentTimeout ||
    x === UpdateErrorCode.AppError
  );
}

export function encode(message: ProtocolMessage): Uint8Array {
  const writer = new BytesWriter();
  if (!validCrdtTypes.includes(message.crdt)) {
    throw new Error(`Invalid CRDT type: ${message.crdt}`);
  }

  // Write CRDT type (4 bytes)
  const crdtBytes = new TextEncoder().encode(message.crdt);
  writer.pushBytes(crdtBytes);

  // Write room ID as varString
  const roomIdBytes = new TextEncoder().encode(message.roomId);
  if (roomIdBytes.byteLength > MAX_ROOM_ID_LENGTH) {
    throw new Error("Room ID too long");
  }
  writer.pushVarBytes(roomIdBytes);


  // Write message type
  writer.pushByte(message.type);

  // Write message-specific payload
  switch (message.type) {
    case MessageType.JoinRequest: {
      writer.pushVarBytes(message.auth);
      writer.pushVarBytes(message.version);
      break;
    }
    case MessageType.JoinResponseOk: {
      writer.pushVarString(message.permission);
      writer.pushVarBytes(message.version);
      if (message.extra) {
        writer.pushVarBytes(message.extra);
      } else {
        writer.pushVarBytes(new Uint8Array(0));
      }
      break;
    }
    case MessageType.JoinError: {
      writer.pushByte(message.code);
      writer.pushVarString(message.message);
      if (message.code === JoinErrorCode.VersionUnknown && message.receiverVersion) {
        writer.pushVarBytes(message.receiverVersion);
      }
      if (message.code === JoinErrorCode.AppError && message.appCode) {
        writer.pushVarString(message.appCode);
      }
      break;
    }
    case MessageType.DocUpdate: {
      writer.pushUleb128(message.updates.length);
      for (const update of message.updates) {
        writer.pushVarBytes(update);
      }
      break;
    }
    case MessageType.DocUpdateV2: {
      const batchIdBytes = hexToBytes(message.batchId);
      writer.pushBytes(batchIdBytes);
      writer.pushUleb128(message.updates.length);
      for (const update of message.updates) {
        writer.pushVarBytes(update);
      }
      break;
    }
    case MessageType.DocUpdateFragmentHeader: {
      // Write 8-byte batch ID
      const batchIdBytes = hexToBytes(message.batchId);
      writer.pushBytes(batchIdBytes);
      writer.pushUleb128(message.fragmentCount);
      writer.pushUleb128(message.totalSizeBytes);
      break;
    }
    case MessageType.DocUpdateFragment: {
      // Write 8-byte batch ID
      const batchIdBytes = hexToBytes(message.batchId);
      writer.pushBytes(batchIdBytes);
      writer.pushUleb128(message.index);
      writer.pushVarBytes(message.fragment);
      break;
    }
    case MessageType.UpdateError: {
      writer.pushByte(message.code);
      writer.pushVarString(message.message);
      if (
        message.code === UpdateErrorCode.FragmentTimeout &&
        message.batchId !== undefined
      ) {
        const batchIdBytes = hexToBytes(message.batchId);
        writer.pushBytes(batchIdBytes);
      }
      if (message.code === UpdateErrorCode.AppError && message.appCode) {
        writer.pushVarString(message.appCode);
      }
      break;
    }
    case MessageType.Ack: {
      const batchIdBytes = hexToBytes(message.batchId);
      writer.pushBytes(batchIdBytes);
      break;
    }
    case MessageType.UpdateErrorV2: {
      const batchIdBytes = hexToBytes(message.batchId);
      writer.pushBytes(batchIdBytes);
      writer.pushByte(message.code);
      writer.pushVarString(message.message);
      if (message.code === UpdateErrorCode.AppError && message.appCode) {
        writer.pushVarString(message.appCode);
      }
      break;
    }
    case MessageType.Leave: {
      // No additional payload for Leave message
      break;
    }
    default:
      throw new Error("Unknown message type");
  }

  const result = writer.finalize();

  if (result.length > MAX_MESSAGE_SIZE) {
    throw new Error(
      `Message size ${result.length} exceeds maximum ${MAX_MESSAGE_SIZE}`
    );
  }

  return result;
}

export function decode(data: Uint8Array): ProtocolMessage {
  const reader = new BytesReader(data);

  // Read CRDT type (4 bytes)
  if (reader.remaining < 4) {
    throw new Error("Invalid message: too short for CRDT type");
  }
  const crdtBytes = reader.readBytes(4);
  const crdtMaybe = new TextDecoder().decode(crdtBytes);
  if (!isCrdtType(crdtMaybe)) {
    throw new Error(`Invalid CRDT type: ${crdtMaybe}`);
  }
  const crdt = crdtMaybe;

  // Validate CRDT type
  if (!validCrdtTypes.includes(crdt)) {
    throw new Error(`Invalid CRDT type: ${crdt}`);
  }

  // Read room ID
  const roomId = reader.readVarString();

  // Read message type
  const typeByte = reader.readByte();
  if (!isMessageType(typeByte)) {
    throw new Error("Invalid message type");
  }
  const type = typeByte;

  // Parse message-specific payload
  switch (type) {
    case MessageType.JoinRequest: {
      const auth = reader.readVarBytes();
      const version = reader.readVarBytes();
      return {
        type,
        crdt,
        roomId,
        auth,
        version,
      } as JoinRequest;
    }
    case MessageType.JoinResponseOk: {
      const permissionRaw = reader.readVarString();
      if (permissionRaw !== "read" && permissionRaw !== "write") {
        throw new Error(`Invalid permission: ${permissionRaw}`);
      }
      const version = reader.readVarBytes();
      const extraBytes = reader.readVarBytes();
      return {
        type,
        crdt,
        roomId,
        permission: permissionRaw,
        version,
        extra: extraBytes,
      } as JoinResponseOk;
    }
    case MessageType.JoinError: {
      const codeByte = reader.readByte();
      const code = isJoinErrorCode(codeByte)
        ? codeByte
        : JoinErrorCode.Unknown;
      const message = reader.readVarString();
      let receiverVersion: Uint8Array | undefined;
      let appCode: string | undefined;

      if (code === JoinErrorCode.VersionUnknown && reader.remaining > 0) {
        receiverVersion = reader.readVarBytes();
      }
      if (code === JoinErrorCode.AppError && reader.remaining > 0) {
        appCode = reader.readVarString();
      }

      return {
        type,
        crdt,
        roomId,
        code,
        message,
        receiverVersion,
        appCode,
      } as JoinError;
    }
    case MessageType.DocUpdate: {
      const count = reader.readUleb128();
      const updates: Uint8Array[] = [];
      for (let i = 0; i < count; i++) {
        updates.push(reader.readVarBytes());
      }
      return {
        type,
        crdt,
        roomId,
        updates,
      } as DocUpdate;
    }
    case MessageType.DocUpdateV2: {
      if (reader.remaining < 8) {
        throw new Error("Invalid DocUpdateV2: missing batch ID");
      }
      const batchIdBytes = reader.readBytes(8);
      const batchId = bytesToHex(batchIdBytes);
      const count = reader.readUleb128();
      const updates: Uint8Array[] = [];
      for (let i = 0; i < count; i++) {
        updates.push(reader.readVarBytes());
      }
      return {
        type,
        crdt,
        roomId,
        batchId,
        updates,
      } as DocUpdateV2;
    }
    case MessageType.DocUpdateFragmentHeader: {
      if (reader.remaining < 8) {
        throw new Error("Invalid DocUpdateFragmentHeader: missing batch ID");
      }
      const batchIdBytes = reader.readBytes(8);
      const batchId = bytesToHex(batchIdBytes);
      const fragmentCount = reader.readUleb128();
      const totalSizeBytes = reader.readUleb128();
      return {
        type,
        crdt,
        roomId,
        batchId,
        fragmentCount,
        totalSizeBytes,
      } as DocUpdateFragmentHeader;
    }
    case MessageType.DocUpdateFragment: {
      if (reader.remaining < 8) {
        throw new Error("Invalid DocUpdateFragment: missing batch ID");
      }
      const batchIdBytes = reader.readBytes(8);
      const batchId = bytesToHex(batchIdBytes);
      const index = reader.readUleb128();
      const fragment = reader.readVarBytes();
      return {
        type,
        crdt,
        roomId,
        batchId,
        index,
        fragment,
      } as DocUpdateFragment;
    }
    case MessageType.UpdateError: {
      const codeByte2 = reader.readByte();
      const code = isUpdateErrorCode(codeByte2)
        ? codeByte2
        : UpdateErrorCode.Unknown;
      const message = reader.readVarString();
      let batchId: HexString | undefined;
      let appCode: string | undefined;

      if (code === UpdateErrorCode.FragmentTimeout && reader.remaining >= 8) {
        const batchIdBytes = reader.readBytes(8);
        batchId = bytesToHex(batchIdBytes);
      }
      if (code === UpdateErrorCode.AppError && reader.remaining > 0) {
        appCode = reader.readVarString();
      }

      return {
        type,
        crdt,
        roomId,
        code,
        message,
        batchId,
        appCode,
      } as UpdateError;
    }
    case MessageType.Ack: {
      if (reader.remaining < 8) {
        throw new Error("Invalid Ack: missing batch ID");
      }
      const batchIdBytes = reader.readBytes(8);
      const batchId = bytesToHex(batchIdBytes);
      return {
        type,
        crdt,
        roomId,
        batchId,
      } as Ack;
    }
    case MessageType.UpdateErrorV2: {
      if (reader.remaining < 8) {
        throw new Error("Invalid UpdateErrorV2: missing batch ID");
      }
      const batchIdBytes = reader.readBytes(8);
      const batchId = bytesToHex(batchIdBytes);
      const codeByte = reader.readByte();
      const code = isUpdateErrorCode(codeByte)
        ? codeByte
        : UpdateErrorCode.Unknown;
      const message = reader.readVarString();
      let appCode: string | undefined;
      if (code === UpdateErrorCode.AppError && reader.remaining > 0) {
        appCode = reader.readVarString();
      }
      return {
        type,
        crdt,
        roomId,
        batchId,
        code,
        message,
        appCode,
      } as UpdateErrorV2;
    }
    case MessageType.Leave: {
      return {
        type,
        crdt,
        roomId,
      } as Leave;
    }
    default:
      throw new Error("Unknown message type");
  }
}

export function tryDecode(data: Uint8Array): ProtocolMessage | undefined {
  try {
    return decode(data);
  } catch {
    return undefined;
  }
}
