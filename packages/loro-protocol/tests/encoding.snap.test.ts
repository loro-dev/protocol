import { describe, it, expect } from "vitest";
import { encode } from "../src/encoding";
import {
  CrdtType,
  MessageType,
  JoinErrorCode,
  UpdateErrorCode,
  bytesToHex,
  type JoinRequest,
  type JoinResponseOk,
  type JoinError,
  type DocUpdateV2,
  type DocUpdateFragmentHeader,
  type DocUpdateFragment,
  type UpdateErrorV2,
  type Ack,
  type Leave,
} from "../src/protocol";

// TODO: REVIEW ensure binary snapshots stay stable across changes to protocol

describe("encoding snapshots", () => {
  const roomId = "room-1234";

  it("JoinRequest", () => {
    const msg: JoinRequest = {
      type: MessageType.JoinRequest,
      crdt: CrdtType.Loro,
      roomId,
      auth: new Uint8Array([10, 20, 30]),
      version: new Uint8Array([40, 50, 60]),
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("JoinResponseOk read", () => {
    const msg: JoinResponseOk = {
      type: MessageType.JoinResponseOk,
      crdt: CrdtType.Yjs,
      roomId,
      permission: "read",
      version: new Uint8Array([11, 22, 33]),
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("JoinResponseOk write + extra", () => {
    const msg: JoinResponseOk = {
      type: MessageType.JoinResponseOk,
      crdt: CrdtType.Loro,
      roomId,
      permission: "write",
      version: new Uint8Array([44, 55]),
      extra: new Uint8Array([66, 77, 88]),
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("JoinError auth failed", () => {
    const msg: JoinError = {
      type: MessageType.JoinError,
      crdt: CrdtType.LoroEphemeralStore,
      roomId,
      code: JoinErrorCode.AuthFailed,
      message: "Invalid credentials",
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("JoinError version unknown with receiver version", () => {
    const msg: JoinError = {
      type: MessageType.JoinError,
      crdt: CrdtType.Loro,
      roomId,
      code: JoinErrorCode.VersionUnknown,
      message: "Version mismatch",
      receiverVersion: new Uint8Array([99, 100]),
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("JoinError app error with appCode", () => {
    const msg: JoinError = {
      type: MessageType.JoinError,
      crdt: CrdtType.Yjs,
      roomId,
      code: JoinErrorCode.AppError,
      message: "Application specific error",
      appCode: "quota_exceeded",
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("DocUpdateV2 multiple updates", () => {
    const msg: DocUpdateV2 = {
      type: MessageType.DocUpdateV2,
      crdt: CrdtType.Yjs,
      roomId,
      batchId: "0x0a0b0c0d0e0f0001",
      updates: [
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6, 7]),
        new Uint8Array([8]),
      ],
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("DocUpdateFragmentHeader", () => {
    const msg: DocUpdateFragmentHeader = {
      type: MessageType.DocUpdateFragmentHeader,
      crdt: CrdtType.Loro,
      roomId,
      batchId: "0xff11223344556677",
      fragmentCount: 10,
      totalSizeBytes: 1024000,
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("DocUpdateFragment", () => {
    const frag = new Uint8Array(32);
    for (let i = 0; i < frag.length; i++) frag[i] = i & 0xff;
    const msg: DocUpdateFragment = {
      type: MessageType.DocUpdateFragment,
      crdt: CrdtType.Loro,
      roomId,
      batchId: "0x0000000000000000",
      index: 3,
      fragment: frag,
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("Ack", () => {
    const msg: Ack = {
      type: MessageType.Ack,
      crdt: CrdtType.Loro,
      roomId,
      batchId: "0x0f0e0d0c0b0a0908",
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("UpdateErrorV2 permission denied", () => {
    const msg: UpdateErrorV2 = {
      type: MessageType.UpdateErrorV2,
      crdt: CrdtType.Loro,
      roomId,
      batchId: "0x0100000000000000",
      code: UpdateErrorCode.PermissionDenied,
      message: "No write permission",
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("UpdateErrorV2 fragment timeout", () => {
    const msg: UpdateErrorV2 = {
      type: MessageType.UpdateErrorV2,
      crdt: CrdtType.YjsAwareness,
      roomId,
      batchId: "0x0100000000000000",
      code: UpdateErrorCode.FragmentTimeout,
      message: "Fragment timeout",
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("UpdateErrorV2 app error with appCode", () => {
    const msg: UpdateErrorV2 = {
      type: MessageType.UpdateErrorV2,
      crdt: CrdtType.Loro,
      roomId,
      batchId: "0x0000000000000001",
      code: UpdateErrorCode.AppError,
      message: "Custom app error",
      appCode: "custom_code_123",
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });

  it("Leave", () => {
    const msg: Leave = {
      type: MessageType.Leave,
      crdt: CrdtType.Loro,
      roomId,
    };
    expect(bytesToHex(encode(msg))).toMatchSnapshot();
  });
});
