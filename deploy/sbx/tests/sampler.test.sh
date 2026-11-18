#!/usr/bin/env bash
# Tests for deploy/sbx/sampler.sh (#857, R2) on a fake /proc and a fake cgroup tree, with df, curl
# and timeout mocked: the one sample line and its fields, one error line per failure kind (and,
# with a state directory, one per kind for as long as it lasts, then a recovered line), every value
# a number or null, a valid JSON line whatever it read, exit 0 always, and no program run beyond df
# and curl (PATH holds the mocks only). SAMPLER_SH overrides the script under test.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }
S="${SAMPLER_SH:-$SRC/deploy/sbx/sampler.sh}"
BASH_BIN="$(command -v bash)"
command -v jq >/dev/null || { echo 'skip - needs jq to read the sample lines'; exit 0; }

# The mocks use builtins only, so the sampler runs with PATH=$TMP/bin and nothing else.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/df" <<MOCK
#!$BASH_BIN
printf 'df %s\n' "\$*" >>"\$MOCK_LOG"
[[ -z "\${MOCK_DF_FAIL:-}" ]] || exit 1
if [[ "\$2" == -i ]]; then
  printf 'Filesystem Inodes IUsed IFree IUse%% Mounted on\n/dev/nvme1n1 13107200 52000 13055200 1%% /srv\n'
else
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/nvme1n1 209715200 94371840 115343360 45%% /srv\n'
fi
MOCK
cat >"$TMP/bin/curl" <<MOCK
#!$BASH_BIN
printf 'curl %s\n' "\$*" >>"\$MOCK_LOG"
[[ -z "\${MOCK_CURL_FAIL:-}" ]] || exit 7
printf '%s\n' "\$(<"\$MOCK_STATS")"
MOCK
cat >"$TMP/bin/timeout" <<MOCK
#!$BASH_BIN
printf 'timeout %s\n' "\$*" >>"\$MOCK_LOG"
shift
exec "\$@"
MOCK
chmod +x "$TMP/bin/"*
export MOCK_LOG="$TMP/mock.log" MOCK_STATS="$TMP/stats.json"
export SBX_SYS_ROOT="$TMP/sys" SBX_ENV_DIR="$TMP/etc" SBX_SRV="$TMP/srv"
unset RUNTIME_DIRECTORY SBX_SAMPLER_STATE_DIR

P="$SBX_SYS_ROOT/proc" C="$SBX_SYS_ROOT/sys/fs/cgroup/sbx.slice"
D="$C/sbx-sbx_default.slice" Y="$C/sbx-sbx_py312.slice"
vmcg() { mkdir -p "$1"; printf 'populated %s\nfrozen 0\n' "$2" >"$1/cgroup.events"; }
setup() {
  rm -rf "$SBX_SYS_ROOT" "$SBX_ENV_DIR" "$SBX_SRV"
  mkdir -p "$P/pressure" "$C" "$D" "$Y" "$SBX_ENV_DIR/workers" "$SBX_SRV/workspaces"
  printf '0.52 0.40 0.31 2/811 12345\n' >"$P/loadavg"
  printf 'MemTotal:       65536000 kB\nMemFree:         1000000 kB\nMemAvailable:   40000000 kB\nSwapTotal:       8000000 kB\nSwapFree:        7500000 kB\n' >"$P/meminfo"
  printf 'some avg10=1.50 avg60=0.75 avg300=0.10 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n' >"$P/pressure/cpu"
  printf 'some avg10=0.20 avg60=0.10 avg300=0.00 total=9\nfull avg10=0.10 avg60=0.05 avg300=0.00 total=4\n' >"$P/pressure/memory"
  printf 'some avg10=12.00 avg60=8.25 avg300=2.00 total=999\nfull avg10=6.00 avg60=4.00 avg300=1.00 total=555\n' >"$P/pressure/io"
  printf 'usage_usec 9000000\nuser_usec 6000000\nsystem_usec 3000000\nnr_periods 0\nnr_throttled 3\nthrottled_usec 4500\n' >"$C/cpu.stat"
  printf '6442450944\n' >"$C/memory.current"
  printf '8589934592\n' >"$C/memory.peak"
  printf '259:0 rbytes=1000 wbytes=2000 rios=10 wios=20 dbytes=0 dios=0\n253:0 rbytes=24 wbytes=48 rios=1 wios=2 dbytes=0 dios=0\n' >"$C/io.stat"
  # sbx_default: two running VMs in pool cgroups, an emptied pool, a pre-#319 vm-<n>, the unit's own
  # cgroup (populated: never a VM) and a stray directory; sbx_py312: one VM, without cgroup.events.
  vmcg "$D/pool-1" 1; vmcg "$D/pool-2" 0; vmcg "$D/pool-3" 1; vmcg "$D/vm-7" 1
  vmcg "$D/sbx-worker@sbx_default.service" 1; vmcg "$D/stray" 1
  printf '4294967296\n' >"$D/memory.current"
  mkdir -p "$Y/pool-1" "$Y/pool-2"
  printf '4242\n' >"$Y/pool-1/cgroup.procs"
  : >"$Y/pool-2/cgroup.procs"
  printf 'SH_MAX_COMMITTED_MB=8192\nSH_DIAG_STATS_ADDR=127.0.0.1:9900\n' >"$SBX_ENV_DIR/workers/sbx_default.env"
  printf 'SH_MAX_COMMITTED_MB=16384\nSH_MEMORY_RESERVE_MB=2048\n' >"$SBX_ENV_DIR/workers/sbx_py312.env"
  printf '%s' '{"inFlight":1,"activeRuns":1,"parkedRuns":0,"standbysResident":2,"idleStandbyResidency":0,"committedBytes":3221225472,"standbyCommittedBytes":268435456,"leaseCommittedBytes":7,"warmAcquires":5,"maxConcurrent":4,"coldAcquires":{"miss":1},"refusals":{"memory-budget":2},"replenishments":3,"session":{"queueFullRefusals":0}}' >"$MOCK_STATS"
  : >"$MOCK_LOG"
}
run() { PATH="$TMP/bin" "$BASH_BIN" "$S" >"$TMP/out" 2>"$TMP/err" || fail "exited $?"; }
sample() { grep '^{"sampler":"sample"' "$TMP/out"; }
q() { sample | jq -c "$1"; } # q FILTER: the filter over the sample line, compact
# is FILTER JSON: equal as jq prints both (so 0.40 and 0.4 compare alike on every jq version).
is() { [[ "$(q "$1")" == "$(jq -c . <<<"$2")" ]] || fail "$1 is $(q "$1"), not $2"; }
lines() { grep -c "^{\"sampler\":\"$1\"" "$TMP/out" || true; }

# 1. Every field from the fake host.
setup
run
[[ "$(wc -l <"$TMP/out" | tr -d ' ')" == 1 ]] || fail 'a clean sample is not exactly one line'
[[ ! -s "$TMP/err" ]] || fail "wrote to stderr: $(cat "$TMP/err")"
sample | jq -e . >/dev/null || fail 'the sample line is not JSON'
[[ "$(q '.ts')" =~ ^\"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\"$ ]] || fail "ts: $(q .ts)"
is '.load' '{"avg1":0.52,"avg5":0.40,"avg15":0.31}'
is '.mem_kb' '{"total":65536000,"available":40000000,"swap_total":8000000,"swap_free":7500000,"swap_used":500000}'
is '.psi.cpu' '{"some_avg10":1.50,"some_avg60":0.75,"full_avg10":0.00,"full_avg60":0.00}'
is '.psi.memory' '{"some_avg10":0.20,"some_avg60":0.10,"full_avg10":0.10,"full_avg60":0.05}'
is '.psi.io' '{"some_avg10":12.00,"some_avg60":8.25,"full_avg10":6.00,"full_avg60":4.00}'
is '.workspaces' '{"bytes_total":214748364800,"bytes_used":96636764160,"bytes_avail":118111600640,"inodes_total":13107200,"inodes_used":52000,"inodes_free":13055200}'
is '.slice' '{"cpu_usage_usec":9000000,"cpu_nr_throttled":3,"cpu_throttled_usec":4500,"memory_current":6442450944,"memory_peak":8589934592,"io_rbytes":1024,"io_wbytes":2048,"io_rios":11,"io_wios":22}'
is '.workers[0]' '{"wrk":"sbx_default","vms":3,"memory_current":4294967296,"budget_mb":8192,"reserve_mb":1024,"stats":{"committedBytes":3221225472,"standbyCommittedBytes":268435456,"refusals":{"memory-budget":2}}}'
is '.workers[1]' '{"wrk":"sbx_py312","vms":1,"memory_current":null,"budget_mb":16384,"reserve_mb":2048,"stats":null}'
is '.errors' '[]'
grep -qx "timeout 5 df -P -k -- $SBX_SRV/workspaces" "$MOCK_LOG" && grep -qx "timeout 5 df -P -i -- $SBX_SRV/workspaces" "$MOCK_LOG" ||
  fail "df is not bounded by timeout on the workspace root: $(cat "$MOCK_LOG")"
grep -qxF "curl -fsS --max-time 1 --noproxy * http://127.0.0.1:9900/stats" "$MOCK_LOG" || fail "curl of /stats: $(grep curl "$MOCK_LOG")"
[[ "$(grep -c '^curl ' "$MOCK_LOG")" == 1 ]] || fail 'curled a worker without SH_DIAG_STATS_ADDR'
pass 'one line: load, memory and swap, PSI, workspace bytes and inodes, sbx.slice, per worker VMs, budget and /stats'

# 2. The VM count is vmpool's names with a process only; a wildcard listen address is read on loopback.
setup
vmcg "$D/pool-1" 0
printf 'SH_MAX_COMMITTED_MB=8192\nSH_DIAG_STATS_ADDR=:9901\n' >"$SBX_ENV_DIR/workers/sbx_default.env"
run
is '.workers[0].vms' '2'
grep -q 'http://127.0.0.1:9901/stats' "$MOCK_LOG" || fail "':9901' is not read on 127.0.0.1"
printf 'SH_MAX_COMMITTED_MB=8192\nSH_DIAG_STATS_ADDR=[::]:9902\n' >"$SBX_ENV_DIR/workers/sbx_default.env"
run
grep -q 'http://\[::1\]:9902/stats' "$MOCK_LOG" || fail "'[::]:9902' is not read on [::1]"
# Any other host is refused, never curled: the sampler reads only this host's own workers.
: >"$MOCK_LOG"
printf 'SH_MAX_COMMITTED_MB=8192\nSH_DIAG_STATS_ADDR=10.1.2.3:9904\n' >"$SBX_ENV_DIR/workers/sbx_default.env"
run
! grep -q '^curl ' "$MOCK_LOG" || fail "a non-loopback SH_DIAG_STATS_ADDR was curled: $(grep curl "$MOCK_LOG")"
is '.workers[0].stats' 'null'
printf 'SH_MAX_COMMITTED_MB=8192\nSH_DIAG_STATS_ADDR=localhost:9905\n' >"$SBX_ENV_DIR/workers/sbx_default.env"
run
grep -q 'http://localhost:9905/stats' "$MOCK_LOG" || fail "'localhost:9905' is not read"
# A running worker's environment (a drop-in's SH_DIAG_STATS_ADDR, the unit's reserve) wins over
# its env file, which every install rewrites.
printf 'SH_MAX_COMMITTED_MB=8192\n' >"$SBX_ENV_DIR/workers/sbx_default.env"
mkdir -p "$D/sbx-worker@sbx_default.service" "$P/4711"
printf '4711\n4712\n' >"$D/sbx-worker@sbx_default.service/cgroup.procs"
printf 'SH_MAX_COMMITTED_MB=12288\0SH_MEMORY_RESERVE_MB=1536\0SH_DIAG_STATS_ADDR=127.0.0.1:9903\0' >"$P/4711/environ"
run
is '.workers[0] | {budget_mb, reserve_mb}' '{"budget_mb":12288,"reserve_mb":1536}'
grep -q 'http://127.0.0.1:9903/stats' "$MOCK_LOG" || fail 'the running worker'"'"'s SH_DIAG_STATS_ADDR is not read'
rm -rf "$D"
run
is '.workers[0] | {vms, memory_current, budget_mb, reserve_mb, stats}' '{"vms":0,"memory_current":null,"budget_mb":8192,"reserve_mb":1024,"stats":null}'
is '.errors' '[]'
pass 'VMs: populated pool-/vm- cgroups only; a stopped worker (no slice) is 0 VMs and no error; wildcard addresses on loopback, any other host refused; a running worker'"'"'s environment wins'

# 3. Failures: one error line per kind, before the sample, whose errors names them; nulls, exit 0.
setup
rm "$P/pressure/cpu" "$P/pressure/io"
MOCK_CURL_FAIL=1 run
[[ "$(lines error)" == 2 ]] || fail "not one error line per kind: $(cat "$TMP/out")"
grep '^{"sampler":"error"' "$TMP/out" | jq -e 'select(.kind == "psi") | .why | test("pressure/\\{cpu,io\\}")' >/dev/null ||
  fail 'the psi line does not name both files'
grep '^{"sampler":"error"' "$TMP/out" | jq -e 'select(.kind == "stats:sbx_default")' >/dev/null || fail 'no stats:sbx_default line'
[[ "$(tail -1 "$TMP/out")" == '{"sampler":"sample"'* ]] || fail 'the sample is not the last line'
is '.errors' '["psi","stats:sbx_default"]'
is '.psi.cpu.some_avg10' 'null'
is '.psi.memory.some_avg10' '0.20'
is '.workers[0].stats' 'null'
printf '<html>proxy error</html>' >"$MOCK_STATS"
run
is '.errors' '["psi","stats:sbx_default"]'
printf '{"committedBytes":-1,"standbyCommittedBytes":0,"refusals":{}}' >"$MOCK_STATS"
run
is '.workers[0].stats' 'null'
pass 'failures: one error line per kind (two PSI files, one psi line), named in the sample, fields null'

# Garbage in every file, and nothing at all: still one valid JSON sample, exit 0, no stderr.
setup
printf 'x 0.40 -1\n' >"$P/loadavg"
printf 'MemTotal: 08 kB\nMemAvailable: 1e9 kB\n' >"$P/meminfo"
printf 'usage_usec 12abc\n' >"$C/cpu.stat"
printf 'max\n' >"$C/memory.current"
printf '259:0 rbytes=1x wbytes=5\n' >"$C/io.stat"
printf 'SH_MAX_COMMITTED_MB=8g\n' >"$SBX_ENV_DIR/workers/sbx_py312.env"
run
[[ ! -s "$TMP/err" ]] || fail "wrote to stderr: $(cat "$TMP/err")"
while IFS= read -r l; do jq -e . >/dev/null <<<"$l" || fail "not JSON: $l"; done <"$TMP/out"
is '.load' '{"avg1":null,"avg5":0.40,"avg15":null}'
is '.mem_kb.total' 'null'
is '.slice | {cpu_usage_usec, memory_current, io_rbytes, io_wbytes}' '{"cpu_usage_usec":null,"memory_current":null,"io_rbytes":0,"io_wbytes":5}'
is '.workers[1].budget_mb' 'null'
is '.errors' '["loadavg","meminfo","slice"]'
export SBX_SYS_ROOT="$TMP/none" SBX_ENV_DIR="$TMP/none" SBX_SRV="$TMP/q\"uote"
run
while IFS= read -r l; do jq -e . >/dev/null <<<"$l" || fail "not JSON: $l"; done <"$TMP/out"
is '.errors' '["loadavg","meminfo","psi","workspaces","slice"]'
is '.workers' '[]'
grep -q 'q\\"uote' "$TMP/out" || fail 'a quote in a path is not escaped'
export SBX_SYS_ROOT="$TMP/sys" SBX_ENV_DIR="$TMP/etc" SBX_SRV="$TMP/srv"
pass 'garbage or nothing: every bad value null, every line valid JSON (a quote in a path escaped), exit 0, stderr silent'

# 4. With a state directory (the unit's RuntimeDirectory): a failure that lasts is one error line,
#    the next runs' samples still name it, and its end is one recovered line.
setup
mkdir -p "$TMP/state"
export RUNTIME_DIRECTORY="$TMP/state"
rm "$P/pressure/io"
run
[[ "$(lines error)" == 1 ]] || fail 'the first failing run has no psi error line'
for _ in 1 2 3; do
  run
  [[ "$(lines error)" == 0 ]] || fail "a lasting failure is reported again: $(cat "$TMP/out")"
  is '.errors' '["psi"]'
done
MOCK_DF_FAIL=1 run
[[ "$(lines error)" == 1 ]] && grep -q '"kind":"workspaces"' "$TMP/out" || fail 'a new kind beside a lasting one is not one line'
printf 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n' >"$P/pressure/io"
run
[[ "$(lines recovered)" == 2 && "$(lines error)" == 0 ]] || fail "no recovered line per kind: $(cat "$TMP/out")"
grep -q '^{"sampler":"recovered","ts":"[^"]*","kind":"psi"}$' "$TMP/out" || fail 'the psi recovery line'
run
[[ "$(wc -l <"$TMP/out" | tr -d ' ')" == 1 ]] || fail 'a recovered host still prints more than its sample'
# A state directory it cannot write: every kind reported each run, nothing fails.
export RUNTIME_DIRECTORY="$TMP/missing-state"
rm "$P/pressure/io"
run; run
[[ "$(lines error)" == 1 ]] || fail 'without a usable state directory the kind is not reported each run'
SBX_SAMPLER_STATE_DIR='' RUNTIME_DIRECTORY="$TMP/state" run
[[ "$(lines error)" == 1 ]] || fail 'an empty SBX_SAMPLER_STATE_DIR (status.sh) does not report every kind'
unset RUNTIME_DIRECTORY
pass 'state: a lasting failure is one error line, the samples keep naming it, its end one recovered line; no state, every run'

# 5. Reads only: the only programs it ran are the mocks (PATH held nothing else), and it wrote
#    nowhere but the state directory.
setup
sleep 1
touch "$TMP/mark"
run
written="$(find "$TMP" -newer "$TMP/mark" -type f ! -path "$TMP/out" ! -path "$TMP/err" ! -path "$MOCK_LOG")"
[[ -z "$written" ]] || fail "wrote files: $written"
grep -v '^\(df\|curl\|timeout\) ' "$MOCK_LOG" && fail "ran something else: $(cat "$MOCK_LOG")"
pass 'reads only: df, timeout and curl are all it runs, and it writes no file'

# 6. The units: a 15 s oneshot that cannot outlive its tick, logging at notice so PID 1's own
#    per-run lines stay out of the journal, with the state directory kept between runs.
U="$SRC/deploy/sbx/sbx-sampler.service" T="$SRC/deploy/sbx/sbx-sampler.timer"
for l in Type=oneshot ExecStart=/usr/local/libexec/sbx-sampler.sh Environment=SBX_ENV_DIR=/etc/sbx Environment=SBX_SRV=/srv/sbx \
  RuntimeDirectory=sbx-sampler RuntimeDirectoryPreserve=yes SyslogLevel=notice LogLevelMax=notice ProtectSystem=strict \
  NoNewPrivileges=yes TimeoutStartSec=10s; do
  grep -qx "$l" "$U" || fail "sbx-sampler.service lacks $l"
done
! grep -q '^Slice=sbx' "$U" || fail 'the sampler runs in sbx.slice, which it measures'
for l in OnUnitActiveSec=15s AccuracySec=1s WantedBy=timers.target; do grep -qx "$l" "$T" || fail "sbx-sampler.timer lacks $l"; done
[[ "$(grep -c '^OnUnitActiveSec=' "$T")" == 1 ]] || fail 'the timer has more than one OnUnitActiveSec= line (install-host.sh rewrites it)'
pass 'units: a bounded oneshot at notice level with a preserved RuntimeDirectory; the timer every 15 s, accuracy 1 s'
