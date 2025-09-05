import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import getPort from "get-port";
import { SimpleServer } from "./server/simple-server";
import { LoroWebsocketClient } from "./client";
import { createEloLoroAdaptor } from "loro-adaptors";

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
});

async function waitUntil(cond: () => boolean, timeoutMs: number, interval = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error("Condition not met within timeout");
}
