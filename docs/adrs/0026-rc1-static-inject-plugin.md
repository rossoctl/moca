# ADR-0026: RC1 credential injection via a dedicated `static-inject` plugin (not a broker service)

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-07-10-authbridge-egress-control-plane-poc-design.md`](../specs/2026-07-10-authbridge-egress-control-plane-poc-design.md)
- **Refines:** the injection-mechanism clause of [ADR-0025](0025-authbridge-deployment-topology.md) and §3 of the RC1 spec.

## Context

The RC1 spec §3 realized credential injection as AuthBridge's **shipped `token-broker` plugin** backed by a
new **`static-broker` HTTP service** (`POST /sessions/token`, keyed by `X-Server-Url`, returning the real
token). Two facts surfaced during RC1-0 planning made that a poor fit for a single-tenant, static PoC:

1. The shipped `token-broker` contract is **OAuth-issuance-shaped** — it forwards the caller's inbound JWT
   and expects the broker to _issue_ a target-service token. That is heavier than a static single-tenant
   swap, and `token-broker` is not even present in the `authbridge-lite` binary.
2. A separate `static-broker` HTTP service adds a moving part whose only job is to hand back a static
   secret — a network hop and a deployment surface with no PoC value.

kagenti-extensions **PR #626** (`placeholder-resolve`) demonstrated a cleaner pattern for exactly this
shape: an outbound AuthBridge plugin that swaps a placeholder on the `Authorization` header for a secret
resolved from a mounted source, fail-closed — no broker service.

## Decision

RC1 injects credentials with a **purpose-built AuthBridge plugin, `static-inject`**, authored in
`kagenti-extensions` on the standard `pipeline.Plugin`/`Configurable` contract and build-tag-registered in
`cmd/authbridge-proxy`. It resolves the real credential from a mounted **`secret_dir`** (or inline
`mappings` for tests), keyed by **destination host** or a **static key**, and rewrites
`Authorization: Bearer <placeholder>` → `Bearer <real>`. It **fails closed** on a missing/mismatched
placeholder, an unresolved key, or a CR/LF/NUL-unsafe value (CWE-113), and commits its config only after
full validation. It is **self-contained** — it does **not** import PR #626's `credinject` package — so RC1
carries **no dependency on that unmerged PR**. There is **no `static-broker` service**; the mounted secret
is the only place the real credential lives.

### Alternatives considered

- **Shipped `token-broker` + a new `static-broker` HTTP service** (spec §3 as written) — rejected: an
  OAuth-issuance-shaped contract and an extra service/network hop whose sole purpose is returning a static
  secret; also absent from `authbridge-lite`.
- **Reuse PR #626's `placeholder-resolve` unchanged** (`source: secret_dir`) — rejected for RC1: it is
  keyed by an `openshell:resolve:env:<KEY>` placeholder grammar rather than the destination host, and it
  ties RC1 to an unmerged external fork PR.
- **Bake the credential into the workload env** — rejected: defeats the entire "workload never holds the
  secret" invariant.

## Consequences

- Positive: the real credential lives only in AuthBridge's mounted secret (invariant preserved); one small,
  self-contained, unit-tested plugin instead of a broker service; host-keyed resolution works uniformly on
  both hops; zero dependency on the unmerged #626.
- Negative / accepted: the plugin (and the reverse-proxy SSE/Host/header fidelity fixes,
  kagenti-extensions **#657**) are now **merged to kext main**; RC1 consumes the official
  `ghcr.io/rossoctl/kagenti-extensions/authbridge` image (pinned `main-9c131ee`) — no stacked-branch
  build. The plugin is still single-tenant/static by design — **per-user issuance and RFC 8693
  token-exchange remain deferred to Z5**; this **refines** the injection-mechanism clause of
  ADR-0025 and spec §3.
- Follow-up: **#655 is DONE** (landed upstream on kext main); only the Z5 per-user / token-exchange
  source (replacing the static `secret_dir`) remains.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
