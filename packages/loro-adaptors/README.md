# loro-adaptors

Adaptors that bridge the Loro protocol to `loro-crdt` documents and the ephemeral store. Includes an end‑to‑end encrypted adaptor for %ELO.

## Install

```bash
pnpm add loro-adaptors loro-protocol loro-crdt
```

## Why

The websocket client (`loro-websocket`) speaks the binary wire protocol. These adaptors connect that client to concrete CRDT state:

- `LoroAdaptor`: wraps a `LoroDoc` and streams local updates to the connection; applies remote updates on receipt
- `LoroEphemeralAdaptor`: wraps an `EphemeralStore` for transient presence/cursor data
- `EloLoroAdaptor`: wraps a `LoroDoc` and packages updates into %ELO containers with AES‑GCM; decrypts inbound containers and imports plaintext.

## Usage

```ts
import { LoroWebsocketClient } from "loro-websocket";
import {
  LoroAdaptor,
  LoroEphemeralAdaptor,
  EloLoroAdaptor,
} from "loro-adaptors";
import { LoroDoc, EphemeralStore } from "loro-crdt";

const client = new LoroWebsocketClient({ url: "ws://localhost:8787" });
await client.waitConnected();

// Plain Loro document
const doc = new LoroDoc();
doc.setPeerId(1); // configure the underlying document directly
const docAdaptor = new LoroAdaptor(doc);
const roomDoc = await client.join({ roomId: "demo", crdtAdaptor: docAdaptor });

// Ephemeral presence
const eph = new EphemeralStore(30_000);
const ephAdaptor = new LoroEphemeralAdaptor(eph);
const roomEph = await client.join({ roomId: "demo", crdtAdaptor: ephAdaptor });

// %ELO (end‑to‑end encrypted Loro)
const key = new Uint8Array(32);
const elo = new EloLoroAdaptor({
  getPrivateKey: async () => ({ keyId: "k1", key }),
});
const secure = await client.join({ roomId: "secure-room", crdtAdaptor: elo });

// Edits
doc.getText("content").insert(0, "hello");
doc.commit();

// Cleanup
await roomEph.destroy();
await roomDoc.destroy();
await secure.destroy();
```

## API

- `new LoroAdaptor(doc?: LoroDoc, config?: { onImportError?, onUpdateError? })`
- `new LoroEphemeralAdaptor(store?: EphemeralStore)`
- `new EloLoroAdaptor(docOrConfig: LoroDoc | { getPrivateKey, ivFactory?, onDecryptError?, onUpdateError? })`
  - `getPrivateKey: (keyId?) => Promise<{ keyId: string, key: CryptoKey | Uint8Array }>`
  - Optional `ivFactory()` for testing (12‑byte IV)

Notes (E2EE)

- IV must be 12 bytes and unique per key. The `ivFactory` is for tests only.
- The server never decrypts; it indexes plaintext headers to select backfill.

## Development

```bash
pnpm build
pnpm test
pnpm typecheck
```

## License

MIT
