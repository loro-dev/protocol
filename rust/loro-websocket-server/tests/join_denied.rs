use loro_websocket_client::LoroWebsocketClient;
use loro_websocket_server as server;
use loro_websocket_server::protocol::Permission;
use std::sync::Arc;

#[tokio::test(flavor = "current_thread")]
async fn join_denied_returns_error() {
    // Bind ephemeral port
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    // Server with auth that always denies
    let cfg: server::ServerConfig<()> = server::ServerConfig {
        authenticate: Some(Arc::new(|_room, _crdt, _auth| Box::pin(async { Ok(None) }))),
        default_permission: Permission::Write,
        handshake_auth: Some(Arc::new(|_ws, token| token == Some("secret"))),
        ..Default::default()
    };
    let server_task = tokio::spawn(async move {
        server::serve_incoming_with_config(listener, cfg)
            .await
            .unwrap();
    });

    let url = format!("ws://{}/ws1?token=secret", addr);
    let client = LoroWebsocketClient::connect(&url).await.unwrap();
    let doc = Arc::new(tokio::sync::Mutex::new(loro::LoroDoc::new()));
    let res = client.join_loro("room-auth", doc.clone()).await;
    assert!(res.is_err(), "expected join to be denied");

    server_task.abort();
}
