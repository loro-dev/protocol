use loro_protocol::{bytes::BytesWriter, elo::*, protocol::CrdtType};

fn hex_to_bytes(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i + 1 < s.len() {
        let b = u8::from_str_radix(&s[i..i + 2], 16).unwrap();
        out.push(b);
        i += 2;
    }
    out
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut s = String::from("0x");
    for b in bytes { use std::fmt::Write; let _ = write!(s, "{:02x}", b); }
    s
}

#[test]
fn normative_vector_deltaspan_header_and_ct_align_with_spec() {
    // From protocol-e2ee.md ## Normative Test Vector (DeltaSpan)
    let key_hex = "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    let _key = hex_to_bytes(key_hex); // not used (no crypto here), kept for clarity
    let peer_id = hex_to_bytes("0x01020304");
    let start: u64 = 1;
    let end: u64 = 3;
    let key_id = "k1";
    let iv = hex_to_bytes("0x86bcad09d5e7e3d70503a57e");
    assert_eq!(iv.len(), 12);
    let plaintext = hex_to_bytes("0x01026869"); // varUint 1, varBytes("hi")

    // Encode header exactly as spec (this becomes AAD)
    let mut w = BytesWriter::new();
    w.push_byte(EloRecordKind::DeltaSpan as u8);
    w.push_var_bytes(&peer_id);
    w.push_uleb128(start);
    w.push_uleb128(end);
    w.push_var_string(key_id);
    w.push_var_bytes(&iv);
    let header = w.finalize();

    // Expected AAD hex from spec: 00 || 04 01020304 || 01 || 03 || 02 6b31 || 0c iv
    let expected_aad = "0x0004010203040103026b310c86bcad09d5e7e3d70503a57e";
    assert_eq!(bytes_to_hex(&header), expected_aad);

    // Ciphertext||tag from spec (AES-GCM over plaintext with key/iv/AAD above)
    let ct = hex_to_bytes("0x6930a8fbe96cc5f30b67f4bc7f53262e01b62852");

    // Build full record = header || varBytes(ct)
    let mut w = BytesWriter::new();
    w.push_bytes(&header);
    w.push_var_bytes(&ct);
    let record = w.finalize();

    // Parse header to confirm fields and that AAD equals header bytes
    let parsed = parse_elo_record_header(&record).expect("parse delta");
    assert_eq!(parsed.kind, EloRecordKind::DeltaSpan);
    match parsed.header {
        EloHeader::Delta(h) => {
            assert_eq!(h.peer_id, peer_id);
            assert_eq!(h.start, start);
            assert_eq!(h.end, end);
            assert_eq!(h.key_id, key_id);
            assert_eq!(&h.iv[..], &iv[..]);
        }
        _ => panic!("expected delta header"),
    }
    assert_eq!(bytes_to_hex(parsed.aad), expected_aad);
    assert_eq!(parsed.ct, &ct[..]);

    // Also verify magic mapping exists (parity with TS)
    assert_eq!(CrdtType::Elo.magic_bytes(), *b"%ELO");
}

