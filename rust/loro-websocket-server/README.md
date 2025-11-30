# loro-websocket-server (Rust)

Minimal async WebSocket server for the Loro protocol. Broadcasts DocUpdates between clients and provides hooks for auth and persistence. It mirrors the TypeScript server in `packages/loro-websocket`.

## Features
- Supports `%LOR`, `%EPH`, `%ELO` (experimental/WIP) and related CRDT types with fragment reassembly (≤256 KiB per message).
- Connection keepalive handling (`"ping"/"pong"` text frames).
- Workspace isolation via URL path (`/{workspace}`) and optional handshake auth.
- Load/save hooks with optional per-document metadata context to assist persistence.

> %ELO is treated as an opaque encrypted payload on the server; the Rust client adaptor is snapshot-only today and considered WIP.

## Quick start

Run the bundled SQLite-backed example:

```bash
cargo run -p loro-websocket-server --example simple-server -- --addr 127.0.0.1:9000 --db loro.db
```

Then connect clients to `ws://127.0.0.1:9000/ws1`.

Integrate your own storage by wiring `ServerConfig.on_load_document` and `on_save_document`.

## Tests

```bash
cargo test -p loro-websocket-server
```
