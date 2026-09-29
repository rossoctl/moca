# ADR-0021: Shared sandbox pool via N Sandbox CRs with harness-side Redis-lease routing

- **Status:** Implemented
- **Date:** 2026-07-02
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-07-02-p2-shared-sandbox-pool-design.md`](../specs/2026-07-02-p2-shared-sandbox-pool-design.md)

## Context

After P1 the sandbox tier is a single `Sandbox` CR serving one harness 1:1; the harness resolves its exec target as "the first Running pod." To decouple the dense, cheap harness tier from the smaller durable sandbox tier, many short-lived leaf harnesses must load-balance across a static pool of sandbox pods. Because `kubectl exec` targets a concrete pod name, "pick the first Running pod" must become deliberate, load-aware selection — the heart of P2.

## Decision

We will run the pool as N distinct single-instance `Sandbox` CRs sharing a common pod label, and route each leaf harness-side by listing Running pods and acquiring a Redis-backed, TTL-expiring lease on the least-loaded pod under a soft cap — with each pod holding its own repo copy on its own RWO PVC (ref-pinned lazy converge + per-leaf worktree).

### Alternatives considered

- **RWX / fleet-wide single repo** — needs an EFS/CSI provisioner absent on the EBS-only OCP cluster, adds networked-FS latency and cross-pod contention; kept as documented alternative only.
- **A new deployable routing component / autoscaler** — Redis leases reuse the existing hard dependency with crash-safe TTL reclaim and no new controller; autoscaling deferred.
- **`SandboxWarmPool` / `spec.replicas`** — removed upstream in agent-sandbox v1beta1.

## Consequences

- Positive: N:M sharing with no RWX, no new component, implicit crash reclaim via lease expiry.
- Negative / accepted cost: soft-cap overshoot under races; intra-pod cross-leaf isolation is only directory-level (one trust domain).
- Follow-up owed: Kata pod-level isolation and the empirical sharing ratio (P3).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
