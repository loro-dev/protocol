import { describe, it, expect } from "vitest";
import {
  encodeEloContainer,
  decodeEloContainer,
  EloRecordKind,
  encryptDeltaSpan,
  encryptSnapshot,
  parseEloRecordHeader,
} from "./e2ee";
import { bytesToHex, hexToBytes } from "./protocol";

describe("%ELO container codec", () => {
  it("encodes and decodes container", () => {
    const records = [new Uint8Array([1, 2, 3]), new Uint8Array([4])];
    const bytes = encodeEloContainer(records);
    const out = decodeEloContainer(bytes);
    expect(out.length).toBe(2);
    expect(Array.from(out[0]!)).toEqual([1, 2, 3]);
    expect(Array.from(out[1]!)).toEqual([4]);
  });
});

describe("%ELO record header parsing", () => {
  it("parses DeltaSpan header and preserves exact header bytes as AAD", async () => {
    const key = hexToBytes(
      "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    );
    const peerId = hexToBytes("0x01020304");
    const iv = hexToBytes("0x86bcad09d5e7e3d70503a57e");
    const plaintext = hexToBytes("0x01026869");
    const meta = { peerId, start: 1, end: 3, keyId: "k1", iv };
    const { record, headerBytes } = await encryptDeltaSpan(plaintext, meta, key);
    const parsed = parseEloRecordHeader(record);
    expect(parsed.kind).toBe(EloRecordKind.DeltaSpan);
    expect(bytesToHex(parsed.headerBytes)).toEqual(bytesToHex(headerBytes));
    expect(bytesToHex(parsed.iv)).toEqual(bytesToHex(iv));
    expect(parsed.header.kind).toBe(EloRecordKind.DeltaSpan);
    const h = parsed.header;
    if (h.kind === EloRecordKind.DeltaSpan) {
      expect(bytesToHex(h.peerId)).toEqual(bytesToHex(peerId));
      expect(h.start).toBe(1);
      expect(h.end).toBe(3);
      expect(h.keyId).toBe("k1");
    }
  });
});

describe("%ELO AES-GCM normative vector (DeltaSpan)", () => {
  it("matches ct for known key/iv/aad", async () => {
    // From protocol-e2ee.md
    const key = hexToBytes(
      "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    );
    const peerId = hexToBytes("0x01020304");
    const iv = hexToBytes("0x86bcad09d5e7e3d70503a57e");
    const plaintext = hexToBytes("0x01026869"); // varUint 1, varBytes("hi")
    const meta = { peerId, start: 1, end: 3, keyId: "k1", iv };

    const { record } = await encryptDeltaSpan(plaintext, meta, key);
    const parsed = parseEloRecordHeader(record);
    const ctHex = bytesToHex(parsed.ct);
    expect(ctHex).toBe(
      // ciphertext || tag (16B)
      "0x6930a8fbe96cc5f30b67f4bc7f53262e01b62852"
    );
  });
});

describe("%ELO Snapshot header vv sorting", () => {
  it("sorts vv by peerId bytes ascending during encoding", async () => {
    const key = hexToBytes(
      "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    );
    const iv = hexToBytes("0x0102030405060708090a0b0c");
    const plaintext = new Uint8Array([0x00]); // dummy snapshot payload
    const vvUnsorted = [
      { peerId: hexToBytes("0x02"), counter: 5 },
      { peerId: hexToBytes("0x01ff"), counter: 9 },
      { peerId: hexToBytes("0x01"), counter: 7 },
    ];
    const { record } = await encryptSnapshot(plaintext, { vv: vvUnsorted, keyId: "k1", iv }, key);
    const parsed = parseEloRecordHeader(record);
    expect(parsed.kind).toBe(EloRecordKind.Snapshot);
    const hdr = parsed.header;
    if (hdr.kind === EloRecordKind.Snapshot) {
      // Expected lexicographic order: 0x01, 0x01ff, 0x02
      const order = hdr.vv.map((e) => bytesToHex(e.peerId));
      expect(order).toEqual([
        "0x01",
        "0x01ff",
        "0x02",
      ]);
    }
  });
});
