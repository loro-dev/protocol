use loro as loro_crdt;
use loro_websocket_client::Client;
use loro_websocket_server as server;
use loro_websocket_server::protocol::{self as proto, CrdtType};
use std::sync::Arc;

#[tokio::test(flavor = "current_thread")]
async fn edit_loro_doc_notifies_subscribers() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind listener");
    let addr = listener.local_addr().expect("local addr");
    let cfg: server::ServerConfig<()> = server::ServerConfig {
        handshake_auth: Some(Arc::new(|_| true)),
        ..Default::default()
    };
    let registry: Arc<server::HubRegistry<()>> = Arc::new(server::HubRegistry::new(cfg));
    let server_registry = registry.clone();
    let server_task = tokio::spawn(async move {
        server::serve_incoming_with_registry(listener, server_registry)
            .await
            .expect("server exited");
    });

    let url = format!("ws://{}/workspace", addr);
    let mut client = Client::connect(&url).await.expect("client connect");
    let room = "edit-room".to_string();
    let join = proto::ProtocolMessage::JoinRequest {
        crdt: CrdtType::Loro,
        room_id: room.clone(),
        auth: Vec::new(),
        version: Vec::new(),
    };
    client.send(&join).await.expect("send join");

    // Drain the join response before editing.
    loop {
        match client.next().await.expect("next message") {
            Some(proto::ProtocolMessage::JoinResponseOk { .. }) => break,
            Some(_) => continue,
            None => panic!("connection closed while joining"),
        }
    }

    // Verify that the client is registered as a subscriber.
    let hub_arc = {
        let hubs_guard = registry.hubs().lock().await;
        hubs_guard
            .get("workspace")
            .cloned()
            .expect("workspace hub not found")
    };
    let subscriber_count = {
        let hub_guard = hub_arc.lock().await;
        let key = server::RoomKey {
            crdt: CrdtType::Loro,
            room: room.clone(),
        };
        hub_guard.subs.get(&key).map(|v| v.len()).unwrap_or(0)
    };
    assert_eq!(subscriber_count, 1, "expected the client to be subscribed");

    registry
        .edit_loro_doc("workspace", &room, |doc| {
            let text = doc.get_text("text");
            text.insert(0, "from-server").unwrap();
            doc.commit();
            Ok(())
        }, false) // force_close = false, room will stay open since it has a subscriber
        .await
        .expect("edit succeeded");

    let mut got_update = false;
    for _ in 0..4 {
        if let Some(proto::ProtocolMessage::DocUpdate { updates, .. }) =
            client.next().await.expect("next message after edit")
        {
            let doc = loro_crdt::LoroDoc::new();
            for data in updates {
                let _ = doc.import(&data);
            }
            if doc.get_text("text").to_string() == "from-server" {
                got_update = true;
                break;
            }
        }
    }
    assert!(got_update, "client did not receive server edit");

    drop(client);
    server_task.abort();
}
