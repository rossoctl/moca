# Gating rules for sandbox images and templates

> **Preview.** The gating rules for sandbox images and templates are implemented but not yet
> declared Stable; interfaces and limits may change.

**Draft.** The image extensions (X) are owned by the image builder; Moca's side writes the
enforcement to follow them. This document cites the tool that enforces a rule, not the line. The
control plane's create-time policy (`packages/control-plane/src/template-policy.ts`, template
lifecycle spec §8) refuses a create by these ids: a `422 policy_refused` names the rule.

Moca's gating rules are **Moca's own rules (M) plus the image builder's extensions (X)**. An image gets
into a template only through the template validation process, `template-build.sh`, and that process
gates the image by these rules. Every deployed image and template is provenance-tracked, and the
provenance is persistent, verifiable offline, and hosted in the **control plane**. The workload plane
(the KVM host, the worker) is only where the evidence comes from.

## How to read a rule

| Column       | Meaning                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tier**     | `ctr`: container sandboxes (the image runs as a container). `vm`: microVM sandboxes (the image is exported to a rootfs and snapshotted). `both`                                 |
| **Evidence** | what passes it: a value seen, in which record                                                                                                                                   |
| **Status**   | **enforced** (by which tool; a violation stops it) / **CI** (a test in Moca's CI) / **documented** (written down, nothing checks it) / **gap** (should be enforced, is not yet) |

A rule's evidence is kept in one of four records (see [Records](#records-and-what-each-holds)):

- **G**: the image's gate record, written by the image builder (a per-family schema, such as `example-builder/moca-microvm/1`, or the general gate's, which `SH_GATE_RECORD_SCHEMA` names: default `moca-gate-record/1`);
- **R**: `/etc/moca-rootfs-source` in the rootfs;
- **S**: the snapshot's `manifest.json`;
- **T**: the template record, `moca-sbx-template/1`.

## 1. The image (before any template is built from it)

### 1.1 Moca's own image rules

| #   | Rule                                                                                                                                                                          | Tier | Evidence                                              | Status                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| M1  | Pinned by digest: a template's image is `[host[:port]/]path@sha256:<64 hex>` in the distribution reference grammar (lowercase path), never a tag, nor a tag beside the digest | vm   | spec `image`; the pulled digest equals it (T `image`) | enforced: `template-build.sh` (the digest); the policy at create (the grammar too) |
| M2  | Re-pulled for every build; a stale local copy is never exported (#414)                                                                                                        | vm   | R `digest=`                                           | enforced: `build-rootfs.sh` (`SH_SKIP_PULL` is the explicit exception)             |
| M3  | The tools a template needs are in the image (see M3 below the table)                                                                                                          | vm   | `build-rootfs.sh` passes                              | enforced: `build-rootfs.sh`                                                        |
| M4  | Exported as root with owners kept, never merged into an existing tree                                                                                                         | vm   | `build-rootfs.sh` passes                              | enforced: `build-rootfs.sh`                                                        |
| M5  | Moca's own sandbox image: the worker's tools present, both Dockerfiles alike, vendored rg and gh pinned by sha256                                                             | ctr  | Moca's CI                                             | CI                                                                                 |
| M6  | Moca's own sandbox image: `/workspace` and `HOME` 1001:0 775, `USER 1001`                                                                                                     | ctr  | the Dockerfile                                        | documented (HOME: CI)                                                              |

**M3, the required tools:** a template's required tools are **its spec's
`tools` plus the guest agent's minimum, `bash ls cat base64 file`**: `bash` runs every command
(M17), the harness writes files with `base64 -d >` and `cat >`, lists with `ls`, and asks `file`
for a mime type. A template whose client pushes a config or context overlay also needs `tar`,
`gzip` and `flock`, and lists them in `tools`. `gh` is required only where the
spec lists it. `build-rootfs.sh --require` takes the list from its caller, and
`template-build.sh` passes the spec's `tools` plus that minimum. Without `--require`, every image
`build-rootfs.sh` requires Moca's own sandbox image's list (`bash git rg gh python3 base64 file ls
cat`), which most third-party images, and every benchmark image, do not carry; a template with
`egress: false` cannot use `gh` anyway.

### 1.2 The image builder's image extensions

These apply to every image built by the image builder. The image builder enforces them, so a gate record
that passed is the evidence. A general gate record (§2.3) proves X1, X4 as its stated floor
(`gate.floor`; `gate.floor_checked_offline` says whether it was proved offline), X5, X7, X8 and X9, and
X6 when the contract lists files that must be absent. X2 and X3 do not apply: a general gate builds
nothing, so its record has no base digest and no recipe. A template built from such an image must carry the record's digest
(X10), so the evidence can be found.

| #   | Rule                                                                                                                                                                                                                                                           | Tier | Evidence (in G)                                                                                                                         | Status                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | **Gated, and the gate passed in full**: an image is pushed only after its gate, reviewed, then read back from the registry by digest                                                                                                                           | both | `gate.passed: true`; `image.digest` equals the digest read back                                                                         | enforced: the image builder (its record review, and its push's readback); the `benchmark` profile needs a passed record whose sha256 the policy trusts (X1, X1.trusted, X1.image) |
| X2  | **Built from a pinned base**: FROM a digest whose own gate record exists (testbed, agent testbed, or the task's environment)                                                                                                                                   | both | `testbed_image.digest` / `environment_image.digest` / `base_image.digest`                                                               | enforced: the image builder (the recipe refuses a tag; tests check the base's record)                                                                                             |
| X3  | **Reproducible recipe**: the tag is derived from the recipe's hashes                                                                                                                                                                                           | both | `recipe.dockerfile_sha256`, `recipe.platform_layer_sha256`, `recipe.emitter`; `image.tag`                                               | enforced: the image builder                                                                                                                                                       |
| X4  | **The environment works at base**: the instance's own test command, unpatched, passes what the benchmark says passes; in the microVM layout, with the same counts as the container                                                                             | both | `observed.testbed.test_cmd_{rc,passed,failed}`                                                                                          | enforced: the image builder's gate                                                                                                                                                |
| X5  | **Commits are refused**: one baseline commit, a clean tree, no git identity anywhere (no `/etc/gitconfig` identity, none in the guest HOME)                                                                                                                    | both | `observed.testbed.commit_count: "1"`, `agent_can_commit: "no"`; vm: `observed.guest.git_identity: "none"`; ctr: `/etc/gitconfig` absent | enforced: the image builder's gate (SWE-bench). Moca's default image allows commits (#415): this rule is the benchmark images'                                                    |
| X6  | **No answer key in the image**: no test or solution file a grader uses (TB: no file carrying their sha256, no `/tests` or `/solution`); the grading command appears in no record except as its sha256                                                          | both | TB: `gate.forbidden_sha256_checked`, `observed.absence`; SWE-bench: `gate_cmd_sha256` only                                              | enforced: the image builder's gate                                                                                                                                                |
| X7  | **No credentials**: no credential-shaped variable in the image's environment or the guest's                                                                                                                                                                    | both | `observed.*.credential_env_names: []`                                                                                                   | enforced: the image builder's gate                                                                                                                                                |
| X8  | **The gate runs as the sandbox will**: vm, root, read-only root, `--network none`, `/workspace` seeded from `/opt/testbed-src`, `/tmp` and `/var` tmpfs, `HOME=/tmp/home`; ctr, the user the image's container sandbox runs as, with no network for the checks | both | `gate.kind`, `gate.network`, `gate.rootfs`, `gate.user`; `observed.guest.rootfs: "readonly"`                                            | enforced: the image builder's gate                                                                                                                                                |
| X9  | **The guest can resolve localhost**: the exported `/etc/hosts` is a file that maps `localhost` to 127.0.0.1 and ::1 (its sha256 is the spec's `etc_hosts_sha256`, M10)                                                                                         | vm   | `observed.etc_hosts_exported_sha256`                                                                                                    | enforced: the image builder's gate; Moca checks it again (M10)                                                                                                                    |

## 2. The template (spec → snapshot → record)

### 2.1 Moca's own template rules

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Tier | Evidence                                 | Status                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------- | ------------------------------------------------------------------------ |
| M7  | The spec is well formed: id `^[a-z0-9][a-z0-9-]{0,30}$`; guest ≥ 128 MiB (`guest_ram_mb`, or its alias `guest_mb` alone, never both), 1-32 vCPUs; `guest_home` under `/tmp`; booleans typed; seed a string; probe `{cmd, timeout_s, expect_rc, expect}` with valid regexes; distinct `tools`; a spec's `id` or `image`, when present, equal to the create's (`M7.spec_id`, `M7.spec_image`, at create time in the control plane: the build uses the create's) | vm   | spec                                     | enforced: `template-build.sh`                                            |
| M8  | `guest_home_gitconfig` needs `guest_home`, and is refused with `skip_git_identity_check`                                                                                                                                                                                                                                                                                                                                                                      | vm   | spec; T `guest_home_gitconfig`           | enforced: `template-build.sh`                                            |
| M9  | A probe whose expected result is unmeasured is refused (`probe_status` `unmeasured` or `none`)                                                                                                                                                                                                                                                                                                                                                                | vm   | spec                                     | enforced: `template-build.sh`                                            |
| M10 | The rootfs's `/etc/hosts` has the spec's sha256                                                                                                                                                                                                                                                                                                                                                                                                               | vm   | spec `etc_hosts_sha256`                  | enforced: `template-build.sh`                                            |
| M11 | In-guest checks before the snapshot: git identity (unless skipped), egress listener, `/dev/fd`, `/var`                                                                                                                                                                                                                                                                                                                                                        | vm   | build log                                | enforced: `build-snapshot.sh`                                            |
| M12 | **The probe passes in a VM restored from the new snapshot**: the seed, then the probe, exit `expect_rc` and match every `expect` (colour codes stripped first); a failure publishes nothing                                                                                                                                                                                                                                                                   | vm   | T `probe` (what was required); build log | enforced: `template-build.sh` + `build-snapshot.sh --verify-command`     |
| M13 | Published only after a verified restore, sealed root-owned, by rename                                                                                                                                                                                                                                                                                                                                                                                         | vm   | S                                        | enforced: `build-snapshot.sh`                                            |
| M14 | At worker start: the manifest verifies (version 2: every field and file, the memory file with `SH_VERIFY_MEMFILE=1`), the template record matches it (`SH_TEMPLATE_RECORD`), the instance type matches, the memory file pins, a restore runs `true`                                                                                                                                                                                                           | vm   | S `hash`, T                              | enforced: `microvm-worker` (instance type: fails open, with an override) |
| M15 | Egress: `false` installs the worker with `--no-egress`; an egress CA only with `true`, a public certificate, its sha256 equal to the host's                                                                                                                                                                                                                                                                                                                   | vm   | S/T `egress_ca_sha256`                   | enforced: `template-build.sh`, `install-host.sh`                         |
| M16 | One template per worker; budget ≥ (guest + 32) × 3 + 1024 MiB                                                                                                                                                                                                                                                                                                                                                                                                 | vm   | T `min_budget_mb`                        | enforced: `template-register.sh`, `install-host.sh`                      |
| M17 | Commands run under `bash -c`                                                                                                                                                                                                                                                                                                                                                                                                                                  | both | —                                        | documented                                                               |

### 2.2 The image builder's template extensions

| #   | Rule                                                                                                                                                                                                                                                                                                   | Tier | Evidence                                                                                                   | Status                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X10 | **A template names its image's gate record**: the spec's `source_record_digest` equals its `image` digest, and the gate record with that digest passed (X1)                                                                                                                                            | vm   | spec `source_record_digest`; G                                                                             | **enforced**: at create under any profile (policy: the digest equality, the record for this image, its gate passed), and `template-build.sh --gate-record` (the same); T carries `source_record_digest` and `gate_record`                                             |
| X11 | **No network for a benchmark template**: `egress: false`                                                                                                                                                                                                                                               | vm   | spec/T `egress`                                                                                            | **enforced**: the `benchmark` profile requires `egress: false` (policy, X11); the image builder's specs write `false`                                                                                                                                                 |
| X12 | **Commits stay refused where the spec says**: `skip_git_identity_check: true` only with `guest_home_gitconfig: false`, and only for an image whose G shows X5                                                                                                                                          | vm   | spec; T; checked in a real guest                                                                           | **enforced**: M8 the pairing; at create under any profile, the policy refuses a skip no gate record backs (X5); `template-build.sh --gate-record` refuses a skip the gate record does not back; T records `skip_git_identity_check` and `gate_record.commits_refused` |
| X13 | **The probe is public**: its target is never a test that grades a fix, and its expected counts are never the grading command's                                                                                                                                                                         | vm   | the probe's target is one of the image builder's public targets; its command's sha256 ≠ the gate command's | enforced: the image builder (the target derivation and a test); **documented only** in Moca                                                                                                                                                                           |
| X14 | **The probe's expectation was measured**: in a real VM (`vm`) or the guest emulation (`emulation`), on the same image digest and command; matched against the printed summary, colour codes stripped                                                                                                   | vm   | spec `probe_status`, `proved_in_vm`; the image builder's probe record                                      | enforced: the image builder (tests); M9 refuses an unmeasured one; the `benchmark` profile requires `probe_status` `vm` or `emulation` (policy, X14)                                                                                                                  |
| X15 | **The template's size is the gate's envelope**: 4096 MiB, 2 vCPUs, `HOME=/tmp/home`                                                                                                                                                                                                                    | vm   | spec                                                                                                       | enforced: the `benchmark` profile's envelope, exactly 4096 MiB and 2 vCPUs (policy, X15)                                                                                                                                                                              |
| X16 | **The guest exposes no registry host or account id**: no file Moca adds to a template's rootfs, and no line of its template record, names a registry host (a private one above all) or an AWS account id; images are recorded by the reference the spec gives (`repository@sha256:…`) and their digest | vm   | the rootfs's `/etc/moca-rootfs-source` (`image=` the spec's own reference); T; the provenance scans        | **enforced**: `template-build.sh`'s test that a `--registry` build writes a host-free `image=` line; the provenance export scans. `build-rootfs.sh` had once written the pull reference, `--registry`'s host included.                                                |

### 2.3 Self-attested gate records, and repositories per registry (Moca)

A subject may submit its own gate record (made with the image builder's general gate) on a profile
with `selfAttest`. It counts only for that subject's own templates, which stay private and are shown
as self-attested until an admin adds the record's sha256 to `trustedGateRecords`; a build made on a
`selfAttest` profile while its record was trusted reads as self-attested again (and its template as
private) once an admin removes it. A record counts for one subject only, its first submitter, unless
its build failed (a failed build never admitted a template, so it releases the record; rejected and
retired builds keep it): the same sha256 submitted by a second subject is refused (X1.self.scope); a
build made while the record was trusted claims nothing. The X rules above apply unchanged, plus:
commits always refused, whatever the spec says (X12.self), and egress only where the profile allows
it (X1.self.egress). `benchmark-self` keeps X11 (offline, for benchmark integrity) and, like
`benchmark`, needs a general-gate record's floor checked offline (X1.offline:
`gate.floor_checked_offline`, on a record of the schema `SH_GATE_RECORD_SCHEMA` names, default
`moca-gate-record/1`; fail closed: a record of any other schema, such as a builder's family records,
which predate the field, passes unless it says `floor_checked_offline: false`, so a deployment that
takes another builder's general-gate records sets `SH_GATE_RECORD_SCHEMA` to that builder's schema
and holds them fail-closed too); `general-self` allows the KVM host's allowlisted egress and either
floor. All of §2.3's rules are tier `vm` and are checked at create. Moca's spec: [subject trust for
gate records](../../../../docs/specs/2026-11-08-subject-trust-gate-records-design.md).

| #                   | Rule                                                                                                              | Evidence                                                                  | Status                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------- |
| X1.self.scope       | A self-attested record counts only for its first submitter                                                        | the catalog: each self-attested build's gate sha256, its template's owner | enforced: control plane |
| X12.self            | A self-attested record shows commits refused (`agent_can_commit` `no`, `git_identity` `none`), whatever the spec  | G `observed`                                                              | enforced: control plane |
| X1.self.egress      | `spec.egress` false on a self-attested record unless the profile sets `selfAttestEgress`                          | spec `egress`; the policy                                                 | enforced: control plane |
| X1.offline          | A general-gate record's floor checked offline, on a profile that requires X1 (unless `requireOfflineGate: false`) | G `gate.floor_checked_offline`                                            | enforced: control plane |
| registry.repository | From a registry the policy lists in `allowedRepositories`, the image is one of its repositories                   | spec `image`; the policy                                                  | enforced: control plane |

The registry allowlist (`allowedRegistries`) admits a registry host. Where the policy also lists
repositories for it (`allowedRepositories`, keyed by the host as the policy reads it, Docker Hub as
`docker.io`), the image must come from one of them: an exact path (`library/python`) or a prefix
(`library/*`), matched on whole path segments; a Docker Hub official name reads as `library/<name>`.
The image's path is first held to the entries' grammar (lowercase segments of letters and digits
separated by `.`, `_` or `-`; no empty, `.` or `..` segment), so the policy and the build host's
puller read one path the same way; a path that is not is refused by the same rule. A registry with
no list allows every repository it serves.

## 3. Provenance: what must be kept, where

**The chain.** Each link is a digest, and each must be checkable offline from the records alone:

```
benchmark base (by digest) ─► the image builder's gate record G (image digest, recipe hashes, gate result)
    ─► template spec (image digest, source_record_digest) ─► rootfs (R: image, digest)
    ─► snapshot manifest S (hash version 2: over every field and file, R's image digest included)
    ─► template record T (manifest_hash) ─► the worker serving it (its id names the image digest;
       at start it checks T against S, SH_TEMPLATE_RECORD)
```

**Where it lives.** The control plane holds the provenance; the workload plane only produces it.
`template-register.sh` runs on the operator's machine and takes T from the host. Proposed, for
Moca to build: the control plane stores T together with S and the G it cites (or G's
digest and where it is published), so a deployed template can be verified without the host.

### The fields Moca should carry as gate evidence

From G, copied into T at registration (all are in the image builder's family records; a general gate record has no `recipe` and no base digest, so those are null in T):

| Field                                   | From                                                                 | Why                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `source_record_digest`                  | spec                                                                 | ties the template to its gate record (X10)                                                       |
| `gate_record.schema`                    | G `schema`                                                           | which family's gate it passed (`example-builder/moca-microvm/1`, `example-builder/tb-microvm/1`) |
| `gate_record.passed`                    | G `gate.passed`                                                      | X1                                                                                               |
| `gate_record.kind`, `.network`, `.user` | G `gate`                                                             | X8: how it was gated                                                                             |
| `gate_record.base_digest`               | G `testbed_image.digest` / `environment_image.digest`                | X2                                                                                               |
| `gate_record.recipe`                    | G `recipe` (`dockerfile_sha256`, `platform_layer_sha256`, `emitter`) | X3                                                                                               |
| `gate_record.builder`                   | G `builder` (`arch`, `engine`, `network`), `built_at`                | where and how it was built                                                                       |
| `gate_record.sha256`                    | the sha256 of G as committed                                         | the record T was built against; a changed G is a different record                                |
| `gate_record.commit`                    | the image builder's commit holding G, where G is published           | where to fetch G for an offline check                                                            |
| `probe_status`, `proved_in_vm`          | spec                                                                 | X14                                                                                              |

Never carried: a registry host, an account id, a credential, or the grading command (only its
sha256, already in G).

### Records, and what each holds

| Record                       | Written by                                      | Holds                                                                                                                                                                                                                                                  | Hosted                                                                         |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| G, `<builder>/<family>/1`    | the image builder, committed after the readback | image digest, base digest, recipe hashes, builder, the gate's observations, `template` (the spec)                                                                                                                                                      | the image builder's repository (persistent; offline: the file and its commit)  |
| R, `/etc/moca-rootfs-source` | `build-rootfs.sh`                               | `image=`, `digest=`                                                                                                                                                                                                                                    | inside the snapshot's rootfs (workload plane)                                  |
| S, `manifest.json`           | `build-snapshot.sh`                             | `hash_version` 2; image, vmm, instance type, kernel release, size, vcpus, capabilities, `built_at`, kernel/rootfs/agent/vmstate/memfile sha256, `egress_ca_sha256`, `source_image_digest` (R), all inside `hash` (version 1: kernel/rootfs/agent only) | beside the snapshot (workload plane)                                           |
| T, `moca-sbx-template/1`     | `template-build.sh`                             | the spec's fields, snapshot, worker id, `manifest_hash`, `built_at`, `min_budget_mb`                                                                                                                                                                   | **proposed: the control plane** (today: the host, then the operator's machine) |
