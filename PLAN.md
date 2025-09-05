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
- [ ] `rust/loro-protocol`: add `%ELO` to enum + magic; expose helpers for container header parsing (no crypto).
- [ ] `rust/loro-websocket-server`: accept `%ELO`; minimally broadcast updates and (optionally) build an in‑memory header index for join backfill (matching TS behavior).
- [ ] Tests: basic accept/broadcast; header parser unit tests.

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
