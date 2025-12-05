# Loro End‑to‑End Encrypted Extension (%ELO)

Protocol version: 0 (extends base protocol.md).

This document specifies how to use the existing Loro syncing protocol with end‑to‑end encrypted document updates. It reuses the same transport envelope and message types defined in protocol.md and introduces a new CRDT magic type: "%ELO" (E2EE Loro). Only the payload schema of `DocUpdate` and the reassembled payload of `DocUpdateFragmentHeader (0x04) + DocUpdateFragment (0x05)` is specialized for `%ELO`.

It is the application's responsibility to ensure both ends support this extension and agree on keys and key rotation policy.

## Message Envelope (Unchanged)

Everything in protocol.md applies unless noted. In particular:

- Magic bytes (first 4 bytes): add
  - "%ELO": E2EE Loro Document
- Then `varBytes` room ID (max 128 bytes), 1‑byte message type, and payload.
- Message types (0x00–0x07), errors, keepalive frames, fragmentation behavior, and size limits (≤256 KB per message; fragments allowed) are unchanged.

Join/Leave, permissioning, and error codes work as in `%LOR`. The only difference is the content format of update payloads.

## Terminology

- Req: requester (client). Recv: receiver (server).
- PeerID: opaque byte string identifying a replica/peer (raw bytes).
- Span: for a peer, a half‑open counter interval `[start, end)` describing a contiguous range of updates. Requires `end > start`.
- Key ID: application‑defined string identifying the symmetric key version used for encryption.

## Cryptography

This extension is designed to work with the Web Crypto API available in modern browsers.

- Symmetric cipher: AES‑GCM with 256‑bit keys (AES‑GCM‑256). A 128‑bit key is acceptable where 256‑bit is unavailable.
- Tag length: 128 bits (16 bytes). `ct` below is ciphertext concatenated with the 16‑byte tag.
- Nonce/IV: 96‑bit (12 bytes), carried explicitly in each record header; MUST be unique per key. Use a cryptographically strong random IV for each record.
- AAD: the exact encoded plaintext header is bound into AEAD as Additional Authenticated Data.

Key agreement/distribution is out of scope for this document (e.g., password‑derived, passkey‑derived, OOB sharing). Implementations MUST provide an application hook to fetch the appropriate key material by `keyId`.

Recommended browser primitives (Web Crypto `SubtleCrypto`): `AES-GCM`.

## `%ELO` Update Payloads

For `%ELO`, the payload in `DocUpdate` (0x03) and in the reassembled bytes of `DocUpdateFragmentHeader (0x04) + DocUpdateFragment (0x05)` is a container of one or more encrypted records. Each record exposes a small plaintext header for routing/deduplication while the CRDT bytes are encrypted.

### Container Encoding

```
DocUpdatePayload :=
  varUint N                       // number of records
  record[0] .. record[N-1]

record := varBytes recordBytes    // length-prefixed record
```

Implementations SHOULD fragment at the protocol layer if the serialized payload exceeds 256 KB.

### Record Encoding (plaintext header + ciphertext body)

Two record kinds are defined: delta span updates and snapshots.

```
// Common
u8 kind                           // 0x00 = DeltaSpan, 0x01 = Snapshot

// kind = 0x00 (DeltaSpan)
varBytes peerId                   // PeerID (RECOMMENDED ≤ 64 bytes)
varUint  start                    // inclusive
varUint  end                      // exclusive; MUST satisfy end > start
varString keyId                   // application-defined key version (RECOMMENDED ≤ 64 UTF-8 bytes)
varBytes iv                       // explicit IV; MUST be exactly 12 bytes
varBytes ct                       // AES-GCM(ciphertext || 16-byte tag), see Crypto

// kind = 0x01 (Snapshot)
varUint  vvCount                  // number of entries in version vector (RECOMMENDED ≤ 1024)
repeat vvCount times (sorted by peerId bytes ascending, lexicographic):
  varBytes peerId
  varUint  counter
varString keyId
varBytes iv                       // explicit IV; MUST be exactly 12 bytes
varBytes ct
```

Notes:

- The server MUST be able to parse `kind`, version metadata (`peerId/start/end` for delta or `vv` for snapshot), `iv`, and `keyId` without decrypting `ct`.
- The CRDT bytes (Loro updates or snapshot encoding) are entirely inside `ct` and only readable by clients with the correct key.
- Field bounds: Implementations SHOULD reject records with `peerId` > 64 bytes or `keyId` > 64 UTF‑8 bytes with `Ack.status=invalid_update`. Oversized messages remain subject to the 256 KB limit (`payload_too_large`).

### AEAD AAD and IV

Let `K` be the symmetric key bytes for the given `keyId` (32 bytes recommended).

- AAD (Additional Authenticated Data): the exact concatenation of the record’s plaintext header fields for its `kind`:
  - DeltaSpan AAD = `kind || encode(peerId) || encode(start) || encode(end) || encode(keyId) || encode(iv)`
  - Snapshot AAD = `kind || encode(vvCount) || encode(peerId/counter pairs) || encode(keyId) || encode(iv)`
    where `encode(...)` uses the same `varBytes`/`varUint`/`varString` encodings as above. Encoders MUST include exactly this encoded header as AAD; decoders MUST reject on AEAD verification failure.

- IV (96‑bit): The explicit `iv` field in the record header; MUST be exactly 12 bytes and unique per key. Use a CSPRNG. Do not reuse an IV under the same key.

Encrypt/decrypt with AES‑GCM using this IV and AAD. The `ct` field stores the concatenated ciphertext + 16‑byte tag as emitted by Web Crypto.

Rationale: An explicit random IV per record eliminates IV‑reuse risk and simplifies implementations. Binding the exact header bytes via AAD prevents header tampering.

## Syncing Process (Unchanged, with `%ELO` payloads)

Req and Recv follow the same join/sync rules as `%LOR`:

- JoinRequest carries application-defined join metadata (often auth) and a document version (both opaque to the protocol). Recv may respond with JoinResponseOk, JoinError, and may push missing updates.
- When sending updates, Req packs one or more `%ELO` records into a `DocUpdate` payload. If large, use fragments per the base protocol.
- Recv broadcasts received updates to other subscribers in the same room.
- Leave unsubscribes from the room.

## Server Behavior (Indexing and Dedup)

Although the server cannot decrypt, it SHOULD index the plaintext headers for efficient sync:

- Storage model: `Map<PeerID, Array<Span>>` where each Span is `[start,end)` with associated `keyId` and raw `record` bytes. Spans are kept sorted by `start`.
- Dedup/merge (Span Override): On receiving a new DeltaSpan for `peerId = P` with span `[S,E)`, replace only if the new span fully covers existing spans for the same `peerId` (i.e., for each covered span `[s,e)`, `S ≤ s` and `E ≥ e`). This replacement is based solely on version metadata and applies regardless of `keyId`.
- Querying: Given a requester version vector `VV`, send all delta spans where `end > VV[peerId]` (i.e., spans that extend beyond the requester’s counter for that `peerId`).
- Validation: Servers SHOULD validate header encodings (e.g., `end > start`, for DeltaSpan plaintext, `iv` length == 12, recommended `peerId`/`keyId` bounds) and reject malformed updates with `Ack.status=invalid_update`. Over‑limit payloads SHOULD be rejected with `Ack.status=payload_too_large`.
- Snapshots: On receiving a snapshot record, applications MAY choose to replace prior stored deltas according to their retention policy (e.g., keep a window of recent deltas). Authorization for snapshot override is an application concern.

The server MUST treat `keyId` as opaque metadata and MUST NOT rely on or require any specific format.

## Client Behavior and Interface

Clients typically need a hook to resolve keys:

```
type GetPrivateKey = (keyId?: string) => Promise<{ keyId: string; key: Uint8Array }>;
```

- Export: when sending, export CRDT updates as contiguous spans per peer, encrypt each span into a DeltaSpan record, then encode into the container.
- Import: when receiving, parse the container, for each record read the explicit `iv`, build AAD from the exact encoded header, decrypt `ct`, and batch‑import the plaintext updates/snapshot into the CRDT.
- Unknown key handling: If a record’s `keyId` is unknown, clients SHOULD fetch/resolve the key and retry decryption. If resolution fails or decryption fails with a known key, surface a local error (no Ack is emitted because the server is unaware).

Key rotation is handled by publishing new records with a new `keyId`. Receivers that encounter an unknown `keyId` must obtain the key via application logic and then retry decryption.

## Limits and Fragmentation

- Max message size remains 256 KB. The container format should be sized accordingly; use `DocUpdateFragmentHeader (0x04)`/`DocUpdateFragment (0x05)` when larger.
- Fragmentation happens after serializing the container bytes. Reassembly on Recv reconstructs the full container before parsing headers.

## Errors and Telemetry

- Client‑local decrypt failures: Report via a local callback (e.g., `onError({ kind: 'decrypt_failed' | 'unknown_key', peerId, start, end, keyId })`). Servers cannot detect these.
- Server rejections: Map header validation issues to `Ack.status=invalid_update`; size over limits to `Ack.status=payload_too_large`; fragment timeout behavior is unchanged from the base protocol.
- Observability: For debugging, servers SHOULD log anonymized header fields (e.g., `peerId`, `start`, `end`, `keyId`) and high‑level outcomes. Servers MUST NOT log `ct` contents.

## Normative Test Vector (DeltaSpan)

The following vector demonstrates explicit‑IV AES‑GCM encryption for a single‑record DeltaSpan. All values are hex unless noted.

- key (32 bytes): 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
- kind = 00 (DeltaSpan)
- peerId = 01020304 (raw bytes), encode(peerId) = 0401020304
- start = 1 -> 01
- end = 3 -> 03
- keyId = "k1", encode(keyId) = 026b31
- iv (explicit): 86bcad09d5e7e3d70503a57e, encode(iv) = 0c86bcad09d5e7e3d70503a57e
- AAD = kind || enc(peerId) || enc(start) || enc(end) || enc(keyId) || enc(iv) = 0004010203040103026b310c86bcad09d5e7e3d70503a57e
- Plaintext (DeltaSpan canonical): varUint M=1, then 1 varBytes("hi") -> 01026869
- AES‑GCM(IV, AAD) ct = ciphertext || tag (tag is 16 bytes): 6930a8fbe96cc5f30b67f4bc7f53262e01b62852

Implementations MUST reproduce these values exactly to ensure cross‑language interoperability when using the same primitives.

## Security Considerations

- Header integrity: AAD covers all plaintext header fields. Encoders MUST include exactly the encoded header as AAD; decoders MUST reject on AEAD failure.
- IV uniqueness: IV is explicit in each record and MUST be generated using a CSPRNG; do not reuse an IV under the same key.
- Replay: Receivers SHOULD deduplicate by version metadata; replays are benign at the CRDT layer but may waste bandwidth.
- Key rotation: Select non‑revealing `keyId` values; treat distribution as an application concern. Consider migrating to a fresh snapshot under the new key for compaction.
- Confidentiality: Only `ct` is confidential; header fields are visible to intermediaries by design to enable routing and dedup.

## Compatibility

- Transport, message types, errors, and keepalive frames are identical to the base protocol.
- `%ELO` only changes the interpretation of the `DocUpdate` payload. Other CRDT types (e.g., `%LOR`, `%EPH`, `%YJS`, `%YAW`) are unaffected.
