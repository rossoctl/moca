# ADR-0012: A separate shared injector pod holds the provider key and owns public LLM egress

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-26-inference-injector-design.md`](../specs/2026-06-26-inference-injector-design.md)

## Context

The harness lock-down (ADR-0011) requires that the harness hold no provider key and have no public internet route, so its default-deny egress boundary is enforceable. But inference still needs a real provider credential and a route to the provider. Because a NetworkPolicy selects pods (not containers) and a same-pod sidecar shares the netns, any key-holding component co-located with the harness would re-grant the harness that egress.

## Decision

We will run a separate, shared, long-lived injector pod that concretely realizes the parent research doc's inference broker (M8): it holds the provider keys, terminates a mutually-authenticated in-cluster hop, strips client auth and sets the real credential, and is the only component with public egress — a path-preserving, streaming host+auth rewrite, not a policy engine.

### Alternatives considered

- **Same-pod sidecar** — shares the harness netns, so the harness would inherit public egress; breaks the enforceable boundary.
- **Envoy / AuthBridge reuse** — heavier than needed for a static, small-provider-set injector.
- **M13-style forward proxy with baked CA / placeholder-swap** — deception unnecessary since the harness explicitly targets the injector.

## Consequences

- Positive: "harness holds no key" is structural; single rotation/audit and egress chokepoint.
- Negative / accepted cost: concentration makes the injector the high-value target; one extra in-cluster hop; static key at rest in v1.
- Follow-up owed: per-session budget cap and SPIRE-bound credential fetch (§13).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
