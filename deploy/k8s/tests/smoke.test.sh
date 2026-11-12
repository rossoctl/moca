#!/usr/bin/env bash
# Cluster-free tests for deploy/k8s/smoke.sh's own failure handling (#423): the runs that fail are
# the ones whose logs matter, so none of them may delete $OUT, and a kubectl error in a claim must
# become a FAIL line and the summary, not a set -e death before it. kubectl, curl and sleep are
# mocks on PATH; every other tool is the real one.
set -euo pipefail
# An operator's exported values must not reach the runs below (P7 expects them unset), as in setup.test.sh.
unset SH_SANDBOX_COUNT SH_SANDBOX_DEFAULT_TIER

SMOKE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/smoke.sh"
# The bash that launched this suite, not the first one on PATH (#440), as in setup.test.sh:
# `/bin/bash smoke.test.sh` on macOS must exercise bash 3.2, which is what operators run
# smoke.sh with. $BASH is the running interpreter; the fallback is for a sourced run.
REAL_BASH="${BASH:-$(command -v bash)}"
TMP="$(mktemp -d)"
# Every log dir a run kept, removed at exit (runs happen in subshells, so a variable would not do).
cleanup() {
  local d
  if [[ -f "$TMP/kept" ]]; then while IFS= read -r d; do rm -rf "$d"; done <"$TMP/kept"; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
mkdir -p "$TMP/bin"
export MOCK_STATE="$TMP/state"

fail() {
  echo "FAIL: $*" >&2
  [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2
  exit 1
}
pass() { echo "ok - $*"; }

cat >"$TMP/bin/sleep" <<'MOCK'
#!/bin/sh
exit 0
MOCK

# curl: /healthz succeeds for the first $MOCK_HEALTHZ_OK calls (default: always). /v1/sessions, when
# MOCK_SESSIONS=1, appends its request body to $MOCK_STATE/sessions.log and returns the next session
# of a counter (s1, s2, ...). /v1/turn streams the file $MOCK_TURN_SSE when it is set; otherwise, with
# MOCK_SESSIONS=1, it builds the turn from its request body: one bash tool_result, then the done
# frame of the request's sessionId. A K8S-SMOKE-WHERE-1 turn prints where=<host>, its host the
# session's entry in MOCK_WHERE ("s5=moca-sandbox-0 s6=..."); a K8S-SMOKE-WHERE-2 turn reads
# MOCK_WHERE_2 first, so a case can move one session's second turn. MOCK_ENVELOPE=1 wraps the
# preview in the JSON envelope a real model's run carries (see p4_sse below). Every turn's prompt is
# appended to $MOCK_STATE/prompts.log. MOCK_SESSIONS_DOWN=N: once claim 10 has deleted redis-0 (the
# kubectl mock's $MOCK_STATE/redis-restarted), the next N session POSTs fail, as a stack still
# reconnecting to Redis does. Claim M1: a session POST's "model" and a PATCH /v1/sessions/<id> set the
# model the next turn reports (a K8S-SMOKE-MODEL turn prints model=<it>, as the mock gateway does);
# MOCK_PATCH_IGNORED=1 answers the PATCH 200 but keeps the old model. /metrics answers MOCK_METRICS
# verbatim (claim 13's arming check). Everything else is a refused connection.
cat >"$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
url='' data='' prev='' ofile='' wfmt=''
for a in "$@"; do
  [[ "$prev" != -d ]] || data="$a"
  [[ "$prev" != -o ]] || ofile="$a"
  [[ "$prev" != -w ]] || wfmt="$a"
  [[ "$a" != http* ]] || url="$a"
  prev="$a"
done
case "$url" in
*/healthz)
  n=$(($(cat "$MOCK_STATE/healthz" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$MOCK_STATE/healthz"
  [[ "$n" -le "${MOCK_HEALTHZ_OK:-1000}" ]] ;;
*/v1/sessions)
  [[ "${MOCK_SESSIONS-}" == 1 ]] || exit 7
  if [[ -f "$MOCK_STATE/redis-restarted" ]]; then
    d=$(($(cat "$MOCK_STATE/sessions-down" 2>/dev/null || echo 0) + 1))
    echo "$d" >"$MOCK_STATE/sessions-down"
    [[ "$d" -gt "${MOCK_SESSIONS_DOWN:-0}" ]] || { echo '{"error":"redis: connection lost"}'; exit 0; }
  fi
  printf '%s\n' "$data" >>"$MOCK_STATE/sessions.log"
  jq -r '.model // empty' <<<"$data" >"$MOCK_STATE/model"
  n=$(($(cat "$MOCK_STATE/sessions" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$MOCK_STATE/sessions"
  echo "{\"sessionId\":\"s$n\",\"token\":\"t$n\"}" ;;
*/v1/sessions/*)
  [[ "${MOCK_SESSIONS-}" == 1 ]] || exit 7
  printf '%s\n' "$data" >>"$MOCK_STATE/patches.log"
  [[ -n "${MOCK_PATCH_IGNORED-}" ]] || jq -r '.model // empty' <<<"$data" >"$MOCK_STATE/model"
  body="$(jq -nc --arg s "${url##*/}" --arg m "$(cat "$MOCK_STATE/model")" '{sessionId: $s, model: $m}')"
  if [[ -n "$ofile" ]]; then printf '%s' "$body" >"$ofile"; else printf '%s' "$body"; fi
  [[ "$wfmt" != '%{http_code}' ]] || printf '200' ;;
*/v1/turn)
  if [[ -n "${MOCK_TURN_SSE-}" ]]; then cat "$MOCK_TURN_SSE"; exit 0; fi
  [[ "${MOCK_SESSIONS-}" == 1 ]] || exit 7
  sid="$(jq -r .sessionId <<<"$data")"
  prompt="$(jq -r .prompt <<<"$data")"
  printf '%s\n' "$prompt" >>"$MOCK_STATE/prompts.log"
  case "$prompt" in
  *K8S-SMOKE-WHERE-2*) table="${MOCK_WHERE_2-} ${MOCK_WHERE-}" ;;
  *K8S-SMOKE-WHERE-1*) table="${MOCK_WHERE-}" ;;
  *) table='' ;;
  esac
  text='ran'
  [[ "$prompt" != *K8S-SMOKE-MODEL* ]] || text="model=$(cat "$MOCK_STATE/model" 2>/dev/null)"
  for kv in $table; do
    [[ "${kv%%=*}" != "$sid" ]] || { text="where=${kv#*=}"; break; }
  done
  jq -nc --arg t "$text" --arg env "${MOCK_ENVELOPE-}" \
    '{type: "tool_result", preview: (if $env == "1" then {content: [{type: "text", text: ($t + "\n")}]} | tojson else $t end)}' |
    sed 's/^/data: /'
  jq -nc --arg s "$sid" '{type: "done", sessionId: $s}' | sed 's/^/data: /' ;;
*/metrics) printf '%s' "${MOCK_METRICS-}" ;;
*) exit 7 ;;
esac
MOCK

cat >"$TMP/bin/kubectl" <<'MOCK'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >>"$MOCK_STATE/kubectl.log"
case " $* " in
*" port-forward "*) exit 0 ;;
*" exec deploy/moca-control-plane "*) printf 'api.token.not-a-secret' ;;
*" exec moca-sandbox-0 "*) echo BLOCKED ;;
*"HGET sh:sandbox:records"*) printf '%s' "${MOCK_P4_RECORD-}" ;;
*" exec redis-0 "*) printf '%s' "${MOCK_REDIS_OUT-}" ;;
*" exec deploy/sandbox-relay "*) exit 0 ;;
*" get statefulset "*) echo 1 ;;
*"SH_SANDBOX_TIERS"*)
  [[ -z "${MOCK_SETTINGS_CM_FAIL-}" ]] || { echo 'Error from server (Forbidden): configmaps "moca-settings" is forbidden' >&2; exit 1; }
  printf '%s' "${MOCK_TIERS-}" ;;
*"SH_ASYNC_DRAIN"*)
  [[ -z "${MOCK_SETTINGS_CM_FAIL-}" ]] || { echo 'Error from server (Forbidden): configmaps "moca-settings" is forbidden' >&2; exit 1; }
  printf '%s' "${MOCK_ASYNC_DRAIN-}" ;;
*" get configmap moca-setup "*)
  [[ -z "${MOCK_SETUP_CM_FAIL-}" ]] || { echo 'Error from server (Forbidden): configmaps "moca-setup" is forbidden' >&2; exit 1; }
  printf '%s' "${MOCK_P4_IDS-moca_microvm_0}" ;;
*" get route moca-relay "*) echo moca-relay-moca.apps.example.test ;;
*" get secret moca-relay "*) jq -n '{data: {MOCA_RELAY_EXEC_TOKEN: ("exec-token-must-stay-off-argv-0123" | @base64)}}' ;;
*" get secret moca-relay-tls "*) jq -n '{data: {"tls.crt": ("-----BEGIN CERTIFICATE-----" | @base64)}}' ;;
*" exec -i deploy/moca-control-plane "*) cat >"$MOCK_STATE/probe.stdin"; echo "${MOCK_PROBE_OUT-attach=0 exec=12}" ;;
*" get nodes "*) echo 5.14.0-427.el9.x86_64 ;;
*" get configmap "*) echo http://127.0.0.1:8080 ;;
*" get pods -l "*) echo '{"items":[{"metadata":{"name":"moca-supervisor-x"}}]}' ;;
*" delete pod redis-0 "*)
  [[ -z "${MOCK_REDIS_DELETE_FAIL-}" ]] || { echo 'Error from server (Forbidden): pods "redis-0" is forbidden' >&2; exit 1; }
  : >"$MOCK_STATE/redis-restarted" ;;
*" delete pod "* | *" rollout status "*) exit 0 ;;
*" get pods "*)
  [[ -z "${MOCK_GET_PODS_FAIL-}" ]] || { echo 'Unable to connect to the server: dial tcp: i/o timeout' >&2; exit 1; }
  echo '{"items":[]}' ;;
*) echo "mock kubectl: unhandled: $*" >&2; exit 2 ;;
esac
MOCK
chmod +x "$TMP/bin/sleep" "$TMP/bin/curl" "$TMP/bin/kubectl"
# The bash mocks are heredocs with `#!/usr/bin/env bash`, which resolves against the run's PATH --
# $TMP/bin first, then the caller's, so it would find Homebrew's 5.x even when this suite was
# launched with /bin/bash. Pin them to $REAL_BASH so the mocks run on the same interpreter as the
# script under test (#440). The `#!/bin/sh` shims need no pin: they exec an absolute real binary.
for m in curl kubectl; do
  { printf '#!%s\n' "$REAL_BASH"; tail -n +2 "$TMP/bin/$m"; } >"$TMP/bin/$m.new"
  mv "$TMP/bin/$m.new" "$TMP/bin/$m"
  chmod +x "$TMP/bin/$m"
done

# run_smoke: the caller's exported MOCK_* shape the run; sets RC and KEPT_DIR.
run_smoke() {
  rm -rf "$MOCK_STATE"
  mkdir -p "$MOCK_STATE"
  local args=("$@")
  [[ $# -gt 0 ]] || args=(--target kind-ci)
  if PATH="$TMP/bin:$PATH" K8S_LIVE_SMOKE=1 "$REAL_BASH" "$SMOKE" "${args[@]}" >"$TMP/out" 2>&1; then RC=0; else RC=$?; fi
  KEPT_DIR="$(sed -n 's/^logs kept in //p' "$TMP/out" | tail -1)"
  [[ -z "$KEPT_DIR" ]] || printf '%s\n' "$KEPT_DIR" >>"$TMP/kept"
}
expect_out() { grep -qF -- "$1" "$TMP/out" || fail "output lacks: $1"; }
expect_kept() {
  [[ -n "$KEPT_DIR" && -d "$KEPT_DIR" ]] || fail "a failed run deleted its logs ($1)"
  [[ -z "$(find "$KEPT_DIR" -name '*.hdr')" ]] || fail "a kept log dir still holds a token header file ($1)"
}

echo "== smoke.sh failure handling"
(export MOCK_HEALTHZ_OK=0; run_smoke; [[ "$RC" != 0 ]] || fail 'a port-forward that never came up exited 0'
  expect_out 'port-forward to the supervisor never came up'
  expect_kept 'port-forward never came up'
  [[ -f "$KEPT_DIR/pf-sup.log" ]] || fail 'the port-forward log is not among the kept logs')
pass 'an early exit (port-forward never up, FAIL still 0) keeps its logs'

(export MOCK_REDIS_DELETE_FAIL=1 MOCK_GET_PODS_FAIL=1; run_smoke; [[ "$RC" != 0 ]] || fail 'a failing run exited 0'
  expect_out 'Claim 11'
  expect_out 'PASS='
  grep -E '^  FAIL .*redis' "$TMP/out" | grep -q . || fail 'claim 10 kubectl error did not become a FAIL line'
  grep -E '^  FAIL .*restart' "$TMP/out" | grep -q . || fail 'claim 11 kubectl error did not become a FAIL line'
  expect_kept 'claims 10 and 11')
pass 'a kubectl error in claims 10 and 11 becomes FAIL lines and the summary, logs kept, no *.hdr left'

(export MOCK_SESSIONS=1 MOCK_HEALTHZ_OK=2; run_smoke; [[ "$RC" != 0 ]] || fail 'a failing run exited 0'
  grep -q 'port-forward' <(grep -E '^  FAIL' "$TMP/out") || fail 'the post-drain forward failure did not become a FAIL line'
  expect_out 'Claim 10'
  expect_out 'PASS='
  expect_kept 'post-drain forward')
pass 'a post-drain port-forward that never comes back is a FAIL, and the run reaches the summary'

if out="$("$REAL_BASH" "$SMOKE" 2>&1)" && [[ "$out" == SKIP:* ]]; then pass 'without K8S_LIVE_SMOKE=1 it SKIPs'; else fail "no SKIP without K8S_LIVE_SMOKE: $out"; fi

rc=0
out="$(K8S_LIVE_SMOKE=1 PATH="$TMP/bin:$PATH" "$REAL_BASH" "$SMOKE" --target 2>&1)" || rc=$?
[[ "$rc" == 2 && "$out" == *'--target needs a value'* ]] || fail "--target with no value: rc=$rc out=$out"
pass '--target with no value exits 2 and says why'

echo "== --tier p4 (#424)"
for bad in "--tier p4 --target kind-ci" "--tier bogus --target ocp" "--target ocp --tier"; do
  rc=0
  # shellcheck disable=SC2086 # word-split on purpose: each case is an argv
  out="$(K8S_LIVE_SMOKE=1 PATH="$TMP/bin:$PATH" "$REAL_BASH" "$SMOKE" $bad 2>&1)" || rc=$?
  [[ "$rc" == 2 ]] || fail "'$bad' exited $rc, want 2: $out"
done
rc=0
out="$(K8S_LIVE_SMOKE=1 PATH="$TMP/bin:$PATH" "$REAL_BASH" "$SMOKE" --tier p4 --target kind-ci 2>&1)" || rc=$?
[[ "$out" == *'--tier p4 needs --target ocp'* ]] || fail "--tier p4 on kind-ci does not say why: $out"
rc=0
out="$(K8S_LIVE_SMOKE=1 SMOKE_P4_ADD_ID=bad-id PATH="$TMP/bin:$PATH" "$REAL_BASH" "$SMOKE" --target ocp --tier p4 2>&1)" || rc=$?
[[ "$rc" == 2 && "$out" == *'SMOKE_P4_ADD_ID'* ]] || fail "a dashed SMOKE_P4_ADD_ID was not refused: rc=$rc $out"
pass '--tier: p4 needs ocp, an unknown tier and a missing value exit 2, a bad SMOKE_P4_ADD_ID exits 2'

(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real MOCK_REDIS_OUT=moca_microvm_0
  run_smoke --target ocp --tier p4
  [[ "$RC" != 0 ]] || fail 'a p4 run whose turns fail exited 0'
  grep -q '^  ok attached: moca_microvm_0' "$TMP/out" || fail 'claim P2 did not pass with the P4 record present'
  grep -q '^  ok .*attach=0 exec=12' "$TMP/out" || fail 'claim P6 did not pass on attach=0 exec=12'
  grep -qF 'exec-token-must-stay-off-argv' "$MOCK_STATE/probe.stdin" || fail 'the probe did not get the exec token on stdin'
  ! grep -qF 'exec-token-must-stay-off-argv' "$MOCK_STATE/kubectl.log" || fail 'the exec token reached a kubectl argv'
  expect_out 'skipped: set SMOKE_P4_ADD_ID'
  expect_out 'Claim P3'
  expect_out 'PASS='
  ! grep -qE 'Claim (7|8|9|10|11|12):' "$TMP/out" || fail 'the p4 tier ran container-tier claims'
  expect_kept 'p4 tier')
pass 'p4 tier: P2 reads moca-setup and the records, P6 passes the exec token on stdin only, P7 is skipped, no container claims'

(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real \
  MOCK_REDIS_OUT=$'moca_microvm_0\nmoca-sandbox-0' MOCK_PROBE_OUT='attach=14 exec=14'
  run_smoke --target ocp --tier p4
  grep -qE '^  FAIL container sandboxes attached alongside P4' "$TMP/out" || fail 'a container record beside P4 did not fail claim P2'
  grep -qE '^  FAIL probe: .attach=14' "$TMP/out" || fail 'an UNAVAILABLE attach (TLS/dial failure) did not fail claim P6')
pass 'p4 tier: a container record fails P2; an attach that never reached the relay (14) fails P6'

(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real MOCK_SETUP_CM_FAIL=1
  run_smoke --target ocp --tier p4
  grep -qE '^  FAIL could not read configmap moca-setup' "$TMP/out" || fail 'a failed moca-setup read was not reported as a read failure'
  ! grep -qF 'holds no SH_P4_SANDBOX_IDS' "$TMP/out" || fail 'a failed moca-setup read was reported as an empty SH_P4_SANDBOX_IDS'
  expect_out 'PASS=')
pass 'p4 tier: a failed read of moca-setup is a read failure in P2, not an empty SH_P4_SANDBOX_IDS'

# moca-setup's value comes from the cluster, not from setup.sh's validated input (#437 review): a
# tampered entry is reported as an invalid id, never glob-expanded against the smoke's cwd.
(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real \
  MOCK_REDIS_OUT=moca_microvm_0 MOCK_P4_IDS='moca_microvm_0,*'
  run_smoke --target ocp --tier p4
  grep -qF "  FAIL moca-setup SH_P4_SANDBOX_IDS holds invalid id(s): '*'" "$TMP/out" ||
    fail "a '*' in moca-setup was not reported as an invalid id: $(grep -A1 'Claim P2' "$TMP/out" | tail -1)"
  ! grep -qE '^  FAIL not in sh:sandbox:records' "$TMP/out" || fail "a '*' in moca-setup was glob-expanded into ids")
pass 'p4 tier: P2 splits the cluster-held id list without globbing, and refuses an invalid id'

# A real model's tool_result preview is a JSON envelope, not plain text (live run, #424): P3 must
# read the kernel out of .content[].text, not compare the whole envelope against the nodes'.
# p4_sse FILE TEXT: an SSE turn whose bash result is TEXT, wrapped as the live run saw it.
p4_sse() {
  jq -nc --arg t "$2" '{type: "tool_result", preview: ({content: [{type: "text", text: $t}]} | tojson)}' |
    sed 's/^/data: /' >"$1"
  echo 'data: {"type":"done","sessionId":"s1"}' >>"$1"
}
cat >"$TMP/guest.sse" <<'SSE'
data: {"type":"tool_result","preview":"{\"content\":[{\"type\":\"text\",\"text\":\"6.18.44+\\np4-proof\\n\"}]}"}
data: {"type":"done","sessionId":"s1"}
SSE
p4_sse "$TMP/guest-built.sse" $'6.18.44+\np4-proof\n'
cmp -s "$TMP/guest.sse" "$TMP/guest-built.sse" || fail 'the literal envelope fixture is not the live format p4_sse builds'
p4_sse "$TMP/node.sse" $'5.14.0-427.el9.x86_64\np4-proof\n'
(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real MOCK_REDIS_OUT=moca_microvm_0 \
  MOCK_SESSIONS=1 MOCK_TURN_SSE="$TMP/guest.sse"
  run_smoke --target ocp --tier p4
  grep -qE '^  ok session s1 ran on kernel 6\.18\.44\+ \(nodes run 5\.14\.0-427\.el9\.x86_64\)$' "$TMP/out" ||
    fail 'P3 did not pass naming the guest kernel 6.18.44+ out of the JSON envelope')
pass 'p4 tier: P3 reads the guest kernel out of a JSON-envelope preview and passes naming it'

(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real MOCK_REDIS_OUT=moca_microvm_0 \
  MOCK_SESSIONS=1 MOCK_TURN_SSE="$TMP/node.sse"
  run_smoke --target ocp --tier p4
  ! grep -qE '^  ok session s1 ran on kernel' "$TMP/out" || fail 'P3 passed on a turn that ran on a node kernel'
  grep -qE "^  FAIL the turn's kernel '5\.14\.0-427\.el9\.x86_64'" "$TMP/out" ||
    fail 'P3 did not FAIL naming the node kernel read out of the envelope')
pass 'p4 tier: P3 FAILs when the envelope text is a node kernel'

echo "== claim M1: a session's model is switched with PATCH (per-session model selection)"
m1() { sed -n '/Claim M1:/,/^--- /p' "$TMP/out"; }
(export MOCK_SESSIONS=1
  run_smoke
  m1 | grep -qx '  ok session s2 switched to mock-b and its turn reached the gateway as mock-b' ||
    fail "claim M1 did not pass when the PATCH took effect: $(m1)"
  [[ "$(cat "$MOCK_STATE/patches.log")" == '{"model":"mock-b"}' ]] || fail "claim M1 did not PATCH to mock-b: $(cat "$MOCK_STATE/patches.log")")
pass 'claim M1: created on mock-a, PATCHed to mock-b, and the turn carries mock-b'

(export MOCK_SESSIONS=1 MOCK_PATCH_IGNORED=1
  run_smoke
  m1 | grep -qF '  FAIL model turn:' || fail "claim M1 passed though the turn still carried mock-a: $(m1)")
pass 'claim M1: a PATCH that does not reach the turn is a FAIL'

echo "== claim 12: a session returns to its sandbox (P6.3, #425)"
# Sessions are numbered across the run: claims 3, M1, 8 and 9 take s1-s4, so claim 12's four are s5-s8.
SPREAD='s5=moca-sandbox-0 s6=moca-sandbox-1 s7=moca-sandbox-0 s8=moca-sandbox-1'
claim12() { sed -n '/Claim 12:/,/^PASS=/p' "$TMP/out"; }
(export MOCK_SESSIONS=1 MOCK_ENVELOPE=1 MOCK_WHERE="$SPREAD"
  run_smoke
  claim12 | grep -qx '  ok 4 sessions, each on one sandbox for both turns' ||
    fail "claim 12 did not pass with every second turn on its first turn's sandbox: $(claim12)"
  ! grep -qF 'could not tell affinity from luck' "$TMP/out" || fail 'a spread run printed the luck note'
  # Claim M1's own session adds a model; every other session posts {}.
  [[ "$(grep -v '"model"' "$MOCK_STATE/sessions.log" | sort -u)" == '{}' ]] ||
    fail "an untiered stack's sessions did not post {}: $(sort -u "$MOCK_STATE/sessions.log" | tr '\n' ' ')"
  [[ "$(grep '"model"' "$MOCK_STATE/sessions.log")" == '{"model":"mock-a"}' ]] ||
    fail "claim M1 did not create its session on mock-a: $(grep model "$MOCK_STATE/sessions.log")")
pass 'claim 12: first turns on two sandboxes, each second turn on its first: ok, no luck note; untiered sessions post {}'

# The first turns must overlap for least-loaded to spread them: each holds its lease for 2 s. The
# second turns run one at a time, and need no hold.
(export MOCK_SESSIONS=1 MOCK_WHERE="$SPREAD"
  run_smoke
  [[ "$(grep -c 'K8S-SMOKE-WHERE-1' "$MOCK_STATE/prompts.log")" == 4 &&
    "$(grep 'K8S-SMOKE-WHERE-1' "$MOCK_STATE/prompts.log" | grep -cF 'sleep 2; echo "where=$HOSTNAME"')" == 4 ]] ||
    fail "the first turns do not hold their lease (sleep 2): $(grep WHERE-1 "$MOCK_STATE/prompts.log" | head -1)"
  [[ "$(grep -c 'K8S-SMOKE-WHERE-2' "$MOCK_STATE/prompts.log")" == 4 &&
    "$(grep 'K8S-SMOKE-WHERE-2' "$MOCK_STATE/prompts.log" | grep -c 'sleep')" == 0 ]] ||
    fail "the second turns are not a bare echo: $(grep WHERE-2 "$MOCK_STATE/prompts.log" | head -1)")
pass 'claim 12: each first turn holds its lease (sleep 2; echo ...), each second turn is a bare echo'

# The live run's model is deploy/microvm/mock-anthropic.mjs: its steps must be the commands smoke.sh asks for.
MOCK_MJS="$(cd "$(dirname "$SMOKE")/../microvm" && pwd)/mock-anthropic.mjs"
for m in WHERE-1 WHERE-2 ASYNC ASYNC-SLOW; do
  asked="$(sed -n "s/.*ask K8S-SMOKE-$m '\([^']*\)'.*/\1/p" "$SMOKE")"
  scripted="$(sed -n "s/.*'K8S-SMOKE-$m': { steps: \['\([^']*\)'\].*/\1/p" "$MOCK_MJS")"
  [[ -n "$asked" && "$asked" == "$scripted" ]] ||
    fail "K8S-SMOKE-$m: smoke.sh asks for '$asked', mock-anthropic.mjs runs '$scripted'"
done
pass "claims 12-14: mock-anthropic.mjs scripts exactly the commands smoke.sh asks for"

# Claim 10 restarts Redis; claim 12 must not start until the stack takes a session again.
(export MOCK_SESSIONS=1 MOCK_ENVELOPE=1 MOCK_WHERE="$SPREAD" MOCK_SESSIONS_DOWN=3
  run_smoke
  [[ "$(cat "$MOCK_STATE/sessions-down")" -ge 4 ]] || fail "claim 12 did not retry the session POST: $(claim12)"
  claim12 | grep -qx '  ok 4 sessions, each on one sandbox for both turns' ||
    fail "claim 12 did not pass once the stack took sessions again: $(claim12)")
pass 'claim 12: waits for the stack to take a session after the Redis restart, then runs'

(export MOCK_SESSIONS=1 MOCK_WHERE="$SPREAD" MOCK_SESSIONS_DOWN=100000
  run_smoke
  claim12 | grep -qF '  FAIL the stack took no new session within 60s of the Redis restart (claim 10)' ||
    fail "a stack that never took a session again did not fail claim 12, saying so: $(claim12)"
  ! grep -q 'K8S-SMOKE-WHERE' "$MOCK_STATE/prompts.log" 2>/dev/null || fail 'claim 12 ran turns without sessions'
  expect_kept 'claim 12 wait timed out')
pass 'claim 12: a stack that takes no session within 60 s of the Redis restart FAILs, saying so'

(export MOCK_SESSIONS=1 MOCK_WHERE="$SPREAD" MOCK_WHERE_2='s7=moca-sandbox-1'
  run_smoke
  claim12 | grep -qx '  FAIL a session moved between sandboxes, or a turn failed' ||
    fail "a session that moved did not fail claim 12: $(claim12)"
  claim12 | grep -qF "session s7: first 'moca-sandbox-0', then 'moca-sandbox-1'" ||
    fail "claim 12 did not name the session that moved: $(claim12)"
  expect_kept 'claim 12 moved')
pass 'claim 12: a second turn on the other sandbox fails, naming the session and both sandboxes'

(export MOCK_SESSIONS=1 MOCK_WHERE='s5=moca-sandbox-0 s6=moca-sandbox-0 s7=moca-sandbox-0 s8=moca-sandbox-0'
  run_smoke
  claim12 | grep -qx '  ok 4 sessions, each on one sandbox for both turns' || fail "claim 12 did not pass on one sandbox: $(claim12)"
  claim12 | grep -qF 'note the first turns all landed on one sandbox, so this run could not tell affinity from luck' ||
    fail "first turns on one sandbox did not print the luck note: $(claim12)")
pass 'claim 12: first turns all on one sandbox pass with the luck note'

(export MOCK_SESSIONS=1
  run_smoke
  claim12 | grep -qx '  FAIL a session moved between sandboxes, or a turn failed' ||
    fail "turns that printed no where= did not fail claim 12: $(claim12)"
  # Spread 0 here, but the luck note qualifies a PASS only: on a FAIL it would only mislead.
  ! grep -qF 'could not tell affinity from luck' "$TMP/out" || fail "a failed claim 12 printed the luck note: $(claim12)")
pass 'claim 12: a turn that reports no sandbox is a FAIL, not a match of two empty names, and prints no luck note'

(export MOCK_SESSIONS=1 SH_SINGLE_NAMESPACE=moca-single SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real
  run_smoke --target ocp-single
  grep -qF 'kubectl -n moca-single get configmap moca-settings -o jsonpath={.data.SH_SANDBOX_TIERS}' "$MOCK_STATE/kubectl.log" ||
    fail "ocp-single did not read the tiers from its own namespace's moca-settings"
  [[ "$(sort -u "$MOCK_STATE/sessions.log")" == '{}' ]] ||
    fail "ocp-single's sessions did not post {}: $(sort -u "$MOCK_STATE/sessions.log" | tr '\n' ' ')"
  ! grep -qF 'tiered' "$TMP/out" || fail 'an untiered ocp-single run printed a tier note')
pass 'ocp-single (never tiered): every session posts {}'

echo "== a tiered stack (P6.3, #425)"
(export MOCK_SESSIONS=1 MOCK_TIERS=container,microvm MOCK_WHERE="$SPREAD"
  run_smoke
  [[ "$(grep -v '"model"' "$MOCK_STATE/sessions.log" | sort -u)" == '{"sandbox":{"tier":"container"}}' ]] ||
    fail "a tiered container smoke did not ask for the container tier: $(sort -u "$MOCK_STATE/sessions.log" | tr '\n' ' ')"
  [[ "$(grep '"model"' "$MOCK_STATE/sessions.log")" == '{"sandbox":{"tier":"container"},"model":"mock-a"}' ]] ||
    fail "claim M1 dropped the tier from its session: $(grep model "$MOCK_STATE/sessions.log")"
  expect_out 'note this stack is tiered (container,microvm): every session asks for the container tier')
pass 'tiered: the container smoke creates container-tier sessions and says so'

P4_REC='{"sandboxId":"moca_microvm_0","labels":{"moca.dev/tier":"microvm"},"capabilities":[],"capacityMax":4,"transport":"grpc"}'
(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real MOCK_SESSIONS=1 \
  MOCK_TIERS=container,microvm MOCK_REDIS_OUT=$'moca_microvm_0\nmoca-sandbox-0\nmoca-sandbox-1' MOCK_P4_RECORD="$P4_REC"
  run_smoke --target ocp --tier p4
  [[ "$(sort -u "$MOCK_STATE/sessions.log")" == '{"sandbox":{"tier":"microvm"}}' ]] ||
    fail "a tiered p4 smoke did not ask for the microvm tier: $(sort -u "$MOCK_STATE/sessions.log" | tr '\n' ' ')"
  grep -qx '  ok attached: moca_microvm_0, each advertising moca.dev/tier=microvm (container sandboxes beside them: moca-sandbox-0 moca-sandbox-1)' "$TMP/out" ||
    fail "P2 did not pass on a tiered stack with labelled P4 records and containers: $(grep -A1 'Claim P2' "$TMP/out" | tail -1)"
  grep -qF "HGET sh:sandbox:records 'moca_microvm_0'" "$MOCK_STATE/kubectl.log" || fail "P2 did not read moca_microvm_0's record")
pass 'tiered p4: sessions ask for microvm; P2 passes with containers attached and the P4 record labelled microvm'

(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real \
  MOCK_TIERS=container,microvm MOCK_REDIS_OUT=$'moca_microvm_0\nmoca-sandbox-0' \
  MOCK_P4_RECORD='{"sandboxId":"moca_microvm_0","labels":{},"capabilities":[],"capacityMax":4,"transport":"grpc"}'
  run_smoke --target ocp --tier p4
  grep -qx "  FAIL P4 record(s) not advertising moca.dev/tier=microvm: moca_microvm_0 (tier '') (a P6.3 microvm-worker advertises it; an older one gets no sessions on a tiered stack)" "$TMP/out" ||
    fail "a P4 record without the tier label did not fail P2: $(grep -A1 'Claim P2' "$TMP/out" | tail -1)")
pass 'tiered p4: a P4 record without moca.dev/tier fails P2, naming the id and what it advertised'

(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real MOCK_SESSIONS=1 \
  MOCK_SETTINGS_CM_FAIL=1 MOCK_REDIS_OUT=moca_microvm_0 MOCK_P4_RECORD="$P4_REC"
  run_smoke --target ocp --tier p4
  [[ "$RC" != 0 ]] || fail 'a run that could not read the stack tiers exited 0'
  grep -qE '^  FAIL could not read configmap moca-settings .*forbidden' "$TMP/out" ||
    fail 'a failed moca-settings read was not a FAIL quoting the error'
  grep -qF '  FAIL could not tell whether this stack is tiered' "$TMP/out" ||
    fail "P2 judged a stack whose tiers it could not read: $(grep -A1 'Claim P2' "$TMP/out" | tail -1)"
  ! grep -qE '^  ok attached' "$TMP/out" || fail 'P2 passed without knowing whether the stack is tiered'
  [[ "$(sort -u "$MOCK_STATE/sessions.log")" == '{}' ]] || fail 'an unreadable moca-settings did not fall back to {} sessions'
  ! grep -q 'Claim 13' "$TMP/out" || fail 'the p4 tier run reached the container-tier async claims')
pass 'an unreadable moca-settings is a FAIL (quoted), P2 does not judge it, sessions post {}'

# The drain knob follows the same rule as the tiers above, but claim 13 only exists on the container
# path (--tier p4 ends at the summary): an unreadable ConfigMap cannot say "SH_ASYNC_DRAIN is unset",
# so claim 13 must FAIL rather than skip itself as though the consumer were off on purpose.
(export MOCK_SETTINGS_CM_FAIL=1
  run_smoke
  grep -qE '^  FAIL could not read configmap moca-settings \(SH_ASYNC_DRAIN\)' "$TMP/out" ||
    fail "an unreadable moca-settings let claim 13 skip as though the drain were off: $(grep -A1 'Claim 13' "$TMP/out" | tail -1)"
  grep -qF '  note no drain on this stack (claim 13 says why): skipped' "$TMP/out" ||
    fail "claim 14 did not defer to claim 13's verdict: $(grep -A1 'Claim 14' "$TMP/out" | tail -1)")
pass 'an unreadable moca-settings FAILs claim 13 rather than skipping it, and claim 14 defers to it'

# Opt-in: no SH_ASYNC_DRAIN key means the stack runs no drain, which is a SKIP, not a FAIL.
(export MOCK_TIERS=container MOCK_SESSIONS=1 MOCK_WHERE="$SPREAD"
  run_smoke
  grep -qF '  note SH_ASYNC_DRAIN is unset on this stack' "$TMP/out" ||
    fail "an absent SH_ASYNC_DRAIN did not skip claim 13: $(grep -A1 'Claim 13' "$TMP/out" | tail -1)"
  ! grep -qE '^  (FAIL|ok).*async' "$TMP/out" || fail 'claim 13 judged a stack that runs no drain')
pass 'a stack without SH_ASYNC_DRAIN skips claims 13 and 14 instead of failing them'

# Claim 13's arming check wants a NUMBER, not "anything but NaN": a supervisor whose /metrics has no
# such key reads as `null` through jq, and an unreachable admin port as empty. Neither says a worker
# armed, so neither may pass -- and the FAIL must not blame the ConfigMap for an unreachable port.
(export MOCK_TIERS=container MOCK_SESSIONS=1 MOCK_WHERE="$SPREAD" MOCK_ASYNC_DRAIN=1
  export MOCK_METRICS='{"counters":{}}'
  run_smoke
  grep -qF "FAIL the admin port answered async_queue_depth='null', not a number" "$TMP/out" ||
    fail "a /metrics without the gauge passed claim 13's arming check: $(grep -A1 'Claim 13' "$TMP/out" | tail -1)"
  export MOCK_METRICS=''
  run_smoke
  grep -qF "FAIL the admin port answered async_queue_depth='<nothing>', not a number" "$TMP/out" ||
    fail "an unreadable /metrics was not reported as unreadable: $(grep -A1 'Claim 13' "$TMP/out" | tail -1)"
  grep -qF 'or http://127.0.0.1:18081/metrics is unreachable' "$TMP/out" ||
    fail 'the FAIL blamed SH_ASYNC_DRAIN alone for a reading it cannot explain')
pass "claim 13 requires a numeric async_queue_depth, and names both causes when it is not"

echo "== P7 keeps the sticky sandbox count (#425)"
# P7 runs the setup.sh beside smoke.sh, so the copy here runs a stand-in that records its env.
mkdir -p "$TMP/k8s"
cp "$SMOKE" "$TMP/k8s/smoke.sh"
cat >"$TMP/k8s/setup.sh" <<'MOCK'
#!/usr/bin/env bash
echo "count=${SH_SANDBOX_COUNT-unset} tier=${SH_SANDBOX_DEFAULT_TIER-unset} ids=${SH_P4_SANDBOX_IDS-unset} $*" >>"$MOCK_STATE/setup.log"
MOCK
want_p7=$'count=unset tier=unset ids=moca_microvm_0,moca_scratch_0 --target ocp\ncount=unset tier=unset ids=moca_microvm_0 --target ocp'
(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real MOCK_REDIS_OUT=moca_microvm_0 \
  SMOKE_P4_ADD_ID=moca_scratch_0
  SMOKE="$TMP/k8s/smoke.sh" run_smoke --target ocp --tier p4
  grep -qE '^  ok moca_scratch_0.s token reached' "$TMP/out" || fail "P7 did not pass with the stand-in setup.sh: $(grep -A2 'Claim P7' "$TMP/out")"
  [[ "$(cat "$MOCK_STATE/setup.log")" == "$want_p7" ]] ||
    fail "P7's setup.sh runs did not leave SH_SANDBOX_COUNT to the sticky value: $(cat "$MOCK_STATE/setup.log")")
pass 'P7: the add and the restore leave SH_SANDBOX_COUNT unset (sticky), so a mixed stack keeps its containers'
# An operator's exported count or default tier must not reach P7's setup.sh runs either.
(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real MOCK_REDIS_OUT=moca_microvm_0 \
  SMOKE_P4_ADD_ID=moca_scratch_0 SH_SANDBOX_COUNT=0 SH_SANDBOX_DEFAULT_TIER=microvm
  SMOKE="$TMP/k8s/smoke.sh" run_smoke --target ocp --tier p4
  [[ "$(cat "$MOCK_STATE/setup.log")" == "$want_p7" ]] ||
    fail "an exported SH_SANDBOX_COUNT / SH_SANDBOX_DEFAULT_TIER reached P7's setup.sh: $(cat "$MOCK_STATE/setup.log")")
pass "P7: an operator's exported SH_SANDBOX_COUNT and SH_SANDBOX_DEFAULT_TIER do not reach its setup.sh runs"

echo "smoke.test.sh: all passed"
