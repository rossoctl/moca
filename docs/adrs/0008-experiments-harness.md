# ADR-0008: Measure the loader as in-process local reconstruction cost, not end-to-end latency

- **Status:** Implemented
- **Date:** 2026-06-24
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-24-m6-experiments-design.md`](../specs/2026-06-24-m6-experiments-design.md)

## Context

The compaction-checkpoint loader and budget voter shipped with only unit/parity tests. The parent plan's E2 experiment measured end-to-end cold-start latency, but Pi's native compaction already bounds the LLM context, so latency is dominated by an already-bounded LLM call and would show "no effect." The loader's real, measurable win is local: the Redis read, index build, and leaf→root walk. We need reproducible, asserted experiments that isolate that win and run deterministically without an LLM key.

## Decision

We will build a new in-process TypeScript `experiments/` vitest workspace where E2 measures local reconstruction cost — entries/bytes read via a counting `SessionStorageBackend` decorator against synthetic length-N sessions in real Redis — asserting the backend/checkpoint read ratio strictly increases with N, and E5 asserts the voter blocks and records exactly one `abort`.

### Alternatives considered

- **End-to-end cold-start latency under an `everyK` cadence (parent plan)** — rejected: the wrong instrument (latency already bounded); the `everyK` knob doesn't exist.
- **Python drivers over HTTP against deployed Knative** — rejected: in-process Redis reads and the `buildSessionContext` walk aren't observable over HTTP.

## Consequences

- Positive: deterministic, key-free CI gate; faithful proxy of the O(tail) vs O(total) story.
- Negative / accepted cost: counts entries/bytes at the backend boundary, not raw Redis wire bytes; wall-clock is illustrative only. One production change — model/provider become runtime inputs.
- Follow-up owed: cluster experiments E1/E3/E4 deferred to M7; verify whether checkpoint/flush events fire without `bindExtensions` in production.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
