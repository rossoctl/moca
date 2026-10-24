#!/usr/bin/env bash
# The two-user demo of per-workload sandboxes (#476) on the Kind stack setup.sh brought up. Alice
# and Bob each pack their own repo and create a workload with sandboxes of its own; their tasks run,
# and run.sh checks where each ran, what each could see and write, that Bob cannot reach Alice's
# workload, and that deleting the workloads leaves nothing behind. Alice also creates a phase 1
# workload (no --sandboxes), which must behave as before. Prints a PASS/FAIL table and exits 1 if
# any check failed.
#
#   run.sh
#
# Environment: MOCA_DEMO_STATE (as for setup.sh), DEMO_TIMEOUT (seconds to wait for a batch of
# tasks, default 300). The prompts carry MOCA-DEMO2-* markers for the scripted mock model
# (deploy/microvm/mock-anthropic.mjs) and spell the work out in words for a real model.

set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${MOCA_DEMO_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/moca-two-users-demo}"
TIMEOUT="${DEMO_TIMEOUT:-300}"
KUBE_CONTEXT=kind-moca-two-users
SBX_NS=moca-sandbox
MOCA_NS=moca
CS_NS=context-service
OUT="$STATE_DIR/results/$(date +%Y%m%dT%H%M%S)"
TAG="demo2-$(date +%s)"
# mocactl prefers these over its config file. Pin them to the demo so a real deployment's exported
# URLs can never receive a demo token or an upload.
export SH_CONTROL_PLANE_URL=http://127.0.0.1:8190 SH_HARNESS_URL=http://127.0.0.1:8180
export PATH="$STATE_DIR/bin:$PATH"
ALICE_WL=alice-repo
BOB_WL=bob-repo
ALICE_P1=alice-phase1
# "user workload" pairs to delete on exit; the forged pods to remove.
CREATED=''
FORGED=''
RESULTS=''
FAILED=0

step() { printf '\n== %s\n' "$*"; }
die() {
  printf 'run.sh: %s\n' "$*" >&2
  exit 1
}
kc() { kubectl --context "$KUBE_CONTEXT" "$@"; }
# as USER CMD...: run CMD with USER's demo-only mocactl login.
as() {
  local u="$1"
  shift
  XDG_CONFIG_HOME="$STATE_DIR/$u/config" XDG_STATE_HOME="$STATE_DIR/$u/state" "$@"
}
# check ACCEPTANCE NAME OK(0|1) [DETAIL]: record one row of the table.
check() {
  local verdict=PASS
  if [ "$3" != 0 ]; then
    verdict=FAIL
    FAILED=1
  fi
  RESULTS="$RESULTS$verdict|$1|$2|${4:-}"$'\n'
  printf '  %s  [%s] %s%s\n' "$verdict" "$1" "$2" "${4:+ ($4)}"
}
# ok CMD...: 0 when CMD succeeds, 1 otherwise, for check's third argument.
ok() { if "$@"; then echo 0; else echo 1; fi; }
table() {
  printf '\n%-5s  %-4s  %s\n' RESULT ACC CHECK
  printf '%s' "$RESULTS" | while IFS='|' read -r v a n d; do
    [ -n "$v" ] || continue
    printf '%-5s  %-4s  %s%s\n' "$v" "$a" "$n" "${d:+ -- $d}"
  done
}
sha32() { printf '%s' "$1" | openssl dgst -sha256 | sed 's/^.*= *//' | cut -c1-32; }

for c in contextctl mocactl jq tar kubectl openssl; do command -v "$c" >/dev/null 2>&1 || die "$c is required (run setup.sh first)"; done
for u in alice bob; do
  [ -f "$STATE_DIR/$u/config/mocactl/auth.json" ] || die "no demo login for $u under $STATE_DIR: run setup.sh first"
done

# Delete what this run created, also after a failure or an interruption, then print the table.
# shellcheck disable=SC2329 # run by the EXIT trap
cleanup() {
  status=$?
  set +e
  for p in $FORGED; do kc -n "$SBX_NS" delete pod "$p" --ignore-not-found --wait=false >/dev/null 2>&1; done
  printf '%s' "$CREATED" | while read -r u w; do
    [ -n "$w" ] || continue
    echo "run.sh: deleting $u's workload $w after a failure" >&2
    as "$u" mocactl workloads delete "$w" >/dev/null 2>&1 ||
      echo "run.sh: could not delete $u's workload $w: XDG_CONFIG_HOME=$STATE_DIR/$u/config mocactl workloads delete $w" >&2
  done
  if [ -n "$RESULTS" ]; then table; fi
  if [ "$status" = 0 ] && [ "$FAILED" != 0 ]; then status=1; fi
  if [ "$status" = 0 ]; then echo 'ALL PASSED'; else echo "FAILED (exit $status); logs in $OUT"; fi
  exit "$status"
}
trap cleanup EXIT
mkdir -p "$OUT/alice" "$OUT/bob"
cd "$OUT"

# create USER NAME ARGS...: create a workload from USER's packed repo; prints the JSON.
create() {
  local u="$1" name="$2"
  shift 2
  CREATED="$CREATED$u $name"$'\n'
  as "$u" mocactl workloads create --context "$u.context" --name "$name" --json "$@"
}
# spawn USER WORKLOAD MARKER WORDS: start a task (WORKLOAD empty: no workload); prints its id.
spawn() {
  local u="$1" w="$2" m="$3" words="$4"
  if [ -n "$w" ]; then
    as "$u" mocactl spawn --kind prompt --workload "$w" --tag "$TAG" "$m. $words"
  else
    as "$u" mocactl spawn --kind prompt --tag "$TAG" "$m. $words"
  fi
}
# await USER SID...: wait until none of USER's SIDs is running, then fetch each result into
# $OUT/USER/SID.text. Fails if any task failed.
await() {
  local u="$1" waited=0 states sid status=0
  shift
  while :; do
    states="$(as "$u" mocactl subagents --tag "$TAG" --json | jq -r '.subagents[] | "\(.sessionId) \(.state)"')"
    local busy=0
    for sid in "$@"; do
      if printf '%s\n' "$states" | grep -qx "$sid running"; then busy=1; fi
    done
    [ "$busy" = 1 ] || break
    [ "$waited" -lt "$TIMEOUT" ] || die "$u's tasks still running after ${TIMEOUT}s"
    sleep 3
    waited=$((waited + 3))
  done
  for sid in "$@"; do
    as "$u" mocactl get "$sid" --out "$OUT/$u" >/dev/null || status=1
    printf -- '--- %s %s\n' "$u" "$sid"
    cat "$OUT/$u/$sid.text" 2>/dev/null || true
  done
  return "$status"
}
# field USER SID KEY: the first KEY=value a task printed.
field() { sed -n "s/^$3=//p" "$OUT/$1/$2.text" 2>/dev/null | head -1; }
has() { grep -qF -- "$3" "$OUT/$1/$2.text" 2>/dev/null; }
in_list() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }

ALICE_SCOPE="$(sha32 demo:alice)"
BOB_SCOPE="$(sha32 demo:bob)"
# pods_of SCOPE: the names of that owner's workload sandbox pods, space-separated.
pods_of() {
  kc -n "$SBX_NS" get pods -l "app=moca-workload-sandbox,moca.dev/owner=$1" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{end}'
}

step 'contextctl ctx pack: Alice and Bob each pack their own repo'
for u in alice bob; do
  contextctl ctx pack "$DEMO_DIR/repos/$u" -o "$u.context" >/dev/null
  tar -tzf "$u.context"
done

step '1. Alice and Bob create workloads with sandboxes of their own'
a_json="$(create alice "$ALICE_WL" --sandboxes 2 --mount writable)" || die "Alice's workload create failed"
echo "$a_json"
b_json="$(create bob "$BOB_WL" --sandboxes 1 --mount read-only)" || die "Bob's workload create failed"
echo "$b_json"
p1_json="$(create alice "$ALICE_P1")" || die "Alice's phase 1 workload create failed"
echo "$p1_json"
check 1 "Alice's workload is ready with 2 sandboxes, mount writable" \
  "$(ok test "$(jq -r '"\(.status) \(.sandboxes.count) \(.sandboxes.ready) \(.mount)"' <<<"$a_json")" = 'ready 2 2 writable')"
check 1 "Bob's workload is ready with 1 sandbox, mount read-only" \
  "$(ok test "$(jq -r '"\(.status) \(.sandboxes.count) \(.sandboxes.ready) \(.mount)"' <<<"$b_json")" = 'ready 1 1 read-only')"
check 6 "Alice's phase 1 workload (no --sandboxes) is ready with no sandboxes of its own" \
  "$(ok test "$(jq -r '"\(.status) \(.sandboxes // "none")"' <<<"$p1_json")" = 'ready none')"

ALICE_PODS="$(pods_of "$ALICE_SCOPE")"
BOB_PODS="$(pods_of "$BOB_SCOPE")"
SHARED_PODS="$(kc -n "$SBX_NS" get pods -l app=moca-sandbox -o jsonpath='{range .items[*]}{.metadata.name}{" "}{end}')"
ALICE_KEY="$(kc -n "$SBX_NS" get statefulsets -l "moca.dev/owner=$ALICE_SCOPE" -o jsonpath='{.items[*].metadata.name}')"
BOB_KEY="$(kc -n "$SBX_NS" get statefulsets -l "moca.dev/owner=$BOB_SCOPE" -o jsonpath='{.items[*].metadata.name}')"
# Context Service keeps each Context as a PVC in its namespace, labelled with the Context's name,
# which is the workload key the StatefulSets are named by.
contexts() {
  kc -n "$CS_NS" get persistentvolumeclaims -l app.kubernetes.io/managed-by=context-service \
    -o jsonpath='{range .items[*]}{.metadata.labels.context\.rossoctl\.io/name}{" "}{end}'
}
CONTEXTS="$(contexts)"
echo "Contexts:          $CONTEXTS"
set -- $CONTEXTS
check 1 "Context Service holds exactly this run's three Contexts (fresh cluster), Alice's and Bob's among them" \
  "$(ok sh -c '[ "$1" = 3 ] && case " $2 " in *" $3 "*) case " $2 " in *" $4 "*) exit 0 ;; esac ;; esac; exit 1' _ "$#" "$CONTEXTS" "$ALICE_KEY" "$BOB_KEY")"
set --
echo "Alice's sandboxes: $ALICE_PODS(workload $ALICE_KEY)"
echo "Bob's sandboxes:   $BOB_PODS(workload $BOB_KEY)"
echo "shared pool:       $SHARED_PODS"
set -- $ALICE_PODS
na=$#
set -- $BOB_PODS
nb=$#
set --
check 1 'the provisioner made 2 pods for Alice and 1 for Bob, none shared' \
  "$(ok test "$na $nb" = '2 1')" "alice=$ALICE_PODS bob=$BOB_PODS"
# Each pod mounts only its own workload's PVC, read-only at the revision or writable at its tree.
mounts="$(kc -n "$SBX_NS" get pods -l app=moca-workload-sandbox -o json | jq -r '.items[] |
  .metadata.labels["moca.dev/workload"] as $wl |
  ([.spec.volumes[] | select(.persistentVolumeClaim) | .persistentVolumeClaim.claimName] | join(",")) as $claims |
  (.spec.containers[0].volumeMounts[] | select(.mountPath == "/workspace/context")) as $m |
  "\(.metadata.name) wl=\($wl) claims=\($claims) subPath=\($m.subPath) ro=\($m.readOnly // false)"')"
printf '%s\n' "$mounts"
own_claims=0
printf '%s\n' "$mounts" | while read -r _ wl claims _ _; do [ "${claims#claims=}" = "${wl#wl=}" ] || exit 1; done || own_claims=1
check 3 "every workload pod mounts only its own workload's PVC" "$own_claims"
a_mount=0
for p in $ALICE_PODS; do printf '%s\n' "$mounts" | grep -q "^$p .* subPath=moca-workspace ro=false$" || a_mount=1; done
check 4 "Alice's pods mount her PVC writable (subPath moca-workspace)" "$a_mount"
b_mount=0
for p in $BOB_PODS; do printf '%s\n' "$mounts" | grep -q "^$p .* subPath=revision/[0-9a-f]* ro=true$" || b_mount=1; done
check 4 "Bob's pod mounts his PVC read-only at the frozen revision" "$b_mount"

step '2-3. Tasks: Alice on her workload, Bob on his, a run with no workload, a phase 1 run'
A_WHO="$(spawn alice "$ALICE_WL" MOCA-DEMO2-WHO 'Print $HOSTNAME, your working directory, and notes.txt.')"
A_PEEK="$(spawn alice "$ALICE_WL" MOCA-DEMO2-PEEK 'Print $HOSTNAME and notes.txt, try to append to notes.txt, then search /workspace, /home, /tmp, /run, /mnt and /var/tmp for lines containing SECRET-.')"
B_PEEK="$(spawn bob "$BOB_WL" MOCA-DEMO2-PEEK 'Print $HOSTNAME and notes.txt, try to append to notes.txt, then search /workspace, /home, /tmp, /run, /mnt and /var/tmp for lines containing SECRET-.')"
SHARED="$(spawn alice '' MOCA-DEMO2-WHO 'Print $HOSTNAME, your working directory, and notes.txt.')"
P1_WHO="$(spawn alice "$ALICE_P1" MOCA-DEMO2-WHO 'Print $HOSTNAME, your working directory, and notes.txt.')"
await alice "$A_WHO" "$A_PEEK" "$SHARED" "$P1_WHO" || check - "Alice's first tasks finished" 1
await bob "$B_PEEK" || check - "Bob's task finished" 1

where="$(field alice "$A_WHO" where) $(field alice "$A_PEEK" where)"
a_on=0
for h in $where; do in_list "$h" "$ALICE_PODS" || a_on=1; done
check 2 "Alice's workload tasks ran on her own sandboxes" "$a_on" "where=$where"
b_where="$(field bob "$B_PEEK" where)"
check 2 "Bob's workload task ran on his own sandbox" "$(ok in_list "$b_where" "$BOB_PODS")" "where=$b_where"
s_where="$(field alice "$SHARED" where)"
check 2 'a task with no workload ran on the shared pool' "$(ok in_list "$s_where" "$SHARED_PODS")" "where=$s_where"
check 4 "Alice's task starts in the mounted context, not a per-run copy" \
  "$(ok test "$(field alice "$A_WHO" cwd)" = /workspace/context/workspace)" "cwd=$(field alice "$A_WHO" cwd)"
check 4 "Bob's task starts in the mounted context, not a per-run copy" \
  "$(ok test "$(field bob "$B_PEEK" cwd)" = /workspace/context/workspace)" "cwd=$(field bob "$B_PEEK" cwd)"
check 3 "Alice's task sees her own notes" "$(ok has alice "$A_WHO" SECRET-ALICE)"
check 3 "Bob's task sees his own notes" "$(ok has bob "$B_PEEK" 'found=/workspace/context/workspace/notes.txt:SECRET-BOB')"
check 3 "Bob's task finds nothing of Alice's anywhere it can read" "$(ok sh -c '! grep -q ALICE "$1"' _ "$OUT/bob/$B_PEEK.text")"
check 3 "Alice's task finds nothing of Bob's anywhere it can read" "$(ok sh -c '! grep -q BOB "$1"' _ "$OUT/alice/$A_PEEK.text")"
check 4 "Bob's read-only workload refuses a write to its context" "$(ok has bob "$B_PEEK" write=refused)"
check 4 "Alice's writable workload accepts a write to its context" "$(ok has alice "$A_PEEK" write=allowed)"
p_where="$(field alice "$P1_WHO" where)"
check 6 'the phase 1 workload task ran on the shared pool' "$(ok in_list "$p_where" "$SHARED_PODS")" "where=$p_where"
check 6 'the phase 1 workload task starts in its per-run copy, with the context' \
  "$(ok sh -c 'case "$1" in /workspace/.moca-context/runs/*) grep -q SECRET-ALICE "$2" ;; *) exit 1 ;; esac' _ "$(field alice "$P1_WHO" cwd)" "$OUT/alice/$P1_WHO.text")" \
  "cwd=$(field alice "$P1_WHO" cwd)"

step '3. Bob names Alice'"'"'s workload'
bob_get=0
as bob mocactl workloads get "$ALICE_WL" >"$OUT/bob/get-alice.out" 2>&1 && bob_get=1
grep -q 'not yours' "$OUT/bob/get-alice.out" || bob_get=1
cat "$OUT/bob/get-alice.out"
check 3 "Bob's GET of Alice's workload is 404 workload_not_found" "$bob_get"
bob_spawn=0
as bob mocactl spawn --kind prompt --workload "$ALICE_WL" --tag "$TAG" 'MOCA-DEMO2-PEEK.' >"$OUT/bob/spawn-alice.out" 2>&1 && bob_spawn=1
cat "$OUT/bob/spawn-alice.out"
check 3 "Bob cannot run a task on Alice's workload" "$bob_spawn"
bob_del=0
as bob mocactl workloads delete "$ALICE_WL" >"$OUT/bob/delete-alice.out" 2>&1 && bob_del=1
cat "$OUT/bob/delete-alice.out"
check 3 "Bob cannot delete Alice's workload" "$bob_del"
check 3 "Alice's workload is still ready after Bob's attempts" \
  "$(ok test "$(as alice mocactl workloads get "$ALICE_WL" --json | jq -r .status)" = ready)"

step '3. A sandbox that claims a workload sandbox id it holds no attach token for'
# forge NAME SANDBOX_ID SECRET KEY|- FILE: a stock worker pod, as an operator could start one in
# moca-sandbox, with the token from SECRET (KEY as SANDBOX_TOKEN, or the Secret mounted as a file).
forge() {
  local name="$1" id="$2" secret="$3" key="$4" image
  FORGED="$FORGED $name"
  image="$(kc -n "$SBX_NS" get statefulset moca-sandbox -o jsonpath='{.spec.template.spec.containers[0].image}')"
  jq -n --arg name "$name" --arg id "$id" --arg secret "$secret" --arg key "$key" --arg image "$image" '
    { apiVersion: "v1", kind: "Pod",
      metadata: { name: $name, labels: { app: "moca-workload-sandbox", "moca-demo": "forged" } },
      spec: {
        automountServiceAccountToken: false, restartPolicy: "Never",
        securityContext: { runAsNonRoot: true, runAsUser: 1001, runAsGroup: 0, seccompProfile: { type: "RuntimeDefault" } },
        containers: [{
          name: "sandbox", image: $image, imagePullPolicy: "IfNotPresent",
          env: ([{ name: "SANDBOX_ID", value: $id }, { name: "RELAY_ADDR", value: "sandbox-relay-attach.moca.svc:9443" }]
            + (if $key == "-" then [{ name: "SANDBOX_TOKEN_FILE", value: "/run/moca-attach/token" }]
               else [{ name: "SANDBOX_TOKEN", valueFrom: { secretKeyRef: { name: $secret, key: $key } } }] end)),
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          volumeMounts: (if $key == "-" then [{ name: "t", mountPath: "/run/moca-attach", readOnly: true }] else [] end) }],
        volumes: (if $key == "-" then [{ name: "t", secret: { secretName: $secret } }] else [] end) } }' |
    kc -n "$SBX_NS" apply -f - >/dev/null
}
# The shared pool's token, as Alice's sandbox 1; then Bob's own attach token, as Alice's sandbox 1.
forge forged-shared "$ALICE_KEY-1" moca-relay-attach SH_RELAY_TOKEN
forge forged-bob-token "$ALICE_KEY-1" "$BOB_KEY-attach" -
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
refused_shared=1
refused_bob=1
for _ in $(seq 1 40); do
  logs="$(kc -n "$MOCA_NS" logs deploy/sandbox-relay --since-time="$since" --all-containers 2>/dev/null || true)"
  printf '%s\n' "$logs" | grep -q "attach refused for $ALICE_KEY-1: a workload sandbox id needs an attach token" && refused_shared=0
  printf '%s\n' "$logs" | grep -q "attach refused for $ALICE_KEY-1: sandbox id is not an ordinal below n of its token's workload" && refused_bob=0
  [ "$refused_shared$refused_bob" != 00 ] || break
  sleep 3
done
kc -n "$MOCA_NS" logs deploy/sandbox-relay --since-time="$since" --all-containers 2>/dev/null | grep 'attach refused' | sort -u || true
check 3 "the relay refuses a shared-token sandbox claiming Alice's sandbox id" "$refused_shared"
check 3 "the relay refuses Bob's attach token claiming Alice's sandbox id" "$refused_bob"
for p in $FORGED; do kc -n "$SBX_NS" delete pod "$p" --ignore-not-found >/dev/null; done
FORGED=''

step "4. Alice's writable tree persists across her tasks and sandboxes"
A_WRITE="$(spawn alice "$ALICE_WL" MOCA-DEMO2-WRITE 'Print $HOSTNAME, then write "written-by=$HOSTNAME" to run-note.txt.')"
await alice "$A_WRITE" || check - "Alice's write task finished" 1
writer="$(field alice "$A_WRITE" written-by)"
[ -n "$writer" ] || writer="$(field alice "$A_WRITE" where)"
# Two at once, so least-loaded selection spreads them over both of her sandboxes.
A_RB1="$(spawn alice "$ALICE_WL" MOCA-DEMO2-READBACK 'Wait 2 seconds, print $HOSTNAME, then print run-note.txt.')"
A_RB2="$(spawn alice "$ALICE_WL" MOCA-DEMO2-READBACK 'Wait 2 seconds, print $HOSTNAME, then print run-note.txt.')"
await alice "$A_RB1" "$A_RB2" || check - "Alice's read-back tasks finished" 1
check 4 "Alice's write task wrote run-note.txt" "$(ok test "$(field alice "$A_WRITE" write-exit)" = 0)" "on $writer"
rb_ok=0
other=0
for sid in "$A_RB1" "$A_RB2"; do
  [ "$(field alice "$sid" note)" = "written-by=$writer" ] || rb_ok=1
  [ "$(field alice "$sid" where)" = "$writer" ] || other=1
done
check 4 "both later tasks see the note" "$rb_ok" "on $(field alice "$A_RB1" where) and $(field alice "$A_RB2" where)"
check 4 "a task on Alice's other sandbox sees it too (one shared tree)" "$(ok test "$other" = 1)"
all_where="$where $(field alice "$A_WRITE" where) $(field alice "$A_RB1" where) $(field alice "$A_RB2" where)"
a_on=0
for h in $all_where; do in_list "$h" "$ALICE_PODS" || a_on=1; done
check 2 "every one of Alice's workload tasks ran on her sandboxes, none on Bob's or the shared pool" "$a_on"

step '5. Alice and Bob delete their workloads'
del_ok=0
for pair in "alice $ALICE_WL" "bob $BOB_WL" "alice $ALICE_P1"; do
  set -- $pair
  # The record stays as a tombstone, `status: deleted`. A delete that outlasts its wait answers
  # 202 (`deleting`, still exit 0); a repeat finishes it.
  st=''
  for _ in 1 2 3 4 5; do
    as "$1" mocactl workloads delete "$2" || break
    st="$(as "$1" mocactl workloads get "$2" --json | jq -r .status)"
    [ "$st" != deleted ] || break
    sleep 5
  done
  [ "$st" = deleted ] || del_ok=1
  echo "$1's workload $2: ${st:-delete failed}"
done
set --
CREATED=''
check 5 'mocactl workloads delete removed all three workloads' "$del_ok"
left="$(kc -n "$SBX_NS" get statefulsets,services,secrets,persistentvolumeclaims,pods \
  -l "moca.dev/owner in ($ALICE_SCOPE,$BOB_SCOPE)" -o name 2>&1)"
for k in $ALICE_KEY $BOB_KEY; do
  for o in "statefulset/$k" "service/$k" "secret/$k-attach" "persistentvolumeclaim/$k" "pod/$k-0" "pod/$k-1"; do
    kc -n "$SBX_NS" get "$o" >/dev/null 2>&1 && left="$left $o"
  done
done
check 5 'no StatefulSet, Service, attach Secret, PVC or pod of either workload remains' \
  "$(ok test -z "$(printf '%s' "$left" | tr -d '[:space:]')")" "${left:-none left}"
cs_left="$(contexts)"
check 5 "no Context of the three workloads remains in Context Service" \
  "$(ok test -z "$(printf '%s' "$cs_left" | tr -d '[:space:]')")" "${cs_left:-none left}"
echo
echo "Results: $OUT"
