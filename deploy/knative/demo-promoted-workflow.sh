#!/usr/bin/env bash
# deploy/knative/demo-promoted-workflow.sh
# Scripted sibling of docs/demos/promoted-workflow-demo.md — asserts every claim the guided
# walkthrough makes, with no narration.
#
# The claim: a Claude Code workflow authored in a MINIMAL LOCAL SANDBOX (one skill, a CLAUDE.md,
# one memory file, one slash command) runs unchanged in the harness. Proved by dispatching the
# SAME prompt twice to the SAME cluster, differing only by the `configRef` field:
#
#   A (bare)     -> generic prose. Cannot cite KAG-4471; nothing told it that id exists.
#   B (promoted) -> cites KAG-4471 (promoted memory), carries a RISK line (promoted CLAUDE.md),
#                   and echoes a token readable ONLY inside the sandbox pod (promoted skill).
#
# Why the token is the load-bearing claim: pi puts a skill's name/description in the system prompt
# and tells the model to `read` the body on demand (pi-fork core/skills.ts formatSkillsForPrompt).
# That read executes in the SEPARATE sandbox pod. So the token cannot appear unless the bundle
# materialised on BOTH halves of the fs-free split and the injected absolute skills path resolved
# to the skill's own subdirectory. It is the sibling-read claim of the spec's live smoke, dispatched
# over HTTP instead of in-process.
#
# The `HOME` override is the point of the demo, not a trick to skip work: it makes promote read the
# sandbox as USER scope, so exactly one skill travels instead of a whole ~/.claude. That is the
# sandbox-first authoring the design recommends (spec §11).
#
# Prereqs: a warm harness cluster (setup-kind.sh) whose image CONTAINS the promotion feature.
#   The capability gate below refuses to run against an older image rather than print a green
#   run that proves nothing. jq, curl, kubectl, pnpm and a built pi-fork are required.
# Usage:
#   bash deploy/knative/demo-promoted-workflow.sh
#   bash deploy/knative/demo-promoted-workflow.sh --keep-sandbox   # leave /tmp/sh-demo in place
#   bash deploy/knative/demo-promoted-workflow.sh --teardown       # remove the sandbox and exit
set -euo pipefail
# Resolve $0 BEFORE the cd: --help re-reads this file, and a relative argv[0] (the usual
# `bash deploy/knative/demo-promoted-workflow.sh --help`) stops resolving once the cwd moves.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"
source ./lib.sh # NS, BASE, HOST_HEADER, CURL_HDR, CURL_OPTS, ok/ko, PASS/FAIL

REPO_ROOT="$(cd ../.. && pwd)"
FIXTURE="$(pwd)/fixtures/promoted-demo"
SANDBOX="${SH_DEMO_SANDBOX:-/tmp/sh-demo}"
# Marker file gating every destructive touch of $SANDBOX. Without it this script would happily
# rm -rf a directory a caller pointed SH_DEMO_SANDBOX at by mistake.
MARKER=".sh-demo-sandbox"
MODEL="${SH_MODEL:-claude-haiku-4-5}"
REDIS_PORT="${SH_DEMO_REDIS_PORT:-16379}"
KEEP_SANDBOX=0
TEARDOWN=0
# The unguessable fact: it exists only in the promoted memory file, so a bare run cannot cite it.
TICKET="KAG-4471"
TOKEN="SHIPNOTE-7F3A-SANDBOX-OK" # notsecret
PROMPT="Write the ship note for the auth timeout fix."

for a in "$@"; do
  case "$a" in
    --keep-sandbox) KEEP_SANDBOX=1 ;;
    --teardown) TEARDOWN=1 ;;
    -h | --help)
      sed -n '2,31p' "$SELF" # 31 is the last comment line; 32 is `set -euo pipefail`
      exit 0
      ;;
    *)
      echo "unknown flag: $a" >&2
      exit 2
      ;;
  esac
done

PFS=() # port-forward pids we started; only ours are killed on exit
# Initialised before cleanup() can run: it is the EXIT trap, and `set -u` would abort on an unset
# name if a claim failed before these were assigned.
promote_log=""
repromote_log=""
prom_file=""
cleanup() {
  for pid in ${PFS[@]+"${PFS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  rm -f "$promote_log" "$repromote_log" "$prom_file" 2>/dev/null || true
  if [ "$KEEP_SANDBOX" -eq 0 ] && [ -f "$SANDBOX/$MARKER" ]; then rm -rf "$SANDBOX"; fi
}
trap cleanup EXIT

reset_sandbox() {
  if [ -e "$SANDBOX" ] && [ ! -f "$SANDBOX/$MARKER" ]; then
    echo "REFUSING to touch $SANDBOX: it exists and holds no $MARKER marker." >&2
    echo "Point SH_DEMO_SANDBOX at a fresh path, or delete that directory yourself." >&2
    exit 2
  fi
  rm -rf "$SANDBOX"
  mkdir -p "$SANDBOX/.claude"
  touch "$SANDBOX/$MARKER"
}

# Claude Code's own project slug: every path separator becomes '-'. promote.ts:projectMemoryDir
# mirrors this to FIND the memory directory Claude Code already made, so the demo must produce the
# same shape rather than a tidier one.
memory_dir_for() { echo "$SANDBOX/.claude/projects/-$(echo "${1#/}" | tr '/' '-')/memory"; }

claim() {
  echo ""
  echo "--- Claim $1: $2 ---"
}

# ---------------------------------------------------------------------------------------------
if [ "$TEARDOWN" -eq 1 ]; then
  if [ -f "$SANDBOX/$MARKER" ]; then
    rm -rf "$SANDBOX"
    echo "removed $SANDBOX"
  else
    echo "nothing to remove at $SANDBOX (no $MARKER marker)"
  fi
  KEEP_SANDBOX=1 # cleanup() must not re-run the removal
  exit 0
fi

echo "=== Promoted-workflow demo (model=$MODEL, sandbox=$SANDBOX) ==="

# --- Step 0: dependencies and a warm cluster -------------------------------------------------
for bin in jq curl kubectl pnpm; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "MISSING dependency: $bin" >&2
    exit 2
  }
done

kubectl -n "$NS" get pod -l app=redis -o name >/dev/null 2>&1 ||
  kubectl -n "$NS" get deploy/redis >/dev/null 2>&1 || {
    echo "no redis in namespace $NS — run ./deploy/knative/setup-kind.sh first" >&2
    exit 2
  }
kubectl wait ksvc/"$KSVC" -n "$NS" --for=condition=Ready --timeout=120s >/dev/null || {
  echo "ksvc $KSVC is not Ready" >&2
  exit 2
}

# Kourier port-forward for dispatch; skipped in Route mode (KSVC_URL set).
if [ -z "${KSVC_URL:-}" ] && ! curl -s $CURL_OPTS -o /dev/null --max-time 2 "$BASE/" 2>/dev/null; then
  kubectl port-forward -n kourier-system svc/kourier "${PORT}:80" >/dev/null 2>&1 &
  PFS+=($!)
  sleep 3
fi

# Redis port-forward so `promote` uploads into the CLUSTER's store.
#
# Deliberately NOT 6379, and deliberately no "something already listens, reuse it" shortcut. A
# listener on 6379 is not evidence that it is this cluster's Redis: a local test container
# (`sh-tdd-redis` publishes 0.0.0.0:6379) answers the probe just as happily, and then promote
# uploads into it while the harness reads the cluster's — reporting a successful upload and
# `config bundle not found` for the very digest it just wrote. Measured, not hypothetical: it cost
# this demo two model calls before Claim 3 failed with the digest right there in the message.
# Bind our own private port instead, and fail loudly if it is taken.
if (exec 3<>/dev/tcp/127.0.0.1/"$REDIS_PORT") 2>/dev/null; then
  exec 3>&- 2>/dev/null || true
  echo "port $REDIS_PORT is already in use; set SH_DEMO_REDIS_PORT to a free port" >&2
  exit 2
fi
kubectl port-forward -n "$NS" svc/redis "${REDIS_PORT}:6379" >/dev/null 2>&1 &
PFS+=($!)
sleep 3
export REDIS_URL="redis://localhost:${REDIS_PORT}"

dispatch() { # dispatch <sessionId> <prompt> [configRef]
  local sid="$1" prompt="$2" ref="${3:-}" body
  if [ -n "$ref" ]; then
    body=$(jq -nc --arg s "$sid" --arg m "$MODEL" --arg p "$prompt" --arg c "$ref" \
      '{sessionId:$s, kind:"prompt", model:$m, prompt:$p, configRef:$c}')
  else
    body=$(jq -nc --arg s "$sid" --arg m "$MODEL" --arg p "$prompt" \
      '{sessionId:$s, kind:"prompt", model:$m, prompt:$p}')
  fi
  curl -s $CURL_OPTS --max-time 240 ${CURL_HDR[@]+"${CURL_HDR[@]}"} \
    -H "Content-Type: application/json" -d "$body" "$BASE/runs"
}

# --- Claim 0: the deployed image actually implements promotion --------------------------------
# An unknown digest MUST fail before any model call. An image without the feature ignores the
# field and answers normally -- which would make Claim 3's A/B look like a model mood swing
# instead of a missing deployment. Gate on it.
claim 0 "the deployed harness resolves configRef (an unknown digest fails loudly)"
probe=$(dispatch "demo-cfg-probe-$$" "say hi" "sha256:$(printf 'f%.0s' {1..64})")
if [ "$(jq -r '.status' <<< "$probe")" = "failed" ]; then
  ok "unknown digest rejected: $(jq -r '.message' <<< "$probe" | head -c 60)"
else
  ko "the deployed image IGNORED configRef — it predates the promotion feature"
  cat >&2 <<EOF

The cluster is serving a harness image without PR #214. Rebuild, load and force a new Revision
(the tag is mutable, so re-applying an unchanged spec rolls NOTHING):

  docker build --load -t dev.local/moca:local "$REPO_ROOT"
  kind load docker-image dev.local/moca:local --name sh-knative
  kubectl -n $NS patch ksvc $KSVC --type merge \\
    -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"deploy.sh/build-ts\":\"\$(date +%s)\"}}}}}"
  kubectl wait ksvc/$KSVC -n $NS --for=condition=Ready --timeout=180s

EOF
  echo "=== Results: $PASS passed, $FAIL failed ==="
  exit 1
fi

# --- Claim 1: a minimal sandbox promotes clean ------------------------------------------------
claim 1 "the sandbox promotes with one skill and zero preflight findings"
reset_sandbox
cp "$FIXTURE/CLAUDE.md" "$SANDBOX/CLAUDE.md"
cp -R "$FIXTURE/skills" "$SANDBOX/.claude/skills"
cp -R "$FIXTURE/commands" "$SANDBOX/.claude/commands"
MEM="$(memory_dir_for "$SANDBOX")"
mkdir -p "$MEM"
cp "$FIXTURE/memory/"*.md "$MEM/"
# promote bounds its CLAUDE.md walk at a `.git` entry; without one it climbs past $SANDBOX and
# sweeps ancestor context files into a bundle bound for a shared store.
git -C "$SANDBOX" init -q

promote_log="$(mktemp)"
# HOME=$SANDBOX is the demo: promote reads $SANDBOX/.claude as USER scope, so the bundle holds
# this workflow and nothing else from the real ~/.claude.
if ! HOME="$SANDBOX" pnpm --dir "$REPO_ROOT/harness" promote \
  --entry ship-note --project "$SANDBOX" > "$promote_log" 2>&1; then
  ko "promote failed"
  cat "$promote_log" >&2
  exit 1
fi
sed -n '/^project:/,$p' "$promote_log"

travels=$(grep -E '^  travels' "$promote_log" | awk '{print $2}')
[ "$travels" = "1" ] && ok "exactly 1 skill travels" || ko "expected 1 travelling skill, got '$travels'"
grep -q '^preflight: no findings' "$promote_log" &&
  ok "zero preflight findings" || ko "preflight reported findings (see log above)"

DIGEST=$(grep -oE 'sha256:[0-9a-f]{64}' "$promote_log" | head -1)
[ -n "$DIGEST" ] || {
  ko "no digest in promote output"
  exit 1
}
echo "  digest: $DIGEST"
[ -f "$SANDBOX/.claude/promoted.lock.json" ] &&
  ok "lockfile written" || ko "no .claude/promoted.lock.json"

# Read the key back through the CLUSTER's own client, not through our forwarded socket. A
# port-forward that reached the wrong Redis passes every check above -- promote prints "uploaded"
# either way -- and only fails later as an inscrutable "bundle not found" for a digest visibly
# present in the log. Asserting from inside the cluster makes that mismatch impossible to miss,
# and does it before the two model calls in Claim 3 are paid for.
if [ "$(kubectl exec -n "$NS" deploy/redis -- redis-cli EXISTS "config:bundle:$DIGEST" 2>/dev/null | tr -d '\r')" = "1" ]; then
  ok "the bundle is in the cluster's Redis (verified in-cluster, not via the port-forward)"
else
  ko "the bundle is NOT in the cluster's Redis — the port-forward reached a different Redis"
  echo "  check nothing else holds :$REDIS_PORT, then re-run" >&2
  exit 1
fi

# --- Claim 2: re-promotion of unchanged config uploads nothing --------------------------------
claim 2 "re-promoting unchanged configuration uploads nothing"
repromote_log="$(mktemp)"
if ! HOME="$SANDBOX" pnpm --dir "$REPO_ROOT/harness" promote \
  --entry ship-note --project "$SANDBOX" > "$repromote_log" 2>&1; then
  # Report and carry on rather than exiting: Claim 3 only needs $DIGEST from Claim 1, and an
  # aborted run here would hide the A/B behind a re-promotion failure.
  ko "re-promote failed"
  cat "$repromote_log" >&2
else
  d2=$(grep -oE 'sha256:[0-9a-f]{64}' "$repromote_log" | head -1)
  [ "$d2" = "$DIGEST" ] && ok "digest is stable" || ko "digest changed: $d2"
  grep -q 'upload skipped' "$repromote_log" &&
    ok "upload skipped (content-addressed)" || ko "re-promotion re-uploaded the bundle"
fi

# --- Claim 3: the A/B — same prompt, one field ------------------------------------------------
# The bare run is the CONTROL, and it is only valid if no promoted bundle is sitting in the shared
# pool sandbox for it to find.
#
# The overlay materialises each bundle into a digest-keyed cache in the SHARED pool sandbox
# (/workspace/.sh-config/<digest>/), world-readable, holding context/agents/0-CLAUDE.md and memory/.
# It used to stay there after its leaf ended, so a later bare leaf leasing the same sandbox could
# explore the filesystem and answer from another run's workflow -- measured: a second run of this
# demo had its bare arm emit "following the house rules" with the ticket AND the token, having been
# told neither (#216). The cache is now refcounted and reclaimed when its last leaf releases, so this
# step ASSERTS the cache is empty rather than forcing it to be. Do not turn this back into a purge:
# an `rm -rf` here would hide a teardown regression by cleaning up after it, and the control's
# honesty would go back to depending on the demo rather than on the harness.
claim 3 "the same prompt behaves differently only because of configRef"
POOL_SEL="${KAGENTI_SANDBOX_POOL_SELECTOR:-sh.kagenti.io/sandbox-pool=default}"
mapfile -t POOL_PODS < <(kubectl get pods -n "$NS" -l "$POOL_SEL" -o name 2>/dev/null | sed 's|pod/||')
[ "${#POOL_PODS[@]}" -gt 0 ] || {
  ko "no pool sandbox pods match $POOL_SEL"
  exit 1
}
still=0
unreadable=0
leaked=""
for p in "${POOL_PODS[@]}"; do
  # Count EVERY cached bundle, not just this run's digest. Any bundle carrying the same memory fact
  # answers the bare arm just as well -- measured: a bundle built from this same fixture before
  # Prettier normalised one emphasis marker in the memory file has a different content digest, sat
  # alongside, and would satisfy a per-digest check while breaking the control.
  #
  # Distinguish "zero bundles" from "could not look". An empty $n means the exec failed -- pod not
  # ready, evicted, transient API error -- and `${n:-0}` would silently score that as a clean pod,
  # letting the run claim the cache is empty having verified nothing. That is the same shape of
  # false green this check exists to prevent, so it must not be counted as evidence.
  n=$(kubectl exec -n "$NS" "$p" -- sh -c 'ls -1d /workspace/.sh-config/sha256-* 2>/dev/null | wc -l' 2>/dev/null | tr -d ' \r')
  if [ -z "$n" ]; then
    unreadable=$((unreadable + 1))
    continue
  fi
  [ "$n" -gt 0 ] && leaked="$leaked $p"
  still=$((still + n))
done
[ "$unreadable" -eq 0 ] ||
  ko "could not inspect the cache on $unreadable pod(s); the control is unverified"
if [ "$still" -eq 0 ]; then
  ok "config cache is empty on ${#POOL_PODS[@]} pool sandbox(es), so the control is honest"
else
  # A regression in the refcounted teardown, not something for this script to paper over. Name the
  # pods so the next step is a `kubectl exec ... ls`, not a guess.
  ko "$still cached bundle(s) still on disk (pods:$leaked) — the teardown regressed (#216) and the bare run could read one"
fi

CACHE_DIR="/workspace/.sh-config/sha256-${DIGEST#sha256:}"
SID_A="demo-bare-$$"
SID_B="demo-promoted-$$"
echo "  A (bare)     -> $SID_A"
bare=$(dispatch "$SID_A" "$PROMPT")

# B runs in the BACKGROUND so the sandbox half can be observed while it is true.
#
# The bundle's presence on the pool sandbox's filesystem is now only observable WHILE a leaf holds a
# ref on it: the cache is reclaimed when the last one releases (#216). Looking after the run returned
# -- which is what this demo used to do -- would now always find nothing, and the mechanical check
# below would have to be downgraded to trusting the model's words. So watch for the bundle to appear
# underneath the run instead. Same single dispatch either way: no extra model call.
prom_file="$(mktemp)"
echo "  B (promoted) -> $SID_B"
dispatch "$SID_B" "$PROMPT" "$DIGEST" > "$prom_file" &
prom_pid=$!

# The sandbox half, mechanically: the overlay must materialise the bundle -- INCLUDING the skill's
# references/ subdirectory -- into the pool sandbox it leased. Asserted on the filesystem rather than
# in the model's words, so it holds even on a run where the model declines to read.
landed=""
for _ in $(seq 1 240); do
  for p in "${POOL_PODS[@]}"; do
    if kubectl exec -n "$NS" "$p" -- test -f "$CACHE_DIR/skills/ship-note/references/release-token.md" 2>/dev/null; then
      landed="$p"
      break 2
    fi
  done
  # Stop waiting once the run is over: past that point the cache is legitimately gone, so continuing
  # to poll would just burn the full timeout before reporting a failure that is already decided.
  kill -0 "$prom_pid" 2>/dev/null || break
  sleep 1
done
[ -n "$landed" ] &&
  ok "the bundle materialised in $landed, references/ and all (sandbox overlay ran)" ||
  ko "no pool sandbox held $CACHE_DIR/skills/ship-note/references/release-token.md while the leaf ran"

wait "$prom_pid" || true
prom=$(cat "$prom_file")

# ...and the reclaim, which is the other half of the same invariant: once the leaf that created the
# cache releases its ref, the bundle is gone, so a later bare leaf has nothing to read. This is the
# assertion the demo's old `rm -rf` purge stood in for.
gone=1
for p in "${POOL_PODS[@]}"; do
  kubectl exec -n "$NS" "$p" -- test -d "$CACHE_DIR" 2>/dev/null && gone=0
done
[ "$gone" -eq 1 ] &&
  ok "the cache was reclaimed when the leaf released it, so it cannot outlive its leaf (#216)" ||
  ko "the cache survived its leaf on at least one pod — a later bare run could read it (#216)"

bare_text=$(jq -r '.text // ""' <<< "$bare")
prom_text=$(jq -r '.text // ""' <<< "$prom")
[ "$(jq -r '.status' <<< "$prom")" = "responded" ] ||
  {
    ko "promoted run did not respond: $(jq -c . <<< "$prom" | head -c 300)"
    exit 1
  }

echo ""
echo "  --- A, bare (no configRef) ---"
sed 's/^/    /' <<< "$bare_text"
echo "  --- B, promoted ($DIGEST) ---"
sed 's/^/    /' <<< "$prom_text"
echo ""

# Memory travelled: the id exists nowhere but the promoted memory file.
grep -q "$TICKET" <<< "$prom_text" &&
  ok "promoted run cites $TICKET (memory travelled)" ||
  ko "promoted run never cites $TICKET"
grep -q "$TICKET" <<< "$bare_text" &&
  ko "bare run cited $TICKET — the fact leaked from somewhere else, so the A/B proves nothing" ||
  ok "bare run cannot cite $TICKET"

# The sandbox half, as the model saw it: this token is only readable by a `read` executed in the
# sandbox pod, resolving a relative sibling path against the injected absolute skills root.
grep -q "$TOKEN" <<< "$prom_text" &&
  ok "promoted run echoes the skill's sibling token (path translation, end to end)" ||
  ko "no sibling token — the skill body or its references/ did not resolve in the sandbox"

# CLAUDE.md travelled as an agents file, so this one is deterministic rather than model-dependent.
grep -qE 'RISK' <<< "$prom_text" &&
  ok "promoted run carries the CLAUDE.md RISK line" ||
  ko "no RISK line — the CLAUDE.md chain did not travel"

# --- Claim 4: the verdict is durable and re-readable ------------------------------------------
claim 4 "the promoted run's status is persisted and re-readable"
enc=$(jq -rn --arg s "$SID_B" '$s|@uri')
status=$(curl -s $CURL_OPTS --max-time 30 ${CURL_HDR[@]+"${CURL_HDR[@]}"} \
  "$BASE/runs/status?sessionId=$enc" || true)
[ "$(jq -r '.status // empty' <<< "$status")" = "responded" ] &&
  ok "/runs/status replays 'responded'" ||
  ko "/runs/status did not report the run: $(head -c 200 <<< "$status")"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  echo "PROMOTED-WORKFLOW DEMO FAIL"
  exit 1
fi
echo "PROMOTED-WORKFLOW DEMO PASS"
