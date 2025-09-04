# AGENTS.md

Guidance for code agents working in this repository.

## Project Overview

Loro Protocol is a transport‑agnostic synchronization protocol for collaborative real‑time data structures (CRDTs). This monorepo contains:

- TypeScript protocol encoder/decoder (`packages/loro-protocol`)
- WebSocket client and a minimal Node server (`packages/loro-websocket`)
- Adaptors that bridge the protocol to the Loro CRDT (`packages/loro-adaptors`)
- A Rust workspace with protocol/client/server equivalents under `rust/`

No Cloudflare/DO code lives in this repo.

## Common Development Commands

```bash
# Install dependencies
pnpm install

# Build / test / lint across packages
pnpm -r build
pnpm -r test
pnpm -r typecheck
pnpm -r lint

# Dev/watch (where supported)
pnpm -r dev

# Clean build artifacts
pnpm -r clean
```

## Architecture

### Monorepo Structure

- `packages/loro-protocol`: Core wire encoding/decoding logic (TS)
- `packages/loro-websocket`: WebSocket client and `SimpleServer` (TS)
- `packages/loro-adaptors`: Adaptors for `loro-crdt` docs and ephemeral state (TS)
- `examples/excalidraw-example`: React demo using `SimpleServer`
- `rust/`: Rust workspace with `loro-protocol`, `loro-websocket-client`, `loro-websocket-server`

### Protocol Essentials

See `/protocol.md`.

- Message envelope: 4‑byte CRDT magic, varBytes roomId (≤128B), 1‑byte type, payload
- Types: JoinRequest/JoinResponseOk/JoinError, DocUpdate, DocUpdateFragmentHeader/Fragment, UpdateError, Leave
- Limit: 256 KiB max per message; large payloads must be fragmented
- Keepalive: connection‑scoped text frames "ping"/"pong" (out‑of‑band)

Key TS files:

- `packages/loro-protocol/src/{bytes,encoding,protocol}.ts`

## Build & Test

- TypeScript: `vitest` tests are co‑located with sources (`*.test.ts`). The websocket package includes e2e tests spinning up `SimpleServer`.
- Rust: run with `cargo` under `rust/` (tests in crates and `tests/`).

Useful references:

- TS E2E: `packages/loro-websocket/src/e2e.test.ts`
- Rust server example: `rust/loro-websocket-server/examples/simple-server.rs`

## Implementation Notes

- Fragmentation: servers/clients reassemble using `DocUpdateFragmentHeader` + `DocUpdateFragment` with an 8‑byte batch id
- Rooms: one WS connection can join multiple rooms (CRDT+roomId pair)
- CRDTs: Loro (`%LOR`), Loro Ephemeral (`%EPH`), Yjs (`%YJS`), Yjs Awareness (`%YAW`)
- Errors: explicit small codes for join/update failures
- Auth: `SimpleServer` exposes `authenticate` and snapshot load/save hooks

## Development Guidelines

Principles:

- Incremental, boring, and obvious code
- Single responsibility; avoid premature abstractions
- Tests for new behavior; don’t disable existing tests

Process:

1. Understand existing patterns
2. Add/adjust tests
3. Implement minimally to pass
4. Refactor with tests passing

Quality gates:

- All packages build and tests pass
- Lint/format clean
- Clear commit messages (explain “why”)
- Mark the important code and error-proned code with comments like `// TODO: REVIEW: <REASON>`

When stuck (≤3 attempts): document failures, explore alternatives, question assumptions, try a simpler angle.
