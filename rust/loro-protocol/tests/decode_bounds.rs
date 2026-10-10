use loro_protocol::{
    decode, decode_elo_container, parse_elo_record_header, BytesReader, BytesWriter, EloRecordKind,
};

#[test]
fn overflowing_varint_is_not_silently_truncated() {
    // The tenth byte can contain only bit 63. A payload of 2 overflows u64.
    let mut bytes = vec![0x80; 9];
    bytes.push(2);
    assert!(BytesReader::new(&bytes).read_uleb128().is_err());
    let mut writer = BytesWriter::new();
    writer.push_uleb128(u64::MAX);
    assert_eq!(
        BytesReader::new(&writer.finalize()).read_uleb128().unwrap(),
        u64::MAX
    );
}

#[test]
fn impossible_update_count_returns_error_without_panicking() {
    let mut writer = BytesWriter::new();
    writer.push_bytes(b"%LOR");
    writer.push_var_string("x");
    writer.push_byte(3); // DocUpdate
    writer.push_uleb128(u64::MAX);
    writer.push_bytes(&[0; 8]);
    let bytes = writer.finalize();
    assert!(decode(&bytes).is_err());
}

#[test]
fn impossible_encrypted_record_count_returns_error_without_panicking() {
    let mut writer = BytesWriter::new();
    writer.push_uleb128(u64::MAX);
    assert!(decode_elo_container(&writer.finalize()).is_err());
}

#[test]
fn impossible_encrypted_snapshot_vector_returns_error_without_panicking() {
    let mut writer = BytesWriter::new();
    writer.push_byte(EloRecordKind::Snapshot as u8);
    writer.push_uleb128(u64::MAX);
    assert!(parse_elo_record_header(&writer.finalize()).is_err());
}
