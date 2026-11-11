use loro_protocol::{decode, encode, BatchId, CrdtType, ProtocolMessage, MAX_MESSAGE_SIZE};

fn update(payload: usize, room: &str) -> ProtocolMessage {
    ProtocolMessage::DocUpdate {
        crdt: CrdtType::Loro,
        room_id: room.into(),
        updates: vec![vec![17; payload]],
        batch_id: BatchId([0; 8]),
    }
}

#[test]
fn encoding_preserves_exact_limit_and_room_error_precedence() {
    // 4 magic + 2 room + 1 type + 1 count + 3 payload length + 8 batch ID.
    let limit = MAX_MESSAGE_SIZE - 19;
    let message = update(limit, "x");
    let bytes = encode(&message).unwrap();
    assert_eq!(bytes.len(), MAX_MESSAGE_SIZE);
    assert_eq!(decode(&bytes).unwrap(), message);
    assert_eq!(
        encode(&update(limit + 1, "x")).unwrap_err(),
        format!(
            "Message size {} exceeds maximum {}",
            MAX_MESSAGE_SIZE + 1,
            MAX_MESSAGE_SIZE
        )
    );
    assert_eq!(
        encode(&update(MAX_MESSAGE_SIZE, &"x".repeat(129))).unwrap_err(),
        "Room ID too long"
    );
}

#[test]
fn varint_boundaries_and_many_empty_updates_keep_wire_parity() {
    for size in [0, 1, 127, 128, 16383, 16384] {
        let message = update(size, "世界");
        let bytes = encode(&message).unwrap();
        assert_eq!(decode(&bytes).unwrap(), message);
    }
    let message = ProtocolMessage::DocUpdate {
        crdt: CrdtType::Loro,
        room_id: "x".into(),
        updates: vec![vec![]; MAX_MESSAGE_SIZE],
        batch_id: BatchId([0; 8]),
    };
    assert!(encode(&message).unwrap_err().starts_with("Message size "));
}
