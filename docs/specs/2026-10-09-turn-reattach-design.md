# Re-attach to a running turn — Design

**Date:** 2026-10-09 · **Status:** Proposed · **ADR:** [ADR-0040](../adrs/0040-detachable-turns.md) ·
**Issue:** [#471](https://github.com/rossoctl/moca/issues/471)
**Builds on (reuse, no redesign):** [ADR-0029](../adrs/0029-turn-sse-streaming.md) /
[turn-sse-streaming-design](2026-08-26-turn-sse-streaming-design.md) (the `/v1/turn` SSE
representation, `sseExtension`, the lazily-flushing frame writer);
[ADR-0034](../adrs/0034-vm-process-manager-socket-handoff.md) /
[p6-vm-process-manager-design](2026-09-08-p6-vm-process-manager-design.md) (supervisor, workers,
`load` reports, drain); [ADR-0036](../adrs/0036-tui-decoupled-http-client.md) /
[mocactl-control-plane-client-design](2026-09-25-mocactl-control-plane-client-design.md) (`ActiveSession`,
the transcript cache §6.6, no server-side turn serialization §2.6).
**Amends:** turn-sse-streaming-design §3.6 and its "no resumable/replayable stream" non-goal, for
turns that opt in.

## 1. Problem

Quit `mocactl` while a turn is streaming, reopen it, resume the session: the reply is cut off where you
quit, and only a new prompt ("go on") moves the session on. The output you expected to find was never
produced.

Today (`rossoctl/main` @ `0555d7f`):

- One turn lives exactly as long as one HTTP connection. `handleTurnStream`
  (`packages/knative-server/src/server.ts:324`) aborts the turn when the response closes early
  (`res.on('close')` → `ac.abort()` → `wireAbort` → `session.abort()`, `harness/src/run-turn.ts:1035`).
  The session resumes at its last durable checkpoint; work in flight at disconnect is lost.
- Frames carry no id (`server.ts:313` writes `event:` and `data:` only), and nothing records them
  server-side, so there is nothing to resume from.
- Esc and a dropped connection are the same signal: `ActiveSession.cancel()` aborts the fetch
  (`packages/mocactl/src/core/session-manager.ts:80`).
- `mocactl` rebuilds history from its local transcript (`core/transcripts.ts`), which ends where the
  client went away. #472 adds a notice saying the last turn is not running.
- A reconnect can land on a different process: up to five Knative pods, or any P6 worker under the
  default `leastInFlight` policy. `mocactl` never sends `X-SH-Session-Id`, so `stickyBySession` does
  not apply.
- Nothing serializes turns of one session server-side, yet `RedisSessionBackend` documents itself as
  single-writer-per-session (`packages/session-backend/src/redis-backend.ts:7-13`).
- The async prompt path (ADR-0028, `kind:"prompt"` leaves) is refused for authenticated callers
  (`server.ts:886-898`) and emits no frames, so it cannot serve an interactive user.

### Acceptance (from #471, as scoped here)

1. Quit `mocactl` mid-turn, reopen, resume: the output produced while away appears, then the turn
   streams on to its terminal frame. No prompt is needed.
2. Esc cancels the running turn server-side, whether or not the client stays connected.
3. Opening the session on a second device shows the same live turn.
4. A gated live smoke covers disconnect, reattach, and cancel against a deployed P6 runtime.

## 2. Decision summary

- **Detachable turns, opt-in per turn.** `POST /v1/turn` with `"detachable": true` (authenticated, SSE,
  and `SH_TURN_DETACH=1` on the harness) runs a turn that a disconnect does not abort. Everything else
  keeps today's semantics.
- **A per-turn Redis Stream is the event log.** The owning process writes every frame to its own
  connection and to `sh:turn:<sid>:<turnId>:events`. The stream entry id is the SSE `id:`.
- **`GET /v1/turn?sessionId=` re-attaches.** On any process: replay from `Last-Event-ID`, then follow
  live to the terminal frame. A finished turn stays replayable for `SH_TURN_LOG_TTL_S` (24 h).
- **`POST /v1/turn/cancel` is the cancel.** Disconnect means "detach" for a detachable turn.
- **One live turn per session**, held by a renewed Redis lease. A second detachable turn gets `409
turn_in_progress`.
- **The client decides at quit time.** `mocactl` asks: keep the turn running in the background, or
  cancel it.
- **A turn nobody watches is capped:** it aborts after `SH_TURN_DETACHED_MAX_S` (30 min) unwatched;
  re-attaching resets the clock.
- **P6 only (vm, compose, k8s).** Knative keeps today's behavior; see §3.

## 3. Alternatives considered

- **A buffer in the owning process, routed to by the supervisor.** Fails when a reconnect reaches
  another pod, and the buffer dies with the process. Rejected.
- **Redis Pub/Sub instead of a Stream.** Frames published between disconnect and reattach are gone.
  Rejected.
- **Interactive turns as async leaves (#168) plus an event stream.** Reuses the queue's durability, but
  adds queue latency to every interactive turn and reopens the leaf path to authenticated callers.
  Far larger change to the turn model. Rejected for this slice; the per-turn log could later serve
  leaves too.
- **Grace-then-abort (keep a turn alive N minutes for a reconnect).** Smaller, but a user who quits
  deliberately and returns later finds nothing. The detached-time cap gives the same protection
  against forgotten turns without that loss.
- **Knative in this slice.** The autoscaler counts open requests. A detached turn holds none, so its
  pod reads as idle and can be scaled to zero mid-turn; `server.close` on SIGTERM waits only for
  open connections. Making that safe (holding a request open from inside the pod, or min-scale and
  KEDA rules) is its own design. Deferred to a follow-up issue. Without `SH_TURN_DETACH=1`, a Knative
  revision ignores `detachable`, and clients fall back (§7).

## 4. Wire contract

### 4.1 `POST /v1/turn` gains `detachable`

Request body: `{ sessionId, prompt, detachable?: boolean }`.

`detachable` is honored when all of these hold; otherwise it is ignored and the turn behaves exactly
as today:

- the request carries a session token that `resolveTurnAuth` accepts;
- it asks for SSE (`Accept: text/event-stream`);
- the harness runs with `SH_TURN_DETACH=1`.

A detachable turn's stream differs in three ways:

1. **A `turn` frame comes first:** `event: turn` / `data: {"type":"turn","turnId":"…","sessionId":"…"}`.
   Its presence is the capability signal; there is no separate probe. The turn id is a
   `randomUUID()` minted by the owner. `turn` joins the `TurnStreamFrame` union
   (`harness/src/turn-stream.ts`) and `mocactl`'s `TurnFrame` (`src/api/frames.ts`); it is not
   terminal.
2. **Every frame carries `id: <turnId>:<entryId>`**, where `entryId` is the frame's Redis Stream entry
   id (§5.2). The `turn` frame's id names the turn's first entry.
3. **Closing the connection does not abort the turn.**

Clients that do not send `detachable` never see the `turn` frame or `id:` lines. The lazy flush is
unchanged: a pre-first-frame failure still returns the sync path's status and JSON. The lease (§5.1)
is taken before the first frame, so `409` and `503` keep real status codes too.

### 4.2 `GET /v1/turn?sessionId={sid}` — attach

SSE. Header `Last-Event-ID: <turnId>:<entryId>` is optional.

- Resolves the session's current turn through `sh:turn:<sid>:last` (§5.2).
- If `Last-Event-ID` names that turn, replays the entries after `entryId`; otherwise replays the turn
  from its first entry.
- Starts with the `turn` frame. It carries `truncated: true` when the cursor is older than the first
  retained entry (the stream was trimmed, §5.2) and replay starts at the first retained entry.
- Then follows the live turn (`XREAD BLOCK`) until the terminal `done`/`error` frame, and ends the
  response.
- A turn already finished replays to its terminal frame and ends at once.
- `404 {"error":"turn_not_found"}` when the session has no retained turn.

Authorization mirrors `GET /runs/status` (`authorizeRunRead`, `turn-auth.ts:282`): verify the session
token, require `sid` equal to `sessionId`, no credential exchange. While connected, the attach
refreshes the turn's watch key (§5.3).

### 4.3 `POST /v1/turn/cancel`

Body: `{ sessionId, turnId? }`. Requires a session token with `turn:write` and `sid` equal to
`sessionId`.

- `202 {"turnId":"…","outcome":"requested"|"ended"}`: the cancel was requested of the running turn
  (`requested`), or the turn `turnId` names had already ended (`ended`, a no-op).
- `409 {"error":"turn_mismatch","turnId":"<running>"}`: `turnId` was given and names a different turn
  than the running one, so a stale cancel cannot kill a newer turn.
- `404 {"error":"turn_not_found"}`: no running or retained turn.

The terminal frame (`error`, `stopReason: "aborted"`) reaches the log and every watcher through the
normal path (§5.4).

### 4.4 One live turn per session

- A detachable `POST /v1/turn` while the session holds a live lease (§5.1) gets `409
{"error":"turn_in_progress","turnId":"<running>"}`.
- With `SH_TURN_DETACH=1`, every `/v1/turn` checks the lease before its first frame, so a
  non-detachable turn for a session whose detachable turn is running also gets that `409`. This is
  the only change existing callers can observe, and only once a detachable client uses the session.
- Non-detachable turns do not take the lease. Concurrent non-detachable turns behave as today.

### 4.5 Routes on the harness's own resource

The routes hang off `/v1/turn`, not `/v1/sessions/{sid}/…`: the control plane owns `/v1/sessions/*`
(`packages/control-plane/src/routes.ts:87-123`), and the two are separate origins only by
configuration. `isTurnRequest` (`packages/knative-server/src/worker.ts:47`) matches `POST` on exact
paths, so neither new route counts as a turn by path; detachable turns are counted by their own
lifetime (§5.5).

## 5. Server lifecycle

New module `harness/src/turn-registry.ts` owns §5.1–§5.4 behind one interface:

```ts
interface TurnRegistry {
  begin(sessionId: string, ownerId: string): Promise<ActiveTurn>; // throws TurnInProgressError
  attach(sessionId: string, cursor?: string): AsyncGenerator<LoggedFrame>; // throws TurnNotFound
  cancel(sessionId: string, turnId?: string): Promise<CancelOutcome>;
}
interface ActiveTurn {
  turnId: string;
  append(frame: TurnStreamFrame): Promise<string>; // returns the SSE id
  watched(own: boolean): void; // owner's connection open/closed
  readonly signal: AbortSignal; // cancel, unwatched cap, lost lease
  end(terminal: TurnStreamFrame): Promise<void>; // writes terminal, releases lease
}
```

`handleTurnStream` uses it when the turn is detachable. `executeTurn` is untouched beyond the signal
it already accepts: the registry's `signal` replaces the disconnect-driven `AbortController`.

### 5.1 Active-turn lease

- Key `sh:turn:<sid>:active` holds JSON `{turnId, owner, startedAt, cancelRequested}`.
- Taken with `SET NX PX 30000` before the first frame. On conflict, `begin` throws
  `TurnInProgressError` carrying the holder's `turnId` → `409`.
- Renewed every 10 s by a Lua compare-and-set on `turnId`, so a renewal never extends another turn's
  lease.
- Released by `end`, after the terminal frame is written (compare-and-delete on `turnId`).
- **Owner crash:** the lease lapses within 30 s. Every attach checks the lease when it starts and at
  each watch refresh (§5.3). Finding no lease for a turn whose log has no terminal entry, it runs one
  Lua script that, atomically, re-checks both conditions and appends the synthetic terminal
  `{type:"error", stopReason:"aborted", errorMessage:"the harness process running this turn
stopped"}` and the `EXPIRE`s of `end`. Concurrent attaches therefore write it once, and each
  then reads it as the terminal frame. The session resumes from its last durable checkpoint, as
  today.
- **Renewal failure:** the owner keeps running until the lease would have lapsed, then aborts the
  turn. Two processes never both believe they own the session.

### 5.2 Event log

- Stream `sh:turn:<sid>:<turnId>:events`, one entry per frame, field `f` = the frame's JSON.
  `XADD … MAXLEN ~ 100000 *`.
- Pointer `sh:turn:<sid>:last` = `turnId`, set by `begin`.
- On `end`, both keys get `EXPIRE SH_TURN_LOG_TTL_S` (default 86400). While the turn runs, the stream
  has no TTL; the lease guarantees someone ends it or §5.1's crash path does.
- The frame written to the owner's own connection carries the id of its log entry, so a client moving
  from the original stream to an attach neither repeats nor skips frames.
- `XADD` failure mid-turn: the turn continues, the owner's connection still receives the frame (with no
  `id:`), and the failure is logged with the session and turn ids. An attach later may miss those
  frames. Accepted, not hidden.

### 5.3 Watchers and the detached-time cap

- The owner knows whether its own connection is open (`watched(own)`).
- Each attach connection, on any process, refreshes `sh:turn:<sid>:<turnId>:watch` (`SET PX 30000`,
  every 10 s) while connected.
- At each lease renewal the owner checks: unwatched = own connection closed and no watch key. After
  `SH_TURN_DETACHED_MAX_S` (default 1800) continuously unwatched, the owner aborts with
  `errorMessage: "turn unwatched for 30 min"` (the text uses the configured value).
- Any watcher resets the clock.

### 5.4 Cancel

- `POST /v1/turn/cancel` sets `cancelRequested` on the lease (Lua, compare on `turnId`) and
  `PUBLISH sh:turn:cancel <sid>:<turnId>`.
- Each process holds one subscriber connection to `sh:turn:cancel`. A message naming one of its turns
  aborts that turn's `signal` at once.
- The flag, read at each renewal, covers a missed message: cancel lands within 10 s at worst.
- The aborted turn ends through the normal path: `executeTurn` returns `stopReason: "aborted"`,
  `terminalFrame` maps it to `error`, `end` writes it.

### 5.5 Process accounting and drain (P6)

- A detachable turn counts in the worker's `TurnCounter` from `begin` to `end`, not from request to
  socket close, so `load` reports and `leastInFlight` routing see it.
- `drain()` stops new work as today. Detached turns run until the supervisor's shutdown grace
  (`SHUTDOWN_GRACE_MS`, 20 s). Turns still running at the deadline are aborted with
  `errorMessage: "harness restarting"`, and their terminal frame is written. Attach streams served by
  the draining worker end without a terminal frame; clients reconnect (§6.5) to another worker.
- The worker's IPC-disconnect exit path aborts detached turns the same way before exiting.
- The 20 s grace is unchanged. Long turns do not survive a restart, as attached turns do not today.
  Raising it toward systemd's and k8s's 120 s is a separate change.

### 5.6 Configuration

| Variable                      | Default | Meaning                                                                              |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `SH_TURN_DETACH`              | unset   | `1` honors `detachable`. Set in vm, compose, k8s configs.                            |
| `SH_TURN_DETACHED_MAX_S`      | 1800    | Unwatched time before a detachable turn is aborted.                                  |
| `SH_TURN_LOG_TTL_S`           | 86400   | Retention of a finished turn's log and `last` pointer.                               |
| `SH_TURN_REGISTRY_TIMEOUT_MS` | 5000    | Bound on begin, the first attach read, and cancel; past it, `503 redis_unavailable`. |

Wired into `deploy/compose/docker-compose.yml`, `deploy/vm/env/supervisor.env.example`, and
`deploy/k8s` (`moca-settings`, sticky like the other `SH_*` settings). Not into `deploy/knative`.
`SH_TURN_REGISTRY_TIMEOUT_MS` is a code default (it guards against a blackholed Redis) and is not
wired into any deployment.

## 6. `mocactl`

### 6.1 Sending a turn

- The TUI sends `detachable: true` on every turn. Headless mode (`mocactl run …`) does not in this
  slice, so Ctrl+C there still cancels.
- A `turn` frame marks the turn detachable: `ActiveSession` records its `turnId` and the last frame
  id. The block reducer ignores `turn` frames (no event block).
- `HarnessClient` gains `attach({sessionId, token, lastEventId, signal})` and
  `cancelTurn({sessionId, turnId?, token})`, which resolves with the `turnId` and `outcome` its `202`
  names. A bare `404` (a harness without the route) reads as `turn_not_found`, as on attach.
  `readSse` surfaces the `id:` field.

### 6.2 Transcript

- A new record `{kind:"turn", at, turnId}`, and frame records gain `eventId?`. Coalesced text and
  thinking deltas take the id of the last delta merged.
- `load` returns `lastTurnId` and `lastEventId`. Files written before this change load unchanged.
- A prompt is recorded once its own turn is accepted (its first frame), or when the turn ends
  without one. A `409`'s attach (§6.5) records the other device's turn before the prompt, as a `turn`
  entry with no prompt ahead of it: `turn T1 … T1 terminal, prompt P, turn T2 …`. It renders as a
  reply with no prompt, and its terminal counts toward usage like any other.
- Any `turn` entry, with or without a prompt before it, opens a turn: the last one is open (a
  resume re-attaches it) until a terminal frame follows.

### 6.3 Quit and switching sessions

When the running turn is detachable, quit (`/quit`, Ctrl+C) and switching sessions open an overlay:

```
a turn is running — k keep it running in the background · c cancel it · esc stay
```

- `k`: close the connection and leave (or switch).
- `c`: `cancelTurn`, then leave. A failed cancel shows an error and stays.
- Ctrl+C again while the overlay is up picks `k`, the non-destructive choice.

A turn that is not detachable (older harness, Knative) quits as today.

### 6.4 Esc

- Detachable: Esc calls `cancelTurn` and keeps reading until the terminal frame, rendered "■ cancelled"
  as now. Double Esc still clears the queue.
- Cancel call fails: notice "couldn't cancel — the turn keeps running", and the stream stays open.
- Not detachable: aborts the fetch, as today.
- Before the first frame: the server may already hold the lease (§5.1) and writes the `turn` frame
  lazily, so Esc keeps reading for up to 2 s (`PENDING_CANCEL_MS`).
  - A `turn` frame: cancel that turn, as above.
  - Any other frame (a harness without detachable turns): abort the fetch.
  - A refusal (`4xx`, `503`): the turn ends with it, and nothing sends it again.
  - No frame by the deadline: abort the fetch, then `POST /v1/turn/cancel` without a `turnId`.
    Closing a detachable request detaches the turn rather than cancelling it, so the abort alone
    would leave it running.
- The turnId-less cancel can land before `begin()`. `turn_not_found`, or a `202` for a turn that had
  already ended, is retried: 3 tries, 1.5 s apart. The `202`'s `outcome: "ended"` says so; from a
  server that sends no `outcome`, a `202` naming the last turn this client saw reads the same.
  - A `202` for a new turn: cancelled.
  - Every try finds no turn: no turn holds the session (the abort stopped it, or it never began).
    That is success, with no notice.
  - Any other failure: the "couldn't cancel" notice.
- Each try is bounded by the 5 s cancel timeout, so the cancel can take up to about 18 s in the worst
  case. The queue holds the next prompt until it settles, so a late try cannot cancel that prompt's
  turn. The leave overlay's `c` resolves the same way.
- Accepted risk: if the request never reached `begin()` and another device started a turn inside
  that window, the turnId-less cancel can cancel that turn.

### 6.5 Resume, reattach, and dropped streams

- `ActiveSession` gains an `attach` step, queued ahead of prompts. `SessionManager.resume` queues it
  with `lastEventId` from the transcript.
- Attached frames take the same path as a turn's: transcript append, then the reducer. A turn that
  finished while away replays its remaining frames through `done`, so both screen and transcript end
  complete.
- `404` (no turn, or a harness without the route): the attach step ends silently. The #472 notice
  still covers an open last turn.
- A stream of a detachable turn, original or attach, that ends without a terminal frame is reattached
  automatically with the last id: up to 5 tries, backoff 0.5 s doubling. Then `turn-end: error`
  ("lost the connection to the running turn — it may still be running; reopen the session to
  reattach").
- The budget is per drop: a try that delivered new frames restarts the count and the backoff. The
  `turn` frame every attach repeats first does not count as new.
- A dropped stream, a `502`/`503`/`504`, or `redis_unavailable` on the re-attach is retried (a worker
  drain, a gateway). Any other error ends the turn.
- `readSse` drops an event left without its closing blank line at EOF, id and all (the SSE spec's
  rule), so a re-attach never resumes after a frame it did not receive.
- `submit` answered `409 turn_in_progress` (another device's turn): attach to it, then send the
  prompt when it ends.
- `truncated: true` adds the notice "earlier output of this turn is no longer available".

## 7. Compatibility

| Client \ harness | P6 with `SH_TURN_DETACH=1`                                                | Older harness, or Knative                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Older mocactl    | Unchanged, except `409` while a detachable turn of the same session runs. | Unchanged.                                                                                                                                                                                                                                                                                      |
| curl and scripts | As above.                                                                 | Unchanged.                                                                                                                                                                                                                                                                                      |
| New mocactl      | Full feature.                                                             | No `turn` frame → today's behavior: Esc aborts, no quit overlay. An Esc with no frame for 2 s also sends the turnId-less cancel (§6.4): every try answers `404`, which reads as success with no notice, since the abort stopped the turn. Attach `404` → nothing to attach. #472 notice stands. |

## 8. Failure modes

| Failure                                  | Behavior                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Redis down when a detachable turn starts | `503` with `Retry-After` before the first frame; `mocactl` already retries on it.               |
| Redis down mid-turn                      | Log writes fail and are counted (§5.2); lease renewal fails → the owner aborts at lapse (§5.1). |
| Owner process crashes                    | Lease lapses ≤ 30 s; the next attach writes the synthetic terminal frame (§5.1).                |
| Worker drains                            | Detached turns aborted at the grace deadline with a terminal frame; attaches reconnect (§5.5).  |
| Client crashes or loses network          | The turn runs on under the unwatched cap (§5.3); the next resume attaches.                      |
| Cancel message missed                    | The lease flag aborts the turn at the next renewal, ≤ 10 s (§5.4).                              |
| Cursor older than the retained stream    | Replay from the first retained entry, `truncated: true` (§4.2).                                 |
| Log expired (`SH_TURN_LOG_TTL_S`)        | Attach `404`; the transcript and #472 notice remain.                                            |

## 9. Testing

- **`turn-registry` unit tests, real Redis:** lease take/renew/release and compare-and-set against a
  foreign `turnId`; lapse and the synthetic terminal, written once under two concurrent attaches;
  the unwatched clock with fake timers, reset by a watch key; cancel by Pub/Sub and by the flag alone;
  `truncated` replay after a trim; id format.
- **`knative-server` integration, real Redis:** two server instances on one Redis, one owning and one
  attaching; replay from a cursor then live follow; `409 turn_in_progress` for detachable and
  non-detachable second turns; cancel issued on the other instance; `detachable` ignored without
  `SH_TURN_DETACH`, without auth, and without SSE (golden bytes for the sync path unchanged).
- **Worker:** a detached turn stays counted after its socket closes; drain aborts it at the deadline
  with a terminal frame; IPC disconnect does the same.
- **`mocactl`:** transcript `turn`/`eventId` records and old files; the quit and switch overlay keys;
  Esc through `cancelTurn` and its failure notice; resume attach completing a finished turn; automatic
  reattach after a dropped stream, and the error after 5 tries; `409` then attach then send; fallback
  against a harness that sends no `turn` frame.
- **Gated live smoke on compose (`MOCA_DETACH_SMOKE=1`):** start a turn, drop the client, attach on a
  new connection, assert contiguous ids to `done`; then start a turn and cancel it through the route,
  asserting `stopReason: "aborted"`.

## 10. Scope — explicitly not building

- Knative support (follow-up issue; §3).
- Server-side session history for a device with no transcript beyond the current turn's log.
- Detachable turns in headless `mocactl`, and an `attach` subcommand.
- Raising the supervisor's 20 s shutdown grace.
- Detachable async leaves.

## 11. Ordering

1. `turn-registry` (lease, log, watch, cancel) with its unit tests.
2. Server: `detachable` on `/v1/turn`, `GET /v1/turn`, `POST /v1/turn/cancel`, `409`; integration tests.
3. Worker accounting and drain.
4. Deploy wiring of the three settings (compose, vm, k8s); the gated smoke.
5. `mocactl`: client methods and `id:` parsing, transcript records, attach step and reconnect, Esc,
   quit overlay.
6. Docs: ADR-0040, forward pointers from turn-sse-streaming-design §3.6 and its non-goal, endpoint docs.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
