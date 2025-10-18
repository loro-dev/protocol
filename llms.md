# Loro Protocol & WebSocket Client Reference (LLM Ready)

This document distills the repository's specs and APIs into a compact guide
for language-model agents. It covers the binary protocol, the `%ELO`
end-to-end encrypted extension, and the full surface of the
`LoroWebsocketClient`.

---

## 1. Protocol Overview

- **Transport agnostic:** Works over WebSocket or any ordered, reliable link.
- **Multiplexed rooms:** Each message carries a CRDT magic prefix plus a room
  identifier; rooms of different CRDT types are distinct even if they share an
  ID string.
- **CRDT magic bytes (first four bytes):**
  - `%LOR` – Loro document updates (default).
  - `%EPH` – Loro ephemeral store.
  - `%YJS` – Yjs document updates.
  - `%YAW` – Yjs awareness.
  - `%ELO` – Encrypted Loro document updates (see §3).
- **Envelope fields (after magic bytes):**
  1. `varBytes roomId` (max 128 bytes).
  2. `u8 messageType`.
  3. Type-specific payload.
- **Message size ceiling:** 256 KiB. Larger payloads must be fragmented with
  `DocUpdateFragmentHeader` + `DocUpdateFragment`.
- **Keepalive:** Plain-text `"ping"`/`"pong"` WebSocket frames bypass the
  envelope; they are connection-scoped and never forwarded to rooms.

### 1.1 Message Types

| Type ID | Name                       | Payload Summary |
|--------:|----------------------------|-----------------|
| `0x00`  | `JoinRequest`              | `varBytes auth`, `varBytes version`. |
| `0x01`  | `JoinResponseOk`           | `varString permission ("read"/"write")`, `varBytes version`, `varBytes extraMetadata`. |
| `0x02`  | `JoinError`                | `u8 code`, `varString message`, optional `varBytes receiverVersion` when `code=version_unknown`. |
| `0x03`  | `DocUpdate`                | `varUint N` updates followed by `N` `varBytes` chunks. |
| `0x04`  | `DocUpdateFragmentHeader`  | `8-byte batchId`, `varUint fragmentCount`, `varUint totalSizeBytes`. |
| `0x05`  | `DocUpdateFragment`        | `8-byte batchId`, `varUint index`, `varBytes fragment`. |
| `0x06`  | `UpdateError`              | `u8 code`, `varString message`, optional batch ID when `code=fragment_timeout`. |
| `0x07`  | `Leave`                    | No additional payload. |

### 1.2 Sync Lifecycle

1. Client (`Req`) sends `JoinRequest` with auth payload and local version.
2. Server (`Recv`) responds:
   - `JoinResponseOk` with current version and permission, then streams
     backfills via `DocUpdate`/`DocUpdateFragment`.
   - or `JoinError` for authentication failure or unknown version. On
     `version_unknown`, the server includes its version for reseeding.
3. Clients broadcast local edits using `DocUpdate`. Payloads exceeding the
   size limit are sliced into fragments: send header first, then numbered
   fragments. Recipients reassemble by `batchId`.
4. Clients send `Leave` when unsubscribing from a room.
5. Servers may emit `UpdateError` when denying updates; clients SHOULD surface
   these via adaptor callbacks.

### 1.3 Fragmentation Rules

- `MAX_MESSAGE_SIZE = 256*1024` bytes.
- Clients split oversize updates into fragments smaller than the limit minus
  overhead (~240 KiB per fragment in the current implementation).
- Receivers store fragments per `batchId`, expect all `fragmentCount` entries,
  and enforce a default 10-second reassembly timeout.
- On timeout (`UpdateError.fragment_timeout`), senders SHOULD resend the full
  batch (header + fragments).

### 1.4 Error Codes

- **`JoinError` codes:**
  - `0x00 unknown`
  - `0x01 version_unknown` (`receiverVersion` included)
  - `0x02 auth_failed`
  - `0x7F app_error` (`varString app_code`)
- **`UpdateError` codes:**
  - `0x00 unknown`
  - `0x03 permission_denied`
  - `0x04 invalid_update`
  - `0x05 payload_too_large`
  - `0x06 rate_limited`
  - `0x07 fragment_timeout` (`8-byte batchId`)
  - `0x7F app_error` (`varString app_code`)
- Protocol violations MAY be raised via host callbacks; implementations often
  close the connection on unrecoverable errors.

### 1.5 Keepalive (`"ping"` / `"pong"`)

- Exactly the ASCII text `"ping"`/`"pong"` (WebSocket text frames).
- Either side MAY send `"ping"`; the peer MUST reply with `"pong"` promptly.
- Keepalive frames are never associated with rooms, are not broadcast, and
  must not be parsed as protocol messages.

---

## 2. `%ELO` End-to-End Encrypted Payloads

`%ELO` introduces encrypted DocUpdate payloads while keeping the base envelope,
handshake, and keepalive unchanged. Only the body of `DocUpdate` (and the
reassembled bytes from fragments) differs.

### 2.1 Container Structure

```
DocUpdatePayload :=
  varUint recordCount
  record[0] … record[recordCount-1]

record := varBytes recordBytes
```

Fragmentation happens after container encoding if serialized bytes exceed the
256 KiB limit.

### 2.2 Record Header + Ciphertext

Each `recordBytes` contains a plaintext header followed by AES-GCM ciphertext
(`ct || 16-byte tag`). Two `kind` values exist:

- **`0x00 DeltaSpan`**
  - `varBytes peerId` (≤64 bytes recommended).
  - `varUint start` (inclusive) and `varUint end` (exclusive, `end > start`).
  - `varString keyId` (≤64 UTF-8 bytes).
  - `varBytes iv` (12-byte nonce, explicit per record).
  - `varBytes ct` (ciphertext with tag).
- **`0x01 Snapshot`**
  - `varUint vvCount`.
  - Repeat `vvCount` times (sorted by peerId): `varBytes peerId`,
    `varUint counter`.
  - `varString keyId`.
  - `varBytes iv` (12-byte).
  - `varBytes ct`.

The server parses headers for routing/deduplication but never decrypts `ct`.

### 2.3 Cryptography Requirements

- **Cipher:** AES-GCM-256 (AES-GCM-128 permitted where necessary).
- **IV:** 96-bit (12 bytes). MUST be unique per symmetric key.
- **Tag:** 128-bit (16 bytes).
- **AAD:** Exact encoded plaintext header (kind + all encoded fields including
  `iv`). Encoders MUST feed the encoded header bytes into AEAD; decoders MUST
  treat authentication failure as fatal.
- **Keys:** Managed at the application layer. Implementations expose a hook
  (e.g., `getPrivateKey(keyId)` returning `{ keyId, key }`) to fetch the
  correct key material. Key rotation is handled by publishing updates under a
  new `keyId`.
- **Decryption failures:** Clients report locally (e.g., `onDecryptError`);
  servers cannot detect them.
- **Normative test vector:** See `protocol-e2ee.md` for a canonical
  DeltaSpan example (key, IV, header encoding, ciphertext).

### 2.4 Limits and Replay Handling

- Message size remains bounded by the base protocol (use fragments as needed).
- Receivers SHOULD deduplicate spans via `peerId`/`start`/`end` metadata.
- Unknown `keyId` SHOULD trigger key resolution and a retry; persistent
  failure is surfaced locally instead of emitting `UpdateError`.

---

## 3. WebSocket Client (`loro-websocket`)

High-level client that speaks the protocol, handles reconnection, latency
tracking, and room management. Designed to pair with CRDT adaptors from
`loro-adaptors`.

### 3.1 Setup

```ts
import { LoroWebsocketClient } from "loro-websocket";
import { createLoroAdaptor } from "loro-adaptors";

// In Node, provide a WebSocket implementation:
import { WebSocket } from "ws";
(globalThis as any).WebSocket = WebSocket as typeof globalThis.WebSocket;

const client = new LoroWebsocketClient({ url: "ws://localhost:8787" });
await client.waitConnected();
```

Adaptors bridge the client to actual CRDT state:

- `createLoroAdaptor({ peerId })` – Loro document.
- `LoroEphemeralAdaptor` – transient presence (`%EPH`).
- `EloLoroAdaptor` – `%ELO` encrypted Loro with `getPrivateKey()`.

### 3.2 Constructor Options

```ts
new LoroWebsocketClient({
  url: string,                 // Required ws:// or wss:// endpoint.
  pingIntervalMs?: number,     // Default 30_000 ms.
  disablePing?: boolean,       // Skip periodic ping/pong entirely.
  onWsClose?: () => void,      // Invoked on low-level close before status change.
});
```

Instantiation triggers an immediate `connect()` with exponential backoff on
failure.

### 3.3 Connection & Lifecycle API

- `waitConnected(): Promise<void>` – Resolves once the socket reaches OPEN.
- `connect(): Promise<void>` – Manually initiate/resume connection. Also
  re-enables auto-reconnect if the client was previously `close()`d.
- `close(): void` – Gracefully close, flush pending frames, transition to
  `Disconnected`, and disable auto-reconnect.
- `destroy(): void` – Full teardown: remove listeners, stop timers, reject
  pending operations, close the socket, and disable reconnects permanently.

### 3.4 Status & Event Hooks

- `getStatus(): ClientStatusValue` – `"connecting" | "connected" | "disconnected"`.
- `onStatusChange(cb): () => void` – Subscribe to status changes; invokes the
  callback immediately with the current status. Returns an unsubscribe fn.
- `ping(timeoutMs?: number): Promise<void>` – Send an app-level `"ping"` and
  resolve on the matching `"pong"`; rejects on timeout (default 5 s). Ensures
  the connection is open before sending.
- `getLatency(): number | undefined` – Last measured RTT (ms) from ping/pong.
- `onLatency(cb): () => void` – Subscribe to latency updates; emits the last
  known RTT immediately if available.

### 3.5 Auto-Reconnect Model

- Retries begin ~500 ms after an unexpected close, doubling every attempt
  up to 15 s (500 ms → 1 s → 2 s → 4 s … 15 s cap). Success resets the backoff.
- Network offline events pause retries; they resume immediately on `online`.
- Calling `close()` or `destroy()` stops auto-retries; later `connect()`
  restarts them from the base delay.

### 3.6 Room Management

```ts
const adaptor = createLoroAdaptor({ peerId: 1 });
const room = await client.join({
  roomId: "doc-123",
  crdtAdaptor: adaptor,
  auth?: Uint8Array,           // Optional bytes forwarded to the server.
});
```

- Room identities are keyed by `<crdtType><roomId>`. Joining the same pair
  twice reuses the existing promise/room.
- Upon `JoinResponseOk`:
  - The adaptor receives `setCtx({ send, onJoinFailed, onImportError })`.
  - The client registers the room so reconnects automatically re-send
    `JoinRequest` and replay buffered updates (special handling for `%ELO` to
    cover backfills that race the join).
- `join` rejects on non-recoverable `JoinError`. When `code=version_unknown`,
  adaptors can supply `getAlternativeVersion()` to retry before falling back
  to an empty version.

#### 3.6.1 Room Object (`LoroWebsocketClientRoom`)

The resolved room implements:

- `leave(): Promise<void>` – Send `Leave` over the current socket. No effect if
  already destroyed.
- `waitForReachingServerVersion(): Promise<void>` – Resolves when the adaptor
  reports that the local document version is ≥ the server’s version.
- `destroy(): Promise<void>` – Calls `leave()`, destroys the adaptor, removes
  the room from the client, and clears listeners. Idempotent.

### 3.7 Update Transmission

- Adaptors call `send(updates: Uint8Array[])` supplied in `setCtx`. The client
  encodes each update as `DocUpdate` or fragments as needed (header then
  numbered fragments). Fragment payloads reserve ~4 KiB below `MAX_MESSAGE_SIZE`
  to stay within limits.
- On receiving `DocUpdate`/fragments, the client reassembles updates and passes
  them to `crdtAdaptor.applyUpdate`.
- `UpdateError` messages invoke `crdtAdaptor.handleUpdateError` if provided.

### 3.8 Ping/Pong Integration

- Periodic ping (default 30 s) sends `"ping"` only when no RTT probe is in
  flight. Disable with `disablePing` or adjust interval. Receipt of `"pong"`
  clears waiters, updates latency, and resets the RTT timer.
- Manual `ping(timeoutMs)` registers a waiter with its own timeout and reuses
  the same shared `"pong"` handling.

### 3.9 Clean Shutdown

- `close()` flushes frames, closes the socket with code `1000`, cancels timers,
  rejects in-flight promises, and leaves ping waiters with `Disconnected`.
- `destroy()` additionally detaches global online/offline listeners and should
  be called before discarding the client instance.

---

## 4. SimpleServer & Persistence Hooks

The `SimpleServer` (Node, `ws`-based) provides a minimal server matching the
protocol for local development and tests.

```ts
import { SimpleServer } from "loro-websocket/server";

const server = new SimpleServer({
  port: 8787,
  host?: string,
  saveInterval?: number,   // Default 60_000 ms.
  authenticate?: async (roomId, crdtType, auth) => "read" | "write" | null,
  onLoadDocument?: async (roomId, crdtType) => Uint8Array | null,
  onSaveDocument?: async (roomId, crdtType, data) => void,
});

await server.start();
// ...
await server.stop();
```

Key behaviors:

- Tracks per-room CRDT documents via adaptor-compatible helpers.
- Handles `"ping"`/`"pong"` keepalive frames at the text layer.
- Saves dirty documents periodically when `onSaveDocument` is provided.
- Enforces message size limits and reassembles fragments mirroring the client.

---

## 5. Practical Tips for Agents

- Always respect the 256 KiB message ceiling; rely on the client’s automatic
  fragmentation rather than hand-rolling your own.
- When operating on `%ELO`, ensure your adaptor can fetch keys by `keyId` and
  pass 12-byte IVs to encryption helpers.
- Subscribe to `onStatusChange` to gate CRDT mutations behind `Connected`.
- Use `waitForReachingServerVersion()` before assuming local state matches the
  server (important after reconnects).
- For auth flows, encode credentials as `Uint8Array` and pass via `join({ auth })`.
- Remember that keepalive frames are raw text messages: handle them before
  attempting to decode binary protocol messages.

This reference should equip an LLM agent to reason about the binary protocol,
the `%ELO` extension, and the WebSocket client/server APIs without re-reading
the full repository.
