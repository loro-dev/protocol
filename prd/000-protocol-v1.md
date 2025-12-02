## Rollout Plan: Protocol v1 (acks + batch IDs)

Tracking doc for implementing protocol v1 across the monorepo.

### Stage 1: Protocol Surface Update — Complete
- **Goal**: Add v1 message types (0x08 DocUpdateV2 with batch IDs, 0x09 ACK, 0x0A UpdateErrorV2) and deprecate 0x03/0x06 across shared protocol types (TS + Rust).
- **Success Criteria**: Enums/structs/codecs include new variants; batch IDs carried; 0x03/0x06 marked deprecated; encoding/decoding tests updated (TS `packages/loro-protocol`, Rust `rust/loro-protocol`).
- **Tests**: `pnpm --filter loro-protocol test`; `cargo test -p loro-protocol` (snapshots updated for new message variants).

### Stage 2: Transport Handling & Acks — In Progress
- **Goal**: WebSocket client/server emit DocUpdateV2 and respond with ACK/UpdateErrorV2 (including fragment flow) with all-or-nothing semantics.
- **Success Criteria**: Client/server use batch IDs; send ACK/UpdateErrorV2 per batch; timeouts mapped to UpdateErrorV2; legacy paths gated for v1 default.
- **Tests**: TS e2e in `packages/loro-websocket`; Rust websocket client/server tests updated for v1 flow (done).

### Stage 3: Adaptors & Examples — Not Started
- **Goal**: Adaptors/examples propagate batch IDs and ack/reject outcomes to app callers; no deprecated 0x03/0x06.
- **Success Criteria**: Adaptors consume/emit v1 messages; hooks surface acceptance/rejection; examples run via DocUpdateV2 path.
- **Tests**: Adjust adaptor/example tests; optional manual smoke of `examples/excalidraw-example`.

### Stage 4: Docs & Migration Guidance — Not Started
- **Goal**: Document v1 behavior, ack requirements, and migration from deprecated messages.
- **Success Criteria**: README/protocol docs updated as needed; notes on legacy interoperability/defaults.
- **Tests**: Docs lint/format clean.
