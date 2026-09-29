# ADR-0027: RC1 control gate as IBAC-only, and Hop-2 egress interception over plain HTTP

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-07-10-authbridge-egress-control-plane-poc-design.md`](../specs/2026-07-10-authbridge-egress-control-plane-poc-design.md)
- **Refines:** RC1 spec §2 (capability #3), §3 (AB2 baked CA), §4, §6.

## Context

The RC1 spec asks for **SPARC/IBAC control on both hops** with a stubbed judge (§2 cap #3, §4), and a
per-sandbox **forward proxy with a baked CA** that TLS-terminates HTTPS egress so it can read/rewrite L7
(§3). Two facts surfaced during RC1-0:

1. **SPARC's `/reflect` contract is undocumented** — the AuthBridge docs describe only prose inputs
   (`messages`, `tool_specs`, `tool_calls`) and a `decision` + `overall_avg_score` output, with no literal
   request/verdict JSON; implementing a faithful `sparc-stub` would require reverse-engineering
   `reflector.go`/`plugin.go`. **IBAC's judge contract is documented and clean:**
   `POST {judge_endpoint}/v1/chat/completions` → an OpenAI chat-completion whose
   `choices[0].message.content` is `{"verdict":"allow"|"deny","reason":"..."}`, and IBAC fails **closed**.
2. **AuthBridge's forward proxy has no documented baked-CA TLS-interception** (only TLS-passthrough and
   SPIRE mTLS). A forward proxy can read/rewrite the `Authorization` header only on **plain HTTP**; an
   HTTPS request would be an opaque `CONNECT` tunnel it cannot rewrite.

## Decision

For the RC1 PoC:

- **(a) Control gate = `ibac` on both hops**, backed by a canned **`ibac-stub`** implementing IBAC's
  documented `/v1/chat/completions` → `{verdict,reason}` contract (fail-closed, deny by a configured
  tool/URL/arg-marker denylist). The chain is `parser → ibac → static-inject`, so a denied action is
  blocked **before** injection. SPARC's fail-open grounding gate and its undocumented `/reflect` contract
  are **deferred**. (The spec's `sparc-stub` is realized as `ibac-stub`.)
- **(b) Hop-2 proves injection against a plain-HTTP in-cluster echo target** that reflects the received
  `Authorization` — the forward proxy reads L7 and swaps the placeholder for the real token. The baked-CA
  HTTPS MITM production shape is **deferred** (already out of PoC scope per spec §10).

### Alternatives considered

- **SPARC + IBAC both** (spec as written) — rejected for RC1: SPARC's reflect contract must be
  reverse-engineered from source; the fail-open-vs-fail-closed contrast is nice to show but not required to
  prove the control-before-injection seam.
- **SPARC-only** — rejected: undocumented contract plus a fail-open default is the weaker demonstration of
  a gate that blocks before injection.
- **Baked-CA HTTPS MITM for Hop-2 now** — rejected: no documented AuthBridge support; requires CA
  distribution + sandbox trust-store wiring the PoC explicitly defers (spec §10).

## Consequences

- Positive: a documented, reliable control-gate contract; the **deny-before-inject** invariant is
  demonstrated on both hops; Hop-2 proves real injection without the baked-CA unknown.
- Negative / accepted: the **SPARC fail-open vs IBAC fail-closed contrast** (spec §6) is not demonstrated in
  RC1; Hop-2 runs over plain HTTP, so the **baked-CA production shape** (spec §3/§10) is validated later;
  IBAC's intent semantics need care so the judge actually runs for an inference request with no a2a inbound
  intent — pinned as the **first RC1-1 task** (verify against `ibac/plugin.go`/`judge.go`).
- Follow-up: a real SPARC reflection service + real IBAC judge (replace `ibac-stub`); baked-CA HTTPS
  interception for Hop-2.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
