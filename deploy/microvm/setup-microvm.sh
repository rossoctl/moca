#!/usr/bin/env bash
# deploy/microvm/setup-microvm.sh
#
# Installs the P4 microVM tier NEXT TO an installed P6 (deploy/vm/setup-vm.sh): the microvm-worker
# binary, its unit and slice, and the wiring that attaches it to P6's relay under its OWN relay
# token (#369). It reads P6's installed relay.env and never writes a P6-owned file: the relay learns
# the new token through a systemd drop-in that loads a separate env file.
#
# Prerequisites: P6 installed and running; /dev/kvm; Firecracker + jailer in /usr/local/bin; a golden
# snapshot at $MICROVM_SNAPSHOT_DIR (build-rootfs.sh, then build-snapshot.sh -- see P4-ON-P6.md);
# Go, unless MICROVM_BIN (and MOCA_EGRESS_BIN) name prebuilt binaries.
#
# A HOST WITH CONTAINER SANDBOXES TOO (P6.3, docs/specs/2026-10-04-p6-on-kubernetes-slice3-design.md
# §7) is made tiered rather than refused: when any sh-sandbox-* container exists, running or stopped,
# this script writes microvm-tiers.env and drop-ins that load it into sh-supervisor and
# sh-control-plane, so each session stays in the tier it was created in. A P4-only host stays untiered.
# Before it writes anything, every RUNNING container sandbox must advertise moca.dev/tier=container
# in its presence record (a pre-P6.3 image advertises none, and a tiered host would exclude it); a
# stopped one cannot be checked and is warned about.
#
# Usage: sudo ./deploy/microvm/setup-microvm.sh [--remote BUNDLE_DIR]      (re-running changes nothing)
#        sudo ./deploy/microvm/setup-microvm.sh --template ID --snapshot DIR [--budget-mb N] [--egress]
#        sudo ./deploy/microvm/setup-microvm.sh --uninstall-template ID
#
# --template ID --snapshot DIR (session templates, docs/specs/2026-10-30-session-sandbox-templates-design.md
# §7): install a SECOND P4 worker beside the main one, serving the snapshot DIR (a directory holding
# manifest.json, e.g. one build-snapshot.sh wrote) as sandbox template ID. It runs from the template
# unit microvm-worker@.service as instance tpl_<id with - as _>, in its own slice microvm-tpl-<instance>.slice
# (each worker sweeps its own parent cgroup at start, so two workers never share one), with its own
# workspace and jail roots, relay token and env file. The main install must exist first; nothing of
# the main worker is touched. Its guest RAM is the snapshot manifest's; --budget-mb (default the
# least that holds one session) and --egress (default: none, so the guest has no network) are its own.
# --uninstall-template ID stops it and removes exactly what --template wrote, keeping workspace data.
#
# --remote BUNDLE_DIR (P6 on Kubernetes, docs/specs/2026-10-04-p6-on-kubernetes-slice2-design.md §5):
# attach this host's worker to a relay in a cluster, over TLS, instead of to a local P6. The bundle is
# the directory deploy/k8s/setup.sh wrote for this host's ID; its token replaces a local one (the
# cluster is the token authority), and MICROVM_SANDBOX_ID comes from it. No relay drop-in, no podman,
# no installed P6 needed. The one local change: tier files an earlier mixed run wrote are removed, and
# the installed units try-restarted, since this host's own P6 is container-only once its only microVM
# worker attaches elsewhere. moca-egress (P4.1) is installed and started in both modes, since the
# worker unit references it. Running again without --remote switches back.
#
# Env overrides: SH_UNIT_DIR, SH_ENV_DIR, SH_BIN_DIR, MICROVM_SANDBOX_ID, MICROVM_WORKSPACE_IDLE,
# MICROVM_SNAPSHOT_DIR, MICROVM_BIN, MOCA_EGRESS_BIN, MOCA_EGRESS_ALLOW (seeds a NEW moca-egress.env
# only), MOCA_EGRESS_READY_TIMEOUT (seconds to wait for its control socket, default 30),
# MICROVM_ATTACH_TIMEOUT, MICROVM_ATTACH_SETTLE (--remote: seconds
# an attach must hold before it counts, at least 1) -- defaults below -- and
# MICROVM_MAX_COMMITTED_MB (unset by default): a VM-memory budget in MiB for a host smaller than the
# shipped unit's 24 GiB, written as a drop-in that also lowers the unit's AssertMemory to match -- and
# SH_SANDBOX_DEFAULT_TIER (container or microvm): the tier of a session created without one, on a host
# with both tiers. Sticky, like deploy/k8s/setup.sh's: unset keeps the value in microvm-tiers.env (else
# container), and set but empty clears it back to container. Given on a host that ends up untiered
# (P4-only, or --remote), it is not recorded, and a log line says so.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
: "${SH_UNIT_DIR:=/etc/systemd/system}"
: "${SH_ENV_DIR:=/etc/serverless-harness}"
: "${DEFAULT_EGRESS_ALLOW:=api.github.com,github.com,codeload.github.com,objects.githubusercontent.com}"
: "${SH_BIN_DIR:=/usr/local/bin}"
SANDBOX_ID_GIVEN="${MICROVM_SANDBOX_ID+x}" # --remote refuses a given id that disagrees with the bundle
: "${MICROVM_SANDBOX_ID:=moca_microvm_0}"
: "${MICROVM_WORKSPACE_IDLE:=8h}"
: "${MICROVM_SNAPSHOT_DIR:=/srv/snapshots/default}"
: "${MICROVM_ATTACH_TIMEOUT:=60}"
: "${MICROVM_ATTACH_SETTLE:=5}"
# moca-egress's control socket (MOCA_EGRESS_CONTROL_SOCK in microvm-worker.service) and how long to
# wait for it after starting the unit: overridable only so the tests can point it at a temp dir.
: "${MOCA_EGRESS_SOCKET:=/run/moca-egress/control.sock}"
: "${MOCA_EGRESS_READY_TIMEOUT:=30}"

RELAY_DROPIN="50-moca-microvm.conf"
WORKER_DROPIN="50-moca-p6.conf"
REMOTE_DROPIN="50-moca-remote.conf"
RELAY_CA_DST="$SH_ENV_DIR/microvm-relay-ca.crt"
REMOTE_BUNDLE='' # --remote's directory; empty in local mode
TPL_ID='' TPL_SNAPSHOT='' TPL_BUDGET_MB='' TPL_EGRESS='' TPL_UNINSTALL='' # --template / --uninstall-template
TEMPLATE_ID_RE='^[a-z0-9][a-z0-9-]{0,30}$' # the control plane's template id rule
TPL_UNIT_SRC="microvm-worker@.service" # the template unit this script writes from microvm-worker.service
TPL_SRV_ROOT="${MICROVM_TPL_SRV:-}" # per-template roots; default: beside the snapshot (template_main)
B_ADDR='' B_ID='' B_TOKEN='' B_CA=''
MEMORY_DROPIN="60-moca-memory.conf"
TIERS_DROPIN="50-microvm-tiers.conf" # in sh-supervisor.service.d and sh-control-plane.service.d
# The shipped unit's SH_MEMORY_RESERVE_MB: a budget at or below it admits nothing (Config.Normalize).
SHIPPED_RESERVE_MB=4096
CHANGED=() # destination paths this run actually rewrote
MIXED=0    # 1 when container sandboxes share this host with the microVM worker (preflight)
DEFAULT_TIER=container # the resolved SH_SANDBOX_DEFAULT_TIER (preflight)

log() { printf '==> %s\n' "$*"; }
die() { echo "setup-microvm.sh: $*" >&2; exit 1; }

# The relay authenticates a sandbox by SH_RELAY_TOKEN_<sandboxId> (sandbox-relay/src/main.ts), and
# systemd's EnvironmentFile= only accepts shell-valid names -- a dashed id's line is dropped with a
# log message, and the attach then fails closed with nothing pointing at why.
# DIR is reserved: SH_RELAY_TOKEN_DIR is the relay's token-directory setting, so the relay refuses
# that ID before any lookup (k8s slice 2 spec §2.1) and such a worker could never attach.
validate_sandbox_id() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    { echo "MICROVM_SANDBOX_ID='$1' must match ^[A-Za-z_][A-Za-z0-9_]*\$ (it becomes the env name SH_RELAY_TOKEN_$1)" >&2; return 1; }
  [[ "$1" != DIR ]] ||
    { echo "MICROVM_SANDBOX_ID='DIR' is reserved: SH_RELAY_TOKEN_DIR is the relay's token-directory setting, so the relay refuses that ID" >&2; return 1; }
}

# env_value <key> <file>: the last <key>= value, one matched pair of surrounding quotes stripped the
# way systemd's EnvironmentFile= strips them. Same semantics as setup-vm.sh's helpers, re-implemented
# rather than sourced because that script is being reworked in parallel (#366).
env_value() {
  local v
  v="$( (grep -E "^$1=" "$2" 2>/dev/null || true) | tail -1 | cut -d= -f2-)"
  if ((${#v} >= 2)); then
    case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  fi
  printf '%s' "$v"
}

# relay_port <relay.env>: the relay's attach port, 8443 when unset (sandbox-relay/src/main.ts).
relay_port() {
  local p
  p="$(env_value SH_RELAY_PORT "$1")"
  [[ -z "$p" ]] && { echo 8443; return; }
  [[ "$p" =~ ^[0-9]+$ ]] || { echo "SH_RELAY_PORT='$p' in $1 is not a port number" >&2; return 1; }
  echo "$p"
}

parse_args() {
  while (($#)); do
    case "$1" in
    --remote)
      [[ $# -ge 2 && -n "$2" ]] || die '--remote needs the bundle directory deploy/k8s/setup.sh wrote for this host'
      REMOTE_BUNDLE="$2"
      shift 2
      ;;
    --template) [[ $# -ge 2 && -n "$2" ]] || die '--template needs a template id'; TPL_ID="$2"; shift 2 ;;
    --snapshot) [[ $# -ge 2 && -n "$2" ]] || die '--snapshot needs a snapshot directory'; TPL_SNAPSHOT="$2"; shift 2 ;;
    --budget-mb) [[ $# -ge 2 && -n "$2" ]] || die '--budget-mb needs MiB'; TPL_BUDGET_MB="$2"; shift 2 ;;
    --egress) TPL_EGRESS=1; shift ;;
    --uninstall-template)
      [[ $# -ge 2 && -n "$2" ]] || die '--uninstall-template needs a template id'
      TPL_ID="$2" TPL_UNINSTALL=1
      shift 2
      ;;
    *) die "unknown argument: $1 (usage: setup-microvm.sh [--remote BUNDLE_DIR] | --template ID --snapshot DIR [--budget-mb N] [--egress] | --uninstall-template ID)" ;;
    esac
  done
}

# load_bundle: the bundle deploy/k8s/setup.sh writes per P4 ID, checked before anything is written.
# Every refusal names the field, never the token's value.
load_bundle() {
  local env="$REMOTE_BUNDLE/worker.env" tls
  [[ -f "$env" ]] ||
    die "no $env: --remote takes the bundle directory deploy/k8s/setup.sh writes (deploy/k8s/.generated/ocp/p4/<id>)"
  B_ADDR="$(env_value RELAY_ADDR "$env")"
  # Without a port the worker fails later, at dial, with an opaque error; the relay Route is on 443.
  [[ "$B_ADDR" =~ ^[A-Za-z0-9.-]+:[0-9]+$ ]] ||
    die "RELAY_ADDR='$B_ADDR' in $env must be host:port -- the relay Route is <host>:443"
  tls="$(env_value RELAY_TLS "$env")"
  [[ "$tls" == true ]] || die "RELAY_TLS='$tls' in $env: a relay outside this host is reached over TLS only"
  B_ID="$(env_value SANDBOX_ID "$env")"
  validate_sandbox_id "$B_ID" || exit 1
  [[ -z "$SANDBOX_ID_GIVEN" || "$MICROVM_SANDBOX_ID" == "$B_ID" ]] ||
    die "the bundle is for $B_ID but MICROVM_SANDBOX_ID=$MICROVM_SANDBOX_ID: unset it (--remote takes the id from the bundle)"
  B_TOKEN="$(env_value SANDBOX_TOKEN "$env")"
  [[ "$B_TOKEN" =~ ^[0-9a-f]{64}$ ]] ||
    die "SANDBOX_TOKEN in $env is not 64 hex characters: copy the bundle again from deploy/k8s/.generated/ocp/p4/$B_ID"
  B_CA=''
  if [[ -f "$REMOTE_BUNDLE/relay-ca.crt" ]]; then
    grep -q -- '-----BEGIN CERTIFICATE-----' "$REMOTE_BUNDLE/relay-ca.crt" ||
      die "$REMOTE_BUNDLE/relay-ca.crt holds no PEM certificate"
    B_CA="$REMOTE_BUNDLE/relay-ca.crt"
  fi
  MICROVM_SANDBOX_ID="$B_ID"
}

preflight() {
  [[ "$(id -u)" == 0 ]] || die "must run as root (installs units under $SH_UNIT_DIR)"
  if [[ -n "$REMOTE_BUNDLE" ]]; then load_bundle; else validate_sandbox_id "$MICROVM_SANDBOX_ID" || exit 1; fi
  if [[ -n "${MICROVM_MAX_COMMITTED_MB:-}" ]] &&
    ! { [[ "$MICROVM_MAX_COMMITTED_MB" =~ ^[1-9][0-9]*$ ]] && ((MICROVM_MAX_COMMITTED_MB > SHIPPED_RESERVE_MB)); }; then
    die "MICROVM_MAX_COMMITTED_MB='$MICROVM_MAX_COMMITTED_MB' must be a whole number of MiB above the unit's SH_MEMORY_RESERVE_MB ($SHIPPED_RESERVE_MB), or nothing is ever admitted"
  fi
  [[ "$MICROVM_ATTACH_TIMEOUT" =~ ^[1-9][0-9]*$ ]] ||
    die "MICROVM_ATTACH_TIMEOUT='$MICROVM_ATTACH_TIMEOUT' must be a whole number of seconds, at least 1"
  [[ "$MOCA_EGRESS_READY_TIMEOUT" =~ ^[1-9][0-9]*$ ]] ||
    die "MOCA_EGRESS_READY_TIMEOUT='$MOCA_EGRESS_READY_TIMEOUT' must be a whole number of seconds, at least 1"
  # At least 1: the hold must outlast the worker's first reconnect backoff (at most 750ms), or a
  # rejected token's attached -> stream ended -> attached cycle could fall outside the window.
  [[ "$MICROVM_ATTACH_SETTLE" =~ ^[1-9][0-9]*$ ]] ||
    die "MICROVM_ATTACH_SETTLE='$MICROVM_ATTACH_SETTLE' must be a whole number of seconds, at least 1, to outlast the worker's first reconnect backoff (at most 750ms)"
  # The default tier is sticky: a re-run without SH_SANDBOX_DEFAULT_TIER must not silently flip a
  # chosen microvm back to container (and try-restart both units to do it). Set but empty clears it.
  # The RESOLVED value is checked, so a bad stored one is refused too -- on both paths, before the
  # --remote return below, so a bad value writes nothing anywhere. (--remote records no default and
  # removes microvm-tiers.env, but a typo should not pass silently.) A stored one names its clear.
  local tiers_env="$SH_ENV_DIR/microvm-tiers.env" from clear=''
  if [[ -n "${SH_SANDBOX_DEFAULT_TIER+x}" ]]; then
    DEFAULT_TIER="${SH_SANDBOX_DEFAULT_TIER:-container}" from=''
  else
    DEFAULT_TIER="$(env_value SH_SANDBOX_DEFAULT_TIER "$tiers_env")" from=" in $tiers_env"
    DEFAULT_TIER="${DEFAULT_TIER:-container}"
    clear=', or set SH_SANDBOX_DEFAULT_TIER= (empty) to clear it'
  fi
  case "$DEFAULT_TIER" in
    container | microvm) ;;
    *) die "SH_SANDBOX_DEFAULT_TIER='$DEFAULT_TIER'$from must be container or microvm$clear" ;;
  esac
  if [[ -z "$REMOTE_BUNDLE" ]]; then
    [[ -f "$SH_ENV_DIR/relay.env" && -f "$SH_UNIT_DIR/sh-relay.service" ]] ||
      die "no installed P6 found ($SH_ENV_DIR/relay.env, $SH_UNIT_DIR/sh-relay.service); run deploy/vm/setup-vm.sh first"
  fi
  [[ -f "$MICROVM_SNAPSHOT_DIR/manifest.json" ]] ||
    die "no golden snapshot at $MICROVM_SNAPSHOT_DIR; build one with deploy/microvm/build-rootfs.sh then build-snapshot.sh (deploy/microvm/P4-ON-P6.md)"
  # Remote: MIXED stays 0. This host's own containers, if any, attach to its own relay, which the
  # remote worker does not use, so the local P6 is container-only and untiered (install_tiers removes
  # what an earlier mixed run wrote); the cluster's setup.sh tiers the cluster's stack.
  [[ -z "$REMOTE_BUNDLE" ]] || return 0
  local attached
  # -a: a STOPPED sandbox container still counts. setup-vm.sh runs them --restart=always, and
  # podman-restart.service brings every such container back at boot -- both tiers attached again.
  attached="$(podman ps -a --format '{{.Names}}' --filter 'name=^sh-sandbox-' | tr '\n' ' ')"
  # P6.3: a host with both tiers is TIERED rather than refused -- each session stays in the tier it
  # was created in (spec §7; deploy/vm/env/supervisor.env.example, "Sandbox tiers"). install_tiers acts on it.
  [[ -z "${attached// /}" ]] || MIXED=1
  ((MIXED == 0)) || check_container_tiers "$attached"
}

# check_container_tiers "<sh-sandbox-* names>": before a host is tiered, every RUNNING container
# sandbox must advertise moca.dev/tier=container. setup-vm.sh never pulls (`podman run --replace` of
# the image it already has), so an older host keeps a pre-P6.3 image, whose worker advertises no
# tier; the tiered harness excludes it, and every container-tier session -- the default tier -- then
# fails with "no attached sandbox in sandbox tier 'container'". The label is read from the presence
# record the relay mirrors from the worker's Hello (sh:sandbox:records, keyed by sandbox id), the
# way start_worker and verify_attached reach Redis. The id is the container's name: setup-vm.sh's
# start_sandboxes runs `--name sh-sandbox-$i -e SANDBOX_ID=sh-sandbox-$i`. A STOPPED container has
# no record to read and is only warned about. Nothing is guessed: an unreachable Redis is refused.
check_container_tiers() {
  local running name rec tier img bad='' first_bad='' unattached=''
  running=" $(podman ps --format '{{.Names}}' --filter 'name=^sh-sandbox-' | tr '\n' ' ') "
  for name in $1; do
    [[ "$running" == *" $name "* ]] ||
      log "WARNING: $name is not running, so its tier cannot be checked; it must be P6.3 or later"
  done
  [[ -n "${running// /}" ]] || return 0
  [[ "$(podman exec sh-redis redis-cli PING 2>/dev/null)" == PONG ]] ||
    die "cannot reach Redis (podman exec sh-redis redis-cli PING) to check the container sandboxes' tier before tiering this host; start sh-redis (deploy/vm/setup-vm.sh) and re-run. Nothing was written"
  for name in $running; do
    rec="$(podman exec sh-redis redis-cli HGET sh:sandbox:records "$name")" ||
      die "cannot reach Redis to read $name's presence record; start sh-redis (deploy/vm/setup-vm.sh) and re-run. Nothing was written"
    if [[ -z "$rec" ]]; then unattached+=" $name"; continue; fi
    tier="$(printf '%s' "$rec" | sed -n 's/.*"moca\.dev\/tier":"\([^"]*\)".*/\1/p')"
    [[ "$tier" == container ]] || { bad+=" $name (tier '${tier:-none}')"; first_bad="${first_bad:-$name}"; }
  done
  if [[ -n "$bad" ]]; then
    # The image the container runs is the one setup-vm.sh was given (SANDBOX_IMAGE, or its default).
    img="$(podman inspect --format '{{.ImageName}}' "$first_bad" 2>/dev/null)" || img=''
    img="${img:-${SANDBOX_IMAGE:-ghcr.io/rossoctl/moca-remote-worker:latest}}"
    die "container sandboxes not advertising moca.dev/tier=container:$bad. A tiered host excludes them, and every container-tier session would fail; no tier at all means a pre-P6.3 image. setup-vm.sh never pulls, so: podman pull $img, then re-run deploy/vm/setup-vm.sh (its podman run --replace recreates the containers on the new image), then re-run this script. Nothing was written"
  fi
  [[ -z "$unattached" ]] ||
    die "${unattached# } is running but not attached to the relay (no record in sh:sandbox:records), so its tier cannot be checked; see podman logs and journalctl -u sh-relay, then re-run. Nothing was written"
}

# install_if_changed <src> <dst> <mode>: copy only when the content differs, recording dst in CHANGED.
install_if_changed() {
  if ! cmp -s "$1" "$2" 2>/dev/null; then
    mkdir -p "$(dirname "$2")"
    install -m "$3" "$1" "$2"
    CHANGED+=("$2")
  fi
}

# remove_if_present <path>: delete a file this script once wrote, recording it in CHANGED.
remove_if_present() { if [[ -e "$1" ]]; then rm -f "$1"; CHANGED+=("$1"); fi; }

# render_env <file> <keep|set|drop> <key> <value> [<keep|set|drop> <key> <value>]... -> writes <file>.new
# keep: write only if the key is absent. set: replace the value IN PLACE (never delete-and-append,
# which reorders the file and makes an unchanged re-run look like a change). drop: delete every
# <key>= line; its value is ignored (pass '' to keep the triplet shape). Every other line --
# including ones an operator added -- is preserved where it is.
render_env() {
  local file="$1"; shift
  local out="$file.new" mode key value tmp
  (umask 077; if [[ -f "$file" ]]; then cp "$file" "$out"; else : >"$out"; fi)
  # An operator-edited file may lack a final newline; appending onto it would glue two assignments.
  if [[ -s "$out" && -n "$(tail -c 1 "$out")" ]]; then printf '\n' >>"$out"; fi
  while (($#)); do
    mode="$1" key="$2" value="$3"; shift 3
    if [[ "$mode" == drop ]]; then
      if grep -qE "^$key=" "$out"; then
        tmp="$(mktemp)"
        awk -v k="$key" 'index($0, k "=") != 1' "$out" >"$tmp"
        cat "$tmp" >"$out"; rm -f "$tmp"
      fi
      continue
    fi
    if grep -qE "^$key=" "$out"; then
      [[ "$mode" == keep ]] && continue
      tmp="$(mktemp)"
      # The value travels in the environment, never argv: it may be the relay token.
      RENDER_VALUE="$value" awk -v k="$key" 'index($0, k "=") == 1 { print k "=" ENVIRON["RENDER_VALUE"]; next } { print }' "$out" >"$tmp"
      cat "$tmp" >"$out"; rm -f "$tmp"
    else
      printf '%s=%s\n' "$key" "$value" >>"$out"
    fi
  done
}

commit_env() { # commit_env <file>: move <file>.new into place iff it differs
  if cmp -s "$1.new" "$1" 2>/dev/null; then rm -f "$1.new"; return; fi
  chmod 0600 "$1.new"; mv "$1.new" "$1"; CHANGED+=("$1")
}

install_worker_binary() {
  local stage; stage="$(mktemp -d)"
  if [[ -n "${MICROVM_BIN:-}" ]]; then
    cp "$MICROVM_BIN" "$stage/microvm-worker"
  else
    log "building microvm-worker from $REPO_ROOT/remote-worker"
    (cd "$REPO_ROOT/remote-worker" &&
      CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w' -o "$stage/microvm-worker" ./cmd/microvm-worker)
  fi
  install_if_changed "$stage/microvm-worker" "$SH_BIN_DIR/microvm-worker" 0755
  rm -rf "$stage"
}

# install_egress_binary: moca-egress (P4.1), built or taken from MOCA_EGRESS_BIN exactly as the worker is.
install_egress_binary() {
  local stage; stage="$(mktemp -d)"
  if [[ -n "${MOCA_EGRESS_BIN:-}" ]]; then
    cp "$MOCA_EGRESS_BIN" "$stage/moca-egress"
  else
    log "building moca-egress from $REPO_ROOT/remote-worker"
    (cd "$REPO_ROOT/remote-worker" &&
      CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w' -o "$stage/moca-egress" ./cmd/moca-egress)
  fi
  install_if_changed "$stage/moca-egress" "$SH_BIN_DIR/moca-egress" 0755
  rm -rf "$stage"
}

# install_egress_env: the allowlist, written ONLY when absent so an operator's edit survives a re-run.
# MOCA_EGRESS_ALLOW from the environment seeds a fresh file; it never overrides an existing one. No
# secret lives here, so 0644 (the unit's DynamicUser reads it via systemd, as root, regardless).
install_egress_env() {
  local env="$SH_ENV_DIR/moca-egress.env" stage; stage="$(mktemp -d)"
  if [[ ! -e "$env" ]]; then
    printf 'MOCA_EGRESS_ALLOW=%s\n' "${MOCA_EGRESS_ALLOW:-$DEFAULT_EGRESS_ALLOW}" >"$stage/moca-egress.env"
    install_if_changed "$stage/moca-egress.env" "$env" 0644
  fi
  rm -rf "$stage"
}

install_units() {
  local stage; stage="$(mktemp -d)"
  install_if_changed "$SCRIPT_DIR/moca-egress.service" "$SH_UNIT_DIR/moca-egress.service" 0644
  install_if_changed "$SCRIPT_DIR/microvm-worker.service" "$SH_UNIT_DIR/microvm-worker.service" 0644
  install_if_changed "$SCRIPT_DIR/microvm-vms.slice" "$SH_UNIT_DIR/microvm-vms.slice" 0644
  if [[ -n "$REMOTE_BUNDLE" ]]; then
    printf '# Written by deploy/microvm/setup-microvm.sh --remote: attach this worker to a relay outside this host, over TLS.\n[Unit]\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nEnvironmentFile=%s\n' \
      "$SH_ENV_DIR/microvm-worker.env" >"$stage/worker.conf"
    install_if_changed "$stage/worker.conf" "$SH_UNIT_DIR/microvm-worker.service.d/$REMOTE_DROPIN" 0644
    remove_if_present "$SH_UNIT_DIR/microvm-worker.service.d/$WORKER_DROPIN"
  else
    printf '# Written by deploy/microvm/setup-microvm.sh: the per-sandbox relay token for the P4 worker.\n[Service]\nEnvironmentFile=%s\n' \
      "$SH_ENV_DIR/microvm-relay.env" >"$stage/relay.conf"
    install_if_changed "$stage/relay.conf" "$SH_UNIT_DIR/sh-relay.service.d/$RELAY_DROPIN" 0644
    printf '# Written by deploy/microvm/setup-microvm.sh: attach this worker to the P6 relay on this host.\n[Unit]\nAfter=sh-relay.service\nWants=sh-relay.service\n\n[Service]\nEnvironmentFile=%s\n' \
      "$SH_ENV_DIR/microvm-worker.env" >"$stage/worker.conf"
    install_if_changed "$stage/worker.conf" "$SH_UNIT_DIR/microvm-worker.service.d/$WORKER_DROPIN" 0644
    remove_if_present "$SH_UNIT_DIR/microvm-worker.service.d/$REMOTE_DROPIN"
  fi
  install_memory_dropin "$stage"
  rm -rf "$stage"
}

# The shipped unit budgets 24 GiB and asserts >=23G of physical memory, so on a smaller host it
# refuses to start -- correctly, since the budget would promise memory that is not there. A smaller
# host gets a smaller budget AND a matching assertion, in the same 90%-of-budget band
# systemd-units.test.sh holds the shipped values to. `AssertMemory=` (empty) resets the unit's list
# first; without it the shipped >=23G would still apply alongside the new one. The reset clears EVERY
# assertion, not just the memory one (systemd.unit(5); verified on a rig: a unit asserting a missing
# path started once the reset was in a drop-in), so each other Assert*= of the shipped unit -- the
# /dev/kvm guard above all -- is re-stated after it, read from the unit so a new one is carried too.
# A leading zero is refused: bash arithmetic would read it as octal while Go parses it as decimal.
install_memory_dropin() {
  local dst="$SH_UNIT_DIR/microvm-worker.service.d/$MEMORY_DROPIN"
  if [[ -z "${MICROVM_MAX_COMMITTED_MB:-}" ]]; then
    remove_if_present "$dst"
    return
  fi
  printf '%s\n' \
    "# Written by deploy/microvm/setup-microvm.sh (MICROVM_MAX_COMMITTED_MB): a VM-memory budget" \
    "# for a host smaller than the shipped unit assumes, and the physical-memory assertion to match." \
    "[Unit]" "AssertMemory=" "AssertMemory=>=$((MICROVM_MAX_COMMITTED_MB * 90 / 100))M" \
    >"$1/memory.conf"
  grep -E '^Assert[A-Za-z]+=' "$SCRIPT_DIR/microvm-worker.service" | grep -v '^AssertMemory=' >>"$1/memory.conf" || true
  printf '%s\n' "" "[Service]" "Environment=SH_MAX_COMMITTED_MB=$MICROVM_MAX_COMMITTED_MB" >>"$1/memory.conf"
  install_if_changed "$1/memory.conf" "$dst" 0644
}

# install_tiers: co-located with container sandboxes, tell P6's supervisor and control plane that two
# tiers exist (P6.3), through ONE env file both units load, so the two cannot disagree; otherwise
# (P4-only, or --remote) remove what an earlier mixed run wrote. Drop-ins and an env file of OURS,
# never an edit to supervisor.env / control-plane.env, which setup-vm.sh owns.
install_tiers() {
  local env="$SH_ENV_DIR/microvm-tiers.env" def="$DEFAULT_TIER" stage stored
  local sup="$SH_UNIT_DIR/sh-supervisor.service.d/$TIERS_DROPIN"
  local cp="$SH_UNIT_DIR/sh-control-plane.service.d/$TIERS_DROPIN"
  if ((MIXED == 0)); then
    # The sticky default lives only in the tiers file, so an untiered host neither records a given
    # one nor keeps a stored one: both are said out loud, so a later return to mixed is no surprise.
    [[ -z "${SH_SANDBOX_DEFAULT_TIER:-}" ]] ||
      log "SH_SANDBOX_DEFAULT_TIER=$SH_SANDBOX_DEFAULT_TIER ignored: this host is not tiered (only a host with container sandboxes AND a local P4 worker is), so it is not recorded"
    if [[ -f "$env" ]]; then
      stored="$(env_value SH_SANDBOX_DEFAULT_TIER "$env")"
      [[ -z "$stored" || "$stored" == container ]] ||
        log "this host is no longer tiered: the stored SH_SANDBOX_DEFAULT_TIER=$stored in $env is dropped with it (sessions default to container again if it is re-tiered)"
    fi
    # Running units keep the old drop-in until the daemon-reload in apply(), and see the change at
    # its try-restart there; the order of these removals does not matter.
    remove_if_present "$sup"; remove_if_present "$cp"; remove_if_present "$env"
    return 0
  fi
  log "two sandbox tiers on this host (container, microvm; default $def): each session stays in the tier it was created in"
  stage="$(mktemp -d)"
  printf 'SH_SANDBOX_TIERS=container,microvm\nSH_SANDBOX_DEFAULT_TIER=%s\n' "$def" >"$stage/tiers.env"
  # `EnvironmentFile=` WITHOUT systemd's `-` prefix, on purpose: a tiers file deleted by hand makes
  # both units fail to start, loudly, rather than run untiered on a host that has both tiers.
  printf '[Service]\nEnvironmentFile=%s\n' "$env" >"$stage/tiers.conf"
  install_if_changed "$stage/tiers.env" "$env" 0644
  install_if_changed "$stage/tiers.conf" "$sup" 0644
  install_if_changed "$stage/tiers.conf" "$cp" 0644
  rm -rf "$stage"
}

install_env() {
  local worker="$SH_ENV_DIR/microvm-worker.env" relay="$SH_ENV_DIR/microvm-relay.env" port token
  port="$(relay_port "$SH_ENV_DIR/relay.env")"
  # Generated once, never rotated (setup-vm.sh's rule for its own secrets). The relay's copy is the
  # source of truth when there is one: after --remote the worker's file holds the CLUSTER's token,
  # and switching back must restore the one the local relay accepts -- never hand it the cluster's.
  token="$(env_value "SH_RELAY_TOKEN_$MICROVM_SANDBOX_ID" "$relay")"
  if [[ -z "$token" && "$(env_value RELAY_TLS "$worker")" != true ]]; then
    token="$(env_value SANDBOX_TOKEN "$worker")"
  fi
  if [[ -z "$token" ]]; then
    token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
    [[ ${#token} == 64 ]] || die "could not generate a relay token"
  fi
  render_env "$worker" \
    set RELAY_ADDR "127.0.0.1:$port" \
    set SANDBOX_ID "$MICROVM_SANDBOX_ID" \
    set SANDBOX_TOKEN "$token" \
    keep SH_WORKSPACE_IDLE "$MICROVM_WORKSPACE_IDLE" \
    drop RELAY_TLS '' \
    drop RELAY_CA_FILE ''
  commit_env "$worker"
  remove_if_present "$RELAY_CA_DST"
  # The relay's file is wholly installer-owned, so it is rendered from scratch rather than merged:
  # a changed MICROVM_SANDBOX_ID must not leave the OLD id's token behind, still valid at the relay.
  (umask 077; printf 'SH_RELAY_TOKEN_%s=%s\n' "$MICROVM_SANDBOX_ID" "$token" >"$relay.new")
  commit_env "$relay"
}

# --remote: the worker env comes from the bundle; the CA is not secret (0644). A stale
# microvm-relay.env is left in place, so switching back restores the local token.
install_env_remote() {
  local worker="$SH_ENV_DIR/microvm-worker.env" ca
  if [[ -n "$B_CA" ]]; then
    install_if_changed "$B_CA" "$RELAY_CA_DST" 0644
    ca=(set RELAY_CA_FILE "$RELAY_CA_DST")
  else
    remove_if_present "$RELAY_CA_DST"
    ca=(drop RELAY_CA_FILE '')
  fi
  render_env "$worker" \
    set RELAY_ADDR "$B_ADDR" \
    set RELAY_TLS true \
    set SANDBOX_ID "$B_ID" \
    set SANDBOX_TOKEN "$B_TOKEN" \
    keep SH_WORKSPACE_IDLE "$MICROVM_WORKSPACE_IDLE" \
    "${ca[@]}"
  commit_env "$worker"
}

changed_any() { # changed_any <path>...: true iff one of them is in CHANGED
  local c p
  for p in "$@"; do for c in "${CHANGED[@]+"${CHANGED[@]}"}"; do [[ "$c" == "$p" ]] && return 0; done; done
  return 1
}

apply() {
  local relay_restart=0
  if changed_any "$SH_UNIT_DIR/microvm-worker.service" "$SH_UNIT_DIR/microvm-vms.slice" "$SH_UNIT_DIR/moca-egress.service" \
    "$SH_UNIT_DIR/sh-relay.service.d/$RELAY_DROPIN" "$SH_UNIT_DIR/microvm-worker.service.d/$WORKER_DROPIN" \
    "$SH_UNIT_DIR/microvm-worker.service.d/$REMOTE_DROPIN" "$SH_UNIT_DIR/microvm-worker.service.d/$MEMORY_DROPIN" \
    "$SH_UNIT_DIR/sh-supervisor.service.d/$TIERS_DROPIN" "$SH_UNIT_DIR/sh-control-plane.service.d/$TIERS_DROPIN"; then
    systemctl daemon-reload
  fi
  if changed_any "$SH_UNIT_DIR/sh-relay.service.d/$RELAY_DROPIN" "$SH_ENV_DIR/microvm-relay.env"; then
    log "restarting sh-relay.service to load the microVM worker's token (in-flight turns fail and retry)"
    systemctl restart sh-relay.service
    relay_restart=1
  fi
  # try-restart, never restart (setup-vm.sh's rule): an unconfigured supervisor or control plane is
  # left stopped on purpose, and starting it would trip systemd's start limit. A stopped unit loads
  # the drop-in on its next start anyway.
  # Only a unit that is installed: a P6 from before the control plane (#366) has no
  # sh-control-plane.service, and systemd refuses a try-restart of a unit it cannot find (exit 5) --
  # under set -e that would end the run with the files written, and a re-run, seeing them unchanged,
  # would never try-restart the supervisor. The drop-in is written all the same: it is harmless, and
  # the setup-vm.sh run that later installs the unit picks it up.
  if changed_any "$SH_ENV_DIR/microvm-tiers.env" "$SH_UNIT_DIR/sh-supervisor.service.d/$TIERS_DROPIN" \
    "$SH_UNIT_DIR/sh-control-plane.service.d/$TIERS_DROPIN"; then
    log "re-reading the sandbox tiers: try-restart sh-control-plane and sh-supervisor (the supervisor drains in-flight turns)"
    [[ ! -f "$SH_UNIT_DIR/sh-control-plane.service" ]] || systemctl try-restart sh-control-plane.service
    [[ ! -f "$SH_UNIT_DIR/sh-supervisor.service" ]] || systemctl try-restart sh-supervisor.service
  fi
  # moca-egress first: the worker registers each VM's egress listener with it. A restart (not a
  # stop/start) is enough, the worker's control client re-registers live VMs on reconnect.
  # The restart severs in-flight guest connections (open tunnels die); new ones work at once.
  systemctl enable moca-egress.service
  # A Type=notify start that exits or times out before READY=1 -- a bad moca-egress.env -- makes
  # systemctl itself fail, so it gets the same hint as a socket that never appears.
  local egress_hint="the reason is in: journalctl -u moca-egress (often a bad $SH_ENV_DIR/moca-egress.env). Fix it and re-run"
  if changed_any "$SH_BIN_DIR/moca-egress" "$SH_UNIT_DIR/moca-egress.service" "$SH_ENV_DIR/moca-egress.env"; then
    systemctl reset-failed moca-egress.service || true
    systemctl restart moca-egress.service || die "moca-egress failed to start; $egress_hint"
  elif ! systemctl is-active --quiet moca-egress.service; then
    systemctl reset-failed moca-egress.service || true
    systemctl start moca-egress.service || die "moca-egress failed to start; $egress_hint"
  fi
  wait_egress_ready
  systemctl enable microvm-worker.service
  if ((relay_restart)) || changed_any "$SH_BIN_DIR/microvm-worker" "$SH_UNIT_DIR/microvm-worker.service" \
    "$SH_UNIT_DIR/microvm-vms.slice" "$SH_UNIT_DIR/microvm-worker.service.d/$WORKER_DROPIN" \
    "$SH_UNIT_DIR/microvm-worker.service.d/$REMOTE_DROPIN" "$SH_UNIT_DIR/microvm-worker.service.d/$MEMORY_DROPIN" \
    "$SH_ENV_DIR/microvm-worker.env" "$RELAY_CA_DST"; then
    systemctl stop microvm-worker.service
    start_worker
  elif ! systemctl is-active --quiet microvm-worker.service; then
    # Nothing changed, but the worker is not running -- the usual state after a snapshot problem
    # put it in `failed` (the unit's StartLimitBurst), which a rebuilt snapshot does not undo. A
    # re-run is how an operator expects to bring it back, and a running worker is left alone.
    log "microvm-worker.service is not running; starting it"
    systemctl reset-failed microvm-worker.service || true
    start_worker
  fi
}

# wait_egress_ready: the worker's startup probe Registers over moca-egress's control socket, so a
# moca-egress that exits at boot (a bad moca-egress.env) would otherwise surface much later, as the
# worker failing to attach, with this script pointing at the wrong unit. The unit is Type=notify, so
# a successful start already means the socket is bound; this wait is the belt to that, and it is
# what names moca-egress when the start did not succeed.
wait_egress_ready() {
  local deadline=$((SECONDS + MOCA_EGRESS_READY_TIMEOUT))
  until [[ -S "$MOCA_EGRESS_SOCKET" ]]; do
    if ((SECONDS >= deadline)); then
      die "moca-egress did not bind $MOCA_EGRESS_SOCKET within ${MOCA_EGRESS_READY_TIMEOUT}s, so the worker could not register its VMs; the reason is in: journalctl -u moca-egress (often a bad $SH_ENV_DIR/moca-egress.env). Fix it and re-run"
    fi
    sleep 1
  done
}

# start_worker drops the worker's presence record BEFORE starting it, so verify_attached can only
# see a record the NEW process wrote. Records have no TTL, and a relay that died without its
# teardown leaves the previous connection's behind -- which would read as "attached" even when the
# new worker's attach is refused (a token mismatch, the silent failure that check exists for).
start_worker() {
  [[ -n "$REMOTE_BUNDLE" ]] || podman exec sh-redis redis-cli HDEL sh:sandbox:records "$MICROVM_SANDBOX_ID" >/dev/null
  systemctl start microvm-worker.service
}

# The install is not done until the relay has mirrored the worker into sh:sandbox:records -- the
# set the supervisor leases from. A unit that is "active" but never attached is the silent failure.
verify_attached() {
  local i
  for ((i = 0; i < MICROVM_ATTACH_TIMEOUT; i++)); do
    [[ "$(podman exec sh-redis redis-cli HEXISTS sh:sandbox:records "$MICROVM_SANDBOX_ID")" == 1 ]] && {
      log "$MICROVM_SANDBOX_ID is attached to the relay"; return 0; }
    sleep 1
  done
  die "$MICROVM_SANDBOX_ID did not attach within ${MICROVM_ATTACH_TIMEOUT}s; see journalctl -u microvm-worker -u sh-relay"
}

# --remote cannot read the cluster's presence records, so the worker's own log is the evidence: its
# "attached, serving execs" line, read from the CURRENT process's journal (its InvocationID). A
# timestamp would also match the previous process's line, and an unchanged re-run -- worker left
# running -- logged its line before any timestamp this run could take. Captured, not piped into
# `grep -q`: under pipefail grep's early exit would SIGPIPE journalctl and fail the match.
#
# "attached" alone is not proof: the worker logs it as soon as its stream opens, before the relay
# has read the first frame. A wrong or revoked token is refused there -- the relay ends the stream,
# the worker logs "stream ended" within milliseconds, waits its backoff and reconnects: at least
# one attached/stream-ended pair per backoff cycle. So an attach counts only once it has HELD for
# MICROVM_ATTACH_SETTLE seconds: the same invocation, the same number of attached / stream-ended
# lines as at the first sighting (no reconnect churn inside the window), and the last of them an
# attached one. The window outlasts the worker's first backoff (backoffMin 500ms, jittered to at
# most 750ms, doubling from there; remote-worker/cmd/microvm-worker/main.go), so a rejected worker
# reconnects at least once inside it; a later, longer backoff still leaves "stream ended" as the
# last line, since that line follows its "attached" by milliseconds, not by the backoff.
attach_state() { # attach_state <journal text> -> "<count of attached/ended lines> <last: attached|ended|none>"
  local line n=0 last=none
  while IFS= read -r line; do
    case "$line" in
    *"attached, serving execs"*) n=$((n + 1)) last=attached ;;
    *"stream ended"*) n=$((n + 1)) last=ended ;;
    esac
  done <<<"$1"
  printf '%s %s' "$n" "$last"
}

# The wait is bounded by the wall clock, not by a count of polls: a churning worker makes every poll
# take a settle window, so counted polls could run TIMEOUT x (1 + SETTLE) seconds. Polls start until
# MICROVM_ATTACH_TIMEOUT has passed, and a hold that starts before then may finish, so the wait ends
# within about TIMEOUT + SETTLE + 1 seconds. The first poll always runs: SECONDS ticks on whole
# seconds, so with a small TIMEOUT the deadline could otherwise pass before any look at the journal.
verify_attached_remote() {
  local inv='' now out first deadline=$((SECONDS + MICROVM_ATTACH_TIMEOUT))
  while :; do
    inv="$(systemctl show -p InvocationID --value microvm-worker.service)" || inv=''
    if [[ -n "$inv" ]]; then
      out="$(journalctl -q -o cat "_SYSTEMD_INVOCATION_ID=$inv" 2>/dev/null || true)"
      first="$(attach_state "$out")"
      if [[ "$first" == *" attached" ]]; then
        sleep "$MICROVM_ATTACH_SETTLE"
        now="$(systemctl show -p InvocationID --value microvm-worker.service)" || now=''
        out="$(journalctl -q -o cat "_SYSTEMD_INVOCATION_ID=$inv" 2>/dev/null || true)"
        if [[ "$now" == "$inv" && "$(attach_state "$out")" == "$first" ]]; then
          log "$MICROVM_SANDBOX_ID is attached to the relay at $B_ADDR"
          return 0
        fi
      fi
    fi
    ((SECONDS < deadline)) || break
    sleep 1
  done
  die "$MICROVM_SANDBOX_ID did not stay attached to $B_ADDR within ${MICROVM_ATTACH_TIMEOUT}s (a wrong or revoked token, TLS or DNS); the reason is in: journalctl -u microvm-worker _SYSTEMD_INVOCATION_ID=$inv"
}

# --- A templated P4 worker (--template / --uninstall-template) -----------------------------------
# The instance name and every path come from the template id alone, so --uninstall-template finds
# exactly what --template wrote. A dashed id becomes underscores: it is also the relay's sandbox id,
# and SH_RELAY_TOKEN_<id> must be a shell-valid name (validate_sandbox_id).
tpl_names() {
  [[ "$TPL_ID" =~ $TEMPLATE_ID_RE ]] || die "template id '$TPL_ID' must match $TEMPLATE_ID_RE"
  TPL_SID="tpl_${TPL_ID//-/_}"
  validate_sandbox_id "$TPL_SID" || exit 1
  TPL_UNIT="microvm-worker@$TPL_SID.service"
  # The instance's slice is microvm-tpl-<sid>.slice (the template unit's Slice=microvm-tpl-%i.slice),
  # which systemd nests at microvm.slice/microvm-tpl.slice/microvm-tpl-<sid>.slice (a dashed slice
  # name is a hierarchy). The sid has underscores only, so the nesting stops there and the unit's
  # SH_PARENT_CGROUP can spell it.
  TPL_ENV="$SH_ENV_DIR/microvm-worker-$TPL_SID.env"
  TPL_RELAY_ENV="$SH_ENV_DIR/microvm-relay-$TPL_SID.env"
  TPL_RELAY_DROPIN="$SH_UNIT_DIR/sh-relay.service.d/51-moca-$TPL_SID.conf"
  TPL_WORKER_DROPIN="$SH_UNIT_DIR/microvm-worker@$TPL_SID.service.d/50-moca-template.conf"
}

# The template unit: the shipped microvm-worker.service with each instance in its own slice. The
# slice is per instance (%i), not the main worker's microvm-vms.slice: a worker sweeps every VM under
# its parent cgroup at start, so a shared one would let either worker kill the other's VMs. The
# per-instance memory and egress settings come from the instance's env file, loaded after the unit's
# Environment= lines, so they override the shipped defaults.
install_template_unit() {
  local stage="$1"
  sed -e 's/^Description=.*/Description=microvm-worker %i: a templated P4 worker (moca session templates)/' \
    -e 's/^Slice=.*/Slice=microvm-tpl-%i.slice/' \
    -e 's|^Environment=SH_PARENT_CGROUP=.*|Environment=SH_PARENT_CGROUP=microvm.slice/microvm-tpl.slice/microvm-tpl-%i.slice|' \
    -e 's/^AssertMemory=.*/AssertMemory=>=4G/' \
    "$SCRIPT_DIR/microvm-worker.service" >"$stage/tpl.service"
  # The two lines that keep this worker's VMs apart from the main worker's: if the shipped unit ever
  # renames them, the sed above matches nothing and the instance would sweep the MAIN worker's slice.
  if ! grep -qx 'Slice=microvm-tpl-%i.slice' "$stage/tpl.service" ||
    ! grep -qx 'Environment=SH_PARENT_CGROUP=microvm.slice/microvm-tpl.slice/microvm-tpl-%i.slice' "$stage/tpl.service"; then
    die "could not derive the template unit from $SCRIPT_DIR/microvm-worker.service (its Slice= or SH_PARENT_CGROUP= line changed)"
  fi
  install_if_changed "$stage/tpl.service" "$SH_UNIT_DIR/$TPL_UNIT_SRC" 0644
}

template_main() {
  [[ "$(id -u)" == 0 ]] || die "must run as root (installs units under $SH_UNIT_DIR)"
  tpl_names
  if [[ -n "$TPL_UNINSTALL" ]]; then template_uninstall; return; fi
  # The main install is the prerequisite: its binary, its relay token drop-in pattern, its egress.
  [[ -f "$SH_UNIT_DIR/microvm-worker.service" && -x "$SH_BIN_DIR/microvm-worker" ]] ||
    die 'install the main P4 worker first: sudo deploy/microvm/setup-microvm.sh'
  [[ -f "$SH_ENV_DIR/relay.env" && -f "$SH_UNIT_DIR/sh-relay.service" ]] ||
    die "no local P6 relay ($SH_ENV_DIR/relay.env, sh-relay.service): a templated worker attaches to this host's relay"
  [[ -n "$TPL_SNAPSHOT" ]] || die '--template needs --snapshot DIR (a snapshot directory with manifest.json)'
  [[ -f "$TPL_SNAPSHOT/manifest.json" ]] || die "no snapshot at $TPL_SNAPSHOT (no manifest.json)"
  local snap_dir snap_name guest
  snap_dir="$(cd "$(dirname "$TPL_SNAPSHOT")" && pwd)" snap_name="$(basename "$TPL_SNAPSHOT")"
  # A new snapshot is a new template worker (the versioned-update rule: old sandboxes drain on the
  # old one), never this worker re-pointed under its live sessions.
  local was
  was="$(env_value SH_SNAPSHOT_IMAGE "$TPL_ENV" 2>/dev/null || true)"
  [[ -z "$was" || "$was" == "$snap_name" ]] ||
    die "template $TPL_ID's worker serves snapshot $was; a new snapshot is a new template worker (another id), or --uninstall-template $TPL_ID first"
  # Unset flags keep what the install stored, so a re-run (to restart a failed worker, say) never
  # changes its budget or egress behind the operator's back.
  if [[ -z "$TPL_BUDGET_MB" ]]; then TPL_BUDGET_MB="$(env_value SH_MAX_COMMITTED_MB "$TPL_ENV" 2>/dev/null || true)"; fi
  if [[ -z "$TPL_EGRESS" && -n "$(env_value MOCA_EGRESS_CONTROL_SOCK "$TPL_ENV" 2>/dev/null || true)" ]]; then TPL_EGRESS=1; fi
  # moca-egress keys its listeners by VM id, and every worker names its VMs vm-1, vm-2, ...: two
  # egress-on workers on one moca-egress would close each other's guests' listeners. Until moca-egress
  # scopes ids per worker, a templated worker gets egress only while no other worker uses it.
  if [[ -n "$TPL_EGRESS" ]]; then
    local other
    for other in "$SH_ENV_DIR/microvm-worker.env" "$SH_ENV_DIR"/microvm-worker-tpl_*.env; do
      [[ -f "$other" && "$other" != "$TPL_ENV" ]] || continue
      if [[ "$other" == "$SH_ENV_DIR/microvm-worker.env" ]]; then
        # The main worker gets egress from the unit's Environment= (MOCA_EGRESS_CONTROL_SOCK), unless
        # its env file blanks it.
        grep -qx 'MOCA_EGRESS_CONTROL_SOCK=' "$other" && continue
      else
        [[ -n "$(env_value MOCA_EGRESS_CONTROL_SOCK "$other" 2>/dev/null || true)" ]] || continue
      fi
      die "--egress: $(basename "$other") already uses moca-egress, which keys VMs by id (vm-1, ...) across workers, so two egress-on workers would cut each other's guests off; leave this template offline"
    done
  fi
  # Workspaces and the jail must share the snapshot's filesystem (Restore hardlinks the snapshot and
  # workspace files into each VM's jail), and the jail path must stay short: the VM's API socket,
  # <jail>/firecracker/vm-<20 digits>/root/run/firecracker.socket, is the longest path under it (the
  # egress socket's .../run/v.sock_1025 is shorter) and must fit a Unix socket path (at most 107
  # bytes). So the roots are <snapshot dir>/.tpl/t<12 hex of the sid's sha256>: a short key whatever
  # the template id (<snapshot dir>/.tpl/<sid> overflowed it for a 19-character id).
  local key; key="t$(printf '%s' "$TPL_SID" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-12)"
  local root="${TPL_SRV_ROOT:-$snap_dir/.tpl}/$key"
  local longest="$root/jail/firecracker/vm-99999999999999999999/root/run/firecracker.socket"
  ((${#longest} < 108)) ||
    die "the jail path $root/jail is too long for the VMs' API socket (${#longest} bytes, at most 107): set MICROVM_TPL_SRV to a shorter directory on the snapshot's filesystem"
  install -d -m 0700 "$root/workspaces" "$root/jail"
  local dev_snap dev_root
  dev_snap="$(stat -c %d "$TPL_SNAPSHOT" 2>/dev/null || stat -f %d "$TPL_SNAPSHOT")"
  dev_root="$(stat -c %d "$root" 2>/dev/null || stat -f %d "$root")"
  [[ "$dev_snap" == "$dev_root" ]] ||
    die "$root is on another filesystem than the snapshot $TPL_SNAPSHOT: the worker hardlinks between them"
  guest="$(sed -n 's/.*"guest_ram_mb"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$TPL_SNAPSHOT/manifest.json" | head -1)"
  [[ "$guest" =~ ^[1-9][0-9]*$ ]] || die "snapshot $TPL_SNAPSHOT has no guest_ram_mb in its manifest.json"
  # One session: the VM plus the unit's two standbys, each guest + 32 MiB, over a 1024 MiB reserve
  # (install-host.sh's rule for SBX0's workers).
  local need=$(((guest + 32) * 3 + 1024))
  TPL_BUDGET_MB="${TPL_BUDGET_MB:-$need}"
  if ! [[ "$TPL_BUDGET_MB" =~ ^[1-9][0-9]*$ ]] || ((TPL_BUDGET_MB < need)); then
    die "--budget-mb $TPL_BUDGET_MB cannot hold one session of a ${guest} MiB guest: at least $need MiB"
  fi
  local port token stage
  port="$(relay_port "$SH_ENV_DIR/relay.env")"
  token="$(env_value "SH_RELAY_TOKEN_$TPL_SID" "$TPL_RELAY_ENV" 2>/dev/null || true)"
  if [[ -z "$token" ]]; then
    token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
    [[ ${#token} == 64 ]] || die "could not generate a relay token"
  fi
  stage="$(mktemp -d)"
  install_template_unit "$stage"
  printf '[Unit]\nDescription=Parent slice of the templated P4 workers (moca session templates)\n\n[Slice]\nMemorySwapMax=0\n' \
    >"$stage/tpl.slice"
  install_if_changed "$stage/tpl.slice" "$SH_UNIT_DIR/microvm-tpl.slice" 0644
  (umask 077
    printf 'SH_RELAY_TOKEN_%s=%s\n' "$TPL_SID" "$token" >"$stage/relay.env"
    {
      printf 'RELAY_ADDR=127.0.0.1:%s\nSANDBOX_ID=%s\nSANDBOX_TOKEN=%s\n' "$port" "$TPL_SID" "$token"
      printf 'SANDBOX_TEMPLATE=%s\nSH_SNAPSHOT_DIR=%s\nSH_SNAPSHOT_IMAGE=%s\nSH_GUEST_RAM_MB=%s\n' \
        "$TPL_ID" "$snap_dir" "$snap_name" "$guest"
      printf 'SH_MAX_COMMITTED_MB=%s\nSH_MEMORY_RESERVE_MB=1024\nSH_WORKSPACE_IDLE=%s\n' "$TPL_BUDGET_MB" "$MICROVM_WORKSPACE_IDLE"
      printf 'SH_WORKSPACE_ROOT=%s/workspaces\nSH_CHROOT_BASE=%s/jail\n' "$root" "$root"
      if [[ -n "$TPL_EGRESS" ]]; then printf 'MOCA_EGRESS_CONTROL_SOCK=%s\n' "$MOCA_EGRESS_SOCKET"; else printf 'MOCA_EGRESS_CONTROL_SOCK=\n'; fi
    } >"$stage/worker.env")
  unset token
  install_if_changed "$stage/relay.env" "$TPL_RELAY_ENV" 0600
  install_if_changed "$stage/worker.env" "$TPL_ENV" 0600
  printf '# Written by deploy/microvm/setup-microvm.sh --template %s: its relay token.\n[Service]\nEnvironmentFile=%s\n' \
    "$TPL_ID" "$TPL_RELAY_ENV" >"$stage/relay.conf"
  install_if_changed "$stage/relay.conf" "$TPL_RELAY_DROPIN" 0644
  printf '# Written by deploy/microvm/setup-microvm.sh --template %s.\n[Unit]\nAfter=sh-relay.service\nWants=sh-relay.service\n\n[Service]\nEnvironmentFile=%s\n' \
    "$TPL_ID" "$TPL_ENV" >"$stage/worker.conf"
  install_if_changed "$stage/worker.conf" "$TPL_WORKER_DROPIN" 0644
  rm -rf "$stage"
  ((${#CHANGED[@]} == 0)) || systemctl daemon-reload
  if changed_any "$TPL_RELAY_DROPIN" "$TPL_RELAY_ENV"; then
    log "restarting sh-relay.service to load template $TPL_ID's worker token (in-flight turns fail and retry)"
    systemctl restart sh-relay.service
  fi
  systemctl enable "$TPL_UNIT"
  if ((${#CHANGED[@]})) || ! systemctl is-active --quiet "$TPL_UNIT"; then
    systemctl stop "$TPL_UNIT" 2>/dev/null || true
    systemctl reset-failed "$TPL_UNIT" 2>/dev/null || true
    podman exec sh-redis redis-cli HDEL sh:sandbox:records "$TPL_SID" >/dev/null
    systemctl start "$TPL_UNIT"
  fi
  MICROVM_SANDBOX_ID="$TPL_SID" verify_attached
  log "template $TPL_ID: worker $TPL_SID on snapshot $snap_name (guest ${guest} MiB, budget ${TPL_BUDGET_MB} MiB, egress $([[ -n "$TPL_EGRESS" ]] && echo on || echo off))"
  log "declare it to the control plane in SH_SANDBOX_TEMPLATES, then sessions name it: mocactl run --option sandboxTemplate=$TPL_ID"
  if ((${#CHANGED[@]})); then log "changed: ${CHANGED[*]}"; else log "nothing to change"; fi
}

# Removes exactly what --template wrote for this id. The shared template unit and parent slice go only
# with the last templated worker; workspace data is kept (as setup-microvm.sh never deletes data).
template_uninstall() {
  local root
  root="$(env_value SH_WORKSPACE_ROOT "$TPL_ENV" 2>/dev/null || true)"
  systemctl disable --now "$TPL_UNIT" 2>/dev/null || true
  # The VMs' cgroups are siblings of the unit under its slice, out of KillMode's reach: stopping the
  # slice ends any VM still alive, or it would hold its memory with no worker left to sweep it.
  systemctl stop "microvm-tpl-$TPL_SID.slice" 2>/dev/null || true
  remove_if_present "$TPL_WORKER_DROPIN"
  rmdir "$(dirname "$TPL_WORKER_DROPIN")" 2>/dev/null || true
  remove_if_present "$TPL_RELAY_DROPIN"
  remove_if_present "$TPL_ENV"
  remove_if_present "$TPL_RELAY_ENV"
  if ! compgen -G "$SH_ENV_DIR/microvm-worker-tpl_*.env" >/dev/null; then
    remove_if_present "$SH_UNIT_DIR/$TPL_UNIT_SRC"
    remove_if_present "$SH_UNIT_DIR/microvm-tpl.slice"
  fi
  if ((${#CHANGED[@]})); then
    systemctl daemon-reload
    changed_any "$TPL_RELAY_DROPIN" && systemctl restart sh-relay.service
    podman exec sh-redis redis-cli HDEL sh:sandbox:records "$TPL_SID" >/dev/null || true
    log "removed template $TPL_ID's worker $TPL_SID (workspace data kept${root:+ under ${root%/workspaces}})"
    log "changed: ${CHANGED[*]}"
  else
    log "nothing to change: no templated worker for $TPL_ID"
  fi
}

main() {
  parse_args "$@"
  if [[ -n "$TPL_ID" ]]; then
    [[ -z "$REMOTE_BUNDLE" ]] || die '--template and --uninstall-template are for a local P6, not --remote'
    [[ -z "$TPL_UNINSTALL" || -z "$TPL_SNAPSHOT$TPL_BUDGET_MB$TPL_EGRESS" ]] ||
      die '--uninstall-template ID takes no --snapshot, --budget-mb or --egress'
    template_main
    return
  fi
  [[ -z "$TPL_SNAPSHOT$TPL_BUDGET_MB$TPL_EGRESS" ]] || die '--snapshot, --budget-mb and --egress go with --template ID'
  preflight
  install_worker_binary
  install_egress_binary
  install_egress_env
  install_units
  if [[ -n "$REMOTE_BUNDLE" ]]; then install_env_remote; else install_env; fi
  # --remote: MIXED is 0 (preflight), so this removes what an earlier mixed local run wrote.
  install_tiers
  apply
  if [[ -n "$REMOTE_BUNDLE" ]]; then verify_attached_remote; else verify_attached; fi
  if ((${#CHANGED[@]})); then log "changed: ${CHANGED[*]}"; else log "nothing to change"; fi
}

if [[ "${SH_SOURCE_ONLY:-}" != 1 ]]; then main "$@"; fi
