#!/usr/bin/env bash
# Live smoke for the compose trial (#342): brings the stack up in a throwaway project, proves the
# supervisor has a healthy worker pool, that the sandbox attached through the relay into Redis, and
# that a real /turn runs a command in that sandbox and persists its session. Then, with the MU1
# control plane on (#348): that discovery advertises the harness, that an AUTHENTICATED /v1/turn
# streams over SSE on a caller's own stored credential, and that the credential survives
# `docker compose down && up` -- then tears it all down. Needs Docker (or podman's docker CLI) with
# Compose, and a model credential.
#
#   COMPOSE_LIVE_SMOKE=1 ANTHROPIC_API_KEY=... ./deploy/compose/smoke.sh
#
# Environment:
#   COMPOSE_LIVE_SMOKE=1   Required; without it this exits 0 having done nothing (like M3_LIVE_SMOKE).
#   SH_COMPOSE_BUILD=1     Build both images from this checkout (docker build) and run those instead
#                          of the published ones. Needs pi-fork populated.
#   SH_PORT                Host port for the supervisor (default 18080, to stay off a real 8080).
#   SH_CP_PORT             Host port for the control plane (default 18090, to stay off a real 8090).
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
SH_CP_PORT="${SH_CP_PORT:-18090}"
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
HARNESS_IMAGE=ghcr.io/rossoctl/moca:latest
[[ "${SH_COMPOSE_BUILD:-}" != 1 ]] || HARNESS_IMAGE=dev.local/moca:compose
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
    printf 'MOCA_RELAY_EXEC_TOKEN=%s\n' "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
    echo 'SH_TURNS_PER_WORKER=2'
    echo 'SH_WORKERS=2'
    echo "SH_PORT=$SH_PORT"
    echo "SH_CP_PORT=$SH_CP_PORT"
    # The control plane, as install.sh turns it on. The client id is never exercised: this smoke
    # stands in for the device-flow login by minting an api token with the control plane's own key.
    echo 'COMPOSE_PROFILES=control-plane'
    echo 'SH_GITHUB_CLIENT_ID=Iv1.compose-smoke-unused'
    # Generated exactly as install.sh does, by the image's own key generator.
    docker run --rm --network none --user 1000:1000 -w /app/packages/control-plane "$HARNESS_IMAGE" \
      node --import tsx src/genkeys.ts
    printf '%s\n' ${IMAGE_ENV[@]+"${IMAGE_ENV[@]}"}
    for var in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL OPENAI_API_KEY OPENAI_BASE_URL \
      SH_MODEL SH_MODEL_PROVIDER SH_MODEL_API SH_MODEL_BASE_URL SH_MODEL_AUTH SH_MODEL_CUSTOM; do
      [[ -z "${!var+x}" ]] || printf '%s=%s\n' "$var" "${!var}"
    done
  } >"$PROJ/.env"
)

grep -q '^SH_CREDENTIAL_KEK=' "$PROJ/.env" || { echo "FAIL: the key generator produced nothing" >&2; exit 1; }
echo "bringing the stack up (project sh-smoke-$$, supervisor on 127.0.0.1:$SH_PORT, control plane on 127.0.0.1:$SH_CP_PORT)"
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
# Extract ids from a file, handling incomplete final lines (e.g., from kill cutting mid-stream).
# Portable across BSD and GNU tools. Only strips a newline-less final line; otherwise reads all ids.
complete_ids() { if [[ -n "$(tail -c1 "$1")" ]]; then sed '$d' "$1"; else cat "$1"; fi | sed -n 's/^id: //p'; }

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

CP="http://127.0.0.1:$SH_CP_PORT"
cp_ready() { curl -sf "$CP/readyz" >/dev/null; }

claim 5 "the control plane is ready and advertises the harness at 127.0.0.1:$SH_PORT"
if wait_for 90 cp_ready; then
  ADVERTISED="$(curl -s "$CP/v1/discovery" | jq -r '.harnessUrl // empty' 2>/dev/null || true)"
  if [[ "$ADVERTISED" == "http://127.0.0.1:$SH_PORT" ]]; then
    ok "harnessUrl=$ADVERTISED"
  else
    ko "discovery advertises '$ADVERTISED', expected http://127.0.0.1:$SH_PORT"
  fi
else
  ko "control plane /readyz never answered on $CP"
fi

claim 6 "an authenticated POST /v1/turn streams a reply over SSE, on the caller's own stored credential"
# The api token a device-flow login would return, minted with the control plane's own signing key
# INSIDE its container (the key never leaves it). Headers go through files so no bearer reaches an argv.
API_HDR="$PROJ/api.hdr"
TURN_HDR="$PROJ/turn.hdr"
(
  umask 077
  printf 'Authorization: Bearer %s\n' "$(dc exec -T control-plane node --import tsx --input-type=module -e \
    "import { makeSigner } from './src/token.ts';
     const s = makeSigner(process.env.SH_SESSION_TOKEN_PRIVATE_KEY);
     process.stdout.write(s.mint({ sub: 'smoke:1', tenant: 'smoke:1', roles: [], scope: ['api'], ttlSeconds: 900 }));" \
    2>/dev/null)" >"$API_HDR"
)
# The caller's inference credential. A gateway token goes as `Authorization: Bearer` (kind bearer); a
# raw Anthropic API key is read from x-api-key only, so it is stored as kind api-key -- the control
# plane refuses it as bearer (#368).
if [[ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
  INFERENCE_TOKEN="$ANTHROPIC_AUTH_TOKEN" CRED_KIND=bearer CRED_FIELD=token
else
  INFERENCE_TOKEN="${ANTHROPIC_API_KEY:-}" CRED_KIND=api-key CRED_FIELD=key
fi
ENDPOINT="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
HOST="$(sed -E 's#^[a-z]+://([^/:]+).*#\1#' <<<"$ENDPOINT")"
CRED_BODY="$(SMOKE_TOKEN="$INFERENCE_TOKEN" jq -nc --arg ep "$ENDPOINT" --arg host "$HOST" \
  --arg kind "$CRED_KIND" --arg field "$CRED_FIELD" \
  '{kind: $kind, consumer: "inference", destination: {hosts: [$host]}, endpoint: $ep, secret: {($field): env.SMOKE_TOKEN}}')"
PUT_STATUS="$(curl -s -o "$PROJ/put.json" -w '%{http_code}' -X PUT -H @"$API_HDR" -H 'Content-Type: application/json' \
  --data-binary @- "$CP/v1/credentials/smoke-inference" <<<"$CRED_BODY" || true)"
# One authenticated turn: a new session on the stored credential, its session token, and an SSE
# /v1/turn with it. The turn only succeeds if the exchange DECRYPTS the credential and the gateway
# accepts it -- which is what makes it, unlike `GET /v1/credentials` (list never decrypts), proof
# that the stored secret is intact.
authed_turn() {
  local tag="$1" session sid done_sid sse="$PROJ/turn-$1.sse"
  session="$(curl -s -X POST -H @"$API_HDR" -H 'Content-Type: application/json' -d '{}' "$CP/v1/sessions" || true)"
  sid="$(jq -r '.sessionId // empty' <<<"$session" 2>/dev/null || true)"
  if [[ -z "$sid" ]]; then
    ko "POST /v1/sessions returned no session: ${session:0:300}"
    return
  fi
  (
    umask 077
    printf 'Authorization: Bearer %s\n' "$(jq -r '.token // empty' <<<"$session" 2>/dev/null || true)" >"$TURN_HDR"
  )
  curl -sN --max-time 180 -H @"$TURN_HDR" -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
    -D "$PROJ/turn-$tag.headers" -d "$(jq -nc --arg s "$sid" '{sessionId: $s, prompt: "Reply with exactly the word: pong"}')" \
    "http://127.0.0.1:$SH_PORT/v1/turn" >"$sse" || true
  done_sid="$(sed -n 's/^data: //p' "$sse" | jq -r 'select(.type == "done") | .sessionId' 2>/dev/null | head -1)"
  if ! grep -qi '^content-type: text/event-stream' "$PROJ/turn-$tag.headers"; then
    ko "not an SSE response: $(head -c 400 "$sse")"
  elif grep -q '^event: text' "$sse" && [[ "$done_sid" == "$sid" ]]; then
    ok "session $sid streamed $(grep -c '^event: text' "$sse") text frame(s) and a done frame"
  else
    ko "expected text frames and a done frame for $sid: $(head -c 600 "$sse")"
  fi
}

if [[ -z "$INFERENCE_TOKEN" ]]; then
  ko "no ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY to store as the caller's credential"
elif [[ "$PUT_STATUS" != 2* ]]; then
  ko "PUT /v1/credentials/smoke-inference answered $PUT_STATUS: $(head -c 300 "$PROJ/put.json")"
else
  authed_turn before
fi

claim 7 "a stored credential survives docker compose down && up, and still DECRYPTS for a turn"
# Redis has no volume, so every session is gone after the restart; the credential, on its own
# volume, is not. The api token still verifies: the signing key lives in .env.
dc down >/dev/null 2>&1
dc up -d >/dev/null 2>&1
if wait_for 90 cp_ready && wait_for 120 metrics && wait_for 90 sandbox_attached; then
  authed_turn after
else
  ko "the stack did not come back after down && up"
fi

claim 8 "a detachable turn survives its client: re-attach replays what was missed, without repeats"
# A fresh session; the first stream is started in the background, cut ~1 s after its first id,
# then GET /v1/turn resumes from its last id, then a full replay verifies nothing was missed.
detach_turn() {
  local session sid first="$PROJ/detach-1.sse" second="$PROJ/detach-2.sse" third="$PROJ/detach-3.sse" pid last_id
  session="$(curl -s -X POST -H @"$API_HDR" -H 'Content-Type: application/json' -d '{}' "$CP/v1/sessions" || true)"
  sid="$(jq -r '.sessionId // empty' <<<"$session" 2>/dev/null || true)"
  [[ -n "$sid" ]] || { ko "POST /v1/sessions returned no session: ${session:0:300}"; return; }
  (umask 077; printf 'Authorization: Bearer %s\n' "$(jq -r '.token // empty' <<<"$session" 2>/dev/null || true)" >"$TURN_HDR")
  curl -sN --max-time 180 -H @"$TURN_HDR" -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg s "$sid" '{sessionId: $s, prompt: "Write the numbers 1 to 200, one per line, nothing else.", detachable: true}')" \
    "http://127.0.0.1:$SH_PORT/v1/turn" >"$first" &
  pid=$!
  wait_for 60 grep -q '^id: ' "$first" || true
  sleep 1
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  last_id="$(complete_ids "$first" | tail -1)"
  [[ -n "$last_id" ]] || { ko "the detachable turn sent no ids: $(head -c 400 "$first")"; return; }
  curl -sN --max-time 180 -H @"$TURN_HDR" -H 'Accept: text/event-stream' -H "Last-Event-ID: $last_id" \
    "http://127.0.0.1:$SH_PORT/v1/turn?sessionId=$sid" >"$second" || true
  if ! grep -q '^event: done' "$second"; then
    ko "the re-attach did not reach done: $(tail -c 400 "$second")"
    return
  fi
  # Extract complete ids from each stream (handle incomplete final lines from kill)
  local first_ids second_ids repeats expected actual
  first_ids="$(complete_ids "$first")"
  second_ids="$(sed -n 's/^id: //p' "$second" | tail -n +2)"
  # Check for repeats: no id from first + second (skip first line) should appear twice
  repeats="$(cat <(echo "$first_ids") <(echo "$second_ids") | sort | uniq -d)"
  if [[ -n "$repeats" ]]; then
    ko "the re-attach repeated frames the first stream had"
    return
  fi
  # Check for missed frames: full replay ids must equal first + second ids
  curl -sN --max-time 60 -H @"$TURN_HDR" -H 'Accept: text/event-stream' \
    "http://127.0.0.1:$SH_PORT/v1/turn?sessionId=$sid" >"$third" || true
  local third_ids
  third_ids="$(sed -n 's/^id: //p' "$third")"
  expected="$(cat <(echo "$first_ids") <(echo "$second_ids") | sort -u)"
  actual="$(echo "$third_ids" | sort -u)"
  if ! diff <(echo "$expected") <(echo "$actual") >/dev/null 2>&1; then
    ko "the re-attach missed frames: expected $(echo "$expected" | grep -c . || true) ids, got $(echo "$actual" | grep -c . || true)"
  else
    ok "re-attached session $sid, replayed $(echo "$first_ids" | grep -c . || true) + $(echo "$second_ids" | grep -c . || true) frames without loss"
  fi
}
detach_turn

claim 9 "POST /v1/turn/cancel ends a running detachable turn with abortReason cancelled"
cancel_turn() {
  local session sid out="$PROJ/cancel.sse" post_body="$PROJ/cancel-post.json" pid status
  session="$(curl -s -X POST -H @"$API_HDR" -H 'Content-Type: application/json' -d '{}' "$CP/v1/sessions" || true)"
  sid="$(jq -r '.sessionId // empty' <<<"$session" 2>/dev/null || true)"
  [[ -n "$sid" ]] || { ko "POST /v1/sessions returned no session"; return; }
  (umask 077; printf 'Authorization: Bearer %s\n' "$(jq -r '.token // empty' <<<"$session" 2>/dev/null || true)" >"$TURN_HDR")
  curl -sN --max-time 180 -H @"$TURN_HDR" -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg s "$sid" '{sessionId: $s, prompt: "Write the numbers 1 to 500, one per line, nothing else.", detachable: true}')" \
    "http://127.0.0.1:$SH_PORT/v1/turn" >"$out" &
  pid=$!
  wait_for 30 grep -q '^event: turn' "$out" || true
  status="$(curl -s -o "$post_body" -w '%{http_code}' -X POST -H @"$TURN_HDR" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg s "$sid" '{sessionId: $s}')" "http://127.0.0.1:$SH_PORT/v1/turn/cancel" || true)"
  wait "$pid" || true
  if [[ "$status" != 202 ]]; then
    ko "cancel answered $status: $(head -c 300 "$post_body")"
  elif grep -q '"abortReason":"cancelled"' "$out"; then
    ok "cancelled session $sid's turn"
  else
    ko "the stream did not end cancelled: $(tail -c 400 "$out")"
  fi
}
cancel_turn

printf '\n=== Results: %s passed, %s failed ===\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
