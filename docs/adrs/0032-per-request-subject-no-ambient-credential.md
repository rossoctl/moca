# ADR-0032: Multi-session isolation comes from a per-request subject and no ambient credential, not from a `SessionContext` in `pi-fork`

- **Status:** Proposed
- **Date:** 2026-09-06
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-09-06-p5-session-isolation-design.md`](../specs/2026-09-06-p5-session-isolation-design.md)

## Context

Running N Pi sessions in one harness process is the largest density lever available
([#220](https://github.com/rossoctl/moca/issues/220)): sessions idle 80–90% of
wall-clock, yet each owns a pod. #220 attributes the blockage to five process-global mutable states,
four of them in `pi-fork`, and proposes threading a `SessionContext` through the call chain.

Tracing the code contradicts that framing. Pi's request-auth path is **already per-session**:
`AgentSession._getRequiredRequestAuth` resolves credentials from a per-instance `ModelRegistry` and
passes an explicit `apiKey` into stream options, and `withEnvApiKey` (`stream.ts:26`) consults the
environment **only when no explicit key was given**. Of the other four globals, one is unreachable
in server mode (`takeOverStdout` is called only from the CLI and RPC entrypoints), one is already
session-scoped (its sole registrant filters by `sessionId`), and two are low-severity. The harness's
own `process.env.ANTHROPIC_API_KEY` seed is what activates the ambient fallback beneath Pi's
per-session mechanism — and because it is write-once-**if-absent**, session A's token sticks
process-wide and B..N authenticate **as A**: a cross-tenant identity leak, not the mutual corruption
the issue describes.

Tracing also surfaced a prerequisite #220 never names: **no per-session credential enters the harness
at all.** Every `buildConfig()` call site fills the token from `process.env`, so the pod's
environment _is_ the credential, one per deployment. Deleting the seed alone would leave every
session with no credential rather than fixing a leak.

Meanwhile the obvious fix — accept a real credential per request — is already forbidden here.
ADR-0011 requires a secret-free harness, ADR-0012 puts the provider keys in a separate injector pod,
and ADR-0026's `static-inject` plugin swaps `Authorization: Bearer <placeholder>` for the real
secret, having explicitly **rejected** "bake the credential into the workload env". That invariant is
currently documented prose with no test pinning it.

## Decision

We will make multi-session isolation a property of **identity flow**, not of state scoping: the
harness carries a **per-request subject** (`X-SH-Subject`) from which it derives an **inert
placeholder**, never a provider credential; and we will **remove every ambient identity source** in
server mode — the `ANTHROPIC_API_KEY` seed, the `ANTHROPIC_AUTH_TOKEN` fallback, and any ambient
credential or tenant placeholder in `process.env` — so a credential-less session **fails closed**
instead of inheriting its neighbour's identity.

One ambient value survives, deliberately. `ANTHROPIC_API_KEY` cannot be deleted: pi resolves the
request key **by provider name** (`run-turn.ts:150-155` documents this), and `createAgentSession`
offers no seam for a per-session key, so an absent variable throws `No API key found for "anthropic"`
before any request is made. Server mode therefore sets it to a **fixed non-secret sentinel** —
identical for every tenant, so it asserts no identity; stripped before the wire by
`'x-api-key': null`; and _assertable_, which deletion is not. Removing it entirely would require the
`pi-fork` seam this decision exists to avoid.

The three steps are strictly ordered — inflow, then fallback removal, then scrub — because removing
the fallback before the inflow exists would leave every session unauthenticated.

`pi-fork` is **not** modified. The four remaining globals are **pinned by reachability tests** rather
than refactored, on the principle that an inert global should be proven inert and left alone.

## Alternatives considered

- **Thread a `SessionContext` through `pi-fork`** (#220's proposal) — four refactors that add fork
  divergence to fix a credential path that is already per-session and three globals that are inert.
- **Accept a real per-request credential in a header** — contradicts ADR-0011/0012/0026; makes the
  harness a secret-bearing multi-tenant relay, which is the invariant those ADRs exist to prevent.
- **`AsyncLocalStorage` ambient context in `pi-fork`** — catches globals we never enumerated, but is
  a large divergence in a core module, loses context across some async boundaries, and makes
  credential flow _implicit_ — the opposite of what a provable security property needs.
- **Worker-thread isolation (K sessions as K workers)** — isolation for free, including unenumerated
  globals, but each worker carries its own module graph; at 50–100 sessions per pod the heap cost
  eats the density win. Viable fallback at K≈4–8 for a 5–10× gain, not 100×.
- **Single-tenant multiplexing only** — smallest change, and the credential question mostly
  evaporates, but it bakes in ambient assumptions that a later mixed-tenant pod would have to undo.

## Consequences

- Positive: isolation becomes **structural** — with no ambient identity in the process, "we passed
  the right one" stops being a hoped-for behaviour and becomes a precondition the process cannot
  violate. Zero `pi-fork` divergence. ADR-0011/0012's "harness holds no key" invariant gains its
  first test — scoped to the **process**, not yet to the pod (see the follow-up below).
- Positive: the harness becomes tenancy-**neutral**, so enabling mixed tenancy later is an injector
  configuration change, not a harness rewrite.
- Negative / accepted cost: a new inbound header contract and a new non-secret subject → placeholder
  mapping to deploy and keep correct. Callers on the turn path must supply a subject or receive 401 —
  a deliberate breaking change on that path, justified by fail-closed.
- Negative / accepted cost: **this slice cannot claim end-to-end multi-tenant safety.**
  `static-inject` resolves by destination host or a static key, so per-subject resolution at the
  injector remains Z5's deferred per-user / RFC 8693 half, in `kagenti-extensions`. The harness half
  is the strict prerequisite — the injector cannot key on a subject the harness never sends.
- Negative / accepted cost: `ANTHROPIC_API_KEY` remains set, to a sentinel. "The process holds no
  ambient credential" is therefore true of _identity_ but not literally of the variable — a
  distinction a reader could mistake for a loophole, which is why the sentinel's exact value is
  asserted by a test rather than left to convention, together with the absence of the
  higher-precedence `ANTHROPIC_OAUTH_TOKEN`, which would otherwise outrank it.
- Negative / accepted cost: the scrub is **in-process**, while the manifests still deliver a real
  credential to the container (`service.yaml:45-49`, `:56`). The harness _process_ ends up
  sentinel-only; the harness _pod_ does not. Editing the manifest alone cannot fix it, since no
  manifest puts an injector in the harness's egress path — a sentinel-only pod could reach no model.
- Negative / accepted: an ambient **placeholder** is treated as strictly as an ambient key, because
  the injector faithfully swaps it for the real credential — so a leaked placeholder spends tenant
  A's budget on B's work and produces an audit trail that certifies the error instead of catching it.
- Follow-up owed: the **secret-free harness pod** — dropping `llm-credentials` from the ksvc and
  putting an injector in the harness's egress path — belongs to the lock-down slice (ADR-0011 · Z2)
  and injector deployment (ADR-0012 · Z3), not to this one.
- Follow-up owed: the deployment-model slice (`ScaledJob` → elastic pod pool, and #55's overload
  shift from pod-level to session-level) is separate and unblocked by this. `#220`'s severity table
  needs the spec's §2.1 corrections before anyone scopes from it. `cwd` (`server.ts:69`) is
  process-wide and unlisted by #220; if a session-scoped file operation resolves against
  `process.cwd()`, scope grows.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
