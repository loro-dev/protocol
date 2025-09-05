// Send a real %ELO update using the EloLoroAdaptor and loro-crdt
// This ensures proper join ordering and avoids races with the server.
import { WebSocket as NodeWebSocket } from "ws";
import { LoroWebsocketClient } from "../client";
import { EloLoroAdaptor } from "loro-adaptors";
import { pathToFileURL } from "node:url";

function hexToBytes(s: string): Uint8Array {
  const src = s.startsWith("0x") ? s.slice(2) : s;
  const out = new Uint8Array(src.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(src.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function main() {
  const url = process.argv[2];
  const roomId = process.argv[3] ?? "room-elo";
  if (!url) throw new Error("usage: node dist/wrappers/send-elo-normative.js <ws_url> [roomId]");

  // Provide WebSocket implementation for the client in Node
  (globalThis as any).WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  console.log(`[wrapper] send-elo: connecting to ${url}, room=${roomId}`);

  // Deterministic 32-byte key (matches normative tests)
  const key = hexToBytes(
    "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  );

  const adaptor = new EloLoroAdaptor({
    getPrivateKey: async () => ({ keyId: "k1", key }),
  });

  const client = new LoroWebsocketClient({ url });
  await client.waitConnected();

  // Join and, once joined, produce a small local update which adaptor
  // will package as an %ELO container and send to the server.
  const room = await client.join({ roomId, crdtAdaptor: adaptor });
  console.log(`[wrapper] send-elo: joined, applying local change`);

  const doc = adaptor.getDoc();
  doc.getText("t").insert(0, "hi");
  doc.commit();

  // Give ample time to flush the update to the server before closing.
  console.log(`[wrapper] send-elo: waiting to flush update (800ms)`);
  await new Promise(res => setTimeout(res, 800));
  await room.destroy();
  console.log(`[wrapper] send-elo: done`);
  // Ensure process exits (client keeps WS/ping alive otherwise)
  process.exit(0);
}

// ESM entrypoint guard
const isEntrypoint = import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isEntrypoint) {
  // eslint-disable-next-line unicorn/prefer-top-level-await
  main().catch(err => { console.error(err); process.exit(1); });
}
