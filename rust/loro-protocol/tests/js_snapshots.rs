use loro_protocol::*;

fn to_hex(data: &[u8]) -> String {
    let mut s = String::from("0x");
    for b in data { use std::fmt::Write as _; let _ = write!(s, "{:02x}", b); }
    s
}

#[test]
fn snapshot_join_request() {
    // Matches: packages/loro-protocol/src/__snapshots__/encoding.snap.test.ts.snap
    // exports[`encoding snapshots > JoinRequest 1`]
    let msg = ProtocolMessage::JoinRequest {
        crdt: CrdtType::Loro,
        room_id: "room-1234".to_string(),
        auth: vec![10,20,30],
        version: vec![40,50,60],
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x254c4f5209726f6f6d2d3132333400030a141e0328323c");
}

#[test]
fn snapshot_join_response_read() {
    // exports[`encoding snapshots > JoinResponseOk read 1`]
    let msg = ProtocolMessage::JoinResponseOk {
        crdt: CrdtType::Yjs,
        room_id: "room-1234".to_string(),
        permission: Permission::Read,
        version: vec![11,22,33],
        extra: None,
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x25594a5309726f6f6d2d31323334010472656164030b162100");
}

#[test]
fn snapshot_join_response_write_extra() {
    // exports[`encoding snapshots > JoinResponseOk write + extra 1`]
    let msg = ProtocolMessage::JoinResponseOk {
        crdt: CrdtType::Loro,
        room_id: "room-1234".to_string(),
        permission: Permission::Write,
        version: vec![44,55],
        extra: Some(vec![66,77,88]),
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x254c4f5209726f6f6d2d3132333401057772697465022c3703424d58");
}

#[test]
fn snapshot_join_error_auth_failed() {
    // exports[`encoding snapshots > JoinError auth failed 1`]
    let msg = ProtocolMessage::JoinError {
        crdt: CrdtType::LoroEphemeralStore,
        room_id: "room-1234".to_string(),
        code: JoinErrorCode::AuthFailed,
        message: "Invalid credentials".into(),
        receiver_version: None,
        app_code: None,
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x2545504809726f6f6d2d31323334020213496e76616c69642063726564656e7469616c73");
}

#[test]
fn snapshot_join_error_version_unknown() {
    // exports[`encoding snapshots > JoinError version unknown with receiver version 1`]
    let msg = ProtocolMessage::JoinError {
        crdt: CrdtType::Loro,
        room_id: "room-1234".to_string(),
        code: JoinErrorCode::VersionUnknown,
        message: "Version mismatch".into(),
        receiver_version: Some(vec![99, 100]),
        app_code: None,
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x254c4f5209726f6f6d2d3132333402011056657273696f6e206d69736d61746368026364");
}

#[test]
fn snapshot_join_error_app_error() {
    // exports[`encoding snapshots > JoinError app error with appCode 1`]
    let msg = ProtocolMessage::JoinError {
        crdt: CrdtType::Yjs,
        room_id: "room-1234".to_string(),
        code: JoinErrorCode::AppError,
        message: "Application specific error".into(),
        receiver_version: None,
        app_code: Some("quota_exceeded".into()),
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x25594a5309726f6f6d2d31323334027f1a4170706c69636174696f6e207370656369666963206572726f720e71756f74615f6578636565646564");
}

#[test]
fn snapshot_doc_update_v2_multiple() {
    // exports[`encoding snapshots > DocUpdateV2 multiple updates 1`]
    let msg = ProtocolMessage::DocUpdateV2 {
        crdt: CrdtType::Yjs,
        room_id: "room-1234".to_string(),
        batch_id: BatchId::from_hex("0x0a0b0c0d0e0f0001").unwrap(),
        updates: vec![vec![1,2,3], vec![4,5,6,7], vec![8]],
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x25594a5309726f6f6d2d31323334080a0b0c0d0e0f0001030301020304040506070108");
}

#[test]
fn snapshot_ack() {
    // exports[`encoding snapshots > Ack 1`]
    let msg = ProtocolMessage::Ack {
        crdt: CrdtType::Loro,
        room_id: "room-1234".to_string(),
        batch_id: BatchId::from_hex("0x0f0e0d0c0b0a0908").unwrap(),
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x254c4f5209726f6f6d2d31323334090f0e0d0c0b0a0908");
}

#[test]
fn snapshot_fragment_header() {
    // exports[`encoding snapshots > DocUpdateFragmentHeader 1`]
    let msg = ProtocolMessage::DocUpdateFragmentHeader {
        crdt: CrdtType::Loro,
        room_id: "room-1234".to_string(),
        batch_id: BatchId::from_hex("0xff11223344556677").unwrap(),
        fragment_count: 10,
        total_size_bytes: 1_024_000,
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x254c4f5209726f6f6d2d3132333404ff112233445566770a80c03e");
}

#[test]
fn snapshot_fragment() {
    // exports[`encoding snapshots > DocUpdateFragment 1`]
    let mut frag = vec![0u8; 32];
    for (i, b) in frag.iter_mut().enumerate() { *b = (i & 0xff) as u8; }
    let msg = ProtocolMessage::DocUpdateFragment {
        crdt: CrdtType::Loro,
        room_id: "room-1234".to_string(),
        batch_id: BatchId([0u8; 8]),
        index: 3,
        fragment: frag,
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x254c4f5209726f6f6d2d313233340500000000000000000320000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
}

#[test]
fn snapshot_update_error_v2_permission_denied() {
    // exports[`encoding snapshots > UpdateErrorV2 permission denied 1`]
    let msg = ProtocolMessage::UpdateErrorV2 {
        crdt: CrdtType::Loro,
        room_id: "room-1234".to_string(),
        batch_id: BatchId([1,0,0,0,0,0,0,0]),
        code: UpdateErrorCode::PermissionDenied,
        message: "No write permission".into(),
        app_code: None,
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x254c4f5209726f6f6d2d313233340a010000000000000003134e6f207772697465207065726d697373696f6e");
}

#[test]
fn snapshot_update_error_v2_fragment_timeout() {
    // exports[`encoding snapshots > UpdateErrorV2 fragment timeout 1`]
    let msg = ProtocolMessage::UpdateErrorV2 {
        crdt: CrdtType::YjsAwareness,
        room_id: "room-1234".to_string(),
        batch_id: BatchId([1,0,0,0,0,0,0,0]),
        code: UpdateErrorCode::FragmentTimeout,
        message: "Fragment timeout".into(),
        app_code: None,
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x2559415709726f6f6d2d313233340a01000000000000000710467261676d656e742074696d656f7574");
}

#[test]
fn snapshot_update_error_v2_app_error() {
    // exports[`encoding snapshots > UpdateErrorV2 app error with appCode 1`]
    let msg = ProtocolMessage::UpdateErrorV2 {
        crdt: CrdtType::Loro,
        room_id: "room-1234".to_string(),
        batch_id: BatchId([0,0,0,0,0,0,0,1]),
        code: UpdateErrorCode::AppError,
        message: "Custom app error".into(),
        app_code: Some("custom_code_123".into()),
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x254c4f5209726f6f6d2d313233340a00000000000000017f10437573746f6d20617070206572726f720f637573746f6d5f636f64655f313233");
}

#[test]
fn snapshot_leave() {
    // exports[`encoding snapshots > Leave 1`]
    let msg = ProtocolMessage::Leave {
        crdt: CrdtType::Loro,
        room_id: "room-1234".to_string(),
    };
    let hex = to_hex(&encode(&msg).unwrap());
    assert_eq!(hex, "0x254c4f5209726f6f6d2d3132333407");
}
