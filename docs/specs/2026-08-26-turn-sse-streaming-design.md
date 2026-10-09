# Streaming `/turn` Responses (SSE) — Design

Version: 1.0 — August 26, 2026
Status: Proposed
Scope: Add a **streaming response mode** to `POST /turn`, selected by content negotiation
(`Accept: text/event-stream`), that surfaces assistant-text deltas, thinking deltas, and tool-call
events **live** as Server-Sent Events — while the default (non-streaming) `/turn` JSON contract stays
byte-for-byte unchanged. Realizes [issue #167](https://github.com/rossoctl/serverless-harness/issues/167).
Builds on (reuse, no redesign): the shared `executeTurn` turn core and its extension-factory wiring
([`2026-08-25-async-prompt-dispatch-design.md`](2026-08-25-async-prompt-dispatch-design.md);
[`2026-06-17-m4-knative-serverless-wrapper-design.md`](2026-06-17-m4-knative-serverless-wrapper-design.md)),
Pi's session event surface (`pi.on(...)`), and the Knative HTTP entrypoint's existing route wiring.

> **What this slice is NOT.** Not a new route — streaming is a _representation_ of `/turn`, chosen by
> `Accept`, not a `/turn/stream` alias. Not the async "fire-and-poll" path: that is the companion
> `kind:"prompt"` leaf ([#168](https://github.com/rossoctl/serverless-harness/issues/168),
> [ADR-0028](../adrs/0028-async-prompt-dispatch.md)) — orthogonal ("watch live" vs. "background and
> poll"). Not an auth/credential change. Not a new turn engine: streaming and non-streaming run the
> **same** `executeTurn`; the only new thing is an event _sink_ and its SSE serialization.

---

## 1. Goal & motivation

`POST /turn` runs one Pi turn to completion and returns the assistant's text in a single JSON body.
For an interactive caller that is correct but opaque: nothing is visible until the whole turn —
possibly many seconds of model generation and tool execution — has finished. Issue #167 asks to let a
caller **watch the turn unfold**: assistant-text tokens as they generate, and tool-call start/result
events as they happen, over a standard SSE stream, without changing anything for callers who don't ask
for it.

The hard requirements from the issue:

- The **default (non-streaming)** `/turn` response is unchanged — same status, same JSON bytes.
- The session is **persisted and resumable identically** to the sync path.
- A **client disconnect aborts** the in-flight turn.
- A `curl -N` example plus a **smoke assertion demonstrating deltas** ship as acceptance artifacts.

The governing principle carried over from the companion async slice is **cleanest design over fewest
changes**: the HTTP layer must never teach the turn core about HTTP, and the two response modes must
share one turn engine rather than fork it.

---

## 2. Current state — the seams we extend

| Seam                                                   | Today                                                                                                                   | This slice                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `handleTurn` (`packages/knative-server/src/server.ts`) | read body → parse → validate `prompt` → `runTurn(...)` → `res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result))` | branch on `Accept` **after** validation; the sync emission line is untouched                                          |
| `executeTurn` (`harness/src/run-turn.ts`)              | builds `extensionFactories`, opens/creates session, `session.prompt`, extracts text, returns `TurnResult`               | `ExecuteTurnInput += onEvent?`, `signal?` (both optional, additive); when present, push `sseExtension` and wire abort |
| `TurnResult`                                           | `{ sessionId; response; stopReason; errorMessage?; usage? }`                                                            | **unchanged** — the terminal SSE frame is derived from it                                                             |
| Pi session events (`pi.on`)                            | consumed by `flushExtension`, `checkpointExtension`, …                                                                  | a new `sseExtension` consumes `message_update` / `tool_execution_start` / `tool_execution_end`                        |
| `session.abort()` (`pi-fork/.../agent-session.ts`)     | invoked on shutdown paths                                                                                               | invoked on client disconnect via an `AbortSignal`                                                                     |
| `/turn` route guard (`server.ts`)                      | wrapper writes `500` only `if (!res.headersSent)`                                                                       | already correct for streaming — a post-flush throw can't overwrite status                                             |

The invariant that shapes everything below: **the turn core emits neutral domain frames; the server
owns the SSE transport.** `runTurn`/`executeTurn` never learn what HTTP or SSE is; they call an
optional `onEvent(frame)` sink. The server maps frames to SSE bytes. This is the codebase's own
extension-factory idiom (a factory closing over a sink, exactly as `flushExtension` closes over
`backend`).

---

## 3. Design

### 3.1 The event seam — `TurnStreamFrame` + `sseExtension`

A new module `harness/src/turn-stream.ts` defines the contract between the turn core and any
transport, plus the Pi→frame translator.

**Frame vocabulary** (a discriminated union; the interface both sides share):

```ts
export type TurnStreamFrame =
  | { type: 'text'; delta: string } // assistant-text token
  | { type: 'thinking'; delta: string } // reasoning token (optional; see §3.5)
  | { type: 'tool_use'; id: string; name: string; args: unknown } // tool call started (args verbatim)
  | { type: 'tool_result'; id: string; isError: boolean; preview: string } // tool call ended (clipped)
  | { type: 'done'; sessionId: string; stopReason: string; usage?: LeafUsage }
  | {
      type: 'error';
      sessionId: string;
      stopReason: string;
      errorMessage?: string;
      usage?: LeafUsage;
    };
```

**Tool-payload fidelity is level "B"**: `tool_use` carries the tool `name` and its `args` verbatim
(what the model asked for — high value for a live watcher), while `tool_result` carries only
`isError` plus a **truncated** `preview` of the result text. Tool results can be large (file dumps,
command output); streaming them whole would bloat the wire and leak more than a "watch" view needs.
`preview` is clipped to a byte cap read from `SH_TURN_STREAM_TOOL_RESULT_PREVIEW_BYTES` (default
`2048`); truncation happens **in the translator** (a domain concern), so no transport ever sees the
untruncated result.

**`sseExtension(onEvent, opts?)`** is a Pi `ExtensionFactory` — the same five-line shape as
`flushExtension` — that registers handlers and translates each Pi event into a frame:

```ts
export function sseExtension(
  onEvent: (f: TurnStreamFrame) => void,
  opts?: { previewBytes?: number },
): ExtensionFactory {
  return (pi) => {
    pi.on('message_update', (e) => {
      const a = e.assistantMessageEvent;
      if (a.type === 'text_delta' && a.delta) onEvent({ type: 'text', delta: a.delta });
      else if (a.type === 'thinking_delta' && a.delta)
        onEvent({ type: 'thinking', delta: a.delta });
    });
    pi.on('tool_execution_start', (e) =>
      onEvent({ type: 'tool_use', id: e.toolCallId, name: e.toolName, args: e.args }),
    );
    pi.on('tool_execution_end', (e) =>
      onEvent({
        type: 'tool_result',
        id: e.toolCallId,
        isError: e.isError,
        preview: clip(e.result, opts?.previewBytes),
      }),
    );
  };
}
```

`sseExtension` emits **only incremental progress frames** (`text`/`thinking`/`tool_use`/
`tool_result`). Terminal frames (`done`/`error`) are the server's job (§3.3, §3.4), derived from the
`TurnResult` the core returns — so the streamed client ends with the _same facts_ a sync client reads.

### 3.2 Turn core — two additive optional inputs

`ExecuteTurnInput` gains two optional fields; nothing else about `executeTurn` changes, and it still
returns the same `TurnResult` and throws the same errors:

```ts
interface ExecuteTurnInput {
  // ...existing: prompt, sessionId, config, createIfAbsent, selection...
  onEvent?: (frame: TurnStreamFrame) => void; // present ⇒ append sseExtension(onEvent) to extensionFactories
  signal?: AbortSignal; // present ⇒ signal.onabort → session.abort()
}
```

When `onEvent` is set, `executeTurn` appends `sseExtension(onEvent)` to its existing
`extensionFactories` array. When `signal` is set, it wires `signal → session.abort()` immediately
after `createAgentSession(...)`. `runTurn`'s public signature is untouched — the streaming handler
calls `executeTurn` directly with the extra fields, exactly as `runPromptLeaf` already does. Because
the sink is just another extension factory, the async prompt-leaf path (#168) could later reuse
`sseExtension` to persist a progress log with zero HTTP entanglement.

### 3.3 HTTP layer — content negotiation, framing, lazy flush

The branch lives inside `handleTurn`, **after** its unchanged front matter (body read, JSON parse,
`prompt` validation — all 400 paths preserved), right before the `runTurn` call:

```ts
const wantsStream = /text\/event-stream/i.test(req.headers.accept ?? '');
if (wantsStream) return handleTurnStream(prompt, sessionId, req, res);
// unchanged sync path: runTurn(...) → res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result))
```

`handleTurnStream` is a new sibling in `server.ts` (transport lives with the server; only the _frame
types_ are imported from `@sh/harness/turn-stream`). Its shape:

- **Lazy header flush.** It does **not** write the `200` on entry. A single private `writeFrame(res,
frame)` helper flushes the SSE headers on the **first** frame and serializes every frame to the SSE
  wire form `event: <type>\ndata: <JSON>\n\n`. Named events (not bare `data:`) so `curl -N` shows
  `event: text` / `event: tool_use` and `EventSource` clients can `addEventListener` per type. The
  lazy flush is what preserves status-code parity for pre-turn failures (§3.4).
- **SSE headers** (written on first frame): `Content-Type: text/event-stream`, `Cache-Control:
no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`. No `Content-Length` — Node emits
  chunked transfer encoding and flushes each frame.
- **The call:** `executeTurn({ prompt, sessionId, config: buildConfig(), createIfAbsent: false,
onEvent: (f) => writeFrame(res, f), signal: ac.signal })`. Progress frames stream as they arrive.
- **Terminal frame:** on resolve, derive from the returned `TurnResult` — `done` for a clean
  `stopReason`, `error` for `error`/`aborted` — carrying every `TurnResult` field, then `res.end()`.
- **Heartbeat:** a timer emits an SSE comment (`: keepalive\n\n`) every
  `SH_TURN_STREAM_KEEPALIVE_MS` (default `20000`), reset on every real frame and cleared at turn end,
  so a long silent tool execution can't trip a proxy idle-timeout. Comments are invisible to
  `EventSource` and to `curl` content — they never touch the frame vocabulary.

### 3.4 Error taxonomy & back-compat — parity by construction

Lazy header flush partitions failures into three regimes, each mapped to preserve the sync contract:

1. **Pre-flight (before the branch).** Bad JSON, missing `prompt` — handled in `handleTurn`'s front
   matter _before_ `handleTurnStream` is called, so they stay real `400`s with the identical body. No
   divergence.
2. **Pre-first-frame (session open fails).** `createIfAbsent:false` with an unknown `sessionId`
   throws `"no session in backend"` at session-open, before any progress frame. Since `writeFrame`
   hasn't fired, `res.headersSent` is false, and `handleTurnStream`'s catch **reuses the exact sync
   mapping** — `message.includes("no session in backend") ? 404 : 500`, same JSON body, same
   `sessionId` echo. A streaming request with a bad session gets a real **404**, byte-identical to
   today. We commit to SSE only once there is something to stream.
3. **Post-first-frame (mid-turn failure).** Once tokens have flowed, `headersSent` is true and status
   codes are spent. The catch emits a terminal `error` frame then `res.end()`s. Guarded by
   `!res.writableEnded` so a concurrent disconnect can't double-write or `EPIPE`.

**Terminal frame selection.** When `executeTurn` _returns_ a `TurnResult` (the HTTP-200 equivalent),
the terminal frame carries **every field the sync `TurnResult` exposes** (`sessionId`, `stopReason`,
`usage`, and `errorMessage` when present). The only difference between `done` and `error` is the
_event name_, chosen by whether `stopReason` is a clean finish (`end_turn`/`max_tokens` → `done`;
`error`/`aborted` → `error`). So a model that ends in an error stop-reason surfaces as an `error`
frame with the same `errorMessage` a sync caller would read — the frame name is pure sugar over the
same facts, and resume parity holds because `sessionId`/`stopReason` are always present.

**The guarantee, stated plainly:** the non-streaming response is unchanged because its emission line
is never edited, _and_ every pre-commit failure a sync caller could hit still returns the same status

- body on a streaming request. Streaming only _adds_ a post-commit `error`-frame surface that has no
  sync equivalent (status codes aren't available after the first byte).

### 3.5 Thinking frames are optional

`thinking` deltas (from `thinking_delta`) are surfaced as their own event so a watcher can render or
ignore reasoning independently — the distinct event type _is_ the opt-out, so no gating query param is
needed. But the frame is **best-effort and may never fire**: synthesized custom models configured
`reasoning:false`, and some OpenAI-compatible endpoints, emit no thinking stream. Clients MUST treat
`thinking` (and indeed every progress frame type) as optional and absence as normal.

### 3.6 Client disconnect → abort → durable resume

> **Amended (2026-10-09):** a turn sent with `"detachable": true` is not aborted by a disconnect;
> it is logged, re-attachable, and cancelled explicitly. See
> [turn-reattach-design](2026-10-09-turn-reattach-design.md) and [ADR-0040](../adrs/0040-detachable-turns.md).

`handleTurnStream` creates an `AbortController ac` up front and registers `req.on("close", …)` to
fire `ac.abort()` if the response hasn't finished. That signal is what `executeTurn` wires to
`session.abort()` (§3.2). So a client hitting Ctrl-C on `curl -N` propagates: request close →
`ac.abort()` → `session.abort()` → the in-flight model/tool work unwinds. `flushExtension` still
persists whatever completed on `turn_end`/`session_shutdown`, so the session **resumes at its last
durable point** — the same persistence contract a completed turn gets. On abort we do **not** attempt
a terminal frame (the socket is gone; it would `EPIPE`).

---

## 4. Deployment envelope (Knative)

**Buffering is the real risk, and it is validated, not assumed.** Our side is correct by
construction: no `Content-Length`, `res.write()` per frame → chunked encoding, flushed per frame, and
no response compression on this path (gzip would coalesce frames). Kourier (Envoy) passes chunked
responses through without whole-body buffering; `X-Accel-Buffering: no` is belt-and-suspenders for any
nginx fronting Kourier (Envoy ignores it, harmlessly).

The genuine hazard is the **Knative activator**: while a revision is scaling or under burst
autoscaling, the activator stays in the request path and can buffer the response, which would batch
all deltas to the end and defeat the feature. Two responses, both part of this design:

- **Mitigation:** annotate the streaming revision with
  `autoscaling.knative.dev/target-burst-capacity: "0"`, which drops the activator from the path once
  the pod is up, giving a direct Kourier→pod stream.
- **Validation:** the gated smoke (§5) asserts _inter-frame arrival timing_, not just final content —
  if the activator buffers, deltas arrive clumped and the test fails loudly. "Streaming actually
  streams end-to-end" is proven against a deployed revision, never assumed.

**Timeout ceiling — no new knob.** A streamed turn is bounded by the revision's `timeoutSeconds`
(default 300s) exactly as the sync `/turn` already is; streaming makes that bound _visible_ (frames
until cutoff) rather than worse. Long-horizon work is the async path's job (#168), not this one.

---

## 5. Testing & verification gate

### 5.1 Unit (fast, vitest)

- **`harness/test/turn-stream.test.ts`** (new): feed synthetic Pi events — `message_update` bearing
  `text_delta`, then `thinking_delta`, then `tool_execution_start`, then `tool_execution_end` with an
  oversized result — through `sseExtension` and assert the exact `TurnStreamFrame` sequence. Includes
  the **fidelity-B truncation** case: a result past `SH_TURN_STREAM_TOOL_RESULT_PREVIEW_BYTES` is
  clipped to the cap and `isError` is propagated verbatim.
- **terminal-frame selection/parity** (same suite): a `TurnResult` with a clean stop-reason → `done`
  carrying `sessionId`/`stopReason`/`usage`; an error stop-reason (+`errorMessage`) → `error` carrying
  the same `errorMessage` a sync caller would read. Asserts the frame's field set ⊇ `TurnResult`'s.

### 5.2 Integration (server, vitest)

- **Content negotiation** — the back-compat linchpin:
  - No/other `Accept` → **golden byte-for-byte** assertion against the current JSON response. If a
    future edit perturbs the sync bytes, this fails.
  - `Accept: text/event-stream` → `Content-Type: text/event-stream`, ordered frames, terminal `done`.
  - Bad `sessionId` + streaming `Accept` → real **404 JSON** (pre-first-frame regime), _not_ an error
    frame.
  - Missing `prompt` + streaming `Accept` → **400** (pre-flight).
- **Disconnect/abort:** destroy the client socket mid-stream → assert the `AbortSignal` handed to
  `executeTurn` transitions to `aborted`. `executeTurn` is mocked here, so this proves the server
  propagates the disconnect into the turn core; the actual `session.abort()` → durable-checkpoint
  resume contract is exercised end-to-end by the §5.3 live smoke's follow-up turn, not this unit.

### 5.3 Live gate — `deploy/knative/turn-stream-smoke.sh` (gated `TURN_STREAM_LIVE_SMOKE=1`)

Against a deployed revision (mirroring the `ASYNC_LIVE_SMOKE` idiom): `curl -N` a
`Accept: text/event-stream` turn, assert `event: text` deltas arrive, assert **incremental timing**
(≥2 frames land before the terminal frame — the anti-buffering assertion from §4), assert terminal
`done` carries `sessionId`, then issue a follow-up turn on that `sessionId` to prove **resume
parity**.

### 5.4 Acceptance-criteria coverage (issue #167)

| Criterion                                  | Covered by                                                 |
| ------------------------------------------ | ---------------------------------------------------------- |
| Default `/turn` unchanged                  | §5.2 golden byte-for-byte test                             |
| Session persisted/resumable identically    | §5.3 live-smoke follow-up turn (real engine)               |
| Client disconnect aborts the turn          | §5.2 disconnect/abort                                      |
| `curl -N` example + smoke asserting deltas | §5.3 + a documented `curl -N` example in the endpoint docs |

---

## 6. Scope / YAGNI — explicitly NOT building

- **No `/turn/stream` route.** Streaming is a representation selected by `Accept`; a second route
  would duplicate validation and the branch, and split one noun in two.
- **No full tool-result payloads on the wire.** Fidelity B (verbatim `args`, clipped result preview)
  is the "watch live" contract; a caller needing the whole result reads it from the completed session,
  not the stream.
- **No resumable/replayable stream (Last-Event-ID).** A disconnect aborts the turn (§3.6); we do not
  buffer past frames for reconnect-and-replay. A caller that wants durability uses the async path
  (#168).
  Amended for detachable turns by [turn-reattach-design](2026-10-09-turn-reattach-design.md).
- **No client-selectable frame filtering / verbosity params.** Distinct event names already let a
  client subscribe to only what it wants; a query-param matrix is unneeded surface.
- **No auth/credential change.** Out of scope per the issue.

---

## 7. References

- Issue [#167 — streaming responses for `/turn` (SSE)](https://github.com/rossoctl/serverless-harness/issues/167)
- [`2026-08-25-async-prompt-dispatch-design.md`](2026-08-25-async-prompt-dispatch-design.md) — the shared `executeTurn` core this rides; the orthogonal "background and poll" path
- [`2026-06-17-m4-knative-serverless-wrapper-design.md`](2026-06-17-m4-knative-serverless-wrapper-design.md) — `runTurn` / `/turn` / the Knative wrapper
- [ADR-0029](../adrs/0029-turn-sse-streaming.md) — the decision record for this design

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
