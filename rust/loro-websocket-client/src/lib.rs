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
//! client.send(&ProtocolMessage::Leave { crdt: CrdtType::Loro, room_id: "room1".to_string() }).await?;
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
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::{
    net::TcpStream,
    sync::{mpsc, oneshot, Mutex},
};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

use aes_gcm::aead::{Aead, KeyInit};
use loro::LoroDoc;
pub use loro_protocol as protocol;
use protocol::{encode, try_decode, CrdtType, ProtocolMessage};

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
    fn from(e: tokio_tungstenite::tungstenite::Error) -> Self {
        ClientError::Ws(Box::new(e))
    }
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Configuration knobs for the high-level client.
#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// Timeout window for fragment reassembly before reporting FragmentTimeout.
    pub fragment_reassembly_timeout: std::time::Duration,
    /// Safety headroom subtracted from MAX_MESSAGE_SIZE when fragmenting.
    pub fragment_limit_headroom: usize,
    /// A soft per-fragment cap; final limit is min(soft_max, MAX-HEADROOM).
    pub fragment_limit_soft_max: usize,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            fragment_reassembly_timeout: std::time::Duration::from_secs(10),
            fragment_limit_headroom: 4096,
            fragment_limit_soft_max: 240 * 1024,
        }
    }
}

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
                    if resp.status()
                        == tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED
                    {
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
                    if let Some(msg) = try_decode(data.as_ref()) {
                        return Ok(Some(msg));
                    }
                    // Unknown/invalid payload -> skip.
                }
                Some(Ok(Message::Text(txt))) => {
                    if txt == "ping" {
                        self.ws.send(Message::Text("pong".into())).await?;
                    }
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

    #[derive(Default)]
    struct RecordingAdaptor {
        updates: Arc<Mutex<Vec<Vec<u8>>>>,
    }

    #[async_trait::async_trait]
    impl CrdtDocAdaptor for RecordingAdaptor {
        fn crdt_type(&self) -> CrdtType {
            CrdtType::Loro
        }

        async fn version(&self) -> Vec<u8> {
            Vec::new()
        }

        async fn set_ctx(&mut self, _ctx: CrdtAdaptorContext) {}

        async fn handle_join_ok(
            &mut self,
            _permission: protocol::Permission,
            _version: Vec<u8>,
        ) {
        }

        async fn apply_update(&mut self, updates: Vec<Vec<u8>>) {
            self.updates.lock().await.extend(updates);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn fragment_reassembly_delivers_updates_in_order() {
        let (tx, _rx) = mpsc::unbounded_channel::<Message>();
        let rooms = Arc::new(Mutex::new(HashMap::new()));
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let adaptors = Arc::new(Mutex::new(HashMap::new()));
        let pre_join_buf = Arc::new(Mutex::new(HashMap::new()));
        let frag_batches = Arc::new(Mutex::new(HashMap::new()));
        let config = Arc::new(ClientConfig::default());

        let worker = ConnectionWorker::new(
            tx,
            rooms,
            pending,
            adaptors.clone(),
            pre_join_buf,
            frag_batches,
            config,
        );

        let room_id = "room-frag".to_string();
        let key = RoomKey {
            crdt: CrdtType::Loro,
            room: room_id.clone(),
        };
        let collected = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        adaptors.lock().await.insert(
            key.clone(),
            Box::new(RecordingAdaptor {
                updates: collected.clone(),
            }),
        );

        let batch_id = protocol::BatchId([1, 2, 3, 4, 5, 6, 7, 8]);
        worker
            .handle_message(ProtocolMessage::DocUpdateFragmentHeader {
                crdt: CrdtType::Loro,
                room_id: room_id.clone(),
                batch_id,
                fragment_count: 2,
                total_size_bytes: 10,
            })
            .await;
        // Send fragments out of order to ensure slot ordering is respected
        worker
            .handle_message(ProtocolMessage::DocUpdateFragment {
                crdt: CrdtType::Loro,
                room_id: room_id.clone(),
                batch_id,
                index: 1,
                fragment: b"world".to_vec(),
            })
            .await;
        worker
            .handle_message(ProtocolMessage::DocUpdateFragment {
                crdt: CrdtType::Loro,
                room_id,
                batch_id,
                index: 0,
                fragment: b"hello".to_vec(),
            })
            .await;

        let updates = collected.lock().await;
        assert_eq!(updates.as_slice(), &[b"helloworld".to_vec()]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn elo_snapshot_container_roundtrips_plaintext() {
        let doc = Arc::new(Mutex::new(LoroDoc::new()));
        let key = [7u8; 32];
        let adaptor = EloDocAdaptor::new(doc, "kid", key)
            .with_iv_factory(Arc::new(|| [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
        let plaintext = b"hello-elo".to_vec();

        let container = adaptor.encode_elo_snapshot_container(&plaintext);
        let records =
            protocol::elo::decode_elo_container(&container).expect("container should decode");
        assert_eq!(records.len(), 1);
        let parsed =
            protocol::elo::parse_elo_record_header(records[0]).expect("header should parse");
        match parsed.header {
            protocol::elo::EloHeader::Snapshot(hdr) => {
                assert_eq!(hdr.key_id, "kid");
                assert_eq!(hdr.iv, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
                let cipher = aes_gcm::Aes256Gcm::new_from_slice(&key).unwrap();
                let decrypted = cipher
                    .decrypt(
                        aes_gcm::Nonce::from_slice(&hdr.iv),
                        aes_gcm::aead::Payload {
                            msg: parsed.ct,
                            aad: parsed.aad,
                        },
                    )
                    .unwrap();
                assert_eq!(decrypted, plaintext);
            }
            _ => panic!("expected snapshot header"),
        }
        assert!(matches!(
            parsed.kind,
            protocol::elo::EloRecordKind::Snapshot
        ));
    }
}

#[derive(Clone)]
struct ConnectionWorker {
    tx: mpsc::UnboundedSender<Message>,
    rooms: Arc<Mutex<HashMap<RoomKey, RoomState>>>,
    pending: Arc<Mutex<PendingMap>>,
    adaptors: Arc<Mutex<HashMap<RoomKey, Box<dyn CrdtDocAdaptor + Send + Sync>>>>,
    pre_join_buf: Arc<Mutex<HashMap<RoomKey, Vec<Vec<u8>>>>>,
    frag_batches: Arc<Mutex<HashMap<(RoomKey, protocol::BatchId), FragmentBatch>>>,
    config: Arc<ClientConfig>,
}

impl ConnectionWorker {
    fn new(
        tx: mpsc::UnboundedSender<Message>,
        rooms: Arc<Mutex<HashMap<RoomKey, RoomState>>>,
        pending: Arc<Mutex<PendingMap>>,
        adaptors: Arc<Mutex<HashMap<RoomKey, Box<dyn CrdtDocAdaptor + Send + Sync>>>>,
        pre_join_buf: Arc<Mutex<HashMap<RoomKey, Vec<Vec<u8>>>>>,
        frag_batches: Arc<Mutex<HashMap<(RoomKey, protocol::BatchId), FragmentBatch>>>,
        config: Arc<ClientConfig>,
    ) -> Self {
        Self {
            tx,
            rooms,
            pending,
            adaptors,
            pre_join_buf,
            frag_batches,
            config,
        }
    }

    fn spawn(self, mut stream: futures_util::stream::SplitStream<Ws>) {
        tokio::spawn(async move {
            while let Some(frame) = stream.next().await {
                match frame {
                    Ok(Message::Text(txt)) => {
                        self.handle_text(txt.to_string()).await;
                    }
                    Ok(Message::Binary(data)) => {
                        self.handle_binary(data.to_vec()).await;
                    }
                    Ok(Message::Ping(p)) => {
                        let _ = self.tx.send(Message::Pong(p));
                        let _ = self.tx.send(Message::Text("pong".into()));
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("ws read error: {}", e);
                        break;
                    }
                }
            }
        });
    }

    async fn handle_text(&self, txt: String) {
        if txt == "ping" {
            let _ = self.tx.send(Message::Text("pong".into()));
        }
        // Ignore "pong" and any other text frames
    }

    async fn handle_binary(&self, data: Vec<u8>) {
        if let Some(msg) = try_decode(data.as_ref()) {
            self.handle_message(msg).await;
        }
    }

    async fn handle_message(&self, msg: ProtocolMessage) {
        let key = RoomKey {
            crdt: msg_crdt(&msg),
            room: msg_room_id(&msg),
        };
        match msg {
            ProtocolMessage::JoinResponseOk {
                permission,
                version,
                ..
            } => {
                if let Some(ch) = self.pending.lock().await.remove(&key) {
                    let _ = ch.send(JoinOutcome::Ok {
                        permission,
                        version,
                    });
                }
            }
            ProtocolMessage::JoinError {
                code,
                message,
                receiver_version,
                ..
            } => {
                if let Some(ch) = self.pending.lock().await.remove(&key) {
                    let _ = ch.send(JoinOutcome::Err {
                        code,
                        message: message.clone(),
                        receiver_version,
                    });
                }
                eprintln!("join error: {:?} - {}", code, message);
            }
            ProtocolMessage::DocUpdateV2 {
                batch_id, updates, ..
            } => {
                if let Some(adaptor) = self.adaptors.lock().await.get_mut(&key) {
                    adaptor.apply_update(updates).await;
                } else if let Some(state) = self.rooms.lock().await.get(&key) {
                    let doc = state.doc.lock().await;
                    for u in updates {
                        let _ = doc.import(&u);
                    }
                } else {
                    let mut buf = self.pre_join_buf.lock().await;
                    buf.entry(key.clone()).or_default().extend(updates);
                }
                // Always acknowledge receipt
                let ack = ProtocolMessage::Ack {
                    crdt: key.crdt,
                    room_id: key.room.clone(),
                    batch_id,
                };
                if let Ok(data) = encode(&ack) {
                    let _ = self.tx.send(Message::Binary(data.into()));
                }
            }
            ProtocolMessage::DocUpdate { updates, .. } => {
                if let Some(adaptor) = self.adaptors.lock().await.get_mut(&key) {
                    adaptor.apply_update(updates).await;
                } else if let Some(state) = self.rooms.lock().await.get(&key) {
                    let doc = state.doc.lock().await;
                    for u in updates {
                        let _ = doc.import(&u);
                    }
                } else {
                    let mut buf = self.pre_join_buf.lock().await;
                    buf.entry(key).or_default().extend(updates);
                }
            }
            ProtocolMessage::DocUpdateFragmentHeader {
                batch_id,
                fragment_count,
                total_size_bytes,
                ..
            } => {
                // Insert batch state
                let mut map = self.frag_batches.lock().await;
                map.insert(
                    (key.clone(), batch_id),
                    FragmentBatch {
                        fragment_count: fragment_count as usize,
                        total_size_bytes: total_size_bytes as usize,
                        slots: vec![Vec::new(); fragment_count as usize],
                        received: 0,
                    },
                );
                drop(map);

                // Start a timeout; drop and report FragmentTimeout on expiry.
                let batches = self.frag_batches.clone();
                let key_clone = key.clone();
                let tx_timeout = self.tx.clone();
                let timeout = self.config.fragment_reassembly_timeout;
                tokio::spawn(async move {
                    use tokio::time::sleep;
                    sleep(timeout).await;
                    let mut m = batches.lock().await;
                    if m.remove(&(key_clone.clone(), batch_id)).is_some() {
                        let err = ProtocolMessage::UpdateErrorV2 {
                            crdt: key_clone.crdt,
                            room_id: key_clone.room.clone(),
                            batch_id,
                            code: protocol::UpdateErrorCode::FragmentTimeout,
                            message: format!(
                                "Fragment reassembly timeout for batch {}",
                                batch_id.to_hex()
                            ),
                            app_code: None,
                        };
                        if let Ok(data) = encode(&err) {
                            let _ = tx_timeout.send(Message::Binary(data.into()));
                        }
                    }
                });
            }
            ProtocolMessage::DocUpdateFragment {
                batch_id,
                index,
                fragment,
                ..
            } => {
                let mut map = self.frag_batches.lock().await;
                if let Some(batch) = map.get_mut(&(key.clone(), batch_id)) {
                    let i = index as usize;
                    if i < batch.slots.len() && batch.slots[i].is_empty() {
                        batch.slots[i] = fragment;
                        batch.received += 1;
                    }
                    if batch.received == batch.fragment_count {
                        let mut reassembled = Vec::with_capacity(batch.total_size_bytes);
                        for s in batch.slots.iter() {
                            reassembled.extend_from_slice(s);
                        }
                        map.remove(&(key.clone(), batch_id));
                        drop(map);
                        // Acknowledge completion
                        let ack = ProtocolMessage::Ack {
                            crdt: key.crdt,
                            room_id: key.room.clone(),
                            batch_id,
                        };
                        if let Ok(data) = encode(&ack) {
                            let _ = self.tx.send(Message::Binary(data.into()));
                        }
                        if let Some(adaptor) = self.adaptors.lock().await.get_mut(&key) {
                            adaptor.apply_update(vec![reassembled]).await;
                        } else if let Some(state) = self.rooms.lock().await.get(&key) {
                            let doc = state.doc.lock().await;
                            let _ = doc.import(&reassembled);
                        } else {
                            let mut buf = self.pre_join_buf.lock().await;
                            buf.entry(key).or_default().push(reassembled);
                        }
                    }
                } else {
                    eprintln!(
                        "Received fragment for unknown batch {:?} in room {:?}",
                        batch_id, key.room
                    );
                }
            }
            ProtocolMessage::UpdateErrorV2 { code, message, .. }
            | ProtocolMessage::UpdateError { code, message, .. } => {
                if let Some(adaptor) = self.adaptors.lock().await.get_mut(&key) {
                    adaptor.handle_update_error(code, &message).await;
                } else {
                    eprintln!("update error (no adaptor): {:?} - {}", code, message);
                }
            }
            ProtocolMessage::Ack { .. } => {}
            ProtocolMessage::Leave { .. } | ProtocolMessage::JoinRequest { .. } => {}
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RoomKey {
    crdt: CrdtType,
    room: String,
}
impl Hash for RoomKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        let tag = match self.crdt {
            CrdtType::Loro => 0u8,
            CrdtType::LoroEphemeralStore => 1,
            CrdtType::LoroEphemeralStorePersisted => 2,
            CrdtType::Yjs => 3,
            CrdtType::YjsAwareness => 4,
            CrdtType::Elo => 5,
        };
        tag.hash(state);
        self.room.hash(state);
    }
}

struct RoomState {
    doc: Arc<Mutex<LoroDoc>>,
    sub: Option<loro::Subscription>,
}

enum JoinOutcome {
    Ok {
        permission: protocol::Permission,
        version: Vec<u8>,
    },
    Err {
        code: protocol::JoinErrorCode,
        message: String,
        receiver_version: Option<Vec<u8>>,
    },
}

type PendingMap = HashMap<RoomKey, oneshot::Sender<JoinOutcome>>;

/// A higher-level WebSocket client that manages rooms and applies updates to a LoroDoc.
#[derive(Clone)]
pub struct LoroWebsocketClient {
    tx: mpsc::UnboundedSender<Message>,
    rooms: Arc<Mutex<HashMap<RoomKey, RoomState>>>,
    // Join handshake results per room
    pending: Arc<Mutex<PendingMap>>,
    // Generic adaptor storage keyed by room
    adaptors: Arc<Mutex<HashMap<RoomKey, Box<dyn CrdtDocAdaptor + Send + Sync>>>>,
    // Buffer updates received before room becomes active (mainly for %ELO)
    pre_join_buf: Arc<Mutex<HashMap<RoomKey, Vec<Vec<u8>>>>>,
    // For generating unique fragment batch ids
    next_batch_id: Arc<AtomicU64>,
    // Configurable knobs
    config: Arc<ClientConfig>,
}

impl LoroWebsocketClient {
    /// Connect and spawn reader/writer tasks with default config.
    pub async fn connect(url: &str) -> Result<Self, ClientError> {
        Self::connect_with_config(url, ClientConfig::default()).await
    }

    /// Connect and spawn reader/writer tasks with custom config.
    pub async fn connect_with_config(url: &str, config: ClientConfig) -> Result<Self, ClientError> {
        let (ws, _resp) = match connect_async(url).await {
            Ok(ok) => ok,
            Err(e) => {
                if let tokio_tungstenite::tungstenite::Error::Http(resp) = &e {
                    if resp.status()
                        == tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED
                    {
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
        let (mut sink, stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

        // Writer
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
        });

        let rooms: Arc<Mutex<HashMap<RoomKey, RoomState>>> = Arc::new(Mutex::new(HashMap::new()));
        let pending: Arc<Mutex<PendingMap>> = Arc::new(Mutex::new(HashMap::new()));
        let adaptors_reader: Arc<Mutex<HashMap<RoomKey, Box<dyn CrdtDocAdaptor + Send + Sync>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pre_join_buf_reader: Arc<Mutex<HashMap<RoomKey, Vec<Vec<u8>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let frag_batches_reader: Arc<Mutex<HashMap<(RoomKey, protocol::BatchId), FragmentBatch>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Reader
        let cfg = Arc::new(config);
        ConnectionWorker::new(
            tx.clone(),
            rooms.clone(),
            pending.clone(),
            adaptors_reader.clone(),
            pre_join_buf_reader.clone(),
            frag_batches_reader,
            cfg.clone(),
        )
        .spawn(stream);

        Ok(Self {
            tx,
            rooms,
            pending,
            adaptors: adaptors_reader,
            pre_join_buf: pre_join_buf_reader,
            next_batch_id: Arc::new(AtomicU64::new(1)),
            config: cfg,
        })
    }

    /// Join a Loro room for the given document. Returns a handle for sending updates.
    pub async fn join_loro(
        &self,
        room_id: &str,
        doc: Arc<Mutex<LoroDoc>>,
    ) -> Result<LoroWebsocketClientRoom, ClientError> {
        let key = RoomKey {
            crdt: CrdtType::Loro,
            room: room_id.to_string(),
        };
        // Register room without subscription first
        self.rooms.lock().await.insert(
            key.clone(),
            RoomState {
                doc: doc.clone(),
                sub: None,
            },
        );

        let (tx_done, rx_done) = oneshot::channel::<JoinOutcome>();
        self.pending.lock().await.insert(key.clone(), tx_done);

        // Send join with local version/auth
        let local_version = doc.lock().await.oplog_vv().encode();
        let msg = ProtocolMessage::JoinRequest {
            crdt: CrdtType::Loro,
            room_id: key.room.clone(),
            auth: Vec::new(),
            version: local_version,
        };
        let data = encode(&msg).map_err(ClientError::Protocol)?;
        self.tx
            .send(Message::Binary(data.into()))
            .map_err(|_| ClientError::Protocol("send failed".into()))?;

        // Await join result
        match rx_done.await {
            Ok(JoinOutcome::Ok { permission, .. }) => {
                // Only subscribe to local updates if we have write permission
                if matches!(permission, protocol::Permission::Write) {
                    let batch_counter = self.next_batch_id.clone();
                    let tx2 = self.tx.clone();
                    let key2 = key.clone();
                    let sub = {
                        let guard = doc.lock().await;
                        guard.subscribe_local_update(Box::new(move |bytes| {
                            let batch_id = protocol::BatchId(
                                batch_counter.fetch_add(1, Ordering::Relaxed).to_be_bytes(),
                            );
                            let msg = ProtocolMessage::DocUpdateV2 {
                                crdt: key2.crdt,
                                room_id: key2.room.clone(),
                                batch_id,
                                updates: vec![bytes.clone()],
                            };
                            if let Ok(data) = encode(&msg) {
                                let _ = tx2.send(Message::Binary(data.into()));
                            }
                            true
                        }))
                    };
                    // Store subscription for cleanup
                    self.rooms.lock().await.insert(
                        key.clone(),
                        RoomState {
                            doc: doc.clone(),
                            sub: Some(sub),
                        },
                    );
                } else {
                    // Read-only: keep room without subscription
                    self.rooms.lock().await.insert(
                        key.clone(),
                        RoomState {
                            doc: doc.clone(),
                            sub: None,
                        },
                    );
                }
            }
            Ok(JoinOutcome::Err { code, message, .. }) => {
                // Remove room entry and return error
                self.rooms.lock().await.remove(&key);
                return Err(ClientError::Protocol(format!(
                    "join error: {:?} - {}",
                    code, message
                )));
            }
            Err(_) => {
                self.rooms.lock().await.remove(&key);
                return Err(ClientError::Protocol("join canceled".into()));
            }
        }

        Ok(LoroWebsocketClientRoom {
            inner: self.clone(),
            key,
        })
    }

    /// Send a keepalive ping.
    pub fn ping(&self) -> Result<(), ClientError> {
        self.tx
            .send(Message::Text("ping".into()))
            .map_err(|_| ClientError::Protocol("send failed".into()))
    }

    /// Generic join with a CRDT adaptor. Returns a room handle.
    pub async fn join_with_adaptor(
        &self,
        room_id: &str,
        mut adaptor: Box<dyn CrdtDocAdaptor + Send + Sync>,
    ) -> Result<LoroWebsocketClientRoom, ClientError> {
        let key = RoomKey {
            crdt: adaptor.crdt_type(),
            room: room_id.to_string(),
        };

        // Register adaptor for this room, but not active until JoinResponseOk completes.
        // Construct adaptor context that sends updates (fragmenting if needed) and reports errors.
        let tx2 = self.tx.clone();
        let room_vec = key.room.clone();
        let crdt = key.crdt;
        let batch_counter = self.next_batch_id.clone();
        let cfg = self.config.clone();
        let send_update = move |upd: Vec<u8>| {
            // Leave headroom for envelope overhead using configured limits.
            let frag_limit = std::cmp::max(
                1usize,
                std::cmp::min(
                    cfg.fragment_limit_soft_max,
                    protocol::MAX_MESSAGE_SIZE.saturating_sub(cfg.fragment_limit_headroom),
                ),
            );

            if upd.len() <= frag_limit {
                let batch_id =
                    protocol::BatchId(batch_counter.fetch_add(1, Ordering::Relaxed).to_be_bytes());
                let msg = ProtocolMessage::DocUpdateV2 {
                    crdt,
                    room_id: room_vec.clone(),
                    batch_id,
                    updates: vec![upd],
                };
                if let Ok(data) = encode(&msg) {
                    let _ = tx2.send(Message::Binary(data.into()));
                }
            } else {
                let total = upd.len();
                let n = (total + frag_limit - 1) / frag_limit;
                let batch_id =
                    protocol::BatchId(batch_counter.fetch_add(1, Ordering::Relaxed).to_be_bytes());
                // header
                let header = ProtocolMessage::DocUpdateFragmentHeader {
                    crdt,
                    room_id: room_vec.clone(),
                    batch_id,
                    fragment_count: n as u64,
                    total_size_bytes: total as u64,
                };
                if let Ok(data) = encode(&header) {
                    let _ = tx2.send(Message::Binary(data.into()));
                }
                // fragments
                for i in 0..n {
                    let start = i * frag_limit;
                    let end = ((i + 1) * frag_limit).min(total);
                    let frag = upd[start..end].to_vec();
                    let msg = ProtocolMessage::DocUpdateFragment {
                        crdt,
                        room_id: room_vec.clone(),
                        batch_id,
                        index: i as u64,
                        fragment: frag,
                    };
                    if let Ok(data) = encode(&msg) {
                        let _ = tx2.send(Message::Binary(data.into()));
                    }
                }
            }
        };

        let tx_err = self.tx.clone();
        let room_vec2 = key.room.clone();
        let crdt2 = key.crdt;
        let on_join_failed = move |reason: String| {
            let msg = ProtocolMessage::JoinError {
                crdt: crdt2,
                room_id: room_vec2.clone(),
                code: protocol::JoinErrorCode::AppError,
                message: reason,
                receiver_version: None,
                app_code: None,
            };
            if let Ok(data) = encode(&msg) {
                let _ = tx_err.send(Message::Binary(data.into()));
            }
        };
        let tx_imp = self.tx.clone();
        let room_vec3 = key.room.clone();
        let crdt3 = key.crdt;
        let on_import_error = move |err: String, _data: Vec<Vec<u8>>| {
            let msg = ProtocolMessage::UpdateErrorV2 {
                crdt: crdt3,
                room_id: room_vec3.clone(),
                batch_id: protocol::BatchId([0; 8]),
                code: protocol::UpdateErrorCode::AppError,
                message: err,
                app_code: None,
            };
            if let Ok(data) = encode(&msg) {
                let _ = tx_imp.send(Message::Binary(data.into()));
            }
        };

        adaptor
            .set_ctx(CrdtAdaptorContext {
                send_update: Arc::new(send_update),
                on_join_failed: Arc::new(on_join_failed),
                on_import_error: Arc::new(on_import_error),
            })
            .await;

        // Track to allow reader to route messages even before activation
        self.adaptors.lock().await.insert(key.clone(), adaptor);

        // Join with version negotiation on VersionUnknown
        let mut current_version = if let Some(ad) = self.adaptors.lock().await.get(&key) {
            ad.version().await
        } else {
            Vec::new()
        };
        let mut tried_empty = false;
        loop {
            // Prepare pending and send JoinRequest
            let (tx_done, rx_done) = oneshot::channel::<JoinOutcome>();
            self.pending.lock().await.insert(key.clone(), tx_done);
            let msg = ProtocolMessage::JoinRequest {
                crdt: key.crdt,
                room_id: key.room.clone(),
                auth: Vec::new(),
                version: current_version.clone(),
            };
            let data = encode(&msg).map_err(ClientError::Protocol)?;
            self.tx
                .send(Message::Binary(data.into()))
                .map_err(|_| ClientError::Protocol("send failed".into()))?;

            match rx_done.await {
                Ok(JoinOutcome::Ok {
                    permission,
                    version: server_version,
                }) => {
                    if let Some(adaptor) = self.adaptors.lock().await.get_mut(&key) {
                        if let Some(buf) = self.pre_join_buf.lock().await.remove(&key) {
                            adaptor.apply_update(buf).await;
                        }
                        adaptor.handle_join_ok(permission, server_version).await;
                    }
                    break;
                }
                Ok(JoinOutcome::Err {
                    code,
                    message,
                    receiver_version: _rv,
                }) => {
                    // Allow adaptor-specific error handling
                    if let Some(adaptor) = self.adaptors.lock().await.get_mut(&key) {
                        adaptor.handle_join_err(code, &message).await;
                        if code == protocol::JoinErrorCode::VersionUnknown {
                            // Try alternative version, else fallback to empty once
                            if let Some(alt) =
                                adaptor.get_alternative_version(&current_version).await
                            {
                                current_version = alt;
                                continue;
                            } else if !tried_empty {
                                current_version = Vec::new();
                                tried_empty = true;
                                continue;
                            }
                        }
                    }
                    self.adaptors.lock().await.remove(&key);
                    return Err(ClientError::Protocol(format!(
                        "join error: {:?} - {}",
                        code, message
                    )));
                }
                Err(_) => {
                    self.adaptors.lock().await.remove(&key);
                    return Err(ClientError::Protocol("join canceled".into()));
                }
            }
        }

        Ok(LoroWebsocketClientRoom {
            inner: self.clone(),
            key,
        })
    }

    /// Convenience: join a Loro room using LoroDocAdaptor.
    pub async fn join_loro_with_adaptor(
        &self,
        room_id: &str,
        doc: Arc<Mutex<LoroDoc>>,
    ) -> Result<LoroWebsocketClientRoom, ClientError> {
        let adaptor: Box<dyn CrdtDocAdaptor + Send + Sync> = Box::new(LoroDocAdaptor::new(doc));
        self.join_with_adaptor(room_id, adaptor).await
    }

    /// Convenience: join an %ELO room using EloDocAdaptor (AES-256-GCM key).
    pub async fn join_elo_with_adaptor(
        &self,
        room_id: &str,
        doc: Arc<Mutex<LoroDoc>>,
        key_id: impl Into<String>,
        key: [u8; 32],
    ) -> Result<LoroWebsocketClientRoom, ClientError> {
        let adaptor: Box<dyn CrdtDocAdaptor + Send + Sync> =
            Box::new(EloDocAdaptor::new(doc, key_id, key));
        self.join_with_adaptor(room_id, adaptor).await
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
        let msg = ProtocolMessage::Leave {
            crdt: self.key.crdt,
            room_id: self.key.room.clone(),
        };
        let data = encode(&msg).map_err(ClientError::Protocol)?;
        self.inner
            .tx
            .send(Message::Binary(data.into()))
            .map_err(|_| ClientError::Protocol("send failed".into()))?;
        // Unsubscribe and remove room state
        if let Some(state) = self.inner.rooms.lock().await.remove(&self.key) {
            if let Some(sub) = state.sub {
                sub.unsubscribe();
            }
        }
        // Drop adaptor
        self.inner.adaptors.lock().await.remove(&self.key);
        Ok(())
    }
}

fn msg_crdt(msg: &ProtocolMessage) -> CrdtType {
    match msg {
        ProtocolMessage::JoinRequest { crdt, .. }
        | ProtocolMessage::JoinResponseOk { crdt, .. }
        | ProtocolMessage::JoinError { crdt, .. }
        | ProtocolMessage::DocUpdate { crdt, .. }
        | ProtocolMessage::DocUpdateV2 { crdt, .. }
        | ProtocolMessage::DocUpdateFragmentHeader { crdt, .. }
        | ProtocolMessage::DocUpdateFragment { crdt, .. }
        | ProtocolMessage::UpdateError { crdt, .. }
        | ProtocolMessage::UpdateErrorV2 { crdt, .. }
        | ProtocolMessage::Ack { crdt, .. }
        | ProtocolMessage::Leave { crdt, .. } => *crdt,
    }
}

fn msg_room_id(msg: &ProtocolMessage) -> String {
    match msg {
        ProtocolMessage::JoinRequest { room_id, .. }
        | ProtocolMessage::JoinResponseOk { room_id, .. }
        | ProtocolMessage::JoinError { room_id, .. }
        | ProtocolMessage::DocUpdate { room_id, .. }
        | ProtocolMessage::DocUpdateV2 { room_id, .. }
        | ProtocolMessage::DocUpdateFragmentHeader { room_id, .. }
        | ProtocolMessage::DocUpdateFragment { room_id, .. }
        | ProtocolMessage::UpdateError { room_id, .. }
        | ProtocolMessage::UpdateErrorV2 { room_id, .. }
        | ProtocolMessage::Ack { room_id, .. }
        | ProtocolMessage::Leave { room_id, .. } => room_id.clone(),
    }
}

// --- Fragment reassembly holder ---
struct FragmentBatch {
    fragment_count: usize,
    total_size_bytes: usize,
    slots: Vec<Vec<u8>>,
    received: usize,
}

// --- Generic CRDT adaptor trait and context ---
#[async_trait::async_trait]
pub trait CrdtDocAdaptor {
    fn crdt_type(&self) -> CrdtType;
    async fn version(&self) -> Vec<u8>;
    async fn set_ctx(&mut self, ctx: CrdtAdaptorContext);
    async fn handle_join_ok(&mut self, permission: protocol::Permission, version: Vec<u8>);
    async fn apply_update(&mut self, updates: Vec<Vec<u8>>);
    async fn handle_update_error(&mut self, _code: protocol::UpdateErrorCode, _message: &str) {}
    async fn handle_join_err(&mut self, _code: protocol::JoinErrorCode, _message: &str) {}
    async fn get_alternative_version(&mut self, _current: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

pub struct CrdtAdaptorContext {
    pub send_update: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
    pub on_join_failed: Arc<dyn Fn(String) + Send + Sync>,
    pub on_import_error: Arc<dyn Fn(String, Vec<Vec<u8>>) + Send + Sync>,
}

// --- LoroDocAdaptor: plaintext Loro ---
pub struct LoroDocAdaptor {
    doc: Arc<Mutex<LoroDoc>>,
    sub: Option<loro::Subscription>,
    ctx: Option<CrdtAdaptorContext>,
}

impl LoroDocAdaptor {
    pub fn new(doc: Arc<Mutex<LoroDoc>>) -> Self {
        Self {
            doc,
            sub: None,
            ctx: None,
        }
    }
}

#[async_trait::async_trait]
impl CrdtDocAdaptor for LoroDocAdaptor {
    fn crdt_type(&self) -> CrdtType {
        CrdtType::Loro
    }

    async fn version(&self) -> Vec<u8> {
        self.doc.lock().await.oplog_vv().encode()
    }

    async fn set_ctx(&mut self, ctx: CrdtAdaptorContext) {
        self.ctx = Some(CrdtAdaptorContext {
            send_update: ctx.send_update.clone(),
            on_join_failed: ctx.on_join_failed.clone(),
            on_import_error: ctx.on_import_error.clone(),
        });
        let doc = self.doc.clone();
        let send = ctx.send_update.clone();
        // Subscribe to local updates and forward
        let sub = {
            let guard = doc.lock().await;
            guard.subscribe_local_update(Box::new(move |bytes| {
                (send)(bytes.clone());
                true
            }))
        };
        self.sub = Some(sub);
    }

    async fn handle_join_ok(&mut self, _permission: protocol::Permission, version: Vec<u8>) {
        // Minimal behavior: if server provides no version, send a snapshot
        if version.is_empty() {
            if let Ok(pt) = self.doc.lock().await.export(loro::ExportMode::Snapshot) {
                if let Some(ctx) = &self.ctx {
                    (ctx.send_update)(pt);
                }
            }
        }
    }

    async fn apply_update(&mut self, updates: Vec<Vec<u8>>) {
        let guard = self.doc.lock().await;
        for u in updates {
            let _ = guard.import(&u);
        }
    }

    async fn handle_update_error(&mut self, _code: protocol::UpdateErrorCode, _message: &str) {}
}

impl Drop for LoroDocAdaptor {
    fn drop(&mut self) {
        if let Some(sub) = self.sub.take() {
            sub.unsubscribe();
        }
    }
}

// --- EloDocAdaptor: E2EE Loro (minimal snapshot-only packaging) ---
/// Experimental %ELO adaptor. Snapshot-only packaging is implemented today;
/// delta packaging and API stability are WIP and may change.
pub struct EloDocAdaptor {
    doc: Arc<Mutex<LoroDoc>>,
    ctx: Option<CrdtAdaptorContext>,
    key_id: String,
    key: [u8; 32],
    iv_factory: Option<Arc<dyn Fn() -> [u8; 12] + Send + Sync>>,
    sub: Option<loro::Subscription>,
}

impl EloDocAdaptor {
    pub fn new(doc: Arc<Mutex<LoroDoc>>, key_id: impl Into<String>, key: [u8; 32]) -> Self {
        Self {
            doc,
            ctx: None,
            key_id: key_id.into(),
            key,
            iv_factory: None,
            sub: None,
        }
    }

    pub fn with_iv_factory(mut self, f: Arc<dyn Fn() -> [u8; 12] + Send + Sync>) -> Self {
        self.iv_factory = Some(f);
        self
    }

    fn encode_elo_snapshot_container(&self, plaintext: &[u8]) -> Vec<u8> {
        use protocol::bytes::BytesWriter;
        // Build ELO Snapshot header with empty vv and IV
        let iv: [u8; 12] = self.iv_factory.as_ref().map(|f| (f)()).unwrap_or([0u8; 12]);
        let mut hdr = BytesWriter::new();
        hdr.push_byte(protocol::elo::EloRecordKind::Snapshot as u8);
        hdr.push_uleb128(0); // vv count = 0
        hdr.push_var_string(&self.key_id);
        hdr.push_var_bytes(&iv);
        let header_bytes = hdr.finalize();

        // Encrypt using AES-256-GCM with AAD=header_bytes and IV
        let cipher = aes_gcm::Aes256Gcm::new_from_slice(&self.key).expect("key");
        let nonce = aes_gcm::Nonce::from_slice(&iv);
        let ct = cipher
            .encrypt(
                nonce,
                aes_gcm::aead::Payload {
                    msg: plaintext,
                    aad: &header_bytes,
                },
            )
            .expect("encrypt elo snapshot");

        // Append ct as varBytes after header
        let mut rec = BytesWriter::new();
        rec.push_bytes(&header_bytes);
        rec.push_var_bytes(&ct);
        let record = rec.finalize();

        // Container (1 record)
        let mut cont = BytesWriter::new();
        cont.push_uleb128(1);
        cont.push_var_bytes(&record);
        cont.finalize()
    }
}

#[async_trait::async_trait]
impl CrdtDocAdaptor for EloDocAdaptor {
    fn crdt_type(&self) -> CrdtType {
        CrdtType::Elo
    }

    async fn version(&self) -> Vec<u8> {
        self.doc.lock().await.oplog_vv().encode()
    }

    async fn set_ctx(&mut self, ctx: CrdtAdaptorContext) {
        // Store context and subscribe to local updates immediately (TS parity)
        self.ctx = Some(CrdtAdaptorContext {
            send_update: ctx.send_update.clone(),
            on_join_failed: ctx.on_join_failed.clone(),
            on_import_error: ctx.on_import_error.clone(),
        });

        let doc = self.doc.clone();
        let send = ctx.send_update.clone();
        let key_id = self.key_id.clone();
        let key = self.key;
        let iv_factory = self.iv_factory.clone();
        // Subscribe to local updates and send encrypted containers for each emitted local blob.
        // Note: minimal snapshot-record packaging with empty VV.
        let sub = {
            let guard = doc.lock().await;
            guard.subscribe_local_update(Box::new(move |bytes| {
                use protocol::bytes::BytesWriter;
                let iv: [u8; 12] = iv_factory.as_ref().map(|f| (f)()).unwrap_or([0u8; 12]);
                let mut hdr = BytesWriter::new();
                hdr.push_byte(protocol::elo::EloRecordKind::Snapshot as u8);
                hdr.push_uleb128(0); // vv count = 0
                hdr.push_var_string(&key_id);
                hdr.push_var_bytes(&iv);
                let header_bytes = hdr.finalize();

                // Encrypt
                let cipher = aes_gcm::Aes256Gcm::new_from_slice(&key).expect("key");
                let nonce = aes_gcm::Nonce::from_slice(&iv);
                if let Ok(ct) = cipher.encrypt(
                    nonce,
                    aes_gcm::aead::Payload {
                        msg: &bytes,
                        aad: &header_bytes,
                    },
                ) {
                    let mut rec = BytesWriter::new();
                    rec.push_bytes(&header_bytes);
                    rec.push_var_bytes(&ct);
                    let record = rec.finalize();
                    let mut cont = BytesWriter::new();
                    cont.push_uleb128(1);
                    cont.push_var_bytes(&record);
                    let container = cont.finalize();
                    (send)(container);
                }
                true
            }))
        };
        self.sub = Some(sub);
    }

    async fn handle_join_ok(&mut self, _permission: protocol::Permission, _version: Vec<u8>) {
        // On join, send a full encrypted snapshot to establish baseline.
        // WIP: %ELO snapshot-only packaging; TODO: REVIEW [elo-packaging]
        // This minimal implementation uses snapshot-only packaging and empty VV.
        // It is correct but not optimal; consider delta packaging in a follow-up.
        if let Ok(snap) = self.doc.lock().await.export(loro::ExportMode::Snapshot) {
            let ct = self.encode_elo_snapshot_container(&snap);
            if let Some(ctx) = &self.ctx {
                (ctx.send_update)(ct);
            }
        }
        // Subscription is established in set_ctx() to match TS behavior.
    }

    async fn apply_update(&mut self, updates: Vec<Vec<u8>>) {
        for u in updates {
            if let Ok(records) = protocol::elo::decode_elo_container(&u) {
                for rec in records {
                    if let Ok(parsed) = protocol::elo::parse_elo_record_header(rec) {
                        let iv = match &parsed.header {
                            protocol::elo::EloHeader::Delta(h) => h.iv,
                            protocol::elo::EloHeader::Snapshot(h) => h.iv,
                        };
                        let aad = parsed.aad;
                        let cipher = aes_gcm::Aes256Gcm::new_from_slice(&self.key).expect("key");
                        if let Ok(pt) = cipher.decrypt(
                            aes_gcm::Nonce::from_slice(&iv),
                            aes_gcm::aead::Payload {
                                msg: parsed.ct,
                                aad,
                            },
                        ) {
                            let _ = self.doc.lock().await.import(&pt);
                        } else if let Some(ctx) = &self.ctx {
                            (ctx.on_import_error)("decrypt failed".to_string(), vec![u.clone()]);
                        }
                    }
                }
            }
        }
    }

    async fn handle_update_error(&mut self, _code: protocol::UpdateErrorCode, _message: &str) {}
}

impl Drop for EloDocAdaptor {
    fn drop(&mut self) {
        if let Some(sub) = self.sub.take() {
            sub.unsubscribe();
        }
    }
}

// Public adaptor re-exports for convenience
pub use CrdtDocAdaptor as DocAdaptor;
pub use EloDocAdaptor as EloAdaptor;
pub use LoroDocAdaptor as LoroAdaptor;
