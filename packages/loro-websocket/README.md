# loro-websocket

WebSocket client and a minimal SimpleServer for syncing Loro CRDTs. The client provides connection status events, auto‑reconnect with exponential backoff, latency tracking via ping/pong, safe fragmentation/reassembly for large updates, and seamless room rejoin across reconnects.

## Install

```bash
pnpm add loro-websocket loro-adaptors loro-protocol
# plus peer dep in your app
pnpm add loro-crdt
```

## Quick Start

```ts
// In Node, provide a WebSocket implementation
import { WebSocket } from "ws";
(globalThis as any).WebSocket =
  WebSocket as unknown as typeof globalThis.WebSocket;

import { LoroWebsocketClient, ClientStatus } from "loro-websocket";
import { createLoroAdaptor } from "loro-adaptors";

const client = new LoroWebsocketClient({ url: "ws://localhost:8787" });

// React to connection status
const offStatus = client.onStatusChange(s => console.log("status:", s));

await client.waitConnected();

// Join a room with a CRDT adaptor
const adaptor = createLoroAdaptor({ peerId: 1 });
const room = await client.join({ roomId: "demo", crdtAdaptor: adaptor });

// Edit document and sync
const text = adaptor.getDoc().getText("content");
text.insert(0, "Hello, Loro!");
adaptor.getDoc().commit();

await room.destroy();
offStatus();
```

%ELO (end‑to‑end encrypted Loro) using `EloLoroAdaptor`:

```ts
import { LoroWebsocketClient } from "loro-websocket";
import { EloLoroAdaptor } from "loro-adaptors";

const key = new Uint8Array(32);
key[0] = 1;
const client = new LoroWebsocketClient({ url: "ws://localhost:8787" });
await client.waitConnected();

const adaptor = new EloLoroAdaptor({
  getPrivateKey: async () => ({ keyId: "k1", key }),
});
await client.join({ roomId: "secure-room", crdtAdaptor: adaptor });

adaptor.getDoc().getText("t").insert(0, "secret");
adaptor.getDoc().commit();
```

## Client API

```ts
new LoroWebsocketClient(options: LoroWebsocketClientOptions)

interface LoroWebsocketClientOptions {
  url: string;                 // WebSocket URL (ws:// or wss://)
  pingIntervalMs?: number;     // Periodic ping interval (default 30_000ms)
  disablePing?: boolean;       // Disable periodic pings entirely
  onWsClose?: () => void;      // Low‑level ws close callback (before status transitions)
}

// Status values (no enums)
const ClientStatus = {
  Connecting: "connecting",
  Connected: "connected",
  Reconnecting: "reconnecting",
  Disconnected: "disconnected",
} as const;
type ClientStatusValue = typeof ClientStatus[keyof typeof ClientStatus];
```

- Connection
  - `waitConnected(): Promise<void>` resolves once the socket is open.
  - `connect(): Promise<void>` manually initiate/resume connection; also re‑enables auto‑reconnect after a `close()`.
  - `close(): void` manually close, wait for buffered frames to flush, and stop auto‑reconnect (status → `Disconnected`).
  - `destroy(): void` teardown: remove listeners, stop timers, reject pending `waitConnected`/`ping` calls, flush buffers, close socket, status → `Disconnected`.

- Status and events
  - `getStatus(): ClientStatusValue` returns the current status.
  - `onStatusChange(cb): () => void` subscribes to status changes; immediately calls `cb` with the current status; returns unsubscribe.

- Latency
  - `ping(timeoutMs?: number): Promise<void>` sends an app‑level ping and resolves on pong or rejects on timeout.
  - `getLatency(): number | undefined` returns the last measured ping round‑trip time (ms).
  - `onLatency(cb): () => void` subscribes to latency updates; if a value exists, emits immediately; returns unsubscribe.

- Rooms
  - `join({ roomId, crdtAdaptor, auth? }): Promise<LoroWebsocketClientRoom>` joins a room for a given CRDT type via its adaptor. Optional `auth` is forwarded to the server’s `authenticate` hook.
  - Room API: `leave(): Promise<void>`, `waitForReachingServerVersion(): Promise<void>`, `destroy(): Promise<void>`.

## Status & Reconnect Model

- Status values
  - `Connecting`: initial or manual `connect()` in progress.
  - `Connected`: websocket is open and usable.
  - `Reconnecting`: unexpected close; client retries with exponential backoff.
  - `Disconnected`: manual `close()`; client will not auto‑reconnect until `connect()` is called.

- Auto‑reconnect
  - Exponential backoff: starts at ~500ms, doubles each attempt, capped at 15s.
  - Pauses while browser is offline; resumes immediately on `online` event.
  - After a manual `close()`, call `connect()` to resume retries.

## Latency & Ping/Pong

- Periodic pings
  - By default, the client sends a text `"ping"` every 30s (configurable via `pingIntervalMs`) and expects a `"pong"`. This keeps the connection alive and measures round‑trip latency.
  - Set `disablePing: true` to turn off the timer.

- On‑demand ping
  - Call `ping(timeoutMs)` to send a ping and await the next pong; rejects on timeout.
  - `onLatency(cb)` fires whenever a pong is observed and updates `getLatency()`.

## Rooms & Rejoin

- Join handshake
  - `join()` sends a `JoinRequest` with the adaptor’s CRDT type, version, and optional auth.
  - On `JoinResponseOk`, the adaptor reconciles to the server’s version and begins streaming updates.

- Rejoin after reconnect
  - The client tracks active rooms and their auth. After reconnect, it re‑sends `JoinRequest` for each active room and the adaptor re‑syncs.
  - If the server responds `VersionUnknown`, the client retries using `adaptor.getAlternativeVersion()` or an empty version as a fallback.
  - For `%ELO`, updates that arrive right after join may be buffered briefly to cover backfills that race the join.

## Fragmentation & Large Updates

- Oversize updates are split into `DocUpdateFragmentHeader` + `DocUpdateFragment` messages and reassembled on the receiver.
- Fragmentation occurs automatically for single updates that approach the wire limit (headroom reserved under `MAX_MESSAGE_SIZE`). No action is required by callers.

## SimpleServer (for local/e2e usage)

```ts
import { SimpleServer } from "loro-websocket/server";

const server = new SimpleServer({
  port: 8787,
  authenticate: async (_roomId, _crdt, auth) => {
    // return "read" | "write" | null
    return new TextDecoder().decode(auth) === "readonly" ? "read" : "write";
  },
  onLoadDocument: async (_roomId, _crdt) => null,
  onSaveDocument: async (_roomId, _crdt, _data) => {},
  saveInterval: 60_000,
});
await server.start();
// Later: await server.stop(); flushes any buffered frames before terminating clients
```

## Examples

- Status and reconnect

```ts
const client = new LoroWebsocketClient({ url: "ws://localhost:8787" });
client.onStatusChange(s => console.log("status:", s));

// Later, stop auto‑reconnect
client.close(); // status → Disconnected

// Resume auto‑reconnect
await client.connect(); // status: Connecting → Connected
```

- Latency

```ts
const off = client.onLatency(ms => console.log("latency:", ms));
await client.ping(2000);
console.log("last RTT:", client.getLatency());
off();
```

- Join with auth

```ts
await client.join({
  roomId: "project-123",
  crdtAdaptor: createLoroAdaptor({ peerId: 42 }),
  auth: new TextEncoder().encode("write-token"),
});
```

## Node/Web Compatibility

- Browsers: uses the native `WebSocket` and `window` online/offline events.
- Node: supply a WebSocket implementation (e.g. `ws`) via `globalThis.WebSocket`.
- %ELO crypto uses Web Crypto (`globalThis.crypto.subtle`); Node 18+ provides it.

## License

MIT
