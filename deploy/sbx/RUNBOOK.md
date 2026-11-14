# SBX0 operator runbook

> **Preview.** The SBX0 sandbox service is implemented for an internal cohort, but not yet
> declared Stable; interfaces and limits may change.

For the operators of an SBX0 deployment: the sandbox control plane, the relay and Redis in one
namespace of a shared OpenShift cluster, and template workers plus the janitor on a KVM host. The
install reference (every input and its rule) is [the deploy README](README.md); users have
[the user guide](../../docs/sbx/user-guide.md). The design is
[the SBX0 spec](../../docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md) (§8 for
operations).

Throughout, `<env file>` is the operator's settings file outside the repository (README §1),
`<host>` a KVM host, `<checkout>` this repository on that host, and `<id>` a worker id. Keep
`deploy/sbx/.generated/` between runs: `setup.sh` reads the bundles it last wrote there (it is
gitignored).

## 1. Deploy from scratch

1. **The namespace.** An existing namespace, dedicated to SBX0, where you have edit rights.
2. **A GitHub OAuth app** of this deployment's own, with device flow enabled: its client id is
   `SBX_GITHUB_CLIENT_ID`.
3. **The snapshots.** On the KVM host, one golden snapshot per template, built with
   `deploy/microvm/build-snapshot.sh --out /srv/sbx/snapshots/<image>`
   ([P4-ON-P6](../microvm/P4-ON-P6.md) has the full command). Every curated template carries `bash`,
   `git`, `tar` and `ripgrep`.
   Build them with a `build-snapshot.sh` from P4.1 or later: an older snapshot has no guest egress
   listener (see [Guest egress](#guest-egress)). The host also needs `/usr/local/bin/moca-egress`
   (`CGO_ENABLED=0 go build -o /usr/local/bin/moca-egress ./remote-worker/cmd/moca-egress`); the
   worker install refuses without it, unless you pass `--no-egress`. And SBX0's own worker binary,
   `CGO_ENABLED=0 go build -o /usr/local/libexec/sbx/microvm-worker ./remote-worker/cmd/microvm-worker`
   (`SBX_WORKER_BIN`): the install refuses without it, and never runs
   `/usr/local/bin/microvm-worker`, which a P4 worker on the same host may run.
4. **The cluster side.** Write `<env file>` (README §1 lists every input; the required ones are
   `SBX_NAMESPACE`, `SBX_API_HOST`, `SBX_ATTACH_HOST`, `SBX_EXEC_HOST`, `SBX_IMAGE`, `SBX_WORKERS`,
   `SBX_TEMPLATES_FILE`, `SBX_GITHUB_CLIENT_ID`, `SBX_ALLOWED_SUBJECTS` and `SBX_WORKSPACE_FS_GIB`),
   then:

   ```bash
   deploy/sbx/setup.sh --env-file <env file>
   ```

   It generates every token, key and certificate once and keeps them, applies the overlay, waits for
   the rollouts, and writes one worker bundle per `SBX_WORKERS` id plus the janitor bundle under
   `deploy/sbx/.generated/`.

5. **Each worker,** on its KVM host:

   ```bash
   scp -r deploy/sbx/.generated/workers/<id> <host>:sbx-<id>
   ssh <host> sudo <checkout>/deploy/sbx/install-host.sh sbx-<id> --snapshot <image> [--budget-mb N]
   ssh <host> rm -r sbx-<id>
   ```

   It waits up to 120 s for the worker's attach to hold (`SBX_ATTACH_TIMEOUT`). The worker's guest
   RAM (`SH_GUEST_RAM_MB`) is taken from the snapshot's `manifest.json` (`guest_ram_mb`), never set
   by hand: a snapshot without it is refused. `--budget-mb` (default 8192) must hold at least one
   session, (guest RAM + 32) × 3 + 1024 MiB at the unit's standby depth of 2: 13408 MiB for a
   4096 MiB guest. A smaller budget is refused, naming the minimum. The worker runs
   `SBX_WORKER_BIN` (default `/usr/local/libexec/sbx/microvm-worker`, [README](README.md#2-kvm-host-side)).
   When `<image>` was built by `deploy/sbx/template-onboarding/template-build.sh`, its template record
   (`/srv/sbx/templates/<image>.json`) is wired into the worker env (`SH_TEMPLATE_RECORD`,
   `SANDBOX_TEMPLATE`), so the worker checks the record against its snapshot at every start; a record
   for another worker is refused before anything is written.
   On a host run by a host agent, run it as `sudo SBX_WORKER_AT_BOOT=0 <checkout>/deploy/sbx/install-host.sh ...`:
   the worker is started once but not enabled for boot, so a reboot leaves starting workers to the
   agent's wanted state instead of starting all of them.

6. **The janitor,** once per KVM host:

   ```bash
   scp -r deploy/sbx/.generated/janitor <host>:sbx-janitor
   ssh <host> sudo <checkout>/deploy/sbx/install-host.sh --janitor sbx-janitor
   ssh <host> rm -r sbx-janitor
   ```

7. **Check it** with [status](#8-status-and-the-audit-lines): every worker attached, the janitor
   timer active, then log in as a user and run `mocactl sbx doctor` in a repository.

**Which `mocactl` users install.** Since v0.7.0 the default channel, the latest release, carries
`mocactl sbx`, as [the user guide](../../docs/sbx/user-guide.md#2-install) says:

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh
mocactl sbx --help    # the first line: usage (the sandbox service, SBX0):
```

A `mocactl` older than v0.7.0 has no `sbx`: its `mocactl sbx --help` prints the general
`usage:` list, and a bare `mocactl sbx` says `unknown command "sbx"`. Such a user re-runs the
install line above (or with `MOCACTL_VERSION=edge` for the newest build of `main`).

The increments' inputs, for an older deployment: 1a had `SBX_CLIENTS` (static tokens; now refused)
and no sandbox profile; 1b added the control-plane inputs (`SBX_API_HOST`, `SBX_GITHUB_CLIENT_ID`,
`SBX_ALLOWED_SUBJECTS`, `SBX_TEMPLATES_FILE`, the lifetimes and quotas); 1c adds the janitor
(`SBX_JANITOR_WAIT_MINUTES`, `SBX_API_CA_FILE`) and nothing else that is required.

## 2. Upgrading

**An image upgrade** (a new `SBX_IMAGE`): set it in `<env file>` and re-run `setup.sh`. A changed
image rolls the control plane and the relay, and so does a change to what the relay reads (the
token issuer, `SBX_MAX_INFLIGHT`, the signing keyset, the attach or exec certificate). Workers keep
running, and reattach when the relay comes back; Execs running through the old relay pod end with it
(the worker kills a dropped stream's Execs), so apply those when nothing long is running. Any other
setting (templates, subjects, quotas, lifetimes) rolls the control plane alone, and running Execs
carry on.

**From 1a:** unset `SBX_CLIENTS` (the run refuses it), move `SBX_IMAGE` off the team-only 1a image,
and run with `SBX_ACK_HOSTS=1`, because every 1a worker bundle lacks the workspace idle time and
must be reinstalled:

```bash
SBX_ACK_HOSTS=1 deploy/sbx/setup.sh --env-file <env file>
```

Then re-run `install-host.sh` with the new bundle for every worker (step 5 of §1); it refuses a 1a
bundle. The run deletes the static client tokens and removes the relay's harness exec token. **1a
workspaces are not migrated:** tell 1a users to pull their work out first.

**The worker binary.** `install-host.sh` runs SBX0's own build at `SBX_WORKER_BIN` (default
`/usr/local/libexec/sbx/microvm-worker`), no longer `/usr/local/bin/microvm-worker`: build it there
(§1 step 3) before re-running `install-host.sh` on a host installed before, or the install refuses.
A new worker binary takes effect when its workers restart.

**Redis's image and its data.** Since #670 the base runs Valkey 9, which **cannot read RDB format
12**, the format Redis 7.4 writes. On a namespace whose data a Redis 7.4 wrote, Valkey's AOF load
aborts (`Can't handle RDB format version 12`) and `redis-0` crash-loops, taking the control plane
down with it. Until a migration exists, keep such a namespace on Redis 7: set `SBX_REDIS_IMAGE` to
the digest it ran, e.g.
`docker.io/redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499`
(the pin before #670). With `SBX_REDIS_IMAGE` unset, `setup.sh` now refuses, before it applies
anything, when the namespace's `redis` StatefulSet runs an image other than Valkey, and names that
image. Before any Redis image change, take a copy of `/data` (`BGSAVE`, then
`dump.rdb` and `appendonlydir`). The StatefulSet is OrderedReady: a `redis-0` that crash-loops on
the old revision is never replaced, so `setup.sh`'s rollout wait times out. Then delete the pod
(`kubectl -n <namespace> delete pod redis-0`; its PVC stays) and re-run `setup.sh`.

**Redis's memory limit.** `setup.sh`'s `redis.conf` sets `maxmemory 200mb` with
`maxmemory-policy noeviction`, under the container's 256 MiB limit: a full Redis refuses writes (the
control plane answers `503 redis_unavailable`) and evicts nothing, instead of being OOM-killed with
every session and sandbox record. A new namespace gets it at Redis's first start. An existing one
does not: the Secret's change does not restart `redis-0` (the StatefulSet has no settings hash), so
apply it live, `kubectl -n <namespace> exec redis-0 -c redis -- redis-cli CONFIG SET maxmemory
209715200` and `… CONFIG SET maxmemory-policy noeviction` (`REDISCLI_AUTH` is set in the container),
or let the next restart read the file. Check with `CONFIG GET maxmemory`. A namespace that raises
the container's memory limit should raise `maxmemory` with it.

**A host bundle change.** Re-run `install-host.sh` with the new worker bundle whenever `setup.sh`
says so, and `install-host.sh --janitor` with the new janitor bundle after a change to
`SBX_JANITOR_WAIT_MINUTES`, `SBX_TOKEN_TTL_MINUTES` (its default wait follows the lifetime),
`SBX_API_HOST` or `SBX_API_CA_FILE`. `status.sh --host` warns when a host's installed janitor wait
no longer exceeds the token lifetime plus 30 s.

**A worker installed before the jail path was keyed by a digest of the id** has its jail at
`/srv/sbx/jail/<id>`; a reinstall moves it to `/srv/sbx/jail/j<12 hex of the id>`. Re-running
`install-host.sh` for that worker, or `--uninstall <id>`, removes the old `/srv/sbx/jail/<id>` (only that
path, once the worker is stopped) and logs `removed <path>`; its workspace data is not touched.

**Rolling a worker back past lease mode (plan 4), then forward again.** Every worker since plan 4
writes `<workspace root>/.lease-state/.boot` at boot, `lease=on` or `lease=off`; a lease-on boot
after a lease-off one first marks every known lease state `root_wrote`, because a lease-off worker
runs per-`Exec` commands as root without recording it. A worker binary from before plan 4 writes no
marker, so while a host runs one the marker can still say `lease=on`. A rollback alone is safe: the
old binary has no lease mode. Rolling forward again is safe too, as long as it goes through
`install-host.sh`: every worker install deletes `.lease-state/.boot` before it restarts the worker
(a symlinked marker goes as the link; a symlinked `.lease-state` is refused), so the first new boot
finds no marker and marks every known state, conservatively. A rollback done with an older
`install-host.sh` leaves the marker, and the next forward install clears it. Never roll forward by
replacing `SBX_WORKER_BIN` and restarting the unit alone; if that happened, stop the worker, delete
`/srv/sbx/workspaces/<id>/.lease-state/.boot`, and start it again.

## 3. Changing the sandbox lifetime

`SBX_LIFETIME_DAYS` (default 7) sets how long a sandbox lives, and each worker's idle reclaim,
`SH_WORKSPACE_IDLE`, is that plus two days. **A change means reinstalling every host's workers.**
The control plane takes the new lifetime at once, but a running worker keeps the idle it was
installed with until `install-host.sh` is re-run on its host; after a raise, that idle can be
shorter than a live sandbox's lifetime, and the worker would reclaim its workspace.

So `setup.sh` refuses a lifetime that changes the idle in the bundles it last wrote. Either
reinstall every host first, with bundles made from the new value, or:

```bash
SBX_ACK_HOSTS=1 deploy/sbx/setup.sh --env-file <env file>
```

and then, right after, re-run `install-host.sh` with the new bundle for each worker the run names.

## 4. Adding or removing a user

Users are `SBX_ALLOWED_SUBJECTS`: comma-separated `github:<numeric id>`, no spaces. Look an id up
with `gh api users/<login> --jq .id`. A user who is not enrolled is told their own `github:<id>` by
`mocactl sbx login`.

Edit the list and re-run `setup.sh`. The control plane rolls with the new list:

- **adding** takes effect as soon as the rollout ends;
- **removing** refuses every sandbox route (create, list, mint) at once, and the user's login at
  its next refresh. A sandbox token already issued keeps working until it expires: **within one
  token lifetime plus 30 s** (`SBX_TOKEN_TTL_MINUTES`, 15 minutes by default), and a command still
  running then is cancelled. The user's sandboxes are not deleted; delete them as an admin
  (`mocactl sbx ls --all`, `mocactl sbx rm --force <sandbox id>`) if their work must go. The
  `--force` is needed: `rm` first checks a sandbox for work not yet pulled, which takes a sandbox
  token, and an admin is never minted one for another user's sandbox.

Admins (`SBX_ADMIN_SUBJECTS`) may list, read and delete every sandbox, but never mint a token for
another user's: they cannot run commands in another user's code.

## 5. Adding, updating and removing a template

The template onboarding folder, `deploy/sbx/template-onboarding/` (its `GUIDE.md` and
`ONBOARDING.md`), is the long form, with the tools that do the steps below: `template-build.sh` (the
snapshot, checked in a microVM) and `template-register.sh` (the two lists).

A template is an id clients choose (`mocactl sbx create --template <id>`, `POST /v1/sandboxes
{template}`), served by one worker running one snapshot. A sandbox keeps the worker it was created
on for its whole life, whatever later happens to its template's entry.

**Adding a template:**

1. Build its snapshot on the KVM host (§1 step 3), named `<image>`. An image built from a container
   image for a benchmark (one that refuses agent commits, with a read-only rootfs) usually needs
   `build-snapshot.sh --skip-git-identity-check --guest-home /tmp/home`, and `--vcpus N
--guest-ram-mb M` for its size ([P4-ON-P6](../microvm/P4-ON-P6.md#build-the-golden-snapshot)).
2. Pick a worker id (`^[A-Za-z_][A-Za-z0-9_]*$`, say `sbx_node22`) and add it to `SBX_WORKERS`.
3. Add its entry, `{ "id", "worker", "description", "tools" }`, to `SBX_TEMPLATES_FILE`. One
   template per worker; every worker in the list.
4. Re-run `setup.sh`: it mints the worker's token and writes its bundle. It rolls the control
   plane but not the relay (§2), so running `Exec`s on every template carry on.
5. Install the worker with that bundle and `--snapshot <image>` (§1 step 5). A new worker's token
   reaches the relay when the kubelet syncs the Secret, about a minute, so its first attaches may be
   refused; `install-host.sh` waits. Pass `--budget-mb` for a guest larger than 256 MiB (§1 step 5,
   and §9 for concurrent use).
6. Check it with `deploy/sbx/templates-check.sh` (§14).

**Updating a template** (a new image or snapshot) is versioned: never re-point a worker that serves
sandboxes at another snapshot, or their commands change environment mid-work. Instead:

1. Build the new snapshot under a new `<image>` name.
2. Add a new worker id for it (say `sbx_node22_v2`) to `SBX_WORKERS`, keeping the old one.
3. Change the template's `worker` in `SBX_TEMPLATES_FILE` to the new id. The old worker serves no
   template now, but stays in `SBX_WORKERS`, so it keeps its token and its sandboxes keep working.
4. Re-run `setup.sh`, install the new worker (steps 4-5 above), and check it (step 6). New sandboxes
   of the template go to the new worker; existing ones stay on the old.
5. Retire the old worker once it serves no live sandbox: `GET /v1/janitor/sandboxes` (the janitor's
   token) lists each live sandbox with its `wrk`, and `mocactl sbx ls --all` (an admin) shows their
   templates. Then remove it as below.

Both workers hold their snapshot's memory file in RAM (it is the guest's whole RAM image) until the
old one is retired, so the host needs room for both.

**Removing a template** (or a retired worker) is the reverse of adding one: drop it from both lists,
re-run `setup.sh` (which revokes the worker's token and deletes its bundle; it cannot attach again),
then `sudo <checkout>/deploy/sbx/install-host.sh --uninstall <id>` on its host. Its sandboxes stop
working at once (no worker serves them): tell their owners to pull first. With egress credentials on
(`SBX_EGRESS_CREDENTIALS=1`), a worker that serves no template is no egress worker, so its
remaining sandboxes get no stored credential (as if their owners had none) and credentialed hosts
answer them `401` until it is retired.

**One control plane process per template store** (a deployment with `SBX_TEMPLATE_STORE=1`):
activation's quota and placement check and its lease write run under a lock inside the control
plane process, which is enough because one process owns the store: the Deployment runs one replica,
and the template store's volume is ReadWriteOnce with `strategy: Recreate`, so no second pod writes
it, even during a rollout. Keep it that way. A control plane with more than one replica, or a
rolling update, on one store would need a store-level lock.

**Self-serve templates and the policy** (a deployment with a template store and host agents, "The
template host agent" below): clients create their own templates with `POST /v1/templates`, gated by
the stored policy (`GET /v1/policy`), which only an admin changes (`PUT /v1/policy`, a `policy`
record). What an operator sets there:

- **Profiles**, the gate a create names: `base` (no gate record), `benchmark` (a gate record an admin
  trusts in `trustedGateRecords`), and the self-attested `benchmark-self` (offline) and
  `general-self` (the KVM host's allowlisted egress), which trust a subject's own gate record for its
  own templates only. A new image's default policy gains new profiles, but a stored policy does not:
  add them with one `PUT /v1/policy`, the whole policy as read plus the change.
- **Images:** `allowedRegistries` (`<default>` is the KVM host's own `SBX_REGISTRY`) and, per
  registry, `allowedRepositories`. Docker Hub is `docker.io`. **On a rollback to an image older than
  the repository allowlist, take `docker.io` out of `allowedRegistries` first:** an older image
  ignores `allowedRepositories`, so it would admit every Docker Hub repository.
- **Quotas:** `quota`, and `quotaBySubject` for an override.
- **What clients see of it:** `mocactl sbx policy`, `mocactl sbx quota` and `mocactl sbx hosts`;
  they create, follow and activate their templates with `mocactl sbx templates`
  ([the user guide](../../docs/sbx/user-guide.md), §8).

## 6. Rotating the signing key

The control plane signs sandbox tokens with one Ed25519 key, `SH_SESSION_TOKEN_PRIVATE_KEY` in the
`moca-mu1` Secret; the relay verifies with its public half, in `sbx-token-keys`. **`setup.sh` keeps
exactly one key:** every run rewrites `sbx-token-keys` with the current key alone, so a second key
added by hand is removed by the next run. Rotation is therefore a key replacement:

```bash
kubectl patch secret moca-mu1 -n <namespace> --type=merge \
  -p '{"data":{"SH_SESSION_TOKEN_PRIVATE_KEY":null}}'
deploy/sbx/setup.sh --env-file <env file>
```

Remove that one key only: `moca-mu1` also holds the janitor's token (`SH_JANITOR_TOKEN`), which
deleting the whole Secret would rotate too. The run generates a new key, publishes its public half
as the whole keyset, and rolls the relay and the control plane (both pods' settings hashes cover
the keyset). `setup.sh` does not keep the old key beside the new one, and nothing else does.

What users see: `mocactl` mints a fresh sandbox token for its calls, and re-mints once when the
relay refuses a token before the call started, so sessions carry on with the new key. A token
minted with the old key is refused by the new relay (an unknown key id): a direct client must run
its `SBX_TOKEN_CMD` again, and no old-key token outlives one token lifetime in any case. The relay's
rollout also ends the Execs running through it (the worker kills a dropped stream's Execs), so
rotate when nothing long is running. The gentler form of spec §4.3 (both keys in the keyset while
the signer switches) is not what `setup.sh` does.

**The janitor's token** rotates the same way, plus a restart, because the control plane reads it
only at boot and it is not in the settings hash:

```bash
kubectl patch secret moca-mu1 -n <namespace> --type=merge -p '{"data":{"SH_JANITOR_TOKEN":null}}'
deploy/sbx/setup.sh --env-file <env file>
kubectl rollout restart deployment/moca-control-plane -n <namespace>
```

Then re-run `install-host.sh --janitor` with the new janitor bundle on every host. Until then, each
janitor run there logs `skipped` (refused) and removes nothing.

## 7. The janitor

A systemd timer on each KVM host, every 15 minutes (`sbx-janitor.timer`). Each run asks the control
plane for the live and terminated sandboxes (`GET /v1/janitor/sandboxes`, with its own token) and,
in each of this host's worker roots, removes:

- the workspace of a sandbox terminated more than the wait ago (`SBX_JANITOR_WAIT_MINUTES`,
  default 60, or the token lifetime plus 5 minutes when that is longer);
- an unknown workspace (no record at all) left unmodified for longer than that worker's
  `SH_WORKSPACE_IDLE`;
- `.reclaiming-*` trees older than an hour.

It keeps everything else, and touches nothing when the control plane cannot be asked or answers
anything unexpected. The wait must exceed one token lifetime plus 30 s, so a deleted sandbox's last
token has expired before its files go; `setup.sh` refuses a shorter one, and `status.sh --host`
warns when a host's installed bundle predates a lifetime raise.

Each run logs one JSON line, `summary` or `skipped`, unless it refuses its own settings (a token
file with the wrong mode, a bad URL): then it exits 2 with the reason on stderr and no JSON line.
`status.sh --host` shows the service's result, so such a run shows as FAILED:

```bash
ssh <host> sudo journalctl -u sbx-janitor -o cat | grep '"janitor":"summary"' | tail -1
```

```json
{
  "janitor": "summary",
  "ts": "…",
  "examined": 4,
  "removed": 1,
  "unknown": 0,
  "bytes_freed": 4096,
  "errors": 0
}
```

`errors` counts what it kept because something did not check out (a missing worker env file, an
unreadable time); the lines before the summary say which. A `skipped` line says why (the control
plane unreachable, the token refused, a TLS failure: set `SBX_API_CA_FILE` if the API Route's
certificate is not publicly trusted).

Uninstalling the last worker leaves the janitor. Remove it with
`sudo <checkout>/deploy/sbx/install-host.sh --uninstall-janitor`.

## 8. Status and the audit lines

`deploy/sbx/status.sh` is read-only. It reads the audit lines of the relay's current pod only, so
right after the relay rolls (any `setup.sh` change that alters its settings or keys) the "last
hour" figures cover less than an hour. From a machine with `kubectl` access to the namespace:

```bash
deploy/sbx/status.sh --env-file <env file>
```

```
token lifetime: 900 s
workers attached: sbx_default sbx_py312
workers not attached: none
sandboxes live: 12
sandboxes terminated (retained, approx.): 31
exec last hour: 214 calls, p50 380 ms, p95 2140 ms, errors 1%
exec refused last hour: 2 refused, 5 busy
exec cut short last hour: 1 timeout, 0 expired, 3 cancelled
```

- **workers attached** reads the relay's presence records in Redis. A worker `not attached` serves
  no sandbox: its users see `no live worker for sandbox <id>`.
- **sandboxes terminated (retained, approx.)** is the deleted or expired sandboxes still listed
  (`SBX_RETENTION_DAYS`, default 14).
- **exec last hour** is from the relay's audit lines. A call is an Exec the relay routed; p50 and
  p95 are over those calls' durations; `errors` counts the relay's `error` outcome only (no live
  worker, a worker disconnect, a worker-side failure). A command's own non-zero exit is not an
  error. Refusals (a bad token, a wrong sandbox) and `busy` (the in-flight cap) are counted apart,
  as are calls cut short by a timeout, a token expiry or a client's cancel.

On a KVM host, as root:

```bash
sudo <checkout>/deploy/sbx/status.sh --host --token-ttl-seconds 900
```

```
unit sbx-worker@sbx_default.service: active
unit sbx-janitor.timer: active
workspace filesystem: 45% used, 90G of 200G (110G free) on /srv
janitor last run: {"janitor":"summary",…}
janitor wait: 3600 s (outlasts the token lifetime 900 s + 30 s)
```

Pass `--token-ttl-seconds` the cluster's `token lifetime`, or set `SBX_STATUS_HOSTS="<host> …"` (ssh
targets whose user has passwordless sudo) in `<env file>`, and the cluster-side run reports each
host too, with every line prefixed `host <host>`. The script is piped over ssh, so the host needs
no checkout for this.

**Reading the audit lines yourself.** The relay writes one JSON line per sandbox Exec to stdout
(spec §3.5), mixed with its other output, so select them first:

```bash
kubectl logs deployment/sandbox-relay -c sandbox-relay -n <namespace> --since=1h |
  grep -F '"audit":"sandbox_exec"' | jq -c 'select(.outcome != "end")'
```

Each line has `ts`, `wrk` (the worker), `req_id`, `ms`, `outcome`
(`end | timeout | expired | busy | error | cancelled | refused`) and `out_bytes`; `sub` and `sbx`
(the user and the sandbox) when the token verified; `exit_code` and `truncated` on `end`; and a
fixed `reason` on `refused`. No command text, output or token is ever logged. A refused `Abort` is
`"audit":"sandbox_abort"`. A `"audit":"sandbox_release"` line means a worker never ended an
expired Exec within 60 s of its abort, and the relay gave its slot back anyway: look at that
worker's host (a wedged guest, a stuck vsock). For a debugging session only, `SH_SANDBOX_AUDIT_COMMANDS=1` on the relay
adds each command's first 200 bytes as `cmd`.

## 9. Limits operators must know

- **The in-flight cap.** The relay admits at most `SBX_MAX_INFLIGHT` (default 2) Execs in flight
  per sandbox: one running, one waiting at the worker. More are refused as `busy` (users see
  "sandbox busy"). It keeps one user from filling a template's worker.
- **The deaf-worker slot hold.** When an Exec outlives its token, the relay cancels it and then
  waits for the worker's acknowledgement before freeing its in-flight slot. A wedged worker that
  never answers holds that slot until its attach stream drops: SBX0 has no bound on that drain, so
  with the default cap of 2, one wedged Exec halves the sandbox's concurrency until the worker
  disconnects. Restarting the worker (`systemctl restart sbx-worker@<id>`) drops the stream and
  frees every slot it held, and also ends every running Exec on that worker, for every user of the
  template.
- **Delete is not immediate.** A deleted sandbox (or a removed user) stays reachable for up to one
  token lifetime plus 30 s. Raising `SBX_TOKEN_TTL_MINUTES` allows longer commands at the cost of a
  slower delete, and needs a janitor reinstall (§2).
- **Disk is not admission-controlled on the worker.** The quotas are the disk control: `setup.sh`
  refuses `SBX_MAX_TOTAL` × `SBX_WORKSPACE_IMAGE_MB` over 80 % of `SBX_WORKSPACE_FS_GIB`.
- **A worker's budget is sized for concurrent use, not for one session.** `install-host.sh`'s
  smallest `--budget-mb` holds one session at the unit's standby depth of 2, (guest RAM + 32) × 3 +
  1024 MiB (13408 MiB for a 4096 MiB guest). A **running** VM is charged its full guest size and a
  paused standby only its dirty pages, so that minimum fits about two running VMs: a third command
  at once on the template is refused at admission before it starts (`memory-budget: …`, "template
  busy" to users). Size it for the commands that may run at once on the template, (guest RAM + 32) ×
  running VMs + 1024 MiB: for example 17536 MiB for four 4096 MiB VMs (two agents on one template,
  each with a command and a standby being promoted). The static clients (`remote-worker/cmd/sbx`,
  `docs/api/examples/sbx.py`) retry such a refusal and exit 75 if every try is refused. The
  worker's start-up warning (slots × per-VM size against the budget) is expected at any budget below
  its slot count.

## Guest egress

`install-host.sh` installs and starts one `moca-egress` per host (`moca-egress.service`) before the
worker, and wires every template worker to its control socket
(`MOCA_EGRESS_CONTROL_SOCK=/run/moca-egress/control.sock` in the worker env), with a drop-in
`sbx-worker@<id>.service.d/egress.conf` that orders the worker after `moca-egress`. A `--no-egress`
worker gets neither, so it never starts a `moca-egress.service` that the host has. A sandbox can
then reach only the hosts on the allowlist; everything else is refused with a named error
(`destination_denied`), never a timeout. No credential is involved.

- **The allowlist** is `MOCA_EGRESS_ALLOW` in `/etc/sbx/moca-egress.env`, a comma-separated list of
  hosts. It is seeded on the first install from `deploy/sbx/egress-allow.env` beside the installer
  (or from `MOCA_EGRESS_ALLOW` in the installer's environment, on the first write only) and is never
  overwritten by a re-run. To change it on one host, edit `/etc/sbx/moca-egress.env` and run
  `sudo systemctl restart moca-egress`; to change the default for new hosts, edit
  `deploy/sbx/egress-allow.env` in the repo (see its header for the format and the entry groups).
  Open tunnels end on the restart, new ones work at once. The same restart is needed after
  rebuilding the binary.
- **Another install's `moca-egress.service`.** A host that also runs `deploy/microvm`'s P6 worker
  already has one. If `/etc/systemd/system/moca-egress.service` exists and `/etc/sbx/manifest` has no
  `egress unit` line for it, `install-host.sh` logs
  `reusing the existing moca-egress.service (not installed by this script)`, wires the workers to its
  socket and touches nothing else. Its allowlist is then that install's
  `/etc/serverless-harness/moca-egress.env`.
- **`--no-egress`** installs a worker without `MOCA_EGRESS_CONTROL_SOCK` and installs no egress unit:
  the worker behaves as before egress existed, and the guest has no network.
- **Snapshot:** a golden snapshot built before P4.1 has no guest egress listener. Rebuild it with
  `build-snapshot.sh` for egress to work ([P4-ON-P6](../microvm/P4-ON-P6.md#guest-egress-p41-277)).
- **If it fails to start,** the install names `journalctl -u moca-egress` (often a bad
  `/etc/sbx/moca-egress.env`). Fix it and re-run `install-host.sh`.
- **Ownership is by content.** The manifest records a digest of the unit it installed. If another
  install (`setup-microvm.sh`) later replaces `moca-egress.service`, a re-run logs
  `changed by another install; reusing it` and leaves it alone, and the last uninstall keeps it.
- **Uninstalling** the last worker also stops and removes the `moca-egress.service` this script
  installed; an allowlist you edited stays (`kept ... (edited)`).

### Egress records

The [template host agent](#the-template-host-agent)'s wanted-state run (`sbx-host-agent-wanted`, every 15 s) also ships the proxy's audit
events to the control plane, where each lands in its sandbox's egress log: `mocactl sbx egress
[ID]`, or `GET /v1/sandboxes/{id}/egress`. Nothing to install: no new unit, timer or setting.

Paths are logged without query, fragment or userinfo, and an injected credential appears by name only, but a secret a guest puts in a URL path segment is logged as sent.

- **On or off:** on when `systemctl is-active moca-egress.service` says active, off otherwise (a
  `--no-egress` host, or a moca-egress not started). Active, not enabled: `install-host.sh` reuses a
  `moca-egress.service` another install owns (a P6 worker's) without enabling it, and that install may
  start it only for a while. So on such a host, whether the agent reads the proxy's journal follows
  that unit's state: while it runs for its own install, the agent reads its events every
  15 s, ships only this host's SBX0 sandboxes' (`egressSids`), and counts the rest `egressNotOurs`.
  Nothing of the other install's leaves the host, but check the unit's state before relying on it. Off, the agent reads no journal, posts nothing and writes no cursor; its summary
  says `"egress":"off"`.
- **Only this host's sandboxes' events leave it.** The wanted state names them (`egressSids`: the
  workspace keys of the sandboxes on this host's workers, live or ended within 600 s); an event with
  any other `sid`, such as a Moca P6 session's on the same proxy, stays in the journal and is only
  counted (`egressNotOurs`). The list is read before the journal, so a batch with a `sid` not in it
  (a sandbox created in between, at its first egress) reads the wanted state again, after the journal
  read, before anything is left out; if that read fails, nothing is sent and the cursor stays. The
  proxy's `audit_dropped` reports are sent. Against a control plane
  whose wanted state has no `egressSids` (older than openapi 1.14.0), the agent sends nothing and says
  so in an error line, keeping its cursor.
- **A time budget:** a run starts no new batch 120 s after its egress step began, so slow posts never
  hold the wanted unit (`TimeoutStartSec` 5 min) and its activations. The cursor stays at the last
  batch taken; the next run goes on.
- **It only reads.** The agent reads `journalctl -u moca-egress.service` and never starts, stops or
  configures `moca-egress`, so a failed post never blocks or changes a guest's egress.
- **Where it is:** the journal cursor after the last event the control plane took is
  `/srv/sbx/egress.cursor`; a batch being sent is `/srv/sbx/egress.pending.json` (both 0600). Without a
  cursor, the first run starts at this boot.
- **If a post fails** (the control plane down, a 5xx, or a 404 from one older than this): the summary
  counts an error (`egress post failed: the cursor stays, the next run retries (HTTP <code>)`), the
  cursor stays, and the next run re-sends the same batch first. The control plane takes a repeated
  batch once (idempotent by host and cursor). Up to 10 batches of 1000 entries per run.
- **A batch refused as malformed** (400 `invalid_request` or `invalid_json`) would fail every retry, so
  it is moved to `/srv/sbx/egress.rejected/<UTC time>-<pid>.json` (0600), the cursor moves past it, and
  the error names the file (`egressRejected` in the summary). Its events are not in any sandbox's log:
  look at the file, and fix the agent or the control plane.
- **A cursor the journal no longer has** (rotated away, or from another machine) is an error
  (`the journal cursor is no longer valid; restarting from this boot`). journalctl itself does not
  fail on one: it resumes at the nearest kept entry, or for another machine's cursor by time across
  boots, with exit 0. So before its first read the agent checks that the cursor still names an
  entry (`journalctl --cursor` starts at that entry); journalctl fails only on a cursor it cannot
  parse, which is the same error. Entries rotated away before they were sent are lost with the
  journal. The old cursor is kept as
  `/srv/sbx/egress.cursor.stale`, and shipping restarts from this boot's first entry. Entries already
  sent are skipped (`egressSkipped`), by `/srv/sbx/egress.mark` (the last sent entry's boot id and
  monotonic time): the control plane's replay check is by cursor, so it could not tell them apart.
  Without a mark, the restart re-sends this boot's entries, which the control plane stores twice; the
  agent says so in an error line (`no position mark`). Entries of an earlier boot that the old cursor
  had not reached are not read.
- **What is kept:** each event with its fields and values as the proxy wrote them (the agent decodes and
  re-encodes each one, so the bytes may differ, and the control plane stores its own canonical line), for as long as the sandbox record
  (`SBX_RETENTION_DAYS`). A log holds at most 10,000 events (`EGRESS_LOG_CAP`, about 3 MB), and all
  logs together at most 200,000 (`EGRESS_TOTAL_BUDGET`): with 256 MiB for Redis, egress logs take at
  most about 64 MB. The total counts the logs that still exist, so an expired log gives its share
  back. Each post reads the length of every retained log, so its cost grows with the number of
  sandboxes retained with a log: small at SBX0's scale.
- **Completeness:** an event over 8 KiB isn't sent (only its sandbox id is); the agent reads the journal with `--all`, so one up to 8 KiB is sent whole (without it journalctl prints a field over 4096 bytes as `null`). A journal entry whose message is not text (not UTF-8) cannot be read for its sandbox: the agent says so in an error line. A log's `dropped` counts
  those (`invalid`), events past its cap (`cap`) or past the total budget (`budget`), and the proxy's own `audit_dropped` reports, charged to every sandbox on
  the host's workers live within 60 s before each. `complete` is `dropped == 0`. The sandbox's end
  record (`sandbox`, `state: terminated`) names `egress: {events, sha256, dropped, droppedBy, complete}`; if events
  arrive in the 600 s after the end, a later `sandbox` record with `state: egress` names the final
  log. The grader decides whether an incomplete log still counts.
- **Check a saved copy offline:** wait until the log is sealed: `sealed` in `mocactl sbx egress ID`
  (`summary.sealed: true` with `--json`), 600 s after the sandbox ends. Until then the control plane
  still takes the sandbox's last events, and if the log changes, the janitor's seal writes a later
  `state: egress` record that a copy saved earlier no longer matches. Then save it with
  `mocactl sbx egress ID --ndjson > log.ndjson`, take the provenance export, and run
  `verify-provenance.py EXPORT.json --egress ID=log.ndjson`. (`mocactl sbx egress ID --verify` checks
  the log served against the control plane's summary of it, not against the end record; on an open
  log it says when events arrived while it read.)
- **Deploy the control plane first:** an older one answers 404 on the egress route, and the agent
  keeps its batch and retries.
- **To turn it off** on a host without disabling egress: there is no switch but the unit's state, by
  design. Roll back the host agent instead (`install-host.sh` with the previous tree).

### Credential injection (`--egress`)

Prerequisite for both procedures: set `SBX_EGRESS_CREDENTIALS=1` (and optionally `SBX_EGRESS_HOSTS`)
in `setup.sh`'s env file and run `setup.sh`. That writes `deploy/sbx/.generated/egress/<host id>/`
(`egress.env`, `egress.token`, optional `api-ca.crt`); pass that `<host id>` directory to `--egress`,
not its `egress/` parent. `--egress` generates the host's interception CA once (`/etc/sbx/egress/ca.crt`,
`ca.key`), writes the token (0600) and the drop-in `moca-egress.service.d/sbx-credentials.conf`, then
restarts `moca-egress`. It refuses a host whose `moca-egress.service` it did not install (the P6-owned
unit is configured by its own installer) and a host with no worker yet (the unit comes with the first
worker). `--egress-ca-out` prints the CA path (generating it if absent) and does nothing else. Once the
drop-in exists, a snapshot whose `manifest.json` `egress_ca_sha256` is missing or differs is refused
before systemd is touched.

**Fresh host** (no worker installed):

1. `sudo deploy/sbx/install-host.sh --egress-ca-out` (generates the CA).
2. `deploy/microvm/build-snapshot.sh --egress-ca /etc/sbx/egress/ca.crt --out /srv/sbx/snapshots/<image>`,
   or for a template, `template-build.sh SPEC --egress-ca /etc/sbx/egress/ca.crt ...`
   (`deploy/sbx/template-onboarding/ONBOARDING.md`).
3. `sudo deploy/sbx/install-host.sh WORKER_BUNDLE --snapshot <image>`.
4. `sudo deploy/sbx/install-host.sh --egress .generated/egress/<host id>`.

**Existing host** (worker already installed):

1. `sudo deploy/sbx/install-host.sh --egress .generated/egress/<host id>`.
2. `deploy/microvm/build-snapshot.sh --egress-ca /etc/sbx/egress/ca.crt --out /srv/sbx/snapshots/<new image>`.
3. Re-install each worker with `--snapshot <new image>`.

Between `--egress` and the reinstall, users with a stored credential see guest TLS failures on
intercepted hosts, because the old snapshot does not trust the new CA. Do the reinstall promptly. The
same applies to a CA rotation.

The default allowlist (`MOCA_EGRESS_ALLOW`) does not include `api.githubcopilot.com`. Add it to
`/etc/sbx/moca-egress.env` for the `github-mcp` preset, which otherwise gets `403 destination_denied`.

**Turning credential injection off.** Run `install-host.sh --uninstall-egress` on every KVM host
first, then run `setup.sh` with `SBX_EGRESS_CREDENTIALS=0`. With the cluster off, the lookup route is
unmounted (404); a host that still has the drop-in treats the 404 as an error and answers
`503 credential_unavailable` on every allowlisted request, including a plain `git clone` by users with
no credential. The PVC and the `sbx-egress` Secret stay, so a later on-run finds the stored credentials
again. The reverse rule: never run `--egress` against a cluster that is still off.

A re-run keeps the CA. To rotate it, delete `/etc/sbx/egress/ca.crt` and `ca.key`, re-run `--egress`,
then rebuild every snapshot (step 2). `--uninstall-egress` removes the drop-in, token and api CA and
keeps the CA, because existing snapshots were built with it.

## Snapshot read-ahead

A worker's cold start reads its snapshot's memory file (4 GiB for a 4 GiB guest) from `/srv/sbx`.
On a network block volume whose largest request is 128 KiB (`max_hw_sectors_kb`), the kernel's
default read-ahead of 128 KiB keeps too few reads in flight to reach the volume's throughput. One
measurement (one KVM host, a network volume rated 750 MiB/s and 3,000 IOPS, page cache dropped):
one reader of the memory files got 227 MiB/s at `read_ahead_kb` 128, 730 MiB/s at 512 and about
850 MiB/s at 1024, and four readers 435 and about 779 MiB/s (128, 512). Eight cold worker starts
posted at once, four at a time, were all active after 100.7 s at 128 (about 420 MiB/s) and after
62.2 s at 512 (736-742 MiB/s, the volume's limit), with the same 4.0 GiB read per start. Every
read stayed 128 KiB, at about 5,900-6,900 reads/s at 512 and above (about 5,950 in the cold starts): what bound it was reads in flight, not IOPS.

So `install-host.sh` sets the read-ahead of the device holding `/srv/sbx` to `SBX_READ_AHEAD_KB`
(default 512 KiB, at most 16384) and installs `sbx-read-ahead.service`, a oneshot enabled at boot
(a sysfs write does not survive a reboot) that the workers start after. It is enabled whatever
`SBX_WORKER_AT_BOOT` says: on a host whose workers a host agent starts, the boot still sets the
read-ahead before the agent starts any. It finds the device by path
at every run: a partition's read-ahead is its disk's, an LVM or dm device has its own. The value the
device had before the first install is kept in `/etc/sbx/read-ahead.orig`, and the last worker's
uninstall writes it back. A `/srv/sbx` on no block device (tmpfs, overlay), or a value the device
does not take, is a warning in the install output and in `journalctl -u sbx-read-ahead`, never a
failed install.

- **Check it:** `findmnt -no SOURCE --target /srv/sbx` names the device; for a disk or a dm device,
  `cat /sys/block/<dev>/queue/read_ahead_kb` (for a partition, its disk's).
- **It is device-wide.** Everything else on that volume (another Moca tier, other sandboxes, the
  host's own files if `/srv/sbx` is on the root disk) reads ahead as much. Read-ahead changes the
  size of the reads, not how many bytes a cold start reads; on local NVMe a smaller value may do.
- **Turn it off:** re-run a worker's install with `SBX_READ_AHEAD_KB=0`. That writes the recorded
  value back and removes the unit. A later install without `SBX_READ_AHEAD_KB=0` sets it again.

## 10. A KVM-host outage

**What users see.** Every sandbox whose template runs on the host fails: `mocactl sbx run` and the
agents' tools report `sandbox failure: … no live worker for sandbox <worker id>`, and
`mocactl sbx doctor` fails its `exec` check. Login, `ls` and `create` still work, because the
control plane runs in the cluster; a new sandbox fails the same way until the host is back.

**What to tell them.** The service is best effort, business hours. Their laptops keep the original
trees, and anything not yet pulled is on the host. If the host comes back with its disk, every
sandbox and its files are as they were (a worker restart keeps workspaces). If the disk is lost,
every sandbox on it is gone: they run `mocactl sbx rm --force` (`rm` cannot check a lost sandbox
for unpulled work, so it refuses without `--force`), then `mocactl sbx up`, and redo the work not
pulled.

**What to check.** `status.sh` (`workers not attached`), then on the host `status.sh --host` and
`journalctl -u sbx-worker@<id>`. A worker that crash-looped into `failed` is brought back by
re-running its `install-host.sh` (it resets the failed state).

**A VM left behind by a stopped worker.** A worker's Firecracker VMs run in `pool-N` cgroups under
its slice, `/sys/fs/cgroup/sbx.slice/sbx-<id>.slice`, beside the unit's own cgroup, so stopping the
unit does not kill them. The unit's `ExecStopPost=` does: after every exit (a stop, a crash, a stop
timeout) `/usr/local/libexec/sbx-reap-vms.sh <id>` kills each `pool-N` cgroup of that slice and waits
up to 10 s for it to empty, logging `sbx-reap-vms:` lines to `journalctl -u sbx-worker@<id>`. A
`still populated` line there, or a host installed before the step existed, can leave a VM holding its
guest memory until that worker next starts. With the worker stopped, find one by its cgroup:

```bash
grep -H . /sys/fs/cgroup/sbx.slice/sbx-<id>.slice/pool-*/cgroup.procs   # any pid here is a leaked VM
for p in $(pgrep -x firecracker); do echo "$p $(cut -d: -f3 "/proc/$p/cgroup")"; done   # every VM's cgroup
```

and reap it with `sudo /usr/local/libexec/sbx-reap-vms.sh <id>` (or
`echo 1 | sudo tee /sys/fs/cgroup/sbx.slice/sbx-<id>.slice/pool-<n>/cgroup.kill`). Never while the
worker runs: its `pool-N` cgroups then hold its live sandboxes' VMs.

## 11. The disk filling up

1. `status.sh --host`: the workspace filesystem line, and the janitor's last run.
2. If the janitor is `skipped` on every run, or its timer is not `active`, nothing is being freed:
   fix that first (§7).
3. If it runs but frees nothing, the disk is live sandboxes: `status.sh`'s `sandboxes live`, and
   `mocactl sbx ls --all` as an admin to see whose. Ask users to `mocactl sbx rm` what they no
   longer need.
4. Lower `SBX_MAX_TOTAL` (and `SBX_MAX_PER_SUBJECT`) and re-run `setup.sh`, so fewer sandboxes can
   exist; existing ones are not affected.

## 12. Uninstalling

On each KVM host:

```bash
sudo <checkout>/deploy/sbx/install-host.sh --uninstall <id>     # each worker
sudo <checkout>/deploy/sbx/install-host.sh --uninstall-janitor
```

They remove exactly what the installs recorded in `/etc/sbx/manifest`; the last worker's uninstall
also removes the shared `sbx-worker@.service`, `sbx-reap-vms.sh` and `sbx.slice`, and the `moca-egress.service` it
installed ([Guest egress](#guest-egress)). Workspace data under `/srv/sbx/workspaces/<id>` and its jail `/srv/sbx/jail/j<12 hex of the id>` (the uninstall names it) is left; remove it by hand.

In the cluster, delete what `setup.sh` applied, then its Secrets and ConfigMaps:

```bash
kubectl delete -k deploy/sbx/.generated
kubectl delete secret -n <namespace> moca-redis moca-relay moca-relay-sandbox-tokens moca-mu1 \
  sbx-token-keys moca-relay-tls sbx-exec-tls --ignore-not-found
kubectl delete configmap -n <namespace> moca-settings sbx-settings --ignore-not-found
rm -rf deploy/sbx/.generated
```

The Redis volume (the StatefulSet's `data` claim, `data-redis-0`) is kept by the delete. Remove it
with `kubectl delete pvc data-redis-0 -n <namespace>` to delete every sandbox record and every
login (the refresh families live there too).

## 13. Live smoke

`deploy/sbx/smoke.sh` runs the spec's live checks (§10.6) against a deployed service. Run it after
a deploy or an upgrade, and once for the 1c acceptance. Without `SBX_LIVE_SMOKE=1` it prints one
`SKIP` line and does nothing. It reads only the environment. It never logs in, never prints a
token, and deletes only the sandboxes it created in that run, even when it fails or is
interrupted.

**Prepare two logins, once.** You need two GitHub accounts, both enrolled (§4), because step 2
checks that one user cannot reach the other's sandbox. Each login lives in its own `HOME`:

```bash
mocactl sbx login --control-plane-url https://<api host>          # user A, in your own HOME
mkdir -p ~/sbx-smoke-b
HOME=~/sbx-smoke-b mocactl sbx login --control-plane-url https://<api host>   # user B
```

Log user B in from a browser session signed in to B's GitHub account (a private window works).
Both logins refresh themselves, so this lasts as long as a login normally does. Leave
`XDG_CONFIG_HOME` and `XDG_STATE_HOME` unset: the smoke runs `mocactl` with them unset.

**Run it:**

```bash
SBX_LIVE_SMOKE=1 SBX_API_URL=https://<api host> \
  SBX_SMOKE_HOME_A="$HOME" SBX_SMOKE_HOME_B=~/sbx-smoke-b \
  SBX_SMOKE_HOST=<host> deploy/sbx/smoke.sh
```

```
ok 1 - round trip: sbx up, run, put, pull --apply on a sample repository
ok 2 - two users: B is refused A's sandbox (404, PERMISSION_DENIED); one req_id from both gets each its own result
ok 3 - a command silent for 5 minutes completes
ok 4 - delete: the mint is refused at once; the kept token is cancelled at exp + leeway, then refused
ok 5 - claude fixes the failing test through mocactl sbx mcp; the tree is unchanged until pull --apply
ok 5 - opencode fixes the failing test through mocactl sbx mcp; the tree is unchanged until pull --apply # SKIP opencode not on PATH
ok 6 - the janitor frees a deleted sandbox's directory
ok 7 - egress credentials: the PAT works from the sandbox without being in it; the placeholder is inert; delete revokes # SKIP SBX_SMOKE_GITHUB_TOKEN_FILE and SBX_SMOKE_GITHUB_REPO not both set
ok 8 - lease mode: one guest across commands; an idle restart is noticed; reset and a downgrade end the lease # SKIP lease not allowed
```

It exits 0 when every step is `ok` or skipped, 1 when any step is `not ok` (the line gives the
reason), and 2 on a usage or settings error, before any sandbox is touched. On a failure it keeps its logs and prints their path. A full run takes about 25 minutes without
step 6: step 3 runs a command that is silent for 5 minutes, and step 4 waits for a token to expire
(one token lifetime plus the 30 s leeway). With step 6 it is closer to 70–90 minutes, because step 6
waits out the host's own janitor wait (`setup.sh` keeps it at `max(60, SBX_TOKEN_TTL_MINUTES + 5)`
minutes, so 65 min with 60-minute tokens). Step 8 adds about a minute where lease mode is allowed.

| Variable                                                                 | Default                                      | What it is                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SBX_API_URL`                                                            | (required)                                   | `https://<api host>`                                                                                                                                                                                                                                                                                                                                                   |
| `SBX_SMOKE_HOME_A`, `SBX_SMOKE_HOME_B`                                   | (required)                                   | the two logged-in `HOME`s; they must be two different users                                                                                                                                                                                                                                                                                                            |
| `SBX_SMOKE_GITHUB_TOKEN_FILE`, `SBX_SMOKE_GITHUB_REPO`                   | (unset: step 7 is a SKIP)                    | step 7: a file holding a GitHub PAT (a fine-grained one that can push to the repository; one trailing newline is ignored; never an environment variable) and `OWNER/REPO`                                                                                                                                                                                              |
| `SBX_SMOKE_CRED_TTL`                                                     | `60`                                         | the egress credential cache TTL (`SH_EGRESS_CREDENTIAL_TTL_SECONDS`); step 7 waits this plus 5 s after deleting the credential                                                                                                                                                                                                                                         |
| `SBX_SMOKE_GITHUB_MCP`                                                   | (unset)                                      | `1`: step 7 also checks the `github-mcp` preset (`api.githubcopilot.com` must be in the host's egress allowlist)                                                                                                                                                                                                                                                       |
| `SBX_SMOKE_CRED_TWO_USERS`                                               | (unset)                                      | `1`, with `SBX_SMOKE_HOME_B`: step 7 also checks that user B's sandbox gets a 401 and a public clone works; otherwise that check is a SKIP                                                                                                                                                                                                                             |
| `SBX_SMOKE_TEMPLATE`                                                     | `default`                                    | the template every sandbox is created from                                                                                                                                                                                                                                                                                                                             |
| `SBX_SMOKE_STEPS`                                                        | `1,2,3,4,5,6,7,8`                            | the steps to run; `1,2,5` leaves out the slow ones                                                                                                                                                                                                                                                                                                                     |
| `SBX_SMOKE_AGENTS`                                                       | `claude,opencode`                            | the agents step 5 runs, headless; one not on `PATH` is a SKIP. Each needs its own login and model configured                                                                                                                                                                                                                                                           |
| `SBX_SMOKE_HOST`                                                         | (unset: step 6 is a SKIP)                    | an ssh target (`[user@]host`) for the template's KVM host, with passwordless `sudo`                                                                                                                                                                                                                                                                                    |
| `SBX_SMOKE_HOST_ENV_DIR`, `SBX_SMOKE_HOST_SRV`, `SBX_SMOKE_HOST_LIBEXEC` | `/etc/sbx`, `/srv/sbx`, `/usr/local/libexec` | that host's `SBX_ENV_DIR`, `SBX_SRV` and `SBX_LIBEXEC_DIR`, if `install-host.sh` was given others                                                                                                                                                                                                                                                                      |
| `SBX_SMOKE_JANITOR_AGE`                                                  | the host's own `SBX_JANITOR_AGE`             | step 6's janitor wait. The one run frees **every** workspace on the host terminated longer ago than this, other users' too, so it can only be lengthened: a value below the host's wait (which `setup.sh` keeps above the token lifetime + 30 s) is refused. Step 6 waits until its own deletion is that old: the host's wait, 65 min by default with 60-minute tokens |
| `MOCACTL`                                                                | (unset: installed from the `edge` channel)   | a `mocactl` to test instead, such as a local build (`packages/mocactl/dist/mocactl.mjs`)                                                                                                                                                                                                                                                                               |
| `SBX_SMOKE_PYTHON`                                                       | `python3`                                    | Python 3.10+ with `grpcio` and `grpcio-tools` (steps 2 and 4 use `docs/api/examples/sandbox_v1_client.py`). It also runs the sample repository's tests locally                                                                                                                                                                                                         |

Step 7 (egress credentials, `SBX_EGRESS_CREDENTIALS=1`) runs alone with only user A's login:

```bash
SBX_LIVE_SMOKE=1 SBX_API_URL=https://<api host> SBX_SMOKE_HOME_A="$HOME" SBX_SMOKE_STEPS=7 \
  SBX_SMOKE_GITHUB_TOKEN_FILE=~/.sbx-smoke-pat SBX_SMOKE_GITHUB_REPO=<owner>/<repo> deploy/sbx/smoke.sh
```

`SBX_SMOKE_HOME_B` stays required for steps 1 to 6. Step 7 prints the PAT nowhere and passes it to
`mocactl` on stdin only; its trap deletes the credentials (`smoke-<ts>-<pid>-gh` and `-gh-mcp`, named
per run so two runs as the same user cannot revoke one another), the remote branch
`sbx-smoke-<ts>` and the sandboxes, even on failure.

Step 8 (lease mode, [lease-mode spec](../../docs/specs/2026-11-08-sbx-lease-mode-design.md) §13) also
runs alone with only user A's login. It needs a deployment that allows `lease` and a template whose
worker's snapshot advertises `lease-v1`. On the default deployment (`SBX_MODES_ALLOWED=per-exec`) the
create is refused with 403 `mode_not_allowed`, and the step is a SKIP (`# SKIP lease not allowed`):

```bash
SBX_LIVE_SMOKE=1 SBX_API_URL=https://<api host> SBX_SMOKE_HOME_A="$HOME" SBX_SMOKE_STEPS=8 \
  deploy/sbx/smoke.sh
```

`SBX_MODES_ALLOWED` is deployment-wide: listing `lease` for the smoke lets every enrolled user create
lease sandboxes. Until `docs/sbx/security-review.md` §6 is signed off, run step 8 on a test
deployment, or list `lease` for the run only and set `SBX_MODES_ALLOWED` back afterwards (§2's
re-run of `setup.sh`; the next token mint then moves any lease sandbox left to `per-exec`). The
create is an upgrade, which `mocactl` takes only from a terminal, so the step runs it under `script`
(util-linux `script -qec` on Linux, the BSD `script -q` on macOS), which must be on `PATH`.

What each step does:

1. Creates a sample repository with one failing test, runs `sbx up`, and checks that `sbx run`
   fails the suite. It `sbx put`s the fix and checks that the suite passes in the sandbox, that
   the local tree is unchanged and its suite still fails, and that the local suite passes after
   `sbx pull --apply`.
2. Checks that user B's `sbx token` and `sbx env` for A's sandbox both say `no such sandbox`, and
   that B's token with A's sandbox and workspace key is `PERMISSION_DENIED`. Then A and B each send
   the same `req_id` and the same command at once, each to a sandbox of their own from the same
   template, and each must read its own sandbox's file.
3. Runs `sbx run --timeout 400 -- sh -c 'sleep 300; echo survived'`, which must print `survived`.
4. Mints a token and keeps it, deletes the sandbox, and checks that the next mint is refused
   (`sandbox was deleted`) while the kept token still runs `true`. 20 s before the token's `exp` it
   starts a command that would run past `exp`. That command must be cancelled
   (`DEADLINE_EXCEEDED`) at `exp` plus 30 s. By this machine's clock, anything from 15 to 60 s after
   `exp` passes, to allow for clock skew.
   After that, the token must be refused (`UNAUTHENTICATED`).
5. For each agent, in a fresh sample repository after `sbx up`: `sbx doctor`'s agent-config check
   must pass. Then
   `claude -p "…" --mcp-config .mcp.json --strict-mcp-config` or `opencode run "…"` runs, with the
   smoke's `mocactl` first on `PATH` (logged in as user A) for the `mocactl sbx mcp` it starts. The
   flight recorder must show the agent's calls, and `git status --porcelain` must be the same as
   right after `sbx up`. The local suite must still fail, then pass after `sbx pull --apply`.
6. Deletes a sandbox (step 4's, if that ran), checks that its directory
   `<SBX_SRV>/workspaces/<worker>/<id>` exists on the host, and runs the installed janitor once:
   `ssh <host> sudo -n bash -s`, which sources `janitor.env` and then runs
   `/usr/local/libexec/sbx-janitor.sh` with the host's own `SBX_JANITOR_AGE` (or a longer
   `SBX_SMOKE_JANITOR_AGE`), after waiting until the deletion is that old. The installed timer
   and its settings are not changed. After the run, the directory must be gone.
7. Needs the two GitHub variables, else it is a SKIP. User A stores the PAT
   (`credentials add <run>-gh --preset github`, on stdin from the file). In A's sandbox it clones the
   repository, commits, pushes `sbx-smoke-<ts>` and deletes it, and checks that `gh api user` (or
   `curl`, without `gh`) names the PAT's owner. The placeholder sent from this machine must get a 401.
   User A deletes the credential, the step waits `SBX_SMOKE_CRED_TTL` + 5 s, and the sandbox must get
   a 401. Optionally `github-mcp`, and B's sandbox (401, public clone ok).
8. Creates a sandbox with `sbx create --mode lease --idle-timeout 30 --json` under `script`, and
   checks that its `set_mode` was applied and that `sbx get --json` shows the epoch known and no
   lease yet. It runs `sh -c 'echo warm > /tmp/lease-smoke'`, and then `cat /tmp/lease-smoke` must
   print `warm`: the same guest. After 45 s idle the same `cat` must fail
   (exit 1), with `[sandbox] guest restarted (idle, <HH:MM>): ...` on stderr. `sbx reset` must print
   `lease ended (reset)`, and after one more command `sbx mode per-exec` must print
   `lease ended (mode_change)`, both on stdout. Then it deletes the sandbox.

What it cannot check for you: the agents' own logs (kept on a failure) show whether an agent
fixed the test by the shortest route, or tried its local tools first and was denied. The
`no network in the guest` claim is not one of its steps (`docs/sbx/security-review.md` §2).

## 14. Checking the templates

`deploy/sbx/templates-check.sh` checks that a client chooses the template its sandbox runs on: the
list, a create of each template, each sandbox's token naming its own template's worker, a command in
each answering on its template's image, a token refused at another template's worker, and `sbx up`
refusing a bound sandbox of another template. Run it after adding or updating a template. Like the
smoke, it reads only the environment, never prints a token, and deletes only the sandboxes it
created; without `SBX_LIVE_CHECK=1` it does nothing.

```bash
SBX_LIVE_CHECK=1 SBX_API_URL=https://<api host> \
  SBX_CHECK_HOME_A=<home A> SBX_CHECK_HOME_B=<home B> SBX_CHECK_TEMPLATES=default,<template> \
  SBX_CHECK_PROBE_<TEMPLATE>='<a command that prints yes only on that template>' \
  deploy/sbx/templates-check.sh
```

The two `HOME`s are two enrolled users' logins, prepared as for the smoke (§13). Each
`SBX_CHECK_PROBE_<ID>` (the id upper-cased, dashes as underscores) runs in every template's
sandboxes: it must print `yes` in its own template's and anything else in the others'. For a
SWE-bench template, for example, check the testbed's baseline commit and the testbed's Python.
`SBX_CHECK_EXEC=0` checks the control plane alone, before any worker is installed. The direct-client
check (a token sent to another template's worker) needs `SBX_CHECK_PYTHON`, a Python 3.10+ with
`grpcio` and `grpcio-tools`, and is a SKIP without it. `--help` lists every input and check. It runs
on bash 3.2 too.

```
ok 1 - list: default, <template> (no worker ids)
ok 2 - create: one sandbox per template, each recording its template; an unknown template is refused (…)
ok 3 - routing: each template's sandboxes go to its own worker: default->… <template>->…; two default sandboxes share it, with their own workspaces
ok 4 - hands: each sandbox answers on its template's image: …
ok 5 - isolation: a default sandbox's token sent to <template>'s worker (…) is PERMISSION_DENIED
ok 6 - isolation: user B gets 'no such sandbox' for user A's default sandbox (env and token)
ok 7 - up: a repository bound to a default sandbox refuses sbx up --template <template>
```

It exits 0 when every check is `ok` or skipped, 1 when any is `not ok` (the line gives the
reason), and 2 on a usage or settings error, before any sandbox is touched.

## The template host agent

The self-serve template build of the
[template lifecycle spec](../../docs/specs/2026-11-03-template-lifecycle-and-provenance-design.md)
§6.1, and the activation of §6.3. `deploy/sbx/host-agent.sh --once` is one poll of a KVM host's
agent: it reports what the host holds, claims queued template builds (clients create them with
`POST /v1/templates`), runs `template-build.sh` on each with its gate record, and reports the
result; then it starts and stops installed workers by the host's wanted state. The control plane
registers or rejects each built build by policy; nobody approves it. It needs:

- on the control plane, the template store and this host's bearer: run `setup.sh` with
  `SBX_TEMPLATE_STORE=1 SBX_TEMPLATE_HOSTS='<host id> ...'`. It adds the store's PVC
  (`moca-sbx-templates`, mounted as `SH_PROVENANCE_DIR`; `SBX_TEMPLATES_FILE` is imported into it
  once), a token per host in the Secret `sbx-template-hosts` (`SH_HOST_TOKEN_<ID>`, generated once
  and kept; a host dropped from the list has its token revoked), and a bundle per host in
  `.generated/host-agent/<id>/` (`host-agent.env`, `host-agent.token`, and `api-ca.crt` with
  `SBX_API_CA_FILE`): copy it to the host as `/etc/sbx/host-agent.env` and
  `/etc/sbx/host-agent.token`, add `SBX_KERNEL` (and `SBX_API_CA_FILE`, if the bundle has a CA) to
  the env file, and delete the copy;
- on the host, `/etc/sbx/host-agent.env` (`SBX_API_URL`, `SBX_HOST_ID`, `SBX_KERNEL`, optionally
  `SBX_API_CA_FILE`, `SBX_DISK_FLOOR_GB`, `SBX_BUILD_CONCURRENCY`, `SBX_ACTIVE_LIMIT`,
  `SBX_IDLE_LIMIT_S`, `SBX_MEM_FLOOR_MIB`, `SBX_MEM_PRESSURE_LIMIT` (see "Memory-aware placement"
  below), `SBX_START_CONCURRENCY`, `SBX_START_WINDOW_S`, `SBX_IDLE_GRACE_S` (see "Cold-start
  pacing" below), `SBX_REGISTRY`), the token alone in `/etc/sbx/host-agent.token` (0600, root),
  the script at `/usr/local/libexec/sbx-host-agent.sh`, and in `/etc/systemd/system`
  `sbx-host-agent.service` with its timer (every 2 minutes) and `sbx-host-agent-wanted.service`
  with its timer (every 15 s, the wanted state alone); then `systemctl daemon-reload` and
  `systemctl enable --now sbx-host-agent.timer sbx-host-agent-wanted.timer`. The unit sets
  `SBX_TEMPLATE_BUILD` to the checkout at `/srv/sbx/src` (the agent cannot find it from
  `/usr/local/libexec`) and `REGISTRY_AUTH_FILE=/run/containers/0/auth.json` (it hides root's
  home): log root's podman in with `--authfile /run/containers/0/auth.json`. With `SBX_REGISTRY`
  set, no build is claimed until that file holds a login for it. The unit also gives Go a home and
  caches under `/srv/sbx` (`build-snapshot.sh` compiles the guest agent): run
  `install -d -m 0700 /srv/sbx/go /srv/sbx/home` first. Do not set `GOFLAGS=-mod=mod`: the
  repository is a Go workspace, which refuses it. Run a poll through the unit
  (`systemctl start sbx-host-agent.service`), not by hand: only the unit loads the env file.

It never claims a build below `SBX_DISK_FLOOR_GB` of free disk (default 60), claims at most
`SBX_BUILD_CONCURRENCY` builds a poll (default 1, at most 4), and checks a gate record's bytes
against their sha256 before building with it. The token stays in a 0600 header file, never in argv
or the log. A bad setting is refused (exit 2) before any call. Each run ends with one summary line,
`{"agent":"summary","claimed","built","failed","started","stopped","errors"}`, in the unit's
journal, with `"psi":"absent"`, `"sliceUnread":[...]` and `"memfileMismatch":<n>` when there is
something to say about memory, `"startQueued":<n>` when the start limit left wanted workers for a
later run, and `"graced":<n>` when the idle grace keeps any.

**Nothing that names where an image lives leaves the host.** A failed build's reason and its
uploaded log are redacted (`SBX_REGISTRY` exactly, then URLs, registry hosts, IP addresses and
12-digit account ids); the full log stays on the host in `/srv/sbx/agent-logs/` (0700). The reason
leads with a code a client can branch on: `pull_failed`, `probe_failed`, `disk_floor`,
`spec_refused`, `build_failed`, or `leak_refused` (step `report`): the template record or manifest,
which go byte for byte, names `SBX_REGISTRY`, so the build is reported failed and neither is sent.
Name the image in the spec without its registry; `SBX_REGISTRY` supplies it at the pull. A build
the agent claimed but cannot carry on with is reported failed `agent_error`, with the agent's own
fixed wording and its step (`gate`: a gate record it could not fetch, or whose bytes do not match;
`report`: a report the control plane did not take, or no template record or manifest after the
build), so it does not stay `building`. Text that
reached the store before a redaction rule existed is removed offline with
`template-onboarding/redact-provenance.py` (its `--catalog-only` mode for a build's stored log).

**Activation: the agent runs the workers the control plane wants.** A client takes a lease on a
registered build (`POST /v1/templates/{id}/activate`, or `mocactl sbx templates activate ID`), or a
sandbox create on an inactive build takes one (activation on first use: `409 template_not_active`
with `Retry-After`, retried by `mocactl`). A build is wanted running only while a lease stands. The
templates declared in `SBX_TEMPLATES_FILE` (`SH_SANDBOX_TEMPLATES`) are not affected: their workers
are the deployment's to run, they take no lease, and a create on one is never gated. Each
host's wanted state (`GET /v1/hosts/<id>/wanted`) lists the leased builds placed on it, at most
`SBX_ACTIVE_LIMIT` of them, in `run`, and the builds it holds with no lease and no live sandbox in
`stop`. After each build poll, and every 15 s in `sbx-host-agent-wanted.service` (`host-agent.sh
--wanted-only`: no claim, no build), the agent stops each `stop` worker whose unit is active, then
starts each `run` worker whose `sbx-worker@<id>` unit is installed and not active, and reports each start,
refusal and stop (`attached`, `refused`, `detached`) as provenance; readiness is the relay's
attached record, never these reports. A worker with a live sandbox is never stopped: it drains
first. A lock (`/srv/sbx/.activation.lock`) keeps the two units from starting or stopping workers at
once; the one without it skips, saying so. A host whose last inventory is over 6 minutes old (three
build polls) is left out of placement and of `GET /v1/templates`' hosts until it reports again, so
a stopped or removed agent takes no new placement and no slot. Size the limits:

- `SBX_ACTIVE_LIMIT` is the most workers the host runs at once: each pins its snapshot's guest
  memory whole from its start, with its standby VMs. With an agent that reports memory (below), the
  control plane also keeps new starts within the host's memory, so the limit is an upper bound, not
  a memory calculation. 0 (unset) places nothing on the host. Every worker that stays running
  counts against it: the leased builds placed or running on the host (the inventory says which
  units run; a running build stays on its host), and an unleased one still draining a live
  sandbox, until it stops.
- `SBX_IDLE_LIMIT_S` is the default lease length a client gets when it names none (the largest of
  the hosts' that hold the build, clamped to 60-86400 s; else 3600 s). A lease is renewed by activating again.
- The policy's `quota.active` caps the builds one subject holds a lease on at once
  (`429 quota_exceeded`, `quota: active`); `GET /v1/quota` shows the use.

A refused activation keeps no lease: `409 template_unavailable` (no registered build, no host
that reports holds it, or `reason: memfile_mismatch`) or `409 no_active_slot` with `Retry-After`
(every host holding it is at its limit with leased builds, or `reason: memory`; nothing leased is
evicted). The activation check and lease write run one at a time, under a lock in the control
plane's process: keep one control-plane process per template store (the Deployment's one replica,
the store's ReadWriteOnce volume).

**Memory-aware placement** ([template lifecycle spec](../../docs/specs/2026-11-03-template-lifecycle-and-provenance-design.md)
§6.2): each inventory also reports the host's memory, and the control plane starts a new worker on a
host only if the host has the memory for it, whatever `SBX_ACTIVE_LIMIT` says. `SBX_ACTIVE_LIMIT`
stays the upper bound. Nothing running is stopped: the rule only holds back new starts.

- **What the agent reports** (the inventory's `memory` object): `memTotalMib` and `memAvailableMib`
  from `/proc/meminfo`; `memPressureFull10`, the memory PSI line's **`full avg10`** from
  `/proc/pressure/memory` (a percentage: the share of the last 10 s in which every non-idle task was
  stalled on memory); the workers of held builds whose `sbx-worker@<id>` runs; per running worker,
  `vmCommittedMib`, its slice's `memory.stat` (`sbx.slice/sbx-<id>.slice`) anon + shmem + kernel:
  its VMs' memory the kernel cannot reclaim, never its page cache (a memory file is file-backed and
  mlocked, so the worker's cost counts it; **keep `/srv/sbx` on a disk volume, never tmpfs**: a
  memory file on tmpfs is shmem, and would be counted twice); and `memFloorMib`, **the effective
  floor**, so the number placement uses is in the inventory and in `GET /v1/templates`' hosts block
  (`memory.floorMib`), with no arithmetic.
- **`SBX_MEM_FLOOR_MIB`**: the memory never placed into, a whole number of MiB. Unset, it is 10% of
  MemTotal, at least 4096 (a host of 256 GiB: 26214 MiB). Set a fixed amount on a host shared with
  other work (Moca's own P6 sessions).
- **`SBX_MEM_PRESSURE_LIMIT`** (default 10): while `full avg10` is above it, the host takes no new
  start; what it runs is kept. **No `/proc/pressure`** (an older kernel, or `psi=0` at boot): the
  field is left out, which is **no brake**, never "no starts"; the agent's summary says
  `"psi":"absent"` once per run.
- Both live in `host-agent.env` (0600), never in argv. A bad value (a floor of 0, a leading zero, a
  limit that is not a number in (0, 100] with at most two decimals) is refused like the agent's
  other settings: exit 2, before any call.
- **A worker's cost** is its guest's RAM (the registered build's guest size, which registration
  checked against the manifest's `guest_ram_mb`) plus 128 MiB; a build with no recorded guest size
  counts at 4096 + 128. A host's headroom is `min(total − floor − used, available − floor −
pending)`, `used` being its running workers' cost, their VMs' committed memory and the starts
  placed there but not running yet. The hosts block shows `usedMib` and `headroomMib`.
- **A stale host** (its last inventory over 60 s old: four missed 15 s reports) takes no new start
  (`brake: stale`); one under pressure shows `brake: pressure`.
- **The memory-file check:** for each build it holds, the agent checks that the snapshot's
  `memfile` is exactly `guest_ram_mb × 1 MiB` (the manifest beside it). A worker pins that file
  whole, so a different size (a future Diff snapshot, a balloon, a trimmed file) would make its cost
  wrong. A mismatch is an error line naming the build, a `"memfileMismatch":<n>` count in the
  summary, and the build in the inventory's `memfileMismatch`: the control plane never places it on
  that host (`409 template_unavailable`, `reason: memfile_mismatch`, when every holder reports it),
  and the agent refuses to start it (reported `refused`). Rebuild the snapshot.
- **A slice it cannot read** (`memory.stat` missing, or with no `anon` line): that worker's VMs are
  left out of `vmCommittedMib`, never guessed, and the summary names it (`"sliceUnread":[...]`).
- **What a client sees:** an activation refused for memory is `409 no_active_slot` with
  `reason: memory` and the usual `Retry-After`; at the active limit it answers as before, with no
  reason. A build waiting for memory reads `readiness: unavailable` with `readinessReason: memory`
  (`mocactl sbx templates show ID`), and `mocactl sbx hosts` shows each host's headroom, floor and
  brake.
- **With the sandbox lease mode** (SBX0.3), a lease VM's guest memory is in its worker's slice, so
  `vmCommittedMib` counts it. Its reclaim acts on VMs and this floor on whole workers: on one host,
  set the floor at or above lease mode's reclaim target.
- **Version skew, both ways:** an agent older than memory-aware placement sends no `memory`, and
  the control plane places that host by `SBX_ACTIVE_LIMIT` alone, as before. A control plane older
  than it (openapi 1.12.0) ignores the field and places by `SBX_ACTIVE_LIMIT` alone; the agent still
  refuses to start a build whose memory file does not match. Upgrade either first; list both in the
  rollout.

**Cold-start pacing** ([template lifecycle spec](../../docs/specs/2026-11-03-template-lifecycle-and-provenance-design.md)
§6.5): before it attaches to the relay, a worker reads and locks its whole snapshot memory file, and
workers that start together share the host's disk. So the agent starts at most
**`SBX_START_CONCURRENCY`** workers at once (default 4).

- **What it caps:** workers **starting** (started, not attached yet), not running ones. It is not
  `SBX_ACTIVE_LIMIT`, which caps running workers. Each run starts at most `SBX_START_CONCURRENCY`
  less those still starting, oldest lease first, and leaves the rest for a later run (every 15 s);
  the summary counts them (`"startQueued":<n>`). A run never waits for a start to finish:
  `systemctl start` of the worker unit returns at once.
- **The setting:** a whole number, at least 1, in `host-agent.env` (0600), never in argv. **0 is
  refused** (exit 2, before any call), as is a leading zero or anything that is not a number.
- **Where "starting" comes from:** the control plane's wanted answer lists, in `starting`, the
  builds placed on this host whose worker the relay does not show attached. The limit is the
  agent's, so it holds **with an older control plane too** (openapi before 1.13.0, no `starting`):
  the agent then counts as starting the workers it started less than `SBX_START_WINDOW_S` ago
  (default 300) that are still running and wanted. Its starts are kept in `/srv/sbx/start-times`
  (0600).
- **A stuck start:** either way, a start counts for `SBX_START_WINDOW_S` at most. A worker still
  not attached after it (a crash loop, a hang, a relay it cannot reach) is stuck: each run says so
  in an error line (`worker <id> started <n> s ago and is not attached`) and it no longer holds a
  start slot, so the line moves. Look at that worker's unit (`journalctl -u sbx-worker@<id>`).
  Keep `SBX_START_WINDOW_S` above the host's slowest start in a full wave, or a slow start is taken
  for a stuck one and one more start shares the disk.
- **What it bounds:** each start's wait, not the total. The disk sets the total, at any width.
  Measured on one KVM host whose snapshots sit on a general-purpose cloud block volume (about
  125 MB/s), 4 GiB guests, starts measured after a release (cache not warm): cold starts one at a
  time took 78 s on average (at most 120 s), a wave of four about 3-4 minutes, and with 28 started at once the last attached
  after more than twenty minutes. Raise the limit only on a faster disk.
- **What the agent reports:** `startConcurrency` and `startSeconds` in the inventory's limits.
  `startSeconds` is the mean of its last 10 cold starts, start to attach, to within the 15 s poll
  (kept in `/srv/sbx/start-seconds`, 0600); it is absent until a start is done, and always with an
  older control plane. The hosts block of `GET /v1/templates` shows
  `start: {concurrency, seconds, starting, queued}` (`mocactl sbx hosts`).
- **What a client sees:** a build waiting for a start slot is `activating` with `queued: true` and
  its `queuePosition` (1-based, on its host). `409 template_not_active`'s Retry-After becomes
  `ceil(ceil(position / concurrency) × startSeconds)` once the host has measured a start, else 30 s
  as before. A queued activation stays `activating` longer than before, so **a client polls
  readiness with a timeout sized for the host's whole start line**;
  `mocactl sbx templates activate --wait` sizes its default from it
  (`(ceil(position / concurrency) + 1) × startSeconds × 1.25`, at least 1800 s, at most 4 h;
  `--timeout` wins).
- **Measure cold starts with the page cache dropped** (`echo 3 > /proc/sys/vm/drop_caches`, or
  after a reboot): a start right after its build, or after a recent stop, reads its memory file
  from the cache and looks much faster than a cold one.
- **Placement keeps a build on the host already running its worker** (no start at all; sticky),
  whether or not that host reports its memory; a graced build leased again stays there too.
- **The one change on upgrade:** a host whose agent is upgraded, with no new settings and whatever
  its control plane, now starts at most 4 workers at once instead of every wanted one; a wide
  activation starts in waves of `SBX_START_CONCURRENCY`, each about one start time long (a slot
  frees when a worker attaches, or, with a control plane older than 1.13.0, after
  `SBX_START_WINDOW_S`), so 28 builds at the default take about seven waves, many minutes, and a
  client's first Retry-After is the old 30 s until the host has measured a start. A control plane
  older than 1.13.0 ignores the new inventory fields; an older agent sends none, and the control
  plane then shows no queue and answers Retry-After as before.

**The idle grace** (part of cold-start pacing, openapi 1.13.0): a released worker can stay up for a
while, so a template used again soon is warm (no memory-file read at all).

- **The setting:** `SBX_IDLE_GRACE_S` in `host-agent.env` (0600), never in argv. **Default 0: off**,
  and the host behaves exactly as before: a build with no lease and no live sandbox is stopped at
  the next poll. A whole number of seconds, 0 to 86400, no leading zero; anything else is refused
  (exit 2, before any call). The inventory reports it (`limits.idleGraceSeconds`). It is a host
  setting, not a client's choice.
- **When to use it:** long enough to cover the gaps between a workload's rounds on the same
  templates. Leave it off where each task's cold start is what is measured, or use `stopNow`
  (below).
- **What it does:** after a build's last lease ends (its release, or the lease running out), the
  control plane keeps it in the wanted answer's `run` until that end plus `SBX_IDLE_GRACE_S`, and
  lists it in `graced`. It is graced only if its worker runs on the host (as the agent reports it),
  has no live sandbox, and the host has room for it: a slot under `SBX_ACTIVE_LIMIT` beside the
  workers the host counts (leased and draining ones) and memory-aware placement's headroom. The agent never starts a graced build; it only keeps one running. A use
  within the grace finds the worker attached and gets a sandbox at once (first use takes a lease;
  no `409`).
- **A wanted build that needs the slot** (or the memory) **displaces** the graced worker that ends
  soonest: it goes to `stop`. That is the only stop of a worker nobody asked to stop, and only of
  one with no lease. **At stop time the control plane re-checks that it is still unleased** (under
  the activation lock): a lease taken in between keeps it running. The agent logs such a stop as
  `{"agent":"stopped","worker":"<id>","was":"graced"}`.
- **`stopNow`, to force cold:** `POST /v1/templates/{id}/deactivate {"stopNow": true}`
  (`mocactl sbx templates deactivate ID --stop-now`) releases the caller's lease and, if no lease
  remains, skips the grace: the worker is stopped at the next poll. On a build already in its grace
  it ends the grace (`released: 0`). The `deactivate` record carries `stopNow: true`. Use it for
  one-by-one comparisons, so each task still measures its cold start.
- **Counting releases in the records:** a host's worker reports share record kinds with clients'
  calls: `attached` and `refused` are written as `activate`, `detached` as `deactivate`, each with
  subject `host:<id>` and the report in `body.event`. So a reader counting a client's releases or
  activations filters on the subject (or on `body.event` being absent).
- **What you see:** the agent's summary line gains `"graced":<n>` when it keeps any; the hosts block
  of `GET /v1/templates` shows `idleGraceSeconds` and `graced` (a count) per host with a grace
  (`mocactl sbx hosts`); a graced build reads `deactivating` with `graced: true` and `gracedUntil`
  (epoch seconds; `mocactl sbx templates show ID` says "graced until ...").
- **What it costs:** a graced worker still pins its **whole memory file** (it is a running worker).
  Memory-aware placement counts it in `memory.usedMib`, and it holds a slot of `SBX_ACTIVE_LIMIT`
  until a wanted build needs one. A host over its memory with its graced workers lets the
  soonest-ending go first.
- **Version skew:** an agent without the setting reports no `idleGraceSeconds`, which the control
  plane takes as 0 (off). A control plane older than 1.13.0 ignores the field, sends no `graced`,
  and stops released workers as before; the agent then just applies `stop`. **Roll out the control
  plane before setting `SBX_IDLE_GRACE_S` on a host**: the order is the control plane, then the
  agent, then the setting.

**A registered build's worker is still installed by an operator.** The agent builds, reports, and
starts and stops installed workers; it installs none, and a wanted build whose worker is not
installed is reported `refused` (`worker not installed`). A worker's relay token is minted only by
`setup.sh`, so for a new
template: add a worker id to `SBX_WORKERS` and the template to `SBX_TEMPLATES_FILE`, re-run
`setup.sh`, and install the worker on the host that built the snapshot, as in §5, with
`--snapshot <snapshot>` (the record's `snapshot`, `$SBX_SRV/templates/<snapshot>.json`).
`install-host.sh` then names the record in the worker's env (`SH_TEMPLATE_RECORD`) and its id as
`SANDBOX_TEMPLATE`, and the worker checks the record against its snapshot and its own id at every
start, refusing a mismatch. The worker runs SBX0's own binary, `SBX_WORKER_BIN` (default
`/usr/local/libexec/sbx/microvm-worker`: `CGO_ENABLED=0 go build -o
/usr/local/libexec/sbx/microvm-worker ./remote-worker/cmd/microvm-worker`), never
`/usr/local/bin/microvm-worker`, which a P4 worker on the same host may run; a missing one is
refused. Letting the agent obtain a worker token from the control plane is a follow-up.

Known limits: a claimed build is not re-queued if the agent dies mid-build (cancel it, `POST
/v1/templates/{id}/builds/{build}/cancel`, and create it again); one poll builds up to
`SBX_BUILD_CONCURRENCY` builds, and builds are not scheduled across hosts.

To remove the agent: `systemctl disable --now sbx-host-agent.timer sbx-host-agent-wanted.timer`,
delete the four units,
`/usr/local/libexec/sbx-host-agent.sh`, `/etc/sbx/host-agent.env` and `/etc/sbx/host-agent.token`,
and `systemctl daemon-reload`; drop the host from `SBX_TEMPLATE_HOSTS` and re-run `setup.sh` to
revoke its token.
