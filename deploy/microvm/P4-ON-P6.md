# P4 microVM tier on a P6 host

> **Preview.** The P4 microVM tier is implemented but not yet declared Stable; see "Limits" below. Labels are
> explained in [Maturity and lifecycle](../../docs/reference/maturity-and-lifecycle.md).

The P4 Firecracker `microvm-worker`, installed on the same KVM host as a P6 deployment
(`deploy/vm/`). It attaches to P6's relay under its **own** relay token. Every tool call of every
session then runs in a fresh Firecracker microVM (#274), over a per-session workspace at
`SH_WORKSPACE_ROOT/<session id>`. The workspace persists between turns; the VM does not.

`setup-microvm.sh` is the sibling of `deploy/vm/setup-vm.sh`. It reads P6's installed files and
never writes one of them.

> **Read "Limits" before a demo.** A P4 guest has **no network**: `curl` and `git` to the internet
> fail inside it (#277). There is **no grant binding** either (MI1 S4).

## Container sandboxes and P4 on one host

A host may run the container sandboxes and the microVM worker together. Each session runs in ONE
tier for its whole life: the one it was created in (`mocactl run --new --option sandboxTier=microvm`,
or the New Session form), else the default, `container` (`SH_SANDBOX_DEFAULT_TIER=microvm` on the
`setup-microvm.sh` run changes it). `setup-microvm.sh` makes such a host tiered on its own: it writes
`microvm-tiers.env` and drop-ins that load it into `sh-supervisor` and `sh-control-plane`, then
try-restarts both. A P4-only host stays untiered.

A session also returns to the sandbox that served its previous turn. If that sandbox is briefly gone
(a relay restart), turns answer 503 and the client retries. If it stays gone past
`SH_SANDBOX_AFFINITY_GRACE_SECONDS` (60 s), the session moves to another sandbox of its tier, on a
fresh workspace, and the turn says so (`workspace reset: …`). Design:
`docs/specs/2026-10-04-p6-on-kubernetes-slice3-design.md`.

Every worker on a tiered host must be P6.3 or later: an older worker advertises no tier and is
excluded, with a log line naming it. On a host with container sandboxes, `setup-microvm.sh` checks
this before it writes anything: each **running** `sh-sandbox-*` container's presence record in Redis
must carry `moca.dev/tier=container`. It refuses a container whose record has no tier (a pre-P6.3
image) or another one, and one that is running but not attached, whose tier it cannot read. It also
refuses when Redis cannot be reached. A **stopped** container has no record to read: the run warns,
naming it, and goes on, so that container must already be P6.3 or later. `setup-vm.sh` never pulls:
its `podman run --replace` reuses the image the host already has, so an older host keeps its old
image. Upgrade the containers first, with the image P6 was installed with:

```bash
sudo podman pull ghcr.io/rossoctl/moca-remote-worker:latest  # or your SANDBOX_IMAGE
cd /opt/serverless-harness && sudo ./deploy/vm/setup-vm.sh     # --replace recreates them
sudo deploy/microvm/setup-microvm.sh                           # checks the tiers, then tiers
```

A container counts while it **exists**, running or stopped: `setup-vm.sh` runs them with
`--restart=always`, and `podman-restart.service` brings a stopped one back at boot. Re-run
`setup-microvm.sh` after adding or removing the container sandboxes, so the host's tiers follow.
`SH_SANDBOX_DEFAULT_TIER` is sticky: a re-run without it keeps the value in `microvm-tiers.env`, and
`SH_SANDBOX_DEFAULT_TIER=` (set, empty) clears it back to `container`. A bad value, given or stored, is
refused before anything is written. Going P4-only removes the file, and the stored default with it;
the run names a dropped default other than `container`. A default given on a host that ends up
untiered (P4-only, or `--remote`) is not recorded, and the run says so.

**To go P4-only (optional) on an installed P6:**

```bash
sudo podman rm -f $(sudo podman ps -a --format '{{.Names}}' --filter 'name=^sh-sandbox-')
cd /opt/serverless-harness && sudo SH_SANDBOX_COUNT=0 ./deploy/vm/setup-vm.sh
sudo deploy/microvm/setup-microvm.sh   # removes the tier files, try-restarts both units
```

The second command matters. Without `SH_SANDBOX_COUNT=0`, a later P6 re-run starts the containers
again, and the host is mixed once more. Removing the containers is the only way: a stopped one still
counts, for the reason above.

On a host installed **before** the control plane (#366), that `setup-vm.sh` re-run also installs it.
It generates the control plane's keypair and writes `SH_REQUIRE_AUTH=true` to `supervisor.env`,
which closes the unauthenticated `/turn` that "Run a turn" below uses. A plain `setup-vm.sh` re-run
(no `SH_SANDBOX_COUNT=0`) installs it just the same, on a host that keeps its containers.

**To go back to containers only (optional):**

```bash
sudo systemctl disable --now microvm-worker.service
sudo podman exec sh-redis redis-cli HDEL sh:sandbox:records moca_microvm_0
cd /opt/serverless-harness && sudo ./deploy/vm/setup-vm.sh   # default SH_SANDBOX_COUNT=2
```

A host that was tiered also needs the tier files removed, as in "Uninstall" below: with the microVM
worker gone, a session created in the `microvm` tier has no sandbox to run in.

## Prerequisites

- **`sudo` must find podman.** podman-static installs under `/usr/local/bin`, and on some hosts
  sudo's `secure_path` leaves that out. If `sudo podman version` says `command not found`, run every
  `sudo` command on this page as `sudo env PATH="/usr/local/bin:$PATH" …`, as `deploy/vm/README.md`
  does for `setup-vm.sh`. The verified host's `secure_path` included `/usr/local/bin`.
- **P6 installed and running** (`deploy/vm/README.md`). `setup-microvm.sh` needs its
  `relay.env`, `sh-relay.service` and the `sh-redis` container.
- **`/dev/kvm`**, cgroups v2 and no swap. Bare metal, or an instance type with nested
  virtualisation: the verified run used an `m8i.xlarge`.
- **Memory:** the shipped unit budgets 24 GiB for VMs and asserts at least 23G of physical memory,
  so it refuses to start on a smaller host. On a smaller host set `MICROVM_MAX_COMMITTED_MB` (see
  "Install"). The verified run used a 16 GiB host with an 8192 MiB budget.
- **Firecracker and the jailer** at `/usr/local/bin/firecracker` and `/usr/local/bin/jailer`, where
  the unit expects them. The verified run used Firecracker v1.17.0 from its release tarball.
- **Go** on root's `PATH`. `build-snapshot.sh` builds the guest agent, and `setup-microvm.sh` builds
  the worker and `moca-egress`, unless `MICROVM_BIN` and `MOCA_EGRESS_BIN` name prebuilt ones. To build
  the proxy by hand: `cd remote-worker && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w' ./cmd/moca-egress`.
- **A checkout that includes #375**, the harness fix for a new session's first turn. On a checkout
  from before it, every tool call in a new session's first `/turn` fails on this tier with
  `invalid-workspace-key: workspace_key "anon:<uuid>" must match …`, and turn 1's work lands in a
  workspace no later turn opens.
  - The cause was that `executeTurn` leased the sandbox before using the new session's id.
  - Authenticated `mocactl` turns were not affected: their session already exists.

## Build the golden snapshot

A microVM restores from one golden snapshot: kernel, rootfs, guest agent, and a paused VM's memory,
pinned by `manifest.json`. It is built **on the instance type that will run it**. Restore needs
identical hardware, so `build-snapshot.sh` records the type and the worker checks it at start.

**1. A guest kernel.** Firecracker's CI publishes one. This is its `getting-started.md` recipe,
kernel only:

```bash
ARCH="$(uname -m)"; S3="https://s3.amazonaws.com/spec.ccfc.min"
CI=$(curl -fsSL "$S3?list-type=2&prefix=firecracker-ci/&delimiter=/" \
  | grep -oP "(?<=<Prefix>)firecracker-ci/[0-9]{8}-[^/]+/(?=</Prefix>)" | sort | tail -1)
KEY=$(curl -fsSL "$S3?list-type=2&prefix=${CI}${ARCH}/vmlinux-" \
  | grep -oP "(?<=<Key>)(${CI}${ARCH}/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" | sort -V | tail -1)
curl -fsSL -o "vmlinux-${KEY##*vmlinux-}" "$S3/$KEY"
```

The verified run used `vmlinux-6.18.44`.

**2. The rootfs: the P6 sandbox image's own filesystem.** The microVM tier then offers the same
toolchain as the container tier. `build-rootfs.sh` only reads the image: it runs `podman create`,
then `podman export`, then removes the temporary container.

```bash
cd /opt/serverless-harness
sudo mkdir -p /srv/moca-369-build
sudo deploy/microvm/build-rootfs.sh --out /srv/moca-369-build/rootfs \
  --image ghcr.io/rossoctl/moca-remote-worker:latest   # the image P6's setup-vm.sh runs
```

Pass `--image` explicitly: `sudo` resets the environment, so a `SANDBOX_IMAGE` exported in your
shell does not reach the script. Use whatever image P6 was installed with. It refuses an image missing
any of `bash git rg python3 base64 file ls cat`. It strips the container
worker binary and records the image and its digest in `/etc/moca-rootfs-source` inside the tree.

**3. The snapshot:**

```bash
sudo deploy/microvm/build-snapshot.sh --kernel /path/to/vmlinux-6.18.44 \
  --rootfs /srv/moca-369-build/rootfs --agent /opt/serverless-harness/remote-worker \
  --image default --vmm firecracker --guest-ram-mb 256 --out /srv/snapshots/default
```

`/srv/snapshots/default` is where the shipped unit looks (`SH_SNAPSHOT_DIR` plus
`SH_SNAPSHOT_IMAGE`). The script boots the VM, probes the guest for its tools, snapshots it, then
proves the artifact by restoring one VM and running `true` in it.

**What the manifest must advertise:** `capabilities` must include the container tier's full set,
`bash rg base64 file python3 git`. The verified run's manifest listed
`["base64","bash","curl","file","git","python3","rg"]`. A missing entry means the rootfs lacks the
tool, and every tool call that needs it will fail.

## Install

```bash
cd /opt/serverless-harness
sudo deploy/microvm/setup-microvm.sh                                  # a >= 24 GiB host
sudo MICROVM_MAX_COMMITTED_MB=8192 deploy/microvm/setup-microvm.sh    # a smaller host (16 GiB here)
```

**What it reads:** `SH_RELAY_PORT` from P6's installed `relay.env`. A quoted value is unquoted the way
systemd does it, a missing one falls back to 8443 as the relay does, and a non-numeric one is
refused. It also checks that `sh-relay.service` is installed and that the golden snapshot exists.

**What it writes:**

| File                                                                                                | Contents                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/usr/local/bin/microvm-worker`                                                                     | built from `remote-worker/cmd/microvm-worker` (or `MICROVM_BIN`)                                                                                                                                                                               |
| `/usr/local/bin/moca-egress`                                                                        | built from `remote-worker/cmd/moca-egress` (or `MOCA_EGRESS_BIN`)                                                                                                                                                                              |
| `/etc/systemd/system/moca-egress.service`                                                           | the shipped file, verbatim                                                                                                                                                                                                                     |
| `/etc/serverless-harness/moca-egress.env` (0644)                                                    | `MOCA_EGRESS_ALLOW=`, written only if absent (see "Guest egress")                                                                                                                                                                              |
| `/etc/systemd/system/microvm-worker.service`, `microvm-vms.slice`                                   | the shipped files, verbatim                                                                                                                                                                                                                    |
| `/etc/serverless-harness/microvm-worker.env` (0600)                                                 | `RELAY_ADDR=127.0.0.1:<SH_RELAY_PORT>`, `SANDBOX_ID`, `SANDBOX_TOKEN`, `SH_WORKSPACE_IDLE=8h`                                                                                                                                                  |
| `/etc/serverless-harness/microvm-relay.env` (0600)                                                  | `SH_RELAY_TOKEN_<sandbox id>=<the same token>`                                                                                                                                                                                                 |
| `sh-relay.service.d/50-moca-microvm.conf`                                                           | `EnvironmentFile=` the relay file above                                                                                                                                                                                                        |
| `microvm-worker.service.d/50-moca-p6.conf`                                                          | `EnvironmentFile=` the worker file; `After=`/`Wants=sh-relay.service`                                                                                                                                                                          |
| `microvm-worker.service.d/60-moca-memory.conf`                                                      | only with `MICROVM_MAX_COMMITTED_MB`: the budget, plus `AssertMemory=` reset and re-asserted at 90% of it. The reset clears **every** assertion, so the drop-in also re-states the shipped unit's others, `AssertPathExists=/dev/kvm` included |
| `/etc/serverless-harness/microvm-tiers.env` (0644)                                                  | only on a host that also has container sandboxes: `SH_SANDBOX_TIERS=container,microvm`, `SH_SANDBOX_DEFAULT_TIER` (the given value, else the stored one, else `container`). Removed on a P4-only host and by `--remote`                        |
| `sh-supervisor.service.d/50-microvm-tiers.conf`, `sh-control-plane.service.d/50-microvm-tiers.conf` | with it: `EnvironmentFile=` the tiers file, ONE file for both units so they cannot disagree                                                                                                                                                    |

**The token:**

- It is generated once and never rotated. The relay's copy (`microvm-relay.env`) is the source of
  truth when it exists, so a token edited by hand into `microvm-worker.env` is reverted on the next
  run; to rotate, delete both files and re-run. The relay's file is rewritten from scratch on every
  run, so changing `MICROVM_SANDBOX_ID` leaves no stale token valid. (After `--remote`, the worker's
  file holds the cluster's token; switching back takes the relay's copy instead, and a worker file
  with `RELAY_TLS=true` never donates its token to the local relay.)
- The relay validates `SH_RELAY_TOKEN_<id>` in preference to the global `SH_RELAY_TOKEN`, so the
  container tier's token does not also admit this worker.
- The worker's file never carries the relay's exec token (MI1 §5 R5).

**Why the sandbox id must be underscore-only** (`^[A-Za-z_][A-Za-z0-9_]*$`, default
`moca_microvm_0`): the id becomes part of an environment variable name, and systemd drops a name
containing a dash. Seen on the rig:
`Ignoring invalid environment assignment 'SH_RELAY_TOKEN_sbx-microvm-1=dashed'`. The attach would
then fail closed, with nothing pointing at why. The worker's own default id, `sbx-microvm-1`, has
exactly that problem, which is why the installer refuses dashed ids.

**What it restarts, and when:**

- **The relay:** only when its drop-in or token file changed, which means a first install or a new
  sandbox id. In-flight turns fail and are retried.
- **The worker:** stopped, its presence record cleared, then started, whenever its binary, unit,
  drop-ins or env file changed. It is also started if it isn't running, for example `failed` after a
  snapshot problem.
- **The supervisor and the control plane:** `try-restart`ed, never started, when the tiers file or
  its drop-ins were written or removed. A stopped unit stays stopped and reads them on its next start.
  A unit that is not installed (no control plane before #366) is skipped; its drop-in is still
  written, for the `setup-vm.sh` run that installs it.
- **A running, unchanged worker is left alone.**

The install is not finished until the relay has mirrored the worker into `sh:sandbox:records`. That
record is what the supervisor leases from, so the installer waits for it (`MICROVM_ATTACH_TIMEOUT`,
default 60s). With `--remote` there is no local record to read: the installer waits instead for the
worker's own `attached, serving execs` line, which must then hold for `MICROVM_ATTACH_SETTLE`
seconds (default 5, at least 1) with no reconnect, all within `MICROVM_ATTACH_TIMEOUT` (a hold that
starts before then may finish).

**Re-running changes nothing.** On the rig, the second run printed `nothing to change` and restarted
nothing. Edits an operator makes to `microvm-worker.env` are kept, including `SH_WORKSPACE_IDLE`
and any added lines, but not the token (see "The token" above). They take effect after
`sudo systemctl restart microvm-worker.service`.

The worker's banner in `journalctl -u microvm-worker` confirms the result:

```
microvm-worker: relay=127.0.0.1:9443 sandbox_id=moca_microvm_0 tls=false vmm=firecracker D=2 guest=256MiB budget=8192MiB slots=16 workspace_idle=8h0m0s
microvm-worker: attached, serving execs
```

On a small budget it also warns that 16 slots at standby depth 2 could commit more VMs than the
budget allows. Two or three sessions stay far below that. For more, raise the budget or set
`WORKER_MAX_CONCURRENT` in `microvm-worker.env`.

### Size the budget for RECENTLY ACTIVE sessions, not for concurrency (#452)

The warning above counts slots, which reads like a concurrency limit. The budget is not one.

`MICROVM_MAX_COMMITTED_MB` bounds the memory of VMs _resident at once_, and what makes a VM resident
is a **distinct `workspace_key`** — one per session — not a command in flight. A single command
leaves `1 + D` VMs behind it: the one it ran on, plus `D` standbys warmed for the session's next
command.

What releases them is `StandbyIdle`, **90 seconds** with no Exec for that key, after which the
sweep drops the session's standbys and parks the run — and a parked run holds zero VMs. So the
budget is consumed by sessions active in roughly the last `StandbyIdle + ReclaimScanInterval`
(~2 minutes), not by sessions that are merely open. A session idle for an hour holds **no** memory;
what it still holds is its workspace on disk, until `SH_WORKSPACE_IDLE`.

The number to divide the budget by is therefore how many sessions took a turn in the last couple of
minutes, and the budget itself is net of the reserve:

```
recently active sessions ≈ (MICROVM_MAX_COMMITTED_MB - SH_MEMORY_RESERVE_MB)
                           / ((guest MiB + 32) × (1 + D))
```

The `+ 32` is the per-VM cost outside guest RAM — the VMM process and its sidecars — because
admission charges `GuestRAMBytes + VMOverheadBytes` per VM (`vmpool.PerVMBytes`). It is a constant
(`DefaultVMOverheadBytes`), not a knob. At the verified
settings — budget `8192` MiB, `SH_MEMORY_RESERVE_MB=4096`, `guest=256MiB`, `D=2` — that is
(8192 − 4096) / 864 ≈ **4–5 sessions**, or about 14 VMs, which is the figure #452 reports from the
rig. Note the reserve: on this host it is half the budget, so halving the gap between them halves
the capacity.

Past that point the worker refuses an exec rather than overcommitting, and since #452 it first sheds
the least-recently-used **idle standby** VM and retries, so a refusal now means every resident VM
belongs to a session with live work — a host genuinely busy rather than one holding warm standbys
for sessions that moved on. The refusal reaches the caller as **HTTP 503 with `Retry-After`** and
code `sandbox_unavailable`; the same prompt is retryable, and because the ceiling clears on the
90-second sweep rather than on a human closing a tab, a retry a minute later usually succeeds.

To raise the ceiling, the knobs are the budget and the standby depth:

| Symptom                                     | Knob                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| 503s with few sessions active               | raise `MICROVM_MAX_COMMITTED_MB`, or lower `SH_MEMORY_RESERVE_MB`             |
| 503s under a burst of short, parallel turns | lower `SH_STANDBY_DEPTH` from `2` — fewer warm VMs per session, colder starts |

`SH_WORKSPACE_IDLE` is **not** one of them. It governs the workspace on disk, and the runs it
reclaims already hold zero VMs and do not count toward `MaxRuns` either — so lowering it frees no
memory and only brings #338's silent workspace reset forward.

Before #452, a refusal at this ceiling did not surface as a 503 at all: it was delivered to the
model as its command's output, so a turn answered 200 with the host's memory arithmetic quoted back
as prose. If you are reading an older worker's logs, that is what a budget ceiling looked like.

## Run a turn

These are single-user, **unauthenticated** `/turn` calls, and they need `SH_REQUIRE_AUTH=false` in
`supervisor.env`.

> **The supervisor listens on `0.0.0.0:8080`.** With auth off, anyone who can reach that port can
> run code in your sandboxes and spend the model credential configured below. Turn auth off only on
> a host where port 8080 is reachable from nowhere else: no security-group or firewall rule for it.
> Use an SSH tunnel to reach it. Turn auth back on when you are done.

On a host where `setup-vm.sh` installed the control plane, `SH_REQUIRE_AUTH=true` is the default:

```bash
sudo sed -i 's/^SH_REQUIRE_AUTH=.*/SH_REQUIRE_AUTH=false/' /etc/serverless-harness/supervisor.env
sudo systemctl restart sh-supervisor
# ... the turns below ...
sudo sed -i 's/^SH_REQUIRE_AUTH=.*/SH_REQUIRE_AUTH=true/' /etc/serverless-harness/supervisor.env
sudo systemctl restart sh-supervisor
```

A new session is created by **omitting** `sessionId`, and the response names it. A `sessionId` the
backend has never seen gets a 404.

```bash
curl -sS -X POST http://127.0.0.1:8080/turn -H 'content-type: application/json' \
  -d '{"prompt":"In your sandbox: write the output of uname -a and python3 --version to notes.txt, initialise a git repository, commit notes.txt, and tell me the commit hash."}' | tee turn1.json
S=$(node -pe 'JSON.parse(require("fs").readFileSync("turn1.json","utf8")).sessionId')
curl -sS -X POST http://127.0.0.1:8080/turn -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$S\",\"prompt\":\"Show me git log --oneline and the contents of notes.txt.\"}"
```

On a tiered host, an unauthenticated `/turn` like these runs in the default tier, `container` unless
`SH_SANDBOX_DEFAULT_TIER=microvm`, so the microvm-worker journal below shows nothing. Use
`p4-turn-smoke.sh --auth` instead: it creates its sessions with `sandboxTier=microvm` (below).

**The evidence:** one journal line per Exec. It names the session's workspace and the VM that ran
it, never the command:

```bash
sudo journalctl -u microvm-worker | grep 'vmpool: exec' | grep "workspace_key=\"$S\""
sudo ls /srv/workspaces/   # one directory per session
```

```
vmpool: exec req=… workspace_key="<session id>" vm=vm-5 cold="first-exec" exit=0 err=<nil>
vmpool: exec req=… workspace_key="<session id>" vm=vm-6 cold="exhausted" exit=0 err=<nil>
```

**A model with a direct Anthropic key:** a host with no gateway can use the public API with
`ANTHROPIC_API_KEY` alone. Set **no** `ANTHROPIC_BASE_URL` and **no** `ANTHROPIC_AUTH_TOKEN`
(`applyModelGateway`, `harness/src/run-turn.ts`):

- `ANTHROPIC_BASE_URL` sends requests, **with your key** in `x-api-key`, to that URL instead of
  Anthropic.
- `ANTHROPIC_AUTH_TOKEN` sends a Bearer token and strips `x-api-key`, so your key is not used.

This works only under `MOCA_TENANCY=single`, the `deploy/vm` default; `multi` scrubs ambient keys at
boot.

Keep the key in a root-only env file, not in an `Environment=` line, which `systemctl show` would
reveal to any user:

```bash
sudo install -m 0600 -o root -g root /dev/null /etc/serverless-harness/p4-real-model.env
sudoedit /etc/serverless-harness/p4-real-model.env   # ANTHROPIC_API_KEY=… and SH_MODEL=claude-haiku-4-5
sudo mkdir -p /etc/systemd/system/sh-supervisor.service.d
printf '[Service]\nEnvironmentFile=/etc/serverless-harness/p4-real-model.env\n' |
  sudo tee /etc/systemd/system/sh-supervisor.service.d/91-p4-real-model.conf >/dev/null
sudo systemctl daemon-reload && sudo systemctl restart sh-supervisor
```

## Automated check (no model needed)

`mock-anthropic.mjs` is a scripted Anthropic-Messages server on loopback. It returns fixed `bash`
tool calls and echoes their results into its final text, which is all a non-streaming `/turn`
returns. `p4-turn-smoke.sh` drives real turns through the supervisor against it:

- two turns of one session: write a file, then find it again;
- a second session, which must not see the first session's files;
- the journal and the workspace directories;
- with `--failure-paths`, a worker restart during a tool call, and a kill of the VM running one.

**On a host with the control plane, add `--auth`** and leave `SH_REQUIRE_AUTH=true` alone. Every
turn then goes through the real `mocactl run`, as two users:

- It stands in for `mocactl login` the way `deploy/compose/smoke.sh` does. It mints one api token
  per subject (`p4smoke:a`, `p4smoke:b`) with the control plane's own signing key, read from
  `/etc/serverless-harness/credentials/`. That is why it runs as root.
- The token is written by node straight into a `0600` `mocactl/auth.json` under the run's `--out`
  directory. It never appears on an argv. A token lives one hour; delete the `--out` directory when
  you are done.
- Each subject stores a bearer inference credential, `p4-smoke-mock`, whose endpoint is the mock
  (`SMOKE_MODEL_URL`, default `http://127.0.0.1:18099`). Its secret is the string
  `mock-not-a-secret`.
- Session B belongs to the **second** subject. Each subject must read its own session (200), and
  the second must get a 404 on session A. The control plane also answers 404 for an id it never saw,
  so the 404 means "not the owner" only next to those two 200s.
- `--control-plane URL` defaults to `http://127.0.0.1:8090`.

```bash
sudo systemd-run --unit p4-mock-anthropic -p DynamicUser=yes \
  /usr/bin/node /opt/serverless-harness/deploy/microvm/mock-anthropic.mjs --port 18099
printf 'SH_MODEL_CUSTOM=1\nSH_MODEL=mock-p4\nSH_MODEL_BASE_URL=http://127.0.0.1:18099\nANTHROPIC_AUTH_TOKEN=mock-not-a-secret\n' |
  sudo tee /etc/serverless-harness/p4-smoke.env >/dev/null
sudo mkdir -p /etc/systemd/system/sh-supervisor.service.d
printf '[Service]\nEnvironmentFile=/etc/serverless-harness/p4-smoke.env\n' |
  sudo tee /etc/systemd/system/sh-supervisor.service.d/90-p4-smoke.conf >/dev/null
sudo systemctl daemon-reload && sudo systemctl restart sh-supervisor
sudo deploy/microvm/p4-turn-smoke.sh --failure-paths          # auth off
sudo deploy/microvm/p4-turn-smoke.sh --auth --failure-paths   # control plane
```

The settings go in an `EnvironmentFile=`, not an `Environment=` line. systemd lets values from
`EnvironmentFile=` override `Environment=`, and a later file overrides an earlier one. So only a file
loaded after `supervisor.env` wins over an `SH_MODEL` or `ANTHROPIC_*` already set there, or in the
real-model file above. Remove the real-model drop-in during the check. The verified run used an
`Environment=` drop-in, on a `supervisor.env` that set none of these keys.

On a host with both tiers, the check runs in the microVM tier: `--auth` creates every session with
`--option sandboxTier=microvm`. Without `--auth` a turn has no session, so it runs in the default
tier: the check then requires `SH_SANDBOX_DEFAULT_TIER=microvm` in `microvm-tiers.env`. Either use
`--auth`, or re-run `setup-microvm.sh` with `SH_SANDBOX_DEFAULT_TIER=microvm`. On a host without
tiers it still requires that no `sh-sandbox-*` container exists.

It exits 0 and prints `PASS` when every check held. Afterwards, point the supervisor back at the real
model:

```bash
sudo rm /etc/systemd/system/sh-supervisor.service.d/90-p4-smoke.conf /etc/serverless-harness/p4-smoke.env
sudo systemctl daemon-reload && sudo systemctl restart sh-supervisor
sudo systemctl stop p4-mock-anthropic
```

Each run writes to a fresh private directory and names it on its last line:
`PASS (/tmp/p4-smoke-XXXXXX)`. With `--auth`, a named `--out` must not exist yet: the run creates
it `0700`, because it holds the api tokens, and refuses an existing path or a symlink.

After an `--auth` run, clean up what it created on the control plane and the worker:

- the two sessions, one per subject (the failure-path turns run in session A);
- each subject's mock credential;
- each subject's record, which the control plane keeps, empty, after its credential is gone;
- the sessions' workspaces;
- the run's directory, which holds the tokens.

The session and credential deletes authenticate with the run's tokens, which **expire one hour after
the run**. Clean up within that hour, or mint fresh tokens by running the check again. Each delete
prints its HTTP code:

- a session delete answers `204`, or `202` if a turn is still in flight. Either way the session is
  deleted; after a `202`, a sweeper reaps what that turn writes on its way out;
- a credential delete answers `204`;
- `401` means the token has expired.

```bash
O=/tmp/p4-smoke-XXXXXX   # the directory the run named
cp=http://127.0.0.1:8090
for s in a b; do
  id="$(sudo cat "$O/session-$s")"
  if [ -n "$id" ]; then
    sudo curl -sS -o /dev/null -w "session $s: %{http_code}\n" -X DELETE -H @"$O/xdg-$s/api.hdr" "$cp/v1/sessions/$id"
    sudo rm -rf "/srv/workspaces/$id"
  fi
  sudo curl -sS -o /dev/null -w "credential $s: %{http_code}\n" -X DELETE -H @"$O/xdg-$s/api.hdr" \
    "$cp/v1/credentials/p4-smoke-mock"
  # The file store names a subject's record by the first 16 hex digits of sha256(subject).
  sudo rm -f "/var/lib/moca-control-plane/$(printf %s "p4smoke:$s" | sha256sum | cut -c1-16).json"
done
sudo rm -rf "$O"
```

## Workspace lifetime (#338)

Idle reclaim is the **only** thing that deletes a session's workspace, and a later turn is not told
it happened. The next turn simply starts in an empty workspace.

The worker's default lifetime is 30 minutes. That is too short for a session waiting on a person, so
`SH_WORKSPACE_IDLE` (a Go duration) sets it, and the installer writes `8h`. The worker refuses a value
at or below `StandbyIdle` (90s).

Workspace **disk** is not admission-controlled; only VM memory is. The idle timer is therefore also
the only backstop against filling `SH_WORKSPACE_ROOT`. Measured on the rig: each workspace is a
`workspace.img` of **2 GiB apparent, 66 MiB actually on disk** after a short session. Its cost is what
was written, not the image size. At 8h and 23G free, that host holds roughly 350 idle short sessions.

The silent reset remains. #338 stays open for its real fixes: an observable reset, then an explicit
release.

## Verified / not verified

Verified on 2026-09-30:

- **Host:** `m8i.xlarge` (4 vCPU, 16 GiB, nested virtualisation), Amazon Linux 2023, kernel
  `6.18.44-99.149.amzn2023`.
- **Software:** Firecracker v1.17.0, podman-static 5.8.7.
- **Guest:** kernel `vmlinux-6.18.44`, rootfs from `ghcr.io/rossoctl/moca-remote-worker:latest` @
  `sha256:24be22a0…`.
- **Budget:** `MICROVM_MAX_COMMITTED_MB=8192`.
- **P6:** installed from `deploy/vm` **before the control plane landed** (#366), with
  `SH_SANDBOX_COUNT=0` and `SH_REQUIRE_AUTH=false`.

| Claim                                                                         | Evidence                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The installer attaches the worker under its own relay token                   | `moca_microvm_0 is attached to the relay`; worker `attached, serving execs`                                                                                                                                                                                                                             |
| A re-run changes nothing                                                      | second run: `nothing to change`, no restarts                                                                                                                                                                                                                                                            |
| systemd drops a dashed env name                                               | a transient unit loading both names: `Ignoring invalid environment assignment 'SH_RELAY_TOKEN_sbx-microvm-1=dashed'`; only the underscore name reached the process                                                                                                                                      |
| The snapshot advertises the container tier's tools                            | manifest `["base64","bash","curl","file","git","python3","rg"]`                                                                                                                                                                                                                                         |
| Multi-tool turns run in microVMs, one VM per Exec                             | scripted run: 26/26 checks; each journal Exec has a distinct `vm=`                                                                                                                                                                                                                                      |
| The workspace survives between turns                                          | turn 2 read turn 1's file and repo                                                                                                                                                                                                                                                                      |
| A second session gets a separate workspace                                    | session B saw neither; separate `/srv/workspaces/<id>`                                                                                                                                                                                                                                                  |
| Worker restart mid-Exec ends the tool call with a named error                 | `worker disconnected`                                                                                                                                                                                                                                                                                   |
| A killed VM ends the tool call with a named error                             | `vsock-short-response: vmpool: guest closed before End: EOF`                                                                                                                                                                                                                                            |
| A real model, two turns, one session                                          | direct `ANTHROPIC_API_KEY`, with `SH_MODEL=claude-haiku-4-5` as the owner configured it (the key file was never read back, so the model id is not in the logs): turn 1 committed `5d6c21b`, turn 2 showed it; 12 Execs, 12 distinct VMs, one `workspace_key`; guest `uname -a`: `Linux (none) 6.18.44+` |
| A new session's first turn fails without the harness fix (failure reproduced) | before the fix: `invalid-workspace-key: workspace_key "anon:<uuid>" must match …` on every tool call of turn 1                                                                                                                                                                                          |
| Per-session workspace disk                                                    | 66 MiB actual / 2 GiB apparent                                                                                                                                                                                                                                                                          |

**Then with the control plane**, on the same host, later on 2026-09-30:

- `setup-vm.sh` was re-run with `SH_SANDBOX_COUNT=0` from a checkout that includes #366. It installed
  the control plane, generated its keys and set `SH_REQUIRE_AUTH=true`.
  - `SH_GITHUB_CLIENT_ID` was a placeholder, so **no device-flow login** was run.
  - A second run started the control plane.
- `setup-microvm.sh` was re-run with `MICROVM_MAX_COMMITTED_MB=8192`.

| Claim                                                                        | Evidence                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installing the control plane leaves the microVM tier attached                | `setup-microvm.sh` re-run: `moca_microvm_0 is attached to the relay`, `nothing to change`. The worker reconnected by itself within seconds of each relay restart                               |
| The unauthenticated `/turn` is closed                                        | `POST /turn` without a token: 401                                                                                                                                                              |
| `mocactl run` as a logged-in user runs multi-tool turns in microVMs          | `p4-turn-smoke.sh --auth --failure-paths`: 32/32 checks, `SH_REQUIRE_AUTH=true` throughout. Every turn went through `mocactl run` with a minted api token (the stand-in for `mocactl login`)   |
| The `workspace_key` is the control plane's session id                        | journal: `workspace_key="272d7e37-…"`, the id `mocactl` printed. A control-plane UUID, not an `anon:` key                                                                                      |
| One VM per Exec, the workspace survives, a second user's session is separate | 4 Execs in 4 distinct VMs; turn 2 read turn 1's file and repo; subject b's session saw neither and has its own `/srv/workspaces/<id>`                                                          |
| A second user cannot reach the first user's session                          | subject b: `GET /v1/sessions/<a's id>` → 404. That run predates the positive controls added in review (each owner reads its own session: 200), so its 404 alone does not exclude an unknown id |
| The failure paths still end with a named error                               | worker restart: `worker disconnected`; killed VM: `vsock-short-response: vmpool: guest closed before End: EOF`                                                                                 |
| The authenticated check can be run again                                     | a second `--auth` run: `PASS`; the credential `PUT` replaces the stored one                                                                                                                    |

**Re-run after review**, 2026-10-01, at `cf094b5`, on the same host: `p4-turn-smoke.sh --auth
--failure-paths` passed **34/34**.

- The new checks held: subject a read session A (200), subject b read session B (200), and subject b
  got 404 on A.
- The output directory, each subject's config directory, `auth.json` and `api.hdr` were 0700, 0700,
  0600 and 0600.
- 4 Execs ran in 4 distinct VMs; session A had 3 of them.
- The cleanup block above, run as written, answered `204` to all four deletes and left none of the
  run's sessions, credentials, subject records, workspaces or tokens behind.

**Then a real login**, 2026-10-01, by the owner from a laptop over the SSH tunnel:

- The control plane was given a real GitHub OAuth app (device flow on) and restarted.
- `SH_REQUIRE_AUTH=true` throughout, with no supervisor drop-in, so no mock model was involved.
- The owner reported the manual verification complete. The rows below are what the rig's journal
  shows for that session.

| Claim                                                          | Evidence                                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A user logged in with `mocactl login` ran turns on the P4 tier | session `4e696222-…`, created through the control plane: a UUID `workspace_key`, not `anon:`                                   |
| Two turns of one session, every Exec in its own microVM        | turn 1 (01:31): 2 Execs; turn 2 (01:32:57): 1 Exec; 3 Execs, 3 distinct `vm=` (`vm-13`, `vm-15`, `vm-17`), one `workspace_key` |
| The session has its own workspace                              | `/srv/workspaces/4e696222-…`, 66 MiB on disk                                                                                   |

**Not verified:**

- **A second real GitHub account** on this tier. The second user above is a minted subject; two real
  accounts are #367's acceptance run.
- **Cloud Hypervisor, density and throughput (#256, #261), a host reboot, and any host other than
  the one above.**
- **The budget ceiling on this rig (#452).** Every run above stayed well inside the budget — the
  largest used 4 Execs — so no run here ever reached the ceiling, shed a standby, or produced a 503.
  The eviction and the 503 mapping are covered by unit tests (`remote-worker/internal/vmpool`,
  `packages/k8s-sandbox`, `packages/knative-server`); what is **not** verified is the end-to-end
  behaviour on a host at its ceiling. Reaching it deliberately needs ~5 sessions each taking a turn
  inside the same 90-second `StandbyIdle` window (see the arithmetic above), or a temporarily small
  `MICROVM_MAX_COMMITTED_MB`.

## Guest egress (P4.1, #277)

`setup-microvm.sh` installs and starts `moca-egress` before the worker. The path is guest
`127.0.0.1:3128` -> vsock port 1025 -> `<jail>/run/v.sock_1025` -> `moca-egress`, which allows only the
hosts in its allowlist and refuses everything else with a named error, never a timeout. The worker
registers each VM's listener over `/run/moca-egress/control.sock` (the worker runs as root; the
proxy's `DynamicUser` needs no group). While `moca-egress` is down, restores fail closed.

- **If it is down when the worker starts:** the worker's startup probe fails, and systemd retries the
  worker only within its start limit (5 per 300 s). A `moca-egress` that keeps exiting (for example a
  bad `moca-egress.env`) reaches `failed` too, after 5 starts in 120 s. `setup-microvm.sh` waits for
  the control socket and fails naming `journalctl -u moca-egress` if it never appears. By hand, after
  fixing the cause: `systemctl restart moca-egress`, then `systemctl reset-failed microvm-worker`, then
  `systemctl start microvm-worker`. Re-running `setup-microvm.sh` does the same.

- **Snapshot:** a golden snapshot built before P4.1 has no guest egress listener. Rebuild it with
  `build-snapshot.sh` for egress to work.
- **Allowlist:** `MOCA_EGRESS_ALLOW` in `/etc/serverless-harness/moca-egress.env`, seeded with
  `api.github.com,github.com,codeload.github.com,objects.githubusercontent.com` (or from
  `MOCA_EGRESS_ALLOW` in the installer's environment, on the first write only). A re-run never
  overwrites the file. To change it, edit the file, then `systemctl restart moca-egress`. The restart
  severs open tunnels (the guest must retry). The worker's control client notices the restart on its
  own and re-registers every live VM within seconds, with no Exec needed; a guest that connects in
  that gap waits in the socket backlog and is served once the VM is re-registered.
- **Audit:** one JSON line per request (host, method, path without query, status, `bytes_up`,
  `bytes_down`, `dial_addr`, decision) in `journalctl -u moca-egress`.
- **Not in this slice:** no credentials (the guest's `GH_TOKEN` is the placeholder `moca-placeholder`),
  no TLS interception, no cert-pinning escape hatch, and `MOCA_TENANCY=multi` is refused at boot.
  Because nothing swaps the placeholder yet, tools that send `GH_TOKEN`/`GITHUB_TOKEN` to GitHub (`gh`,
  `curl -H "Authorization: ..."`) get `401`, even on endpoints that work anonymously. `git` is
  unaffected: its credential helper answers only a challenge.
- **No bypass:** the VM has no NIC, so the proxy is the only way out (T7).
- **Cloud Hypervisor:** egress is Firecracker-only and the worker refuses to start on
  `SH_VMM=cloud-hypervisor` with `MOCA_EGRESS_CONTROL_SOCK` set. Drop it with a unit drop-in
  (`[Service]` then `Environment=MOCA_EGRESS_CONTROL_SOCK=`) on such a host.

## Limits — say these plainly

- **No guest network.** A microVM has no NIC, no DNS and no NAT, so `curl` and `git` reach only the
  allowlist in "Guest egress" above, through the proxy, and carry no credentials. Demo P4 on local
  content or on allowlisted hosts.
- **No grant binding.** Any holder of the relay's exec token can target any `workspace_key`
  (MI1 S4).
- **A fresh VM per tool call** (#274). Destroying the VM dominates Exec latency (#307).
- **The silent workspace reset** (#338, above).
- **About four or five RECENTLY ACTIVE sessions per host, at the verified settings** (#452, above).
  The ceiling counts distinct sessions that took a turn in the last ~2 minutes, not concurrent
  commands — each leaves `1 + D` VMs resident until the 90-second `StandbyIdle` sweep parks it. Past
  it, turns answer 503 + `Retry-After` rather than overcommitting the host.
- **A workspace lives on one sandbox.** A session that moves (its sandbox gone past the grace) starts on an empty workspace; nothing copies it.
- **On a host installed before #410, the FIRST re-run of `setup-vm.sh` starts Redis empty.** Redis
  now keeps its data on a named volume with AOF on, and `start_redis` leaves an already-matching
  `sh-redis` running rather than recreating it, so an ordinary re-run keeps every session. But a
  container from before that change holds its data on an anonymous volume: the first re-run warns,
  leaves that volume in place and starts the named one empty, so the control plane's session and
  ownership index reads as gone (the workspaces stay under `/srv/workspaces` until idle reclaim,
  orphaned). Nothing is deleted — re-run once with
  `sudo env SH_REDIS_ADOPT_VOLUME=1 ./deploy/vm/setup-vm.sh` to migrate it. Do that before a demo,
  not mid-demo, and see "Redis persistence" in `deploy/vm/README.md` for the trap in recovering such
  a volume by hand: copying a `dump.rdb` into a volume whose Redis has AOF on yields a silently
  empty Redis.

## Uninstall

```bash
sudo systemctl disable --now microvm-worker.service
sudo systemctl stop microvm-vms.slice
sudo podman exec sh-redis redis-cli HDEL sh:sandbox:records moca_microvm_0
sudo rm -rf /etc/systemd/system/microvm-worker.service.d \
  /etc/systemd/system/sh-relay.service.d/50-moca-microvm.conf \
  /etc/systemd/system/microvm-worker.service /etc/systemd/system/microvm-vms.slice \
  /etc/serverless-harness/microvm-worker.env /etc/serverless-harness/microvm-relay.env \
  /usr/local/bin/microvm-worker
sudo rmdir /etc/systemd/system/sh-relay.service.d 2>/dev/null || true
sudo systemctl daemon-reload && sudo systemctl restart sh-relay.service
# the sandbox tiers, on a host that also ran container sandboxes ("Container sandboxes and P4 on one host"):
sudo rm -f /etc/serverless-harness/microvm-tiers.env \
  /etc/systemd/system/sh-supervisor.service.d/50-microvm-tiers.conf \
  /etc/systemd/system/sh-control-plane.service.d/50-microvm-tiers.conf
# try-restart only the units installed: a P6 from before the control plane (#366) has no
# sh-control-plane.service, and systemd refuses a try-restart of a unit it cannot find
sudo systemctl daemon-reload && sudo systemctl try-restart sh-supervisor
[ ! -f /etc/systemd/system/sh-control-plane.service ] || sudo systemctl try-restart sh-control-plane
# the model and check settings from "Run a turn" and "Automated check", if present:
sudo rm -f /etc/systemd/system/sh-supervisor.service.d/90-p4-smoke.conf \
  /etc/systemd/system/sh-supervisor.service.d/91-p4-real-model.conf \
  /etc/serverless-harness/p4-smoke.env /etc/serverless-harness/p4-real-model.env
sudo systemctl daemon-reload && sudo systemctl restart sh-supervisor.service
# DELETES every session's workspace (their files, repositories and work), not just the tier:
sudo rm -rf /srv/snapshots/default /srv/workspaces/* /srv/jail/* /srv/moca-369-build
```

The `p4-real-model.env` removal matters: it holds a live API key.

Restarting the relay drops its copy of the worker's token. Deleting `microvm-relay.env` **without**
removing its drop-in stops `sh-relay` from starting, because the drop-in's `EnvironmentFile=` is
required, not optional. Remove both together.

## With P6 on Kubernetes instead

When P6 runs in an OpenShift cluster rather than on this host, the same P4 worker attaches to the
in-cluster relay over TLS: `deploy/k8s/setup.sh` issues a bundle per host, and
`sudo deploy/microvm/setup-microvm.sh --remote <bundle>` installs it. Everything above about the
host itself -- KVM, Firecracker, the snapshot, the memory budget -- still applies. Of the local P6,
only the tier files are touched: on a host an earlier mixed local run tiered, `--remote` removes
`microvm-tiers.env` and both drop-ins and try-restarts the installed `sh-supervisor` and
`sh-control-plane`, because this host's only microVM worker now attaches to the cluster's relay, so
its own P6 is container-only from then on, and untiered (P6.3 spec §7). Remote mode also writes
`/etc/serverless-harness/microvm-relay-ca.crt` (when the bundle carries a CA) and the drop-in
`microvm-worker.service.d/50-moca-remote.conf` in place of `50-moca-p6.conf`.
See
[`deploy/k8s/README.md` §11](../k8s/README.md#11-p4-on-kubernetes-microvm-hosts-outside-the-cluster).
