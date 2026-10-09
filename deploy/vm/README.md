# Single-VM deployment (P6 process-manager runtime)

Round one's target for the VM process-manager runtime (spec §4.3, §4.4, step 4): a single
Linux VM running the supervisor, the relay and the MU1 control plane under systemd, with Redis and
the sandbox containers as podman containers alongside them. `setup-vm.sh` is the sibling of
`deploy/knative/setup-kind.sh` and `deploy/knative/setup-ocp.sh`.

> P4 microVM tier on the same host: see [deploy/microvm/P4-ON-P6.md](../microvm/P4-ON-P6.md).

## Prerequisites

- A Linux VM with systemd and [podman](https://podman.io/) installed, with a netavark network
  backend that enforces `isolate=strict`. `setup-vm.sh` refuses a podman that rejects the option,
  but cannot detect one that stores it without enforcing it. Isolation was verified live on
  netavark 1.17.2.
  - Some distributions package no podman; Amazon Linux 2023 is one. A static build such as
    [podman-static](https://github.com/mgoltzsche/podman-static) installs under `/usr/local`, and
    `sudo`'s `secure_path` there drops `/usr/local/bin`. `setup-vm.sh` then stops with
    "missing required commands: podman" and names the fix: run it as
    `sudo env PATH="/usr/local/bin:$PATH" ./deploy/vm/setup-vm.sh`. The whole flow, the control
    plane included, was verified on Amazon Linux 2023 (systemd 252) with podman-static 6.1.2.
- systemd 247 or newer (`LoadCredential=`). `setup-vm.sh` checks and refuses an older one (RHEL 8
  ships 239), which would ignore the key and leave the control plane without its secrets.
- `nft` (nftables), which loads the sandbox network's firewall
- Node.js 22+ and pnpm 9+ on the VM (the supervisor and relay run directly via
  `node --import tsx`, not containerized)
- A user able to install systemd units under `/etc/systemd/system` and run as root (see
  "Bring it up" below)
- A system user and group named `harness` (all three units run as `User=harness`/`Group=harness`):
  e.g. `sudo useradd --system --no-create-home --shell /usr/sbin/nologin harness`
- For logins: a GitHub OAuth app with **device flow enabled** (it is off by default), and outbound
  HTTPS from the VM to `github.com` and `api.github.com`. Its client id goes in `control-plane.env`
  (`SH_GITHUB_CLIENT_ID`), by hand or from `setup-vm.sh`'s environment (see "The GitHub OAuth app"
  below). Without one, the control plane is installed but not started.
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

## Upgrading an existing VM

**Re-run `setup-vm.sh` after pulling; do not just restart the relay.** Since MI1 S1 the relay
refuses to boot without `MOCA_RELAY_EXEC_TOKEN`, which `git pull && systemctl restart
sh-relay.service` never creates. `sudo ./deploy/vm/setup-vm.sh` generates it, migrates `relay.env`
and `supervisor.env` together to the loopback exec listener, installs the sandbox network and
firewall, and restarts what it owns (step 3 below).

Since #366 a re-run also installs the control plane. It writes `control-plane.env`, installs
`sh-control-plane.service`, generates the MU1 secrets once into
`/etc/serverless-harness/credentials/`, and wires `supervisor.env`: it adds the public keyset
(`SH_SESSION_TOKEN_PUBLIC_KEYS`) and `SH_CONTROL_PLANE_URL`, and sets **`SH_REQUIRE_AUTH=true`**.
**From then on, `/turn` without a session token is refused.** A driver that calls it bare, such as an E8 rung, needs
`SH_REQUIRE_AUTH=false` set back in `supervisor.env`; later re-runs keep that choice.

A hand-written MU1 line from the previous `mocactl` README (for a control plane hosted elsewhere)
makes the script stop and name it. `SH_EXCHANGE_TOKEN` in `supervisor.env` (or any of the three
secrets in either env file) is now a systemd credential: move the value into its file under
`credentials/` (mode 0600), or delete the line to have a new one generated. A
`SH_SESSION_TOKEN_PUBLIC_KEYS` line with no private key beside it is half a keypair: delete it, and
the re-run generates a matching pair. A hand-set `SH_CONTROL_PLANE_URL` is replaced by this VM's
on the run that generates the pair.

An upgraded `supervisor.env` keeps the old template's "MU1 caller authentication" comment block
and its commented `#SH_EXCHANGE_TOKEN=` line. Both are inert (a comment is never read, and the
exchange token now comes from `credentials/`) and can be deleted.

## Bring it up

```bash
cd /opt/serverless-harness   # this checkout, on the VM, already built (see Prerequisites)
sudo ./deploy/vm/setup-vm.sh
```

**A first run takes two invocations, by design.** The script installs the env files and then
refuses to go further until `SH_RELAY_TOKEN` is set in the `relay.env` it just wrote (the relay's
token validation is fail-closed, so starting containers before that guarantees sandboxes that can
never attach — see "Sandbox container networking and the relay token" below). So on a fresh VM:

```bash
sudo ./deploy/vm/setup-vm.sh        # writes the env files, then stops at the token check
sudoedit /etc/serverless-harness/relay.env           # SH_RELAY_TOKEN=<a shared secret>
sudoedit /etc/serverless-harness/control-plane.env   # SH_GITHUB_CLIENT_ID, SH_PUBLIC_HARNESS_URL
sudoedit /etc/serverless-harness/supervisor.env      # SH_TURNS_PER_WORKER
sudo ./deploy/vm/setup-vm.sh        # installs units, starts containers, enables the services
```

The control-plane pair can instead be passed to either run, as
`sudo env SH_GITHUB_CLIENT_ID=… SH_PUBLIC_HARNESS_URL=… ./deploy/vm/setup-vm.sh`. The script
writes each one only where `control-plane.env` has none (see "The GitHub OAuth app" below).

The first invocation exits non-zero with a message naming `SH_RELAY_TOKEN` and the file. That is
the expected first-run path, not a failure to debug. The second invocation keeps the env files you
edited (`install_env` never clobbers an existing one) and continues past the check. Only the relay
token blocks the second run. Without the control-plane settings (for `SH_PUBLIC_HARNESS_URL`
behind a tunnel, see "The control plane" below) the control plane is installed but not started;
the supervisor is never started by the script, and `SH_TURNS_PER_WORKER` is what lets you start it
(below).

Across those two runs, the script does the following, in this order:

1. Writes `/etc/serverless-harness/supervisor.env`, `relay.env` and `control-plane.env` from their
   `env/*.example` templates — only the first time each; an operator-edited env file is never
   clobbered on a re-run. Then, if `SH_GITHUB_CLIENT_ID` or `SH_PUBLIC_HARNESS_URL` is set in the
   script's environment, writes it into `control-plane.env` where that file's value is empty
   (never replacing one; a disagreement is warned about), after checking both values first.
2. **Checks `relay.env` for a non-empty `SH_RELAY_TOKEN`, and stops here if there is none.**
   Everything below runs only once that is set — which is why a fresh VM needs the second
   invocation above.
3. Generates `MOCA_RELAY_EXEC_TOKEN` — the supervisor's credential for the relay's `SandboxExec` —
   into both env files when absent, one value, never replacing an existing one; and checks that
   the relay's exec listener (`MOCA_RELAY_EXEC_ADDR` in `relay.env`) and the supervisor's dial
   address (`SH_RELAY_ADDR` in `supervisor.env`) agree. On a VM set up before MI1 — `relay.env`
   with no `MOCA_RELAY_EXEC_ADDR`, `supervisor.env` dialing `127.0.0.1:9443` — both files are
   migrated together to the loopback exec listener `127.0.0.1:9444`. Any other disagreement (one
   file migrated and not the other, or two different ports) stops the script with a message naming
   both values.
4. Generates the MU1 secrets, once and only those missing (see "The control plane" below). On the
   run that generates the signing keypair, it points `supervisor.env` at this VM's control plane
   (`SH_CONTROL_PLANE_URL`) and requires session tokens (`SH_REQUIRE_AUTH=true`).
5. Installs `systemd/sh-supervisor.service`, `systemd/sh-relay.service` and
   `systemd/sh-control-plane.service` into `/etc/systemd/system`, reloads the daemon, and enables
   `podman-restart.service` so the containers below come back after a reboot (see "Reboots" below).
6. Starts a Redis container on podman's **default** network (published on `127.0.0.1:6379`), which
   `isolate=strict` below keeps unreachable from sandboxes.
7. Creates a dedicated `moca-sandbox` podman network (fixed subnet `10.89.40.0/24`, gateway
   `10.89.40.1`, `isolate=strict` so it exchanges no traffic with any other podman network) and
   installs an nftables table that confines it, then starts `SH_SANDBOX_COUNT` (default 2) sandbox
   containers on that network, wired to reach the relay and to authenticate to it. The firewall is
   in place before the first sandbox starts. See "Sandbox container networking and the relay
   token" below.
8. Enables **and restarts** `sh-relay.service`. Enables `sh-control-plane.service`, and restarts it
   once `SH_GITHUB_CLIENT_ID` and `SH_PUBLIC_HARNESS_URL` are both set in `control-plane.env`;
   until then it is only `try-restart`ed, for the supervisor's reason below. Only **enables**
   `sh-supervisor.service` — it is deliberately not started yet (see below).

**A re-run restarts what it owns.** `systemctl enable --now` leaves an already-running unit alone,
so env and unit changes from a re-run would otherwise wait for the next reboot. `setup-vm.sh`
therefore restarts `sh-relay.service` on every run, reloads the sandbox firewall table directly
(its unit is only started, never restarted: through `RequiredBy=` a restart would also restart
`podman-restart.service` and every `--restart=always` container), and
`try-restart`s `sh-supervisor.service` — restarted if it is running, left stopped if it is not, so
a supervisor whose `SH_TURNS_PER_WORKER` is not set yet is never started by the script.
`sh-control-plane.service` is restarted once configured and `try-restart`ed until then. It is
**enabled** either way, though, so an unconfigured one is started on every **boot**: with no
`SH_GITHUB_CLIENT_ID` it refuses to boot, `Restart=always`/`RestartSec=2` retries it, and systemd's
default start limit (5 starts in 10 seconds) leaves it `failed` about ten seconds after boot, with
`systemctl is-system-running` reporting `degraded`. That repeats on each boot until you set
`SH_GITHUB_CLIENT_ID` and `SH_PUBLIC_HARNESS_URL` and re-run `setup-vm.sh`, which restarts it. (With
the client id set but no `SH_PUBLIC_HARNESS_URL` it does boot, advertising no harness.) To opt out, `sudo systemctl disable sh-control-plane.service`; a re-run of
`setup-vm.sh` enables it again. A re-run
also recreates Redis and the sandbox containers (`podman run --replace`), so Redis state is lost
(see "Reboots" below).

`SH_TURNS_PER_WORKER` ships empty on purpose (see below), and `readConfig` throws on blank, so
the supervisor unit is _expected_ to fail if it starts before the operator sets it. With
`Restart=always`/`RestartSec=2` and no `StartLimitIntervalSec=0`, starting it in that state
trips systemd's default 5-starts-in-10s limit in about ten seconds, and the unit then refuses
even the ordinary recovery command until you `systemctl reset-failed` it. `setup-vm.sh` avoids
that entirely by enabling the unit (so it starts on future boots) without starting it now.
Before starting it for the first time, edit `/etc/serverless-harness/supervisor.env` and set
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

## The control plane

**What runs.** `sh-control-plane.service` runs `packages/control-plane` on `127.0.0.1:8090`
(`SH_CONTROL_PLANE_HOST`, `SH_CONTROL_PLANE_PORT` in `control-plane.env`). Credentials use the
**file** store (`SH_CREDENTIAL_STORE=file`) in `/var/lib/moca-control-plane` (`SH_CREDENTIAL_DIR`,
the unit's `StateDirectory`, mode `0700`), envelope-encrypted under the KEK. Sessions live in the
same loopback Redis container as the supervisor's, so a reboot's lost Redis state (see "Reboots"
below) loses sessions, not credentials. Vault (`SH_CREDENTIAL_STORE=vault`) is the multi-host
option and is not wired by `setup-vm.sh`: a follow-up (#362 item 1).

### The GitHub OAuth app

Login is GitHub's **device flow** (`mocactl login` prints a code; the user types it at
`https://github.com/login/device`). The control plane needs one GitHub OAuth app for it, and only
its **client id**: the device flow treats the app as a public client, so there is no client secret
to store.

1. On GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App** (or the same page under
   an organization's settings). Any application name. Homepage URL and authorization callback URL
   are required fields, but the device flow never uses them: use the repository URL for both.
2. On the created app's page, tick **Enable Device Flow** and **Update application**. It is **off by
   default**, and forgetting it is the likeliest first-run failure. `mocactl login` then prints this
   (one line), and the control plane's log carries the same fix:

   ```
   login failed: the control plane cannot log anyone in until its operator fixes it — the control plane's GitHub OAuth app has the device flow off (device_flow_disabled): tick Enable Device Flow on the app
   ```

3. Copy the **Client ID** (`Ov23li…` for a new OAuth app). Do not generate a client secret. A
   mistyped id is a client GitHub does not know, and the line ends instead with:

   ```
   GitHub knows no OAuth app with client id Ov23li… (20 chars) (Not Found): check SH_GITHUB_CLIENT_ID
   ```

   It shows only the start and the length of the id: the reply goes to anyone who can reach the
   control plane, and a wrong value may be a pasted secret.

4. Give it to the control plane, in either of two ways:
   - on the setup run, through `sudo env` (sudo drops the rest of the environment). The same goes
     for the harness URL, since the control plane starts only once it has both:

     ```bash
     sudo env SH_GITHUB_CLIENT_ID=Ov23li... SH_PUBLIC_HARNESS_URL=http://127.0.0.1:8080 \
       ./deploy/vm/setup-vm.sh
     ```

     `setup-vm.sh` writes each value only where `control-plane.env` has none. It never replaces one
     you have already set, and warns if the environment disagrees with the file.

   - or by hand: set both `SH_GITHUB_CLIENT_ID=` and `SH_PUBLIC_HARNESS_URL=` in
     `/etc/serverless-harness/control-plane.env`, then re-run `setup-vm.sh`. With only the client
     id, the script leaves the control plane stopped, and a manual `systemctl restart` boots it
     advertising no harness, so `mocactl doctor` fails at check 5.

The login asks for the `read:user` scope only. The subject is the **numeric** GitHub user id
(`github:<id>`), never the login name, and GitHub's access token is used once, to read that id, and
then dropped. To make someone an admin (`GET /v1/sessions?owner=…`), put their subject in
`SH_ADMIN_SUBJECTS` and restart the control plane. Roles are computed at login and carried in
the API token, so the user must then log in again (`mocactl login`). `GET /v1/me` with the new
token shows the role.

**Network.** The VM must reach `https://github.com` (the device-code and token endpoints) and
`https://api.github.com` (`/user`) outbound. Each user's browser must reach
`https://github.com/login/device`. The laptop running `mocactl` talks only to the control plane and
the harness it advertises, never to GitHub.

**Who may log in.** Anyone with a GitHub account who can reach the control plane. The OAuth app
does not restrict users, and the control plane has no allowlist. The SSH tunnel or firewall
allowlist below is what limits who can reach it. Two users on this VM each see only their own
sessions (404, not 403, for anyone else's), but on the container tier they share sandbox
containers. And an SSH account is more than a way to reach the control plane: unless it is
restricted to the two forwarded ports ("Reaching it" below), its holder can reach Redis and take
over any session. See "What round one does not claim".

### Secrets

They all live in `/etc/serverless-harness/credentials/` (directory `0700`, files `0600`, owner
root), and each unit loads its own with `LoadCredential=` under the setting's own name:

| File                        | Setting                        | Loaded by                       |
| --------------------------- | ------------------------------ | ------------------------------- |
| `session-token-private-key` | `SH_SESSION_TOKEN_PRIVATE_KEY` | control plane                   |
| `credential-kek`            | `SH_CREDENTIAL_KEK`            | control plane                   |
| `exchange-token`            | `SH_EXCHANGE_TOKEN`            | control plane _and_ supervisor  |
| `operator-inference-token`  | `SH_OPERATOR_INFERENCE_TOKEN`  | control plane, optional (below) |

The public half of the signing key is not a secret: it is the `SH_SESSION_TOKEN_PUBLIC_KEYS` line
in `supervisor.env`. Setting any of them as an env line as well makes the unit refuse to boot
(and `setup-vm.sh` stops before that, naming the line).

`setup-vm.sh` generates them once, with the checkout's own `packages/control-plane/src/genkeys.ts`,
and a re-run never replaces one. It generates only a file that is missing, so rotation is by
hand: delete the file and re-run, which restarts the running units onto the new value. The private
key and the `SH_SESSION_TOKEN_PUBLIC_KEYS` line are one keypair: delete both, or the script stops on
half a pair. A new keypair invalidates every live token and re-wires `supervisor.env` as on first
install, `SH_REQUIRE_AUTH=true` included. **A new KEK makes every stored credential
undecryptable**, so with `credential-kek` missing and records in `SH_CREDENTIAL_DIR`, the script
stops: restore the KEK from a backup, or empty the store deliberately.

**The limit.** `LoadCredential=` keeps the secrets out of env files, out of `/proc/<pid>/environ`
and out of every child process's environment. It does not keep them from a child process: children
inherit `CREDENTIALS_DIRECTORY` and the `harness` uid, so they can read the files. Nor is it a uid
boundary. All three units run as `harness`, so a compromise of the supervisor's uid can read the
control plane's credentials. A dedicated control-plane user is a follow-up.

**The operator-key fallback** (`SH_ALLOW_OPERATOR_FALLBACK=true`, off by default) lets a user who
has stored no inference credential spend the operator's key. Every such turn is audited as
`operator_fallback_used`. The key is the one secret `setup-vm.sh` does not create: put it in its
file yourself, set the fallback's settings in `control-plane.env`, and re-run the script. It sees
the file and installs a drop-in (`sh-control-plane.service.d/50-operator-inference-token.conf`) that
loads it with `LoadCredential=`. It never reads the value.

```bash
sudo install -m 0600 /dev/null /etc/serverless-harness/credentials/operator-inference-token
sudoedit /etc/serverless-harness/credentials/operator-inference-token   # the key; mode is kept
sudoedit /etc/serverless-harness/control-plane.env
#   SH_ALLOW_OPERATOR_FALLBACK=true
#   A gateway token:        SH_DEFAULT_INFERENCE_ENDPOINT=https://<gateway>
#   An Anthropic API key:   SH_DEFAULT_INFERENCE_ENDPOINT=https://api.anthropic.com
#                           SH_OPERATOR_INFERENCE_HEADER=x-api-key
cd /opt/serverless-harness && sudo ./deploy/vm/setup-vm.sh
```

The control plane refuses to boot on a fallback that cannot work, naming the setting to fix:

- no token;
- no default endpoint;
- an Anthropic key on the Bearer header, or aimed at anything but `https://api.anthropic.com`;
- an `sk-ant-oat…` OAuth token.

`journalctl -u sh-control-plane` shows which. `setup-vm.sh` itself stops on:

- `SH_ALLOW_OPERATOR_FALLBACK=true` with no token file;
- a token file that is empty, a dangling symlink, or readable by anyone but its owner (not 0600 or
  0400; for a symlink, its target's mode);
- the token as a line in `control-plane.env`, in any spelling systemd accepts (indented, or with
  spaces around `=`);
- another drop-in that also loads `SH_OPERATOR_INFERENCE_TOKEN`, such as the `systemctl edit`
  `override.conf` this README described before.

For that last one, delete the drop-in's `LoadCredential=` line and re-run: the script manages the
credential itself now.

To turn the fallback off, set `SH_ALLOW_OPERATOR_FALLBACK=false`. To remove the key as well, delete
the file and re-run: the drop-in goes with it.

A session's credential is fixed when the session is created, in both directions:

- A session started on the fallback keeps spending the operator's key after its user stores a
  credential of their own. Only a new session picks that credential up. Turning the fallback off ends
  those sessions' turns with a message saying to start a new one.
- A session started on the user's own credential never moves onto the operator's key. If the user
  deletes that credential (because it leaked, say), the session's next turn is refused, naming it.

### Reaching it: the supported demo topology

Both the control plane and the supervisor speak **plain HTTP**; TLS termination is out of scope
for this round. A client needs two ports: the control plane (8090) and the harness it advertises
(`SH_PUBLIC_HARNESS_URL`, the supervisor on 8080). Two topologies are supported:

- **(a) An SSH tunnel, the default.** Each user runs
  `ssh -f -N -o ExitOnForwardFailure=yes -L 8090:127.0.0.1:8090 -L 8080:127.0.0.1:8080 <vm>`
  (`-f` backgrounds it once both forwards are up; `ExitOnForwardFailure` fails instead of
  warning when a local port is taken). On the VM, set
  `SH_PUBLIC_HARNESS_URL=http://127.0.0.1:8080`; on the laptop, run
  `mocactl --control-plane-url http://127.0.0.1:8090 …`. Because the harness URL is advertised,
  **every user must forward the same local port**.

  An SSH account reaches **every** loopback service, including Redis (no password: it holds the
  session-ownership index) and the supervisor's unauthenticated admin listener on 8081. Anyone
  who can write that index can make another user's session their own. So give users who are not
  operators an account that can forward the two ports and nothing else, at the end of
  `/etc/ssh/sshd_config`:

  ```
  Match User user1,user2
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:8090 127.0.0.1:8080
    AllowStreamLocalForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    ForceCommand /usr/sbin/nologin
  ```

  `docs/demos/vm-two-user-acceptance.md` (0a, 0b) installs it and checks it from a laptop.

- **(b) A cloud firewall allowlist.** Set `SH_CONTROL_PLANE_HOST=0.0.0.0` and
  `SH_PUBLIC_HARNESS_URL=http://<vm-address>:8080`, and allow 8090 and 8080 from the users'
  addresses only. Tokens and credentials then cross the network in clear.

The supervisor already listens on `0.0.0.0:8080`. With `SH_REQUIRE_AUTH=true` every turn needs a
session token, but that is not a substitute for the allowlist.

### Session discovery

`/v1/sessions/{id}/resources` answers `sandbox.phase: "unknown"` on a VM:
there is no kubectl, and the control plane treats that like a Kubernetes outage. `mocactl` does
not use the route.

### Checking it

On the VM, `curl -s 127.0.0.1:8090/readyz`. From a laptop, through the tunnel,
`mocactl --control-plane-url http://127.0.0.1:8090 doctor`. Doctor stops at its first failure,
and "harness trusts this control plane" (check 7) comes after "logged in" (3) and "inference
credential present" (4). `mocactl login` (GitHub's device flow) gets past check 3. To check the
wiring without a GitHub login, mint an API token on the VM the way `deploy/compose/smoke.sh` does.
The key stays in its root-only file, and the output goes to stdout only:

```bash
cd /opt/serverless-harness/packages/control-plane
sudo node --import tsx --input-type=module <<'EOF'
import { readFileSync } from 'node:fs';
import { makeSigner } from './src/token.ts';
const s = makeSigner(readFileSync('/etc/serverless-harness/credentials/session-token-private-key', 'utf8'));
const sub = 'demo:1', ttlSeconds = 3600, now = Math.floor(Date.now() / 1000);
const apiToken = s.mint({ sub, tenant: sub, roles: [], scope: ['api'], ttlSeconds, now });
const auth = { apiToken, subject: sub, roles: [], expiresAt: now + ttlSeconds, controlPlaneUrl: 'http://127.0.0.1:8090' };
process.stdout.write(JSON.stringify(auth) + '\n');
EOF
```

That line is a complete `mocactl` login cache (`expiresAt` in epoch **seconds**; `controlPlaneUrl`
must equal the `--control-plane-url` you pass). Save it on the laptop as `mocactl/auth.json` under
`$XDG_CONFIG_HOME` (default `~/.config`), mode 0600, creating the directory first:

```bash
mkdir -p -m 0700 "${XDG_CONFIG_HOME:-$HOME/.config}/mocactl"
(umask 077 && cat > "${XDG_CONFIG_HOME:-$HOME/.config}/mocactl/auth.json")   # paste, then Ctrl-D
```

A hand-minted cache carries no refresh token, so it works until its own `expiresAt` and then asks
for `mocactl login`, exactly as before B14. Use the device flow for a login that renews itself.

Then add an inference credential with `/credentials` in `mocactl`, and run `doctor`.

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

`/etc/serverless-harness/relay.env` is created by `setup-vm.sh` itself, so on a fresh VM there is
nothing to edit until the script has run once — this is the two-invocation first run described under
"Bring it up". After that first run:

```bash
sudoedit /etc/serverless-harness/relay.env   # set SH_RELAY_TOKEN=<a shared secret>
sudo ./deploy/vm/setup-vm.sh                 # re-run; the edited file is preserved
```

Appending instead of editing works equally well once the file exists
(`echo 'SH_RELAY_TOKEN=…' | sudo tee -a /etc/serverless-harness/relay.env`) — but only then, since
the directory and file do not exist before `install_env` creates them.

Whichever way you set it, the value must match each sandbox worker's `SANDBOX_TOKEN`;
`setup-vm.sh` reads it back out of `relay.env` and passes exactly that to every container it
starts, so editing this one file is enough.

**Reaching the host from a container.** `host.containers.internal` is podman's documented
analogue of Docker's `host.docker.internal`. Podman's own `host-gateway` special value resolves
it to whatever the host actually listens on — every port bound to `0.0.0.0`, not just the
relay's — so `setup-vm.sh` instead runs sandboxes on their own dedicated podman network,
`moca-sandbox` (fixed subnet `MOCA_SANDBOX_SUBNET`, default `10.89.40.0/24`), and pins
`host.containers.internal` to that network's gateway (`MOCA_SANDBOX_GATEWAY`, default
`10.89.40.1`) with an explicit `--add-host` on every `podman run`, rather than depending on
netavark's automatic `/etc/hosts` population (which differs between rootful and rootless podman
and across versions). The default address is therefore `host.containers.internal:<port>`, where
`<port>` comes from `SH_RELAY_PORT` in the installed `relay.env` (falling back to `8443`, the
code's own default, if that line is missing). Override the whole address with
`SH_SANDBOX_RELAY_ADDR` if this default does not resolve on your VM's actual network setup.

**Confining the sandbox network to the relay's attach port (MI1 R8).** A dedicated network only
changes what address a sandbox dials — by itself it does not stop a sandbox from reaching
anything else the host listens on, since podman still routes the whole subnet to the host
through that gateway. `setup-vm.sh` also renders an nftables table
(`$SH_ENV_DIR/moca-sandbox.nft`, table `inet moca_sandbox`) that drops all traffic arriving from
the `moca-sandbox` network to the host **except** the relay's attach port (`SH_RELAY_PORT`) and DNS
(port 53, answered by podman's own resolver on the gateway), and loads it immediately with
`nft -f`. `deploy/vm/systemd/moca-sandbox-firewall.service`, a oneshot unit ordered `Before=`
`sh-relay.service` and `podman-restart.service`, re-loads that same table on every boot, so the
restriction survives a reboot and is in place before the relay — and so before any sandbox
container — starts. The unit is also `RequiredBy=` both, so the deployment fails closed: if the
table does not load at boot, the relay does not start and neither does `podman-restart.service`,
which keeps Redis and every `--restart=always` container down until the firewall loads. The table
only filters the `input` hook (traffic addressed to the host itself); forwarded traffic (outbound
internet access from a sandbox) is untouched in this round — that is MI1 S5's `moca-egress` work,
not this one. The rules match the bridge a packet arrives on — `MOCA_SANDBOX_BRIDGE`, default
`moca-sandbox0`, pinned when the network is created and checked on every run — not only its source
address: netavark leaves IPv6 enabled on the bridge and in every container, so link-local IPv6
reaches the host even though `moca-sandbox` has only an IPv4 subnet. Three rules accept: replies on
connections that are already established (`ct state established,related`, on that bridge only), and
new IPv4 connections from the sandbox subnet to the relay's attach port and to DNS. Everything else
arriving on the bridge, IPv6 included, is dropped.

`SandboxExec` is not served on the `moca-sandbox` network at all: the relay binds it on loopback
(`MOCA_RELAY_EXEC_ADDR=127.0.0.1:9444`), and the exec token (`MOCA_RELAY_EXEC_TOKEN`, held only by
the relay and the supervisor) is the control.

**What has been verified on a real host, and what has not.** One live run (2026-09-29) on Amazon
Linux 2023 (kernel 6.18), with rootful podman 5.8.7 (a static build — Amazon Linux 2023 packages no
podman), netavark 1.17.2 using its nftables firewall driver, and nftables 1.0.4, confirmed from
inside a sandbox container:

- the relay's attach port on the gateway connects;
- every other host port tried (22, 8080, 8081, 9444, 6379) is dropped, over IPv4 and over IPv6
  link-local;
- DNS resolves and outbound internet works;
- Redis on podman's default network is unreachable (`isolate=strict`).

On the same host:

- with the table made unloadable, `sh-relay.service` and `podman-restart.service` both refuse to
  start;
- a pre-MI1 install migrates to the split exec listener;
- a fresh install with the default image completes a turn.

Not verified: SELinux- or AppArmor-enforcing hosts, rootless podman, a distro-packaged podman, and
an actual reboot — the fail-closed ordering was exercised with `systemctl`, not a boot.

If a sandbox container cannot attach on a real VM, `SH_SANDBOX_RELAY_ADDR` (or, if podman itself
cannot resolve `host.containers.internal`, the VM's actual gateway or bridge IP) is the override to
reach for first; `sudo nft list table inet moca_sandbox` shows the loaded rules.

**Cloud instance metadata is still reachable from sandboxes.** Because forwarded traffic is
untouched, a sandbox can reach `169.254.169.254`. On a cloud VM that can expose the instance's own
role credentials, which belong to the host, not to any session. Until S5 filters egress, close it at
the platform. On EC2, require IMDSv2 with a hop limit of 1 (`aws ec2 modify-instance-metadata-options
--http-tokens required --http-put-response-hop-limit 1`): a forwarded container request then cannot
obtain a token. On other clouds, use the equivalent, or drop `169.254.0.0/16` from `moca-sandbox0`
in your own forward-hook table. The in-product fix is tracked in rossoctl/moca#357.

## A research turn: curl and git in the sandbox

**Sandbox egress is open in this round.** The firewall above filters only traffic _to the host_.
Forwarded traffic isn't filtered, so the agent's bash tool reaches the whole internet from a sandbox
container: any host, any port, with no proxy and no allowlist. That includes cloud instance metadata:
close it at the platform first (above, #357). Egress control is MI1 S5's `moca-egress`, not this
round. The container image guarantees `git`, `curl` and CA certificates (#368), and `HOME` is a
writable `/home/sandbox`, so `git config --global` works.

Pi shows the model only the last 2000 lines or 50 KB of a command's output, so the prompt steers the
agent to `curl -o` a file and read it with `grep`/`head`, rather than printing it. The demo's prompt,
for `mocactl run` or the interactive UI:

```text
This is a research task. Use your bash tool for every step, and do not answer from memory.
1. Run: git clone --depth 1 https://github.com/rossoctl/moca /workspace/research-demo/moca
2. Run: curl -fsSL -o /workspace/research-demo/node-releases.json https://nodejs.org/dist/index.json
   The file is large: do not print it. Read what you need from it with head, grep or python3.
3. Find the commit the clone checked out, and the newest Node.js release in the fetched file (its
   first entry) with its release date.
Reply with one short paragraph saying what you found, then end with exactly these three lines:
COMMIT=<the first 12 characters of the commit hash>
NODE_VERSION=<the version, for example v1.2.3>
NODE_DATE=<its date, YYYY-MM-DD>
```

Neither answer can come from a model's memory: the clone's HEAD changes with every merge, and the
newest Node.js release every few weeks. Check them with `git ls-remote https://github.com/rossoctl/moca HEAD`
and https://nodejs.org/dist/index.json.

`git clone` refuses a destination that already exists, so to run the prompt a second time on the same
container, remove `/workspace/research-demo` first (for example
`sudo podman exec sh-sandbox-0 rm -rf /workspace/research-demo`, on each container), or change the
directory name in the prompt.

On the container tier, every session shares one `/workspace` per container
(`remote-worker/internal/exec/runner.go` ignores the workspace key). So a second user's turn can see
the first user's `research-demo` directory if both land on the same container. It is not a security
boundary in this round (epic #370).

**The automated check.** `deploy/vm/research-smoke.sh` runs that prompt as a freshly minted user,
in a per-run directory. It passes only if:

- `git clone` and `curl -o` both appear in the turn's `tool_use` frames and succeed;
- the answer's three values equal what the **sandbox's own copy** of the fetched files says;
- the control plane's audit shows the intended credential was spent.

Run it on the VM, as root, on a host with container sandboxes. It refuses to run while a microVM
worker is in the pool, because that tier has no network (#277).

```bash
# The user's own credential, from a root-only file holding exactly one line, the key alone (an
# sk-ant-api… key goes as x-api-key to https://api.anthropic.com; anything else as Bearer to
# RESEARCH_ENDPOINT):
sudo install -m 0600 /dev/null /root/inference-key && sudoedit /root/inference-key
cd /opt/serverless-harness
sudo VM_RESEARCH_SMOKE=1 RESEARCH_CREDENTIAL_FILE=/root/inference-key ./deploy/vm/research-smoke.sh
sudo VM_RESEARCH_SMOKE=1 RESEARCH_CREDENTIAL_FILE=/root/gw-token \
  RESEARCH_ENDPOINT=https://<gateway> ./deploy/vm/research-smoke.sh
# Or no credential of its own, on the operator-key fallback ("The operator-key fallback", above):
sudo VM_RESEARCH_SMOKE=1 RESEARCH_USE_OPERATOR_FALLBACK=1 ./deploy/vm/research-smoke.sh
```

It deletes its credential, session and fetched files afterwards (`KEEP=1` leaves them). A failed run
keeps its SSE transcript in the directory it names.

## Reboots

All three units are `WantedBy=multi-user.target`, so systemd brings the relay, the control plane
and the supervisor back on boot. The podman containers need one extra thing: `--restart=always` (which `setup-vm.sh` now
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

`/etc/serverless-harness/supervisor.env` (mode 0640, root-owned — `install_env` runs as
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
`/etc/serverless-harness/supervisor.env` (they are ordinary env vars the supervisor process
reads at startup) — just be aware that adding an uncommented `SH_ADMIN_PORT` line there will
change what `deploy/vm/tests/setup-vm.test.sh` expects if the test is ever extended to check
for it.

**`SANDBOX_IMAGE`** (default `ghcr.io/rossoctl/moca-remote-worker:latest`) is the
image `setup-vm.sh` runs sandbox containers from. It is a variable for the script, not an env-file
setting: `sudo SANDBOX_IMAGE=<image> ./deploy/vm/setup-vm.sh`. The same name means the
Kubernetes sandbox pod image to `setup-k8s.sh`, and compose spells this concept
`SH_SANDBOX_IMAGE`, so do not export one value for all three.

## What round one does not claim

The systemd `[Service]` hardening directives in `sh-supervisor.service`, `sh-relay.service` and
`sh-control-plane.service` (`ProtectSystem=strict`, `NoNewPrivileges=true`, `SystemCallFilter=`, and
friends) are the VM analogue of a pod's `securityContext` — they narrow the filesystem and
syscall surface available to each process. They are **present, not equivalent**: this round
does **not** claim security-context parity with the Kubernetes deployment, and it does
**not** have any analogue of Kubernetes `NetworkPolicy` egress control. systemd has no
per-unit network-egress primitive comparable to a `NetworkPolicy`, so a VM deployment is
strictly more exposed on that axis until the Z2/Z5 work lands.

Nor does it claim, for the control plane:

- **TLS.** The control plane and the supervisor speak plain HTTP. The supported topologies are an
  SSH tunnel or a firewall allowlist ("The control plane" above), not an encrypted listener.
- **A uid boundary.** The control plane runs as `harness`, the same uid as the supervisor and its
  workers. `LoadCredential=` keeps its secrets out of env files and child processes' environments,
  not out of reach of a compromised `harness` process.
- **Multi-host credentials.** The file store is single-host. Vault, the multi-host store, is not
  wired by `setup-vm.sh`.
- **Sandbox egress control.** A sandbox container reaches the internet and the cloud's instance
  metadata ("A research turn" above). Filtering it is MI1 S5.
- **Sandbox isolation between users.** Session _ownership_ is enforced: each user lists only their
  own sessions, and another user's session answers 404. But on the container tier, every user's
  turns lease the same sandbox containers (`harness/src/select-sandbox.ts` has no owner filter),
  and the container worker ignores `workspace_key` (`remote-worker/internal/exec/runner.go`). So
  users share `/workspace`, the Unix user and the process list. Owner binding is MI1 S5
  (`docs/specs/2026-09-28-moca-multi-user-isolation-design.md` §9).
- **Two users after MI1 S2.** `setup-vm.sh` leaves `MOCA_TENANCY` unset (`single`). Until MI1 S2,
  `single` serves every subject that logs in. From S2 it serves only the first and refuses the rest
  with `403 single_tenant_deployment` (MI1 §6.6). `setup-vm.sh` adds no refusal of its own, since
  it cannot tell how many people will log in. `MOCA_TENANCY=multi` serves two users honestly only
  once S5's owner binding lands. Until then, run a two-user demo at `v0.5.1`
  (`docs/demos/vm-two-user-acceptance.md`, #407).
- **Ownership against loopback access.** Session ownership is enforced at the control plane's API.
  Its index is in Redis on `127.0.0.1:6379`, unauthenticated, so anyone with a shell or an
  unrestricted SSH forward on the VM can rewrite it. Restrict non-operator SSH accounts ("Reaching
  it").
