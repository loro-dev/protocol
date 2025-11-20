import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import getPort from "get-port";
import { SimpleServer } from "../src/server/simple-server";
import { LoroWebsocketClient } from "../src/client";
import { LoroAdaptor } from "loro-adaptors/loro";
import { LoroDoc } from "loro-crdt";
import { CrdtType } from "loro-protocol";

// Make WebSocket available globally for the client
Object.defineProperty(globalThis, "WebSocket", {
  value: WebSocket,
  configurable: true,
  writable: true,
});

describe("SimpleServer onLoadDocument", () => {
  let server: SimpleServer;
  let port: number;
  let initialDocData: Uint8Array;

  beforeAll(async () => {
    port = await getPort();
    
    // Create an initial document state
    const doc = new LoroDoc();
    doc.getText("content").insert(0, "Initial Content");
    initialDocData = doc.export({ mode: "snapshot" });

    server = new SimpleServer({ 
      port,
      onLoadDocument: async (roomId, crdtType) => {
        if (roomId === "loaded-room" && crdtType === CrdtType.Loro) {
          return initialDocData;
        }
        return null;
      }
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  }, 15000);

  it("should send loaded document to first client", async () => {
    const client = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client.waitConnected();

    const adaptor = new LoroAdaptor();
    const room = await client.join({
      roomId: "loaded-room",
      crdtAdaptor: adaptor,
    });

    await room.waitForReachingServerVersion();

    expect(adaptor.getDoc().getText("content").toString()).toBe("Initial Content");

    await room.destroy();
    client.destroy();
  });

  it("should send loaded document + new updates to second client", async () => {
    const client1 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client1.waitConnected();
    const adaptor1 = new LoroAdaptor();
    const room1 = await client1.join({
      roomId: "loaded-room",
      crdtAdaptor: adaptor1,
    });
    
    // Wait for initial sync
    await room1.waitForReachingServerVersion();
    expect(adaptor1.getDoc().getText("content").toString()).toBe("Initial Content");

    // Client 1 makes an update
    adaptor1.getDoc().getText("content").insert(0, "Updated "); // "Updated Initial Content"
    adaptor1.getDoc().commit();
    
    // Wait a bit for server to process
    await new Promise(resolve => setTimeout(resolve, 100));

    // Client 2 joins
    const client2 = new LoroWebsocketClient({ url: `ws://localhost:${port}` });
    await client2.waitConnected();
    const adaptor2 = new LoroAdaptor();
    const room2 = await client2.join({
      roomId: "loaded-room",
      crdtAdaptor: adaptor2,
    });

    await room2.waitForReachingServerVersion();

    // Check if client 2 has the update
    expect(adaptor2.getDoc().getText("content").toString()).toBe("Updated Initial Content");

    await room1.destroy();
    await room2.destroy();
    client1.destroy();
    client2.destroy();
  });
});
