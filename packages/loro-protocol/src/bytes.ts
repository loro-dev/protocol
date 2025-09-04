export class BytesWriter {
  private buf: Uint8Array = new Uint8Array(32);
  private len: number = 0;

  private reserve(size: number) {
    if (this.len + size <= this.buf.length) {
      return;
    }

    let nextLen = nextPow2u32(size + this.len);
    const buf = this.buf;
    this.buf = new Uint8Array(nextLen);
    this.buf.set(buf, 0);
  }

  pushBytes(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }

    this.reserve(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  pushByte(byte: number) {
    this.reserve(1);
    this.buf[this.len] = byte;
    this.len += 1;
  }

  pushUleb128(n: number) {
    do {
      this.pushByte((n & 0x7f) | (n >= 128 ? 0x80 : 0));
      n >>>= 7;
    } while (n > 0);
  }

  pushVarBytes(bytes: Uint8Array): void {
    this.pushUleb128(bytes.length);
    this.pushBytes(bytes);
  }

  pushVarString(str: string): void {
    const enc = new TextEncoder();
    const bytes: Uint8Array = enc.encode(str);
    this.pushVarBytes(bytes);
  }

  finalize(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  get length(): number {
    return this.len;
  }
}

export class BytesReader {
  private buf: Uint8Array;
  private offset: number = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  get position(): number {
    return this.offset;
  }

  readByte(): number {
    if (this.offset >= this.buf.length) {
      throw new Error("readByte out of bounds");
    }
    const v = this.buf[this.offset]!;
    this.offset += 1;
    return v;
  }

  readBytes(len: number): Uint8Array {
    if (len < 0 || this.offset + len > this.buf.length) {
      throw new Error("readBytes out of bounds");
    }
    const out = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  readUleb128(): number {
    let result = 0;
    let shift = 0;
    // Up to 5 bytes is enough for 32-bit lengths; protocol sizes are small.
    while (true) {
      const byte = this.readByte();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;
      if (shift > 35) {
        // Prevent pathological inputs from shifting indefinitely.
        throw new Error("uleb128 too large");
      }
    }
    return result >>> 0;
  }

  readVarBytes(): Uint8Array {
    const len = this.readUleb128();
    return this.readBytes(len);
  }

  readVarString(): string {
    const bytes = this.readVarBytes();
    const dec = new TextDecoder();
    return dec.decode(bytes);
  }
}

export function nextPow2u32(n: number): number {
  let x = n >>> 0;
  x |= x >>> 1;
  x |= x >>> 2;
  x |= x >>> 4;
  x |= x >>> 8;
  x |= x >>> 16;
  x = (x + 1) >>> 0;
  return x === 0 ? 0x1_0000_0000 : x;
}
