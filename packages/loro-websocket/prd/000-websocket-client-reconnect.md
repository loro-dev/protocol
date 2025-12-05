# WebSocket Client Reconnect

Purpose: describe the desired reconnect behavior for the browser/node client in a concise, implementation‑agnostic way.

## Goals
- Stay connected across transient network issues without user code handling retries.
- Avoid tight retry loops when offline or after fatal server closes.
- Provide predictable hooks so apps can show status and react to failures.

## Connection Model
- States: `connecting`, `connected`, `reconnecting`, `disconnected`, `error`.
- The client starts connecting immediately. Any disconnection while retrying is allowed moves to `reconnecting`; fatal conditions move to `disconnected`.
- A single promise (`waitConnected`) always resolves on the next successful transition to `connected`; it is renewed on each reconnect attempt.

## Retry Policy
- Enabled by default; exponential backoff starting at ~0.5s, capped around 15s, with jitter (~25%) to prevent herding.
- Retries continue indefinitely unless a maximum attempt count is configured.
- Fatal stop conditions halt retries (e.g., permission/auth failures, explicit fatal close codes or reasons). After a fatal stop, the client remains `disconnected` until manually retried.

## Liveness & Half‑Open Detection
- Periodic application‑level pings are sent while connected.
- Missing pongs trigger a controlled close with a liveness reason, which then enters the normal backoff flow. This prevents silent half‑open sockets.

## Offline Behavior
- When the environment reports offline, active retries are paused and the socket is closed cleanly.
- When coming back online, a reconnect is scheduled immediately (backoff resets unless disabled).

## Join Handling
- `join` calls issued while the socket is not yet open are enqueued and flushed after connect.
- The queue is unbounded by design; applications concerned about backpressure should gate their own join volume.
- Each join exposes optional per‑room status callbacks: `connecting`, `joined`, `reconnecting`, `disconnected`, `error`.

## Room Rejoin
- Successfully joined rooms are tracked (room id + CRDT type + auth bytes).
- After reconnect, the client automatically resends JoinRequest for each tracked room.
- If a rejoin fails fatally, the room moves to `error` and is removed from the tracked set so callers can decide next steps.

## Manual Controls
- `connect({ resetBackoff?: boolean })` or `retryNow()` starts/forces a reconnect and optionally resets backoff.
- `close()` stops auto‑reconnect and transitions to `disconnected`; callers must explicitly reconnect afterwards.

## Observability Hooks
- Client status listener: notifies transitions among the top‑level states.
- Per‑room status listener: notifies the per‑room states listed above.
- Optional latency callback fed by ping RTT measurements.

## Success Criteria
- Retries pause while offline and resume promptly when online.
- Missing pongs or half‑open links recover via reconnect.
- Fatal closes stop retries; manual retry is still possible.
- Queued joins do not throw and complete once connected; failed rejoins surface as `error` so apps can respond.
