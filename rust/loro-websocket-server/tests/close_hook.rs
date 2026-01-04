use loro_websocket_client::Client;
use loro_websocket_server as server;
use server::protocol::{CrdtType, ProtocolMessage};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

type Cfg = server::ServerConfig<()>;

#[derive(Clone, Debug)]
struct CloseRecord {
    workspace: String,
    conn_id: u64,
    rooms: Vec<(CrdtType, String)>,
}

#[tokio::test(flavor = "current_thread")]
async fn on_close_connection_receives_workspace_and_rooms() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind tcp listener");
    let addr = listener.local_addr().expect("local addr");

    let close_calls: Arc<Mutex<Vec<CloseRecord>>> = Arc::new(Mutex::new(Vec::new()));
    let notify = Arc::new(Notify::new());

    let close_calls_cfg = close_calls.clone();
    let notify_cfg = notify.clone();

    let server_task = tokio::spawn(async move {
        let cfg: Cfg = server::ServerConfig {
            handshake_auth: Some(Arc::new(|args| args.token == Some("secret"))),
            on_close_connection: Some(Arc::new(move |args: server::CloseConnectionArgs| {
                let close_calls = close_calls_cfg.clone();
                let notify = notify_cfg.clone();
                Box::pin(async move {
                    let server::CloseConnectionArgs {
                        workspace,
                        conn_id,
                        rooms,
                    } = args;
                    close_calls.lock().await.push(CloseRecord {
                        workspace,
                        conn_id,
                        rooms,
                    });
                    notify.notify_waiters();
                    Ok(())
                })
            })),
            ..Default::default()
        };
        server::serve_incoming_with_config(listener, cfg)
            .await
            .expect("serve incoming");
    });

    let url = format!("ws://{}/ws-close?token=secret", addr);
    let mut client = Client::connect(&url).await.expect("connect client");
    let room_id = "close-room";
    let join = ProtocolMessage::JoinRequest {
        crdt: CrdtType::Loro,
        room_id: room_id.to_string(),
        auth: Vec::new(),
        version: Vec::new(),
    };
    client.send(&join).await.expect("send join");
    match client.next().await.expect("join response") {
        Some(ProtocolMessage::JoinResponseOk { .. }) => {}
        other => panic!("unexpected response: {:?}", other),
    }

    let notified = notify.notified();
    client.close().await.expect("close client");

    tokio::time::timeout(std::time::Duration::from_secs(2), notified)
        .await
        .expect("close hook not called in time");

    let calls = close_calls.lock().await;
    assert_eq!(calls.len(), 1, "expected exactly one close hook call");
    let record = &calls[0];
    assert_eq!(record.workspace, "ws-close");
    assert!(record.conn_id > 0);
    assert_eq!(record.rooms.len(), 1);
    let (crdt, room) = &record.rooms[0];
    assert_eq!(*crdt, CrdtType::Loro);
    assert_eq!(room, room_id);

    server_task.abort();
}
