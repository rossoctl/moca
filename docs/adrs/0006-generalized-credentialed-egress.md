# ADR-0006: Placeholder-swap over a forward proxy for all credentialed egress

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-19-m13-generalized-credentialed-egress-design.md`](../specs/2026-06-19-m13-generalized-credentialed-egress-design.md)

## Context

MCP egress proved a zero-trust spine: the sandbox runs code that makes a credentialed call it cannot read. But the model also wants to reach arbitrary HTTP APIs (GitHub, REST endpoints, SDKs). We need one mechanism where the sandbox, prompt, and log never hold a real secret, per-user credentials are enforced, and native tools (`gh`, `curl`) work unmodified — without a per-host mesh front-door and per-API correctness wrappers.

## Decision

We will extend AuthBridge's placeholder-swap to all HTTP egress: the sandbox holds only inert placeholders, and a forward proxy (`HTTPS_PROXY` + a baked CA) terminates TLS, resolves `(subject ⊕ destination)` to the real credential, overwrites the placeholder at L7, audits, and enforces the allowlist and call cap — the sole egress boundary.

### Alternatives considered

- **In-mesh front-door + host-based injection (v1.0)** — avoided TLS interception but forced per-host mesh config, per-API wrappers, and an env-injection escape hatch; native tools didn't work unmodified.
- **Shared workload credential for non-OAuth APIs** — rejected: breaks per-user isolation (no "Bob's version" of a shared key).

## Consequences

- Positive: `gh`/`curl`/SDKs work natively; full per-call L7 audit; MCP becomes one interception case of one shared brain.
- Negative / accepted cost: a baked CA (trust anchor, not a secret) and TLS interception; request-signing APIs (AWS SigV4) keep a weaker env-inject escape hatch.
- Follow-up owed: the per-user external-credential store (M7–M9) is a hard dependency this milestone consumes, not builds.
- Supersession: subsumes the parent research doc's sandbox credential injection (M9) and generalizes the placeholder-swap mechanism of ADR-0005 (MCP code-mode) to all egress.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
