# Loro Protocol Monorepo

loro-protocol is a small, transport-agnostic syncing protocol for collaborative CRDT documents. This repo hosts the protocol implementation, a WebSocket client, and minimal servers for local testing or self‑hosting.

- Protocol: multiplex multiple rooms on one connection, 256 KiB max per message, large update fragmentation supported, positive/negative delivery via `Ack`, room eviction via `RoomError`
- CRDTs: Loro document, Loro ephemeral store; extensible (e.g., Yjs, Yjs Awareness)
- Transports: WebSocket or any integrity-preserving transport (e.g., WebRTC)

See `protocol.md` for the full wire spec.

## Packages

- `packages/loro-protocol` (MIT): Core TypeScript definitions, encoders/decoders for the wire protocol
- `packages/loro-websocket` (MIT): WebSocket client + a SimpleServer for local testing
- `packages/loro-adaptors` (MIT): Shared CRDT adaptors for Loro documents and ephemeral state

Rust workspace (MIT):

- `rust/loro-protocol`: Rust encoder/decoder mirroring the TS implementation
- `rust/loro-websocket-client`: Async WS client for the protocol
- `rust/loro-websocket-server`: Minimal async WS server with optional SQLite snapshotting

## Quick Start (Local)

Use the minimal WebSocket server for local development and tests.

1. Install dependencies

```bash
pnpm install
pnpm -r build
```

2. Start a SimpleServer (Node.js)

```bash
pnpm dev-simple-server
```

3. Connect a client and sync a Loro document

```ts
// examples/client.ts
import { LoroWebsocketClient } from "loro-websocket";
import { LoroAdaptor } from "loro-adaptors/loro";

// In Node, provide a WebSocket implementation
import { WebSocket } from "ws";
(globalThis as any).WebSocket = WebSocket;

const client = new LoroWebsocketClient({ url: "ws://localhost:8787" });
await client.waitConnected();

const adaptor = new LoroAdaptor();
const room = await client.join({ roomId: "demo-room", crdtAdaptor: adaptor });

// Edit the shared doc
const text = adaptor.getDoc().getText("content");
text.insert(0, "Hello, Loro!");
adaptor.getDoc().commit();

// Later…
await room.destroy();
```

Tip: For a working reference, see `packages/loro-websocket/src/e2e.test.ts` which spins up `SimpleServer` and syncs two clients end‑to‑end.

## E2EE (%ELO)

`%ELO` adds end‑to‑end encryption to Loro sync. The server never decrypts; it indexes plaintext headers only to support backfill and routing. Clients encrypt/decrypt using AES‑GCM with a 12‑byte IV and the exact encoded header bytes as AAD.

- TypeScript: use `EloAdaptor` from `loro-adaptors` + `LoroWebsocketClient`.
  - Provide a `getPrivateKey()` hook that resolves `{ keyId, key }` (Web Crypto CryptoKey or Uint8Array).
  - The adaptor packages updates into `%ELO` containers and decrypts incoming ones, applying to its internal `LoroDoc`.

Example (Node 18+):

```ts
import { LoroWebsocketClient } from "loro-websocket/client";
import { EloAdaptor } from "loro-adaptors/loro";
import { WebSocket } from "ws";
(globalThis as any).WebSocket =
  WebSocket as unknown as typeof globalThis.WebSocket;

const key = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
]);

const client = new LoroWebsocketClient({ url: "ws://localhost:8787" });
await client.waitConnected();
const adaptor = new EloAdaptor({
  getPrivateKey: async () => ({ keyId: "k1", key }),
});
const room = await client.join({ roomId: "elo-room", crdtAdaptor: adaptor });

// Edit the encrypted doc
const text = adaptor.getDoc().getText("t");
text.insert(0, "hello");
adaptor.getDoc().commit();

await room.destroy();
```

Notes:

- Use a unique, non‑repeating 12‑byte IV per encryption for security (the adaptor accepts an optional `ivFactory()` for testing); the examples may fix IVs for determinism in tests only.
- Keys and key agreement are application‑provided and out of scope.

### Cross‑language E2EE tests

We provide cross‑language tests to verify `%ELO` interoperability between the TS and Rust implementations.

- Run with pnpm:

```bash
pnpm run test:cross-lang
```

This will:

- Run the Rust cross‑lang e2e test (`rust/loro-websocket-server/tests/elo_cross_lang.rs`) with logs.
- Spawn thin TS test-wrappers via `pnpm exec tsx`:
  - `packages/loro-websocket/test-wrappers/start-simple-server.ts`
  - `packages/loro-websocket/test-wrappers/send-elo-normative.ts`
  - `packages/loro-websocket/test-wrappers/recv-elo-doc.ts`
- Use the Rust example `rust/loro-websocket-client/examples/elo_index_client.rs` which encrypts/decrypts real `%ELO` containers.

Requirements:

- Node 18+, pnpm (or npx fallback), Rust toolchain.
- For CI stability, you can run with a single test thread:
  `cargo test -p loro-websocket-server --test elo_cross_lang -- --ignored --nocapture --test-threads=1`.

### Optional: SimpleServer hooks

`SimpleServer` accepts optional hooks for basic join metadata/auth handling and persistence:

```ts
const server = new SimpleServer({
  port: 8787,
  authenticate: async (roomId, crdt, auth) => {
    // join metadata arrives as `auth`; return 'read' | 'write' | null to deny
    return "write";
  },
  onLoadDocument: async (roomId, crdt) => null, // return snapshot bytes
  onSaveDocument: async (roomId, crdt, data) => {
    // persist snapshot bytes somewhere (e.g., filesystem/db)
  },
  saveInterval: 60_000, // ms
});
```

### Alternative: Rust server

The Rust workspace contains a minimal async WebSocket server (`loro-websocket-server`) with optional SQLite persistence. See `rust/loro-websocket-server/examples/simple-server.rs` for a CLI example.

## Protocol Highlights

- Magic bytes per CRDT: "%LOR" (Loro doc), "%EPH" (Loro ephemeral), "%EPS" (persisted Loro ephemeral – tells the server to keep the latest state so new peers can load it immediately), "%YJS", "%YAW", …
- Messages: JoinRequest/JoinResponseOk/JoinError, DocUpdate (with batchId), DocUpdateFragmentHeader/Fragment, Ack, RoomError, Leave
- Limits: 256 KiB per message; large updates must be fragmented; default reassembly timeout 10s
- Multi‑room: room ID is part of every message; one connection can join multiple rooms

See `protocol.md` for the full description and error codes.

## Monorepo Dev

- Build all: `pnpm -r build`
- Test all: `pnpm -r test`
- Cross‑lang E2EE test: `pnpm run test:cross-lang`
- Typecheck: `pnpm -r typecheck`
- Lint: `pnpm -r lint`

Node 18+ is required for local development.

## Publishing & Releases

- Releases are automated with the `release-please` workflow. Merge the release PR generated by the bot to tag new versions.
- The publish job uses npm's [trusted publisher](https://docs.npmjs.com/trusted-publishers) integration. The GitHub Actions workflow requests an OIDC token, so no long-lived `NPM_TOKEN` secret is required.

## Licensing

- `loro-protocol`: MIT
- `loro-websocket`: MIT
- `loro-adaptors`: MIT
- Rust workspace crates under `rust/`: MIT

## Project Structure

```
.
├── protocol.md                 # Wire protocol spec
├── packages/
│   ├── loro-protocol/          # Core encoders/decoders (MIT)
│   ├── loro-websocket/         # Client + SimpleServer (MIT)
│   ├── loro-adaptors/          # Shared CRDT adaptors (MIT)
├── rust/                       # Rust implementations (MIT)
│   ├── loro-protocol/
│   ├── loro-websocket-client/
│   └── loro-websocket-server/
└── pnpm-workspace.yaml
```

## FAQ

- How do I test locally? Use `SimpleServer` in `loro-websocket` or the Rust server.
- Can I bring my own auth/storage? Yes — `SimpleServer` and the Rust server provide hooks for join metadata/auth and persistence.
