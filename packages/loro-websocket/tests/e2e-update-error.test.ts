import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import getPort from "get-port";
import { LoroAdaptor } from "loro-adaptors/loro";
import {
  Ack,
  MessageType,
  UpdateStatusCode,
  encode,
  decode,
  type JoinRequest,
  type ProtocolMessage,
} from "loro-protocol";
import { LoroWebsocketClient } from "../src/client";

// Make WebSocket available globally for the client
Object.defineProperty(globalThis, "WebSocket", {
  value: WebSocket,
  configurable: true,
  writable: true,
});

describe("E2E: onUpdateError", () => {
  let server: WebSocketServer;
  let port: number;
  let skip = false;
  let lastUpdates: Uint8Array[] = [];

  beforeAll(async () => {
    try {
      port = await getPort();
      server = new WebSocketServer({ port });

      server.on("connection", ws => {
        ws.on("message", data => {
          const msg = decode(toUint8Array(data));
          if (!msg) return;
          handleMessage(ws, msg);
        });
      });
    } catch (e) {
      skip = true;
      console.warn("Skipping onUpdateError e2e: cannot start ws server", e);
    }
  });

  afterAll(async () => {
    if (skip || !server) return;
    for (const client of server.clients) {
      try {
        client.terminate();
      } catch { }
    }
    await new Promise(resolve => server.close(() => resolve(undefined)));
  });

  it("invokes adaptor onUpdateError with original batch", async () => {
    if (skip) return;

    const errors: Array<{ updates: Uint8Array[]; code: number; reason?: string }> = [];
    const adaptor = new LoroAdaptor(undefined, {
      onUpdateError: (updates, code, reason) => {
        errors.push({ updates: updates.map(u => u.slice()), code, reason });
      },
    });

    const client = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client.waitConnected();

    const room = await client.join({ roomId: "err-room", crdtAdaptor: adaptor });

    // Emit one local update
    const text = adaptor.getDoc().getText("body");
    text.insert(0, "boom");
    adaptor.getDoc().commit();

    await waitUntil(() => errors.length > 0, 2000, 25);

    const err = errors[0];
    expect(err.code).toBe(UpdateStatusCode.InvalidUpdate);
    expect(err.reason).toBe("invalid_update");
    expect(err.updates.length).toBe(1);
    expect(lastUpdates.length).toBe(1);
    expect(err.updates[0]!.length).toBeGreaterThan(0);

    await room.destroy();
    client.destroy();
  }, 5000);

  function handleMessage(ws: WebSocket, msg: ProtocolMessage) {
    switch (msg.type) {
      case MessageType.JoinRequest: {
        const jr = msg as JoinRequest;
        ws.send(
          encode({
            type: MessageType.JoinResponseOk,
            crdt: jr.crdt,
            roomId: jr.roomId,
            permission: "write",
            version: new Uint8Array(),
            extraMetadata: new Uint8Array(),
          })
        );
        break;
      }
      case MessageType.DocUpdate: {
        lastUpdates = msg.updates.map(u => new Uint8Array(u));
        const ack: Ack = {
          type: MessageType.Ack,
          crdt: msg.crdt,
          roomId: msg.roomId,
          refId: msg.batchId,
          status: UpdateStatusCode.InvalidUpdate,
        };
        ws.send(encode(ack));
        break;
      }
      default:
        break;
    }
  }
});

function toUint8Array(data: unknown): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer)
    return new Uint8Array(data);
  // @ts-expect-error Buffer from ws
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    // @ts-expect-error Buffer type
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    // @ts-expect-error Buffer[] from ws aggregate
    return toUint8Array(Buffer.concat(data));
  }
  return new Uint8Array();
}

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
