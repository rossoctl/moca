# ADR-0029: Streaming `/turn` responses as an SSE representation via content negotiation

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-08-26
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-08-26-turn-sse-streaming-design.md`](../specs/2026-08-26-turn-sse-streaming-design.md)

## Context

`POST /turn` runs one Pi turn to completion and returns the assistant's text as a single JSON body,
holding the connection open with nothing visible until the turn finishes. Issue
[#167](https://github.com/rossoctl/moca/issues/167) asks to let an interactive caller
**watch the turn unfold** — assistant-text deltas and tool-call events, live — without changing
anything for callers who don't ask for it. This is distinct from the async "background and poll" path
([ADR-0028](0028-async-prompt-dispatch.md), issue #168): that trades liveness for durability;
streaming keeps the synchronous connection and adds liveness. The governing constraint is the same
one that shaped ADR-0028 — **cleanest design over fewest changes** — with a hard back-compat floor:
the non-streaming response must stay byte-for-byte identical.

## Decision

We will add streaming as a **representation of `/turn` selected by content negotiation**
(`Accept: text/event-stream`), **not** a new `/turn/stream` route. Both modes run the **same**
`executeTurn` core (the shared turn engine ADR-0028 extracted); streaming adds only an event _sink_,
not a second engine. The sink is a new Pi extension factory `sseExtension(onEvent)` in
`harness/src/turn-stream.ts` — the same shape as `flushExtension` — that translates Pi session events
into a neutral `TurnStreamFrame` union. `executeTurn` gains two **optional, additive** inputs,
`onEvent?` and `signal?`; when absent, `/turn` behaves exactly as today. The server owns the SSE
transport: a `handleTurnStream` sibling that branches after `handleTurn`'s existing validation, and a
**lazily-flushing** frame writer that defers the `200` until the first frame — so a pre-turn failure
(unknown `sessionId`) still returns the real **404 JSON**, byte-identical to the sync path, and only
post-first-frame failures degrade to a terminal `error` frame. Tool payloads stream at **fidelity B**
(verbatim tool `args`; a byte-capped result `preview`). Client disconnect wires
`req`-close → `AbortController` → `session.abort()`, and `flushExtension` persists to the same durable
checkpoint, so an aborted stream resumes identically to the sync path. Transport buffering is
mitigated (chunked encoding, no `Content-Length`, `target-burst-capacity: "0"` to drop the Knative
activator) and, crucially, **validated** by a gated smoke that asserts inter-frame timing.

### Alternatives considered

- **A dedicated `POST /turn/stream` route** — splits one noun in two and duplicates body-read / validation / the branch; content negotiation keeps `/turn` one resource with two representations.
- **A `?stream=true` query flag** — same duplication risk as a second route, and mixes transport selection into the request body's concern; `Accept` is the HTTP-native lever for representation.
- **Eager `200` + SSE headers on entry** — would forfeit status-code parity: an unknown-session streaming request could no longer return a real 404. Lazy flush buys byte-identical pre-turn error parity.
- **Streaming full tool-result payloads (fidelity C)** — bloats the wire and leaks more than a "watch" view needs; the completed session already holds the full result. Fidelity B (args + clipped preview) is the watch contract.
- **A bespoke event bus threaded through `executeTurn`** — reinvents the extension-factory seam the codebase already uses; `sseExtension` reuses it and stays HTTP-agnostic (and reusable by the async path later).

## Consequences

- Positive: the non-streaming `/turn` is unchanged by construction (its emission line is never edited, pinned by a golden byte-for-byte test); streaming and sync share one turn engine, so behavior can't drift; the SSE sink is HTTP-agnostic and could later back an async progress log; session persistence and resume are inherited unchanged, including after abort.
- Negative / accepted cost: SSE introduces a post-commit failure surface with **no** status-code equivalent — once frames flow, a mid-turn failure can only be a terminal `error` frame, never an HTTP 5xx. End-to-end liveness depends on transport that can buffer (the Knative activator most of all), so it is a deployment-envelope concern proven only by a live timing assertion, not a unit test. A streamed turn is still bounded by the revision's `timeoutSeconds` (no long-horizon streaming — that stays the async path's job). Tool results are truncated on the wire (fidelity B), so a streaming watcher does not see full tool output.
- Follow-up owed: a documented `curl -N` example in the endpoint docs; possible reuse of `sseExtension` to persist a progress log for async prompt leaves (#168); revisit fidelity/replay (`Last-Event-ID`) only if a driver needs reconnect-and-replay.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
