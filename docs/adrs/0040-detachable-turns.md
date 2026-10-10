# ADR-0040: Detachable turns — a per-turn Redis Stream log, re-attach by `Last-Event-ID`, and explicit cancel

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-10-09
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-10-09-turn-reattach-design.md`](../specs/2026-10-09-turn-reattach-design.md)
- **Amends:** [ADR-0029](0029-turn-sse-streaming.md) (a client disconnect aborts the turn), for turns
  that opt in.

## Context

ADR-0029 ties a turn's life to its SSE connection: a disconnect aborts the turn, and nothing replays
frames, by design (its follow-up: "revisit replay only if a driver needs reconnect-and-replay").
`mocactl` is that driver. A user who quits mid-turn comes back to a cut-off reply and must prompt the
agent to continue. #471 asks for the turn to keep running and for the client to catch up on what it
missed, then follow live.

A reconnect can reach a different process (Knative pods, P6 workers under `leastInFlight`), every
deployment already runs Redis, and the server does not serialize turns of one session.

## Decision

We will add **detachable turns**, opted into per turn with `"detachable": true` on an authenticated
SSE `POST /v1/turn`, honored where `SH_TURN_DETACH=1` (the P6 runtime: vm, compose, k8s).

- A disconnect detaches a detachable turn instead of aborting it.
- The owning process writes every frame to a **per-turn Redis Stream** as well as to its own connection.
  The entry id is the SSE `id:` (`<turnId>:<entryId>`).
- **`GET /v1/turn?sessionId=`** replays from `Last-Event-ID`, then follows live to the terminal frame,
  from any process. Finished turns stay replayable for 24 h.
- **`POST /v1/turn/cancel`** is the cancel, delivered by Pub/Sub with a lease flag as fallback.
- A renewed Redis lease allows **one live detachable turn per session** (`409 turn_in_progress`).
- A turn left **unwatched for 30 minutes is aborted**.
- `mocactl` asks at quit whether to keep the turn running or cancel it, re-attaches on resume, and
  reconnects automatically after a dropped stream.

### Alternatives considered

- **Owner-process buffer plus routing to the owner** — breaks when a reconnect reaches another pod, and
  dies with the process.
- **Redis Pub/Sub** — loses the frames between disconnect and reattach.
- **Interactive turns as async leaves (ADR-0028)** — queue latency on every interactive turn and a much
  larger change to the turn model.
- **Keep the turn alive only for a short grace window** — loses the deliberate "quit and come back
  later" case that motivated #471.

## Consequences

- Positive: a turn survives its client; any device can watch it; Esc becomes a real server-side cancel
  instead of a side effect of a dropped socket; one live turn per session closes the session log's
  unenforced single-writer assumption for detachable turns.
- Negative / accepted cost: a Redis write per frame and a lease renewal per turn; a turn can run with
  nobody watching for up to 30 minutes; a non-detachable turn is refused (`409`) while a detachable
  turn of the same session runs; frames written while Redis is failing are missing from replay.
- Not covered: Knative, whose autoscaler cannot see a turn without an open request (follow-up issue);
  turns surviving a process restart, which stays bounded by the supervisor's 20 s shutdown grace.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
