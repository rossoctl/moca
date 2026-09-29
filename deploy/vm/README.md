# Single-VM deployment (P6 process-manager runtime)

Round one's target for the VM process-manager runtime (spec §4.3, §4.4, step 4): a single
Linux VM running the supervisor and relay under systemd, with Redis and the sandbox
containers as podman containers alongside them. `setup-vm.sh` is the sibling of
`deploy/knative/setup-kind.sh` and `deploy/knative/setup-ocp.sh`.

## Prerequisites

- A Linux VM with systemd and [podman](https://podman.io/) installed
- Node.js 22+ and pnpm 9+ on the VM (the supervisor and relay run directly via
  `node --import tsx`, not containerized)
- A user able to install systemd units under `/etc/systemd/system` and run as root (see
  "Bring it up" below)
- A system user and group named `harness` (both units run as `User=harness`/`Group=harness`):
  e.g. `sudo useradd --system --no-create-home --shell /usr/sbin/nologin harness`
- **The workspace built.** `ExecStart=node --import tsx src/main.ts` needs `tsx` (a
  devDependency) and the workspace's `link:` targets resolved, and those only exist after the
  checkout is built. Run, in order (spec §9), once per checkout:

  ```bash
  git submodule update --init --recursive
  cd pi-fork && npm ci && npm run build && cd ..
  pnpm install
  ```

  `setup-vm.sh` checks for this and refuses to continue with a clear message if it is missing —
  it does **not** run the build itself, since it can take minutes and does not belong inside a
  bring-up script.

## Bring it up

```bash
cd /opt/moca   # this checkout, on the VM, already built (see Prerequisites)
sudo ./deploy/vm/setup-vm.sh
```

**A first run takes two invocations, by design.** The script installs the env files and then
refuses to go further until `SH_RELAY_TOKEN` is set in the `relay.env` it just wrote (the relay's
token validation is fail-closed, so starting containers before that guarantees sandboxes that can
never attach — see "Sandbox container networking and the relay token" below). So on a fresh VM:

```bash
sudo ./deploy/vm/setup-vm.sh        # writes the env files, then stops at the token check
sudoedit /etc/moca/relay.env   # set SH_RELAY_TOKEN=<a shared secret>
sudo ./deploy/vm/setup-vm.sh        # installs units, starts containers, enables the services
```

The first invocation exits non-zero with a message naming `SH_RELAY_TOKEN` and the file. That is
the expected first-run path, not a failure to debug. The second invocation keeps the env file you
edited (`install_env` never clobbers an existing one) and continues past the check.

Across those two runs, the script does the following, in this order:

1. Writes `/etc/moca/supervisor.env` and `relay.env` from their `env/*.example`
   templates — only the first time each; an operator-edited env file is never clobbered on a
   re-run.
2. **Checks `relay.env` for a non-empty `SH_RELAY_TOKEN`, and stops here if there is none.**
   Everything below runs only once that is set — which is why a fresh VM needs the second
   invocation above.
3. Installs `systemd/sh-supervisor.service` and `systemd/sh-relay.service` into
   `/etc/systemd/system`, reloads the daemon, and enables `podman-restart.service` so the
   containers below come back after a reboot (see "Reboots" below).
4. Starts a Redis container and `SH_SANDBOX_COUNT` (default 2) sandbox containers via podman,
   each wired to reach the relay and to authenticate to it (see "Sandbox container networking
   and the relay token" below).
5. Enables **and starts** `sh-relay.service`, but only **enables** `sh-supervisor.service` — it
   is deliberately not started yet (see below).

`SH_TURNS_PER_WORKER` ships empty on purpose (see below), and `readConfig` throws on blank, so
the supervisor unit is _expected_ to fail if it starts before the operator sets it. With
`Restart=always`/`RestartSec=2` and no `StartLimitIntervalSec=0`, starting it in that state
trips systemd's default 5-starts-in-10s limit in about ten seconds, and the unit then refuses
even the ordinary recovery command until you `systemctl reset-failed` it. `setup-vm.sh` avoids
that entirely by enabling the unit (so it starts on future boots) without starting it now.
Before starting it for the first time, edit `/etc/moca/supervisor.env` and set
`SH_TURNS_PER_WORKER`, then:

```bash
sudo systemctl start sh-supervisor.service
```

### Troubleshooting: "start request repeated too quickly"

If `sh-supervisor.service` ends up crash-looping anyway (for example, it was started before
`SH_TURNS_PER_WORKER` was set, or some other config problem repeats within the 10-second
window), systemd locks it out with `Failed to start sh-supervisor.service: Unit
sh-supervisor.service is not loaded properly: start request repeated too quickly.` Fix the
underlying config in `supervisor.env`, then clear the lockout and start again:

```bash
sudo systemctl reset-failed sh-supervisor.service
sudo systemctl start sh-supervisor.service
```

## Sandbox container networking and the relay token

`remote-worker/cmd/worker/main.go` reads `RELAY_ADDR` (default `localhost:8443`),
`SANDBOX_TOKEN` (default `dev-token`), and `SANDBOX_ID` (default `sbx-laptop-1`) from its own
environment. None of those defaults work for a podman container started with no `-e` flags:
`localhost` inside the container resolves to the container itself, not the host running the
relay; every container would share one `SANDBOX_ID` and collide on the same
`sh:sandbox:records` entry in Redis; and `dev-token` never matches a real, fail-closed relay.
`setup-vm.sh` now sets all three explicitly for each container:

- `SANDBOX_ID=sh-sandbox-<i>` — unique per container.
- `SANDBOX_TOKEN=<the value of SH_RELAY_TOKEN in the installed relay.env>`.
- `RELAY_ADDR=<SH_SANDBOX_RELAY_ADDR, or host.containers.internal:<SH_RELAY_PORT>>` — see below.

**The token preflight.** The relay's token validation
(`makeDefaultValidateToken` in `packages/sandbox-relay/src/main.ts`) is fail-closed: with
`SH_RELAY_TOKEN` unset, every attach is rejected, including a tokenless one.
`relay.env.example` ships it commented out on purpose (it is an operator secret, not a
default), so `setup-vm.sh` checks the _installed_ `relay.env` for a non-empty
`SH_RELAY_TOKEN` before starting any sandbox container, and refuses to continue with a clear
message if it is missing, rather than starting containers that can never attach.

`/etc/moca/relay.env` is created by `setup-vm.sh` itself, so on a fresh VM there is
nothing to edit until the script has run once — this is the two-invocation first run described under
"Bring it up". After that first run:

```bash
sudoedit /etc/moca/relay.env   # set SH_RELAY_TOKEN=<a shared secret>
sudo ./deploy/vm/setup-vm.sh                 # re-run; the edited file is preserved
```

Appending instead of editing works equally well once the file exists
(`echo 'SH_RELAY_TOKEN=…' | sudo tee -a /etc/moca/relay.env`) — but only then, since
the directory and file do not exist before `install_env` creates them.

Whichever way you set it, the value must match each sandbox worker's `SANDBOX_TOKEN`;
`setup-vm.sh` reads it back out of `relay.env` and passes exactly that to every container it
starts, so editing this one file is enough.

**Reaching the host from a container.** `host.containers.internal` is podman's documented
analogue of Docker's `host.docker.internal` (`podman-run(1)`'s `host-gateway` special value).
`setup-vm.sh` passes `--add-host host.containers.internal:host-gateway` explicitly on every
`podman run` so this mapping does not depend on netavark's automatic `/etc/hosts` population,
which differs between rootful and rootless podman and across versions. The default address is
therefore `host.containers.internal:<port>`, where `<port>` comes from `SH_RELAY_PORT` in the
installed `relay.env` (falling back to `8443`, the code's own default, if that line is
missing). Override the whole address with `SH_SANDBOX_RELAY_ADDR` if this default does not
resolve on your VM's actual network setup.

**This is the item in this deployment layer least verified on real hardware.** Nobody has run
this script against an actual podman installation; `host.containers.internal` plus an explicit
`--add-host` is the documented, version-independent mechanism, but rootful vs. rootless podman,
firewall rules, and SELinux/AppArmor policy can all still block the container from reaching the
host's bound port in ways a unit test cannot see. If a sandbox container cannot attach on a
real VM, `SH_SANDBOX_RELAY_ADDR` (or, if podman itself cannot resolve
`host.containers.internal`, the VM's actual gateway or bridge IP) is the override to reach for
first.

## Reboots

Both units are `WantedBy=multi-user.target`, so systemd brings the relay and the supervisor back
on boot. The podman containers need one extra thing: `--restart=always` (which `setup-vm.sh` now
passes to Redis and to every sandbox container) covers a container that _exits_, but
`podman-run(1)` is explicit that it does **not** cover a host reboot. `setup-vm.sh` therefore also
enables `podman-restart.service`, podman's own supported mechanism for that. Without it the units
would come back while Redis and every sandbox container stayed down — `sh:sandbox:records` empty
and every turn failing, on a VM that otherwise looks healthy.

If `podman-restart.service` is not available on your podman build, `setup-vm.sh` warns rather than
failing (it is one package's unit name, not a hard requirement of the bring-up) and the bring-up
still completes. On such a host, re-run `setup-vm.sh` after a reboot before expecting turns to
work.

**Redis state does not survive a reboot either way.** The Redis container runs with no volume, so
sessions, the ownership index and the lease store are lost on reboot and on any `podman rm` of it.
That is a deliberate round-one choice, not an oversight: this deployment exists to run E8 rungs,
and each run starts from an empty Redis anyway. `--restart=always` and `podman-restart.service`
bring the container back, not the data that was in it.

## Where the env file lives

`/etc/moca/supervisor.env` (mode 0640, root-owned — `install_env` runs as
root and does not `chown` to `harness`; that's fine, since systemd reads `EnvironmentFile=`
as PID 1, before dropping privileges to `User=harness`), installed once from
`deploy/vm/env/supervisor.env.example`. `SH_TURNS_PER_WORKER` — the per-worker cap on
in-flight turns (S) — has no default anywhere in this deployment: its correct value is an
_output_ of experiment E8, not a guess, so shipping one would silently truncate the E8
ladder it exists to measure. Left unset, the supervisor's own startup check (`readConfig`)
refuses to start rather than falling back to a wrong value.

## Configuration not in the shipped env files

Two supervisor-related variables from spec §3.8 are deliberately **absent** from
`env/supervisor.env.example` and from both unit files — this is a standing decision, not an
oversight, and `deploy/vm/tests/setup-vm.test.sh` asserts `SH_ADMIN_PORT`'s absence directly
(its else-branch depends on it).

- **`SH_ADMIN_PORT`** (default `8081`) — the loopback-only (`127.0.0.1`), unauthenticated
  `/metrics` listener the supervisor opens whether or not you configure it (§5.2). `0` asks
  the kernel for an ephemeral port instead. `readConfig` rejects a value equal to `PORT`
  (`EADDRINUSE` at boot otherwise), with `0` exempt since the kernel hands out a distinct
  ephemeral port each time. The default is correct for this single-VM target, so it is not in
  `supervisor.env.example`: an operator who does not need to move the admin port should not
  have to think about it, or about accidentally setting it equal to `PORT`.
- **`SH_STATS_INTERVAL_MS`** (default `1000`) — paces the worker's advisory `stats` telemetry
  only; nothing on the routing path depends on it. It is read by the **worker process**, not
  the supervisor, so it reaches a worker through the environment the supervisor spawns it
  with (inherited from the supervisor unit's own environment), not through the supervisor's
  own `readConfig`. There is accordingly no supervisor-side reason to set it in
  `supervisor.env`, and no unit-file line to set it either.

If an operator needs to change either of these, set them directly in
`/etc/moca/supervisor.env` (they are ordinary env vars the supervisor process
reads at startup) — just be aware that adding an uncommented `SH_ADMIN_PORT` line there will
change what `deploy/vm/tests/setup-vm.test.sh` expects if the test is ever extended to check
for it.

## What round one does not claim

The systemd `[Service]` hardening directives in `sh-supervisor.service` and
`sh-relay.service` (`ProtectSystem=strict`, `NoNewPrivileges=true`, `SystemCallFilter=`, and
friends) are the VM analogue of a pod's `securityContext` — they narrow the filesystem and
syscall surface available to each process. They are **present, not equivalent**: this round
does **not** claim security-context parity with the Kubernetes deployment, and it does
**not** have any analogue of Kubernetes `NetworkPolicy` egress control. systemd has no
per-unit network-egress primitive comparable to a `NetworkPolicy`, so a VM deployment is
strictly more exposed on that axis until the Z2/Z5 work lands.
