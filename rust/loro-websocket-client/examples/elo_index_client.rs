use futures_util::{SinkExt, StreamExt};
use loro::{LoroDoc};
use loro_websocket_client::protocol as proto;
use loro_websocket_client::protocol::{CrdtType, ProtocolMessage};
use tokio::time::{sleep, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use aes_gcm::{Aes256Gcm, aead::{Aead, KeyInit}, Nonce};

const KEY: [u8; 32] = [
    0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,
    0x08,0x09,0x0a,0x0b,0x0c,0x0d,0x0e,0x0f,
    0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,
    0x18,0x19,0x1a,0x1b,0x1c,0x1d,0x1e,0x1f,
];
const FIXED_IV: [u8; 12] = [0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0a,0x0b,0x0c];

fn encode_elo_snapshot_container(plaintext: &[u8], key_id: &str) -> Vec<u8> {
    // Build ELO Snapshot header with empty vv and fixed IV
    use loro_websocket_client::protocol::bytes::BytesWriter;
    let mut hdr = BytesWriter::new();
    hdr.push_byte(proto::elo::EloRecordKind::Snapshot as u8);
    hdr.push_uleb128(0); // vv count = 0
    hdr.push_var_string(key_id);
    hdr.push_var_bytes(&FIXED_IV);
    let header_bytes = hdr.finalize();

    // Encrypt using AES-256-GCM with AAD=header_bytes and IV
    let cipher = Aes256Gcm::new_from_slice(&KEY).expect("key");
    let nonce = Nonce::from_slice(&FIXED_IV);
    let ct = cipher.encrypt(nonce, aes_gcm::aead::Payload { msg: plaintext, aad: &header_bytes })
        .expect("encrypt");

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

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Args: role receiver|sender, url, room
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 3 {
        eprintln!("usage: elo_index_client <receiver|sender> <ws_url> <room_id>");
        std::process::exit(2);
    }
    let role = args.remove(0);
    let url = args.remove(0);
    let room = args.remove(0).into_bytes();

    eprintln!("[elo_index_client] connecting to {url} as {role} room={}", String::from_utf8_lossy(&room));
    let (mut ws, _resp) = connect_async(url).await?;

    // Send JoinRequest for %ELO
    let join = ProtocolMessage::JoinRequest { crdt: CrdtType::Elo, room_id: room.clone(), auth: Vec::new(), version: Vec::new() };
    let bytes = loro_websocket_client::protocol::encode(&join).map_err(|e| format!("encode: {}", e))?;
    ws.send(Message::Binary(bytes.into())).await?;

    // Await JoinResponseOk (ignore other frames)
    let mut got_ok = false;
    let mut pending_frag: Option<(proto::BatchId, Vec<Vec<u8>>, u64)> = None; // (id, slots, received)
    let mut doc = LoroDoc::new();

    if role == "sender" {
        // Produce a simple doc and send a real ELO snapshot
        doc.get_text("t").insert(0, "hi").unwrap();
        doc.commit();
        // Wait briefly for join to settle
        sleep(Duration::from_millis(80)).await;
        let snap = doc.export(loro::ExportMode::Snapshot).unwrap();
        let container = encode_elo_snapshot_container(&snap, "k1");
        let du = ProtocolMessage::DocUpdate { crdt: CrdtType::Elo, room_id: room.clone(), updates: vec![container] };
        let data = loro_websocket_client::protocol::encode(&du).map_err(|e| format!("encode du: {}", e))?;
        ws.send(Message::Binary(data.into())).await?;
        eprintln!("[elo_index_client] SENT ELO snapshot container");
        return Ok(());
    }

    while let Some(frame) = ws.next().await {
        match frame? {
            Message::Binary(b) => {
                if let Some(msg) = loro_websocket_client::protocol::try_decode(b.as_ref()) {
                    match msg {
                        ProtocolMessage::JoinResponseOk { .. } => { got_ok = true; eprintln!("[elo_index_client] JOIN OK"); }
                        ProtocolMessage::DocUpdate { updates, .. } => {
                            // Decrypt and apply each ELO record
                            for u in updates {
                                if let Ok(records) = loro_websocket_client::protocol::elo::decode_elo_container(&u) {
                                    for rec in records {
                                        let parsed = loro_websocket_client::protocol::elo::parse_elo_record_header(rec)
                                            .map_err(|e| format!("parse elo: {}", e))?;
                                        let aad = parsed.aad;
                                        let iv = match &parsed.header {
                                            loro_websocket_client::protocol::elo::EloHeader::Delta(h) => h.iv,
                                            loro_websocket_client::protocol::elo::EloHeader::Snapshot(h) => h.iv,
                                        };
                                        let cipher = Aes256Gcm::new_from_slice(&KEY).expect("key");
                                        let nonce = Nonce::from_slice(&iv);
                                        let pt = cipher.decrypt(nonce, aes_gcm::aead::Payload { msg: parsed.ct, aad })
                                            .map_err(|_| "decrypt failed")?;
                                        doc.import(&pt).unwrap();
                                    }
                                }
                            }
                            // Got at least one update; verify doc content
                            let s = doc.get_text("t").to_string();
                            if s == "hi" { println!("INDEXED 1"); return Ok(()); }
                            return Err(format!("unexpected doc content: {}", s).into());
                        }
                        ProtocolMessage::DocUpdateFragmentHeader { batch_id, fragment_count, total_size_bytes, .. } => {
                            let slots = vec![Vec::<u8>::new(); usize::try_from(fragment_count).unwrap_or(0)];
                            pending_frag = Some((batch_id, slots, 0));
                            let _ = total_size_bytes;
                        }
                        ProtocolMessage::DocUpdateFragment { batch_id, index, fragment, .. } => {
                            if let Some((id, ref mut slots, ref mut recvd)) = pending_frag {
                                if id == batch_id {
                                    let i = usize::try_from(index).unwrap_or(usize::MAX);
                                    if i < slots.len() { slots[i] = fragment; *recvd += 1; }
                                    if *recvd as usize == slots.len() {
                                        // Reassemble into one buffer
                                        let mut buf = Vec::new();
                                        for s in slots.iter() { buf.extend_from_slice(s); }
                                        if let Ok(records) = loro_websocket_client::protocol::elo::decode_elo_container(&buf) {
                                            for rec in records {
                                                let parsed = loro_websocket_client::protocol::elo::parse_elo_record_header(rec)
                                                    .map_err(|e| format!("parse elo: {}", e))?;
                                                let aad = parsed.aad;
                                                let iv = match &parsed.header {
                                                    loro_websocket_client::protocol::elo::EloHeader::Delta(h) => h.iv,
                                                    loro_websocket_client::protocol::elo::EloHeader::Snapshot(h) => h.iv,
                                                };
                                                let cipher = Aes256Gcm::new_from_slice(&KEY).expect("key");
                                                let nonce = Nonce::from_slice(&iv);
                                                let pt = cipher.decrypt(nonce, aes_gcm::aead::Payload { msg: parsed.ct, aad })
                                                    .map_err(|_| "decrypt failed")?;
                                                doc.import(&pt).unwrap();
                                            }
                                        }
                                        let s = doc.get_text("t").to_string();
                                        if s == "hi" { println!("INDEXED 1"); return Ok(()); }
                                        return Err(format!("unexpected doc content: {}", s).into());
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            Message::Text(t) => {
                if t == "ping" { let _ = ws.send(Message::Text("pong".into())).await; }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    if got_ok { eprintln!("[elo_index_client] no updates applied"); }
    std::process::exit(1)
}
