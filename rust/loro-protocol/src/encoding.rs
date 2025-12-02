//! Binary encoder/decoder for the Loro protocol wire format.
//!
//! Follows the field order and validation rules from `protocol.md` and matches
//! the JS implementation in `packages/loro-protocol/src/encoding.ts`.
use crate::bytes::{BytesReader, BytesWriter};
use crate::protocol::*;

const MAX_ROOM_ID_LENGTH: usize = 128;

fn encode_crdt(w: &mut BytesWriter, crdt: CrdtType) {
    w.push_bytes(&crdt.magic_bytes());
}

fn decode_crdt(r: &mut BytesReader) -> Result<CrdtType, String> {
    if r.remaining() < 4 { return Err("Invalid message: too short for CRDT type".into()); }
    let bytes = r.read_bytes(4)?;
    let mut arr = [0u8; 4];
    arr.copy_from_slice(bytes);
    CrdtType::from_magic_bytes(arr).ok_or_else(|| format!("Invalid CRDT type: {}{}{}{}",
        arr[0] as char, arr[1] as char, arr[2] as char, arr[3] as char))
}

fn encode_permission(w: &mut BytesWriter, p: Permission) {
    match p {
        Permission::Read => w.push_var_string("read"),
        Permission::Write => w.push_var_string("write"),
    }
}

fn decode_permission(r: &mut BytesReader) -> Result<Permission, String> {
    match r.read_var_string()?.as_str() {
        "read" => Ok(Permission::Read),
        "write" => Ok(Permission::Write),
        other => Err(format!("Invalid permission: {}", other)),
    }
}
/// Encode a `ProtocolMessage` into a compact binary form according to protocol.md.
///
/// The encoder writes, in order: 4-byte CRDT magic, `varBytes` room id, 1-byte
/// message type tag, and the message-specific payload. It validates room id
/// length and ensures the final buffer does not exceed 256KB.
///
/// Returns an owned `Vec<u8>` containing the encoded message.
pub fn encode(message: &ProtocolMessage) -> Result<Vec<u8>, String> {
    let mut w = BytesWriter::new();

    // Common: crdt, room_id, type
    match message {
        ProtocolMessage::JoinRequest { crdt, room_id, auth: _, version: _ }
        | ProtocolMessage::JoinResponseOk { crdt, room_id, permission: _, version: _, extra: _ }
        | ProtocolMessage::JoinError { crdt, room_id, code: _, message: _, receiver_version: _, app_code: _ }
        | ProtocolMessage::DocUpdate { crdt, room_id, updates: _ }
        | ProtocolMessage::DocUpdateV2 { crdt, room_id, batch_id: _, updates: _ }
        | ProtocolMessage::DocUpdateFragmentHeader { crdt, room_id, batch_id: _, fragment_count: _, total_size_bytes: _ }
        | ProtocolMessage::DocUpdateFragment { crdt, room_id, batch_id: _, index: _, fragment: _ }
        | ProtocolMessage::UpdateError { crdt, room_id, code: _, message: _, batch_id: _, app_code: _ }
        | ProtocolMessage::Ack { crdt, room_id, batch_id: _ }
        | ProtocolMessage::UpdateErrorV2 { crdt, room_id, batch_id: _, code: _, message: _, app_code: _ }
        | ProtocolMessage::Leave { crdt, room_id } => {
            let room_id_bytes = room_id.as_bytes();
            if room_id_bytes.len() > MAX_ROOM_ID_LENGTH { return Err("Room ID too long".into()); }
            encode_crdt(&mut w, *crdt);
            w.push_var_bytes(room_id_bytes);
        }
    }

    // Type byte
    let ty: u8 = match message {
        ProtocolMessage::JoinRequest { .. } => MessageType::JoinRequest as u8,
        ProtocolMessage::JoinResponseOk { .. } => MessageType::JoinResponseOk as u8,
        ProtocolMessage::JoinError { .. } => MessageType::JoinError as u8,
        ProtocolMessage::DocUpdate { .. } => MessageType::DocUpdate as u8,
        ProtocolMessage::DocUpdateFragmentHeader { .. } => MessageType::DocUpdateFragmentHeader as u8,
        ProtocolMessage::DocUpdateFragment { .. } => MessageType::DocUpdateFragment as u8,
        ProtocolMessage::UpdateError { .. } => MessageType::UpdateError as u8,
        ProtocolMessage::DocUpdateV2 { .. } => MessageType::DocUpdateV2 as u8,
        ProtocolMessage::Ack { .. } => MessageType::Ack as u8,
        ProtocolMessage::UpdateErrorV2 { .. } => MessageType::UpdateErrorV2 as u8,
        ProtocolMessage::Leave { .. } => MessageType::Leave as u8,
    };
    w.push_byte(ty);

    // Payload
    match message {
        ProtocolMessage::JoinRequest { auth, version, .. } => {
            w.push_var_bytes(auth);
            w.push_var_bytes(version);
        }
        ProtocolMessage::JoinResponseOk { permission, version, extra, .. } => {
            encode_permission(&mut w, *permission);
            w.push_var_bytes(version);
            if let Some(e) = extra { w.push_var_bytes(e); } else { w.push_var_bytes(&[]); }
        }
        ProtocolMessage::JoinError { code, message, receiver_version, app_code, .. } => {
            w.push_byte(*code as u8);
            w.push_var_string(message);
            if matches!(code, JoinErrorCode::VersionUnknown) {
                if let Some(v) = receiver_version { w.push_var_bytes(v); }
            }
            if matches!(code, JoinErrorCode::AppError) {
                if let Some(app) = app_code { w.push_var_string(app); }
            }
        }
        ProtocolMessage::DocUpdate { updates, .. } => {
            w.push_uleb128(updates.len() as u64);
            for u in updates { w.push_var_bytes(u); }
        }
        ProtocolMessage::DocUpdateV2 { batch_id, updates, .. } => {
            w.push_bytes(&batch_id.0);
            w.push_uleb128(updates.len() as u64);
            for u in updates { w.push_var_bytes(u); }
        }
        ProtocolMessage::DocUpdateFragmentHeader { batch_id, fragment_count, total_size_bytes, .. } => {
            w.push_bytes(&batch_id.0);
            w.push_uleb128(*fragment_count);
            w.push_uleb128(*total_size_bytes);
        }
        ProtocolMessage::DocUpdateFragment { batch_id, index, fragment, .. } => {
            w.push_bytes(&batch_id.0);
            w.push_uleb128(*index);
            w.push_var_bytes(fragment);
        }
        ProtocolMessage::UpdateError { code, message, batch_id, app_code, .. } => {
            w.push_byte(*code as u8);
            w.push_var_string(message);
            if matches!(code, UpdateErrorCode::FragmentTimeout) {
                if let Some(id) = batch_id { w.push_bytes(&id.0); }
            }
            if matches!(code, UpdateErrorCode::AppError) {
                if let Some(app) = app_code { w.push_var_string(app); }
            }
        }
        ProtocolMessage::Ack { batch_id, .. } => {
            w.push_bytes(&batch_id.0);
        }
        ProtocolMessage::UpdateErrorV2 { batch_id, code, message, app_code, .. } => {
            w.push_bytes(&batch_id.0);
            w.push_byte(*code as u8);
            w.push_var_string(message);
            if matches!(code, UpdateErrorCode::AppError) {
                if let Some(app) = app_code { w.push_var_string(app); }
            }
        }
        ProtocolMessage::Leave { .. } => {}
    }

    let out = w.finalize();
    if out.len() > MAX_MESSAGE_SIZE {
        return Err(format!(
            "Message size {} exceeds maximum {}",
            out.len(), MAX_MESSAGE_SIZE
        ));
    }
    Ok(out)
}

pub fn decode(buf: &[u8]) -> Result<ProtocolMessage, String> {
    let mut r = BytesReader::new(buf);

    // CRDT
    let crdt = decode_crdt(&mut r)?;
    // room id (varString)
    let room_id = r.read_var_string()?;
    if room_id.len() > MAX_ROOM_ID_LENGTH {
        return Err("Room ID exceeds maximum length of 128 bytes".into());
    }

    // type
    let t = r.read_byte()?;
    let ty = MessageType::from_u8(t).ok_or_else(|| "Invalid message type".to_string())?;

    use ProtocolMessage as PM;
    let msg = match ty {
        MessageType::JoinRequest => {
            let auth = r.read_var_bytes()?.to_vec();
            let version = r.read_var_bytes()?.to_vec();
            PM::JoinRequest { crdt, room_id, auth, version }
        }
        MessageType::JoinResponseOk => {
            let permission = decode_permission(&mut r)?;
            let version = r.read_var_bytes()?.to_vec();
            let extra = r.read_var_bytes()?.to_vec();
            PM::JoinResponseOk { crdt, room_id, permission, version, extra: Some(extra) }
        }
        MessageType::JoinError => {
            let code = r.read_byte().ok().and_then(JoinErrorCode::from_u8).unwrap_or(JoinErrorCode::Unknown);
            let message = r.read_var_string()?;
            let mut receiver_version = None;
            let mut app_code = None;
            if matches!(code, JoinErrorCode::VersionUnknown) && r.remaining() > 0 {
                if let Ok(bytes) = r.read_var_bytes() { receiver_version = Some(bytes.to_vec()); }
            }
            if matches!(code, JoinErrorCode::AppError) && r.remaining() > 0 {
                if let Ok(app) = r.read_var_string() { app_code = Some(app); }
            }
            PM::JoinError { crdt, room_id, code, message, receiver_version, app_code }
        }
        MessageType::DocUpdate => {
            let count = r.read_uleb128()? as usize;
            let mut updates = Vec::with_capacity(count);
            for _ in 0..count { updates.push(r.read_var_bytes()?.to_vec()); }
            PM::DocUpdate { crdt, room_id, updates }
        }
        MessageType::DocUpdateV2 => {
            if r.remaining() < 8 { return Err("Invalid DocUpdateV2: missing batch ID".into()); }
            let id = r.read_bytes(8)?;
            let mut arr = [0u8; 8];
            arr.copy_from_slice(id);
            let batch_id = BatchId(arr);
            let count = r.read_uleb128()? as usize;
            let mut updates = Vec::with_capacity(count);
            for _ in 0..count { updates.push(r.read_var_bytes()?.to_vec()); }
            PM::DocUpdateV2 { crdt, room_id, batch_id, updates }
        }
        MessageType::DocUpdateFragmentHeader => {
            if r.remaining() < 8 { return Err("Invalid DocUpdateFragmentHeader: missing batch ID".into()); }
            let id = r.read_bytes(8)?;
            let mut arr = [0u8; 8];
            arr.copy_from_slice(id);
            let batch_id = BatchId(arr);
            let fragment_count = r.read_uleb128()?;
            let total_size_bytes = r.read_uleb128()?;
            PM::DocUpdateFragmentHeader { crdt, room_id, batch_id, fragment_count, total_size_bytes }
        }
        MessageType::DocUpdateFragment => {
            if r.remaining() < 8 { return Err("Invalid DocUpdateFragment: missing batch ID".into()); }
            let id = r.read_bytes(8)?;
            let mut arr = [0u8; 8];
            arr.copy_from_slice(id);
            let batch_id = BatchId(arr);
            let index = r.read_uleb128()?;
            let fragment = r.read_var_bytes()?.to_vec();
            PM::DocUpdateFragment { crdt, room_id, batch_id, index, fragment }
        }
        MessageType::UpdateError => {
            let code = r.read_byte().ok().and_then(UpdateErrorCode::from_u8).unwrap_or(UpdateErrorCode::Unknown);
            let message = r.read_var_string()?;
            let mut batch_id = None;
            let mut app_code = None;
            if matches!(code, UpdateErrorCode::FragmentTimeout) && r.remaining() >= 8 {
                let id = r.read_bytes(8)?;
                let mut arr = [0u8; 8];
                arr.copy_from_slice(id);
                batch_id = Some(BatchId(arr));
            }
            if matches!(code, UpdateErrorCode::AppError) && r.remaining() > 0 {
                if let Ok(app) = r.read_var_string() { app_code = Some(app); }
            }
            PM::UpdateError { crdt, room_id, code, message, batch_id, app_code }
        }
        MessageType::Ack => {
            if r.remaining() < 8 { return Err("Invalid Ack: missing batch ID".into()); }
            let id = r.read_bytes(8)?;
            let mut arr = [0u8; 8];
            arr.copy_from_slice(id);
            let batch_id = BatchId(arr);
            PM::Ack { crdt, room_id, batch_id }
        }
        MessageType::UpdateErrorV2 => {
            if r.remaining() < 8 { return Err("Invalid UpdateErrorV2: missing batch ID".into()); }
            let id = r.read_bytes(8)?;
            let mut arr = [0u8; 8];
            arr.copy_from_slice(id);
            let batch_id = BatchId(arr);
            let code = r.read_byte().ok().and_then(UpdateErrorCode::from_u8).unwrap_or(UpdateErrorCode::Unknown);
            let message = r.read_var_string()?;
            let mut app_code = None;
            if matches!(code, UpdateErrorCode::AppError) && r.remaining() > 0 {
                if let Ok(app) = r.read_var_string() { app_code = Some(app); }
            }
            PM::UpdateErrorV2 { crdt, room_id, batch_id, code, message, app_code }
        }
        MessageType::Leave => PM::Leave { crdt, room_id },
    };

    Ok(msg)
}

/// Attempt to decode a message, returning `None` when parsing fails.
pub fn try_decode(buf: &[u8]) -> Option<ProtocolMessage> {
    decode(buf).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_leave() {
        let msg = ProtocolMessage::Leave {
            crdt: CrdtType::Loro,
            room_id: "room-123".to_string(),
        };
        let enc = encode(&msg).unwrap();
        let dec = decode(&enc).unwrap();
        assert_eq!(msg, dec);
    }

    #[test]
    fn encode_join_response_ok_defaults_extra() {
        let msg = ProtocolMessage::JoinResponseOk {
            crdt: CrdtType::Yjs,
            room_id: "room-123".to_string(),
            permission: Permission::Read,
            version: vec![10,20],
            extra: None,
        };
        let enc = encode(&msg).unwrap();
        let dec = decode(&enc).unwrap();
        match dec {
            ProtocolMessage::JoinResponseOk { permission, version, extra, .. } => {
                assert!(matches!(permission, Permission::Read));
                assert_eq!(version, vec![10,20]);
                // decoder reads varBytes even if empty is encoded
                assert_eq!(extra.unwrap_or_default(), Vec::<u8>::new());
            }
            _ => panic!("wrong decoded type"),
        }
    }

    #[test]
    fn encode_rejects_room_id_over_limit() {
        let long_room = "x".repeat(129);
        let msg = ProtocolMessage::JoinRequest {
            crdt: CrdtType::Loro,
            room_id: long_room,
            auth: vec![],
            version: vec![],
        };
        let err = encode(&msg).unwrap_err();
        assert!(err.contains("Room ID too long"));
    }

    #[test]
    fn encode_rejects_payload_over_max_size() {
        // Build an intentionally oversized payload (header + one giant update)
        let big_update = vec![0u8; MAX_MESSAGE_SIZE + 1024];
        let msg = ProtocolMessage::DocUpdateV2 {
            crdt: CrdtType::Loro,
            room_id: "room-oversized".into(),
            batch_id: BatchId([0; 8]),
            updates: vec![big_update],
        };
        let err = encode(&msg).unwrap_err();
        assert!(err.contains("exceeds maximum"));
    }
}
