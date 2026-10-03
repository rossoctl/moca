#!/usr/bin/env bash
# Live smoke for P6 on Kubernetes (#423, spec §9.4), against a stack deploy/k8s/setup.sh brought up.
#
#   K8S_LIVE_SMOKE=1 deploy/k8s/smoke.sh [--target kind-ci|kind|ocp]
#
# kind-ci (the default) drives turns through the in-pod mock model. Any other target needs a real
# model credential to store as the smoke user's:
#   SMOKE_MODEL_URL    the inference endpoint, e.g. https://api.anthropic.com
#   SMOKE_MODEL_TOKEN  the credential (read from the environment only, never argv)
#   SMOKE_MODEL_KIND   bearer (default; a gateway token) or api-key (a raw Anthropic key)
# The prompts spell their commands out in words, so a real model runs the same claims; the mock
# keys on the K8S-SMOKE-* markers alone. Reaches everything by port-forward, on every target: the
# OCP Route path is exercised by the demo run (README "Demo on OpenShift"), not here.
set -euo pipefail

if [[ "${K8S_LIVE_SMOKE:-}" != 1 ]]; then
  echo "SKIP: set K8S_LIVE_SMOKE=1 to run the deploy/k8s live smoke (needs a stack from setup.sh)"
  exit 0
fi

TARGET=kind-ci
while [[ $# -gt 0 ]]; do
  case "$1" in
  --target) TARGET="${2-}"; shift 2 ;;
  *) echo "smoke.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$TARGET" in kind | kind-ci | ocp) ;; *) echo "smoke.sh: --target must be kind, kind-ci or ocp" >&2; exit 2 ;; esac
kc() { if [[ "$TARGET" == kind* ]]; then kubectl --context kind-moca "$@"; else kubectl "$@"; fi; }

NS=moca
SBX=moca-sandbox
OUT="$(mktemp -d)"
chmod 700 "$OUT"
PIDS=''
PASS=0
FAIL=0
# Logs are kept for every run that did not pass: a failed claim, and also an early `exit 1` or a
# set -e death, both of which leave FAIL at 0. So the exit status is captured first, before any
# command here can overwrite it. Token header files go on every path.
cleanup() {
  local rc=$?
  [[ -z "$PIDS" ]] || kill $PIDS 2>/dev/null || true
  rm -f "$OUT"/*.hdr
  if [[ "$rc" != 0 || "$FAIL" -gt 0 ]]; then
    echo "logs kept in $OUT"
  else
    rm -rf "$OUT"
  fi
}
trap cleanup EXIT
ok() { PASS=$((PASS + 1)); echo "  ok ${1:-}"; }
ko() { FAIL=$((FAIL + 1)); echo "  FAIL ${1:-}"; }
claim() { printf '\n--- Claim %s: %s ---\n' "$1" "$2"; }
wait_for() { local n="$1"; shift; for _ in $(seq "$n"); do "$@" && return 0; sleep 1; done; return 1; }
note() { echo "  note $1"; }

if [[ "$TARGET" == kind-ci ]]; then
  : "${SMOKE_MODEL_URL:=http://127.0.0.1:18099}" "${SMOKE_MODEL_TOKEN:=mock-not-a-secret}"
fi
[[ -n "${SMOKE_MODEL_URL:-}" && -n "${SMOKE_MODEL_TOKEN:-}" ]] ||
  { echo "smoke.sh: --target $TARGET needs SMOKE_MODEL_URL and SMOKE_MODEL_TOKEN" >&2; exit 2; }
SMOKE_MODEL_KIND="${SMOKE_MODEL_KIND:-bearer}"

HARNESS=http://127.0.0.1:18080
ADMIN=http://127.0.0.1:18081
CP=http://127.0.0.1:18090
tool_out() { sed -n 's/^data: //p' "$1" | jq -r 'select(.type == "tool_result" and (.isError | not)) | .preview' 2>/dev/null; }
# `kc ... &` would background a subshell running kc, so $! -- and the kill -- would hit the
# subshell and orphan kubectl, which then kept the ports bound across forward() and after exit.
# exec makes the background job kubectl itself.
kc_exec() { if [[ "$TARGET" == kind* ]]; then exec kubectl --context kind-moca "$@"; else exec kubectl "$@"; fi; }
# forward: (re)start both port-forwards; false, with the reason printed, if either never comes up.
forward() {
  [[ -z "$PIDS" ]] || { kill $PIDS 2>/dev/null || true; wait $PIDS 2>/dev/null || true; }
  kc_exec -n "$NS" port-forward svc/moca-supervisor 18080:8080 18081:8081 >"$OUT/pf-sup.log" 2>&1 &
  PIDS="$!"
  kc_exec -n "$NS" port-forward svc/moca-control-plane 18090:8080 >"$OUT/pf-cp.log" 2>&1 &
  PIDS="$PIDS $!"
  wait_for 30 curl -sf -o /dev/null "$ADMIN/healthz" || { echo "port-forward to the supervisor never came up:"; cat "$OUT/pf-sup.log"; return 1; }
  wait_for 30 curl -sf -o /dev/null "$CP/healthz" || { echo "port-forward to the control plane never came up:"; cat "$OUT/pf-cp.log"; return 1; }
}
# Nothing can run without the first forward, so that one ends the run (cleanup keeps the logs).
forward || exit 1

claim 1 "the supervisor is ready with every worker healthy"
body="$(curl -s "$ADMIN/readyz" || true)"
if jq -e '.ready == true and .workers > 0 and .healthy == .workers' >/dev/null 2>&1 <<<"$body"; then ok "$body"; else ko "readyz: $body"; fi

claim 2 "every sandbox replica is attached through the relay"
replicas="$(kc -n "$SBX" get statefulset moca-sandbox -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
[[ -n "$replicas" ]] || { ko "could not read moca-sandbox statefulset replicas"; replicas=0; }
keys="$(kc -n "$NS" exec redis-0 -- sh -c 'redis-cli HKEYS sh:sandbox:records' 2>/dev/null || true)"
missing=''
for i in $(seq 0 $((replicas - 1))); do grep -qx "moca-sandbox-$i" <<<"$keys" || missing="$missing moca-sandbox-$i"; done
if [[ -z "$missing" ]]; then ok "$replicas attached"; else ko "not in sh:sandbox:records:$missing (have: $(tr '\n' ' ' <<<"$keys"))"; fi

claim 5 "the control plane is ready and advertises the configured harness URL"
want="$(kc -n "$NS" get configmap moca-settings -o jsonpath='{.data.SH_PUBLIC_HARNESS_URL}' 2>/dev/null || true)"
[[ -n "$want" ]] || { ko "could not read moca-settings configmap"; want="(unset)"; }
got="$(curl -s "$CP/v1/discovery" | jq -r '.harnessUrl // empty' 2>/dev/null || true)"
if curl -sf -o /dev/null "$CP/readyz" && [[ "$got" == "$want" ]]; then ok "harnessUrl=$got"; else ko "readyz or discovery: want '$want', got '$got'"; fi

claim 6 "an unauthenticated /turn is refused"
code="$(curl -s -o "$OUT/unauth.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"prompt":"hi"}' "$HARNESS/turn" || true)"
if [[ "$code" == 4* ]] && grep -q token_required "$OUT/unauth.json"; then ok "$code token_required"; else ko "$code: $(head -c 300 "$OUT/unauth.json")"; fi

# The api token a device-flow login would return, minted INSIDE the control-plane pod with its own
# signing key (the key never leaves the pod). Tokens travel in header files, never argv.
api="$(kc -n "$NS" exec deploy/moca-control-plane -c control-plane -- \
  node --import tsx --input-type=module -e \
  "import { readFileSync } from 'node:fs'; import { makeSigner } from './src/token.ts';
   const s = makeSigner(readFileSync('/run/credentials/SH_SESSION_TOKEN_PRIVATE_KEY', 'utf8'));
   process.stdout.write(s.mint({ sub: 'smoke:1', tenant: 'smoke:1', roles: [], scope: ['api'], ttlSeconds: 900 }));" || true)"
[[ -n "$api" ]] || { ko "could not mint an api token in the control-plane pod"; printf '\nPASS=%s FAIL=%s\n' "$PASS" "$FAIL"; exit 1; }
(umask 077; printf 'Authorization: Bearer %s\n' "$api" >"$OUT/api.hdr")
field=token
[[ "$SMOKE_MODEL_KIND" == bearer ]] || field=key
host="$(sed -E 's#^[a-z]+://([^/:]+).*#\1#' <<<"$SMOKE_MODEL_URL")"
SMOKE_TOKEN="$SMOKE_MODEL_TOKEN" jq -nc --arg ep "$SMOKE_MODEL_URL" --arg host "$host" --arg kind "$SMOKE_MODEL_KIND" --arg field "$field" \
  '{kind: $kind, consumer: "inference", destination: {hosts: [$host]}, endpoint: $ep, secret: {($field): env.SMOKE_TOKEN}}' >"$OUT/cred.json"
put="$(curl -s -o "$OUT/put.json" -w '%{http_code}' -X PUT -H @"$OUT/api.hdr" -H 'Content-Type: application/json' \
  --data-binary @"$OUT/cred.json" "$CP/v1/credentials/smoke-inference" || true)"
rm -f "$OUT/cred.json"
[[ "$put" == 2* ]] || { ko "PUT /v1/credentials answered $put: $(head -c 300 "$OUT/put.json")"; }

# new_session -> sets SID; the session token goes into $OUT/<sid>.hdr
new_session() {
  local s tok
  s="$(curl -s -X POST -H @"$OUT/api.hdr" -H 'Content-Type: application/json' -d '{}' "$CP/v1/sessions" || true)"
  SID="$(jq -r '.sessionId // empty' <<<"$s" 2>/dev/null || true)"
  [[ -n "$SID" ]] || { ko "POST /v1/sessions returned no session: ${s:0:300}"; return 1; }
  tok="$(jq -r '.token // empty' <<<"$s" 2>/dev/null || true)"
  [[ -n "$tok" ]] || { ko "POST /v1/sessions returned no token for session $SID"; return 1; }
  (umask 077; printf 'Authorization: Bearer %s\n' "$tok" >"$OUT/$SID.hdr")
}
# turn TAG SID PROMPT -> $OUT/TAG.sse; true when the stream ended with this session's done frame
turn() {
  curl -sN --max-time 180 -H @"$OUT/$2.hdr" -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg s "$2" --arg p "$3" '{sessionId: $s, prompt: $p}')" "$HARNESS/v1/turn" >"$OUT/$1.sse" || true
  [[ "$(sed -n 's/^data: //p' "$OUT/$1.sse" | jq -r 'select(.type == "done") | .sessionId' 2>/dev/null | head -1)" == "$2" ]]
}
# has_session SID: the session's log stream exists in Redis. Not `kc exec ... | grep -q`: grep -q exits
# at its first match, kubectl then dies of SIGPIPE writing the rest of the scan, and pipefail turned
# a present key into a failed claim whenever it was not listed last.
has_session() {
  [[ -n "$1" && "$(kc -n "$NS" exec redis-0 -- sh -c "redis-cli EXISTS 'session:$1'" 2>/dev/null)" == 1 ]]
}
ask() { printf 'Use the bash tool to run exactly this command, then reply with its output: %s  [%s]' "$2" "$1"; }

claim 3 "an authenticated /v1/turn runs a command in a sandbox and streams over SSE"
SID=''
if new_session && turn write "$SID" "$(ask K8S-SMOKE-WRITE 'uname -s; echo k8s-proof | tee proof.txt; pwd')" &&
  grep -q 'k8s-proof' <(tool_out "$OUT/write.sse") && grep -q 'Linux' <(tool_out "$OUT/write.sse"); then
  ok "session $SID"
else
  ko "write turn: $(head -c 600 "$OUT/write.sse" 2>/dev/null)"
fi
FIRST_SID="$SID"

claim 4 "the session persists in Redis and takes a second turn"
if [[ -n "$FIRST_SID" ]] && turn again "$FIRST_SID" "$(ask K8S-SMOKE-AGAIN 'echo second-turn')" && grep -q second-turn <(tool_out "$OUT/again.sse") &&
  has_session "$FIRST_SID"; then
  ok
else
  ko "second turn or session:$FIRST_SID key missing"
fi

claim 7 "a sandbox reaches the relay's attach port and nothing else in the cluster"
probe() {
  kc -n "$SBX" exec moca-sandbox-0 -c sandbox -- bash -c \
    'timeout 3 bash -c "</dev/tcp/$0/$1" 2>/dev/null && echo OPEN || echo BLOCKED' "$1" "$2" 2>/dev/null || echo ERROR
}
iso_ok=1
for t in redis.moca.svc:6379 sandbox-relay-exec.moca.svc:9444 169.254.169.254:80; do
  r="$(probe "${t%:*}" "${t#*:}")"
  [[ "$r" == BLOCKED ]] || { iso_ok=0; ko "$t is $r from a sandbox (want BLOCKED)"; }
done
r="$(probe kubernetes.default.svc 443)"
if [[ "$TARGET" == ocp ]]; then
  [[ "$r" == BLOCKED ]] || { iso_ok=0; ko "kubernetes.default.svc:443 is $r (want BLOCKED)"; }
else
  note "kubernetes.default.svc:443 is $r (single-node kind: kindnet does not filter node-local traffic; enforced on OCP — README Troubleshooting)"
fi
r="$(probe sandbox-relay-attach.moca.svc 9443)"
[[ "$r" == OPEN ]] || { iso_ok=0; ko "sandbox-relay-attach:9443 is $r (want OPEN)"; }
if [[ "$iso_ok" == 0 ]]; then :; elif [[ "$TARGET" == ocp ]]; then
  ok 'redis, relay exec, kube API and metadata BLOCKED; relay attach OPEN'
else
  ok 'redis, relay exec, metadata BLOCKED; relay attach OPEN'
fi

claim 8 "a research turn reaches the internet from the sandbox (curl and git)"
SID=''
if new_session && turn research "$SID" "$(ask K8S-SMOKE-RESEARCH 'curl -sI https://example.com | head -1; echo "git-head=$(git ls-remote https://github.com/rossoctl/moca HEAD | cut -c1-12)"')" &&
  grep -qE 'HTTP/[0-9.]+ [23][0-9][0-9]' <(tool_out "$OUT/research.sse") && grep -qE 'git-head=[0-9a-f]{12}' <(tool_out "$OUT/research.sse"); then
  ok
else
  ko "research turn: $(head -c 600 "$OUT/research.sse" 2>/dev/null)"
fi

claim 9 "a turn in flight when its supervisor pod is deleted runs to completion (drain)"
# Delete, not `rollout restart`: with maxUnavailable 0 a rollout keeps the old pod until the new one is
# Ready, which can outlast the turn and prove nothing. Deletion sends SIGTERM (after preStop) mid-turn.
SID=''
if new_session; then
  # Not one still terminating from an earlier run: deleting it again would prove nothing.
  pod="$(kc -n "$NS" get pods -l app=moca-supervisor -o json 2>/dev/null |
    jq -r '[.items[] | select(.metadata.deletionTimestamp == null)][0].metadata.name // empty' 2>/dev/null || true)"
  [[ -n "$pod" ]] || { ko "could not find moca-supervisor pod"; pod="unknown"; }
  (turn drain "$SID" "$(ask K8S-SMOKE-DRAIN 'sleep 8; echo drained')" && echo "done" >"$OUT/drain.ok") &
  tpid=$!
  sleep 2
  kc -n "$NS" delete pod "$pod" --wait=false >/dev/null || true
  wait "$tpid" || true
  if [[ -f "$OUT/drain.ok" ]] && grep -q drained <(tool_out "$OUT/drain.sse"); then ok "pod $pod drained its turn"; else ko "drain: $(head -c 600 "$OUT/drain.sse" 2>/dev/null)"; fi
  kc -n "$NS" rollout status deployment/moca-supervisor --timeout=300s >/dev/null || true
  # Claims 10 and 11 need no forward, so a failed one is a FAIL, not the end of the run.
  forward || ko "port-forward did not come back after the drain"
fi

claim 10 "sessions survive a Redis restart (AOF on the PVC)"
# Every kubectl here is guarded: under set -e an API error would end the run before the summary.
if ! kc -n "$NS" delete pod redis-0 >/dev/null; then
  ko "could not delete redis-0"
elif ! kc -n "$NS" rollout status statefulset/redis --timeout=180s >/dev/null; then
  ko "redis did not roll out after the restart"
elif ! wait_for 90 kc -n "$NS" exec redis-0 -- sh -c 'redis-cli ping | grep -q PONG'; then
  ko "redis-0 not ready after restart"
elif has_session "$FIRST_SID"; then ok; else ko "session:$FIRST_SID gone after the restart"; fi

claim 11 "no container restarted (no OOM kill, no crash) apart from the pods deleted above"
if ! restarts="$(kc get pods -n "$NS" -o json | jq '[.items[].status | (.containerStatuses[]?, .initContainerStatuses[]?) | .restartCount] | add // 0')" ||
  ! restarts_sbx="$(kc get pods -n "$SBX" -o json | jq '[.items[].status.containerStatuses[]?.restartCount] | add // 0')"; then
  ko "could not read pod restart counts"
elif [[ "$restarts" == 0 && "$restarts_sbx" == 0 ]]; then ok; else ko "restartCount moca=$restarts moca-sandbox=$restarts_sbx (kubectl describe pod for OOMKilled)"; fi

printf '\nPASS=%s FAIL=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
