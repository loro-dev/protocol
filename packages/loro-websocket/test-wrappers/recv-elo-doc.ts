import { WebSocket as NodeWebSocket } from "ws";
import { LoroWebsocketClient } from "../src/client";
import { EloAdaptor } from "loro-adaptors/loro";
import { pathToFileURL } from "node:url";

function hexToBytes(s: string): Uint8Array {
  const src = s.startsWith("0x") ? s.slice(2) : s;
  const out = new Uint8Array(src.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(src.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function main() {
  const url = process.argv[2];
  const roomId = process.argv[3] ?? "room-elo";
  const expected = process.argv[4] ?? "hi";
  if (!url)
    throw new Error(
      "usage: tsx test-wrappers/recv-elo-doc.ts <ws_url> [roomId] [expected]"
    );
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  console.log(`[wrapper] recv-elo-doc: connecting to ${url}, room=${roomId}`);

  const key = hexToBytes(
    "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  );
  const adaptor = new EloAdaptor({
    getPrivateKey: async () => ({ keyId: "k1", key }),
  });
  const client = new LoroWebsocketClient({ url });
  await client.waitConnected();
  const room = await client.join({ roomId, crdtAdaptor: adaptor });

  // Poll doc content until match or timeout
  const doc = adaptor.getDoc();
  const start = Date.now();
  const timeoutMs = 5000;
  while (Date.now() - start < timeoutMs) {
    const s = doc.getText("t").toString();
    if (s === expected) {
      console.log(`[wrapper] recv-elo-doc: content matches: ${s}`);
      await room.destroy();
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 50));
  }
  console.error(
    `[wrapper] recv-elo-doc: timeout without matching content. got="${doc.getText("t").toString()}" expected="${expected}"`
  );
  await room.destroy();
  process.exit(1);
}

const scriptArg = process.argv[1];
const isEntrypoint =
  typeof scriptArg === "string" &&
  import.meta.url === pathToFileURL(scriptArg).href;
if (isEntrypoint) {
  // eslint-disable-next-line unicorn/prefer-top-level-await
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
