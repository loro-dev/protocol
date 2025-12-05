use loro_protocol::{bytes::BytesWriter, elo::*, protocol::CrdtType};

fn make_delta_record(
    peer: &[u8],
    start: u64,
    end: u64,
    key: &str,
    iv: &[u8; 12],
    ct: &[u8],
) -> Vec<u8> {
    let mut w = BytesWriter::new();
    w.push_byte(EloRecordKind::DeltaSpan as u8);
    w.push_var_bytes(peer);
    w.push_uleb128(start);
    w.push_uleb128(end);
    w.push_var_string(key);
    w.push_var_bytes(iv);
    let header = w.finalize();
    let mut w2 = BytesWriter::new();
    w2.push_bytes(&header);
    w2.push_var_bytes(ct);
    w2.finalize()
}

fn make_snapshot_record(vv: &[(&[u8], u64)], key: &str, iv: &[u8; 12], ct: &[u8]) -> Vec<u8> {
    let mut w = BytesWriter::new();
    w.push_byte(EloRecordKind::Snapshot as u8);
    w.push_uleb128(vv.len() as u64);
    for (peer, ctr) in vv.iter() {
        w.push_var_bytes(peer);
        w.push_uleb128(*ctr);
    }
    w.push_var_string(key);
    w.push_var_bytes(iv);
    let header = w.finalize();
    let mut w2 = BytesWriter::new();
    w2.push_bytes(&header);
    w2.push_var_bytes(ct);
    w2.finalize()
}

#[test]
fn crdt_magic_includes_elo() {
    assert_eq!(CrdtType::Elo.magic_bytes(), *b"%ELO");
    assert_eq!(CrdtType::from_magic_bytes(*b"%ELO"), Some(CrdtType::Elo));
}

#[test]
fn decode_container_and_parse_delta() {
    let peer = b"peer-a";
    let iv: [u8; 12] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    let ct: Vec<u8> = vec![0xaa, 0xbb, 0xcc, 0xdd];
    let rec = make_delta_record(peer, 5, 8, "k1", &iv, &ct);

    // Pack into container with 1 record
    let mut w = BytesWriter::new();
    w.push_uleb128(1);
    w.push_var_bytes(&rec);
    let container = w.finalize();

    let records = decode_elo_container(&container).expect("container ok");
    assert_eq!(records.len(), 1);
    let parsed = parse_elo_record_header(records[0]).expect("parse delta");
    assert_eq!(parsed.kind, EloRecordKind::DeltaSpan);
    match parsed.header {
        EloHeader::Delta(h) => {
            assert_eq!(h.peer_id, peer);
            assert_eq!(h.start, 5);
            assert_eq!(h.end, 8);
            assert_eq!(h.key_id, "k1");
            assert_eq!(&h.iv, &iv);
        }
        _ => panic!("expected delta header"),
    }
    assert_eq!(parsed.ct, &ct[..]);
    assert!(parsed.aad.len() > 0);
}

#[test]
fn parse_snapshot_sorted_vv_and_ct() {
    // Already sorted by peer bytes
    let vv: Vec<(&[u8], u64)> = vec![(b"a", 1), (b"b", 2), (b"zz", 9)];
    let iv: [u8; 12] = [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9];
    let ct: Vec<u8> = vec![0x01, 0x02];
    let rec = make_snapshot_record(&vv, "kid", &iv, &ct);
    let parsed = parse_elo_record_header(&rec).expect("parse snapshot");
    assert_eq!(parsed.kind, EloRecordKind::Snapshot);
    match parsed.header {
        EloHeader::Snapshot(h) => {
            assert_eq!(h.vv.len(), 3);
            assert_eq!(h.key_id, "kid");
            assert_eq!(&h.iv, &iv);
            // peer ids preserved
            assert_eq!(h.vv[0].0, b"a");
            assert_eq!(h.vv[1].0, b"b");
            assert_eq!(h.vv[2].0, b"zz");
        }
        _ => panic!("expected snapshot header"),
    }
    assert_eq!(parsed.ct, &ct[..]);
}

#[test]
fn invalid_cases() {
    // bad iv length
    let peer = b"p";
    let ct: Vec<u8> = vec![1, 2, 3];
    let mut iv_bad = [0u8; 12];
    iv_bad[..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
    // Manually construct with 8-byte iv
    let mut w = BytesWriter::new();
    w.push_byte(EloRecordKind::DeltaSpan as u8);
    w.push_var_bytes(peer);
    w.push_uleb128(1);
    w.push_uleb128(2);
    w.push_var_string("k");
    w.push_var_bytes(&iv_bad[..8]);
    let hdr = w.finalize();
    let mut w2 = BytesWriter::new();
    w2.push_bytes(&hdr);
    w2.push_var_bytes(&ct);
    let rec = w2.finalize();
    assert!(parse_elo_record_header(&rec)
        .unwrap_err()
        .contains("IV must be 12"));

    // peer id too long (65 bytes)
    let long_peer = vec![0u8; 65];
    let rec = make_delta_record(
        &long_peer,
        1,
        2,
        "k",
        &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        &[1],
    );
    assert!(parse_elo_record_header(&rec)
        .unwrap_err()
        .contains("peerId too long"));

    // key id too long (65 ascii)
    let long_key = "A".repeat(65);
    let rec = make_delta_record(
        b"p",
        1,
        2,
        &long_key,
        &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        &[1],
    );
    assert!(parse_elo_record_header(&rec)
        .unwrap_err()
        .contains("keyId too long"));

    // container trailing bytes
    let mut w = BytesWriter::new();
    w.push_uleb128(1);
    w.push_var_bytes(&make_delta_record(
        b"p",
        1,
        2,
        "k",
        &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        &[1],
    ));
    w.push_byte(0xff); // trailing
    let container = w.finalize();
    assert!(decode_elo_container(&container).is_err());
}
