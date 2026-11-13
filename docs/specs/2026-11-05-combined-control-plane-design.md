# One control plane for sessions and sandboxes — Design

Version: 0.1 — November 2026
Status: Accepted (C1-C4, §5); increments 1-6 built; increment 7 (a run with both kinds of client on
the same templates) not started
Builds on: [template lifecycle and provenance](2026-11-03-template-lifecycle-and-provenance-design.md)
§4.1 (the template routes on both profiles), [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md)
§4 (the sandbox profile, its token separation) and
[session sandbox templates](2026-10-30-session-sandbox-templates-design.md) (a session names a
template).

## 1. Why

A Moca Pi brain (sessions) and a stock agent (sandboxes) that work on the same task should be served
by **one** control plane, so both brains' runs use the same build, the same activation lease and
the same provenance chain, and no question of two processes sharing leases enters a comparison of
the two. Today they cannot: `SH_ROUTE_PROFILE` is `harness` or `sandbox`, one per process
(`routes.ts` `matchRoute`, `sandbox-config.ts` `routeProfileFromEnv`), and SBX0 runs as its own
`sandbox`-profile stack in its own namespace. The template routes already mount on both; sessions
and sandboxes do not.

What is missing for a Moca Pi session on a template build:

- a session's template is checked against the **static** `SH_SANDBOX_TEMPLATES` list, not the
  template store (`handlers.ts` `createSession`), so a self-serve template cannot back a session;
- turns route by the worker's template label, not by build, and a session on an inactive template
  is not gated (activation on first use, lifecycle §6.4, is built for sandboxes only);
- the two kinds of client cannot share one store, quota or lease.

## 2. What exists (from the code)

| Concern                   | `harness` profile                                                                                                                  | `sandbox` profile                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes only here          | `/v1/sessions*`, `/v1/models`, `/v1/config-bundles*`, `/internal/credentials`, `/v1/auth/test-token`                               | `/v1/sandboxes*`, `/v1/janitor/sandboxes`, `/v1/egress/credential`                                                                                             |
| On both                   | health, `/v1/discovery`, the auth routes, `/v1/me`, `/v1/credentials*`, `/v1/templates*`, `/v1/policy`, `/v1/quota`, `/v1/hosts/*` | (same)                                                                                                                                                         |
| Who logs in               | any GitHub account (MU1); test users if `SH_TEST_USERS`                                                                            | enrolled only (`SH_ALLOWED_SUBJECTS`, admins), checked at login and refresh (`isEnrolled`)                                                                     |
| API token issuer          | `sh-control-plane`                                                                                                                 | `sbx-control-plane-api` (`apiIssuer`): so neither accepts the other's, even with one key                                                                       |
| Sandbox token             | —                                                                                                                                  | its own `typ`, `aud` `moca-sandbox`, `iss` `sbx-control-plane`                                                                                                 |
| Settings only here        | `SH_CREDENTIAL_KEK`, `SH_EXCHANGE_TOKEN`, inference catalogue, bundles, `SH_SANDBOX_TIERS`, test users                             | `SH_ALLOWED_SUBJECTS`, `SH_SANDBOX_EXEC_ENDPOINT`/`EXEC_CA`, `SH_JANITOR_TOKEN`, the sandbox lifetimes and caps, `SH_EGRESS_HOSTS`                             |
| Stores                    | sessions (`sh:cp:*`), refresh, bundles, credentials (Kubernetes)                                                                   | sandboxes (`sbx:*`), presence, refresh; credentials only with egress                                                                                           |
| Same path, two behaviours | `/v1/discovery` (harness URL, tiers, templates)                                                                                    | `/v1/discovery` (`profile`, exec endpoint, its CA); `/v1/credentials*` (enrolled, egress kind only)                                                            |
| Deployment                | `deploy/k8s` (ocp overlay), its hostname, Secret `moca-mu1`                                                                        | `deploy/sbx/setup.sh` + `ocp-sbx`: own namespace, own Redis, own `sbx-api.*` host, refuses a `moca-mu1` it did not make; NetworkPolicy without kube-API egress |

Redis key prefixes do not collide (`sh:cp:*`, `sbx:*`).

## 3. Design

**A third value, `SH_ROUTE_PROFILE=combined`:** the union of both route sets in one process. The
existing `harness` and `sandbox` profiles stay exactly as they are (SBX0's deployments and the Moca
deployments do not change); `combined` is opt-in, for a deployment that runs both brains.

### 3.1 Routes

`matchRoute` mounts a route on `combined` when its `profiles` names `harness` **or** `sandbox`
(`mountsOn`). No path is in both sets with two meanings, so there is no collision. The routes that
branch on the profile get one rule each:

- `/v1/discovery` returns the **union**: `profile: "combined"`, the harness fields (`harnessUrl`,
  `sandboxTiers`, `sandboxTemplates`, `version`) and the sandbox fields (`execEndpoint`, `execCa`).
  `mocactl sbx` accepts `sandbox` or `combined`; `mocactl` (sessions) ignores the field.
- `/v1/credentials*` keeps the harness store and behaviour, and the sandbox `sandbox-egress` kind is
  accepted only when egress is configured (as on `sandbox`). The egress gate applies on `combined`
  only to the sandbox-only route (`/v1/egress/credential`), so the credential routes stay mounted
  for the harness users. As on `sandbox`, two `sandbox-egress` credentials of one subject never
  hold one destination (`destination_conflict`), and `/v1/egress/credential` serves only an owner
  enrolled for sandboxes (`isEnrolledForSandbox`, §3.2).

### 3.2 Who may call what

**Login stays open as on `harness`** (any GitHub account; test users if configured), and
**enrollment moves from the login to the routes:** on `combined`, every sandbox route and every
template write (create, build, cancel, activate, deactivate, policy PUT) checks it, and so does a
session's activation on first use (§3.4); a test user is refused there (`not_enrolled`). Sessions, models and bundles stay open to any logged-in subject,
as on `harness`, and so do the template, policy and quota reads (on `sandbox` they stay
enrolled-only). In the code: `isEnrolled` is the login gate (open on `combined`),
`isEnrolledForSandbox` the route gate (`requireEnrolledPrincipal`), and `requireReader` the reads.

Consequence to note: on `combined` a non-enrolled GitHub user can log in and use sessions, as on
`harness`; on `sandbox` they cannot log in at all. A deployment that wants SBX0's closed login keeps
the `sandbox` profile.

### 3.3 Tokens

- **API tokens** on `combined` use the harness issuer `sh-control-plane`, so a `sandbox` stack
  sharing the key accepts none of them.
- **The sandbox token** is unchanged in every field (`typ`, `aud`, `iss`), so it never passes as an
  API or session token, nor the reverse; the relay verifies it as before.
- **Session tokens** are unchanged.

### 3.4 One template catalog for both

- `createSession` resolves the session's template **through the template store**, as
  `createSandbox` does (`resolveForUse`): `id`, `id:tag` or `id@sha256:…`, a registered build, the
  visible templates only. The static `SH_SANDBOX_TEMPLATES` list remains the import source and the
  fallback without `SH_PROVENANCE_DIR`.
- **First use (lifecycle §6.4) for sessions:** the same `requireActive` rule. On a deployment with
  host agents, a session on a build that is not active takes the caller's lease and answers
  `409 template_not_active` with `Retry-After`; `sandbox.activate: false` starts nothing.
  Activation stays enrolled-only (§3.2): a caller not enrolled for sandboxes takes no lease. It
  waits (409) on a build another subject's lease is starting, and is refused (`403 not_enrolled`)
  on one nobody is starting. The activation is the create's last check, after the `configRef`,
  credential and model checks, so a create refused for another reason holds no lease.
  `mocactl`'s `SessionManager.create` retries it for up to 10 minutes, as `sbx create` does, saying
  why in headless runs.
- **Turns by build:** the session records `sandboxBuildId`. `microvm-worker` adds a build label,
  `moca.dev/build`, from the manifest it verified at start (`session.WithBuild`), beside
  `moca.dev/tier` and `moca.dev/template` (`session/labels.go`). The exchange returns
  `sandboxBuildId` for a manifest-hash build (never an `imported:` one); the data plane
  (`turn-auth`, `run-turn`) passes it to `selectPoolSandbox`, which keeps only workers labelled with
  it and refuses the turn when none is attached. So a session pinned to a build never runs on
  another. The label is the worker's own claim, from its Hello: the relay does not check it
  against the attach token, so a compromised worker can claim any build. That is the trust
  `moca.dev/template` already has, and no new exposure.
- **A pinned session keeps its worker while in use:** nothing else would. The first-use lease
  runs out (by default after the hosts' idle limit, 3600 s), and an active build takes no lease for
  a later session, so the host agent would stop the worker between turns and the next turn would
  find none. So each turn's credential exchange (interactive or queued) keeps the build's worker
  for the hold, the same length as a default lease, from that turn, as a live sandbox keeps its
  worker (`busyWorkers`): it is not stopped while held, and keeps its slot. A hold keeps a worker
  that runs; it never starts one, and never counts as a lease or against `quota.active`. Only the
  turns of a subject enrolled for sandboxes hold (the rule first-use leases follow): a subject who
  is not enrolled has its turns run on an active build while the worker is up, but they extend
  nothing, so they cannot keep a build running after its owner and every lease holder have released
  it (deactivate, the host's capacity).
  **Failure mode:** a session with no turn for longer than the hold (or across a control-plane
  restart, which forgets the holds as it forgets host state until the next turn) can find its
  worker stopped; its next turn is refused (`503 sandbox_unavailable`), and a subject not enrolled
  cannot start it again. **Recovery:** an enrolled subject activates the template
  (`mocactl sbx templates activate ID --wait`, or `POST /v1/templates/{id}/activate`), and the
  session's turns run again once its worker is attached; the session keeps its build, so nothing
  else changes.
- **Upgrade order:** sandboxes route by worker id and ignore the label; an unpinned session matches
  by template as before; only a pinned session refuses a worker without the label. So the worker
  rebuild must precede the first pinned Moca Pi session on a combined deployment, and nothing else
  depends on the order (on a `sandbox`-profile deployment, nothing does).

### 3.5 Settings and stores

`combined` reads both settings sets: everything `harness` requires (KEK, exchange token, inference)
and everything `sandbox` requires (allowed subjects, exec endpoint and CA, janitor token, sandbox
caps), and builds both sets of stores on its one Redis. A missing required setting of either refuses
the start, naming it (as each profile does). `configFromEnv` reads the harness settings, then the
sandbox block (`combinedProfileConfig`); the one template list is both the sessions' and the
sandboxes'. Egress follows `SH_EGRESS_HOSTS` alone on `combined`, since the KEK is always set there
(the harness credential store's).

### 3.6 Deployment

A new overlay, `deploy/k8s/overlays/ocp-combined`: the harness control plane of `deploy/k8s` with
`SH_ROUTE_PROFILE=combined`, the SBX0 settings, the template store (the `template-store` component),
the relay with both Routes (attach and exec) and the janitor. One namespace, one Redis, one signing
key (Secret `moca-mu1`, made by `deploy/k8s/setup.sh`), one API host. The harness's credentials are
files on a volume of their own (`SH_CREDENTIAL_STORE=file`): no Role, no service account token, so
no Kubernetes API access (the base NetworkPolicy's egress on 443/6443 stays, for GitHub's device
flow). No cluster-scoped object.

`deploy/sbx/tests/overlay-combined.test.sh` renders it and asserts the combined profile, both
profiles' credentials, the relay's two Exec callers, one namespace and no cluster-scoped object.
`deploy/sbx/setup.sh` deploys it with `SBX_PROFILE=combined`: the harness's keys added to
`moca-mu1` (the public keyset, KEK, exchange token), the harness's exec token kept, the template
store on, its own addresses, the supervisor's Route (`SBX_MOCA_HOST`); tested without a cluster in
`deploy/sbx/tests/setup.test.sh`. It writes to `deploy/sbx/.generated-<namespace>/`, so the same
checkout leaves an SBX0 namespace's generated files alone.

**The isolation boundary changes.** The relay takes two kinds of Exec caller on one listener: the
harness's exec token (`MOCA_RELAY_EXEC_TOKEN`, checked first in `execCaller`) and the per-sandbox
tokens. The harness's token is not scoped to a sandbox: it allows Exec into any attached worker, so
on `combined` also into the sandboxes of enrolled users. A compromised supervisor, which holds that
token, therefore reaches those sandboxes; with SBX0 in a namespace of its own it reaches none. A
deployment that needs that separation keeps the two profiles in two namespaces.

Run it in a new namespace, so an SBX0 deployment stays as it is; the templates are brought in by
create there (the template store does not move between namespaces).

## 4. Increments (each tested)

1. **Routes and discovery:** the `combined` profile, `matchRoute`'s union, the union discovery, the
   route-table and openapi tests; `mocactl sbx` accepts `combined`. No behaviour change on the two
   existing profiles (their tests unchanged).
2. **Who may call what:** enrollment on the routes (§3.2), test users refused on sandbox and
   template-write routes on `combined`; token-separation tests: a
   `combined` API token refused by a `sandbox` stack sharing the key, a sandbox token refused as an
   API or session token.
3. **Settings and stores:** `configFromEnv` and `depsFromEnv` for `combined`, with refusals naming
   each missing setting.
4. **Sessions through the template store:** `createSession` by `resolveForUse`; first use for
   sessions; `mocactl` retries.
5. **Turns by build:** the worker's build label, `select-sandbox.ts` by build, a pinned session
   never on another build.
6. **Deployment:** `ocp-combined` and its setup steps, in a new namespace. A new namespace is a
   cluster-scoped change: its step list names the namespace, every cluster-scoped object it creates
   or touches, and its teardown, and needs the cluster owner's approval.
7. **A run with both brains** on the same templates.

Increments 1-5 are code and tests only; 6 and 7 need a cluster (and a KVM host for 7).

## 5. Decisions

| #   | Question                                                                                                    | Decision                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| C1  | A third profile `combined`, or change `harness` to mount the sandbox routes when SBX0 settings are present? | **`combined`**: explicit, and today's `harness` deployments do not change |
| C2  | Login on `combined`: open (as `harness`, enrollment on the routes) or closed (as `sandbox`)?                | **open**, enrollment on the sandbox and template-write routes             |
| C3  | Where to run it: a new namespace, or convert an SBX0 namespace?                                             | **a new namespace**; SBX0 stays as it is                                  |
| C4  | Turns by build in this design, or later?                                                                    | **in it** (increment 5): without it a session's build is not guaranteed   |

## 6. Limits

- On `combined` a non-enrolled login can use sessions, as on `harness` (§3.2).
- A pinned session idle for longer than the hold can lose its worker, until an enrolled subject
  activates the template again (§3.4). A subject not enrolled holds no worker at all: its session
  runs only while some lease or an enrolled subject's turns keep the worker up.
- On `combined` the harness's exec token reaches every attached worker, the sandboxes of enrolled
  users included (§3.6): a supervisor compromise is no longer contained to the harness's workers.
- With no model-catalog hosts, a session's `model` is accepted unverified (`modelVerified: false`).
- A session needs an inference credential even if it runs no turn.
- `credentials` of the egress kind on `combined` only when egress is configured.
