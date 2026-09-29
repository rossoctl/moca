# ADR-0011: Defend the harness by defanging local execution, not by mediating egress

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-26-harness-lockdown-design.md`](../specs/2026-06-26-harness-lockdown-design.md)

## Context

The harness (Pi runtime + wrapper) is trusted code operating on untrusted model output and a durable, replayed log. Its only egress destinations are fixed and non-model-controlled (LLM provider, Redis, sandbox), so it has no arbitrary-egress surface. Yet tool redirection to the sandbox is override-based and fail-open: an unresolved sandbox config silently leaves Pi's native local shell/filesystem tools standing, and un-overridden Pi paths can execute model-directed commands locally.

## Decision

We will defend the harness by making any local execution unrewarding and unable to phone home — fail-closed tool redirection, a secret-free container, a default-deny egress NetworkPolicy, a distroless image, and least-privilege RBAC — rather than by installing an L7 egress proxy it does not need.

### Alternatives considered

- **Forward proxy + baked CA + placeholder-swap (the M13 sandbox apparatus)** — unjustified here; the harness makes no model-controlled egress to mediate.
- **Rely on tool-override redirection alone** — fail-open and enumerates a known tool list; breaks on any Pi version that adds a local-exec path.

## Consequences

- Positive: provider-key-never-in-log property preserved structurally, kernel-enforced boundary independent of enumerating Pi's every local path.
- Negative / accepted cost: a two-posture (dev vs. zero-trust) code path; L3 depends on a policy-enforcing CNI; distroless complicates in-container debugging.
- Follow-up owed: build the M8 injector so the external `:443`/DNS allowlist collapses to in-cluster peers.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
