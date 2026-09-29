# ADR-0007: Ride Pi's native compaction entry as the resume checkpoint

- **Status:** Implemented
- **Date:** 2026-06-23
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-23-m5-compaction-checkpoint-design.md`](../specs/2026-06-23-m5-compaction-checkpoint-design.md)

## Context

On cold start the harness reconstructs a session by full-replaying the Redis log: `openFromBackend` reads every entry and indexes all of them, so local reconstruction cost grows O(total entries) with session length. Pi already persists compaction as a first-class log entry and its `buildSessionContext()` assembles only `[summary, kept tail, post-compaction]`, so the LLM context is already bounded — the remaining unbounded cost is purely the local Redis read, index build, and leaf→root walk.

## Decision

We will treat Pi's native `compaction` entry as the checkpoint and add an additive `SessionManager.openFromCheckpoint()` that, guided by a tiny resume-pointer marker, reads only the kept-tail-forward slice — making cold-start local reconstruction O(tail) — falling back to `openFromBackend` when no marker exists.

### Alternatives considered

- **A separate context snapshot** — rejected: duplicates what Pi's compaction entry already holds; the marker stores only a pointer.
- **`everyK` / forced checkpoint cadence** — deferred: we ride Pi's own compaction cadence; add only if an experiment shows it's needed.

## Consequences

- Positive: bounded Redis bandwidth/CPU at large session lengths; cold context is identical to warm by reusing `buildSessionContext()`.
- Negative / accepted cost: the win is local, not LLM latency (already bounded); `thinkingLevel` resets to default for one post-compaction turn (self-heals); deterministic stream ids are incompatible with pre-M5 dev sessions.
- Follow-up owed: E2 must measure local reconstruction cost, not end-to-end latency.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
