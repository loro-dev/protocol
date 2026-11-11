use loro_protocol::{encode, BatchId, CrdtType, ProtocolMessage};
use std::{hint::black_box, time::Instant};

fn main() {
    for &(count, bytes) in &[(1, 32), (1, 4096), (64, 1024), (1, 240 * 1024)] {
        let message = ProtocolMessage::DocUpdate {
            crdt: CrdtType::Loro,
            room_id: "benchmark-room".into(),
            batch_id: BatchId([7; 8]),
            updates: vec![vec![42; bytes]; count],
        };
        let expected = encode(&message).unwrap();
        assert_eq!(loro_protocol::decode(&expected).unwrap(), message);
        let iterations = if bytes > 100_000 { 2000 } else { 10_000 };
        let mut samples = Vec::new();
        for _ in 0..15 {
            let start = Instant::now();
            for _ in 0..iterations {
                black_box(encode(black_box(&message)).unwrap());
            }
            samples.push(start.elapsed().as_nanos() / iterations);
        }
        samples.sort_unstable();
        println!(
            "count={count} payload={bytes} encoded={} median_ns={} p95_ns={}",
            expected.len(),
            samples[7],
            samples[14]
        );
    }
}
