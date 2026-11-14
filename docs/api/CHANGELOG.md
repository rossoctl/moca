# Control-plane API changelog

The version is `info.version` in [openapi.yaml](openapi.yaml): the minor is bumped for additive
changes, the major only with a `/v2` ([change policy](../reference/change-policy.md), decision 5).

## 1.12.0

Retire a template, or one build of it ([#749](https://github.com/rossoctl/moca/issues/749)), per the
[template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md) §5.1. Every
change is additive; the routes mount on both route profiles and need `SH_PROVENANCE_DIR` (else
`400 invalid_request`).

- New POST /v1/templates/{id}/retire `{reason?}` (the owner, or an admin): every build not yet
  retired becomes `retired`, its activation leases go, and each writes a `retire` record naming the
  caller, `from` (the status before), `buildRecord` (the digest of the build's `build` record, null
  for one never built) and the reason; earlier records stay. Answers
  `{templateId, subject, status, builds}`, each build a new `RetiredBuild`
  `{build, buildId, readiness, record}`. Idempotent: an already retired build is listed with
  `record: null` and no second record. Not reversible: a new build is the way back, and the id
  stays its owner's.
- New DELETE /v1/templates/{id}/builds/{build}: retires one build, by build id or handle, answering
  one `RetiredBuild` with `templateId`, `subject` and `status`.
- New codes: `409 build_in_use`, a retire refused while a live sandbox runs on the build;
  `410 template_retired`, a sandbox create or an activation naming a retired build, a tag of one, or
  a template whose every build is retired (was `400 unknown_template` or `409 template_unavailable`).
- Readiness gains `retired` (Template, TemplateBuild). TemplateBuild gains `heldBy`, the hosts whose
  last inventory holds its snapshot, a host gone silent too (null without host agents). A retired build whose worker still
  holds a presence record reports `capacity` `{running, inUse}`, as an active one does (null once
  its worker is stopped; `running: null` when presence cannot be read). TemplateBuild gains
  `shared`, true for a retired build whose snapshot or worker a build that is not retired also
  uses: its worker is kept for that build, and its `capacity` is null.
- GET /v1/hosts/{host}/wanted: `stop` also lists the retired builds the host holds with no live
  sandbox, except a `shared` one; and one worker id is never in both `run` and `stop` (two
  registered builds from one image share it); POST /v1/hosts/{host}/workers/report takes `detached` for a retired build. Removing a
  retired build's worker and snapshot from its host is not part of this version.

## 1.11.0

Activation leases and the hosts' wanted state ([#742](https://github.com/rossoctl/moca/issues/742)),
per the [template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md)
§6.2-§6.4. Every change is additive; the template routes mount on both route profiles and need
`SH_PROVENANCE_DIR` (else `400 invalid_request`).

- New POST /v1/templates/{id}/activate `{tag?, build?, leaseSeconds?}`: takes or renews the caller's
  activation lease on a registered build (60-86400 s; default the largest `idleLimitSeconds` of
  the hosts that hold it, clamped to 60-86400, else 3600; renewed by calling again, without limit) and answers
  `{templateId, buildId, leaseUntil, host}`. A build is wanted running only while a lease stands; a
  leased build is never evicted. Each grant is an `activate` record; the lease stores its digest. Refusals keep
  no lease: `409 template_unavailable` (no registered build under that reference, or no reporting
  host holds it), `409 no_active_slot` with `Retry-After` (every holder at its `activeLimit` with
  leased builds; the wait is until a build placed on one of its holders loses its last lease), `429 quota_exceeded` with `quota: active`. The quota and placement check, the
  record and the lease write run one activation at a time across all templates.
- New POST /v1/templates/{id}/deactivate `{all?}`: drops the caller's leases on the template (an
  admin with `all: true`, everyone's), answering `{templateId, released}`, with a `deactivate`
  record when any is dropped.
- New GET /v1/hosts/{host}/wanted (host bearer): `run`, the leased builds placed on this host within
  its `activeLimit`, and `stop`, the builds it holds with no lease and no live sandbox (and a leased
  build it runs while placement keeps it on another host); new `WantedWorker` schema. Placement is
  sticky (a running build stays on its host) and counts every worker that stays running on a host:
  leased builds placed or running there, and unleased ones draining a live sandbox.
- POST /v1/hosts/{host}/inventory: each `holds` entry gains `running` (boolean, default false):
  whether the build's worker unit runs on the host.
- New POST /v1/hosts/{host}/workers/report `{buildId, event, reason?}` (host bearer): `attached`,
  `refused` or `detached`, recorded as `activate` or `deactivate` records by `host:<host>` (a
  `refused` repeating the host's last one for a build still in its `run` is not recorded again:
  `recorded: null`);
  readiness still comes from the relay.
- POST /v1/sandboxes: activation on first use. With `SH_TEMPLATE_HOSTS` set, a create on a
  registered build that is not `active` takes the caller's lease (`reason: first_use` on its record;
  refused as activate would be) and answers `409 template_not_active` with `readiness` and
  `Retry-After: 30`; a caller already holding a live lease on the build is only answered the
  wait (no renewal, no record per retry). New body field `activate` (default true; false starts nothing). No sandbox
  record is kept while waiting. Without template hosts, nothing changes. A template imported from
  `SH_SANDBOX_TEMPLATES` is never gated, and activate refuses it with `400 invalid_request`: the
  deployment runs its worker, and its readiness is that worker's presence alone. The `sandbox` record's
  `lease` is now the digest of the caller's `activate` record (null without a lease).
- Readiness gains `activating`, `deactivating` and `unavailable` (Template, TemplateBuild); before
  any host reports it is the presence alone, as before.
- GET /v1/templates: `hosts` lists each reporting host's `active {limit, used}` (`used`: the
  workers placement counts on it), `idleLimitSeconds`
  and `disk {freeGb, floorGb}`. A host whose last inventory is over 6 minutes old is left out of
  it and of placement until it reports again.
- GET /v1/quota: `active.used` counts the builds the caller holds a live lease on.
- New error codes `no_active_slot`, `template_unavailable` and `template_not_active` (409); the
  Error schema gains `readiness`, and `quota` the value `active`.

## 1.10.0

Template host agents and their routes ([#741](https://github.com/rossoctl/moca/issues/741)), per the
[template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md) §6.1 and
§8.2. Every change is additive; the routes mount on both route profiles, need `SH_PROVENANCE_DIR`
for the builds (else `400 invalid_request`), and answer only a host listed in `SH_TEMPLATE_HOSTS`
(else `401 unauthorized`).

- New security scheme `hostToken`: one template host's bearer, `SH_HOST_TOKEN_<ID>`. The host in
  the path must be the one whose token is presented; no user, admin, janitor or egress token is
  accepted.
- New POST /v1/hosts/{host}/inventory: what the host holds (`holds`, each a `template` and its
  `manifestHash`) and its limits (`limits`: `activeLimit`, `idleLimitSeconds`, `buildConcurrency`,
  `diskFreeGb`, `diskFloorGb`).
- New POST /v1/hosts/{host}/builds/claim `{max}`: up to 4 queued builds, oldest first and subjects
  in turn, each moved to `building` and held by the host, with its job: the template id, the
  handle, the image and the spec as `template-build.sh` reads it (the template's id and the create's
  image always win over the spec's own; the guest size is always `guest_ram_mb`, the value the
  policy checked), and the gate record's path when the create had one.
- New GET /v1/hosts/{host}/blobs/{digest}: a stored document (a gate record) by sha256, base64 of
  its exact bytes.
- New POST /v1/hosts/{host}/builds/{build}/log (at most 200 entries a call; a build keeps its
  last 1000) and POST /v1/hosts/{host}/builds/{build}/report, whose `event` is `building` or
  `probing`; `failed` with `step` and `message`; or `built` with `templateRecord` and `manifest`,
  each file as a string. A report answers only a build this host claimed (else `404 not_found`);
  a failed or cancelled build takes no more. On `built` the control plane stores both files,
  writes a `build` record, checks them against the create's request and registers the build (its
  `buildId` becomes the manifest hash; a template's first registered build takes `default`) or
  rejects it with `reason.rule`, writing a `check` record (`at: registration`) either way.

## 1.9.0

A subject's own gate record, trusted for its own templates, and repositories allowed per registry
([#738](https://github.com/rossoctl/moca/issues/738)), per the
[subject trust spec](../specs/2026-11-08-subject-trust-gate-records-design.md). Trust is decided by
who submits a gate record, never by anything inside it. Every change is additive.

- `Profile` adds `selfAttest`, `selfAttestEgress` and `requireOfflineGate`. The default policy adds
  `benchmark-self` (the `benchmark` rules, no network) and `general-self` (no X11; `spec.egress` may
  be true, the KVM host's allowlisted egress); `benchmark` stays curated (its records must be in
  `trustedGateRecords`).
- On a `selfAttest` profile, a record not in `trustedGateRecords` passes `X1.trusted` for the
  creating subject's own templates. New create rules, each in the `check` record and named by a
  `422 policy_refused`: `X1.self.scope` (another subject already self-attested the same sha256;
  a build made while the record was trusted claims nothing, and a build that failed releases its
  claim),
  `X12.self` (the record must show commits refused, whatever the spec), `X1.self.egress`
  (`spec.egress` false unless the profile allows it) and `X1.offline`.
- `X1.offline`: on a profile that requires X1 (unless `requireOfflineGate: false`, as on
  `general-self`), a general-gate record needs `gate.floor_checked_offline: true` (fail closed); a
  curated family record predates the field and passes. The general-gate schema is the setting
  `SH_GATE_RECORD_SCHEMA` (default `moca-gate-record/1`; a malformed value refuses to boot), and
  GET /v1/policy answers it as `gateRecordSchema`, so a client's dry run applies the rule as the
  deployment does (an older control plane without the field reads as the default).
- The `gate` provenance record's `source` adds `self`, with `scope`: the subject the record counts
  for, the template's owner (the submitter, except on an admin's build for another subject's
  template).
- `Template` and `TemplateBuild` add `attestation` (`deployment | self`), recomputed on every read
  from the current policy: `self` for a build made on a `selfAttest` profile whose record is not
  trusted now, whatever its trust at create. `TemplateBuild` adds `gateFloorCheckedOffline`, and
  `gateFloorMetOffline` for a gate from a `network_needed` contract. A template with a registered
  self-attested build reads `visibility: private`, whatever is stored.
- New error code `self_attested` (409): a self-attested create asking for `deployment`
  visibility, or a self-attested build added to a deployment-visible template. PATCH
  /v1/templates/{id} answers the same refusal for `visibility: deployment` on a template with a
  self-attested build, registered or on its way there, and PUT /v1/templates/{id}/owner for a
  transfer of such a template to another subject.
- PUT /v1/policy: a removal from `trustedGateRecords` that makes builds of deployment-visible
  templates self-attested names them as `narrowed: [{template, buildId}]` in its answer and in its
  `policy` record; those templates read as private from then on, and their owners keep using them.
- `Policy` adds the optional `allowedRepositories`: per registry host (as the policy reads it,
  Docker Hub as `docker.io`), the repositories a create may name there, each an exact path
  (`library/python`) or a prefix (`library/*`), matched on whole path segments; a Docker Hub
  official name reads as `library/<name>`. New create rule `registry.repository`, which also
  refuses there an image path outside the entries' grammar (uppercase, or an empty, `.` or `..`
  segment). A registry with
  no list allows every repository, as before; a registry listed there must also be in
  `allowedRegistries`. Its keys compare case-insensitively, as `allowedRegistries` does.

## 1.8.0

Template tags, edits and owner transfer through the API
([#747](https://github.com/rossoctl/moca/issues/747)), per the
[template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md) §5.1-§5.2.
Every change is additive; the new routes mount on both route profiles and need `SH_PROVENANCE_DIR` (else
`400 invalid_request`). Each change writes a provenance record naming the new value and the one before.

- New POST /v1/templates/{id}/tags `{tags, build}` (the owner, or an admin): moves 1-16 tags onto a registered build of
  the template, by build id or handle, without a rebuild. New sandboxes and sessions naming `id:tag` (and the bare `id`,
  for `default`) get the new build; those already created keep theirs. A `tag` record per tag that changes
  (`{tag, buildId, before}`); a tag already on the build answers `record: null`.
- New DELETE /v1/templates/{id}/tags/{tag} (the owner, or an admin): removes a tag; its build is not deleted. `default`
  is moved, never removed (`400 invalid_request`); a tag name outside the tag grammar is `400 invalid_request`
  too. A `tag` record with `buildId: null`.
- New PATCH /v1/templates/{id} `{description?, visibility?}` (the owner, or an admin): a `visibility` record
  (`{field, value, before}`) per field that changes. A description holding a lone surrogate is `400 invalid_request`.
- New PUT /v1/templates/{id}/owner `{owner}` (an admin): the new owner, `github:<numeric id>` or `oidc:<provider sub>`
  (never `test:<n>`), must be enrolled. A template the deployment declared (`owner: null`) can be handed to a subject
  the same way (`before: null`), who can then build, tag and edit it; a restart does not undo it. An `owner` record
  (`{owner, before}`).
- Every template change (a tag moved or removed, an edit, an owner transfer, a cancelled build) is stored only once its
  records are on the chain: a record that fails to append refuses the change. The owner's check is made again under the
  template's lock, so a change by an owner the template was transferred away from meanwhile is refused (`403`).

## 1.7.0

Session grants: the key ring, the token format and the two lifecycle endpoints of
[MI1](../specs/2026-09-28-moca-multi-user-isolation-design.md) §6.1-§6.2, which discharge
[#388](https://github.com/rossoctl/moca/issues/388) items 1-2 and the `turn_exp` half of
[#387](https://github.com/rossoctl/moca/issues/387)'s M2.

- New POST /internal/turn-grants, behind the existing `exchangeToken` scheme: a worker presents the
  session token it was handed with the turn and gets the turn's two grants. The response is two
  signed grants, the turn's absolute `turnExp`, the `exp` to refresh at, and the session's bundle
  digest. **No credential and no secret is in it** — the inference grant names the session's
  credential and the sandbox grant names its `sandbox-egress` credentials, by name (§7.2). A grant is
  a capability spent at an enforcement point, not a secret.
- New POST /internal/grants/refresh: a worker presents either half mid-turn and gets a fresh pair.
  `turn_exp` is carried forward unchanged, so no number of refreshes extends a turn, and a refresh
  past it is refused outright rather than clamped. A fresh **issue** does start a new window:
  `turn_exp` is anchored to the call, and nothing yet identifies a turn to anchor to, so the bound
  on a caller holding a live session token is that token's lifetime. Anchoring issuance to the turn
  record is the redeemer's slice, where `turn_exp` first enforces anything. The session is re-read rather than echoed, so a
  credential or bundle changed mid-turn takes effect at the next refresh and a session tombstoned
  mid-turn stops refreshing (404 `session_not_found`, the same answer another user's session gives).
- New `TurnGrants` schema and the error code `grant_invalid` (401): one code for every way a grant can
  fail — bad signature, wrong `typ`, unknown `kid`, wrong audience, wrong issuer, expired, or past
  `turn_exp` — because a caller's only move on any of them is to get a new grant. The `message` does
  name the failed check, for whoever is debugging a verifier; the route is behind the shared bearer.
- Both routes are **unmounted unless `MOCA_GRANT_SIGNING_KEY` is set**, and 404 before the body is
  read (ADR-0045's shape). A deployment that has not generated the grant ring behaves exactly as
  before. New configuration: `MOCA_GRANT_SIGNING_KEY`, `MOCA_GRANT_PUBLIC_KEYS`, `MOCA_GRANT_TTL_S`
  (300) and `MOCA_TURN_MAX_S` (1800), in
  [configuration.md](../reference/configuration.md#control-plane).
- The grants are signed by a **separate key ring** from session tokens, with header
  `typ: moca-grant+jwt`, so a session token can never pass as a grant even where an `aud` check is
  forgotten (§6.1). Note for any out-of-tree verifier: `aud: moca-sandbox` now names two different
  tokens — the sandbox grant and SBX0's sandbox access token — and only `typ` separates them. The
  cross-language vectors are at
  `packages/control-plane/test/fixtures/grant-vectors.json` (§12.2); they pin the verifier side and
  carry the public key only.

Interim, and named as such: **nothing redeems a grant yet.** The `moca-egress` inference listener and
§6.3's `/internal/token` are a later slice, so /internal/credentials and /internal/turn-credentials
both stay (§6.2's "replaces /internal/credentials" lands with the redeemer), workers never verify a
grant, and `MOCA_TENANCY=multi` still refuses async turns. There is no revocation list by design:
`MOCA_GRANT_TTL_S` is the revocation latency.

## 1.6.0

Sandbox modes ([lease-mode spec](../specs/2026-11-08-sbx-lease-mode-design.md) §8.1–§8.2), served
only on the `sandbox` route profile.

- `Sandbox` gains `mode` (`per-exec`, `lease` or `lease+processes`), `idleTimeoutS` (0 = the worker's
  default) and `modeEpoch`. A sandbox created `per-exec` starts at epoch 0, one created in a lease
  mode at 1.
- POST /v1/sandboxes accepts `mode` (default `per-exec`) and `idleTimeoutS` (30 to
  `SH_SANDBOX_IDLE_CEILING_S`, whose default is 1800; omitted, the worker's default of 300 s; an
  explicit 0 is 400 `invalid_request`).
- New PUT /v1/sandboxes/{id}/mode: changes the mode and the idle timeout, raises `modeEpoch` by 1 on
  every accepted call, audits `sandbox_mode_changed`, and returns the sandbox with a `setModeToken`
  for the client's `LeaseControl set_mode`.
- New POST /v1/sandboxes/{id}/mode-token: a `setModeToken` for the mode and epoch the record holds
  now, raising nothing.
- Both mode routes are owner only (an admin gets 404 on another user's sandbox) and take only the
  owner's user API token; a sandbox token is a 401. A set-mode token is a JWT with
  `typ: moca-sandbox-mode+jwt`, valid 300 s.
- New error code `mode_not_allowed` (403): a lease mode the deployment's `SH_SANDBOX_MODES_ALLOWED`
  (default `per-exec`, so no lease mode until an operator lists one) does not list. `per-exec` is
  always allowed.
- Sandbox tokens gain the claims `mode`, `mode_epoch` and `idle_timeout_s`. A token without them
  reads as `per-exec`, epoch 0.
- Narrowing the policy downgrades existing sandboxes at their next token mint. A sandbox token or
  `mode-token` minted for a sandbox whose lease mode `SH_SANDBOX_MODES_ALLOWED` no longer lists first
  sets it to `per-exec` at the next epoch, audited as `sandbox_mode_changed` with the reason
  `mode_not_allowed`. A lowered `SH_SANDBOX_IDLE_CEILING_S` clamps the `idle_timeout_s` claim; the
  stored `idleTimeoutS` and the epoch are unchanged.

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
- New GET /v1/quota: the caller's limits and use (`templates`, owned with a build registered or on
  its way there, a new build of one that holds no slot checked like a new id; `buildsQueued`,
  queued, building or probing; `active`; `owned`, template ids owned in any status, a failed or
  cancelled-only one included, 200 when the policy does not set it), and on the sandbox profile the
  live-sandbox cap (`sandboxes`). `owned` counts retired ids too, and a retired id is never served
  again, so it is in effect a lifetime cap per subject: a user who retires as they go reaches it in
  time, and only an admin raises it.
- New error codes `policy_refused` (422, with `rule`, the gating rule's id from
  `deploy/sbx/template-onboarding/governance/GATING-RULES.md`) and `template_exists` (409: ids are
  unique per deployment, the first creator owns one). `quota_exceeded` on a create names the quota
  (`quota`: `templates`, `buildsQueued` or `owned`). The `Error` schema adds `rule` and `quota`.
- `TemplateBuild` adds `handle` (the create's handle; equal to `buildId` for an imported build) and
  `reason` (why a build failed or was rejected), and GET /v1/templates/{id}/builds/{build} also
  finds a build by its handle.
- A refused create is recorded as a `check` provenance record only on an existing template's stream
  the caller may write; a refusal on an id no template holds writes one audit line instead
  (`template_create_refused`, with the subject, `templateId` and the failed `rules`).

Upgrade note (the policy fails closed):

- X12 applies under every profile, `base` included: a `skip_git_identity_check: true` that no gate
  record backs is refused (`422 policy_refused`, rule `X12`). A `base` client sends a gate record
  showing commits refused (X5: `agent_can_commit: "no"`, `git_identity: "none"`), or drops the skip:
  the build host's git identity check then needs git with an identity in the image, or no git at all
  once the build-snapshot change in [#757](https://github.com/rossoctl/moca/pull/757) is in.
- A stored policy (`<SH_PROVENANCE_DIR>/policy.json`) that names a rule id outside the ones the
  check acts on (X1, X10, X11, X12, X14, X15), or an `envelope.exact` that is not two positive whole
  numbers, is refused when it is read: every create and every read of the policy or the quota fails
  until an admin PUTs a valid policy, instead of the policy silently enforcing nothing. So read
  `GET /v1/policy` and fix it **before** upgrading: afterwards only `PUT /v1/policy` succeeds (the
  file itself stays readable on the volume).

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
  anything else is 400 `invalid_request`, refused before Redis is read. The response also carries
  the `envelope` the worker runs, with the turn's `sessionId` attached, so a claim is one round trip.
- New GET /metrics, admin-only: `counters.async_quota_refusals`, the count of submissions refused
  with 429 `async_quota_exhausted`. The control plane reports it because it is the side that refuses
  them — a worker never sees a submission that was never enqueued (§7). Process-local and reset by a
  restart; with more than one replica each request reports one replica's share.
- New error codes `turn_not_cancellable` (409, cancelling a turn that is not queued),
  `turn_not_claimable` (409, claiming a cancelled or terminal turn), `turn_not_found` (404),
  `async_quota_exhausted` (429, `MOCA_ASYNC_QUEUED_PER_OWNER` non-terminal turns already held),
  `async_tenancy_unsupported` (501, async under `MOCA_TENANCY=multi`) and
  `workload_runs_unavailable` (501, a submission naming a `workloadId`). Either 501 is answered
  before the quota is touched, so a request that can never be served is never reported as a 429 and
  leaves no record, no queue entry and no quota slot behind (§4.2).
- `async: true` on the harness's own turn route stays removed and still answers 400 `async_removed`;
  these routes are its replacement.

Upgrade note: `LEAF_RESULT_TTL_SECONDS` is now read by the harness tier through the control plane's
own strict parse, because both write the same result keys and a drained turn's result must outlive
nothing less than its record. A value that is not a positive integer refuses to BOOT there, where a
lenient `parseInt` used to read it as `NaN` and fail every result write instead. Surrounding
whitespace is trimmed, so an env file's trailing space or CRLF still boots; blank still means the
default (86400).

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
