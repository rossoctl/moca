#!/usr/bin/env bash
# Run the moca-delegate-task flow on the Kind demo (setup.sh first), with only the skill's commands:
# pack example_repo, create a workload, spawn a read-only and a writable task, watch them, fetch
# both results, delete the workload.
#
#   run.sh
#
# Environment: MOCA_DEMO_STATE (as for setup.sh), DEMO_TIMEOUT (seconds to wait, default 300).
# The prompts carry MOCA-DEMO-READ and MOCA-DEMO-FIX markers for a scripted mock model and spell the
# work out in words, so a real model can run them too.

set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${MOCA_DEMO_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/moca-kind-demo}"
TIMEOUT="${DEMO_TIMEOUT:-300}"
OUT="$STATE_DIR/results/$(date +%Y%m%dT%H%M%S)"
# The demo-only login setup.sh wrote, and the contextctl it built.
export XDG_CONFIG_HOME="$STATE_DIR/config" XDG_STATE_HOME="$STATE_DIR/state"
export PATH="$STATE_DIR/bin:$PATH"
WORKLOAD=''

step() { printf '\n== %s\n' "$*"; }
die() {
  printf 'run.sh: %s\n' "$*" >&2
  exit 1
}
for c in contextctl mocactl jq tar; do command -v "$c" >/dev/null 2>&1 || die "$c is required (run setup.sh first)"; done
[ -f "$XDG_CONFIG_HOME/mocactl/auth.json" ] || die "no demo login under $STATE_DIR: run setup.sh first"

# Delete the workload also after a failure or an interruption.
# shellcheck disable=SC2329 # run by the EXIT trap
cleanup() {
  status=$?
  if [ -n "$WORKLOAD" ]; then
    step "mocactl workloads delete $WORKLOAD"
    mocactl workloads delete "$WORKLOAD" || echo "run.sh: could not delete workload $WORKLOAD; retry the command above" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
mkdir -p "$OUT"
cd "$OUT"

step 'contextctl ctx pack example_repo -o repo.context'
contextctl ctx pack "$DEMO_DIR/example_repo" -o repo.context
tar -tvzf repo.context

step 'mocactl workloads create --context repo.context'
created="$(mocactl workloads create --context repo.context --json)"
printf '%s\n' "$created"
WORKLOAD="$(printf '%s' "$created" | jq -r .workloadId)"
[ "$(printf '%s' "$created" | jq -r .status)" = ready ] || die "workload $WORKLOAD is not ready"

step 'mocactl spawn --kind prompt --workload ID --tag demo (read-only)'
READ_ID="$(mocactl spawn --kind prompt --workload "$WORKLOAD" --tag demo \
  "MOCA-DEMO-READ. The repository is in your working directory, read-only. Run pwd and ls, then \
try to append a line to src/greet.py (it should be refused), then run ./test.sh. Report each \
command's output and exit status.")"
echo "$READ_ID"

step 'mocactl spawn --kind prompt --workload ID --writable --tag demo'
FIX_ID="$(mocactl spawn --kind prompt --workload "$WORKLOAD" --writable --tag demo \
  "MOCA-DEMO-FIX. The repository is in your working directory, as a writable copy. ./test.sh \
fails: fix src/greet.py so that greet(\"Ada\") returns \"Hello, Ada!\", run ./test.sh again, and \
return the change as a unified diff with the test output.")"
echo "$FIX_ID"

step 'mocactl subagents --tag demo (until neither task is running)'
waited=0
while :; do
  states="$(mocactl subagents --tag demo --json |
    jq -r --arg a "$READ_ID" --arg b "$FIX_ID" '.subagents[] | select(.sessionId == $a or .sessionId == $b) | .state')"
  printf '%s\n' "$states" | grep -qx running || break
  [ "$waited" -lt "$TIMEOUT" ] || die "tasks still running after ${TIMEOUT}s"
  sleep 3
  waited=$((waited + 3))
done
mocactl subagents --tag demo

step 'mocactl get SESSION_ID --out results/'
status=0
for sid in "$READ_ID" "$FIX_ID"; do
  # get exits 1, with the reason on stderr, for a task that failed or has not finished.
  mocactl get "$sid" --out results/ >/dev/null || status=1
  printf -- '--- %s.text\n' "$sid"
  cat "results/$sid.text" 2>/dev/null || true
done
echo
echo "Results: $OUT/results"
exit "$status"
