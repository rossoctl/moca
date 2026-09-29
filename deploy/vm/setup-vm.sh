#!/usr/bin/env bash
# Bring up the P6 single-VM deployment: Redis, relay, sandbox containers, supervisor unit.
# Sibling of deploy/knative/setup-kind.sh and setup-ocp.sh (spec §4.4).
#
# Prerequisites:
#   - a Linux VM with systemd and podman, Node 22+
#   - run as a user that can sudo to root (installs units under /etc/systemd/system)
#
# Usage:
#   ./deploy/vm/setup-vm.sh
#
# Env overrides:
#   SH_UNIT_DIR       Where systemd unit files are installed (default /etc/systemd/system)
#   SH_ENV_DIR        Where the supervisor/relay env files live (default /etc/moca)
#   SH_INSTALL_DIR    Where the harness checkout lives on the VM (default /opt/moca)
#   SH_SANDBOX_COUNT     Number of sandbox containers to start (default 2)
#   SANDBOX_IMAGE        Sandbox container image (default ghcr.io/rossoctl/moca-sandbox:latest)
#   SH_SANDBOX_RELAY_ADDR  Address each sandbox container uses to dial the relay (default
#                          host.containers.internal:<SH_RELAY_PORT from relay.env>). Reaching
#                          the host from inside a container is the part of this script least
#                          verified on real hardware -- override this if the default does not
#                          resolve on your VM (see deploy/vm/README.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${SH_UNIT_DIR:=/etc/systemd/system}"
: "${SH_ENV_DIR:=/etc/moca}"
: "${SH_INSTALL_DIR:=/opt/moca}"
: "${SH_SANDBOX_COUNT:=2}"
: "${SANDBOX_IMAGE:=ghcr.io/rossoctl/moca-sandbox:latest}"

log() { printf '==> %s\n' "$*"; }

require_cmds() {
  local missing=()
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  if ((${#missing[@]})); then
    echo "missing required commands: ${missing[*]}" >&2
    return 1
  fi
}

# Both units run as User=harness/Group=harness; nothing here creates that account (uid
# policy, shell, and home are an operator decision, not this script's to make). Fail loudly
# before install_units, naming the account and the units that need it, instead of letting
# systemd fail later with a confusing "user harness does not exist".
# install -d -m 0750 /etc/moca and systemctl enable both need root. Failing here
# with a clear message beats dying partway through on a confusing `install: Permission denied`.
# uid defaults to the real effective uid (via `id -u`, not $EUID, so a test can override it
# without actually running as another user). main() always calls this with zero arguments --
# only the test suite passes one -- so shellcheck's cross-call-site analysis of this file alone
# cannot see a call that uses $1, hence the disable below.
# shellcheck disable=SC2120
require_root() {
  local uid="${1:-}"
  [[ -n "$uid" ]] || uid="$(id -u)"
  if [[ "$uid" != "0" ]]; then
    echo "must run as root: this installs systemd units under $SH_UNIT_DIR and files under" \
      "$SH_ENV_DIR. Re-run as: sudo $0" >&2
    return 1
  fi
}

# ExecStart is `node --import tsx src/main.ts`; tsx is a devDependency and the workspace's
# link: targets (harness -> pi-fork) only resolve after root `pnpm install`, and pi-fork's own
# type/JS output only exists after its own build (spec §9). A fresh VM checkout has run neither,
# so both units would die with ERR_MODULE_NOT_FOUND. Building here would take minutes inside a
# bring-up script that is supposed to be fast and idempotent -- fail loudly instead, naming the
# exact commands, and let the operator run them once.
#
# root defaults to the repo root two levels above this script (deploy/vm/../..), overridable
# by SH_REPO_ROOT, itself overridable by a positional argument -- production behaviour
# (running unmodified, with no env var set) is unchanged; SH_REPO_ROOT exists only so a test
# can point this at a fabricated tree without needing a second real checkout or claiming this
# script's own worktree is built when the caller (e.g. CI's toolchain-free deploy-scripts job)
# never ran pnpm install or built pi-fork. main() always calls this with zero arguments, same
# SC2120 rationale as require_root above.
# shellcheck disable=SC2120
require_build() {
  local root="${1:-${SH_REPO_ROOT:-$SCRIPT_DIR/../..}}"
  local missing=()
  [[ -d "$root/packages/supervisor/node_modules" ]] ||
    missing+=("pnpm install has not run (packages/supervisor/node_modules is missing)")
  if [[ ! -d "$root/pi-fork/packages/ai/dist" || ! -d "$root/pi-fork/packages/coding-agent/dist" ]]; then
    missing+=("pi-fork is not built (pi-fork/packages/{ai,coding-agent}/dist is missing)")
  fi
  if ((${#missing[@]})); then
    printf 'workspace is not built:\n' >&2
    printf '  - %s\n' "${missing[@]}" >&2
    echo "run, in order (spec §9): git submodule update --init --recursive; " \
      "cd pi-fork && npm ci && npm run build && cd ..; pnpm install" >&2
    return 1
  fi
}

require_user() {
  local user="$1"
  if ! getent passwd "$user" >/dev/null 2>&1; then
    echo "missing system user '$user': sh-supervisor.service and sh-relay.service both run" \
      "as User=$user/Group=$user. Create it first, e.g.:" \
      "sudo useradd --system --no-create-home --shell /usr/sbin/nologin $user" >&2
    return 1
  fi
}

install_units() {
  log "installing systemd units into $SH_UNIT_DIR"
  install -m 0644 "$SCRIPT_DIR/systemd/sh-supervisor.service" "$SH_UNIT_DIR/"
  install -m 0644 "$SCRIPT_DIR/systemd/sh-relay.service" "$SH_UNIT_DIR/"
  systemctl daemon-reload
}

# install_env_file <name> <hint> installs deploy/vm/env/<name>.env.example to
# $SH_ENV_DIR/<name>.env, once. Never clobber an operator-edited env file: it holds the S
# that an E8 run established (supervisor.env) or the shared token a worker was configured
# with (relay.env) — either one, a silent overwrite on re-run would be a real outage.
install_env_file() {
  local name="$1" hint="${2:-}"
  if [[ ! -f "$SH_ENV_DIR/$name.env" ]]; then
    install -m 0640 "$SCRIPT_DIR/env/$name.env.example" "$SH_ENV_DIR/$name.env"
    log "wrote $SH_ENV_DIR/$name.env${hint:+ — $hint}"
  else
    log "keeping existing $SH_ENV_DIR/$name.env"
  fi
}

install_env() {
  install -d -m 0750 "$SH_ENV_DIR"
  install_env_file supervisor "set SH_TURNS_PER_WORKER before starting"
  install_env_file relay "set SH_RELAY_TOKEN before starting"
}

start_redis() {
  log "starting Redis container"
  # LOOPBACK ONLY, and this is the execution path rather than a data-at-rest concern.
  #
  # `-p 6379:6379` binds 0.0.0.0 in podman, and this image runs with no --requirepass, no ACL and no
  # TLS. On THIS deployment the supervisor ships SH_SANDBOX_DISCOVERY=records
  # (env/supervisor.env.example), and select-sandbox.ts honours that by never listing pods:
  # `const pods = source === 'records' ? [] : await list(...)`. So the only inventory of executors is
  # a set of Redis records. Anyone who can write to Redis chooses the sandbox every turn dispatches
  # to -- receiving the user's prompts and repository contents and returning whatever they like as
  # the agent's output. Admission control, the fail-closed relay token and RestrictAddressFamilies on
  # both units are all bypassed, because none of them is in that path.
  #
  # Nothing loses access: both env templates already point at redis://127.0.0.1:6379, and the sandbox
  # containers reach the RELAY, not Redis -- start_sandboxes hands them RELAY_ADDR, SANDBOX_TOKEN and
  # SANDBOX_ID and nothing else.
  #
  # The invariant was already written down for the admin listener (setup-vm.test.sh asserts it binds
  # 127.0.0.1 *because* it is unauthenticated). It simply had not been applied to the listener that
  # exposes session state, the ownership index, the lease store and sh:sandbox:records.
  #
  # NO VOLUME, deliberately for this round: session state, the ownership index and the lease store
  # are lost on every reboot and on every `podman rm` of this container. That is acceptable only
  # because this deployment exists to run E8 rungs, where each run starts from an empty Redis
  # anyway. It is stated here (and in README.md's "What round one does not claim") rather than left
  # for an operator to discover after a reboot: --restart=always below brings the container back,
  # not the data that was in it.
  podman run -d --name sh-redis --replace --restart=always \
    -p 127.0.0.1:6379:6379 docker.io/redis:7-alpine
}

# Podman's --restart=always covers a container that exits, but explicitly NOT a host reboot:
# podman-run(1) says "--restart will not restart containers after a system reboot", and points at
# podman-restart.service as the supported way to get that. Without it, the units come back on boot
# (both are WantedBy=multi-user.target) while Redis and every sandbox container do not --
# sh:sandbox:records is empty and every turn fails until somebody re-runs this script, which is a
# far worse failure than a unit that refuses to start, because everything looks healthy.
#
# Not fatal if it is unavailable: this is one podman package's unit name, and a host where it is
# missing is a host with a working bring-up and a documented reboot gap, not a host that should
# refuse to install. Warn with the consequence named, since `set -e` would otherwise abort the whole
# script here on an older podman.
enable_container_restart() {
  log "enabling podman-restart.service (containers do not survive a reboot without it)"
  if ! systemctl enable podman-restart.service; then
    echo "WARNING: could not enable podman-restart.service. --restart=always still restarts a" \
      "container that exits, but podman-run(1) is explicit that it does NOT survive a host" \
      "reboot. After a reboot, re-run this script (or start sh-redis and the sh-sandbox-*" \
      "containers by hand) before expecting any turn to succeed." >&2
  fi
}

# remote-worker/cmd/worker/main.go:93-105 reads RELAY_ADDR (default localhost:8443),
# SANDBOX_TOKEN (default dev-token), and SANDBOX_ID (default sbx-laptop-1) from its own
# environment. A bare `podman run` with none of those set means: "localhost" resolves to the
# container itself, not the host, so the worker can never reach the relay; every container
# shares one SANDBOX_ID and collides on the same Redis record; and dev-token never matches a
# fail-closed relay. relay_port/relay_token read the INSTALLED relay.env (not the .example),
# so they see the operator's real values once install_env has run. file defaults to
# $SH_ENV_DIR/relay.env; a caller may override it for testing.
# R46 (see setup-vm.test.sh): under `set -euo pipefail`, a no-match grep aborts the whole
# script right here rather than leaving these functions to report "no token"/"default port" --
# `|| true` on the grep stage keeps a missing SH_RELAY_TOKEN/SH_RELAY_PORT line a normal empty
# result instead of a fatal error. sandbox_relay_addr below always calls this with zero
# arguments -- only the test suite passes a file override -- same SC2120 rationale as
# require_root/require_build above.
# shellcheck disable=SC2120
relay_port() {
  local file="${1:-$SH_ENV_DIR/relay.env}"
  local port
  port="$( (grep -oE '^SH_RELAY_PORT=[0-9]+' "$file" 2>/dev/null || true) | tail -1 | cut -d= -f2)"
  echo "${port:-8443}"
}

relay_token() {
  local file="${1:-$SH_ENV_DIR/relay.env}"
  local token
  token="$( (grep -oE '^SH_RELAY_TOKEN=.+' "$file" 2>/dev/null || true) | tail -1 | cut -d= -f2-)"
  # systemd's EnvironmentFile= strips exactly one matched pair of surrounding quotes before
  # handing the value to the relay's own process (systemd.exec(5), "Environment Variables in
  # Spawned Processes") -- so an operator writing SH_RELAY_TOKEN="s3cr3t" gives the relay
  # s3cr3t, not "s3cr3t". Strip the same single matched pair here so this function always
  # returns what the relay actually validates against; otherwise start_sandboxes would hand
  # every container the quoted literal, the fail-closed validator would reject every attach,
  # and require_relay_token's non-empty check would still pass -- the exact silently-empty
  # sh:sandbox:records outcome B5 exists to prevent, reachable through an ordinary quoting habit.
  if ((${#token} >= 2)); then
    case "$token" in
    \"*\")
      token="${token#\"}"
      token="${token%\"}"
      ;;
    \'*\')
      token="${token#\'}"
      token="${token%\'}"
      ;;
    esac
  fi
  echo "$token"
}

# The relay's token validation is fail-closed (makeDefaultValidateToken in
# packages/sandbox-relay/src/main.ts): with SH_RELAY_TOKEN unset, every attach -- including a
# tokenless one -- is rejected. relay.env.example ships it commented out on purpose (an
# operator secret, not a default), so a fresh install produces a relay.env that cannot
# authenticate a single sandbox. Fail loudly here, before start_sandboxes ever runs a
# container that is guaranteed to fail to attach, instead of leaving that discovery to a
# silently-empty sh:sandbox:records set on the VM. main() always calls this with zero
# arguments, same SC2120 rationale as require_root/require_build above.
# shellcheck disable=SC2120
require_relay_token() {
  local file="${1:-$SH_ENV_DIR/relay.env}"
  if [[ -z "$(relay_token "$file")" ]]; then
    echo "SH_RELAY_TOKEN is not set in $file: the relay's token validation is fail-closed" \
      "(packages/sandbox-relay/src/main.ts), so every sandbox attach would be rejected." \
      "Set SH_RELAY_TOKEN there to a shared secret matching each worker's SANDBOX_TOKEN, then" \
      "re-run." >&2
    return 1
  fi
}

# Reaching the host's relay port from inside a container is the one piece of this deployment
# most likely to need a real VM run to confirm -- see the report's "Still unverified" section.
# host.containers.internal is podman's documented analogue of Docker's host.docker.internal
# (podman-run(1): the host-gateway special string). Passing --add-host explicitly on every
# `podman run` below makes that mapping deterministic rather than depending on netavark's
# automatic /etc/hosts population, which differs between rootful and rootless podman and
# across versions. SH_SANDBOX_RELAY_ADDR overrides the whole address if this default does not
# reach the relay on your VM's actual network setup.
sandbox_relay_addr() {
  echo "${SH_SANDBOX_RELAY_ADDR:-host.containers.internal:$(relay_port)}"
}

start_sandboxes() {
  log "starting $SH_SANDBOX_COUNT sandbox containers"
  local i token addr
  token="$(relay_token)"
  addr="$(sandbox_relay_addr)"
  for ((i = 0; i < SH_SANDBOX_COUNT; i++)); do
    # SANDBOX_TOKEN is passed BY NAME (`-e SANDBOX_TOKEN`, no `=`), so podman takes the value from
    # its own environment and the secret never enters argv. `-e "SANDBOX_TOKEN=$token"` would put it
    # in this process's command line, and /proc/<pid>/cmdline is world-readable on Linux unless
    # hidepid is set -- so for the lifetime of each of these invocations any unprivileged local user
    # running `ps` in a loop reads the token that require_relay_token just insisted must be a real
    # secret. The token is the whole of the relay's authentication (makeDefaultValidateToken is
    # fail-closed), so holding it means being able to attach as a sandbox, i.e. to become an executor.
    SANDBOX_TOKEN="$token" podman run -d --name "sh-sandbox-$i" --replace --restart=always \
      --add-host host.containers.internal:host-gateway \
      -e "SANDBOX_ID=sh-sandbox-$i" \
      -e "RELAY_ADDR=$addr" \
      -e SANDBOX_TOKEN \
      "$SANDBOX_IMAGE"
  done
}

start_services() {
  log "enabling relay (started now) and supervisor (enabled, not started)"
  systemctl enable --now sh-relay.service
  # SH_TURNS_PER_WORKER ships empty on purpose (§3.8) and readConfig throws on blank, so this
  # unit is EXPECTED to fail until the operator sets it. Restart=always/RestartSec=2 with no
  # StartLimitIntervalSec=0 means systemd's default 5-starts-in-10s limit trips in about ten
  # seconds if this were `enable --now`, after which even the documented recovery command
  # (`systemctl start sh-supervisor.service`) is refused with "start request repeated too
  # quickly" until `systemctl reset-failed`. Enable without --now instead: the unit is wired
  # into multi-user.target for the next boot, but nothing tries to start it yet.
  systemctl enable sh-supervisor.service
}

main() {
  require_cmds podman systemctl install node getent pnpm
  require_root
  require_build
  require_user harness
  install_env
  require_relay_token
  install_units
  # Before the containers, so a `podman run` that lands between the two is already covered.
  enable_container_restart
  start_redis
  start_sandboxes
  start_services
  log "done — relay is running. Before starting the supervisor, set SH_TURNS_PER_WORKER in" \
    "$SH_ENV_DIR/supervisor.env, then: systemctl start sh-supervisor.service"
}

# Sourcing guard: lets the test load these functions without touching the machine.
if [[ -z "${SH_SOURCE_ONLY:-}" ]]; then
  main "$@"
fi
