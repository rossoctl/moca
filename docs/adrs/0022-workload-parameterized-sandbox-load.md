# ADR-0022: Report the sharing ratio as an N-vs-workload curve, not a single number

- **Status:** Implemented
- **Date:** 2026-07-03
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-07-03-e6-workload-parameterized-sandbox-load-design.md`](../specs/2026-07-03-e6-workload-parameterized-sandbox-load-design.md)

## Context

P3's sharing-ratio experiment used a trivial leaf (converge + one `marker.txt` read, ~2 sandbox execs), so its reported N ≈ 29–48:1 is an optimistic upper bound, not a representative Archetype-A figure — a validity gap raised in review. Since N ≈ 1/duty and duty rises with real sandbox work, a realistic code-review leaf yields a lower N. Separately, the concurrency knee was unreliable: `detectKnee` broke on a single noisy dip, and the harness ksvc cap (max-scale 5) meant any knee above 5 measured the harness tier, not the sandbox.

## Decision

We will make the headline output an N-vs-workload curve measured confound-free at C=1 across real Archetype-A code-review leaves of increasing scope (L0/L1/L2), each point tagged with its measured sandbox exec count, and report the concurrency knee only as a noise-robust floor with its max-scale bound.

### Alternatives considered

- **Keep the single-N claim** — misleading without a stated workload; it answers "best case with a near-empty leaf" only.
- **Inject synthetic sandbox work via a harness/leaf knob** — would touch the FS-free harness and leaf contract; intensity stays emergent and measured instead.

## Consequences

- Positive: honest, workload-tagged ratio; knee freed of harness-cap, cold-start, and single-dip confounds.
- Negative / accepted cost: no true saturation knee at feasible concurrency (few-percent duty), so it stays a reported floor.
- Follow-up owed: chasing a real high-concurrency knee and Kata isolation remain out of scope (P4).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
