//! loro-dev/protocol#16: when the receiver cannot interpret the joining
//! version, `join_loro` should rejoin with an empty version, as
//! `join_with_adaptor` already does, instead of failing the join.

use futures_util::{SinkExt, StreamExt};
use loro::{ExportMode, LoroDoc};
use loro_protocol::{decode, encode, BatchId, JoinErrorCode, Permission, ProtocolMessage};
use loro_websocket_client::LoroWebsocketClient;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

/// Serves one connection. A join with a non-empty version gets
/// `VersionUnknown`; a join with an empty version gets `JoinResponseOk`
/// followed by the receiver's whole history. Returns the join versions seen.
async fn serve_one(listener: TcpListener, server_doc: LoroDoc, max_joins: usize) -> Vec<Vec<u8>> {
    let (stream, _) = listener.accept().await.unwrap();
    let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
    let mut joins = Vec::new();
    while joins.len() < max_joins {
        let Some(Ok(Message::Binary(data))) = ws.next().await else {
            break;
        };
        let ProtocolMessage::JoinRequest {
            crdt,
            room_id,
            version,
            ..
        } = decode(&data).unwrap()
        else {
            continue;
        };
        joins.push(version.clone());
        let server_version = server_doc.oplog_vv().encode();
        let replies = if version.is_empty() {
            vec![
                ProtocolMessage::JoinResponseOk {
                    crdt,
                    room_id: room_id.clone(),
                    permission: Permission::Write,
                    version: server_version,
                    extra: None,
                },
                ProtocolMessage::DocUpdate {
                    crdt,
                    room_id,
                    updates: vec![server_doc.export(ExportMode::all_updates()).unwrap()],
                    batch_id: BatchId([0; 8]),
                },
            ]
        } else {
            vec![ProtocolMessage::JoinError {
                crdt,
                room_id,
                code: JoinErrorCode::VersionUnknown,
                message: "version unknown".into(),
                receiver_version: Some(server_version),
                app_code: None,
            }]
        };
        for reply in replies {
            ws.send(Message::Binary(encode(&reply).unwrap().into()))
                .await
                .unwrap();
        }
    }
    joins
}

#[tokio::test(flavor = "current_thread")]
async fn join_loro_rejoins_with_empty_version_on_version_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_doc = LoroDoc::new();
    server_doc
        .get_text("text")
        .insert(0, "from server")
        .unwrap();
    server_doc.commit();
    let server = tokio::spawn(serve_one(listener, server_doc, 2));

    let client = LoroWebsocketClient::connect(&format!("ws://{addr}/"))
        .await
        .unwrap();
    let doc = LoroDoc::new();
    doc.get_text("local").insert(0, "local edit").unwrap();
    doc.commit();
    let doc = Arc::new(Mutex::new(doc));
    let joined = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.join_loro("room", doc.clone()),
    )
    .await
    .expect("join timed out");
    assert!(joined.is_ok(), "join failed: {:?}", joined.err());

    let joins = server.await.unwrap();
    assert_eq!(joins.len(), 2);
    assert!(!joins[0].is_empty());
    assert!(joins[1].is_empty());

    // The history sent after the rejoin is imported into the joined doc.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if doc.lock().await.get_text("text").to_string() == "from server" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("server history was not imported");
    assert_eq!(doc.lock().await.get_text("local").to_string(), "local edit");
}

#[tokio::test(flavor = "current_thread")]
async fn join_loro_fails_if_empty_version_is_also_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    // This receiver answers every join, including the empty one, with
    // VersionUnknown, so the client must give up after one fallback.
    let joins = Arc::new(std::sync::Mutex::new(Vec::<Vec<u8>>::new()));
    let seen = joins.clone();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        while let Some(Ok(Message::Binary(data))) = ws.next().await {
            if let ProtocolMessage::JoinRequest {
                crdt,
                room_id,
                version,
                ..
            } = decode(&data).unwrap()
            {
                seen.lock().unwrap().push(version);
                let reply = ProtocolMessage::JoinError {
                    crdt,
                    room_id,
                    code: JoinErrorCode::VersionUnknown,
                    message: "version unknown".into(),
                    receiver_version: None,
                    app_code: None,
                };
                ws.send(Message::Binary(encode(&reply).unwrap().into()))
                    .await
                    .unwrap();
            }
        }
    });

    let client = LoroWebsocketClient::connect(&format!("ws://{addr}/"))
        .await
        .unwrap();
    let doc = LoroDoc::new();
    doc.get_text("local").insert(0, "local edit").unwrap();
    doc.commit();
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.join_loro("room", Arc::new(Mutex::new(doc))),
    )
    .await
    .expect("join timed out");
    assert!(res.is_err());
    // Give a third join, which must not be sent, time to arrive.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let joins = joins.lock().unwrap().clone();
    assert_eq!(joins.len(), 2, "{joins:?}");
    assert!(!joins[0].is_empty());
    assert!(joins[1].is_empty());
    server.abort();
}
