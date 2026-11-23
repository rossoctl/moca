---
sidebar_position: 1
---

# Build a client: interfaces, calls, errors and retries

> **Preview.** The control-plane, sandbox and harness APIs are implemented but not yet declared
> Stable; interfaces and limits may change. Known limits: [Known gaps](../harness/reference/http-api.md#known-gaps).

This page is for a developer who writes their own client for moca: an SDK, a tool, a script or an
agent's MCP server. It covers the interfaces a client talks to, which API calls each `mocactl sbx`
command makes (so you can copy what it does), the error codes across REST, SSE and gRPC with what
a client should do about each, the CLI's exit codes, and when to retry.

The contracts are the source of truth: [`openapi.yaml`](openapi.yaml) (control plane),
[`harness-openapi.yaml`](harness-openapi.yaml) (harness) and
[`proto/sandbox/v1/sandbox.proto`](../../proto/sandbox/v1/sandbox.proto) (sandbox execution).

## The three interfaces

```
┌─────────────┐  REST /v1, JSON (API token)       ┌─────────────────────────┐
│ your client │──────────────────────────────────>│ control plane           │
│             │                                   │ logins, sandboxes,      │
│             │                                   │ templates, sessions     │
│             │                                   └─────────────────────────┘
│             │  gRPC SandboxExec (sandbox token) ┌─────────┐   ┌───────────┐
│             │──────────────────────────────────>│ relay   │<──│ worker    │
│             │                                   │ routes  │──>│ microVMs  │
│             │                                   │ Exec    │   │ (dials    │
│             │                                   └─────────┘   │ out)      │
│             │                                                 └───────────┘
│             │  REST + SSE turns (session token) ┌─────────────────────────┐
│             │──────────────────────────────────>│ harness                 │
└─────────────┘                                   │ runs turns on workers   │
                                                  └─────────────────────────┘
```

- **The control plane's REST API** holds every resource: logins and tokens, sandboxes, templates,
  sessions, credentials and config bundles, under `/v1`, in JSON. Errors are
  `{"error": "<stable code>", "message": "..."}`. The caller is never in a path: `/v1/sessions`
  means the caller's sessions. `GET /v1/discovery` tells a client the rest, including the
  harness's URL (`harnessUrl`).
- **Sandbox execution is gRPC**, service `SandboxExec` of `sandbox.v1`. The client dials the
  relay, which checks the sandbox token and routes the call to the worker serving the sandbox's
  template. Each call stands alone; there is no session. See
  [Call the sandbox API from your own code](../sandbox/how-to/direct-api.md).
- **The harness runs turns** of a session: `POST /v1/turn` with a session token, answered as one
  JSON result or, with `Accept: text/event-stream`, as SSE frames. See the
  [HTTP API guide](../harness/reference/http-api.md).

### Which credential each takes

Lifetimes and rotation are in the [security model](../reference/security-model.md#tokens) and, for
the sandbox token, in [Tokens](../sandbox/how-to/direct-api.md#tokens).

| Credential     | Sent to                                                                       | How a client gets a new one                                                                                             |
| -------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Device code    | `POST /v1/auth/device/token`, polled every `interval` s until its `expiresIn` | `POST /v1/auth/device` again (start a new login)                                                                        |
| API token      | every control-plane `/v1` call, as `Authorization: Bearer`                    | `POST /v1/auth/token` with the refresh token; keep the rotated refresh token it returns                                 |
| Refresh token  | `POST /v1/auth/token` only                                                    | rotated on each use; `400 invalid_grant` means log in again                                                             |
| Session token  | the harness's turn routes, for one session                                    | `POST /v1/sessions/{id}/token`                                                                                          |
| Sandbox token  | `SandboxExec` calls on one sandbox, as gRPC metadata                          | `POST /v1/sandboxes/{id}/token` (owner only); send `{"activity": false}` when the mint runs no command                  |
| Set-mode token | `LeaseControl set_mode`, once                                                 | answered by `PUT /v1/sandboxes/{id}/mode`, or `POST /v1/sandboxes/{id}/mode-token`; re-mint once on `PERMISSION_DENIED` |

A script that needs a token asks `mocactl` for it instead of reading its files: `mocactl auth token`
for an API token, `mocactl sbx token` for a sandbox token.

## The bridge table: `mocactl sbx` command to API calls

What each `mocactl sbx` command sends, so a client can do the same. For the top-level `mocactl`
commands (`login`, `run`, `sessions`, `promote`, `doctor` and the rest), see the
[`mocactl` command reference](../harness/reference/cli-mocactl.md#commands). The template routes
are in [`openapi.yaml`](openapi.yaml) under `/v1/templates`, `/v1/quota` and `/v1/policy`.

This table is derived from `packages/mocactl/src/sbx/*.ts` and may lag the code. Admin-only
commands (`subjects`, `enroll`, `templates quota`, and the like) are left out.

Every control-plane call below is retried once, after a token refresh, when it answers `401` with
`token_required`, `token_invalid` or `token_expired`. Every `Exec` and `LeaseControl` call is
preceded by `POST /v1/sandboxes/{id}/token` when no fresh sandbox token is held.

| Command                                    | API calls                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sbx login`                                | `GET /v1/discovery` (to refuse a control plane without the sandbox service), then `POST /v1/auth/device` and `POST /v1/auth/device/token` every `interval` s; a new code when one expires                                                                                                                                         |
| `sbx logout`                               | `POST /v1/auth/revoke` with the refresh token                                                                                                                                                                                                                                                                                     |
| `sbx templates ls` / `templates show`      | `GET /v1/templates`; `GET /v1/templates/{id}`, or `GET /v1/templates/{id}/builds/{build}` with `--build`                                                                                                                                                                                                                          |
| `sbx hosts`                                | `GET /v1/templates`, its `hosts` block                                                                                                                                                                                                                                                                                            |
| `sbx quota` / `sbx policy`                 | `GET /v1/quota`; `GET /v1/policy`                                                                                                                                                                                                                                                                                                 |
| `sbx templates create --dry-run`           | `GET /v1/policy` only; the checks run locally, nothing is posted                                                                                                                                                                                                                                                                  |
| `sbx templates create` / `templates build` | `POST /v1/templates` (`build ID`: `POST /v1/templates/{id}/builds`), with no policy read first. On `429 quota_exceeded` with `quota: buildsQueued`, the same POST again after `Retry-After` (30 s when none is sent), until `--timeout`. On `409 template_exists`, `GET /v1/templates/{id}` to say whose the id is                |
| `sbx templates follow`                     | without `--build`, `GET /v1/templates/{id}` for the newest build; then `GET /v1/templates/{id}/builds/{build}` every 5 s, polling through `5xx` and an unreachable control plane                                                                                                                                                  |
| `sbx templates cancel`                     | `POST /v1/templates/{id}/builds/{build}/cancel`                                                                                                                                                                                                                                                                                   |
| `sbx templates activate [--wait]`          | `POST /v1/templates/{id}/activate`; with `--wait`, the same POST again on `409 no_active_slot` after `Retry-After` (30 s when none is sent), then, without `--timeout`, `GET /v1/templates` for the host's start line, then `GET …/builds/{build}` every 5 s until `active`                                                       |
| `sbx templates deactivate`                 | `POST /v1/templates/{id}/deactivate` (`{stopNow: true}` with `--stop-now`)                                                                                                                                                                                                                                                        |
| `sbx templates tag` / `untag` / `edit`     | `POST /v1/templates/{id}/tags`; `DELETE /v1/templates/{id}/tags/{tag}`; `PATCH /v1/templates/{id}`                                                                                                                                                                                                                                |
| `sbx templates retire [--build] [--wait]`  | `POST /v1/templates/{id}/retire`, or with `--build` `DELETE /v1/templates/{id}/builds/{build}`; with `--wait`, `GET …/builds/{build}` every 5 s                                                                                                                                                                                   |
| `sbx create`                               | `POST /v1/sandboxes`; on `409 template_not_active`, the same POST again after `Retry-After` (30 s when none is sent), for up to 10 minutes; on `409 name_conflict` for a name it made up (no `--name`), the same POST again with a fresh `adjective-surname`, up to 5 POSTs in all                                                |
| `sbx create --mode M`                      | as `create`, then `POST …/mode-token` and `LeaseControl set_mode` with that set-mode token (re-minted once on `PERMISSION_DENIED`)                                                                                                                                                                                                |
| `sbx create --seed`                        | as `create`, then `GET /v1/templates/{id}` for the served build's seed, an `Exec` of the seed, and an `Exec` that checks the workspace for a clean git tree                                                                                                                                                                       |
| `sbx ls [--all]`                           | `GET /v1/sandboxes` (`?all=1`)                                                                                                                                                                                                                                                                                                    |
| `sbx get`                                  | `GET /v1/sandboxes/{id}`; for a lease mode, a token minted with `{activity: false}` and `LeaseControl status`, and, when the worker does not know the epoch, `POST …/mode-token` with `{activity: false}` and `LeaseControl set_mode`                                                                                             |
| `sbx mode M`                               | `GET /v1/sandboxes/{id}` (to refuse an upgrade without a terminal and carry the idle timeout over), `PUT /v1/sandboxes/{id}/mode`, sent again without `idleTimeoutS` on `400 invalid_request` when the timeout was carried, then `LeaseControl set_mode`                                                                          |
| `sbx reset`                                | `LeaseControl status`, then `LeaseControl reset`                                                                                                                                                                                                                                                                                  |
| `sbx proc start` / `ls` / `logs` / `stop`  | `Exec`s with a process kind (`lease+processes` only; refused locally below that mode)                                                                                                                                                                                                                                             |
| `sbx token [--renew-every S]` / `sbx env`  | `POST /v1/sandboxes/{id}/token` (`env`: with `{activity: false}`)                                                                                                                                                                                                                                                                 |
| `sbx run` / `sbx put`                      | `SandboxExec.Exec`, sent again as a new Exec after a refusal before start (see [Retries](#when-to-retry))                                                                                                                                                                                                                         |
| `sbx up`                                   | `GET /v1/sandboxes/{id}` for the bound sandbox, or `GET /v1/sandboxes` for one labelled with this repository; else `POST /v1/sandboxes` as `create`; then `Exec`s that send the tree and commit a baseline                                                                                                                        |
| `sbx push` / `sbx pull`                    | `Exec`s: the tree in; a `git diff` against the baseline out                                                                                                                                                                                                                                                                       |
| `sbx rm`                                   | without `--force`, an `Exec` that checks for unpulled changes; `GET /v1/sandboxes/{id}` (to read its mode); a sandbox token (`{activity: false}`); for a lease sandbox, `LeaseControl sandbox_deleted`; then `Release` for every sandbox; best effort, capped at 15 s in all, any error ignored; then `DELETE /v1/sandboxes/{id}` |
| `sbx mcp` / `sbx claude` / `sbx codex`     | one `Exec` per tool call; in a lease mode, `LeaseKeepalive` every 30 s                                                                                                                                                                                                                                                            |
| `sbx credentials` / `add` / `delete`       | `GET /v1/credentials`; `PUT` / `DELETE /v1/credentials/{name}`, with `consumer: sandbox-egress`                                                                                                                                                                                                                                   |
| `sbx egress [--ndjson \| --verify]`        | `GET /v1/sandboxes/{id}/egress`, paged by `after` (`--ndjson`: `format=ndjson`; `--verify`: the NDJSON log, then the first page's `summary`)                                                                                                                                                                                      |
| `sbx doctor`                               | the login check, `GET /v1/sandboxes/{id}`, and one `Exec` of `true`                                                                                                                                                                                                                                                               |

## Errors

Control-plane and harness errors are `{"error": "<code>", "message": "..."}`; `message` is left
out of `internal_error` by design. Branch on `error`, never on `message`. `Retry-After` comes on the
control plane's `409 no_active_slot` and `409 template_not_active` only, and on every harness `503`
and `429`; a control-plane `503` carries none.

On the harness, a turn that fails before its first SSE frame answers with the HTTP status below,
exactly as a non-streamed turn. Once the stream has begun, a failure is a terminal `error` frame
instead (see [Streaming frames](../harness/reference/http-api.md#streaming-frames)), with no status
and no `Retry-After`.

| Status | Code                                                                        | From          | When                                                                                                                                                  | What a client should do                                                                                             |
| ------ | --------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_json`, `invalid_request`, `configRef_invalid`                      | control plane | a malformed body or field                                                                                                                             | fix the request; the message names the field                                                                        |
| 400    | `invalid_grant`                                                             | control plane | the refresh token is unknown, revoked, expired or a replayed predecessor                                                                              | log in again                                                                                                        |
| 400    | `digest_mismatch`                                                           | control plane | a config-bundle upload whose bytes do not hash to the digest it claimed                                                                               | rebuild the bundle and upload again                                                                                 |
| 400    | `unknown_template`                                                          | control plane | a sandbox or session names an unknown, invisible or rejected build                                                                                    | list the templates and pick one                                                                                     |
| 400    | `credential_required`, `credential_ambiguous`, `model_unavailable`          | control plane | no credential, several and none named, or a model the endpoint does not offer                                                                         | name the credential or the model                                                                                    |
| 400    | `endpoint_unresolved`                                                       | both          | the inference credential has no endpoint, and the deployment sets no default                                                                          | give the credential an endpoint                                                                                     |
| 400    | `session_mismatch`, `subject_conflict`                                      | both          | the session token names another session; `X-SH-Subject` contradicts the token                                                                         | mint the token for this session; drop the header                                                                    |
| 400    | `prompt_required`, `sessionId_required`                                     | harness       | a turn without a `prompt`; an attach, cancel or status read without a `sessionId`                                                                     | fix the request; never retry it as is                                                                               |
| 400    | `tenant_not_allowed`                                                        | harness       | an authenticated read named a tenant (the session token alone scopes it)                                                                              | drop the tenant parameter                                                                                           |
| 401    | `token_required`, `token_invalid`, `token_expired`                          | both          | no, a bad or an expired API or session token                                                                                                          | refresh the token, then retry once                                                                                  |
| 401    | `unauthorized`                                                              | control plane | a device-flow start the identity provider refused, or a test user on the device flow                                                                  | do not retry as is; show the message                                                                                |
| 403    | `not_enrolled`                                                              | control plane | the subject is not enrolled for sandboxes; on a refresh, the login was ended                                                                          | send the operator the subject the message names                                                                     |
| 403    | `forbidden`                                                                 | control plane | not the owner, or an admin-only route                                                                                                                 | do not retry                                                                                                        |
| 403    | `mode_not_allowed`                                                          | control plane | a lease mode the deployment does not allow                                                                                                            | use `per-exec`, or ask the operator                                                                                 |
| 404    | `sandbox_not_found`, `template_not_found`, `session_not_found`, `not_found` | both          | unknown, or another user's (never 403, so ids cannot be probed)                                                                                       | check the id                                                                                                        |
| 404    | `credential_not_found`                                                      | both          | no credential with that name, or none the subject can resolve                                                                                         | add the credential, or name an existing one                                                                         |
| 404    | `config_bundle_not_found`                                                   | control plane | a session names a digest nobody uploaded, or that expired                                                                                             | promote the bundle again                                                                                            |
| 404    | `turn_not_found`                                                            | harness       | attach or cancel with no running or retained turn (an unknown async turn on the control plane is `404 not_found`)                                     | do not retry; start a new turn                                                                                      |
| 409    | `sandbox_terminated` (`reason`)                                             | control plane | a token or mode call on a sandbox deleted or expired                                                                                                  | create a new sandbox                                                                                                |
| 409    | `name_conflict`                                                             | control plane | you already have a live sandbox with that name                                                                                                        | pick another name                                                                                                   |
| 409    | `template_exists`, `self_attested`                                          | control plane | another subject's template id; deployment visibility for a self-attested template                                                                     | pick another id; keep the template private                                                                          |
| 409    | `template_not_active`                                                       | control plane | the build is not active; its activation has started unless you sent `activate: false`                                                                 | send the same call again after `Retry-After`                                                                        |
| 409    | `no_active_slot` (`reason: memory` when memory is the limit)                | control plane | every host holding the build is full                                                                                                                  | send the same call again after `Retry-After`                                                                        |
| 409    | `template_unavailable`                                                      | control plane | no registered build, or no host holds it                                                                                                              | do not retry as is; tell the operator, or rebuild                                                                   |
| 409    | `build_in_use`                                                              | control plane | a retire or reject while a live sandbox runs on the build                                                                                             | delete those sandboxes first                                                                                        |
| 409    | `destination_conflict`                                                      | control plane | another of your egress credentials already holds that destination                                                                                     | delete or edit the other credential                                                                                 |
| 409    | `policy_changed`, `quota_changed`                                           | control plane | a `PUT /v1/policy` (or a subject's quota) sent with `?expect=` after the stored one changed; nothing was written                                      | read it again, re-apply your change, write again                                                                    |
| 409    | `bootstrap_subject`                                                         | control plane | an unenroll or role change for a subject the deployment's settings enroll (`SH_ALLOWED_SUBJECTS`, `SH_ADMIN_SUBJECTS`)                                | change it in the settings instead                                                                                   |
| 409    | `admin_granted`                                                             | control plane | an unenroll of a subject that holds the admin role, which keeps it enrolled                                                                           | revoke the role first, then unenroll                                                                                |
| 409    | `self_revoke`                                                               | control plane | an admin revoking its own admin role                                                                                                                  | have another admin revoke it                                                                                        |
| 409    | `turn_not_cancellable`                                                      | control plane | a cancel of an async turn that is no longer queued                                                                                                    | read the turn's result                                                                                              |
| 409    | `turn_in_progress` (`turnId`)                                               | harness       | the session already runs a detachable turn                                                                                                            | attach to `turnId`, or wait for it to end                                                                           |
| 409    | `turn_mismatch` (`turnId`)                                                  | harness       | a cancel names a turn other than the session's running one                                                                                            | cancel the `turnId` in the answer, if that is the turn you meant                                                    |
| 410    | `template_retired`                                                          | control plane | a use, activation or create through a retired build                                                                                                   | choose a live build, or move the tag                                                                                |
| 410    | `device_code_expired`                                                       | control plane | the login was not approved in time                                                                                                                    | start the login again                                                                                               |
| 410    | `config_bundle_not_found`                                                   | harness       | the session's promoted bundle is gone                                                                                                                 | promote the same directory again; if it changed, start a new session                                                |
| 422    | `policy_refused` (`rule`)                                                   | control plane | a template create failed a gating rule                                                                                                                | fix what the rule names; `templates create --dry-run` checks it first                                               |
| 422    | `config_bundle_unsupported`                                                 | harness       | the bundle's format is newer than this harness reads                                                                                                  | not retryable as is: the harness must be upgraded                                                                   |
| 428    | `authorization_pending`                                                     | control plane | the user has not approved the device code yet                                                                                                         | poll again after `interval`                                                                                         |
| 429    | `quota_exceeded` (`quota` on a template quota)                              | control plane | the live-sandbox cap; `templates`, `buildsQueued` or `owned` on a create; `active` on an activation; on an OIDC deployment, too many sign-ins waiting | free one (`sbx rm`, retire) or ask an admin; for `buildsQueued`, wait for a queue slot; for a login start, back off |
| 429    | `bundle_quota_exceeded`                                                     | control plane | the config-bundle byte budget is full                                                                                                                 | delete bundles you no longer need, or ask the operator                                                              |
| 429    | `async_quota_exhausted`                                                     | control plane | you already hold your cap of queued async turns                                                                                                       | wait for one to finish                                                                                              |
| 429    | `subject_quota_exceeded`                                                    | harness       | you already hold your share of in-flight turns on this worker                                                                                         | retry after `Retry-After`                                                                                           |
| 429    | `overloaded`                                                                | supervisor    | the host is full; refused before the turn reached a worker (not in `harness-openapi.yaml`)                                                            | retry after `Retry-After`                                                                                           |
| 500    | `internal_error`                                                            | both          | a server fault (on the harness, also a template seed that failed)                                                                                     | not retryable as is; report it                                                                                      |
| 501    | `workload_runs_unavailable`                                                 | both          | a run or async turn names a workload on a deployment without workloads                                                                                | do not retry; drop the workload                                                                                     |
| 502    | `identity_provider_misconfigured`                                           | control plane | the deployment's OAuth app is misconfigured                                                                                                           | do not retry; tell the operator                                                                                     |
| 503    | `redis_unavailable`, `credential_unavailable`, `model_catalog_unavailable`  | control plane | a dependency is down; no `Retry-After`                                                                                                                | back off and retry                                                                                                  |
| 503    | `sandbox_unavailable`, `credential_unavailable`, `redis_unavailable`        | harness       | no sandbox capacity now, the control-plane exchange failed, or Redis did not answer                                                                   | retry the same turn after `Retry-After`                                                                             |

A replayed refresh token that was superseded more than the grace window ago revokes the whole login;
the server records that, and the client sees only `400 invalid_grant`.

**gRPC (`SandboxExec`).** The status codes and their causes are in
[Outcomes versus failures](../sandbox/how-to/direct-api.md#outcomes-versus-failures). What a client
does about them:

| Status                                                      | What a client should do                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED`                                           | mint a new sandbox token once and retry with the same `req_id`, only if no event of the call had arrived              |
| `RESOURCE_EXHAUSTED` "sandbox busy"                         | nothing ran: send it again as a new Exec with a new `req_id`, after a backoff                                         |
| `DEADLINE_EXCEEDED` "sandbox token expired during the Exec" | never retry as is: shorten or split the command                                                                       |
| `PERMISSION_DENIED`, `INVALID_ARGUMENT`, `ALREADY_EXISTS`   | fix the request (`sandbox_id`, `workspace_key`, `req_id`); a `LeaseControl set_mode` re-mints its set-mode token once |
| an `error` event or a non-OK status after the first event   | the command may have run: report it, never run it again                                                               |

## Exit codes

Per-command detail is in the generated references:
[`mocactl sbx`](../sandbox/reference/cli-sbx.md) and
[`mocactl`](../harness/reference/cli-mocactl.md#exit-codes). The exits of `sbx.py` are in
[The examples](../sandbox/how-to/direct-api.md#the-examples).

| Code              | `mocactl sbx`                                                                                                                    | `mocactl`                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| the command's own | `sbx run`: the command ran and exited with it                                                                                    |                                                                                |
| `0`               | ok                                                                                                                               | ok                                                                             |
| `1`               | failed (also a refusal of the control plane)                                                                                     | failed (the turn, or the control plane refused)                                |
| `2`               | usage error                                                                                                                      | usage or setup problem, including not logged in                                |
| `3`               | log in first                                                                                                                     | `auth token`: log in first; `promote`: a credential would reach a shared store |
| `4`               | the control plane is unreachable                                                                                                 | `auth token`: the control plane is unreachable                                 |
| `5`               | a wait timed out (`templates follow`, `activate --wait`, `retire --wait`, a create waiting for a queue slot); nothing was undone |                                                                                |
| `75`              | `sbx run`, `sbx put`: refused before it started, on every try; nothing ran                                                       |                                                                                |
| `124`             | `sbx run`: the command timed out, or was killed                                                                                  |                                                                                |
| `125`             | `sbx run`, `sbx put`: the sandbox failed; there is no exit status                                                                |                                                                                |
| `130`             | interrupted (Ctrl-C); a build already queued goes on                                                                             | cancelled (Ctrl-C)                                                             |

## Quotas and limits

The defaults a client runs into are documented with what they bound:

- **Per sandbox:** two Execs in flight (one running, one waiting; a third is refused as busy),
  16 MiB per gRPC message, 8 MiB of stdout per call, and a longest command of one token lifetime
  minus 60 s (14 minutes by default) — [Calling the sandbox API, Limits](../sandbox/how-to/direct-api.md#limits).
- **Per user:** 3 live sandboxes by default, a 7-day idle lifetime, and how delete and removal take
  effect — [Limits](../sandbox/concepts/limits.md).
- **Templates:** your template quotas (`templates`, `buildsQueued`, `active`, `owned`) and their
  use: `GET /v1/quota` (`mocactl sbx quota`); a refusal is `429 quota_exceeded` naming the `quota`
  (above).

## When to retry

- **Send the same call again after `Retry-After`:** `409 template_not_active` and
  `409 no_active_slot` on the control plane; every harness `503`; the harness's
  `429 subject_quota_exceeded` and the supervisor's `429 overloaded`. `mocactl` waits 30 s when a
  control-plane refusal carries no `Retry-After`, and gives a sandbox create 10 minutes in all.
- **Back off and retry:** a control-plane `503` (it sends no `Retry-After`) and an unreachable
  control plane, as `mocactl`'s pollers do; `429 quota_exceeded` with `quota: buildsQueued`, until
  your own timeout; a login start's `429 quota_exceeded`, a few times, never in a tight loop.
- **Poll at the interval the server gave:** `428 authorization_pending`, every `interval` seconds
  until `expiresIn` runs out.
- **Refresh, then retry once:** a `401` with `token_required`, `token_invalid` or `token_expired`;
  gRPC `UNAUTHENTICATED` if no event of the call had arrived (same `req_id`). A second `401` means
  the new token is no better: stop.
- **Send again as a new Exec, with backoff:** a refusal before start (`RESOURCE_EXHAUSTED`
  "sandbox busy", or the worker's `memory-budget:`, `max-runs:`, `busy: queue full`). `mocactl sbx
run` and `put` retry 4 times by default (`MOCACTL_SBX_BUSY_RETRIES`, at most 20), after about 1, 2,
  4 and 8 s with jitter, then exit 75. Each wait spends the sandbox token's lifetime.
- **Never retry as is:** anything after an Exec's first event (the command may have run);
  `DEADLINE_EXCEEDED`; a `4xx` that names a rule, a quota you must free, or a conflict;
  `422 config_bundle_unsupported`; `500 internal_error`; `501 workload_runs_unavailable`;
  `502 identity_provider_misconfigured`.

A detachable turn whose stream dropped is not sent again: attach to it with `GET /v1/turn` and the
last event id received, as in
[Detachable turns](../harness/reference/http-api.md#detachable-turns-attach-and-cancel).
