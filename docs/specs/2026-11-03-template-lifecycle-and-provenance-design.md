# Template lifecycle, readiness and provenance — Design

Version: 0.2 (draft for review) — November 2026
Status: Proposed. This file holds §1-§4, the template store and its read API (#736) and the
self-serve create (#737), §7, provenance (#730), and §8, policy (#737); §5, §6 and §9-§12 (the
owner's and the admin's actions, builds and activation on a host, tracing, validation, order of
work, decisions) come with the issues that build them, and keep their numbers so a reference to a
section stays valid.
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
or build, or one the caller cannot see, is `400 unknown_template`, as an unknown id always was.

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

| State          | Means                                                                                | Built      |
| -------------- | ------------------------------------------------------------------------------------ | ---------- |
| `active`       | its worker is attached; sandboxes can run                                            | #736       |
| `inactive`     | registered, no worker attached                                                       | #736       |
| `unknown`      | the relay's presence could not be read: never a guess                                | #736       |
| `activating`   | the control plane asked a host to attach its worker; not yet attached                | planned §6 |
| `deactivating` | the control plane asked the host to detach it; live sandboxes drain                  | planned §6 |
| `unavailable`  | it cannot be activated: no host declares its snapshot, or the host refused, with why | planned §6 |

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
is `422 policy_refused {rule, message}` and a `check` record (written only on a stream the caller
may write: an id no template holds yet, its own, or as an admin adding a build; a refusal on another
subject's id is only answered), and nothing is queued. Refusals on the caller's own and on new ids are
bounded only by the request rate. Over a quota
(§6.2: templates owned with a build registered or on its way there, so one whose builds all failed
or were cancelled holds no slot; builds queued, building or probing at once, charged to the
template's owner even when an admin adds the build) is `429 quota_exceeded` naming which
(`quota`); the quota is read and the build written under one lock per subject, so concurrent creates
for different ids never pass one check together. Another subject's id is `409 template_exists` (`404 template_not_found` when that
template is private: no existence oracle). An admitted create writes `create`, `gate` (with a gate
record) and `check` records (§7.1) and queues the build for a build host (§6.1, a later issue).

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
filled by the host agent (planned); empty means no host has reported, never that there is no limit.
An unknown template or build, and a `private` template the caller does not own, answer
`404 template_not_found` (no existence oracle). Errors keep Moca's shape, `{error, message}` with a
stable code. `capacity.running` is what the worker advertises at once (its presence record's
capacity), not a formula in the control plane; `capacity.inUse` is its live sandboxes now, and
`lastUsedAt` the newest sandbox created on it, retained records included.

A sandbox names `id`, `id:tag` or `id@<build id>` (§3.2); the reference is resolved to one build at
creation, recorded on the sandbox (`buildId`, and `templateManifestHash`, null for an imported build),
and kept for its life. Planned with activation (§6.4): a create on a build that is not `active` is
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

## 7. Provenance

Nothing in the control plane records where a sandbox template came from, who changed it, or which
snapshot a sandbox ran on. The ownership-plane audit stream (`sh:cp:audit`) is trimmed, not chained,
and not exportable as a self-checking document. Provenance is a separate, append-only record: one
hash chain per stream, exportable, and verifiable offline with the Python standard library alone.

### 7.1 Records and the chain

Every step writes one record. A record is JSON, append-only, with `prev` (the digest of the record it
follows) so the chain from the image to a sandbox can be walked and checked. Every record names its
**subject** (who, or `policy` for an automatic decision, `janitor`, or `host:<id>`) and when:

| Record                         | Written when                                                     | Holds                                                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`                       | an admin sets the policy                                         | the profiles, in full; its digest is what every `check` cites                                                                                                                                                                                                    |
| `create`                       | a client creates a template or a build                           | the subject, id, image digest, spec, profile, visibility, the gate record's sha256 if given (the record itself stored beside it)                                                                                                                                 |
| `gate`                         | a gate record is cited                                           | the gate record's sha256 (`record_sha256`), its source (a trusted source, or `client`) and its gate fields                                                                                                                                                       |
| `build`                        | a snapshot is built and its probe passed                         | the template record and the manifest: image digest, manifest hash, kernel, rootfs, agent and snapshot digests, the probe and its result, the Moca commit, the host, when                                                                                         |
| `check`                        | policy is applied, at create and at registration                 | the policy's digest, the profile, each rule and its result, the outcome (`admitted`, `registered`, `rejected`); at registration, `build` is the digest of the `build` record it judged                                                                           |
| `activate` · `deactivate`      | readiness changes                                                | host, worker, manifest hash, subject, reason; each lease stores its `activate` record's digest                                                                                                                                                                   |
| `tag` · `visibility` · `owner` | the owner or an admin changes one                                | the new value and the one before                                                                                                                                                                                                                                 |
| `retire` · `reject`            | a template or build is retired or rejected, or a host removes it | subject, reason, `from` (the status before), `buildRecord`; a host's removal is a `retire` by `host:<id>`                                                                                                                                                        |
| `sandbox`                      | a sandbox is created, and when it ends                           | at create: sandboxId, buildId, templateManifestHash, `lease` (null with no lease), expiresAt; at end: `state: terminated`, `reason` (`deleted` with endedAt, or `expired`, written once by the janitor's sweep when it first sees it; the true end is expiresAt) |
| `session`                      | a Moca Pi session pinned to a template is created and deleted    | as `sandbox`, with sessionId                                                                                                                                                                                                                                     |
| `use` (summary)                | sessions start                                                   | per build and day: count, first and last, by subject                                                                                                                                                                                                             |

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
`templateManifestHash` is null (the list names no snapshot); `lease` is null until activation (§6.3)
writes leases. A store written before a kind existed links those events by
time, not by digest; a verifier older than a kind refuses a store holding one.

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
(`templates`, `buildsQueued`, `active`). Until an admin sets one, the default policy applies, and it
is recorded on first use, so every `check` cites a `policy` record that exists. `GET /v1/policy`
shows it, its digest and its record.

| Profile     | For                                                   | Requires, beyond the `base` rules                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`      | any client's own image (a toolchain, a project's env) | Moca's rules M1, M7-M9 at create (M2-M4, M10-M17 on the build host); the image from an allowed registry; the size envelope                                                                                        |
| `benchmark` | SWE-bench and the like                                | a gate record that passed (X1), from a **trusted source** (§8.3), whose `source_record_digest` equals the image digest (X10); X11 (no network), X12 (commits refused), X14 (a measured probe), X15 (the envelope) |

### 8.1 At create (in the control plane, before any build)

The profile exists; M7 (the id rule and every spec field, including a spec `id` or `image` that
differs from the create's: `M7.spec_id`, `M7.spec_image`), M8, M9; the image pinned by digest (M1)
**from an allowed registry** (`allowedRegistries`; a reference with no host is the build host's
default registry, `<default>`); the profile's size envelope; for `benchmark`, X1, X10-X12, X14 and
X15 from the spec and the gate record; X10 and X12 whenever the spec names a gate record or skips
the git identity check, whatever the profile; and the caller's quota (§6.2). A refusal is
`422 policy_refused {rule, message}` and a `check` record listing every rule and its result; nothing
is queued. The control plane refuses early, so a refused create costs no host time; the build host
still applies its own checks, since a host is never trusted to have been asked only valid builds.

### 8.2 At build and registration

On the build host, the build tool applies its checks (M1-M4, M10-M13, M15, and X10, X12 with the
gate record). When the host agent (§6.1, a later issue) reports a build `built`, the control plane
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

### 8.4 The instance-id mapping

So two clients onboarding the same benchmark instance name it alike (and §3.2's reuse or
`409 template_exists` applies), the `benchmark` profile is to name its **id rule**: for SWE-bench, the
instance id lower-cased, `__` and `_` to `-`, refused, never truncated, past 31 characters. Not
enforced yet: the create checks the id's form only.
