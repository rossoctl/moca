# ADR-0025: AuthBridge (Rosso Cortex) deployment topology — shared LLM gateway, per-sandbox egress proxy

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-07-10-authbridge-egress-control-plane-poc-design.md`](../specs/2026-07-10-authbridge-egress-control-plane-poc-design.md)
- **Refined by:** [ADR-0026](0026-rc1-static-inject-plugin.md) — RC1 injection is a dedicated `static-inject` plugin, **superseding the "injection uses the stateless `token-broker` plugin backed by a small `static-broker`" clause** in the Decision below. The topology decision (shared AB1 `Deployment`/`Service` vs. per-sandbox AB2) is unchanged.

## Context

The zero-trust credential plane (Phase 2, `Z`-prefix) is being reframed around **Rosso Cortex /
AuthBridge** as the concrete injection **and** control mechanism, for a single-tenant PoC. AuthBridge is
a Go HTTP plugin pipeline that can run credential injection (`token-broker`/`token-exchange`) _and_
control plugins (`SPARC` grounding, `IBAC` intent) on the same egress hop. Adopting it forces a question
the earlier specs did not settle uniformly: **where does AuthBridge physically sit?**

Two harness egress hops need it, and they differ:

- **harness → LLM** — one fixed destination, one shared single-tenant provider key. Z3 (inference
  injector) had specified a **shared reverse-proxy pod** but explicitly _rejected_ AuthBridge in favor of
  a plain Go injector — a choice made when only _credential injection_ was in scope. Once **control
  plugins (SPARC/IBAC) are also wanted on this hop**, a plain injector is insufficient and AuthBridge is
  justified — which reopens the placement question.
- **sandbox → external API** — arbitrary destinations; Z5 (generalized credentialed egress) already
  specifies a forward proxy with a baked CA. The `#89` SandboxTransport inversion makes the sandbox
  reachable from anywhere (BYO/on-prem/other-cloud), where a central proxy cannot observe the sandbox's
  own outbound calls.

The forces: the harness is serverless/scale-to-zero (Knative); Kubernetes `NetworkPolicy` selects
_pods_, not containers; AuthBridge's in-memory `abph_` placeholder-swap is single-process only; kagenti's
target mesh is Istio **ambient** (L7 policy at a shared _waypoint_, not per-pod sidecars); and per-caller
identity attribution depends on the deferred Z1 identity spine.

## Decision

We will deploy AuthBridge in **two different shapes, one per hop**: the **harness→LLM** injector/control
gate is a **shared `Deployment` + `ClusterIP Service`** that every harness pod routes to (`AuthBridge #1`);
the **sandbox→external** injector/control gate is **co-located with each sandbox** (`AuthBridge #2`) and
ships **with the sandbox bundle** — a sidecar for in-cluster sandboxes, part of the remote bundle for BYO.
Injection uses the stateless `token-broker` plugin backed by a small `static-broker`, so the shared
gateway holds no key and is not bound by the single-process `abph_` limitation.

### Alternatives considered

- **AuthBridge #1 as a per-harness sidecar** (`envoy-sidecar`/co-located) — rejected for the shared role:
  a `NetworkPolicy` cannot stop the _harness pod_ from egressing when the proxy shares its network
  namespace, so the enforceable "harness pod has zero public egress" boundary (Z2 L3) is lost; it also
  scales a proxy with every scale-to-zero replica and diverges from the ambient/waypoint target shape.
  (It is simpler — loopback, no harness↔gateway mTLS, local session context — and remains a valid
  fallback if the egress-lockdown property is waived.)
- **AuthBridge #2 as a shared central egress proxy** — rejected: a central proxy cannot intercept a
  sandbox's own outbound calls, and for a BYO/remote sandbox that egress never touches the harness
  cluster; the proxy must travel with the sandbox.
- **Plain Go inference injector (Z3 as-written), no AuthBridge on the LLM hop** — rejected for this PoC:
  it cannot host the SPARC/IBAC control plugins that capability #3 requires on that hop.

## Consequences

- Positive: the harness pod can be locked to **zero public egress** (default-deny except → the gateway
  `Service`), giving an enforceable "no key _and_ can't phone home" boundary (Z2); a single shared audit
  and policy chokepoint for all harness→LLM traffic; alignment with the kagenti Istio-ambient _waypoint_
  production shape; the sandbox gate works identically whether the sandbox is in-cluster or BYO; because
  injection is via the stateless `token-broker`, the shared gateway can scale horizontally and no workload
  ever holds the real key (it lives only in `static-broker`).
- Negative / accepted cost: the shared gateway **cannot attribute a request to a specific caller** without
  mTLS/SPIFFE — so **per-user/per-session policy and per-caller audit are deferred to Z1** (acceptable
  while single-tenant, where there is one principal); a future multi-replica shared gateway **cannot** use
  the in-memory `abph_` placeholder-swap (single-process only) — the PoC sidesteps this by using
  `token-broker`, but it constrains that future; the SPARC/IBAC `inference` gate on the shared hop sees
  only what rides the request, so per-session intent context must be carried on the wire.
- Follow-up owed: **Z1** identity spine (SPIRE + mTLS on the harness→gateway hop) to unlock per-caller
  attribution and multi-tenant policy; a decision on multi-replica shared-gateway HA vs. the `abph_`
  feature; hardening of the baked-CA trust distribution for `AuthBridge #2`.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
