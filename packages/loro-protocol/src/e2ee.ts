import { BytesReader, BytesWriter } from "./bytes";

// %ELO encrypted container & record helpers (browser/Node/CF-compatible)

export const EloRecordKind = {
  DeltaSpan: 0x00,
  Snapshot: 0x01,
} as const;
export type EloRecordKind = (typeof EloRecordKind)[keyof typeof EloRecordKind];

export interface EloDeltaHeader {
  kind: typeof EloRecordKind.DeltaSpan;
  peerId: Uint8Array; // raw bytes
  start: number; // inclusive
  end: number; // exclusive
  keyId: string;
  iv: Uint8Array; // 12 bytes
}

export interface EloSnapshotVVEntry {
  peerId: Uint8Array;
  counter: number;
}

export interface EloSnapshotHeader {
  kind: typeof EloRecordKind.Snapshot;
  vv: EloSnapshotVVEntry[]; // sorted by peerId bytes asc
  keyId: string;
  iv: Uint8Array; // 12 bytes
}

export type EloHeader = EloDeltaHeader | EloSnapshotHeader;

export interface ParsedEloRecordHeader {
  kind: EloRecordKind;
  header: EloHeader;
  keyId: string;
  iv: Uint8Array;
  ct: Uint8Array;
  headerBytes: Uint8Array; // exact encoded header per spec (AAD)
  aad: Uint8Array; // alias of headerBytes for clarity
}

// Container
export function encodeEloContainer(records: Uint8Array[]): Uint8Array {
  const w = new BytesWriter();
  w.pushUleb128(records.length);
  for (const rec of records) {
    w.pushVarBytes(rec);
  }
  return w.finalize();
}

export function decodeEloContainer(data: Uint8Array): Uint8Array[] {
  const r = new BytesReader(data);
  const n = r.readUleb128();
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    out.push(r.readVarBytes());
  }
  if (r.remaining !== 0) {
    throw new Error("ELO container has trailing bytes");
  }
  return out;
}

// Note: We intentionally reuse BytesReader/Writer; capture AAD via reader.position after reading IV.

export function parseEloRecordHeader(
  recordBytes: Uint8Array
): ParsedEloRecordHeader {
  const r = new BytesReader(recordBytes);
  const kind = r.readByte();
  if (kind === undefined) throw new Error("Empty ELO record");

  if (kind === EloRecordKind.DeltaSpan) {
    const peerId = r.readVarBytes();
    const startCounter = r.readUleb128();
    const endCounter = r.readUleb128();
    const keyId = r.readVarString();
    const iv = r.readVarBytes();
    const headerBytes = recordBytes.slice(0, r.position);
    const ct = r.readVarBytes();
    if (r.remaining !== 0) throw new Error("ELO record trailing bytes");
    const header: EloDeltaHeader = {
      kind: EloRecordKind.DeltaSpan,
      peerId,
      start: startCounter,
      end: endCounter,
      keyId,
      iv,
    };
    return {
      kind,
      header,
      keyId,
      iv,
      ct,
      headerBytes,
      aad: headerBytes,
    };
  } else if (kind === EloRecordKind.Snapshot) {
    const vvCount = r.readUleb128();
    const vv: EloSnapshotVVEntry[] = [];
    for (let j = 0; j < vvCount; j++) {
      const peerId = r.readVarBytes();
      const counter = r.readUleb128();
      vv.push({ peerId, counter });
    }
    const keyId = r.readVarString();
    const iv = r.readVarBytes();
    const headerBytes = recordBytes.slice(0, r.position);
    const ct = r.readVarBytes();
    if (r.remaining !== 0) throw new Error("ELO record trailing bytes");
    const header: EloSnapshotHeader = {
      kind: EloRecordKind.Snapshot,
      vv,
      keyId,
      iv,
    };
    return {
      kind,
      header,
      keyId,
      iv,
      ct,
      headerBytes,
      aad: headerBytes,
    };
  } else {
    throw new Error(`Unknown ELO record kind: ${kind}`);
  }
}

// Crypto helpers (Web Crypto across browsers/Node/CF Workers)
function getSubtle(): SubtleCrypto {
  const g: any = globalThis as any;
  if (g.crypto && g.crypto.subtle) return g.crypto.subtle as SubtleCrypto;
  throw new Error("Web Crypto not available in this environment");
}

// Ensure strict DOM BufferSource types without casts by copying into ArrayBuffer
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

export async function importAesGcmKey(key: Uint8Array): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array)) throw new Error("Key must be Uint8Array");
  if (key.length !== 16 && key.length !== 32) {
    throw new Error("AES-GCM key must be 16 or 32 bytes");
  }
  // Pass ArrayBuffer to satisfy BufferSource typing
  return await getSubtle().importKey("raw", toArrayBuffer(key), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export function randomIv12(): Uint8Array {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  return iv;
}

export async function aesGcmEncrypt(
  key: CryptoKey | Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const k = key instanceof Uint8Array ? await importAesGcmKey(key) : key;
  if (iv.length !== 12) throw new Error("IV must be 12 bytes");
  const res = await subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: aad ? toArrayBuffer(aad) : undefined },
    k,
    toArrayBuffer(plaintext)
  );
  // Web Crypto returns ciphertext||tag; store as-is per spec (tag is 16 bytes)
  return new Uint8Array(res);
}

export async function aesGcmDecrypt(
  key: CryptoKey | Uint8Array,
  iv: Uint8Array,
  ct: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const k = key instanceof Uint8Array ? await importAesGcmKey(key) : key;
  if (iv.length !== 12) throw new Error("IV must be 12 bytes");
  const res = await subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: aad ? toArrayBuffer(aad) : undefined },
    k,
    toArrayBuffer(ct)
  );
  return new Uint8Array(res);
}

// Build exact header bytes per spec
function encodeDeltaHeaderBytes(
  peerId: Uint8Array,
  start: number,
  end: number,
  keyId: string,
  iv: Uint8Array
): Uint8Array {
  const w = new BytesWriter();
  w.pushByte(EloRecordKind.DeltaSpan);
  w.pushVarBytes(peerId);
  w.pushUleb128(start);
  w.pushUleb128(end);
  w.pushVarString(keyId);
  w.pushVarBytes(iv);
  return w.finalize();
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const da = a[i]!;
    const db = b[i]!;
    if (da !== db) return da - db;
  }
  return a.length - b.length;
}

function encodeSnapshotHeaderBytes(
  vv: EloSnapshotVVEntry[],
  keyId: string,
  iv: Uint8Array
): Uint8Array {
  const w = new BytesWriter();
  w.pushByte(EloRecordKind.Snapshot);
  // Ensure vv is sorted by peerId bytes ascending (lexicographic) as required by the spec
  const vvSorted = [...vv].sort((a, b) => compareBytes(a.peerId, b.peerId));
  w.pushUleb128(vvSorted.length);
  for (const { peerId, counter } of vvSorted) {
    w.pushVarBytes(peerId);
    w.pushUleb128(counter);
  }
  w.pushVarString(keyId);
  w.pushVarBytes(iv);
  return w.finalize();
}

export interface EncryptDeltaSpanMeta {
  peerId: Uint8Array;
  start: number;
  end: number;
  keyId: string;
  iv?: Uint8Array; // optional; random if absent
}

export async function encryptDeltaSpan(
  plaintext: Uint8Array,
  meta: EncryptDeltaSpanMeta,
  key: CryptoKey | Uint8Array
): Promise<{ record: Uint8Array; headerBytes: Uint8Array; ct: Uint8Array }> {
  if (!(meta.end > meta.start)) {
    throw new Error("Invalid span: end must be > start");
  }
  const iv = meta.iv ?? randomIv12();
  const headerBytes = encodeDeltaHeaderBytes(
    meta.peerId,
    meta.start,
    meta.end,
    meta.keyId,
    iv
  );
  const ct = await aesGcmEncrypt(key, iv, plaintext, headerBytes);
  const w = new BytesWriter();
  w.pushBytes(headerBytes);
  w.pushVarBytes(ct);
  return { record: w.finalize(), headerBytes, ct };
}

export interface EncryptSnapshotMeta {
  vv: EloSnapshotVVEntry[];
  keyId: string;
  iv?: Uint8Array; // optional; random if absent
}

export async function encryptSnapshot(
  plaintext: Uint8Array,
  meta: EncryptSnapshotMeta,
  key: CryptoKey | Uint8Array
): Promise<{ record: Uint8Array; headerBytes: Uint8Array; ct: Uint8Array }> {
  const iv = meta.iv ?? randomIv12();
  const headerBytes = encodeSnapshotHeaderBytes(meta.vv, meta.keyId, iv);
  const ct = await aesGcmEncrypt(key, iv, plaintext, headerBytes);
  const w = new BytesWriter();
  w.pushBytes(headerBytes);
  w.pushVarBytes(ct);
  return { record: w.finalize(), headerBytes, ct };
}

export async function decryptEloRecord<
  T extends (keyId: string) => Promise<CryptoKey | Uint8Array>,
>(
  recordBytes: Uint8Array,
  getKey: T
): Promise<
  | {
      kind: typeof EloRecordKind.DeltaSpan;
      header: EloDeltaHeader;
      plaintext: Uint8Array;
    }
  | {
      kind: typeof EloRecordKind.Snapshot;
      header: EloSnapshotHeader;
      plaintext: Uint8Array;
    }
> {
  const parsed = parseEloRecordHeader(recordBytes);
  const key = await getKey(parsed.keyId);
  const pt = await aesGcmDecrypt(key, parsed.iv, parsed.ct, parsed.aad);
  if (parsed.kind === EloRecordKind.DeltaSpan) {
    return {
      kind: EloRecordKind.DeltaSpan,
      header: parsed.header as EloDeltaHeader,
      plaintext: pt,
    };
  } else {
    return {
      kind: EloRecordKind.Snapshot,
      header: parsed.header as EloSnapshotHeader,
      plaintext: pt,
    };
  }
}
