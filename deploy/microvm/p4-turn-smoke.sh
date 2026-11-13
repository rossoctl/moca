#!/usr/bin/env bash
# deploy/microvm/p4-turn-smoke.sh
#
# Drives real harness turns through the P6 supervisor on a P4 host and checks that they ran in
# microVMs (#369 acceptance). Needs the supervisor pointed at a model that follows the P4-SMOKE-*
# scripts -- deploy/microvm/mock-anthropic.mjs via SH_MODEL_CUSTOM/SH_MODEL_BASE_URL (P4-ON-P6.md).
# By default it posts unauthenticated /turn calls, for a P6 install with SH_REQUIRE_AUTH=false.
#
# --auth drives every turn through the real `mocactl run` instead, on a host with the control plane
# (#366) and SH_REQUIRE_AUTH=true. It stands in for `mocactl login` the way deploy/compose/smoke.sh
# does: it mints an api token per subject with the control plane's own signing key, into a private
# XDG_CONFIG_HOME, and stores a bearer inference credential that points at the loopback mock model.
# Session B belongs to a second subject. The token is written by node straight into 0600 files, never
# onto an argv or into a shell variable.
#
# A TIERED host (P6.3: container sandboxes too, so setup-microvm.sh wrote $SH_ENV_DIR/microvm-tiers.env)
# runs each session in the tier it was created in. With --auth every session this driver creates asks
# for the microvm tier (--option sandboxTier=microvm). Without --auth a turn carries no session token,
# so it runs in the process default tier (spec §3.4): that file must say SH_SANDBOX_DEFAULT_TIER=microvm.
# An untiered host must be P4-only, as before: there every sandbox would be a candidate.
#
# The /turn contract it relies on (packages/server/src/server.ts, harness/src/run-turn.ts):
#   - a NEW session is created by omitting sessionId; the response names it. A sessionId the backend
#     has never seen is a 404 session_not_found, so this driver never invents one.
#   - the response is {sessionId, response, ...}, and `response` is only the final assistant text.
#     mock-anthropic.mjs puts every tool result into that text, which is how the checks below see
#     what ran in the sandbox.
#
#   sudo deploy/microvm/p4-turn-smoke.sh [--supervisor URL] [--out DIR (default: mktemp -d)] [--failure-paths]
#                                        [--auth [--control-plane URL]]
set -uo pipefail

SUP="http://127.0.0.1:8080"
CP="http://127.0.0.1:8090"
AUTH=0
OUT=""
FAILURE_PATHS=0
: "${MICROVM_SANDBOX_ID:=moca_microvm_0}"
: "${SH_WORKSPACE_ROOT:=/srv/workspaces}"
# The shipped unit's SH_CHROOT_BASE; jailer puts each VM at <base>/firecracker/<vm-id>/root.
: "${SH_JAIL_BASE:=/srv/jail}"
# Seconds a failure-path turn runs before the fault is injected (long enough to be inside the Exec).
: "${SMOKE_FAIL_DELAY:=10}"
# --auth only: the checkout (for the token signer and mocactl), the control plane's systemd credentials
# (deploy/vm/setup-vm.sh's SH_CRED_DIR), the client, and where the stored credential sends the model.
: "${MOCA_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
: "${MOCA_CRED_DIR:=/etc/serverless-harness/credentials}"
# setup-microvm.sh's env dir: microvm-tiers.env there marks a tiered host.
: "${SH_ENV_DIR:=/etc/serverless-harness}"
TIERS_ENV="$SH_ENV_DIR/microvm-tiers.env"
TIERED=0
[ -f "$TIERS_ENV" ] && TIERED=1
# MOCACTL, if set, is a command line split on whitespace; unset, it is the checkout's own mocactl, kept
# as an array so a checkout path with a space in it still works.
if [ -n "${MOCACTL:-}" ]; then read -ra MOCACTL_CMD <<<"$MOCACTL"
else MOCACTL_CMD=(node "$MOCA_ROOT/packages/mocactl/bin/mocactl.mjs"); fi
# Seconds a `mocactl run` may take: the same bound the unauthenticated path puts on curl --max-time.
: "${SMOKE_TURN_TIMEOUT:=300}"
: "${SMOKE_MODEL_URL:=http://127.0.0.1:18099}"
SMOKE_CREDENTIAL="p4-smoke-mock"
while [ $# -gt 0 ]; do
  case "$1" in
  --supervisor) SUP="$2"; shift 2 ;;
  --out) OUT="$2"; shift 2 ;;
  --failure-paths) FAILURE_PATHS=1; shift ;;
  --auth) AUTH=1; shift ;;
  --control-plane) CP="$2"; shift 2 ;;
  *) echo "usage: $0 [--supervisor URL] [--out DIR] [--failure-paths] [--auth [--control-plane URL]]" >&2
    exit 2 ;;
  esac
done
# mocactl normalises its URLs without trailing slashes, and loadAuth requires auth.json's
# controlPlaneUrl to equal that exactly; a trailing slash would also build //v1/... URLs for curl.
while [ "${CP%/}" != "$CP" ]; do CP="${CP%/}"; done
while [ "${SUP%/}" != "$SUP" ]; do SUP="${SUP%/}"; done
# With --auth, $OUT holds minted api tokens, so it is always a directory this run creates, 0700: the
# default is a fresh mktemp one, and a named one must not exist yet. mkdir without -p refuses any
# existing path, symlink or not -- an owner check would not do, since under sudo root owns /tmp
# itself (#409 review). Without --auth a named --out may already exist.
if [ -z "$OUT" ]; then
  T="${TMPDIR:-/tmp}"
  OUT="$(mktemp -d "${T%/}/p4-smoke-XXXXXX")" || exit 2
elif [ "$AUTH" = 1 ]; then
  mkdir -m 0700 -- "$OUT" || {
    echo "--out $OUT: with --auth it must be a new directory (it will hold api tokens); pick a path that does not exist" >&2
    exit 2
  }
else
  mkdir -p "$OUT"
fi
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1" | tee -a "$OUT/SUMMARY"; else
  echo "  FAIL: $1 (want '$3', got '$2')" | tee -a "$OUT/SUMMARY"; fails=$((fails + 1)); fi; }

# json_field <file> <field>: one top-level string field of a JSON response ("" if absent/unparseable).
json_field() {
  node -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    process.stdout.write(typeof v === "string" ? v : "") } catch {}' "$1" "$2"
}
# env_file_value <key> <file>: the last <key>= value, one pair of surrounding quotes stripped the way
# systemd's EnvironmentFile= strips them (setup-microvm.sh's env_value).
env_file_value() {
  local v
  v="$( (grep -E "^$1=" "$2" 2>/dev/null || true) | tail -1 | cut -d= -f2-)"
  if ((${#v} >= 2)); then
    case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  fi
  printf '%s' "$v"
}
# login_as <subject>: the api token a device-flow login would return, minted with the control plane's
# own key, written as mocactl's auth.json under $OUT/xdg-<subject> and as a curl header file. Both
# 0600 under a 0700 dir; node reads the key file and writes the token, so it never passes the shell.
login_as() {
  local dir="$OUT/xdg-$1"
  install -d -m 0700 "$dir" "$dir/mocactl" || return 1
  (cd "$MOCA_ROOT/packages/control-plane" && umask 077 &&
    MINT_KEY_FILE="$MOCA_CRED_DIR/session-token-private-key" MINT_SUB="p4smoke:$1" MINT_DIR="$dir" \
      MINT_CP="$CP" node --import tsx --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import { makeSigner } from "./src/token.ts";
    const e = process.env, ttl = 3600, now = Math.floor(Date.now() / 1000);
    const token = makeSigner(readFileSync(e.MINT_KEY_FILE, "utf8"))
      .mint({ sub: e.MINT_SUB, tenant: e.MINT_SUB, roles: [], scope: ["api"], ttlSeconds: ttl });
    writeFileSync(`${e.MINT_DIR}/mocactl/auth.json`, JSON.stringify({ apiToken: token, subject: e.MINT_SUB,
      roles: [], expiresAt: now + ttl, controlPlaneUrl: e.MINT_CP }), { mode: 0o600 });
    writeFileSync(`${e.MINT_DIR}/api.hdr`, `Authorization: Bearer ${token}\n`, { mode: 0o600 });')
}
# store_credential <subject>: a bearer inference credential aimed at the loopback mock model. Direct
# mode sends it as the model's Authorization; the mock ignores it. Prints the PUT's HTTP code (204).
store_credential() {
  local body
  body="$(node -e 'const u = new URL(process.argv[1]); process.stdout.write(JSON.stringify({ kind: "bearer",
    consumer: "inference", destination: { hosts: [u.hostname] }, endpoint: u.origin,
    secret: { token: "mock-not-a-secret" } }))' "$SMOKE_MODEL_URL")"
  curl -sS --max-time 10 -o "$OUT/credential-$1.json" -w '%{http_code}' -X PUT \
    -H @"$OUT/xdg-$1/api.hdr" -H 'content-type: application/json' -d "$body" \
    "$CP/v1/credentials/$SMOKE_CREDENTIAL" 2>>"$OUT/credential-$1.err"
}
# session_code <subject> <session id>: the HTTP code of GET /v1/sessions/<id> as that subject, or
# "no-id" for an empty id (which would hit /v1/sessions/, a different route).
session_code() {
  [ -n "$2" ] || { echo no-id; return; }
  curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H @"$OUT/xdg-$1/api.hdr" \
    "$CP/v1/sessions/$2" 2>/dev/null
}
# turn <name> <session id, or "" for a new session> <prompt> [subject]: writes <name>.code, <name>.txt
# (the response text) and <name>.sid (the session id), and prints nothing. Without --auth it posts
# /turn and <name>.code is the HTTP code; with --auth it runs `mocactl run` as <subject> (default a)
# and <name>.code is 200 for a clean exit, exit-<n> otherwise, with mocactl's stderr in <name>.err.
turn() {
  if [ "$AUTH" = 1 ]; then turn_mocactl "$@"; else turn_http "$@"; fi
}
turn_mocactl() {
  local dir="$OUT/xdg-${4:-a}" rc bound=()
  local args=(run "$3" --control-plane-url "$CP" --harness-url "$SUP")
  if [ -n "$2" ]; then args+=(--session "$2"); else args+=(--option "inferenceCredential=$SMOKE_CREDENTIAL"); fi
  # A session keeps the tier it was created in, so only a new one names it.
  if [ -z "$2" ] && [ "$TIERED" = 1 ]; then args+=(--option sandboxTier=microvm); fi
  # A hung turn must end the check, not the driver. timeout(1) is coreutils (the rig has it); without
  # it the turn is unbounded.
  # --foreground keeps mocactl in the driver's process group, so a Ctrl-C on the driver reaches it
  # too instead of leaving the turn running until the bound.
  command -v timeout >/dev/null && bound=(timeout --foreground "$SMOKE_TURN_TIMEOUT")
  XDG_CONFIG_HOME="$dir" XDG_STATE_HOME="$dir/state" ${bound[@]+"${bound[@]}"} "${MOCACTL_CMD[@]}" "${args[@]}" \
    >"$OUT/$1.txt" 2>"$OUT/$1.err"
  rc=$?
  # 124 is timeout(1)'s own code: say so, rather than leave an exit code to look up.
  if [ "$rc" = 0 ]; then echo 200; elif [ "$rc" = 124 ] && ((${#bound[@]})); then echo "timed-out"
  else echo "exit-$rc"; fi >"$OUT/$1.code"
  # mocactl names the session on stderr before the turn starts: "session <id>".
  sed -n 's/^session \([^ ]*\)$/\1/p' "$OUT/$1.err" | head -1 >"$OUT/$1.sid"
}
turn_http() {
  local body
  # Built by JSON.stringify, not interpolated: a prompt with a quote, backslash or newline would
  # otherwise be malformed JSON and a 400 that reads like a server fault. node is already required.
  body="$(node -e 'const [s, p] = process.argv.slice(1);
    process.stdout.write(JSON.stringify(s ? { sessionId: s, prompt: p } : { prompt: p }))' "$2" "$3")"
  curl -sS --max-time 300 -o "$OUT/$1.json" -w '%{http_code}' -X POST "$SUP/turn" \
    -H 'content-type: application/json' -d "$body" >"$OUT/$1.code" 2>"$OUT/$1.err"
  json_field "$OUT/$1.json" response >"$OUT/$1.txt"
  json_field "$OUT/$1.json" sessionId >"$OUT/$1.sid"
}
has() { grep -qF -- "$2" "$OUT/$1.txt" && echo yes || echo no; }
# absent <name> <needle> <proof>: "absent" only if the response is demonstrably there (it contains
# <proof>, a string this turn must print) and <needle> is not in it. Without the proof a missing or
# empty response would make every "did not see X" check pass, proving nothing.
absent() {
  if [ "$(has "$1" "$3")" != yes ]; then echo "no-response"
  elif [ "$(has "$1" "$2")" = yes ]; then echo "present"
  else echo "absent"; fi
}
code() { cat "$OUT/$1.code"; }

# running_vm: the id of the one Firecracker VM whose state is Running. Standbys are restored and
# PAUSED; the newest process is usually the replacement standby an acquire just triggered, so
# "newest pid" is the wrong VM.
running_vm() {
  local sock vm
  for sock in "$SH_JAIL_BASE"/firecracker/vm-*/root/run/firecracker.socket; do
    [ -e "$sock" ] || continue
    if curl -sS --max-time 2 --unix-socket "$sock" http://localhost/ 2>/dev/null | grep -q '"state":"Running"'; then
      vm="${sock#"$SH_JAIL_BASE"/firecracker/}"
      echo "${vm%%/*}"
      return 0
    fi
  done
  return 1
}

echo "== preconditions" | tee "$OUT/SUMMARY"
check "the microVM worker is in the pool" \
  "$(podman exec sh-redis redis-cli HEXISTS sh:sandbox:records "$MICROVM_SANDBOX_ID")" "1"
if [ "$TIERED" = 1 ]; then
  check "the host is tiered (container, microvm)" "$(env_file_value SH_SANDBOX_TIERS "$TIERS_ENV")" "container,microvm"
  # --auth names the tier on every session it creates; an unauthenticated turn gets the default.
  if [ "$AUTH" != 1 ]; then
    check "unauthenticated turns run in the default tier, so $TIERS_ENV must set SH_SANDBOX_DEFAULT_TIER=microvm (else use --auth, or re-run setup-microvm.sh with SH_SANDBOX_DEFAULT_TIER=microvm)" \
      "$(env_file_value SH_SANDBOX_DEFAULT_TIER "$TIERS_ENV")" "microvm"
  fi
else
  check "no container sandbox exists (P4-only host)" \
    "$(podman ps -a --format '{{.Names}}' --filter 'name=^sh-sandbox-' | wc -l | tr -d ' ')" "0"
fi

if [ "$AUTH" = 1 ]; then
  echo "== control plane: two subjects, each a stand-in for mocactl login" | tee -a "$OUT/SUMMARY"
  check "the control plane answers" \
    "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$CP/healthz" 2>/dev/null)" "200"
  for s in a b; do
    if login_as "$s" 2>"$OUT/login-$s.err"; then check "minted subject $s's api token" yes yes
    else check "minted subject $s's api token (see login-$s.err; run as root?)" no yes; fi
    check "stored subject $s's inference credential" "$(store_credential "$s")" "204"
  done
fi

since="$(date '+%Y-%m-%d %H:%M:%S')"
host_kernel="$(uname -r)"

echo "== session A, turn 1: write a file, git, python, rg" | tee -a "$OUT/SUMMARY"
turn a1 "" "P4-SMOKE-WRITE"
A="$(cat "$OUT/a1.sid")"
echo "$A" >"$OUT/session-a"
check "a1 HTTP 200" "$(code a1)" "200"
check "a1 named its new session" "$([ -n "$A" ] && echo yes || echo no)" "yes"
check "a1 ran the model's final text" "$(has a1 done-write)" "yes"
check "a1 ran on the golden rootfs (provenance file)" "$(has a1 'image=')" "yes"
check "a1 python3 ran" "$(has a1 42)" "yes"
check "a1 guest kernel is not the host's" "$(absent a1 "$host_kernel" 'image=')" "absent"

echo "== session A, turn 2: the workspace survived between turns" | tee -a "$OUT/SUMMARY"
turn a2 "$A" "P4-SMOKE-READ"
check "a2 HTTP 200" "$(code a2)" "200"
check "a2 read turn 1's file" "$(has a2 p4-proof)" "yes"
check "a2 saw turn 1's repo" "$(has a2 continuity-ok)" "yes"

echo "== session B: a different workspace" | tee -a "$OUT/SUMMARY"
turn b1 "" "P4-SMOKE-READ" b
B="$(cat "$OUT/b1.sid")"
echo "$B" >"$OUT/session-b"
check "b1 HTTP 200" "$(code b1)" "200"
check "b1 is a different session" "$([ -n "$B" ] && [ "$B" != "$A" ] && echo yes || echo no)" "yes"
check "b1 did not see A's file" "$(absent b1 p4-proof continuity-missing)" "absent"
check "b1 did not see A's repo" "$(has b1 continuity-missing)" "yes"
if [ "$AUTH" = 1 ]; then
  # Session B is a second subject's, not a second session of one. The control plane answers 404 for
  # another subject's session, but also for an id it never saw and for an empty one, so the 404 counts
  # only next to its positive controls: each owner reads its own session.
  check "subject a reads its own session A (200)" "$(session_code a "$A")" "200"
  check "subject b reads its own session B (200)" "$(session_code b "$B")" "200"
  check "subject b cannot read subject a's session (404)" "$(session_code b "$A")" "404"
fi

echo "== evidence on the host" | tee -a "$OUT/SUMMARY"
journalctl -u microvm-worker --since "$since" --no-pager >"$OUT/journal.log" 2>&1
# At-least, not exact: the harness may issue Execs of its own (file ops) besides the model's
# three bash calls, and the check is that they all landed in A's workspace, not how many there were.
count_key() { # count_key <session id>: journal Exec lines for that workspace_key (0 for no id)
  [ -n "$1" ] || { echo 0; return; }
  grep -c "workspace_key=\"$1\"" "$OUT/journal.log" || true
}
nA="$(count_key "$A")"
nB="$(count_key "$B")"
check "journal: A's Execs name its workspace_key (>= 3 tool calls)" "$([ "$nA" -ge 3 ] && echo yes || echo "no ($nA)")" "yes"
check "journal: B's Execs name its workspace_key (>= 1)" "$([ "$nB" -ge 1 ] && echo yes || echo "no ($nB)")" "yes"
nExec="$(grep -cE 'vmpool: exec .*vm=vm-' "$OUT/journal.log")"
check "journal: every Exec ran in a distinct VM (#274: one VM per Exec)" \
  "$(grep -oE 'vm=vm-[0-9]+' "$OUT/journal.log" | sort -u | wc -l | tr -d ' ')" "$nExec"
check "workspace dir for A" "$([ -n "$A" ] && [ -d "$SH_WORKSPACE_ROOT/$A" ] && echo yes || echo no)" "yes"
check "workspace dir for B" "$([ -n "$B" ] && [ -d "$SH_WORKSPACE_ROOT/$B" ] && echo yes || echo no)" "yes"
du -sh "$SH_WORKSPACE_ROOT/$A" "$SH_WORKSPACE_ROOT/$B" >"$OUT/workspace-du.txt" 2>&1

if [ "$FAILURE_PATHS" = 1 ]; then
  echo "== failure path 1: worker restarted mid-Exec" | tee -a "$OUT/SUMMARY"
  turn f1 "$A" "P4-SMOKE-SLEEP" &
  tpid=$!
  sleep "$SMOKE_FAIL_DELAY"
  systemctl restart microvm-worker.service
  wait "$tpid"
  check "f1 HTTP 200 (the turn ended, it did not hang)" "$(code f1)" "200"
  check "f1's tool error is named" "$(has f1 'worker disconnected')" "yes"
  check "f1 never reported the command finishing" "$(absent f1 slept done-sleep)" "absent"
  for _ in $(seq 60); do
    [ "$(podman exec sh-redis redis-cli HEXISTS sh:sandbox:records "$MICROVM_SANDBOX_ID")" = 1 ] && break
    sleep 1
  done

  echo "== failure path 2: the VM running the Exec is killed" | tee -a "$OUT/SUMMARY"
  turn f2 "$A" "P4-SMOKE-SLEEP" &
  tpid=$!
  sleep "$SMOKE_FAIL_DELAY"
  vm="$(running_vm || true)"
  vmpid=""
  [ -n "$vm" ] && vmpid="$(pgrep -f -- "--id $vm( |\$)" | head -1)"
  echo "  killed ${vm:-none} (pid ${vmpid:-none})" | tee -a "$OUT/SUMMARY"
  check "a Running VM was found for the in-flight Exec" "$([ -n "$vmpid" ] && echo yes || echo no)" "yes"
  # `env kill`, the external kill, not the shell builtin: the builtin cannot be intercepted, so a
  # test could never stand in for it, and it would signal a REAL pid on whatever machine runs the test.
  [ -n "$vmpid" ] && env kill -KILL "$vmpid"
  wait "$tpid"
  check "f2 HTTP 200 (the turn ended, it did not hang)" "$(code f2)" "200"
  check "f2 never reported the command finishing" "$(absent f2 slept done-sleep)" "absent"
  # Recorded, not asserted: which layer names a killed VM is what this run finds out.
  echo "  f2 error text (record in the runbook): $(sed -n '2p' "$OUT/f2.txt")" | tee -a "$OUT/SUMMARY"
fi

if [ "$fails" -eq 0 ]; then echo "PASS ($OUT)" | tee -a "$OUT/SUMMARY"; else echo "FAIL ($fails) ($OUT)" | tee -a "$OUT/SUMMARY"; fi
exit "$fails"
