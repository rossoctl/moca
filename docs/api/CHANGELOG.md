# Control-plane API changelog

The version is `info.version` in [openapi.yaml](openapi.yaml): the minor is bumped for additive
changes, the major only with a `/v2` ([change policy](../reference/change-policy.md), decision 5).

## 1.6.0

A subject's own gate record, trusted for its own templates
([#738](https://github.com/rossoctl/moca/issues/738)), per the
[subject trust spec](../specs/2026-11-08-subject-trust-gate-records-design.md). Trust is decided by
who submits a gate record, never by anything inside it. Every change is additive.

- `Profile` adds `selfAttest`, `selfAttestEgress` and `requireOfflineGate`. The default policy adds
  `benchmark-self` (the `benchmark` rules, no network) and `general-self` (no X11; `spec.egress` may
  be true, the KVM host's allowlisted egress); `benchmark` stays curated (its records must be in
  `trustedGateRecords`).
- On a `selfAttest` profile, a record not in `trustedGateRecords` passes `X1.trusted` for the
  creating subject's own templates. New create rules, each in the `check` record and named by a
  `422 policy_refused`: `X1.self.scope` (another subject already self-attested the same sha256),
  `X12.self` (the record must show commits refused, whatever the spec), `X1.self.egress`
  (`spec.egress` false unless the profile allows it) and `X1.offline`.
- `X1.offline`: on a profile that requires X1 (unless `requireOfflineGate: false`, as on
  `general-self`), a general-gate record needs `gate.floor_checked_offline: true` (fail closed); a
  curated family record predates the field and passes. The general-gate schema is the setting
  `SH_GATE_RECORD_SCHEMA` (default `moca-gate-record/1`; a malformed value refuses to boot), and
  GET /v1/policy answers it as `gateRecordSchema`, so a client's dry run applies the rule as the
  deployment does (an older control plane without the field reads as the default).
- The `gate` provenance record's `source` adds `self`, with `scope` (the submitter).
- `Template` and `TemplateBuild` add `attestation` (`deployment | self`), recomputed on every read
  from the current policy. `TemplateBuild` adds `gateFloorCheckedOffline`, and
  `gateFloorMetOffline` for a gate from a `network_needed` contract. A template with a registered
  self-attested build reads `visibility: private`, whatever is stored.
- New error code `self_attested` (409): a self-attested create asking for `deployment`
  visibility, or a self-attested build added to a deployment-visible template. The same refusal on
  a visibility edit applies once the template edit route is in.
- PUT /v1/policy: a removal from `trustedGateRecords` that makes builds of deployment-visible
  templates self-attested names them as `narrowed: [{template, buildId}]` in its answer and in its
  `policy` record; those templates read as private from then on, and their owners keep using them.

## 1.5.0

Self-serve template create, gated by policy ([#737](https://github.com/rossoctl/moca/issues/737)),
per the [template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md)
§4 and §8. Every change is additive; all new routes mount on both route profiles and need
`SH_PROVENANCE_DIR` (else `400 invalid_request`).

- New POST /v1/templates `{id, image, spec, gateRecord?, profile?, visibility?}`: any enrolled
  client creates a template from an image pinned by digest. The deployment's policy checks it before
  anything is queued; an admitted create answers `202 {templateId, buildId: null, build, status:
queued}`, `build` being the build's path under a `b-<26 hex>` handle, and writes `create`, `gate`
  (with a gate record) and `check` provenance records. A create with the same image, spec, profile
  and gate record sha256 as a build of the caller's own template that is registered or on its way
  answers that build with `reused: true` (`200` when registered, `202` before); a failed or rejected
  build is never reused.
- New POST /v1/templates/{id}/builds (the owner, or an admin: a new image or spec, the same body and
  answers) and POST /v1/templates/{id}/builds/{build}/cancel (the owner, or an admin: a queued,
  building or probing build becomes `failed` with `reason.step` `cancelled`, and a `build` record).
- New GET /v1/policy (any enrolled client) and PUT /v1/policy (an admin; each change a `policy`
  record naming who), with the `Policy` (`moca-template-policy/1`: profiles with their rules and
  size envelope, allowed registries, trusted gate records by sha256, quotas) and `PolicyView`
  schemas. The default policy has a `base` and a `benchmark` profile.
- New GET /v1/quota: the caller's limits and use (`templates`, `buildsQueued`, `active`), and on the
  sandbox profile the live-sandbox cap (`sandboxes`).
- New error codes `policy_refused` (422, with `rule`, the gating rule's id from
  `deploy/sbx/template-onboarding/governance/GATING-RULES.md`) and `template_exists` (409: ids are
  unique per deployment, the first creator owns one). `quota_exceeded` on a create names the quota
  (`quota`: `templates` or `buildsQueued`). The `Error` schema adds `rule` and `quota`.
- `TemplateBuild` adds `handle` (the create's handle; equal to `buildId` for an imported build) and
  `reason` (why a build failed or was rejected), and GET /v1/templates/{id}/builds/{build} also
  finds a build by its handle.

## 1.4.0

The template store and its read API ([#736](https://github.com/rossoctl/moca/issues/736)), per the
[template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md) §3-§4.
Every change is additive.

- GET /v1/templates mounts on both route profiles (it was `sandbox` only), so a Moca Pi brain and a
  stock agent read the same templates. Its first fields (`id`, `description`, `tools`) are unchanged;
  each template adds `owner` (null for one the deployment declared), `visibility`, `onboarding`,
  `readiness`, `tags` and `builds`, and the list adds a `hosts` block, empty until a later issue's
  host agent reports.
- New GET /v1/templates/{id}, GET /v1/templates/{id}/builds, GET /v1/templates/{id}/builds/{build}
  (each build with its own `spec`, seed included) and GET /v1/templates/{id}/tags (each tag's build,
  and when and by whom it was set), on both profiles.
- New `Template` and `TemplateBuild` schemas. A build's `readiness` comes from the relay's presence
  records: `active` with its `capacity`, `inactive`, or `unknown` when presence cannot be read.
  An imported build's id is `imported:<12 hex>`; a built one's is `sha256:<manifest hash>`.
- POST /v1/sandboxes takes `template` as `id`, `id:tag` or `id@<build id>`, resolved to one
  registered build at creation and kept for the sandbox's life; an unknown one is still
  `400 unknown_template`. The `Sandbox` schema adds `buildId` and `templateManifestHash` (null for an
  imported build, which names no snapshot).
- New error code `template_not_found` (404): an unknown template or build, or a `private` template
  the caller does not own.
- `SH_PROVENANCE_DIR` keeps the templates in a store on a persistent volume, with the provenance
  records ([#730](https://github.com/rossoctl/moca/issues/730)): `SH_SANDBOX_TEMPLATES` is imported
  into an empty store once and ignored after that. Unset, templates come from the env list at every
  start, as before.

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
