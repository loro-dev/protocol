//! Loro WebSocket Server (simple skeleton)
//!
//! Minimal async WebSocket server that accepts connections and echoes binary
//! protocol frames back to clients. It also responds to text "ping" with
//! text "pong" as described in protocol.md keepalive section.
//!
//! This is intentionally simple and is meant as a starting point. Application
//! logic (authorization, room routing, broadcasting, etc.) should be layered
//! on top using the `loro_protocol` crate for message encoding/decoding.
//!
//! Example (not run here because it binds a socket):
//! ```no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
//! #   let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
//! #   rt.block_on(async move {
//! loro_websocket_server::serve("127.0.0.1:9000").await?;
//! #   Ok(())
//! # })
//! # }
//! ```

use futures_util::{SinkExt, StreamExt};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    hash::{Hash, Hasher},
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::mpsc,
};
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::{self, Message};

use loro::awareness::EphemeralStore;
use loro::{ExportMode, LoroDoc};
pub use loro_protocol as protocol;
use protocol::{
    try_decode, CrdtType, JoinErrorCode, Permission, ProtocolMessage, UpdateStatusCode,
};
use tracing::{debug, error, info, warn};

// Limits to protect server memory from abusive fragment headers
const MAX_FRAGMENTS: u64 = 4096; // hard cap on number of fragments per batch
const MAX_BATCH_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB per batch

#[derive(Clone, Debug, PartialEq, Eq)]
struct RoomKey {
    crdt: CrdtType,
    room: String,
}
impl Hash for RoomKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        // CrdtType is repr as enum with a few variants; map to u8 for hashing
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

type Sender = mpsc::UnboundedSender<Message>;

// Hook types
/// Snapshot payload returned by `on_load_document` alongside optional metadata
/// that will be passed through to `on_save_document`.
pub struct LoadedDoc<DocCtx> {
    pub snapshot: Option<Vec<u8>>,
    pub ctx: Option<DocCtx>,
}

/// Arguments provided to `on_load_document`.
pub struct LoadDocArgs {
    pub workspace: String,
    pub room: String,
    pub crdt: CrdtType,
}

/// Arguments provided to `on_save_document`.
pub struct SaveDocArgs<DocCtx> {
    pub workspace: String,
    pub room: String,
    pub crdt: CrdtType,
    pub data: Vec<u8>,
    pub ctx: Option<DocCtx>,
}

type LoadFuture<DocCtx> =
    Pin<Box<dyn Future<Output = Result<LoadedDoc<DocCtx>, String>> + Send + 'static>>;
type SaveFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'static>>;
type LoadFn<DocCtx> = Arc<dyn Fn(LoadDocArgs) -> LoadFuture<DocCtx> + Send + Sync>;
type SaveFn<DocCtx> = Arc<dyn Fn(SaveDocArgs<DocCtx>) -> SaveFuture + Send + Sync>;

/// Arguments provided to `authenticate`.
pub struct AuthArgs {
    pub room: String,
    pub crdt: CrdtType,
    pub auth: Vec<u8>,
    pub conn_id: u64,
}

type AuthFuture =
    Pin<Box<dyn Future<Output = Result<Option<Permission>, String>> + Send + 'static>>;
type AuthFn = Arc<dyn Fn(AuthArgs) -> AuthFuture + Send + Sync>;

/// Arguments provided to `handshake_auth`.
pub struct HandshakeAuthArgs<'a> {
    pub workspace: &'a str,
    pub token: Option<&'a str>,
    pub request: &'a tungstenite::handshake::server::Request,
    pub conn_id: u64,
}

type HandshakeAuthFn = dyn Fn(HandshakeAuthArgs) -> bool + Send + Sync;

#[derive(Clone)]
pub struct ServerConfig<DocCtx = ()> {
    pub on_load_document: Option<LoadFn<DocCtx>>,
    pub on_save_document: Option<SaveFn<DocCtx>>,
    pub save_interval_ms: Option<u64>,
    pub default_permission: Permission,
    pub authenticate: Option<AuthFn>,
    /// Optional handshake auth: called during WS HTTP upgrade.
    ///
    /// Parameters:
    /// - `workspace_id`: extracted from request path `/{workspace}` (empty if missing)
    /// - `token`: `token` query parameter if present
    /// - `request`: the full HTTP request (headers, uri, etc)
    /// - `conn_id`: the connection id
    ///
    /// Return true to accept, false to reject with 401.
    pub handshake_auth: Option<Arc<HandshakeAuthFn>>,
}

// CRDT document abstraction to reduce match-based branching
trait CrdtDoc: Send {
    fn get_version(&self) -> Vec<u8> {
        Vec::new()
    }
    fn compute_backfill(&self, _client_version: &[u8]) -> Vec<Vec<u8>> {
        Vec::new()
    }
    fn apply_updates(&mut self, _updates: &[Vec<u8>]) -> Result<(), String> {
        Ok(())
    }
    fn should_persist(&self) -> bool {
        false
    }
    fn export_snapshot(&self) -> Option<Vec<u8>> {
        None
    }
    fn import_snapshot(&mut self, _data: &[u8]) {}
    fn allow_backfill_when_no_other_clients(&self) -> bool {
        false
    }
    fn remove_when_last_subscriber_leaves(&self) -> bool {
        false
    }
}

struct LoroRoomDoc {
    doc: LoroDoc,
}
impl LoroRoomDoc {
    fn new() -> Self {
        Self {
            doc: LoroDoc::new(),
        }
    }
}
impl CrdtDoc for LoroRoomDoc {
    fn apply_updates(&mut self, updates: &[Vec<u8>]) -> Result<(), String> {
        for u in updates {
            let _ = self.doc.import(u);
        }
        Ok(())
    }
    fn should_persist(&self) -> bool {
        true
    }
    fn export_snapshot(&self) -> Option<Vec<u8>> {
        self.doc.export(ExportMode::Snapshot).ok()
    }
    fn import_snapshot(&mut self, data: &[u8]) {
        let _ = self.doc.import(data);
    }
}

struct EphemeralRoomDoc {
    store: EphemeralStore,
}
impl EphemeralRoomDoc {
    fn new(timeout_ms: i64) -> Self {
        Self {
            store: EphemeralStore::new(timeout_ms),
        }
    }
}
impl CrdtDoc for EphemeralRoomDoc {
    fn compute_backfill(&self, _client_version: &[u8]) -> Vec<Vec<u8>> {
        let data = self.store.encode_all();
        if data.is_empty() {
            Vec::new()
        } else {
            vec![data]
        }
    }
    fn apply_updates(&mut self, updates: &[Vec<u8>]) -> Result<(), String> {
        for u in updates {
            if !u.is_empty() {
                self.store.apply(u);
            }
        }
        Ok(())
    }
    fn remove_when_last_subscriber_leaves(&self) -> bool {
        true
    }
}

struct PersistentEphemeralRoomDoc {
    store: EphemeralStore,
    timeout_ms: i64,
}
impl PersistentEphemeralRoomDoc {
    fn new(timeout_ms: i64) -> Self {
        Self {
            store: EphemeralStore::new(timeout_ms),
            timeout_ms,
        }
    }
}
impl CrdtDoc for PersistentEphemeralRoomDoc {
    fn compute_backfill(&self, _client_version: &[u8]) -> Vec<Vec<u8>> {
        let data = self.store.encode_all();
        if data.is_empty() {
            Vec::new()
        } else {
            vec![data]
        }
    }
    fn apply_updates(&mut self, updates: &[Vec<u8>]) -> Result<(), String> {
        for u in updates {
            if !u.is_empty() {
                self.store.apply(u);
            }
        }
        Ok(())
    }
    fn should_persist(&self) -> bool {
        true
    }
    fn export_snapshot(&self) -> Option<Vec<u8>> {
        Some(self.store.encode_all())
    }
    fn import_snapshot(&mut self, data: &[u8]) {
        self.store = EphemeralStore::new(self.timeout_ms);
        if !data.is_empty() {
            self.store.apply(data);
        }
    }
    fn allow_backfill_when_no_other_clients(&self) -> bool {
        true
    }
}

// ELO header index entries
struct EloDeltaSpanIndexEntry {
    start: u64,
    end: u64,
    key_id: String,
    record: Vec<u8>,
}

struct EloRoomDoc {
    spans_by_peer: std::collections::HashMap<String, Vec<EloDeltaSpanIndexEntry>>,
}
impl EloRoomDoc {
    fn new() -> Self {
        Self {
            spans_by_peer: std::collections::HashMap::new(),
        }
    }

    fn peer_key_from_bytes(bytes: &[u8]) -> String {
        // Prefer UTF-8 if valid, else hex
        match std::str::from_utf8(bytes) {
            Ok(s) => s.to_string(),
            Err(_) => {
                let mut out = String::with_capacity(bytes.len() * 2);
                for b in bytes {
                    use std::fmt::Write as _;
                    let _ = write!(&mut out, "{:02x}", b);
                }
                out
            }
        }
    }

    fn decode_version_vector(&self, buf: &[u8]) -> Option<std::collections::HashMap<String, u64>> {
        use loro_protocol::bytes::BytesReader;
        let mut r = BytesReader::new(buf);
        let count = usize::try_from(r.read_uleb128().ok()?).ok()?;
        let mut map: std::collections::HashMap<String, u64> =
            std::collections::HashMap::with_capacity(count);
        for _ in 0..count {
            let peer_bytes = r.read_var_bytes().ok()?;
            let ctr = r.read_uleb128().ok()?;
            map.insert(Self::peer_key_from_bytes(peer_bytes), ctr);
        }
        Some(map)
    }

    fn encode_current_vv(&self) -> Vec<u8> {
        use loro_protocol::bytes::BytesWriter;
        let mut entries: Vec<(String, u64)> = Vec::new();
        for (peer, spans) in self.spans_by_peer.iter() {
            if !peer.as_bytes().iter().all(|b| b.is_ascii_digit()) {
                continue;
            }
            let mut max_end = 0u64;
            for s in spans.iter() {
                if s.end > max_end {
                    max_end = s.end;
                }
            }
            if max_end > 0 {
                entries.push((peer.clone(), max_end));
            }
        }
        let mut w = BytesWriter::new();
        w.push_uleb128(entries.len() as u64);
        for (peer, ctr) in entries.iter() {
            w.push_var_bytes(peer.as_bytes());
            w.push_uleb128(*ctr);
        }
        w.finalize()
    }
}
impl CrdtDoc for EloRoomDoc {
    fn get_version(&self) -> Vec<u8> {
        // If we have no indexed entries yet, return an empty version to signal
        // "unknown/empty" baseline so clients may choose to send a snapshot.
        if self.spans_by_peer.is_empty() {
            return Vec::new();
        }
        self.encode_current_vv()
    }
    fn compute_backfill(&self, client_version: &[u8]) -> Vec<Vec<u8>> {
        let known = self
            .decode_version_vector(client_version)
            .unwrap_or_default();
        let mut records: Vec<Vec<u8>> = Vec::new();
        for (peer, spans) in self.spans_by_peer.iter() {
            let k = known.get(peer).copied().unwrap_or(0);
            for e in spans {
                if e.end > k {
                    records.push(e.record.clone());
                }
            }
        }
        if records.is_empty() {
            return Vec::new();
        }
        let mut w = loro_protocol::bytes::BytesWriter::new();
        w.push_uleb128(records.len() as u64);
        for rec in records.iter() {
            w.push_var_bytes(rec);
        }
        vec![w.finalize()]
    }
    fn apply_updates(&mut self, updates: &[Vec<u8>]) -> Result<(), String> {
        use loro_protocol::elo::{
            decode_elo_container, parse_elo_record_header, EloHeader, EloRecordKind,
        };
        for u in updates {
            let records = decode_elo_container(u.as_slice())?;
            for rec in records {
                let parsed = parse_elo_record_header(rec)?;
                match parsed.kind {
                    EloRecordKind::DeltaSpan => {
                        if let EloHeader::Delta(h) = parsed.header {
                            if !(h.end > h.start) {
                                return Err("invalid ELO delta span: end must be > start".into());
                            }
                            if h.iv.len() != 12 {
                                return Err("invalid ELO delta span: IV must be 12 bytes".into());
                            }
                            let peer = Self::peer_key_from_bytes(&h.peer_id);
                            let list = self.spans_by_peer.entry(peer).or_default();
                            // Insert keeping order by start; remove fully covered entries [start, end]
                            let mut kept: Vec<EloDeltaSpanIndexEntry> =
                                Vec::with_capacity(list.len() + 1);
                            let mut inserted = false;
                            for e in list.iter() {
                                if !inserted && e.start >= h.start {
                                    kept.push(EloDeltaSpanIndexEntry {
                                        start: h.start,
                                        end: h.end,
                                        key_id: h.key_id.clone(),
                                        record: rec.to_vec(),
                                    });
                                    inserted = true;
                                }
                                // keep entries not fully covered by [start, end]
                                let covered = e.start >= h.start && e.end <= h.end;
                                if !covered {
                                    kept.push(EloDeltaSpanIndexEntry {
                                        start: e.start,
                                        end: e.end,
                                        key_id: e.key_id.clone(),
                                        record: e.record.clone(),
                                    });
                                }
                            }
                            if !inserted {
                                kept.push(EloDeltaSpanIndexEntry {
                                    start: h.start,
                                    end: h.end,
                                    key_id: h.key_id.clone(),
                                    record: rec.to_vec(),
                                });
                            }
                            *list = kept;
                        }
                    }
                    EloRecordKind::Snapshot => {
                        // Snapshot header validation already done by parser; no indexing needed
                    }
                }
            }
        }
        Ok(())
    }
    fn allow_backfill_when_no_other_clients(&self) -> bool {
        true
    }
}
impl<DocCtx> Default for ServerConfig<DocCtx> {
    fn default() -> Self {
        Self {
            on_load_document: None,
            on_save_document: None,
            save_interval_ms: None,
            default_permission: Permission::Write,
            authenticate: None,
            handshake_auth: None,
        }
    }
}

struct RoomDocState<DocCtx> {
    doc: Box<dyn CrdtDoc>,
    dirty: bool,
    ctx: Option<DocCtx>,
}

struct Hub<DocCtx> {
    // room -> vec of (conn_id, sender)
    subs: HashMap<RoomKey, Vec<(u64, Sender)>>,
    // room -> document state (Loro persistent, Ephemeral in-memory, Elo index)
    docs: HashMap<RoomKey, RoomDocState<DocCtx>>,
    config: ServerConfig<DocCtx>,
    // (conn_id, room) -> permission
    perms: HashMap<(u64, RoomKey), Permission>,
    workspace: String,
    // Fragment reassembly state: per room + batch id
    fragments: HashMap<(RoomKey, protocol::BatchId), FragmentBatch>,
}

impl<DocCtx> Hub<DocCtx>
where
    DocCtx: Clone + Send + Sync + 'static,
{
    fn new(config: ServerConfig<DocCtx>, workspace: String) -> Self {
        Self {
            subs: HashMap::new(),
            docs: HashMap::new(),
            config,
            perms: HashMap::new(),
            workspace,
            fragments: HashMap::new(),
        }
    }

    const EPHEMERAL_TIMEOUT_MS: i64 = 60_000;

    fn join(&mut self, conn_id: u64, room: RoomKey, tx: &Sender) {
        let entry = self.subs.entry(room).or_default();
        if !entry.iter().any(|(id, _)| *id == conn_id) {
            entry.push((conn_id, tx.clone()));
        }
    }

    fn leave_all(&mut self, conn_id: u64) {
        let mut emptied: Vec<RoomKey> = Vec::new();
        for (k, vec) in self.subs.iter_mut() {
            vec.retain(|(id, _)| *id != conn_id);
            if vec.is_empty() {
                emptied.push(k.clone());
            }
        }
        // Drop empty rooms from subscription map
        for k in &emptied {
            let _ = self.subs.remove(k);
        }

        // Remove permissions for this connection
        self.perms.retain(|(id, _), _| *id != conn_id);

        // Clean up ephemeral state for rooms that no longer have subscribers
        for k in emptied.clone() {
            if let Some(state) = self.docs.get(&k) {
                if state.doc.remove_when_last_subscriber_leaves() {
                    self.docs.remove(&k);
                    debug!(room=?k.room, "cleaned up ephemeral doc after last subscriber left");
                }
            }
        }

        // Clean up in-flight fragment batches started by this connection, or for rooms now emptied
        if !self.fragments.is_empty() {
            use std::collections::HashSet;
            let emptied_set: HashSet<RoomKey> = emptied.into_iter().collect();
            self.fragments
                .retain(|(rk, _), b| b.from_conn != conn_id && !emptied_set.contains(rk));
        }
    }

    fn broadcast(&mut self, room: &RoomKey, from: u64, msg: Message) {
        if let Some(list) = self.subs.get_mut(room) {
            // drop dead senders
            let mut dead: HashSet<u64> = HashSet::new();
            for (id, tx) in list.iter() {
                if *id == from {
                    continue;
                }
                if tx.send(msg.clone()).is_err() {
                    dead.insert(*id);
                }
            }
            if !dead.is_empty() {
                list.retain(|(id, _)| !dead.contains(id));
                debug!(room=?room.room, removed=%dead.len(), "removed dead subscribers");
            }
        }
    }

    async fn ensure_room_loaded(&mut self, room: &RoomKey) {
        if self.docs.contains_key(room) {
            return;
        }
        match room.crdt {
            CrdtType::Loro => {
                let mut d = LoroRoomDoc::new();
                let mut ctx = None;
                if let Some(loader) = &self.config.on_load_document {
                    let args = LoadDocArgs {
                        workspace: self.workspace.clone(),
                        room: room.room.clone(),
                        crdt: room.crdt,
                    };
                    match (loader)(args).await {
                        Ok(loaded) => {
                            if let Some(bytes) = loaded.snapshot {
                                d.import_snapshot(&bytes);
                            }
                            ctx = loaded.ctx;
                        }
                        Err(e) => {
                            warn!(room=?room.room, %e, "load document failed");
                        }
                    }
                }
                self.docs.insert(
                    room.clone(),
                    RoomDocState {
                        doc: Box::new(d),
                        dirty: false,
                        ctx,
                    },
                );
            }
            CrdtType::LoroEphemeralStore => {
                let d = EphemeralRoomDoc::new(Self::EPHEMERAL_TIMEOUT_MS);
                self.docs.insert(
                    room.clone(),
                    RoomDocState {
                        doc: Box::new(d),
                        dirty: false,
                        ctx: None,
                    },
                );
            }
            CrdtType::LoroEphemeralStorePersisted => {
                let mut d = PersistentEphemeralRoomDoc::new(Self::EPHEMERAL_TIMEOUT_MS);
                let mut ctx = None;
                if let Some(loader) = &self.config.on_load_document {
                    let args = LoadDocArgs {
                        workspace: self.workspace.clone(),
                        room: room.room.clone(),
                        crdt: room.crdt,
                    };
                    match (loader)(args).await {
                        Ok(loaded) => {
                            if let Some(bytes) = loaded.snapshot {
                                d.import_snapshot(&bytes);
                            }
                            ctx = loaded.ctx;
                        }
                        Err(e) => {
                            warn!(room=?room.room, %e, "load persisted ephemeral store failed");
                        }
                    }
                }
                self.docs.insert(
                    room.clone(),
                    RoomDocState {
                        doc: Box::new(d),
                        dirty: false,
                        ctx,
                    },
                );
            }
            CrdtType::Elo => {
                let d = EloRoomDoc::new();
                self.docs.insert(
                    room.clone(),
                    RoomDocState {
                        doc: Box::new(d),
                        dirty: false,
                        ctx: None,
                    },
                );
            }
            _ => {}
        }
    }

    fn current_version_bytes(&self, room: &RoomKey) -> Vec<u8> {
        match self.docs.get(room) {
            Some(state) => state.doc.get_version(),
            None => Vec::new(),
        }
    }

    fn apply_updates(&mut self, room: &RoomKey, updates: &[Vec<u8>]) -> Result<(), String> {
        match self.docs.get_mut(room) {
            Some(state) => {
                if let Err(e) = state.doc.apply_updates(updates) {
                    warn!(room=?room.room, %e, "apply_updates failed");
                    Err(e)
                } else {
                    if state.doc.should_persist() {
                        state.dirty = true;
                    }
                    Ok(())
                }
            }
            None => Err("room not found".into()),
        }
    }

    fn snapshot_bytes(&self, room: &RoomKey) -> Option<Vec<u8>> {
        let Some(data) = self.docs.get(room).and_then(|s| s.doc.export_snapshot()) else {
            return None;
        };
        if data.is_empty() {
            None
        } else {
            Some(data)
        }
    }
}

struct FragmentBatch {
    from_conn: u64,
    fragment_count: u64,
    total_size: u64,
    received: u64,
    chunks: Vec<Option<Vec<u8>>>,
}

impl<DocCtx> Hub<DocCtx>
where
    DocCtx: Clone + Send + Sync + 'static,
{
    fn start_fragment_batch(
        &mut self,
        room: &RoomKey,
        from_conn: u64,
        batch_id: protocol::BatchId,
        fragment_count: u64,
        total_size: u64,
    ) {
        let key = (room.clone(), batch_id);
        let chunks_len = usize::try_from(fragment_count).unwrap_or(0);
        let batch = FragmentBatch {
            from_conn,
            fragment_count,
            total_size,
            received: 0,
            chunks: vec![None; chunks_len],
        };
        self.fragments.insert(key, batch);
    }

    /// Returns Some(reassembled) when complete; removes batch.
    fn add_fragment_and_maybe_finish(
        &mut self,
        room: &RoomKey,
        batch_id: protocol::BatchId,
        index: u64,
        fragment: Vec<u8>,
    ) -> Option<Vec<u8>> {
        let key = (room.clone(), batch_id);
        if let Some(b) = self.fragments.get_mut(&key) {
            let idx = match usize::try_from(index) {
                Ok(i) => i,
                Err(_) => return None,
            };
            if idx >= b.chunks.len() {
                return None;
            }
            if b.chunks[idx].is_none() {
                b.chunks[idx] = Some(fragment);
                b.received += 1;
            }
            if b.received == b.fragment_count {
                let mut out = Vec::with_capacity(b.total_size as usize);
                for ch in b.chunks.iter() {
                    if let Some(bytes) = ch.as_ref() {
                        out.extend_from_slice(bytes);
                    }
                }
                self.fragments.remove(&key);
                return Some(out);
            }
        }
        None
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_BATCH_ID: AtomicU64 = AtomicU64::new(1);

fn next_batch_id() -> protocol::BatchId {
    protocol::BatchId(NEXT_BATCH_ID.fetch_add(1, Ordering::Relaxed).to_be_bytes())
}

fn send_ack(
    tx: &Sender,
    crdt: CrdtType,
    room: &str,
    ref_id: protocol::BatchId,
    status: UpdateStatusCode,
) {
    let ack = ProtocolMessage::Ack {
        crdt,
        room_id: room.to_string(),
        ref_id,
        status,
    };
    if let Ok(bytes) = loro_protocol::encode(&ack) {
        let _ = tx.send(Message::Binary(bytes.into()));
    }
}

struct HubRegistry<DocCtx> {
    config: ServerConfig<DocCtx>,
    hubs: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<Hub<DocCtx>>>>>,
}

impl<DocCtx> HubRegistry<DocCtx>
where
    DocCtx: Clone + Send + Sync + 'static,
{
    fn new(config: ServerConfig<DocCtx>) -> Self {
        Self {
            config,
            hubs: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    async fn get_or_create(&self, workspace: &str) -> Arc<tokio::sync::Mutex<Hub<DocCtx>>> {
        let mut map = self.hubs.lock().await;
        if let Some(h) = map.get(workspace) {
            return h.clone();
        }
        let hub = Arc::new(tokio::sync::Mutex::new(Hub::new(
            self.config.clone(),
            workspace.to_string(),
        )));
        // Spawn saver task for this hub if configured
        if let (Some(ms), Some(saver)) = (
            self.config.save_interval_ms,
            self.config.on_save_document.clone(),
        ) {
            let hub_clone = hub.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(ms));
                loop {
                    interval.tick().await;
                    let mut guard = hub_clone.lock().await;
                    let ws = guard.workspace.clone();
                    let rooms: Vec<RoomKey> = guard.docs.keys().cloned().collect();
                    for room in rooms {
                        if let Some(state) = guard.docs.get_mut(&room) {
                            if state.dirty && state.doc.should_persist() {
                                let start = std::time::Instant::now();
                                if let Some(snapshot) = state.doc.export_snapshot() {
                                    let room_str = room.room.clone();
                                    let ctx = state.ctx.clone();
                                    let args = SaveDocArgs {
                                        workspace: ws.clone(),
                                        room: room_str.clone(),
                                        crdt: room.crdt,
                                        data: snapshot,
                                        ctx,
                                    };
                                    match (saver)(args).await {
                                        Ok(()) => {
                                            state.dirty = false;
                                            let elapsed = start.elapsed();
                                            debug!(workspace=%ws, room=%room_str, ms=%elapsed.as_millis(), "snapshot saved");
                                        }
                                        Err(e) => {
                                            warn!(workspace=%ws, room=%room_str, %e, "snapshot save failed");
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            });
        }
        map.insert(workspace.to_string(), hub.clone());
        hub
    }
}

/// Start a simple broadcast server on the given socket address.
pub async fn serve(addr: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    info!(%addr, "binding TCP listener");
    let listener = TcpListener::bind(addr).await?;
    serve_incoming_with_config::<()>(listener, ServerConfig::default()).await
}

/// Serve a pre-bound listener. Useful for tests to bind on port 0.
pub async fn serve_incoming(
    listener: TcpListener,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    serve_incoming_with_config::<()>(listener, ServerConfig::default()).await
}

pub async fn serve_incoming_with_config<DocCtx>(
    listener: TcpListener,
    config: ServerConfig<DocCtx>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    DocCtx: Clone + Send + Sync + 'static,
{
    let registry = Arc::new(HubRegistry::new(config.clone()));

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                debug!(remote=%peer, "accepted TCP connection");
                let registry = registry.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_conn(stream, registry).await {
                        warn!(%e, "connection task ended with error");
                    }
                });
            }
            Err(e) => {
                error!(%e, "accept failed; continuing");
                continue;
            }
        }
    }
}

async fn handle_conn<DocCtx>(
    stream: TcpStream,
    registry: Arc<HubRegistry<DocCtx>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    DocCtx: Clone + Send + Sync + 'static,
{

    // Generate a connection id
    let conn_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

    // Capture config outside of non-async closure
    let handshake_auth = registry.config.handshake_auth.clone();
    let workspace_holder: Arc<std::sync::Mutex<Option<String>>> =
        Arc::new(std::sync::Mutex::new(None));
    let workspace_holder_c = workspace_holder.clone();

        
    let ws = accept_hdr_async(
        stream,
        move |req: &tungstenite::handshake::server::Request,
              resp: tungstenite::handshake::server::Response| {
            if let Some(check) = &handshake_auth {
                // Parse path: expect "/{workspace}" (workspace may be empty)
                let uri = req.uri();
                let path = uri.path();
                let mut workspace_id = "";
                if let Some(rest) = path.strip_prefix('/') {
                    if !rest.is_empty() {
                        // take first segment as workspace id
                        workspace_id = rest.split('/').next().unwrap_or("");
                    }
                }
                // Save for later
                {
                    if let Ok(mut guard) = workspace_holder_c.lock() {
                        *guard = Some(workspace_id.to_string());
                    }
                }

                // Parse query token parameter (no external deps)
                let token = uri.query().and_then(|q| {
                    for pair in q.split('&') {
                        let mut it = pair.splitn(2, '=');
                        let k = it.next().unwrap_or("");
                        let v = it.next();
                        if k == "token" {
                            return Some(v.unwrap_or(""));
                        }
                    }
                    None
                });

                let allowed = (check)(HandshakeAuthArgs {
                    workspace: workspace_id,
                    token,
                    request: req,
                    conn_id,
                });
                if !allowed {
                    warn!(workspace=%workspace_id, token=?token, "handshake auth denied");
                    // Build a 401 Unauthorized response
                    let builder = tungstenite::http::Response::builder()
                        .status(tungstenite::http::StatusCode::UNAUTHORIZED);
                    // Provide a small body for clarity
                    let response = builder
                        .body(Some("Unauthorized".to_string()))
                        .unwrap_or_else(|e| {
                            warn!(?e, "failed to build unauthorized response");
                            let mut fallback =
                                tungstenite::http::Response::new(Some("Unauthorized".to_string()));
                            *fallback.status_mut() = tungstenite::http::StatusCode::UNAUTHORIZED;
                            fallback
                        });
                    return Err(response);
                }
                debug!(workspace=%workspace_id, token=?token, "handshake auth accepted");
            }
            Ok(resp)
        },
    )
    .await?;

    // Determine workspace id (default to empty string)
    let workspace_id = workspace_holder
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();
    let hub = registry.get_or_create(&workspace_id).await;

    // writer task channel
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let (mut sink, mut stream) = ws.split();
    // writer
    let sink_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                debug!("sink send error; writer task exiting");
                break;
            }
        }
    });

    let mut joined_rooms: HashSet<RoomKey> = HashSet::new();

    while let Some(msg) = stream.next().await {
        match msg? {
            Message::Text(txt) => {
                if txt == "ping" {
                    let _ = tx.send(Message::Text("pong".into()));
                }
            }
            Message::Binary(data) => {
                if let Some(proto) = try_decode(data.as_ref()) {
                    match proto {
                        ProtocolMessage::JoinRequest {
                            crdt,
                            room_id,
                            auth,
                            version,
                        } => {
                            let room = RoomKey {
                                crdt,
                                room: room_id.clone(),
                            };
                            let mut h = hub.lock().await;
                            // ensure doc exists / load
                            h.ensure_room_loaded(&room).await;
                            // authenticate
                            let mut permission = h.config.default_permission;
                            if let Some(auth_fn) = &h.config.authenticate {
                                let room_str = room.room.clone();
                                match (auth_fn)(AuthArgs {
                                    room: room_str,
                                    crdt: room.crdt,
                                    auth: auth.clone(),
                                    conn_id,
                                })
                                .await
                                {
                                    Ok(Some(p)) => {
                                        permission = p;
                                    }
                                    Ok(None) => {
                                        let err = ProtocolMessage::JoinError {
                                            crdt,
                                            room_id: room.room.clone(),
                                            code: JoinErrorCode::AuthFailed,
                                            message: "Authentication failed".into(),
                                            receiver_version: None,
                                            app_code: None,
                                        };
                                        if let Ok(bytes) = loro_protocol::encode(&err) {
                                            let _ = tx.send(Message::Binary(bytes.into()));
                                        }
                                        warn!(room=?room.room, "join denied by authenticate() returning None");
                                        continue;
                                    }
                                    Err(e) => {
                                        let err = ProtocolMessage::JoinError {
                                            crdt,
                                            room_id: room.room.clone(),
                                            code: JoinErrorCode::Unknown,
                                            message: e,
                                            receiver_version: None,
                                            app_code: None,
                                        };
                                        if let Ok(bytes) = loro_protocol::encode(&err) {
                                            let _ = tx.send(Message::Binary(bytes.into()));
                                        }
                                        warn!(room=?room.room, "join denied due to authenticate() error");
                                        continue;
                                    }
                                }
                            }
                            // register subscriber and record permission
                            h.join(conn_id, room.clone(), &tx);
                            h.perms.insert((conn_id, room.clone()), permission);
                            joined_rooms.insert(room.clone());
                            info!(workspace=%h.workspace, room=?room.room, ?permission, "join ok");
                            // respond ok with current version and empty extra
                            let current_version = h.current_version_bytes(&room);
                            let ok = ProtocolMessage::JoinResponseOk {
                                crdt,
                                room_id: room.room.clone(),
                                permission,
                                version: current_version,
                                extra: Some(Vec::new()),
                            };
                            if let Ok(bytes) = loro_protocol::encode(&ok) {
                                let _ = tx.send(Message::Binary(bytes.into()));
                            }
                            // send initial state:
                            // - If snapshot available (Loro), send as a DocUpdate.
                            if let Some(snap) = h.snapshot_bytes(&room) {
                                let du = ProtocolMessage::DocUpdate {
                                    crdt,
                                    room_id: room.room.clone(),
                                    updates: vec![snap],
                                    batch_id: next_batch_id(),
                                };
                                if let Ok(bytes) = loro_protocol::encode(&du) {
                                    let _ = tx.send(Message::Binary(bytes.into()));
                                    debug!(room=?room.room, "sent initial snapshot after join");
                                }
                            } else {
                                // Otherwise, attempt backfill if other clients present or the CRDT allows
                                let others_in_room =
                                    h.subs.get(&room).map(|v| v.len()).unwrap_or(0) > 1;
                                let allow_when_empty = h
                                    .docs
                                    .get(&room)
                                    .map(|s| s.doc.allow_backfill_when_no_other_clients())
                                    .unwrap_or(false);
                                if others_in_room || allow_when_empty {
                                    let backfill = h
                                        .docs
                                        .get(&room)
                                        .map(|s| s.doc.compute_backfill(&version))
                                        .unwrap_or_default();
                                    let backfill_cnt = backfill.len();
                                    for u in backfill {
                                        let du = ProtocolMessage::DocUpdate {
                                            crdt,
                                            room_id: room.room.clone(),
                                            updates: vec![u],
                                            batch_id: next_batch_id(),
                                        };
                                        if let Ok(bytes) = loro_protocol::encode(&du) {
                                            let _ = tx.send(Message::Binary(bytes.into()));
                                        }
                                    }
                                    if backfill_cnt > 0 {
                                        debug!(room=?room.room, cnt=%backfill_cnt, "sent backfill after join");
                                    }
                                }
                            }
                        }
                        ProtocolMessage::DocUpdateFragmentHeader {
                            crdt,
                            room_id,
                            batch_id,
                            fragment_count,
                            total_size_bytes,
                        } => {
                            let room = RoomKey {
                                crdt,
                                room: room_id.clone(),
                            };
                            if !joined_rooms.contains(&room) {
                                send_ack(
                                    &tx,
                                    crdt,
                                    &room.room,
                                    batch_id,
                                    UpdateStatusCode::PermissionDenied,
                                );
                                continue;
                            }
                            // Permission check
                            let perm = hub
                                .lock()
                                .await
                                .perms
                                .get(&(conn_id, room.clone()))
                                .copied();
                            if !matches!(perm, Some(Permission::Write)) {
                                send_ack(
                                    &tx,
                                    crdt,
                                    &room.room,
                                    batch_id,
                                    UpdateStatusCode::PermissionDenied,
                                );
                                continue;
                            }
                            // Bounds checks
                            if fragment_count == 0
                                || fragment_count > MAX_FRAGMENTS
                                || total_size_bytes > MAX_BATCH_BYTES
                            {
                                send_ack(
                                    &tx,
                                    crdt,
                                    &room.room,
                                    batch_id,
                                    UpdateStatusCode::PayloadTooLarge,
                                );
                                continue;
                            }
                            // Initialize batch (guard against hijack by another sender)
                            let mut h = hub.lock().await;
                            let key = (room.clone(), batch_id);
                            if let Some(existing) = h.fragments.get(&key) {
                                if existing.from_conn != conn_id {
                                    send_ack(
                                        &tx,
                                        crdt,
                                        &room.room,
                                        batch_id,
                                        UpdateStatusCode::InvalidUpdate,
                                    );
                                    continue;
                                }
                                // else: duplicate header from same sender -> accept and broadcast as-is
                            } else {
                                h.start_fragment_batch(
                                    &room,
                                    conn_id,
                                    batch_id,
                                    fragment_count,
                                    total_size_bytes,
                                );
                            }
                            // Broadcast header as-is
                            h.broadcast(&room, conn_id, Message::Binary(data));
                        }
                        ProtocolMessage::DocUpdateFragment {
                            crdt,
                            room_id,
                            batch_id,
                            index,
                            fragment,
                        } => {
                            let room = RoomKey {
                                crdt,
                                room: room_id.clone(),
                            };
                            if !joined_rooms.contains(&room) {
                                send_ack(
                                    &tx,
                                    crdt,
                                    &room.room,
                                    batch_id,
                                    UpdateStatusCode::PermissionDenied,
                                );
                                continue;
                            }
                            // Validate batch existence and sender binding; also index bounds
                            let mut h = hub.lock().await;
                            let key = (room.clone(), batch_id);
                            if let Some(b) = h.fragments.get(&key) {
                                if b.from_conn != conn_id {
                                    send_ack(
                                        &tx,
                                        crdt,
                                        &room.room,
                                        batch_id,
                                        UpdateStatusCode::InvalidUpdate,
                                    );
                                    // do not broadcast
                                    continue;
                                }
                                if !usize::try_from(index)
                                    .ok()
                                    .map(|i| i < b.chunks.len())
                                    .unwrap_or(false)
                                {
                                    send_ack(
                                        &tx,
                                        crdt,
                                        &room.room,
                                        batch_id,
                                        UpdateStatusCode::InvalidUpdate,
                                    );
                                    continue;
                                }
                            } else {
                                send_ack(
                                    &tx,
                                    crdt,
                                    &room.room,
                                    batch_id,
                                    UpdateStatusCode::FragmentTimeout,
                                );
                                continue;
                            }
                            // Broadcast this fragment as-is to others (only after validation)
                            h.broadcast(&room, conn_id, Message::Binary(data.clone()));
                            // Accumulate and possibly finish
                            if let Some(buf) =
                                h.add_fragment_and_maybe_finish(&room, batch_id, index, fragment)
                            {
                                // On completion: parse and apply to stored doc state if applicable
                                let apply_result = match crdt {
                                    CrdtType::Loro
                                    | CrdtType::LoroEphemeralStore
                                    | CrdtType::LoroEphemeralStorePersisted => {
                                        let start = std::time::Instant::now();
                                        let res = h.apply_updates(&room, &[buf.clone()]);
                                        let elapsed_ms = start.elapsed().as_millis();
                                        if res.is_ok() {
                                            debug!(room=?room.room, updates=1, ms=%elapsed_ms, "applied reassembled updates");
                                        }
                                        res
                                    }
                                    CrdtType::Elo => {
                                        // Apply as indexing-only
                                        h.apply_updates(&room, &[buf.clone()])
                                    }
                                    _ => Ok(()),
                                };

                                if apply_result.is_ok() {
                                    send_ack(&tx, crdt, &room.room, batch_id, UpdateStatusCode::Ok);
                                } else {
                                    send_ack(&tx, crdt, &room.room, batch_id, UpdateStatusCode::InvalidUpdate);
                                }
                            }
                        }
                        ProtocolMessage::DocUpdate {
                            crdt,
                            room_id,
                            updates,
                            batch_id,
                        } => {
                            let room = RoomKey {
                                crdt,
                                room: room_id.clone(),
                            };
                            let oversized =
                                updates.iter().any(|u| u.len() > protocol::MAX_MESSAGE_SIZE);
                            if oversized {
                                send_ack(
                                    &tx,
                                    crdt,
                                    &room.room,
                                    batch_id,
                                    UpdateStatusCode::PayloadTooLarge,
                                );
                                continue;
                            }
                            if !joined_rooms.contains(&room) {
                                send_ack(
                                    &tx,
                                    crdt,
                                    &room.room,
                                    batch_id,
                                    UpdateStatusCode::PermissionDenied,
                                );
                                warn!(room=?room.room, "update rejected: not joined");
                            } else {
                                // Check permission
                                let perm = hub
                                    .lock()
                                    .await
                                    .perms
                                    .get(&(conn_id, room.clone()))
                                    .copied();
                                if !matches!(perm, Some(Permission::Write)) {
                                    send_ack(
                                        &tx,
                                        crdt,
                                        &room.room,
                                        batch_id,
                                        UpdateStatusCode::PermissionDenied,
                                    );
                                    continue;
                                }
                                let mut h = hub.lock().await;
                                let apply_result = match crdt {
                                    CrdtType::Loro
                                    | CrdtType::LoroEphemeralStore
                                    | CrdtType::LoroEphemeralStorePersisted => {
                                        let start = std::time::Instant::now();
                                        let res = h.apply_updates(&room, &updates);
                                        let elapsed_ms = start.elapsed().as_millis();
                                        if res.is_ok() {
                                            debug!(room=?room.room, updates=%updates.len(), ms=%elapsed_ms, "applied and broadcast updates");
                                        }
                                        res
                                    }
                                    CrdtType::Elo => {
                                        // Index headers only; payload remains opaque to server.
                                        h.apply_updates(&room, &updates)
                                    }
                                    _ => Ok(()),
                                };

                                if apply_result.is_ok() {
                                    h.broadcast(&room, conn_id, Message::Binary(data));
                                    send_ack(
                                        &tx,
                                        crdt,
                                        &room.room,
                                        batch_id,
                                        UpdateStatusCode::Ok,
                                    );
                                } else {
                                    send_ack(
                                        &tx,
                                        crdt,
                                        &room.room,
                                        batch_id,
                                        UpdateStatusCode::InvalidUpdate,
                                    );
                                }
                            }
                        }
                        _ => {
                            // For simplicity, ignore other messages in minimal server.
                        }
                    }
                } else {
                    // Invalid frame: close with Protocol error, but keep server running
                    warn!("invalid protocol frame; closing connection");
                    let _ = tx.send(Message::Close(Some(CloseFrame {
                        code: CloseCode::Protocol,
                        reason: "Protocol error".into(),
                    })));
                    break;
                }
            }
            Message::Close(frame) => {
                let _ = tx.send(Message::Close(frame.clone()));
                break;
            }
            Message::Ping(p) => {
                let _ = tx.send(Message::Pong(p));
                let _ = tx.send(Message::Text("pong".into()));
            }
            _ => {}
        }
    }

    // cleanup
    {
        let mut h = hub.lock().await;
        h.leave_all(conn_id);
    }
    // drop tx to stop writer
    drop(tx);
    let _ = sink_task.await;
    debug!(conn_id, "connection closed and cleaned up");
    Ok(())
}
