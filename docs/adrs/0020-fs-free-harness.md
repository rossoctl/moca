# ADR-0020: Filesystem-free harness (envelope inline + Redis, working set on Sandbox CR)

- **Status:** Implemented
- **Date:** 2026-07-02
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-07-02-p1-fs-free-harness-design.md`](../specs/2026-07-02-p1-fs-free-harness-design.md)

## Context

The head/hands invariant is that only the sandbox touches a filesystem; the credentialed harness does network I/O only. Today the harness and its async worker read and write the leaf envelope (inputs, verdict, done/gate markers) and resume decisions on a shared `/work` PVC. Because many harness pods would share that PVC across nodes, this file coupling is the root cause forcing cross-node RWX on OpenShift.

## Decision

We will make the harness perform zero filesystem I/O: move leaf inputs and the resume decision inline into the `/runs` envelope, store the result/gate record in Redis (`leaf:result:<id>`), and move the sandbox working set onto a durable `agent-sandbox` `Sandbox` CR volume — so neither the harness Service nor the async worker mounts any shared writable volume.

### Alternatives considered

- **Keep `/work` PVC with cross-node RWX** — heavier infra (EFS/CSI), unavailable on the EBS-only OCP cluster, and leaves the FS attack surface on the credentialed tier.
- **Transitional "accept both" envelope shapes** — honoring old `inputsRef`/`resultRef` fields would require keeping the mount, defeating the goal; a clean break is taken since no live external consumer exists.

## Consequences

- Positive: harness/worker mount nothing writable; RWX no longer applies to the harness tier; Redis TTL replaces file cleanup.
- Negative / accepted cost: a hard `/runs` wire break; long human-gate waits are bounded by `LEAF_RESULT_TTL_SECONDS`.
- Follow-up owed: shared sandbox pool + N:M routing and RWX-vs-copy topology (P2).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
