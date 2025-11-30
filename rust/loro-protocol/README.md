# loro-protocol (Rust)

Rust implementation of the Loro syncing protocol encoder/decoder. Mirrors the TypeScript package in `packages/loro-protocol` and follows the wire format described in `protocol.md` and the end-to-end encrypted flow in `protocol-e2ee.md`.

## Features
- Encode/decode Join, DocUpdate, FragmentHeader/Fragment, UpdateError, and Leave messages
- 256 KiB message size guard to match the wire spec
- Bytes utilities (`BytesWriter`, `BytesReader`) for varint/varbytes/varstring
- `%ELO` container parsing; Rust-side encryption helpers are WIP and may evolve

## Usage

Add the crate to your workspace (published crate name matches the package):

```bash
cargo add loro-protocol
```

Encode and decode messages:

```rust
use loro_protocol::{encode, decode, ProtocolMessage, CrdtType};

let msg = ProtocolMessage::JoinRequest {
    crdt: CrdtType::Loro,
    room_id: "room-123".to_string(),
    auth: vec![],
    version: vec![],
};

let bytes = encode(&msg)?;
let roundtrip = decode(&bytes)?;
assert_eq!(roundtrip, msg);
```

Streaming-friendly decode:

```rust
use loro_protocol::try_decode;

let buf = /* bytes from the wire */;
if let Some(msg) = try_decode(&buf) {
    // valid message
} else {
    // malformed or incomplete buffer
}
```

## Tests

```bash
cargo test -p loro-protocol
```

## Spec References

- `protocol.md` for the wire format and message semantics
- `protocol-e2ee.md` for %ELO encryption details
