# Plan: Implement `%ELO` End‑to‑End Encryption (protocol-e2ee.md)

Goal: Add `%ELO` (E2EE Loro) alongside existing `%LOR` without breaking current behavior. Implement container encoding, client encryption/decryption, server header indexing + dedup, and tests. Keep the transport envelope unchanged.

## Scope & Principles
- Minimal, incremental, and test‑driven; preserve existing `%LOR`/`%EPH` flows.
- Browser‑first crypto: Web Crypto `AES-GCM` with explicit 12‑byte IV, 16‑byte tag.
- Server never decrypts; it parses plaintext headers for routing/indexing only.
- Keys are app‑supplied via hook; key agreement/storage is out of scope.

## Wire & Crypto (from protocol-e2ee.md)
- New CRDT magic: `%ELO`.
- `DocUpdate` payload = container of N records; each record = plaintext header + `AES-GCM` ciphertext (`ct` includes tag) and explicit `iv`.
- Record kinds: `DeltaSpan (0x00)` with `(peerId, start, end, keyId, iv, ct)`, `Snapshot (0x01)` with `(vv, keyId, iv, ct)`.
- AAD = exact encoded header bytes per kind; IV must be unique per key.

## Deliverables (TS first, Rust parity later)
- TypeScript: `%ELO` constants, container codec, client adaptor, server indexing, tests (unit + e2e).
- Rust: `%ELO` enum + magic mapping; (optional) header parser for servers; add basic broadcast/index example later.

## High‑Level Phases
1) Protocol & codec scaffolding
2) Client adaptor (decrypt/apply + encrypt/publish)
3) Server indexing + dedup + join query
4) Tests and fixtures (incl. normative AES‑GCM vector)
5) Rust parity (protocol + minimal server acceptance)
6) Docs and examples

---

## TODOs

### Phase 1 — Protocol & Codec
- [x] Add `%ELO` to `packages/loro-protocol/src/protocol.ts`.
  - [ ] Rust mapping in `rust/loro-protocol/src/protocol.rs` (defer to Phase 5: Rust parity).
- [x] TS: Add `packages/loro-protocol/src/e2ee.ts` with:
  - [x] Types: `EloRecordKind`, `EloDeltaHeader`, `EloSnapshotHeader`.
  - [x] `encodeEloContainer(records: Uint8Array[]): Uint8Array` and `decodeEloContainer(data): Uint8Array[]`.
  - [x] `parseEloRecordHeader(recordBytes): { kind, header, iv, keyId, ct, headerBytes, aad }` (no decryption).
  - [x] `encryptDeltaSpan(plaintext: Uint8Array, meta, key, iv?)` and `encryptSnapshot(plaintext, vv, key, iv?)` using Web Crypto; build AAD from exact header encoding.
  - [x] `decryptEloRecord(recordBytes, getKey): { kind, meta, plaintext }` with robust error handling.
- [x] TS: Add unit tests for container encode/decode and header parsing.
  - Includes the normative AES‑GCM DeltaSpan vector for early parity.

Status: Phase 1 complete (TS). Cross‑runtime crypto uses `globalThis.crypto.subtle` and `crypto.getRandomValues`, compatible with browsers, Node.js ≥18, and Cloudflare Workers.

Notes (encoding correctness):
- `%ELO` records’ `ct` must be the exact bytes returned by Loro’s export APIs; never re‑encode or transform them.
- IV must be 12 bytes; tag 16 bytes; AAD is the exact concatenation of the encoded plaintext header fields.

### Phase 2 — Client Adaptor (%ELO)
- [x] Add `EloLoroAdaptor` in `packages/loro-adaptors`:
  - [x] `crdtType = CrdtType.Elo`.
  - [x] Config: `{ getPrivateKey: (keyId?: string) => Promise<{ keyId, key: CryptoKey|Uint8Array }> }`; optional `ivFactory`, `snapshotMode`, `onDecryptError`, `onUpdateError`.
  - [x] Outbound (use Loro export APIs when available; fallback otherwise):
    - After JoinResponseOk, decode server `version` and convert to frontiers via `vvToFrontiers()` when present; seed `lastSentFrontiers`.
    - Compute forward spans via `findIdSpansBetween(from,to)`; if present, export each with `export({ mode: "updates-in-range", spans })` and encrypt to DeltaSpan records.
    - If spans/frontiers APIs unavailable, send a full Snapshot instead. `subscribeLocalUpdates()` is used only to trigger packaging; raw bytes are never sent directly.
  - [x] Inbound: parse container, resolve key, decrypt, and `doc.import` plaintext (snapshot or updates).
  - [x] Snapshots: header `vv` sorted by peerId bytes; plaintext from `export({ mode: snapshot | shallow-snapshot })`.
  - [x] Unknown key/decrypt failure handled via local callbacks (no UpdateError emission).
  - [x] `getVersion()` returns `doc.version().encode()`.
- [x] Tests: adaptor unit tests (snapshot join path; apply snapshot). Delta spans are scaffolded; delta tests pending spans API availability in this env.

Status: Phase 2 core complete with snapshot packaging and decrypt/apply. Forward-delta packaging is implemented behind runtime checks and falls back to snapshots when necessary; add delta-flow tests once spans/frontiers APIs are accessible.

### Phase 3 — Server Indexing & Join (SimpleServer)
- [x] Accept `%ELO` in `packages/loro-websocket/src/server/simple-server.ts`:
  - [x] Maintain per‑room `%ELO` state: centralized in `packages/loro-websocket/src/server/elo-doc.ts` (EloDoc) with `spansByPeer` index of `{ start,end,keyId,record }`.
  - [x] On `DocUpdate` with `%ELO`: reassemble fragments if any, decode container into records; validate headers (`end>start`, 12‑byte IV) else `UpdateError.invalid_update`.
  - [x] Dedup/merge: for a new span `[S,E)`, replace any fully covered existing spans for the same peer.
  - [x] Join flow: respond with current version vector derived from spans (max `end` per peer). Then send all records where `end > vv[peerId]` to requester, re‑containerizing via `encodeEloContainer`. Server never decrypts/rewrites `ct`.
  - [x] Broadcast: forward incoming updates as‑is to other subscribers (no decryption, no rewrite).
  - [x] Persistence hooks: keep `%ELO` storage in‑memory; logic isolated for easy extension.
- [x] Tests: e2e with two `%ELO` clients sharing a key; verify join/backfill and live updates.

### Phase 4 — Test Vectors, Limits, Edge Cases
- [x] Add normative AES‑GCM vector from `protocol-e2ee.md` as a unit test (fix IV, key, AAD; verify `ct`).
- [x] Fragmentation: test large container bytes fragmented and reassembled path.
- [x] Error paths: invalid header (iv size, keyId length, peerId length), payload too large, decrypt failure, unknown key.
- [x] Observability: ensure server logs anonymized header info only; never log `ct`.

### Phase 5 — Rust Parity (follow‑up)
- [x] `rust/loro-protocol`: wire‑level support for `%ELO`
  - [x] Add `CrdtType::Elo` with magic bytes `%ELO`; update `from_magic_bytes()` and adjust any `match` statements referencing `CrdtType` (e.g., server/client hashing).
  - [x] New module `src/elo.rs`: container + header parser only (no crypto).
    - [x] Types: `EloRecordKind`, `EloDeltaHeader { peer_id: Vec<u8>, start: u64, end: u64, key_id: String, iv: [u8;12] }`, `EloSnapshotHeader { vv: Vec<(Vec<u8>, u64)>, key_id: String, iv: [u8;12] }`.
    - [x] `decode_elo_container(data: &[u8]) -> Result<Vec<&[u8]>, String>` (validate no trailing bytes).
    - [x] `parse_elo_record_header(record: &[u8]) -> Result<ParsedEloRecord, String>` returning header + `ct` view and exact `aad` bytes.
    - [x] Invariants: `iv.len()==12`, `end > start` for deltas, `peer_id.len()<=64`, `key_id.len()<=64`, snapshot `vv` sorted by `peerId` bytes.
  - [x] Tests (`tests/elo.rs`, `tests/elo_normative_vector.rs`):
    - [x] Roundtrip `CrdtType` magic mapping includes `%ELO`.
    - [x] Container decode happy path + trailing bytes error.
    - [x] Header parse for both record kinds; invalid header cases return errors.
    - [x] Normative Vector (DeltaSpan): header AAD bytes and ct match `protocol-e2ee.md`.

- [x] `rust/loro-websocket-server`: accept and route `%ELO` without decryption
  - [x] Treat `%ELO` as a supported CRDT for joining and broadcasting; do not import/apply to a `LoroDoc`.
  - [x] Ensure fragment reassembly path also works for `%ELO` and re‑broadcasts original frames (implemented, generic across CRDTs).
  - [x] Keep version bytes empty on join for `%ELO` (no server‑side state).
  - [x] Add an in‑memory `%ELO` header index (mirror of TS `EloDoc`).
    - [x] Parse headers with `loro-protocol::elo` helpers, index spans per peer, dedup covered spans.
    - [x] Join/backfill wiring: on join, decode the client's VersionVector and backfill only records whose `end` exceeds the client’s known counter for that peer; re‑containerize as opaque `DocUpdate`.
  - [x] Refactor server to per‑CRDT doc handlers (trait objects) instead of large `match` branches:
    - [x] `LoroRoomDoc`: snapshot export/import, apply updates, marked for persistence.
    - [x] `EphemeralRoomDoc`: ephemeral store apply/encode‑all; auto‑cleanup when last subscriber leaves.
    - [x] `EloRoomDoc`: header indexing only; no decryption; allows backfill without other clients.

- [x] Tests (server):
  - [x] `elo_accept_broadcast.rs`: two clients join `%ELO` room; sender posts a `%ELO` `DocUpdate` (opaque bytes); receiver gets identical payload.
  - [x] `elo_fragment_reassembly.rs`: large `%ELO` payload via `DocUpdateFragmentHeader` + `DocUpdateFragment`; ensure reassembly and re‑broadcast.
  - [x] Cross‑lang e2e (ignored by default):
    - [x] `elo_cross_lang.rs` spawns:
      - Rust server + JS sender (`examples/js/elo_send_normative.js`) → Rust receiver example (`elo_index_client`) indexes `%ELO` container.
      - JS server (`examples/js/ws_simple_server.js`) + Rust sender example (`elo_index_client`) → JS receiver (`examples/js/elo_recv_index.js`) confirms receipt and header parsing.
    - [x] Added Rust example bin `rust/loro-websocket-client/examples/elo_index_client.rs` for joining `%ELO`, sending a normative container, or indexing received containers.
  - [ ] (Optional when index enabled) `elo_join_backfill.rs`: join after prior updates yields backfill matching TS semantics.

Status: Rust parity for `%ELO` is implemented at the wire level. Protocol enum and parsing utilities are complete with tests; the server accepts `%ELO` joins/updates and broadcasts unchanged. Fragment support is implemented and verified. Header index and selective backfill (by decoded VersionVector) are implemented in Rust without a feature flag via a per‑room `EloRoomDoc`. Server code is refactored to per‑CRDT doc handlers for maintainability. All tests pass in TS and Rust packages.

### Phase 6 — Docs & Examples
- [ ] Update `README.md` and add a short `%ELO` usage example.
- [ ] Cross‑link `protocol-e2ee.md`; document adaptor config and key‑hook expectations.
- [ ] Call out non‑goals: key agreement, key escrow, server‑side re‑encryption, content addressing.

---

## Design Notes & Rationale
- Header‑only indexing keeps servers dumb and fast while enabling dedup + efficient joins.
- Explicit IV per record avoids reuse hazards and eases multi‑tab concurrency.
- AAD = exact header encoding: prevents header tampering without encrypting routing metadata.
- Use Loro’s export surface:
  - `export({ mode: "updates-in-range" })` for DeltaSpan plaintext per `{ peer, counter, length }`.
  - `export({ mode: "snapshot" })` (or `"shallow-snapshot"`) for Snapshot plaintext.
  - Spans computed via `findIdSpansBetween(fromFrontiers, toFrontiers)`; header `[start,end)` maps to `{ counter, counter+length }`.
- Snapshot‑only mode enables a tractable MVP; DeltaSpan packing follows by computing spans and exporting ranges per peer.

## Acceptance Criteria
- All existing `%LOR`/`%EPH` tests pass unchanged.
- New `%ELO` unit tests (codec, vectors) and e2e pass.
- SimpleServer indexes `%ELO` headers, dedups spans, and serves correct backfill on join.
- No plaintext CRDT bytes ever leave clients for `%ELO` rooms.

## Risks & Mitigations
- IV reuse: use CSPRNG; recommend per‑room key rotation; optional IV cache/testing hooks.
- Key management: app‑level hook with retries; document required semantics.
- Large records: rely on existing fragmentation; keep container packing conservative.
- Cross‑impl parity: add identical tests across TS/Rust for envelope + `%ELO` headers.
