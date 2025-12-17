use loro_websocket_client::Client;
use loro_websocket_server as server;
use loro_websocket_server::protocol::{self as proto, BatchId, CrdtType};
use loro_websocket_server::protocol::bytes::BytesWriter;
use std::sync::Arc;

#[tokio::test(flavor = "current_thread")]
async fn elo_accepts_join_and_broadcasts_updates() {
    // Start server on ephemeral port with simple handshake auth
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_task = tokio::spawn(async move {
        let cfg: server::ServerConfig<()> = server::ServerConfig {
            handshake_auth: Some(Arc::new(|args| args.token == Some("secret"))),
            ..Default::default()
        };
        server::serve_incoming_with_config(listener, cfg)
            .await
            .unwrap();
    });

    let url = format!("ws://{}/elo?token=secret", addr);
    let mut c1 = Client::connect(&url).await.unwrap();
    let mut c2 = Client::connect(&url).await.unwrap();

    let room_id = "room-elo".to_string();

    // Both clients join the same %ELO room
    let j1 = proto::ProtocolMessage::JoinRequest {
        crdt: CrdtType::Elo,
        room_id: room_id.clone(),
        auth: Vec::new(),
        version: Vec::new(),
    };
    c1.send(&j1).await.unwrap();
    let j2 = proto::ProtocolMessage::JoinRequest {
        crdt: CrdtType::Elo,
        room_id: room_id.clone(),
        auth: Vec::new(),
        version: Vec::new(),
    };
    c2.send(&j2).await.unwrap();

    // Expect JoinResponseOk for both
    let mut ok1 = false;
    let mut ok2 = false;
    for _ in 0..4 {
        if let Some(msg) = c1.next().await.unwrap() {
            if matches!(
                msg,
                proto::ProtocolMessage::JoinResponseOk {
                    crdt: CrdtType::Elo,
                    ..
                }
            ) {
                ok1 = true;
                break;
            }
        }
    }
    for _ in 0..4 {
        if let Some(msg) = c2.next().await.unwrap() {
            if matches!(
                msg,
                proto::ProtocolMessage::JoinResponseOk {
                    crdt: CrdtType::Elo,
                    ..
                }
            ) {
                ok2 = true;
                break;
            }
        }
    }
    assert!(
        ok1 && ok2,
        "both clients should receive JoinResponseOk for %ELO"
    );

    // Client 1 sends a minimal valid %ELO container (1 delta record)
    let opaque_update: Vec<u8> = build_minimal_elo_container();
    let du = proto::ProtocolMessage::DocUpdate {
        crdt: CrdtType::Elo,
        room_id: room_id.clone(),
        updates: vec![opaque_update.clone()],
        batch_id: BatchId([3, 3, 3, 3, 3, 3, 3, 3]),
    };
    c1.send(&du).await.unwrap();

    // Client 2 should receive the same DocUpdate (broadcasted unchanged)
    let mut got = None;
    for _ in 0..5 {
        if let Some(proto::ProtocolMessage::DocUpdate {
            crdt,
            room_id: rid,
            updates,
            batch_id: _,
        }) = c2.next().await.unwrap()
        {
            if matches!(crdt, CrdtType::Elo) && rid == room_id && updates.len() == 1 {
                got = Some(updates[0].clone());
                break;
            }
        }
    }
    assert_eq!(
        got,
        Some(opaque_update),
        "%ELO update should be forwarded unchanged"
    );

    server_task.abort();
}

fn build_minimal_elo_container() -> Vec<u8> {
    // Record: kind=DeltaSpan, peerId=[1], start=1, end=2, keyId="k1", iv=12 zero bytes, ct=[0]
    let mut rec = BytesWriter::new();
    rec.push_byte(0x00);
    rec.push_var_bytes(&[1]);
    rec.push_uleb128(1);
    rec.push_uleb128(2);
    rec.push_var_string("k1");
    rec.push_var_bytes(&[0u8; 12]);
    rec.push_var_bytes(&[0]);
    let rec_bytes = rec.finalize();

    // Container with 1 record
    let mut container = BytesWriter::new();
    container.push_uleb128(1);
    container.push_var_bytes(&rec_bytes);
    container.finalize()
}
