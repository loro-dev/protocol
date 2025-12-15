use loro_websocket_client::Client;
use loro_websocket_server as server;
use loro_websocket_server::protocol::{self as proto, CrdtType};
use std::sync::Arc;
use tokio::time::{timeout, Duration};

fn hex_to_bytes(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[tokio::test(flavor = "current_thread")]
async fn elo_fragment_reassembly_broadcasts_original_frames() {
    // Boot server
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_task = tokio::spawn(async move {
        let cfg: server::ServerConfig<()> = server::ServerConfig {
            handshake_auth: Some(Arc::new(|_ws, token, _cookies| token == Some("secret"))),
            ..Default::default()
        };
        server::serve_incoming_with_config(listener, cfg)
            .await
            .unwrap();
    });

    let url = format!("ws://{}/elo?token=secret", addr);
    let mut c1 = Client::connect(&url).await.unwrap();
    let mut c2 = Client::connect(&url).await.unwrap();

    // Join %ELO room
    let room_id = "room-frag-elo".to_string();
    c1.send(&proto::ProtocolMessage::JoinRequest {
        crdt: CrdtType::Elo,
        room_id: room_id.clone(),
        auth: Vec::new(),
        version: Vec::new(),
    })
    .await
    .unwrap();
    c2.send(&proto::ProtocolMessage::JoinRequest {
        crdt: CrdtType::Elo,
        room_id: room_id.clone(),
        auth: Vec::new(),
        version: Vec::new(),
    })
    .await
    .unwrap();
    // Await JoinResponseOk for both with timeouts
    let ok1 = timeout(Duration::from_millis(1000), async {
        loop {
            if let Some(proto::ProtocolMessage::JoinResponseOk { crdt, .. }) =
                c1.next().await.unwrap()
            {
                if matches!(crdt, CrdtType::Elo) {
                    break true;
                }
            }
        }
    })
    .await
    .unwrap_or(false);
    let ok2 = timeout(Duration::from_millis(1000), async {
        loop {
            if let Some(proto::ProtocolMessage::JoinResponseOk { crdt, .. }) =
                c2.next().await.unwrap()
            {
                if matches!(crdt, CrdtType::Elo) {
                    break true;
                }
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        ok1 && ok2,
        "both clients must receive JoinResponseOk for %ELO"
    );

    // Build an example ELO container payload (opaque to server)
    // Use the normative vector header+ct as the single record inside container
    let aad = hex_to_bytes("0x0004010203040103026b310c86bcad09d5e7e3d70503a57e");
    let ct = hex_to_bytes("0x6930a8fbe96cc5f30b67f4bc7f53262e01b62852");
    // record = header || varBytes(ct)
    let mut w = loro_protocol::BytesWriter::new();
    w.push_bytes(&aad);
    w.push_var_bytes(&ct);
    let record = w.finalize();
    // container = varUint(1) || varBytes(record)
    let mut w = loro_protocol::BytesWriter::new();
    w.push_uleb128(1);
    w.push_var_bytes(&record);
    let container = w.finalize();

    // Fragment it into 2 pieces
    let mid = container.len() / 2;
    let frag0 = container[..mid].to_vec();
    let frag1 = container[mid..].to_vec();

    let batch_id = proto::BatchId([0, 1, 2, 3, 4, 5, 6, 7]);
    // Send header then fragments from client 1
    let header = proto::ProtocolMessage::DocUpdateFragmentHeader {
        crdt: CrdtType::Elo,
        room_id: room_id.clone(),
        batch_id,
        fragment_count: 2,
        total_size_bytes: container.len() as u64,
    };
    c1.send(&header).await.unwrap();
    let f0 = proto::ProtocolMessage::DocUpdateFragment {
        crdt: CrdtType::Elo,
        room_id: room_id.clone(),
        batch_id,
        index: 0,
        fragment: frag0.clone(),
    };
    c1.send(&f0).await.unwrap();
    let f1 = proto::ProtocolMessage::DocUpdateFragment {
        crdt: CrdtType::Elo,
        room_id: room_id.clone(),
        batch_id,
        index: 1,
        fragment: frag1.clone(),
    };
    c1.send(&f1).await.unwrap();

    // Client 2 should receive header and both fragments, unchanged
    let mut got_header = false;
    let mut got0 = None;
    let mut got1 = None;
    for _ in 0..10 {
        if let Some(msg) = timeout(Duration::from_millis(1000), c2.next())
            .await
            .unwrap()
            .unwrap()
        {
            match msg {
                proto::ProtocolMessage::DocUpdateFragmentHeader {
                    crdt,
                    room_id: rid,
                    batch_id: bid,
                    fragment_count,
                    total_size_bytes,
                } => {
                    if matches!(crdt, CrdtType::Elo) && rid == room_id && bid == batch_id {
                        assert_eq!(fragment_count, 2);
                        assert_eq!(total_size_bytes, container.len() as u64);
                        got_header = true;
                    }
                }
                proto::ProtocolMessage::DocUpdateFragment {
                    crdt,
                    room_id: rid,
                    batch_id: bid,
                    index,
                    fragment,
                } => {
                    if matches!(crdt, CrdtType::Elo) && rid == room_id && bid == batch_id {
                        if index == 0 {
                            got0 = Some(fragment.clone());
                        }
                        if index == 1 {
                            got1 = Some(fragment);
                        }
                    }
                }
                _ => {}
            }
        }
        if got_header && got0.is_some() && got1.is_some() {
            break;
        }
    }
    assert!(got_header, "did not receive fragment header");
    assert_eq!(got0, Some(frag0));
    assert_eq!(got1, Some(frag1));

    server_task.abort();
}
