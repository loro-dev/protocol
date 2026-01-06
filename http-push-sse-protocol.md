# HTTP Push + SSE Transport Profile (Loro Syncing Protocol)

Transport profile version: 0. Extends `protocol.md` (Protocol v1) without changing the binary wire format.

This document describes a transport mapping that uses:

- **HTTP push** for client → server frames (request body carries a single protocol frame).
- **SSE (Server‑Sent Events)** for server → client frames (each SSE event carries a single protocol frame).

The goal is to reuse all message types, fragmentation rules, and semantics from `protocol.md`, while allowing two common exchanges to be handled as simple **HTTP request/response** pairs:

- `JoinRequest` → `JoinResponseOk` / `JoinError`
- `DocUpdate` / `DocUpdateFragment*` → `Ack`

## Non‑Goals

- Defining specific HTTP routes, parameters, or auth schemes. These are application decisions.
- Providing reliable replay for SSE on reconnect (out of scope). Clients rejoin to recover.

## Terminology

- **Protocol frame**: the exact bytes produced by `encode(message)` from `loro-protocol` (and parsed by `decode(bytes)`).
- **Session key**: an application-defined opaque identifier that binds one client's push requests to its SSE stream.
  - It can be carried via cookie, header, query parameter, etc.
  - The transport must ensure the same session key is used for both directions.

## Core Invariants (Unchanged from `protocol.md`)

- The binary protocol frame format is unchanged.
- Message types and semantics are unchanged (`JoinRequest`, `DocUpdate`, fragments, `Ack`, `RoomError`, `Leave`, …).
- **Max frame size is still 256 KiB**. Payloads that would exceed the limit MUST use fragmentation.

## Frame Encodings

### HTTP push (client → server)

- Request body: a single protocol frame (binary).
- Recommended headers:
  - `Content-Type: application/octet-stream`
  - `Content-Length: <frame size>`
- Push responses MAY return a protocol frame (binary) when the exchange is naturally request/response:
  - `JoinRequest` → `JoinResponseOk` / `JoinError`
  - `DocUpdate` / fragments completing a batch → `Ack`

For other push messages (e.g., `Leave`), the response body can be empty.

### SSE pull (server → client)

SSE is text-based, so each binary protocol frame is encoded as base64url.

Event format:

```
event: msg
data: <base64url(protocol-frame)>

```

Notes:

- **Exactly one protocol frame per SSE event**.
- `data:` MAY be split across multiple lines; SSE concatenates them with `\n`. Implementations SHOULD either:
  - emit a single `data:` line, or
  - split into multiple `data:` lines and base64url‑decode after concatenation with `\n` removed.

Base64url:

- RFC 4648 "base64url" (`-` and `_` instead of `+` and `/`).
- Padding (`=`) is OPTIONAL; decoders SHOULD accept both forms.

## Session Binding

Because HTTP requests are stateless and SSE is a long-lived stream, implementations MUST bind them with a session key.

The transport profile does not dictate how, but it MUST satisfy:

- A push request can be associated with exactly one logical session.
- A server can route room broadcasts to all sessions that have joined that room.

Security note: if the session key is sensitive, prefer cookie/header transport over query strings (URLs are often logged).

## Request/Response Simplifications

### Join handshake (`JoinRequest` → `JoinResponse*`)

Recommended pattern:

1. Client issues a push with a `JoinRequest` frame.
2. Server responds in the same HTTP response body with:
   - `JoinResponseOk`, or
   - `JoinError`.
3. After `JoinResponseOk`, server MAY send backfills (`DocUpdate` or fragments) over SSE.

Rationale: SSE reconnections can drop in-flight frames; making join responses part of the push response avoids depending on SSE delivery guarantees.

### Client-originated updates (`DocUpdate*` → `Ack`)

Recommended pattern:

- For `DocUpdate` (single frame):
  - Client pushes `DocUpdate`.
  - Server MUST respond with `Ack` (binary) in the HTTP response body.

- For fragmented updates (`DocUpdateFragmentHeader` + `DocUpdateFragment`):
  - Client pushes the header and fragments.
  - Server MUST emit exactly one `Ack` per batch ID, referencing the batch ID.
  - It is RECOMMENDED that the `Ack` is returned as the HTTP response to the push that completes the batch
    (typically the final fragment).
  - Server MAY return an early non‑OK `Ack` when it can reject immediately (not joined, permission denied, rate limited, etc.).

After accepting and applying a client update, the server broadcasts it to other sessions joined to the room via SSE:

- Broadcast is typically `DocUpdate` with the same `batchId`, or the original fragments if fragmentation was used.
- The sender does not need to receive its own update (implementation choice).

## Client Handling of Server Frames (SSE)

- Server-originated updates and backfills arrive on SSE as `event: msg` frames.
- The client processes them exactly as it would process WebSocket binary frames.

Ack directionality:

- Clients SHOULD NOT send `Ack(status=0x00)` for server-originated updates (same reasoning as `protocol.md` WebSocket directionality).
- Clients MAY send a non‑zero `Ack` via HTTP push if they fail to apply a server update (e.g., `invalid_update`, `fragment_timeout`).

## Keepalive

The `"ping"`/`"pong"` out-of-band keepalive in `protocol.md` is specific to WebSocket text frames.

For SSE:

- Implementations MAY send periodic SSE comments as heartbeats, e.g. `:keepalive\n\n`.
- Heartbeats MUST NOT be parsed as protocol frames and MUST NOT be forwarded to rooms.

## Ordering and Concurrency

HTTP push requests can arrive concurrently, which can break assumptions about fragment ordering.

Recommendations:

- Serialize push handling per session key.
- Enforce that `DocUpdateFragmentHeader` is observed before accepting fragments for that batch (or buffer until header arrives).
- Use existing batch IDs as the correlation key for both fragments and `Ack`.

## Loss Recovery on SSE Reconnect

This profile assumes SSE can disconnect without replay. To recover:

- Clients SHOULD treat an SSE reconnect as a connection reconnect.
- Clients SHOULD re-issue `JoinRequest` for each active room with their current version so the server can backfill missing updates.

## Compatibility

- Works for all CRDT magic types defined in `protocol.md` (including `%ELO` from `protocol-e2ee.md`).
- `%ELO` payload semantics remain unchanged; only the transport encoding differs.

