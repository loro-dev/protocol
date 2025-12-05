import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import getPort from "get-port";
import { SimpleServer } from "../src/server/simple-server";
import { LoroWebsocketClient, ClientStatus } from "../src/client";
import type { LoroWebsocketClientRoom } from "../src/client";
import { LoroAdaptor } from "loro-adaptors/loro";
import { FlockAdaptor } from "loro-adaptors/flock";
import { Flock } from "@loro-dev/flock";
import {
  encode,
  decode,
  MessageType,
  RoomErrorCode,
  type JoinResponseOk,
  type RoomError,
} from "loro-protocol";



// Make WebSocket available globally for the client
Object.defineProperty(globalThis, "WebSocket", {
  value: WebSocket,
  configurable: true,
  writable: true,
});

describe("E2E: Client-Server Sync", () => {
  let server: SimpleServer;
  let port: number;
  let skip = false;

  beforeAll(async () => {
    try {
      port = await getPort();
      server = new SimpleServer({ port });
      await server.start();
    } catch (e) {
      skip = true;
      console.warn("Skipping e2e tests: cannot bind port", e);
    }
  });

  afterAll(async () => {
    if (!skip && server) {
      await server.stop();
    }
  }, 15000);

  it("should sync two clients through server", async () => {
    if (skip) return;
    // Create two clients
    if (skip) return;
    const client1 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    const client2 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });

    await client1.waitConnected();
    await client2.waitConnected();

    // Create adaptors with separate documents
    const adaptor1 = new LoroAdaptor();

    const adaptor2 = new LoroAdaptor();

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

  it("should sync Flock adaptors to a consistent state", async () => {
    const client1 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    const client2 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });

    await Promise.all([client1.waitConnected(), client2.waitConnected()]);

    const adaptor1 = new FlockAdaptor(new Flock());
    const adaptor2 = new FlockAdaptor(new Flock());

    const room1 = await client1.join({
      roomId: "flock-room",
      crdtAdaptor: adaptor1,
    });
    const room2 = await client2.join({
      roomId: "flock-room",
      crdtAdaptor: adaptor2,
    });

    await Promise.all([
      room1.waitForReachingServerVersion(),
      room2.waitForReachingServerVersion(),
    ]);

    const doc1 = adaptor1.getDoc();
    const doc2 = adaptor2.getDoc();

    doc1.put(["greeting"], "hello");
    doc2.put(["greeting"], "hello world");
    doc2.put(["counter"], 1);
    doc1.put(["nested", "value"], { a: 1, b: true });

    await waitUntil(
      () => {
        const state1 = JSON.stringify(doc1.exportJson());
        const state2 = JSON.stringify(doc2.exportJson());
        return state1 === state2;
      },
      6000,
      50
    );

    expect(doc2.get(["greeting"])).toBe("hello world");
    expect(doc2.get(["counter"])).toBe(1);
    expect(doc2.get(["nested", "value"])).toEqual({ a: 1, b: true });

    await Promise.all([room1.destroy(), room2.destroy()]);
    client1.destroy();
    client2.destroy();
  }, 10000);

  it("should handle client reconnection", async () => {
    const client1 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client1.waitConnected();

    const adaptor1 = new LoroAdaptor();

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
    const adaptor2 = new LoroAdaptor();

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

    expect(text2.toString()).toBe("After reconnectBefore disconnect");

    await room2.destroy();
  }, 10000);

  it("should resolve ping() with pong", async () => {
    if (skip) return;
    const client = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client.waitConnected();

    // Expect ping roundtrip within timeout
    await client.ping(2000);
  }, 10000);

  it("emits correct status transitions across reconnects and manual close/connect", async () => {
    if (skip) return;
    const client = new LoroWebsocketClient({ url: `ws://localhost:${port}` });

    const seen: string[] = [];
    const unsub = client.onStatusChange(s => seen.push(s));

    // Initial -> Connecting -> Connected
    await client.waitConnected();
    expect(seen[0]).toBe(ClientStatus.Connecting);
    expect(seen.includes(ClientStatus.Connected)).toBe(true);

    // Simulate unexpected disconnect by stopping server
    await server.stop();

    // Wait until client reports Disconnected
    await waitUntil(() => seen.includes(ClientStatus.Disconnected), 5000, 25);

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
    const hasFiniteLatency = typeof got === "number" && Number.isFinite(got);
    expect(hasFiniteLatency).toBe(true);

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

    const adaptor1 = new LoroAdaptor();
    const adaptor2 = new LoroAdaptor();

    const statusLog: Array<{ client: number; status: string }> = [];

    await client1.join({
      roomId: "rejoin-room",
      crdtAdaptor: adaptor1,
      onStatusChange: s => statusLog.push({ client: 1, status: s }),
    });
    await client2.join({
      roomId: "rejoin-room",
      crdtAdaptor: adaptor2,
      onStatusChange: s => statusLog.push({ client: 2, status: s }),
    });

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

    expect(statusLog.some(e => e.status === "reconnecting")).toBe(true);
    expect(statusLog.some(e => e.status === "joined")).toBe(true);

    client1.destroy();
    client2.destroy();
  }, 20000);

  it("resumes syncing after simulated offline/online events", async () => {
    const env = installMockWindow();
    let client1: LoroWebsocketClient | undefined;
    let client2: LoroWebsocketClient | undefined;
    let unsubscribe1: (() => void) | undefined;
    let unsubscribe2: (() => void) | undefined;
    try {
      client1 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
      client2 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });

      const statuses1: string[] = [];
      const statuses2: string[] = [];
      unsubscribe1 = client1.onStatusChange(s => statuses1.push(s));
      unsubscribe2 = client2.onStatusChange(s => statuses2.push(s));

      await Promise.all([client1.waitConnected(), client2.waitConnected()]);
      const initialConnected1 = statuses1.filter(
        s => s === ClientStatus.Connected
      ).length;
      const initialConnected2 = statuses2.filter(
        s => s === ClientStatus.Connected
      ).length;
      const adaptor1 = new LoroAdaptor();
      const adaptor2 = new LoroAdaptor();

      const [room1, room2] = await Promise.all([
        client1.join({ roomId: "offline-room", crdtAdaptor: adaptor1 }),
        client2.join({ roomId: "offline-room", crdtAdaptor: adaptor2 }),
      ]);

      const text1 = adaptor1.getDoc().getText("shared");
      const text2 = adaptor2.getDoc().getText("shared");

      text1.insert(0, "seed");
      adaptor1.getDoc().commit();
      await waitUntil(() => text2.toString() === "seed", 3000, 50);

      env.goOffline();
      await waitUntil(
        () =>
          client1!.getStatus() === ClientStatus.Disconnected &&
          client2!.getStatus() === ClientStatus.Disconnected,
        5000,
        25
      );
      expect(statuses1.includes(ClientStatus.Disconnected)).toBe(true);
      expect(statuses2.includes(ClientStatus.Disconnected)).toBe(true);

      text1.insert(text1.length, " offline edit");
      adaptor1.getDoc().commit();
      const expected = text1.toString();

      await new Promise(resolve => setTimeout(resolve, 50));

      env.goOnline();
      await waitUntil(
        () =>
          client1!.getStatus() === ClientStatus.Connected &&
          client2!.getStatus() === ClientStatus.Connected,
        10000,
        50
      );

      await waitUntil(
        () =>
          statuses1.filter(s => s === ClientStatus.Connected).length >
            initialConnected1 &&
          statuses2.filter(s => s === ClientStatus.Connected).length >
            initialConnected2,
        5000,
        25
      );

      await waitUntil(() => text2.toString() === expected, 5000, 50);

      await Promise.all([room1.destroy(), room2.destroy()]);
    } finally {
      unsubscribe1?.();
      unsubscribe2?.();
      client1?.destroy();
      client2?.destroy();
      env.restore();
    }
  }, 20000);

  it("reconnects even when the online event never fires", async () => {
    const env = installMockWindow();
    let client1: LoroWebsocketClient | undefined;
    let client2: LoroWebsocketClient | undefined;
    let unsubscribe1: (() => void) | undefined;
    let unsubscribe2: (() => void) | undefined;
    let room1: LoroWebsocketClientRoom | undefined;
    let room2: LoroWebsocketClientRoom | undefined;
    try {
      client1 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
      client2 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });

      const statuses1: string[] = [];
      const statuses2: string[] = [];
      unsubscribe1 = client1.onStatusChange(s => statuses1.push(s));
      unsubscribe2 = client2.onStatusChange(s => statuses2.push(s));

      await Promise.all([client1.waitConnected(), client2.waitConnected()]);

      // Keep placeholders to mirror earlier assertions; unused now
      const _initialConnectedCount1 = statuses1.filter(
        s => s === ClientStatus.Connected
      ).length;
      const _initialConnectedCount2 = statuses2.filter(
        s => s === ClientStatus.Connected
      ).length;

      const adaptor1 = new LoroAdaptor();
      const adaptor2 = new LoroAdaptor();

      [room1, room2] = await Promise.all([
        client1.join({ roomId: "offline-no-online", crdtAdaptor: adaptor1 }),
        client2.join({ roomId: "offline-no-online", crdtAdaptor: adaptor2 }),
      ]);

      const text1 = adaptor1.getDoc().getText("shared");
      const text2 = adaptor2.getDoc().getText("shared");

      text1.insert(0, "seed");
      adaptor1.getDoc().commit();
      await waitUntil(() => text2.toString() === "seed", 3000, 50);

      env.goOffline();
      await waitUntil(
        () =>
          client1!.getStatus() === ClientStatus.Disconnected &&
          client2!.getStatus() === ClientStatus.Disconnected,
        5000,
        25
      );
      await server.stop();

      expect((navigator as { onLine?: boolean }).onLine).toBe(false);

      // No env.goOnline() here – navigator stays offline
      await new Promise(resolve => setTimeout(resolve, 200));
      await server.start();

      // Without an online event, auto-retry should stay paused
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(statuses1[statuses1.length - 1]).toBe(ClientStatus.Disconnected);
      expect(statuses2[statuses2.length - 1]).toBe(ClientStatus.Disconnected);

      // Manual retry should override the pause
      await Promise.all([client1.retryNow(), client2.retryNow()]);
      await waitUntil(
        () =>
          client1!.getStatus() === ClientStatus.Connected &&
          client2!.getStatus() === ClientStatus.Connected,
        10000,
        50
      );

      text1.insert(text1.length, " rebound");
      adaptor1.getDoc().commit();
      await waitUntil(() => text2.toString() === "seed rebound", 5000, 50);
    } finally {
      unsubscribe1?.();
      unsubscribe2?.();
      await Promise.all([room1?.destroy(), room2?.destroy()]);
      client1?.destroy();
      client2?.destroy();
      env.restore();
    }
  }, 20000);

  it("emits room status error when auth changes and stops auto rejoin", async () => {
    let allowAuth = true;
    const authPort = await getPort();
    const authServer = new SimpleServer({
      port: authPort,
      authenticate: async (_roomId, _crdt, _auth) => (allowAuth ? "write" : null),
    });
    await authServer.start();

    const client = new LoroWebsocketClient({ url: `ws://localhost:${authPort}` });
    await client.waitConnected();
    const adaptor = new LoroAdaptor();
    const statuses: string[] = [];
    await client.join({
      roomId: "auth-room",
      crdtAdaptor: adaptor,
      auth: new TextEncoder().encode("token"),
      onStatusChange: s => statuses.push(s),
    });

    // Take server offline, then disallow auth and bring it back
    await authServer.stop();
    allowAuth = false;
    await authServer.start();

    await waitUntil(
      () =>
        statuses.includes("error"),
      8000,
      50
    );

    client.destroy();
    await authServer.stop();
  }, 15000);

  it("destroy rejects pending ping waiters", async () => {
    const client = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client.waitConnected();

    // Suppress pong handling so the ping promise stays pending until destroy
    const clientWithPong = client as unknown as {
      handlePong: () => void;
    };
    const originalHandlePong = clientWithPong.handlePong;
    clientWithPong.handlePong = () => { };

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

  it("stops auto-retry after fatal close code and retryNow reconnects", async () => {
    const fatalPort = await getPort();
    const wss = new WebSocketServer({ port: fatalPort });
    let connections = 0;
    wss.on("connection", ws => {
      connections++;
      const connId = connections;
      ws.on("message", (data: Buffer | ArrayBuffer | string) => {
        const text =
          typeof data === "string"
            ? data
            : Buffer.isBuffer(data)
              ? data.toString()
              : new TextDecoder().decode(new Uint8Array(data));
        if (text === "ping") {
          // Only respond for non-fatal connections
          if (connId >= 2) {
            ws.send("pong");
          }
        }
      });
      if (connId === 1) {
        setTimeout(() => {
          try {
            ws.close(1008, "policy");
          } catch {}
        }, 30);
      }
    });

    const client = new LoroWebsocketClient({
      url: `ws://localhost:${fatalPort}`,
      pingIntervalMs: 50,
      pingTimeoutMs: 200,
    });
    const statuses: string[] = [];
    const off = client.onStatusChange(s => statuses.push(s));

    await client.waitConnected();
    await waitUntil(
      () => statuses.includes(ClientStatus.Disconnected),
      4000,
      25
    );

    // Ensure it does not auto-retry after fatal close
    const lenAfterFatal = statuses.length;
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(statuses.length).toBe(lenAfterFatal);
    expect(statuses[statuses.length - 1]).toBe(ClientStatus.Disconnected);

    // Manual retry should reconnect
    await client.retryNow();
    await waitUntil(
      () => client.getStatus() === ClientStatus.Connected,
      4000,
      25
    );

    off();
    client.destroy();
    wss.close();
  }, 10000);

  it("marks room disconnected when maxAttempts reached", async () => {
    const maxPort = await getPort();
    const wss = new WebSocketServer({ port: maxPort });
    wss.on("connection", ws => {
      // Immediately close to force retries
      ws.close(1011, "boom");
    });

    const statuses: string[] = [];
    const roomStatuses: string[] = [];
    const client = new LoroWebsocketClient({
      url: `ws://localhost:${maxPort}`,
      reconnect: { maxAttempts: 1, initialDelayMs: 50, maxDelayMs: 50 },
    });
    client.onStatusChange(s => statuses.push(s));

    const adaptor = new LoroAdaptor();
    const join = client.join({
      roomId: "limited-room",
      crdtAdaptor: adaptor,
      onStatusChange: s => roomStatuses.push(s),
    });

    await expect(join).rejects.toBeTruthy();

    await waitUntil(
      () => statuses.at(-1) === ClientStatus.Disconnected,
      4000,
      25
    );
    expect(roomStatuses.at(-1)).toBe("disconnected");

    client.destroy();
    wss.close();
  }, 8000);

  it("queues joins issued while connecting and flushes once connected", async () => {
    const queuedPort = await getPort();
    const client = new LoroWebsocketClient({
      url: `ws://localhost:${queuedPort}`,
      pingIntervalMs: 200, // slow ping to avoid noise before server up
    });
    const adaptor = new LoroAdaptor();
    const statuses: string[] = [];

    const joinPromise = client.join({
      roomId: "queued-join",
      crdtAdaptor: adaptor,
      onStatusChange: s => statuses.push(s),
    });

    // Start server after join was requested
    await new Promise(resolve => setTimeout(resolve, 200));
    const server = new SimpleServer({ port: queuedPort });
    await server.start();

    const room = await joinPromise;
    const text = adaptor.getDoc().getText("q");
    text.insert(0, "hello");
    adaptor.getDoc().commit();
    await room.waitForReachingServerVersion();

    expect(statuses).toContain("connecting");
    expect(statuses).toContain("joined");

    await room.destroy();
    client.destroy();
    await server.stop();
  }, 12000);

  it("emits room joined status exactly once for an initial join", async () => {
    const localPort = await getPort();
    const localServer = new SimpleServer({ port: localPort });
    await localServer.start();
    const client = new LoroWebsocketClient({ url: `ws://localhost:${localPort}` });
    try {
      await client.waitConnected();
      const adaptor = new LoroAdaptor();
      const statuses: string[] = [];
      await client.join({
        roomId: "single-join",
        crdtAdaptor: adaptor,
        onStatusChange: s => statuses.push(s),
      });

      await waitUntil(
        () => statuses.filter(s => s === "joined").length === 1,
        5000,
        25
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(statuses.filter(s => s === "joined").length).toBe(1);
      expect(statuses[0]).toBe("connecting");
    } finally {
      client.destroy();
      await localServer.stop();
    }
  }, 10000);

  it("emits room joined status once per reconnect cycle", async () => {
    const localPort = await getPort();
    const localServer = new SimpleServer({ port: localPort });
    await localServer.start();
    const client = new LoroWebsocketClient({ url: `ws://localhost:${localPort}` });
    try {
      await client.waitConnected();
      const adaptor = new LoroAdaptor();
      const statuses: string[] = [];
      await client.join({
        roomId: "rejoin-once",
        crdtAdaptor: adaptor,
        onStatusChange: s => statuses.push(s),
      });

      await waitUntil(
        () => statuses.filter(s => s === "joined").length === 1,
        5000,
        25
      );

      await localServer.stop();
      await waitUntil(() => statuses.includes("reconnecting"), 5000, 25);
      await new Promise(resolve => setTimeout(resolve, 200));
      await localServer.start();

      await waitUntil(
        () => client.getStatus() === ClientStatus.Connected,
        8000,
        50
      );
      await waitUntil(
        () => statuses.filter(s => s === "joined").length === 2,
        8000,
        50
      );

      expect(statuses.filter(s => s === "joined").length).toBe(2);
      expect(statuses.includes("reconnecting")).toBe(true);
    } finally {
      client.destroy();
      await localServer.stop();
    }
  }, 20000);

  it("forces reconnect after ping timeout and recovers when pongs return", async () => {
    const pongPort = await getPort();
    const wss = new WebSocketServer({ port: pongPort });
    let connId = 0;
    wss.on("connection", ws => {
      const id = ++connId;
      ws.on("message", (data: Buffer | ArrayBuffer | string) => {
        const text =
          typeof data === "string"
            ? data
            : Buffer.isBuffer(data)
              ? data.toString()
              : new TextDecoder().decode(new Uint8Array(data));
        if (text === "ping") {
          if (id >= 2) ws.send("pong");
          // first connection intentionally ignores to trigger timeout
        }
      });
    });

    const statuses: string[] = [];
    const client = new LoroWebsocketClient({
      url: `ws://localhost:${pongPort}`,
      pingIntervalMs: 80,
      pingTimeoutMs: 100,
      reconnect: { initialDelayMs: 50, maxDelayMs: 200, jitter: 0 },
    });
    client.onStatusChange(s => statuses.push(s));

    await client.waitConnected();
    await waitUntil(
      () => statuses.includes(ClientStatus.Disconnected),
      5000,
      25
    );
    await waitUntil(
      () =>
        statuses.filter(s => s === ClientStatus.Connected).length >= 2 &&
        connId >= 2,
      6000,
      25
    );

    // Stay connected for a short window to ensure stability
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(client.getStatus()).toBe(ClientStatus.Connected);

    client.destroy();
    wss.close();
  }, 12000);
});

describe("E2E: RoomError rejoin policy", () => {
  it("does not auto rejoin after eviction (0x02)", async () => {
    const port = await getPort();
    const wss = new WebSocketServer({ port });
    let joinCount = 0;

    wss.on("connection", ws => {
      ws.on("message", data => {
        let msg;
        try {
          msg = decode(toUint8Array(data));
        } catch {
          return;
        }
        if (msg.type === MessageType.JoinRequest) {
          joinCount += 1;
          const res: JoinResponseOk = {
            type: MessageType.JoinResponseOk,
            crdt: msg.crdt,
            roomId: msg.roomId,
            permission: "write",
            version: new Uint8Array(),
          };
          ws.send(encode(res));
          setTimeout(() => {
            const err: RoomError = {
              type: MessageType.RoomError,
              crdt: msg.crdt,
              roomId: msg.roomId,
              code: RoomErrorCode.Evicted,
              message: "evicted",
            };
            ws.send(encode(err));
          }, 50);
        }
      });
    });

    const client = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client.waitConnected();
    const adaptor = new LoroAdaptor();
    await client.join({ roomId: "room-evict", crdtAdaptor: adaptor });

    // Wait to allow potential auto-rejoin attempts
    await new Promise(r => setTimeout(r, 400));

    expect(joinCount).toBe(1);

    await client.destroy();
    wss.close();
  }, 5000);

  it("auto rejoins once when server suggests rejoin (0x01)", async () => {
    const port = await getPort();
    const wss = new WebSocketServer({ port });
    let joinCount = 0;

    wss.on("connection", ws => {
      ws.on("message", data => {
        let msg;
        try {
          msg = decode(toUint8Array(data));
        } catch {
          return;
        }
        if (msg.type === MessageType.JoinRequest) {
          joinCount += 1;
          const res: JoinResponseOk = {
            type: MessageType.JoinResponseOk,
            crdt: msg.crdt,
            roomId: msg.roomId,
            permission: "write",
            version: new Uint8Array(),
          };
          ws.send(encode(res));
          // Only prompt rejoin on first join
          if (joinCount === 1) {
            setTimeout(() => {
              const err: RoomError = {
                type: MessageType.RoomError,
                crdt: msg.crdt,
                roomId: msg.roomId,
                code: RoomErrorCode.RejoinSuggested,
                message: "please rejoin",
              };
              ws.send(encode(err));
            }, 50);
          }
        }
      });
    });

    const client = new LoroWebsocketClient({
      url: `ws://localhost:${port}`,
      reconnect: { initialDelayMs: 50, maxDelayMs: 150, jitter: 0 },
    });
    await client.waitConnected();
    const adaptor = new LoroAdaptor();
    await client.join({ roomId: "room-rejoin", crdtAdaptor: adaptor });

    await waitUntil(() => joinCount >= 2, 5000, 20).catch(() => {});
    // Ensure no extra rejoins
    await new Promise(r => setTimeout(r, 200));
    expect(joinCount).toBe(2);

    await client.destroy();
    wss.close();
  }, 8000);
});

function installMockWindow(initialOnline = true) {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window"
  );
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator"
  );

  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const state = { online: initialOnline };

  const mockWindow = {
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject
    ) {
      if (!listener) return;
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject
    ) {
      const set = listeners.get(type);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) {
        listeners.delete(type);
      }
    },
  } as Pick<Window, "addEventListener" | "removeEventListener">;

  const mockNavigator = {
    get onLine() {
      return state.online;
    },
    set onLine(value: boolean) {
      state.online = value;
    },
  } as Navigator & { onLine: boolean };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: mockWindow,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: mockNavigator,
  });

  const dispatch = (type: "online" | "offline") => {
    state.online = type === "online";
    const set = listeners.get(type);
    if (!set) return;
    const evt = { type } as Event;
    for (const listener of Array.from(set)) {
      if (typeof listener === "function") {
        listener.call(mockWindow, evt);
      } else if (isEventListenerObject(listener)) {
        listener.handleEvent.call(mockWindow, evt);
      }
    }
  };

  return {
    goOnline() {
      dispatch("online");
    },
    goOffline() {
      dispatch("offline");
    },
    restore() {
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
      if (originalNavigatorDescriptor) {
        Object.defineProperty(
          globalThis,
          "navigator",
          originalNavigatorDescriptor
        );
      } else {
        Reflect.deleteProperty(globalThis, "navigator");
      }
      listeners.clear();
    },
  };
}

function isEventListenerObject(
  value: EventListenerOrEventListenerObject
): value is EventListenerObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "handleEvent" in value &&
    typeof value.handleEvent === "function"
  );
}

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

function toUint8Array(data: Buffer | ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // Buffer from ws in Node
  // @ts-ignore
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return new Uint8Array(data);
  return new Uint8Array();
}
// (duplicate WebSocketServer import removed)
