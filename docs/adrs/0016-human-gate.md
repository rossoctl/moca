# ADR-0016: Human-gate as a structured terminal plus externally-triggered continuation

- **Status:** Implemented
- **Date:** 2026-06-28
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-28-human-gate-design.md`](../specs/2026-06-28-human-gate-design.md)

## Context

Archetype B needs a single leaf session to pause mid-pipeline awaiting a human decision, park in
durable state with the pod scaled to zero, and resume with the decision injected — the canonical
async + scale-to-zero + durable-resume case. The challenge is providing this without an always-on
component, without depending on Pi internals, and without leaving a dangling tool call that breaks
resume.

## Decision

We will implement the gate as a `request_approval` tool that ends the turn well-formed and parks the
session (durable gate-request entry + `awaiting_approval` marker), then resume it as an ordinary
re-invocation of `POST /runs` on the same `sessionId` carrying a `decisionRef` file, seeding the
agent with a continuation prompt derived from the decision.

### Alternatives considered

- **Tool-result injection to continue** — leaves a dangling `tool_use`, is fragile across crashes, and would depend on Pi internals; continuation-prompt reuses the proven M5 resume path.
- **Harness-side decision watcher / auto-resume** — reintroduces an always-on component and defeats scale-to-zero; resume stays an external re-invocation.
- **Harness-side timeout/TTL sweeper** — same always-on cost; deadlines are the orchestrator's concern (re-invoke with `abort`).

## Consequences

- Positive: no new machinery, endpoint, or image — the gate rides existing durable session logs and markers; `gateId` matching makes replayed/stale decisions safe.
- Negative / accepted cost: parked sessions wait indefinitely with no harness-enforced deadline; the orchestrator must own timeouts and not race conflicting decision files.
- Follow-up owed: auto-approve mode (safety-precondition surface) is shaped-for but not built; event-driven gates deferred to Archetype C.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
