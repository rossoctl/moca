# ADR-0014: Prove the leaf-session backend with a run-to-completion `/runs` invocation contract

- **Status:** Implemented
- **Date:** 2026-06-26
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-26-mvp-leaf-session-contract-design.md`](../specs/2026-06-26-mvp-leaf-session-contract-design.md)

## Context

The capability charter (ADR-0013) named the leaf-session invocation contract the core MVP capability but left it unbuilt. We need the thinnest vertical slice that proves an external deterministic orchestrator can dispatch parameterized, run-to-completion leaf sessions on scale-to-zero infra — without building any domain-specific analysis logic.

## Decision

We will build a job-mode `/runs` endpoint that runs an agent autonomously to a schema-validated verdict emitted via a harness-registered `submit_verdict` tool, returning only a terminal status while the domain artifact travels out-of-band; the contract is idempotent on `session_id` and designed to be re-entrant (a leaf may itself call `/runs`).

### Alternatives considered

- **Return the verdict in the HTTP body** — puts domain artifacts in the harness's channel (charter G3); the verdict travels via the result reference instead.
- **Let model-authored code write the result** — the workspace is read-only to the agent; trusted harness code validates and writes.
- **Run workers as plain K8s Jobs** — loses turn-level durability, the brain/hands split, and the on-ramp to later hardening.

## Consequences

- Positive: a reusable seam any orchestrator can target; real stages plug in by changing only prompt, schema, and tooling.
- Negative / accepted cost: blocks per invocation (async deferred); the stub task under-tests sandbox depth; edge over a plain Job is incremental for the bare slice.
- Follow-up owed: async completion, real tooled image, CoW workspace seeding; the file-based volume envelope was later superseded by the P1 FS-free contract.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
