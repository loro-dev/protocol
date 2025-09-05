import { VersionVector } from "loro-crdt";
import {
  bytesToHex,
  decodeEloContainer,
  encodeEloContainer,
  parseEloRecordHeader,
  EloRecordKind,
} from "loro-protocol";

export interface EloDeltaSpanIndexEntry {
  start: number; // inclusive
  end: number; // exclusive
  keyId: string;
  record: Uint8Array; // exact record bytes; server must not mutate
}

// An in-memory, server-side index for %ELO encrypted updates.
// The server never decrypts; it only validates headers and indexes
// delta-span coverage for backfill selection.
export class EloDoc {
  // Keyed by decoded peerId string; values kept sorted by start (ascending)
  private spansByPeer: Map<string, EloDeltaSpanIndexEntry[]> = new Map();
  private verbose: boolean;

  constructor(opts?: { verbose?: boolean }) {
    const envVerbose =
      typeof process !== "undefined" &&
      (process as any).env &&
      ((process as any).env.ELO_LOG === "1" ||
        (process as any).env.ELO_LOG === "true");
    this.verbose = !!(opts?.verbose ?? envVerbose);
  }

  indexBatch(batch: Uint8Array): { ok: true } | { ok: false; error: string } {
    let records: Uint8Array[];
    try {
      records = decodeEloContainer(batch);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    for (const rec of records) {
      let parsed;
      try {
        parsed = parseEloRecordHeader(rec);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }

      if (parsed.kind === EloRecordKind.DeltaSpan) {
        const hdr = parsed.header as import("loro-protocol").EloDeltaHeader;
        // Validate span and IV per spec
        const { start, end, iv } = hdr;
        if (!(end > start)) {
          return { ok: false, error: "Invalid ELO delta span: end must be > start" };
        }
        if (iv.length !== 12) {
          return { ok: false, error: "Invalid ELO delta span: IV must be 12 bytes" };
        }
        if (hdr.peerId.length > 64) {
          return { ok: false, error: "Invalid ELO delta span: peerId must be ≤ 64 bytes" };
        }
        if (parsed.keyId && new TextEncoder().encode(parsed.keyId).length > 64) {
          return { ok: false, error: "Invalid ELO delta span: keyId must be ≤ 64 bytes" };
        }

        const peerKey = this.peerKeyFromBytes(hdr.peerId);
        const list = this.spansByPeer.get(peerKey) ?? [];

        // Fast path: append at end if ordered and no need to prune
        if (list.length === 0 || list[list.length - 1]!.start <= start) {
          // Remove any fully covered spans with start >= start
          const kept = this.filterCoveredFromIndex(list, start, end);
          kept.push({ start, end, keyId: parsed.keyId, record: rec });
          this.spansByPeer.set(peerKey, kept);
          if (this.verbose) {
            console.info("[ELO] indexed-delta", {
              peerId: peerKey,
              start,
              end,
              keyId: parsed.keyId,
            });
          }
          continue;
        }

        // General path: binary insert by start; prune covered entries [start, end]
        const left = this.lowerBound(list, start);
        const before = left > 0 ? list.slice(0, left) : [];
        const after = this.filterCoveredFromIndex(list.slice(left), start, end);
        const next = before;
        next.push({ start, end, keyId: parsed.keyId, record: rec });
        for (const e of after) next.push(e);
        this.spansByPeer.set(peerKey, next);
        if (this.verbose) {
          console.info("[ELO] indexed-delta", {
            peerId: peerKey,
            start,
            end,
            keyId: parsed.keyId,
          });
        }
      } else if (parsed.kind === EloRecordKind.Snapshot) {
        // Snapshot: validate IV length; do not store; server does not need to backfill snapshots
        if (parsed.iv.length !== 12) {
          return { ok: false, error: "Invalid ELO snapshot: IV must be 12 bytes" };
        }
        if (parsed.keyId && new TextEncoder().encode(parsed.keyId).length > 64) {
          return { ok: false, error: "Invalid ELO snapshot: keyId must be ≤ 64 bytes" };
        }
        // no-op
        if (this.verbose) {
          console.info("[ELO] received-snapshot", { keyId: parsed.keyId });
        }
      }
    }

    return { ok: true };
  }

  getVersionBytes(): Uint8Array {
    // Derive VV as max end per peer from indexed spans
    const vvMap = new Map<`${number}`, number>();
    for (const [peer, spans] of this.spansByPeer.entries()) {
      let maxEnd = 0;
      for (const s of spans) if (s.end > maxEnd) maxEnd = s.end;
      if (maxEnd > 0 && /^\d+$/.test(peer)) vvMap.set(peer as `${number}`, maxEnd);
    }
    const vv = new VersionVector(vvMap);
    return vv.encode();
  }

  selectBackfillBatches(requesterVersion: Uint8Array): Uint8Array[] {
    // Decode requester VV; unknown/invalid => treat as empty
    let requester: VersionVector | undefined;
    try {
      if (requesterVersion && requesterVersion.length > 0) {
        requester = VersionVector.decode(requesterVersion);
      }
    } catch {
      requester = undefined;
    }

    // Build a flat list of records to send where end > known counter for that peer
    const records: Uint8Array[] = [];
    for (const [peer, spans] of this.spansByPeer.entries()) {
      const key: number | bigint | `${number}` =
        /^\d+$/.test(peer) ? (peer as `${number}`) : 0;
      const known = requester ? Number(requester.get(key) ?? 0) : 0;
      for (const s of spans) {
        if (s.end > known) records.push(s.record);
      }
    }
    if (records.length === 0) return [];
    // Package into a single batch (protocol calls this a container)
    if (this.verbose) {
      const vvEntries = requester ? [...requester.toJSON().entries()].length : 0;
      console.info("[ELO] select-backfill", {
        requesterVvEntries: vvEntries,
        recordCount: records.length,
      });
    }
    return [encodeEloContainer(records)];
  }

  private peerKeyFromBytes(peerId: Uint8Array): string {
    try {
      // Prefer UTF-8 for Loro peer IDs (numeric strings)
      return new TextDecoder().decode(peerId);
    } catch {
      // Fallback to hex if not valid UTF-8
      return bytesToHex(peerId);
    }
  }

  private lowerBound(list: EloDeltaSpanIndexEntry[], start: number): number {
    // First index with e.start >= start
    let lo = 0,
      hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid]!.start < start) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private filterCoveredFromIndex(
    list: EloDeltaSpanIndexEntry[],
    start: number,
    end: number
  ): EloDeltaSpanIndexEntry[] {
    // Keep entries not fully covered by [start, end]
    const kept: EloDeltaSpanIndexEntry[] = [];
    for (const e of list) {
      const covered = e.start >= start && e.end <= end;
      if (!covered) kept.push(e);
    }
    return kept;
  }
}
