//! Loro Syncing Protocol (Rust)
//!
//! This crate provides a pure-Rust implementation of the message
//! encoding/decoding used by the Loro syncing protocol. It mirrors the
//! TypeScript package in `packages/loro-protocol` and follows the wire format
//! specified in `/protocol.md`.
//!
//! Features:
//! - Compact, allocation-friendly binary encoding
//! - Support for Loro, Yjs, Loro Ephemeral Store, and Yjs Awareness CRDT kinds
//! - Strict validation for message type, room id length, and maximum message size (256KB)
//! - Helpers for variable-length integers/bytes/strings
//!
//! Quick start
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
//! For the protocol details and field ordering, see `protocol.md`.

pub mod bytes;
pub mod protocol;
pub mod encoding;
pub mod elo;

pub use bytes::{BytesReader, BytesWriter};
pub use encoding::{decode, encode, try_decode};
pub use protocol::*;
pub use elo::*;
