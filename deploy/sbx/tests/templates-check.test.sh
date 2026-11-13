#!/usr/bin/env bash
# Tests for deploy/sbx/templates-check.sh against fakes: a mocactl (a node script, as MOCACTL is) that
# keeps two users' sandboxes and two templates, each on its own worker, in a temp dir; and a python3
# that plays the direct client and the relay's rule (a token is refused for any worker but its own).
# What it must do: nothing without SBX_LIVE_CHECK=1; refuse bad settings before any call; pass every
# check against a correct service; fail the check that a broken service breaks (two templates on one
# worker, an unknown template accepted, a probe that answers on the wrong template, a cross-worker
# token accepted, B reaching A's sandbox); delete every sandbox it created; never print a token.
# The check runs under this test's own interpreter ($BASH), so `/bin/bash templates-check.test.sh`
# tests it on bash 3.2.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CHECK="$SRC/deploy/sbx/templates-check.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }
command -v node >/dev/null && command -v jq >/dev/null || { echo 'SKIP: templates-check.test.sh needs node and jq'; exit 0; }
# The check keeps a failed run's logs under $TMPDIR: this test's own, removed with it.
export TMPDIR="$TMP/tmp"
mkdir -p "$TMPDIR"
export MOCK_DIR="$TMP/state" MOCK_LOG="$TMP/mock.log" TOKEN_CANARY="tok-canary-$$"
mkdir -p "$MOCK_DIR/sb" "$TMP/home-a" "$TMP/home-b" "$TMP/bin"
echo a >"$TMP/home-a/.user"
echo b >"$TMP/home-b/.user"

# mocactl sbx: templates, create, ls, rm, env, token, run, up. A sandbox is $MOCK_DIR/sb/<id>.json.
# MOCK_ONE_WORKER=1 puts both templates on one worker; MOCK_ACCEPT_UNKNOWN=1 accepts any template;
# MOCK_B_SEES=1 lets user B read user A's sandboxes.
cat >"$TMP/mocactl.mjs" <<'MOCK'
import fs from 'node:fs';
import path from 'node:path';
const D = process.env.MOCK_DIR, user = fs.readFileSync(path.join(process.env.HOME, '.user'), 'utf8').trim();
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, `mocactl user=${user} xdg=${process.env.XDG_CONFIG_HOME ?? ''}${process.env.XDG_STATE_HOME ?? ''} ${argv.join(' ')}\n`);
const out = (s) => process.stdout.write(s + '\n'), err = (s) => { process.stderr.write(s + '\n'); process.exit(1); };
const TEMPLATES = { default: 'sbx_default', 'swe-x': process.env.MOCK_ONE_WORKER === '1' ? 'sbx_default' : 'sbx_swe_x_v1' };
const IMAGE = { sbx_default: 'default', sbx_swe_x_v1: 'swe' };
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
const all = () => fs.readdirSync(path.join(D, 'sb')).map((f) => JSON.parse(fs.readFileSync(path.join(D, 'sb', f), 'utf8')));
const get = (id) => {
  const f = path.join(D, 'sb', `${id}.json`);
  if (!fs.existsSync(f)) err('sbx: no such sandbox');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (s.owner !== user && process.env.MOCK_B_SEES !== '1') err('sbx: no such sandbox');
  return s;
};
const create = (template, name) => {
  if (!(template in TEMPLATES) && process.env.MOCK_ACCEPT_UNKNOWN !== '1') err('sbx: unknown_template: no such template (GET /v1/templates lists them)');
  const n = all().length + 1, id = `sbx-${n.toString(16).padStart(26, '0')}`;
  const s = { id, owner: user, name: name ?? null, template, worker: TEMPLATES[template] ?? 'sbx_default', state: 'ready' };
  fs.writeFileSync(path.join(D, 'sb', `${id}.json`), JSON.stringify(s));
  return s;
};
const [, cmd] = argv;
if (argv[0] !== 'sbx') err('not sbx');
if (cmd === 'templates') out(JSON.stringify(Object.keys(TEMPLATES).map((id) => ({ id, description: id, tools: ['bash'] }))));
else if (cmd === 'create') { const s = create(flag('--template'), flag('--name')); out(JSON.stringify({ id: s.id, template: s.template, name: s.name, state: s.state })); }
else if (cmd === 'ls') out(JSON.stringify(all().filter((s) => s.owner === user).map(({ id, name, template, state }) => ({ id, name, template, state }))));
else if (cmd === 'rm') { const id = argv.find((a) => a.startsWith('sbx-')); const s = get(id); s.state = 'terminated'; fs.writeFileSync(path.join(D, 'sb', `${id}.json`), JSON.stringify(s)); out(`deleted ${id}`); }
else if (cmd === 'env') { const s = get(argv[2]); out(`export SBX_ADDR='exec.example.invalid:443'\nexport SBX_TLS='1'\nexport SBX_SANDBOX_ID='${s.worker}'\nexport SBX_WORKSPACE_KEY='${s.id}'\nexport SBX_CA_FILE=''`); }
else if (cmd === 'token') { const s = get(argv[2]); out(`${process.env.TOKEN_CANARY}.${s.worker}.${s.id}`); }
else if (cmd === 'run') {
  const s = get(flag('--sandbox')), sh = argv.slice(argv.indexOf('--') + 1);
  const script = sh[sh.length - 1], image = IMAGE[s.worker];
  if (script.includes('moca-rootfs-source')) out(`hello image=x digest=sha256:${image === 'swe' ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb'}`);
  else if (script === 'probe-swe') out(image === 'swe' || process.env.MOCK_PROBE_LEAKS === '1' ? 'yes' : 'no');
  else out('?');
}
else if (cmd === 'up') {
  const t = flag('--template'), bf = path.join('.sbx', 'sandbox.json');
  if (fs.existsSync(bf)) {
    const b = get(JSON.parse(fs.readFileSync(bf, 'utf8')).id);
    if (t && b.template !== t) err(`the bound sandbox ${b.id} has template ${b.template}, not ${t}: pull its work, remove it`);
    out(`reused ${b.id}`);
  } else { const s = create(t, flag('--name')); fs.mkdirSync('.sbx', { recursive: true }); fs.writeFileSync(bf, JSON.stringify({ id: s.id })); out(`up ${s.id}`); }
}
else err(`mock: unexpected ${argv.join(' ')}`);
MOCK

# python3 for the direct client: `-c 'import grpc...'` succeeds; protoc writes nothing; the heredoc
# client gets the token file and the worker id, and answers as the relay would (exact wrk match).
cat >"$TMP/bin/python3" <<'MOCK'
#!/usr/bin/env bash
if [[ "${1:-}" == -c ]]; then exit 0; fi
if [[ "${1:-}" == -m ]]; then exit 0; fi
if [[ "${1:-}" == - ]]; then
  cat >/dev/null
  tok="$(cat "$4")" wrk="$6"
  tokwrk="$(printf '%s' "$tok" | cut -d. -f2)"
  if [[ "$tokwrk" == "$wrk" || "${MOCK_RELAY_LAX:-}" == 1 ]]; then echo 'outcome=end'; else echo 'outcome=rpc code=PERMISSION_DENIED'; fi
  exit 0
fi
exit 99
MOCK
chmod +x "$TMP/bin/python3"

run_check() { # run_check [VAR=VALUE ...]: the check against the fakes, its output in $TMP/out
  rm -rf "$MOCK_DIR/sb"; mkdir -p "$MOCK_DIR/sb"; : >"$MOCK_LOG"
  env SBX_LIVE_CHECK=1 SBX_API_URL=https://sbx-api.example.invalid SBX_CHECK_HOME_A="$TMP/home-a" SBX_CHECK_HOME_B="$TMP/home-b" \
    SBX_CHECK_TEMPLATES=default,swe-x SBX_CHECK_PROBE_SWE_X=probe-swe MOCACTL="$TMP/mocactl.mjs" SBX_CHECK_PYTHON="$TMP/bin/python3" \
    XDG_CONFIG_HOME=/should-be-unset "$@" "$BASH" "$CHECK" >"$TMP/out" 2>&1
}
live_left() { jq -r 'select(.state != "terminated") | .id' "$MOCK_DIR"/sb/*.json 2>/dev/null | wc -l | tr -d ' '; }

# Nothing without SBX_LIVE_CHECK=1.
: >"$MOCK_LOG"
"$BASH" "$CHECK" >"$TMP/out" 2>&1 || fail 'without SBX_LIVE_CHECK it exited non-zero'
grep -q '^SKIP: ' "$TMP/out" && [[ ! -s "$MOCK_LOG" ]] || fail 'without SBX_LIVE_CHECK it did something'
pass 'does nothing without SBX_LIVE_CHECK=1'

# Settings refusals, exit 2, before any mocactl call.
for bad in 'SBX_CHECK_TEMPLATES=default' 'SBX_CHECK_TEMPLATES=default,Bad_Id' "SBX_CHECK_HOME_B=$TMP/home-a" 'SBX_API_URL=http://x' 'SBX_CHECK_EXEC=2'; do
  rc=0; run_check "$bad" || rc=$?
  [[ "$rc" == 2 ]] || fail "$bad: exit $rc, not 2"
  [[ ! -s "$MOCK_LOG" ]] || fail "$bad: called mocactl before refusing"
done
pass 'refuses one template, a bad id, the same HOME twice, a non-https URL and a bad SBX_CHECK_EXEC (exit 2, no calls)'

# A correct service: every check ok, every sandbox deleted, XDG unset, no token printed.
run_check || fail 'a correct service did not pass'
[[ "$(grep -c '^ok ' "$TMP/out")" == 7 ]] || fail "expected 7 ok lines, got $(grep -c '^ok ' "$TMP/out")"
! grep -q '^not ok' "$TMP/out" || fail 'a not ok against a correct service'
grep -q 'default->sbx_default swe-x->sbx_swe_x_v1' "$TMP/out" || fail 'the routing line does not name each template with its worker'
grep -q "PERMISSION_DENIED" "$TMP/out" || fail 'the isolation line does not name PERMISSION_DENIED'
[[ "$(live_left)" == 0 ]] || fail "$(live_left) sandboxes left live"
! grep -q 'xdg=/should-be-unset' "$MOCK_LOG" || fail 'mocactl ran with XDG_CONFIG_HOME set'
! grep -qF "$TOKEN_CANARY" "$TMP/out" || fail 'a token was printed'
pass 'passes all checks against a correct service; deletes every sandbox; XDG unset; prints no token'

# SBX_CHECK_EXEC=0: no command in a sandbox, the hands check is a SKIP.
run_check SBX_CHECK_EXEC=0 || fail 'SBX_CHECK_EXEC=0 did not pass'
grep -q '^ok [0-9]* - hands: .* # SKIP SBX_CHECK_EXEC=0' "$TMP/out" || fail 'hands is not a SKIP with SBX_CHECK_EXEC=0'
grep -q '^ok [0-9]* - up: .* # SKIP SBX_CHECK_EXEC=0' "$TMP/out" || fail 'up is not a SKIP with SBX_CHECK_EXEC=0'
! grep -qE ' (run|up) ' "$MOCK_LOG" || fail 'ran a command or sbx up with SBX_CHECK_EXEC=0'
pass 'SBX_CHECK_EXEC=0 runs no command and no sbx up, skipping both checks'

# Each broken service fails its own check, exits 1, and still deletes its sandboxes.
for c in 'MOCK_ONE_WORKER=1:routing: every template has its own worker' \
  'MOCK_ACCEPT_UNKNOWN=1:create: an unknown template is refused' \
  'MOCK_PROBE_LEAKS=1:hands:' \
  'MOCK_RELAY_LAX=1:isolation: a default sandbox'"'"'s token sent to swe-x'"'"'s worker is refused' \
  'MOCK_B_SEES=1:isolation: user B cannot reach'; do
  rc=0; run_check "${c%%:*}" || rc=$?
  [[ "$rc" == 1 ]] || fail "${c%%:*}: exit $rc, not 1"
  grep -q "^not ok [0-9]* - ${c#*:}" "$TMP/out" || fail "${c%%:*}: no 'not ok ... ${c#*:}'"
  [[ "$(live_left)" == 0 ]] || fail "${c%%:*}: $(live_left) sandboxes left live"
done
pass 'fails the matching check for one worker, an accepted unknown template, a leaking probe, a lax relay, B reaching A; cleans up each time'
