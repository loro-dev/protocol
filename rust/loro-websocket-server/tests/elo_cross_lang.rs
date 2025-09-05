use std::{io, path::PathBuf, process::Stdio, time::Duration};
use std::sync::{Mutex, OnceLock};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::time::timeout;

use loro_websocket_server as server;
static SERIAL: OnceLock<Mutex<()>> = OnceLock::new();

fn workspace_pkg_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR points to rust/loro-websocket-server
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent() // rust/
        .and_then(|p| p.parent()) // repo root
        .unwrap()
        .join("packages/loro-websocket")
}

async fn run_tsx_in_pkg(ts_file_rel: &str, extra: &[&str]) -> io::Result<std::process::ExitStatus> {
    // Prefer pnpm exec in package dir; fallback to npx
    let pkg_dir = workspace_pkg_dir();
    eprintln!("[test] run_tsx_in_pkg: pnpm exec tsx {ts_file_rel} {}", extra.join(" "));
    let status = Command::new("pnpm")
        .current_dir(&pkg_dir)
        .arg("exec")
        .arg("tsx")
        .arg(ts_file_rel)
        .args(extra)
        .status()
        .await;
    match status {
        Ok(s) => Ok(s),
        Err(_) => {
            eprintln!("[test] pnpm exec failed, falling back to npx tsx");
            let file = workspace_pkg_dir().join(ts_file_rel);
            let mut all_args: Vec<String> = Vec::with_capacity(1 + extra.len());
            all_args.push(file.to_string_lossy().to_string());
            for a in extra { all_args.push((*a).to_string()); }
            Command::new("npx").arg("tsx").args(all_args).status().await
        }
    }
}

async fn spawn_tsx_in_pkg(ts_file_rel: &str, extra: &[&str]) -> io::Result<Child> {
    // Long-running process: try pnpm exec first, else npx
    let pkg_dir = workspace_pkg_dir();
    eprintln!("[test] spawn_tsx_in_pkg: pnpm exec tsx {ts_file_rel} {}", extra.join(" "));
    let child = Command::new("pnpm")
        .current_dir(&pkg_dir)
        .arg("exec")
        .arg("tsx")
        .arg(ts_file_rel)
        .args(extra)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn();
    match child {
        Ok(c) => Ok(c),
        Err(_) => {
            eprintln!("[test] pnpm exec failed, falling back to npx tsx");
            let file = workspace_pkg_dir().join(ts_file_rel);
            let mut all_args: Vec<String> = Vec::with_capacity(1 + extra.len());
            all_args.push(file.to_string_lossy().to_string());
            for a in extra { all_args.push((*a).to_string()); }
            Command::new("npx")
                .arg("tsx")
                .args(all_args)
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
        }
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn js_client_to_rust_client_via_rust_server() {
    // Serialize tests to avoid interleaved server/client interactions on localhost
    let _guard = SERIAL
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // Requires pnpm/npx with tsx; runs TS wrappers directly
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ws_url = format!("ws://127.0.0.1:{}", addr.port());
    eprintln!("[test] Starting Rust server at {ws_url}");
    // Start server
    tokio::spawn(async move { let _ = server::serve_incoming(listener).await; });

    // Start Rust receiver example
    eprintln!("[test] Spawning Rust receiver example at {ws_url}");
    let mut recv = Command::new("cargo")
        .args([
            "run", "--quiet", "-p", "loro-websocket-client",
            "--example", "elo_index_client", "--",
            "receiver", &ws_url, "room-elo"
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn receiver");

    // Start TS sender wrapper via tsx
    eprintln!("[test] Running JS sender wrapper with {ws_url}");
    let status = run_tsx_in_pkg("src/wrappers/send-elo-normative.ts", &[&ws_url, "room-elo"]).await.expect("spawn tsx sender");
    assert!(status.success(), "tsx sender failed");

    // Wait for receiver to index and exit
    eprintln!("[test] Waiting for Rust receiver to exit (10s)");
    let rc = timeout(Duration::from_secs(10), recv.wait()).await.expect("receiver timeout").expect("receiver wait");
    assert!(rc.success(), "receiver failed");
}

#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn rust_client_to_js_client_via_js_server() {
    // Serialize tests to avoid interleaved server/client interactions on localhost
    let _guard = SERIAL
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // Pick an available port by binding a Rust listener temporarily, then drop it
    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);

    // Start TS WS server on that port via tsx
    eprintln!("[test] Spawning JS WS server at ws://127.0.0.1:{port}");
    let mut child = spawn_tsx_in_pkg("src/wrappers/start-simple-server.ts", &["127.0.0.1", &port.to_string()])
        .await
        .expect("spawn js server");
    let ws_url = format!("ws://127.0.0.1:{}", port);

    // Actively wait for the port to accept connections to avoid races
    let ready_deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    eprintln!("[test] Waiting for JS server to accept connections (up to 3s)");
    loop {
        match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            Ok(_) => { eprintln!("[test] JS server is listening"); break },
            Err(_) => {
                if tokio::time::Instant::now() > ready_deadline { break; }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }

    // Start JS receiver that decrypts and validates doc content
    eprintln!("[test] Spawning JS ELO receiver wrapper with {ws_url}");
    let mut js_recv = spawn_tsx_in_pkg("src/wrappers/recv-elo-doc.ts", &[&ws_url, "room-elo", "hi"]).await.expect("spawn tsx recv");

    // Start Rust sender example
    eprintln!("[test] Spawning Rust sender example at {ws_url}");
    let status = Command::new("cargo")
        .args([
            "run", "--quiet", "-p", "loro-websocket-client",
            "--example", "elo_index_client", "--",
            "sender", &ws_url, "room-elo"
        ])
        .status()
        .await
        .expect("spawn rust sender");
    assert!(status.success(), "rust sender failed");

    // Wait for JS receiver to exit
    eprintln!("[test] Waiting for JS receiver to exit (10s)");
    let rc = timeout(Duration::from_secs(10), js_recv.wait()).await.expect("js recv timeout").expect("js recv wait");
    assert!(rc.success(), "js receiver failed");

    // Kill server
    let _ = child.kill().await;
}
