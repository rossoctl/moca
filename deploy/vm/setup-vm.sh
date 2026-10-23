#!/usr/bin/env bash
# Bring up the P6 single-VM deployment: Redis, relay, sandbox containers, control plane and
# supervisor units.
# Sibling of deploy/knative/setup-kind.sh and setup-ocp.sh (spec §4.4).
#
# Prerequisites:
#   - a Linux VM with systemd 247+ (LoadCredential=) and podman, Node 22+
#   - run as a user that can sudo to root (installs units under /etc/systemd/system)
#
# Usage:
#   ./deploy/vm/setup-vm.sh
#
# Env overrides:
#   SH_UNIT_DIR       Where systemd unit files are installed (default /etc/systemd/system)
#   SH_ENV_DIR        Where the supervisor/relay/control-plane env files live (default
#                       /etc/serverless-harness)
#   SH_CRED_DIR       TEST-ONLY. Where the MU1 secrets are written as root-only files (default
#                       $SH_ENV_DIR/credentials). The units' LoadCredential= lines hardcode
#                       /etc/serverless-harness/credentials, so any other value on a real host yields
#                       units that cannot start.
#   SH_INSTALL_DIR    Where the harness checkout lives on the VM (default /opt/serverless-harness)
#   SH_SANDBOX_COUNT     Number of sandbox containers to start (default 2)
#   SANDBOX_IMAGE        Sandbox container image (default
#                          ghcr.io/rossoctl/moca-remote-worker:latest, the image
#                          that attaches to the relay -- compose's sandbox image too)
#   SH_SANDBOX_RELAY_ADDR  Address each sandbox container uses to dial the relay (default
#                          host.containers.internal:<SH_RELAY_PORT from relay.env>). Reaching
#                          the host from inside a container is the part of this script least
#                          verified on real hardware -- override this if the default does not
#                          resolve on your VM (see deploy/vm/README.md). install_sandbox_firewall
#                          opens the port from THIS address, not SH_RELAY_PORT unconditionally,
#                          so overriding it also changes which port the firewall opens.
#   MOCA_SANDBOX_SUBNET    Dedicated podman network subnet for sandbox containers (default
#                          10.89.40.0/24). MI1 R8: sandboxes no longer share the default podman
#                          network, so the firewall below can name this subnet precisely.
#   MOCA_SANDBOX_GATEWAY   Gateway address on that subnet (default 10.89.40.1); also what
#                          host.containers.internal resolves to inside a sandbox container.
#   MOCA_SANDBOX_BRIDGE    Name of that network's bridge interface (default moca-sandbox0, at most
#                          15 characters). The firewall matches sandbox traffic by the bridge it
#                          arrives on, so it covers every address family, IPv6 link-local included.
#   MOCA_REDIS_VOLUME      Named podman volume holding Redis's data (default moca-redis). Sessions,
#                          ownership and leases live here, so this survives both a re-run of this
#                          script and a reboot (#410).
#   SH_REDIS_ADOPT_VOLUME  Set to 1 ONCE, on a host installed before #410, to migrate the sessions
#                          from that install's anonymous /data volume into MOCA_REDIS_VOLUME. Off by
#                          default: the installer warns about the old volume rather than rewriting
#                          live data unasked. See deploy/vm/README.md, "Redis persistence".
#
# Control-plane settings (optional; written into control-plane.env only where it has none yet --
# an existing value is kept, with a warning if these disagree). sudo drops the environment, so pass
# them through it: sudo env SH_GITHUB_CLIENT_ID=Ov23li... SH_PUBLIC_HARNESS_URL=... ./deploy/vm/setup-vm.sh
#   SH_GITHUB_CLIENT_ID    A GitHub OAuth app's client id, device flow ENABLED (deploy/vm/README.md,
#                          "The GitHub OAuth app"). No client secret: the device flow needs none.
#   SH_PUBLIC_HARNESS_URL  The harness as clients reach it, advertised by GET /v1/discovery; behind
#                          the default SSH tunnel, http://127.0.0.1:8080.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${SH_UNIT_DIR:=/etc/systemd/system}"
: "${SH_ENV_DIR:=/etc/serverless-harness}"
: "${SH_INSTALL_DIR:=/opt/serverless-harness}"
: "${SH_SANDBOX_COUNT:=2}"
: "${SANDBOX_IMAGE:=ghcr.io/rossoctl/moca-remote-worker:latest}"
MOCA_SANDBOX_SUBNET="${MOCA_SANDBOX_SUBNET:-10.89.40.0/24}"
MOCA_SANDBOX_GATEWAY="${MOCA_SANDBOX_GATEWAY:-10.89.40.1}"
MOCA_SANDBOX_BRIDGE="${MOCA_SANDBOX_BRIDGE:-moca-sandbox0}"
MOCA_REDIS_VOLUME="${MOCA_REDIS_VOLUME:-moca-redis}"
cred_dir() { printf '%s' "${SH_CRED_DIR:-$SH_ENV_DIR/credentials}"; }
# The MU1 secrets as systemd credentials: NAME (what LoadCredential= and credentialValue call it) and
# the file under $SH_CRED_DIR that holds it. The units hardcode the default path; setup-vm.test.sh
# checks each pair against both units.
MU1_CREDENTIALS=(
  "SH_SESSION_TOKEN_PRIVATE_KEY:session-token-private-key"
  "SH_CREDENTIAL_KEK:credential-kek"
  "SH_EXCHANGE_TOKEN:exchange-token"
)

log() { printf '==> %s\n' "$*"; }

# A tool that is installed but not on PATH is usually sudo's secure_path at work: Amazon Linux and
# RHEL drop /usr/local/bin, which is exactly where a static podman build installs (AL2023 packages no
# podman). Say where it is and how to re-run, instead of a bare "missing". SH_CMD_HINT_DIRS exists so
# the test can point this at a scratch directory.
require_cmds() {
  local missing=() c d
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  if ((${#missing[@]})); then
    echo "missing required commands: ${missing[*]}" >&2
    for c in "${missing[@]}"; do
      for d in ${SH_CMD_HINT_DIRS:-/usr/local/bin /usr/local/sbin}; do
        if [[ -x "$d/$c" ]]; then
          echo "  $c is at $d/$c, which is not on this PATH (sudo's secure_path usually drops $d)." \
            "Re-run as: sudo env PATH=\"$d:\$PATH\" $0" >&2
          break
        fi
      done
    done
    return 1
  fi
}

# require_systemd <min>: the units load the MU1 secrets with LoadCredential=, new in systemd 247. An older
# systemd (RHEL 8 ships 239) ignores the key with a warning, so the control plane dies on a missing
# SH_SESSION_TOKEN_PRIVATE_KEY and the supervisor requires auth with no exchange token to verify it by.
# The version is the first integer after "systemd" on `systemctl --version`'s first line.
require_systemd() {
  local min="$1" line re='^systemd[[:space:]]+([0-9]+)'
  line="$(systemctl --version 2>/dev/null | head -1)" || true
  if [[ ! "$line" =~ $re ]]; then
    echo "could not read systemd's version from 'systemctl --version' (first line: '$line'): the units" \
      "need systemd $min or newer for LoadCredential=, which loads the control plane's secrets." >&2
    return 1
  fi
  if ((BASH_REMATCH[1] < min)); then
    echo "systemd ${BASH_REMATCH[1]} is too old: the units need systemd $min or newer for LoadCredential=," \
      "which loads the control plane's secrets (an older systemd ignores it, and neither the control" \
      "plane nor an authenticating supervisor can start)." >&2
    return 1
  fi
}

# All three units run as User=harness/Group=harness; nothing here creates that account (uid
# policy, shell, and home are an operator decision, not this script's to make). Fail loudly
# before install_units, naming the account and the units that need it, instead of letting
# systemd fail later with a confusing "user harness does not exist".
# install -d -m 0750 /etc/serverless-harness and systemctl enable both need root. Failing here
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
    echo "missing system user '$user': sh-supervisor.service, sh-relay.service and" \
      "sh-control-plane.service all run as User=$user/Group=$user. Create it first, e.g.:" \
      "sudo useradd --system --no-create-home --shell /usr/sbin/nologin $user" >&2
    return 1
  fi
}

install_units() {
  log "installing systemd units into $SH_UNIT_DIR"
  install -m 0644 "$SCRIPT_DIR/systemd/sh-supervisor.service" "$SH_UNIT_DIR/"
  install -m 0644 "$SCRIPT_DIR/systemd/sh-relay.service" "$SH_UNIT_DIR/"
  install -m 0644 "$SCRIPT_DIR/systemd/sh-control-plane.service" "$SH_UNIT_DIR/"
  systemctl daemon-reload
}

# install_env_file <name> <hint> installs deploy/vm/env/<name>.env.example to
# $SH_ENV_DIR/<name>.env, once. Never clobber an operator-edited env file: it holds the S
# that an E8 run established (supervisor.env), the shared token a worker was configured
# with (relay.env) or the GitHub OAuth app's client id (control-plane.env) — any one, a silent
# overwrite on re-run would be a real outage.
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
  install_env_file control-plane "set SH_GITHUB_CLIENT_ID and SH_PUBLIC_HARNESS_URL before starting (or pass both to this script: sudo env SH_GITHUB_CLIENT_ID=... SH_PUBLIC_HARNESS_URL=... $0)"
}

# The two answers from redis_container_diff that are not a list of differing fields. Sentinels
# rather than bare strings because start_redis and adopt_redis_volume both branch on them, and a
# typo in one copy of a literal would silently take the other path.
REDIS_MATCHES="matches"
REDIS_ABSENT="no container"

# redis_container_diff prints REDIS_MATCHES when the running sh-redis is already what this script
# would start, REDIS_ABSENT when there is none, else a human-readable list of what differs -- which
# start_redis logs, so an operator sees WHY their container was recreated rather than just losing
# it. Four fields, because those are the four this function's caller sets; a container differing in
# any of them is not the one we would have started.
#
# `podman container inspect` on a missing container exits non-zero and prints to stderr: under
# `set -euo pipefail` that would abort the whole script on a first install, so the call is guarded
# and its stderr dropped. Image is compared by the configured NAME, not the resolved digest: this
# script pins a floating `:7-alpine` tag, so comparing digests would replace Redis -- and on a
# pre-#410 container, LOSE ITS DATA -- every time upstream rebuilt the tag.
redis_container_diff() {
  local image port volume appendonly out=()
  podman container inspect sh-redis >/dev/null 2>&1 || { printf '%s' "$REDIS_ABSENT"; return 0; }
  image="$(podman container inspect sh-redis --format '{{.ImageName}}' 2>/dev/null)"
  port="$(podman container inspect sh-redis \
    --format '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostIp}}:{{.HostPort}}->{{$p}} {{end}}{{end}}' 2>/dev/null)"
  volume="$(podman container inspect sh-redis \
    --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null)"
  appendonly="$(podman container inspect sh-redis --format '{{.Config.CreateCommand}}' 2>/dev/null)"
  [[ "$image" == *redis:7-alpine* ]] || out+=("image is '$image', expected docker.io/redis:7-alpine")
  [[ "$port" == *127.0.0.1:6379* ]] || out+=("published port is '$port', expected 127.0.0.1:6379")
  if [[ "$volume" != "$MOCA_REDIS_VOLUME" ]]; then
    # The anonymous-volume case (this image's own VOLUME /data) is the pre-#410 container every
    # existing host is running, and adopt_redis_volume keys off this text. It is NOT detectable from
    # the mount: podman reports an anonymous volume's .Name as a 64-hex id, indistinguishable from a
    # name an operator chose (verified live, podman 6.1.1). The volume's own .Anonymous flag is the
    # only reliable signal, so ask for it -- defaulting to false, since treating an unknown volume
    # as anonymous would run a data migration over something nobody asked us to touch.
    local anon="false"
    [[ -z "$volume" ]] ||
      anon="$(podman volume inspect "$volume" --format '{{.Anonymous}}' 2>/dev/null || echo false)"
    if [[ "$anon" == true || -z "$volume" ]]; then
      out+=("/data volume is ANONYMOUS (${volume:-unnamed}), expected $MOCA_REDIS_VOLUME")
    else
      out+=("/data volume is '$volume', expected $MOCA_REDIS_VOLUME")
    fi
  fi
  [[ "$appendonly" == *appendonly* ]] || out+=("it runs without --appendonly yes")
  ((${#out[@]})) || { printf '%s' "$REDIS_MATCHES"; return 0; }
  local IFS='; '
  printf '%s' "${out[*]}"
}

# The one-time migration off the anonymous volume (#410). Every host installed before this change
# is running a container whose /data is an anonymous volume holding that host's real sessions;
# starting the named volume beside it leaves them reachable but unused.
#
# OPT-IN, by SH_REDIS_ADOPT_VOLUME=1. The default warns and continues: adopting means this
# installer reading and rewriting live operator data, and picking WHICH volume is the right one on
# a host with eleven orphans. That is the operator's call, and the warning is what tells them the
# data is still there to make it. Same shape as ensure_exec_listener's one-time migration: act only
# on the exact state we recognize, and never guess.
#
# THE ORDER BELOW IS LOAD-BEARING, and it is not the order the issue proposed. Verified against
# redis:7-alpine (podman 6.1.1): with `--appendonly yes`, Redis loads the AOF and IGNORES an
# existing dump.rdb -- so "copy dump.rdb in, then start" yields an EMPTY Redis, silently. The
# conversion must therefore happen with appendonly OFF (so the RDB is loaded), then CONFIG SET
# appendonly yes writes the AOF from what was loaded. After that, start_redis's own
# `--appendonly yes` reads it correctly.
adopt_redis_volume() {
  local diff="$1"
  # Only the state this function knows how to migrate: a container on an anonymous /data volume.
  # Anything else already has a volume somebody named, and copying over it is not ours to do.
  [[ "$diff" == *"volume is ANONYMOUS"* ]] || return 0
  if [[ "${SH_REDIS_ADOPT_VOLUME:-}" != 1 ]]; then
    echo "WARNING: the running sh-redis keeps its sessions on an ANONYMOUS podman volume (every" \
      "host installed before #410 does). This run starts Redis on the named volume" \
      "'$MOCA_REDIS_VOLUME' instead, so those sessions become unreachable -- they are NOT" \
      "deleted, and podman keeps the old volume until you remove it. To migrate them into the" \
      "named volume, re-run with: sudo env SH_REDIS_ADOPT_VOLUME=1 $0" >&2
    return 0
  fi
  log "adopting the existing anonymous Redis volume into '$MOCA_REDIS_VOLUME' (SH_REDIS_ADOPT_VOLUME=1)"
  # SAVE first, synchronously: the dump.rdb on disk is otherwise as old as the last save point, so
  # copying without this silently drops the most recent sessions -- the ones most likely to matter.
  podman exec sh-redis redis-cli SAVE
  podman stop sh-redis
  podman volume create --ignore "$MOCA_REDIS_VOLUME"
  # Both volumes into one throwaway container. `--volumes-from` carries the anonymous volume at
  # its own /data, so the copy needs no volume id -- which is what makes this safe on a host with
  # several orphans: it is always THIS container's data, never a guess at which orphan is current.
  podman run --rm --volumes-from sh-redis -v "$MOCA_REDIS_VOLUME:/adopt" \
    --entrypoint sh docker.io/redis:7-alpine -c 'cp -p /data/dump.rdb /adopt/dump.rdb'
  # Conversion, appendonly OFF so the RDB is what gets loaded (see the comment above). Started
  # detached and shut down explicitly rather than left to --rm: SHUTDOWN NOSAVE after the rewrite
  # is what guarantees the AOF is complete on disk before start_redis opens the same volume.
  podman run -d --rm --name sh-redis-adopt -v "$MOCA_REDIS_VOLUME:/data" \
    docker.io/redis:7-alpine redis-server --appendonly no
  local i
  for ((i = 0; i < 30; i++)); do
    podman exec sh-redis-adopt redis-cli PING >/dev/null 2>&1 && break
    sleep 1
  done
  podman exec sh-redis-adopt redis-cli CONFIG SET appendonly yes
  # The rewrite is a background job; shutting down before it finishes leaves a partial AOF that
  # Redis then loads INSTEAD of the RDB -- the same silent-empty failure, one step later.
  for ((i = 0; i < 60; i++)); do
    [[ "$(podman exec sh-redis-adopt redis-cli INFO persistence 2>/dev/null |
      sed -n 's/^aof_rewrite_in_progress:\([0-9]*\).*/\1/p')" == 0 ]] && break
    sleep 1
  done
  podman exec sh-redis-adopt redis-cli SHUTDOWN NOSAVE || true # NOSAVE closes the connection
  log "adopted: the sessions in the anonymous volume are now in '$MOCA_REDIS_VOLUME'"
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
  # PERSISTED, on a NAMED volume, with AOF on (#410). Both halves are needed and neither is
  # sufficient:
  #
  #   - The named volume survives `podman rm`. This image declares `VOLUME /data`, so the old
  #     no-`-v` form did not lose data outright -- every --replace just moved it to a FRESH
  #     anonymous volume and orphaned the last one (the rig accumulated 11). Sessions were
  #     unreachable, which to the user is the same thing.
  #   - `--appendonly yes` makes a write durable when it happens. Without it Redis snapshots on
  #     the `save` points only, so a reboot drops up to the last window's writes even with the
  #     volume kept.
  #
  # Redis holds the control plane's session and ownership index, the harness's own session state
  # (@moca/session-backend), the lease store and sh:sandbox:records -- only the last is
  # self-healing (workers re-register on reconnect). This matches the Kubernetes path, which
  # already persists: a PVC in deploy/k8s/base/redis.yaml plus `appendonly yes` in
  # deploy/k8s/setup.sh's redis.conf.
  #
  # NOT `--replace` unconditionally. That recreated the container on EVERY run, which is what made
  # a re-run destructive -- and a re-run is how an operator applies a changed control-plane.env, so
  # the installer's own documented procedure forgot every session (#410, seen twice during the P6.3
  # acceptance in #425). redis_container_diff below replaces it only when something it cares about
  # actually differs, which is the same contract install_env_file keeps for an operator's env file.
  local diff
  diff="$(redis_container_diff)"
  if [[ "$diff" == "$REDIS_MATCHES" ]]; then
    log "keeping the running sh-redis (same image, port, volume and appendonly setting)"
    return 0
  fi
  adopt_redis_volume "$diff"
  [[ "$diff" == "$REDIS_ABSENT" ]] || log "replacing sh-redis: $diff"
  podman run -d --name sh-redis --replace --restart=always \
    -p 127.0.0.1:6379:6379 -v "$MOCA_REDIS_VOLUME:/data" \
    docker.io/redis:7-alpine redis-server --appendonly yes
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

# The workers' credential for the relay's SandboxExec (MI1 §5 R5). Only the relay and the
# supervisor hold it, so it is generated here when absent -- into BOTH files, one value -- and an
# existing value is never replaced. It is never handed to a sandbox container (start_sandboxes).
# Terminate an operator-edited file's last line before appending to it: `>>` onto a file with no final
# newline glues the new assignment onto the last one (SH_RELAY_TOKEN=<t>MOCA_RELAY_EXEC_TOKEN=...),
# silently changing that value. $(...) strips a trailing newline, so it is empty only when the file
# already ends in one.
end_with_newline() {
  if [[ -s "$1" && -n "$(tail -c 1 "$1")" ]]; then printf '\n' >>"$1"; fi
}

ensure_exec_token() {
  local relay="$SH_ENV_DIR/relay.env" sup="$SH_ENV_DIR/supervisor.env" token
  token="$( (grep -oE '^MOCA_RELAY_EXEC_TOKEN=.+' "$relay" 2>/dev/null || true) | tail -1 | cut -d= -f2-)"
  if [[ -z "$token" ]]; then
    token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
    [[ -n "$token" ]] || { echo "could not generate MOCA_RELAY_EXEC_TOKEN" >&2; return 1; }
    end_with_newline "$relay"
    (umask 077; printf 'MOCA_RELAY_EXEC_TOKEN=%s\n' "$token" >>"$relay")
  fi
  if ! grep -qE "^MOCA_RELAY_EXEC_TOKEN=${token}\$" "$sup" 2>/dev/null; then
    local tmp
    tmp="$(mktemp)"
    { grep -vE '^MOCA_RELAY_EXEC_TOKEN=' "$sup" 2>/dev/null || true; printf 'MOCA_RELAY_EXEC_TOKEN=%s\n' "$token"; } >"$tmp"
    cat "$tmp" >"$sup"
    rm -f "$tmp"
  fi
}

# env_file_value <key> <file> prints the last <key>= value in <file>, with one matched pair of
# surrounding quotes stripped the way systemd's EnvironmentFile= strips them (see relay_token).
env_file_value() {
  local v
  v="$( (grep -oE "^$1=.*" "$2" 2>/dev/null || true) | tail -1 | cut -d= -f2-)"
  if ((${#v} >= 2)); then
    case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
    esac
  fi
  printf '%s' "$v"
}

# The relay serves SandboxExec on its own loopback listener (MOCA_RELAY_EXEC_ADDR) and the
# supervisor dials it (SH_RELAY_ADDR) -- MI1 §5 R5. install_env never rewrites an existing env file,
# so on a VM set up before MI1 relay.env has no MOCA_RELAY_EXEC_ADDR (one listener for everything)
# and supervisor.env dials PRE_MI1_RELAY_ADDR. That exact pair is migrated here, both files together,
# to the templates' split listener. A pair that already agrees (the two ports equal) is left alone.
# Anything else -- one file migrated and not the other, or ports that disagree -- is refused, naming
# both values: guessing would leave the supervisor dialing a port nothing serves SandboxExec on.
PRE_MI1_RELAY_ADDR="127.0.0.1:9443"
ensure_exec_listener() {
  local relay="$SH_ENV_DIR/relay.env" sup="$SH_ENV_DIR/supervisor.env"
  local exec_addr dial_addr new_addr tmp
  exec_addr="$(env_file_value MOCA_RELAY_EXEC_ADDR "$relay")"
  dial_addr="$(env_file_value SH_RELAY_ADDR "$sup")"
  if [[ -n "$exec_addr" && -n "$dial_addr" && "${exec_addr##*:}" == "${dial_addr##*:}" ]]; then
    return 0
  fi
  if [[ -z "$exec_addr" && "$dial_addr" == "$PRE_MI1_RELAY_ADDR" ]]; then
    new_addr="$(env_file_value MOCA_RELAY_EXEC_ADDR "$SCRIPT_DIR/env/relay.env.example")"
    [[ -n "$new_addr" ]] || { echo "relay.env.example has no MOCA_RELAY_EXEC_ADDR" >&2; return 1; }
    if [[ "${new_addr##*:}" == "$(relay_port "$relay")" ]]; then
      echo "cannot migrate to the split exec listener: relay.env's SH_RELAY_PORT is" \
        "$(relay_port "$relay"), the port MOCA_RELAY_EXEC_ADDR=$new_addr would take. Set" \
        "MOCA_RELAY_EXEC_ADDR in $relay and SH_RELAY_ADDR in $sup to one free loopback port," \
        "then re-run." >&2
      return 1
    fi
    log "migrating to the split exec listener: MOCA_RELAY_EXEC_ADDR=$new_addr in $relay," \
      "SH_RELAY_ADDR=$new_addr in $sup"
    end_with_newline "$relay"
    printf 'MOCA_RELAY_EXEC_ADDR=%s\n' "$new_addr" >>"$relay"
    tmp="$(mktemp)"
    sed -E "s|^SH_RELAY_ADDR=.*\$|SH_RELAY_ADDR=$new_addr|" "$sup" >"$tmp"
    cat "$tmp" >"$sup" # in place, so the file keeps its owner and mode
    rm -f "$tmp"
    return 0
  fi
  echo "relay.env and supervisor.env disagree on the relay's exec listener:" \
    "MOCA_RELAY_EXEC_ADDR=${exec_addr:-<unset>} ($relay), SH_RELAY_ADDR=${dial_addr:-<unset>} ($sup)." \
    "The supervisor must dial the port the relay serves SandboxExec on. Set both to the same" \
    "loopback address (the templates use $(env_file_value MOCA_RELAY_EXEC_ADDR "$SCRIPT_DIR/env/relay.env.example")), then re-run." >&2
  return 1
}

# set_env_line <file> <key> <value>: exactly one KEY=value line -- in place of the first KEY= line if
# there is one, else of the first #KEY= (a template's commented slot), else appended on its own line;
# any later KEY= duplicate is dropped (systemd and env_file_value both honour the LAST one, so a
# leftover would win). Rewritten through a temp file and `cat >`, keeping the file's owner and mode,
# as ensure_exec_listener does. awk reads the value from its environment, never from an argv.
set_env_line() {
  local file="$1" key="$2" tmp
  tmp="$(mktemp)" || return 1
  SET_ENV_VALUE="$3" awk -v k="$key" '
    FNR == NR { if ($0 ~ "^" k "=") has = 1; next }
    !done && $0 ~ (has ? "^" k "=" : "^#" k "=") { print k "=" ENVIRON["SET_ENV_VALUE"]; done = 1; next }
    done && $0 ~ "^" k "=" { next }
    { print }
    END { if (!done) print k "=" ENVIRON["SET_ENV_VALUE"] }
  ' "$file" "$file" >"$tmp" || { rm -f "$tmp"; return 1; }
  cat "$tmp" >"$file" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
}

# The checkout's own key generator (packages/control-plane/src/genkeys.ts), run by the checkout's own
# node -- require_build has already established the workspace is built. It prints the four MU1 secrets
# as KEY=value lines on STDOUT only, so they never enter an argv or a file this script did not choose.
# A function so the test can stand in for it without a built workspace.
generate_mu1() {
  local root="${SH_REPO_ROOT:-$SCRIPT_DIR/../..}"
  (cd "$root/packages/control-plane" && node --import tsx src/genkeys.ts)
}

# mu1_value <KEY> <extended regex>: KEY's value in $GENERATED, which must match the regex in full, so
# a truncated or garbled line can never be written as a secret (deploy/compose/install.sh's check).
mu1_value() {
  local v
  v="$( (printf '%s\n' "$GENERATED" | sed -n "s/^$1=//p") | tail -1)"
  if ! printf '%s\n' "$v" | grep -Eqx -- "$2"; then
    echo "the key generator (packages/control-plane/src/genkeys.ts) produced no usable $1" >&2
    return 1
  fi
  printf '%s' "$v"
}

# write_secret <file> <value>: whole or not at all, root-only -- a temp file in the same directory,
# created under umask 077, renamed into place. printf is a builtin: the value never reaches an argv.
# Each step's failure is checked explicitly: a caller under `||` runs this with errexit suspended, and a
# failed write (ENOSPC) followed by a successful rename would put an empty secret in place.
write_secret() {
  local dir tmp
  dir="$(cred_dir)"
  tmp="$(umask 077 && mktemp "$dir/.tmp.XXXXXX")" || return 1
  printf '%s\n' "$2" >"$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$dir/$1" || { rm -f "$tmp"; return 1; }
}

# The MU1 secrets (#366): the control plane's ed25519 signing key and credential KEK, and the exchange
# token both tiers present -- root-only files under cred_dir, which the units load with LoadCredential=
# (MI1 §6.7: secrets are files, never env vars). The public half of the signing key is not a secret; it
# goes to supervisor.env as SH_SESSION_TOKEN_PUBLIC_KEYS. Generated once, only what is missing, and
# NEVER replaced: a new KEK makes every stored credential undecryptable, a new signing key invalidates
# every live session token. Sets MU1_NEW_KEYPAIR=1 when this run generated the keypair (Task 6 wiring).
ensure_mu1_secrets() {
  local sup="$SH_ENV_DIR/supervisor.env" cp="$SH_ENV_DIR/control-plane.env" dir pair name f
  local priv_file have_pub store missing=() priv='' pub='' kek='' xchg=''
  dir="$(cred_dir)"
  MU1_NEW_KEYPAIR=''
  for pair in "${MU1_CREDENTIALS[@]}"; do
    name="${pair%%:*}"
    for f in "$sup" "$cp"; do
      if grep -qE "^$name=" "$f" 2>/dev/null; then
        echo "$f sets $name, which on this VM is a systemd credential ($dir/${pair#*:}): with both," \
          "the unit refuses to boot. Move the value into that file (mode 0600), or delete the line to" \
          "have a new one generated, then re-run. A control plane hosted elsewhere is not supported" \
          "alongside the one setup-vm.sh installs." >&2
        return 1
      fi
    done
  done
  for pair in "${MU1_CREDENTIALS[@]}"; do
    if [[ -e "$dir/${pair#*:}" && ! -s "$dir/${pair#*:}" ]]; then
      echo "$dir/${pair#*:} is empty. Restore ${pair%%:*} into it, or delete the file to have a new" \
        "one generated -- for SH_CREDENTIAL_KEK that makes every stored credential undecryptable." >&2
      return 1
    fi
  done
  priv_file="$dir/session-token-private-key"
  have_pub="$(env_file_value SH_SESSION_TOKEN_PUBLIC_KEYS "$sup")"
  if [[ -s "$priv_file" && -z "$have_pub" ]] || [[ ! -e "$priv_file" && -n "$have_pub" ]]; then
    echo "only one half of the control plane's signing keypair exists:" \
      "$priv_file is $([[ -s "$priv_file" ]] && echo present || echo missing)," \
      "SH_SESSION_TOKEN_PUBLIC_KEYS in $sup is $([[ -n "$have_pub" ]] && echo set || echo unset)." \
      "They are one keypair: restore the missing half, or remove both to generate a fresh pair" \
      "(every live session token then stops verifying), then re-run." >&2
    return 1
  fi
  # A lost KEK is regenerated only over an empty store: the file store's records (one per subject, in
  # SH_CREDENTIAL_DIR) are sealed under the old one, and a new KEK makes every one undecryptable.
  store="$(env_file_value SH_CREDENTIAL_DIR "$cp")"
  store="${store:-/var/lib/moca-control-plane}"
  if [[ ! -e "$dir/credential-kek" && -n "$(find "$store" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "$dir/credential-kek is missing, but the credential store $store already holds records sealed" \
      "under it: a new KEK would make every stored credential undecryptable. Restore credential-kek from" \
      "a backup (mode 0600), or -- discarding every stored credential, deliberately -- empty $store," \
      "then re-run." >&2
    return 1
  fi
  for pair in "${MU1_CREDENTIALS[@]}"; do
    [[ -e "$dir/${pair#*:}" ]] || missing+=("${pair%%:*}")
  done
  ((${#missing[@]})) || return 0
  install -d -m 0700 "$dir"
  log "generating ${missing[*]} into $dir (once; a re-run never replaces one)"
  GENERATED="$(generate_mu1)" || {
    echo "could not run the key generator: (cd packages/control-plane && node --import tsx src/genkeys.ts)" >&2
    return 1
  }
  # Every value extracted and checked BEFORE the first write, so a bad run leaves nothing half-written.
  if [[ ! -e "$priv_file" ]]; then
    priv="$(mu1_value SH_SESSION_TOKEN_PRIVATE_KEY '[A-Za-z0-9+/]+=*')" || { GENERATED=''; return 1; }
    pub="$(mu1_value SH_SESSION_TOKEN_PUBLIC_KEYS '[0-9a-f]{16}:[A-Za-z0-9+/]+=*')" || { GENERATED=''; return 1; }
  fi
  if [[ ! -e "$dir/credential-kek" ]]; then
    kek="$(mu1_value SH_CREDENTIAL_KEK '[A-Za-z0-9+/]{43}=')" || { GENERATED=''; return 1; }
  fi
  if [[ ! -e "$dir/exchange-token" ]]; then
    xchg="$(mu1_value SH_EXCHANGE_TOKEN '[0-9a-f]{64}')" || { GENERATED=''; return 1; }
  fi
  GENERATED=''
  if [[ -n "$priv" ]]; then
    write_secret session-token-private-key "$priv" || return 1
    set_env_line "$sup" SH_SESSION_TOKEN_PUBLIC_KEYS "$pub" || return 1
    MU1_NEW_KEYPAIR=1
  fi
  if [[ -n "$kek" ]]; then write_secret credential-kek "$kek" || return 1; fi
  if [[ -n "$xchg" ]]; then write_secret exchange-token "$xchg" || return 1; fi
}

# The supervisor's side of MU1 (#366): dial this VM's control plane and require a session token.
# Written on the run that generated the keypair -- the run that turns MU1 on, on a fresh VM or on one
# upgraded from before the control plane -- and on no later run: after that both are the operator's,
# and one who set SH_REQUIRE_AUTH=false (to keep driving plain `curl /turn`, say) keeps it. The only
# later repair is a supervisor.env with no SH_CONTROL_PLANE_URL at all, which cannot exchange a single
# token-carrying turn.
wire_supervisor_mu1() {
  local sup="$SH_ENV_DIR/supervisor.env" cp="$SH_ENV_DIR/control-plane.env" port url
  port="$(env_file_value SH_CONTROL_PLANE_PORT "$cp")"
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    echo "SH_CONTROL_PLANE_PORT in $cp is '${port}', not a port number. The control plane would fall" \
      "back to 8080 -- the supervisor's own port. Set it (the template uses 8090), then re-run." >&2
    return 1
  fi
  url="http://127.0.0.1:$port"
  if [[ -n "${MU1_NEW_KEYPAIR:-}" ]]; then
    log "wiring $sup to this VM's control plane ($url); every turn now needs a session token"
    set_env_line "$sup" SH_CONTROL_PLANE_URL "$url" || return 1
    set_env_line "$sup" SH_REQUIRE_AUTH true || return 1
  elif [[ -z "$(env_file_value SH_CONTROL_PLANE_URL "$sup")" ]]; then
    log "adding SH_CONTROL_PLANE_URL=$url to $sup"
    set_env_line "$sup" SH_CONTROL_PLANE_URL "$url" || return 1
  fi
}

# file_mode <file>: its permission bits in octal (GNU stat, then BSD stat for the macOS test run).
# -L: a symlink's TARGET, which is what LoadCredential= reads (a link's own mode is always 777).
file_mode() { stat -L -c '%a' "$1" 2>/dev/null || stat -L -f '%Lp' "$1"; }

# operator_fallback_value <env file>: SH_ALLOW_OPERATOR_FALLBACK as systemd's EnvironmentFile= reads it
# -- leading whitespace allowed, like the SH_OPERATOR_INFERENCE_TOKEN guard below -- with quotes removed.
operator_fallback_value() {
  local v
  # Whitespace around the key and after `=` too: parse_env_file_internal (systemd's env-file.c) trims
  # the key and skips blanks after `=`.
  v="$( (grep -E '^[[:space:]]*SH_ALLOW_OPERATOR_FALLBACK[[:space:]]*=' "$1" 2>/dev/null || true) | tail -1)"
  v="${v#*=}"
  v="${v#"${v%%[![:space:]]*}"}"
  # Trailing whitespace goes, as systemd drops it from an unquoted value; then a matched pair of
  # quotes only, exactly as env_file_value strips them.
  v="${v%"${v##*[![:space:]]}"}"
  if ((${#v} >= 2)); then
    case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
    esac
  fi
  printf '%s' "$v"
}

# The operator-key fallback's token (#368, spec §6.4): an operator secret this script never generates,
# reads or copies -- only its presence is checked. When the file exists a drop-in loads it into the
# control plane with LoadCredential=, like the MU1 secrets; when it does not, the drop-in goes too,
# because LoadCredential= on a missing file fails the unit. Whether the token, its header and the
# default endpoint agree is the control plane's own boot check (main.ts checkInferenceConfig).
OPERATOR_TOKEN_FILE=operator-inference-token
OPERATOR_DROPIN=50-operator-inference-token.conf
ensure_operator_fallback() {
  local cp="$SH_ENV_DIR/control-plane.env" f dropin_dir other allow
  f="$(cred_dir)/$OPERATOR_TOKEN_FILE"
  dropin_dir="$SH_UNIT_DIR/sh-control-plane.service.d"
  allow="$(operator_fallback_value "$cp")"
  # Any OTHER drop-in loading this credential -- the `systemctl edit` override.conf that this README
  # told operators to write before #411 -- doubles the line while the token exists, and once it goes
  # fails the unit on the missing file. It is the operator's file, so it is named, not removed.
  # As systemd parses a unit file: whitespace around `=`, the Encrypted form, and the colon-less one.
  other="$(grep -lE '^[[:space:]]*LoadCredential(Encrypted)?[[:space:]]*=[[:space:]]*SH_OPERATOR_INFERENCE_TOKEN([:[:space:]]|$)' \
    "$dropin_dir"/*.conf 2>/dev/null |
    grep -vxF "$dropin_dir/$OPERATOR_DROPIN" || true)"
  if [[ -n "$other" ]]; then
    echo "$(tr '\n' ' ' <<<"$other")also loads SH_OPERATOR_INFERENCE_TOKEN. setup-vm.sh now manages that" \
      "credential itself ($OPERATOR_DROPIN): delete the LoadCredential= line from that file (or the" \
      "file, if it holds nothing else), then re-run." >&2
    return 1
  fi
  # Every spelling systemd's EnvironmentFile= accepts: leading whitespace, and whitespace around `=`.
  if grep -qE '^[[:space:]]*SH_OPERATOR_INFERENCE_TOKEN[[:space:]]*=' "$cp" 2>/dev/null; then
    echo "$cp sets SH_OPERATOR_INFERENCE_TOKEN, which on this VM is a systemd credential ($f): with" \
      "both, the control plane refuses to boot. Move the value into that file (mode 0600), delete the" \
      "line, then re-run." >&2
    return 1
  fi
  if [[ -L "$f" && ! -e "$f" ]]; then
    echo "$f is a dangling symlink. Point it at the operator's inference key, or remove it to turn the" \
      "fallback's token off, then re-run." >&2
    return 1
  fi
  if [[ -e "$f" ]]; then
    if [[ ! -s "$f" ]]; then
      echo "$f is empty. Put the operator's inference key in it, or delete it to turn the fallback's" \
        "token off, then re-run." >&2
      return 1
    fi
    if [[ ! "$(file_mode "$f")" =~ ^[46]00$ ]]; then
      echo "$f is mode $(file_mode "$f"): it is the operator's inference key, so it must be 0600 or" \
        "0400 (root only). sudo chmod 0600 $f, then re-run." >&2
      return 1
    fi
    install -d -m 0755 "$dropin_dir"
    printf '%s\n' '# Written by deploy/vm/setup-vm.sh because the operator token file exists (#368).' \
      '# Removed by it when the file goes: LoadCredential= on a missing file fails the unit.' \
      '[Service]' \
      "LoadCredential=SH_OPERATOR_INFERENCE_TOKEN:/etc/serverless-harness/credentials/$OPERATOR_TOKEN_FILE" \
      >"$dropin_dir/$OPERATOR_DROPIN"
    chmod 0644 "$dropin_dir/$OPERATOR_DROPIN"
    if [[ "$allow" != true ]]; then
      log "operator inference token loaded, but the fallback is off (SH_ALLOW_OPERATOR_FALLBACK in $cp)"
    else
      log "operator-key fallback on: users with no inference credential of their own spend $f"
    fi
    return 0
  fi
  if [[ "$allow" == true ]]; then
    echo "SH_ALLOW_OPERATOR_FALLBACK=true in $cp, but $f does not exist. Put the operator's inference" \
      "key there (sudo install -m 0600 /dev/null $f && sudoedit $f), or turn the fallback off, then" \
      "re-run." >&2
    return 1
  fi
  rm -f "$dropin_dir/$OPERATOR_DROPIN"
  rmdir "$dropin_dir" 2>/dev/null || true
}

# Sandboxes run on their OWN podman network (MI1 §5 R8), with a fixed subnet so the firewall below
# can name it, and with isolate=strict so it exchanges no traffic with any other podman network --
# sh-redis runs on podman's default one. --ignore: a re-run finds it already there. If an operator
# pre-created moca-sandbox with another subnet, set MOCA_SANDBOX_SUBNET/MOCA_SANDBOX_GATEWAY to match
# it. --ignore accepts a pre-existing network unconditionally, though, so this also reads back the
# live subnet/gateway, isolate option and bridge name and fails closed on a mismatch, rather than
# letting the firewall below install rules for a network that does not have the expected values.
# The read-back proves only what podman STORED. A podman that rejects isolate=strict fails the create
# here, but one that accepts and stores the option over a netavark too old to enforce it passes every
# check below. Nothing in setup can detect that; the live verification that isolation is enforced ran
# on netavark 1.17.2 (MI1 S1, PR #350). Use a netavark at least that recent.
ensure_sandbox_network() {
  podman network create --ignore --subnet "$MOCA_SANDBOX_SUBNET" --gateway "$MOCA_SANDBOX_GATEWAY" \
    --opt isolate=strict --interface-name "$MOCA_SANDBOX_BRIDGE" moca-sandbox
  local expected="$MOCA_SANDBOX_SUBNET $MOCA_SANDBOX_GATEWAY" actual isolate bridge
  actual="$(podman network inspect moca-sandbox --format '{{range .Subnets}}{{.Subnet}} {{.Gateway}}{{end}}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "moca-sandbox network exists with subnet/gateway '$actual', but" \
      "MOCA_SANDBOX_SUBNET/MOCA_SANDBOX_GATEWAY expect '$expected'." \
      "install_sandbox_firewall writes its rules against the expected values, so recreate the" \
      "network to match, or set MOCA_SANDBOX_SUBNET/MOCA_SANDBOX_GATEWAY to the network's actual" \
      "values, then re-run." >&2
    return 1
  fi
  isolate="$(podman network inspect moca-sandbox --format '{{index .Options "isolate"}}')"
  if [[ "$isolate" != "strict" ]]; then
    [[ -n "$isolate" && "$isolate" != "<no value>" ]] || isolate="<unset>"
    echo "moca-sandbox network has isolate=$isolate, but setup expects isolate=strict: sandboxes" \
      "must exchange no traffic with any other podman network. Stop the sh-sandbox-* containers," \
      "remove the network (podman network rm moca-sandbox), then re-run -- with a netavark that" \
      "supports isolate=strict." >&2
    return 1
  fi
  bridge="$(podman network inspect moca-sandbox --format '{{.NetworkInterface}}')"
  if [[ "$bridge" != "$MOCA_SANDBOX_BRIDGE" ]]; then
    echo "moca-sandbox network's bridge interface is '$bridge', but setup expects" \
      "'$MOCA_SANDBOX_BRIDGE': the firewall matches sandbox traffic by that bridge. Stop the" \
      "sh-sandbox-* containers, remove the network (podman network rm moca-sandbox), then re-run," \
      "or set MOCA_SANDBOX_BRIDGE to the network's actual bridge." >&2
    return 1
  fi
}

# Traffic from the sandbox network TO THIS HOST is dropped except the address sandboxes actually
# dial (sandbox_relay_addr(), which SH_SANDBOX_RELAY_ADDR may point at a different port than
# relay_port()) and DNS (podman's resolver answers on the gateway), both over IPv4 from the
# sandbox subnet. The rules match the bridge a packet arrives on, not only its source address:
# netavark leaves IPv6 enabled on the bridge and in every container, so link-local IPv6 reaches the
# host even though the network has no IPv6 subnet, and everything on the bridge that is not one of
# the three accepts (established/related replies, and the two IPv4 ones) -- IPv6 included -- is
# dropped. The forward chain drops only link-local destinations (169.254.0.0/16 and the IPv6
# metadata address fd00:ec2::254) arriving from the sandbox bridge: forwarded traffic is the path
# a sandbox takes to a link-local metadata endpoint (169.254.169.254 on AWS, GCP, Azure and OCI;
# fd00:ec2::254 on AWS), which on a cloud VM can hand out the instance role's credentials --
# they belong to the host, not to any session (rossoctl/moca#357). Metadata served from routable
# addresses (Alibaba's 100.100.100.200, Azure's WireServer 168.63.129.16) stays reachable until
# S5's egress filtering. General forwarded (internet) traffic is untouched; MI1 S5 routes it
# through moca-egress. The declare/delete/redeclare idiom makes `nft -f` replace the table
# atomically, so a re-run never stacks duplicate rules. The checked-in unit carries an
# @SH_ENV_DIR@ placeholder rather than a literal path -- SH_ENV_DIR is itself overridable, so
# this renders the placeholder into the real value before installing the unit. The same for
# @NFT@: require_cmds accepts nft anywhere on PATH, so the unit runs the nft this script ran,
# not a hardcoded /usr/sbin/nft that dies 203/EXEC on a distro shipping it in /usr/bin.
install_sandbox_firewall() {
  local attach nft="$SH_ENV_DIR/moca-sandbox.nft" tmp_unit nft_bin
  nft_bin="$(command -v nft)"
  [[ "$nft_bin" == /* ]] || { echo "nft resolves to '$nft_bin', not an absolute path the unit can run" >&2; return 1; }
  attach="$(sandbox_relay_addr)"
  attach="${attach##*:}"
  cat >"$nft" <<NFT
table inet moca_sandbox
delete table inet moca_sandbox
table inet moca_sandbox {
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "$MOCA_SANDBOX_BRIDGE" ct state established,related accept
    iifname "$MOCA_SANDBOX_BRIDGE" ip saddr $MOCA_SANDBOX_SUBNET tcp dport $attach accept
    iifname "$MOCA_SANDBOX_BRIDGE" ip saddr $MOCA_SANDBOX_SUBNET meta l4proto { tcp, udp } th dport 53 accept
    iifname "$MOCA_SANDBOX_BRIDGE" counter drop
    ip saddr $MOCA_SANDBOX_SUBNET counter drop
  }
  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname "$MOCA_SANDBOX_BRIDGE" ip daddr 169.254.0.0/16 counter drop
    iifname "$MOCA_SANDBOX_BRIDGE" ip6 daddr fd00:ec2::254 counter drop
  }
}
NFT
  nft -f "$nft"
  tmp_unit="$(mktemp)"
  sed -e "s|@SH_ENV_DIR@|$SH_ENV_DIR|g" -e "s|@NFT@|$nft_bin|g" \
    "$SCRIPT_DIR/systemd/moca-sandbox-firewall.service" >"$tmp_unit"
  install -m 0644 "$tmp_unit" "$SH_UNIT_DIR/moca-sandbox-firewall.service"
  rm -f "$tmp_unit"
  systemctl daemon-reload
  systemctl enable moca-sandbox-firewall.service
  # The table is already loaded by the nft -f above; start only marks the unit active, and the
  # rendered unit takes effect at the next boot. Never restart it: through RequiredBy= a restart
  # also restarts podman-restart.service, which stops every --restart=always container on the host.
  systemctl start moca-sandbox-firewall.service
}

# Reaching the host's relay port from inside a container has been confirmed on one real host
# (deploy/vm/README.md lists what was and was not verified there).
# host.containers.internal is podman's documented analogue of Docker's host.docker.internal
# (podman-run(1): the host-gateway special string), but the alias is now pinned to the
# moca-sandbox gateway rather than podman's host-gateway value: host-gateway resolves to whatever
# the host actually listens on, which is every port bound to 0.0.0.0, not just the relay's attach
# port (MI1 R8). install_sandbox_firewall is what actually restricts that reachability;
# --add-host here only controls what address a sandbox dials. SH_SANDBOX_RELAY_ADDR overrides the
# whole address if this default does not reach the relay on your VM's actual network setup.
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
      --network moca-sandbox \
      --add-host "host.containers.internal:$MOCA_SANDBOX_GATEWAY" \
      -e "SANDBOX_ID=sh-sandbox-$i" \
      -e "RELAY_ADDR=$addr" \
      -e SANDBOX_TOKEN \
      "$SANDBOX_IMAGE"
  done
}

# SH_GITHUB_CLIENT_ID and SH_PUBLIC_HARNESS_URL from this script's environment fill control-plane.env's
# EMPTY slots (the template ships both empty), as deploy/compose/install.sh does for the client id, so
# a first run can be given them instead of a sudoedit. Both, because cp_configured needs both. A value
# already in the file is the operator's and is never replaced -- a re-run with a stale shell variable
# must not repoint logins at another OAuth app -- so a disagreement is only warned about. Each value is
# checked, both before either is written, because set_env_line writes it verbatim as one env line: a
# newline in it would add a line of its own to a root-owned file every unit reads.
seed_control_plane_env() {
  local f="$SH_ENV_DIR/control-plane.env" key want have
  # URL characters only (RFC 3986, minus $ ' ( ) *): no whitespace, quote, `$`, backtick or
  # backslash -- a trailing backslash continues the line for systemd's EnvironmentFile= parser.
  local url_re='^https?://[][A-Za-z0-9._~:/?#@!&+,;=%-]+$'
  # The SHAPE of a client id, not just its characters: letters and digits, with at most one inner dot
  # (Ov23li and 14 more, a legacy 20-hex id, Iv1.<16 hex>). The docs' placeholder `Ov23li...` must not
  # pass: the seed never replaces a value, so a pasted placeholder would stick until the file is edited.
  if [[ -n "${SH_GITHUB_CLIENT_ID:-}" && ! "$SH_GITHUB_CLIENT_ID" =~ ^[A-Za-z0-9]+(\.[A-Za-z0-9]+)?$ ]]; then
    echo "SH_GITHUB_CLIENT_ID in this script's environment is not a GitHub OAuth client id" \
      "(letters and digits, e.g. Ov23li and 14 more, not a placeholder); nothing was written to $f" >&2
    return 1
  fi
  # The characters, then the shape, the way the control plane will parse it at boot (urlEnv in
  # packages/control-plane/src/main.ts): a value it refuses would be a crash loop under
  # Restart=always, not a refusal here. node is in require_cmds.
  if [[ -n "${SH_PUBLIC_HARNESS_URL:-}" ]] && ! { [[ "$SH_PUBLIC_HARNESS_URL" =~ $url_re ]] &&
    node -e 'if (!/^https?:$/.test(new URL(process.argv[1]).protocol)) process.exit(1)' \
      "$SH_PUBLIC_HARNESS_URL" >/dev/null 2>&1; }; then
    echo "SH_PUBLIC_HARNESS_URL in this script's environment is not an http(s):// URL" \
      "(e.g. http://127.0.0.1:8080 behind an SSH tunnel); nothing was written to $f" >&2
    return 1
  fi
  for key in SH_GITHUB_CLIENT_ID SH_PUBLIC_HARNESS_URL; do
    want="${!key:-}"
    [[ -n "$want" ]] || continue
    have="$(env_file_value "$key" "$f")"
    if [[ -z "$have" ]]; then
      log "setting $key in $f from the environment"
      set_env_line "$f" "$key" "$want" || return 1
    elif [[ "$have" != "$want" ]]; then
      echo "WARNING: keeping $key=$have in $f; the environment's $key=$want is ignored." \
        "Edit the file to change it." >&2
    fi
  done
}

# The control plane refuses to boot without SH_GITHUB_CLIENT_ID, and without SH_PUBLIC_HARNESS_URL it
# boots advertising no harness, so no mocactl can find one. Both ship empty (no honest default).
cp_configured() {
  local f="$SH_ENV_DIR/control-plane.env"
  [[ -n "$(env_file_value SH_GITHUB_CLIENT_ID "$f")" && -n "$(env_file_value SH_PUBLIC_HARNESS_URL "$f")" ]]
}

start_services() {
  log "enabling and restarting the relay; enabling the control plane (started once configured) and" \
    "the supervisor (restarted only if running)"
  # `enable --now` leaves an already-running unit alone, so a re-run's env and unit changes would
  # wait for the next reboot. restart applies them now (and starts the relay on a fresh install).
  systemctl enable sh-relay.service
  systemctl restart sh-relay.service
  # Before the supervisor, which exchanges every token-carrying turn with it. Unconfigured, it gets the
  # supervisor's rule, for the supervisor's reason: a unit that cannot boot, under Restart=always, trips
  # the default start limit in seconds and then refuses even `systemctl start` until reset-failed.
  systemctl enable sh-control-plane.service
  if cp_configured; then
    systemctl restart sh-control-plane.service
  else
    systemctl try-restart sh-control-plane.service
  fi
  # SH_TURNS_PER_WORKER ships empty on purpose (§3.8) and readConfig throws on blank, so this
  # unit is EXPECTED to fail until the operator sets it. Restart=always/RestartSec=2 with no
  # StartLimitIntervalSec=0 means systemd's default 5-starts-in-10s limit trips in about ten
  # seconds if this were `enable --now`, after which even the documented recovery command
  # (`systemctl start sh-supervisor.service`) is refused with "start request repeated too
  # quickly" until `systemctl reset-failed`. Enable without --now instead: the unit is wired
  # into multi-user.target for the next boot, but nothing tries to start it yet. try-restart then
  # restarts it only if it is already running -- a re-run's env reaches a configured supervisor,
  # and an unconfigured one stays stopped.
  systemctl enable sh-supervisor.service
  systemctl try-restart sh-supervisor.service
}

main() {
  require_cmds podman systemctl install node getent pnpm nft
  require_systemd 247
  require_root
  require_build
  require_user harness
  install_env
  # Before require_relay_token, which stops a first run: the values given to that run are kept.
  seed_control_plane_env
  require_relay_token
  ensure_exec_token
  ensure_exec_listener
  # Before install_units: sh-supervisor.service LoadCredential=s the exchange token this creates.
  ensure_mu1_secrets
  wire_supervisor_mu1
  # Before install_units, whose daemon-reload picks up (or drops) the token's drop-in.
  ensure_operator_fallback
  install_units
  # Before the containers, so a `podman run` that lands between the two is already covered.
  enable_container_restart
  start_redis
  ensure_sandbox_network
  install_sandbox_firewall
  start_sandboxes
  start_services
  report_done
}

# The closing message, from what systemd reports rather than what a first run would leave: on a
# re-run (every upgrade among them) start_services try-restarted a running supervisor, and telling
# that operator to set SH_TURNS_PER_WORKER and start it would be wrong.
report_done() {
  if systemctl is-active --quiet sh-supervisor.service; then
    log "done — relay and supervisor are running; the supervisor is running this run's configuration" \
      "(restarted by this run)"
  else
    log "done — relay is running. Before starting the supervisor, set SH_TURNS_PER_WORKER in" \
      "$SH_ENV_DIR/supervisor.env, then: systemctl start sh-supervisor.service"
  fi
  if cp_configured; then
    log "control plane: http://127.0.0.1:$(env_file_value SH_CONTROL_PLANE_PORT "$SH_ENV_DIR/control-plane.env")" \
      "on this VM (reach it through an SSH tunnel: deploy/vm/README.md, \"The control plane\")"
  else
    # Not "or systemctl start": with either value missing the unit cannot boot, or boots advertising
    # no harness. Both routes below set both.
    log "control plane installed but not started: set SH_GITHUB_CLIENT_ID and SH_PUBLIC_HARNESS_URL in" \
      "$SH_ENV_DIR/control-plane.env and re-run this script, or pass both to it:" \
      "sudo env SH_GITHUB_CLIENT_ID=... SH_PUBLIC_HARNESS_URL=... $0"
  fi
}

# Sourcing guard: lets the test load these functions without touching the machine.
if [[ -z "${SH_SOURCE_ONLY:-}" ]]; then
  main "$@"
fi
