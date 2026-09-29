# ADR-0013: Reprioritize the harness as a leaf-session backend and defer the heavy credential plane

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-26-leaf-session-backend-capability-charter.md`](../specs/2026-06-26-leaf-session-backend-capability-charter.md)

## Context

The credential-plane re-examination produced a coherent Z-track but an unanchored priority order. Testing the design against three independent real agentic pipelines showed they share one shape: a deterministic, non-LLM orchestrator dispatching parameterized agent leaf sessions, with structured artifacts and checkpoint/resume. None uses recursive subagents, and all three are per-project automations, not multi-tenant.

## Decision

We will treat the harness's core role as an excellent leaf-session backend invoked by an arbitrary external orchestrator, make the MVP the leaf-session invocation contract plus workspace isolation, defer per-user identity (Z1) until multi-tenant hosting is a goal, and defer the Z6 subagent extras because the only near-term subagent need is met by a re-entrant leaf-session contract.

### Alternatives considered

- **Build an orchestrator or subagent runtime** — no archetype needs it; the harness is invoked, not the driver.
- **Build the full credential plane (Z1) now** — justified only by multi-tenant hosting none of the three require; keep on the shelf.
- **New subagent machinery (Z6 extras)** — clean-context delegation comes free from a re-entrant contract; only lineage/budget/policy/mail defer.

## Consequences

- Positive: prevents over-building the heavy (correct) credential plane ahead of demand; a single reusable seam serves all archetypes.
- Negative / accepted cost: multi-tenant use later requires pulling deferred Z1/Z3/Z5 designs off the shelf.
- Follow-up owed: pick the MVP archetype+slice; define the minimal input/output envelope; promote human-gate and trigger primitives post-MVP.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
