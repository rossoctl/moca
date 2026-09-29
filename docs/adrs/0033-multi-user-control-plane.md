# ADR-0033: An always-on control plane owns multi-user identity and credentials

- **Status:** Accepted <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-09-08
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-09-08-multi-user-control-plane-design.md`](../specs/2026-09-08-multi-user-control-plane-design.md)

> P5's session-isolation design took ADR-0032 and is now **merged**, so this is simply the next free
> number. P5's **implementation** remains a separate contributor's track on a different timeline; the
> linked spec §3.5 records how the two compose and what this decision delivers before P5 lands.

## Context

The harness is single-tenant by construction. `buildConfig()` reads one
`ANTHROPIC_AUTH_TOKEN` from the process environment for every caller
(`packages/knative-server/src/server.ts:66-73`), the session store has no owner concept
(`LogStore.list()` returns all session ids), no route reads an `Authorization` header, and all leaves
share one service-account identity. Supporting several users means deciding, at once, where the
authenticated subject comes from, where per-user credentials live, and which component is trusted to
hold them.

Three forces shape the answer:

- **The target design is not available.** [Z1](../specs/2026-06-26-identity-spine-design.md) puts a
  trusted orchestrator above the harness and keeps credentials out of it entirely, with per-subject
  resolution happening at the [Z3](../specs/2026-06-26-inference-injector-design.md)/[Z5](../specs/2026-06-19-m13-generalized-credentialed-egress-design.md)
  injector. That resolution lives in `rossoctl/cortex` (formerly `kagenti-extensions`), outside this repo, so
  building on it blocks
  every user-visible deliverable on another codebase.
- **The harness is the wrong place for either.** It processes untrusted model output, so it must not be
  able to mint identity, and per Z2/ADR-0011 it should hold no secret. An ambient credential there is
  worse than untidy: the write-once-if-absent seed at `harness/src/run-turn.ts:310-312` makes session
  A's token stick process-wide, so B..N authenticate **as A**.
- **Something has to be demonstrable soon**, which rules out sequencing the full credential plane first.

## Decision

We will introduce **`@moca/control-plane`**, an always-on Deployment that owns the authenticated `/v1`
API, the session-ownership index, per-user credential storage, and resource introspection, as **MU1**
in a new `MU` (multi-user service) track rather than as a Phase-2 `Z` id — Phase 2 is a security
architecture, this is a product surface. It
authenticates users (GitHub OAuth in slice 1), mints an **Ed25519** session token carrying subject and
session id but **no secret**, and the data plane exchanges that token — over a shared-secret-authenticated
internal hop, reusing the `SH_RELAY_TOKEN` pattern already in the tree — for the subject's
credential at the start of each turn.

We accept, and contain, a **divergence from Z1 §2**: that table gives the orchestrator "Holds secrets?
no", and our control plane both mints identity and holds the credential store.

The containments are the reason the cost is bounded:

- A `CredentialStore` interface, so slice 3 moves resolution behind the Z3/Z5 injector without
  reshaping a handler or an endpoint, and so Vault or External Secrets can replace Kubernetes Secrets
  later.
- Credential Secrets in a dedicated `sh-credentials` namespace, with **no `list` verb** granted to the
  serving path — names are derived from the subject, so every access is a `get` by exact name and the
  serving path cannot enumerate users.
- Envelope encryption (AES-256-GCM, KEK in a separate Secret) with **AAD = `subject|name`**, so a
  namespace-wide secret read yields ciphertext and an attacker who can write Secrets cannot relabel one
  user's ciphertext into another's row.

### Alternatives considered

- **Retrofit auth onto the Knative Service** — one deployable and fastest to demo, but the process
  verifying tokens and holding credentials would be the same one running model output, contradicting
  Z2/ADR-0011, and every `GET /v1/sessions` would pay a scale-to-zero cold start.
- **Gateway-only auth (oauth2-proxy / Istio injecting a subject header)** — least new code, but the
  harness would then trust an asserted header, which Z1 §3.2 identifies as precisely the spoofable
  signal that per-session identity exists to replace.
- **Wait for Z3/Z5 per-subject resolution** — the correct end state, and still the slice-3 target, but
  it blocks all user-visible work on `rossoctl/cortex`.
- **Per-user credentials in Redis** — rejected on inspection: `deploy/knative/redis.yaml` has no PVC and
  no `appendonly`, so every user's key would be lost on a pod restart.

## Consequences

- Positive: a request's upstream identity is determined solely by that request. Two enforcement points
  the control plane owns — session creation and the credential exchange — refuse a subject with no
  resolvable credential, so a credential-less session fails closed instead of borrowing its
  neighbour's. Pinned by a test that sets `ANTHROPIC_AUTH_TOKEN` in the environment and asserts the
  session is still refused.
- Positive: the harness cannot forge identity **from the sandbox tier**, where model code runs. Ed25519
  with a public-key-only verifier makes that structural rather than procedural — but namespace
  collocation (below) means code execution in the harness pod itself can still reach the signing key,
  so the guarantee is bounded to the tier, not absolute. Spec §8.1/§8.2.
- Positive: the control plane stays off the data path — one small exchange per turn, and it never sees a
  prompt or a model response.
- Negative / accepted cost: the identity minter and the credential store are one component, against
  Z1's explicit separation. Compromising the control plane compromises both.
- Negative / accepted cost: in **direct mode** the harness transiently holds a raw provider key in
  memory. This diverges from **P5 §5**'s in-process lock-down invariant ("no real provider credential
  is reachable from the harness process in server mode") as well as from Z1 §2 / Z3, and is named in
  both places so P5's implementation does not assert an invariant this decision knowingly breaks. The
  credential is **tagged** (`placeholder` vs `direct`) rather than passed as a bare string, so the
  mode is assertable; placeholder mode wins wherever an injector is configured, and MU3 deletes
  direct mode outright. Spec §3.6.
- Negative / accepted cost: until P5's startup sentinel lands, "no ambient identity" is enforced **by
  policy** (two checks) rather than **by construction** (nothing reachable). The spec §3.5 refuses to
  blur the two, and §9.3 test 1 asserts the policy form now and tightens later.
- Negative / accepted cost: the operator-key fallback does not disappear, it relocates — behind
  `SH_ALLOW_OPERATOR_FALLBACK` (default `false`), resolved by the trusted tier where it is attributable and
  logged rather than ambient in the harness.
- Negative / accepted cost: revoking a user at the identity provider does not stop their scheduled runs,
  because the stored credential — not an OIDC grant — is what authorizes background egress.
- Negative / accepted cost: auth on the data plane ships behind **`SH_REQUIRE_AUTH`, default `false`**,
  because 14 existing `deploy/knative/` scripts call `/turn` and `/runs` unauthenticated. A deployment
  that does not set the flag keeps today's behaviour and makes none of the isolation claims. A
  present-but-invalid token fails in either mode — the flag governs whether auth is _required_, never
  whether it is _enforced_. Flipping the default and updating those callers is MU2.
- Negative / accepted cost: the internal exchange is authenticated by a shared token, so any code able
  to run in the harness pod can call it. Bounded by the exchange returning only the subject named in a
  **signed** token the harness cannot mint; Z1's per-session SVIDs replace it with a per-session
  caller identity, which a shared secret cannot express.
- Follow-up owed: slice 1 ships a **shared** sandbox pool, so two users' leaves can land on the same
  pod; isolation holds at the API, session store, and inference credential only, and the demo says so.
  The tenant-labelled partition is blocked on the ADR-0028 deferral at `server.ts:308-320`, where a
  workload's pool selector is deliberately ignored for `kind: 'prompt'` leaves.
- Follow-up owed: the control plane's Deployment and Secrets currently sit in the same namespace as
  the harness, and the same unscoped `pods/exec` grant the harness needs for sandbox pods also reaches
  the control-plane pod, so code execution in the harness pod can read the signing key, KEK, and
  exchange token from its environment. Bounded to that tier, not to the sandbox where model code
  runs. The fix is moving the Deployment and its Secrets into the `sh-credentials` namespace already
  shipped for the credential store, which also splits the pod-phase RBAC behind `/resources`. Not done
  in slice 1. Spec §8.2.
- Follow-up owed: deliver `sandbox-egress` credentials via Z5 rather than storing them unconsumed, and
  retire this divergence as MU3. The environment fallbacks, the startup sentinel, and the leaf/CLI
  paths are all **P5's**, so this decision deliberately touches no line of `run-turn.ts` — the linked
  spec §3.4 explains why deleting the `:310-312` seed without P5's sentinel would break gateway mode
  outright.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
