use loro_websocket_client::Client;
use loro_websocket_server as server;
use server::protocol::{CrdtType, ProtocolMessage};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

type Cfg = server::ServerConfig<()>;

#[derive(Clone, Debug)]
struct UpdateRecord {
    workspace: String,
    room: String,
    crdt: CrdtType,
    conn_id: u64,
    updates_len: usize,
}

#[tokio::test(flavor = "current_thread")]
async fn on_update_hook_called() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind tcp listener");
    let addr = listener.local_addr().expect("local addr");

    let update_calls: Arc<Mutex<Vec<UpdateRecord>>> = Arc::new(Mutex::new(Vec::new()));
    let notify = Arc::new(Notify::new());

    let update_calls_cfg = update_calls.clone();
    let notify_cfg = notify.clone();

    let server_task = tokio::spawn(async move {
        let cfg: Cfg = server::ServerConfig {
            on_update: Some(Arc::new(move |args: server::UpdateArgs<()>| {
                let update_calls = update_calls_cfg.clone();
                let notify = notify_cfg.clone();
                Box::pin(async move {
                    let server::UpdateArgs {
                        workspace,
                        room,
                        crdt,
                        conn_id,
                        updates,
                        ctx: _,
                    } = args;
                    update_calls.lock().await.push(UpdateRecord {
                        workspace,
                        room,
                        crdt,
                        conn_id,
                        updates_len: updates.len(),
                    });
                    notify.notify_waiters();
                })
            })),
            // Use handshake auth to ensure workspace_id is captured
            handshake_auth: Some(Arc::new(|_| true)),
            ..Default::default()
        };
        server::serve_incoming_with_config(listener, cfg)
            .await
            .unwrap();
    });

    // Connect client
    let url = format!("ws://{}/my-workspace", addr);
    let mut client = Client::connect(&url).await.expect("connect");

    // Join room
    client
        .send(&ProtocolMessage::JoinRequest {
            crdt: CrdtType::Loro,
            room_id: "room1".to_string(),
            auth: vec![],
            version: vec![],
        })
        .await
        .expect("send join");

    // Wait for join response
    match client.next().await.expect("recv") {
        Some(ProtocolMessage::JoinResponseOk { .. }) => {}
        msg => panic!("unexpected msg: {:?}", msg),
    }

    // Send update
    let update_payload = vec![1, 2, 3, 4];
    client
        .send(&ProtocolMessage::DocUpdate {
            crdt: CrdtType::Loro,
            room_id: "room1".to_string(),
            updates: vec![update_payload.clone()],
            batch_id: server::protocol::BatchId([0; 8]), // dummy batch id
        })
        .await
        .expect("send update");

    // Wait for hook to be called
    notify.notified().await;

    let calls = update_calls.lock().await;
    assert_eq!(calls.len(), 1);
    let record = &calls[0];
    assert_eq!(record.workspace, "my-workspace");
    assert_eq!(record.room, "room1");
    assert_eq!(record.crdt, CrdtType::Loro);
    assert_eq!(record.updates_len, 1);
    // conn_id is dynamic, just check it's non-zero
    assert!(record.conn_id > 0);

    server_task.abort();
}
