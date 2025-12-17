use loro_websocket_server as server;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

#[tokio::test(flavor = "current_thread")]
async fn handshake_auth_can_read_cookies() {
    // Start server requiring cookie "session=valid"
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_task = tokio::spawn(async move {
        let cfg: server::ServerConfig<()> = server::ServerConfig {
            handshake_auth: Some(Arc::new(|args| {
                if let Some(header) = args.request.headers().get("Cookie") {
                    if let Ok(s) = header.to_str() {
                        for cookie in cookie::Cookie::split_parse(s) {
                            if let Ok(c) = cookie {
                                if c.name() == "session" && c.value() == "valid" {
                                    return true;
                                }
                            }
                        }
                    }
                }
                false
            })),
            ..Default::default()
        };
        server::serve_incoming_with_config(listener, cfg)
            .await
            .unwrap();
    });

    let url = format!("ws://{}/ws1", addr);

    // 1. Test valid cookie
    {
        let mut req = url.clone().into_client_request().unwrap();
        req.headers_mut().insert(
            "Cookie",
            HeaderValue::from_static("session=valid; other=stuff"),
        );
        match tokio_tungstenite::connect_async(req).await {
            Ok(_) => {} // success
            Err(e) => panic!("valid cookie should be accepted: {}", e),
        }
    }

    // 2. Test missing cookie
    {
        let req = url.clone().into_client_request().unwrap();
        // no cookie header
        match tokio_tungstenite::connect_async(req).await {
            Ok(_) => panic!("missing cookie should be rejected"),
            Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
                assert_eq!(resp.status(), 401);
            }
            Err(e) => panic!("unexpected error for missing cookie: {}", e),
        }
    }

    // 3. Test invalid cookie value
    {
        let mut req = url.clone().into_client_request().unwrap();
        req.headers_mut()
            .insert("Cookie", HeaderValue::from_static("session=invalid"));
        match tokio_tungstenite::connect_async(req).await {
            Ok(_) => panic!("invalid cookie should be rejected"),
            Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
                assert_eq!(resp.status(), 401);
            }
            Err(e) => panic!("unexpected error for invalid cookie: {}", e),
        }
    }

    server_task.abort();
}
