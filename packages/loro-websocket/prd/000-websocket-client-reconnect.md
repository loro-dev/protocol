# PRD 000 — Stabilize WebSocket Client Reconnect

## Problem
- Auto‑reconnect works in simple cases but is brittle in degraded networks and offers little visibility. Developers see flapping status events, stuck “connected” sockets that no longer deliver data, and endless retry loops after auth kicks or offline transitions.
- The current API exposes only coarse `onStatusChange` and a low‑level `onWsClose()` without context, making it hard to debug, alert, or build UX around reconnect.

## Current Behavior (as implemented)
- Initial connect fires in the constructor; subsequent reconnects are scheduled with exponential backoff: 0.5s, 1s, 2s … capped at 15s (`src/client/index.ts:430-437`).
- Reconnect is controlled by a boolean `shouldReconnect`; it is only flipped to `false` for close codes 4400‑4499 or reasons `permission_changed` / `room_closed` (`src/client/index.ts:365-377`).
- Offline handling clears the timer and closes the socket, but does **not** block the next reconnect timer that will be scheduled by the ensuing `close` event (`src/client/index.ts:451-459`).
- Pings measure latency but never trigger a reconnect on missing pongs; half‑open connections stay in `Connected` forever (`src/client/index.ts:1095-1141`).
- Joins issued while the socket is still CONNECTING send immediately; in Node’s `ws` this throws, rejecting the join but leaving client state inconsistent (`src/client/index.ts:871-880`).
- No jitter in backoff → concurrent clients herd after an outage.
- No visibility hooks for reconnect attempts, reasons, backoff delay, or per‑room rejoin results; `onWsClose` lacks the `CloseEvent`.

## Observed / Potential Failure Modes
1) **Offline loop**: `handleOffline()` closes the socket, `onSocketClose()` immediately schedules a retry even though the device is offline, causing tight retry/error loops and battery/CPU churn.  
2) **Fatal kicks retry forever**: Server close codes like 1008/1011 or application errors keep auto‑retrying because only 440x and two strings are treated as fatal. This spams auth, logs, and server.  
3) **Half‑open stall**: If the TCP path drops without a FIN (common on captive portals / mobile), the socket stays “open”; no pongs arrive, but the client never transitions to Disconnected or triggers backoff.  
4) **Join during CONNECTING**: Calling `join` before `waitConnected()` can throw in Node, leaving `pendingRooms` populated and adapters without context.  
5) **Thundering herd**: Identical backoff without jitter means many clients reconnect in lockstep after outages.  
6) **Weak observability**: Callers can’t answer “why did we reconnect?”, “what attempt/delay are we on?”, “was rejoin successful?”, or “what close code did we get?”. Debugging relies on console noise.

## Goals
- Make reconnect predictable across offline/online transitions, server kicks, and half‑open links.
- Provide API hooks and telemetry to let applications surface health, analytics, and UX cues.
- Preserve back‑compat by keeping defaults close to today’s behavior, but safer.

## Non‑Goals
- Rewriting the server or changing wire protocol.
- Adding persistence or storage for reconnect state.

## Proposed Design (kept minimal)

1) **Small reconnect policy**
   - `reconnect?: { enabled?: boolean; initialDelayMs?: number; maxDelayMs?: number; jitter?: number; maxAttempts?: number | "infinite"; fatalCloseCodes?: number[]; fatalCloseReasons?: string[] }`
   - Defaults keep today’s timing (500ms start, cap 15s, jitter 0.25) and infinite retries.
   - `maxAttempts` stays supported; callers can set a finite ceiling, otherwise `"infinite"`.
   - Fatal closes (4400‑4499, 1008, 1011, `permission_changed`, `room_closed`, `auth_failed`) stop auto‑retry; caller can still call `retryNow()`.

2) **Ping-based liveness**
   - If two consecutive pings miss (`pingTimeoutMs` default 10s), forcibly close with reason `ping_timeout` and enter backoff. Prevents half‑open stalls.

3) **Offline pause**
   - While `navigator.onLine === false`, do not schedule retries. When `online` fires, schedule immediately. No extra backstop timer to keep behavior predictable.

4) **Safer join during connect**
   - Queue join requests while the socket is CONNECTING; flush on OPEN. (“Pending joins” = `join()` calls made before the socket is ready.)

5) **Manual reconnect**
   - Add `retryNow()` (alias `connect({ resetBackoff: true })`) to attempt immediately and reset backoff. Also re-enables auto-retry if it had stopped.

6) **Room rejoin resilience**
   - Keep an `activeRooms` registry (roomId + crdt) for rooms that were successfully joined.
   - On reconnect, automatically resend JoinRequest for every active room; include original auth bytes.
   - If rejoin fails (fatal join error), emit a rejoin failure event and leave the room unjoined; caller can decide to retry or surface UI.
   - Pending joins (issued while CONNECTING) remain queued and flush on OPEN; successful joins add to `activeRooms`.

7) **Per-room status callbacks**
   - `join` accepts `onStatusChange?: (status) => void` where status ∈ `connecting | joined | reconnecting | disconnected | error`.
   - Transitions:
     - `connecting`: initial join or queued join flushing.
     - `joined`: join/rejoin success.
     - `reconnecting`: socket closed unexpectedly and room queued for auto-rejoin.
     - `disconnected`: reconnects disabled (fatal close/maxAttempts/close()).
     - `error`: join/rejoin failure (e.g., auth denied); room is removed from active set so callers can rejoin manually.

## UX / API Back‑Compat
- Defaults mimic today’s timing and infinite retries; jitter and fatal code handling are additive improvements.
- Existing `onStatusChange` continues to work; new states (`reconnecting`) will be documented but won’t break existing string comparisons (add to `ClientStatus` map).
- `onWsClose` kept but now receives the `CloseEvent` for parity; deprecated in docs in favor of `onClose`.

## Acceptance Criteria
- Reconnect pauses while offline; resumes immediately on `online`.
- Fatal kicks (440x, 1008/1011, auth strings) do **not** auto‑retry unless caller calls `retryNow()`.
- Half‑open sockets are detected by ping timeout and recover via reconnect.
- Joins issued during connect do not throw and complete once connected or fail with a clear error.
- Minimal API surface: no new event fan‑out beyond `onStatusChange` and `retryNow()`.

## Testing Plan
- Unit: backoff jitter math, classifyClose matrix, join queuing during CONNECTING, half‑open ping timeout transition.
- E2E:
  - server stop/start with offline events → reconnect after online.
  - server closes with 1008 → no retry by default.
  - missing pongs → forced reconnect.
  - many clients (N≥20) reconnect → ensure jitter prevents synchronized attempts.
- Regression: existing e2e reconnection and offline tests must still pass with defaults.

## Open Questions
- Do we need a queue limit or backpressure strategy for joins during CONNECTING, or is unbounded queuing acceptable given typical usage?
