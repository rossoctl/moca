# ADR-0017: Apply the non-root least-privilege securityContext baseline to the agent-running pods

- **Status:** Implemented
- **Date:** 2026-06-28
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-28-registry-hardening-hygiene-design.md`](../specs/2026-06-28-registry-hardening-hygiene-design.md)

## Context

After all three leaf-session archetypes shipped, the cron-dispatch pod was already hardened
(non-root, no priv-esc, read-only rootfs, dropped caps, seccomp), but the two pods that actually run
the agent — the leaf-worker `ScaledJob` and the Knative service — had no securityContext at all and
ran as root with default capabilities. This is an inconsistent, needlessly privileged baseline for
the harness's highest-risk workloads.

## Decision

We will apply the cron-dispatch securityContext baseline (`runAsNonRoot`, `runAsUser: 65532`,
seccomp `RuntimeDefault`, `allowPrivilegeEscalation: false`, drop `ALL` caps, and `readOnlyRootFilesystem`
with writable `/tmp`) to both the leaf-worker `ScaledJob` and the Knative service, verified by the
existing gate smoke.

### Alternatives considered

- **Leave the pods running as root** — the rejected status quo; inconsistent and over-privileged for the agent-running tier.
- **`readOnlyRootFilesystem: true` unconditionally** — decided empirically per-pod; fall back to `false` on a pod only if live smoke shows un-redirectable root-fs writes, keeping non-fs hardening unconditional.

## Consequences

- Positive: both agent-running pods reach the same least-privilege baseline as cron-dispatch; also aligns the `isMainModule` idiom and records the shipped track in the milestone registry.
- Negative / accepted cost: because `/work` is the orchestrator's store, a uid-65532 harness cannot write result dirs created by a root writer — the orchestrator must provision per-run dirs writable by 65532 (documented operator contract).
- Follow-up owed: document the non-root `/work` ownership contract in the operator runbook; reclaimer-churn tuning explicitly deferred (no observed symptom).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
