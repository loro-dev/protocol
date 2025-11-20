# loro-protocol

Binary wire protocol for Loro CRDTs (TypeScript). Provides compact encoders/decoders for all protocol messages, bytes utilities, and helpers for the %ELO end-to-end encrypted flow (AES‑GCM with 12‑byte IV and exact-header AAD).

## Install

```bash
pnpm add loro-protocol
```

## Features

- Message encoding/decoding for Join/DocUpdate/Fragments/Errors/Leave
- 256 KiB message size guard with fragmentation support at higher layers
- Bytes helpers (`BytesWriter`, `BytesReader`) with varUint/varBytes/varString
- %ELO helpers: container codec, record header parsing, AES‑GCM encrypt/decrypt

See `protocol.md` and `protocol-e2ee.md` at the repo root for the ground‑truth spec.

## Usage

Encode and decode messages:

```ts
import { encode, decode, CrdtType, MessageType } from "loro-protocol";

const join = encode({
  type: MessageType.JoinRequest,
  crdt: CrdtType.Loro,
  roomId: "room-1",
  auth: new Uint8Array(),
  version: new Uint8Array(),
});

const msg = decode(join);
console.log(msg.type); // 0x00 JoinRequest
```

%ELO encrypted records (AES‑GCM):

```ts
import {
  EloRecordKind,
  encryptSnapshot,
  encryptDeltaSpan,
  decryptEloRecord,
  encodeEloContainer,
  decodeEloContainer,
  parseEloRecordHeader,
} from "loro-protocol";

// Encrypt a snapshot
const key = crypto.getRandomValues(new Uint8Array(32));
const plaintext = new Uint8Array([1, 2, 3]);
const { record } = await encryptSnapshot(plaintext, { vv: [], keyId: "k1" }, key);
const container = encodeEloContainer([record]);

// Later, parse and decrypt
const [rec] = decodeEloContainer(container);
const parsed = parseEloRecordHeader(rec);
const out = await decryptEloRecord(rec, async () => key);
console.log(parsed.kind === EloRecordKind.Snapshot, out.plaintext);
```

Notes
- The server can parse %ELO headers to index/backfill but never decrypts `ct`.
- IV must be exactly 12 bytes and unique per key; AAD is the exact encoded header.

## API Surface

- Encoding/decoding: `encode(msg)`, `decode(buf)`, `tryDecode(buf)`
- Bytes: `BytesWriter`, `BytesReader`
- %ELO: `encodeEloContainer`, `decodeEloContainer`, `parseEloRecordHeader`, `encryptSnapshot`, `encryptDeltaSpan`, `decryptEloRecord`

## Node/Web Compatibility

%ELO crypto uses Web Crypto (`globalThis.crypto.subtle`). Node 18+ provides it via `globalThis.crypto`.

## License

MIT

