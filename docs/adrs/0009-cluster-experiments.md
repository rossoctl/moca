# ADR-0009: Drive cluster experiments with bash extending smoke.sh

- **Status:** Implemented
- **Date:** 2026-06-25
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-25-m7-cluster-experiments-design.md`](../specs/2026-06-25-m7-cluster-experiments-design.md)

## Context

M4 deployed the harness as a Knative service, and its `smoke.sh` informally proved scale-to-zero and cold-start resume. The serverless thesis needs those turned into reproducible end-to-end cluster experiments with explicit metrics: E1 (scale-to-zero economics), E3 (mobility onto a fresh instance), E4 (crash recovery). The parent plan specified Python drivers against a `pi-harness` ksvc, but the real deploy is ksvc `moca` in `default`, and `smoke.sh` already implements ~80% of the cluster choreography.

## Decision

We will implement the three experiments as idempotent bash drivers under `deploy/knative/`, factoring `smoke.sh`'s choreography into a shared `lib.sh`, measuring E1 as sampled pod-seconds (running pods × poll interval) for `min-scale=1` vs `0`, and asserting E3/E4 by conversational recall of a planted token on a fresh/killed pod.

### Alternatives considered

- **Python drivers (`requests`, `subprocess`)** — rejected: adds a Python toolchain to a TS repo; kubectl/curl/jq are native to cluster ops and `smoke.sh` already does most of it.
- **Counting pod startTimes for E1** — rejected: measures pod count, not idle cost; sampling integrates running time.

## Consequences

- Positive: reuses the existing deploy scripts; `smoke.sh` stays as the regression anchor; pi-fork untouched.
- Negative / accepted cost: sampled pod-seconds is approximate (5s granularity); E1 magnitude depends on the idle/retention ratio, so the gate is directional (serverless ≤ 0.6× persistent) plus absolute numbers. Uses cheap `claude-haiku-4-5`.
- Follow-up owed: routing non-anthropic models through the gateway needs a wire-id bridge, deferred out of scope.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
