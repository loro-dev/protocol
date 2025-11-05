//! Minimal CLI to run the Loro WebSocket server with SQLite persistence
//!
//! Usage:
//!   cargo run -p loro-websocket-server --example simple-server -- [--host 127.0.0.1] [--port 9000] [--db loro.db]
//!   cargo run -p loro-websocket-server --example simple-server -- --addr 0.0.0.0:9000 --db state.db
//!
//! Notes:
//! - Uses a single-thread Tokio runtime to match crate features.
//! - Defaults to 127.0.0.1:9000 and ./loro.db if not specified.

use clap::Parser;
use std::{error::Error, path::PathBuf};
use tracing::{debug, error, info, warn};
use tracing_subscriber::EnvFilter;

use loro_websocket_server::protocol::CrdtType;
use loro_websocket_server::{serve_incoming_with_config, ServerConfig};
use tokio::net::TcpListener;

#[derive(Parser, Debug)]
#[command(
    name = "simple-server",
    about = "Loro WebSocket server with SQLite persistence"
)]
struct Args {
    #[arg(short = 'a', long, value_name = "ADDR", conflicts_with_all = ["host", "port"], help = "Full socket address to bind, e.g. 0.0.0.0:9000")]
    addr: Option<String>,

    #[arg(
        short = 'H',
        long,
        default_value = "127.0.0.1",
        help = "Host to bind when --addr not provided"
    )]
    host: String,

    #[arg(
        short = 'p',
        long,
        default_value_t = 9000,
        help = "Port to bind when --addr not provided"
    )]
    port: u16,

    #[arg(
        short = 'd',
        long = "db",
        value_name = "PATH",
        default_value = "loro.db",
        help = "SQLite database path"
    )]
    db: PathBuf,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    // Init tracing
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .compact()
        .init();

    let args = Args::parse();
    let addr = args
        .addr
        .unwrap_or_else(|| format!("{}:{}", args.host, args.port));
    let db_path = args.db;

    init_db(&db_path).await?;

    // Wire persistence hooks
    let db_for_load = db_path.clone();
    type LoadFut = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Option<Vec<u8>>, String>> + Send>,
    >;
    type SaveFut = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;

    let on_load = std::sync::Arc::new(move |workspace: String, room: String, crdt: CrdtType| {
        let db_path = db_for_load.clone();
        let fut = async move {
            tokio::task::spawn_blocking(move || load_snapshot(&db_path, &workspace, &room, crdt))
                .await
                .map_err(|e| format!("task join error: {e}"))?
        };
        let fut: LoadFut = Box::pin(fut);
        fut
    });

    let db_for_save = db_path.clone();
    let on_save = std::sync::Arc::new(
        move |workspace: String, room: String, crdt: CrdtType, data: Vec<u8>| {
            let db_path = db_for_save.clone();
            let fut = async move {
                tokio::task::spawn_blocking(move || {
                    save_snapshot(&db_path, &workspace, &room, crdt, &data)
                })
                .await
                .map_err(|e| format!("task join error: {e}"))?
            };
            let fut: SaveFut = Box::pin(fut);
            fut
        },
    );

    let cfg = ServerConfig {
        on_load_document: Some(on_load),
        on_save_document: Some(on_save),
        // Save periodically if there are changes
        save_interval_ms: Some(1_000),
        ..Default::default()
    };

    info!(%addr, db=%db_path.display().to_string(), "starting loro-websocket-server");
    info!("Press Ctrl-C to stop.");

    let listener = TcpListener::bind(&addr).await?;
    serve_incoming_with_config(listener, cfg).await
}

// clap provides --help automatically

async fn init_db(path: &std::path::Path) -> Result<(), Box<dyn Error + Send + Sync>> {
    let p = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<(), Box<dyn Error + Send + Sync>> {
        let conn = rusqlite::Connection::open(p)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS documents (
                workspace TEXT NOT NULL,
                crdt TEXT NOT NULL,
                room TEXT NOT NULL,
                data BLOB NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (workspace, crdt, room)
            );
            "#,
        )?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))??;
    Ok(())
}

fn crdt_to_str(crdt: CrdtType) -> &'static str {
    match crdt {
        CrdtType::Loro => "loro",
        CrdtType::LoroEphemeralStore => "loro_ephemeral",
        CrdtType::LoroEphemeralStorePersisted => "loro_ephemeral_persisted",
        CrdtType::Yjs => "yjs",
        CrdtType::YjsAwareness => "yjs_awareness",
        CrdtType::Elo => "elo",
    }
}

fn load_snapshot(
    path: &PathBuf,
    workspace: &str,
    room: &str,
    crdt: CrdtType,
) -> Result<Option<Vec<u8>>, String> {
    let conn = rusqlite::Connection::open(path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT data FROM documents WHERE workspace=?1 AND crdt=?2 AND room=?3")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params![workspace, crdt_to_str(crdt), room])
        .map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let data: Vec<u8> = row.get(0).map_err(|e| e.to_string())?;
        Ok(Some(data))
    } else {
        Ok(None)
    }
}

fn save_snapshot(
    path: &PathBuf,
    workspace: &str,
    room: &str,
    crdt: CrdtType,
    data: &[u8],
) -> Result<(), String> {
    let conn = rusqlite::Connection::open(path).map_err(|e| e.to_string())?;
    let now_ms = chrono_like_now_ms();
    conn.execute(
        "INSERT INTO documents (workspace, crdt, room, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace, crdt, room) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
        rusqlite::params![workspace, crdt_to_str(crdt), room, data, now_ms],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn chrono_like_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| std::time::Duration::from_secs(0));
    dur.as_millis() as i64
}
