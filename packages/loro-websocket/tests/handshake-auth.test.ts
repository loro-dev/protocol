import { describe, it, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import getPort from "get-port";
import { SimpleServer } from "../src/server/simple-server";

// Make WebSocket available globally for the client
Object.defineProperty(globalThis, "WebSocket", {
  value: WebSocket,
  configurable: true,
  writable: true,
});

describe("Handshake Auth", () => {
  let server: SimpleServer;
  let port: number;

  beforeAll(async () => {
    port = await getPort();
    server = new SimpleServer({
      port,
      handshakeAuth: req => {
        const cookie = req.headers.cookie;
        return cookie === "session=valid";
      },
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  }, 10000);

  it("should accept connection with valid cookie", async () => {
    const ws = new WebSocket(`ws://localhost:${port}`, {
      headers: {
        Cookie: "session=valid",
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        resolve();
      });
      ws.addEventListener("error", err => {
        reject(err);
      });
    });
    ws.close();
  });

  it("should reject connection with invalid cookie", async () => {
    const ws = new WebSocket(`ws://localhost:${port}`, {
      headers: {
        Cookie: "session=invalid",
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        reject(new Error("Should have failed"));
      });
      ws.addEventListener("error", () => {
        resolve();
      });
    });
  });

  it("should reject connection with missing cookie", async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        reject(new Error("Should have failed"));
      });
      ws.addEventListener("error", () => {
        resolve();
      });
    });
  });
});
