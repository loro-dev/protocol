import { describe, expect, it } from "vitest";
import { encode, decode, tryDecode } from "../src/encoding";
import {
  CrdtType,
  MessageType,
  JoinErrorCode,
  UpdateStatusCode,
  RoomErrorCode,
  type JoinRequest,
  type JoinResponseOk,
  type JoinError,
  type DocUpdate,
  type DocUpdateFragmentHeader,
  type DocUpdateFragment,
  type RoomError,
  type Ack,
  type Leave,
} from "../src/protocol";

describe("Message Encoding and Decoding", () => {
  const roomId = "room-123";
  const batchId = "0x0102030405060708";

  describe("JoinRequest", () => {
    it("encodes and decodes JoinRequest correctly", () => {
      const message: JoinRequest = {
        type: MessageType.JoinRequest,
        crdt: CrdtType.Loro,
        roomId,
        auth: new Uint8Array([10, 20, 30]),
        version: new Uint8Array([40, 50, 60]),
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.JoinRequest);
      expect(decoded.crdt).toBe(CrdtType.Loro);
      expect(decoded.roomId).toEqual(roomId);
      if (decoded.type !== MessageType.JoinRequest) throw new Error("bad type");
      expect(Array.from(decoded.auth)).toEqual([10, 20, 30]);
      expect(Array.from(decoded.version)).toEqual([40, 50, 60]);
    });

    it("handles different CRDT types", () => {
      const crdtTypes = [
        CrdtType.Loro,
        CrdtType.LoroEphemeralStore,
        CrdtType.Yjs,
        CrdtType.YjsAwareness,
      ];

      for (const crdt of crdtTypes) {
        const message: JoinRequest = {
          type: MessageType.JoinRequest,
          crdt,
          roomId,
          auth: new Uint8Array([1]),
          version: new Uint8Array([2]),
        };

        const encoded = encode(message);
        const decoded = decode(encoded);
        expect(decoded.crdt).toBe(crdt);
      }
    });
  });

  describe("JoinResponseOk", () => {
    it("encodes and decodes JoinResponseOk with read permission", () => {
      const message: JoinResponseOk = {
        type: MessageType.JoinResponseOk,
        crdt: CrdtType.Yjs,
        roomId,
        permission: "read",
        version: new Uint8Array([11, 22, 33]),
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.JoinResponseOk);
      expect(decoded.crdt).toBe(CrdtType.Yjs);
      if (decoded.type !== MessageType.JoinResponseOk)
        throw new Error("bad type");
      expect(decoded.permission).toBe("read");
      expect(Array.from(decoded.version)).toEqual([11, 22, 33]);
      expect(decoded.extra).toStrictEqual(new Uint8Array([]));
    });

    it("encodes and decodes JoinResponseOk with write permission and extra data", () => {
      const message: JoinResponseOk = {
        type: MessageType.JoinResponseOk,
        crdt: CrdtType.Loro,
        roomId,
        permission: "write",
        version: new Uint8Array([44, 55]),
        extra: new Uint8Array([66, 77, 88]),
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.JoinResponseOk);
      if (decoded.type !== MessageType.JoinResponseOk)
        throw new Error("bad type");
      expect(decoded.permission).toBe("write");
      expect(Array.from(decoded.version)).toEqual([44, 55]);
      expect(decoded.extra).toBeDefined();
      expect(Array.from(decoded.extra!)).toEqual([66, 77, 88]);
    });
  });

  describe("JoinError", () => {
    it("encodes and decodes JoinError with auth failed", () => {
      const message: JoinError = {
        type: MessageType.JoinError,
        crdt: CrdtType.LoroEphemeralStore,
        roomId,
        code: JoinErrorCode.AuthFailed,
        message: "Invalid credentials",
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.JoinError);
      if (decoded.type !== MessageType.JoinError) throw new Error("bad type");
      expect(decoded.code).toBe(JoinErrorCode.AuthFailed);
      expect(decoded.message).toBe("Invalid credentials");
      expect(decoded.receiverVersion).toBeUndefined();
      expect(decoded.appCode).toBeUndefined();
    });

    it("encodes and decodes JoinError with version unknown", () => {
      const message: JoinError = {
        type: MessageType.JoinError,
        crdt: CrdtType.Loro,
        roomId,
        code: JoinErrorCode.VersionUnknown,
        message: "Version mismatch",
        receiverVersion: new Uint8Array([99, 100]),
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.JoinError);
      if (decoded.type !== MessageType.JoinError) throw new Error("bad type");
      expect(decoded.code).toBe(JoinErrorCode.VersionUnknown);
      expect(decoded.message).toBe("Version mismatch");
      expect(Array.from(decoded.receiverVersion!)).toEqual([99, 100]);
    });

    it("encodes and decodes JoinError with app error", () => {
      const message: JoinError = {
        type: MessageType.JoinError,
        crdt: CrdtType.Yjs,
        roomId,
        code: JoinErrorCode.AppError,
        message: "Application specific error",
        appCode: "quota_exceeded",
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.JoinError);
      if (decoded.type !== MessageType.JoinError) throw new Error("bad type");
      expect(decoded.code).toBe(JoinErrorCode.AppError);
      expect(decoded.message).toBe("Application specific error");
      expect(decoded.appCode).toBe("quota_exceeded");
    });
  });

  describe("DocUpdate", () => {
    it("encodes and decodes DocUpdate with single update", () => {
      const message: DocUpdate = {
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId,
        updates: [new Uint8Array([111, 222])],
        batchId,
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.DocUpdate);
      if (decoded.type !== MessageType.DocUpdate) throw new Error("bad type");
      expect(decoded.updates.length).toBe(1);
      expect(Array.from(decoded.updates[0])).toEqual([111, 222]);
      expect(decoded.batchId).toBe(batchId);
    });

    it("encodes and decodes DocUpdate with multiple updates", () => {
      const message: DocUpdate = {
        type: MessageType.DocUpdate,
        crdt: CrdtType.Yjs,
        roomId,
        updates: [
          new Uint8Array([1, 2, 3]),
          new Uint8Array([4, 5, 6, 7]),
          new Uint8Array([8]),
        ],
        batchId,
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.DocUpdate);
      if (decoded.type !== MessageType.DocUpdate) throw new Error("bad type");
      expect(decoded.updates.length).toBe(3);
      expect(Array.from(decoded.updates[0])).toEqual([1, 2, 3]);
      expect(Array.from(decoded.updates[1])).toEqual([4, 5, 6, 7]);
      expect(Array.from(decoded.updates[2])).toEqual([8]);
      expect(decoded.batchId).toBe(batchId);
    });

    it("encodes and decodes DocUpdate with empty updates array", () => {
      const message: DocUpdate = {
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId,
        updates: [],
        batchId,
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.DocUpdate);
      if (decoded.type !== MessageType.DocUpdate) throw new Error("bad type");
      expect(decoded.updates.length).toBe(0);
      expect(decoded.batchId).toBe(batchId);
    });

    it("rejects DocUpdate when batchId is shorter than 8 bytes", () => {
      const message: DocUpdate = {
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId,
        updates: [new Uint8Array([1])],
        batchId,
      };

      const encoded = encode(message);
      const truncated = encoded.slice(0, encoded.length - 1); // drop one batchId byte

      expect(() => decode(truncated)).toThrow(/batch ID/);
    });

    it("rejects DocUpdate when extra bytes follow the batchId", () => {
      const message: DocUpdate = {
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId,
        updates: [new Uint8Array([1])],
        batchId,
      };

      const encoded = encode(message);
      const withExtra = new Uint8Array(encoded.length + 1);
      withExtra.set(encoded);
      withExtra[withExtra.length - 1] = 0xff;

      expect(() => decode(withExtra)).toThrow(/trailing bytes/);
    });
  });

  describe("DocUpdateFragmentHeader", () => {
    it("encodes and decodes DocUpdateFragmentHeader correctly", () => {
      const message: DocUpdateFragmentHeader = {
        type: MessageType.DocUpdateFragmentHeader,
        crdt: CrdtType.Loro,
        roomId,
        batchId: "0xff11223344556677",
        fragmentCount: 10,
        totalSizeBytes: 1024000,
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.DocUpdateFragmentHeader);
      if (decoded.type !== MessageType.DocUpdateFragmentHeader)
        throw new Error("bad type");
      expect(decoded.batchId).toBe("0xff11223344556677");
      expect(decoded.fragmentCount).toBe(10);
      expect(decoded.totalSizeBytes).toBe(1024000);
    });

    it("handles zero and small batch IDs", () => {
      const message: DocUpdateFragmentHeader = {
        type: MessageType.DocUpdateFragmentHeader,
        crdt: CrdtType.Yjs,
        roomId,
        batchId: "0x0000000000000000",
        fragmentCount: 1,
        totalSizeBytes: 100,
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.DocUpdateFragmentHeader);
      if (decoded.type !== MessageType.DocUpdateFragmentHeader)
        throw new Error("bad type");
      expect(decoded.batchId).toBe("0x0000000000000000");
      expect(decoded.fragmentCount).toBe(1);
      expect(decoded.totalSizeBytes).toBe(100);
    });
  });

  describe("DocUpdateFragment", () => {
    it("encodes and decodes DocUpdateFragment correctly", () => {
      const fragmentData = new Uint8Array(1000);
      for (let i = 0; i < fragmentData.length; i++) {
        fragmentData[i] = i & 0xff;
      }

      const message: DocUpdateFragment = {
        type: MessageType.DocUpdateFragment,
        crdt: CrdtType.Loro,
        roomId,
        batchId: "0x0000000000000000",
        index: 3,
        fragment: fragmentData,
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.DocUpdateFragment);
      if (decoded.type !== MessageType.DocUpdateFragment)
        throw new Error("bad type");
      expect(decoded.batchId).toBe("0x0000000000000000");
      expect(decoded.index).toBe(3);
      expect(Array.from(decoded.fragment)).toEqual(Array.from(fragmentData));
    });
  });

  describe("RoomError", () => {
    it("encodes and decodes RoomError eviction", () => {
      const message: RoomError = {
        type: MessageType.RoomError,
        crdt: CrdtType.Loro,
        roomId,
        code: RoomErrorCode.Evicted,
        message: "evicted",
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.RoomError);
      if (decoded.type !== MessageType.RoomError) throw new Error("bad type");
      expect(decoded.code).toBe(RoomErrorCode.Evicted);
      expect(decoded.message).toBe("evicted");
    });
  });

  describe("Ack", () => {
    it("encodes and decodes Ack ok", () => {
      const message: Ack = {
        type: MessageType.Ack,
        crdt: CrdtType.Loro,
        roomId,
        refId: batchId,
        status: UpdateStatusCode.Ok,
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.Ack);
      if (decoded.type !== MessageType.Ack) throw new Error("bad type");
      expect(decoded.refId).toBe(batchId);
      expect(decoded.status).toBe(UpdateStatusCode.Ok);
    });

    it("encodes and decodes Ack with fragment timeout", () => {
      const message: Ack = {
        type: MessageType.Ack,
        crdt: CrdtType.LoroEphemeralStore,
        roomId,
        refId: "0x0000000000000001",
        status: UpdateStatusCode.FragmentTimeout,
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.Ack);
      if (decoded.type !== MessageType.Ack) throw new Error("bad type");
      expect(decoded.refId).toBe("0x0000000000000001");
      expect(decoded.status).toBe(UpdateStatusCode.FragmentTimeout);
    });
  });

  describe("Leave", () => {
    it("encodes and decodes Leave message", () => {
      const message: Leave = {
        type: MessageType.Leave,
        crdt: CrdtType.Loro,
        roomId,
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.type).toBe(MessageType.Leave);
      if (decoded.type !== MessageType.Leave) throw new Error("bad type");
      expect(decoded.crdt).toBe(CrdtType.Loro);
      expect(decoded.roomId).toEqual(roomId);
    });
  });

  describe("tryDecode", () => {
    it("returns undefined for invalid data", () => {
      const invalidData = new Uint8Array([1, 2, 3]); // Too short
      const result = tryDecode(invalidData);
      expect(result).toBeUndefined();
    });

    it("returns undefined for invalid CRDT type", () => {
      const invalidCrdt = new Uint8Array([
        65,
        66,
        67,
        68, // "ABCD" - invalid CRDT
        1,
        5, // varBytes length and room ID
        1,
        2,
        3,
        4,
        5,
        0, // message type
      ]);
      const result = tryDecode(invalidCrdt);
      expect(result).toBeUndefined();
    });

    it("returns the decoded message for valid data", () => {
      const message: Leave = {
        type: MessageType.Leave,
        crdt: CrdtType.Loro,
        roomId: "room-123",
      };

      const encoded = encode(message);
      const result = tryDecode(encoded);

      expect(result).toBeDefined();
      expect(result?.type).toBe(MessageType.Leave);
      expect(result?.crdt).toBe(CrdtType.Loro);
    });
  });

  describe("Message size validation", () => {
    it("throws error when message exceeds maximum size", () => {
      // Create a message that would exceed 256KB
      const largeUpdate = new Uint8Array(260 * 1024); // 260KB
      const message: DocUpdate = {
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId,
        updates: [largeUpdate],
        batchId,
      };

      expect(() => encode(message)).toThrow(/Message size .* exceeds maximum/);
    });
  });

  describe("Room ID validation", () => {
    it("accepts room IDs up to 128 bytes", () => {
      const maxRoomId = "a".repeat(128);
      const message: Leave = {
        type: MessageType.Leave,
        crdt: CrdtType.Loro,
        roomId: maxRoomId,
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.roomId).toEqual(maxRoomId);
    });

    it("throws error for room IDs exceeding 128 bytes during encode", () => {
      const largeRoomId = "a".repeat(129);
      const message: Leave = {
        type: MessageType.Leave,
        crdt: CrdtType.Loro,
        roomId: largeRoomId,
      };

      // The encoder allows it, but decoder should reject
      expect(() => encode(message)).toThrow(/Room ID too long/);
    });
  });

  describe("UTF-8 string handling", () => {
    it("correctly handles UTF-8 strings with emojis and special characters", () => {
      const testStrings = [
        "Hello, World!",
        "こんにちは世界",
        "🎉🚀💻 Emojis work!",
        "Mixed: 中文, English, 日本語, 한국어",
        "Special chars: \n\t\r\"'\\",
      ];

      for (const testString of testStrings) {
        const message: JoinError = {
          type: MessageType.JoinError,
          crdt: CrdtType.Loro,
          roomId,
          code: JoinErrorCode.Unknown,
          message: testString,
        };

        const encoded = encode(message);
        const decoded = decode(encoded);
        expect(decoded.type).toBe(MessageType.JoinError);
        if (decoded.type !== MessageType.JoinError) throw new Error("bad type");
        expect(decoded.message).toBe(testString);
      }
    });
  });

  describe("Edge cases", () => {
    it("handles empty auth and version in JoinRequest", () => {
      const message: JoinRequest = {
        type: MessageType.JoinRequest,
        crdt: CrdtType.Loro,
        roomId,
        auth: new Uint8Array(0),
        version: new Uint8Array(0),
      };

      const encoded = encode(message);
      const decoded = decode(encoded);
      expect(decoded.type).toBe(MessageType.JoinRequest);
      if (decoded.type !== MessageType.JoinRequest) throw new Error("bad type");
      expect(decoded.auth.length).toBe(0);
      expect(decoded.version.length).toBe(0);
    });

    it("handles empty room ID", () => {
      const message: Leave = {
        type: MessageType.Leave,
        crdt: CrdtType.Loro,
        roomId: "",
      };

      const encoded = encode(message);
      const decoded = decode(encoded);

      expect(decoded.roomId.length).toBe(0);
    });
  });
});
