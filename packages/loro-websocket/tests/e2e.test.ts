import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import getPort from "get-port";
import { SimpleServer } from "../src/server/simple-server";
import {
  registerCrdtDoc,
  getCrdtDocConstructor,
  type CrdtDoc,
  type CrdtDocConstructor,
} from "../src/server/crdt-doc";
import { LoroWebsocketClient } from "../src/client";
import { createLoroAdaptor, loroServerAdaptor } from "loro-adaptors";
import { CrdtType } from "loro-protocol";

class AdaptorBackedLoroDoc implements CrdtDoc {
  private data: Uint8Array;

  constructor() {
    this.data = AdaptorBackedLoroDoc.clone(loroServerAdaptor.createEmpty());
  }

  private static clone(input: Uint8Array): Uint8Array {
    return input.length ? new Uint8Array(input) : new Uint8Array();
  }

  getVersion(): Uint8Array {
    return AdaptorBackedLoroDoc.clone(loroServerAdaptor.getVersion(this.data));
  }

  computeBackfill(clientVersion: Uint8Array): Uint8Array[] | null {
    const version = clientVersion ?? new Uint8Array();
    const { updates } = loroServerAdaptor.handleJoinRequest(
      this.data,
      version,
      "write"
    );
    return updates && updates.length
      ? updates.map(AdaptorBackedLoroDoc.clone)
      : null;
  }

  applyUpdates(updates: Uint8Array[]) {
    const result = loroServerAdaptor.applyUpdates(this.data, updates, "write");
    if (!result.success) {
      const message = result.error?.message ?? "Unknown update failure";
      return { ok: false as const, error: message };
    }

    if (result.newDocumentData) {
      this.data = AdaptorBackedLoroDoc.clone(result.newDocumentData);
    }

    return { ok: true as const };
  }

  shouldPersist(): boolean {
    return true;
  }

  exportSnapshot(): Uint8Array | null {
    return this.data.length ? AdaptorBackedLoroDoc.clone(this.data) : null;
  }

  importSnapshot(data: Uint8Array): void {
    this.data = AdaptorBackedLoroDoc.clone(data);
  }

  allowBackfillWhenNoOtherClients(): boolean {
    return false;
  }
}

// Make WebSocket available globally for the client
Object.defineProperty(globalThis, "WebSocket", {
  value: WebSocket,
  configurable: true,
  writable: true,
});

describe("E2E: Client-Server Sync", () => {
  let server: SimpleServer;
  let port: number;
  let restoreLoroCtor: CrdtDocConstructor | undefined;

  beforeAll(async () => {
    restoreLoroCtor = getCrdtDocConstructor(CrdtType.Loro);
    registerCrdtDoc(CrdtType.Loro, () => new AdaptorBackedLoroDoc());

    port = await getPort();
    server = new SimpleServer({ port });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    if (restoreLoroCtor) {
      registerCrdtDoc(CrdtType.Loro, restoreLoroCtor);
    }
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
});
