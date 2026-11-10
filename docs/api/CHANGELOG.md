# Control-plane API changelog

The version is `info.version` in [openapi.yaml](openapi.yaml): the minor is bumped for additive
changes, the major only with a `/v2` ([change policy](../reference/change-policy.md), decision 5).

## 1.3.0

Async turns: the owner-scoped submission API
([#387](https://github.com/rossoctl/moca/issues/387)) and the dequeue-time credential exchange
([#388](https://github.com/rossoctl/moca/issues/388)), per the
[async fan-out spec](../specs/2026-11-05-p6-async-fan-out-design.md) and
[ADR-0047](../adrs/0047-p6-async-fan-out-in-worker-drain.md). The M1 slice: a working drain under
`MOCA_TENANCY=single`.

- New POST /v1/sessions/{id}/turns (202 with the turn id), GET /v1/sessions/{id}/turns/{turnId} and
  DELETE /v1/sessions/{id}/turns/{turnId} (queued turns only). Owner-scoped: another user's session
  answers 404. `idempotencyKey` defaults to the session id, so a resubmission is deduplicated rather
  than queued behind. Documented in 1.2.0's document by oversight; recorded here.
- New `TurnStatus` schema and `turnId` path parameter. The nine turn states are pinned against the
  server's own list by a contract test.
- New POST /internal/turn-credentials, behind the existing `exchangeToken` scheme: a worker presents
  the turn id it read off the queue and gets back the credential resolved from the turn record. No
  credential and no bearer token ever travels in the work queue (MI1 §6.5). A pure read — it does not
  move the turn to `running`. The `turnId` must be the `t-<uuid>` shape the control plane mints;
  anything else is 400 `invalid_request`, refused before Redis is read.
- New error codes `turn_not_cancellable` (409, cancelling a turn that is not queued),
  `turn_not_claimable` (409, claiming a cancelled or terminal turn), `turn_not_found` (404),
  `async_quota_exhausted` (429, `MOCA_ASYNC_QUEUED_PER_OWNER` non-terminal turns already held),
  `async_tenancy_unsupported` (501, async under `MOCA_TENANCY=multi`) and
  `workload_runs_unavailable` (501, a submission naming a `workloadId`). Either 501 is answered
  before the quota is touched, so a request that can never be served is never reported as a 429 and
  leaves no record, no queue entry and no quota slot behind (§4.2).
- `async: true` on the harness's own turn route stays removed and still answers 400 `async_removed`;
  these routes are its replacement.

Interim, and named as such: /internal/turn-credentials returns a resolved credential rather than the
MI1 S2 grants, there is no `turn_exp`, and `MOCA_TENANCY=multi` refuses async at both the submission
and the claim. M2 mints grants for both audiences with a `turn_exp` and lifts that gate.

## 1.2.0

The sandbox service's routes ([SBX0 spec](../specs/2026-10-15-sbx0-internal-sandbox-service-design.md) §5.1),
served only by a control plane on the `sandbox` route profile (`SH_ROUTE_PROFILE=sandbox`); a moca
control plane answers 404 for all of them.

- New GET /v1/templates; POST and GET /v1/sandboxes; GET and DELETE /v1/sandboxes/{id}; and
  POST /v1/sandboxes/{id}/token, which mints a sandbox token for Exec (owner only, admins included).
- New GET /v1/janitor/sandboxes for the host janitor, behind the new `janitorToken` security scheme
  (`SH_JANITOR_TOKEN`).
- New `Sandbox` schema and `sandboxId` path parameter (`sbx-` plus 26 lowercase hex characters).
- New error codes `not_enrolled` (403), `sandbox_not_found` (404), `sandbox_terminated` (409, with
  `reason`), `name_conflict` (409), `quota_exceeded` (429) and `unknown_template` (400).
- Every sandbox route, the janitor's included, keeps its records in Redis and can answer
  `503 redis_unavailable`; POST /v1/sandboxes can answer `400 invalid_json`.
- GET /v1/discovery names the route `profile`, and on `sandbox` answers `execEndpoint` and `execCa`.
- POST /v1/auth/device/token and POST /v1/auth/token can answer `403 not_enrolled` on the `sandbox`
  profile (a subject not in, or since removed from, `SH_ALLOWED_SUBJECTS`); a refused refresh also
  revokes that login.

## 1.1.0

Per-session model selection ([spec](../specs/2026-10-14-per-session-model-selection-design.md)).

- New error codes `model_unavailable` (400) and `model_catalog_unavailable` (503).
- /internal/credentials returns the session's `model` when it names one.
- POST /v1/sessions accepts `model`; the session view shows it; new PATCH /v1/sessions/{id} switches it.
- New GET /v1/models and GET /v1/sessions/{id}/models.
