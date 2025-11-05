//! Protocol types and constants mirrored from `protocol.md` and the TS package.
//!
//! These are the source-of-truth structures for the Rust encoder/decoder. The
//! `ProtocolMessage` enum aggregates all message variants.
/// Reserved library magic string, aligned with the TypeScript library.
/// Not part of the message envelope; included for parity.
pub const MAGIC: &str = "LRSP";
pub const MAX_MESSAGE_SIZE: usize = 256 * 1024; // 256KB

/// CRDT types supported by the wire format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrdtType {
    /// "%LOR"
    Loro,
    /// "%EPH"
    LoroEphemeralStore,
    /// "%EPS"
    LoroEphemeralStorePersisted,
    /// "%YJS"
    Yjs,
    /// "%YAW"
    YjsAwareness,
    /// "%ELO" (End-to-End Encrypted Loro)
    Elo,
}

impl CrdtType {
    pub fn magic_bytes(self) -> [u8; 4] {
        match self {
            CrdtType::Loro => *b"%LOR",
            CrdtType::LoroEphemeralStore => *b"%EPH",
            CrdtType::LoroEphemeralStorePersisted => *b"%EPS",
            CrdtType::Yjs => *b"%YJS",
            CrdtType::YjsAwareness => *b"%YAW",
            CrdtType::Elo => *b"%ELO",
        }
    }

    pub fn from_magic_bytes(bytes: [u8; 4]) -> Option<Self> {
        match &bytes {
            b"%LOR" => Some(CrdtType::Loro),
            b"%EPH" => Some(CrdtType::LoroEphemeralStore),
            b"%EPS" => Some(CrdtType::LoroEphemeralStorePersisted),
            b"%YJS" => Some(CrdtType::Yjs),
            b"%YAW" => Some(CrdtType::YjsAwareness),
            b"%ELO" => Some(CrdtType::Elo),
            _ => None,
        }
    }
}

/// Permission returned by a successful JoinResponse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Read,
    Write,
}

/// Message type tags as defined in protocol.md
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MessageType {
    JoinRequest = 0x00,
    JoinResponseOk = 0x01,
    JoinError = 0x02,
    DocUpdate = 0x03,
    DocUpdateFragmentHeader = 0x04,
    DocUpdateFragment = 0x05,
    UpdateError = 0x06,
    Leave = 0x07,
}

impl MessageType {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0x00 => MessageType::JoinRequest,
            0x01 => MessageType::JoinResponseOk,
            0x02 => MessageType::JoinError,
            0x03 => MessageType::DocUpdate,
            0x04 => MessageType::DocUpdateFragmentHeader,
            0x05 => MessageType::DocUpdateFragment,
            0x06 => MessageType::UpdateError,
            0x07 => MessageType::Leave,
            _ => return None,
        })
    }
}

/// Error codes for JoinError (0x02).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum JoinErrorCode {
    Unknown = 0x00,
    VersionUnknown = 0x01,
    AuthFailed = 0x02,
    AppError = 0x7f,
}

impl JoinErrorCode {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0x00 => JoinErrorCode::Unknown,
            0x01 => JoinErrorCode::VersionUnknown,
            0x02 => JoinErrorCode::AuthFailed,
            0x7f => JoinErrorCode::AppError,
            _ => return None,
        })
    }
}

/// Error codes for UpdateError (0x06).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum UpdateErrorCode {
    Unknown = 0x00,
    PermissionDenied = 0x03,
    InvalidUpdate = 0x04,
    PayloadTooLarge = 0x05,
    RateLimited = 0x06,
    FragmentTimeout = 0x07,
    AppError = 0x7f,
}

impl UpdateErrorCode {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0x00 => UpdateErrorCode::Unknown,
            0x03 => UpdateErrorCode::PermissionDenied,
            0x04 => UpdateErrorCode::InvalidUpdate,
            0x05 => UpdateErrorCode::PayloadTooLarge,
            0x06 => UpdateErrorCode::RateLimited,
            0x07 => UpdateErrorCode::FragmentTimeout,
            0x7f => UpdateErrorCode::AppError,
            _ => return None,
        })
    }
}

/// 8-byte batch ID for fragmenting. On the wire this is exactly 8 raw bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BatchId(pub [u8; 8]);

impl BatchId {
    pub fn from_hex(s: &str) -> Result<Self, String> {
        let s = s.strip_prefix("0x").unwrap_or(s);
        if s.len() != 16 {
            return Err("batch id hex must be 16 chars".into());
        }
        let mut out = [0u8; 8];
        for (i, slot) in out.iter_mut().enumerate() {
            let idx = i * 2;
            let byte =
                u8::from_str_radix(&s[idx..idx + 2], 16).map_err(|_| "invalid hex".to_string())?;
            *slot = byte;
        }
        Ok(BatchId(out))
    }

    pub fn to_hex(self) -> String {
        let mut s = String::from("0x");
        for b in self.0.iter() {
            use std::fmt::Write as _;
            let _ = write!(s, "{:02x}", b);
        }
        s
    }
}

/// All protocol messages as a single enum. Each variant includes the common
/// `crdt` magic and `room_id` as part of the struct fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolMessage {
    JoinRequest {
        crdt: CrdtType,
        room_id: Vec<u8>,
        auth: Vec<u8>,
        version: Vec<u8>,
    },
    JoinResponseOk {
        crdt: CrdtType,
        room_id: Vec<u8>,
        permission: Permission,
        version: Vec<u8>,
        extra: Option<Vec<u8>>,
    },
    JoinError {
        crdt: CrdtType,
        room_id: Vec<u8>,
        code: JoinErrorCode,
        message: String,
        receiver_version: Option<Vec<u8>>,
        app_code: Option<String>,
    },
    DocUpdate {
        crdt: CrdtType,
        room_id: Vec<u8>,
        updates: Vec<Vec<u8>>,
    },
    DocUpdateFragmentHeader {
        crdt: CrdtType,
        room_id: Vec<u8>,
        batch_id: BatchId,
        fragment_count: u64,
        total_size_bytes: u64,
    },
    DocUpdateFragment {
        crdt: CrdtType,
        room_id: Vec<u8>,
        batch_id: BatchId,
        index: u64,
        fragment: Vec<u8>,
    },
    UpdateError {
        crdt: CrdtType,
        room_id: Vec<u8>,
        code: UpdateErrorCode,
        message: String,
        batch_id: Option<BatchId>,
        app_code: Option<String>,
    },
    Leave {
        crdt: CrdtType,
        room_id: Vec<u8>,
    },
}
