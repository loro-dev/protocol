import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import getPort from "get-port";
import { SimpleServer } from "../src/server/simple-server";
import { LoroWebsocketClient } from "../src/client";
import { LoroAdaptor } from "loro-adaptors/loro";

// Make WebSocket available globally for the client
Object.defineProperty(globalThis, "WebSocket", {
  value: WebSocket,
  configurable: true,
  writable: true,
});

describe("Permission Enforcement", () => {
  let server: SimpleServer;
  let port: number;

  beforeAll(async () => {
    port = await getPort();
    server = new SimpleServer({
      port,
      authenticate: async (roomId, crdtType, auth) => {
        const authStr = new TextDecoder().decode(auth);
        return authStr === "readonly" ? "read" : "write";
      },
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  }, 10000);

  it("should allow read-only client to receive updates but not send them", async () => {
    // Create two clients: one with write permission, one with read permission
    const writeClient = new LoroWebsocketClient({
      url: `ws://localhost:${port}`,
    });
    const readClient = new LoroWebsocketClient({
      url: `ws://localhost:${port}`,
    });

    await writeClient.waitConnected();
    await readClient.waitConnected();

    const writeAdaptor = new LoroAdaptor();
    const readAdaptor = new LoroAdaptor();

    // Join the same room with different permissions
    const writeRoom = await writeClient.join({
      roomId: "permission-test",
      crdtAdaptor: writeAdaptor,
      auth: new TextEncoder().encode("write-token"),
    });

    const readRoom = await readClient.join({
      roomId: "permission-test",
      crdtAdaptor: readAdaptor,
      auth: new TextEncoder().encode("readonly"),
    });

    // Give time for initial sync
    await new Promise(resolve => setTimeout(resolve, 100));

    // Writer makes a change
    const writeText = writeAdaptor.getDoc().getText("content");
    writeText.insert(0, "Hello from writer!");
    writeAdaptor.getDoc().commit();

    // Wait for sync
    await new Promise(resolve => setTimeout(resolve, 200));

    // Read-only client should receive the update
    const readText = readAdaptor.getDoc().getText("content");
    expect(readText.toString()).toBe("Hello from writer!");

    // Read-only client attempts to modify (server should reject this)
    const initialContent = writeText.toString();
    readText.insert(readText.length, " Unauthorized edit!");
    readAdaptor.getDoc().commit();

    // Wait to see if unauthorized changes propagate
    await new Promise(resolve => setTimeout(resolve, 200));

    // Writer should NOT see the unauthorized changes
    expect(writeText.toString()).toBe(initialContent);
    expect(writeText.toString()).toBe("Hello from writer!");

    // But read-only client still has the local change
    expect(readText.toString()).toBe("Hello from writer! Unauthorized edit!");

    await writeRoom.destroy();
    await readRoom.destroy();
  }, 8000);
});
