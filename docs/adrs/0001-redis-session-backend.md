# ADR-0001: Persist Pi session state through a pluggable Redis backend

- **Status:** Implemented
- **Date:** 2026-06-16
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-16-m1-redis-session-backend-design.md`](../specs/2026-06-16-m1-redis-session-backend-design.md)

## Context

MOCA needs a session to survive process death so a fresh process can resume it with no local files. Pi persists session state to local JSONL, tied to a file path, which is incompatible with scale-to-zero. Pi's append API is synchronous and its in-memory tree is authoritative during a live session.

## Decision

We will introduce an upstreamable `SessionStorageBackend` seam in Pi core (defaulting to the existing file backend) and inject a Redis backend through it, resuming sessions by `session_id` rather than by file path.

### Alternatives considered

- **Keep file-path JSONL persistence** — cannot survive to a fresh, file-less process; incompatible with serverless.
- **Add async/`flush()` into Pi's core interface** — pollutes the upstreamable seam; all write-behind machinery instead lives in a harness-side buffering decorator.
- **Reshape Pi entries into a semantic schema** — rejected as critical-path work; the envelope stores Pi's native entry verbatim.

## Consequences

- Positive: A completed turn is durable in Redis; a fresh process resumes by `session_id`; the seam mirrors Pi issue #2032 and stays upstreamable.
- Negative / accepted cost: Fire-and-forget writes can lose an _in-flight_ turn on hard kill; durability boundary is the completed turn (flush at `turn_end`/`session_shutdown`).
- Follow-up owed: Checkpoint write / compaction path deferred to M4 (M1 implements only the read side).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
