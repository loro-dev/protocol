import { describe, it, expect, vi, beforeEach } from "vitest";
import { LoroDoc } from "loro-crdt";
import { EloAdaptor } from "../src/adaptors";
import { CrdtType, MessageType } from "loro-protocol";
import { parseEloRecordHeader, decodeEloContainer } from "loro-protocol";
import { encryptDeltaSpan, encodeEloContainer } from "loro-protocol";

const KEY_HEX =
  "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2)
    out[i / 2] = parseInt(s.slice(i, i + 2), 16);
  return out;
}

describe("EloLoroAdaptor — snapshot join", () => {
  let doc: LoroDoc;
  let adaptor: EloAdaptor;
  const key = hexToBytes(KEY_HEX);
  const fixedIv = hexToBytes("0x0102030405060708090a0b0c");

  beforeEach(() => {
    doc = new LoroDoc();
    adaptor = new EloAdaptor(doc, {
      getPrivateKey: async () => ({ keyId: "k1", key }),
      ivFactory: () => fixedIv,
    });
  });

  it("sends a snapshot container when server has no version", async () => {
    const mockSend = vi.fn();
    adaptor.setCtx({
      send: mockSend,
      onJoinFailed: vi.fn(),
      onImportError: vi.fn(),
    });

    await adaptor.handleJoinOk({
      type: MessageType.JoinResponseOk,
      crdt: CrdtType.Elo,
      roomId: "room",
      permission: "write",
      version: new Uint8Array(),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [[updates]] = mockSend.mock.calls as [Uint8Array[]][];
    expect(updates.length).toBe(1);
    const [container] = updates;
    const records = decodeEloContainer(container);
    expect(records.length).toBe(1);
    const record = records[0];
    if (!record) throw new Error("Expected an ELO record to be emitted");
    const parsed = parseEloRecordHeader(record);
    expect(parsed.kind).toBe(0x01); // Snapshot
    expect(parsed.keyId).toBe("k1");
    expect(parsed.iv.length).toBe(12);
  });
});

describe("EloLoroAdaptor — apply snapshot update", () => {
  it("applies a snapshot container and updates the doc", async () => {
    const key = hexToBytes(KEY_HEX);
    // Create a source doc with content
    const source = new LoroDoc();
    source.getText("test").insert(0, "hello");
    source.commit();
    const plaintext = source.export({ mode: "snapshot" });

    const adaptorDoc = new LoroDoc();
    const adaptor = new EloAdaptor(adaptorDoc, {
      getPrivateKey: async () => ({ keyId: "k1", key }),
      ivFactory: () => hexToBytes("0x0102030405060708090a0b0c"),
    });
    adaptor.setCtx({
      send: vi.fn(),
      onJoinFailed: vi.fn(),
      onImportError: vi.fn(),
    });

    // Build a single snapshot record container using the same helpers the adaptor uses
    const { encryptSnapshot, encodeEloContainer } = await import(
      "loro-protocol"
    );
    const { record } = await encryptSnapshot(
      plaintext,
      { vv: [], keyId: "k1", iv: hexToBytes("0x0102030405060708090a0b0c") },
      key
    );
    const container = encodeEloContainer([record]);

    // Apply to adaptor doc
    adaptor.applyUpdate([container]);
    // Wait briefly for async decrypt/import to complete
    await new Promise(res => setTimeout(res, 10));
    expect(adaptorDoc.getText("test").toString()).toBe("hello");
  });
});

describe("EloLoroAdaptor — apply delta update", () => {
  it("applies a delta container update and updates the doc", async () => {
    const key = hexToBytes(KEY_HEX);
    // Create source update plaintext via standard update export
    const source = new LoroDoc();
    source.getText("test").insert(0, "hello");
    source.commit();
    const plaintext = source.export({ mode: "update" });

    const adaptorDoc = new LoroDoc();
    const adaptor = new EloAdaptor(adaptorDoc, {
      getPrivateKey: async () => ({ keyId: "k1", key }),
      ivFactory: () => hexToBytes("0x0102030405060708090a0b0c"),
    });
    adaptor.setCtx({
      send: vi.fn(),
      onJoinFailed: vi.fn(),
      onImportError: vi.fn(),
    });

    // Build a single delta record container
    const peerId = new TextEncoder().encode("peer-1");
    const { record } = await encryptDeltaSpan(
      plaintext,
      {
        peerId,
        start: 1,
        end: 2,
        keyId: "k1",
        iv: hexToBytes("0x0102030405060708090a0b0c"),
      },
      key
    );
    const container = encodeEloContainer([record]);

    adaptor.applyUpdate([container]);
    await new Promise(res => setTimeout(res, 10));
    expect(adaptorDoc.getText("test").toString()).toBe("hello");
  });
});
