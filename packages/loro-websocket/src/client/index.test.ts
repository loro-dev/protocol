import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CrdtType,
  JoinErrorCode,
  MessageType,
  type JoinError,
} from "loro-protocol";
import * as protocol from "loro-protocol";
import { LoroWebsocketClient, ClientStatus } from "./index";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CLOSED;
  bufferedAmount = 0;
  binaryType: any = "arraybuffer";
  url: string;
  lastSent: unknown;
  private listeners = new Map<string, Set<(ev: any) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (ev: any) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (ev: any) => void) {
    const set = this.listeners.get(type);
    set?.delete(listener);
  }

  dispatch(type: string, ev: any) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const l of Array.from(set)) l(ev);
  }

  send(data: any) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.lastSent = data;
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

describe("LoroWebsocketClient", () => {
  let originalWebSocket: any;

  beforeEach(() => {
    originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = FakeWebSocket as any;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  it("does not throw when retrying join after closed socket and reports via onError", async () => {
    const onError = vi.fn();
    const client = new LoroWebsocketClient({
      url: "ws://test",
      disablePing: true,
      reconnect: { enabled: false },
      onError,
    });

    const adaptor = {
      crdtType: CrdtType.Loro,
      setCtx: () => { },
      getVersion: () => new Uint8Array([0]),
      getAlternativeVersion: () => new Uint8Array([1]),
      handleJoinOk: async () => { },
      waitForReachingServerVersion: async () => { },
      destroy: () => { },
    } satisfies any;

    const joinError: JoinError = {
      type: MessageType.JoinError,
      code: JoinErrorCode.VersionUnknown,
      message: "",
      crdt: adaptor.crdtType,
      roomId: "room",
    };

    const pending = {
      room: Promise.resolve({} as any),
      resolve: () => { },
      reject: () => { },
      adaptor,
      roomId: "room",
    } satisfies any;

    // Avoid unhandled rejection when the client is destroyed without ever opening.
    (client as any).connectedPromise?.catch(() => { });

    // Force the current socket to a closed state so send will fail.
    (client as any).ws.readyState = FakeWebSocket.CLOSED;

    await expect(
      (client as any).handleJoinError(joinError, pending, adaptor.crdtType + "room")
    ).resolves.not.toThrow();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(((client as any).queuedJoins ?? []).length).toBeGreaterThan(0);

  });

  it("forwards decode or handler errors to onError instead of crashing", async () => {
    const onError = vi.fn();
    const client = new LoroWebsocketClient({
      url: "ws://test",
      disablePing: true,
      reconnect: { enabled: false },
      onError,
    });

    (client as any).connectedPromise?.catch(() => { });

    vi.spyOn(protocol, "tryDecode").mockImplementation(() => {
      throw new Error("decode failed");
    });

    await (client as any).onSocketMessage((client as any).ws, {
      data: new ArrayBuffer(0),
    } as MessageEvent<ArrayBuffer>);

    expect(onError).toHaveBeenCalledTimes(1);

  });

  it("does not leave unhandled promise rejections when destroy() is called during an in-flight reconnect attempt", async () => {
    // Reproduces the reconnect-adopter leak: scheduleReconnect()'s retry timer
    // calls `void this.connect()` as a bare, unreferenced call. `connect()` is
    // async and (on its normal path) just returns the shared
    // `connectedPromise`, so each such call creates its own "adopter" promise
    // chained to that shared promise. The shared promise itself is protected
    // by a `.catch(() => {})` in `ensureConnectedPromise()`, but that does not
    // protect these separate adopter promises. If `destroy()` rejects the
    // shared promise while a reconnect attempt is still in flight, every
    // accumulated adopter promise rejects too, with no handler anywhere.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const client = new LoroWebsocketClient({
        url: "ws://test",
        disablePing: true,
        reconnect: { enabled: true, initialDelayMs: 5, maxDelayMs: 5, jitter: 0 },
      });

      // Bring the initial socket to Connected.
      const firstWs = (client as any).ws as FakeWebSocket;
      firstWs.readyState = FakeWebSocket.OPEN;
      firstWs.dispatch("open", {});
      expect(client.getStatus()).toBe(ClientStatus.Connected);

      // Simulate an unexpected close, which schedules a reconnect attempt.
      firstWs.readyState = FakeWebSocket.CLOSED;
      firstWs.dispatch("close", { code: 1006, reason: "" });

      // Wait for the reconnect timer to fire. This creates a new socket via
      // scheduleReconnect()'s bare `void this.connect()` call - the adopter
      // promise from the bug report.
      await new Promise(resolve => setTimeout(resolve, 30));

      // A second (never-opened) socket is now the active reconnect attempt.
      expect((client as any).ws).not.toBe(firstWs);

      // Destroying mid-reconnect rejects the shared connectedPromise. Without
      // the fix, the adopter promise created above has no catch handler.
      client.destroy();

      // Give Node's event queue a chance to report any unhandled rejection
      // before we assert.
      await new Promise(resolve => setTimeout(resolve, 30));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandled).toHaveLength(0);
  });
});
