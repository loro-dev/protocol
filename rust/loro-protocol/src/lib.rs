//! # Loro Syncing Protocol (Rust)
//!
//! Rust encoder/decoder for the Loro wire format described in `/protocol.md`
//! It mirrors the TypeScript implementation in `packages/loro-protocol` and
//! is shared by the Rust WebSocket server/client crates.
//!
//! ## Guarantees
//! - Enforces the 256 KiB per-message limit during encoding
//! - Validates CRDT magic bytes and room id length (<= 128 bytes)
//! - Uses compact, allocation-friendly varint encoding for strings/bytes
//!
//! ## Crate layout
//! - `protocol`: message enums/constants and the `ProtocolMessage` enum
//! - `encoding`: `encode`, `decode`, and `try_decode` helpers
//! - `bytes`: `BytesWriter`/`BytesReader` for varint-friendly buffers
//!
//! ## Quick start
//!
//! ```
//! use loro_protocol::{encode, decode, ProtocolMessage, CrdtType};
//!
//! // Build a JoinRequest
//! let msg = ProtocolMessage::JoinRequest {
//!     crdt: CrdtType::Loro,
//!     room_id: "room-123".to_string(),
//!     auth: vec![10,20,30],
//!     version: vec![40,50,60],
//! };
//!
//! // Encode to bytes and decode back
//! let bytes = encode(&msg).unwrap();
//! let roundtrip = decode(&bytes).unwrap();
//! assert_eq!(roundtrip, msg);
//! ```
//!
//! ## Streaming decode
//!
//! ```
//! use loro_protocol::{encode, try_decode, ProtocolMessage, CrdtType};
//!
//! // Prepare any valid message buffer
//! let buf = encode(&ProtocolMessage::Leave {
//!     crdt: CrdtType::Loro,
//!     room_id: "room-123".into(),
//! }).unwrap();
//!
//! let maybe = try_decode(&buf);
//! assert!(maybe.is_some());
//! ```
//!
//! See `protocol.md` and `protocol-e2ee.md` for the full field ordering and
//! validation rules.

pub mod bytes;
pub mod elo;
pub mod encoding;
pub mod protocol;

pub use bytes::{BytesReader, BytesWriter};
pub use elo::*;
pub use encoding::{decode, encode, try_decode};
pub use protocol::*;
