# loro-websocket-client (Rust)

Async WebSocket client for the Loro protocol. Exposes:
- Low-level `Client` to send/receive raw `loro_protocol::ProtocolMessage`.
- High-level `LoroWebsocketClient` that joins rooms and mirrors updates into a `loro::LoroDoc`, matching the TypeScript client behavior.

## Quick start

```rust
use std::sync::Arc;
use loro::{LoroDoc};
use loro_websocket_client::LoroWebsocketClient;

# #[tokio::main(flavor = "current_thread")]
# async fn main() -> Result<(), Box<dyn std::error::Error>> {
let client = LoroWebsocketClient::connect("ws://127.0.0.1:9000/ws1?token=secret").await?;
let doc = Arc::new(tokio::sync::Mutex::new(LoroDoc::new()));
let _room = client.join_loro("room1", doc.clone()).await?;
// mutate doc then commit; the client auto-sends updates
{ let mut d = doc.lock().await; d.get_text("text").insert(0, "hello")?; d.commit(); }
# Ok(()) }
```

## Features
- Handles protocol keepalive (`"ping"/"pong"`) and filters control frames.
- Automatic fragmentation/reassembly thresholds aligned with the server.
- %ELO adaptor helpers to encrypt/decrypt containers alongside Loro.

## Tests

```bash
cargo test -p loro-websocket-client
```
