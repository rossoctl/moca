#!/usr/bin/env bash
# Tests for deploy/sbx/status.sh (SBX0 §8.4), with kubectl (and the redis-cli it execs), ssh,
# systemctl, df and journalctl mocked on PATH. What it must print: the attached workers, the live and
# retained-terminated sandbox counts, Exec p50/p95 and errors from the relay's audit lines, and on a
# KVM host the units, the workspace disk, the janitor's last run and whether its installed wait still
# outlasts the token lifetime. What it must not do: change anything (every mocked call is read-only),
# read 1a's sbx:ended, or fail: it reports, and exits 0, whatever it could not reach.
# STATUS_SH overrides the script under test.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }
STATUS="${STATUS_SH:-$SRC/deploy/sbx/status.sh}"
export MOCK_LOG="$TMP/mock.log" MOCK_DIR="$TMP/fixtures"
mkdir -p "$TMP/bin" "$MOCK_DIR"

# kubectl: logs its argv; serves the sbx-settings ConfigMap and the relay's log from fixtures, and
# runs `exec ... -- redis-cli ...` as the redis-cli mock below (as if inside the Redis pod).
# MOCK_FAIL=<word> makes the call whose argv holds that word fail.
cat >"$TMP/bin/kubectl" <<'MOCK'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >>"$MOCK_LOG"
[[ -z "${MOCK_FAIL:-}" || " $* " != *" $MOCK_FAIL "* ]] || { echo "Error from server: $MOCK_FAIL failed" >&2; exit 1; }
case "$*" in
'get configmap sbx-settings -n sbx-test -o json') cat "$MOCK_DIR/settings.json" ;;
'logs deployment/sandbox-relay -c sandbox-relay -n sbx-test --since=1h') cat "$MOCK_DIR/relay.log" ;;
'exec -n sbx-test statefulset/redis -c redis -- redis-cli '*) shift 7; exec "$@" ;;
*) echo "mock kubectl: unexpected: $*" >&2; exit 99 ;;
esac
MOCK
# redis-cli: logs its argv; answers the three reads status.sh makes, and nothing else.
cat >"$TMP/bin/redis-cli" <<'MOCK'
#!/usr/bin/env bash
printf 'redis-cli %s\n' "$*" >>"$MOCK_LOG"
case "$*" in
'HKEYS sh:sandbox:records') cat "$MOCK_DIR/hkeys" ;;
'ZCOUNT sbx:live ('*' +inf') echo 4 ;;
'ZCARD sbx:all') echo 9 ;;
*) echo "(error) mock redis-cli: unexpected: $*"; exit 1 ;;
esac
MOCK
# ssh: logs its argv; MOCK_SSH_FAIL=<target> fails that target as an unreachable host. Otherwise it
# checks that the remote command is exactly status.sh's own --host invocation and runs it here,
# without the sudo, on the script it was handed on stdin: so the piped script is proven to work with
# no checkout (and no lib.sh) on the host.
cat >"$TMP/bin/ssh" <<'MOCK'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >>"$MOCK_LOG"
args=("$@") n=${#args[@]}
target="${args[$((n - 2))]}" remote="${args[$((n - 1))]}"
[[ "$target" != "${MOCK_SSH_FAIL:-}" ]] || { echo 'ssh: connect to host: Connection refused' >&2; exit 255; }
[[ "$remote" =~ ^sudo\ -n\ bash\ -s\ --\ --host(\ --token-ttl-seconds\ [0-9]+)?(\ --max-lifetime-seconds\ [0-9]+)?$ ]] || { echo "mock ssh: unexpected remote command: $remote" >&2; exit 98; }
exec bash -s -- ${remote#sudo -n bash -s -- }
MOCK
cat >"$TMP/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$MOCK_LOG"
case "$1" in
list-units)
  printf 'sbx-worker@sbx_default.service loaded active running SBX0 sandbox worker sbx_default\n'
  printf 'sbx-worker@sbx_py312.service loaded failed failed SBX0 sandbox worker sbx_py312\n' ;;
is-active)
  case "$2" in
  sbx-worker@sbx_default.service | sbx-janitor.timer | sbx-sampler.timer) echo active ;;
  *) echo failed; exit 3 ;;
  esac ;;
show)
  case "$4" in
  Result) echo "${MOCK_JANITOR_RESULT:-success}" ;;
  ExecMainStartTimestamp) echo 'Mon 2026-10-19 09:00:00 UTC' ;;
  esac ;;
*) echo "mock systemctl: unexpected: $*" >&2; exit 99 ;;
esac
MOCK
# df: -hP is status.sh's own; -P -k and -P -i are the host sampler's (bytes in KiB, and inodes).
cat >"$TMP/bin/df" <<'MOCK'
#!/usr/bin/env bash
printf 'df %s\n' "$*" >>"$MOCK_LOG"
case "$1 $2" in
'-P -k') printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/nvme1n1 209715200 94371840 115343360 45%% /srv\n' ;;
'-P -i') printf 'Filesystem Inodes IUsed IFree IUse%% Mounted on\n/dev/nvme1n1 13107200 52000 13055200 1%% /srv\n' ;;
*) printf 'Filesystem      Size  Used Avail Use%% Mounted on\n/dev/nvme1n1    200G   90G  110G  45%% /srv\n' ;;
esac
MOCK
cat >"$TMP/bin/journalctl" <<'MOCK'
#!/usr/bin/env bash
printf 'journalctl %s\n' "$*" >>"$MOCK_LOG"
cat "$MOCK_DIR/journal"
MOCK
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH"

printf '{"data":{"SH_SANDBOX_TOKEN_TTL_SECONDS":"900"}}\n' >"$MOCK_DIR/settings.json"
printf 'sbx_default\nsbx_old\n' >"$MOCK_DIR/hkeys"
# Three Exec lines (ms 10, 20, 900; one error), and what must not count: the relay's non-JSON
# chatter, a broken line that names the marker, an Abort refusal, an Exec refusal and a busy one.
cat >"$MOCK_DIR/relay.log" <<'LOG'
[relay] exec listening on 127.0.0.1:9444
{"audit":"sandbox_exec","ts":"2026-10-19T09:00:00.000Z","sub":"github:1","sbx":"sbx-0123456789abcdef0123456789","wrk":"sbx_default","req_id":1,"ms":10,"outcome":"end","exit_code":0,"truncated":false,"out_bytes":5}
[relay] warn: {"audit":"sandbox_exec" truncated by a log shipper
{"audit":"sandbox_exec","ts":"2026-10-19T09:00:01.000Z","sub":"github:1","sbx":"sbx-0123456789abcdef0123456789","wrk":"sbx_default","req_id":2,"ms":900,"outcome":"error","out_bytes":0}
{"audit":"sandbox_abort","ts":"2026-10-19T09:00:02.000Z","wrk":"sbx_default","req_id":3,"ms":0,"outcome":"refused","out_bytes":0,"reason":"no bearer token"}
{"x":{"audit":"sandbox_exec"},"audit":"sandbox_abort","ms":5,"outcome":"end","out_bytes":0}
{"audit":"sandbox_exec","ts":"2026-10-19T09:00:03.000Z","wrk":"sbx_default","req_id":4,"ms":1,"outcome":"refused","out_bytes":0,"reason":"malformed token"}
{"audit":"sandbox_exec","ts":"2026-10-19T09:00:04.000Z","sub":"github:1","sbx":"sbx-0123456789abcdef0123456789","wrk":"sbx_default","req_id":5,"ms":0,"outcome":"busy","out_bytes":0}
{"audit":"sandbox_exec","ts":"2026-10-19T09:00:05.000Z","sub":"github:1","sbx":"sbx-0123456789abcdef0123456789","wrk":"sbx_default","req_id":6,"ms":20,"outcome":"end","exit_code":1,"truncated":false,"out_bytes":0}
LOG
printf 'SBX_NAMESPACE=sbx-test\nSBX_WORKERS="sbx_default sbx_py312"\n' >"$TMP/sbx.env"

has() { grep -qxF -- "$1" "$TMP/out" || fail "no line '$1'"; }

# 1. The cluster side.
: >"$MOCK_LOG"
bash "$STATUS" --env-file "$TMP/sbx.env" >"$TMP/out" 2>&1 || fail "exited $?"
has 'workers attached: sbx_default'
has 'workers not attached: sbx_py312'
has 'workers attached, not in SBX_WORKERS: sbx_old'
has 'sandboxes live: 4'
has 'sandboxes terminated (retained, approx.): 5'
has 'exec last hour: 3 calls, p50 20 ms, p95 900 ms, errors 33%'
has 'exec refused last hour: 1 refused, 1 busy'
has 'exec cut short last hour: 0 timeout, 0 expired, 0 cancelled'
has 'token lifetime: 900 s'
now="$(date +%s)"
live_at="$(sed -n 's/^redis-cli ZCOUNT sbx:live (\([0-9]*\) +inf$/\1/p' "$MOCK_LOG")"
{ [[ -n "$live_at" ]] && ((live_at <= now && live_at > now - 60)); } || fail "live is not ZCOUNT sbx:live (<now> +inf: ${live_at:-none}"
pass 'cluster: workers, live and retained-terminated sandboxes, Exec p50/p95/errors, refusals, token lifetime'

! grep -q 'sbx:ended' "$MOCK_LOG" "$STATUS" || fail 'reads sbx:ended, which 1b removed'
while read -r tool verb rest; do
  case "$tool $verb" in
  'kubectl get' | 'kubectl logs' | 'redis-cli HKEYS' | 'redis-cli ZCOUNT' | 'redis-cli ZCARD') ;;
  'kubectl exec') [[ "$rest" == *' -- redis-cli '* ]] || fail "a kubectl exec that is not redis-cli: $rest" ;;
  *) fail "a call that is not a read: $tool $verb $rest" ;;
  esac
done <"$MOCK_LOG"
pass 'cluster: read-only (kubectl get, logs and redis-cli HKEYS/ZCOUNT/ZCARD only), no sbx:ended'

# 2. Calls cut short count as calls, not errors; then no Exec at all; every worker attached.
for o in timeout expired cancelled; do
  printf '{"audit":"sandbox_exec","ts":"2026-10-19T09:00:00.000Z","wrk":"sbx_default","req_id":1,"ms":5,"outcome":"%s","out_bytes":0}\n' "$o"
done >"$MOCK_DIR/relay.log"
printf 'sbx_default\nsbx_py312\n' >"$MOCK_DIR/hkeys"
bash "$STATUS" --env-file "$TMP/sbx.env" >"$TMP/out" 2>&1 || fail "exited $?"
has 'exec last hour: 3 calls, p50 5 ms, p95 5 ms, errors 0%'
has 'exec cut short last hour: 1 timeout, 1 expired, 1 cancelled'
has 'workers attached: sbx_default sbx_py312'
has 'workers not attached: none'
! grep -q 'not in SBX_WORKERS' "$TMP/out" || fail 'reported a stray worker when there is none'
: >"$MOCK_DIR/relay.log"
bash "$STATUS" --env-file "$TMP/sbx.env" >"$TMP/out" 2>&1 || fail "exited $?"
has 'exec last hour: 0 calls'
has 'exec refused last hour: 0 refused, 0 busy'
pass 'cluster: timeouts, expiries and cancels are calls but not errors; no Exec in the hour; every worker attached'

# Nearest-rank percentiles over 20 calls (ms 1..20): p50 is the 10th, p95 the 19th.
for ms in $(seq 1 20); do
  printf '{"audit":"sandbox_exec","ts":"2026-10-19T09:00:00.000Z","wrk":"sbx_default","req_id":%s,"ms":%s,"outcome":"end","exit_code":0,"truncated":false,"out_bytes":0}\n' "$ms" "$ms"
done >"$MOCK_DIR/relay.log"
bash "$STATUS" --env-file "$TMP/sbx.env" >"$TMP/out" 2>&1 || fail "exited $?"
has 'exec last hour: 20 calls, p50 10 ms, p95 19 ms, errors 0%'
pass 'cluster: p50 and p95 are nearest-rank'

# 3. What it cannot reach is reported, and the run still exits 0.
for word in exec logs configmap; do
  MOCK_FAIL=$word bash "$STATUS" --env-file "$TMP/sbx.env" >"$TMP/out" 2>&1 || fail "MOCK_FAIL=$word: exited $?"
  grep -q ': unavailable' "$TMP/out" || fail "MOCK_FAIL=$word: nothing reported as unavailable"
done
MOCK_FAIL="exec" bash "$STATUS" --env-file "$TMP/sbx.env" >"$TMP/out" 2>&1
has 'workers attached: unavailable (kubectl exec redis-cli failed)'
has 'sandboxes live: unavailable (kubectl exec redis-cli failed)'
# redis-cli can print an error on stdout and still exit 0: it is not a worker list.
printf '(error) NOAUTH Authentication required.\n' >"$MOCK_DIR/hkeys"
bash "$STATUS" --env-file "$TMP/sbx.env" >"$TMP/out" 2>&1 || fail "exited $?"
has 'workers attached: unavailable (kubectl exec redis-cli failed)'
printf 'sbx_default\nsbx_py312\n' >"$MOCK_DIR/hkeys"
pass 'cluster: an unreachable Redis, relay log or ConfigMap, or a redis-cli error, is reported, exit 0'

# 4. Arguments: --env-file is setup.sh's own parse_args, from lib.sh (shared, not copied).
! bash "$STATUS" --bogus >"$TMP/out" 2>&1 || fail 'accepted an unknown argument'
grep -q 'usage: status.sh' "$TMP/out" || fail 'the refusal does not show the usage'
! bash "$STATUS" --env-file "$TMP/missing.env" >"$TMP/out" 2>&1 || fail 'accepted a missing env file'
! (SBX_WORKERS='sbx_default' bash "$STATUS" >"$TMP/out" 2>&1) || fail 'ran with no SBX_NAMESPACE'
grep -q '^parse_args()' "$SRC/deploy/sbx/lib.sh" || fail 'lib.sh does not define parse_args'
! grep -q 'parse_args()' "$SRC/deploy/sbx/setup.sh" "$STATUS" || fail 'setup.sh or status.sh defines its own parse_args'
grep -q '^\. "\$SBX_DIR/lib.sh"' "$SRC/deploy/sbx/setup.sh" || fail 'setup.sh does not source lib.sh'
pass 'arguments: unknown and missing refused; parse_args lives in lib.sh, sourced by setup.sh'

# 5. The host side. The host sampler (deploy/sbx/sampler.sh, beside the script under test: no
#    installed one in SBX_LIBEXEC_DIR) reads a fake /proc and cgroup tree.
export SBX_ENV_DIR="$TMP/etc" SBX_SRV="$TMP/srv" SBX_LIBEXEC_DIR="$TMP/libexec"
export SBX_SYS_ROOT="$TMP/sys"
FAKE_PROC="$SBX_SYS_ROOT/proc" FAKE_CG="$SBX_SYS_ROOT/sys/fs/cgroup"
mkdir -p "$SBX_ENV_DIR" "$SBX_SRV/workspaces" "$FAKE_PROC/pressure" "$FAKE_CG/sbx.slice" "$SBX_LIBEXEC_DIR"
printf '0.52 0.40 0.31 2/811 12345\n' >"$FAKE_PROC/loadavg"
printf 'MemTotal: 65536000 kB\nMemAvailable: 40000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n' >"$FAKE_PROC/meminfo"
for r in cpu memory io; do
  printf 'some avg10=1.00 avg60=0.50 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n' >"$FAKE_PROC/pressure/$r"
done
printf 'usage_usec 9000000\nnr_throttled 0\nthrottled_usec 0\n' >"$FAKE_CG/sbx.slice/cpu.stat"
printf '6442450944\n' >"$FAKE_CG/sbx.slice/memory.current"
printf '259:0 rbytes=1 wbytes=2 rios=3 wios=4 dbytes=0 dios=0\n' >"$FAKE_CG/sbx.slice/io.stat"
printf 'SBX_API_URL=https://sbx-api.apps.example.invalid\nSBX_JANITOR_AGE=3600\n' >"$SBX_ENV_DIR/janitor.env"
cat >"$MOCK_DIR/journal" <<'LOG'
{"janitor":"summary","ts":"2026-10-19T08:45:00Z","examined":3,"removed":0,"unknown":0,"bytes_freed":0,"errors":0}
{"janitor":"reclaimed","wrk":"sbx_default","wsk":"sbx-0123456789abcdef0123456789","bytes":4096}
{"janitor":"summary","ts":"2026-10-19T09:00:00Z","examined":4,"removed":1,"unknown":0,"bytes_freed":4096,"errors":0}
{"janitor":"error","wrk":"sbx_py312","wsk":"","why":"no env file"}
LOG
: >"$MOCK_LOG"
bash "$STATUS" --host --token-ttl-seconds 900 >"$TMP/out" 2>&1 || fail "--host exited $?"
has 'unit sbx-worker@sbx_default.service: active'
has 'unit sbx-worker@sbx_py312.service: failed'
has 'unit sbx-janitor.timer: active'
has 'unit sbx-sampler.timer: active'
has 'workspace filesystem: 45% used, 90G of 200G (110G free) on /srv'
has 'janitor last run: {"janitor":"summary","ts":"2026-10-19T09:00:00Z","examined":4,"removed":1,"unknown":0,"bytes_freed":4096,"errors":0}'
has 'janitor wait: 3600 s (outlasts the token lifetime 900 s + 30 s)'
has 'janitor service: success, last started Mon 2026-10-19 09:00:00 UTC'
grep -qx "df -hP $SBX_SRV/workspaces" "$MOCK_LOG" || fail 'df is not of the workspace root'
while read -r tool verb _; do
  case "$tool $verb" in
  'systemctl list-units' | 'systemctl is-active' | 'systemctl show' | 'df -hP' | 'df -P' | journalctl\ *) ;;
  *) fail "a host call that is not a read: $tool $verb" ;;
  esac
done <"$MOCK_LOG"
pass 'host: units, workspace disk, the janitor last summary and its wait; read-only'

# The host sample: the sampler's own line, once, the same fields as the journal's series.
sample="$(sed -n 's/^host sample: //p' "$TMP/out")"
[[ "$(grep -c '^host sample: ' "$TMP/out")" == 1 ]] || fail 'not exactly one host sample line'
command -v jq >/dev/null || fail 'the status tests need jq (the cluster side does)'
jq -e '.sampler == "sample" and .load.avg1 == 0.52 and .mem_kb.available == 40000000 and .psi.io.some_avg10 == 1
  and .workspaces.inodes_free == 13055200 and .slice.memory_current == 6442450944 and .errors == []' <<<"$sample" >/dev/null ||
  fail "host sample: $sample"
! grep -q '^host sample error: ' "$TMP/out" || fail 'a clean host printed a sample error'
rm "$FAKE_PROC/pressure/io"
bash "$STATUS" --host >"$TMP/out" 2>&1 || fail "exited $?"
grep -q '^host sample error: {"sampler":"error","ts":"[^"]*","kind":"psi",' "$TMP/out" || fail 'a failing kind is not shown'
sed -n 's/^host sample: //p' "$TMP/out" | jq -e '.errors == ["psi"]' >/dev/null || fail 'the sample does not name the failing kind'
# The sampler's state directory is never used here: run under a unit's RUNTIME_DIRECTORY, the
# kind it already reported is still shown.
mkdir -p "$TMP/state" && printf 'psi\n' >"$TMP/state/errors"
RUNTIME_DIRECTORY="$TMP/state" bash "$STATUS" --host >"$TMP/out" 2>&1 || fail "exited $?"
grep -q '^host sample error: .*"kind":"psi"' "$TMP/out" || fail 'status.sh used the sampler state directory'
printf 'some avg10=1.00 avg60=0.50 avg300=0.00 total=1\n' >"$FAKE_PROC/pressure/io"
# No sampler installed and none beside the script: said so.
mkdir -p "$TMP/alone" && cp "$STATUS" "$TMP/alone/status.sh"
bash "$TMP/alone/status.sh" --host >"$TMP/out" 2>&1 || fail "exited $?"
grep -q "^host sample: unavailable (no $SBX_LIBEXEC_DIR/sbx-sampler.sh: " "$TMP/out" || fail 'a missing sampler is not reported'
pass 'host: one host sample line (the sampler'"'"'s), an error line per failing kind, never the timer'"'"'s state; a missing sampler said so'

# A janitor run that refused its settings writes no JSON line: the service result shows it failed,
# though the last summary in the journal is an older, good one (#554 review).
MOCK_JANITOR_RESULT=exit-code bash "$STATUS" --host --token-ttl-seconds 900 >"$TMP/out" 2>&1 || fail "exited $?"
grep -q '^janitor service: latest run at Mon 2026-10-19 09:00:00 UTC FAILED (exit-code)' "$TMP/out" ||
  fail 'a failed janitor run behind a good summary is not reported'
pass 'host: a janitor run that refused its settings shows as FAILED'

# The wait must exceed the lifetime + 30 s: equal warns, one second more is fine (the boundary).
bash "$STATUS" --host --token-ttl-seconds 3570 >"$TMP/out" 2>&1 || fail "exited $?"
grep -q '^janitor wait: 3600 s; WARNING: not above the token lifetime 3570 s + 30 s' "$TMP/out" || fail 'no warning at wait == ttl + 30'
grep -q 'install-host.sh --janitor' "$TMP/out" || fail 'the warning does not say how to fix it'
bash "$STATUS" --host --token-ttl-seconds 3569 >"$TMP/out" 2>&1 || fail "exited $?"
has 'janitor wait: 3600 s (outlasts the token lifetime 3569 s + 30 s)'
bash "$STATUS" --host >"$TMP/out" 2>&1 || fail "exited $?"
grep -q '^janitor wait: 3600 s (not checked: ' "$TMP/out" || fail 'no note when the lifetime is unknown'
printf 'SBX_JANITOR_AGE=03600\n' >"$SBX_ENV_DIR/janitor.env"
bash "$STATUS" --host --token-ttl-seconds 900 >"$TMP/out" 2>&1 || fail "exited $?"
grep -q '^janitor wait: unreadable' "$TMP/out" || fail 'read a leading-zero wait as a number'
rm "$SBX_ENV_DIR/janitor.env"
: >"$MOCK_DIR/journal"
bash "$STATUS" --host --token-ttl-seconds 900 >"$TMP/out" 2>&1 || fail "exited $?"
has 'janitor wait: not installed'
has 'janitor last run: none in the journal'
! bash "$STATUS" --host --token-ttl-seconds 15m >"$TMP/out" 2>&1 || fail 'accepted a non-numeric lifetime'
pass 'host: the wait warns at <= ttl + 30 s, notes an unknown lifetime, refuses a leading zero, reports none installed'

# The workers' installed idle must exceed the longest lifetime a sandbox can have (#770): the
# workspace reclaim would otherwise take a live sandbox's files. 720h is exactly 2592000 s: warns.
mkdir -p "$SBX_ENV_DIR/workers"
printf 'SH_WORKSPACE_IDLE=768h\n' >"$SBX_ENV_DIR/workers/sbx_a.env"
printf 'X=1\nSH_WORKSPACE_IDLE=216h\n' >"$SBX_ENV_DIR/workers/sbx_b.env"
printf 'SH_WORKSPACE_IDLE=720h\n' >"$SBX_ENV_DIR/workers/sbx_c.env"
printf 'SH_WORKSPACE_IDLE=9d\n' >"$SBX_ENV_DIR/workers/sbx_d.env"
printf 'SH_WORKSPACE_IDLE=0768h\n' >"$SBX_ENV_DIR/workers/sbx_e.env"
printf 'X=1\n' >"$SBX_ENV_DIR/workers/sbx_f.env"
bash "$STATUS" --host --token-ttl-seconds 900 --max-lifetime-seconds 2592000 >"$TMP/out" 2>&1 || fail "exited $?"
has 'worker idle sbx_a: 768h (outlasts the longest lifetime 2592000 s)'
has "worker idle sbx_b: 216h; WARNING: not above the longest lifetime 2592000 s, so this worker can reclaim a live sandbox's workspace: re-run deploy/sbx/install-host.sh with the current bundle"
grep -q '^worker idle sbx_c: 720h; WARNING: not above the longest lifetime 2592000 s' "$TMP/out" || fail 'no warning at idle == maximum'
has 'worker idle sbx_d: unreadable (SH_WORKSPACE_IDLE in '"$SBX_ENV_DIR"'/workers/sbx_d.env is not whole hours)'
grep -q '^worker idle sbx_e: unreadable' "$TMP/out" || fail 'read a leading-zero idle as a number'
has 'worker idle sbx_f: missing (no SH_WORKSPACE_IDLE in '"$SBX_ENV_DIR"'/workers/sbx_f.env)'
bash "$STATUS" --host >"$TMP/out" 2>&1 || fail "exited $?"
has 'worker idle sbx_a: 768h (not checked: the longest lifetime is unknown; pass --max-lifetime-seconds, or run status.sh from the cluster side)'
! bash "$STATUS" --host --max-lifetime-seconds 30d >"$TMP/out" 2>&1 || fail 'accepted a non-numeric maximum'
rc=0; bash "$STATUS" --host --max-lifetime-seconds 30d >"$TMP/out" 2>&1 || rc=$?
[[ "$rc" == 2 ]] || fail "a bad --max-lifetime-seconds exited $rc, not 2"
rm -rf "$SBX_ENV_DIR/workers"
pass 'host: a worker idle warns at <= the longest lifetime, notes an unknown maximum, reports an unreadable idle'

# 6. The cluster side runs the host side on every SBX_STATUS_HOSTS target over ssh, with the
#    cluster's token lifetime, and reports an unreachable host without failing. Piped, the host
#    side has no script path: it runs the installed sampler.
cp "$SRC/deploy/sbx/sampler.sh" "$SBX_LIBEXEC_DIR/sbx-sampler.sh"
printf 'SBX_JANITOR_AGE=900\n' >"$SBX_ENV_DIR/janitor.env"
cp "$MOCK_DIR/journal" "$MOCK_DIR/journal.bak"
printf '%s\n' '{"janitor":"skipped","why":"control plane unreachable; nothing touched"}' >"$MOCK_DIR/journal"
printf 'SBX_STATUS_HOSTS="kvm-a.example.invalid ops@kvm-b.example.invalid"\n' >>"$TMP/sbx.env"
: >"$MOCK_LOG"
MOCK_SSH_FAIL=ops@kvm-b.example.invalid bash "$STATUS" --env-file "$TMP/sbx.env" >"$TMP/out" 2>&1 || fail "exited $?"
has 'host kvm-a.example.invalid unit sbx-worker@sbx_default.service: active'
has 'host kvm-a.example.invalid janitor last run: {"janitor":"skipped","why":"control plane unreachable; nothing touched"}'
grep -q '^host kvm-a.example.invalid janitor wait: 900 s; WARNING: not above the token lifetime 900 s + 30 s' "$TMP/out" ||
  fail 'the stale-bundle warning does not reach the cluster-side report'
has 'host ops@kvm-b.example.invalid: unreachable (ssh exit 255)'
grep -q '^host kvm-a.example.invalid host sample: {"sampler":"sample",' "$TMP/out" || fail 'the piped host side did not run the installed sampler'
grep -q '^ssh -o BatchMode=yes -o ConnectTimeout=10 kvm-a.example.invalid sudo -n bash -s -- --host --token-ttl-seconds 900$' "$MOCK_LOG" ||
  fail 'ssh did not run the host side with the cluster token lifetime'
printf 'SBX_STATUS_HOSTS="-oProxyCommand=evil"\n' >>"$TMP/sbx.env"
! bash "$STATUS" --env-file "$TMP/sbx.env" >"$TMP/out" 2>&1 || fail 'accepted an ssh option as a host'
pass 'cluster: each SBX_STATUS_HOSTS host is reported over ssh with the cluster lifetime; unreachable reported; options refused'

# The cluster side passes the longest lifetime too: SH_SANDBOX_MAX_LIFETIME_SECONDS, else the
# control plane's own fallback, SH_SANDBOX_LIFETIME_SECONDS (#770).
sed -i.bak '$d' "$TMP/sbx.env" && rm -f "$TMP/sbx.env.bak"
printf '{"data":{"SH_SANDBOX_TOKEN_TTL_SECONDS":"900","SH_SANDBOX_MAX_LIFETIME_SECONDS":"2592000","SH_SANDBOX_LIFETIME_SECONDS":"604800"}}\n' >"$MOCK_DIR/settings.json"
: >"$MOCK_LOG"
bash "$STATUS" --env-file "$TMP/sbx.env" >"$TMP/out" 2>&1 || fail "exited $?"
grep -q '^ssh .* kvm-a.example.invalid sudo -n bash -s -- --host --token-ttl-seconds 900 --max-lifetime-seconds 2592000$' "$MOCK_LOG" ||
  fail 'ssh did not pass the maximum lifetime'
printf '{"data":{"SH_SANDBOX_TOKEN_TTL_SECONDS":"900","SH_SANDBOX_LIFETIME_SECONDS":"604800"}}\n' >"$MOCK_DIR/settings.json"
: >"$MOCK_LOG"
bash "$STATUS" --env-file "$TMP/sbx.env" >"$TMP/out" 2>&1 || fail "exited $?"
grep -q '^ssh .* kvm-a.example.invalid sudo -n bash -s -- --host --token-ttl-seconds 900 --max-lifetime-seconds 604800$' "$MOCK_LOG" ||
  fail 'ssh did not fall back to the default lifetime'
# The longest lifetime known, the token lifetime not: the host side still runs, with the maximum only.
printf '{"data":{"SH_SANDBOX_MAX_LIFETIME_SECONDS":"2592000"}}\n' >"$MOCK_DIR/settings.json"
: >"$MOCK_LOG"
bash "$STATUS" --env-file "$TMP/sbx.env" >"$TMP/out" 2>&1 || fail "exited $?"
grep -q '^ssh .* kvm-a.example.invalid sudo -n bash -s -- --host --max-lifetime-seconds 2592000$' "$MOCK_LOG" ||
  fail 'ssh did not pass the maximum alone when the token lifetime is unknown'
! grep -q '^host kvm-a.example.invalid: unreachable' "$TMP/out" || fail 'the host side did not run with the maximum alone'
grep -q '^host kvm-a.example.invalid janitor wait: .*not checked: the token lifetime is unknown' "$TMP/out" ||
  fail 'the host side with the maximum alone does not note the unknown token lifetime'
pass 'cluster: the longest lifetime is passed to the host side, falling back to SH_SANDBOX_LIFETIME_SECONDS'
