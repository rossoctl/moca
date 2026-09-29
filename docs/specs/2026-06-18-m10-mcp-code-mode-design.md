# M10 Design: MCP via Code-Mode in the Sandbox

Version: 1.1 — June 19, 2026
Status: Design (approved for implementation planning)
Scope: How MCP tool calls are originated in the serverless harness — as **code the model
runs in the sandbox**, not as harness-native tool calls and not through a standalone
terminating gateway — and the **credential/identity model** that injects per-user,
unattended-session credentials at egress.
Parent design: [Zero-Trust, Multi-Agent Extensions to the MOCA](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) §3.3 (MCP servers — gateway invocation), M10; §2 spine; M7–M9 credential plane
Builds on: M1 (Redis session backend), M2 (`K8sSandboxClient`), M3 (persistent channel), M4 (Knative wrapper)

> **Supersedes §3.3 of the parent design.** The parent doc chose a dedicated MCP gateway
> with harness-registered `registerTool` _forwarding tools_. This spec replaces that with a
> **code-execution-with-MCP** model: the model writes a script that calls MCP from inside the
> sandbox, and credential injection + per-call audit happen transparently at the egress
> waypoint. The spine (§2 of the parent) is unchanged and, if anything, more cleanly honored.

> **Changelog 1.1:** added §5 (credential & identity model) — where secrets live, the
> unattended per-user delegation mechanism (SPIFFE actor + bound subject + pre-authorized
> Keycloak delegation, RFC 8693 §4.1), the best-fit comparison of AuthBridge / OpenShell /
> DAM, and the resulting decisions D8–D10. The cross-cutting identity-plane build belongs to
> the M7–M9 spine; M10 specs the MCP-egress slice and records the chosen model so the spine
> milestones inherit it.

---

## 1. Goal & scope

The parent design settled three things about MCP and left one open:

- **Settled:** MCP servers are separate kagenti-deployed components with their own
  identities and lifecycle; the harness must hold no MCP backend credentials; the design
  must fit the zero-trust spine (no model-influenced component holds a raw secret).
- **Open:** the **invocation locus** — does an MCP call originate in the harness (brain),
  the sandbox (hands), or a dedicated gateway?

A verification finding in the parent design is decisive here: at the pinned Pi commit
(`406a2214`) **Pi has no MCP client** — no `@modelcontextprotocol/sdk`, no MCP protocol
code. MCP integration must therefore be _built_ regardless of locus, so "fits Pi as-is"
does not favor any option. Freed from that pull, we choose the locus that is **thinnest on
Pi, most token-efficient, and most consistent with the spine**: the sandbox, invoked as
code.

**The principle:** MCP is not a protocol the harness speaks. It is _code the model runs in
the hands_. This is a thin specialization of spine §3.2 ("the sandbox makes credentialed
egress calls it cannot read") — an MCP call is just another such egress.

M10 is **done** when:

1. The model completes an MCP-backed task by writing and running a script in the sandbox —
   the harness imports no MCP SDK and registers no MCP forwarding tools.
2. An MCP call round-trips with backend credentials injected **only** at the egress
   waypoint; the raw credential is absent from the harness env, the sandbox env, the prompt,
   and every log entry.
3. Each individual MCP call appears as a per-call audit entry in the session stream,
   produced by the waypoint and correlated to the session.
4. A runaway script (pathological MCP loop) is stopped by the hard per-session cap; ordinary
   over-budget sessions abort cleanly at the next turn boundary.
5. Two sessions for **different users** (bob, alice) reach the same MCP backend with
   **distinct, user-scoped** credentials minted at egress, while **both users are offline**
   (unattended) — no live user token present in either session.

### In scope

- A **pre-baked MCP wrapper library + client runtime** in the sandbox image
  (`./servers/<server>/<tool>.ts` schema stubs + a thin MCP-over-HTTP client that
  auto-stamps session correlation).
- An **MCP extension to the AuthBridge Envoy egress waypoint** (ext-proc): recognize
  MCP-over-HTTP, resolve the session's bound user-subject, inject per-user/per-backend creds,
  append a per-call log entry to the session stream, count calls and enforce a hard
  per-session cap.
- **Budget-sum widening** in the existing M4-era budget voter to include broker-written MCP
  entries (the tunable soft budget).
- **Recording** the credential/identity model (§5) that the egress path depends on. The
  _implementation_ of the identity plane (delegation issuance, offline grants) is M7–M9.

### Out of scope (later milestones / separate tracks)

- **The identity-plane build itself.** Issuing the pre-authorized delegation, the offline
  grant lifecycle, SPIRE/SPIFFE issuance, and the AuthBridge actor-token wiring are the
  **M7–M9 spine** milestones. M10 consumes that plane and records its required shape.
- **Per-team / per-session MCP server rosters.** The pre-baked roster is static per sandbox
  image; varying it needs image variants. Deferred.
- **stdio-transport MCP servers.** This binding parses MCP **over HTTP/SSE** at L7;
  stdio-only servers are not covered.
- **A standalone terminating MCP gateway.** Replaced by the transparent waypoint (see D5).
  kagenti's `mcp-gateway` component is not on the sandbox→backend data path in this design.
- **Subagent fan-out mechanics** — owned by M11; M10 only confirms MCP and the credential
  model compose with it (§9).
- **Env-injected credential broker** (OpenShell-style, for git/CLI tokens) — a _complement_
  to the primary OBO path, pulled in only if/when M9 needs a token in the sandbox env (§5.4).

---

## 2. Key decisions

| #   | Decision                  | Choice                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Invocation locus          | **Sandbox, as code.** The model uses Pi's existing Bash/Write/Read tools (already redirected to the pod by `K8sSandboxClient`, M2) to author and run a script that calls MCP. Full replacement of the §3.3 forwarding-tool approach — the brain never originates MCP.                                                                                                                    |
| D2  | Tool discovery            | **Pre-baked into the sandbox image.** Interface stubs live on disk as `./servers/<server>/<tool>.ts`; the model reads only what it needs (progressive disclosure = the token win). Zero runtime codegen; reproducible. Trade-off: static roster per image.                                                                                                                               |
| D3  | Observability granularity | **Egress waypoint logs each call.** From Pi's view a bash run is one `intention` → one `tool_result`. The waypoint additionally appends one **per-MCP-call** entry into the _same session stream_, correlated by session id + `actor_spiffe_id`. The egress plane becomes a log _producer_.                                                                                              |
| D4  | Budget enforcement        | **Lean both.** Waypoint enforces a high **hard** per-session call cap (kill-switch for runaway loops). Harness **soft** budget = the existing turn-boundary voter, with its cumulative sum widened to include broker-written MCP entries → clean `abort`.                                                                                                                                |
| D5  | Network / trust path      | **Direct to backends + transparent waypoint.** Wrappers address real MCP server hostnames; the AuthBridge Envoy egress waypoint (Envoy + ext-proc) transparently intercepts at L7, injects creds, logs, and enforces the cap. No separate terminating gateway component.                                                                                                                 |
| D6  | Session correlation       | **Runtime auto-stamps it.** The pre-baked client runtime reads `KAGENTI_SESSION_ID` from env (set by the harness when it binds the sandbox to a turn) and stamps `X-Kagenti-Session` on every MCP call. The model's code never threads session context. This correlation does **double duty**: per-call audit (D3) **and** resolving the bound user-subject for credential scoping (D9). |
| D7  | Pi integration surface    | **Near-zero.** No `@modelcontextprotocol/sdk`, no `registerTool` MCP forwarding tools, no Pi fork for MCP. Reuses native `BashOperations`/`WriteOperations`/`ReadOperations`.                                                                                                                                                                                                            |
| D8  | Credential broker base    | **AuthBridge proxy.** It is the only candidate that already composes SPIFFE workload identity with user identity through an RFC 8693 token-exchange engine and does transparent L7 injection (matching D5). OpenShell's credentials-driver is a complement for env-injected creds only; DAM is a directional reference, not a buildable base (§5.5).                                     |
| D9  | Per-user scoping          | **SPIFFE actor + bound subject + pre-authorized delegation.** Inject keyed on _(session's bound user-subject ⊕ requesting workload's SPIFFE id)_. The agent's JWT-SVID is the RFC 8693 `actor_token`; `subject = bob`; a delegation grant stored in Keycloak authorizes that workload to act for that subject. Output: a fresh, short-lived, user+audience-scoped backend token.         |
| D10 | Unattended sessions       | **No live user token at runtime.** Because the user is offline, the subject is supplied from a **pre-authorized delegation / offline grant** held in the identity plane (Keycloak), not from a live inbound `Authorization` header. This is precisely the RFC 8693 §4.1 actor-token chaining AuthBridge lists as _not yet wired_ — the M7/M8 build.                                      |

---

## 3. Architecture & request path

```
model (in Pi)
  │  decides to use an MCP capability
  ▼
writes a script  ──► Pi Bash/Write tool ──► K8sSandboxClient ──► runs IN the sandbox pod
                                                                      │
  script imports pre-baked wrappers  ./servers/<server>/<tool>.ts     │
  (schema stubs + thin MCP-over-HTTP client runtime)                  │
                                                                      ▼
                                          MCP-over-HTTP to real backend hostname
                                          (client runtime auto-stamps X-Kagenti-Session)
                                                                      │
                                          ┌───────────────────────────┘
                                          ▼
                  AuthBridge Envoy egress waypoint  (Envoy + ext-proc) — "the broker"
                  • resolve X-Kagenti-Session → session's bound user-subject (e.g. bob)
                  • RFC 8693 exchange: actor=agent JWT-SVID, subject=bob, audience=backend
                        (subject sourced from pre-authorized Keycloak delegation — user offline)
                  • inject the minted user+audience-scoped token (placeholder-swap)
                  • append one per-call entry → session stream
                        (data.via="mcp-waypoint", server, tool, actor_spiffe_id, subject)
                  • increment per-session counter; reject past the hard cap
                                          │
                                          ▼
                                  real MCP server(s)   (enforce per-user authz on the token)
  │
  ▼
script filters / aggregates in code, prints ONLY the relevant slice
  │
  ▼
returns as ONE bash tool_result to the model context     ← the token win
```

**Why this shape.** The large token reduction reported for code-execution-with-MCP comes
from two properties this path preserves: (1) tool definitions are files on disk read on
demand, never a context dump; (2) intermediate MCP results are processed in code and never
enter the model context — only the final slice does. Pi is a _coding_ agent, so
writing-and-running-code is its strongest mode; this plays to its grain rather than bolting
an RPC tool surface onto it.

---

## 4. Components

| Component                                | Where it runs                   | Responsibility                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP wrapper library + client runtime** | pre-baked in the sandbox image  | `./servers/<server>/<tool>.ts` interface stubs (schemas only — no creds, no live endpoints baked in) + a thin MCP-over-HTTP client. Runtime auto-stamps `X-Kagenti-Session` from `KAGENTI_SESSION_ID`.                |
| **AuthBridge waypoint MCP extension**    | egress path of the sandbox pod  | Recognize MCP-over-HTTP; resolve session→subject; perform the RFC 8693 delegation exchange; inject the user-scoped token; append a per-call log entry; count calls + enforce the hard cap.                            |
| **Identity plane (M7–M9)**               | cluster                         | SPIRE issues SPIFFE SVIDs to harness/sandbox/subagents; Keycloak holds OAuth clients, per-user pre-authorized delegations / offline grants, and performs token exchange. **M10 consumes this; it does not build it.** |
| **Budget-sum widening**                  | harness (existing M4-era voter) | The turn-boundary cumulative sum now also counts the broker-written MCP entries. A few lines; no new mechanism.                                                                                                       |

**Wrappers ≠ credentials/endpoints.** Pre-baking bakes only interface stubs. The live target
URL and credentials are resolved at runtime through the egress plane, so the same image is
portable across environments and pre-baking never violates the cred spine.

**What binds a sandbox to a session — and to a user.** The harness sets `KAGENTI_SESSION_ID`
(and the sandbox receives its SPIFFE id from SPIRE) when it provisions/binds the sandbox for
a turn. The session record carries the initiating user's **subject reference** (e.g. `bob`).
That env + SPIFFE id + bound subject is what lets the _transparent_ waypoint both correlate
nested MCP calls to the right session stream **and** mint the right user-scoped token.

**Delta vs. parent §3.3.** This design _removes_ a Pi integration (the forwarding tools) and
_replaces_ the standalone MCP gateway component with an extension to a waypoint kagenti
already runs.

---

## 5. Credential & identity model

This section records the model the egress path depends on. The _engine_ (token exchange,
SPIFFE issuance) largely exists in AuthBridge/SPIRE/Keycloak today; the _unattended
delegation_ piece is the M7–M9 build. Recorded here so those milestones inherit a settled
shape.

### 5.1 Where credentials live (and don't)

Both kagenti credential subsystems converge on the spine's "broker is the sole secret
holder" property:

| Layer                 | AuthBridge                                                                                                    | OpenShell credentials-keycloak                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **At rest**           | Keycloak OAuth clients (client_id+secret, or SPIFFE JWT-SVID assertion) + K8s Secret mounted into the sidecar | K8s Secret files mounted into the credentials-driver sidecar              |
| **At runtime**        | in-memory in the AuthBridge **sidecar** only                                                                  | in-memory in the credentials **driver** sidecar only                      |
| **Harness / sandbox** | never hold raw secrets                                                                                        | never hold raw secrets                                                    |
| **Injection**         | L7 `Authorization` header rewrite (Envoy / ext-proc), transparent                                             | short-lived token → `DriverSandboxSpec.environment` env var, via UDS gRPC |

**Answer:** credentials live in **Keycloak + a K8s Secret, loaded into the broker sidecar's
memory; nowhere else.** The session log carries only **identity references** (subject SPIFFE
id strings), never tokens — invariant §4.1 #2 of the parent design.

### 5.2 Per-user scoping for unattended sessions

The hard case is **Bob vs Alice while both are offline.** A scale-to-zero session has no
live user JWT after the idle gap, so the user dimension cannot come from a live inbound
token. It comes from a **pre-authorized delegation**:

- **SPIFFE identity = the requester's right to act.** The session/sandbox/subagent each
  carry a JWT-SVID. At egress that SVID is the RFC 8693 `actor_token` — it proves _which
  workload_ is asking.
- **User identity = the subject acted for.** The session is bound to `subject = bob`, an
  identity reference in the log (never a secret).
- **The grant that makes it unattended** = a pre-authorized delegation stored in Keycloak
  ("this agent workload identity may act on behalf of `bob` for audience X"), established
  once when Bob consents. No live user token is needed at runtime.

At egress the broker presents _actor = agent JWT-SVID, subject = bob, audience = backend_ →
Keycloak validates the stored delegation → mints a fresh, short-lived, user+audience-scoped
token → injects it. Bob's sessions get Bob-scoped tokens while Bob is offline; Alice's get
Alice-scoped. **Blast radius:** a compromised sandbox in Bob's session can only ever act as
Bob, because the actor SVID + bound subject are what authorize the mint.

> **Concrete finding:** the mechanism above is exactly the RFC 8693 **actor-token /
> delegation chaining (§4.1)** that AuthBridge today lists as _not wired yet_. The AuthBridge
> TODO **is** the unattended-delegation feature. Building it is additive to an engine that
> already exists, and is the substance of the M7/M8 spine work.

### 5.3 The placeholder-swap pattern (adopted)

AuthBridge's `2026-06-02-credential-placeholder-swap-design.md` carries an **opaque handle**
in the request/conversation and swaps in the real token at egress in the sidecar. We adopt
it because it defends both invariant §4.1 (no secret in the log) **and** the prompt-injection
threat (no secret in model-visible output): the sandbox's MCP client never even holds a
placeholder _value_ it could leak — at most a session header — and the sidecar supplies the
token.

### 5.4 Env-injected credentials (complement, deferred)

MCP-over-HTTP is served by L7 header injection. Some sandbox operations need a token _in
env_ for a CLI — notably `git push` (parent M9). For those, the **OpenShell
credentials-driver pattern** fits: a sidecar broker over a Unix-domain socket,
`ResolveCredential(name, subject) → short-lived token`, injected as an env var, with the raw
secret never leaving the sidecar. This is pulled in **only if M9 needs it**; one
user-subject binding (§5.2) feeds both paths. It is a weaker identity model on its own
(no token-exchange delegation), so it is a complement, not the base.

### 5.5 Best-fit comparison (why AuthBridge is the base)

For _unattended + SPIFFE + user identity_:

|                                               | AuthBridge proxy                                    | OpenShell gateway / credentials-driver            | DAM                                                         |
| --------------------------------------------- | --------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| **SPIFFE workload identity**                  | ✅ native (JWT-SVID client assertion)               | ❌ not in cred path (static `client_credentials`) | ❓ undocumented                                             |
| **User identity in cred mint**                | ✅ as `subject_token` (OBO)                         | ❌ `user_id` not passed to driver (their TODO)    | ✅ "their own credentials" (per README)                     |
| **Token exchange (RFC 8693)**                 | ✅ engine exists                                    | ❌ none                                           | ❓                                                          |
| **Unattended / offline delegation**           | ⚠️ needs actor-token chaining built (the §4.1 TODO) | ⚠️ needs offline grant + user plumbing built      | ✅ "runs after you close your laptop" — internals SSO-gated |
| **Transparent L7 inject (MCP-over-HTTP, D5)** | ✅ header rewrite                                   | ➖ env injection (CLI-shaped)                     | ❓                                                          |
| **Secret-out-of-log**                         | ✅ placeholder-swap design                          | ✅ token never leaves sidecar                     | ✅ "no creds in runtime"                                    |
| **Verifiable / buildable now**                | ✅ local source                                     | ✅ local source                                   | ❌ SSO-gated, ACP-not-MCP                                   |

**Decision (D8):** AuthBridge proxy as the base — the only candidate that already composes
SPIFFE workload identity with user identity via a token-exchange engine _and_ does the
transparent L7 injection the M10 MCP-over-HTTP path needs. The single missing capability is
sourcing the subject from a pre-authorized delegation (D10) rather than a live inbound token
— additive. OpenShell's credentials-driver is the right complement for env creds (§5.4); DAM
is a directional reference only (SSO-gated, ACP not MCP, SPIFFE usage unverifiable).

---

## 6. Log schema & observability

§3.3's "reuses `intention` → `tool_result`" still holds in spirit; the **producer** and
**granularity** shift:

- **Coarse pair (harness-produced):** the model's bash run is one `intention` (the script) →
  one `tool_result` (the printed slice) — identical to any other bash call.
- **Fine entries (broker-produced):** the waypoint appends one entry per MCP call into the
  _same session stream_, carrying `data.via = "mcp-waypoint"`, the target `server`/`tool`,
  `actor_spiffe_id`, and the bound `subject` reference. **No new entry type** is required —
  but the egress plane is now a log _producer_, not only the harness.

**Invariant §4.1 holds unchanged:** no entry carries a raw secret. Credentials are injected
downstream of the log, at the waypoint; entries name _who / what / where / on-behalf-of-whom_
— never the credential. This stays directly testable by the parent design's red-team grep
over the log, the harness env, the sandbox env, and the reconstructed conversation.

---

## 7. Budget & failure modes

**Budget (the lean both, D4):**

- **Hard cap (waypoint):** a high per-session MCP-call ceiling (e.g. ~1000 calls/turn). Rides
  the logging path already built for D3 — a counter plus one comparison. Fires only on
  pathological loops.
- **Soft budget (harness):** the existing turn-boundary voter, sum widened to include the
  broker's MCP entries. This is the operator-tunable budget and produces a clean `abort`.

**Why both, despite a simplicity preference.** Code-mode introduces one genuinely new failure
mode: the model writes a loop that makes thousands of MCP calls inside a _single_ bash run.
No inference happens during that run, so the inference budget never sees it, and a pure
turn-boundary budget only reacts _after_ the turn. The hard cap closes that intra-turn hole.
Because both halves are small additions to code paths we already build (D3 logging path;
M4 voter), "both" costs marginally more than one and avoids having to choose between ugly
mid-script failures _or_ an unguarded runaway path.

**Failure modes (new, stated explicitly):**

- **Hard-cap hit** → the MCP call throws _inside the model's script_ → the model sees an
  error mid-run and adapts. Acceptable: errors-in-scripts are a coding agent's native failure
  surface.
- **Single-turn budget burn** → a bad script can still exhaust a turn's soft budget in one
  bash call; the soft budget catches it at the _next_ turn boundary, the hard cap catches
  _pathological_ loops mid-turn.
- **Delegation expired / revoked** → the exchange fails at the waypoint; the MCP call returns
  an auth error into the script. The model surfaces it; the session does not silently fall
  back to a less-scoped or workload-only token.

---

## 8. Pi integration surface

This is the crux of the original "how does this work with Pi?" question. The answer is
**near-zero surface — less than §3.3 required.**

- ✗ No `@modelcontextprotocol/sdk` dependency.
- ✗ No `registerTool` MCP forwarding tools (§3.3 _did_ need these).
- ✗ No Pi fork for MCP.
- ✓ Reuses Pi's existing `BashOperations` / `WriteOperations` / `ReadOperations`, already
  redirected to the pod by `K8sSandboxClient` (M2).

Pi stays a near-pure function: it runs bash that happens to call MCP from inside the
sandbox. MCP knowledge lives entirely in the sandbox image and the egress waypoint; the
credential model is wholly outside Pi.

---

## 9. Subagents (composition check only — owned by M11)

MCP and the credential model compose with subagents with **no extra mechanism**. Parent §3.4
already gives each subagent a fresh isolated sandbox → its own SPIFFE id → its own
`actor_token`, its own waypoint egress scope, and its own per-session MCP budget and hard cap
→ contained blast radius. A subagent acting for the same user inherits the parent's bound
subject (optionally a **down-scoped** delegation); a misbehaving subagent can act only within
its own (actor SVID ⊕ subject) scope, never a sibling's or the parent's. Each subagent uses
the same pre-baked image with its own identity. Nothing MCP- or credential-specific is added
in M11 for this to hold.

---

## 10. Consequences & trade-offs (recorded honestly)

1. **Relaxed isolation.** §3.3's "untrusted backends never in the sandbox netns" relaxes to
   "reachable only through the mediating waypoint." Isolation now comes from the mesh +
   NetworkPolicy + the ext-proc, not from an air-gap. For high-risk untrusted backends this
   is weaker than a terminating proxy; if that becomes unacceptable, a terminating
   `mcp-gateway` hop can be reintroduced for _specific_ backends without changing the
   code-mode model (the wrappers' target hostname simply points at the gateway for those).
2. **Static roster per image.** Rebuild the sandbox image when the MCP server set changes;
   per-team/per-session rosters need image variants (deferred, §1 out of scope).
3. **L7 dependency for audit and injection.** Both per-call audit and credential injection
   depend on the waypoint parsing MCP-over-HTTP. Networked (HTTP/SSE) MCP servers only;
   stdio-transport servers are out of scope for this binding.
4. **Coarser Pi-native view.** Pi's own event stream sees one bash `tool_call` per script;
   fine-grained MCP visibility lives in the session stream (broker entries), not in Pi's
   in-process hooks. Anything that needs per-MCP-call reaction must read the log.
5. **Persistent per-user delegation store required.** Unattended sessions force the user
   dimension to be a durable, pre-authorized grant in the identity plane (Keycloak), not an
   in-memory sidecar token. This is new identity-plane state with its own consent, rotation,
   and revocation lifecycle — owned by M7/M8, flagged here as a hard dependency.
6. **AuthBridge actor-token path must be built.** The chosen model (D9/D10) depends on RFC
   8693 §4.1 actor-token/delegation chaining that AuthBridge currently leaves unwired. M10 is
   blocked on that M7/M8 capability for its unattended, per-user gate (criterion 5).

---

## 11. Milestone gate

M10 passes when, end to end on a Kind cluster with the sandbox image, the waypoint MCP
extension, and the M7–M9 identity plane deployed:

1. A model task completes against a real MCP server purely by running a script in the
   sandbox; `grep` confirms the harness bundle imports no MCP SDK and registers no MCP tool.
2. The backend credential is present **only** at the waypoint: red-team grep finds it absent
   from harness env, sandbox env, prompt, and every session-log entry, while the call still
   succeeds.
3. Each MCP call produced a per-call session-stream entry with `data.via = "mcp-waypoint"`,
   an `actor_spiffe_id`, and a `subject` reference.
4. A deliberately runaway script trips the hard cap (MCP call throws mid-script); a separate
   over-budget session ends via a clean turn-boundary `abort`.
5. **Per-user, unattended:** two sessions bound to different subjects (bob, alice), with no
   live user token present, reach the same backend and receive **distinct user-scoped**
   tokens minted via the delegation exchange; the backend observes bob's calls as bob and
   alice's as alice.

---

## 12. References

- [Zero-Trust, Multi-Agent Extensions](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) — §2 spine, §3.2 sandbox egress, §3.3 (superseded here), §3.4 subagents, §4.1 invariants, M7–M9 credential plane.
- [M2 Design — K8sSandboxClient](2026-06-17-m2-k8s-sandbox-client-design.md) — Operations redirection to the pod (the path code-mode rides).
- [M4 Design — Knative Serverless Wrapper](2026-06-17-m4-knative-serverless-wrapper-design.md) — `runTurn`, the budget voter this design widens.
- Pi harness — [earendil-works/pi](https://github.com/earendil-works/pi): native Bash/Write/Read Operations; MCP client absent at pin `406a2214`.
- kagenti AuthBridge — `kagenti-extensions/AuthBridge`: RFC 8693 token exchange (`exchange/client.go`), SPIFFE JWT-SVID client assertion, Keycloak; `authbridge-lite` variant; the placeholder-swap design (`2026-06-02-credential-placeholder-swap-design.md`); actor-token chaining noted unwired in `auth/auth.go`.
- OpenShell credentials-keycloak — `openshell-credentials-keycloak`: UDS gRPC credentials driver, `ResolveCredential` proto, env-injection pattern (complement for env creds; `user_id` plumbing is their noted TODO).
- DAM — [dam-agents/dam](https://github.com/dam-agents/dam): directional reference for zero-trust, gateway-brokered, per-user, unattended agents; ACP (not MCP); credential internals SSO-gated/undocumented.
- RFC 8693 — OAuth 2.0 Token Exchange (`subject_token`, `actor_token`, `audience`); §4.1 actor-token/delegation chaining.
- Anthropic, "Code execution with MCP: building more efficient agents" (Nov 2025) — the progressive-disclosure + filter-in-code pattern this design applies.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
