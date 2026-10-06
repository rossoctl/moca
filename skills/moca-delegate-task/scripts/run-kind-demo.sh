#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-moca-delegate-demo}"
KUBE_CONTEXT="kind-$CLUSTER_NAME"
COUNT=12
SANDBOXES=3
ALLOW_LARGE_BATCH=false
KEEP_DATA=false
QUIET=false
OUTPUT_ROOT="${OUTPUT_ROOT:-/tmp/moca-delegate-demo}"
SH_URL="${SH_URL:-http://127.0.0.1:8080}"
SH_HOST="${SH_HOST:-serverless-harness.default.example.com}"
CONTEXTCTL="${CONTEXTCTL:-contextctl}"

usage() {
  cat <<'EOF'
Usage: run-kind-demo.sh [options]

Generate synthetic incidents, upload their context once, fan out the analysis to
MOCA, and validate every result.

Options:
  --count NUMBER       Number of tasks (default: 12)
  --sandboxes NUMBER   Number of MOCA sandboxes (default: 3)
  --allow-large-batch  Confirm more than 25 model calls
  --keep-data          Keep generated Context Service contexts
  --quiet              Hide the behind-the-scenes view
  -h, --help           Show this help
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --count)
      [ "$#" -ge 2 ] || die "--count requires a value"
      COUNT="$2"
      shift 2
      ;;
    --sandboxes)
      [ "$#" -ge 2 ] || die "--sandboxes requires a value"
      SANDBOXES="$2"
      shift 2
      ;;
    --allow-large-batch)
      ALLOW_LARGE_BATCH=true
      shift
      ;;
    --keep-data)
      KEEP_DATA=true
      shift
      ;;
    --quiet)
      QUIET=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ "$COUNT" =~ ^[1-9][0-9]*$ ]] || die "--count must be a positive integer"
[[ "$SANDBOXES" =~ ^[1-9][0-9]*$ ]] || die "--sandboxes must be a positive integer"
if [ "$COUNT" -gt 25 ] && [ "$ALLOW_LARGE_BATCH" != "true" ]; then
  die "$COUNT tasks require --allow-large-batch because each task makes one model call"
fi

for command_name in "$CONTEXTCTL" curl kubectl python3; do
  require_command "$command_name"
done

current_context="$(kubectl config current-context 2>/dev/null || true)"
[ "$current_context" = "$KUBE_CONTEXT" ] ||
  die "select the demo cluster first: kubectl config use-context $KUBE_CONTEXT"

curl -fsS http://127.0.0.1:8081/healthz >/dev/null ||
  die "Context Service is not ready. Complete references/kind-setup.md first"
curl -fsS -H "Host: $SH_HOST" "$SH_URL/health" >/dev/null ||
  die "MOCA is not ready. Complete references/kind-setup.md first"

run_id="$(date -u +%Y%m%d%H%M%S)-$$"
source_context="moca-demo-source-$run_id"
artifact_context="moca-demo-corpus-$run_id"
run_directory="$OUTPUT_ROOT/$run_id"
results="$run_directory/results.json"
telemetry="$run_directory/telemetry.jsonl"
done_file="$run_directory/demo.done"
remote_log="$run_directory/remote-task.log"
watcher_pid=""

cleanup() {
  if [ -n "$watcher_pid" ]; then
    kill "$watcher_pid" >/dev/null 2>&1 || true
  fi
  if [ "$KEEP_DATA" = "true" ]; then
    echo "Kept contexts: $source_context, $artifact_context"
    return
  fi
  "$CONTEXTCTL" ctx delete "$artifact_context" --backend filesystem >/dev/null 2>&1 || true
  "$CONTEXTCTL" ctx delete "$source_context" --backend filesystem >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "1/4 Generate $COUNT synthetic incident tasks"
python3 "$SCRIPT_DIR/generate_incident_demo.py" --count "$COUNT" --output "$run_directory"

echo "2/4 Capture the incident reports as one local context"
"$CONTEXTCTL" ctx create "$source_context" --type workspace --backend filesystem >/dev/null
"$CONTEXTCTL" ctx artifact publish "$artifact_context" "$run_directory/incidents" \
  --from "$source_context" --producer demo >/dev/null

echo "3/4 Upload the context once and run $COUNT tasks across $SANDBOXES sandboxes"
: > "$telemetry"
if [ "$QUIET" != "true" ]; then
  python3 "$SCRIPT_DIR/watch_demo.py" \
    --telemetry "$telemetry" \
    --files "$run_directory/incidents" \
    --done "$done_file" \
    --tasks "$COUNT" &
  watcher_pid=$!
fi
batch_args=(
  batch
  --context "$artifact_context"
  --tasks "$run_directory/tasks.jsonl"
  --sandboxes "$SANDBOXES"
  --sh-url "$SH_URL"
  --telemetry "$telemetry"
)
if [ "$ALLOW_LARGE_BATCH" = "true" ]; then
  batch_args+=(--allow-large-batch)
fi
set +e
SH_HOST="$SH_HOST" python3 "$SCRIPT_DIR/remote_task.py" "${batch_args[@]}" \
  > "$results" 2> "$remote_log"
remote_status=$?
set -e
printf '%s\n' "$remote_status" > "$done_file"
if [ -n "$watcher_pid" ]; then
  wait "$watcher_pid" || true
  watcher_pid=""
fi
if [ "$remote_status" -ne 0 ]; then
  cat "$remote_log" >&2
  exit "$remote_status"
fi

echo "4/4 Validate every remote result"
python3 "$SCRIPT_DIR/validate_incident_demo.py" \
  --results "$results" \
  --expected "$run_directory/expected.json"

echo "Results: $results"
