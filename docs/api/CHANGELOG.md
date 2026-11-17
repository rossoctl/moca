# API changelog

The version is `info.version` in [openapi.yaml](openapi.yaml) for the control plane and in
[harness-openapi.yaml](harness-openapi.yaml) for the data plane: the minor is bumped for additive
changes, the major only with a `/v2` ([change policy](../reference/change-policy.md), decision 5).
Each section below is a control-plane version. A data-plane version is described in the section
that shipped it ("The data plane's twin … goes to"):

| `harness-openapi.yaml` | Shipped with                   |
| ---------------------- | ------------------------------ |
| 1.5.0                  | [1.28.0](#1280)                |
| 1.4.0                  | [1.26.0](#1260)                |
| 1.3.0                  | [1.17.0](#1170)                |
| 1.2.0                  | [1.16.0](#1160)                |
| 1.1.0                  | [1.15.0](#1150)                |
| 1.0.0                  | the first document, 2026-10-09 |

## 1.29.0

A per-source bound on login starts ([#716](https://github.com/rossoctl/moca/issues/716)).
Additive.

- `POST /v1/auth/device` now documents its `429 quota_exceeded`, which the oidc provider has
  answered since it shipped (the 10,000-state total cap) and which now has a second cause: one
  client address holding `SH_OIDC_MAX_PENDING_PER_SOURCE` (default 20) live login states. The
  message tells the two apart ("...from this address"); the code and the status are the same. The
  address is the socket peer, or the X-Forwarded-For entry `SH_TRUSTED_PROXY_HOPS` names (the
  socket peer when the header holds fewer entries than that). The GitHub provider is unchanged.
- For a deployment with its own `PendingAuthStore` (the control plane's extension point for a
  shared pending-login store): `put` now answers which bound refused the entry (`'parked'`,
  `'full'` or `'source_full'`) instead of a boolean. A store still answering the boolean keeps
  working: `true` reads as parked and `false` as the total cap's refusal. To enforce the
  per-source bound, a store answers `'source_full'`.

## 1.28.0

A config bundle's format version, checked where a bundle is stored and where it is applied
([#510](https://github.com/rossoctl/moca/issues/510)), per the
[change policy](../reference/change-policy.md#version-markers) (decision 7). Additive on the wire.

- POST /v1/config-bundles refuses a bundle whose `format.json` names a format newer than this
  release reads, or is not a format version, with `400 invalid_request` and the reason in
  `message`. A bundle without `format.json` is format 1, so every bundle stored before it existed
  keeps its digest and stays usable.

The data plane's twin, [harness-openapi.yaml](harness-openapi.yaml), goes to 1.5.0: POST /v1/turn
answers `422 config_bundle_unsupported` when the session's bundle is stored and intact but in a
format the harness does not read, with the reason and what to upgrade in `message`, on the sync
path and before the first SSE frame alike; after it, the terminal `error` frame carries the same
reason.

## 1.27.0

The base URL says what it is ([#779](https://github.com/rossoctl/moca/issues/779)). Additive on the
wire.

- `GET /` answers `200` with a short `text/plain` page on every profile: that this is a Moca control
  plane, where its API is (`/v1`, and `GET /v1/discovery`), how to install `mocactl` and log in, and
  that a sandbox's egress is an allowlist the operator extends. Before, it was the unknown-path
  `404 not_found`. The page names no URL of the deployment and echoes nothing of the request. Its
  wording is not a contract: a client reads `/v1/discovery`.

## 1.26.0

Per-turn artifacts and a bounded status read
([#390](https://github.com/rossoctl/moca/issues/390)), per the
[async fan-out spec](../specs/2026-11-05-p6-async-fan-out-design.md) §4.4 and §9.2. The data plane's
twin goes to **1.4.0** with it. One **narrowing** on the wire, deliberate and named below — allowed
because `/v1` is Preview ([maturity](../reference/maturity-and-lifecycle.md)), and recorded here
because that is what Preview requires.

- `GET /v1/sessions/{id}/turns/{turnId}` no longer inlines the turn's OUTPUT. `result.patch` and
  `result.text` are **removed** from that body: the route is polled, and a 4 MiB patch rode every
  poll. In their place, additively: `result.summary` (one line — the assistant's text, a gate's
  summary, the patch's diffstat or the failure's reason — clipped to `MOCA_TURN_SUMMARY_BYTES`,
  default 2048 bytes), `result.artifacts` (`[{kind, bytes, sha256?}]`) and `result.workspace` on a
  solve result as well as a `responded` one. The synchronous `POST /v1/runs` and `GET /runs/status`
  bodies are untouched — they still carry `patch` and `text` in full.
- The same cap now holds every **model-written** string in that body, not just `summary`:
  `result.verdict.reason` and `result.gate.summary`/`proposed_action` are clipped to
  `MOCA_TURN_SUMMARY_BYTES` with the same trailing `…[truncated]`. Nothing upstream caps them, so
  unclipped they kept a `done` turn's polled body unbounded. The cap bounds each string's CONTENT,
  so a clipped one is `MOCA_TURN_SUMMARY_BYTES` plus that 14-byte marker. `MOCA_TURN_SUMMARY_BYTES=0`
  omits all four keys rather than returning a bare marker; `verdict` and `gate` keep their shaped
  fields (`item_id`, `verdict`, `gateId`), so a client can still branch on them.
- `GET /v1/sessions/{id}/turns/{turnId}/artifacts/{kind}` serves the output whole: bytes, with
  `text/x-diff` and an `ETag` — always `"sha256:<hex>"`, the one format
  `result.artifacts[].sha256` uses: the capture's own digest when the record carries one, else a
  digest of the bytes served. `If-None-Match` is not honoured, so the ETag is for comparison, not
  for skipping a fetch. `patch` is the only kind. Every absence is 404 (unknown kind, a turn
  not yet terminal, no stored result, a capture refused for size).
- The data plane's `TurnWorkspace` gains `diffstat` (`{files, insertions, deletions}`), counted from
  the diff's hunks and present even when `patchRefused` left the bytes behind; `LeafResult`'s
  `solved` branch gains `workspace`, the descriptor (`baseline`, `patchSha256`, `patchBytes`,
  `diffstat`) for the patch in `patch`. `RunStatus`'s `solved` branch is unchanged.
- Async results and turn records are kept for **7 days** by default, up from 24 h
  (`LEAF_RESULT_TTL_SECONDS` `604800`), so a Friday turn is still readable on Monday. Not a wire
  change; it is what makes the two routes above worth polling.

## 1.25.0

A sandbox's lifetime counts idle time ([#770](https://github.com/rossoctl/moca/issues/770)), per the
[idle-lifetime design](../specs/2026-11-16-sbx-idle-lifetime-design.md) §3 and §4.2. Additive on the
wire.

- POST /v1/sandboxes takes `idleLifetimeS` (integer, 3600 to the deployment's maximum; omitted is
  the default lifetime), and every `Sandbox` carries it.
- Activity mints slide `expiresAt`: POST /v1/sandboxes/{id}/token, POST
  /v1/sandboxes/{id}/mode-token and PUT /v1/sandboxes/{id}/mode move it to at least now plus the
  sandbox's `idleLifetimeS` (clamped to the maximum as it is now), never backwards. Reads and lists
  do not. The move applies only when SH_SANDBOX_MAX_LIFETIME_SECONDS is configured; unset, the
  deadline stays fixed at creation as before.
- POST /v1/sandboxes/{id}/token and /mode-token accept an optional body `{ "activity": false }`: a
  mint that runs no command (a lease keepalive) leaves the deadline where it is. A non-boolean
  `activity` is `400 invalid_request`; body validation precedes state, so that answer also holds
  on a terminated sandbox (not `409 sandbox_terminated`).
- POST /v1/sandboxes/{id}/token returns `sandboxExpiresAt`, the sandbox's `expiresAt` after the
  mint; it moves, so track it. The token's `exp` is capped at it.
- PUT /v1/sandboxes/{id}/mode refuses a body naming `activity` (`400 invalid_request`): a mode
  change always counts as activity.
- Stored data: the record hash gains `idleLifetimeS`, and a touch rewrites `expiresAt`, the `live`
  score and the TTLs. An older control plane reads the moved `expiresAt` correctly and ignores the
  field.

## 1.24.0

Grants at dequeue under `MOCA_TENANCY=multi`
([#388](https://github.com/rossoctl/moca/issues/388)), per the
[multi-user isolation design](../specs/2026-09-28-moca-multi-user-isolation-design.md) §6.1 and the
[async fan-out spec](../specs/2026-11-05-p6-async-fan-out-design.md) §5.4. Additive on the wire; the
one removal is an error code no caller can receive any more.

- POST /internal/turn-credentials returns MI1 §6.1 grants under `MOCA_TENANCY=multi`: `mode: grant`,
  the inference grant as `anthropicAuthToken`, the inference listener as `anthropicBaseUrl`, plus
  `sandboxGrant` and `turnExp` (unix seconds, anchored at the DEQUEUE and clamped to
  `min(caps.wallClock, MOCA_TURN_MAX_S)`). No credential value leaves the control plane under
  `multi`. Under `single` the response is unchanged, `direct` or `placeholder`.
- `async_tenancy_unsupported` (501) is **removed** from the error taxonomy: no caller can receive it
  any more, on any route. Async submission and the dequeue claim both work under `multi`. The
  refusal did not disappear, it changed shape — a `multi` deployment without
  `MOCA_GRANT_SIGNING_KEY` and `MOCA_INFERENCE_ADDR` refuses to BOOT, so an operator meets it once
  at startup instead of per turn.
- The control plane listens on a SECOND port when `MOCA_INFERENCE_ADDR` is set: a transparent
  inference proxy that accepts an inference grant as its bearer and swaps it for the session's
  credential. Not part of the REST surface and deliberately not described in this document's paths —
  it forwards whatever the model API sends, unchanged.

## 1.23.0

A template create reuses a registered build only while a host holds its snapshot, and the
rebuild it admits otherwise supersedes the old build
([#816](https://github.com/rossoctl/moca/issues/816)), as the
[template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md) §4
(Reuse) and §6.1 ask. No route or error code changes, and one value is added (`reason.step:
superseded`); when a create is answered `reused: true` changes, and so does what a rebuild of the
same snapshot registers as.

- POST /v1/templates and POST /v1/templates/{id}/builds: on a deployment with host agents, a
  registered build with the same inputs is reused (`200`, `reused: true`) only while a fresh host
  (its last inventory at most HOST_STALE_S, 360 s, old, as placement counts hosts) holds its
  manifest hash. When fresh hosts report and none holds it, the create is admitted as a new build
  (`202`, no `reused`), the old build's rebuild, with the usual quota and gate checks, instead of
  an answer naming a build whose sandbox create is refused `409 template_unavailable`. When no
  fresh host reports at all (right after a control-plane restart, or the only host silent),
  holding is unknown and the registered build is reused as before. A build on its way (`queued` to
  `built`) is reused as before, and a deployment without host agents is unchanged.
- Registration: that rebuild has the old build's manifest hash. When the old build is still
  registered, the host that claimed the rebuild did not already hold the snapshot, and no fresh
  host holds the hash but the one reporting the rebuild (which has just built it), the rebuild
  registers and supersedes the old build in the same update: the old build becomes `retired` with
  `reason: {step: superseded}` and keeps its build id, its live leases move to the new build, and
  the tags that named it, `default` included, name the new build. A `retire` record by `policy`
  names both builds. Otherwise the rebuild is rejected, rule `T.unique`, as before: when another
  fresh host holds the hash, or when the claiming host already held it (it found the snapshot
  already built), the old build staying registered with its leases. Only that rebuild
  supersedes: any other build with the same hash (another profile or gate record) is rejected
  `T.unique`, as before, whoever holds the snapshot.
- GET /v1/templates/{id}/builds/{build}, DELETE /v1/templates/{id}/builds/{build}, POST
  /v1/templates/{id}/builds/{build}/reject, activate `{build}`, tags and `id@<build>`: a build id
  a superseded build shares names the build that took it over; the superseded build is found by
  its handle. A superseded build lists no tags.

## 1.22.0

A retire, or an admin's reject, is refused while an active Moca Pi session is pinned to the build
([#817](https://github.com/rossoctl/moca/issues/817)), per the
[template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md) §5.1
and §5.2. No route, field or error code is added; `409 build_in_use` gains a cause.

- POST /v1/templates/{id}/retire, DELETE /v1/templates/{id}/builds/{build} and
  POST /v1/templates/{id}/builds/{build}/reject: refused `409 build_in_use` ("is pinned by an
  active session") while an active session created with a sandbox template is pinned to the
  build, as while a live sandbox runs on it. Deleting the session lets the retire or reject
  through. Before, only live sandboxes counted, so a retire could stop the worker and remove the
  snapshot a pinned session's next turn needs.
- Stored data: a new sorted set per build, `sh:cp:build:<hash of the build id>:sessions`, of the
  sessions pinned to it: added at session create, removed by the delete cascade, and pruned of
  members that are no longer active as a retire or reject checks it. An older control plane
  ignores it. Sessions created before it existed are not in it, so they never block a retire.

## 1.21.0

Admins set template quotas per subject, and reject a registered build after the fact
([#748](https://github.com/rossoctl/moca/issues/748)), per the
[template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md) §5.2. Every
change is additive; the routes mount on both route profiles and need `SH_PROVENANCE_DIR` (else
`400 invalid_request`).

- New PUT /v1/quota/{subject} (admin): `subject` is `default` (the deployment default) or a subject,
  `github:<numeric id>` or `oidc:<provider sub>` (never `test:<n>`), for an override; the body is a
  Quota, or `null` to remove a subject's override (the default is never removed). Each change is a
  new `policy` record naming the admin. Answers `{target, subject, quota, before, policy, record}`:
  the quota now and before (null: no override), the new policy's digest and the record's. Enforced
  at once on creates, queued builds and activations. A quota holds `templates`, `buildsQueued` and
  `active`, and optionally `owned` (another key is `400 invalid_request`); a body without `owned`
  leaves the target's `owned` as it is. An optional `?expect=` (JSON: the quota the client read,
  `null` for no override) makes the write a compare-and-set on all four counters (an unset `owned`
  matches only an unset one): when the target's quota is not that value now, nothing is written and
  the answer is the new code `409 quota_changed`.
- Policy gains `quotaBySubject`, the per-subject overrides of `quota`, keyed by subject; a key that
  is not a subject, or a malformed quota, is `400 invalid_request`. An override's `owned` is
  optional: without it, the subject's `owned` is the default's (else 200).
- PUT /v1/policy gains an optional `?expect=`, the `digest` GET /v1/policy answered: the write is
  made only if the policy's digest is that value now, else nothing is written or recorded and the
  answer is the new code `409 policy_changed`, whose `digest` is the policy's now. So a policy
  written from an older read never drops a quota (or policy) another admin wrote since. An `expect`
  that is not `sha256:` and 64 lowercase hex digits is `400 invalid_request`. Without it, the
  policy is stored as sent, as before.
- GET /v1/quota answers the limits that apply to the caller (its override, else the default) and
  gains `quotaSource`, `subject` or `default`, and `ownedSource`, the same for `owned` alone (an
  override may leave `owned` to the default).
- New POST /v1/templates/{id}/builds/{build}/reject `{reason}` (admin; the reason is required): a
  registered build becomes `rejected` with `reason.rule` `admin`, its activation leases go, a host
  holding it finds it in the wanted state's `stop` (as a retired build, but never in `remove`: its
  worker is stopped, not removed, and no `removed` report is taken for it) and its `detached`
  report is taken, and a sandbox create naming it answers `400 unknown_template`. A `reject` record
  names the admin, `from`, the reason and `buildRecord` (the digest of the build's `build` record).
  Answers `{templateId, subject, build, buildId, record, status: rejected}`; idempotent
  (`record: null`). Refused `409 build_in_use` while a live sandbox runs on the build; any status
  but `registered` is `400 invalid_request`. Not reversible.
- A rejected build (by policy or by an admin) keeps no snapshot or worker for a retired build that
  shares it: the retired build is stopped and removed as any retired build is (no longer `shared`),
  while the rejected build itself is only stopped.

## 1.20.0

Enrollment and the admin role through the API
([#739](https://github.com/rossoctl/moca/issues/739)), per the
[enrollment and roles spec](../specs/2026-11-08-enrollment-and-roles-api-design.md). Every change is
additive; without `SH_PROVENANCE_DIR` nothing changes.

- New GET /v1/subjects (every enrolled subject with its roles, each with `source: env | api`),
  PUT and DELETE /v1/subjects/{subject} (enroll with `{"enrolled": true}`, unenroll), and PUT and
  DELETE /v1/subjects/{subject}/roles/admin (grant, with an optional `until` in epoch seconds, at
  most 366 days ahead; revoke), on both route profiles. Any admin reads the list; only an admin named in
  `SH_ADMIN_SUBJECTS` changes it (`403 forbidden` otherwise). The same holds for a PUT /v1/policy
  that widens the policy (a trusted gate record, a registry or a repository added; a profile added
  or loosened: a rule dropped from `requires`, `requireOfflineGate` off, `selfAttest` or
  `selfAttestEgress` on, an envelope bound raised or removed, its `exact` size changed or removed;
  or a `defaultProfile` that accepts more): an admin by an API grant may narrow it (a profile
  removed is a narrowing) and change its quotas. Each change answers the subject with
  the `record` it wrote (null when nothing changed). With no store the routes answer
  `400 invalid_request`. A `Subject` carries `storeEnrolled` (the store's own enrollment, apart from
  the settings and any role); enrolling a subject the settings enroll writes nothing
  (`record: null`).
- A subject on these routes is `github:<numeric id>` or `oidc:<provider sub>` (the sub pattern the
  OIDC login verifies); `test:<n>` and anything else is `400 invalid_request`. New `Subject` schema.
- New error codes `bootstrap_subject` (409: unenrolling or revoking a subject the settings enroll or
  make admin) and `self_revoke` (409: an admin revoking its own role).
- With a store, roles and enrollment are evaluated per request: the control plane replaces a
  verified token's `roles` with the subject's roles now, so a grant, a revoke or a lapsed `until`
  takes effect at the subject's next request. The login, the refresh and the egress owner check use
  the same evaluation. Without a store the token's claims stand, as before.
- Each change is a record on a new `members` provenance stream: `member {subject, enrolled, before}`
  and `role {subject, role, state: granted | revoked | expired, until, before}`, naming the acting
  admin (`control-plane` for an `expired`, written once). `verify-provenance.py` and `verifyExport`
  accept the two kinds on that stream only.

## 1.19.0

The host agent removes a retired build's worker and snapshot
([#743](https://github.com/rossoctl/moca/issues/743)), per the
[template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md) §6.1 step 7.
Every change is additive.

- GET /v1/hosts/{host}/wanted gains `remove`: the retired builds the host holds with no live sandbox
  and no pinned session's hold on their worker, each also in `stop`; while a sandbox that ended on
  the worker is still in `egressSids` (less than 600 s ago), it is in `stop` only, so its last
  egress events are still taken. The agent stops a running worker, then uninstalls it
  (`install-host.sh --uninstall --keep-shared`: its own files only), deletes the snapshot and its template record, and reports it. A
  worker with a live sandbox is in no list, nor is a retired build whose build id or worker a build
  that is not retired shares (in any template): its snapshot or worker is still needed.
- POST /v1/hosts/{host}/workers/report takes `removed` for a retired build the host holds: a `retire`
  record by `host:<id>` with `event: removed` and `buildRecord` (the digest of the build's `build`
  record). The host no longer holds the build, so TemplateBuild's `heldBy` drops it at once, before
  the host's next inventory. A `removed` for a build the wanted state leaves out because a build not
  retired shares it is refused `409 build_in_use`.

## 1.18.0

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

## 1.17.0

A session's seed from its build, its workspace's patch, its records, and its queued turns on its
template ([#751](https://github.com/rossoctl/moca/issues/751)), per the
[session templates spec](../specs/2026-10-30-session-sandbox-templates-design.md) §5-§5.2 and the
[template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md) §7.1.
Additive.

- POST /internal/credentials: for a session pinned to a manifest-hash build through the template
  store, `sandboxSeed` is that build's own `spec.seed` (none when the build has none), and
  `sandboxSeedSource` (`build` or `declared`) is sent with any seed.
- POST /internal/turn-credentials returns `sandboxTemplate`, `sandboxSeed`, `sandboxSeedSource` and
  `sandboxBuildId` as POST /internal/credentials does, so a queued turn of a templated session runs
  on its template's workers, pinned to its build, and seeded.
- GET /v1/sessions/{id}/turns/{turnId}: a `responded` result of a templated session carries
  `workspace` (the patch after the turn) and, with a seed, `seed` (`{source, buildId?}`).
- With a template store, a session whose template resolved through it writes a `session` record on
  `template/<id>` at creation (`state: created`, with its build, manifest hash and lease) and at
  delete (`state: terminated`, `reason: deleted`, `endedAt`).

The data plane's twin, [harness-openapi.yaml](harness-openapi.yaml), goes to 1.3.0: a templated
session's turn result (and its terminal `done` and `error` frames) carries `workspace`
(`TurnWorkspace`: the patch from the seed's baseline commit, whole or refused over
`SH_TURN_PATCH_MAX_BYTES`, never cut) and `sandbox.seed`; a `/v1/runs` prompt run of a templated
session runs on its template and its `responded` result carries both too.

## 1.16.0

Sessions and sandboxes from one combined control plane
([#750](https://github.com/rossoctl/moca/issues/750)), per the
[combined control plane spec](../specs/2026-11-05-combined-control-plane-design.md). Additive: the
`harness` and `sandbox` profiles answer as before.

- `SH_ROUTE_PROFILE=combined` mounts every route of both profiles. Its GET /v1/discovery answers
  `profile: "combined"` with the harness fields plus `execEndpoint` and `execCa`.
- On `combined` login is open, as on `harness`; the sandbox routes and the template writes need an
  enrolled subject (`403 not_enrolled` otherwise, test users included), and the template, policy and
  quota reads take any logged-in subject. Its API tokens carry the harness issuer.
- With a template store (`SH_PROVENANCE_DIR`), POST /v1/sessions resolves `sandbox.template` through
  it as POST /v1/sandboxes does: `id`, `id:tag` or `id@sha256:…`, else 400 `unknown_template`; the
  build is kept for the session's life. `sandbox.activate` (default true) and activation on first
  use apply: 409 `template_not_active` with Retry-After, or `no_active_slot`,
  `template_unavailable`. Only a subject enrolled for sandboxes starts an activation; on `combined`
  another subject waits (409) on one already starting and is refused (`403 not_enrolled`) on a
  template nobody is starting. The activation is the create's last check, so a create refused for
  another reason holds no lease.
- The `Session` view adds `sandboxBuildId` and `templateManifestHash` beside `sandboxTemplate`.
- POST /internal/credentials returns `sandboxBuildId` for a session pinned to a manifest-hash build.
  Each exchange of such a session (and of its queued turns) keeps that build's worker running for
  the hosts' idle limit from the turn, as a live sandbox does (GET /v1/hosts/{host}/wanted leaves it
  out of `stop`), when the session's subject is enrolled for sandboxes; it starts no worker and
  takes no lease. A turn of a subject not enrolled runs while the worker is up but extends nothing.

The data plane's twin, [harness-openapi.yaml](harness-openapi.yaml), goes to 1.2.0: a session pinned
to a build runs only on workers labelled `moca.dev/build` with it, and its turn is refused (503
`sandbox_unavailable`) when none is attached.

## 1.15.0

Sandbox templates for agent sessions
([#731](https://github.com/rossoctl/moca/issues/731)), per the
[session templates spec](../specs/2026-10-30-session-sandbox-templates-design.md). Additive: a
deployment that does not set `SH_SANDBOX_TEMPLATES` on the harness profile answers exactly as
before.

- POST /v1/sessions accepts `sandbox.template`, fixed for the session's life. A non-string is
  400 `invalid_request`; so is an id the deployment does not declare (the message lists the
  declared ids), and any template on a deployment that declares none.
- The `Session` view gains `sandboxTemplate` (null for none) on a deployment that declares
  templates, and for any session that named one.
- GET /v1/discovery gains `sandboxTemplates: [{id, description, tools}]`, the declared templates
  without their seeds; absent when none are declared.
- POST /internal/credentials returns `sandboxTemplate` and `sandboxSeed` for a session that named a
  template, and neither otherwise. A template the deployment no longer declares is still returned,
  without a seed, so its turns are refused rather than run on an untemplated worker.

The data plane's twin, [harness-openapi.yaml](harness-openapi.yaml), goes to 1.1.0: authenticated
turns take the session's template from the control plane, a failed seed is a 500, and
`workspace_reset`'s `retiered` also covers a sandbox that now serves another template.

## 1.14.0

Per-sandbox egress records ([#752](https://github.com/rossoctl/moca/issues/752)), per the
[egress records spec](../specs/2026-11-08-sandbox-egress-records-design.md): what a sandbox reached
through the KVM host's egress proxy, readable through the API and named in the sandbox's provenance.
Every change is additive.

- New GET /v1/sandboxes/{id}/egress?after=&limit= (the owner or an admin, as GET /v1/sandboxes/{id})
  gives `{events, next, summary}`. The events are the proxy's audit events exactly as it wrote them
  (new `EgressEvent` schema), in arrival order. `summary` (new `EgressSummary` schema) is
  `{byHost: {host: {count, decisions, bytesUp, bytesDown}}, total, dropped, droppedBy: {proxy, cap,
budget, invalid}, complete, sealed, sha256}`, on the first page (no `after`); null on the pages
  after it.
- `?format=ndjson` gives the whole log as `application/x-ndjson`: each event's canonical JSON, each
  followed by `\n`. Its sha256 is `summary.sha256`.
- New POST /v1/hosts/{host}/egress `{events, cursor, oversized?}` (host bearer): the host agent's
  batches of up to 1000 events and its journal cursor, idempotent by (host, cursor), answering
  `{accepted, refused, capped, overBudget, invalid, dropped, cursor}`. A log holds at most 10,000
  events and 4 MiB of lines, and all logs together at most 64 MiB of lines; the rest count as
  dropped.
- GET /v1/hosts/{host}/wanted gains `egressSids`, the workspace keys whose events the host ships (the
  set the egress route accepts); the agent sends no other sandbox's or session's events.
- The `sandbox` provenance record that ends a sandbox (`state: terminated`) gains
  `egress: {events, sha256, dropped, droppedBy, complete}`. Events that arrive in the 600 s after the
  end are still taken; if any did, one more `sandbox` record with `state: egress` names the final
  log. No record kind is added.

## 1.13.0

Pacing template workers' cold starts ([#745](https://github.com/rossoctl/moca/issues/745)), per the
[template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md) §6.5: a
KVM host starts at most `SBX_START_CONCURRENCY` (default 4) workers at once, an activation waiting
for a start slot says so, and an optional idle grace (`SBX_IDLE_GRACE_S`, default 0, off) keeps a
released build's worker running for a while. The start limit is the host agent's, so it holds with
an older control plane too. Every change is additive.

- `GET /v1/hosts/{host}/wanted` gains `starting: [buildId]`: the builds of `run` whose worker is not
  attached to the relay (its presence, as readiness reads it), in `run`'s order. `run` is now in the
  wanted order, first leased first. Without `starting` (an older control plane, or the presence
  unreadable) the agent counts its own starts of the last `SBX_START_WINDOW_S` (default 300). With
  `starting`, a listed worker counts for `SBX_START_WINDOW_S` at most: one not attached after it is
  stuck (an error line each run) and holds no start slot.
- `POST /v1/hosts/{host}/inventory`'s `limits` take optional `startConcurrency`, `startSeconds` (the
  mean of the agent's last cold starts, start to attach) and `idleGraceSeconds` (0-86400). Without
  them (an older agent) nothing changes; an older control plane ignores them.
- A build `activating` on such a host gains `queued` and `queuePosition` (1-based, among its host's
  placed, wanted builds not attached yet, first leased first); `queued` is true beyond the host's
  `startConcurrency`.
- `409 template_not_active`'s Retry-After is `ceil(ceil(queuePosition / startConcurrency) ×
startSeconds)` when the host reports both; else 30 s, as before. A queued activation stays
  `activating` longer than before: a client polls with a timeout sized for the host's whole start
  line.
- A build whose worker already runs on a holder needs no start: it stays there (1.12.0's sticky
  placement), whether or not the host reports memory figures; a graced build leased again too.
- The idle grace runs from the build's last lease end (a release's time, or an expired lease's
  `until`), for a worker the agent reports running with no live sandbox, while the host has room
  under `activeLimit` beside the workers it counts (`active.used`: graced ones are counted apart)
  and its memory headroom (a graced worker counts as running there). A wanted
  build that needs the slot or the memory displaces the graced worker that ends soonest; the stop is
  re-checked for a lease, under the activation lock, when the wanted answer is made. The wanted
  answer gains `graced: [buildId]` for a host with a grace: the graced builds, kept in `run` after
  the wanted ones (the agent starts none of them).
- `POST /v1/templates/{id}/deactivate` takes an optional `stopNow: true`: with no lease left, the
  build skips the grace (stopped at the next poll); the `deactivate` record carries `stopNow: true`.
- Builds gain `graced: true` and `gracedUntil` (epoch seconds) while in a grace; a create on a
  graced build takes the caller's lease and is served at once.
- `GET /v1/templates`' hosts gain `start: {concurrency, seconds, starting, queued}`, only for a host
  whose agent reports it, and `idleGraceSeconds` and `graced` (a count) for a host whose agent sets
  a grace.

## 1.12.0

Placement of template workers by host memory ([#744](https://github.com/rossoctl/moca/issues/744)),
per the [template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md)
§6.2: a new worker starts on a host only if the host has the memory for it, whatever its
`activeLimit` says. Nothing running is evicted. Every change is additive.

- `POST /v1/hosts/{host}/inventory` takes an optional `memory: {memTotalMib, memAvailableMib,
memFloorMib, memPressureFull10, memPressureLimit, runningWorkers, vmCommittedMib, memfileMismatch}`.
  Without it (an older agent) the host is placed by `activeLimit` alone, as before; an older control
  plane ignores it.
- A build costs its guest RAM (`spec.guest_mb`) plus 128 MiB, or 4096 + 128 with no recorded guest size.
  A host's headroom is `min(total − floor − used, available − floor − pending starts)`, where `used`
  counts its running workers, their VMs' committed memory and the builds placed there not started yet.
  A host whose last inventory is older than 60 s, or whose PSI `full avg10` is above its limit, takes
  no new start. A build in a host's `memfileMismatch` is never placed there.
- `409 no_active_slot` gains `reason: memory` when a holder under its active limit lacks the memory
  (Retry-After unchanged); at the active limit it answers as before, with no `reason`.
  `409 template_unavailable` gains `reason: memfile_mismatch` when every holder reports the build's
  memory file wrong. `409 template_not_active` with readiness `unavailable` carries the reason too.
- Templates and builds gain `readinessReason` (`not_held | no_slot | memory | memfile_mismatch`),
  present only with readiness `unavailable`; new `ReadinessReason` schema.
- `GET /v1/templates`' hosts gain `memory: {totalMib, availableMib, floorMib, usedMib, headroomMib,
pressureFull10, pressureLimit, brake, runningWorkers, memfileMismatch, reportedAt}`, only for a
  host whose agent reports it; `floorMib` is the effective floor.

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
  `async_tenancy_unsupported` (501, async under `MOCA_TENANCY=multi`; removed in 1.24.0, see that
  section) and `workload_runs_unavailable` (501, a submission naming a `workloadId`). Either 501 is
  answered before the quota is touched, so a request that can never be served is never reported as a
  429 and leaves no record, no queue entry and no quota slot behind (§4.2).
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
