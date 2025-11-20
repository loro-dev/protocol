# loro-adaptors

Adaptors that bridge the Loro protocol to `loro-crdt` documents, `flock` replicas, and the ephemeral store. Includes an end‑to‑end encrypted adaptor for %ELO.

## Install

```bash
pnpm add loro-adaptors loro-protocol

# If using loro-crdt:
pnpm add loro-crdt

# If using flock:
pnpm add @loro-dev/flock

# If using yjs:
pnpm add yjs
```

## Why

The websocket client (`loro-websocket`) speaks the binary wire protocol. These adaptors connect that client to concrete CRDT state:

- `LoroAdaptor`: wraps a `LoroDoc` and streams local updates to the connection; applies remote updates on receipt
- `LoroEphemeralAdaptor`: wraps an `EphemeralStore` for transient presence/cursor data
- `LoroPersistentStoreAdaptor`: wraps an `EphemeralStore` but marks updates as persisted so the server stores them for new peers
- `EloAdaptor`: wraps a `LoroDoc` and packages updates into %ELO containers with AES‑GCM; decrypts inbound containers and imports plaintext.
- `FlockAdaptor`: wraps a `Flock` replica and streams local updates to the connection; applies remote updates on receipt.
- `YjsAwarenessServerAdaptor`: handles Yjs awareness updates on the server side (opaque blob merging).

## Usage

### Loro

```ts
import { LoroWebsocketClient } from "loro-websocket";
import {
  LoroAdaptor,
  LoroEphemeralAdaptor,
  LoroPersistentStoreAdaptor,
  EloAdaptor,
} from "loro-adaptors/loro"; // Import from "loro-adaptors/loro" to avoid pulling in unused peer dependencies
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

// Persisted presence that should be available to late joiners
const persistedStore = new EphemeralStore(30_000);
const persistedAdaptor = new LoroPersistentStoreAdaptor(persistedStore);
const roomPersisted = await client.join({
  roomId: "demo-persisted",
  crdtAdaptor: persistedAdaptor,
});

// %ELO (end‑to‑end encrypted Loro)
const key = new Uint8Array(32);
const elo = new EloAdaptor({
  getPrivateKey: async () => ({ keyId: "k1", key }),
});
const secure = await client.join({ roomId: "secure-room", crdtAdaptor: elo });

// Edits
doc.getText("content").insert(0, "hello");
doc.commit();

// Cleanup
await roomEph.destroy();
await roomDoc.destroy();
await roomPersisted.destroy();
await secure.destroy();
```

### Flock

```ts
import { LoroWebsocketClient } from "loro-websocket";
import { FlockAdaptor } from "loro-adaptors/flock"; // Import from "loro-adaptors/flock"
import { Flock } from "@loro-dev/flock";

const client = new LoroWebsocketClient({ url: "ws://localhost:8787" });
await client.waitConnected();

const flock = new Flock();
const adaptor = new FlockAdaptor(flock);
const room = await client.join({ roomId: "flock-demo", crdtAdaptor: adaptor });
```

### YJS Awareness

```ts
import { YjsAwarenessServerAdaptor } from "loro-adaptors/yjs";
// This is primarily for server-side use or specific awareness integration
```

## API

- `loro-adaptors/loro`
  - `new LoroAdaptor(doc?: LoroDoc, config?: { onImportError?, onUpdateError? })`
  - `new LoroEphemeralAdaptor(store?: EphemeralStore)`
  - `new LoroPersistentStoreAdaptor(store?: EphemeralStore)`
  - `new EloAdaptor(docOrConfig: LoroDoc | { getPrivateKey, ivFactory?, onDecryptError?, onUpdateError? })`
- `loro-adaptors/flock`
  - `new FlockAdaptor(flock: Flock, config?: { onImportError?, onUpdateError? })`
- `loro-adaptors/yjs`
  - `new YjsAwarenessServerAdaptor()`

## Development

```bash
pnpm build
pnpm test
pnpm typecheck
```

## License

MIT