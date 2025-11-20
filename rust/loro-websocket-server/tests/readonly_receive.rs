use loro_websocket_server as server;
use loro_websocket_client::Client;
use loro_websocket_server::protocol::{self as proto, CrdtType, Permission};
use loro as loro_crdt;
use std::sync::Arc;

#[tokio::test(flavor = "current_thread")]
async fn readonly_receives_updates_writer_sends() {
    // Server auth: "writer" -> write, "reader" -> read, else deny
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cfg = server::ServerConfig {
        authenticate: Some(Arc::new(|_room, _crdt, auth| Box::pin(async move {
            if auth == b"writer" { Ok(Some(Permission::Write)) }
            else if auth == b"reader" { Ok(Some(Permission::Read)) }
            else { Ok(None) }
        }))),
        default_permission: Permission::Write,
        handshake_auth: Some(Arc::new(|_ws, token| token == Some("secret"))),
        ..Default::default()
    };
    let server_task = tokio::spawn(async move {
        server::serve_incoming_with_config(listener, cfg).await.unwrap();
    });

    let url = format!("ws://{}/ws1?token=secret", addr);
    let mut writer = Client::connect(&url).await.unwrap();
    let mut reader = Client::connect(&url).await.unwrap();

    let room = "room-ro".to_string();
    // Join writer with auth "writer"
    let join_w = proto::ProtocolMessage::JoinRequest { crdt: CrdtType::Loro, room_id: room.clone(), auth: b"writer".to_vec(), version: Vec::new() };
    writer.send(&join_w).await.unwrap();
    // Drain join ok + snapshot
    for _ in 0..2 { let _ = writer.next().await.unwrap(); }

    // Join reader with auth "reader"
    let join_r = proto::ProtocolMessage::JoinRequest { crdt: CrdtType::Loro, room_id: room.clone(), auth: b"reader".to_vec(), version: Vec::new() };
    reader.send(&join_r).await.unwrap();
    // Expect JoinResponseOk then snapshot DocUpdate
    let mut got_join_ok = false;
    for _ in 0..2 {
        match reader.next().await.unwrap() {
            Some(proto::ProtocolMessage::JoinResponseOk { .. }) => got_join_ok = true,
            Some(proto::ProtocolMessage::DocUpdate { .. }) => {},
            _ => {}
        }
    }
    assert!(got_join_ok);

    // Prepare a writer snapshot update
    let doc = loro_crdt::LoroDoc::new();
    let t = doc.get_text("text");
    t.insert(0, "hello").unwrap();
    let snap = doc.export(loro_crdt::ExportMode::Snapshot).unwrap();
    let upd = proto::ProtocolMessage::DocUpdate { crdt: CrdtType::Loro, room_id: room.clone(), updates: vec![snap] };
    writer.send(&upd).await.unwrap();

    // Reader should receive the DocUpdate broadcast
    let mut got_update = false;
    for _ in 0..3 {
        if let Some(proto::ProtocolMessage::DocUpdate { updates, .. }) = reader.next().await.unwrap() {
            // Apply to a local doc and assert content
            let doc2 = loro_crdt::LoroDoc::new();
            for u in updates { let _ = doc2.import(&u); }
            assert_eq!(doc2.get_text("text").to_string(), "hello");
            got_update = true;
            break;
        }
    }
    assert!(got_update, "reader did not receive update");

    // Reader attempts to send an update -> expect UpdateError.PermissionDenied
    let upd2 = proto::ProtocolMessage::DocUpdate { crdt: CrdtType::Loro, room_id: room.clone(), updates: vec![vec![1,2,3]] };
    reader.send(&upd2).await.unwrap();
    let mut got_err = false;
    for _ in 0..3 {
        if let Some(proto::ProtocolMessage::UpdateError { code, .. }) = reader.next().await.unwrap() {
            assert!(matches!(code, proto::UpdateErrorCode::PermissionDenied));
            got_err = true;
            break;
        }
    }
    assert!(got_err, "reader did not receive permission denied");

    server_task.abort();
}
