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
   worker install refuses without it, unless you pass `--no-egress`.
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

   It waits up to 120 s for the worker's attach to hold (`SBX_ATTACH_TIMEOUT`).

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
image, or any changed setting, rolls the control plane and the relay. Workers keep running, and
reattach when the relay comes back; Execs running through the old relay pod end with it (the worker
kills a dropped stream's Execs), so apply changes when nothing long is running.

**From 1a:** unset `SBX_CLIENTS` (the run refuses it), move `SBX_IMAGE` off the team-only 1a image,
and run with `SBX_ACK_HOSTS=1`, because every 1a worker bundle lacks the workspace idle time and
must be reinstalled:

```bash
SBX_ACK_HOSTS=1 deploy/sbx/setup.sh --env-file <env file>
```

Then re-run `install-host.sh` with the new bundle for every worker (step 5 of §1); it refuses a 1a
bundle. The run deletes the static client tokens and removes the relay's harness exec token. **1a
workspaces are not migrated:** tell 1a users to pull their work out first.

**A host bundle change.** Re-run `install-host.sh` with the new worker bundle whenever `setup.sh`
says so, and `install-host.sh --janitor` with the new janitor bundle after a change to
`SBX_JANITOR_WAIT_MINUTES`, `SBX_TOKEN_TTL_MINUTES` (its default wait follows the lifetime),
`SBX_API_HOST` or `SBX_API_CA_FILE`. `status.sh --host` warns when a host's installed janitor wait
no longer exceeds the token lifetime plus 30 s.

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

## 5. Adding a template

1. Build its snapshot on the KVM host (§1 step 3), named `<image>`.
2. Pick a worker id (`^[A-Za-z_][A-Za-z0-9_]*$`, say `sbx_node22`) and add it to `SBX_WORKERS`.
3. Add its entry, `{ "id", "worker", "description", "tools" }`, to `SBX_TEMPLATES_FILE`. One
   template per worker; every worker in the list.
4. Re-run `setup.sh`: it mints the worker's token and writes its bundle.
5. Install the worker with that bundle and `--snapshot <image>` (§1 step 5). A new worker's token
   reaches the relay when the kubelet syncs the Secret, about a minute, so its first attaches may be
   refused; `install-host.sh` waits.

Removing a template is the reverse: drop it from both, re-run `setup.sh` (which revokes the worker's
token and deletes its bundle; it cannot attach again), then
`sudo <checkout>/deploy/sbx/install-host.sh --uninstall <id>` on its host. Its sandboxes stop
working at once (no worker serves them): tell their owners to pull first.

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
as the whole keyset, and rolls the relay and the control plane (the settings hash covers the
keyset). `setup.sh` does not keep the old key beside the new one, and nothing else does.

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

## Guest egress

`install-host.sh` installs and starts one `moca-egress` per host (`moca-egress.service`) before the
worker, and wires every template worker to its control socket
(`MOCA_EGRESS_CONTROL_SOCK=/run/moca-egress/control.sock` in the worker env). A sandbox can then reach
only the hosts on the allowlist; everything else is refused with a named error (`destination_denied`),
never a timeout. No credential is involved.

- **The allowlist** is `MOCA_EGRESS_ALLOW` in `/etc/sbx/moca-egress.env`, a comma-separated list of
  hosts. It is seeded on the first install with `api.github.com,github.com,codeload.github.com,objects.githubusercontent.com`
  (or from `MOCA_EGRESS_ALLOW` in the installer's environment, on the first write only) and is never
  overwritten by a re-run. To change it, edit the file and run `sudo systemctl restart moca-egress`;
  open tunnels end, new ones work at once. The same restart is needed after rebuilding the binary.
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
2. `deploy/microvm/build-snapshot.sh --egress-ca /etc/sbx/egress/ca.crt --out /srv/sbx/snapshots/<image>`.
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
also removes the shared `sbx-worker@.service` and `sbx.slice`, and the `moca-egress.service` it
installed ([Guest egress](#guest-egress)). Workspace data under `/srv/sbx/workspaces/<id>` and `/srv/sbx/jail/<id>` is left; remove it by hand.

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
```

It exits 0 when every step is `ok` or skipped, 1 when any step is `not ok` (the line gives the
reason), and 2 on a usage or settings error, before any sandbox is touched. On a failure it keeps its logs and prints their path. A full run takes about 25 minutes without
step 6: step 3 runs a command that is silent for 5 minutes, and step 4 waits for a token to expire
(one token lifetime plus the 30 s leeway). With step 6 it is closer to 70–90 minutes, because step 6
waits out the host's own janitor wait (`setup.sh` keeps it at `max(60, SBX_TOKEN_TTL_MINUTES + 5)`
minutes, so 65 min with 60-minute tokens).

| Variable                                                                 | Default                                      | What it is                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SBX_API_URL`                                                            | (required)                                   | `https://<api host>`                                                                                                                                                                                                                                                                                                                                                   |
| `SBX_SMOKE_HOME_A`, `SBX_SMOKE_HOME_B`                                   | (required)                                   | the two logged-in `HOME`s; they must be two different users                                                                                                                                                                                                                                                                                                            |
| `SBX_SMOKE_GITHUB_TOKEN_FILE`, `SBX_SMOKE_GITHUB_REPO`                   | (unset: step 7 is a SKIP)                    | step 7: a file holding a GitHub PAT (a fine-grained one that can push to the repository; one trailing newline is ignored; never an environment variable) and `OWNER/REPO`                                                                                                                                                                                              |
| `SBX_SMOKE_CRED_TTL`                                                     | `60`                                         | the egress credential cache TTL (`SH_EGRESS_CREDENTIAL_TTL_SECONDS`); step 7 waits this plus 5 s after deleting the credential                                                                                                                                                                                                                                         |
| `SBX_SMOKE_GITHUB_MCP`                                                   | (unset)                                      | `1`: step 7 also checks the `github-mcp` preset (`api.githubcopilot.com` must be in the host's egress allowlist)                                                                                                                                                                                                                                                       |
| `SBX_SMOKE_CRED_TWO_USERS`                                               | (unset)                                      | `1`, with `SBX_SMOKE_HOME_B`: step 7 also checks that user B's sandbox gets a 401 and a public clone works; otherwise that check is a SKIP                                                                                                                                                                                                                             |
| `SBX_SMOKE_TEMPLATE`                                                     | `default`                                    | the template every sandbox is created from                                                                                                                                                                                                                                                                                                                             |
| `SBX_SMOKE_STEPS`                                                        | `1,2,3,4,5,6,7`                              | the steps to run; `1,2,5` leaves out the slow ones                                                                                                                                                                                                                                                                                                                     |
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

What it cannot check for you: the agents' own logs (kept on a failure) show whether an agent
fixed the test by the shortest route, or tried its local tools first and was denied. The
`no network in the guest` claim is not one of its steps (`docs/sbx/security-review.md` §2).
