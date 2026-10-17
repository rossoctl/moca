#!/usr/bin/env bash
# deploy/sbx/install-host.sh -- install, update or remove one SBX0 template worker on a KVM host
# (docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md §8.2).
#
#   sudo deploy/sbx/install-host.sh BUNDLE_DIR --snapshot IMAGE [--budget-mb N]
#   sudo deploy/sbx/install-host.sh --uninstall WORKER_ID
#
# BUNDLE_DIR is deploy/sbx/.generated/workers/<id> from deploy/sbx/setup.sh. IMAGE names a golden
# snapshot under $SBX_SRV/snapshots (deploy/microvm/build-snapshot.sh --out $SBX_SRV/snapshots/IMAGE).
# Needs microvm-worker, firecracker and jailer in /usr/local/bin (deploy/microvm/P4-ON-P6.md).
#
# Touches ONLY its own files: the template unit, sbx.slice, sbx-<id>.slice, $SBX_ENV_DIR, and the
# worker's directories under $SBX_SRV. Never another install on the same host. Every file it writes
# is listed in $SBX_ENV_DIR/manifest, and --uninstall is the undo (spec §8.2): it removes the
# worker's files and, once no worker is left in the manifest, the shared template unit and
# sbx.slice too. It leaves workspace data in place (the janitor, or the operator, removes that).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${SBX_UNIT_DIR:=/etc/systemd/system}"
: "${SBX_ENV_DIR:=/etc/sbx}"
: "${SBX_SRV:=/srv/sbx}"
: "${SBX_ATTACH_TIMEOUT:=120}"
: "${SBX_ATTACH_SETTLE:=5}"
# A bundle from deploy/sbx/setup.sh carries SH_WORKSPACE_IDLE (the sandbox lifetime plus two days,
# spec §5.4) and SH_WORKSPACE_IMAGE_MB. A bundle without the idle predates that rule and is refused;
# the image size defaults to microvm-worker's own.
DEFAULT_IMAGE_MB=2048
DEFAULT_BUDGET_MB=8192

log() { printf '==> %s\n' "$*"; }
die() { echo "deploy/sbx/install-host.sh: $*" >&2; exit 1; }

env_value() { (grep -E "^$1=" "$2" 2>/dev/null || true) | tail -1 | cut -d= -f2-; }

BUNDLE='' SNAPSHOT='' BUDGET_MB="$DEFAULT_BUDGET_MB" UNINSTALL=''
parse_args() {
  while (($#)); do
    case "$1" in
    --snapshot) [[ $# -ge 2 ]] || die '--snapshot needs a value'; SNAPSHOT="$2"; shift 2 ;;
    --budget-mb) [[ $# -ge 2 ]] || die '--budget-mb needs a value'; BUDGET_MB="$2"; shift 2 ;;
    --uninstall) [[ $# -ge 2 ]] || die '--uninstall needs a worker id'; UNINSTALL="$2"; shift 2 ;;
    -*) die "unknown flag: $1" ;;
    *) [[ -z "$BUNDLE" ]] || die 'one bundle directory at a time'; BUNDLE="$1"; shift ;;
    esac
  done
}

valid_id() { [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "$1" != DIR ]]; }

record() { mkdir -p "$SBX_ENV_DIR"; touch "$SBX_ENV_DIR/manifest"; grep -qxF "$1" "$SBX_ENV_DIR/manifest" || echo "$1" >>"$SBX_ENV_DIR/manifest"; }

install_units() {
  install -d -m 0755 "$SBX_UNIT_DIR"
  install -m 0644 "$SCRIPT_DIR/sbx.slice" "$SBX_UNIT_DIR/sbx.slice"
  sed "s#^EnvironmentFile=/etc/sbx/#EnvironmentFile=$SBX_ENV_DIR/#" "$SCRIPT_DIR/sbx-worker@.service" \
    >"$SBX_UNIT_DIR/sbx-worker@.service"
  chmod 0644 "$SBX_UNIT_DIR/sbx-worker@.service"
  record "unit $SBX_UNIT_DIR/sbx.slice"
  record "unit $SBX_UNIT_DIR/sbx-worker@.service"
}

install_worker() {
  local env="$BUNDLE/worker.env" id addr tok idle image_mb ca=''
  [[ -f "$env" ]] || die "no $env: pass the bundle directory deploy/sbx/setup.sh wrote (workers/<id>)"
  id="$(env_value SANDBOX_ID "$env")"
  valid_id "$id" || die "SANDBOX_ID in $env is not a valid worker id"
  addr="$(env_value RELAY_ADDR "$env")"
  [[ "$addr" =~ ^[A-Za-z0-9.-]+:[0-9]+$ ]] || die "RELAY_ADDR in $env must be host:port"
  [[ "$(env_value RELAY_TLS "$env")" == true ]] || die "RELAY_TLS in $env must be true"
  tok="$(env_value SANDBOX_TOKEN "$env")"
  [[ "$tok" =~ ^[0-9a-f]{64}$ ]] || die "SANDBOX_TOKEN in $env is not 64 hex characters: copy the bundle again"
  idle="$(env_value SH_WORKSPACE_IDLE "$env")"
  [[ -n "$idle" ]] ||
    die "$env has no SH_WORKSPACE_IDLE (a bundle from before increment 1b): re-run deploy/sbx/setup.sh and copy the new bundle"
  [[ "$idle" =~ ^[1-9][0-9]*h$ ]] || die "SH_WORKSPACE_IDLE in $env must be whole hours, e.g. 216h"
  image_mb="$(env_value SH_WORKSPACE_IMAGE_MB "$env")"
  image_mb="${image_mb:-$DEFAULT_IMAGE_MB}"
  [[ "$image_mb" =~ ^[1-9][0-9]*$ ]] || die "SH_WORKSPACE_IMAGE_MB in $env must be a whole number of MiB"
  [[ -n "$SNAPSHOT" ]] || die '--snapshot IMAGE is required'
  [[ "$SNAPSHOT" =~ ^[A-Za-z0-9._-]+$ ]] || die '--snapshot must be a directory name'
  [[ -d "$SBX_SRV/snapshots/$SNAPSHOT" ]] || die "no snapshot $SBX_SRV/snapshots/$SNAPSHOT (build it with deploy/microvm/build-snapshot.sh)"
  [[ "$BUDGET_MB" =~ ^[1-9][0-9]*$ ]] && ((BUDGET_MB > 1024)) || die '--budget-mb must be a whole number of MiB above 1024 (the unit reserve)'

  install -d -m 0700 "$SBX_ENV_DIR" "$SBX_ENV_DIR/workers"
  if [[ -f "$BUNDLE/relay-ca.crt" ]]; then
    grep -q -- '-----BEGIN CERTIFICATE-----' "$BUNDLE/relay-ca.crt" || die "$BUNDLE/relay-ca.crt holds no PEM certificate"
    install -m 0644 "$BUNDLE/relay-ca.crt" "$SBX_ENV_DIR/workers/$id-relay-ca.crt"
    ca="$SBX_ENV_DIR/workers/$id-relay-ca.crt"
    record "file $ca"
  fi
  install -d -m 0700 "$SBX_SRV/workspaces/$id" "$SBX_SRV/jail/$id"
  (
    umask 077
    {
      printf 'RELAY_ADDR=%s\nRELAY_TLS=true\nSANDBOX_ID=%s\nSANDBOX_TOKEN=%s\n' "$addr" "$id" "$tok"
      [[ -z "$ca" ]] || printf 'RELAY_CA_FILE=%s\n' "$ca"
      printf 'SH_SNAPSHOT_DIR=%s\nSH_SNAPSHOT_IMAGE=%s\n' "$SBX_SRV/snapshots" "$SNAPSHOT"
      printf 'SH_WORKSPACE_ROOT=%s\nSH_CHROOT_BASE=%s\n' "$SBX_SRV/workspaces/$id" "$SBX_SRV/jail/$id"
      printf 'SH_PARENT_CGROUP=sbx.slice/sbx-%s.slice\n' "$id"
      printf 'SH_MAX_COMMITTED_MB=%s\nSH_WORKSPACE_IDLE=%s\nSH_WORKSPACE_IMAGE_MB=%s\n' "$BUDGET_MB" "$idle" "$image_mb"
    } >"$SBX_ENV_DIR/workers/$id.env"
  )
  chmod 0600 "$SBX_ENV_DIR/workers/$id.env"
  printf '[Unit]\nDescription=SBX0 sandbox worker %s (slice)\n\n[Slice]\nMemorySwapMax=0\n' "$id" \
    >"$SBX_UNIT_DIR/sbx-$id.slice"
  record "worker sbx-worker@$id $SBX_ENV_DIR/workers/$id.env $SBX_UNIT_DIR/sbx-$id.slice"
  systemctl daemon-reload
  # enable, then exactly one restart: a first install starts the unit, a re-install picks up the new
  # env file once (enable --now followed by restart would start a fresh unit twice).
  systemctl enable "sbx-worker@$id.service"
  # A worker that crash-looped into `failed` (StartLimitBurst, e.g. a missing snapshot) refuses a
  # restart with "start request repeated too quickly" until reset; a re-run after the fix is how an
  # operator brings it back (as deploy/microvm/setup-microvm.sh does).
  systemctl reset-failed "sbx-worker@$id.service" || true
  systemctl restart "sbx-worker@$id.service"
  wait_attached "$id"
}

invocation() { # invocation WORKER_ID -> the unit's current InvocationID, or nothing
  systemctl show -p InvocationID --value "sbx-worker@$1.service" 2>/dev/null | sed 's/^InvocationID=//' || true
}

# attach_state <journal text> -> "<count of attached/ended lines> <last: attached|ended|none>"
attach_state() {
  local line n=0 last=none
  while IFS= read -r line; do
    case "$line" in
    *"attached, serving execs"*) n=$((n + 1)) last=attached ;;
    *"stream ended"*) n=$((n + 1)) last=ended ;;
    esac
  done <<<"$1"
  printf '%s %s' "$n" "$last"
}

# The rule of deploy/microvm/setup-microvm.sh --remote (attach_state, verify_attached_remote). The
# worker logs `attached, serving execs` as soon as its stream opens, before the relay reads the
# token; a refused token ends the stream milliseconds later (`stream ended (...); reconnecting`) and
# the worker retries after a backoff. Refusals are normal for a while after a template is added: the
# relay sees the new token file only once the kubelet syncs the Secret, about a minute. So an earlier
# refusal does not fail the wait; an attach counts once it HOLDS: in the current invocation the last
# attached/ended line is an attached one, and the count and the last line are unchanged across
# SBX_ATTACH_SETTLE seconds (at least 1, to outlast the worker's first backoff of at most 750ms).
# The journal is captured once per look, never piped into `grep -q`: under pipefail grep's early
# exit can SIGPIPE journalctl, and a negated check would then read as success. Bounded by the wall
# clock: polls start until SBX_ATTACH_TIMEOUT has passed, and the first one always runs.
wait_attached() {
  local id="$1" inv='' now out first deadline=$((SECONDS + SBX_ATTACH_TIMEOUT))
  while :; do
    inv="$(invocation "$id")"
    if [[ -n "$inv" ]]; then
      out="$(journalctl -q --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$inv" 2>/dev/null || true)"
      first="$(attach_state "$out")"
      if [[ "$first" == *" attached" ]]; then
        sleep "$SBX_ATTACH_SETTLE"
        now="$(invocation "$id")"
        out="$(journalctl -q --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$inv" 2>/dev/null || true)"
        if [[ "$now" == "$inv" && "$(attach_state "$out")" == "$first" ]]; then
          log "sbx-worker@$id attached to the relay"
          return 0
        fi
      fi
    fi
    ((SECONDS < deadline)) || break
    sleep 1
  done
  die "sbx-worker@$id did not stay attached within ${SBX_ATTACH_TIMEOUT}s (a wrong or revoked token, TLS or DNS; a newly added worker's token can take about a minute to reach the relay, so re-run or raise SBX_ATTACH_TIMEOUT). The reason is in: journalctl -u sbx-worker@$id _SYSTEMD_INVOCATION_ID=$inv"
}

drop_manifest_lines() { # drop_manifest_lines -e FIXED... : remove every manifest line containing one
  { grep -v -F "$@" "$SBX_ENV_DIR/manifest" || true; } >"$SBX_ENV_DIR/manifest.new"
  mv "$SBX_ENV_DIR/manifest.new" "$SBX_ENV_DIR/manifest"
}

# Once the manifest names no worker, the units it lists as shared (`unit <path>`: the template unit
# and sbx.slice) have nothing left to serve: remove them and their lines. Only what the manifest
# lists, so a host whose manifest is gone keeps whatever is there.
remove_shared_units() {
  local kind path
  [[ -f "$SBX_ENV_DIR/manifest" ]] || return 0
  ! grep -q '^worker ' "$SBX_ENV_DIR/manifest" || return 0
  while read -r kind path; do
    [[ "$kind" == unit && -n "$path" ]] || continue
    rm -f "$path"
    drop_manifest_lines -x -e "unit $path"
    log "removed $path (no SBX0 worker left on this host)"
  done < <(grep '^unit ' "$SBX_ENV_DIR/manifest" || true)
}

uninstall_worker() {
  local id="$1"
  valid_id "$id" || die "not a worker id: $id"
  systemctl disable --now "sbx-worker@$id.service" || true
  # A stop that hit TimeoutStopSec can leave the worker's VMs in its slice; stopping the slice ends them.
  systemctl stop "sbx-$id.slice" || true
  rm -f "$SBX_ENV_DIR/workers/$id.env" "$SBX_ENV_DIR/workers/$id-relay-ca.crt" "$SBX_UNIT_DIR/sbx-$id.slice"
  # Fixed strings, so worker `a` never takes `ba`'s lines: `@a ` and `/a-relay-ca.crt` are not
  # substrings of `@ba ` and `/ba-relay-ca.crt`.
  [[ ! -f "$SBX_ENV_DIR/manifest" ]] || drop_manifest_lines -e "worker sbx-worker@$id " -e "/$id-relay-ca.crt"
  log "removed sbx-worker@$id"
  remove_shared_units
  systemctl daemon-reload
  log "left in place: $SBX_SRV/workspaces/$id and $SBX_SRV/jail/$id (workspace data; remove by hand when no sandbox needs it)"
}

main() {
  parse_args "$@"
  [[ -n "${SBX_SKIP_ROOT_CHECK:-}" || "$(id -u)" == 0 ]] || die 'must run as root'
  if [[ -n "$UNINSTALL" ]]; then uninstall_worker "$UNINSTALL"; return; fi
  [[ "$SBX_ATTACH_TIMEOUT" =~ ^[1-9][0-9]*$ ]] ||
    die "SBX_ATTACH_TIMEOUT='$SBX_ATTACH_TIMEOUT' must be a whole number of seconds, at least 1"
  # At least 1: the hold must outlast the worker's first reconnect backoff (at most 750ms), or a
  # refused token's attached -> stream ended -> attached cycle could fall outside the window.
  [[ "$SBX_ATTACH_SETTLE" =~ ^[1-9][0-9]*$ ]] ||
    die "SBX_ATTACH_SETTLE='$SBX_ATTACH_SETTLE' must be a whole number of seconds, at least 1, to outlast the worker's first reconnect backoff (at most 750ms)"
  [[ -n "$BUNDLE" ]] || die 'usage: install-host.sh BUNDLE_DIR --snapshot IMAGE [--budget-mb N] | --uninstall ID'
  install_units
  install_worker
}

main "$@"
