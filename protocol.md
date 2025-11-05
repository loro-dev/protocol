# Loro Syncing Protocol

Protocol version: 0.

It is the application's responsibility to ensure Req and Recv use the same protocol version.

This protocol is designed to be easy to implement and general-purpose, so it can be used across different languages and platforms.

It can be used for WebSocket connections as well as P2P connections such as WebRTC. It assumes that the underlying transport guarantees message integrity.

It can be used to sync Loro or Yjs documents, but it does not address collection-level synchronization.

A single connection can multiplex several rooms.

Each message includes the room ID.

Exception: the protocol also defines two out‑of‑band keepalive frames, "ping" and "pong", sent as WebSocket text frames, which do not carry magic bytes, room id, or a message envelope. See Keepalive: Ping/Pong.

## Message Format

- The first 4 bytes are magic bytes that indicate the CRDT type:
  - "%LOR": Loro Document
  - "%EPH": [Loro Ephemeral Store](https://loro.dev/docs/api/js#ephemeralstore)
  - "%EPS": Persisted Loro Ephemeral Store (marks data that should be stored server-side so new peers can hydrate immediately)
  - "%YJS": Yjs
  - "%YAW": Yjs Awareness
  - "%FLO": Flock Document
  - ...
- Followed by a `varBytes` room ID (maximum 128 bytes).
  - If two room IDs are the same but the CRDT types differ, they refer to different rooms.
- Followed by a byte for the message type.
- Payload, which depends on the message type.
- Message size should not exceed 256 KB.

Implementations use `%EPS` when the ephemeral payloads must survive beyond a single client session. Tagging frames with this CRDT
type tells the server to persist the latest store so that future peers can immediately download the full state instead of waiting
for another client to resend their presence data.

Note: Keepalive frames are special and bypass this envelope entirely. When the entire frame payload is exactly the text string "ping" or "pong" (WebSocket text frames), it MUST be treated as a keepalive and NOT parsed using the fields above. See Keepalive: Ping/Pong.

## Terminology

- Req (Requester): the client side of a WebSocket connection.
- Recv (Receiver): the server side of a WebSocket connection.
- varBytes: a variable-length byte array. It starts with a LEB128 uint.
- varString: a variable-length UTF-8 string. It starts with a LEB128 uint.
- varUint: LEB128 uint.

## Message Types

- 0x00: JoinRequest.
  - `varBytes` authentication payload for the target room.
  - `varBytes` for the requester's document version.
- 0x01: JoinResponseOk.
  - `varString` permission: "read" | "write".
  - `varBytes` for the receiver's document version.
  - `varBytes` for extra metadata
- 0x02: JoinError.
  - 1-byte error code. See Errors.
  - `varString` message (human-friendly).
  - Optional: for `version_unknown`, append `varBytes` receiver version.
- 0x03: DocUpdate.
  - `varUint` N.
  - N `varBytes`.
- 0x04: DocUpdateFragmentHeader.
  - 8-byte ID for this batch of fragments.
  - `varUint` fragment count
  - `varUint` total payload size in bytes
- 0x05: DocUpdateFragment.
  - 8-byte ID for this batch of fragments.
  - `varUint` nth fragment.
  - `varBytes` update fragment.
- 0x06: UpdateError.
  - 1-byte error code. See Errors.
  - `varString` message (human-friendly).
  - Optional: for `fragment_timeout`, append 8-byte batch ID.
- 0x07: Leave. Unsubscribe from the room.

## Syncing Process

Req sends a `JoinRequest` to Recv.

- If authentication fails, Recv sends `JoinError(code=0x02 auth_failed)`.
- If authentication succeeds but the version is unknown, Recv sends `JoinError(code=0x01 version_unknown)` and includes its version.
- If authentication succeeds, Recv sends `JoinResponseOk` with its latest known version of the document. Recv may then send the updates missing from Req through `DocUpdate` or `DocUpdateFragment` messages.

When Recv receives updates in the same room from other peers, it broadcasts them to all the other peers through `DocUpdate` or `DocUpdateFragment` messages.

When Req makes local edits on the document, it sends `DocUpdate` or `DocUpdateFragment` messages to Recv.

- If Req doesn't have permission to edit the document, an `UpdateError(code=0x03 permission_denied)` is sent to Req.

Req sends `Leave` if it is no longer interested in updates for the target document.

### Update Fragments

It is usually not efficient to send a large document without splitting it into fragments. Some platforms, such as Cloudflare Durable Objects, also impose hard limits (for example, a maximum WebSocket message size of 1 MB in Cloudflare).

This protocol limits message size to 256 KB. Large updates must be split into fragments of up to 256 KB each. The default reassembly timeout is 10 seconds.

If Recv times out waiting for remaining fragments of a batch, it MUST:

- Discard all partial fragments for that batch ID.
- Send `UpdateError(code=0x07 fragment_timeout)` with the 8-byte batch ID so Req can resend.

Upon receiving `fragment_timeout`, Req SHOULD resend the whole batch (header + all fragments) with the same or a new batch ID.

## Errors

Two error message types with small numeric codes for clarity and easy parsing.

### JoinError (0x02)

- Fields: 1-byte `code`, `varString message`.
- Extras: for `version_unknown` include `varBytes receiver_version`.

Codes:

- 0x00 unknown: unspecified error.
- 0x01 version_unknown: cannot interpret provided version. Extra: `receiver_version`.
- 0x02 auth_failed: authentication/authorization failed.
- 0x7F app_error: Extra `varString app_code` (free-form, e.g., `quota_exceeded`).

### UpdateError (0x06)

- Fields: 1-byte `code`, `varString message`.

Codes:

- 0x00 unknown: unspecified error.
- 0x03 permission_denied: requester has no write permission.
- 0x04 invalid_update: update payload is malformed or rejected.
- 0x05 payload_too_large: a single message or reassembled update exceeded limits.
- 0x06 rate_limited: sender is rate limited.
- 0x07 fragment_timeout: timed out waiting for remaining fragments. Extra: 8-byte `batch_id`.
- 0x7F app_error: Extra `varString app_code` (free-form, e.g., `quota_exceeded`).

### Local (non-message) issues

- Protocol violations may be reported to the host application via a callback and may result in closing the connection.

### Library hook (optional)

Implementations may expose `onError({ roomId, kind, code, message, app_code? })` where `kind` is `join` or `update` based on the message type.

## Keepalive: Ping/Pong (Out‑of‑Band)

Some environments (e.g., browsers) do not expose transport‑level WebSocket ping/pong to applications. To support liveness checks and idle connection keepalive at the application layer, this protocol reserves two special frames that bypass the normal message envelope:

- Format: The entire frame payload is exactly the text `"ping"` or `"pong"` sent as WebSocket text frames (no magic bytes, no room id, no type byte, no length prefixes). Binary frames MUST NOT be used for keepalive.
- Direction: Either side MAY send `"ping"` at any time. The receiver MUST reply with `"pong"` promptly.
- Scope: Keepalive frames are connection‑scoped and MUST NOT be associated with any room. They MUST NOT be forwarded, broadcast, or delivered to application handlers as document updates.
- Parsing: A frame whose payload is exactly `"ping"` or `"pong"` MUST be handled as keepalive and MUST NOT be parsed as a protocol message.
- Rate limiting: Implementations MAY rate‑limit excessive keepalive traffic.
- Timeouts: Applications MAY use `ping`/`pong` round‑trip time to detect dead connections and reconnect.

Implementation note: On platforms that support automatic responses (e.g., Cloudflare Durable Objects), servers MAY configure an auto‑response mapping `ping -> pong` to avoid waking application logic for keepalive traffic.
