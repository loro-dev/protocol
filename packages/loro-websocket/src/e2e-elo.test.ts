import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import getPort from "get-port";
import { SimpleServer } from "./server/simple-server";
import { LoroWebsocketClient } from "./client";
import { createEloLoroAdaptor } from "loro-adaptors";
import {
  encode,
  encodeEloContainer,
  tryDecode,
  MessageType,
  UpdateErrorCode,
} from "loro-protocol";

// Make WebSocket available globally for the client
Object.defineProperty(globalThis, "WebSocket", {
  value: WebSocket,
  configurable: true,
  writable: true,
});

// Ensure Web Crypto is available in Node test envs
try {
  // @ts-ignore
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { webcrypto } = require("node:crypto");
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      configurable: true,
      writable: true,
    });
  }
} catch { /* ignore */ }

describe("E2E: %ELO join/backfill and live updates", () => {
  let server: SimpleServer;
  let port: number;

  beforeAll(async () => {
    port = await getPort();
    server = new SimpleServer({ port });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  }, 15000);

  it("joins with backfill and syncs live", async () => {
    const client1 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client1.waitConnected();
    const client2 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client2.waitConnected();

    const key = new Uint8Array(16);
    key[0] = 1;
    const adaptor1 = createEloLoroAdaptor({
      getPrivateKey: async () => ({ keyId: "k1", key }),
    });
    const adaptor2 = createEloLoroAdaptor({
      getPrivateKey: async () => ({ keyId: "k1", key }),
    });

    // Client 1 joins and makes a change to generate a delta span
    const room1 = await client1.join({ roomId: "elo-room", crdtAdaptor: adaptor1 });
    const t1 = adaptor1.getDoc().getText("t");
    t1.insert(0, "hello");
    adaptor1.getDoc().commit();

    // Allow server to index delta
    await new Promise(r => setTimeout(r, 150));

    // Client 2 joins and should receive backfill (encrypted delta)
    const room2 = await client2.join({ roomId: "elo-room", crdtAdaptor: adaptor2 });
    // Wait until backfill applied
    await waitUntil(() => adaptor2.getDoc().getText("t").toString() === "hello", 5000);

    // Live update from client2 -> client1
    const t2 = adaptor2.getDoc().getText("t");
    t2.insert(t2.length, " world");
    adaptor2.getDoc().commit();

    await new Promise(r => setTimeout(r, 150));
    expect(adaptor1.getDoc().getText("t").toString()).toBe("hello world");

    await room1.destroy();
    await room2.destroy();
  }, 15000);

  it("handles fragmentation: large encrypted update is fragmented and reassembled", async () => {
    const client1 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client1.waitConnected();
    const client2 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client2.waitConnected();

    const key = new Uint8Array(16);
    key[0] = 2;
    const adaptor1 = createEloLoroAdaptor({
      getPrivateKey: async () => ({ keyId: "k1", key }),
    });
    const adaptor2 = createEloLoroAdaptor({
      getPrivateKey: async () => ({ keyId: "k1", key }),
    });

    const room1 = await client1.join({ roomId: "elo-frag", crdtAdaptor: adaptor1 });
    const room2 = await client2.join({ roomId: "elo-frag", crdtAdaptor: adaptor2 });

    // Generate a large single local update (> 300 KB) to force fragmentation
    const big = "x".repeat(320 * 1024);
    const t1 = adaptor1.getDoc().getText("t");
    t1.insert(0, big);
    adaptor1.getDoc().commit();

    // Wait until client2 has applied the text
    await waitUntil(() => adaptor2.getDoc().getText("t").length === big.length, 15000, 50);

    await room1.destroy();
    await room2.destroy();
  }, 20000);
});

describe("E2E: %ELO server validation and errors", () => {
  let server: SimpleServer;
  let port: number;

  beforeAll(async () => {
    port = await getPort();
    server = new SimpleServer({ port });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  }, 15000);

  it("rejects delta with invalid IV length", async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    await waitForOpen(ws);
    // Join ELO room
    ws.send(
      encode({
        type: MessageType.JoinRequest,
        crdt: "%ELO",
        roomId: "elo-bad",
        auth: new Uint8Array(),
        version: new Uint8Array(),
      } as any)
    );
    await waitForJoinOk(ws);

    // Build a single-record container with iv length 11 (invalid)
    const rec = buildEloDeltaRecord({
      peerId: new Uint8Array([1]),
      start: 1,
      end: 2,
      keyId: "k1",
      iv: new Uint8Array(11),
      ct: new Uint8Array([0]),
    });
    const container = encodeEloContainer([rec]);

    // Send DocUpdate
    ws.send(
      encode({
        type: MessageType.DocUpdate,
        crdt: "%ELO",
        roomId: "elo-bad",
        updates: [container],
      } as any)
    );

    const err = await waitForUpdateError(ws);
    expect(err.code).toBe(UpdateErrorCode.InvalidUpdate);
  }, 15000);

  it("rejects delta with too-long peerId and keyId", async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    await waitForOpen(ws);
    ws.send(
      encode({
        type: MessageType.JoinRequest,
        crdt: "%ELO",
        roomId: "elo-bad2",
        auth: new Uint8Array(),
        version: new Uint8Array(),
      } as any)
    );
    await waitForJoinOk(ws);

    const longPeer = new Uint8Array(65);
    const longKey = "k".repeat(65);
    const rec = buildEloDeltaRecord({
      peerId: longPeer,
      start: 1,
      end: 2,
      keyId: longKey,
      iv: new Uint8Array(12),
      ct: new Uint8Array([0]),
    });
    const container = encodeEloContainer([rec]);
    ws.send(
      encode({
        type: MessageType.DocUpdate,
        crdt: "%ELO",
        roomId: "elo-bad2",
        updates: [container],
      } as any)
    );

    const err = await waitForUpdateError(ws);
    expect(err.code).toBe(UpdateErrorCode.InvalidUpdate);
  }, 15000);

  it("client encode rejects payloads larger than MAX_MESSAGE_SIZE", async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    await waitForOpen(ws);
    ws.send(
      encode({
        type: MessageType.JoinRequest,
        crdt: "%ELO",
        roomId: "elo-big",
        auth: new Uint8Array(),
        version: new Uint8Array(),
      } as any)
    );
    await waitForJoinOk(ws);

    // Build an oversized update (not an ELO container; generic path)
    const big = new Uint8Array(260 * 1024);
    let threw = false;
    try {
      encode({
        type: MessageType.DocUpdate,
        crdt: "%ELO",
        roomId: "elo-big",
        updates: [big],
      } as any);
    } catch (e) {
      threw = true;
      expect(String(e)).toMatch(/exceeds maximum/i);
    }
    expect(threw).toBe(true);
  }, 15000);
});

describe("E2E: %ELO decrypt failure and unknown key handling", () => {
  let server: SimpleServer;
  let port: number;

  beforeAll(async () => {
    port = await getPort();
    server = new SimpleServer({ port });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  }, 15000);

  it("client reports decrypt error for unknown keyId", async () => {
    const client1 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    const client2 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await Promise.all([client1.waitConnected(), client2.waitConnected()]);

    const key1 = new Uint8Array(16);
    key1[0] = 3;
    const key2 = new Uint8Array(16);
    key2[0] = 4;
    let decryptErrorCalled = false;
    const adaptor1 = createEloLoroAdaptor({
      getPrivateKey: async () => ({ keyId: "k1", key: key1 }),
    });
    const adaptor2 = createEloLoroAdaptor({
      getPrivateKey: async () => ({ keyId: "k2", key: key2 }),
      onDecryptError: () => {
        decryptErrorCalled = true;
      },
    });

    const room1 = await client1.join({ roomId: "elo-unknown", crdtAdaptor: adaptor1 });
    const room2 = await client2.join({ roomId: "elo-unknown", crdtAdaptor: adaptor2 });

    const t1 = adaptor1.getDoc().getText("t");
    t1.insert(0, "secret");
    adaptor1.getDoc().commit();

    await new Promise(r => setTimeout(r, 200));
    expect(decryptErrorCalled).toBe(true);
    // Client 2 doc should not have applied the change
    expect(adaptor2.getDoc().getText("t").toString()).toBe("");

    await room1.destroy();
    await room2.destroy();
  }, 15000);
});

// --- Helpers ---

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 5000);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("error", err => {
      clearTimeout(t);
      reject(err as any);
    });
  });
}

async function waitForJoinOk(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 5000);
    ws.on("message", (data: any) => {
      try {
        const msg = tryDecodeMsg(data);
        if (msg && msg.type === MessageType.JoinResponseOk) {
          clearTimeout(t);
          resolve();
        }
      } catch {}
    });
  });
}

async function waitForUpdateError(ws: WebSocket): Promise<any> {
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 5000);
    ws.on("message", (data: any) => {
      try {
        const msg = tryDecodeMsg(data);
        if (msg && msg.type === MessageType.UpdateError) {
          clearTimeout(t);
          resolve(msg);
        }
      } catch {}
    });
  });
}

function tryDecodeMsg(data: any): any | null {
  try {
    const u8 = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
    return tryDecode(u8);
  } catch {
    return null;
  }
}

function buildEloDeltaRecord(opts: {
  peerId: Uint8Array;
  start: number;
  end: number;
  keyId: string;
  iv: Uint8Array;
  ct: Uint8Array;
}): Uint8Array {
  const parts: number[] = [];
  pushByte(parts, 0x00); // kind DeltaSpan
  pushVarBytes(parts, opts.peerId);
  pushUleb128(parts, opts.start);
  pushUleb128(parts, opts.end);
  pushVarString(parts, opts.keyId);
  pushVarBytes(parts, opts.iv);
  pushVarBytes(parts, opts.ct);
  return new Uint8Array(parts);
}

function pushByte(out: number[], b: number) {
  out.push(b & 0xff);
}
function pushUleb128(out: number[], n: number) {
  let x = n >>> 0;
  while (x >= 0x80) {
    out.push((x & 0x7f) | 0x80);
    x >>>= 7;
  }
  out.push(x);
}
function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function pushVarBytes(out: number[], bytes: Uint8Array) {
  pushUleb128(out, bytes.length);
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]!);
}
function pushVarString(out: number[], s: string) {
  pushVarBytes(out, utf8Bytes(s));
}

async function waitUntil(cond: () => boolean, timeoutMs: number, interval = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error("Condition not met within timeout");
}
