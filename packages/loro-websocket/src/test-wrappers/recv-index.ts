import { WebSocket } from "ws";
import { tryDecode, MessageType, encode, ProtocolMessage, CrdtType } from "loro-protocol";
import { pathToFileURL } from "node:url";

async function main() {
  const url = process.argv[2];
  const roomId = (process.argv[3] ?? "room-elo");
  if (!url) throw new Error("usage: node dist/test-wrappers/recv-index.js <ws_url> [roomId]");
  console.log(`[wrapper] recv-index connecting to ${url}, room=${roomId}`);
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const join: ProtocolMessage = { type: MessageType.JoinRequest, crdt: CrdtType.Elo, roomId: Buffer.from(roomId), auth: new Uint8Array(), version: new Uint8Array() } as any;
  ws.send(Buffer.from(await encode(join)));
  let ok = false;
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("timeout")), 10000);
    ws.on("message", (data: Buffer) => {
      const msg = tryDecode(new Uint8Array(data));
      if (!msg) return;
      if (msg.type === MessageType.JoinResponseOk) { ok = true; console.log(`[wrapper] recv-index joined ok`); }
      if (msg.type === MessageType.DocUpdate) {
        console.log(`[wrapper] recv-index received DocUpdate (${msg.updates.length})`);
        clearTimeout(to);
        try { ws.close(); } catch { }
        resolve();
      }
    });
  });
  if (!ok) throw new Error("no join ok");
  // Exit promptly so the test can proceed
  process.exit(0);
}

// ESM entrypoint guard
const isEntrypoint = import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isEntrypoint) {
  // eslint-disable-next-line unicorn/prefer-top-level-await
  main().catch(err => { console.error(err); process.exit(1); });
}
