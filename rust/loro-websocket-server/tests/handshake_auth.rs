use loro_websocket_client::{Client, ClientError};
use loro_websocket_server as server;
use std::sync::Arc;

#[tokio::test(flavor = "current_thread")]
async fn handshake_rejects_invalid_token_with_401() {
    // Start server requiring token == "secret"
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

    // Attempt connect with wrong token -> should fail at handshake with 401
    let url = format!("ws://{}/ws1?token=wrong", addr);
    match Client::connect(&url).await {
        Ok(_) => panic!("connection unexpectedly succeeded with invalid token"),
        Err(ClientError::Unauthorized) => {}
        Err(e) => panic!("unexpected error: {}", e),
    }

    server_task.abort();
}
