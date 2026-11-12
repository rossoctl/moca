#!/usr/bin/env bash
# Live smoke for P6 on Kubernetes (#423, spec §9.4; P4 tier #424), against a stack deploy/k8s/setup.sh
# brought up.
#
#   K8S_LIVE_SMOKE=1 deploy/k8s/smoke.sh [--target kind-ci|kind|ocp] [--tier container|p4]
#
# kind-ci (the default) drives turns through the in-pod mock model. Any other target needs a real
# model credential to store as the smoke user's:
#   SMOKE_MODEL_URL    the inference endpoint, e.g. https://api.anthropic.com
#   SMOKE_MODEL_TOKEN  the credential (read from the environment only, never argv)
#   SMOKE_MODEL_KIND   bearer (default; a gateway token) or api-key (a raw Anthropic key)
# The prompts spell their commands out in words, so a real model runs the same claims; the mock
# keys on the K8S-SMOKE-* markers alone. Reaches everything by port-forward, on every target: the
# OCP Route path is exercised by the demo run (README "Demo on OpenShift"), not here -- except the
# relay Route, which --tier p4 probes directly (claim P6).
#
# --tier p4 (ocp only; docs/specs/2026-10-04-p6-on-kubernetes-slice2-design.md §6): a stack whose
# sandboxes are P4 microVM hosts outside the cluster (SH_P4_SANDBOX_IDS). Claims 1, 5 and 6 are the
# container tier's; P2-P4 replace 2-4; P6 probes the relay Route; P7 (only with SMOKE_P4_ADD_ID=<a
# scratch id>) re-runs setup.sh to add that id and back, and proves the relay was not restarted.
#
# A tiered stack (P6.3, #425: container sandboxes AND P4 hosts, SH_SANDBOX_TIERS in moca-settings):
# every session names the tier this smoke tests, so either smoke is right whatever the default tier.
# Claim 12 (container tier only) proves a session's turns return to the sandbox of its first.
set -euo pipefail

if [[ "${K8S_LIVE_SMOKE:-}" != 1 ]]; then
  echo "SKIP: set K8S_LIVE_SMOKE=1 to run the deploy/k8s live smoke (needs a stack from setup.sh)"
  exit 0
fi

TARGET=kind-ci
TIER=container
# A value flag given last would make `shift 2` fail under set -e with no message (setup.sh's
# need_value guards the same case).
need_value() { [[ $# -ge 2 ]] || { echo "smoke.sh: $1 needs a value" >&2; exit 2; }; }
while [[ $# -gt 0 ]]; do
  case "$1" in
  --target) need_value "$@"; TARGET="$2"; shift 2 ;;
  --tier) need_value "$@"; TIER="$2"; shift 2 ;;
  *) echo "smoke.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$TARGET" in kind | kind-ci | ocp | ocp-single) ;; *) echo "smoke.sh: --target must be kind, kind-ci, ocp or ocp-single" >&2; exit 2 ;; esac
case "$TIER" in container | p4) ;; *) echo "smoke.sh: --tier must be container or p4" >&2; exit 2 ;; esac
if [[ "$TIER" == p4 ]]; then
  [[ "$TARGET" == ocp ]] || { echo "smoke.sh: --tier p4 needs --target ocp (P4 hosts reach the relay through an OpenShift Route)" >&2; exit 2; }
  [[ -z "${SMOKE_P4_ADD_ID:-}" || "$SMOKE_P4_ADD_ID" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    { echo "smoke.sh: SMOKE_P4_ADD_ID='$SMOKE_P4_ADD_ID' must match ^[A-Za-z_][A-Za-z0-9_]*\$ (a P4 sandbox id)" >&2; exit 2; }
fi
kc() { if [[ "$TARGET" == kind* ]]; then kubectl --context kind-moca "$@"; else kubectl "$@"; fi; }

NS=moca
SBX=moca-sandbox
# ocp-single: every workload shares the one namespace the stack was installed in
# (SH_SINGLE_NAMESPACE, default moca-single). An exported SH_SINGLE_NAMESPACE wins; otherwise it is
# read from the moca-setup ConfigMap in the kubeconfig's current namespace (the read needs a
# namespace to find the one it names), and the default covers a ConfigMap that cannot be read.
if [[ "$TARGET" == ocp-single ]]; then
  NS="${SH_SINGLE_NAMESPACE:-$(kc get configmap moca-setup -o jsonpath='{.data.SH_SINGLE_NAMESPACE}' 2>/dev/null || true)}"
  NS="${NS:-moca-single}"
  SBX="$NS"
fi
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
summary() { printf '\nPASS=%s FAIL=%s\n' "$PASS" "$FAIL"; [[ "$FAIL" == 0 ]]; }

# kind-ci runs the in-pod mock model; ocp-single has no mock (README §12.2), so its smoke needs a
# real model credential like --target ocp does.
if [[ "$TARGET" == kind-ci ]]; then
  : "${SMOKE_MODEL_URL:=http://127.0.0.1:18099}" "${SMOKE_MODEL_TOKEN:=mock-not-a-secret}"
fi
[[ -n "${SMOKE_MODEL_URL:-}" && -n "${SMOKE_MODEL_TOKEN:-}" ]] ||
  { echo "smoke.sh: --target $TARGET needs SMOKE_MODEL_URL and SMOKE_MODEL_TOKEN" >&2; exit 2; }
SMOKE_MODEL_KIND="${SMOKE_MODEL_KIND:-bearer}"

# The stack's sandbox tiers (P6.3, #425): setup.sh writes SH_SANDBOX_TIERS=container,microvm to
# moca-settings only on a mixed stack, '' otherwise (kind and ocp-single are never tiered). A tiered
# stack puts a session that names no tier in its DEFAULT tier, which may be either, so every session
# here names the one this smoke tests: then both smokes are right on a mixed stack whatever its
# default. An untiered control plane refuses a session that names a tier, so there the body is {}.
# A failed read is not an empty value (P2's setup_read is the same rule): it is a FAIL, because an
# unreadable moca-settings cannot say "untiered", and treating it so could run a P4 smoke's turns in
# a container, or pass P2 on the wrong check. The sessions then post {} so the other claims still run.
tiers_read=1
tiers="$(kc -n "$NS" get configmap moca-settings -o jsonpath='{.data.SH_SANDBOX_TIERS}' 2>"$OUT/tiers.err")" ||
  { tiers_read=0; tiers=''; }
SESSION_BODY='{}'
if [[ "$tiers_read" == 0 ]]; then
  ko "could not read configmap moca-settings (SH_SANDBOX_TIERS), so this run cannot tell whether the stack is tiered: $(head -c 300 "$OUT/tiers.err" 2>/dev/null)"
elif [[ -n "$tiers" ]]; then
  want_tier=container
  [[ "$TIER" != p4 ]] || want_tier=microvm
  SESSION_BODY="$(jq -nc --arg t "$want_tier" '{sandbox: {tier: $t}}')"
  note "this stack is tiered ($tiers): every session asks for the $want_tier tier"
fi

HARNESS=http://127.0.0.1:18080
ADMIN=http://127.0.0.1:18081
CP=http://127.0.0.1:18090
tool_out() { sed -n 's/^data: //p' "$1" | jq -r 'select(.type == "tool_result" and (.isError | not)) | .preview' 2>/dev/null; }
# tool_text: a real model's preview is a JSON envelope, {"content":[{"type":"text","text":"..."}]},
# whose text tool_out leaves JSON-escaped on one line; decode it. A plain preview passes as is.
tool_text() { jq -Rr '(fromjson? | objects | .content[]? | select(.type? == "text") | .text) // .' 2>/dev/null; }
# first_line: the first non-blank line, trimmed. awk reads to the end: an early exit (head, sed q)
# would SIGPIPE the jq feeding it, and pipefail would turn that into a failure.
first_line() { awk '!done && NF { sub(/^[ \t\r]+/, ""); sub(/[ \t\r]+$/, ""); print; done = 1 }'; }
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

if [[ "$TIER" == p4 ]]; then
  claim P2 "every P4 sandbox in SH_P4_SANDBOX_IDS is attached through the relay; untiered, no container sandbox is; tiered, each P4 record advertises the microvm tier"
  # A failed read is not an empty value: only a readable moca-setup can say "no P4 tier".
  setup_read=1
  ids="$(kc -n "$NS" get configmap moca-setup -o jsonpath='{.data.SH_P4_SANDBOX_IDS}' 2>"$OUT/p2-setup.err")" ||
    { setup_read=0; ids=''; }
  keys="$(kc -n "$NS" exec redis-0 -- sh -c 'redis-cli HKEYS sh:sandbox:records' 2>/dev/null || true)"
  missing=''
  bad=''
  # The list comes from the cluster, not from setup.sh's validated input: split it without globbing
  # and re-check each id against the relay's rule, so a tampered value is a FAIL, never a pathname
  # expansion. ${a[@]+...}: an empty array is "unbound" under set -u in bash < 4.4.
  if [[ -n "$ids" ]]; then
    idre='^[A-Za-z_][A-Za-z0-9_]*$'
    IFS=',' read -ra p4_ids <<<"$ids"
    for id in ${p4_ids[@]+"${p4_ids[@]}"}; do
      if [[ "$id" =~ $idre ]]; then
        grep -qx "$id" <<<"$keys" || missing="$missing $id"
      else
        bad="$bad '$id'"
      fi
    done
  fi
  containers="$(grep -E '^moca-sandbox-[0-9]+$' <<<"$keys" | tr '\n' ' ' || true)"
  containers="${containers% }"
  # A tiered stack (P6.3) runs container sandboxes beside its P4 hosts on purpose, so there the check
  # is the other half of tiering: the supervisor leases a microvm session only to a record whose
  # labels advertise moca.dev/tier=microvm (the relay stores the worker's Hello labels as the
  # record's .labels), and a P4 host without it gets no sessions at all.
  unlabelled=''
  if [[ "$tiers_read" == 1 && -n "$tiers" && -n "$ids" && -z "$bad" && -z "$missing" ]]; then
    for id in ${p4_ids[@]+"${p4_ids[@]}"}; do
      # The id matched $idre above, so it is safe inside the quoted redis-cli argument.
      rec="$(kc -n "$NS" exec redis-0 -- sh -c "redis-cli HGET sh:sandbox:records '$id'" 2>/dev/null || true)"
      rt="$(jq -r '.labels["moca.dev/tier"] // empty' <<<"$rec" 2>/dev/null || true)"
      [[ "$rt" == microvm ]] || unlabelled="$unlabelled $id (tier '$rt')"
    done
  fi
  if [[ "$setup_read" == 0 ]]; then
    ko "could not read configmap moca-setup: $(head -c 300 "$OUT/p2-setup.err" 2>/dev/null)"
  elif [[ -z "$ids" ]]; then
    ko "moca-setup holds no SH_P4_SANDBOX_IDS: this stack has no P4 tier (README \"P4 on Kubernetes\")"
  elif [[ -n "$bad" ]]; then
    ko "moca-setup SH_P4_SANDBOX_IDS holds invalid id(s):$bad (setup.sh writes only ids matching $idre)"
  elif [[ -n "$missing" ]]; then
    ko "not in sh:sandbox:records:$missing (have: $(tr '\n' ' ' <<<"$keys"))"
  elif [[ "$tiers_read" == 0 ]]; then
    ko "could not tell whether this stack is tiered (moca-settings unreadable, above), so not which check applies: attached: $ids; container sandboxes: ${containers:-none}"
  elif [[ -z "$tiers" ]]; then
    if [[ -n "$containers" ]]; then
      ko "container sandboxes attached alongside P4: $containers"
    else
      ok "attached: $ids"
    fi
  elif [[ -n "$unlabelled" ]]; then
    ko "P4 record(s) not advertising moca.dev/tier=microvm:$unlabelled (a P6.3 microvm-worker advertises it; an older one gets no sessions on a tiered stack)"
  else
    ok "attached: $ids, each advertising moca.dev/tier=microvm (container sandboxes beside them: ${containers:-none})"
  fi
else
  claim 2 "every sandbox replica is attached through the relay"
  replicas="$(kc -n "$SBX" get statefulset moca-sandbox -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
  [[ -n "$replicas" ]] || { ko "could not read moca-sandbox statefulset replicas"; replicas=0; }
  keys="$(kc -n "$NS" exec redis-0 -- sh -c 'redis-cli HKEYS sh:sandbox:records' 2>/dev/null || true)"
  missing=''
  for i in $(seq 0 $((replicas - 1))); do grep -qx "moca-sandbox-$i" <<<"$keys" || missing="$missing moca-sandbox-$i"; done
  if [[ -z "$missing" ]]; then ok "$replicas attached"; else ko "not in sh:sandbox:records:$missing (have: $(tr '\n' ' ' <<<"$keys"))"; fi
fi

claim 5 "the control plane is ready and advertises the configured harness URL"
want="$(kc -n "$NS" get configmap moca-settings -o jsonpath='{.data.SH_PUBLIC_HARNESS_URL}' 2>/dev/null || true)"
[[ -n "$want" ]] || { ko "could not read moca-settings configmap"; want="(unset)"; }
got="$(curl -s "$CP/v1/discovery" | jq -r '.harnessUrl // empty' 2>/dev/null || true)"
if curl -sf -o /dev/null "$CP/readyz" && [[ "$got" == "$want" ]]; then ok "harnessUrl=$got"; else ko "readyz or discovery: want '$want', got '$got'"; fi

claim 6 "an unauthenticated /turn is refused"
code="$(curl -s -o "$OUT/unauth.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"prompt":"hi"}' "$HARNESS/turn" || true)"
if [[ "$code" == 4* ]] && grep -q token_required "$OUT/unauth.json"; then ok "$code token_required"; else ko "$code: $(head -c 300 "$OUT/unauth.json")"; fi

# mint_api -> $OUT/api.hdr: the api token a device-flow login would return, minted INSIDE the
# control-plane pod with its own signing key (the key never leaves the pod). Tokens travel in header
# files, never argv. A function because the ttl is 900 s, which the async claims below outlast: they
# re-mint rather than inherit a token that expires mid-poll.
mint_api() {
  local api
  api="$(kc -n "$NS" exec deploy/moca-control-plane -c control-plane -- \
    node --import tsx --input-type=module -e \
    "import { readFileSync } from 'node:fs'; import { makeSigner } from './src/token.ts';
     const s = makeSigner(readFileSync('/run/credentials/SH_SESSION_TOKEN_PRIVATE_KEY', 'utf8'));
     process.stdout.write(s.mint({ sub: 'smoke:1', tenant: 'smoke:1', roles: [], scope: ['api'], ttlSeconds: 900 }));" || true)"
  [[ -n "$api" ]] || return 1
  (umask 077; printf 'Authorization: Bearer %s\n' "$api" >"$OUT/api.hdr")
}
# It returns 1 and judges nothing: a failed mint makes a turn UNREADABLE, not wrong, and only the
# caller knows which claim that lands in -- a ko here would add a second FAIL to the caller's own.
# Nothing below this line works without a token, so the FIRST mint ends the run.
mint_api || { ko "could not mint an api token in the control-plane pod"; printf '\nPASS=%s FAIL=%s\n' "$PASS" "$FAIL"; exit 1; }
field=token
[[ "$SMOKE_MODEL_KIND" == bearer ]] || field=key
host="$(sed -E 's#^[a-z]+://([^/:]+).*#\1#' <<<"$SMOKE_MODEL_URL")"
SMOKE_TOKEN="$SMOKE_MODEL_TOKEN" jq -nc --arg ep "$SMOKE_MODEL_URL" --arg host "$host" --arg kind "$SMOKE_MODEL_KIND" --arg field "$field" \
  '{kind: $kind, consumer: "inference", destination: {hosts: [$host]}, endpoint: $ep, secret: {($field): env.SMOKE_TOKEN}}' >"$OUT/cred.json"
put="$(curl -s -o "$OUT/put.json" -w '%{http_code}' -X PUT -H @"$OUT/api.hdr" -H 'Content-Type: application/json' \
  --data-binary @"$OUT/cred.json" "$CP/v1/credentials/smoke-inference" || true)"
rm -f "$OUT/cred.json"
[[ "$put" == 2* ]] || { ko "PUT /v1/credentials answered $put: $(head -c 300 "$OUT/put.json")"; }

# new_session [quiet] -> sets SID; the session token goes into $OUT/<sid>.hdr. quiet: a failure is not
# a FAIL line, only its reason in SESSION_ERR (for a caller that retries).
# shellcheck disable=SC2120 # quiet is passed through wait_for, which shellcheck cannot follow
new_session() {
  local s tok
  SESSION_ERR=''
  s="$(curl -s --max-time 10 -X POST -H @"$OUT/api.hdr" -H 'Content-Type: application/json' -d "$SESSION_BODY" "$CP/v1/sessions" || true)"
  SID="$(jq -r '.sessionId // empty' <<<"$s" 2>/dev/null || true)"
  [[ -n "$SID" ]] || SESSION_ERR="POST /v1/sessions returned no session: ${s:0:300}"
  if [[ -z "$SESSION_ERR" ]]; then
    tok="$(jq -r '.token // empty' <<<"$s" 2>/dev/null || true)"
    [[ -n "$tok" ]] || SESSION_ERR="POST /v1/sessions returned no token for session $SID"
  fi
  if [[ -n "$SESSION_ERR" ]]; then [[ "${1-}" == quiet ]] || ko "$SESSION_ERR"; return 1; fi
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
# submit_async TAG SID PROMPT -> prints the turn id, '' on failure; the 202 body stays at $OUT/TAG.sub.
# An api token, not a session token: all three async turn routes are auth: 'api' (routes.ts). No
# idempotencyKey, which defaults to the session id -- so each submission needs its OWN session, or
# the second would be deduplicated onto the first turn (spec §4.3).
submit_async() {
  curl -s --max-time 20 -o "$OUT/$1.sub" -X POST -H @"$OUT/api.hdr" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg p "$3" '{async: true, kind: "prompt", prompt: $p}')" "$CP/v1/sessions/$2/turns" || true
  jq -r '.turnId // empty' "$OUT/$1.sub" 2>/dev/null || true
}
# turn_state SID TURNID -> prints "<state> <attempts>", '' when the read failed. The record's state
# is the source of truth; `result` appears only once it is terminal (turn-handlers.ts).
turn_state() {
  curl -s --max-time 20 -H @"$OUT/api.hdr" "$CP/v1/sessions/$1/turns/$2" |
    jq -r 'select(.state) | "\(.state) \(.attempts // 0)"' 2>/dev/null || true
}
# A prompt leaf ends `responded`; the rest are the other terminal states a failure would land in.
is_terminal() { case "$1" in responded | done | solved | failed | cancelled | lost) return 0 ;; *) return 1 ;; esac; }
# await_turn SID TURNID SECONDS -> prints the final "<state> <attempts>"; false on timeout.
await_turn() {
  local st=''
  for _ in $(seq "$3"); do
    st="$(turn_state "$1" "$2")"
    if [[ -n "$st" ]] && is_terminal "${st%% *}"; then echo "$st"; return 0; fi
    sleep 1
  done
  echo "${st:-unreadable}"
  return 1
}

if [[ "$TIER" == p4 ]]; then
  claim P3 "an authenticated turn runs in a P4 microVM: a kernel that is no node's, and a file written"
  SID=''
  if new_session && turn p4write "$SID" "$(ask K8S-SMOKE-P4-WRITE 'uname -r; echo p4-proof | tee proof.txt')" &&
    grep -q p4-proof <(tool_out "$OUT/p4write.sse"); then
    guest="$(tool_out "$OUT/p4write.sse" | tool_text | first_line || true)"
    raw="$(tool_out "$OUT/p4write.sse" | tr '\n' ' ' || true)"
    nodes="$(kc get nodes -o jsonpath='{.items[*].status.nodeInfo.kernelVersion}' 2>/dev/null || true)"
    kre='^[0-9]+\.[0-9]+'
    if [[ -z "$nodes" ]]; then
      ko "could not read the nodes' kernels (kubectl get nodes)"
    elif ! [[ "$guest" =~ $kre ]]; then
      ko "the turn's output '$guest' is not a kernel release (preview: ${raw:0:300})"
    elif [[ " $nodes " == *" $guest "* ]]; then
      ko "the turn's kernel '$guest' is a node's ($nodes): it did not run in a microVM"
    else
      ok "session $SID ran on kernel $guest (nodes run $nodes)"
    fi
  else
    ko "p4 write turn: $(head -c 600 "$OUT/p4write.sse" 2>/dev/null)"
  fi
  FIRST_SID="$SID"

  claim P4 "a second turn in the same session reads the file back: the microVM workspace persisted"
  if [[ -n "$FIRST_SID" ]] && turn p4read "$FIRST_SID" "$(ask K8S-SMOKE-P4-READ 'cat proof.txt')" &&
    grep -q p4-proof <(tool_out "$OUT/p4read.sse"); then
    ok
  else
    ko "p4 read turn: $(head -c 600 "$OUT/p4read.sse" 2>/dev/null)"
  fi
else
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
fi

# kind-ci only: the ids are the mock's, which a real model does not have. The mock listens on the
# harness pod's loopback, so the control plane cannot list the credential's models and accepts both
# ids unverified (spec §8); the gateway, the mock, then sees which one each turn carries.
if [[ "$TARGET" == kind-ci ]]; then
  claim M1 "a session's model is chosen at creation and switched with PATCH; the turn names the switched one"
  # SESSION_BODY may already name a sandbox tier: add the model to it rather than replace it.
  SESSION_BODY_SAVED="$SESSION_BODY"
  SESSION_BODY="$(jq -c '. + {model: "mock-a"}' <<<"$SESSION_BODY")"
  SID=''
  if new_session; then
    sw="$(curl -s -o "$OUT/patch.json" -w '%{http_code}' -X PATCH -H @"$OUT/api.hdr" -H 'Content-Type: application/json' \
      -d '{"model":"mock-b"}' "$CP/v1/sessions/$SID" || true)"
    if [[ "$sw" != 200 ]]; then
      ko "PATCH /v1/sessions/$SID answered $sw: $(head -c 300 "$OUT/patch.json")"
    elif turn model "$SID" "Reply with the model you are. [K8S-SMOKE-MODEL]" &&
      grep -q 'model=mock-b' "$OUT/model.sse"; then
      ok "session $SID switched to mock-b and its turn reached the gateway as mock-b"
    else
      ko "model turn: $(head -c 600 "$OUT/model.sse" 2>/dev/null)"
    fi
  fi
  SESSION_BODY="$SESSION_BODY_SAVED"
fi

if [[ "$TIER" == p4 ]]; then
  # Runs in the control-plane pod (its egress allows 443 anywhere), from the relay package's directory:
  # that is where the image's tsx, @grpc/grpc-js and @moca/k8s-sandbox resolve. The exec token and
  # the relay certificate arrive on stdin. A refused attach is ENDED by the relay (relay.ts: status
  # OK, nothing parked), so 0 proves the Route reached the attach handler; a TLS/ALPN/dial failure is
  # 14, an accepted attach stays open (-1).
  ROUTE_PROBE="$(cat <<'JS'
import { readFileSync } from 'node:fs';
import { X509Certificate, randomBytes } from 'node:crypto';
import { credentials, makeGenericClientConstructor, Metadata } from '@grpc/grpc-js';
import { SandboxWorkerService, SandboxExecClient, WorkerFrame, ExecRequest } from '@moca/k8s-sandbox';
const { exec, ca } = JSON.parse(readFileSync(0, 'utf8'));
const addr = process.env.P4_RELAY_ADDR;
const cert = new X509Certificate(ca);
// setup.sh's self-signed certificate is its own CA; an operator's chains to the system roots.
// createSsl(null) trusts Node's bundled roots, while the Go worker trusts the host's system pool:
// an operator certificate from an internal CA can pass on the host but fail P6, or the reverse.
const creds = credentials.createSsl(cert.checkIssued(cert) ? Buffer.from(ca) : null);
const bearer = (t) => { const md = new Metadata(); md.set('authorization', `Bearer ${t}`); return md; };
const codeOf = (call) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(-1), 15000);
  const done = (c) => { clearTimeout(timer); resolve(c); };
  call.on('data', () => {});
  call.on('error', (e) => done(e.code));
  call.on('status', (s) => done(s.code));
});
const Worker = makeGenericClientConstructor(SandboxWorkerService, 'SandboxWorker');
const w = new Worker(addr, creds);
const a = w.attach(bearer(`smoke-wrong-${randomBytes(16).toString('hex')}`));
a.write(WorkerFrame.fromPartial({ hello: { sandboxId: 'smoke_probe', capacityMax: 1 } }));
const attach = await codeOf(a);
a.cancel(); w.close();
const x = new SandboxExecClient(addr, creds);
const e = x.exec(ExecRequest.fromPartial({}), bearer(exec));
const execCode = await codeOf(e);
e.cancel(); x.close();
process.stdout.write(`attach=${attach} exec=${execCode}\n`);
process.exit(0);
JS
)"
  claim P6 "through the relay Route: a wrong attach token is refused at the relay, and SandboxExec is not served even with the exec token"
  relay_host="$(kc -n "$NS" get route moca-relay -o jsonpath='{.spec.host}' 2>/dev/null || true)"
  if [[ -z "$relay_host" ]]; then
    ko "no Route moca-relay (setup.sh renders it only with SH_P4_SANDBOX_IDS)"
  else
    probe_out="$({ kc -n "$NS" get secret moca-relay -o json && kc -n "$NS" get secret moca-relay-tls -o json; } |
      jq -cs '{exec: (.[0].data.MOCA_RELAY_EXEC_TOKEN | @base64d), ca: (.[1].data["tls.crt"] | @base64d)}' |
      kc -n "$NS" exec -i deploy/moca-control-plane -c control-plane -- sh -c \
        'cd /app/packages/sandbox-relay && P4_RELAY_ADDR="$1" exec node --import tsx --input-type=module -e "$0"' \
        "$ROUTE_PROBE" "$relay_host:443" 2>"$OUT/probe.err" || true)"
    if [[ "$probe_out" =~ ^attach=0\ exec=(12|14)$ ]]; then
      ok "$relay_host:443 $probe_out (attach refused at the relay; exec UNIMPLEMENTED/UNAVAILABLE)"
    else
      ko "probe: '$probe_out' (want attach=0 and exec 12 or 14): $(head -c 400 "$OUT/probe.err" 2>/dev/null)"
    fi
  fi

  claim P7 "adding a P4 host reloads no relay: same pod, same start time, no restart"
  if [[ -z "${SMOKE_P4_ADD_ID:-}" ]]; then
    note "skipped: set SMOKE_P4_ADD_ID=<a scratch id> to run it (it re-runs setup.sh to add the id, then to remove it)"
  else
    relay_state() {
      kc -n "$NS" get pods -l app=sandbox-relay -o json | jq -r '[.items[] | select(.metadata.deletionTimestamp == null) |
        "\(.metadata.name) \(.status.startTime) \([.status.containerStatuses[]?.restartCount] | add // 0)"] | join(",")'
    }
    token_seen() { kc -n "$NS" exec deploy/sandbox-relay -c sandbox-relay -- sh -c "test -s /run/relay-tokens/$1" >/dev/null 2>&1; }
    setup_sh="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd || true)/setup.sh"
    ids="$(kc -n "$NS" get configmap moca-setup -o jsonpath='{.data.SH_P4_SANDBOX_IDS}' 2>/dev/null || true)"
    before="$(relay_state 2>/dev/null || true)"
    if [[ -z "$ids" || -z "$before" ]]; then
      ko "could not read SH_P4_SANDBOX_IDS ('$ids') or the relay pod ('$before')"
    elif [[ ",$ids," == *",$SMOKE_P4_ADD_ID,"* ]]; then
      ko "SMOKE_P4_ADD_ID=$SMOKE_P4_ADD_ID is already a P4 host: pick a scratch id"
    else
      # SH_SANDBOX_COUNT and SH_SANDBOX_DEFAULT_TIER are not given: both are sticky (moca-setup), so
      # both runs keep the stack's values. Forcing a count of 0 here would scale a mixed stack's
      # container sandboxes away (and untier it). `env -u`: an operator's exported value must not
      # change the stack either.
      # setup.sh writes the sticky moca-setup early, so even a failed add can leave the scratch id
      # behind (sticky, with a token and a bundle): the restore runs whenever the add was attempted.
      if ! env -u SH_SANDBOX_COUNT -u SH_SANDBOX_DEFAULT_TIER SH_P4_SANDBOX_IDS="$ids,$SMOKE_P4_ADD_ID" bash "$setup_sh" --target ocp >"$OUT/p7-add.log" 2>&1; then
        ko "setup.sh adding $SMOKE_P4_ADD_ID failed (log kept: $OUT/p7-add.log)"
      else
        t0="$SECONDS"
        if wait_for 180 token_seen "$SMOKE_P4_ADD_ID"; then
          seen=$((SECONDS - t0))
          after="$(relay_state 2>/dev/null || true)"
          if [[ "$after" == "$before" ]]; then
            ok "$SMOKE_P4_ADD_ID's token reached the relay's directory in ${seen}s; relay pod unchanged ($after)"
          else
            ko "the relay pod changed: before '$before', after '$after'"
          fi
        else
          ko "$SMOKE_P4_ADD_ID's token never appeared in the relay's /run/relay-tokens within 180s"
        fi
      fi
      # Put the list back: revokes the scratch id and deletes its bundle.
      env -u SH_SANDBOX_COUNT -u SH_SANDBOX_DEFAULT_TIER SH_P4_SANDBOX_IDS="$ids" bash "$setup_sh" --target ocp >"$OUT/p7-restore.log" 2>&1 ||
        ko "setup.sh restoring SH_P4_SANDBOX_IDS=$ids failed (log kept: $OUT/p7-restore.log): re-run it by hand"
    fi
  fi
  summary
  exit
fi

claim 7 "a sandbox reaches the relay's attach port and nothing else in the cluster"
probe() {
  kc -n "$SBX" exec moca-sandbox-0 -c sandbox -- bash -c \
    'timeout 3 bash -c "</dev/tcp/$0/$1" 2>/dev/null && echo OPEN || echo BLOCKED' "$1" "$2" 2>/dev/null || echo ERROR
}
iso_ok=1
for t in redis.$NS.svc:6379 sandbox-relay-exec.$NS.svc:9444 169.254.169.254:80; do
  r="$(probe "${t%:*}" "${t#*:}")"
  [[ "$r" == BLOCKED ]] || { iso_ok=0; ko "$t is $r from a sandbox (want BLOCKED)"; }
done
r="$(probe kubernetes.default.svc 443)"
if [[ "$TARGET" == ocp ]]; then
  [[ "$r" == BLOCKED ]] || { iso_ok=0; ko "kubernetes.default.svc:443 is $r (want BLOCKED)"; }
elif [[ "$TARGET" == ocp-single ]]; then
  # The three-namespace ocp target enforces this; on a shared cluster a cluster-level network
  # allowance can admit the apiserver endpoint past the namespace's policies (on ROKS, the
  # node-local proxy 172.20.0.1:2040, inside the excepted 172.16.0.0/12). The sandbox mounts no
  # ServiceAccount token, so the API refuses it either way. README §12.3.
  note "kubernetes.default.svc:443 is $r (a cluster-level network allowance can admit it past the namespace's policies; the sandbox holds no ServiceAccount token — README §12.3)"
else
  note "kubernetes.default.svc:443 is $r (single-node kind: kindnet does not filter node-local traffic; enforced on OCP — README Troubleshooting)"
fi
r="$(probe sandbox-relay-attach.$NS.svc 9443)"
[[ "$r" == OPEN ]] || { iso_ok=0; ko "sandbox-relay-attach:9443 is $r (want OPEN)"; }
if [[ "$iso_ok" == 0 ]]; then :; elif [[ "$TARGET" == ocp ]]; then
  ok 'redis, relay exec, kube API and metadata BLOCKED; relay attach OPEN'
elif [[ "$TARGET" == ocp-single ]]; then
  ok 'redis, relay exec and metadata BLOCKED; relay attach OPEN (kube API: see note)'
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

claim 12 "every turn of a session returns to the sandbox of its first turn (affinity, P6.3)"
# First turns run CONCURRENTLY so their leases overlap and the least-loaded choice spreads them over
# both sandboxes. A bare echo often finishes before the next turn leases, and then least-loaded puts
# every session on one sandbox, where the second turns land with or without affinity: so each first
# turn holds its lease for 2 s (`sleep 2`). Second turns run one by one, when every sandbox is idle.
# Without affinity the second turns would all go to the first sandbox, so a session first served by
# the other one would move.
# Plain indexed arrays (bash 3.2), and wait on OUR pids only: port-forwards run in the background too.
aff_sids=() aff_pids=() aff_first=()
aff_ok=1 aff_down=0
# Claim 10 just restarted Redis, and nothing above waits for the supervisor and the control plane to
# reconnect: the first session is retried for up to 60 s, so a stack still reconnecting is not a FAIL
# of affinity. That session is the first of the four.
if wait_for 60 new_session quiet; then
  aff_sids+=("$SID")
  for i in 1 2 3; do new_session && aff_sids+=("$SID"); done
  [[ "${#aff_sids[@]}" == 4 ]] || aff_ok=0
else
  aff_ok=0 aff_down=1
fi
for i in ${aff_sids[@]+"${!aff_sids[@]}"}; do
  # shellcheck disable=SC2016 # $HOSTNAME is the sandbox's: it must expand there, not here
  (
    # Asked once, into a variable: the retry below must send the same command, and the mock
    # scripts exactly the one ask (tests/smoke.test.sh syncs every ask line with mock-anthropic.mjs).
    where1="$(ask K8S-SMOKE-WHERE-1 'sleep 2; echo "where=$HOSTNAME"')"
    turn "where1-$i" "${aff_sids[$i]}" "$where1" && exit 0
    # The burst is four turns of ONE subject on a pool whose trial size fits them exactly (W=2,
    # S=4, so the per-subject cap is 2 per worker): routing's estimate is optimistic and a
    # worker's stale `load` report can lower it after the next hand-off -- over-admission the
    # supervisor accepts by design (§3.9) and counts -- so a burst can hand one worker a third
    # turn, which the quota refuses with 429 subject_quota_exceeded: its own code, sent with
    # Retry-After, precisely so a client can tell "you are over your share" from "the host is
    # full" and back off. Back off and retry that code alone, twice (a lease frees in 2 s);
    # any other failure, or a third refusal, fails the claim as before.
    for _ in 1 2; do
      grep -q subject_quota_exceeded "$OUT/where1-$i.sse" || exit 1
      sleep 2
      turn "where1-$i" "${aff_sids[$i]}" "$where1" && exit 0
    done
    exit 1
  ) &
  aff_pids+=("$!")
done
for p in ${aff_pids[@]+"${aff_pids[@]}"}; do wait "$p" || aff_ok=0; done
# tool_text decodes a real model's JSON envelope and passes the mock's plain preview through (as P3
# relies on). `|| true`: a turn whose stream is not JSON must read as no sandbox, not end the run.
where_of() { tool_out "$OUT/$1.sse" | tool_text | sed -n 's/.*where=\([A-Za-z0-9_.-]*\).*/\1/p' | first_line || true; }
for i in ${aff_sids[@]+"${!aff_sids[@]}"}; do
  aff_first[i]="$(where_of "where1-$i")"
  [[ -n "${aff_first[$i]}" ]] || aff_ok=0
done
for i in ${aff_sids[@]+"${!aff_sids[@]}"}; do
  # shellcheck disable=SC2016 # as above
  turn "where2-$i" "${aff_sids[$i]}" "$(ask K8S-SMOKE-WHERE-2 'echo "where=$HOSTNAME"')" || aff_ok=0
  again="$(where_of "where2-$i")"
  [[ -n "$again" && "$again" == "${aff_first[$i]}" ]] ||
    { aff_ok=0; echo "  session ${aff_sids[$i]}: first '${aff_first[$i]}', then '$again'"; }
done
if ((aff_down)); then
  ko "the stack took no new session within 60s of the Redis restart (claim 10); last: $SESSION_ERR"
elif ((aff_ok)); then ok "4 sessions, each on one sandbox for both turns"; else ko "a session moved between sandboxes, or a turn failed"; fi
# The note qualifies a pass only: after a FAIL there is nothing to tell apart from luck.
spread="$(printf '%s\n' ${aff_first[@]+"${aff_first[@]}"} | sort -u | grep -c . || true)"
((!aff_ok)) || [[ "$spread" -ge 2 ]] ||
  note "the first turns all landed on one sandbox, so this run could not tell affinity from luck"

# The async leaf consumer (#688, ADR-0047, README §14). Opt-in: setup.sh writes SH_ASYNC_DRAIN to
# moca-settings only when it was asked for, so an absent key means this stack runs no drain and both
# claims below are SKIPPED rather than failed. A failed read is not an absent key (the tiers read
# above is the same rule): an unreadable moca-settings cannot say "the drain is off".
async_drain="$(kc -n "$NS" get configmap moca-settings -o jsonpath='{.data.SH_ASYNC_DRAIN}' 2>"$OUT/async.err")" ||
  async_drain=unreadable
async_n=5

claim 13 "five async leaves, on a stack that runs two at a time, all reach a result"
if [[ "$async_drain" == unreadable ]]; then
  ko "could not read configmap moca-settings (SH_ASYNC_DRAIN): $(head -c 300 "$OUT/async.err" 2>/dev/null)"
elif [[ "$async_drain" != 1 ]]; then
  note "SH_ASYNC_DRAIN is unset on this stack, so no worker drains the queue: skipped (README §14.1)"
else
  # Five SESSIONS, not five turns on one: idempotencyKey defaults to the session id, so siblings on
  # one session would all be deduplicated onto the first turn (spec §4.3).
  async_sids=() async_tids=() async_states=()
  async_ok=1
  still_queued=0
  bad=''
  mint_api || { async_ok=0; echo "  could not mint an api token in the control-plane pod"; }
  if ((async_ok)); then
    # quiet: one ko for the claim, not one per session that could not be opened.
    for _ in $(seq "$async_n"); do new_session quiet && async_sids+=("$SID") || async_ok=0; done
    ((async_ok)) || echo "  could not open $async_n sessions: $SESSION_ERR"
  fi
  if ((async_ok)); then
    for i in ${async_sids[@]+"${!async_sids[@]}"}; do
      t="$(submit_async "async-$i" "${async_sids[$i]}" "$(ask K8S-SMOKE-ASYNC 'echo async-leaf-ok')")"
      if [[ -z "$t" ]]; then
        async_ok=0
        echo "  POST .../turns on ${async_sids[$i]} returned no turnId: $(head -c 300 "$OUT/async-$i.sub" 2>/dev/null)"
        break
      fi
      async_tids+=("$t")
    done
  fi
  # The wiring proof, and the one honest arming check: both gauges read "NaN" until worker slot 0
  # reports them, and only an ARMED worker reports at all. So a NUMBER -- 0 included -- is positive
  # evidence that SH_ASYNC_DRAIN=1 reached a worker process, where a bare 0 would be ambiguous.
  depth="$(curl -s "$ADMIN/metrics" | jq -r '.async_queue_depth' 2>/dev/null || true)"
  if ((async_ok)); then
    # How many were still waiting when the last 202 landed. A note, not an assertion: with W=2 the
    # queue should be backed up here, but a stack fast enough to drain it as it fills is not a bug.
    for i in ${async_tids[@]+"${!async_tids[@]}"}; do
      if [[ "$(turn_state "${async_sids[$i]}" "${async_tids[$i]}")" == queued* ]]; then
        still_queued=$((still_queued + 1))
      fi
    done
    note "$still_queued of $async_n still queued when the last 202 landed (fan-out is replicas x SH_WORKERS wide, 2 by default)"
    # All five on ONE deadline, not 240 s each: the leaves run concurrently, so a sequential
    # per-turn budget would multiply one stall into a 20-minute claim.
    deadline=$((SECONDS + 240))
    while :; do
      pending=0
      for i in ${async_tids[@]+"${!async_tids[@]}"}; do
        async_states[i]="$(turn_state "${async_sids[$i]}" "${async_tids[$i]}")"
        is_terminal "${async_states[$i]%% *}" || pending=$((pending + 1))
      done
      ((pending)) || break
      [[ "$SECONDS" -lt "$deadline" ]] || break
      sleep 3
    done
    for i in ${async_tids[@]+"${!async_tids[@]}"}; do
      [[ "${async_states[$i]%% *}" == responded ]] ||
        bad="$bad ${async_tids[$i]}=${async_states[$i]:-unreadable}"
    done
    # One result read in full: `responded` says the agent loop finished, the text says the leaf's
    # tool actually ran. /runs/status would answer `queued` here forever -- this is the turn route.
    text="$(curl -s --max-time 20 -H @"$OUT/api.hdr" "$CP/v1/sessions/${async_sids[0]}/turns/${async_tids[0]}" |
      jq -r '.result.text // empty' 2>/dev/null || true)"
    grep -q async-leaf-ok <<<"$text" ||
      bad="$bad (${async_tids[0]} returned no tool output: '${text:0:200}')"
  fi
  # A NUMBER, not "anything but NaN": an absent key reads as `null` and an unreachable admin port as
  # '', and neither is evidence of an armed worker. One message for both, because the reading alone
  # cannot tell them apart -- and claiming one of them would send the reader to the wrong place.
  if [[ ! "$depth" =~ ^[0-9]+$ ]]; then
    ko "the admin port answered async_queue_depth='${depth:-<nothing>}', not a number: either no worker reported the gauge (so SH_ASYNC_DRAIN=1 reached none of them, README §14.1) or $ADMIN/metrics is unreachable"
  elif ((!async_ok)); then
    ko "could not submit $async_n async leaves (above)"
  elif [[ -n "$bad" ]]; then
    ko "not every async leaf reached a result:$bad"
  else
    ok "$async_n leaves, all responded (async_queue_depth read $depth; slot 0 refreshes it every 10s, so it lags the last 202)"
  fi
fi

claim 14 "an async leaf whose supervisor pod is deleted mid-run is redelivered and finishes"
# #389's crash-redelivery acceptance, on deploy/k8s. Deleting the pod is the cluster's kill -9: the
# drain abandons its in-flight leaf UNACKED (it does not kill it, and does not DELCONSUMER), so the
# entry sits in the PEL until XAUTOCLAIM reclaims it past MIN_IDLE_MS. Last claim of the run: it
# costs a rollout, and claim 11's restart count must not see it.
if [[ "$async_drain" != 1 ]]; then
  note "no drain on this stack (claim 13 says why): skipped"
else
  SID='' pod='' tid='' st_err=''
  if new_session quiet; then
    # Not one already terminating from claim 9: deleting it again would prove nothing.
    pod="$(kc -n "$NS" get pods -l app=moca-supervisor -o json 2>/dev/null |
      jq -r '[.items[] | select(.metadata.deletionTimestamp == null)][0].metadata.name // empty' 2>/dev/null || true)"
    tid="$(submit_async async-crash "$SID" "$(ask K8S-SMOKE-ASYNC-SLOW 'sleep 40; echo async-slow-ok')")"
  fi
  is_running() { [[ "$(turn_state "$1" "$2")" == running* ]]; }
  if [[ -z "$pod" || -z "$tid" ]]; then
    ko "could not start a slow async leaf on a live supervisor pod: pod='${pod:-none}' turn='${tid:-none}' ${SESSION_ERR:-}"
  elif ! wait_for 60 is_running "$SID" "$tid"; then
    ko "the leaf never reached running within 60s, so the delete below would prove nothing: $(turn_state "$SID" "$tid")"
  else
    kc -n "$NS" delete pod "$pod" --wait=false >/dev/null || true
    kc -n "$NS" rollout status deployment/moca-supervisor --timeout=300s >/dev/null || true
    forward || ko "port-forward did not come back after the async pod delete"
    # The first token is ~900 s old by now, so re-mint. Without one every read below is a 401 and
    # the turn is UNREADABLE -- which is not the same as a leaf that never finished, and must not be
    # reported as one.
    mint_api || st_err='could not re-mint an api token after the rollout, so this claim cannot read the turn'
    # 240 s covers MIN_IDLE_MS (90 s, the floor before any reclaim), the rollout, and a second run
    # of the 40 s leaf. Skipped without a token: four minutes of 401s prove nothing.
    st=''
    [[ -n "$st_err" ]] || st="$(await_turn "$SID" "$tid" 240)" || true
    if [[ -n "$st_err" ]]; then
      ko "$st_err"
    elif [[ "${st%% *}" != responded ]]; then
      ko "the leaf did not finish after its pod was deleted: $st"
    elif [[ "${st##* }" -lt 2 ]]; then
      ko "the leaf finished on attempt ${st##* }: it was never redelivered, so the delete did not interrupt it"
    else
      ok "pod $pod deleted mid-leaf; turn $tid finished on delivery ${st##* }"
    fi
  fi
fi

summary
