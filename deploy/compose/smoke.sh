#!/usr/bin/env bash
# Live smoke for the compose trial (#342): brings the stack up in a throwaway project, proves the
# supervisor has a healthy worker pool, that the sandbox attached through the relay into Redis, and
# that a real /turn runs a command in that sandbox and persists its session -- then tears it all
# down. Needs Docker (or podman's docker CLI) with Compose, and a model credential.
#
#   COMPOSE_LIVE_SMOKE=1 ANTHROPIC_API_KEY=... ./deploy/compose/smoke.sh
#
# Environment:
#   COMPOSE_LIVE_SMOKE=1   Required; without it this exits 0 having done nothing (like M3_LIVE_SMOKE).
#   SH_COMPOSE_BUILD=1     Build both images from this checkout (docker build) and run those instead
#                          of the published ones. Needs pi-fork populated.
#   SH_PORT                Host port for the supervisor (default 18080, to stay off a real 8080).
#   KEEP=1                 Leave the stack running afterwards, for debugging.
#   Model settings (ANTHROPIC_*, OPENAI_*, SH_MODEL*) are copied into the project's .env.
set -euo pipefail

if [[ "${COMPOSE_LIVE_SMOKE:-}" != 1 ]]; then
  echo "SKIP: set COMPOSE_LIVE_SMOKE=1 to run the compose live smoke (needs Docker + a model key)"
  exit 0
fi

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$(mktemp -d)"
SH_PORT="${SH_PORT:-18080}"
PASS=0
FAIL=0
ok() {
  PASS=$((PASS + 1))
  echo "  ok ${1:-}"
}
ko() {
  FAIL=$((FAIL + 1))
  echo "  FAIL ${1:-}"
}
claim() { printf '\n--- Claim %s: %s ---\n' "$1" "$2"; }

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "FAIL: no 'docker compose' or 'docker-compose'" >&2
  exit 1
fi
FILES=(-f "$PROJ/docker-compose.yml")
cp "$COMPOSE_DIR/docker-compose.yml" "$PROJ/"
IMAGE_ENV=()
if [[ "${SH_COMPOSE_BUILD:-}" == 1 ]]; then
  # Built here rather than via docker-compose.build.yml: Compose resolves an override's build
  # contexts against the PROJECT directory, which for this throwaway project is not the checkout.
  REPO_ROOT="$(cd "$COMPOSE_DIR/../.." && pwd)"
  echo "building images from $REPO_ROOT"
  docker build --load -q -t dev.local/moca:compose -f "$REPO_ROOT/Dockerfile" "$REPO_ROOT"
  docker build --load -q -t dev.local/remote-worker:compose -f "$REPO_ROOT/remote-worker/Dockerfile" "$REPO_ROOT"
  IMAGE_ENV=(SH_HARNESS_IMAGE=dev.local/moca:compose SH_SANDBOX_IMAGE=dev.local/remote-worker:compose)
fi
# A unique project name, so a smoke run never adopts or tears down someone's real trial stack.
dc() { "${COMPOSE[@]}" -p "sh-smoke-$$" --project-directory "$PROJ" "${FILES[@]}" "$@"; }

teardown() {
  if [[ "${KEEP:-}" == 1 ]]; then
    echo "KEEP=1: stack left running; tear down with: ${COMPOSE[*]} -p sh-smoke-$$ --project-directory $PROJ ${FILES[*]} down"
    return
  fi
  dc logs --no-color >"$PROJ/compose.log" 2>&1 || true
  [[ "$FAIL" -eq 0 ]] || { echo "--- last compose logs ---"; tail -60 "$PROJ/compose.log"; }
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$PROJ"
}
trap teardown EXIT

(
  umask 077
  {
    printf 'SH_RELAY_TOKEN=%s\n' "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
    echo 'SH_TURNS_PER_WORKER=2'
    echo 'SH_WORKERS=2'
    echo "SH_PORT=$SH_PORT"
    printf '%s\n' ${IMAGE_ENV[@]+"${IMAGE_ENV[@]}"}
    for var in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL OPENAI_API_KEY OPENAI_BASE_URL \
      SH_MODEL SH_MODEL_PROVIDER SH_MODEL_API SH_MODEL_BASE_URL SH_MODEL_AUTH SH_MODEL_CUSTOM; do
      [[ -z "${!var+x}" ]] || printf '%s=%s\n' "$var" "${!var}"
    done
  } >"$PROJ/.env"
)

echo "bringing the stack up (project sh-smoke-$$, supervisor on 127.0.0.1:$SH_PORT)"
dc up -d

# $1 seconds, polling a command until it succeeds.
wait_for() {
  local secs="$1"
  shift
  local end=$((SECONDS + secs))
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < end)) || return 1
    sleep 2
  done
}
metrics() { dc exec -T supervisor wget -qO- http://127.0.0.1:8081/metrics; }
sandbox_attached() { [[ "$(dc exec -T redis redis-cli HEXISTS sh:sandbox:records sh-sandbox-0)" == 1 ]]; }

claim 1 "the supervisor's worker pool is up, with SH_WORKERS=2 workers, all healthy"
if wait_for 120 metrics; then
  M="$(metrics)"
  if jq -e '(.workers | length) == 2 and all(.workers[]; .healthy)' <<<"$M" >/dev/null; then
    ok "$(jq -c '[.workers[] | {id, pid, healthy}]' <<<"$M")"
  else
    ko "metrics: $(jq -c .workers <<<"$M")"
  fi
else
  ko "admin /metrics never answered inside the supervisor container"
fi

claim 2 "the sandbox attached through the relay and is recorded in Redis"
wait_for 90 sandbox_attached && ok "sh:sandbox:records has sh-sandbox-0" || ko "no sh-sandbox-0 record after 90s"

claim 3 "a /turn runs a command in the SANDBOX container and returns its output"
# The sandbox container's hostname is its container id: no model can guess it, and it differs from
# the supervisor's own, so seeing it in the reply proves the command ran in the sandbox -- through
# the relay -- and not in the worker or in the model's head.
SANDBOX_HOST="$(dc exec -T sandbox cat /etc/hostname | tr -d '\r\n')"
BODY="$(jq -nc '{prompt:"Run exactly this shell command with your bash tool: cat /etc/hostname -- then reply with only its output."}')"
RESP="$(curl -s --max-time 180 -H 'Content-Type: application/json' -d "$BODY" "http://127.0.0.1:$SH_PORT/turn" || true)"
SESSION_ID="$(jq -r '.sessionId // empty' <<<"$RESP" 2>/dev/null || true)"
if [[ -z "$SANDBOX_HOST" ]]; then
  ko "could not read the sandbox container's hostname"
elif [[ -n "$SESSION_ID" ]] && grep -qF "$SANDBOX_HOST" <<<"$RESP"; then
  ok "sessionId=$SESSION_ID, reply carries sandbox hostname $SANDBOX_HOST"
else
  ko "expected sandbox hostname $SANDBOX_HOST in the response: ${RESP:0:400}"
fi

claim 4 "the session was persisted to Redis"
if [[ -n "$SESSION_ID" ]] && [[ -n "$(dc exec -T redis redis-cli --scan --pattern "session:$SESSION_ID*")" ]]; then
  ok
else
  ko "no session:$SESSION_ID* key in Redis"
fi

printf '\n=== Results: %s passed, %s failed ===\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
