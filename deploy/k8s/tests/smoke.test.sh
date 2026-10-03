#!/usr/bin/env bash
# Cluster-free tests for deploy/k8s/smoke.sh's own failure handling (#423): the runs that fail are
# the ones whose logs matter, so none of them may delete $OUT, and a kubectl error in a claim must
# become a FAIL line and the summary, not a set -e death before it. kubectl, curl and sleep are
# mocks on PATH; every other tool is the real one.
set -euo pipefail

SMOKE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/smoke.sh"
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

# curl: /healthz succeeds for the first $MOCK_HEALTHZ_OK calls (default: always); /v1/sessions
# returns a session when MOCK_SESSIONS=1; everything else is a refused connection.
cat >"$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
url=''
for a in "$@"; do [[ "$a" == http* ]] && url="$a"; done
case "$url" in
*/healthz)
  n=$(($(cat "$MOCK_STATE/healthz" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$MOCK_STATE/healthz"
  [[ "$n" -le "${MOCK_HEALTHZ_OK:-1000}" ]] ;;
*/v1/sessions)
  [[ "${MOCK_SESSIONS-}" == 1 ]] || exit 7
  echo '{"sessionId":"s1","token":"t1"}' ;;
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
*" exec redis-0 "*) exit 0 ;;
*" get statefulset "*) echo 1 ;;
*" get configmap "*) echo http://127.0.0.1:8080 ;;
*" get pods -l "*) echo '{"items":[{"metadata":{"name":"moca-supervisor-x"}}]}' ;;
*" delete pod redis-0 "*)
  [[ -z "${MOCK_REDIS_DELETE_FAIL-}" ]] || { echo 'Error from server (Forbidden): pods "redis-0" is forbidden' >&2; exit 1; } ;;
*" delete pod "* | *" rollout status "*) exit 0 ;;
*" get pods "*)
  [[ -z "${MOCK_GET_PODS_FAIL-}" ]] || { echo 'Unable to connect to the server: dial tcp: i/o timeout' >&2; exit 1; }
  echo '{"items":[]}' ;;
*) echo "mock kubectl: unhandled: $*" >&2; exit 2 ;;
esac
MOCK
chmod +x "$TMP/bin/sleep" "$TMP/bin/curl" "$TMP/bin/kubectl"

# run_smoke: the caller's exported MOCK_* shape the run; sets RC and KEPT_DIR.
run_smoke() {
  rm -rf "$MOCK_STATE"
  mkdir -p "$MOCK_STATE"
  if PATH="$TMP/bin:$PATH" K8S_LIVE_SMOKE=1 bash "$SMOKE" --target kind-ci >"$TMP/out" 2>&1; then RC=0; else RC=$?; fi
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

if out="$(bash "$SMOKE" 2>&1)" && [[ "$out" == SKIP:* ]]; then pass 'without K8S_LIVE_SMOKE=1 it SKIPs'; else fail "no SKIP without K8S_LIVE_SMOKE: $out"; fi

echo "smoke.test.sh: all passed"
