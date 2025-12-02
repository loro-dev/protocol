use loro_websocket_client::Client;
use loro_websocket_server as server;
use loro_websocket_server::protocol::{self as proto, BatchId, CrdtType};
use std::sync::Arc;

#[tokio::test(flavor = "current_thread")]
async fn reject_update_without_join() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_task = tokio::spawn(async move {
        let cfg: server::ServerConfig<()> = server::ServerConfig {
            handshake_auth: Some(Arc::new(|_ws, token| token == Some("secret"))),
            ..Default::default()
        };
        server::serve_incoming_with_config(listener, cfg)
            .await
            .unwrap();
    });

    let url = format!("ws://{}/ws1?token=secret", addr);
    let mut c = Client::connect(&url).await.unwrap();

    // Send DocUpdateV2 without a prior JoinRequest
    let msg = proto::ProtocolMessage::DocUpdateV2 {
        crdt: CrdtType::Loro,
        room_id: "room-no-join".to_string(),
        batch_id: BatchId([9, 0, 0, 0, 0, 0, 0, 0]),
        updates: vec![vec![1, 2, 3]],
    };
    c.send(&msg).await.unwrap();

    // Expect UpdateErrorV2.PermissionDenied
    let mut got_err = false;
    for _ in 0..3 {
        match c.next().await.unwrap() {
            Some(proto::ProtocolMessage::UpdateErrorV2 { code, .. }) => {
                assert!(matches!(code, proto::UpdateErrorCode::PermissionDenied));
                got_err = true;
                break;
            }
            _ => {}
        }
    }
    assert!(got_err, "did not receive UpdateError.PermissionDenied");

    server_task.abort();
}
