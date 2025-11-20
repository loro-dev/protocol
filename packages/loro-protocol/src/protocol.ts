export const MAGIC = "LRSP";

export const MAX_MESSAGE_SIZE = 256 * 1024;

export const CrdtType = {
  Loro: "%LOR",
  LoroEphemeralStore: "%EPH",
  LoroEphemeralStorePersisted: "%EPS",
  Yjs: "%YJS",
  YjsAwareness: "%YAW",
  Elo: "%ELO",
  Flock: "%FLO",
} as const;
export const CrdtTypeId = {
  Loro: "loro",
  LoroEphemeralStore: "eph",
  LoroEphemeralStorePersisted: "eps",
  Yjs: "yjs",
  YjsAwareness: "yaw",
  Elo: "elo",
  Flock: "flo",
} as const;
export type CrdtType = (typeof CrdtType)[keyof typeof CrdtType];
export type CrdtId = (typeof CrdtTypeId)[keyof typeof CrdtTypeId];
export const MagicBytesToCrdtId = {
  "%LOR": "loro",
  "%EPH": "eph",
  "%EPS": "eps",
  "%YJS": "yjs",
  "%YAW": "yaw",
  "%ELO": "elo",
  "%FLO": "flo",
} as const;

export type Permission = "read" | "write";

export const MessageType = {
  JoinRequest: 0x00,
  JoinResponseOk: 0x01,
  JoinError: 0x02,
  DocUpdate: 0x03,
  DocUpdateFragmentHeader: 0x04,
  DocUpdateFragment: 0x05,
  UpdateError: 0x06,
  Leave: 0x07,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const JoinErrorCode = {
  Unknown: 0x00,
  VersionUnknown: 0x01,
  AuthFailed: 0x02,
  AppError: 0x7f,
} as const;
export type JoinErrorCode = (typeof JoinErrorCode)[keyof typeof JoinErrorCode];

export const UpdateErrorCode = {
  Unknown: 0x00,
  PermissionDenied: 0x03,
  InvalidUpdate: 0x04,
  PayloadTooLarge: 0x05,
  RateLimited: 0x06,
  FragmentTimeout: 0x07,
  AppError: 0x7f,
} as const;
export type UpdateErrorCode =
  (typeof UpdateErrorCode)[keyof typeof UpdateErrorCode];

export type RoomId = string;

export interface MessageBase {
  crdt: CrdtType;
  roomId: RoomId;
}

export interface JoinRequest extends MessageBase {
  type: typeof MessageType.JoinRequest;
  auth: Uint8Array;
  version: Uint8Array;
}

export interface JoinResponseOk extends MessageBase {
  type: typeof MessageType.JoinResponseOk;
  permission: Permission;
  version: Uint8Array;
  extra?: Uint8Array;
}

export interface JoinError extends MessageBase {
  type: typeof MessageType.JoinError;
  code: JoinErrorCode;
  message: string;
  receiverVersion?: Uint8Array;
  appCode?: string;
}

export interface DocUpdate extends MessageBase {
  type: typeof MessageType.DocUpdate;
  updates: Uint8Array[];
}

export type HexString = `0x${string}`;
export interface DocUpdateFragmentHeader extends MessageBase {
  type: typeof MessageType.DocUpdateFragmentHeader;
  batchId: HexString;
  fragmentCount: number;
  totalSizeBytes: number;
}

export interface DocUpdateFragment extends MessageBase {
  type: typeof MessageType.DocUpdateFragment;
  batchId: HexString;
  index: number;
  fragment: Uint8Array;
}

export interface UpdateError extends MessageBase {
  type: typeof MessageType.UpdateError;
  code: UpdateErrorCode;
  message: string;
  batchId?: HexString;
  appCode?: string;
}

export function hexToBytes(hex: HexString): Uint8Array {
  const hexWithoutPrefix = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(hexWithoutPrefix.length / 2);
  for (let i = 0; i < hexWithoutPrefix.length; i += 2) {
    bytes[i / 2] = parseInt(hexWithoutPrefix.slice(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): HexString {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return `0x${hex}`;
}
export interface Leave extends MessageBase {
  type: typeof MessageType.Leave;
}

export type ProtocolMessage =
  | JoinRequest
  | JoinResponseOk
  | JoinError
  | DocUpdate
  | DocUpdateFragmentHeader
  | DocUpdateFragment
  | UpdateError
  | Leave;
