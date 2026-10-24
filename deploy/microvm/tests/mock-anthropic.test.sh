#!/usr/bin/env bash
# deploy/microvm/tests/mock-anthropic.test.sh -- the scripted model the P4 live run drives turns with.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOCK="$DIR/mock-anthropic.mjs"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"; fails=$((fails + 1)); fi; }
command -v node >/dev/null || { echo "SKIP: node not installed"; exit 0; }
TMP="$(mktemp -d)"
node "$MOCK" --port 0 >"$TMP/out" 2>"$TMP/err" &
pid=$!
trap 'kill $pid 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 50); do grep -q listening "$TMP/out" && break; sleep 0.1; done
port="$(sed -nE 's/.*127\.0\.0\.1:([0-9]+).*/\1/p' "$TMP/out")"
check "listening on loopback" "$([ -n "$port" ] && echo yes || echo no)" "yes"
post() { curl -sS -o "$TMP/body" -w '%{http_code}' -X POST "http://127.0.0.1:$port/v1/messages" \
  -H 'content-type: application/json' -d "$1"; }

echo "== step 0 of WRITE is a bash tool_use, streamed"
code="$(post '{"model":"mock-p4","stream":true,"messages":[{"role":"user","content":"P4-SMOKE-WRITE"}]}')"
check "200" "$code" "200"
check "SSE message_start" "$(grep -c '^event: message_start' "$TMP/body")" "1"
check "tool_use for bash" "$(grep -c '"type":"tool_use".*"name":"bash"' "$TMP/body")" "1"
check "the command is in the input json delta" "$(grep -c 'uname -r' "$TMP/body")" "1"
check "stop_reason tool_use" "$(grep -c '"stop_reason":"tool_use"' "$TMP/body")" "1"

echo "== after two tool_results, WRITE ends with text"
code="$(post '{"model":"mock-p4","stream":true,"messages":[
  {"role":"user","content":"P4-SMOKE-WRITE"},
  {"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]},
  {"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"x"}]},
  {"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"bash","input":{}}]},
  {"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"y"}]}]}')"
check "200" "$code" "200"
check "final text" "$(grep -c 'done-write' "$TMP/body")" "1"
check "stop_reason end_turn" "$(grep -c '"stop_reason":"end_turn"' "$TMP/body")" "1"

echo "== the final text carries the tool results back (non-streaming /turn returns only that text)"
code="$(post '{"model":"mock-p4","stream":true,"messages":[
  {"role":"user","content":"P4-SMOKE-READ"},
  {"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]},
  {"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"RESULT-ONE"}]}]}]}')"
check "200" "$code" "200"
check "final text includes the tool result" "$(grep -c 'done-read.*RESULT-ONE' "$TMP/body")" "1"
code="$(post '{"model":"mock-p4","stream":true,"messages":[
  {"role":"user","content":"P4-SMOKE-READ"},
  {"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]},
  {"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"RESULT-STRING","is_error":true}]}]}')"
check "a string tool_result (and an error one) is echoed too" "$(grep -c 'RESULT-STRING' "$TMP/body")" "1"

echo "== a later turn is keyed on ITS prompt, not the session's first"
code="$(post '{"model":"mock-p4","stream":true,"messages":[
  {"role":"user","content":"P4-SMOKE-WRITE"},{"role":"assistant","content":[{"type":"text","text":"done-write"}]},
  {"role":"user","content":[{"type":"text","text":"P4-SMOKE-READ"}]}]}')"
check "READ step 0" "$(grep -c 'continuity-ok' "$TMP/body")" "1"

echo "== an unscripted prompt is a 400, not a guess"
check "400" "$(post '{"model":"mock-p4","stream":true,"messages":[{"role":"user","content":"hello"}]}')" "400"

echo "== the K8s smoke scripts (#423) are scripted, and do not disturb the P4 ones"
for m in K8S-SMOKE-WRITE K8S-SMOKE-AGAIN K8S-SMOKE-RESEARCH K8S-SMOKE-DRAIN K8S-SMOKE-P4-WRITE K8S-SMOKE-P4-READ \
  K8S-SMOKE-WHERE-1 K8S-SMOKE-WHERE-2; do
  code="$(post '{"model":"mock-k8s","stream":true,"messages":[{"role":"user","content":"run it. '"$m"'"}]}')"
  check "$m step 0 is 200" "$code" "200"
  check "$m step 0 is a bash tool_use" "$(grep -c '"name":"bash"' "$TMP/body")" "1"
  # P6.3 claim 12 reads the sandbox's pod name out of where=; the command is JSON in JSON
  # (partial_json), so grep the unquoted fragment.
  case "$m" in K8S-SMOKE-WHERE-*) check "$m step 0 prints where=" "$(grep -c 'where=' "$TMP/body")" "1" ;; esac
  # The first turns run concurrently and must overlap, so each holds its lease for 2 s; the second
  # turns run one at a time and need no hold.
  case "$m" in
    K8S-SMOKE-WHERE-1) check "$m step 0 holds its lease (sleep 2)" "$(grep -c 'sleep 2; echo' "$TMP/body")" "1" ;;
    K8S-SMOKE-WHERE-2) check "$m step 0 is a bare echo" "$(grep -c 'sleep' "$TMP/body")" "0" ;;
  esac
done
code="$(post '{"model":"mock-k8s","stream":true,"messages":[
  {"role":"user","content":"K8S-SMOKE-DRAIN"},
  {"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]},
  {"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"drained"}]}]}')"
check "DRAIN ends with its done text and the tool output" "$(grep -c 'done-k8s-drain\\ndrained' "$TMP/body")" "1"

echo "== the per-session model smoke: no tool step, and the reply names the request's model"
code="$(post '{"model":"mock-b","stream":true,"messages":[{"role":"user","content":"Reply with the model you are. [K8S-SMOKE-MODEL]"}]}')"
check "K8S-SMOKE-MODEL is 200" "$code" "200"
check "K8S-SMOKE-MODEL has no tool_use" "$(grep -c '"type":"tool_use"' "$TMP/body")" "0"
check "K8S-SMOKE-MODEL text names the model" "$(grep -c 'model=mock-b' "$TMP/body")" "1"

echo "== the moca-delegate-task Kind demo scripts (skills/moca-delegate-task/demo/run.sh)"
# demo_turn MARKER N: the turn after N tool_results, each echoing RESULT-<i>.
demo_turn() {
  local msgs i
  msgs='{"role":"user","content":"The repository is in your working directory. '"$1"'"}'
  for ((i = 1; i <= $2; i++)); do
    msgs="$msgs"',{"role":"assistant","content":[{"type":"tool_use","id":"t'"$i"'","name":"bash","input":{}}]}'
    msgs="$msgs"',{"role":"user","content":[{"type":"tool_result","tool_use_id":"t'"$i"'","content":"RESULT-'"$i"'"}]}'
  done
  post '{"model":"mock-k8s","stream":true,"messages":['"$msgs"']}'
}
# shellcheck disable=SC2016 # the specs are literal commands, not to be expanded
for spec in 'MOCA-DEMO-READ 0 echo "cwd=$(pwd)"; ls' 'MOCA-DEMO-READ 1 write=refused' 'MOCA-DEMO-READ 2 ./test.sh' \
  'MOCA-DEMO-FIX 0 before-exit' 'MOCA-DEMO-FIX 1 after-exit' 'MOCA-DEMO-FIX 2 git diff --no-index'; do
  m="${spec%% *}"; rest="${spec#* }"; n="${rest%% *}"; want="${rest#* }"
  code="$(demo_turn "$m" "$n")"
  check "$m step $n is 200" "$code" "200"
  check "$m step $n is a bash tool_use" "$(grep -c '"name":"bash"' "$TMP/body")" "1"
  # The command is JSON in JSON (partial_json): strip the escaping before matching it.
  check "$m step $n runs '$want'" "$(sed 's/\\//g' "$TMP/body" | grep -cF -- "$want")" "1"
done
code="$(demo_turn MOCA-DEMO-READ 3)"
check "MOCA-DEMO-READ ends with its done text and every result" \
  "$(grep -c 'done-demo-read\\nRESULT-1\\nRESULT-2\\nRESULT-3' "$TMP/body")" "1"
code="$(demo_turn MOCA-DEMO-FIX 3)"
check "MOCA-DEMO-FIX ends with its done text and every result" \
  "$(grep -c 'done-demo-fix\\nRESULT-1\\nRESULT-2\\nRESULT-3' "$TMP/body")" "1"

echo "== the two-user Kind demo scripts (skills/moca-delegate-task/demo-two-users/run.sh)"
# shellcheck disable=SC2016 # the specs are literal commands, not to be expanded
for spec in 'MOCA-DEMO2-WHO 0 where=$HOSTNAME' 'MOCA-DEMO2-WRITE 0 written-by=$HOSTNAME' \
  'MOCA-DEMO2-READBACK 0 note=$(cat run-note.txt' 'MOCA-DEMO2-PEEK 0 write=refused' 'MOCA-DEMO2-PEEK 1 SECRET-'; do
  m="${spec%% *}"; rest="${spec#* }"; n="${rest%% *}"; want="${rest#* }"
  code="$(demo_turn "$m" "$n")"
  check "$m step $n is 200" "$code" "200"
  check "$m step $n is a bash tool_use" "$(grep -c '"name":"bash"' "$TMP/body")" "1"
  check "$m step $n runs '$want'" "$(sed 's/\\//g' "$TMP/body" | grep -cF -- "$want")" "1"
done
for spec in 'MOCA-DEMO2-WHO 1 done-demo2-who' 'MOCA-DEMO2-WRITE 1 done-demo2-write' \
  'MOCA-DEMO2-READBACK 1 done-demo2-readback' 'MOCA-DEMO2-PEEK 2 done-demo2-peek'; do
  m="${spec%% *}"; rest="${spec#* }"; n="${rest%% *}"; want="${rest#* }"
  code="$(demo_turn "$m" "$n")"
  check "$m ends with $want and every result" "$(grep -c "$want\\\\nRESULT-1" "$TMP/body")" "1"
done

if [ "$fails" -eq 0 ]; then echo "PASS"; else echo "FAIL ($fails)"; fi
exit "$fails"
