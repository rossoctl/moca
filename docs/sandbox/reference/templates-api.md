---
sidebar_position: 2
---

# Template API

> **Preview.** The template routes of the control plane are implemented but not yet declared
> Stable; interfaces and limits may change. Known limits: [Limits](../concepts/limits.md).

The REST routes a client calls to create, follow, activate, change and retire templates, with
their error codes, policy rule ids and quotas. The full contract, every field and every status, is
[`openapi.yaml`](../../api/openapi.yaml); this page is the map. What the states mean is in
[Templates, builds and activation](../concepts/templates.md), and the terminal path is
[Make your own templates](../how-to/templates.md).

## Conventions

- **Authentication.** Every route takes an API token as `Authorization: Bearer <token>` (the
  `sessionToken` scheme in the contract). On the `sandbox` route profile the caller must be
  enrolled (`403 not_enrolled`); on the `harness` profile any logged-in subject may call the read
  routes. Every route also answers `401` without a valid token. Neither is repeated below.
- **Every route profile.** The template, policy and quota routes are served on the `sandbox`,
  `harness` and `combined` profiles alike. Of the two create routes under "Use", the
  sandbox create is the `sandbox` profile's and the session create the `harness` profile's;
  `combined` serves both.
- **The template store.** The five `GET /v1/templates…` read routes work on any deployment:
  without a template store they list the templates the deployment declares
  (`SH_SANDBOX_TEMPLATES`). Every other route here, `GET /v1/policy` and `GET /v1/quota`
  included, needs the store (`SH_PROVENANCE_DIR`) and answers `400 invalid_request` without it.
- **Errors** are JSON, `{error, message?, …}`, with a stable `error` code (table below). A refusal
  that may clear by itself carries `Retry-After`. Another subject's `private` template answers
  `404 template_not_found`, as an unknown id does.
- **Who.** _Client_: an enrolled subject (any logged-in subject on the harness profile). _Owner_:
  the template's owner. _Admin_: a subject with the admin role, who may act on any template.

## Reads

| Method | Path                                | Who    | What it does                                                                               | `mocactl sbx`         |
| ------ | ----------------------------------- | ------ | ------------------------------------------------------------------------------------------ | --------------------- |
| GET    | `/v1/templates`                     | client | the templates you can see, with their builds and readiness, and each host's limits and use | `templates`, `hosts`  |
| GET    | `/v1/templates/{id}`                | client | one template; each build with its spec, the seed included                                  | `templates show ID`   |
| GET    | `/v1/templates/{id}/builds`         | client | its builds, newest first                                                                   | `templates show ID`   |
| GET    | `/v1/templates/{id}/builds/{build}` | client | one build, by its build id (URL-encoded) or by the `b-<26 hex>` handle its create answered | `templates follow ID` |
| GET    | `/v1/templates/{id}/tags`           | client | its tags, each with its build and who set it when                                          |                       |
| GET    | `/v1/policy`                        | client | the policy (profiles, registries, trusted gate records, quotas), its `digest` and `record` | `policy`              |
| GET    | `/v1/quota`                         | client | your template quotas and use, where each comes from, and your live-sandbox cap             | `quota`               |

The `hosts` list in `GET /v1/templates` is empty until a host agent reports, which never means
"no limit". Poll a build's `status` to follow it, and its `readiness` before a use.

## Create and builds

| Method | Path                                       | Who                            | What it does                                                                          | `mocactl sbx`                   |
| ------ | ------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------- |
| POST   | `/v1/templates`                            | client                         | create a template, or a new build of your own; `202` queued                           | `templates create --spec F`     |
| POST   | `/v1/templates/{id}/builds`                | owner (an admin: any template) | a new build of an existing template; otherwise as the create, the body's `id` ignored | `templates build ID --spec F`   |
| POST   | `/v1/templates/{id}/builds/{build}/cancel` | owner, admin                   | withdraw a `queued`, `building` or `probing` build: it becomes `failed`               | `templates cancel ID --build B` |

- **The body** is `{id, image, spec, profile?, gateRecord?, visibility?}`. `image` is
  `[host[:port]/]path@sha256:<64 hex>` (lowercase path, no tag beside the digest). `spec` is a
  `moca-sbx-template-spec/1` document; its guest size is `guest_ram_mb` or its alias `guest_mb`,
  never both, and an `id` or `image` inside it must equal the create's. `gateRecord` is the gate
  record file, byte for byte. The whole body is at most 1 MiB. `visibility` defaults to
  `deployment`, except on a self-attested create (a profile with `selfAttest` and a gate record
  the policy does not trust): that one is stored `private`, and an explicit `deployment` is refused
  `409 self_attested`.
- **The answer** is `202 {templateId, buildId: null, build, status: queued}`; follow `build`, the
  handle. A policy refusal is `422 policy_refused` with `rule`, and nothing is queued.
- **Reuse.** The same image, spec, profile and gate record as a build of your own template that
  is registered or on its way answers that build with `reused: true` (`200` when registered,
  `202` before), and queues nothing. A failed or rejected build is never reused. With host
  agents, a registered build is not reused when fresh hosts report and none of them holds its
  snapshot: the create then queues a rebuild, which supersedes the old build when it registers.
- **A full queue.** On `429 quota_exceeded` with `quota: buildsQueued`, wait for a build to finish
  and send the same create again; `mocactl sbx templates create` does that by itself, up to its
  `--timeout`.

## Lifecycle changes

| Method | Path                                       | Who          | What it does                                                                                     | `mocactl sbx`                       |
| ------ | ------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| POST   | `/v1/templates/{id}/tags`                  | owner, admin | move 1 to 16 tags onto a registered build (`{tags, build}`)                                      | `templates tag ID TAG... --build B` |
| DELETE | `/v1/templates/{id}/tags/{tag}`            | owner, admin | remove a tag; its build stays. `default` is moved, never removed (`400`)                         | `templates untag ID TAG`            |
| PATCH  | `/v1/templates/{id}`                       | owner, admin | change `visibility` (`private` or `deployment`) or `description` (at most 1024 characters)       | `templates edit ID`                 |
| PUT    | `/v1/templates/{id}/owner`                 | admin        | hand the template to another enrolled subject (`{owner}`: `github:<id>` or `oidc:<sub>`)         | `templates transfer ID SUBJECT`     |
| POST   | `/v1/templates/{id}/retire`                | owner, admin | retire every build (`{reason?}`, at most 1024 characters)                                        | `templates retire ID`               |
| DELETE | `/v1/templates/{id}/builds/{build}`        | owner, admin | retire one build; the others stay                                                                | `templates retire ID --build B`     |
| POST   | `/v1/templates/{id}/builds/{build}/reject` | admin        | reject a registered build after the fact (`{reason}`, 1 to 1024 characters); it cannot be undone | none: call the route                |

- Each change writes a provenance record naming who made it and the value before. A change that
  changes nothing (a tag already on the build, a transfer to the current owner) answers
  `record: null`.
- A retire or a reject is refused `409 build_in_use` while a live sandbox runs on the build or an
  active session is pinned to it. Both are idempotent, and neither can be undone: a new build is
  the way back. A retired build's leases go, and the hosts holding it are told to stop its worker
  and then remove it.
- `deployment` visibility, and a transfer, are refused `409 self_attested` for a template with a
  self-attested build until an admin trusts its gate record.

## Activation

| Method | Path                            | Who                             | What it does                                                                          | `mocactl sbx`                    |
| ------ | ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| POST   | `/v1/templates/{id}/activate`   | anyone who can see the template | take or renew your lease on a registered build (`{tag?, build?, leaseSeconds?}`)      | `templates activate ID [--wait]` |
| POST   | `/v1/templates/{id}/deactivate` | lease holder; admin with `all`  | release your leases (`{stopNow?}`); an admin's `{all: true}` releases every subject's | `templates deactivate ID`        |

- **The lease** is 60 to 86400 s (`leaseSeconds`). Without it, it is the largest
  `idleLimitSeconds` of the hosts that hold the build, clamped to that range, else 3600 s.
  Activate again to renew it, without limit; a renewal does not count against your `active`
  quota again.
- **The answer** is `200 {templateId, buildId, leaseUntil, host}`; `host` is null while no host
  agent has reported.
- **Refusals keep no lease:** `409 template_unavailable` (no registered build under that
  reference, no reporting host holds it, or `reason: memfile_mismatch`), `409 no_active_slot` with
  `Retry-After` (`reason: memory` when memory, not slots, is short), `410 template_retired`, or
  `429 quota_exceeded` with `quota: active`. A template the deployment declares in
  `SH_SANDBOX_TEMPLATES` takes no lease (`400 invalid_request`).
- **`stopNow: true`** skips the host's idle grace once no lease is left.

## Use: sandboxes and sessions

| Method | Path            | Who                                | Template fields                                                     |
| ------ | --------------- | ---------------------------------- | ------------------------------------------------------------------- |
| POST   | `/v1/sandboxes` | enrolled subject (sandbox service) | `{template, activate?}`; `template` is `ID`, `ID:TAG` or `ID@BUILD` |
| POST   | `/v1/sessions`  | logged-in subject                  | `{sandbox: {template, activate?}}`, with the same reference forms   |

- On a build that is not active, the create takes your lease and answers
  `409 template_not_active` with `readiness` and `Retry-After`: retry the same create after the
  wait. `activate: false` is refused the same way without starting anything. `Retry-After` is
  30 s, or the build's place in its host's start line when the host reports its start limit and a
  measured start time.
- The rest of a sandbox create is unrelated to templates: its `name`, `labels`, lease `mode` and
  `idleTimeoutS`, and its idle lifetime `idleLifetimeS` (at least 3600 s, at most the
  deployment's maximum; `mocactl sbx create --lifetime`). See
  [Call the sandbox API from your own code](../how-to/direct-api.md).

The host agents' routes (`/v1/hosts/{host}/…`) take each host's own bearer, never a user token;
operators find them in [the runbook](../../operate/sandbox-service/runbook.md#the-template-host-agent).

## Error codes

| HTTP | Code                   | When                                                                                                                                                                                                                         | What to do                                       |
| ---- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 400  | `invalid_request`      | a malformed body or field; a route that needs the template store on a deployment without one; a cancel of a build not `queued`, `building` or `probing`; removing `default`; a tag moved onto a build that is not registered | fix the request; the message names the field     |
| 400  | `unknown_template`     | a sandbox or session names an unknown id, tag or build, one you cannot see, or a build that is not registered (a rejected one included)                                                                                      | check `mocactl sbx templates`                    |
| 403  | `not_enrolled`         | the caller is not enrolled for sandboxes                                                                                                                                                                                     | ask your operator to enroll you                  |
| 403  | `forbidden`            | not the template's owner or an admin, or an admin-only route; a widening policy write by an admin not named in the settings                                                                                                  |                                                  |
| 403  | `mode_not_allowed`     | a sandbox create or mode change asks for a lease mode the deployment does not allow                                                                                                                                          | use `per-exec`                                   |
| 404  | `template_not_found`   | an unknown template or build, or another subject's `private` template                                                                                                                                                        | check the id                                     |
| 409  | `template_exists`      | the id is another subject's                                                                                                                                                                                                  | pick another id                                  |
| 409  | `self_attested`        | `deployment` visibility or a transfer for a template with a self-attested build, or a self-attested build added to a deployment-visible template                                                                             | keep it private until an admin trusts the record |
| 409  | `template_not_active`  | a use on a build that is not active; its activation has started unless `activate: false`                                                                                                                                     | retry the same call after `Retry-After`          |
| 409  | `no_active_slot`       | every host holding the build is at its active limit with leased builds, or (`reason: memory`) has no memory for its worker                                                                                                   | retry after `Retry-After`                        |
| 409  | `template_unavailable` | no registered build under that reference, no host holds it, or (`reason: memfile_mismatch`) every holder reports its memory file wrong                                                                                       | tell your operator; a rebuild clears a mismatch  |
| 409  | `build_in_use`         | a retire or reject while a live sandbox runs on the build or an active session is pinned to it                                                                                                                               | delete those sandboxes or sessions first         |
| 409  | `quota_changed`        | a `PUT /v1/quota/{subject}` whose `?expect=` is no longer the quota                                                                                                                                                          | read again, then write                           |
| 409  | `policy_changed`       | a `PUT /v1/policy` whose `?expect=` is no longer the policy's digest; the body's `digest` is the current one                                                                                                                 | read again, redo the change, then write          |
| 410  | `template_retired`     | a sandbox create, session create or activation through a retired build, tag or template                                                                                                                                      | choose a live build, or move the tag             |
| 422  | `policy_refused`       | a create failed a policy rule; `rule` names it (below)                                                                                                                                                                       | fix what the rule names                          |
| 429  | `quota_exceeded`       | a template quota (`quota` names it: `templates`, `buildsQueued`, `owned`, `active`), or the live-sandbox cap (no `quota` field)                                                                                              | free one, or ask an admin                        |

The complete list of the control plane's codes is the `Error` schema in
[`openapi.yaml`](../../api/openapi.yaml).

## Policy rule ids

A `422 policy_refused` names the first rule the create failed in `rule`. `mocactl sbx templates
create --dry-run` runs the checks that need only the inputs; whether a gate record is trusted, the
registry is allowed and the quotas, only the server decides. What the `M` and `X` rules require of
an image is in
[the gating rules](../../../deploy/sbx/template-onboarding/governance/GATING-RULES.md).

| Rule                                                                        | Checks                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `profile`                                                                   | the profile named (or the policy's default) exists                                                                 |
| `M1`                                                                        | the image is pinned by digest, `[host[:port]/]path@sha256:<64 hex>`                                                |
| `registry`                                                                  | the image's registry is in `allowedRegistries` (compared case-insensitively)                                       |
| `registry.repository`                                                       | the image's repository is in that registry's `allowedRepositories`, when the policy lists any                      |
| `M7.id`                                                                     | the template id is well formed                                                                                     |
| `M7.guest`, `M7.vcpus`, `M7.workspace`                                      | guest at least 128 MiB, under one key only; 1 to 32 vCPUs; workspace at least 256 MiB                              |
| `M7.home`, `M7.egress`, `M7.seed`, `M7.probe`, `M7.tools`, `M7.description` | `guest_home` under `/tmp`; `egress` a boolean; `seed` a string; a well-formed probe; distinct tools; a description |
| `M7.skip_git_identity_check`, `M7.guest_home_gitconfig`                     | booleans when present                                                                                              |
| `M7.spec_id`, `M7.spec_image`                                               | an `id` or `image` in the spec equals the create's                                                                 |
| `M8`                                                                        | `guest_home_gitconfig` only with `guest_home`, and never with `skip_git_identity_check`                            |
| `M9`                                                                        | the probe's expected result was measured (`probe_status` not `unmeasured` or `none`)                               |
| `envelope`                                                                  | guest, vCPUs and workspace within the profile's envelope                                                           |
| `gate.json`                                                                 | the gate record is a JSON object                                                                                   |
| `X1`, `X1.trusted`, `X1.image`                                              | the gate passed; its sha256 is trusted (or self-attested on a `selfAttest` profile); it is for this image          |
| `X1.offline`                                                                | the gate's test floor was checked offline, where the profile requires it                                           |
| `X1.self.scope`, `X1.self.egress`, `X12.self`                               | a self-attested record: claimed by one subject only; egress only where the profile allows; commits refused         |
| `X10`, `X10.record`                                                         | the spec's `source_record_digest` is the image's digest, and the gate record it names is sent                      |
| `X11`                                                                       | `egress: false`, on a profile that requires it                                                                     |
| `X12`                                                                       | `skip_git_identity_check` only with a gate record showing commits refused, under every profile                     |
| `X14`                                                                       | `probe_status` is `vm` or `emulation`                                                                              |
| `X15`                                                                       | the exact guest size and vCPUs, where the profile sets them                                                        |

A build refused later, at registration, is `rejected` with `reason.rule` naming a field of its
template record or snapshot manifest (`T.…`, `S.…`; `T.unique` when another build already has
that snapshot). A failed build's reason leads with a code
([the runbook](../../operate/sandbox-service/runbook.md#the-template-host-agent) lists them).

## Quotas

| Quota          | Default | Counts                                                                     | Checked on                                        | Refusal                                     |
| -------------- | ------- | -------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| `templates`    | 100     | templates you own with a build registered or on its way there              | a create of a template that holds no such build   | `429 quota_exceeded`, `quota: templates`    |
| `buildsQueued` | 10      | builds of your templates not yet built (`queued`, `building` or `probing`) | a create or new build that queues one             | `429 quota_exceeded`, `quota: buildsQueued` |
| `active`       | 8       | builds you hold a live activation lease on                                 | an activation, and a first use that takes a lease | `429 quota_exceeded`, `quota: active`       |
| `owned`        | 200     | template ids you own in any status, failed and retired ones included       | a create of a new id                              | `429 quota_exceeded`, `quota: owned`        |

- The defaults are the default policy's; your deployment's may differ, and an admin may set
  yours apart (`mocactl sbx templates quota`). `mocactl sbx quota` (`GET /v1/quota`) shows the
  limits that apply to you, your use, and whether each comes from the default or your own
  override (`quotaSource`, `ownedSource`).
- `owned` is a lifetime cap: a template whose builds all failed or were retired stops counting
  against `templates`, but still counts against `owned`.
- The live-sandbox cap (3 per subject by default, and a total for the service) is not a template
  quota, but `GET /v1/quota` shows it as `sandboxes` on the sandbox service
  ([Limits](../concepts/limits.md)).

Setting quotas and the policy is an admin's job:
[Self-serve templates and the policy](../../operate/sandbox-service/runbook.md#5-adding-updating-and-removing-a-template)
in the runbook.
