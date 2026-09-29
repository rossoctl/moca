# ADR-0036: `mocactl` is a standalone HTTP client of MU1, not a harness/control-plane feature

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-09-25
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-09-25-mocactl-control-plane-client-design.md`](../specs/2026-09-25-mocactl-control-plane-client-design.md)

## Context

MU1 (ADR-0033) shipped a full authenticated `/v1` API — device-flow login, owned sessions, named
per-user inference credentials, SSE-streamed turns — but the only existing client is
`harness/src/cli.ts`: a single-shot, unauthenticated wrapper around `/turn` with no session ownership
and no credential management, explicitly kept ambient and out of MU1's scope ("Leaf and CLI credential
paths stay ambient," MU1 spec §1). There is no interactive way to exercise the API MU1 actually built.

Four forces shape what kind of client this should be:

- **The control plane and the harness are, and will remain, independently deployed services.**
  RA1 (in progress) makes P6's VM/supervisor path the eventual primary substrate for the harness while
  Knative keeps running deprecated-but-present; P6's own spec confirms the request `handler` is
  reused byte-identical between the two. Any client has to survive that substrate churn without caring
  which one it's talking to.
- **Two token lifetimes, two endpoints.** An API token (1h, no refresh) authenticates control-plane
  calls; a session token (5min, re-mintable) authenticates `/turn`. "Just call the API" undersells the
  amount of real session/auth-lifecycle logic a usable client needs.
- **No TUI/CLI framework exists anywhere in this monorepo.** Every CLI here (`cli.ts`,
  `promote-cli.ts`) is hand-rolled argv parsing. This is a first, unconstrained choice, not an
  extension of an existing pattern.
- **A UX bar already exists outside this repo.** OpenCode's TUI (persistent chat view, overlay
  panels, leader-key + slash-command + fuzzy palette, live-streamed rendering, a theme-token layer) is
  a working answer to "what should a terminal coding-agent client feel like," not a hypothetical.

## Decision

We will build **`mocactl`** (`packages/mocactl`, `@moca/mocactl`) as a standalone terminal client that
communicates **exclusively** over MU1's `/v1` HTTP API. It declares **no `workspace:*` dependency on
any `@moca/*` package** and makes no assumption about what deployment substrate — Knative today, P6's
VM/supervisor path once RA1 lands — sits behind the one URL it is given: the control plane's. The
control plane says where the harness is through a public `GET /v1/discovery` (set by the operator
with `SH_PUBLIC_HARNESS_URL`); a local `--harness-url` overrides it. It is built on **Ink/React**, the first TUI framework introduced into this monorepo, and its
interaction model is deliberately modeled on OpenCode's conventions: one persistent chat view with
session, credential, and login functions as dismissable overlays, each reachable by slash-command,
leader-key (`ctrl+x` + mnemonic), and a fuzzy command palette (`ctrl+p`), all generated from one
data-driven command table; per-tool rich rendering (including an `edit` diff built from arguments
already on the wire); and a centralized theme-token layer whose default maps onto the terminal's own
palette. Its session, auth, and transcript logic lives in a UI-free core shared with a headless
`mocactl run` and a `mocactl doctor`.

### Alternatives considered

- **Extend `harness/src/cli.ts` into an interactive client** — rejected: it is ambient/unauthenticated
  by design, and retrofitting session ownership and credentials onto it would blur the one property
  MU1 exists to guarantee (a request's identity is determined solely by that request).
- **Build the client inside `packages/control-plane` or `packages/knative-server`** — rejected: gives
  a terminal client a workspace dependency on server-side internals it doesn't need, coupling its
  release and versioning to code it should only ever reach over HTTP.
- **blessed/neo-blessed, or a raw-ANSI renderer, instead of Ink** — rejected: more boilerplate on a
  less actively maintained ecosystem (blessed), or a full layout/input/diffing reimplementation (raw),
  for no benefit over Ink's React-state-to-render mapping, which fits a live SSE frame stream
  naturally.
- **Two user-supplied URLs (control plane and harness)** — rejected in revision 1.2: users found two
  addresses for one service confusing. Deriving the harness from the control-plane URL by convention
  (same origin behind a path-routing proxy) was also rejected, because it would oblige every
  deployment to run that proxy.
- **An original, from-scratch UX** — rejected: OpenCode has already solved "what does a good terminal
  coding-agent client feel like." Matching its conventions lowers the learning curve for anyone coming
  from it and avoids re-solving an already-solved interaction-design problem.

## Consequences

- Positive: the client is portable across whatever substrate the harness ends up on without a single
  line changing, because it never assumes anything about what is behind either configured URL.
- Positive: one small backend change ships with it — `GET /v1/discovery` — and everything else a v1
  needs (auth, sessions, credentials, SSE turns) MU1 already exposes. It buys a one-URL setup, and it
  is the seam through which the control plane can later place sessions on different harnesses.
- Negative / accepted cost: an operator must set `SH_PUBLIC_HARNESS_URL` to the harness as a CLIENT
  reaches it, which is not the in-cluster address; a deployment that sets nothing gets a one-line fix
  from `mocactl`, not a guess.
- Positive: users get an already-validated interaction model (OpenCode's) instead of a bespoke one
  they have to learn from scratch.
- Negative / accepted cost: two things a user might reasonably call "configuring the harness/sandbox"
  — model selection and sandbox pool/resource/tool selection — are not reachable from this client,
  because neither has an HTTP surface today. The second is an explicitly named MU2 gap in MU1 §8.2
  ("the `/turn` path does not lease from the pool at all"), not an oversight introduced here.
- Negative / accepted cost: pointing this client at a P6/VM-deployed harness requires that
  deployment's operator to add MU1's auth env vars first — verified absent from
  `deploy/vm/env/supervisor.env.example` today. The client cannot fix that, but it detects it: a
  harness that rejects a freshly minted session token is diagnosed as "does not trust this control
  plane" (and by `mocactl doctor`) rather than looping the user through re-login.
- Negative / accepted cost: no route returns a session's messages, so resume-with-history is served
  from a **local, per-subject transcript store**. Resuming a session started on another machine shows
  no history (the model's context is intact server-side; only the display is missing).
- Negative / accepted cost: the server does not serialize concurrent turns of one session, so the
  client enforces one in-flight turn per session and queues the rest. Another client on the same
  session is not protected.
- Follow-up owed: session creation is described as a schema of option fields, so when
  model-selection or sandbox-selection gain an HTTP surface, supporting each is one new field entry
  rather than a redesign.
- Follow-up owed: `GET /v1/sessions/{id}/messages` is the highest-value backend addition for this
  client — it makes history cross-device and turns the local store into a cache.
- Follow-up owed: no track/milestone prefix is claimed for this work (spec §11); assigning one, if
  wanted, is left to whoever accepts the spec.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
