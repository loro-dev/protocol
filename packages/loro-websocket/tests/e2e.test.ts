import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import getPort from "get-port";
import { SimpleServer } from "../src/server/simple-server";
import { LoroWebsocketClient } from "../src/client";
import { ClientStatus } from "../src/client";
import { createLoroAdaptor } from "loro-adaptors";

// Make WebSocket available globally for the client
Object.defineProperty(globalThis, "WebSocket", {
  value: WebSocket,
  configurable: true,
  writable: true,
});

describe("E2E: Client-Server Sync", () => {
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

  it("should sync two clients through server", async () => {
    // Create two clients
    const client1 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    const client2 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });

    await client1.waitConnected();
    await client2.waitConnected();

    // Create adaptors with separate documents
    const adaptor1 = createLoroAdaptor({ peerId: 1 });

    const adaptor2 = createLoroAdaptor({ peerId: 2 });

    // Join the same room
    const room1 = await client1.join({
      roomId: "test-room",
      crdtAdaptor: adaptor1,
    });

    const room2 = await client2.join({
      roomId: "test-room",
      crdtAdaptor: adaptor2,
    });

    // Wait a bit for join handshake
    await new Promise(resolve => setTimeout(resolve, 100));

    // Client1 makes changes
    const text1 = adaptor1.getDoc().getText("shared");
    text1.insert(0, "Hello from client1!");
    adaptor1.getDoc().commit();

    // Wait for sync
    await new Promise(resolve => setTimeout(resolve, 200));

    // Check client2 received the update
    const text2 = adaptor2.getDoc().getText("shared");
    expect(text2.toString()).toBe("Hello from client1!");

    // Client2 makes changes
    text2.insert(text2.length, " Hello from client2!");
    adaptor2.getDoc().commit();

    // Wait for sync
    await new Promise(resolve => setTimeout(resolve, 200));

    // Check client1 received the update
    expect(text1.toString()).toBe("Hello from client1! Hello from client2!");

    // Both documents should be identical
    expect(adaptor1.getDoc().getText("shared").toString()).toBe(
      adaptor2.getDoc().getText("shared").toString()
    );

    // Cleanup
    await room1.destroy();
    await room2.destroy();
  }, 10000);

  it("should handle client reconnection", async () => {
    const client1 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client1.waitConnected();

    const adaptor1 = createLoroAdaptor({ peerId: 3 });

    // Join room and make changes
    const room1 = await client1.join({
      roomId: "reconnect-room",
      crdtAdaptor: adaptor1,
    });

    const text = adaptor1.getDoc().getText("content");
    text.insert(0, "Before disconnect");
    adaptor1.getDoc().commit();

    await new Promise(resolve => setTimeout(resolve, 100));

    // Leave room
    await room1.destroy();

    // Create new client connection (simulating reconnection)
    const client2 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client2.waitConnected();

    // Create fresh adaptor but with existing document state
    const adaptor2 = createLoroAdaptor({ peerId: 4 });

    // Rejoin same room
    const room2 = await client2.join({
      roomId: "reconnect-room",
      crdtAdaptor: adaptor2,
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    // Make additional changes
    const text2 = adaptor2.getDoc().getText("content");
    text2.insert(0, "After reconnect");
    adaptor2.getDoc().commit();

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(text2.toString()).toBe("After reconnect");

    await room2.destroy();
  }, 10000);

  it("should resolve ping() with pong", async () => {
    const client = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client.waitConnected();

    // Expect ping roundtrip within timeout
    await client.ping(2000);
  }, 10000);

  it("emits correct status transitions across reconnects and manual close/connect", async () => {
    const client = new LoroWebsocketClient({ url: `ws://localhost:${port}` });

    const seen: string[] = [];
    const unsub = client.onStatusChange(s => seen.push(s));

    // Initial -> Connecting -> Connected
    await client.waitConnected();
    expect(seen[0]).toBe(ClientStatus.Connecting);
    expect(seen.includes(ClientStatus.Connected)).toBe(true);

    // Simulate unexpected disconnect by stopping server
    await server.stop();

    // Wait until client reports Reconnecting
    await waitUntil(
      () => seen.includes(ClientStatus.Reconnecting),
      5000,
      25
    );

    // Bring server back; client should auto-reconnect
    await server.start();
    await waitUntil(
      () => seen[seen.length - 1] === ClientStatus.Connected,
      8000,
      50
    );

    // Manual close -> Disconnected, no auto-retry
    client.close();
    await waitUntil(
      () => seen[seen.length - 1] === ClientStatus.Disconnected,
      2000
    );
    // Ensure it stays disconnected for a moment
    const lenAtDisconnect = seen.length;
    await new Promise(r => setTimeout(r, 800));
    expect(seen.length).toBe(lenAtDisconnect);

    // Manual connect resumes retries and reconnects
    const connectPromise = client.connect();
    await waitUntil(
      () => seen[seen.length - 1] === ClientStatus.Connecting,
      2000
    );
    await connectPromise;
    await waitUntil(
      () => seen[seen.length - 1] === ClientStatus.Connected,
      4000
    );

    unsub();
    client.destroy();
  }, 20000);

  it("onStatusChange emits immediately and unsubscribe stops future events", async () => {
    const client = new LoroWebsocketClient({ url: `ws://localhost:${port}` });

    const seen: string[] = [];
    const unsub = client.onStatusChange(s => seen.push(s));
    // Should emit current status immediately
    expect(seen[0]).toBe(ClientStatus.Connecting);

    await client.waitConnected();
    expect(seen.includes(ClientStatus.Connected)).toBe(true);

    // Unsubscribe then cause a disconnect; list should not grow further
    unsub();
    const before = seen.length;
    await server.stop();
    await new Promise(r => setTimeout(r, 150));
    await server.start();
    await new Promise(r => setTimeout(r, 200));
    expect(seen.length).toBe(before);

    client.destroy();
  }, 15000);

  it("onLatency notifies after ping and getLatency returns value; immediate emission on subscribe", async () => {
    const client = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client.waitConnected();

    let notified = 0;
    let lastLatency: number | undefined;
    const off = client.onLatency(ms => {
      notified++;
      lastLatency = ms;
    });

    await client.ping(2000);
    await waitUntil(() => notified > 0 && lastLatency != null, 2000, 25);

    // Getter should reflect last RTT
    const got = client.getLatency();
    expect(typeof got === "number" && isFinite(got!)).toBe(true);

    // Subscribe again; should emit immediately with current latency
    let immediate: number | undefined;
    const off2 = client.onLatency(ms => {
      immediate = ms;
    });
    expect(typeof immediate === "number").toBe(true);

    off();
    off2();
    client.destroy();
  }, 10000);

  it("rejoins rooms after reconnect and continues syncing", async () => {
    const client1 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    const client2 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await Promise.all([client1.waitConnected(), client2.waitConnected()]);

    const adaptor1 = createLoroAdaptor({ peerId: 11 });
    const adaptor2 = createLoroAdaptor({ peerId: 22 });

    await client1.join({ roomId: "rejoin-room", crdtAdaptor: adaptor1 });
    await client2.join({ roomId: "rejoin-room", crdtAdaptor: adaptor2 });

    // Stop server so both clients disconnect and attempt to reconnect
    await server.stop();
    // Give time to observe close and schedule reconnect
    await new Promise(r => setTimeout(r, 200));
    await server.start();

    // Wait until both clients are connected again
    await waitUntil(
      () =>
        client1.getStatus() === ClientStatus.Connected &&
        client2.getStatus() === ClientStatus.Connected,
      8000,
      50
    );

    // Make a change from client1 and ensure client2 receives it
    const t1 = adaptor1.getDoc().getText("x");
    t1.insert(0, "r1");
    adaptor1.getDoc().commit();

    await waitUntil(
      () => adaptor2.getDoc().getText("x").toString() === "r1",
      3000,
      50
    );

    client1.destroy();
    client2.destroy();
  }, 20000);

  it("destroy rejects pending ping waiters", async () => {
    const client = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client.waitConnected();

    // Suppress pong handling so the ping promise stays pending until destroy
    const clientWithPong = client as unknown as {
      handlePong: () => void;
    };
    const originalHandlePong = clientWithPong.handlePong;
    clientWithPong.handlePong = () => {};

    const pingPromise = client.ping(5000);

    await new Promise(resolve => setTimeout(resolve, 0));

    client.destroy();

    const outcome = await pingPromise
      .then(() => ({ kind: "resolved" as const }))
      .catch((err: unknown) => ({ kind: "rejected" as const, err }));

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      const message =
        outcome.err instanceof Error
          ? outcome.err.message
          : String(outcome.err);
      expect(message).toMatch(/Destroyed|closed/);
    }

    clientWithPong.handlePong = originalHandlePong;
  }, 10000);

  it("allows immediate reconnect after close without hanging", async () => {
    const client = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client.waitConnected();

    client.close();
    const reconnect = client.connect();

    // Let the previous socket dispatch its close event before awaiting connect
    await new Promise(resolve => setTimeout(resolve, 10));

    await reconnect;
    await waitUntil(() => client.getStatus() === ClientStatus.Connected, 5000);

    client.destroy();
  }, 15000);
});

// Small polling helper for this file
async function waitUntil(
  cond: () => boolean,
  timeoutMs: number,
  interval = 25
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error("Condition not met within timeout");
}
