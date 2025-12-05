//! `%ELO` container and record header parsing (no crypto).
//! Mirrors the TypeScript implementation in `packages/loro-protocol/src/e2ee.ts`
//! for container decode and plaintext header parsing. This module is intentionally
//! crypto-free; consumers can use the parsed `aad` (exact header bytes) and `iv`
//! with their own AES-GCM bindings if desired.
//! NOTE: `%ELO` support on the Rust side is work-in-progress; only the container
//! and header parsing surface is considered stable today.

use crate::bytes::BytesReader;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EloRecordKind {
    DeltaSpan = 0x00,
    Snapshot = 0x01,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EloDeltaHeader {
    pub peer_id: Vec<u8>,
    pub start: u64,
    pub end: u64,
    pub key_id: String,
    pub iv: [u8; 12],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EloSnapshotHeader {
    pub vv: Vec<(Vec<u8>, u64)>,
    pub key_id: String,
    pub iv: [u8; 12],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EloHeader {
    Delta(EloDeltaHeader),
    Snapshot(EloSnapshotHeader),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedEloRecord<'a> {
    pub kind: EloRecordKind,
    pub header: EloHeader,
    /// Exact header bytes as encoded on the wire; use as AAD for AES-GCM.
    pub aad: &'a [u8],
    /// Ciphertext bytes (ct||tag), as-is from the wire.
    pub ct: &'a [u8],
}

/// Decode an ELO container into a list of record byte slices.
/// The returned slices borrow from `data`.
pub fn decode_elo_container<'a>(data: &'a [u8]) -> Result<Vec<&'a [u8]>, String> {
    let mut r = BytesReader::new(data);
    let n = usize::try_from(r.read_uleb128()?).map_err(|_| "length too large".to_string())?;
    let mut out: Vec<&[u8]> = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(r.read_var_bytes()?);
    }
    if r.remaining() != 0 {
        return Err("ELO container has trailing bytes".into());
    }
    Ok(out)
}

/// Parse a single ELO record's plaintext header, returning header metadata, AAD
/// (the exact header bytes), and a view of the ciphertext bytes.
pub fn parse_elo_record_header<'a>(record: &'a [u8]) -> Result<ParsedEloRecord<'a>, String> {
    let mut r = BytesReader::new(record);
    let kind_byte = r.read_byte()?;
    match kind_byte {
        0x00 => parse_delta(&mut r, record),
        0x01 => parse_snapshot(&mut r, record),
        _ => Err(format!("Unknown ELO record kind: 0x{:02x}", kind_byte)),
    }
}

fn parse_delta<'a>(
    r: &mut BytesReader<'a>,
    record: &'a [u8],
) -> Result<ParsedEloRecord<'a>, String> {
    let peer_id = r.read_var_bytes()?.to_vec();
    let start = r.read_uleb128()?;
    let end = r.read_uleb128()?;
    let key_id = r.read_var_string()?;
    let iv_bytes = r.read_var_bytes()?;
    let aad_len = r.position();
    let ct = r.read_var_bytes()?;
    if r.remaining() != 0 {
        return Err("ELO record trailing bytes".into());
    }

    // Invariants
    if end <= start {
        return Err("Invalid ELO delta span: end must be > start".into());
    }
    if iv_bytes.len() != 12 {
        return Err("Invalid ELO delta span: IV must be 12 bytes".into());
    }
    if peer_id.len() > 64 {
        return Err("Invalid ELO delta span: peerId too long".into());
    }
    if key_id.as_bytes().len() > 64 {
        return Err("Invalid ELO delta span: keyId too long".into());
    }

    let mut iv = [0u8; 12];
    iv.copy_from_slice(iv_bytes);

    Ok(ParsedEloRecord {
        kind: EloRecordKind::DeltaSpan,
        header: EloHeader::Delta(EloDeltaHeader {
            peer_id,
            start,
            end,
            key_id,
            iv,
        }),
        aad: &record[..aad_len],
        ct,
    })
}

fn parse_snapshot<'a>(
    r: &mut BytesReader<'a>,
    record: &'a [u8],
) -> Result<ParsedEloRecord<'a>, String> {
    let count =
        usize::try_from(r.read_uleb128()?).map_err(|_| "vv length too large".to_string())?;
    let mut vv: Vec<(Vec<u8>, u64)> = Vec::with_capacity(count);
    for _ in 0..count {
        let pid = r.read_var_bytes()?.to_vec();
        let ctr = r.read_uleb128()?;
        vv.push((pid, ctr));
    }
    let key_id = r.read_var_string()?;
    let iv_bytes = r.read_var_bytes()?;
    let aad_len = r.position();
    let ct = r.read_var_bytes()?;
    if r.remaining() != 0 {
        return Err("ELO record trailing bytes".into());
    }

    if iv_bytes.len() != 12 {
        return Err("Invalid ELO snapshot: IV must be 12 bytes".into());
    }
    if key_id.as_bytes().len() > 64 {
        return Err("Invalid ELO snapshot: keyId too long".into());
    }
    // vv should be sorted by peer_id bytes ascending
    if !is_sorted_by_bytes(&vv) {
        return Err("Invalid ELO snapshot: vv not sorted by peer id bytes".into());
    }

    let mut iv = [0u8; 12];
    iv.copy_from_slice(iv_bytes);

    Ok(ParsedEloRecord {
        kind: EloRecordKind::Snapshot,
        header: EloHeader::Snapshot(EloSnapshotHeader { vv, key_id, iv }),
        aad: &record[..aad_len],
        ct,
    })
}

fn is_sorted_by_bytes(vv: &[(Vec<u8>, u64)]) -> bool {
    vv.windows(2).all(|w| {
        let a = &w[0].0;
        let b = &w[1].0;
        compare_bytes(a, b) <= 0
    })
}

fn compare_bytes(a: &[u8], b: &[u8]) -> i32 {
    let n = a.len().min(b.len());
    for i in 0..n {
        let da = a[i];
        let db = b[i];
        if da != db {
            return (da as i32) - (db as i32);
        }
    }
    (a.len() as i32) - (b.len() as i32)
}
