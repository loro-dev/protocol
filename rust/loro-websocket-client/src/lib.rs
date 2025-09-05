//! Loro WebSocket Client
//!
//! Two layers are exposed:
//! - Low-level `Client` to send/receive raw `loro_protocol::ProtocolMessage`.
//! - High-level `LoroWebsocketClient` that joins rooms and applies incoming updates
//!   to a provided `loro::LoroDoc`. This mirrors the JS client's responsibilities.
//!
//! Low-level example (not run here):
//! ```no_run
//! use loro_websocket_client::Client;
//! use loro_protocol::{ProtocolMessage, CrdtType};
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! #   let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
//! #   rt.block_on(async move {
//! let mut client = Client::connect("ws://127.0.0.1:9000").await?;
//! client.send(&ProtocolMessage::Leave { crdt: CrdtType::Loro, room_id: vec![1,2,3] }).await?;
//! if let Some(msg) = client.next().await? {
//!     println!("got: {:?}", msg);
//! }
//! #   Ok(())
//! # })
//! # }
//! ```
//!
//! High-level example (not run here):
//! ```no_run
//! use std::sync::Arc;
//! use loro::{LoroDoc};
//! use loro_websocket_client::LoroWebsocketClient;
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! #   let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
//! #   rt.block_on(async move {
//! let client = LoroWebsocketClient::connect("ws://127.0.0.1:9000").await?;
//! let doc = Arc::new(tokio::sync::Mutex::new(LoroDoc::new()));
//! let _room = client.join_loro("room1", doc.clone()).await?;
//! // mutate doc then commit; client auto-sends local updates to the room
//! { let mut d = doc.lock().await; d.get_text("text").insert(0, "hello").unwrap(); d.commit(); }
//! #   Ok(())
//! # })
//! # }
//! ```

use futures_util::{SinkExt, StreamExt};
use std::{collections::HashMap, hash::{Hash, Hasher}, sync::Arc};
use tokio::{net::TcpStream, sync::{mpsc, oneshot, Mutex}};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

pub use loro_protocol as protocol;
use protocol::{encode, try_decode, ProtocolMessage, CrdtType};
use loro::LoroDoc;

/// Errors that may occur in the client.
#[derive(Debug)]
pub enum ClientError {
    /// WebSocket handshake returned 401 Unauthorized.
    Unauthorized,
    /// Underlying WebSocket error.
    Ws(Box<tokio_tungstenite::tungstenite::Error>),
    /// Protocol encoding/decoding error.
    Protocol(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Unauthorized => write!(f, "unauthorized"),
            ClientError::Ws(e) => write!(f, "websocket error: {}", e),
            ClientError::Protocol(e) => write!(f, "protocol error: {}", e),
        }
    }
}
impl std::error::Error for ClientError {}
impl From<tokio_tungstenite::tungstenite::Error> for ClientError {
    fn from(e: tokio_tungstenite::tungstenite::Error) -> Self { ClientError::Ws(Box::new(e)) }
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// A minimal client wrapping a WebSocket stream.
pub struct Client {
    ws: Ws,
}

impl Client {
    /// Connect to a ws/wss URL.
    pub async fn connect(url: &str) -> Result<Self, ClientError> {
        match connect_async(url).await {
            Ok((ws, _resp)) => Ok(Self { ws }),
            Err(e) => {
                // Try to classify Unauthorized (401) specially
                if let tokio_tungstenite::tungstenite::Error::Http(resp) = &e {
                    if resp.status() == tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED {
                        return Err(ClientError::Unauthorized);
                    }
                }
                let s = e.to_string().to_lowercase();
                if s.contains("401") || s.contains("unauthorized") {
                    return Err(ClientError::Unauthorized);
                }
                Err(ClientError::Ws(Box::new(e)))
            }
        }
    }

    /// Send a protocol message as a binary frame.
    pub async fn send(&mut self, msg: &ProtocolMessage) -> Result<(), ClientError> {
        let data = encode(msg).map_err(ClientError::Protocol)?;
        self.ws.send(Message::Binary(data.into())).await?;
        Ok(())
    }

    /// Send a keepalive ping (text frame "ping" per protocol.md).
    pub async fn ping(&mut self) -> Result<(), ClientError> {
        self.ws.send(Message::Text("ping".into())).await?;
        Ok(())
    }

    /// Receive the next protocol message.
    /// - Ignores non-binary frames.
    /// - Replies to text "ping" with text "pong".
    /// - Returns Ok(None) on clean close.
    pub async fn next(&mut self) -> Result<Option<ProtocolMessage>, ClientError> {
        loop {
            match self.ws.next().await {
                Some(Ok(Message::Binary(data))) => {
                    if let Some(msg) = try_decode(data.as_ref()) { return Ok(Some(msg)); }
                    // Unknown/invalid payload -> skip.
                }
                Some(Ok(Message::Text(txt))) => {
                    if txt == "ping" { self.ws.send(Message::Text("pong".into())).await?; }
                    // Keepalive frames are connection-scoped; not forwarded to app.
                }
                Some(Ok(Message::Ping(_))) => {
                    // Let tungstenite handle pongs automatically, or reply with pong text for parity
                    // with protocol keepalive behavior.
                    self.ws.send(Message::Text("pong".into())).await?;
                }
                Some(Ok(Message::Close(_))) => return Ok(None),
                Some(Ok(_)) => { /* ignore other control frames */ }
                Some(Err(e)) => return Err(ClientError::Ws(Box::new(e))),
                None => return Ok(None),
            }
        }
    }

    /// Close the connection gracefully.
    pub async fn close(mut self) -> Result<(), ClientError> {
        self.ws.close(None).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn client_error_display() {
        let e = ClientError::Protocol("bad".into());
        assert!(format!("{}", e).contains("protocol error"));
    }
}

// High-level client integrated with LoroDoc

#[derive(Clone, Debug, PartialEq, Eq)]
struct RoomKey { crdt: CrdtType, room: Vec<u8> }
impl Hash for RoomKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        let tag = match self.crdt {
            CrdtType::Loro => 0u8,
            CrdtType::LoroEphemeralStore => 1,
            CrdtType::Yjs => 2,
            CrdtType::YjsAwareness => 3,
            CrdtType::Elo => 4,
        };
        tag.hash(state);
        self.room.hash(state);
    }
}

struct RoomState {
    doc: Arc<Mutex<LoroDoc>>,
    sub: Option<loro::Subscription>,
}

type PendingMap = HashMap<RoomKey, oneshot::Sender<Result<protocol::Permission, String>>>;

/// A higher-level WebSocket client that manages rooms and applies updates to a LoroDoc.
#[derive(Clone)]
pub struct LoroWebsocketClient {
    tx: mpsc::UnboundedSender<Message>,
    rooms: Arc<Mutex<HashMap<RoomKey, RoomState>>>,
    // Join handshake results per room
    pending: Arc<Mutex<PendingMap>>,
}

impl LoroWebsocketClient {
    /// Connect and spawn reader/writer tasks.
    pub async fn connect(url: &str) -> Result<Self, ClientError> {
        let (ws, _resp) = match connect_async(url).await {
            Ok(ok) => ok,
            Err(e) => {
                if let tokio_tungstenite::tungstenite::Error::Http(resp) = &e {
                    if resp.status() == tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED {
                        return Err(ClientError::Unauthorized);
                    }
                }
                let s = e.to_string().to_lowercase();
                if s.contains("401") || s.contains("unauthorized") {
                    return Err(ClientError::Unauthorized);
                }
                return Err(ClientError::Ws(Box::new(e)));
            }
        };
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

        // Writer
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if sink.send(msg).await.is_err() { break; }
            }
        });

        let rooms: Arc<Mutex<HashMap<RoomKey, RoomState>>> = Arc::new(Mutex::new(HashMap::new()));
        let pending: Arc<Mutex<PendingMap>> = Arc::new(Mutex::new(HashMap::new()));
        let rooms_reader = rooms.clone();
        let pending_reader = pending.clone();
        let tx_reader = tx.clone();

        // Reader
        tokio::spawn(async move {
            while let Some(frame) = stream.next().await {
                match frame {
                    Ok(Message::Text(txt)) => {
                        if txt == "ping" { let _ = tx_reader.send(Message::Text("pong".into())); }
                        if txt == "pong" { /* ignore */ }
                    }
                    Ok(Message::Binary(data)) => {
                        if let Some(msg) = try_decode(data.as_ref()) {
                            let key = RoomKey { crdt: msg_crdt(&msg), room: msg_room_id(&msg) };
                            match msg {
                                ProtocolMessage::JoinResponseOk { permission, .. } => {
                                    if let Some(ch) = pending_reader.lock().await.remove(&key) {
                                        let _ = ch.send(Ok(permission));
                                    }
                                }
                                ProtocolMessage::JoinError { code, message, .. } => {
                                    if let Some(ch) = pending_reader.lock().await.remove(&key) {
                                        let _ = ch.send(Err(format!("join error: {:?} - {}", code, message)));
                                    }
                                    eprintln!("join error: {:?} - {}", code, message);
                                }
                                ProtocolMessage::DocUpdate { updates, .. } => {
                                    if let Some(state) = rooms_reader.lock().await.get(&key) {
                                        let doc = state.doc.lock().await;
                                        for u in updates { let _ = doc.import(&u); }
                                    }
                                }
                                ProtocolMessage::DocUpdateFragmentHeader { .. } => {
                                    // TODO: fragment reassembly (not implemented in minimal client)
                                }
                                ProtocolMessage::DocUpdateFragment { .. } => {
                                    // TODO: fragment reassembly (not implemented in minimal client)
                                }
                                ProtocolMessage::UpdateError { code, message, .. } => {
                                    eprintln!("update error: {:?} - {}", code, message);
                                }
                                ProtocolMessage::Leave { .. } => {}
                                ProtocolMessage::JoinRequest { .. } => {}
                            }
                        }
                    }
                    Ok(Message::Ping(p)) => {
                        let _ = tx_reader.send(Message::Pong(p));
                        let _ = tx_reader.send(Message::Text("pong".into()));
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(_) => {}
                    Err(e) => { eprintln!("ws read error: {}", e); break; }
                }
            }
        });

        Ok(Self { tx, rooms, pending })
    }

    /// Join a Loro room for the given document. Returns a handle for sending updates.
    pub async fn join_loro(&self, room_id: &str, doc: Arc<Mutex<LoroDoc>>) -> Result<LoroWebsocketClientRoom, ClientError> {
        let key = RoomKey { crdt: CrdtType::Loro, room: room_id.as_bytes().to_vec() };
        // Register room without subscription first
        self.rooms.lock().await.insert(key.clone(), RoomState { doc: doc.clone(), sub: None });

        let (tx_done, rx_done) = oneshot::channel::<Result<protocol::Permission, String>>();
        self.pending.lock().await.insert(key.clone(), tx_done);

        // Send join with empty version/auth for minimal implementation
        let msg = ProtocolMessage::JoinRequest { crdt: CrdtType::Loro, room_id: key.room.clone(), auth: Vec::new(), version: Vec::new() };
        let data = encode(&msg).map_err(ClientError::Protocol)?;
        self.tx.send(Message::Binary(data.into())).map_err(|_| ClientError::Protocol("send failed".into()))?;

        // Await join result
        match rx_done.await {
            Ok(Ok(permission)) => {
                // Only subscribe to local updates if we have write permission
                if matches!(permission, protocol::Permission::Write) {
                    let tx2 = self.tx.clone();
                    let key2 = key.clone();
                    let sub = {
                        let guard = doc.lock().await;
                        guard.subscribe_local_update(Box::new(move |bytes| {
                            let msg = ProtocolMessage::DocUpdate { crdt: key2.crdt, room_id: key2.room.clone(), updates: vec![bytes.clone()] };
                            if let Ok(data) = encode(&msg) {
                                let _ = tx2.send(Message::Binary(data.into()));
                            }
                            true
                        }))
                    };
                    // Store subscription for cleanup
                    self.rooms.lock().await.insert(key.clone(), RoomState { doc: doc.clone(), sub: Some(sub) });
                } else {
                    // Read-only: keep room without subscription
                    self.rooms.lock().await.insert(key.clone(), RoomState { doc: doc.clone(), sub: None });
                }
            }
            Ok(Err(e)) => {
                // Remove room entry and return error
                self.rooms.lock().await.remove(&key);
                return Err(ClientError::Protocol(e));
            }
            Err(_) => {
                self.rooms.lock().await.remove(&key);
                return Err(ClientError::Protocol("join canceled".into()));
            }
        }

        Ok(LoroWebsocketClientRoom { inner: self.clone(), key })
    }

    /// Send a keepalive ping.
    pub fn ping(&self) -> Result<(), ClientError> {
        self.tx.send(Message::Text("ping".into())).map_err(|_| ClientError::Protocol("send failed".into()))
    }
}

/// Room handle providing helpers to send updates from a bound `LoroDoc`.
#[derive(Clone)]
pub struct LoroWebsocketClientRoom {
    inner: LoroWebsocketClient,
    key: RoomKey,
}

impl LoroWebsocketClientRoom {
    /// Send a `Leave` message for this room.
    pub async fn leave(&self) -> Result<(), ClientError> {
        let msg = ProtocolMessage::Leave { crdt: self.key.crdt, room_id: self.key.room.clone() };
        let data = encode(&msg).map_err(ClientError::Protocol)?;
        self.inner.tx.send(Message::Binary(data.into())).map_err(|_| ClientError::Protocol("send failed".into()))?;
        // Unsubscribe and remove room state
        if let Some(state) = self.inner.rooms.lock().await.remove(&self.key) {
            if let Some(sub) = state.sub { sub.unsubscribe(); }
        }
        Ok(())
    }
}

fn msg_crdt(msg: &ProtocolMessage) -> CrdtType {
    match msg {
        ProtocolMessage::JoinRequest { crdt, .. }
        | ProtocolMessage::JoinResponseOk { crdt, .. }
        | ProtocolMessage::JoinError { crdt, .. }
        | ProtocolMessage::DocUpdate { crdt, .. }
        | ProtocolMessage::DocUpdateFragmentHeader { crdt, .. }
        | ProtocolMessage::DocUpdateFragment { crdt, .. }
        | ProtocolMessage::UpdateError { crdt, .. }
        | ProtocolMessage::Leave { crdt, .. } => *crdt,
    }
}

fn msg_room_id(msg: &ProtocolMessage) -> Vec<u8> {
    match msg {
        ProtocolMessage::JoinRequest { room_id, .. }
        | ProtocolMessage::JoinResponseOk { room_id, .. }
        | ProtocolMessage::JoinError { room_id, .. }
        | ProtocolMessage::DocUpdate { room_id, .. }
        | ProtocolMessage::DocUpdateFragmentHeader { room_id, .. }
        | ProtocolMessage::DocUpdateFragment { room_id, .. }
        | ProtocolMessage::UpdateError { room_id, .. }
        | ProtocolMessage::Leave { room_id, .. } => room_id.clone(),
    }
}
