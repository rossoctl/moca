#!/usr/bin/env bash
# deploy/vm/research-smoke.sh
#
# Live smoke for #368 (VM demo C). One user's turn on the P6 VM, on that user's OWN inference
# credential (or the operator fallback), must run `git clone` and `curl -o` in a container sandbox and
# answer a question only the fetched content can answer. Run it on the VM, as root:
#   - it mints the user's API token with the control plane's own signing key, as deploy/vm/README.md
#     "Checking it" does, so no GitHub login is needed;
#   - it reads the ground truth from the sandbox containers with podman.
#
#   sudo VM_RESEARCH_SMOKE=1 RESEARCH_CREDENTIAL_FILE=/root/inference-key ./deploy/vm/research-smoke.sh
#   sudo VM_RESEARCH_SMOKE=1 RESEARCH_USE_OPERATOR_FALLBACK=1 ./deploy/vm/research-smoke.sh
#
# What passes:
#   - both commands appear in the turn's SSE tool_use frames, and neither tool_result is an error;
#   - the fetched files exist in a sandbox container;
#   - the answer's COMMIT/NODE_VERSION/NODE_DATE lines equal what that container's own copy of the
#     files says. A model answering from memory cannot pass: the clone's HEAD changes with every
#     merge, and the newest Node.js release every few weeks;
#   - the control plane's audit stream shows the turn spent the credential this run meant it to.
#
# Environment:
#   VM_RESEARCH_SMOKE=1               Required; without it this exits 0 having done nothing.
#   RESEARCH_CREDENTIAL_FILE          A file holding the user's inference key: exactly one line, the key
#                                     alone, no surrounding whitespace. Read from the file, never argv/env. An Anthropic API key
#                                     (sk-ant-api…) is stored as kind api-key for https://api.anthropic.com;
#                                     anything else as kind bearer for RESEARCH_ENDPOINT.
#   RESEARCH_ENDPOINT                 The gateway origin a bearer token is for (required for one).
#   RESEARCH_USE_OPERATOR_FALLBACK=1  Store no credential. The turn must then run on the operator's key
#                                     (SH_ALLOW_OPERATOR_FALLBACK=true; deploy/vm/README.md).
#   RESEARCH_HARNESS_URL              The supervisor (default http://127.0.0.1:8080).
#   RESEARCH_TURN_TIMEOUT             Seconds the turn may take (default 900).
#   SH_ENV_DIR, SH_INSTALL_DIR        As setup-vm.sh (default /etc/serverless-harness, /opt/serverless-harness).
#   SH_CRED_DIR                       TEST-ONLY, as setup-vm.sh (default $SH_ENV_DIR/credentials).
#   RESEARCH_DELETE_WAIT              Seconds between tries at deleting the session (default 2).
#   KEEP=1                            Leave the credential, session, fetched files, the minted subject's
#                                     record in the credential store, and the evidence in place.
set -uo pipefail

if [[ "${VM_RESEARCH_SMOKE:-}" != 1 ]]; then
  echo "SKIP: set VM_RESEARCH_SMOKE=1 to run the VM research smoke (on the VM, as root, with a model key)"
  exit 0
fi

: "${SH_ENV_DIR:=/etc/serverless-harness}"
: "${SH_INSTALL_DIR:=/opt/serverless-harness}"
CRED_DIR="${SH_CRED_DIR:-$SH_ENV_DIR/credentials}"
HARNESS="${RESEARCH_HARNESS_URL:-http://127.0.0.1:8080}"
TURN_TIMEOUT="${RESEARCH_TURN_TIMEOUT:-900}"
REPO_URL=https://github.com/rossoctl/moca
PAGE_URL=https://nodejs.org/dist/index.json
RUN_ID="research-$(date +%s)-$$"
WORKDIR="/workspace/$RUN_ID"
SUBJECT="research-smoke:$RUN_ID"
CRED_NAME=research-smoke
FALLBACK="${RESEARCH_USE_OPERATOR_FALLBACK:-}"

# research_prompt <dir>: the research turn's prompt. deploy/vm/README.md ("A research turn") carries
# the same text with <dir> = /workspace/research-demo, for the demo runbook; keep the two in step.
research_prompt() {
  cat <<EOF
This is a research task. Use your bash tool for every step, and do not answer from memory.
1. Run: git clone --depth 1 $REPO_URL $1/moca
2. Run: curl -fsSL -o $1/node-releases.json $PAGE_URL
   The file is large: do not print it. Read what you need from it with head, grep or python3.
3. Find the commit the clone checked out, and the newest Node.js release in the fetched file (its
   first entry) with its release date.
Reply with one short paragraph saying what you found, then end with exactly these three lines:
COMMIT=<the first 12 characters of the commit hash>
NODE_VERSION=<the version, for example v1.2.3>
NODE_DATE=<its date, YYYY-MM-DD>
EOF
}

PASS=0
FAIL=0
ok() {
  PASS=$((PASS + 1))
  echo "  ok $*"
}
ko() {
  FAIL=$((FAIL + 1))
  echo "  FAIL $*"
}
claim() { printf '\n--- %s ---\n' "$*"; }
die() {
  echo "research-smoke: $*" >&2
  exit 2
}

# Everything this run writes, secrets included (the api and session tokens, as curl header files), in
# one 0700 directory. The header files go at exit whatever happens; the rest stays only on failure,
# as evidence.
OUT="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/research-smoke.XXXXXX")" || die "cannot create a work directory"
SID=""
STORED=""
TURNED=""

# js <expr> <json file>: evaluate a JavaScript expression over one JSON file (bound to `s`) and print it.
js() {
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
    process.stdout.write(String(new Function("s", "return (" + process.argv[1] + ")")(s) ?? ""))' "$1" "$2" 2>/dev/null
}
# hdr <name> <token>: an Authorization header file for curl -H @file, so no token reaches an argv.
hdr() { (umask 077 && printf 'Authorization: Bearer %s\n' "$2" >"$OUT/$1.hdr"); }
sandboxes() { podman ps --format '{{.Names}}' --filter 'name=^sh-sandbox-' --filter status=running; }

# Remove this run's minted subject from the file credential store (#418). Deleting the credential
# cannot do it: the store's `delete` writes the subject's document back without that credential and
# never unlinks, so an empty record survives -- one per run, forever. Nothing but this subject is
# ever touched: the name is the sha256[:16] of THIS run's subject, which no other subject can hash
# to, and the file must parse as a document holding no credentials.
# A control-plane route that deleted an empty subject would let this (and P4-ON-P6.md's smoke) stop
# reaching into the store; until then both do it by hand.
drop_record() {
  local dir hash f
  dir="$( (grep -oE '^SH_CREDENTIAL_DIR=.*' "$SH_ENV_DIR/control-plane.env" 2>/dev/null || true) | tail -1 | cut -d= -f2-)"
  # Only the file store keeps records here; vault (or no store line at all) has nothing to remove.
  [[ -n "$dir" && -d "$dir" ]] || return 0
  # The store's own name for the subject (packages/control-plane/src/subject-document.ts).
  hash="$(SMOKE_SUB="$SUBJECT" node -e '
    const { createHash } = require("node:crypto");
    process.stdout.write(createHash("sha256").update(process.env.SMOKE_SUB).digest("hex").slice(0, 16));
  ' 2>/dev/null)" || return 0
  # No format check on $hash: node either printed this subject's 16 hex characters or the run
  # returned above, and an empty one makes `$dir/.json`, which the next line does not find.
  f="$dir/$hash.json"
  [[ -f "$f" ]] || return 0
  # Refuse to remove a record that still holds a credential: this subject is this run's alone, so
  # that would mean the delete above did not land, and silently dropping it would destroy the only
  # evidence. Say so instead.
  if ! node -e '
    const doc = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.exit(Object.keys(doc.credentials ?? {}).length === 0 ? 0 : 1);
  ' "$f" 2>/dev/null; then
    echo "warning: $f still holds a credential for $SUBJECT; it stays (delete it by hand)" >&2
    return 0
  fi
  rm -f "$f" || echo "warning: could not remove $SUBJECT's record $f; delete it by hand" >&2
}

cleanup() {
  local c
  if [[ "${KEEP:-}" == 1 ]]; then
    echo "KEEP=1: left subject $SUBJECT's ${STORED:+credential $CRED_NAME, }session ${SID:-<none>}," \
      "$WORKDIR in the sandbox, and the evidence in $OUT (token files included: delete it when done)"
    return
  fi
  if [[ -s "$OUT/api.hdr" ]]; then
    if [[ -n "$SID" ]]; then
      # deleteSession cascade-deletes even mid-turn (202), so only a transient failure -- a 5xx, a
      # dropped connection -- lands here: retry a few times, then say so rather than leave it silently.
      for _ in 1 2 3 4 5; do
        code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H @"$OUT/api.hdr" "$CP/v1/sessions/$SID" 2>/dev/null || true)"
        [[ "$code" == 2* || "$code" == 404 ]] && break
        sleep "${RESEARCH_DELETE_WAIT:-2}"
      done
      [[ "$code" == 2* || "$code" == 404 ]] ||
        echo "warning: could not delete session $SID (last answer HTTP ${code:-none}); it stays in the control plane" >&2
    fi
    [[ -z "$STORED" ]] || curl -sS -o /dev/null -X DELETE -H @"$OUT/api.hdr" "$CP/v1/credentials/$CRED_NAME" || true
  fi
  drop_record
  if [[ -n "$TURNED" ]]; then
    for c in $(sandboxes); do podman exec "$c" rm -rf "$WORKDIR" >/dev/null 2>&1 || true; done
  fi
  rm -f "$OUT"/*.hdr "$OUT/session.json"
  if [[ "$FAIL" -eq 0 && "$PASS" -gt 0 ]]; then rm -rf "$OUT"; else echo "evidence: $OUT"; fi
}
trap cleanup EXIT

if [[ -z "$FALLBACK" ]]; then
  [[ -n "${RESEARCH_CREDENTIAL_FILE:-}" ]] ||
    die "set RESEARCH_CREDENTIAL_FILE (a file holding the user's inference key), or RESEARCH_USE_OPERATOR_FALLBACK=1"
  [[ -s "$RESEARCH_CREDENTIAL_FILE" && -r "$RESEARCH_CREDENTIAL_FILE" ]] ||
    die "RESEARCH_CREDENTIAL_FILE ($RESEARCH_CREDENTIAL_FILE) is missing, empty or unreadable"
  # One line with no surrounding whitespace (a CR from a Windows editor included), so the kind
  # detected here and the secret node sends below are the same string: node trims, grep does not.
  [[ "$(grep -c . "$RESEARCH_CREDENTIAL_FILE")" == 1 ]] ||
    die "RESEARCH_CREDENTIAL_FILE must hold exactly one line: the key, and nothing else"
  ! grep -qE '^[[:space:]]|[[:space:]]$' "$RESEARCH_CREDENTIAL_FILE" ||
    die "RESEARCH_CREDENTIAL_FILE's line must be the key alone, with no surrounding whitespace"
  if grep -q '^sk-ant-api' "$RESEARCH_CREDENTIAL_FILE"; then
    CRED_KIND=api-key
  else
    CRED_KIND=bearer
    [[ -n "${RESEARCH_ENDPOINT:-}" ]] ||
      die "RESEARCH_ENDPOINT is required for a gateway (bearer) token: the gateway origin it is for"
  fi
fi
if [[ -n "$FALLBACK" ]]; then
  WHOSE="no credential of its own (the operator fallback)"
else
  WHOSE="its own $CRED_KIND credential"
fi
[[ -s "$CRED_DIR/session-token-private-key" ]] ||
  die "no signing key at $CRED_DIR/session-token-private-key: run this on the VM, as root, after setup-vm.sh"
CP_PORT="$(grep -oE '^SH_CONTROL_PLANE_PORT=[0-9]+' "$SH_ENV_DIR/control-plane.env" 2>/dev/null | tail -1 | cut -d= -f2)"
CP="http://127.0.0.1:${CP_PORT:-8090}"


claim "preconditions: control plane ready, container sandboxes attached, no microVM worker"
code="$(curl -sS -o /dev/null -w '%{http_code}' "$CP/readyz" 2>/dev/null || true)"
[[ "$code" == 200 ]] && ok "control plane $CP/readyz" || ko "control plane $CP/readyz answered '${code:-nothing}'"
boxes="$(sandboxes | grep -c . || true)"
[[ "$boxes" -ge 1 ]] && ok "$boxes running sh-sandbox-* container(s)" || ko "no running sh-sandbox-* container"
# One tier per host (deploy/microvm/P4-ON-P6.md): with a microVM worker attached the turn may land in
# a guest with no network (#277), and this smoke would fail for a reason that is not the one it tests.
# Read first, filtered second: a failed read must not look like an empty, all-container pool.
if ! records="$(podman exec sh-redis redis-cli HKEYS sh:sandbox:records 2>"$OUT/redis.err")"; then
  ko "could not read the pool records from sh-redis: $(head -c 300 "$OUT/redis.err")"
else
  others="$(grep -v '^sh-sandbox-' <<<"$records" | grep -v '^$' || true)"
  [[ -z "$others" ]] && ok "every pool record is a container sandbox" ||
    ko "the pool holds non-container records ($(tr '\n' ' ' <<<"$others")): a microVM worker has no network (#277); go back to containers (deploy/microvm/P4-ON-P6.md)"
fi
if [[ "$FAIL" -ne 0 ]]; then
  printf '\n=== Results: %s passed, %s failed (preconditions; no turn run) ===\n' "$PASS" "$FAIL"
  exit 1
fi

claim "a minted user ($SUBJECT) with $WHOSE"
token="$(cd "$SH_INSTALL_DIR/packages/control-plane" && SMOKE_KEY_FILE="$CRED_DIR/session-token-private-key" \
  SMOKE_SUB="$SUBJECT" node --import tsx --input-type=module -e "
import { readFileSync } from 'node:fs';
import { makeSigner } from './src/token.ts';
const s = makeSigner(readFileSync(process.env.SMOKE_KEY_FILE, 'utf8'));
const sub = process.env.SMOKE_SUB;
process.stdout.write(s.mint({ sub, tenant: sub, roles: [], scope: ['api'], ttlSeconds: 3600 }));" 2>"$OUT/mint.err")"
[[ -n "$token" ]] || die "could not mint an api token: $(head -c 400 "$OUT/mint.err")"
hdr api "$token"
token=""
if [[ -z "$FALLBACK" ]]; then
  # The body is built by node straight from the key file and piped to curl: the key is in no argv, no
  # env var and no file this script writes.
  code="$(RESEARCH_KEY_FILE="$RESEARCH_CREDENTIAL_FILE" RESEARCH_ENDPOINT="${RESEARCH_ENDPOINT:-}" node -e '
    const key = require("fs").readFileSync(process.env.RESEARCH_KEY_FILE, "utf8").trim();
    const raw = key.startsWith("sk-ant-api");
    const endpoint = raw ? "https://api.anthropic.com" : process.env.RESEARCH_ENDPOINT;
    const base = { consumer: "inference", destination: { hosts: [new URL(endpoint).hostname] }, endpoint };
    process.stdout.write(JSON.stringify(raw ? { ...base, kind: "api-key", secret: { key } }
      : { ...base, kind: "bearer", secret: { token: key } }));' |
    curl -sS -o "$OUT/put.json" -w '%{http_code}' -X PUT -H @"$OUT/api.hdr" -H 'Content-Type: application/json' \
      --data-binary @- "$CP/v1/credentials/$CRED_NAME" 2>>"$OUT/curl.err" || true)"
  if [[ "$code" == 2* ]]; then
    STORED=1
    ok "stored $CRED_KIND credential $CRED_NAME (HTTP $code)"
  else
    ko "PUT /v1/credentials/$CRED_NAME answered '$code': $(head -c 400 "$OUT/put.json" 2>/dev/null)"
  fi
fi
code="$(curl -sS -o "$OUT/session.json" -w '%{http_code}' -X POST -H @"$OUT/api.hdr" \
  -H 'Content-Type: application/json' -d '{}' "$CP/v1/sessions" 2>>"$OUT/curl.err" || true)"
SID="$(js 's.sessionId' "$OUT/session.json")"
if [[ "$code" == 201 && -n "$SID" ]]; then
  ok "session $SID"
  hdr turn "$(js 's.token' "$OUT/session.json")"
else
  ko "POST /v1/sessions answered '$code': $(head -c 400 "$OUT/session.json" 2>/dev/null)"
  printf '\n=== Results: %s passed, %s failed ===\n' "$PASS" "$FAIL"
  exit 1
fi

claim "the research turn (up to ${TURN_TIMEOUT}s): git clone and curl -o in the sandbox"
research_prompt "$WORKDIR" >"$OUT/prompt.txt"
TURNED=1
SMOKE_SID="$SID" node -e 'process.stdout.write(JSON.stringify({ sessionId: process.env.SMOKE_SID,
  prompt: require("fs").readFileSync(process.argv[1], "utf8") }))' "$OUT/prompt.txt" >"$OUT/turn-body.json"
curl -sSN --max-time "$TURN_TIMEOUT" -H @"$OUT/turn.hdr" -H 'Accept: text/event-stream' \
  -H 'Content-Type: application/json' -D "$OUT/turn.headers" --data-binary @"$OUT/turn-body.json" \
  "$HARNESS/v1/turn" >"$OUT/turn.sse" 2>>"$OUT/curl.err" || true
# The SSE stream IS the transcript: tool_use carries each command verbatim (harness/src/turn-stream.ts),
# tool_result says whether it failed, and the text deltas make the answer.
node -e '
  const fs = require("fs");
  const frames = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.startsWith("data: "))
    .flatMap((l) => { try { return [JSON.parse(l.slice(6))]; } catch { return []; } });
  const results = new Map(frames.filter((f) => f.type === "tool_result").map((f) => [f.id, f]));
  const tools = frames.filter((f) => f.type === "tool_use").map((f) => ({
    name: f.name, command: typeof f.args?.command === "string" ? f.args.command : "",
    ok: results.has(f.id) && !results.get(f.id).isError }));
  // Markdown the model may wrap the lines in (`COMMIT=…`, **COMMIT=…**) is not part of the value.
  const text = frames.filter((f) => f.type === "text").map((f) => f.delta).join("");
  const plain = text.replace(/[`*]/g, "");
  const last = (k) => { const m = [...plain.matchAll(new RegExp("^\\s*" + k + "=\\s*(\\S+)\\s*$", "gm"))];
    return m.length ? m[m.length - 1][1] : ""; };
  const done = frames.find((f) => f.type === "done"), error = frames.find((f) => f.type === "error");
  process.stdout.write(JSON.stringify({ tools, text, doneSession: done?.sessionId ?? "",
    stopReason: done?.stopReason ?? "", error: error ? (error.errorMessage ?? error.stopReason ?? "error") : "",
    commit: last("COMMIT"), nodeVersion: last("NODE_VERSION"), nodeDate: last("NODE_DATE") }));
' "$OUT/turn.sse" >"$OUT/summary.json" 2>>"$OUT/curl.err" || echo '{"tools":[]}' >"$OUT/summary.json"

if ! grep -qi '^content-type: text/event-stream' "$OUT/turn.headers" 2>/dev/null; then
  ko "not an SSE response: $(head -c 400 "$OUT/turn.sse")"
elif [[ -n "$(js 's.error' "$OUT/summary.json")" ]]; then
  ko "the turn ended in an error frame: $(js 's.error' "$OUT/summary.json")"
elif [[ "$(js 's.doneSession' "$OUT/summary.json")" == "$SID" ]]; then
  ok "the turn completed (stopReason $(js 's.stopReason' "$OUT/summary.json"))"
else
  ko "no done frame for $SID: $(tail -c 400 "$OUT/turn.sse")"
fi
ran() { # ran <what> <JS predicate over one tool call `t`>
  if [[ "$(js "s.tools.some((t) => t.name === 'bash' && t.ok && ($2))" "$OUT/summary.json")" == true ]]; then
    ok "$1 ran in the sandbox: $(js "s.tools.find((t) => t.name === 'bash' && t.ok && ($2)).command" "$OUT/summary.json")"
  elif [[ "$(js "s.tools.some((t) => t.name === 'bash' && ($2))" "$OUT/summary.json")" == true ]]; then
    ko "$1 was run but failed (its tool_result is an error)"
  else
    ko "no bash tool call ran $1; the turn's bash commands: $(js "s.tools.map((t) => t.command).join(' | ')" "$OUT/summary.json")"
  fi
}
ran "git clone" "/\\bgit\\s+clone\\b/.test(t.command) && t.command.includes('$REPO_URL')"
ran "curl -o" "/\\bcurl\\b/.test(t.command) && /(^|\\s)(-[A-Za-z]*o|--output)(\\s|=|$)/.test(t.command) && t.command.includes('$PAGE_URL')"

claim "the answer uses the fetched content (checked against the sandbox's own copy)"
box=""
for c in $(sandboxes); do
  if podman exec "$c" test -d "$WORKDIR"; then
    box="$c"
    break
  fi
done
if [[ -z "$box" ]]; then
  ko "no sandbox container holds $WORKDIR"
else
  ok "the fetched files are in $box:$WORKDIR"
  want_commit="$(podman exec "$box" git -C "$WORKDIR/moca" rev-parse HEAD 2>/dev/null | cut -c1-12)"
  read -r want_version want_date < <(podman exec "$box" python3 -c \
    'import json, sys; d = json.load(open(sys.argv[1])); print(d[0]["version"], d[0]["date"])' \
    "$WORKDIR/node-releases.json" 2>/dev/null || true)
  got_commit="$(js 's.commit.toLowerCase()' "$OUT/summary.json")"
  if [[ -n "$want_commit" && "$got_commit" == "$want_commit" ]]; then
    ok "COMMIT=$got_commit is the clone's HEAD"
  else
    ko "COMMIT='$got_commit', but the clone's HEAD is '${want_commit:-unreadable}'"
  fi
  for pair in "NODE_VERSION:nodeVersion:${want_version:-}" "NODE_DATE:nodeDate:${want_date:-}"; do
    IFS=: read -r label field want <<<"$pair"
    got="$(js "s.$field" "$OUT/summary.json")"
    if [[ -n "$want" && "$got" == "$want" ]]; then
      ok "$label=$got is the fetched file's newest release"
    else
      ko "$label='$got', but the fetched file says '${want:-unreadable}'"
    fi
  done
fi

claim "the turn spent the credential this run meant it to (control-plane audit)"
want_decision=credential_issued
[[ -z "$FALLBACK" ]] || want_decision=operator_fallback_used
got_decision="$(podman exec sh-redis redis-cli --raw XRANGE sh:cp:audit - + 2>/dev/null | SMOKE_SID="$SID" node -e '
  // --raw XRANGE: each entry is its id line, then field and value lines. Group them back.
  const lines = require("fs").readFileSync(0, "utf8").split("\n"), entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\d+-\d+$/.test(lines[i])) entries.push({});
    else if (entries.length && i + 1 < lines.length) entries[entries.length - 1][lines[i]] = lines[++i];
  }
  const mine = entries.filter((e) => e.sessionId === process.env.SMOKE_SID &&
    ["credential_issued", "operator_fallback_used"].includes(e.decision));
  process.stdout.write(mine.length ? mine[mine.length - 1].decision : "");' 2>/dev/null || true)"
if [[ "$got_decision" == "$want_decision" ]]; then
  ok "audit: $want_decision for $SID"
else
  ko "audit: want $want_decision for $SID, got '${got_decision:-none}'"
fi

printf '\n=== Results: %s passed, %s failed ===\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
