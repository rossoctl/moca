# SBX0 sandbox service

The sandbox control plane, the sandbox relay and Redis in one namespace of a shared OpenShift
cluster. Three Routes reach them: **api** (edge TLS, the control plane: login and the sandbox
resource), **attach** (passthrough, KVM hosts' workers dial in) and **exec** (passthrough, clients'
`Exec` calls). Design:
[`docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md`](../../docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md).

This page is the install reference. Day-to-day operation (users, templates, key rotation, outages,
disk, status and upgrades) is [the runbook](RUNBOOK.md); onboarding a template from a container
image is the template onboarding folder, `deploy/sbx/template-onboarding/`; users have
[the user guide](../../docs/sbx/user-guide.md); the security gate's checklist is
[the security review](../../docs/sbx/security-review.md).

## 1. Cluster side

Needs `kubectl` logged in with edit rights in an **existing** namespace, `jq`, and an `openssl` that
makes Ed25519 keys (OpenSSL 1.1.1 or later; on macOS, `brew install openssl@3`). The namespace must
be **dedicated to SBX0**: the overlay's default-deny and relay NetworkPolicies would cut off anything
else running in it. Keep the inputs in a file outside the repo:

    SBX_NAMESPACE=<namespace>
    SBX_API_HOST=<api route host>
    SBX_ATTACH_HOST=<attach route host>
    SBX_EXEC_HOST=<exec route host>         # three distinct hosts
    SBX_IMAGE=<image ref>
    SBX_WORKERS="sbx_default sbx_py312"     # one worker id per template
    SBX_TEMPLATES_FILE=<templates.json>     # below
    SBX_GITHUB_CLIENT_ID=<client id>        # this deployment's own GitHub OAuth app (device flow)
    SBX_ALLOWED_SUBJECTS=github:<id>,github:<id>   # who may log in: numeric GitHub user ids
    SBX_ADMIN_SUBJECTS=github:<id>          # optional
    SBX_WORKSPACE_FS_GIB=<n>                # the KVM host's workspace filesystem size, in GiB

    deploy/sbx/setup.sh --env-file <file>

A subject is `github:` plus the numeric GitHub user id, not the login. Look one up with
`gh api users/<login> --jq .id`. A user who is not enrolled is told their own subject by
`mocactl sbx login`, so they can send it to you.

Optional inputs:

| Variable                               | Default             | Rule                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SBX_EGRESS_CREDENTIALS`               | off                 | `1` enables user-scoped egress credentials (`mocactl sbx credentials`); needs host steps after: [runbook](RUNBOOK.md#credential-injection---egress)                                                                                                                                                                                 |
| `SBX_REDIS_IMAGE`                      | the base's Valkey 9 | `repository[:tag]@sha256:<digest>`: the image Redis runs. Set it to Redis 7 for a namespace whose data a Redis 7.4 wrote: Valkey 9 cannot read RDB format 12, and its load aborts ([runbook §2](RUNBOOK.md#2-upgrading)). Unset, `setup.sh` refuses to run on a namespace whose `redis` StatefulSet runs an image other than Valkey |
| `SBX_LIFETIME_DAYS`                    | 7                   | 1-30; each worker's idle reclaim is set to this plus two days (below)                                                                                                                                                                                                                                                               |
| `SBX_TOKEN_TTL_MINUTES`                | 15                  | 5-60: a sandbox token's lifetime, the longest command, and the delete delay                                                                                                                                                                                                                                                         |
| `SBX_RETENTION_DAYS`                   | 14                  | 1-90: how long a deleted or expired sandbox stays in `mocactl sbx ls`                                                                                                                                                                                                                                                               |
| `SBX_MAX_PER_SUBJECT`, `SBX_MAX_TOTAL` | 3, 40               | live sandboxes per user, and in all                                                                                                                                                                                                                                                                                                 |
| `SBX_MAX_INFLIGHT`                     | 2                   | 1-8: `Exec` calls one sandbox may have in flight at the relay                                                                                                                                                                                                                                                                       |
| `SBX_WORKSPACE_IMAGE_MB`               | 2048                | each workspace's image size (`microvm-worker`'s `SH_WORKSPACE_IMAGE_MB`)                                                                                                                                                                                                                                                            |
| `SBX_{API,ATTACH,EXEC}_TLS_{CERT,KEY}` | none                | the Route's certificate; otherwise the router's (api) or a self-signed one                                                                                                                                                                                                                                                          |
| `SBX_JANITOR_WAIT_MINUTES`             | 60                  | how long after a sandbox ends the janitor frees its workspace (below)                                                                                                                                                                                                                                                               |
| `SBX_API_CA_FILE`                      | none                | a PEM CA the host janitor trusts for the API Route (below)                                                                                                                                                                                                                                                                          |

**Lease mode (SBX0.3)** has two control-plane settings
([lease-mode spec](../../docs/specs/2026-11-08-sbx-lease-mode-design.md) §8.1). `setup.sh` does not
set them yet, so a deployment runs with their defaults:

| Variable                    | Default    | Rule                                                                                                                                                                                                                                                                                      |
| --------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SH_SANDBOX_MODES_ALLOWED`  | `per-exec` | the modes a user may pick, a comma list of `per-exec`, `lease` and `lease+processes`. `per-exec` is always allowed, listed or not. Keep the default until the lease gate below is passed                                                                                                  |
| `SH_SANDBOX_IDLE_CEILING_S` | 1800       | the longest lease idle timeout an owner may set, in seconds; at least 30, or the control plane refuses to boot. An owner who sets none gets the worker's default, 300 s. The worker also clamps with its own `SH_LEASE_IDLE_CEILING_S` (default 1800), so raise it together with this one |

**Lease mode stays off by default.** It stays off until plan 4's live smoke test passes and the
[SBX security review](../../docs/sbx/security-review.md) has its lease section (lease-mode spec
§11). A microVM worker serves lease mode on its own once its snapshot advertises `lease-v1`, so the
control plane's list is the only switch. After that gate, an operator opts in to level 1 with
`SH_SANDBOX_MODES_ALLOWED=per-exec,lease`. Keep `lease+processes` off until the security review
covers it.

Narrowing the policy downgrades existing sandboxes at their next token mint, so the list stays the
switch for sandboxes created before the change. Remove `lease` from `SH_SANDBOX_MODES_ALLOWED` and
the next sandbox token (or `mode-token`) minted for a lease sandbox first sets it to `per-exec` at a
new epoch, which ends its live lease at the next Exec; the control-plane audit log shows a
`sandbox_mode_changed` with `reason: mode_not_allowed`. A lowered `SH_SANDBOX_IDLE_CEILING_S` clamps
the idle timeout of every token minted after it, without changing the sandbox's record.

The relay needs nothing new for lease mode: it verifies set-mode tokens with the sandbox token
keyset and issuer it already has.

The templates file lists one template per worker in `SBX_WORKERS`. A template id is lower-case
letters, digits and dashes, and unique; `tools` is what `mocactl sbx` shows:

```json
[
  {
    "id": "default",
    "worker": "sbx_default",
    "description": "bash, git, Python 3",
    "tools": ["bash", "git", "python3"]
  },
  { "id": "py312", "worker": "sbx_py312", "description": "Python 3.12", "tools": ["python3.12"] }
]
```

The run refuses, before applying anything, when `SBX_MAX_TOTAL` × `SBX_WORKSPACE_IMAGE_MB` exceeds
80 % of `SBX_WORKSPACE_FS_GIB`: the quota is the disk control.

Re-run it after any change; tokens, the signing key and certificates are kept. A change to any
setting, the public keyset or a route certificate rolls the control plane and the relay, which read
them only at boot.

**One namespace per SBX stack.** The run refuses a `moca-mu1` Secret it did not create: a moca
control plane's signing key, in a shared namespace or copied in. The two stacks also mint API tokens
under different issuers, so neither accepts the other's.

**Rotating the signing key is a hard cut.** The keyset holds only the current key, so there is no
overlap window. Delete `moca-mu1` and re-run: every API token and sandbox token already issued is
refused at once. Refresh tokens are not signed and survive, so `mocactl sbx` gets new ones on its
next call, but an Exec in flight fails, and a direct client must fetch a new sandbox token.

**Changing `SBX_LIFETIME_DAYS` means reinstalling every host's workers.** The control plane takes
the new lifetime at once, but a running worker keeps the idle reclaim (`SH_WORKSPACE_IDLE`) it was
installed with until `install-host.sh` is re-run on its host. After a raise, that idle can be shorter
than a live sandbox's lifetime, and the worker would reclaim its workspace. So the run refuses a
lifetime that changes the idle in the bundles it last wrote, unless `SBX_ACK_HOSTS=1` is set. To
raise it, ideally re-run `install-host.sh` on every host first, with bundles made from the new value;
otherwise set `SBX_ACK_HOSTS=1` and reinstall every host right after the run, which names them.
The check reads the bundles in `deploy/sbx/.generated/workers/`: keep that directory between runs
(it is gitignored), or the run cannot see the idle the hosts were given.

**Delete and de-enrollment are not immediate.** A sandbox token already issued keeps working until
it expires, plus the relay's 30 s clock leeway: up to `SBX_TOKEN_TTL_MINUTES` plus 30 s after a
`mocactl sbx rm`, or after a subject is removed from `SBX_ALLOWED_SUBJECTS`. An `Exec` still running
when that token expires is cancelled. Raising `SBX_TOKEN_TTL_MINUTES` allows longer commands at the
cost of a slower delete.

Without
`SBX_{ATTACH,EXEC}_TLS_CERT/KEY` those Routes use self-signed certificates: the attach one ships in
every worker bundle, and the control plane hands the exec one to clients.

**Upgrading from 1a:** unset `SBX_CLIENTS` (the run refuses it), and move `SBX_IMAGE` off the
team-only 1a image (built from `sbx/relay-1a`): its relay requires the harness exec token, and its
control plane has no sandbox profile. The run deletes the static client tokens and their bundles,
and removes the relay's harness exec token once the new relay is up. Run it with `SBX_ACK_HOSTS=1`,
because every 1a host must be reinstalled anyway, then re-run `install-host.sh` with the new worker
bundles, which now carry the workspace idle time and image size; it refuses a 1a bundle. **1a
workspaces are not migrated:** a 1b sandbox has a workspace key of its own, which no 1a workspace
matches, so tell 1a users to pull their work out before the upgrade.

**The API Route's certificate:** with `SBX_API_TLS_CERT/KEY` the run patches the certificate and
key onto the Route itself, never into the applied overlay or a file left on disk. OpenShift keeps an
edge Route's key in its spec, so anyone who can read Routes in the namespace (`view`) can read it:
give that role only to operators. Without them the API Route uses the router's
default certificate. If that certificate is not publicly trusted (a self-signed or internal-CA
wildcard), `mocactl sbx login` fails its TLS check: users then need `NODE_EXTRA_CA_CERTS=<ca.pem>`
in their environment.

**The janitor's wait** (`SBX_JANITOR_WAIT_MINUTES`) defaults to 60 minutes, or
`SBX_TOKEN_TTL_MINUTES` + 5 when that is longer. The run refuses a wait that does not exceed the
token lifetime plus 30 s: a deleted sandbox's last token must have expired before its workspace is
freed. The janitor calls the API Route from the KVM host. If that Route's certificate is not
publicly trusted, set `SBX_API_CA_FILE` to its CA, which is shipped in the janitor bundle.
Otherwise every janitor run logs `skipped`.

## 2. KVM host side

The host needs what `deploy/microvm/P4-ON-P6.md` lists for P4 (`/dev/kvm`, Firecracker, jailer),
SBX0's own `microvm-worker` build at `SBX_WORKER_BIN` (below), `/usr/local/bin/moca-egress` (the
install refuses without it, unless `--no-egress`) and outbound TCP 443 to the attach host. Build each template's snapshot under
`/srv/sbx/snapshots/<image>` with `deploy/microvm/build-snapshot.sh`, then per worker:

    scp -r deploy/sbx/.generated/workers/<id> <host>:sbx-<id>
    ssh <host> sudo <checkout>/deploy/sbx/install-host.sh sbx-<id> --snapshot <image> [--budget-mb N]
    ssh <host> rm -r sbx-<id>

The worker's guest RAM comes from the snapshot's `manifest.json`, and `--budget-mb` (default 8192)
must hold one session of it: (guest RAM + 32) × 3 + 1024 MiB, 13408 for a 4096 MiB guest. SBX0's
workers run their own `microvm-worker` build, `SBX_WORKER_BIN` (default
`/usr/local/libexec/sbx/microvm-worker`, built from the same tree:
`CGO_ENABLED=0 go build -o /usr/local/libexec/sbx/microvm-worker ./remote-worker/cmd/microvm-worker`),
never the `/usr/local/bin/microvm-worker` that `deploy/microvm`'s P4 worker runs; a missing one is
refused.

The script waits up to `SBX_ATTACH_TIMEOUT` (120 s) for the worker's attach to hold. A newly added
worker's token reaches the relay only when the kubelet syncs the Secret, about a minute, so the first
attaches may be refused. Re-running it restarts the worker once, with the new env file.
By default it enables the worker's unit, so every host boot starts every installed worker. Under a
host agent, which starts and stops workers from the control plane's wanted state, run it with
`SBX_WORKER_AT_BOOT=0`: the unit is installed and started once as usual but not enabled for boot,
so a boot starts no worker and the agent starts the ones it should. Only `0` and `1` (the default)
are accepted; any other value, an empty one included, is refused before the host is touched. A
re-install applies the value it is given: with `0` it disables a unit an earlier install enabled.
It also installs `moca-egress.service` (one per host, the guests' allowlisted egress proxy; allowlist
in `/etc/sbx/moca-egress.env`) before the first worker: [the runbook](RUNBOOK.md#guest-egress).
It installs `/usr/local/libexec/sbx-reap-vms.sh` too, the unit's `ExecStopPost=`: a worker's VMs run
in `pool-N` cgroups beside the unit's own, which a stop does not reach, so after every exit it kills
those of that worker's slice and waits for them to empty ([the runbook](RUNBOOK.md#10-a-kvm-host-outage)).
`install-host.sh --uninstall <id>` is the undo: it removes everything the install recorded in
`/etc/sbx/manifest` for that worker (its unit instance, slice, env file and CA). The last uninstall on
a host also removes the shared `sbx-worker@.service`, `sbx-reap-vms.sh` and `sbx.slice`. Workspace data under
`/srv/sbx/workspaces/<id>` and its jail `/srv/sbx/jail/j<12 hex of the id>` is kept; remove it by hand when no sandbox needs
it.

**A template's snapshot and worker from a container image** are what
`deploy/sbx/template-onboarding/template-build.sh` (on the KVM host: the snapshot, checked in a
microVM, and a template record) and `template-register.sh` (on the operator's machine: the record
into `SBX_WORKERS` and the templates file) do, as [the runbook's §5](RUNBOOK.md#5-adding-updating-and-removing-a-template)
describes. Size `--budget-mb` for the commands that may run at once on the template, not for one
session ([the runbook's §9](RUNBOOK.md#9-limits-operators-must-know)). After a template change,
`deploy/sbx/templates-check.sh` checks that each template's sandboxes run on its own worker
([the runbook's §14](RUNBOOK.md#14-checking-the-templates)).

**The janitor** frees the workspaces of ended sandboxes (spec §8.3). Install it once per host, from
the bundle `setup.sh` writes to `deploy/sbx/.generated/janitor`:

    scp -r deploy/sbx/.generated/janitor <host>:sbx-janitor
    ssh <host> sudo <checkout>/deploy/sbx/install-host.sh --janitor sbx-janitor
    ssh <host> rm -r sbx-janitor

It needs `jq` and `curl` on the host. It installs `/usr/local/libexec/sbx-janitor.sh`,
`/etc/sbx/janitor.env` and `/etc/sbx/janitor.token` (0600; the token is in that file only) and
enables `sbx-janitor.timer`, which runs every 15 minutes. Each run asks the control plane for its
live and terminated sandboxes, then, in each of this host's worker roots, it removes:

- the workspace of a sandbox terminated more than the wait ago;
- an unknown workspace (no record at all) left unmodified for longer than the worker's
  `SH_WORKSPACE_IDLE`;
- `.reclaiming-*` trees older than an hour.

It renames each tree out of the workspace name space before removing it. It keeps everything else,
and touches nothing when the control plane is unreachable. Each run logs one JSON summary line:

    journalctl -u sbx-janitor -o cat | grep '"janitor":"summary"' | tail -1

Uninstalling the last worker leaves the janitor in place. `install-host.sh --uninstall-janitor`
removes it. Re-run `--janitor` with a new bundle after changing `SBX_JANITOR_WAIT_MINUTES`,
`SBX_API_HOST` or `SBX_API_CA_FILE`.

## 3. Status

`deploy/sbx/status.sh --env-file <file>` reports, read-only, which workers are attached, the live
and retained sandboxes, and the last hour's Exec latency and error rate from the relay's audit lines.
On a KVM host, `sudo deploy/sbx/status.sh --host` reports the units, the workspace disk and the
janitor's last run (see [the runbook](RUNBOOK.md#8-status-and-the-audit-lines)).

## 4. Users

Users log in with GitHub, then bring a repository up in a sandbox; [the user guide](../../docs/sbx/user-guide.md)
covers it end to end:

    mocactl sbx login --control-plane-url https://<api host>
    cd <repository> && mocactl sbx up

To call the gRPC API directly, see [the direct-client guide](../../docs/api/sandbox-v1-direct-client.md).
