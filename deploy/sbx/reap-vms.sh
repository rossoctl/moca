#!/usr/bin/env bash
# deploy/sbx/reap-vms.sh -- the ExecStopPost= of sbx-worker@.service (#795): end every VM a template
# worker left in its own slice. Installed by deploy/sbx/install-host.sh as
# $SBX_LIBEXEC_DIR/sbx-reap-vms.sh and run by systemd as `sbx-reap-vms.sh %i` after the worker exits,
# whatever the exit: a clean stop, a crash, a stop timeout.
#
#   sbx-reap-vms.sh WORKER_ID
#
# Why: jailer places each Firecracker VM in a pool cgroup (pool-N) under the worker's slice, a
# sibling of the service's own cgroup, so KillMode=control-group does not reach it. A VM left there
# holds its guest memory, outside every budget, until that worker's next start sweeps it
# (vmpool.SweepOrphans), which may be never.
#
# What it touches: only the immediate children of the worker's own slice,
# $SBX_CGROUP_ROOT/sbx.slice/sbx-<id>.slice, that are named pool-<digits> (the names
# remote-worker/internal/vmpool/cgroup.go's isPooledCgroupDirName accepts). Never the service's own
# cgroup (sbx-worker@<id>.service, which this script runs in), never another worker's slice, never
# any other directory. For each one it writes 1 to cgroup.kill (cgroup v2, Linux 5.14+), or, on a
# kernel without it, SIGKILLs the pids listed in cgroup.procs, then waits up to SBX_REAP_TIMEOUT
# seconds (default 10) for every one to report `populated 0` in cgroup.events (or, without that
# file, an empty cgroup.procs). The directories stay: the worker re-creates or reuses them.
#
# It never fails the stop: every problem is logged (stderr, so the unit's journal) and it exits 0.
#
# SBX_CGROUP_ROOT (default /sys/fs/cgroup, the cgroup v2 mount) is a test seam.
set -u

ROOT="${SBX_CGROUP_ROOT:-/sys/fs/cgroup}"
TIMEOUT="${SBX_REAP_TIMEOUT:-10}"

log() { printf 'sbx-reap-vms: %s\n' "$*" >&2; }

id="${1:-}"
# install-host.sh's valid_id: a worker id has no dash, so systemd's slice sbx-<id>.slice nests
# exactly one level under sbx.slice -- the SH_PARENT_CGROUP install-host.sh writes for it.
if [[ ! "$id" =~ ^[A-Za-z_][A-Za-z0-9_]*$ || "$id" == DIR ]]; then
  log "not a worker id: '$id'; nothing reaped"
  exit 0
fi
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || { log "SBX_REAP_TIMEOUT='$TIMEOUT' is not whole seconds; using 10"; TIMEOUT=10; }
slice="$ROOT/sbx.slice/sbx-$id.slice"
# The worker's own env (EnvironmentFile=) names the slice its VMs are in; a different one is logged,
# and only the slice derived from the instance name is touched.
if [[ -n "${SH_PARENT_CGROUP:-}" && "$SH_PARENT_CGROUP" != "sbx.slice/sbx-$id.slice" ]]; then
  log "SH_PARENT_CGROUP=$SH_PARENT_CGROUP is not sbx.slice/sbx-$id.slice; only the latter is reaped"
fi
[[ -d "$slice" ]] || exit 0 # no slice (never started, or already stopped): nothing to reap

is_pool_dir() { [[ "$1" =~ ^pool-[0-9]+$ ]]; }

# populated DIR: the cgroup still holds a process.
populated() {
  local line
  if [[ -f "$1/cgroup.events" ]]; then
    while IFS= read -r line; do
      [[ "$line" == 'populated 0' ]] && return 1
      [[ "$line" == 'populated 1' ]] && return 0
    done <"$1/cgroup.events"
  fi
  [[ -s "$1/cgroup.procs" ]] || return 1
  grep -q '[0-9]' "$1/cgroup.procs"
}

# kill_pids DIR: SIGKILL every pid in cgroup.procs (the fallback without cgroup.kill). A pid that has
# already gone is not an error; a pid <= 1 is never signalled.
kill_pids() {
  local pid
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] && ((pid > 1)) || continue
    kill -KILL "$pid" 2>/dev/null || true
  done <"$1/cgroup.procs"
}

dirs=()
for d in "$slice"/*/; do
  [[ -d "$d" ]] || continue
  d="${d%/}"
  is_pool_dir "${d##*/}" || continue
  populated "$d" || continue
  dirs+=("$d")
  if [[ -f "$d/cgroup.kill" ]]; then
    { echo 1 >"$d/cgroup.kill"; } 2>/dev/null || { log "${d##*/}: writing cgroup.kill failed; sending SIGKILL"; kill_pids "$d"; }
  else
    kill_pids "$d"
  fi
  log "${d##*/}: killed (worker $id; the unit's result: ${SERVICE_RESULT:-unknown})"
done
n=${#dirs[@]}
((n)) || exit 0

# Wait for every killed cgroup to empty, polling every 0.1 s, bounded by TIMEOUT. The fallback
# re-signals on each poll, for a process that forked between the read and the kill.
polls=$((TIMEOUT * 10))
while :; do
  left=()
  for d in "${dirs[@]}"; do
    if populated "$d"; then
      left+=("$d")
      [[ -f "$d/cgroup.kill" ]] || kill_pids "$d"
    fi
  done
  ((${#left[@]})) || { log "$n VM cgroup(s) of worker $id emptied"; exit 0; }
  ((polls > 0)) || break
  polls=$((polls - 1))
  dirs=("${left[@]}")
  sleep 0.1
done
for d in "${left[@]}"; do log "${d##*/}: still populated after ${TIMEOUT}s; see $d/cgroup.procs"; done
exit 0
