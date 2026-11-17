# Change policy for the API, CLI and configuration

> **Adopted 2026-10-13** by the maintainer. It meets the last criterion for Stable in
> [Maturity and lifecycle](maturity-and-lifecycle.md) ("a stated change policy"). "Today" describes what the repository
> does now, from code and manifests; several decisions below need code changes, tracked in the linked issues.

## What the policy covers

| Surface                   | Where it is defined                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The HTTP API              | [`docs/api/openapi.yaml`](../api/openapi.yaml) (control plane), [`docs/api/harness-openapi.yaml`](../api/harness-openapi.yaml) (data plane) |
| The `mocactl` CLI         | [Command reference](cli-mocactl.md)                                                                                                         |
| Configuration             | [Configuration reference](configuration.md): environment variables, ConfigMaps, `setup.sh` flags                                            |
| The sandbox wire contract | `proto/sandbox/v1` (the `Attach` and `Exec` services)                                                                                       |
| Stored data               | Redis keys, the credential envelope, token claims, config bundles                                                                           |

It applies to **Stable** surfaces. A **Preview** surface may change at any time, but changes are listed in the release
notes. A **Legacy** surface does not change except for security and breakage fixes
([support policy](maturity-and-lifecycle.md#removed-paths)).

## What is the contract today

- **HTTP routes.** The route table in `packages/server/src/routes.ts` marks each route's `surface` as
  `client` or `internal`, and a contract test keeps the OpenAPI document and that table in step. Only `client` routes
  are described in the OpenAPI files. The control-plane document (`docs/api/openapi.yaml`) says `version: 1.28.0` (per-session model
  selection, then the sandbox service's routes, then the async turn routes, then the template store and self-serve create, then sandbox modes, then the grant lifecycle, then template tags, edits and owner transfer, then subject trust for gate records, then the template host agents, then activation leases, then memory-aware placement, then cold-start pacing, then per-sandbox egress records, then sandbox templates for sessions, then the combined control plane, then a session's seed, patch and records, then template retire, then retired build removal, then enrollment and the admin role, then admin quotas and build reject, then pinned sessions as build use, then build reuse only while a host holds the snapshot, then grants at dequeue under multi tenancy, then idle-counted sandbox lifetimes, then per-turn artifacts and a bounded status read, then the base URL's page, then the config bundle's format version on upload and on a turn, added to it); the harness document (`docs/api/harness-openapi.yaml`) says `version: 1.5.0`. The `/v1`
  prefix is the only version marker on the wire.
- **Aliases.** `/turn` and `/runs` are unprefixed aliases of `/v1/turn` and `/v1/runs`: client routes, served by the
  same handler with the same auth, body and responses, and described in the harness document as aliases of the `/v1`
  routes (decision 3). New features appear under `/v1` only. `/run-leaf` and `/run-leaf/status` are internal, marked
  `deprecated`, and log a warning once per process.
  `/runs/status` has no `/v1` form. `/workloads` is an operator surface, off unless enabled.
- **`mocactl`.** The version is injected at build time (a release tag, `edge-<sha>`, or `dev`). `--help` is global,
  exit codes are documented, and `--json` outputs are structured.
- **Configuration.** Variables keep historical prefixes (`SH_*`, `KAGENTI_*`, `MOCA_*`). Parsing is strict in some
  places and lenient in others ([Configuration](configuration.md#conventions)).
- **Wire contract.** `sandbox/v1` has been extended additively (for example the `workspace_key` field on `Exec`).
- **Stored data.** Redis holds a schema-version key, `sh:schema-version` (`SCHEMA_VERSION`, 1, in
  `packages/control-plane/src/schema-version.ts`). The control plane, each worker and the relay write it when it is
  absent and check it once Redis answers: a version newer than the process knows, or a value that is not a version,
  makes the process log the reason and exit. An older version is accepted and left as it is, because a release must
  read what the previous one wrote. New fields are still handled by tolerant reads. The credential envelope is
  versioned (`v1.` prefix). Token claims are read by the data plane from the control plane's tokens.
- **Config bundles.** `BUNDLE_FORMAT_VERSION` is 1. A bundle carries it as a content entry, `format.json`, which the
  digest covers and the store keeps (the stored bundle still drops `lockfile.json`, which records the digest). The
  control plane refuses to store a bundle in a newer format (`400 invalid_request`, naming the version), and the
  harness refuses to apply one (a turn answers `422 config_bundle_unsupported`, naming it). A bundle without `format.json`, built before it existed, reads as version 1.
- **Releases.** Tags are `v0.x.y`, so by semantic-versioning convention anything may change between minor releases.

## What counts as breaking

A change is **breaking** if a correct client or operator built against the previous behaviour can stop working:

- removing or renaming a route, field, query parameter, flag, environment variable or exit code;
- changing a field's type or meaning, a status code, or the meaning of an error code;
- narrowing the values a request accepts, or newly requiring a field, flag or variable;
- changing a default so that behaviour, capacity or security posture changes;
- changing a persisted format so the previous version cannot read data the new one wrote.

Not breaking: adding an optional field, route, flag, variable or error code. **Clients must therefore ignore unknown
response fields and tolerate unknown error codes.** Text output meant for people (log lines, `mocactl` prose, error
`message` strings) is not a contract; the structured fields are.

## The rules

1. **Within a release series** (`0.N.x` patch releases), Stable surfaces change only additively and with fixes. A
   breaking change waits for the next minor release.
2. **A breaking change to a Stable surface is deprecated first.** The deprecation is announced in the release notes
   and in the docs (a banner on the page), and the surface keeps working for the **longer of one minor release and the
   period below** before it may be removed. The removal's release notes cite the deprecation.

   | Surface                                        | Minimum period |
   | ---------------------------------------------- | -------------- |
   | HTTP API, `sandbox/v1` wire contract           | 90 days        |
   | `mocactl`, configuration, anything else Stable | 30 days        |

3. **Deprecations are visible at runtime where possible.** Routes get `deprecated: true` in the route table and the
   OpenAPI file, and log a warning once per process (the mechanism `/run-leaf` already uses). Flags and variables get a
   one-line warning on use.
4. **Renames keep the old name working** for the deprecation period. Existing prefixes (`SH_*`, `KAGENTI_*`, `MOCA_*`)
   are not renamed in bulk; a rename is a breaking change like any other.
5. **A new required variable, or a changed default, is called out in the release notes under "Upgrade notes"**, with
   the order of upgrade when order matters (for example, the harness before the control plane for config bundles).
6. **A security fix may break a surface without notice**, and the release notes say so.

### By surface

| Surface                               | Additive (allowed in a patch)                                               | Breaking                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| HTTP API, `/v1`                       | New optional fields, routes, error codes                                    | Removing or retyping anything; a new required field. Introduce `/v2` for a real break, or deprecate and remove per rule 2 |
| Unprefixed aliases (`/turn`, `/runs`) | None: frozen, supported, no removal date. New features appear on `/v1` only | Removing one needs the same notice as any route                                                                           |
| `mocactl`                             | New commands, flags, `--json` fields                                        | Removing a flag or command, changing an exit code or a documented `--json` field                                          |
| Configuration                         | New optional variables with a safe default                                  | Removing or renaming a variable; a new required one; a default that changes capacity or security                          |
| `sandbox/v1` wire                     | New fields (additive, as `workspace_key` was)                               | Anything else: introduce `sandbox/v2` and keep `v1` for the deprecation period                                            |
| Stored data                           | New keys and new fields that older code ignores                             | A change the previous release cannot read. Stored data must be readable by the previous release                           |
| Config bundles                        | None without a format version that survives upload                          | A format change the previous release cannot read; readers fail loudly on a version they do not understand                 |

### Version markers

Two markers guard stored formats, and each is bumped only by a change the previous release cannot read, which is a
breaking change under rule 2 and decision 8:

- **`SCHEMA_VERSION`** (Redis). Absent, it is written; equal or older, the process runs; newer, it exits. A release
  that bumps it decides whether its processes raise the stored value (and so lock the previous release out) and how
  existing keys are read; that is one branch of `checkSchemaVersion`. Until then, a rollback across releases that share
  a version needs no step, and a rollback past a bump is not supported. Absent, with any `sh:` data, means version 1:
  every release before the key existed wrote version-1 data. The check reads first and writes only an absent key, so
  a Redis that refuses writes (full under `noeviction`, a read-only replica, an ACL without `SET`) still has its
  stamp checked; a refused write on an absent key is logged once and retried, and the process runs on. The key has no
  TTL, so it needs a `noeviction` or `volatile-*` eviction policy: under `allkeys-*` it can be evicted, and after a
  `FLUSHALL` or a restore that lost it the next process stamps its own version, which after a bump could put an old
  version over newer data. Re-stamp it after such a restore (`SET sh:schema-version <version>`).
- **`BUNDLE_FORMAT_VERSION`** (config bundles). Readers accept their own version and every older one, and refuse a
  newer one. Upgrade the harness and the control plane before the clients that build bundles (`mocactl`, the
  promote tooling).

## Release notes

Every release states: breaking changes, deprecations and their removal release, new required configuration, upgrade
order requirements, and which paths are Preview, Stable or Legacy at that release. A release that names P6 as the
supported runtime also satisfies the first Stable criterion for the deployment paths it names.

## Decisions (accepted 2026-10-13)

| #   | Question                                                             | Decision                                                                                                                                    | Follow-up                                                 |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Unit of notice                                                       | The longer of one minor release and the period in rule 2 (releases have come about two weeks apart, so releases alone are too short)        |                                                           |
| 2   | Deprecation period                                                   | 90 days for the HTTP API and the sandbox wire contract; 30 days for the CLI, configuration and anything else                                |                                                           |
| 3   | The `/turn` and `/runs` aliases                                      | Keep them indefinitely as supported, frozen aliases of `/v1`; only `/run-leaf` and `/run-leaf/status` (already deprecated) are removed      | [#507](https://github.com/rossoctl/moca/issues/507)       |
| 4   | `GET /runs/status`                                                   | Add `GET /v1/runs/status` and keep `/runs/status` as an alias                                                                               | [#508](https://github.com/rossoctl/moca/issues/508)       |
| 5   | `version` in the OpenAPI files (control plane 1.28.0, harness 1.5.0) | The version of the `/v1` contract: bump the minor for additive changes and the major only with a `/v2`; add a changelog                     | Done: [CHANGELOG.md](../api/CHANGELOG.md)                 |
| 6   | Stored-data compatibility                                            | Readable by the previous release, no migrations yet; add a schema-version key in Redis before the first change that needs one               | Done: [#509](https://github.com/rossoctl/moca/issues/509) |
| 7   | Config bundle format                                                 | Carry a format version into the stored bundle, have the harness check it and fail loudly, and require the previous version to stay readable | Done: [#510](https://github.com/rossoctl/moca/issues/510) |
| 8   | Who approves a breaking change                                       | A breaking change to a Stable surface needs an ADR and sign-off from the owner in `CODEOWNERS` for the affected area                        |                                                           |

Related, from the upgrade-order discussion: the control plane should not hand a `configRef` to a harness that cannot
apply it. Every harness since v0.5.0 applies it, so this is closed in favour of decision 7's format-version check
([#512](https://github.com/rossoctl/moca/issues/512), [#510](https://github.com/rossoctl/moca/issues/510)).
