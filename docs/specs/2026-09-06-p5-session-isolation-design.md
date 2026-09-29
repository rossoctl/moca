# Multi-Session Harness Isolation — Per-Request Subject, No Ambient Credential — Design

Version: 1.1 — September 6, 2026; amended September 8 and September 9, 2026
Status: Proposed
Scope: Make **N concurrent Pi sessions in one harness process** provably isolated, by carrying the
LLM identity **per request** and removing every ambient (process-global) credential source that a
second session could inherit. Realizes the concurrency-safety half of
[issue #220](https://github.com/rossoctl/moca/issues/220).
Builds on (reuse, no redesign): the harness lock-down's secret-free container
([Z2](2026-06-26-harness-lockdown-design.md), [ADR-0011](../adrs/0011-harness-lockdown.md)), the
inference injector's "harness holds no provider key"
([Z3](2026-06-26-inference-injector-design.md), [ADR-0012](../adrs/0012-inference-injector.md)),
RC1's `static-inject` placeholder swap
([RC1](2026-07-10-authbridge-egress-control-plane-poc-design.md),
[ADR-0026](../adrs/0026-rc1-static-inject-plugin.md)), and Pi's **already per-session** request-auth
path (`AgentSession._getRequiredRequestAuth` → per-instance `ModelRegistry`).

> **What this slice is NOT.** Not the deployment-model change — KEDA `ScaledJob` → elastic pod pool,
> the 100× density claim, and the #55 overload-handling shift from pod-level to session-level are a
> **separate slice** and a separate issue. Not end-to-end multi-tenancy: that additionally needs
> **per-subject resolution at the injector**, which is Z5's deferred per-user / RFC 8693 half
> ([ADR-0026](../adrs/0026-rc1-static-inject-plugin.md) "only the Z5 per-user / token-exchange source
> … remains") and lives in `kagenti-extensions`, not here. Not a `SessionContext` threaded through
> `pi-fork` — §4 explains why four of the issue's five items are pinned rather than refactored. Not a
> change to the leaf `ScaledJob` path, which is one pod per leaf and stays ambient by design.

---

## 1. Goal & motivation

The harness runs one session per process. Each session idles 80–90% of wall-clock waiting on the
model and on tool calls, yet owns a whole pod, so 10,000 concurrent sessions means 10,000 pods.
Issue #220 proposes multiplexing N sessions per process and identifies five process-global mutable
states as the blockers.

**The five-blocker framing does not survive tracing the code.** One is real, one is unreachable, one
is largely false, and two are low-severity — while the actual prerequisite for multi-tenant
multiplexing is something the issue never mentions: _no per-session credential ever enters the
harness at all_. §2 records what the code does, with citations, because the issue's own severity
table was written from reading rather than tracing, and this spec's value is the corrected map.

The goal of this slice is a single enforceable property:

> **A request's upstream identity is determined solely by that request, and no identity is reachable
> from process-global state.**

Both clauses are load-bearing. The first alone is unenforceable: while an ambient credential exists,
"we passed the right one" is a behaviour we hope holds, not a fact the process guarantees. The
second clause turns it into a precondition the process cannot violate — a credential-less session
**fails closed** instead of silently borrowing its neighbour's identity.

## 2. Current state — verified, with citations

Every claim here was traced in the tree at `f78081f`, not inferred from the issue.

### 2.1 The issue's severity table, corrected

| #                               | Issue says                                                             | Code says                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. `ANTHROPIC_API_KEY` mutation | Showstopper — "sessions with different auth tokens corrupt each other" | **Real, and different in kind.** `run-turn.ts:310-312` is write-once-**if-absent**, so session A's token sticks process-wide and B..N silently authenticate **as A**. A cross-tenant identity leak, not mutual corruption — the two framings imply different fixes.      |
| 2. `stdoutTakeoverState`        | Showstopper                                                            | **Unreachable in server mode.** `takeOverStdout()` is called only from `main.ts:511` (CLI) and `rpc-mode.ts:54`; the harness enters Pi via `createAgentSession` (`run-turn.ts:1-8`).                                                                                     |
| 3. `sessionResourceCleanups`    | Showstopper — "cleanup for A tears down B"                             | **Largely false.** The sole registrant repo-wide (`openai-codex-responses.ts:786`) already filters by session: `closeOpenAICodexWebSocketSessions(sessionId)` closes only that session's cached socket (`:769-784`), and `agent-session.ts:733` passes `this.sessionId`. |
| 4. `fileMutationQueues`         | Race — "sessions serialize through same promise chain"                 | **Wrong mechanism.** The map is keyed by `realpath` (`file-mutation-queue.ts:16-26, :35`), so different files already run in parallel. The only true global is `registrationQueue` (`:5`), which serializes one `realpath()` call — throughput, not correctness.         |
| 5. `commandResultCache`         | Stale data                                                             | **Low.** Only caches values beginning with `!` (`resolve-config-value.ts:81-86, :211-219`). The harness supplies credentials as config/env, never as `!cmd`.                                                                                                             |

### 2.2 Pi is already per-session on the credential path

This is the finding that shapes the design. Pi does **not** rely on ambient credentials:

- `AgentSession` resolves auth **per request** via `_getRequiredRequestAuth` (`agent-session.ts:357-381`),
  which reads `this._modelRegistry` — a **per-instance** field, whose `modelRegistry` accessor is at
  `:353-355`.
- The resolved `apiKey` is passed **explicitly** into stream options (`agent-session.ts:1705`, `:1978`, `:2791`).
- `withEnvApiKey` (`stream.ts:22-30`) consults the environment **only when no explicit key was
  given**: `if (hasExplicitApiKey(options?.apiKey)) return options;` at `:26`, before
  `getEnvApiKey(model.provider)` at `:27`.

So the env var is a _fallback beneath an already-per-session mechanism_. The harness's seed at
`run-turn.ts:310-312` is precisely what activates that fallback and defeats the isolation Pi already
provides. **Nothing in `pi-fork` needs to change for the credential path.**

### 2.3 The gap the issue never names: no per-session identity inflow

Every caller fills the credential from process env:

- `packages/knative-server/src/server.ts:66-73` — `buildConfig()` takes no arguments and reads
  `process.env.ANTHROPIC_AUTH_TOKEN` (`:71`), `ANTHROPIC_BASE_URL` (`:70`), and `cwd` (`:69`).
  Called at `:111` (sync turn), `:174` (**the SSE branch of the same `/turn` route**, not async
  dispatch: `handleTurnStream:150` ← `handleTurn:108`, `if (wantsStream)` ← `POST /turn` at `:564`),
  `:411`/`:415` (leaf).
- `packages/knative-server/src/leaf-job.ts:13-18`, used at `:77`.
- `harness/src/cli.ts:13`.

`TurnConfig.anthropicAuthToken` exists as a field (`run-turn.ts:64`) but no caller ever populates it
from a request. **The pod's environment _is_ the credential, one per deployment.** Consequently,
deleting the env seed alone would not fix a leak — it would leave every session with no credential
at all. The ordering in §3.2 follows from this.

A `tenant` concept does already exist, partially: `run-leaf.ts:111` (`tenant?: string` — "namespaces
the session id"), `leafSessionId` at `:157-160`, and `server.ts:442` reads `tenant` as a query
parameter on the leaf-result path. The turn path has no equivalent.

### 2.4 The architecture already forbids the obvious fix

Passing a real credential to the harness per request contradicts three accepted ADRs:

- **[ADR-0011](../adrs/0011-harness-lockdown.md)** — the harness holds no provider key and has no
  public egress, so its default-deny boundary is enforceable.
- **[ADR-0012](../adrs/0012-inference-injector.md)** — a separate injector pod holds the keys,
  strips client auth, sets the real credential, and is the only component with public egress.
- **[ADR-0026](../adrs/0026-rc1-static-inject-plugin.md)** — the `static-inject` AuthBridge plugin
  rewrites `Authorization: Bearer <placeholder>` → `Bearer <real>` from a mounted `secret_dir`,
  fail-closed. Its **rejected** alternative #3 is literally "bake the credential into the workload
  env — defeats the entire 'workload never holds the secret' invariant."

So the harness must carry an **inert placeholder plus a subject**, never a secret. That invariant is
today **documented prose with nothing pinning it** — the same failure mode that let #182's spec
entry go stale for two months.

## 3. Design

### 3.1 The isolation contract

Three statements, each testable:

1. **Per-request identity.** Every upstream request's `Authorization` header derives from the
   subject on the inbound request, and from nothing else.
2. **No ambient identity.** In server mode the process holds no provider credential and no
   tenant-bearing placeholder. The only ambient value is an inert sentinel identical for every
   tenant (§3.3), so `withEnvApiKey`'s fallback (`stream.ts:27`) can never resolve to anyone's
   identity.
3. **Fail closed, twice.** A request with no subject is rejected before a session is created. A
   subject with no placeholder resolution makes **no upstream request at all**. This clause rests
   entirely on step 1's explicit 401 — §3.2 step 2 records why removing the ambient fallbacks adds no
   enforcement of its own.

### 3.2 Three ordered steps (the order is forced by §2.3)

**Step 1 — per-request subject inflow.** `buildConfig()` becomes `buildConfig(req)` in
`packages/knative-server/src/server.ts`, reading the subject from the inbound request and deriving
the per-request placeholder from it. The turn path gains what the leaf path already has (§2.3).

**Both `/turn` call sites convert: `:111` (sync) and `:174` (SSE).** They are the two branches of one
route, split at `:107-108` on the `Accept` header, so converting only `:111` leaves a bypass rather
than a partial rollout (§3.5). `handleTurnStream` already receives `req` (`:153`), so the subject is
in scope there with no signature change.

The placeholder rides in on the existing `TurnConfig.anthropicAuthToken` field — `applyModelGateway`
installs `Authorization: Bearer ${authToken}` (`run-turn.ts:336`) from it, so **no new credential
_path_ is needed**. It does need a **tag**, and that is the one thing this step must not pin as a
bare string. [MU1](2026-09-08-multi-user-control-plane-design.md) §3.6 item 1 (merged, so this is a
live constraint rather than a hypothetical) puts a different payload in the same field:

```ts
type UpstreamCredential =
  | { mode: 'placeholder'; value: string } // P5 + an injector in the egress path
  | { mode: 'direct'; value: string }; // MU1 interim, control-plane resolved
```

Both failure directions of conflating them are silent: an implementation that unconditionally sets
the placeholder overwrites MU1's real token and the request fails with an opaque upstream auth error
because no injector is configured to swap it, while a direct-mode deployment that later grows an
injector has its real key rewritten. This is §3.4's argument — the injector faithfully swaps in
whichever tenant a placeholder names — applied to a **mislabelled** placeholder, so the same
strictness follows. P5 does not own the resolution rule (MU1's: the control plane declares the mode
at exchange time, placeholder mode wins wherever an injector exists, and MU3 deletes direct mode);
P5 only has to leave room for it, which costs nothing here and avoids MU1 reopening `run-turn.ts`
plus this slice's tests to widen a field P5 had just declared sufficient.

`TurnConfig` **does** gain an explicit `subject` field: without it the tenant is knowable
only by reverse-mapping the placeholder, which would put the logging path in contact with the
credential mapping this slice exists to isolate, and the §5 two-tenant test would have nothing but
the outbound header to assert on. The value grows with density — at one session per process the
reverse-map is merely distasteful, but in a process multiplexing S sessions it is the only route to
per-session attribution, per log line, on a hot path.

Subject transport: a dedicated header, **`X-SH-Subject`**, not `Authorization`. `Authorization` is
unused on inbound requests today (the server consumes no auth header), but its meaning there is "may
this caller use the harness" — and ADR-0011's lock-down implies caller auth is coming. Overloading
one header with _authorize the caller_ and _whose budget to spend upstream_ collides exactly when
that lands. The subject is also **not** taken from the request body: the body is parsed, logged, and
persisted, and identity should not ride in a field that gets written to Redis.

That reservation has since been taken up: MU1 §3.5 adopts the split unchanged and claims
`Authorization: Bearer <session token>` for caller auth. One consequence lands inside this step, so
the implementation must not over-pin it. **Do not assert "an inbound `X-SH-Subject` is always
honoured."** Once a session token is present the subject is `token.sub` and an inbound
`X-SH-Subject` is _ignored_ — a request carrying both a token and a conflicting header is rejected
with `subject_conflict` (400) rather than resolved by precedence (MU1 §3.5, §3.6 item 3). The
operator-driven and leaf paths keep this slice's inbound-header behaviour; the token-bearing path
does not. What P5 pins is the narrower and durable statement: **the subject is resolved from the
request, and never from process state.** MU1 then makes the subject _trustworthy_ rather than merely
asserted, which is the half this slice cannot do alone (§7).

Placeholder derivation is a **pure, non-secret mapping** from subject → placeholder, from mounted
non-secret configuration. It contains no credentials, so it may be logged and asserted on in tests.

**Step 2 — remove the ambient fallbacks.** In `harness/src/run-turn.ts::applyModelGateway`, delete
the `process.env.ANTHROPIC_API_KEY` seed (`:310-312`) and the `|| process.env.ANTHROPIC_AUTH_TOKEN`
fallback (`:306`). The signature does not change — only what it trusts. **Only safe after step 1**,
which is the whole reason for the ordering.

**Step 2 does not itself make anything fail closed.** `run-turn.ts:314`
(`if (!gatewayBase && !authToken) return baseModel;`) returns the model **unchanged** rather than
throwing, leaving pi's own `withEnvApiKey` fallback (§2.2) reachable below it — and
`model-gateway.test.ts:27` pins that behaviour deliberately. So step 1's explicit 401 is the **only**
enforcement of §3.1 clause 3: step 1 shipped without the 401, or step 2 landing first, fails open
silently rather than loudly.

_The leaf path shares this function and step 1 does not reach it_ — `run-turn.ts:307-309` says both
call sites run it and warns against "cleaning it up", while step 1's per-request subject arrives in
`server.ts`, which a leaf `ScaledJob` never enters. The leaf survives both deletions anyway, for two
independent reasons, so no leaf-side compensation is needed:

- `deploy/knative/leaf-scaledjob.yaml:65-66` mounts `ANTHROPIC_API_KEY` from `llm-credentials`
  directly, so the `:310-312` seed never fires in a leaf pod — its `!process.env.ANTHROPIC_API_KEY`
  guard is already false — and the by-provider-name lookup that §3.3 shows to be load-bearing
  therefore still resolves there.
- `leaf-job.ts:13-19` populates `anthropicAuthToken` from `process.env.ANTHROPIC_AUTH_TOKEN` itself
  (`:18`), so the token reaches `applyModelGateway` through `config`, not through the `:306` fallback.

The leaf never depended on either. This is the dual-path check most likely to be re-derived from
scratch, which is why it is recorded here rather than left to §8.

**Step 3 — scrub at the server entrypoint.** At server startup, **replace** `ANTHROPIC_API_KEY` with
an inert sentinel and **delete** `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` (the first two
are the names `getApiKeyEnvVars` returns for the `anthropic` provider, `env-api-keys.ts:96-98`).

The deletion of `ANTHROPIC_OAUTH_TOKEN` is not incidental. `getApiKeyEnvVars` returns
`["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]` **in that order**, under a comment stating the
former takes precedence. An OAuth token left in the environment therefore **outranks** the sentinel,
and the sentinel's whole argument (§3.3, reason 3) collapses — which is why §5 asserts the deletions
and not only the replacement.

**"Entrypoint" means the exported `startServer()` (`server.ts:576`), not the `isMainModule` guard
(`:592-593`).** The choice is not cosmetic: §5's _Sentinel identity_ row is assertable in-process only
in the former — inside the guard it needs a subprocess, which would leave the one line that makes
step 2 safe without unit coverage. The accepted cost is that every test which starts a server now
mutates process env and needs the save/restore discipline `model-gateway.test.ts` already applies;
skip it once and the failure mode is an order-dependent test that passes for the wrong reason.

**Land the scrub as a small exported function that `startServer()` calls, not inline inside it.**
The assertability argument above is unaffected — the function still runs on the `startServer()` path
and the sentinel is still checkable in-process — but it stops the scrub from being reachable by
exactly one entry point. [P6](https://github.com/rossoctl/moca/pull/244)'s VM worker is
a **third** entry point: it builds `createServer(handler)` and never calls `listen()`, serving sockets
handed to it over IPC, so it never calls `startServer()` and would run **unscrubbed** — with W×S
multiplexed sessions, which is precisely the exposure the scrub exists for. A shared function is the
same one-line factoring and closes that before it opens.

The scrub belongs at that entrypoint **only** — not in `run-turn`, not in `leaf-job`. This is
what keeps the leaf path working: a leaf `ScaledJob` is one pod per leaf, so ambient env is correct
there and multiplexing never applies. Scrubbing inside `run-turn` would break leaf mode, since both
paths share it.

### 3.3 Why the sentinel, and why it is not a hole

`ANTHROPIC_API_KEY` **cannot simply be deleted.** `run-turn.ts:150-155` documents why, and it is
load-bearing: pi resolves the request key **by provider name**, so
`authStorage.getApiKey('anthropic')` → `getEnvApiKey('anthropic')` → `process.env.ANTHROPIC_API_KEY`.
With it absent, `_getRequiredRequestAuth` (`agent-session.ts:357-381`) throws
`No API key found for "anthropic"` before any request is attempted — and `createAgentSession`
(`run-turn.ts:499-504`) exposes **no** seam to pass a per-session key into the session's
`ModelRegistry`. Deleting the variable would therefore break gateway mode outright.

So server mode sets `ANTHROPIC_API_KEY` to a **fixed, non-secret sentinel** (e.g.
`sh-unused-see-authorization-header`), which satisfies pi's existence check while the real identity
travels in the per-request `Authorization: Bearer <placeholder>` header that `applyModelGateway`
installs on the model. This is safe rather than a workaround, for three reasons:

1. The sentinel is **identical for every tenant**, so it asserts no identity and cannot leak one.
   Clause 2 of §3.1 is about _identity_, and the sentinel carries none.
2. It never reaches the wire as auth: `applyModelGateway` sets `'x-api-key': null` (`run-turn.ts:337`)
   whenever a gateway token is in play, so the sentinel is stripped, not sent.
3. It is **assertable**: a test can require that the ambient key equals the sentinel exactly, which
   fails loudly if a real credential or a tenant placeholder is ever reintroduced into the
   environment. Deletion cannot be asserted this precisely — an absent variable and a variable
   deleted-then-repopulated look identical.

The alternative — a `pi-fork` seam threading a per-session `apiKey` into `ModelRegistry` — is the
only way to remove the ambient value entirely. It is deliberately **not** taken here: it reopens the
fork divergence this design avoids, for a value that carries no identity. If a future change needs
per-session _provider_ selection (not just per-session identity), that seam becomes worth adding, and
this is the place to revisit.

### 3.4 Why an ambient _placeholder_ is as dangerous as an ambient key

Under lock-down the harness never holds a secret, so it is tempting to treat placeholder leakage as
cosmetic. It is not. A placeholder is an identity assertion: if session B inherits tenant A's
placeholder, the injector faithfully swaps in **A's real credential**. The result is A's budget
spent on B's work, A's data scope granted to B's session, and an injector audit trail that records
the request as legitimately A's — so the one mechanism that would otherwise catch the error instead
certifies it. Placeholder isolation is therefore in scope, at the same strictness as key isolation.

### 3.5 Deliberate YAGNI

- **`anthropicBaseUrl` stays deployment-level.** The gateway is infrastructure, not tenant identity.
  Extension point noted: a tenant needing its own gateway makes base URL subject-derived too.
- **The genuinely non-turn `buildConfig()` call sites keep ambient config** (`server.ts:411`, `:415`;
  `leaf-job.ts:77`) until the deployment model changes. They are on the 1:1 path today.
  **`server.ts:174` is not one of them** — it was listed here in error. It is the SSE branch of
  `POST /turn` (§2.3), so leaving it ambient would let any client bypass the per-request subject by
  sending `Accept: text/event-stream`, making §3.1 clause 1 false and never reaching step 1's 401.
- **`registrationQueue` is left alone** (§4).

### 3.6 What the scrub does not cover: the pod as deployed

The scrub is **in-process only**, and the manifests still hand the container the real thing:
`deploy/knative/service.yaml:45-49` mounts `api-key` from `llm-credentials` into the ksvc and `:56`
mounts `auth-token`. So after step 3 the harness _process_ holds a sentinel while the harness _pod_
was still delivered a secret. §5's lock-down row is scoped to the process for exactly this reason —
ADR-0011/0012's "harness holds no key" comes out of this slice **partly** pinned, and claiming
otherwise would repeat the §2.4 failure this spec is trying to end.

Closing it is deliberately out of scope, because it cannot be done by editing `service.yaml`. Nothing
puts an injector in the **harness's** egress path today: the base `kustomization.yaml` renders redis +
sandbox pool + ksvc + relay with no AuthBridge, and `overlays/ocp-authbridge` adds only the AB1/AB2
_sandbox_-egress demo without patching the ksvc's env. Replacing the ksvc's `api-key` with the §3.3
sentinel would therefore leave the harness unable to reach any model, in every deployment including
the AB-gated ones. A secret-free harness pod needs the lock-down's own work (ADR-0011 · Z2) plus
injector deployment (ADR-0012 · Z3); it is recorded as follow-up in §6, and §8's touched-files list
carries no manifest for the same reason.

## 4. The other four globals — pinned, not refactored

The principle: **an inert global should be proven inert and left alone.** Refactoring it raises
`pi-fork` divergence to fix nothing, while a reachability test catches the thing actually feared —
that it quietly becomes reachable later.

**Every verdict in this section is a _correctness_ verdict, and silent on liveness.** That is the
right scope for a slice whose property is isolation, but it is not inheritable: a global that cannot
corrupt a session but can stall S of them is inert by this section's test and fatal by the deployment
model's. Both residuals below are recorded as "throughput, not correctness" on that basis, as is
`registrationQueue` in §2.1 — the liveness question they raise belongs to the deployment-model slice
(§6), which is where density makes it load-bearing.

| Global                                               | Disposition                         | Pinned by                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stdoutTakeoverState` (`output-guard.ts:7`)          | Unreachable in server mode          | `isStdoutTakenOver()` stays false in **any non-CLI entry point** — deliberately not "across a server turn", which would leave P6's worker (a third entry point, §3.2 step 3) uncovered by a pin whose stakes are higher there: `output-guard.ts:91`'s `process.exit(1)` costs one session at 1:1 and S sessions multiplexed |
| `sessionResourceCleanups` (`session-resources.ts:3`) | Already session-scoped              | Cleaning up A leaves B's resources intact; the no-arg `cleanupSessionResources()` form is never reached from the harness path                                                                                                                                                                                               |
| `fileMutationQueues` (`file-mutation-queue.ts:4`)    | Left alone deliberately             | Documented, not changed — keyed by `realpath`, so the residual global is one serialized `realpath()`                                                                                                                                                                                                                        |
| `commandResultCache` (`resolve-config-value.ts:10`)  | Unreachable with harness config     | No harness config value begins with `!`                                                                                                                                                                                                                                                                                     |
| `cwd` (`server.ts:69`)                               | **Not in the issue**; probed, inert | No **write** resolves under `cwd` across a server turn; the settings read is the only cwd contact                                                                                                                                                                                                                           |

Two notes on this table:

**`output-guard` hides a worse hazard than the one the issue lists.** `writeRawStdout`'s failure
path calls `process.exit(1)` (`output-guard.ts:91`). In a CLI that is a reasonable response to an
unwritable stdout; in a multiplexed server it is a **fleet-wide outage triggered by one session's
write error**. Pinning the module unreachable covers both, and is a further argument against ever
routing server output through it.

**`cwd` was the one item that could change this slice's verdict**, so it was probed rather than
assumed. `cwd` is threaded per-turn (`run-turn.ts:417`, `config?.cwd ?? process.cwd()`) and is
identical for every request, reaching `SessionManager.create`/`openFromCheckpoint` (`:429-442`) and
`SettingsManager.create` (`:446`). Result: **inert, and the scope does not grow** — but the 1.0 pin
above ("no session-scoped file operation resolves against `process.cwd()`") was too strong, because
one cwd-derived path _is_ computed. The accurate statement:

- **`SessionManager` — proven inert.** `create` sets
  `dir = backend ? "" : sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)`
  (`session-manager.ts:1421`) and the harness always passes a backend and no `sessionDir`
  (`run-turn.ts:419-420`, `:432`, `:442`), so `dir` is `""` on both branches that could otherwise
  reach `cwd`; `openFromCheckpoint` routes to `openFromBackend` (`:1465`, `:1469`). With `sessionDir`
  empty the constructor's `mkdirSync` is guarded off (`:792`), and every write in the class targets
  `this.sessionFile`, which the backend path never sets. `cwd` survives only as a **value** in the
  session header (`:856`, `:1333`).
- **`SettingsManager` — cwd-derived, but read-only on this path.** `FileSettingsStorage` computes
  `projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json")`
  (`settings-manager.ts:189`). Startup is a pure read: `loadFromStorage` (`:349-352`) passes a
  callback returning `undefined`, and `withLock` writes only on a non-`undefined` return (`:232-241`).
  Writes require `updateProjectSettings` (`:635`) → `assertProjectTrustedForWrite` (`:527`). The
  project-scope writers all live in `settings-manager.ts` itself: `setProjectPackages` (`:942`),
  `setProjectExtensionPaths` (`:958`), `setProjectSkillPaths` (`:974`),
  `setProjectPromptTemplatePaths` (`:990`) and `setProjectThemePaths` (`:1006`) — each calling
  `updateProjectSettings` on the next line — plus `saveProjectSettings` (`:618`, reached at `:640`)
  and the `"project"` branch of `enqueueWrite` (`:552-553`). **None is reachable from a server turn**,
  and the chain is short enough to state rather than trust:
  - The five `setProject*` methods have exactly two non-test callers. One is the interactive TUI
    (`config-selector.ts:484`/`:486`/`:488`/`:490`/`:558`, under `src/modes/interactive/`), which
    server mode never enters.
  - The other is `package-manager.ts:798`/`:806`/`:824`, inside `addSourceToSettings` (`:782`) and
    `removeSourceFromSettings` (`:813`), reached only via `installAndPersist` (`:989`) and
    `removeAndPersist` (`:1014`) — whose sole non-test callers are `package-manager-cli.ts:601`/`:606`,
    i.e. the `pi packages` CLI. Both also require an explicit `local: true` to select project scope at
    all (`scope = options?.local ? "project" : "user"`, `:783`, `:814`, `:994`).
  - Neither entry point exists in server mode: `sdk.ts` contains no `PackageManager` reference, so
    `createAgentSession` never constructs one, and the harness passes only
    `sessionManager`/`model`/`resourceLoader`/`settingsManager` (`run-turn.ts:499-504`).

  Superseded citation: v1.1 named `package-manager-cli.ts:487` and `resource-loader.ts:328`/`:338` as
  the project-scope mutators. Those three lines are `setProjectTrusted(...)` calls
  (`settings-manager.ts:447`), which flip an in-memory boolean and clear the modified-field sets
  without writing anything to disk — so the audit named a set that cannot write and omitted the set
  that can. The **conclusion** (no project-scope write is reachable from a server turn) survives; only
  the evidence did not. Also note the path: `package-manager-cli.ts` is at
  `packages/coding-agent/src/`, not `src/core/`. The three trust-flag calls _are_ unreachable from a
  server turn, for a reason worth keeping: `resource-loader.ts:328`/`:338` run only under
  `reload({ resolveProjectTrust })` (`:335-338`), and `run-turn.ts:493` calls `reload()` with no
  options.

Two residuals to pin rather than assume, since both hold by "no caller" and not by refusal:

1. **The trust gate is open.** `projectTrusted` defaults to `true` (`settings-manager.ts:313`) and
   `run-turn.ts:446` passes no options, so a future project-scope write would succeed, not throw —
   and all N sessions share one `<cwd>/.pi/settings.json`, re-read every turn. The guard therefore
   belongs on the five `setProject*` methods named above (`:942`, `:958`, `:974`, `:990`, `:1006`),
   which are the paths that would reach `updateProjectSettings` if one ever became turn-reachable —
   not on the `setProjectTrusted` call sites, which cannot write.
2. **The settings lock busy-waits synchronously.** `acquireLockSyncWithRetry` (`:192-217`) spins up to
   10 × 20 ms and is entered on the **read** path too whenever the file exists (`:226-228`). On a
   single-threaded event loop that stalls _every_ multiplexed session for up to 200 ms.
   `SettingsManager` has no async variant of `withLock`, so contention always spins.

   What makes this structural rather than incidental is the key it locks on:
   `join(resolvedCwd, CONFIG_DIR_NAME, "settings.json")` (`:189`) — derived from `cwd`, the
   process-global this section just declared inert. Every session in a process therefore resolves to
   **one** lockfile, so contention scales with S rather than being a coincidence of layout, and each
   contended acquisition burns CPU rather than yielding. Two notes for whoever inherits it:
   - `AuthStorage` has a byte-identical `acquireLockSyncWithRetry` (`auth-storage.ts:76-98`, same
     10 × 20 ms sync spin under the same "Sleep synchronously to avoid changing callers to async"
     comment) but does **not** carry the hazard onto the credential path: `getApiKey` (`:464`)
     refreshes via `refreshOAuthTokenWithLock` (`:409`, called at `:490`), which uses `withLockAsync`
     (`:417` → `:124`) and retries asynchronously. Only the sync write-path callers spin, and a server
     turn should not reach them. `SettingsManager` is the live instance; do not go looking for a
     second one on the credential path.
   - The instrument that catches it already exists in the deployment-model slice — P6 §5.2's
     per-worker event-loop lag p99 (`monitorEventLoopDelay`). No new pin is owed here.

## 5. Testing & verification gate

The load-bearing test is a **two-tenant interleaved turn test that fails on `main` today**: two
sessions with different subjects, turns interleaved, against a stub upstream that records the
`Authorization` header of each request; assert each request carried its own subject's placeholder and
never its neighbour's. It fails today for the most basic reason available — no per-request subject
exists at all (§2.3).

**Interleaving must happen at `await` boundaries, not sequentially.** Node is single-threaded, so
the hazard shape is precisely "a global mutated between two awaits". A sequential two-session test
would pass while the bug remained, which makes it worse than no test.

**Write it against a parameterizable entry point, not against `startServer()` directly.** The
deployment-model slice inherits this test and runs it at the **worker** level (P6 §7), because that is
where W×S sessions actually share a process — round one claims no isolation property of its own, but it
must not break this one unknowingly, and re-running P5's own test is the cheapest way to know. If the
test stands up `startServer()` directly it has to be forked to do that. Deciding it while authoring
costs nothing; retrofitting it means two copies of the assertion that can drift.

| Test                            | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Fails today because                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Two-tenant interleaved turns    | Each upstream request carries its own subject's placeholder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | No per-request subject exists        |
| Two-tenant interleaved, **SSE** | The same assertion over `POST /turn` with `Accept: text/event-stream` — the `:174` branch (§3.2 step 1). Not optional: the sync-only version above passes green while the SSE branch still resolves its credential from ambient env                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `:174` keeps ambient config today    |
| Fail-closed: no subject         | **No subject resolvable from any source** → 401 before a session is created, **and no upstream request made**. Phrased on resolvability, not on the header: MU1 §3.5 makes a token-bearing request with no `X-SH-Subject` legitimate (the subject is `token.sub`), so an assertion written as "no `X-SH-Subject` → 401" has to be _inverted_ later — the same trap this section warns about below for the three `model-gateway.test.ts` assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Ambient env silently supplies one    |
| Ambient-absence                 | With a real tenant token in `ANTHROPIC_API_KEY` before startup, a subject-less session still fails rather than borrowing it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | This is the leak (`run-turn.ts:310`) |
| Sentinel identity (§3.3)        | After startup `ANTHROPIC_API_KEY` equals the sentinel **exactly** and is byte-identical across two differently-subjected turns, **and `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` are absent** — the first outranks the sentinel in pi's own lookup (§3.2 step 3), so asserting the sentinel alone would stay green while a real credential took precedence over it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | No scrub exists                      |
| Lock-down invariant, in-process | After the startup scrub, no real provider credential is reachable from the harness **environment** in server mode — i.e. `ANTHROPIC_API_KEY` is the sentinel and the two token vars are absent. Scoped to the environment rather than the whole process deliberately, and twice over: the pod as _deployed_ still receives one (§3.6), and MU1's interim **direct mode** puts a real token in process memory every turn, a divergence [ADR-0033](../adrs/0033-multi-user-control-plane.md) explicitly accepts (MU1 §3.6 item 2). MU1 never writes the environment, so the env-scoped form stays true through MU3 — whereas the process-scoped form fails the moment MU1 lands, and the tempting repair at that point is to weaken the assertion, discarding exactly the pin §2.4 exists to create. Implementations wanting the stronger claim should gate it on direct mode being disabled rather than loosen it | Unpinned prose today (§2.4)          |
| Four reachability guards (§4)   | Each inert global stays inert                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | New guards                           |

Homes: `harness/test` and `packages/knative-server/test` — both typechecked since #190, which is the
gate that made this work sequenceable (threading per-session identity is exactly the change whose
test fakes need compiler checking).

The ambient-absence test deserves emphasis: it is the only test that would have caught the original
defect, and it must set the env var _deliberately_ and assert failure anyway. A test that merely
omits the env var proves nothing.

**Three existing tests assert exactly what step 2 deletes, and must be inverted rather than updated.**
They are currently correct about `main`, so they will fail on a correct implementation — expect them
in the step-2 diff and do not let a green run be achieved by weakening them:

- `harness/test/model-gateway.test.ts:50` — _"seeds `ANTHROPIC_API_KEY` from the auth token when the
  key is unset"_ pins the `:310-312` seed. Invert: assert the env key is **not** written from the token.
- `:42` — _"reads `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from env when config omits them"_ must
  be **split**, not deleted: the `BASE_URL` half survives (§3.5 keeps `anthropicBaseUrl`
  deployment-level), while the `AUTH_TOKEN` half inverts to assert no `Authorization` header.
- `:78` — _"treats an empty-string config value as unset and falls back to the env var"_ takes the same
  split; after step 2 the `||`-not-`??` reasoning at `run-turn.ts:304-305` applies to `gatewayBase` only.

`:27` (_"returns the base model unchanged…"_) stays as-is and is load-bearing in the other direction —
it is the pin that proves §3.2 step 2's fail-open, which is why the 401 carries clause 3.
`run-turn.test.ts`, `run-turn-model.test.ts` and `turn-stream.test.ts` also touch these env vars.

## 6. Scope / YAGNI — explicitly NOT building

- **The deployment model.** `ScaledJob` → elastic pod pool, the pod-count and activation-latency
  numbers, and #55's overload shift from pod-level to session-level. Separate slice, separate issue;
  this one is its prerequisite. That slice now has a spec —
  [P6](https://github.com/rossoctl/moca/pull/244), which realizes it as a VM process
  manager plus session mux rather than on Kubernetes — so the three forward references above (the
  shared scrub function in §3.2 step 3, the non-CLI entry-point pin in §4, and the parameterizable
  test entry point in §5) have a named consumer rather than a hypothetical one.
- **The injector's per-subject half.** Z5's per-user / RFC 8693 token-exchange source replacing
  `static_inject`'s static `secret_dir`. Different repo (`kagenti-extensions`), deferred plane
  (`specs/README.md:152`).
- **`SessionContext` threaded through `pi-fork`.** §2.2 and §4: the credential path is already
  per-session, and the other globals are inert. Four `pi-fork` refactors would add divergence and
  fix nothing.
- **The secret-free harness _pod_.** `service.yaml:45-49` and `:56` keep mounting `llm-credentials`,
  so this slice pins the lock-down invariant in-process only (§3.6). Making it true of the deployment
  needs an injector in the harness's egress path, which no manifest provides — owed by the lock-down
  slice (ADR-0011 · Z2) and injector deployment (ADR-0012 · Z3), not by this one.
- **Caller authentication.** `X-SH-Subject` states _who the work is for_, not _who may ask_. Caller
  auth is ADR-0011's lock-down work; §3.2 keeps `Authorization` free for it.
- **Per-tenant sandbox or data isolation.** Untouched here — but one case is called out rather than
  left to the general disclaimer, because §3.1's guarantees do not cover it and a reader could
  reasonably assume they do. **Sessions are not bound to subjects, so this slice does not prevent
  cross-tenant session resumption.** `/turn` takes `sessionId` from the request body
  (`server.ts:101`) and passes it to `SessionManager.openFromCheckpoint` (`run-turn.ts:439`), and the
  Redis keyspace is flat — `session:${sid}` and `session:${sid}:seq`
  (`packages/session-backend/src/redis-backend.ts:6-7`; the full path matters because
  `harness/src/buffered-redis-backend.ts` also exists). A
  caller supplying another subject's session id therefore resumes that conversation and reads its
  history, and does so while the upstream call carries the caller's _own_ placeholder: §3.1 clause 1
  holds exactly as specified and the leak happens anyway. The two are orthogonal, which is why this
  needs stating. The leaf path already closes it — `leafSessionId` prefixes `tenant/sessionId` before
  sanitizing (`run-leaf.ts:158-159`) — so the turn path lacking an equivalent is the same dual-path
  asymmetry §2.3 records for credentials, one layer up. **Precondition on the deployment:** until a
  subject→session binding exists, `/turn` must not be reachable by mutually untrusted callers, and
  §7's tenancy-_neutral_ claim assumes a gateway that has already partitioned them. Binding the id
  (prefix on write, verify on resume) belongs to the deployment-model slice.

## 7. Dependencies & what #220 may claim

**Deliverable now, without Z5:** everything in §3 and §5. The harness becomes tenancy-_neutral_ —
it carries a per-request subject and holds no ambient identity — so enabling mixed tenancy later is
an injector configuration change rather than a harness rewrite.

**Not claimable until Z5's per-user half lands:** end-to-end multi-tenant safety. Today
`static-inject` resolves by destination host or a static key (ADR-0026), i.e. one credential per
deployment. The harness half is the **strict prerequisite** — the injector cannot key on a subject
the harness never sends — so this slice unblocks that work and must not advertise more.

`#220` should therefore be split: this slice, the deployment-model slice, and the injector
dependency tracked against Z5. Its severity table needs the §2.1 corrections before anyone scopes
from it.

## 8. Implementation notes for a fresh session

Verified mechanics, so a clean session does not rediscover them.

**Files this slice touches.** `packages/knative-server/src/server.ts` (`buildConfig` → request-scoped
at **both** `/turn` call sites `:111` and `:174`, subject header parsing, the startup scrub in
`startServer()` `:576`, 401 path), `harness/src/run-turn.ts` (`applyModelGateway` :306, :310-312),
`harness/test/model-gateway.test.ts` (invert `:50`, split `:42` and `:78` — §5), plus new tests in
`harness/test` and `packages/knative-server/test`. **No `pi-fork` changes.** `harness/src/cli.ts:13`
and `packages/knative-server/src/leaf-job.ts:13-18` stay ambient on purpose (§3.2 step 3).

**Worktree setup.** `link:` deps resolve inside the worktree, so a fresh one needs, in order:
`git submodule update --init --recursive`, then `cd pi-fork && npm ci && npm run build`, then
`pnpm install` at the root. Skipping the `pi-fork` build fails typecheck with missing declarations.

**Tests need Redis** — the `sh-test-redis` container on `:6379`. ~10 `ECONNREFUSED` failures across
4 files means it is stopped, not a regression.

**Commands.** `make typecheck` is `pnpm -r typecheck` across 9 packages; a new package fails
`harness/test/typecheck-coverage.test.ts` until it has a `tsconfig.json` with `test` in its include
and a `typecheck` script. `make lint` runs pre-commit over all files and **skips untracked files** —
stage new files first or it may lint nothing.

**Commits.** `git commit -s` (DCO enforced in CI) and `Assisted-By: Claude (Anthropic AI)
<noreply@anthropic.com>`.

## 9. References

- Issue [#220](https://github.com/rossoctl/moca/issues/220) — multi-session
  multiplexing (this slice realizes its concurrency-safety half; see §2.1 for corrections to its
  severity table).
- [ADR-0032](../adrs/0032-per-request-subject-no-ambient-credential.md) — the decision this spec records.
- [MU1](2026-09-08-multi-user-control-plane-design.md) · [ADR-0033](../adrs/0033-multi-user-control-plane.md) —
  composes with this slice; §3.5 adopts the `Authorization` / `X-SH-Subject` split, and §3.6 states the
  three interactions this spec's v1.1 amendment absorbs (tagged credential, env-scoped lock-down
  assertion, conditional inbound subject).
- [ADR-0011](../adrs/0011-harness-lockdown.md) · [Z2](2026-06-26-harness-lockdown-design.md) — secret-free harness.
- [ADR-0012](../adrs/0012-inference-injector.md) · [Z3](2026-06-26-inference-injector-design.md) — injector holds the keys.
- [ADR-0025](../adrs/0025-authbridge-deployment-topology.md) · [ADR-0026](../adrs/0026-rc1-static-inject-plugin.md) · [RC1](2026-07-10-authbridge-egress-control-plane-poc-design.md) — placeholder swap, fail-closed.
- [ADR-0006](../adrs/0006-generalized-credentialed-egress.md) — `(subject ⊕ destination)` → credential resolution.
- [Z5](2026-06-19-m13-generalized-credentialed-egress-design.md) — home of the deferred per-user work.
- Epic [#49](https://github.com/rossoctl/moca/issues/49) · [P1](2026-07-02-p1-fs-free-harness-design.md) — the two-tier split this assumes.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
