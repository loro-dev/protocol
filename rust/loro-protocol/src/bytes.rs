/// Simple growable buffer writer with helpers for the protocol primitives.
///
/// This mirrors the JavaScript implementation's `BytesWriter` from
/// `packages/loro-protocol/src/bytes.ts`.
pub struct BytesWriter {
    buf: Vec<u8>,
}

impl BytesWriter {
    #[must_use]
    pub fn new() -> Self {
        Self { buf: Vec::with_capacity(32) }
    }

    #[inline]
    pub fn push_bytes(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    #[inline]
    pub fn push_byte(&mut self, byte: u8) {
        self.buf.push(byte);
    }

    /// Encode an unsigned LEB128 integer (sufficient for lengths and indices here).
    pub fn push_uleb128(&mut self, mut n: u64) {
        loop {
            let byte = (n & 0x7f) as u8;
            n >>= 7;
            if n == 0 {
                self.push_byte(byte);
                break;
            }
            self.push_byte(byte | 0x80);
        }
    }

    #[inline]
    pub fn push_var_bytes(&mut self, bytes: &[u8]) {
        self.push_uleb128(bytes.len() as u64);
        self.push_bytes(bytes);
    }

    #[inline]
    pub fn push_var_string(&mut self, s: &str) {
        self.push_var_bytes(s.as_bytes());
    }

    #[inline]
    #[must_use]
    pub fn finalize(self) -> Vec<u8> {
        self.buf
    }

    #[inline]
    #[must_use]
    pub fn len(&self) -> usize { self.buf.len() }

    #[inline]
    #[must_use]
    pub fn is_empty(&self) -> bool { self.buf.is_empty() }
}

impl Default for BytesWriter {
    fn default() -> Self { Self::new() }
}

pub struct BytesReader<'a> {
    buf: &'a [u8],
    off: usize,
}

impl<'a> BytesReader<'a> {
    #[must_use]
    pub fn new(buf: &'a [u8]) -> Self { Self { buf, off: 0 } }

    #[inline]
    #[must_use]
    pub fn remaining(&self) -> usize { self.buf.len().saturating_sub(self.off) }

    pub fn read_byte(&mut self) -> Result<u8, String> {
        if self.off >= self.buf.len() {
            return Err("readByte out of bounds".into());
        }
        let b = self.buf[self.off];
        self.off += 1;
        Ok(b)
    }

    pub fn read_bytes(&mut self, len: usize) -> Result<&'a [u8], String> {
        if self.off.checked_add(len).is_some_and(|e| e <= self.buf.len()) {
            let start = self.off;
            self.off += len;
            Ok(&self.buf[start..start+len])
        } else {
            Err("readBytes out of bounds".into())
        }
    }

    /// Decode an unsigned LEB128 into u64, guarding against excessive shifts.
    pub fn read_uleb128(&mut self) -> Result<u64, String> {
        let mut result: u64 = 0;
        let mut shift: u32 = 0;
        loop {
            let byte = self.read_byte()?;
            result |= u64::from(byte & 0x7f) << shift;
            if (byte & 0x80) == 0 { break; }
            shift += 7;
            if shift > 63 { return Err("uleb128 too large".into()); }
        }
        Ok(result)
    }

    pub fn read_var_bytes(&mut self) -> Result<&'a [u8], String> {
        let len = usize::try_from(self.read_uleb128()?)
            .map_err(|_| "length too large".to_string())?;
        self.read_bytes(len)
    }

    pub fn read_var_string(&mut self) -> Result<String, String> {
        let bytes = self.read_var_bytes()?;
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| "invalid UTF-8 string".to_string())
    }

    /// Current cursor position (number of bytes consumed so far).
    #[inline]
    pub fn position(&self) -> usize { self.off }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_uleb128() {
        let values: [u64; 14] = [
            0, 1, 2, 10, 127, 128, 129, 255, 256, 16383, 16384, 0xffff, 0x1f_ffff, 0x0fff_ffff,
        ];
        let mut w = BytesWriter::new();
        for &n in &values { w.push_uleb128(n); }
        let buf = w.finalize();
        let mut r = BytesReader::new(&buf);
        let mut out = Vec::new();
        for _ in 0..values.len() { out.push(r.read_uleb128().unwrap()); }
        assert_eq!(out, values);
        assert_eq!(r.remaining(), 0);
    }

    #[test]
    fn round_trip_varbytes_and_varstring() {
        let empty: Vec<u8> = vec![];
        let small: Vec<u8> = vec![1,2,3,4,5];
        let mut large: Vec<u8> = vec![0; 5000];
        for (i, b) in large.iter_mut().enumerate() { *b = (i & 0xff) as u8; }

        let mut w = BytesWriter::new();
        w.push_var_bytes(&empty);
        w.push_var_bytes(&small);
        w.push_var_bytes(&large);
        w.push_var_string("hello 世界 🚀");
        let buf = w.finalize();

        let mut r = BytesReader::new(&buf);
        assert_eq!(r.read_var_bytes().unwrap(), &empty[..]);
        assert_eq!(r.read_var_bytes().unwrap(), &small[..]);
        assert_eq!(r.read_var_bytes().unwrap(), &large[..]);
        assert_eq!(r.read_var_string().unwrap(), "hello 世界 🚀");
        assert_eq!(r.remaining(), 0);
    }
}
