// Global WebSocket type for Node test/wrapper runtime
// Allows assigning `globalThis.WebSocket = require('ws').WebSocket` without per-file declares
import type { WebSocket as NodeWebSocket } from "ws";

declare global {
  interface GlobalThis {
    WebSocket: typeof NodeWebSocket;
  }
}

export {};

