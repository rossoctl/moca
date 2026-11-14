# HTTP API guide

> **Preview.** Describes the P6 runtime on `main` as of 2026-11-12. The machine-readable contracts are
> [`docs/api/openapi.yaml`](../api/openapi.yaml) (control plane) and
> [`docs/api/harness-openapi.yaml`](../api/harness-openapi.yaml) (data plane); this page explains how
> they fit together and records behaviour the specs do not. Workload routes are covered in
> [`docs/context-service.md`](../context-service.md).

## Two APIs

| API                  | Who calls it                    | Found via                                               | What it does                                                |
| -------------------- | ------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Control plane        | Users, `mocactl`                | Its own URL (`SH_CONTROL_PLANE_URL` for `mocactl`)      | Login, sessions, credentials, config bundles, token minting |
| Data plane (harness) | Clients holding a session token | `GET /v1/discovery` on the control plane (`harnessUrl`) | Turns, leaf runs, attach, cancel                            |

A client logs in, creates a session (`POST /v1/sessions` returns `{sessionId, token, expiresAt}`), and
sends turns to the harness with that **session token**. A session token has scope `turn:write`, a
5-minute default TTL (`SH_SESSION_TOKEN_TTL_SECONDS`), and is bound to one session;
`POST /v1/sessions/{id}/token` mints a new one. API tokens (scope `api`, 15-minute default TTL via
`SH_API_TOKEN_TTL_SECONDS`, refreshable) are for the control plane and the harness's `/workloads/*` routes;
they are never accepted on `/turn`.

The same handler runs on every deployment path (VM, Kubernetes, Compose), so the data-plane
routes below are identical on all of them.

## Authentication on the data plane

Send `Authorization: Bearer <session token>`. The token is an Ed25519 JWT checked against
`SH_SESSION_TOKEN_PUBLIC_KEYS`.

- **No token:** 401 `token_required` when `SH_REQUIRE_AUTH=true`; otherwise the call is anonymous and
  uses the deployment's ambient model credential (the Compose default).
- **A present but bad token** is refused in either mode (`token_invalid`, `token_expired`).
- A token for one session cannot drive another: a `sessionId` in the body that differs from the
  token's session gives 400 `session_mismatch`; an `X-SH-Subject` that differs from the token's
  subject gives 400 `subject_conflict`.
- For authenticated turns the harness exchanges the token with the control plane for the user's
  inference credential, the config bundle (`configRef`) and the sandbox tier. On `/turn` these always
  come from the control plane, never from the request. `/v1/runs` is different: it does not inherit the
  session's bundle, and a leaf takes its `configRef` from the envelope (see
  [Leaf envelope and result](leaf-and-envelope.md#request)).
- An unreachable control plane fails the turn with 503 `credential_unavailable`; it never falls back
  to the environment.

## Routes

| Route                                    | Auth          | Purpose                                                                              |
| ---------------------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `GET /health`                            | none          | Liveness: 200 `ok`, header `X-Moca-Version`                                          |
| `POST /v1/turn` (alias `POST /turn`)     | session token | One interactive turn                                                                 |
| `GET /v1/turn?sessionId=`                | session token | Attach to a running or finished detachable turn                                      |
| `POST /v1/turn/cancel`                   | session token | Cancel a detachable turn                                                             |
| `POST /v1/runs` (alias `POST /runs`)     | session token | Run a leaf to completion                                                             |
| `GET /runs/status?sessionId=`            | session token | Read a leaf's stored result                                                          |
| `POST /run-leaf`, `GET /run-leaf/status` | session token | **Deprecated** aliases of `/runs` and `/runs/status`; log a warning once per process |

Matching is by URL and not uniform. `/health`, `/turn`, `/v1/turn` (POST), `/v1/turn/cancel`, `/runs`,
`/v1/runs` and `/run-leaf` match the exact URL, so a query string defeats them. `GET /v1/turn` requires
and accepts a query string, `/runs/status` and `/run-leaf/status` match by prefix, and `/workloads`
strips the query. Any other path returns an empty 404. The supervisor admin port (`/healthz`, `/readyz`, `/metrics`) is separate
and loopback by default.

## `POST /v1/turn`

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"prompt":"Run uname -a and tell me the kernel."}' \
  http://127.0.0.1:8080/turn
```

| Field        | Type    | Required | Notes                                                                                                                           |
| ------------ | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`     | string  | yes      | Missing gives 400 `prompt_required`                                                                                             |
| `sessionId`  | string  | no       | Authenticated: defaults to the token's session, created if absent. Anonymous: must exist (404 otherwise); omit it to create one |
| `detachable` | boolean | no       | `true` is honored only with `SH_TURN_DETACH=1`, a valid token, and `Accept: text/event-stream`; otherwise ignored               |

**Sync response (200):**
`{sessionId, response, stopReason, errorMessage?, usage?: {input, output, cacheRead, cacheWrite, total}, sandbox?: {id, tier, workspaceReset?: {from, reason}}}`.
A model-level failure still returns 200 with `stopReason` `error` or `aborted` and an `errorMessage`.

**Streaming:** send `Accept: text/event-stream` and read server-sent events (below).

**Errors before any output:**

| Status | Body `error`                                                                            | Meaning                                                                                                                                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `read_error`, `invalid_json`, `prompt_required`, `session_mismatch`, `subject_conflict` | Bad request                                                                                                                                                                                                                                         |
| 401    | `token_required`, `token_invalid`, `token_expired`                                      | Auth                                                                                                                                                                                                                                                |
| 404    | `session_not_found`                                                                     | A session that does not exist (anonymous calls), or passed through from the credential exchange                                                                                                                                                     |
| 409    | `turn_in_progress`                                                                      | `SH_TURN_DETACH=1` and a detachable turn is live (authenticated callers also get `turnId`)                                                                                                                                                          |
| 410    | `config_bundle_not_found`                                                               | The session's config bundle is missing or expired; the turn never runs without its skills                                                                                                                                                           |
| 503    | `sandbox_unavailable`                                                                   | Sandbox pool saturated, empty, or the session's sandbox is pending (affinity). Has `Retry-After`, and a `message` naming the cause (a pool, tier, template or sandbox id; for a host's mid-turn refusal a fixed sentence, never the host's figures) |
| 503    | `credential_unavailable`, `redis_unavailable`                                           | Control plane or Redis fault. Has `Retry-After` for 503s                                                                                                                                                                                            |
| 500    | `internal_error`                                                                        | Never carries error text                                                                                                                                                                                                                            |

Error bodies are `{error, sessionId?}`, plus a `message` on auth errors, on the `/turn` 503
`sandbox_unavailable` and on the `/runs` 501, and `turnId` on `turn_in_progress`. The 503 `Retry-After` is `KAGENTI_SYNC_SATURATION_RETRY_AFTER_S`
(default 5), or, for a pending affinity, the wait clamped to 1 to 10 seconds. The credential exchange also
passes through `credential_required`, `credential_ambiguous`, `credential_not_found`,
`endpoint_unresolved`, `session_not_found`, `token_invalid` and `token_expired`, so authenticated callers
can receive them too; any other non-200 answer from it becomes 503 `credential_unavailable`.

**Overload.** Before hand-off, the supervisor refuses a connection with a raw `HTTP/1.1 429`,
`Retry-After: 1` and `{"error":"overloaded"}`. This is a transport-level answer to any route and is not
in the OpenAPI files.

### Streaming frames

SSE framing is `[id: <turnId>:<entryId>\n]event: <type>\ndata: <frame JSON>\n\n`. A comment
`: keepalive` is sent every `SH_TURN_STREAM_KEEPALIVE_MS` (default 20000) so proxies keep the
connection. Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`.

Headers go out with the first frame. If none has been written after `SH_TURN_STREAM_FIRST_FRAME_FLUSH_MS`
(default 15000, `0` disables), they go out anyway with a `: keepalive` comment (a detachable turn writes its
`turn` frame instead), so a proxy idle timeout cannot cut a slow first frame. A failure after that point is a
terminal `error` frame, not an HTTP status.

| Event             | Fields                                                               | Notes                                                                                       |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `turn`            | `turnId`, `sessionId`, `truncated?`, `ended?`                        | Detachable and attach only; not terminal                                                    |
| `text`            | `delta`                                                              |                                                                                             |
| `thinking`        | `delta`                                                              | May never fire                                                                              |
| `tool_use`        | `id`, `name`, `args`                                                 |                                                                                             |
| `tool_result`     | `id`, `isError`, `preview`                                           | Preview is clipped to `SH_TURN_STREAM_TOOL_RESULT_PREVIEW_BYTES` (2048)                     |
| `workspace_reset` | `sessionId`, `from`, `tier`, `reason`                                | First, when the sandbox changed since the last turn (`detached` or `retiered`)              |
| `done`            | `sessionId`, `stopReason`, `usage?`                                  | Terminal                                                                                    |
| `error`           | `sessionId`, `stopReason`, `errorMessage?`, `usage?`, `abortReason?` | Terminal. `abortReason`: `cancelled`, `unwatched`, `restarting`, `lease_lost`, `owner_lost` |

`done` is used when `stopReason` is `stop`, `length`, `end_turn` or `max_tokens`; anything else ends in
`error`. On a non-detachable stream a client disconnect aborts the turn.

A terminal `error` frame for a host's mid-turn capacity refusal has the 503 `message`'s fixed sentence as its
`errorMessage`, never the host's figures. The refused command's `tool_result` is a tool result like any other:
its `preview` is the clipped text the tool returned, which for a refusal is the transport's error text.

### Detachable turns: attach and cancel

With `SH_TURN_DETACH=1`, a turn started with `detachable: true` outlives its connection. Every logged
frame carries an `id:`; a frame whose log write failed has none.

- **`GET /v1/turn?sessionId=ID`** follows the live turn and replays from the log. Send
  `Last-Event-ID: <turnId>:<entryId>` to resume after that entry; if the cursor is older than the
  retained log the `turn` frame has `truncated: true`. If the cursor is at or past the end of a **finished**
  turn, the stream is a single `turn` frame with `ended: true`; on a running turn it keeps following live
  from the tail. Errors: 400 `sessionId_required`, 401, 404 `turn_not_found`
  (including when detach is off), 503 `redis_unavailable`. If the owning process is gone the stream
  ends with an `error` frame, `abortReason: owner_lost`.
- **`POST /v1/turn/cancel`** with `{sessionId, turnId?}` returns 202 `{turnId, outcome}`, where
  `outcome` is `requested` or `ended` (a no-op). 409 `turn_mismatch` if `turnId` names a different turn;
  404 `turn_not_found`.
- An unwatched turn is aborted after `SH_TURN_DETACHED_MAX_S` (default 1800); a finished turn stays
  replayable for `SH_TURN_LOG_TTL_S` (default 86400).

## `POST /v1/runs`

Runs one leaf to completion and returns its result. The request is the leaf envelope and the response
is the leaf result; both are specified in [Leaf envelope and result](leaf-and-envelope.md).

- 400 `envelope_invalid` for a body that is not a leaf, solve or prompt envelope; 400 `configRef_invalid`
  for a non-string `configRef`.
- `GET /runs/status?sessionId=ID` returns the stored result: `{status: "queued"}` until one exists
  (also for a session that never existed), then the result for that status. 400 `sessionId_required`.
- An authenticated caller may not pass `tenant` (400 `tenant_not_allowed`).
- **`async: true` is removed, and stays removed.** It returns 400 `async_removed`: the KEDA drainer
  that consumed the queue went with the Knative/KEDA path (ADR-0041). This route is not coming back
  — it is unauthenticated when `SH_REQUIRE_AUTH` is off, which would be a second trust model for one
  queue. Its replacement is the authenticated, owner-scoped `POST /v1/sessions/{id}/turns` with
  `async: true` → `202 {sessionId, turnId}`, designed in
  [ADR-0047](../adrs/0047-p6-async-fan-out-in-worker-drain.md) and documented in
  [`docs/api/openapi.yaml`](../api/openapi.yaml). **That path works**, with two conditions: each
  worker needs `SH_ASYNC_DRAIN=1` (off by default) to drain the queue, and the deployment must be
  `MOCA_TENANCY=single` — under `multi`, submission answers 501 `async_tenancy_unsupported`. Poll
  `GET /v1/sessions/{id}/turns/{turnId}` for state and result. See
  [dispatch archetypes](../concepts/dispatch-archetypes.md) for the operator steps.
- On a saturated pool the sync path waits with backoff (up to `KAGENTI_SYNC_SATURATION_WAIT_MS`, 30 s)
  and then returns 503 with `Retry-After` and `{"status":"failed","reason":"saturated"}`.

## Control plane

The control-plane routes are listed in [`docs/api/openapi.yaml`](../api/openapi.yaml). In outline:

| Area           | Routes                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Probes         | `GET /healthz`, `GET /readyz`, `GET /v1/discovery` (harness URL, sandbox tiers, version; no auth)                                                                                                       |
| Login          | `POST /v1/auth/device`, `/v1/auth/device/token`, `/v1/auth/token` (refresh), `/v1/auth/revoke`, `/v1/auth/revoke-all`, `GET /v1/me`                                                                     |
| Sessions       | `POST` and `GET /v1/sessions`, `GET`, `PATCH` and `DELETE /v1/sessions/{id}`, `GET /v1/sessions/{id}/resources`, `POST /v1/sessions/{id}/token`                                                         |
| Async turns    | `POST /v1/sessions/{id}/turns` (submit, `202`), `GET /v1/sessions/{id}/turns/{turnId}` (state, attempts, result), `DELETE` the same path (cancel while `queued`)                                        |
| Models         | `GET /v1/models?credential=` (the models a credential's endpoint lists), `GET /v1/sessions/{id}/models` (the models the session's credential lists)                                                     |
| Credentials    | `GET /v1/credentials`, `PUT` and `DELETE /v1/credentials/{name}`                                                                                                                                        |
| Config bundles | `POST` and `GET /v1/config-bundles` (your own, newest first), `DELETE /v1/config-bundles/{digest}`                                                                                                      |
| Internal       | `POST /internal/credentials` (session token → credential) and `POST /internal/turn-credentials` (queued turn id → credential, at dequeue): data plane only, both authenticated with `SH_EXCHANGE_TOKEN` |
| Templates      | `GET /v1/templates`, `GET /v1/templates/{id}`, `GET /v1/templates/{id}/builds[/{build}]`, `GET /v1/templates/{id}/tags`: both route profiles (API 1.4.0)                                                |
| Self-serve     | `POST /v1/templates`, `POST /v1/templates/{id}/builds`, `POST /v1/templates/{id}/builds/{build}/cancel`, `GET` and `PUT /v1/policy`, `GET /v1/quota`: both route profiles (API 1.5.0)                   |
| Template admin | `POST /v1/templates/{id}/tags`, `DELETE /v1/templates/{id}/tags/{tag}`, `PATCH /v1/templates/{id}` (the owner, or an admin), `PUT /v1/templates/{id}/owner` (an admin): both route profiles (API 1.8.0) |
| Host agents    | `POST /v1/hosts/{host}/inventory`, `/builds/claim`, `/builds/{build}/log` and `/report`, `GET /v1/hosts/{host}/blobs/{digest}`: a host's own bearer, both route profiles (API 1.10.0)                   |
| Activation     | `POST /v1/templates/{id}/activate` and `/deactivate` (both route profiles); `GET /v1/hosts/{host}/wanted`, `POST /v1/hosts/{host}/workers/report` (a host's own bearer) (API 1.11.0)                    |
| Egress records | `GET /v1/sandboxes/{id}/egress` (the owner or an admin; sandbox profile); `POST /v1/hosts/{host}/egress` (a host's own bearer) (API 1.14.0)                                                             |
| Retire         | `POST /v1/templates/{id}/retire`, `DELETE /v1/templates/{id}/builds/{build}`: both route profiles (API 1.18.0)                                                                                          |

`POST /v1/sessions` takes an optional `model`, and `PATCH /v1/sessions/{id}` with `{"model": ID}` switches it (`null`
returns the session to the deployment default). A turn already running keeps its model; the next turn uses the new one.
An async turn is the exception, and it is not a next turn either: a turn already **queued** keeps the model it was
submitted with, however long it waits, because the turn record pins `model` and `sandboxTier` at submission and
`/internal/turn-credentials` reads them from the record ([#388](https://github.com/rossoctl/moca/issues/388)). The
switch applies to turns submitted after it.
The id is checked against the credential's catalog (400 `model_unavailable` when it is not listed); when the endpoint
cannot list its models, the id is accepted unverified and the answer has `modelVerified: false`. Only the two list routes
answer 503 `model_catalog_unavailable`. These routes came with API 1.1.0; see the [changelog](../api/CHANGELOG.md).

The template read routes came with API 1.4.0 and mount on both route profiles, so a session's brain and a sandbox client
read the same templates. With `SH_PROVENANCE_DIR` set, templates live in the control plane's template store
(`SH_SANDBOX_TEMPLATES` is imported into it once); unset, they come from the env list at every start. Each template is a
name over its builds, with tags naming builds (`default` is what a bare id names), and each registered build reports its
readiness from the relay's presence: `active`, `inactive`, or `unknown` when presence cannot be read. A sandbox create
names `id`, `id:tag` or `id@<build id>`, resolved to one build at creation and kept for the sandbox's life (the Sandbox
shows `buildId`). A `private` template, like an unknown id or build, answers 404 `template_not_found` to anyone but its
owner and admins. See the [template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md).

The self-serve routes came with API 1.5.0 and need `SH_PROVENANCE_DIR`. An enrolled client creates a template from an
image pinned by digest; the deployment's policy (`GET /v1/policy`, set by an admin with `PUT`) checks it before anything
is queued, and a refusal is 422 `policy_refused` naming the gating rule
([GATING-RULES.md](../../deploy/sbx/template-onboarding/governance/GATING-RULES.md)). Ids are unique per deployment
(409 `template_exists`); quotas are per subject (429 `quota_exceeded` naming which; `GET /v1/quota` shows them). A create
with the same inputs as a build of the caller's own template answers that build, `reused: true`.

The template admin routes came with API 1.8.0 and need `SH_PROVENANCE_DIR`. A template's owner, or an admin, moves tags
onto a registered build (`id:tag`, and the bare `id` for `default`, then name it for new sandboxes and sessions; those
already created keep their build), removes a tag (never `default`; the build stays), and changes the description or the
visibility (`private` hides it from other subjects, as a 404). An admin transfers a template to another enrolled subject
(`github:<id>` or `oidc:<sub>`), including one the deployment declared, which has no owner until then. Each change is a
provenance record (`tag`, `visibility` or `owner`) naming the new value and the one before.
The host routes came with API 1.10.0. A KVM host's agent (`deploy/sbx/host-agent.sh`) claims queued builds, builds them
with `template-build.sh` and reports them, with its own bearer (`SH_TEMPLATE_HOSTS`, `SH_HOST_TOKEN_<ID>`); the control
plane registers a built build or rejects it, by policy, naming the rule. A client follows its build by the create's handle
through `queued`, `building`, `probing` and `registered` (or `failed` with `reason.step`, `rejected` with `reason.rule`).

Activation came with API 1.11.0. A client takes or renews a lease on a registered build (`activate`, 60 s to a day a
grant, renewals unlimited); a build is wanted running only while a lease stands, and the host agents start and stop the
installed workers by each host's wanted state. A build no host holds is 409 `template_unavailable`; one whose holders are
all at their active limit with leased builds is 409 `no_active_slot` with `Retry-After`; over the subject's `active` quota
is 429 `quota_exceeded`. With template hosts configured, a sandbox create on a build that is not active takes the
caller's lease and answers 409 `template_not_active` with `Retry-After` (`activate: false` starts nothing). A template
imported from `SH_SANDBOX_TEMPLATES` is never gated (the deployment runs its worker) and takes no lease.

Egress records came with API 1.14.0. A sandbox's egress log (`GET /v1/sandboxes/{id}/egress`) holds the KVM host's
egress proxy events for it, shipped by the host agent; the sandbox's end record names the log's sha256. Paths are logged
without query, fragment or userinfo, and an injected credential appears by name only, but a secret a guest puts in a URL
path segment is logged as sent. See the [egress records spec](../specs/2026-11-08-sandbox-egress-records-design.md).

Retire came with API 1.18.0. The template's owner, or an admin, retires a whole template (`POST
/v1/templates/{id}/retire`, with an optional `reason`) or one build (`DELETE /v1/templates/{id}/builds/{build}`). A
retired build's leases go and its holding hosts are told to stop its worker; it is never served again: a sandbox create
or an activation naming it, a tag of it or a template whose every build is retired is 410 `template_retired`. A retire
is refused 409 `build_in_use` while a live sandbox runs on the build, and is idempotent. Each build retired writes a
`retire` record naming the caller, the status before and the build's `build` record. A retire cannot be undone: a new
build of the template is the way back. Each build lists `heldBy`, the hosts still holding its snapshot, and a retired
build reports `capacity` while its worker still runs (null once its host has stopped it). `mocactl sbx templates retire
--wait` waits for that stop, and returns at once for a build no host holds (`heldBy` null or empty: no host agent
stops its worker) and for a `shared` one (its snapshot or worker serves a build that is not retired, so its worker is
kept running for that build); waiting for the snapshot's removal from every host (`heldBy` empty) comes with
[#743](https://github.com/rossoctl/moca/issues/743).

Another user's session returns 404, not 403. Control-plane error codes and statuses: 400
(`invalid_json`, `invalid_request`, `invalid_grant`, `subject_conflict`, `session_mismatch`,
`digest_mismatch`, `configRef_invalid`, `credential_required`, `credential_ambiguous`, `endpoint_unresolved`, `model_unavailable`), 401 (`token_required`,
`token_invalid`, `token_expired`, `unauthorized`), 403 `forbidden`, 404 (`session_not_found`, `config_bundle_not_found`,
`credential_not_found`, `template_not_found`, `turn_not_found`), 409 (`template_exists`, `turn_not_cancellable`, `turn_not_claimable`, `no_active_slot`, `template_unavailable`, `template_not_active`, `build_in_use`), 410 (`device_code_expired`, `template_retired`), 422 `policy_refused`, 428 `authorization_pending`, 429
(`quota_exceeded`, `bundle_quota_exceeded`, `async_quota_exhausted`), 500 `internal_error`, 501
(`async_tenancy_unsupported`, `workload_runs_unavailable`), 502 `identity_provider_misconfigured`, 503
(`credential_unavailable`, `redis_unavailable`, `model_catalog_unavailable`). The list may not be complete; the mapping is in
`packages/control-plane/src/errors.ts`.

Note that the same `config_bundle_not_found` is 404 on the control plane and 410 on the harness.

## Known gaps

- The supervisor's 429 `overloaded` answer is not in `docs/api/harness-openapi.yaml`.
- `harness-openapi.yaml` describes `/runs/status` as for an async run; sync runs are stored and
  pollable too.
- `prompt` is only checked for presence; how a non-string behaves is not specified.
