#!/usr/bin/env bash
# deploy/sbx/sampler.sh -- one sample of how loaded this SBX0 KVM host is, as one JSON line on stdout
# (#857, R2). Run every 15 s by sbx-sampler.timer, so the journal holds the host's load over time;
# installed with every worker by deploy/sbx/install-host.sh as $SBX_LIBEXEC_DIR/sbx-sampler.sh.
# `status.sh --host` runs it once for a view of now.
#
# Environment (the unit sets the first two):
#   SBX_ENV_DIR      default /etc/sbx: this host's workers are $SBX_ENV_DIR/workers/<id>.env
#   SBX_SRV          default /srv/sbx: the workspace filesystem is $SBX_SRV/workspaces
#   SBX_SYS_ROOT     default /: where /proc and /sys/fs/cgroup (the cgroup v2 mount) are read
#                    from, host-agent.sh's test seam
#   SBX_SAMPLER_STATE_DIR  default $RUNTIME_DIRECTORY (the unit's /run/sbx-sampler): where it
#                    remembers which failures it has already reported; unset, it reports all
#
# It reads files only: /proc/loadavg, /proc/meminfo, /proc/pressure/{cpu,memory,io}, the cgroup
# files of sbx.slice and of each worker's sbx-<id>.slice, the worker env files and each running
# worker's /proc/<pid>/environ. The only programs it starts are df (twice: bytes and inodes, each
# under `timeout 5`) and, for a worker that runs with SH_DIAG_STATS_ADDR, one curl of that
# worker's /stats on this host (1 s at most; a wildcard address is read on loopback, and an address that
# is neither loopback nor a wildcard is refused, never curled). Nothing needs jq, so a worker host needs no more than
# it did. Every value printed is matched as a number first and is null when it cannot be read.
#
# Output, in this order:
#   {"sampler":"error","ts","kind","why"}   once per failure kind, when that kind starts failing
#   {"sampler":"recovered","ts","kind"}     when a kind reported before reads again
#   {"sampler":"sample","ts","load","mem_kb","psi","workspaces","slice","workers","errors"}
# The sample line comes every run, and its `errors` names every kind failing in it, so a failure
# that lasts is one error line, not one every 15 s; without a state directory (status.sh) every
# kind's error line is printed each run. The kinds: loadavg, meminfo, psi, workspaces, slice,
# workers, curl, and worker:<id> (an env file it cannot read) and stats:<id> (/stats unreachable or
# not the expected shape).
#
# The fields (cumulative counters are since boot or since the cgroup was made: a reader takes the
# difference between two samples):
#   load        {avg1, avg5, avg15}                                    /proc/loadavg
#   mem_kb      {total, available, swap_total, swap_free, swap_used}   /proc/meminfo, kB
#   psi         {cpu|memory|io: {some_avg10, some_avg60, full_avg10, full_avg60}}, percent
#   workspaces  {bytes_total, bytes_used, bytes_avail, inodes_total, inodes_used, inodes_free}
#   slice       sbx.slice: {cpu_usage_usec, cpu_nr_throttled, cpu_throttled_usec,
#               memory_current, memory_peak (null before Linux 5.19), io_rbytes, io_wbytes,
#               io_rios, io_wios} (io.stat summed over devices)
#   workers     [{wrk, vms, memory_current, budget_mb, reserve_mb, stats}], one per installed
#               worker: vms counts its slice's VM cgroups that hold a process (pool-<n>, and the
#               vm-<n> and vm-vm-<n>.scope names vmpool also makes), running and paused standby
#               VMs alike; memory_current is its slice's; budget_mb and reserve_mb are
#               SH_MAX_COMMITTED_MB and SH_MEMORY_RESERVE_MB (1024, the unit's, when none is set),
#               from the running worker's /proc/<pid>/environ, else its env file. The worker admits
#               a VM while committedBytes stays within budget_mb minus reserve_mb. stats is
#               {committedBytes, standbyCommittedBytes, refusals} from the worker's /stats, named as
#               the worker names them, or null without SH_DIAG_STATS_ADDR (read the same way: a
#               drop-in sets it).
#
# It always exits 0: a sample with a missing field is still a sample, and a failed unit every 15 s
# would flood the journal with systemd's own lines.
set -uo pipefail
shopt -s nullglob
export LC_ALL=C TZ=UTC

SYS_ROOT="${SBX_SYS_ROOT:-/}"
SYS_ROOT="${SYS_ROOT%/}"
PROC="$SYS_ROOT/proc"
CG="$SYS_ROOT/sys/fs/cgroup"
SBX_SRV="${SBX_SRV:-/srv/sbx}"
SBX_ENV_DIR="${SBX_ENV_DIR:-/etc/sbx}"
STATE_DIR="${SBX_SAMPLER_STATE_DIR-${RUNTIME_DIRECTORY:-}}"
WORKER_RE='^[A-Za-z_][A-Za-z0-9_]*$'                   # install-host.sh's worker id
VM_CG_RE='^(pool-[0-9]+|vm-[0-9]+|vm-vm-[0-9]+\.scope)$' # vmpool's isPoolVMCgroupDirName
NUM_RE='^(0|[1-9][0-9]{0,19})(\.[0-9]{1,6})?$'
INT_RE='^(0|[1-9][0-9]{0,18})$'
DEFAULT_RESERVE_MB=1024 # sbx-worker@.service's SH_MEMORY_RESERVE_MB

printf -v TS '%(%Y-%m-%dT%H:%M:%SZ)T' -1
declare -A ERR=() # kind -> why, for this run
ERR_KINDS=()      # the kinds in the order they failed

fail() { # fail KIND WHY: one per kind per run
  [[ -n "${ERR[$1]:-}" ]] && return 0
  ERR[$1]="$2"
  ERR_KINDS+=("$1")
}

json_str() { # json_str VAR TEXT: TEXT as a JSON string into VAR (quotes, backslashes, controls)
  local s="${2//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf -v "$1" '"%s"' "${s//[[:cntrl:]]/?}"
}

num() { # num VAR VALUE: VALUE when it is a plain decimal number, else null
  if [[ "$2" =~ $NUM_RE ]]; then printf -v "$1" '%s' "$2"; else printf -v "$1" null; fi
}
int() { # int VAR VALUE: VALUE when it is a whole number, else null
  if [[ "$2" =~ $INT_RE ]]; then printf -v "$1" '%s' "$2"; else printf -v "$1" null; fi
}

read1() { # read1 VAR FILE: the first word of FILE's first line into VAR; fails when unreadable
  local w=''
  [[ -r "$2" ]] || return 1
  { read -r w _ <"$2"; } 2>/dev/null || [[ -n "${w:-}" ]] || return 1
  printf -v "$1" '%s' "$w"
}

sample_load() {
  local a='' b='' c='' l1 l5 l15
  { [[ -r "$PROC/loadavg" ]] && read -r a b c _ <"$PROC/loadavg"; } 2>/dev/null || fail loadavg "cannot read $PROC/loadavg"
  num l1 "$a"; num l5 "$b"; num l15 "$c"
  [[ "$l1$l5$l15" != *null* ]] || fail loadavg "$PROC/loadavg is not three load averages"
  LOAD="{\"avg1\":$l1,\"avg5\":$l5,\"avg15\":$l15}"
}

sample_mem() {
  local k v t='' a='' st='' sf='' total avail swt swf swu=null
  if [[ -r "$PROC/meminfo" ]]; then
    while read -r k v _; do
      case "$k" in
      MemTotal:) t="$v" ;;
      MemAvailable:) a="$v" ;;
      SwapTotal:) st="$v" ;;
      SwapFree:) sf="$v" ;;
      esac
    done <"$PROC/meminfo" 2>/dev/null
  fi
  int total "$t"; int avail "$a"; int swt "$st"; int swf "$sf"
  [[ "$total$avail$swt$swf" != *null* ]] || fail meminfo "no MemTotal, MemAvailable, SwapTotal and SwapFree in $PROC/meminfo"
  [[ "$swt" == null || "$swf" == null ]] || swu=$((swt - swf))
  MEM="{\"total\":$total,\"available\":$avail,\"swap_total\":$swt,\"swap_free\":$swf,\"swap_used\":$swu}"
}

sample_psi() {
  local r f kind a b s10 s60 f10 f60 out='' missing=''
  for r in cpu memory io; do
    f="$PROC/pressure/$r" s10=null s60=null f10=null f60=null
    if [[ -r "$f" ]]; then
      while read -r kind a b _; do
        case "$kind" in
        some) num s10 "${a#avg10=}"; num s60 "${b#avg60=}" ;;
        full) num f10 "${a#avg10=}"; num f60 "${b#avg60=}" ;;
        esac
      done <"$f" 2>/dev/null
    fi
    # The cpu file has a `full` line from Linux 5.13 on; before, only that pair is null.
    [[ "$s10" != null ]] || missing+=" $r"
    out+="${out:+,}\"$r\":{\"some_avg10\":$s10,\"some_avg60\":$s60,\"full_avg10\":$f10,\"full_avg60\":$f60}"
  done
  missing="${missing# }"
  [[ -z "$missing" ]] || fail psi "no readable $PROC/pressure/{${missing// /,}} (a kernel without PSI, or booted with psi=0)"
  PSI="{$out}"
}

# df_line VAR FLAG: the second line of `df -P FLAG` for the workspace root (bounded: a hung
# filesystem must not hold the run).
df_line() {
  local -a t=()
  command -v timeout >/dev/null && t=(timeout 5)
  printf -v "$1" '%s' "$("${t[@]}" df -P "$2" -- "$SBX_SRV/workspaces" 2>/dev/null | { read -r _; read -r l; printf '%s' "${l:-}"; })"
}

sample_workspaces() {
  local line bt=null bu=null ba=null it=null iu=null ifr=null
  local -a f
  if [[ ! -d "$SBX_SRV/workspaces" ]]; then
    fail workspaces "no $SBX_SRV/workspaces"
  else
    # Filesystem 1024-blocks Used Available Capacity Mounted-on; with -i: Inodes IUsed IFree IUse%.
    df_line line -k
    read -r -a f <<<"$line"
    if [[ "${f[1]:-}" =~ $INT_RE && "${f[2]:-}" =~ $INT_RE && "${f[3]:-}" =~ $INT_RE ]]; then
      bt=$((f[1] * 1024)) bu=$((f[2] * 1024)) ba=$((f[3] * 1024))
    else
      fail workspaces "df -Pk $SBX_SRV/workspaces failed or gave no sizes"
    fi
    df_line line -i
    read -r -a f <<<"$line"
    int it "${f[1]:-}"; int iu "${f[2]:-}"; int ifr "${f[3]:-}"
    [[ "$it$iu$ifr" != *null* ]] || fail workspaces "df -Pi $SBX_SRV/workspaces failed or gave no inode counts"
  fi
  WS="{\"bytes_total\":$bt,\"bytes_used\":$bu,\"bytes_avail\":$ba,\"inodes_total\":$it,\"inodes_used\":$iu,\"inodes_free\":$ifr}"
}

sample_slice() {
  local s="$CG/sbx.slice" k v usage=null nthr=null thr=null cur=null peak=null kv
  local rb=0 wb=0 ri=0 wi=0 io=''
  local -a f
  if [[ ! -d "$s" ]]; then
    fail slice "no $s (no worker started since boot, or not cgroup v2)"
  else
    if [[ -r "$s/cpu.stat" ]]; then
      while read -r k v; do
        case "$k" in
        usage_usec) int usage "$v" ;;
        nr_throttled) int nthr "$v" ;;
        throttled_usec) int thr "$v" ;;
        esac
      done <"$s/cpu.stat" 2>/dev/null
    fi
    read1 v "$s/memory.current" && int cur "$v"
    read1 v "$s/memory.peak" && int peak "$v" # Linux 5.19+; absent is not a failure
    if [[ -r "$s/io.stat" ]]; then
      io=1
      # One line per device: MAJ:MIN rbytes=N wbytes=N rios=N wios=N dbytes=N dios=N
      while read -r -a f; do
        for kv in "${f[@]:1}"; do
          v="${kv#*=}"
          [[ "$v" =~ $INT_RE ]] || continue
          case "$kv" in
          rbytes=*) rb=$((rb + v)) ;;
          wbytes=*) wb=$((wb + v)) ;;
          rios=*) ri=$((ri + v)) ;;
          wios=*) wi=$((wi + v)) ;;
          esac
        done
      done <"$s/io.stat" 2>/dev/null
    fi
    [[ "$usage" != null && "$cur" != null && -n "$io" ]] ||
      fail slice "cannot read cpu.stat, memory.current or io.stat in $s (the cpu, memory and io controllers)"
  fi
  [[ -n "$io" ]] || rb=null wb=null ri=null wi=null
  SLICE="{\"cpu_usage_usec\":$usage,\"cpu_nr_throttled\":$nthr,\"cpu_throttled_usec\":$thr,\"memory_current\":$cur,\"memory_peak\":$peak,\"io_rbytes\":$rb,\"io_wbytes\":$wb,\"io_rios\":$ri,\"io_wios\":$wi}"
}

populated() { # populated DIR: the cgroup holds a process (reap-vms.sh's rule)
  local line=''
  if [[ -r "$1/cgroup.events" ]]; then
    while read -r line; do
      [[ "$line" == 'populated 0' ]] && return 1
      [[ "$line" == 'populated 1' ]] && return 0
    done <"$1/cgroup.events" 2>/dev/null
  fi
  line=''
  # No cgroup.events: the first pid in cgroup.procs (a cgroupfs file always has size 0, so -s says nothing).
  { read -r line <"$1/cgroup.procs"; } 2>/dev/null || [[ -n "${line:-}" ]] || return 1
  [[ "$line" =~ ^[1-9][0-9]*$ ]]
}

# stats ID ADDR -> STATS: the three /stats fields as JSON, or null (and a stats:<id> failure).
STATS_COMMITTED_RE='"committedBytes":(0|[1-9][0-9]{0,18})[,}]'
STATS_STANDBY_RE='"standbyCommittedBytes":(0|[1-9][0-9]{0,18})[,}]'
STATS_REFUSALS_RE='"refusals":(null|\{[^{}]*\})'
REFUSALS_RE='^(null|\{\}|\{"[A-Za-z0-9_.-]+":[0-9]+(,"[A-Za-z0-9_.-]+":[0-9]+)*\})$'
stats() {
  local id="$1" addr="$2" host port body c s r
  STATS=null
  [[ -n "$addr" ]] || return 0
  if [[ ! "$addr" =~ ^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]*):([1-9][0-9]{0,4})$ ]]; then
    fail "stats:$id" "SH_DIAG_STATS_ADDR='$addr' is not [host]:port"
    return 0
  fi
  host="${BASH_REMATCH[1]}" port="${BASH_REMATCH[2]}"
  # A wildcard listen address is reached on loopback; any other host must be a loopback one: the sampler reads
  # this host's own workers and never calls out, whatever an env file names.
  case "$host" in
    '' | 0.0.0.0) host=127.0.0.1 ;;
    '[::]') host='[::1]' ;;
    localhost | '[::1]') ;;
    *)
      # 127.0.0.0/8, numeric only: a name such as 127.example.com would go to DNS
      if [[ ! "$host" =~ ^127(\.[0-9]{1,3}){3}$ ]]; then
        fail "stats:$id" "SH_DIAG_STATS_ADDR='$addr' is not a loopback or wildcard address: not read"
        return 0
      fi
      ;;
  esac
  command -v curl >/dev/null || { fail curl 'no curl on PATH: no worker /stats read'; return 0; }
  body="$(curl -fsS --max-time 1 --noproxy '*' "http://$host:$port/stats" 2>/dev/null)" ||
    { fail "stats:$id" "no answer from http://$host:$port/stats (SH_DIAG_STATS_ADDR)"; return 0; }
  [[ "$body" =~ $STATS_COMMITTED_RE ]] && c="${BASH_REMATCH[1]}" || c=''
  [[ "$body" =~ $STATS_STANDBY_RE ]] && s="${BASH_REMATCH[1]}" || s=''
  [[ "$body" =~ $STATS_REFUSALS_RE ]] && r="${BASH_REMATCH[1]}" || r=''
  if [[ -z "$c" || -z "$s" || ! "$r" =~ $REFUSALS_RE ]]; then
    fail "stats:$id" "http://$host:$port/stats is not the worker's /stats (committedBytes, standbyCommittedBytes, refusals)"
    return 0
  fi
  STATS="{\"committedBytes\":$c,\"standbyCommittedBytes\":$s,\"refusals\":$r}"
}

sample_workers() {
  local f id line budget reserve addr ws d vms cur v out='' b rs pid
  if [[ -d "$SBX_ENV_DIR/workers" && ! -r "$SBX_ENV_DIR/workers" ]]; then
    fail workers "cannot read $SBX_ENV_DIR/workers (run as root)"
  fi
  for f in "$SBX_ENV_DIR"/workers/*.env; do
    id="${f##*/}"
    id="${id%.env}"
    [[ "$id" =~ $WORKER_RE ]] || continue
    budget='' reserve='' addr=''
    if [[ -r "$f" ]]; then
      while IFS= read -r line || [[ -n "$line" ]]; do
        case "$line" in
        SH_MAX_COMMITTED_MB=*) budget="${line#*=}" ;;
        SH_MEMORY_RESERVE_MB=*) reserve="${line#*=}" ;;
        SH_DIAG_STATS_ADDR=*) addr="${line#*=}" ;;
        esac
      done <"$f" 2>/dev/null
    else
      fail "worker:$id" "cannot read $f"
    fi
    # A running worker's own environment wins: it is what the worker uses, drop-ins included
    # (SH_DIAG_STATS_ADDR is set in one, as the env file is rewritten by every install). Its main
    # process is the first in the unit's cgroup (Type=simple: microvm-worker itself).
    pid=''
    read1 pid "$CG/sbx.slice/sbx-$id.slice/sbx-worker@$id.service/cgroup.procs" || pid=''
    if [[ "$pid" =~ ^[1-9][0-9]*$ && -r "$PROC/$pid/environ" ]]; then
      while IFS= read -r -d '' line; do
        case "$line" in
        SH_MAX_COMMITTED_MB=*) budget="${line#*=}" ;;
        SH_MEMORY_RESERVE_MB=*) reserve="${line#*=}" ;;
        SH_DIAG_STATS_ADDR=*) addr="${line#*=}" ;;
        esac
      done <"$PROC/$pid/environ" 2>/dev/null
    fi
    int b "$budget"
    int rs "${reserve:-$DEFAULT_RESERVE_MB}"
    ws="$CG/sbx.slice/sbx-$id.slice" vms=0 cur=null
    if [[ -d "$ws" ]]; then
      for d in "$ws"/*/; do
        d="${d%/}"
        [[ "${d##*/}" =~ $VM_CG_RE ]] && populated "$d" && vms=$((vms + 1))
      done
      read1 v "$ws/memory.current" && int cur "$v"
    fi
    stats "$id" "$addr"
    out+="${out:+,}{\"wrk\":\"$id\",\"vms\":$vms,\"memory_current\":$cur,\"budget_mb\":$b,\"reserve_mb\":$rs,\"stats\":$STATS}"
  done
  WORKERS="[$out]"
}

# report: the error and recovered lines against what the state directory says was reported before,
# then the new state. A state directory that cannot be written is ignored (every kind reported).
report() {
  local k why prev=() kinds=''
  declare -A PREV=()
  if [[ -n "$STATE_DIR" && -r "$STATE_DIR/errors" ]]; then
    mapfile -t prev <"$STATE_DIR/errors" 2>/dev/null
    for k in "${prev[@]}"; do [[ -z "$k" ]] || PREV[$k]=1; done
  fi
  for k in "${ERR_KINDS[@]}"; do
    json_str why "${ERR[$k]}"
    [[ -n "${PREV[$k]:-}" ]] || printf '{"sampler":"error","ts":"%s","kind":"%s","why":%s}\n' "$TS" "$k" "$why"
    kinds+="${kinds:+,}\"$k\""
  done
  for k in "${prev[@]}"; do
    [[ -z "$k" || -n "${ERR[$k]:-}" ]] || printf '{"sampler":"recovered","ts":"%s","kind":"%s"}\n' "$TS" "$k"
  done
  if [[ -n "$STATE_DIR" && -d "$STATE_DIR" && -w "$STATE_DIR" ]]; then
    { ((${#ERR_KINDS[@]} == 0)) || printf '%s\n' "${ERR_KINDS[@]}"; } >"$STATE_DIR/errors" 2>/dev/null || true
  fi
  ERRORS="[$kinds]"
}

main() {
  sample_load
  sample_mem
  sample_psi
  sample_workspaces
  sample_slice
  sample_workers
  report
  printf '{"sampler":"sample","ts":"%s","load":%s,"mem_kb":%s,"psi":%s,"workspaces":%s,"slice":%s,"workers":%s,"errors":%s}\n' \
    "$TS" "$LOAD" "$MEM" "$PSI" "$WS" "$SLICE" "$WORKERS" "$ERRORS"
  return 0
}

main "$@"
