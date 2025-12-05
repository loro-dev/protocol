# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Project Overview

Transport‑agnostic sync protocol and tooling for collaborative CRDTs (Loro, Yjs, etc.). The repo contains TypeScript packages (protocol, websocket client/server, adaptors) and Rust equivalents under `rust/`.

## Common Development Commands

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm -r typecheck
pnpm -r lint
pnpm -r clean
```

## Architecture

### Structure

- `packages/loro-protocol`: protocol types + encoder/decoder (TS)
- `packages/loro-websocket`: WS client and `SimpleServer` (TS)
- `packages/loro-adaptors`: adaptors for `loro-crdt` doc/ephemeral (TS)
- `examples/excalidraw-example`: demo using `SimpleServer`
- `rust/`: Rust workspace with protocol/client/server crates

### Protocol

Source of truth: `/protocol.md`.

- Envelope: 4‑byte CRDT magic, varBytes roomId (≤128B), 1‑byte type, payload
- Types: JoinRequest/JoinResponseOk/JoinError, DocUpdate (with batchId), DocUpdateFragmentHeader/Fragment, Ack, RoomError, Leave
- Limits: 256 KiB per message; fragment large updates
- Keepalive: connection‑scoped text frames "ping"/"pong"

Key TS files: `packages/loro-protocol/src/{bytes,encoding,protocol}.ts`.

## Testing

- TS: unit and e2e tests with `vitest` (e.g. `packages/loro-websocket/src/e2e.test.ts`).
- Rust: `cargo test` in `rust/` crates.

## Notes for Implementers

- Fragmentation: reassemble fragments by batch header + index; timeout triggers Ack.FragmentTimeout
- Rooms: a WS connection can join multiple CRDT+room pairs
- Auth/persistence hooks exposed by `SimpleServer` and Rust server

## Development Guidelines

Keep changes small and test‑backed. Prefer clarity over cleverness. Follow existing patterns and formatting; ensure all tests pass. When stuck, document attempts and try simpler alternatives.
