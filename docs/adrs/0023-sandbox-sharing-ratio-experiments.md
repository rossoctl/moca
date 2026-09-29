# ADR-0023: Measure sandbox sharing capacity on runc, splitting Kata isolation into P4

- **Status:** Implemented
- **Date:** 2026-07-03
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-07-03-p3-sandbox-sharing-ratio-experiments-design.md`](../specs/2026-07-03-p3-sandbox-sharing-ratio-experiments-design.md)

## Context

P2 delivered the pool mechanism but left the capacity numbers unmeasured: `KAGENTI_SANDBOX_CAP` defaults to a soft 20 and pool size N is a static config knob, both "tune empirically in P3." The original #48 bundled Kata/VM isolation with the ratio experiments and asserted the experiments depend on Kata — but the live OCP 4.20.8 cluster is all `m6i.xlarge` with no `/dev/kvm`, so default Kata cannot start, and the isolation work needs an out-of-band infra decision.

## Decision

We will measure the sharing ratio and per-sandbox concurrency cap empirically on the runc runtime — via experiments E6 (saturation curve → CAP + duty-derived N) and E7 (converge contention + mixed-ref correctness) against an in-cluster git-daemon — and split all Kata/VM isolation and intra-pod hardening out into a separate, infra-gated P4.

### Alternatives considered

- **Keep Kata as a prerequisite for the experiments** — the ratio baseline is runtime-independent and unblocked, whereas Kata is infra-blocked on this cluster; the dependency is reversed.
- **GitHub-backed or `file://` load repos** — not hermetic / not reachable across the pool; a `git://` daemon is required for shared mixed-ref converge.

## Consequences

- Positive: shippable measurement decoupled from an infra spike; correctness (mixed-ref, never-over-cap) hard-gated, ratio reported with a sanity floor.
- Negative / accepted cost: numbers are runc-only; the Kata-overhead delta is unknown until P4.
- Follow-up owed: P4 infra spike (peer-pods / gVisor / bare-metal), RuntimeClass, and intra-pod isolation hardening.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
