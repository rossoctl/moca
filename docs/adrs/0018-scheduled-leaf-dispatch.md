# ADR-0018: Native Kubernetes CronJob as the scheduled dispatch start signal

- **Status:** Implemented
- **Date:** 2026-06-28
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-28-scheduled-leaf-dispatch-design.md`](../specs/2026-06-28-scheduled-leaf-dispatch-design.md)

## Context

Archetype C (scheduled ingestion) starts from a clock, not an invocation: "every night at 02:00,
process the standing batch." The harness already accepts background work via `POST /runs {async:true}`,
but has no start signal that can fire on a schedule with no external orchestrator process running —
and it must stay a client of the unchanged async contract (charter G1/G2: invoked, not orchestrator).

## Decision

We will add a native Kubernetes `CronJob` that fires a `cron-dispatch` pod which reads a
ConfigMap-defined static envelope list, substitutes the fire id (its owning Job name) into
`sessionId`/`resultRef`, and POSTs each `{async:true}` to the existing service.

### Alternatives considered

- **KEDA `cron` scaler** — the wrong primitive: it is window-based (scale up between start/end) and would spawn jobs continuously across the window rather than fire once at time T; this supersedes the async spec's passing note.
- **Dynamic ingestion (scan-a-dir → one leaf per file)** — that work-selection is orchestration, deferred to the external orchestrator.

## Consequences

- Positive: Kubernetes owns cron semantics; no new harness enqueue logic, no new RBAC, no new image; the dispatcher is just a clock-driven client of the async contract.
- Negative / accepted cost: the batch list is static config (edit-and-`kubectl apply`); `concurrencyPolicy: Forbid` serializes fires and missed-fire backfill is left at defaults.
- Follow-up owed: per-tenant schedules and event triggers are non-precluding extensions of the same shape, not built here.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
