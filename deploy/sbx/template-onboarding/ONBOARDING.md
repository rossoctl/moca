# Onboarding a sandbox template

The walk-through, with two worked examples (Moca's public image and a SWE-bench instance) and a
client choosing between them, is the [Template Onboarding Guide](GUIDE.md). This page is the short
reference.

This page turns a container image into an SBX0 template that clients can ask for by id, and checks
it. It is the long form of [RUNBOOK](../RUNBOOK.md) §5, and uses two tools, both in this folder:

- `template-build.sh` runs on the KVM host. It turns a spec into a snapshot that has been checked
  in a microVM, plus a template record.
- `template-register.sh` runs on the operator's machine. It turns that record into SBX0's inputs.

A sandbox of a template runs every command in a microVM restored from the template's snapshot.
Each template has its own worker (`microvm-worker`, one snapshot each), so onboarding a template
means building a snapshot, giving it a worker id, and installing that worker.

## The process at a glance

| Step                | Where              | What                                                                    | Check                                                                          |
| ------------------- | ------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 0. The spec         | anywhere           | Describe the template: image by digest, guest size, egress, seed, probe | `template-build.sh` validates every field before it runs anything              |
| 1. Build            | KVM host, root     | `template-build.sh SPEC --kernel K`: pull by digest, rootfs, snapshot   | the digest pulled matches; `/etc/hosts` as pinned; free disk                   |
| 2. Probe            | (inside step 1)    | The seed and the probe run in a VM restored from the new snapshot       | the probe's exit code and output patterns; a failure publishes nothing         |
| 3. Register         | operator's machine | `template-register.sh --env-file F RECORD`, then `setup.sh`             | one worker per template; the old worker is kept on an update                   |
| 4. Install          | KVM host, root     | `install-host.sh BUNDLE --snapshot S --budget-mb N [--no-egress]`       | the worker attaches to the relay                                               |
| 5. Live check       | operator's machine | `templates-check.sh` (RUNBOOK §14)                                      | a client creates a sandbox of the template, and its commands run on that image |
| 6. Update or retire | both               | A new image gets a new worker; the old one drains, then `--retire`      | no live sandbox on the old worker                                              |

## 0. The spec

A spec is a JSON file, schema `moca-sbx-template-spec/1`:

```json
{
  "schema": "moca-sbx-template-spec/1",
  "id": "django-django-11133",
  "image": "team/moca-microvm@sha256:<64 hex>",
  "guest_ram_mb": 4096,
  "vcpus": 2,
  "guest_home": "/tmp/home",
  "skip_git_identity_check": true,
  "egress": false,
  "seed": "cp -a /opt/testbed-src/. /workspace/",
  "probe": {
    "cmd": "<a command that proves the image works>",
    "timeout_s": 900,
    "expect_rc": 0,
    "expect": ["<extended regex>", "..."]
  },
  "description": "what clients see in GET /v1/templates",
  "tools": ["bash", "git", "python3", "rg"],
  "etc_hosts_sha256": "<optional: the sha256 the image's /etc/hosts must have>"
}
```

| Field                     | Rule                                                                                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | What clients ask for: `^[a-z0-9][a-z0-9-]{0,30}$`. It stays the same across versions of the template.                                                                                                                                                                                  |
| `image`                   | Pinned: `repository@sha256:<digest>`, never a tag. A repository with no registry host takes its host from `--registry` at build time, so a spec written by an image builder commits no host.                                                                                           |
| `guest_ram_mb`, `vcpus`   | The guest's size (at least 128 MiB; 1-32 vCPUs). Every VM restored from the snapshot has it.                                                                                                                                                                                           |
| `guest_home`              | Optional, a path under `/tmp`: a writable `HOME` for guest commands. The rootfs is read-only.                                                                                                                                                                                          |
| `skip_git_identity_check` | `true` for an image that refuses agent commits on purpose (a benchmark testbed).                                                                                                                                                                                                       |
| `guest_home_gitconfig`    | Optional, `true`: copy the image's `/root/.gitconfig` into `guest_home`, so an identity set in the image applies. Refused with `skip_git_identity_check`: an image that refuses commits must not get its root identity.                                                                |
| `egress`                  | `false` installs the worker with `--no-egress`, so the guest has no network at all. Use it for a benchmark whose upstream fix must stay out of reach. `true` gives the host's allowlisted egress ([RUNBOOK](../RUNBOOK.md#guest-egress)).                                              |
| `seed`                    | A bash command that fills a new sandbox's empty `/workspace`, or `""` for none. **The client runs it:** `mocactl sbx create --template ID --seed` on a deployment with the template store, or as its first command in each new sandbox. It is in the record so the client can read it. |
| `probe`                   | A bash command, run after the seed in `/workspace` in the restored VM. It passes when it exits `expect_rc` and its output matches every regex in `expect`.                                                                                                                             |
| `description`, `tools`    | The template's entry as clients list it. The build also requires each tool in `tools` (plus `bash ls cat base64 file`, the guest agent's own) to be in the image, and refuses one that is not (gating rule M3, `governance/GATING-RULES.md`).                                          |
| `etc_hosts_sha256`        | Optional. If set, the build stops unless the rootfs's `/etc/hosts` has this sha256.                                                                                                                                                                                                    |
| `probe_status`            | Optional, an image builder's note. `unmeasured` or `none` means nobody has measured the probe's expected result, and the build refuses the spec.                                                                                                                                       |

Other fields are ignored, so an image builder may add its own (for example `notes`,
`proved_in_vm` and `source_record_digest`).

**The probe must be shareable.** For a benchmark, use a public test target, never the tests that
grade a fix: their names and counts are answer-key material. The probe proves that the image's
toolchain works in a microVM, not that the task is solvable.

**Commands run through `bash -c`.** The guest agent runs every command, the probe's included,
with bash. A client that wraps one in `sh -c` may fail on an image whose `/bin/sh` is dash (for
example, a `source` in a SWE-bench test command).

### SWE-bench templates from an image builder's records

An image builder's per-instance gate records may carry the spec under `template` (as the sample
gate record, `examples/django__django-11133.gate-record.json`, does), so nothing needs to be written
by hand:

```bash
jq '.template' django__django-11133.gate-record.json > django__django-11133.json
```

- **The id rule:** the instance id lower-cased, with `__` replaced by `-`. A Verified image whose
  instance is also in Lite gets a `-v` suffix. Every id fits 31 characters.
- **Probes:** a record whose `probe_status` is `unmeasured` or `none` is refused by the build
  (and by rule M9): it waits for a measurement. Any other value, or none, builds; the image
  builder's measured ones are `vm` (in a real microVM) and `emulation` (in its guest emulation).

## 1-2. Build and probe (the KVM host)

```bash
sudo deploy/sbx/template-onboarding/template-build.sh SPEC --kernel /path/to/vmlinux [--agent <checkout>/remote-worker] \
  [--vmm firecracker|cloud-hypervisor] [--registry HOST] [--egress-ca /etc/sbx/egress/ca.crt] \
  [--gate-record FILE [--gate-commit SHA]] [--keep-image] [--force]
```

`--gate-record` is the image's gate record from its builder.
The build checks it before pulling: its gate passed, it is for this image, the spec's
`source_record_digest` is this image's digest, and, for a spec that skips the git identity check, it
shows commits refused. A spec that names a `source_record_digest` must be built with it. The template
record then carries `gate_record`, the evidence and the record's sha256 (with `--gate-commit`, the
builder's commit that holds it), for checking offline (gating rules X10 and X12,
[`governance/GATING-RULES.md`](governance/GATING-RULES.md)).

`--egress-ca` is for a template whose sandboxes use egress credentials (`egress: true` only): it bakes
the host's interception CA, from `install-host.sh --egress-ca-out`, into the snapshot, and the record
keeps its fingerprint ([RUNBOOK, guest egress](../RUNBOOK.md#guest-egress)). Only an operator's
build bakes a CA: the host agent's self-serve builds pass no `--egress-ca`.

It needs root, podman logged in to the image's registry, the kernel the host's workers run, and
`SBX_MIN_FREE_GB` (default 50) free under `$SBX_SRV` (default `/srv/sbx`). A 4 GiB guest's snapshot
is 7.3-13.6 GB (the guide's §9), and the image and rootfs take more space while it builds.

What it does:

1. Checks the spec and the free disk.
2. Pulls the image by digest (removing it afterwards unless it was already there, or with
   `--keep-image`) and checks the digest it got.
3. Runs `build-rootfs.sh`, then the `/etc/hosts` check, then `build-snapshot.sh` with the spec's
   flags and `--verify-command`. That runs the seed and the probe in a VM restored from the new
   snapshot. A failed probe publishes nothing, and the log shows the last of its output.
4. Writes the record.

It touches no worker, unit or cluster. A 4 GiB SWE-bench guest took 140-515 s per snapshot, image
pull included, on the host the guide's §9 describes; the probe adds its own run time.

**Names:**

| What      | Name                                                                |
| --------- | ------------------------------------------------------------------- |
| Snapshot  | `$SBX_SRV/snapshots/<id>-<first 12 hex of the digest>`              |
| Worker id | `sbx_<id with - as _>_<the same 12 hex>`                            |
| Record    | `$SBX_SRV/templates/<snapshot>.json` (schema `moca-sbx-template/1`) |

A new image is a new snapshot and a new worker. A re-run with the same spec skips a snapshot that
is already built; `--force` rebuilds it.

**The record** is the spec's fields plus `worker`, `snapshot`, `manifest_hash`, `built_at` and
`min_budget_mb`: the smallest `--budget-mb` that holds one session, `(guest + 32) × 3 + 1024` MiB.
It holds no secret. Copy it to the operator's machine. It stays on the KVM host too, at
`$SBX_SRV/templates/<snapshot>.json`: `install-host.sh` points the worker at it (`SH_TEMPLATE_RECORD`), and
the worker refuses to start if the record does not match its snapshot.

## 3. Register (the operator's machine)

```bash
deploy/sbx/template-onboarding/template-register.sh --env-file <env file> RECORD           # prints the setup.sh to run
deploy/sbx/template-onboarding/template-register.sh --env-file <env file> RECORD --apply   # and runs it
```

It edits the env file's `SBX_WORKERS` line and the `SBX_TEMPLATES_FILE` list, nothing else, and
writes each file whole. A re-run with nothing new changes nothing.

- **A new id** adds the worker and the entry.
- **A known id** is a versioned update: the entry moves to the new worker, and the old worker stays
  in `SBX_WORKERS`, so the sandboxes it serves keep working.

It refuses an env file whose `SBX_WORKERS` is not one plain line, and one that sets
`SBX_EGRESS_HOSTS`. Edit those by hand ([RUNBOOK](../RUNBOOK.md) §5).

`setup.sh` mints the worker's token and writes its bundle. A template change rolls the control
plane only, so running commands on other templates carry on.

## 4. Install the worker (the KVM host)

Copy the bundle `deploy/sbx/.generated/workers/<worker id>` to the host (it holds a token; copy it
by path, delete the copy after), then:

```bash
sudo deploy/sbx/install-host.sh <bundle> --snapshot <snapshot> --budget-mb <at least min_budget_mb> [--no-egress]
```

`template-build.sh` and `template-register.sh` both print this line with the record's values.
`--no-egress` follows the spec's `egress: false`. The worker reads its guest RAM from the
snapshot's manifest. A budget below one session is refused. Each extra 13408 MiB holds one more
4 GiB session warm.

**Size `--budget-mb` for the commands run at once on this template**, not for one session: a
running VM is charged its full guest size, so the minimum fits about two at once, and a third is
refused at admission (`memory-budget: …`). Allow (guest + 32) × (running VMs) + 1024:
17536 MiB for four 4 GiB VMs, as used for two agents working one template at once. Clients retry a
command refused before it started and exit 75 if every try is refused (125 is any other failure).

## 5. Check it live

`deploy/sbx/templates-check.sh` (RUNBOOK §14) lists the templates and creates a sandbox of each. It
shows that each one's commands run on that template's worker, and that a token for one template
cannot reach another's.

For a template with a probe, set `SBX_CHECK_PROBE_<ID>` to a command that prints `yes` only on that
image. For a SWE-bench template, for example, check the testbed's baseline commit and the
testbed's python.

## 6. Update and retire

A new image for a template: write the spec with the new digest, then steps 1-5 again. The record
names a new worker, and registering it moves the template there. The old worker keeps its token,
and its live sandboxes keep working.

Once the old worker serves no live sandbox (`GET /v1/janitor/sandboxes` lists each live sandbox's
`wrk`), retire it:

```bash
deploy/sbx/template-onboarding/template-register.sh --env-file <env file> --retire <old worker id> --apply
sudo deploy/sbx/install-host.sh --uninstall <old worker id>       # on its host
```

Removing a template entirely is `--remove <id>`. Its sandboxes stop working at once.

Both workers hold their snapshot's memory file until the old one is retired, so the host needs room
for both.

**On a deployment with the template store and host agents, a client does this itself through the
API** (template lifecycle spec §5; shown end to end on a deployment): a new build (`POST
/v1/templates/{id}/builds`), `default` moved onto it (`mocactl sbx templates tag ID default --build
B`), then the old build retired (`mocactl sbx templates retire ID --build OLD`). The new build is a
new snapshot and a new worker, and the host agent installs no worker: an operator installs it
(steps 3-4, with the record's `snapshot`; [RUNBOOK](../RUNBOOK.md#the-template-host-agent)). A
retire is refused while a sandbox or session still uses the build (`409 build_in_use`); after it, the
host agent removes the worker and the snapshot, once 600 s have passed since its last sandbox ended
(`retire --wait` waits 900 s by default). Every step is a provenance record naming who did it.
The removal keeps the build's workspaces for the janitor (`install-host.sh --janitor`): without
it they stay on the host's disk.

## What a client does

1. Lists the templates (`mocactl sbx templates`, `GET /v1/templates`) and creates a sandbox of one
   (`mocactl sbx create --template <id>` or `sbx up --template <id>`, `POST /v1/sandboxes {template}`).
   An unknown id is `400 unknown_template`. Without `--template`, `mocactl` asks for the template
   `default`, so on a deployment that lists no `default` a client must always name one.
2. Seeds the sandbox: `mocactl sbx create --template <id> --seed` on a deployment with the
   template store (the build's seed, then a clean-tree check; the seeded HEAD becomes the
   baseline), or the template's `seed` as its first command. The seed is in the record, and in the
   description for SWE-bench templates.
3. Works through `mocactl sbx` (`run`, `put`, `pull`) or an agent wired to `mocactl sbx mcp`
   (Claude Code, OpenCode: the [user guide](../../../docs/sbx/user-guide.md)).

**A template that brings its own repository (a seed), such as a SWE-bench template:** use
`sbx create`, not `sbx up`. `sbx up` pushes the client's repository into `/workspace`, `.git`
included, before the seed runs, so the workspace would not be the template's repository at its
baseline. So:

1. `mocactl sbx create --template <id> --seed --json` and keep the sandbox id (without the template
   store: `mocactl sbx create --template <id> --json`, then
   `mocactl sbx run --sandbox <id> -- bash -c '<seed>'`);
2. point the agent's MCP server at that sandbox: `mocactl sbx mcp --sandbox <id>` (for OpenCode,
   in `opencode.json`'s `mcp.sandbox.command`, keeping `sbx up`'s `tools` block that switches the
   local tools off);
3. after the run, take the agent's change: with `--seed`, `sbx pull` returns the changes since the
   seeded baseline; on a sandbox seeded by hand, take it from the sandbox, for example with
   `git diff --binary <baseline>` in `/workspace`, rather than `sbx pull`, which diffs against the
   client's repository.

A headless OpenCode run of a SWE-bench instance on SBX0 was driven this way.

Limits a long-running client meets:

- 3 live sandboxes per user and 40 in all by default (`SBX_MAX_PER_SUBJECT`, `SBX_MAX_TOTAL`);
- 2 commands in flight per sandbox (`SBX_MAX_INFLIGHT`);
- a template with `egress: false` has no network.

**A Moca Pi session on a template** (the combined control plane): the harness runs the seed itself,
from the pinned build's own spec (the turn's `sandbox.seed.source` is `build`), and each turn's result
carries the workspace's patch against the seed's baseline (`workspace.patch`, with its sha256 and
size). For `id@buildId`, `mocactl run --option sandboxTemplate=id@sha256:… "<prompt>"` (the
control plane's template store resolves it; the API form is `POST /v1/sessions
{sandbox:{template:"id@sha256:…"}}`), and delete the session when done. The [guide](GUIDE.md#a-session-pinned-to-a-build-end-to-end) has the whole path.
