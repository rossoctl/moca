# Template lifecycle, readiness and provenance — Design

Version: 0.2 (draft for review) — November 2026
Status: Proposed. This file holds §1-§4, the template store and its read API (#736) and the
self-serve create (#737), §5.1-§5.2, the owner's and the admin's actions as built so far (#737,
#747) and retire (#749), §6.1, the host agent's builds (#741), §6.2-§6.4, activation (#742) and
placement by host memory (#744), §6.5, the pacing of cold starts (#745), §7, provenance (#730), and
§8, policy (#737); the rest of §5, and §9-§12 (tracing, validation, order of work, decisions) come
with the issues that build them, and keep their numbers so a reference to a section stays valid.
Builds on: [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md) (templates on the sandbox
profile, the host janitor).

## 1. Goal and scope

**Goal:** SWE-bench, and benchmarks like it, at scale on Moca templates: many per-instance templates
onboarded by their clients themselves, gated automatically, a bounded set of them **active** on a host
at a time, chosen by the workload through the Moca API, with every deployed image and template
traceable through persistent provenance that can be verified offline, hosted in the control plane.

**In scope:**

- templates **declared in the control plane's store**, not in a deploy-time list (§3.1);
- templates as names over immutable **builds**, with **tags** (§3.2);
- template **states** a client can read: onboarding and readiness (§3.3);
- the **read API**, on both route profiles (§4, §4.1);
- self-serve onboarding: a client creates a template from an image by digest, a build host builds and
  probes it, and the build is registered when it passes policy (§4, §8);
- activation by the client, within a per-subject quota and a per-host active limit, with aging and
  least-recently-used replacement, and activation on first use (§6);
- policy: Moca's side of the gating rules as machine checks, in profiles an admin chooses (§8);
- provenance: a chain of records from the image to every run, persistent in the control plane and
  verifiable offline (§7);
- tracing a run to its exact snapshot (§9).

**Out of scope here:** an authorization design beyond SBX0's (every enrolled subject is a client,
admins are `SH_ADMIN_SUBJECTS`); build steps in code (clients bring a finished image); a worker
serving several snapshots; multi-host scheduling and HA; signing images or an SBOM; the workload and
its scheduler (the benchmark runner's).

## 2. What exists, and what is missing

| Today                                                                                                           | Where                                                                 | Missing for the goal                                                           |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Templates are declared to the control plane as `SH_SANDBOX_TEMPLATES` (a JSON env list), changed by redeploying | `packages/control-plane/src/sandbox-config.ts`; `deploy/sbx/setup.sh` | no versions, no states; a change is a deploy: **declared in the store** (§3.1) |
| `GET /v1/templates` lists them, on the `sandbox` profile only                                                   | `packages/control-plane/src/routes.ts`                                | no readiness, capacity, owner or provenance; no read for a session's brain     |
| A sandbox names one; its id maps straight to one worker                                                         | `packages/control-plane/src/sandbox-handlers.ts` (`createSandbox`)    | a template with no worker fails only when it is used                           |
| One `microvm-worker` per template; it locks its snapshot's memory at start                                      | `remote-worker/cmd/microvm-worker`                                    | memory per attached worker, idle or not                                        |
| Workers are attached and detached by an operator on the host                                                    | `deploy/sbx/install-host.sh`                                          | nothing for the control plane to drive (§6)                                    |
| The host janitor already reads the control plane with its own bearer                                            | `sandbox-handlers.ts` (`janitorSandboxes`)                            | the pattern a host agent reuses (§6.1)                                         |

## 3. Templates, builds and states

### 3.1 Templates are declared in the store

Templates are **declared in the control plane's store**, not in `SH_SANDBOX_TEMPLATES`: creating,
retiring or changing one is an API call that writes a record (§7), never a redeploy. The env list is
read once, at the first start against an empty store, to import what a deployment declares today, and
is ignored after that (a warning names it if it is still set and differs).

**Built (#736):** the store is `FileTemplateCatalog` (`packages/control-plane/src/template-catalog.ts`),
one JSON document per template (`moca-template/1`) under `<SH_PROVENANCE_DIR>/catalog`, beside the
provenance store of §7.2, which opens with it. The import writes a provenance `create` record per
template (subject `deployment`) and imports each template with no owner (`owner: null`) until an
admin hands it over (§5.2). Unset, `MemoryTemplateCatalog` builds the same documents from the env
list at every start and nothing is recorded, as before the store. One control-plane process per
store directory.

### 3.2 Templates, builds and tags (adopted from E2B)

E2B's templates were reviewed (docs.e2b.dev, "Template tags & versioning", "Template names", the
templates API); adopted:

- **Self-serve** (§4, #737): any enrolled client creates a template and its builds through the
  API, as any E2B key holder does. Moca adds what E2B does not have: policy gating before
  registration (§8).
- **A build is an immutable artifact with an id.** A build is one snapshot; its id is the snapshot's
  manifest hash, `buildId` (`sha256:…`). A **template** is a name over its builds. The rule that a
  new image is a new snapshot and a new worker is unchanged: each is a new build of the same
  template. A template imported from the env list has one registered build, `imported:<12 hex>`: the
  list names no snapshot, so there is no manifest hash, and the id is a digest of the worker id
  (stable per worker), never the worker id itself, which clients never see.
- **A build is reused when its inputs are the same** (#737): a create whose image digest, spec,
  profile and gate record match an existing build of the caller's template, registered or on its way
  there, returns that build, not a second snapshot (§4).
- **Tags are labels on builds, moved without rebuilding.** A template is referenced as `id[:tag]`,
  `default` when the tag is omitted; the template's owner moves tags between its registered builds
  (§5). Old builds stay addressable while their sandboxes drain. An imported template has the one
  tag `default`.
- **Pin by build id:** a sandbox may name `id@sha256:…` (or an imported build's `id@imported:…`)
  instead of a tag, and is then served by exactly that build or refused.
- **The build is an API resource** with a status (§4), as E2B's build status is.
- **Names:** Moca keeps its id rule, `^[a-z0-9][a-z0-9-]{0,30}$` (31 characters, the worker-id
  limit), lowercased on input and refused, never truncated, when longer; `GET /v1/templates/{id}`
  answering 404 is the existence check. A tag follows the same rule. **Ids are unique per
  deployment**: the first subject to create an id owns it; another's create of the same id is
  `409 template_exists` (E2B scopes names to a project; a Moca deployment is one project).
- **Visibility:** `private` (the owner and admins) or `deployment` (every enrolled client may use
  it). An imported template is `deployment`, and so is a created one unless its create says
  `private`, so per-instance benchmark templates are built once and shared.

Not adopted, by design: a builder chain of layers in code (clients bring a finished image, built
anywhere); capturing running processes (a clean guest per command); unlimited templates (a per-host
active limit); public templates across deployments.

**Built (#736):** a reference is resolved at sandbox creation to one registered build and its worker,
and kept for the sandbox's life (the sandbox record's `buildId`): a template whose worker changes
later serves new sandboxes from the new build, and earlier sandboxes keep theirs. An unknown id, tag
or build, or one the caller cannot see, is `400 unknown_template`, as an unknown id always was; a
retired one is `410 template_retired` (§5.1, #749).

### 3.3 The two states

A template's builds each have two independent states, both kept by the control plane.

**Onboarding** (how far the build is from usable), set by the build host's reports and by policy,
never by a person's approval:

| State        | Means                                                                     |
| ------------ | ------------------------------------------------------------------------- |
| `queued`     | created; admitted by the create-time checks (§8.1); waiting for a host    |
| `building`   | a build host took it: pull, rootfs, boot, in-guest checks, snapshot       |
| `probing`    | restored from the new snapshot; the seed and the probe running            |
| `built`      | snapshot and probe passed on a host; its build record is in               |
| `registered` | the control plane checked the build record against policy (§8.2); usable  |
| `rejected`   | refused by policy at registration, or rejected after the fact by an admin |
| `failed`     | the build or the probe failed, or the owner cancelled it                  |
| `retired`    | no new sandboxes or sessions; kept for provenance                         |

A template's own state is `registered` once any build is, else its newest build's, so a client polling
`GET /v1/templates/{id}` sees `queued → building → probing → built → registered` without knowing the
build id. An imported build is `registered` from the start; the other states come with self-serve
create (§4) and the host agent (§6.1).

**Readiness** (whether sandboxes can run on it now), for a `registered` build:

| State          | Means                                                                                | Built |
| -------------- | ------------------------------------------------------------------------------------ | ----- |
| `active`       | its worker is attached; sandboxes can run                                            | #736  |
| `inactive`     | registered, no worker attached                                                       | #736  |
| `unknown`      | the relay's presence could not be read: never a guess                                | #736  |
| `activating`   | the control plane asked a host to attach its worker; not yet attached                | #742  |
| `deactivating` | the control plane asked the host to detach it; live sandboxes drain                  | #742  |
| `unavailable`  | it cannot be activated: no host declares its snapshot, or the host refused, with why | #742  |
| `retired`      | the build is retired (§5.1): never served again                                      | #749  |

Readiness follows from facts, not from intent: `active` means the relay holds an attached record for
its worker (the same record the harness routes on, in the relay's presence hash `sh:sandbox:records`
in the same Redis), and the control plane derives it from that, with the capacity the worker
advertises, so the state cannot claim a worker that is not there.

## 4. The API: create, read, follow

**Create (built, #737; any enrolled client):**

```http
POST /v1/templates
{
  "id": "django-django-11133",
  "image": "<repository>@sha256:…",
  "spec": { "guest_ram_mb": 4096, "vcpus": 2, "workspace_mb": 2048, "egress": false,
            "tools": ["bash", "git", "python3", "rg"], "seed": "…",
            "probe": { "cmd": "…", "timeout_s": 900, "expect_rc": 0, "expect": ["…"] },
            "probe_status": "vm", "source_record_digest": "sha256:…",
            "skip_git_identity_check": true, "guest_home": "/tmp/home",
            "description": "…" },
  "gateRecord": "<the gate record file, byte for byte>",   // optional; required by benchmark (§8)
  "profile": "benchmark",           // a policy profile the deployment offers (§8); default its default
  "visibility": "deployment"
}
→ 202 { "templateId": "django-django-11133", "buildId": null,
        "build": "/v1/templates/django-django-11133/builds/b-…", "status": "queued" }
```

The spec is a template spec (`moca-sbx-template-spec/1`; the samples in
`deploy/sbx/template-onboarding/examples/` are a default sandbox image and a SWE-bench instance,
spec and gate record), with `workspace_mb`, the size of the sandbox's `/workspace` image, within the
profile's envelope. The guest size is `guest_ram_mb`, the key the build tool reads; its alias
`guest_mb` is accepted alone and stored as `guest_ram_mb`, and a spec with both is refused (M7), so
the policy and the build never read two different sizes. An `id` or `image` in the spec must equal the create's (M7, §8.1). The gate
record is sent as the file's own bytes, since its sha256 is what the policy trusts; it is stored with
the provenance records (§7.2) and checked (§8). `POST /v1/templates/{id}/builds` starts a new build
of an existing template of the caller's (a new image or spec); same body, same answer. A build has a
provisional handle (`b-<26 hex>`) until it is built; then its `buildId` is its manifest hash, and
the handle still finds it.

The create is checked against the deployment's policy before anything is queued (§8.1): a refusal
is `422 policy_refused {rule, message}` and a `check` record (written only on the stream of a
template that exists and whose stream the caller may write: its own, or as an admin adding a build;
a refusal on another subject's id is only answered, and one on an id no template holds writes one
line to the capped audit log instead, naming the subject, the id and the failed rules, so no subject
opens provenance streams without bound), and nothing is queued. Over a quota
(§6.2: templates owned with a build registered or on its way there, so one whose builds all failed
or were cancelled holds no slot, and takes one again, checked like a new id, when it gets a new
build; builds queued, building or probing at once, charged to the
template's owner even when an admin adds the build; template ids owned in any status, checked for a
new id only, so a create-then-cancel loop cannot open documents and provenance streams without
bound; retired ids count too, and a retired id is spent, so this is in effect a lifetime cap per
subject that only an admin raises) is `429 quota_exceeded` naming which
(`quota`); the quota is read and the build written under one lock per subject, so concurrent creates
for different ids never pass one check together. Another subject's id is `409 template_exists` (`404 template_not_found` when that
template is private: no existence oracle). An admitted create writes `create`, `gate` (with a gate
record) and `check` records (§7.1) and queues the build for a host agent (§6.1).

**Reuse.** A create that matches a build already registered answers
`200 {buildId, status: "registered", reused: true}`; one that matches a build still on its way
(queued to built) answers `202` with that build and `reused: true`, and queues nothing. The match is
the image, the spec as sent, the profile and the gate record's sha256 on the caller's own template;
the builder (Moca commit, kernel) is not compared (one deployment's hosts build with one builder),
and a failed or rejected build is never reused. With host agents (§6.1), a registered build is to be
reused only while a host reports holding its snapshot.

**Cancel** (built, #737): `POST /v1/templates/{id}/builds/{build}/cancel`, by the owner or an
admin, withdraws a `queued`, `building` or `probing` build: it becomes `failed` with
`reason {message, step: "cancelled"}`, and a `build` record names who cancelled it.

**Reads (built, #736; any enrolled client, `private` templates only to their owner and admins).**
`GET /v1/templates` keeps its first fields (`id`, `description`, `tools`), so an older client reads
the list as before, and adds, per template, its owner, visibility, onboarding, readiness, tags and
builds:

```json
{
  "id": "django-django-11133",
  "owner": null,
  "visibility": "deployment",
  "description": "SWE-bench django__django-11133",
  "tools": ["bash", "git", "python3", "rg"],
  "onboarding": "registered",
  "readiness": "active",
  "tags": { "default": "imported:3c1f0a9b2e4d" },
  "builds": [
    {
      "buildId": "imported:3c1f0a9b2e4d",
      "status": "registered",
      "profile": "imported",
      "readiness": "active",
      "capacity": { "running": 3, "inUse": 1 },
      "lastUsedAt": 1798000000,
      "tags": ["default"],
      "createdAt": 1797990000,
      "provenance": "sha256:…"
    }
  ]
}
```

Each build carries **its own spec, seed included**, on the routes below (not in the list): a client
that runs the seed itself (SBX0's `sandbox` profile does not run it) reads the seed of the build it
was served (`GET /v1/templates/{id}/builds/{buildId}`), never the newest build's.

**Builds, as a resource (adopted from E2B's build status):**

| Route                                        | Returns                                                                           | Built   |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ------- |
| `GET /v1/templates/{id}`                     | one template, each build with its `spec`                                          | #736    |
| `GET /v1/templates/{id}/builds`              | the template's builds, newest first, each with its `spec`                         | #736    |
| `GET /v1/templates/{id}/builds/{build}`      | one build: `status` (§3.3), `readiness`, `capacity`, `lastUsedAt`, `tags`, `spec` | #736    |
| `GET /v1/templates/{id}/tags`                | each tag and the build it points to, with when it was assigned and by whom        | #736    |
| `GET /v1/templates/{id}/builds/{build}/logs` | the build host's log entries, paged                                               | planned |
| `GET /v1/quota`                              | the caller's quotas and use (§6.2); on the sandbox profile, live sandboxes        | #737    |
| `GET /v1/policy`                             | the deployment's policy profiles and the policy's digest (§8)                     | #737    |

plus a `hosts` block in `GET /v1/templates`, one entry per host with its limits and use (§6.2),
filled from the host agents' inventories (#742); empty means no host has reported, never that there
is no limit.
An unknown template or build, and a `private` template the caller does not own, answer
`404 template_not_found` (no existence oracle). Errors keep Moca's shape, `{error, message}` with a
stable code. `capacity.running` is what the worker advertises at once (its presence record's
capacity), not a formula in the control plane; `capacity.inUse` is its live sandboxes now, and
`lastUsedAt` the newest sandbox created on it, retained records included.

A sandbox names `id`, `id:tag` or `id@<build id>` (§3.2); the reference is resolved to one build at
creation, recorded on the sandbox (`buildId`, and `templateManifestHash`, null for an imported build),
and kept for its life. With template hosts (§6.4, #742), a create on a build that is not `active` is
refused `409 template_not_active` with `Retry-After`, and an activation is started for it.

### 4.1 Route profiles

Before this design `/v1/sessions` was on the `harness` route profile and `/v1/templates` and
`/v1/sandboxes` on the `sandbox` profile (`packages/control-plane/src/routes.ts`). **The template
routes of this design mount on both** (`BOTH`), so a Moca Pi brain (sessions, `harness`) and a stock
agent (sandboxes, `sandbox`) see the same templates, builds and readiness; the host-agent routes
(§6.1) mount on the profile whose deployment the hosts serve. On the `sandbox` profile the reads
need an enrolled subject or an admin (SBX0 §4.2); on `harness`, any logged-in subject. The
`harness` profile holds no sandbox records, so there `capacity.inUse` and `lastUsedAt` are null
(unknown), not zero.

## 5. The owner's and the admin's actions

Every action below is an API call that writes a provenance record naming its subject, the new value
and the one before (§7.1), and needs the template store (`SH_PROVENANCE_DIR`; without it the route
answers `400 invalid_request`). All mount on both route profiles (§4.1). Sandboxes and sessions
already created keep the build they were given.

### 5.1 The owner's (self-serve)

**Built (#737, #747):** every route in this table. A caller who cannot see the template gets
`404 template_not_found`, as on the reads; one who sees it but neither owns it nor is an admin gets
`403 forbidden`.

| Route                                                                                 | Who                                | Does                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/templates` · `POST /v1/templates/{id}/builds`                               | any client; a new build: the owner | creates a template or a build (§4)                                                                                                            |
| `POST /v1/templates/{id}/builds/{build}/cancel`                                       | the owner                          | a `queued`, `building` or `probing` build → `failed` (`cancelled`); a `build` record                                                          |
| `POST /v1/templates/{id}/tags {tags, build}` · `DELETE /v1/templates/{id}/tags/{tag}` | the owner                          | moves tags onto a registered build, or removes a tag; removing one never deletes the build (adopted from E2B); a `tag` record per tag changed |
| `PATCH /v1/templates/{id} {visibility, description}`                                  | the owner                          | changes them; a `visibility` record per field changed (`{field, value, before}`)                                                              |

A tag move names the build by its build id or its handle, and only a registered build takes a tag.
After it, `id:tag` (and the bare `id`, for `default`) resolves to the new build at the next creation
(§3.2). `default` is moved, never removed: the bare `id` must resolve. A tag already on the build,
or a field already at its value, changes nothing and writes no record. `private` hides the template
from other subjects (a 404, as for an id that does not exist) and refuses their new use.

**Retire (#749):** the template's owner, or an admin, retires a whole template or one build of it.

| Route                                      | Does                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `POST /v1/templates/{id}/retire {reason?}` | every build not yet retired becomes `retired`                                       |
| `DELETE /v1/templates/{id}/builds/{build}` | one build, by its build id or handle, becomes `retired`; the template's others stay |

- **Ends use for good.** A retired build's activation leases go, so it is no longer wanted: a host
  holding it is told to stop its worker (§6.3 `stop`). A sandbox create or an activation naming it,
  a tag of it, or a template whose every build is retired, is refused `410 template_retired` (not
  `400 unknown_template`: it existed, and its records stay). A retire and an activation's lease
  write run one at a time, and an activation re-reads its build's status before writing, so one
  that resolved the build just before a retire is refused `410 template_retired` too: no lease is
  left on a retired build to count against its subject's `active` quota. A sandbox create writes
  its record one at a time with a retire too, after re-reading its build's status: a create racing
  a retire either lands first (the retire sees its sandbox, and is refused `409 build_in_use`) or
  is refused `410 template_retired`, so no sandbox lands on a build as it is retired. Readiness reads
  `retired`, and each build lists `heldBy`, the hosts whose last inventory still holds its
  snapshot (a host silent past the staleness limit too: it leaves placement, not `heldBy`, so a
  `--wait` keeps waiting for the stop it gets once it reports again).
- **Never cuts off running work.** A retire is refused `409 build_in_use` while a live sandbox runs
  on a build it names (the build the sandbox resolved to at creation, not its worker, which two
  builds from one image can share; a sandbox record without a build id counts for every build on
  its worker; judged on the template as read in the retire's turn, not the request's earlier read):
  delete the sandbox (or let it end), then retire. A worker is never stopped
  under a live sandbox either (§6.3).
- **Recorded.** Each build retired writes a `retire` record naming the caller, `from` (the status
  before), `buildRecord` (the digest of its `build` record; null for a build never built) and the
  reason; its earlier records stay. The record is written within the catalog update that retires
  the build, so a record that cannot be written leaves the build as it was (a retry retires it), and
  no build is retired without its record. The answer lists each build with its id, readiness and the
  record's digest, so a client ties it to the trace. Idempotent: an already retired build is listed
  with `record: null`, and no second record is written.
- **Not reversible.** A new build (`POST /v1/templates/{id}/builds`) is the way back; a retired id
  stays its owner's, and a template whose every build is retired no longer counts against the
  `templates` quota.
- **From mocactl:** `mocactl sbx templates retire ID`, with `--build B` for one build,
  `--reason TEXT` (a whole template only) and `--wait [--timeout S]`. `--wait` returns once each
  build reads `retired` and its worker no longer runs: a retired build whose worker still holds a
  presence record reports `capacity`, as an active one does, and `capacity` is null once its host
  has stopped it (after the wanted state's `stop`); when the relay's presence cannot be read it
  reports `running: null`, and `--wait` keeps waiting rather than take that as stopped. Only a host
  that holds the build stops its worker, so a build no host holds has nothing to wait for: without
  host agents (`heldBy` null), or with none holding it (`heldBy` empty, such as an imported
  template whose worker an operator runs), `--wait` returns at once and says that a worker still
  running is not host-managed, to be stopped where it runs. A retired build whose snapshot or
  worker a build that is not retired shares (two builds of one template from one image share a
  worker id) reads `shared: true` and `capacity` null: its worker is kept running for that build and
  never stopped for the retire, so `--wait` returns at once and says so. Past `--timeout` (default
  300 s) it exits 5. Waiting for the snapshot's removal from every host (`heldBy` empty) comes with the
  host's removal step (#743). A sandbox
  command refused `template_retired` says that the template or build is never served again.

Known limits:

- A tag that points at a retired build still resolves to it, and is refused; so does `default`
  when the default build is retired, even with another registered build.
- Removing a retired build's worker and snapshot from its host comes with the host agent's removal
  step (#743); until then a retired build stays in `heldBy`.
- A Moca Pi session does not yet name a build, so only live sandboxes count as use; a session
  pinned to a build is to be checked beside them once sessions are.

Follow-up, not done here: retiring the build `default` points to could move `default` to the
newest registered build of the template, so a bare id keeps serving.

### 5.2 The admin's

"Admin" is the existing `admin` role (`SH_ADMIN_SUBJECTS`, `packages/control-plane/src/identity.ts`).
Admins do not approve builds; they set what policy allows and act where self-serve cannot:

| Route                               | Does                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PUT /v1/policy`                    | the policy profiles (§8): rules, envelope, registries, trusted gate-record sources; a new policy record |
| every owner action, on any template | e.g. move another's tags, or make another's template private; the record names the admin                |
| `PUT /v1/templates/{id}/owner`      | transfers ownership; also hands a declared template (no owner) to a subject; an `owner` record          |

The new owner is a person's subject, `github:<numeric id>` or `oidc:<provider sub>` (never a
synthetic `test:<n>`), and must be enrolled now (on the `sandbox` profile: `SH_ALLOWED_SUBJECTS`, or
an admin). They get every owner action, and the quotas count the template as theirs from then on; a
transfer to the current owner changes nothing.

A template the deployment declared (imported once from `SH_SANDBOX_TEMPLATES` into an empty
catalog, §3.1) has no owner, so its id blocks every self-serve create under it: `409
template_exists`. An admin hands it to a subject with `PUT /v1/templates/{id}/owner` (an `owner`
record with `before: null`); the subject then builds, tags and edits it like any template of theirs.
The env list is not imported again, so a restart does not undo the transfer.

Not covered here: whether a declared id should be claimable without an admin (a deployment with no
admin cannot transfer), and per-template roles (a maintainer who may tag but not transfer).

## 6. Builds and activation on a host

### 6.1 The host agent

A **new, small service** on each KVM host, `sbx-host-agent` (`deploy/sbx/host-agent.sh`, run by
`sbx-host-agent.service` and its timer; not an extension of the host janitor, which keeps its one
job), beside the workers. It **polls** the control plane and **reports** to it; it never listens, as
the janitor does not (a per-host bearer, no inbound port, SBX0 §8.3). The deployment lists its hosts
in `SH_TEMPLATE_HOSTS` and gives each its own bearer, `SH_HOST_TOKEN_<ID>`; a host route answers
only the host whose token is presented, for itself.

Its job here is to **build**: it claims `queued` builds and runs `template-build.sh` on them, as an
operator does by hand. A build is claimed only while the host's free disk is above its floor
(`SBX_DISK_FLOOR_GB`, default 60 GB, the `template-build.sh` refusal), and at most
`SBX_BUILD_CONCURRENCY` a poll (default 1). It also starts and stops installed workers by the
control plane's wanted state (§6.3); it installs none: a registered build's worker is installed by
an operator (`install-host.sh`, from the template record `template-build.sh` wrote, with the relay
token that only `setup.sh` mints).

**Each host declares the snapshots it holds**: the control plane does not assign templates to
hosts. A build lands on the host that claimed it, and then is in that host's inventory. On every
poll:

| Step | Agent                                                                                                                                     | Control plane                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1    | `POST /v1/hosts/{host}/inventory`: each held snapshot's template id and manifest hash; the host's limits, free disk                       | keeps the last inventory of each host                                    |
| 2    | `POST /v1/hosts/{host}/builds/claim`: up to its free build slots                                                                          | hands out `queued` builds, oldest first, one subject's at a time in turn |
| 3    | fetches a cited gate record (`GET /v1/hosts/{host}/blobs/{sha256}`) and checks its bytes against the sha256                               | serves the stored bytes                                                  |
| 4    | builds; `POST /v1/hosts/{host}/builds/{build}/log` and `/report` (`building`, `probing`, `built` with T and S, or `failed` with the step) | records them; on `built`, checks policy and registers or rejects (§8.2)  |

A claimed build's job is the spec as the policy checked it: the template's id and the create's
image always win over keys of the same name in the spec, and the guest size is always named
`guest_ram_mb` (the API also takes `guest_mb`; `template-build.sh` reads only `guest_ram_mb`). A
report is accepted only for a build handed to that host, and a failed or cancelled build takes no
more reports; the check is made again inside the template's update, with the report's records, so
an owner's cancel that lands while a report is being written stands and no record says it
registered. On `built` the control plane stores T and S byte for byte, writes a `build` record
and the registration `check` (§8.2); a registered build's id becomes its manifest hash, and a
template's first registered build takes the `default` tag. A build id names one build of a
template: a build whose manifest hash another build of the template already has (the same image
and spec created again under another profile or gate record, which the build finds already built)
is rejected, rule `T.unique`, naming that build.

**Nothing that names where an image lives leaves the host.** The control plane keeps what it is
sent, readable by clients and append-only in provenance, so the agent redacts a failed build's
reason and log (`SBX_REGISTRY`, URLs, registry hosts, IP addresses, 12-digit account numbers) and
keeps the full log on the host (a 0700 directory). T and S go byte for byte, so they cannot be
redacted: one that names `SBX_REGISTRY` is not sent, and the build fails `leak_refused`. A
failure's reason leads with a code a client can branch on: `pull_failed`, `probe_failed`,
`disk_floor`, `spec_refused`, `build_failed` or `leak_refused`; or `agent_error`, when the agent
cannot carry on with a build it claimed (a gate record it cannot fetch or whose bytes do not match
its sha256, a report not accepted, no template record or manifest after the build). An agent that
is still running reports every build it claimed: `built`, or `failed` on any other way out.

**The build host handles untrusted images** in a self-serve model. The image is pulled only from a
registry the policy allows (§8.1), its export runs as today (`build-rootfs.sh`, as root, owners
kept, M4) into a size-capped scratch directory, and everything the image runs, runs inside the
Firecracker guest. Hardening the export of a hostile image is recorded, not solved, for the first
version.

Known limits: a claimed build is not re-queued if the agent dies mid-build; one poll builds up to
`SBX_BUILD_CONCURRENCY` builds, with no scheduling across hosts.

### 6.2 Quotas and the active limit

**Per host:** each host's agent reports, with its inventory, its `activeLimit` (the workers it may
run at once), its `idleLimitSeconds` (the default lease length, §6.3), its `buildConcurrency` and its
disk, from the host's own settings (`SBX_ACTIVE_LIMIT`, `SBX_IDLE_LIMIT_S`), and its memory (below).
`activeLimit` is the upper bound on the workers it runs; the memory rule keeps new starts within the
host's memory, so the limit need not be worked out from the templates' guest sizes by hand.
`GET /v1/templates` shows each host's `active {limit, used}`, where `used` counts the workers that
stay running on it: the leased builds placed or running there, and the unleased ones still draining
a live sandbox, retired ones (§5.1) included; and its `memory` when its agent reports it. The inventory says, per held build,
whether its worker's unit is `running`; the host's `attached` and `detached` reports keep that
current between inventories.

**Per subject:** the policy's `quota.active` caps the builds a subject holds a live lease on.
Over it, an activation is refused (`429 quota_exceeded`, `quota: active`); `GET /v1/quota` shows the
use.

**Placement:** a wanted build (one with a live lease, §6.3) is placed on a host whose last inventory
holds its snapshot (by manifest hash). Placement is sticky: a build already running on a holder stays
there, so a lease ending elsewhere never moves a running worker to another host. Any other goes to
a holder under its `activeLimit`, the one with the fewest workers counted (above), then by id, in
the order the leases began (first leased, first placed). A build no
reporting host holds is not placed (`unavailable`); one whose every holder is full waits
(`unavailable`), and is never placed by evicting a leased build. A host whose last inventory is
more than 6 minutes old (three build polls) is left out of placement, of the hosts block and of
the default lease until it reports again, so a host whose agent died takes no new placement and no
slot; with every host silent, readiness is the workers' presence alone, as before any reported.

**Memory (#744):** each attached worker maps and locks its snapshot's whole memory file at start
(`PinMemoryFile`; snapshots are Full, so the file is the guest's whole RAM), so an idle worker holds
its guest's RAM, and the cost of a host is mostly its attached workers times their guest size. A
fixed `activeLimit` fits only templates of one size on a host doing nothing else, so placement also
counts memory, on a host whose agent reports it:

- **The inventory's `memory`** (`host-agent.sh`, sent with every inventory, the build poll's and
  each 15 s wanted run's): `memTotalMib` and `memAvailableMib` (`/proc/meminfo`), `memPressureFull10`
  (`/proc/pressure/memory`, `full avg10`; absent with no PSI, which is no brake), `memPressureLimit`,
  `memFloorMib` (the effective floor), `runningWorkers` (the `sbx-worker@<id>` units active),
  `vmCommittedMib` per running worker, and `memfileMismatch`. Without MemTotal and MemAvailable no
  figures are sent, and the host is placed by `activeLimit` alone.
- **A build's cost** is its guest RAM (`guest_mb` of the registered spec, checked against the
  manifest's `guest_ram_mb`; 4096 for a build with none) plus 128 MiB for the worker and its VMM.
  The agent checks that each held build's memory file is exactly `guest_ram_mb` MiB; a mismatch is
  reported (`memfileMismatch`, an error line), never placed on that host, and never started there
  (`refused`), whatever a control plane asks.
- **`vmCommittedMib`** is what a worker's running VMs hold that the kernel cannot reclaim: its
  slice's `memory.stat` (`sbx.slice/sbx-<id>.slice`) anon + shmem + kernel. Never `memory.current`,
  which also counts the page cache the VMs' files fill (rootfs, workspace): several GiB a worker
  that the kernel takes back at need and that MemAvailable already counts as available. The pinned
  memory file is file-backed and locked, so it is in neither: the worker's cost counts it.
- **The rule,** in `place()`, per host, in the wanted order:
  `headroom = min(total − floor − used, available − floor − pending)`, where `pending` is the cost
  of the builds placed there in this pass whose workers are not running yet, and
  `used = Σ cost(running workers, any build's, wanted or draining) + Σ vmCommittedMib + pending`.
  MemAvailable already reflects what runs, so only the pending starts come off it, and two builds
  placed in one pass both count. A build fits if `cost ≤ headroom` and the host is under
  `activeLimit`. A build already running on a holder stays there (sticky, above): its memory is
  paid for and it is counted already, so nothing is evicted. "Running" is the union of the held
  builds marked `running` (kept current by the host's `attached` and `detached` reports) and the
  inventory's `runningWorkers`. A worker an `attached` report says started since the inventory is
  not in that inventory's MemAvailable, so its cost is in `pending` too until the next one. A host
  reporting the build's memory file wrong is never chosen for it, even where it runs (that copy
  then goes to `stop`, under no live sandbox).
- **Brakes:** while `memPressureFull10` is above `memPressureLimit` (default 10), or the host's last
  inventory is older than 60 s (about four missed reports), the host takes no new start; it keeps
  what it runs.
- **Settings,** in the host's `host-agent.env` (0600), never argv: `SBX_MEM_FLOOR_MIB` (default 10%
  of MemTotal, at least 4096) and `SBX_MEM_PRESSURE_LIMIT` (default 10).
- **Visible:** a build wanted but not placed is `unavailable` with `readinessReason` (`not_held`,
  `no_slot`, `memory`, `memfile_mismatch`); the activation's `409 no_active_slot` carries
  `reason: memory` (at the active limit it answers as before, with no reason), and every holder
  reporting a wrong memory file is `409 template_unavailable` with `reason: memfile_mismatch` (a
  rebuild clears it, not a wait). The check runs under the activation lock (§6.3), so two
  activations cannot see the same headroom.
- **Compatible both ways:** an agent that sends no `memory` is placed by `activeLimit` alone; a
  control plane that does not know the field ignores it, and the agent's own memory-file check still
  holds.
- **Limits:** keep the host's `/srv/sbx` off tmpfs (there a memory file is shmem and is charged
  twice). The rule does not change a worker's own budget (`--budget-mb`), the guest size or the
  pinning, and does not move running workers. Other workloads' memory is seen only through
  MemAvailable. Pages a VM writes that are charged to another cgroup read low in `vmCommittedMib`;
  the MemAvailable term still binds. The sandbox lease mode (SBX0.3), if built, keeps a lease VM's
  guest memory as anon/shmem in its worker's slice, so `vmCommittedMib` counts it with no change; its
  per-worker reclaim and this floor act on different things (VMs and whole workers), and on one host
  the floor should be at or above lease mode's reclaim target.

### 6.3 Leases, aging and the wanted state

- **Leases:** an activation is a **lease** held by its subject, `leaseSeconds` long (60 s to a day a
  grant; default the largest `idleLimitSeconds` of the hosts that hold it, clamped to 60-86400,
  else 3600), renewed by
  `POST /v1/templates/{id}/activate` again, without a cap, while the subject still needs the build
  (for the life of a batch, say). `POST /v1/templates/{id}/deactivate` drops the subject's leases.
  Each grant is an `activate` record, and the lease stores its digest (§7.1). This activation lease
  is not the sandbox lease mode (a warm guest kept for one sandbox between Execs) nor the harness's
  run lease; nothing is shared with them.
- **Wanted:** a build is wanted running only while a lease stands, so aging is a lease running out:
  an unleased build is not kept running, and no idle build needs replacing. Least-recently-used
  replacement of the subject's own activations is not built: over the quota, the activation is
  refused.
- **Refusals:** an activation that cannot be placed is refused with no lease kept:
  `409 template_unavailable` (no registered build under the reference, no reporting host holds it,
  or every holder reports its memory file wrong, §6.2) or `409 no_active_slot` with `Retry-After`
  (every holder is at its `activeLimit` with leased builds, or has no memory headroom for it, §6.2;
  the seconds until the soonest a build placed on one of this build's holders loses its last live
  lease, or 60 when no lease tells, as with draining workers).
- **One activation at a time:** an activation's quota and placement check, its `activate` record
  and its lease write run one at a time across the deployment (owner activation and first use
  alike), so concurrent activations of different templates cannot together pass a subject's quota
  or a host's `activeLimit`. A lease taken in the same second as a placed build waits
  (`409 no_active_slot`) rather than displacing it. A retire (§5.1) and a sandbox create's status
  re-read and record write take the same lock, held for one catalog read and one record write per
  create. The lock is in the control plane's process, so
  one process per template store is what makes it enough.
- **The wanted state:** `GET /v1/hosts/{host}/wanted` answers `run` (the leased builds placed on that
  host) and `stop` (the builds it holds with no lease and no live sandbox, a leased build it runs
  while placement keeps it on another host, so one worker id never runs on two hosts, and the
  retired builds it holds (§5.1) with no live sandbox, except a retired build whose snapshot or
  worker a build that is not retired shares, which that build's own entries decide; one worker id is
  never in both lists, so a worker in `run` for one build is not in `stop` for another that shares
  it; a build imported from SH_SANDBOX_TEMPLATES is in neither list, retired or
  not). The agent stops each `stop` worker that runs, then starts each
  `run` worker that is installed and not running (`sbx-worker@<id>`), and reports each start
  (`attached`), refusal (`refused`, with why) and stop (`detached`) at
  `POST /v1/hosts/{host}/workers/report`, as `activate` and `deactivate` records by `host:<id>`
  (`detached` is taken for a retired build too).
  Readiness never comes from a report: `active` is the relay's attached record. A worker that is
  not installed is reported `refused`, never installed by the agent. The agent retries a refused
  start every 15 s; a `refused` that repeats the host's last one for the build (same reason) while
  the build stays in the host's `run` is not recorded again, so the append-only stream does not
  grow by a record a poll.
- **Live sandboxes:** a worker is never stopped under a live sandbox: an attached build with no
  lease is `deactivating` and drains (no new lease needed for the sandboxes it runs); it is stopped
  once none is left.
- **Two passes, one lock:** the agent applies the wanted state after each build poll and, apart
  from builds, every 15 s (`host-agent.sh --wanted-only`, `sbx-host-agent-wanted.timer`), so an
  activation waits seconds, not behind a build. A lock on the host keeps the two from starting or
  stopping workers at once; the one without it skips.

### 6.4 Activation on first use

So a client can name a template and go: on a deployment with template hosts
(`SH_TEMPLATE_HOSTS`), `POST /v1/sandboxes` on a registered build that is not `active` takes the
caller's lease (as `activate`, recorded with `reason: first_use`; its refusals `no_active_slot`,
`template_unavailable` and `quota_exceeded` answer as they would) and answers
`409 template_not_active` with `readiness` and `Retry-After` (30 s, or the build's place in its
host's start line, §6.5); the client retries. A caller that already holds a live lease on the build
(its own retry) is only answered the wait: no renewal and no new record per retry.
`activate: false` starts nothing. No sandbox record is kept while waiting, so a wait never uses the
live-sandbox cap. The gate applies whenever template hosts are configured, also before any of them
has reported: until a host's first inventory, an attached worker serves and an absent one is
refused, not left to wait at the relay. Without template hosts nothing changes. A template imported
from `SH_SANDBOX_TEMPLATES` (build `imported:<12 hex>`) is never gated, with hosts or without: it
names no snapshot, so no host holds it and the deployment runs its worker; its readiness is that
worker's presence alone, and `activate` refuses it with `400 invalid_request` (it takes no lease).
`mocactl sbx create`
and `sbx up` wait out a `template_not_active` after its `Retry-After` for up to 10 minutes, saying
why; `mocactl sbx templates activate ID --wait` before a batch avoids the first wait.

Known limits: the budget a worker is installed with still caps how many commands it runs at once
(it is sized at install, not from the lease); a first use waits for one worker start, seconds to
minutes by the snapshot's size and the host's disk.

### 6.5 Pacing cold starts: the start limit, start lines and the idle grace

**Why.** A build is `active` once its worker attaches to the relay. Before that the worker verifies
its snapshot, maps and locks its whole memory file (`PinMemoryFile`, mmap + mlock, which reads the
whole file from disk unless it is cached), restores a probe VM, and attaches. A host agent that
starts every wanted worker in one pass (the units are `Type=simple`, so each start returns at once)
has N workers read N memory files at the same time, so each start takes about
`N × file size ÷ disk throughput`, and readiness showed only `activating`. And a worker stopped as
soon as its last lease ended, so a template used again minutes later started cold again.

Measured on one KVM host whose snapshots sit on a general-purpose cloud block volume (about
125 MB/s), 4 GiB guests, starts measured after a release (cache not warm): cold starts one at a time
took 78 s on average (at most 120 s), a wave of four about 3-4 minutes, and with 28 started at once the last attached
after more than twenty minutes. Width does not raise the disk's throughput: a start limit bounds
each start's wait and makes the line visible; it does not shorten the total.

- **The start limit, in the host agent:** `SBX_START_CONCURRENCY` (default 4; at least 1, 0
  refused) caps the workers _starting_ (started, not yet attached) at once; it is not
  `activeLimit`, which caps running ones. Each wanted run starts up to the free slots, in the
  wanted answer's order (oldest lease first), leaves the rest for the next run (15 s), and never
  waits for a start to finish. The wanted answer gains `starting: [buildId]`, the builds of `run`
  whose worker the relay does not show attached; with an older control plane that sends none, the
  agent counts as starting its own starts younger than `SBX_START_WINDOW_S` (default 300) whose
  unit runs and which are still wanted, so the limit holds without a control-plane change. Either
  way a start counts for `SBX_START_WINDOW_S` at most: a listed worker still not attached after it
  (one that crash-loops, hangs, or cannot reach the relay) is stuck, said in an error line each run,
  and holds no slot, so a few stuck workers cannot stop every other start on a host. A listed
  worker the agent did not start is timed from when it first sees it, and gives no start time.
- **The measured start time:** the agent keeps its starts (`start-times`, 0600) and takes a start
  as done when its build is still in `run` but no longer in `starting`; it reports
  `startConcurrency` and `startSeconds`, the mean of its last ten starts (start to attach, to within
  the 15 s poll), in the inventory's limits. `startSeconds` is absent before a start is done.
- **Start lines, in the control plane:** on a host that reports `startConcurrency`, its placed,
  wanted builds not attached, in the wanted order, form its start line: the first
  `startConcurrency` are starting, the rest `queued`. A build in the line is `activating` with
  `queued` and `queuePosition` (1-based). `Retry-After` on `409 template_not_active` becomes
  `max(1, ceil(ceil(position / startConcurrency) × startSeconds))` once the host has measured a
  start, else 30 s; on first use the facts are read again after the lease is taken, so the request's
  own build has its place. The `hosts` block shows
  `start: {concurrency, seconds, starting, queued}`. A queued activation stays `activating` longer
  than before: a client polls with a timeout sized for the whole line (`mocactl sbx templates activate --wait` sizes its default as
  `(ceil(position / concurrency) + 1) × startSeconds × 1.25`, at least 1800 s, at most 4 h;
  `--timeout` wins).
- **Start-aware placement:** §6.2's sticky placement needs no start at all: a build already
  running on a holder (its agent's report: a held build marked running, or its `runningWorkers`;
  attached or graced) stays there, whether or not the host reports memory figures. A graced build
  leased again is such a build: it keeps its worker and its host.
- **The idle grace (optional):** `SBX_IDLE_GRACE_S` (default 0, off; at most 86400), reported as
  `limits.idleGraceSeconds`. After a build's last lease ends (`lastLeaseEnd`: a release's time, or
  an expired lease's end), its running worker, with no live sandbox, stays in `run` until that end
  plus the grace, listed in the wanted answer's `graced`, if the host has room under `activeLimit`
  beside the workers it counts (§6.2: wanted and draining ones) and its memory headroom (a graced
  worker counts as running there). A worker draining a live sandbox is never graced: it keeps its
  slot as a draining worker, and is never displaced. Its readiness is
  `deactivating` with `graced: true` and `gracedUntil`; a use within the grace finds it attached:
  first use takes a lease and is served at once. The agent never starts a graced build; it only
  keeps one running. The grace ends early for:
  - a release with `stopNow: true` (`POST /v1/templates/{id}/deactivate`), which leaves a build with
    no lease stopped at the next poll (its `stopNowAt`), so a benchmark can still measure each
    task's cold start; the `deactivate` record says `stopNow: true`;
  - a wanted build that needs the slot or the memory: the soonest-ending graced workers give way, as
    few as fit it (a host that fits without displacing comes first). It is the only stop of a
    worker nobody asked to stop, and only of one with no lease: the wanted answer re-reads the
    build under the activation lock before listing it in `stop`, and a build leased since keeps its
    worker. A host over its memory with its graced workers lets the soonest-ending go first.
- **The shared lock:** the activation lock (§6.3) lives in its own module (`activation-lock.ts`), so
  the wanted answer's re-check and activation share it; no call to a host runs under it.
- **Compatibility:** an older agent sends none of the new limits: its host has no start line, its
  Retry-After is 30 s, and it has no grace. An older control plane ignores them and sends no
  `starting` (the agent counts its own starts) and no `graced`. Roll out the control plane before
  setting `SBX_IDLE_GRACE_S` on a host.

Known limits: the memory file's pin still reads the whole file at every cold start; prefetching
memory files, or reporting what a host has cached, is out of scope. `startSeconds` is accurate to
the 15 s poll. The grace is a host setting, not a client's choice. The activation lease is not the
sandbox lease mode: a graced worker can hold lease-mode VMs only while their sandboxes live.

## 7. Provenance

Nothing in the control plane records where a sandbox template came from, who changed it, or which
snapshot a sandbox ran on. The ownership-plane audit stream (`sh:cp:audit`) is trimmed, not chained,
and not exportable as a self-checking document. Provenance is a separate, append-only record: one
hash chain per stream, exportable, and verifiable offline with the Python standard library alone.

### 7.1 Records and the chain

Every step writes one record. A record is JSON, append-only, with `prev` (the digest of the record it
follows) so the chain from the image to a sandbox can be walked and checked. Every record names its
**subject** (who, or `policy` for an automatic decision, `janitor`, or `host:<id>`) and when:

| Record                         | Written when                                                                  | Holds                                                                                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`                       | an admin sets the policy                                                      | the profiles, in full; its digest is what every `check` cites                                                                                                                                                                                                    |
| `create`                       | a client creates a template or a build                                        | the subject, id, image digest, spec, profile, visibility, the gate record's sha256 if given (the record itself stored beside it)                                                                                                                                 |
| `gate`                         | a gate record is cited                                                        | the gate record's sha256 (`record_sha256`), its source (a trusted source, or `client`) and its gate fields                                                                                                                                                       |
| `build`                        | a snapshot is built and its probe passed                                      | the template record and the manifest: image digest, manifest hash, kernel, rootfs, agent and snapshot digests, the probe and its result, the Moca commit, the host, when                                                                                         |
| `check`                        | policy is applied, at create and at registration                              | the policy's digest, the profile, each rule and its result, the outcome (`admitted`, `registered`, `rejected`); at registration, `build` is the digest of the `build` record it judged                                                                           |
| `activate` · `deactivate`      | readiness changes                                                             | host, worker, manifest hash, subject, reason; each lease stores its `activate` record's digest                                                                                                                                                                   |
| `tag` · `visibility` · `owner` | the owner or an admin changes one                                             | the new value and the one before                                                                                                                                                                                                                                 |
| `retire` · `reject`            | a template or build is retired or rejected, or a host removes it              | subject, reason, `from` (the status before), `buildRecord`; a host's removal is a `retire` by `host:<id>`                                                                                                                                                        |
| `sandbox`                      | a sandbox is created, and when it ends                                        | at create: sandboxId, buildId, templateManifestHash, `lease` (null with no lease), expiresAt; at end: `state: terminated`, `reason` (`deleted` with endedAt, or `expired`, written once by the janitor's sweep when it first sees it; the true end is expiresAt) |
| `session`                      | a Moca Pi session pinned through the store is created, and when it is deleted | at create: sessionId, buildId, templateManifestHash, `lease` (null with no lease), `state: created`; at delete: sessionId, buildId, `state: terminated`, `reason: deleted`, endedAt                                                                              |
| `use` (summary)                | sessions start                                                                | per build and day: count, first and last, by subject                                                                                                                                                                                                             |

A **stream** is `policy` (the deployment's policy records) or `template/<id>` (everything about one
template). A `policy` record belongs to the `policy` stream and nothing else does.

**Every cross-record reference is a record digest** (the sha256 of the referenced record's canonical
JSON), never a time or a name, so a chain composes with no rule but equality: `check.policy` (the
policy record), `check.build`, `retire.buildRecord`, `reject.buildRecord` (the build's `build`
record), `sandbox.lease` and `session.lease` (the `activate` record the lease came from). A run then
joins its build exactly: its build id is the `build` record's manifest hash and the `activate`,
`sandbox` and `session` records' `buildId`; a sandbox's span is its two `sandbox` records, by
sandboxId.

The units that produce each event write its records. The first is the sandbox resource itself: with
a store configured, `POST /v1/sandboxes` writes the `created` record, `DELETE` the `deleted` end, and
the janitor's read the `expired` end. `buildId` is the build the sandbox's reference resolved to
(§3.2): `imported:<12 hex>` for a template imported from `SH_SANDBOX_TEMPLATES`, whose
`templateManifestHash` is null (the list names no snapshot); `lease` is the caller's live activation
lease on the build (§6.3), by its `activate` record's digest, and null with none. The second is the
session: with a store configured, `POST /v1/sessions` for a session whose template resolved through
it writes the `created` record, and `DELETE /v1/sessions/{id}` the `deleted` end; a session never
deleted has no end record. Its `buildId` and `templateManifestHash` read as a sandbox's: an
`imported:` build's hash is null, and its session gets its end record all the same. Both records are
written after the change they record, best effort: one that cannot be written is logged, and the
create or delete stands. A store written before a kind existed links those events by time, not by
digest; a verifier older than a kind refuses a store holding one.

### 7.2 Hosting, persistence and offline verification

- **Hosted in the control plane**, in a store that is **not Redis**: an append-only directory on the
  control plane's persistent volume (`SH_PROVENANCE_DIR`, opened with the template store, which
  shares the directory; unset, nothing is recorded and nothing changes). One file per record named by
  its digest (`records/`), a head per stream (`heads/`: the latest record's digest and the count), and
  the documents records cite, such as gate records, byte for byte under their sha256 (`blobs/`). A
  record is written (exclusive create, fsync) before its stream's head moves (write-temp, fsync,
  rename), so a crash leaves an orphan record, never a head naming a missing one. Appends to one stream
  are serialized; one control-plane process per directory, as for the file credential store. The
  directory is checked writable at start, so a missing or read-only volume fails the start, not the
  first write. Built: `packages/control-plane/src/provenance.ts` (`ProvenanceStore`).
- **Digests, not signatures**: a record (`moca-provenance-record/1`, with the fields schema, stream,
  seq, prev, kind, subject, at and body) is named by the sha256 of its canonical JSON (keys sorted, no
  whitespace, integers only, printable-ASCII keys, so a second implementation writes the same bytes),
  and names its predecessor's digest in `prev`, with a `seq`, so any edit, drop or reorder breaks the
  chain. Nothing is signed.
- **Exported**: `ProvenanceStore.export()` returns one JSON document (`moca-provenance-export/1`): the
  requested template streams, the policy stream they cite, every exported stream's head and count, and
  the gate records its `gate` records cite. An authorized `GET /v1/provenance/export?template=<id>`
  (the owner, readers of a shared template, admins) is _planned_.
- **Verified offline** by `verify-provenance.py EXPORT.json [--head STREAM=sha256:…]` in
  `deploy/sbx/template-onboarding/` (stdlib Python) or `verifyExport` (the same rules in
  TypeScript; a test runs both on the same exports): every record's digest, each stream's `seq` and
  `prev` chain up to its head and count, record kinds and streams, every blob's sha256, that each `check` cites a policy record and
  each `gate` a blob of the export. An export can only prove itself consistent: `--head` compares a
  head kept elsewhere, which is what catches an export that dropped its latest records. Exit 0
  verified, 1 a check failed (each printed), 2 usage. **Not built yet:** re-running each `check`
  against its policy, and matching a `build` record's manifest hash to a snapshot at hand.
- **Redaction**, for data that must not be kept:
  `deploy/sbx/template-onboarding/redact-provenance.py STORE_DIR TEMPLATE_ID --pattern RE [--apply]`
  (control plane stopped) rewrites the matching records of one stream and every later one, moves the
  head, and appends a note to `redactions.log` (counts and heads, never the matched text);
  `--catalog-only` redacts text only the template catalog keeps. Dry run by default. An export taken
  before a redaction no longer verifies against the new head, by design.
- **The workload plane only reports**: a host posts build results and readiness events. The control
  plane checks and records; it never trusts a report it cannot tie to its chain.

## 8. Policy: gating without an approver

Self-serve replaces an admin's approval with **policy**: the gating rules
([GATING-RULES](../../deploy/sbx/template-onboarding/governance/GATING-RULES.md)) as machine checks,
applied by the control plane and the build host, each result recorded (`check`, §7). A deployment
offers named **profiles**; an admin writes them (`PUT /v1/policy`, each change a `policy` record
naming who), and each create names one, or gets the policy's default.

The policy (`moca-template-policy/1`, `packages/control-plane/src/template-policy.ts`) is kept beside
the template store (`<SH_PROVENANCE_DIR>/policy.json`, `template-policy-store.ts`) and holds the
profiles, the allowed registries, the trusted gate records (by sha256) and the per-subject quotas
(`templates`, `buildsQueued`, `active`, and `owned`, the template ids owned in any status, 200 when
a policy does not set it). Until an admin sets one, the default policy applies, and it
is recorded on first use, so every `check` cites a `policy` record that exists. `GET /v1/policy`
shows it, its digest and its record.

| Profile          | For                                                   | Requires, beyond the `base` rules                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`           | any client's own image (a toolchain, a project's env) | Moca's rules M1, M7-M9 at create (M2-M4, M10-M17 on the build host); the image from an allowed registry; the size envelope                                                                                        |
| `benchmark`      | SWE-bench and the like                                | a gate record that passed (X1), from a **trusted source** (§8.3), whose `source_record_digest` equals the image digest (X10); X11 (no network), X12 (commits refused), X14 (a measured probe), X15 (the envelope) |
| `benchmark-self` | the same, on the creating subject's own gate record   | `benchmark`'s rules, with the record self-attested (§8.3): trusted for its submitter's own templates only, which stay private                                                                                     |
| `general-self`   | general users whose sandboxes need a network          | `benchmark-self`'s without X11: the KVM host's allowlisted egress allowed                                                                                                                                         |

### 8.1 At create (in the control plane, before any build)

The profile exists; M7 (the id rule and every spec field, including a spec `id` or `image` that
differs from the create's: `M7.spec_id`, `M7.spec_image`), M8, M9; the image pinned by digest (M1)
**from an allowed registry** (`allowedRegistries`; a reference with no host is the build host's
default registry, `<default>`) and, where the policy lists repositories for that registry
(`allowedRepositories`), from one of them (rule `registry.repository`; whole path segments,
`prefix/*` for a prefix; the image's path held to the entries' grammar first, so no uppercase and no
empty, `.` or `..` segment; a registry with no list allows every repository it serves); the profile's
size envelope; for `benchmark`, X1, X10-X12, X14 and
X15 from the spec and the gate record; whatever the profile, X10 whenever the spec names a gate
record (with X1's check of that record, or of any gate record sent: it passed, and is for this
image; only `X1.trusted` is the profile's) and X12 whenever the spec skips the git identity check
(a skip with no gate record showing commits refused is refused); and the caller's quota (§6.2). A refusal is
`422 policy_refused {rule, message}` and, on an existing template's stream the caller may write
(§4), a `check` record listing every rule and its result; nothing is queued. The control plane refuses early, so a refused create costs no host time; the build host
still applies its own checks, since a host is never trusted to have been asked only valid builds.

### 8.2 At build and registration

On the build host, the build tool applies its checks (M1-M4, M10-M13, M15, and X10, X12 with the
gate record). When the host agent (§6.1) reports a build `built`, the control plane
re-checks the build record against the create's spec and the policy, and registers the build or
rejects it with the failing rule, with a `check` record either way. A build is registered only with
a passed `check` against the policy named at create.

### 8.3 Trusted gate-record sources

Without signatures, a gate record proves nothing by itself: a client could write one. The `benchmark`
profile therefore trusts a gate record only from a **source the policy names**: for an image builder,
the place it records its gated images, from which the control plane (or the offline verifier) fetches
the record and compares its sha256 with the one the client sent. For the first version the fetch is
replaced by an admin-loaded copy of the source's records: the policy's `trustedGateRecords`, by
sha256 (X1.trusted). Fetching is not built. A record that is not trusted is refused for `benchmark`;
on `base` it may still be sent, and is stored and recorded with source `client`.

A profile with `selfAttest` (`benchmark-self`, `general-self`) also accepts a record the policy does
not list, from the creating subject, for that subject's own templates only: the build is
self-attested, private, and recorded with source `self` until an admin lists the record. The
[subject trust spec](2026-11-08-subject-trust-gate-records-design.md) holds its rules (X1.self.scope,
X12.self, X1.self.egress, X1.offline) and what a trust removal does.

### 8.4 The instance-id mapping

So two clients onboarding the same benchmark instance name it alike (and §3.2's reuse or
`409 template_exists` applies), the `benchmark` profile is to name its **id rule**: for SWE-bench, the
instance id lower-cased, `__` and `_` to `-`, refused, never truncated, past 31 characters. Not
enforced yet: the create checks the id's form only.
