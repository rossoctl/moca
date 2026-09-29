# ADR-0015: KEDA ScaledJob over a Redis Streams queue for background leaf execution

- **Status:** Implemented
- **Date:** 2026-06-27
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-27-async-leaf-completion-design.md`](../specs/2026-06-27-async-leaf-completion-design.md)

## Context

The MVP `POST /runs` blocks until the leaf reaches a terminal state. Real Archetype-A validation
leaves (builds, proofs) run for minutes, and an orchestrator fanning out tens–hundreds of them
cannot hold that many long-lived HTTP connections. We need true background execution that
scales-to-zero, tolerates crashes, and does not put the harness on the completion critical path.

## Decision

We will run async leaves as a KEDA `ScaledJob` consuming a dedicated Redis Streams work queue
(`leaf-queue`): `POST /runs {async:true}` `XADD`s the envelope and returns `202`, KEDA spawns one
Job per pending entry, and each Job runs the unchanged `runLeaf` then signals completion via a
done-marker on the orchestrator's volume.

### Alternatives considered

- **Blocking synchronous `POST /runs`** — cannot sustain hundreds of minutes-long connections; kept only as the unchanged sync path.
- **Always-on worker pool** — no scale-to-zero; wastes idle capacity between bursts.
- **Harness-created Jobs** — would add Job-management RBAC to the harness; KEDA keeps triggering/scaling declarative and out of the harness.

## Consequences

- Positive: scale-to-zero, declarative concurrency cap, and a KEDA trigger substrate that Archetypes B and C reuse without bespoke trigger code.
- Negative / accepted cost: KEDA becomes a cluster prerequisite; delivery is at-least-once, so a rare double-process can occur (idempotent `runLeaf` makes the outcome effectively-once).
- Follow-up owed: the `WorkQueue` seam keeps the contract KEDA-agnostic (a KEDA-less fallback is documented); done-marker transport later moves to a Redis result record (P1).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
