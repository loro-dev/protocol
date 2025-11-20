use loro_websocket_server as server;
use loro_websocket_client::Client;
use loro_websocket_server::protocol::{self as proto, CrdtType};
use loro as loro_crdt;
use std::sync::Arc;

#[tokio::test(flavor = "current_thread")]
async fn join_sends_snapshot_from_loader() {
    // Prepare a stored snapshot
    let stored = loro_crdt::LoroDoc::new();
    let t = stored.get_text("text");
    t.insert(0, "from-storage").unwrap();
    let snapshot = stored.export(loro_crdt::ExportMode::Snapshot).unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cfg = server::ServerConfig {
        on_load_document: Some(Arc::new(move |_workspace, _room, _crdt| {
            let bytes = snapshot.clone();
            Box::pin(async move { Ok(Some(bytes)) })
        })),
        handshake_auth: Some(Arc::new(|_ws, token| token == Some("secret"))),
        ..Default::default()
    };
    let server_task = tokio::spawn(async move {
        server::serve_incoming_with_config(listener, cfg).await.unwrap();
    });

    let url = format!("ws://{}/ws1?token=secret", addr);
    let mut c = Client::connect(&url).await.unwrap();
    // Join
    let room = "room-load".to_string();
    let join = proto::ProtocolMessage::JoinRequest { crdt: CrdtType::Loro, room_id: room.clone(), auth: Vec::new(), version: Vec::new() };
    c.send(&join).await.unwrap();

    // Expect JoinResponseOk then DocUpdate carrying snapshot
    // Skip until we see a DocUpdate
    let mut got_snapshot = false;
    for _ in 0..3 {
        if let Some(proto::ProtocolMessage::DocUpdate { updates, .. }) = c.next().await.unwrap() {
            let doc = loro_crdt::LoroDoc::new();
            for u in updates { let _ = doc.import(&u); }
            assert_eq!(doc.get_text("text").to_string(), "from-storage");
            got_snapshot = true;
            break;
        }
    }
    assert!(got_snapshot, "did not receive snapshot after join");

    server_task.abort();
}
