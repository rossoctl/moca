#!/usr/bin/env bash
# Tests for deploy/sbx/smoke.sh, the SBX0 live smoke (spec §10.6), against fakes on PATH: a mocactl
# that keeps sandboxes, workspaces and owners in a temp dir and logs every call; a python3 that plays
# the example sandbox/v1 client (and runs everything else on the real one); a fake clock (sleep and
# date), so the 5-minute and token-expiry steps run in a second; ssh, a janitor and claude.
# What it must do: nothing at all without SBX_LIVE_SMOKE=1; refuse bad settings before any call;
# run the selected steps only; print `ok N` / `not ok N` and exit 1 on a failure; delete every
# sandbox it created, as its owner, even on failure, and nothing else; never print a token.
# Step 7 (egress credentials) runs against a fake curl, git and gh as well, and the PAT, a canary in a
# file, must appear in no output line and no logged argv.
# SMOKE_SH overrides the script under test.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SMOKE="${SMOKE_SH:-$SRC/deploy/sbx/smoke.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }
REAL_PY="$(command -v python3)" || { echo 'SKIP: smoke.test.sh needs python3'; exit 0; }
REAL_SLEEP="$(command -v sleep)" REAL_DATE="$(command -v date)" REAL_GIT="$(command -v git)"
export REAL_PY REAL_SLEEP REAL_DATE REAL_GIT
export MOCK_LOG="$TMP/mock.log" MOCK_DIR="$TMP/state" MOCK_SRV="$TMP/host/srv" MOCK_CLOCK="$TMP/clock"
mkdir -p "$TMP/bin" "$TMP/failbin" "$MOCK_DIR/sb" "$MOCK_SRV/workspaces/sbx_default" "$TMP/host/etc" "$TMP/host/libexec"

# Two users' homes, logged in (the fake mocactl reads .user; smoke.sh reads only the subject).
for u in a b; do
  mkdir -p "$TMP/home-$u/.config/mocactl"
  echo "$u" >"$TMP/home-$u/.user"
  printf '{"subject":"github:%s","apiToken":"api-secret-%s"}\n' "$u" "$u" >"$TMP/home-$u/.config/mocactl/sbx-auth.json"
done
# A second HOME logged in as user A again: the "two users" check must notice.
mkdir -p "$TMP/home-same/.config/mocactl"
cp "$TMP/home-a/.user" "$TMP/home-same/.user"
cp "$TMP/home-a/.config/mocactl/sbx-auth.json" "$TMP/home-same/.config/mocactl/"

# The fake clock: date +%s reads it, sleep advances it at once. A sleep of exactly 900 s (the
# agent watchdog, smoke.sh's AGENT_TIMEOUT_S) really sleeps, so it stays a watchdog.
cat >"$TMP/bin/date" <<'MOCK'
#!/usr/bin/env bash
if [[ "$*" == +%s ]]; then cat "$MOCK_CLOCK"; else exec "$REAL_DATE" "$@"; fi
MOCK
cat >"$TMP/bin/sleep" <<'MOCK'
#!/usr/bin/env bash
n="${1%%.*}"
[[ "$n" != 900 ]] || exec "$REAL_SLEEP" "$@"
# MOCK_REAL_SLEEP_300=1: the silent command really blocks, so a TERM can arrive during it.
[[ "$n" != 300 || "${MOCK_REAL_SLEEP_300:-}" != 1 ]] || exec "$REAL_SLEEP" 30
# Under a lock, written whole by a rename: two steps' parallel sleeps must not interleave their
# writes and leave a torn clock behind.
until mkdir "$MOCK_CLOCK.lock" 2>/dev/null; do "$REAL_SLEEP" 0.01; done
echo $(($(cat "$MOCK_CLOCK") + n)) >"$MOCK_CLOCK.$$" && mv -f "$MOCK_CLOCK.$$" "$MOCK_CLOCK"
rmdir "$MOCK_CLOCK.lock"
MOCK

# mocactl: `sbx` only. The user is the HOME's .user; sandboxes are $MOCK_DIR/sb/<id> ("owner state"),
# their workspaces $MOCK_SRV/workspaces/sbx_default/<id>. MOCK_FAIL=<word> fails a call naming it.
cat >"$TMP/bin/mocactl-fake" <<'MOCK'
#!/usr/bin/env bash
set -uo pipefail
user="$(cat "$HOME/.user" 2>/dev/null || echo '?')"
printf 'mocactl user=%s url=%s xdg=%s %s\n' "$user" "${MOCACTL_SBX_URL:-}" "${XDG_STATE_HOME:-}${XDG_CONFIG_HOME:-}" "$*" >>"$MOCK_LOG"
[[ "$1" == sbx ]] || { echo "mock mocactl: not sbx: $*" >&2; exit 99; }
shift
if [[ "${MOCK_NO_SBX:-}" == 1 ]]; then echo 'usage: mocactl [command]'; exit 0; fi
[[ -z "${MOCK_FAIL:-}" || " $* " != *" $MOCK_FAIL "* ]] || { echo "sbx: mock failure on $MOCK_FAIL" >&2; exit 1; }
now() { cat "$MOCK_CLOCK"; }
ws() { printf '%s' "$MOCK_SRV/workspaces/sbx_default/$1"; }
new() {
  local n id
  n=$(($(cat "$MOCK_DIR/n" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$MOCK_DIR/n"
  id="$(printf 'sbx-%026x' "$n")"
  echo "$user ready" >"$MOCK_DIR/sb/$id"
  mkdir -p "$(ws "$id")"
  printf '%s' "$id"
}
mine() { # mine ID: refuse a sandbox that is not this user's, as the control plane does (404)
  [[ -f "$MOCK_DIR/sb/$1" && "$(cut -d' ' -f1 "$MOCK_DIR/sb/$1")" == "$user" ]] || { echo 'sbx: no such sandbox' >&2; exit 1; }
}
live() { mine "$1"; [[ "$(cut -d' ' -f2 "$MOCK_DIR/sb/$1")" == ready || "$cmd/${MOCK_MINT_DELETED:-}" == token/1 ]] || { echo 'sbx: sandbox was deleted' >&2; exit 1; }; }
bound() { sed -n 's/.*"id": *"\(sbx-[0-9a-f]*\)".*/\1/p' .sbx/sandbox.json 2>/dev/null; }
cmd="$1"; shift
id='' args=() CREATE_NAME=''
while (($#)); do
  case "$1" in
  --sandbox) id="$2"; shift 2 ;;
  --name) CREATE_NAME="$2"; shift 2 ;;
  --timeout | --template) shift 2 ;;
  --force | --apply) shift ;;
  --) shift; args+=("$@"); break ;;
  *) args+=("$1"); shift ;;
  esac
done
case "$cmd" in
credentials)
  # credentials add NAME --preset P (the PAT on stdin, never logged) / credentials delete NAME
  case "${args[0]:-}" in # bare `credentials` passes none, so the index must tolerate an empty list
  # .read keeps the bytes exactly as they arrived on stdin, and the delete below leaves it behind,
  # so a test can still see what the add was given after the run has revoked the credential.
  add) cat >"$MOCK_DIR/cred-${args[1]}"; cp "$MOCK_DIR/cred-${args[1]}" "$MOCK_DIR/cred-${args[1]}.read"
    echo "$user" >"$MOCK_DIR/cred-${args[1]}.owner"
    # MOCK_CRED_ADD_LOST=1: the server stored it, but the answer never arrives. The name the smoke
    # recorded before the call is the only trace, which is why cred_add records first.
    [[ "${MOCK_CRED_ADD_LOST:-}" != 1 ]] || { echo 'sbx: connection reset' >&2; exit 1; } ;;
  delete)
    [[ -f "$MOCK_DIR/cred-${args[1]}" ]] || { echo 'sbx: no such credential' >&2; exit 1; }
    rm -f "$MOCK_DIR/cred-${args[1]}"
    # MOCK_CRED_STALE=1: the proxy keeps serving the credential after its delete (a broken revocation).
    [[ "${MOCK_CRED_STALE:-}" != 1 ]] || : >"$MOCK_DIR/cred-stale-${args[1]}" ;;
  # `credentials [list] [--json]`: the names this user owns, in cmdCredentials' JSON shape. The
  # cleanup reads this to tell a credential that is not there from a delete that failed.
  list | --json | '')
    sep='' out='{"credentials":['
    for f in "$MOCK_DIR"/cred-*.owner; do
      [[ -e "$f" ]] || continue
      nm="$(basename "$f")" nm="${nm#cred-}" nm="${nm%.owner}"
      [[ -f "$MOCK_DIR/cred-$nm" && "$(cat "$f")" == "$user" ]] || continue
      out+="$sep{\"name\":\"$nm\",\"kind\":\"bearer\",\"consumer\":\"header\",\"hosts\":[\"api.github.com\"],\"endpoint\":null}"; sep=,
    done
    echo "$out]}" ;;
  *) echo "mock mocactl: unexpected: credentials ${args[*]}" >&2; exit 99 ;;
  esac ;;
--help) echo 'usage (the sandbox service, SBX0):'; echo '  mocactl sbx login ...' ;;
ls)
  if [[ " ${args[*]:-} " == *' --json '* ]]; then
    sep='' out='['
    for f in "$MOCK_DIR"/sb/*; do
      [[ -e "$f" ]] || continue
      read -r o st <"$f"
      [[ "$o" == "$user" ]] || continue
      nm="$(cat "$MOCK_DIR/names/$(basename "$f")" 2>/dev/null)"
      [[ "$st" == deleted ]] && st=terminated
      out+="$sep{\"id\":\"$(basename "$f")\",\"name\":\"$nm\",\"state\":\"$st\"}"; sep=,
    done
    echo "$out]"
  else
    for f in "$MOCK_DIR"/sb/*; do [[ -e "$f" ]] && echo "$(basename "$f") $(cat "$f")"; done
  fi ;;
create)
  nid="$(new)"
  mkdir -p "$MOCK_DIR/names"; printf '%s' "$CREATE_NAME" >"$MOCK_DIR/names/$nid"
  # MOCK_CREATE_LOST=1: the server made it, but the answer never arrives.
  [[ "${MOCK_CREATE_LOST:-}" != 1 ]] || { echo 'sbx: connection reset' >&2; exit 1; }
  echo "$nid" ;;
token) live "${args[0]}"; echo "tok.$user.${args[0]}.$(($(now) + ${MOCK_TTL:-900}))" ;;
env)
  live "${args[0]}"
  printf "export SBX_ADDR='exec.sbx.example:443'\nexport SBX_TLS='1'\nexport SBX_SANDBOX_ID='sbx_default'\n"
  printf "export SBX_WORKSPACE_KEY='%s'\nexport SBX_TOKEN_CMD='mocactl sbx token %s'\n" "${args[0]}" "${args[0]}" ;;
rm)
  mine "${args[0]}"
  # MOCK_RM_FAIL_ONCE=1: the first rm fails (the step's own); the cleanup's retry succeeds.
  if [[ "${MOCK_RM_FAIL_ONCE:-}" == 1 && ! -e "$MOCK_DIR/rm-failed" ]]; then : >"$MOCK_DIR/rm-failed"; echo 'sbx: mock rm failure' >&2; exit 1; fi
  echo "$user deleted" >"$MOCK_DIR/sb/${args[0]}"; echo "deleted ${args[0]}" >&2 ;;
run) id="${id:-$(bound)}"; live "$id"; cd "$(ws "$id")" && "${args[@]}" ;;
put) id="${id:-$(bound)}"; live "$id"; cat >"$(ws "$id")/${args[0]}" ;;
up)
  id="$(new)"
  git ls-files -z | xargs -0 -I{} cp {} "$(ws "$id")/"
  mkdir -p .sbx .claude
  printf '{"id": "%s", "controlPlaneUrl": "%s"}\n' "$id" "$MOCACTL_SBX_URL" >.sbx/sandbox.json
  echo '.sbx/' >>.git/info/exclude
  echo '{"mcpServers":{"sandbox":{"command":"mocactl","args":["sbx","mcp"]}}}' >.mcp.json
  echo '{"permissions":{"deny":["Bash"]}}' >.claude/settings.json
  echo "$id" ;;
pull) id="${id:-$(bound)}"; live "$id"; for f in "$(ws "$id")"/*.py; do cp "$f" .; done ;;
doctor) echo 'ok - agent config: Claude Code and OpenCode use the sandbox MCP server' ;;
mcp)
  id="$(bound)"; live "$id"
  mkdir -p "$HOME/.local/state/mocactl/sbx"
  echo '{"tool":"edit","ok":true}' >>"$HOME/.local/state/mocactl/sbx/$id.log"
  printf 'def add(a, b):\n    return a + b\n' >"$(ws "$id")/calc.py" ;;
*) echo "mock mocactl: unexpected: sbx $cmd" >&2; exit 99 ;;
esac
MOCK

# python3: the stub generation and grpc import succeed; smoke.sh's client is played here (a token
# is tok.<user>.<id>.<exp>; the relay's rules: exp + 30 s, exact workspace key); anything else runs
# on the real python3. MOCK_ALLOW_ANY=1 lets any token into any workspace (a broken relay).
cat >"$TMP/bin/python3" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1 $2" == '-c import grpc' ]]; then exit 0; fi
if [[ "$1 $2" == '-m grpc_tools.protoc' ]]; then
  for a in "$@"; do [[ "$a" != --python_out=* ]] || out="${a#*=}"; done
  mkdir -p "$out/sandbox/v1" && : >"$out/sandbox/v1/sandbox_pb2_grpc.py"
  exit 0
fi
[[ "$1" == */smoke_client.py ]] || exec "$REAL_PY" "$@"
mode="$4" tok="$(cat "$5")"
IFS=. read -r _ tuser tid exp <<<"$tok"
if [[ "$mode" == exp ]]; then echo "exp=$exp"; exit 0; fi
addr="$6" wrk="$7" wsk="$8" req="${11}" command="${13}"
printf 'client user=%s wsk=%s req_id=%s cmd=%s\n' "$tuser" "$wsk" "$req" "$command" >>"$MOCK_LOG"
t0="$(cat "$MOCK_CLOCK")"
if ((t0 > exp + 30)); then echo outcome=rpc; echo code=UNAUTHENTICATED
elif [[ "$wsk" != "$tid" && "${MOCK_ALLOW_ANY:-}" != 1 ]]; then echo outcome=rpc; echo code=PERMISSION_DENIED
else
  rc=0
  out="$(cd "$MOCK_SRV/workspaces/$wrk/$wsk" && sh -c "$command")" || rc=$?
  t1="$(cat "$MOCK_CLOCK")"
  if ((t1 > exp + 30)) && [[ "${MOCK_NO_CANCEL:-}" != 1 ]]; then echo $((exp + 30)) >"$MOCK_CLOCK"; echo outcome=rpc; echo code=DEADLINE_EXCEEDED
  else echo outcome=end; echo "exit_code=$rc"; echo timed_out=0; echo "stdout=$out"; fi
fi
echo "t_start=$t0"
echo "t_end=$(cat "$MOCK_CLOCK")"
MOCK

# ssh: the remote command must be smoke.sh's janitor invocation; it runs here, without the sudo,
# on the script piped to it.
cat >"$TMP/bin/ssh" <<'MOCK'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >>"$MOCK_LOG"
[[ "$1 $2 $3" == "-o BatchMode=yes kvm.example" ]] || { echo "mock ssh: unexpected: $*" >&2; exit 98; }
shift 3
[[ "$1 $2 $3 $4 $5" == 'sudo -n bash -s --' && $# -eq 12 ]] || { echo "mock ssh: unexpected remote command: $*" >&2; exit 98; }
shift 4
exec bash -s "$@"
MOCK
# The installed janitor: logs the settings it got; frees the deleted sandboxes' workspaces.
cat >"$TMP/host/libexec/sbx-janitor.sh" <<'MOCK'
#!/usr/bin/env bash
printf 'janitor age=%s url=%s env=%s srv=%s token_file=%s\n' "$SBX_JANITOR_AGE" "$SBX_API_URL" "$SBX_ENV_DIR" "$SBX_SRV" "$SBX_JANITOR_TOKEN_FILE" >>"$MOCK_LOG"
[[ "${MOCK_JANITOR_KEEPS:-}" != 1 ]] || { echo '{"janitor":"summary","removed":0}'; exit 0; }
for f in "$MOCK_DIR"/sb/*; do
  [[ "$(cut -d' ' -f2 "$f")" != deleted ]] || rm -rf "$SBX_SRV/workspaces/sbx_default/$(basename "$f")"
done
echo '{"janitor":"summary","removed":1}'
MOCK
printf 'SBX_API_URL=https://api.sbx.example\nSBX_JANITOR_AGE=3630\n' >"$TMP/host/etc/janitor.env"
echo 'janitor-secret-token-0123456789abcdef' >"$TMP/host/etc/janitor.token"

# curl, git and gh for step 7. Their state is $MOCK_DIR/cred-* (stored credentials) and remote-branches.
# A curl run inside a sandbox (its cwd is under MOCK_SRV) sends the placeholder, and the "proxy" puts
# the credential on: 200 and a login while smoke-gh exists (MOCK_CRED_STALE=1: also after its delete).
cat >"$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$MOCK_LOG"
method=GET url='' kstdin='' write=''
while (($#)); do
  case "$1" in
  -X) method="$2"; shift 2 ;;
  -K) kstdin="$(cat)"; shift 2 ;;
  -w) write="$2"; shift 2 ;;
  -H | -o | -d) shift 2 ;;
  https://*) url="$1"; shift ;;
  *) shift ;;
  esac
done
# A credential is its owner's: the sandbox's owner is the sb file's first word.
sbowner="$(cut -d' ' -f1 "$MOCK_DIR/sb/$(basename "$PWD")" 2>/dev/null)"
# The names carry the run id, so the fakes match on the suffix the preset owns ('gh', 'gh-mcp')
# rather than on a fixed name.
have() {
  local f
  for f in "$MOCK_DIR"/cred-*-"$1"; do
    [[ -f "$f" && "$(cat "$f.owner" 2>/dev/null)" == "$sbowner" ]] && return 0
  done
  for f in "$MOCK_DIR"/cred-stale-*-"$1"; do
    [[ "${MOCK_CRED_STALE:-}" == 1 && -f "$f" ]] && return 0
  done
  return 1
}
if [[ -n "$kstdin" ]]; then # the smoke host, as the PAT's owner: the whole config line, no newline in the PAT
  [[ "$kstdin" == 'user = "x-access-token:ghp_SECRETPATVALUE0123456789"' ]] || { echo '{"message":"Bad credentials"}'; exit 0; }
  if [[ "$method" == DELETE ]]; then
    # MOCK_BRANCH_DELETE_CODE: the ambiguous answers GitHub really sends for a ref delete. Both 422
    # and 404 can mean "Reference does not exist" *or* something else (the default branch, spam, a
    # repo the PAT can no longer reach), so the smoke must confirm rather than believe them.
    if [[ -n "${MOCK_BRANCH_DELETE_CODE:-}" ]]; then
      # MOCK_BRANCH_GONE=1: the ref really is absent (deleted by hand, or by a concurrent run), so
      # the ambiguous code was honest. Without it the ref is still there and the code was a lie.
      [[ "${MOCK_BRANCH_GONE:-}" != 1 ]] ||
        { grep -vx "${url##*/heads/}" "$MOCK_DIR/remote-branches" >"$MOCK_DIR/rb.new" 2>/dev/null; mv -f "$MOCK_DIR/rb.new" "$MOCK_DIR/remote-branches"; }
      printf '%s' "$MOCK_BRANCH_DELETE_CODE"; exit 0
    fi
    if grep -qx "${url##*/heads/}" "$MOCK_DIR/remote-branches" 2>/dev/null; then
      grep -vx "${url##*/heads/}" "$MOCK_DIR/remote-branches" >"$MOCK_DIR/rb.new"; mv "$MOCK_DIR/rb.new" "$MOCK_DIR/remote-branches"
      printf '%s' 204
    else printf '%s' 404; fi
    exit 0
  fi
  case "$url" in
  # The confirming probes: the repo is still reachable with the PAT, and the ref is really absent.
  # MOCK_REPO_GONE=1 is the revoked-PAT / inaccessible-repo case a bare 404 cannot be told from.
  */git/refs/heads/*)
    [[ "${MOCK_REPO_GONE:-}" != 1 ]] || { printf '%s' 404; exit 0; }
    grep -qx "${url##*/heads/}" "$MOCK_DIR/remote-branches" 2>/dev/null && printf '%s' 200 || printf '%s' 404
    exit 0 ;;
  */repos/*)
    [[ "${MOCK_REPO_GONE:-}" != 1 ]] || { printf '%s' 404; exit 0; }
    printf '%s' 200; exit 0 ;;
  esac
  echo '{"login":"octo"}'; exit 0
fi
if [[ "$PWD" != "$MOCK_SRV"/* ]]; then # the smoke host with the placeholder
  [[ "${MOCK_PLACEHOLDER_OK:-}" == 1 ]] && printf '%s' 200 || printf '%s' 401
  exit 0
fi
case "$url" in
https://api.githubcopilot.com/*) have gh-mcp && echo '{"result":{"serverInfo":{"name":"github-mcp-server"}}}' || echo '{"error":"unauthorized"}' ;;
*) have gh && printf '%s' 200 || printf '%s' 401 ;;
esac
MOCK
cat >"$TMP/bin/gh" <<'MOCK'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >>"$MOCK_LOG"
# The credential name carries the run id, so match the preset's suffix, not a fixed name.
gh_cred() { local f; for f in "$MOCK_DIR"/cred-*-gh "$MOCK_DIR"/cred-stale-*-gh; do
  [[ -f "$f" ]] && { [[ "$f" != *stale* || "${MOCK_CRED_STALE:-}" == 1 ]] && return 0; }; done; return 1; }
gh_cred || { echo 'HTTP 401' >&2; exit 1; }
if [[ "${MOCK_GH_WRONG:-}" == 1 ]]; then echo mallory; else echo octo; fi
MOCK
# git: only the github.com clone, the empty commit and pushes to origin are played; all else is real git.
cat >"$TMP/bin/git" <<'MOCK'
#!/usr/bin/env bash
case " $* " in
*' clone '*https://github.com/*) printf 'git %s\n' "$*" >>"$MOCK_LOG"; for last; do :; done; mkdir -p "$last"; exit 0 ;;
*' commit '*--allow-empty*) printf 'git %s\n' "$*" >>"$MOCK_LOG"; exit 0 ;;
*' push '*' origin '*)
  printf 'git %s\n' "$*" >>"$MOCK_LOG"
  ls "$MOCK_DIR"/cred-*-gh >/dev/null 2>&1 || { echo 'fatal: Authentication failed' >&2; exit 128; }
  for last; do :; done
  case " $* " in
  # MOCK_SBX_DELBRANCH_FAIL=1: the in-sandbox branch delete fails, leaving the branch to the EXIT
  # trap's drop_branch. That is the only path on which drop_branch runs: on a clean step 7 the
  # sandbox deletes its own branch and clears BRANCH, so the trap has nothing to do.
  *' --delete '*) [[ "${MOCK_SBX_DELBRANCH_FAIL:-}" != 1 ]] || { echo 'fatal: unable to access' >&2; exit 128; }
    grep -vx "$last" "$MOCK_DIR/remote-branches" >"$MOCK_DIR/rb.new"; mv "$MOCK_DIR/rb.new" "$MOCK_DIR/remote-branches" ;;
  *) echo "${last#HEAD:refs/heads/}" >>"$MOCK_DIR/remote-branches" ;;
  esac
  exit 0 ;;
esac
exec "$REAL_GIT" "$@"
MOCK

# claude: headless, and only with the project's MCP config; it works through `mocactl sbx mcp`, so
# through the mocactl smoke.sh put first on PATH. MOCK_AGENT_LOCAL=1 also edits the laptop's tree.
cat >"$TMP/bin/claude" <<'MOCK'
#!/usr/bin/env bash
printf 'claude %s\n' "$*" >>"$MOCK_LOG"
[[ "$1" == -p && " $* " == *' --mcp-config .mcp.json --strict-mcp-config '* ]] || { echo "mock claude: unexpected: $*" >&2; exit 9; }
[[ "${MOCK_AGENT_LOCAL:-}" != 1 ]] || echo '# local' >>calc.py
[[ "${MOCK_AGENT_HANG:-}" != 1 ]] || exec "$REAL_SLEEP" 30
mocactl sbx mcp </dev/null
echo 'Fixed add() and ran the tests.'
MOCK
# Shims that must never run: the SKIP case puts them first on PATH.
for t in mocactl git python3 ssh claude opencode node curl sh; do
  printf '#!/bin/sh\necho "%s $*" >>"%s"\nexit 97\n' "$t" "$TMP/forbidden.log" >"$TMP/failbin/$t"
done
chmod +x "$TMP/bin/"* "$TMP/failbin/"* "$TMP/host/libexec/sbx-janitor.sh"
BASEPATH="$PATH"
export PATH="$TMP/bin:$BASEPATH"

reset_state() {
  # cred-* takes the .read and .owner side files with it.
  rm -rf "$MOCK_DIR"/cred-* "$MOCK_DIR/remote-branches" "$MOCK_DIR/sb" "$MOCK_DIR/n" "$MOCK_DIR/names" "$MOCK_DIR/rm-failed" "$MOCK_SRV/workspaces/sbx_default" "$TMP"/home-?/.local
  mkdir -p "$MOCK_DIR/sb" "$MOCK_SRV/workspaces/sbx_default"
  # A sandbox of user A's that this run did not create: it must outlive every run.
  echo 'a ready' >"$MOCK_DIR/sb/sbx-ffffffffffffffffffffffffff"
  "$REAL_DATE" +%s >"$MOCK_CLOCK"
  : >"$MOCK_LOG"
}
PAT='ghp_SECRETPATVALUE0123456789'
printf '%s\n' "$PAT" >"$TMP/pat" # with its newline: the smoke must strip it
# smoke [-u NAME | NAME=VALUE]... [-- ARG...]: smoke.sh with the inputs of a full run, changed so.
smoke() {
  (
    export SBX_LIVE_SMOKE=1 SBX_API_URL=https://api.sbx.example \
      SBX_SMOKE_HOME_A="$TMP/home-a" SBX_SMOKE_HOME_B="$TMP/home-b" \
      MOCACTL="$TMP/bin/mocactl-fake" SBX_SMOKE_AGENTS=claude,opencode SBX_SMOKE_HOST=kvm.example \
      SBX_SMOKE_HOST_ENV_DIR="$TMP/host/etc" SBX_SMOKE_HOST_SRV="$MOCK_SRV" SBX_SMOKE_HOST_LIBEXEC="$TMP/host/libexec"
    while (($#)); do
      case "$1" in
      -u) unset "$2"; shift 2 ;;
      --) shift; break ;;
      *) export "${1?}"; shift ;;
      esac
    done
    exec bash "$SMOKE" "$@"
  )
}
has() { grep -qxF -- "$1" "$TMP/out" || fail "no line '$1'"; }
hasnt() { ! grep -qF -- "$1" "$TMP/out" || fail "a line has '$1'"; }
created() { sed -n 's/^mocactl user=\(.\) .* sbx create .*/\1/p; s/^mocactl user=\(.\) .* sbx up .*/\1/p' "$MOCK_LOG" | wc -l | tr -d ' '; }
# Every sandbox the run created is deleted by its owner, and the one it did not is never named in an rm.
all_cleaned() {
  local f id owner st
  for f in "$MOCK_DIR"/sb/*; do
    id="$(basename "$f")" owner="$(cut -d' ' -f1 "$f")" st="$(cut -d' ' -f2 "$f")"
    [[ "$id" == sbx-ffffffffffffffffffffffffff ]] && continue
    [[ "$st" == deleted ]] || fail "$id ($owner) was left behind"
    grep -q "^mocactl user=$owner .* sbx rm --force $id\$" "$MOCK_LOG" || fail "$id was not deleted by its owner $owner"
  done
  [[ "$(cat "$MOCK_DIR/sb/sbx-ffffffffffffffffffffffffff")" == 'a ready' ]] || fail 'the sandbox the run did not create was deleted'
  ! grep -q 'rm .*sbx-ffffffffffffffffffffffffff' "$MOCK_LOG" || fail 'an rm named the sandbox the run did not create'
}

# 1. Without SBX_LIVE_SMOKE=1: a SKIP line, exit 0, and nothing runs (every tool a failing shim).
for v in '' 0 yes; do
  rm -f "$TMP/forbidden.log"
  PATH="$TMP/failbin:$BASEPATH" SBX_LIVE_SMOKE="$v" SBX_API_URL=https://api.sbx.example MOCACTL="$TMP/failbin/mocactl" \
    "$BASH" "$SMOKE" >"$TMP/out" 2>&1 || fail "SBX_LIVE_SMOKE='$v': exited $?"
  has 'SKIP: skipped (SBX_LIVE_SMOKE not set); set SBX_LIVE_SMOKE=1 to run the SBX0 live smoke against a deployed service'
  [[ "$(wc -l <"$TMP/out" | tr -d ' ')" == 1 ]] || fail "SBX_LIVE_SMOKE='$v': more than the SKIP line"
  [[ ! -s "$TMP/forbidden.log" ]] || fail "SBX_LIVE_SMOKE='$v' ran: $(cat "$TMP/forbidden.log")"
done
pass 'without SBX_LIVE_SMOKE=1 it prints one SKIP line, exits 0 and runs nothing'

# 2. Settings: each refused with exit 2 and a reason, before any sandbox call.
reject() { # reject WHAT EXPECT ENV...
  local what="$1" expect="$2" rc=0
  shift 2
  reset_state
  smoke "$@" >"$TMP/out" 2>&1 || rc=$?
  [[ "$rc" == 2 ]] || fail "$what: exit $rc, not 2"
  grep -qF -- "$expect" "$TMP/out" || fail "$what: no '$expect'"
  ! grep -q ' sbx \(create\|up\|token\|env\|rm\|run\|put\)' "$MOCK_LOG" || fail "$what: a sandbox call was made"
  [[ "$(ls "$MOCK_DIR/sb")" == sbx-ffffffffffffffffffffffffff ]] || fail "$what: a sandbox was created"
}
reject 'no SBX_API_URL' 'set SBX_API_URL' -u SBX_API_URL
reject 'an http URL' 'SBX_API_URL must be https://<api host>' SBX_API_URL=http://api.sbx.example
reject 'a URL with a path' 'SBX_API_URL must be https://<api host>' SBX_API_URL=https://api.sbx.example/x
reject 'no home B' 'set SBX_SMOKE_HOME_B to a HOME already logged in' -u SBX_SMOKE_HOME_B
reject 'a home that is no directory' "SBX_SMOKE_HOME_A='$TMP/nope' is not a directory" SBX_SMOKE_HOME_A="$TMP/nope"
reject 'one home for both users' 'are the same directory' SBX_SMOKE_HOME_B="$TMP/home-a/."
reject 'a step out of range' "SBX_SMOKE_STEPS: '8' is not a step" SBX_SMOKE_STEPS=1,8
reject 'a step that is no number' "SBX_SMOKE_STEPS: 'x' is not a step" SBX_SMOKE_STEPS=x
reject 'empty steps' 'SBX_SMOKE_STEPS is empty' SBX_SMOKE_STEPS=
reject 'an unknown agent' "SBX_SMOKE_AGENTS: 'cursor' is not claude or opencode" SBX_SMOKE_AGENTS=claude,cursor
reject 'no agent, with step 5' 'SBX_SMOKE_AGENTS is empty' SBX_SMOKE_AGENTS=
reject 'a bad template' "SBX_SMOKE_TEMPLATE='Py 3' is not a template id" 'SBX_SMOKE_TEMPLATE=Py 3'
reject 'a bad ssh target' "SBX_SMOKE_HOST='-oProxyCommand=x' must be an ssh target" SBX_SMOKE_HOST=-oProxyCommand=x
reject 'a relative host path' 'the host paths must be plain absolute paths' SBX_SMOKE_HOST_SRV=srv
reject 'a bad janitor age' "SBX_SMOKE_JANITOR_AGE='03600' must be whole seconds" SBX_SMOKE_JANITOR_AGE=03600
reject 'a zero janitor age' "SBX_SMOKE_JANITOR_AGE='0' must be whole seconds" SBX_SMOKE_JANITOR_AGE=0
reject 'an argument' "takes no arguments (got '--steps')" -- --steps
reject 'MOCACTL that is no file' "MOCACTL='$TMP/nope' is not a file" MOCACTL="$TMP/nope"
reject 'a mocactl without sbx' 'has no `mocactl sbx`' MOCK_NO_SBX=1
reject 'both homes logged in as one user' 'are both logged in as github:a' SBX_SMOKE_HOME_B="$TMP/home-same"
pass 'refuses bad settings, an argument, a missing or sbx-less mocactl, one user for two, with exit 2 and no sandbox call'

# 3. A full run: every step ok (opencode is not on PATH: a SKIP), in order, each sandbox deleted.
reset_state
smoke >"$TMP/out" 2>&1 || fail "a full run exited $?"
has 'ok 1 - round trip: sbx up, run, put, pull --apply on a sample repository'
has "ok 2 - two users: B is refused A's sandbox (404, PERMISSION_DENIED); one req_id from both gets each its own result"
has 'ok 3 - a command silent for 5 minutes completes'
has 'ok 4 - delete: the mint is refused at once; the kept token is cancelled at exp + leeway, then refused'
has 'ok 5 - claude fixes the failing test through mocactl sbx mcp; the tree is unchanged until pull --apply'
has 'ok 5 - opencode fixes the failing test through mocactl sbx mcp; the tree is unchanged until pull --apply # SKIP opencode not on PATH'
has "ok 6 - the janitor frees a deleted sandbox's directory"
has 'ok 7 - egress credentials: the PAT works from the sandbox without being in it; the placeholder is inert; delete revokes # SKIP SBX_SMOKE_GITHUB_TOKEN_FILE and SBX_SMOKE_GITHUB_REPO not both set'
has '# 6 ok, 0 not ok, 2 skipped'
[[ "$(grep -o '^ok [0-9]' "$TMP/out" | tr -d '\n')" == 'ok 1ok 2ok 3ok 4ok 5ok 5ok 6ok 7' ]] || fail 'the steps did not run in order'
! grep -q '^not ok' "$TMP/out" || fail 'a step is not ok'
all_cleaned
[[ "$(created)" == 6 ]] || fail "created $(created) sandboxes, not 6 (steps 1, 2 x2, 3, 4, 5)"
pass 'a full run: ok 1-6 in order, step 7 a SKIP without its inputs, an agent not installed is a SKIP, and every sandbox it made is deleted by its owner'

# What the full run sent: every mocactl as one of the two homes, with the URL, no XDG overrides.
! grep '^mocactl ' "$MOCK_LOG" | grep -qv "^mocactl user=[ab] url=https://api.sbx.example xdg= " || fail 'a mocactl ran without the HOME, URL or XDG settings'
grep -qx 'mocactl user=a url=https://api.sbx.example xdg= sbx --help' "$MOCK_LOG" || fail 'no sbx --help check'
[[ "$(grep '^mocactl ' "$MOCK_LOG" | head -n 1)" == *' sbx --help' ]] || fail 'sbx --help was not the first call'
grep -q '^mocactl user=b .* sbx token sbx-' "$MOCK_LOG" || fail "no mint by B for A's sandbox"
grep -q '^mocactl user=b .* sbx env sbx-' "$MOCK_LOG" || fail "no env by B for A's sandbox"
# Step 2's denial: B's token with A's workspace key.
grep -q '^client user=b wsk=sbx-0*2 req_id=[0-9]* cmd=true$' "$MOCK_LOG" || fail "no Exec with B's token on A's workspace key"
# Step 2's same req_id: both users, one id, one command.
mapfile -t same < <(grep "^client .* cmd=sleep 3; cat .smoke-marker$" "$MOCK_LOG")
[[ "${#same[@]}" == 2 ]] || fail "not two same-command Execs: ${#same[@]}"
[[ "${same[0]#*req_id=}" == "${same[1]#*req_id=}" ]] || fail "the two Execs had different req_ids"
[[ "${same[0]} ${same[1]}" == *'client user=a '*'client user=b '* || "${same[0]} ${same[1]}" == *'client user=b '*'client user=a '* ]] || fail 'the same req_id was not sent by both users'
# Step 3: the silent command through sbx run, with a timeout above 300 s.
grep -q "^mocactl user=a .* sbx run --sandbox sbx-[0-9a-f]* --timeout 400 -- sh -c sleep 300; echo survived$" "$MOCK_LOG" || fail 'no 5-minute silent sbx run'
# Step 4: the mint right after the rm, then a command started before exp.
grep -A1 '^mocactl user=a .* sbx rm --force sbx-0*5$' "$MOCK_LOG" | grep -q ' sbx token sbx-0*5$' || fail 'no mint right after the delete'
grep -q '^client user=a wsk=sbx-[0-9a-f]* req_id=[0-9]* cmd=sleep 120; echo not-cancelled$' "$MOCK_LOG" || fail 'no command started before exp'
# Step 5: claude headless with the project MCP config, the agent's mocactl as user A.
grep -qx "claude -p The test suite fails (python3 -m unittest). Fix it with a minimal change and run the tests. --mcp-config .mcp.json --strict-mcp-config --allowedTools mcp__sandbox__\*" "$MOCK_LOG" || fail 'claude not run headless with --mcp-config .mcp.json --strict-mcp-config and only the sandbox MCP tools allowed'
grep -q '^mocactl user=a url=https://api.sbx.example xdg= sbx mcp$' "$MOCK_LOG" || fail "the agent's mocactl sbx mcp did not run as user A"
# Step 6: the janitor with the env file sourced, the host's own wait kept, and the host's paths.
grep -q '^ssh -o BatchMode=yes kvm.example sudo -n bash -s -- sbx_default sbx-[0-9a-f]* ' "$MOCK_LOG" || fail 'no ssh for the janitor'
grep -qx "janitor age=3630 url=https://api.sbx.example env=$TMP/host/etc srv=$MOCK_SRV token_file=$TMP/host/etc/janitor.token" "$MOCK_LOG" || fail "the janitor did not run with janitor.env sourced and the host's own SBX_JANITOR_AGE"
pass "the calls: B's mint/env/Exec on A's sandbox, one req_id from both users, a 400 s run, the pre-exp cancel, headless claude, the janitor"

# No token, API token or janitor token printed.
for secret in tok. api-secret janitor-secret; do hasnt "$secret"; done
pass 'never prints a sandbox, login or janitor token'

# 4. Step selection.
reset_state
smoke SBX_SMOKE_STEPS=1,6 -u SBX_SMOKE_HOST >"$TMP/out" 2>&1 || fail "steps 1,6 exited $?"
has 'ok 1 - round trip: sbx up, run, put, pull --apply on a sample repository'
for n in 2 3 4 5 7; do grep -q "^ok $n - .* # SKIP not in SBX_SMOKE_STEPS\$" "$TMP/out" || fail "step $n not skipped"; done
has "ok 6 - the janitor frees a deleted sandbox's directory # SKIP SBX_SMOKE_HOST not set"
! grep -q ' sbx --sandbox\| --timeout 400\|^client\|^claude\|^ssh' "$MOCK_LOG" || fail 'a skipped step ran'
[[ "$(created)" == 1 ]] || fail "created $(created) sandboxes for step 1 alone"
all_cleaned
pass 'SBX_SMOKE_STEPS runs only the steps named; the others, and step 6 with no host, are SKIPs'

# Step 6 alone deletes a sandbox of its own and frees it.
reset_state
smoke SBX_SMOKE_STEPS=6 SBX_SMOKE_JANITOR_AGE=4000 >"$TMP/out" 2>&1 || fail "step 6 alone exited $?"
has "ok 6 - the janitor frees a deleted sandbox's directory"
grep -q '^janitor age=4000 ' "$MOCK_LOG" || fail 'a longer SBX_SMOKE_JANITOR_AGE was not the janitor wait'
all_cleaned
pass "step 6 alone makes, deletes and frees a sandbox of its own; a wait longer than the host's is used"

# A wait shorter than the host's would free other users' workspaces a valid token still reaches.
reset_state
smoke SBX_SMOKE_STEPS=6 SBX_SMOKE_JANITOR_AGE=930 >"$TMP/out" 2>&1 && fail "a janitor wait below the host's own was accepted"
grep -q "^not ok 6 - .*SBX_SMOKE_JANITOR_AGE=930 is below kvm.example's own wait (3630 s)" "$TMP/out" || fail "no refusal of a wait below the host's"
! grep -q '^janitor age=' "$MOCK_LOG" || fail 'the janitor ran with a wait below the host'"'"'s'
all_cleaned
pass "refuses a janitor wait below the host's own, and never runs the janitor with it"

# 5. Failures: `not ok N - ...: why`, the other steps still run, exit 1, and the cleanup still
# deletes every sandbox the run made (as its owner) and nothing else.
expect_fail() { # expect_fail N WHY ENV...
  local n="$1" why="$2" rc=0
  shift 2
  reset_state
  smoke "$@" >"$TMP/out" 2>&1 || rc=$?
  [[ "$rc" == 1 ]] || fail "$why: exit $rc, not 1"
  grep -q "^not ok $n - .*: .*$why" "$TMP/out" || fail "no 'not ok $n - ...: ...$why'"
  grep -q '^# logs kept in ' "$TMP/out" || fail "$why: the logs were not kept"
  all_cleaned
}
expect_fail 2 'not PERMISSION_DENIED' SBX_SMOKE_STEPS=1,2,3 MOCK_ALLOW_ANY=1
has 'ok 1 - round trip: sbx up, run, put, pull --apply on a sample repository'
has 'ok 3 - a command silent for 5 minutes completes'
grep -q "^# cleanup: deleted sbx-[0-9a-f]* (user A)$" "$TMP/out" || fail "the trap did not delete A's sandbox from the failed step"
grep -q "^# cleanup: deleted sbx-[0-9a-f]* (user B)$" "$TMP/out" || fail "the trap did not delete B's sandbox as B"
pass 'a failed step is `not ok` with its reason, later steps still run, exit 1, and the trap deletes its sandboxes as their owners'

expect_fail 5 'the local tree changed during the claude run' SBX_SMOKE_STEPS=5 SBX_SMOKE_AGENTS=claude MOCK_AGENT_LOCAL=1
expect_fail 1 'cannot create\|sbx up: sbx: mock failure on up' SBX_SMOKE_STEPS=1 MOCK_FAIL=up
expect_fail 3 'exit 1' SBX_SMOKE_STEPS=3 MOCK_FAIL=survived
expect_fail 4 'not refused as deleted' SBX_SMOKE_STEPS=4 MOCK_MINT_DELETED=1
expect_fail 4 'not DEADLINE_EXCEEDED' SBX_SMOKE_STEPS=4 MOCK_NO_CANCEL=1
expect_fail 6 'is still there after the run' SBX_SMOKE_STEPS=6 MOCK_JANITOR_KEEPS=1
pass 'an agent that edits the laptop, a failed up, a silent run cut, a mint after delete, no cancel at exp, a janitor that keeps: each `not ok`, exit 1, cleaned up'

# 6. A TERM during the agent run still deletes what the run created.
reset_state
smoke SBX_SMOKE_STEPS=1,5 SBX_SMOKE_AGENTS=claude MOCK_AGENT_HANG=1 >"$TMP/out" 2>&1 &
pid=$!
for _ in $(seq 100); do grep -q '^claude ' "$MOCK_LOG" && break; "$REAL_SLEEP" 0.1; done
grep -q '^claude ' "$MOCK_LOG" || fail 'the agent never started'
pkill -TERM -P "$pid" -f "$SMOKE" || kill -TERM "$pid" # smoke() runs smoke.sh in a subshell of the job
rc=0
wait "$pid" || rc=$?
[[ "$rc" == 143 ]] || fail "a TERM exited $rc, not 143"
all_cleaned
[[ "$(created)" == 2 ]] || fail "created $(created) sandboxes, not 2"
grep -q '^# cleanup: deleted sbx-[0-9a-f]* (user A)$' "$TMP/out" || fail 'the trap did not report the deletion'
! pgrep -f "$TMP/bin/sleep 900" >/dev/null || fail 'the agent watchdog was left running'
pass 'a TERM during the agent run exits 143, stops the watchdog, and the trap deletes the sandbox it was using'

# 7. A TERM during a long wait (step 4's sleep until near exp) is acted on at once, not after it.
reset_state
smoke SBX_SMOKE_STEPS=3 MOCK_REAL_SLEEP_300=1 >"$TMP/out" 2>&1 &
pid=$!
for _ in $(seq 100); do grep -q 'sbx run --sandbox .* sleep 300' "$MOCK_LOG" && break; "$REAL_SLEEP" 0.1; done
grep -q 'sbx run --sandbox .* sleep 300' "$MOCK_LOG" || fail 'the silent run never started'
t0="$("$REAL_DATE" +%s)"
pkill -TERM -P "$pid" -f "$SMOKE" || kill -TERM "$pid"
rc=0
wait "$pid" || rc=$?
(($("$REAL_DATE" +%s) - t0 < 20)) || fail 'a TERM waited for the 5-minute command to end'
[[ "$rc" == 143 ]] || fail "a TERM exited $rc, not 143"
all_cleaned
pass 'a TERM during a 5-minute command exits at once, and the trap deletes its sandbox'

# 8. A create the server made but whose answer was lost is found by its run-named prefix and deleted.
reset_state
smoke SBX_SMOKE_STEPS=3 MOCK_CREATE_LOST=1 >"$TMP/out" 2>&1 && fail 'a lost create answer passed'
all_cleaned
grep -q '^# cleanup: deleted sbx-[0-9a-f]* (user A)$' "$TMP/out" || fail 'the stray sandbox was not deleted by name'
pass 'a sandbox whose create answer was lost is found by its run prefix and deleted'

# 9. A step whose own sbx rm fails is `not ok`, though the trap's retry then deletes it.
reset_state
smoke SBX_SMOKE_STEPS=3 MOCK_RM_FAIL_ONCE=1 >"$TMP/out" 2>&1 && fail 'a failed release passed'
grep -q '^not ok 3 - .*sbx rm sbx-[0-9a-f]* (user A): sbx: mock rm failure' "$TMP/out" || fail 'a failed release is not reported on its step'
all_cleaned
pass "a step whose own sbx rm fails is not ok, and the trap still deletes the sandbox"

# 10. Step 7, egress credentials: opt-in; user A only unless asked for B.
# The PAT never reaches argv (the mocactl and curl logs) nor any output line, in any of these runs.
# kept_logs prints the directory a failed run left behind, from the one place that names it
# (smoke.sh's cleanup: `# logs kept in DIR`). A run that passed removes it and prints no such line.
kept_logs() { sed -n 's/^# logs kept in //p' "$TMP/out"; }
nopat() {
  hasnt "$PAT"
  ! grep -qF -- "$PAT" "$MOCK_LOG" || fail 'the PAT is in a logged argv'
  ! grep -qF -- "${PAT#ghp_}" "$MOCK_LOG" "$TMP/out" || fail 'part of the PAT is in the log or the output'
  # The command output of a failed run is kept for the operator to read, so it is a place the PAT
  # can leak to that outlives the run. Checked per directory named, not through a variable nothing
  # sets: an unset one made this assertion a no-op for the whole of SBX0.2b.
  local d
  while read -r d; do
    [[ -d "$d" ]] || fail "smoke.sh said it kept logs in '$d', which is not a directory"
    ! grep -rqF -- "$PAT" "$d" || fail "the PAT is in the kept logs ($d)"
    ! grep -rqF -- "${PAT#ghp_}" "$d" || fail "part of the PAT is in the kept logs ($d)"
  done < <(kept_logs)
}
# nopat is only as strong as the files it reaches, so pin that it reaches them: a PAT planted in a
# kept log must make it fail. Without this, a kept-logs path that stops resolving goes unnoticed.
nopat_sees_kept_logs() {
  local d
  d="$(kept_logs | head -n 1)"
  [[ -n "$d" && -d "$d" ]] || fail 'the failing run kept no logs: nopat has no kept logs to check'
  printf '%s\n' "$PAT" >"$d/canary.log"
  if (nopat) 2>/dev/null; then
    rm -f "$d/canary.log"
    fail 'nopat passed with the PAT planted in the kept logs: the kept-logs check is a no-op'
  fi
  rm -f "$d/canary.log"
  nopat
}
credrun() { smoke SBX_SMOKE_STEPS=7 -u SBX_SMOKE_HOME_B SBX_SMOKE_GITHUB_TOKEN_FILE="$TMP/pat" SBX_SMOKE_GITHUB_REPO=octo/repo "$@"; }
# The credentials still stored: a cred-NAME file without its .read/.owner side files.
# cred-stale-* is the proxy's copy of a revoked credential, not a stored one, so it does not count.
live_creds() {
  local f n=0
  for f in "$MOCK_DIR"/cred-*; do
    [[ -f "$f" ]] || continue
    f="$(basename "$f")"
    case "$f" in cred-stale-* | *.*) continue ;; esac
    n=$((n + 1))
  done
  printf '%s\n' "$n"
}

# Without its inputs: a SKIP, and nothing else is needed (no home B).
reset_state
smoke SBX_SMOKE_STEPS=7 -u SBX_SMOKE_HOME_B >"$TMP/out" 2>&1 || fail "step 7 without inputs exited $?"
grep -q '^ok 7 - .* # SKIP SBX_SMOKE_GITHUB_TOKEN_FILE and SBX_SMOKE_GITHUB_REPO not both set$' "$TMP/out" || fail 'no SKIP for step 7 without inputs'
[[ "$(created)" == 0 ]] || fail 'step 7 without inputs created a sandbox'
! grep -q 'credentials' "$MOCK_LOG" || fail 'step 7 without inputs touched credentials'
pass 'step 7 without its inputs is a SKIP that needs no second user'

# The default run keeps requiring HOME_B (steps 1-6 need it).
reject 'steps 1-6 without home B, with step 7 inputs' 'set SBX_SMOKE_HOME_B to a HOME already logged in' -u SBX_SMOKE_HOME_B SBX_SMOKE_GITHUB_TOKEN_FILE="$TMP/pat" SBX_SMOKE_GITHUB_REPO=octo/repo
reject 'a bad repo' "SBX_SMOKE_GITHUB_REPO='octo' must be OWNER/REPO" SBX_SMOKE_STEPS=7 SBX_SMOKE_GITHUB_TOKEN_FILE="$TMP/pat" SBX_SMOKE_GITHUB_REPO=octo
reject 'a missing token file' 'SBX_SMOKE_GITHUB_TOKEN_FILE is not a readable, non-empty file' SBX_SMOKE_STEPS=7 SBX_SMOKE_GITHUB_TOKEN_FILE="$TMP/none" SBX_SMOKE_GITHUB_REPO=octo/repo
pass 'refuses a missing HOME_B for steps 1-6, a bad repository and a missing token file'

# A full single-user run.
reset_state
credrun >"$TMP/out" 2>&1 || fail "step 7 exited $?"
has '# step 7: second-user check skipped (no second user)'
! grep -q "ok 7 - B's sandbox" "$TMP/out" || fail 'the second-user sub-step printed its own ok line'
has 'ok 7 - egress credentials: the PAT works from the sandbox without being in it; the placeholder is inert; delete revokes'
has '# 1 ok, 0 not ok, 6 skipped'
all_cleaned
[[ "$(created)" == 1 ]] || fail "step 7 created $(created) sandboxes, not 1"
grep -qE '^mocactl user=a url=https://api\.sbx\.example xdg= sbx credentials add smoke-[0-9]+-[0-9]+-gh --preset github$' "$MOCK_LOG" || fail 'no credentials add with the github preset as A'
grep -qE '^mocactl user=a url=https://api\.sbx\.example xdg= sbx credentials delete smoke-[0-9]+-[0-9]+-gh$' "$MOCK_LOG" || fail 'no credentials delete as A'
! grep -q 'user=b' "$MOCK_LOG" || fail 'user B was used'
grep -q 'git clone -q https://github.com/octo/repo ' "$MOCK_LOG" || fail 'no clone'
grep -q 'git push -q origin HEAD:refs/heads/sbx-smoke-' "$MOCK_LOG" || fail 'no push of the branch'
grep -qx 'gh api user --jq .login' "$MOCK_LOG" || fail 'no gh api user'
[[ ! -s "$MOCK_DIR/remote-branches" ]] || fail "the remote branch was left: $(cat "$MOCK_DIR/remote-branches")"
[[ "$(live_creds)" == 0 ]] || fail 'the credential was left'
# The wait: TTL 60 + 5 s on the fake clock, between the delete and the check.
grep -q 'waiting 65 s' "$TMP/out" || fail 'no 65 s wait'
# The add is handed the token file on stdin, byte for byte, and the PAT reaches it no other way.
# (Dropping the trailing newline is mocactl's own contract, not the smoke's: it pipes the file
# whole, so what the fake receives still has it.) The credential is gone by here, deleted above,
# so this reads what the fake kept of that stdin. The `|| true` this replaces compared the
# already-deleted file against '' and discarded the result either way, so it held nothing at all:
# the smoke could have sent an empty stdin, or the PAT on argv, and it would still have passed.
read_file="$(echo "$MOCK_DIR"/cred-*-gh.read)"
[[ -f "$read_file" ]] || fail 'the credential add never read the PAT from stdin'
cmp -s "$read_file" "$TMP/pat" ||
  fail "the add's stdin is not the token file: $(cmp "$read_file" "$TMP/pat" 2>&1 |
    sed 's/^cmp: //')"
nopat
pass 'step 7: store on stdin, clone/commit/push, the owner, the branch deleted, the placeholder 401, revoked; PAT in no log or output'

# The stored value is the PAT without its newline (checked while the credential exists: the fake sandbox runs gh).
reset_state
credrun SBX_SMOKE_GITHUB_MCP=1 >"$TMP/out" 2>&1 || fail "step 7 with github-mcp exited $?"
grep -qE '^mocactl user=a url=https://api\.sbx\.example xdg= sbx credentials add smoke-[0-9]+-[0-9]+-gh-mcp --preset github-mcp$' "$MOCK_LOG" || fail 'no github-mcp add'
grep -qE '^mocactl user=a url=https://api\.sbx\.example xdg= sbx credentials delete smoke-[0-9]+-[0-9]+-gh-mcp$' "$MOCK_LOG" || fail 'no github-mcp delete'
grep -q 'api.githubcopilot.com/mcp/' "$MOCK_LOG" || fail 'no MCP initialize'
! grep 'api.githubcopilot.com' "$MOCK_LOG" | grep -qi authorization || fail 'the MCP request carried an Authorization header'
has 'ok 7 - egress credentials: the PAT works from the sandbox without being in it; the placeholder is inert; delete revokes'
all_cleaned
nopat
pass 'step 7 with SBX_SMOKE_GITHUB_MCP=1: initialize without an Authorization header, both credentials deleted'

# Two users: B gets a 401 and a public clone.
reset_state
credrun SBX_SMOKE_HOME_B="$TMP/home-b" SBX_SMOKE_CRED_TWO_USERS=1 >"$TMP/out" 2>&1 || fail "step 7 with two users exited $?"
! grep -q 'SKIP no second user' "$TMP/out" || fail 'the B check was skipped'
grep -q '^mocactl user=b .* sbx run --sandbox sbx-[0-9a-f]* --timeout 180 -- sh -c curl ' "$MOCK_LOG" || fail "no 401 check in B's sandbox"
grep -q 'git ls-remote https://github.com/cli/cli HEAD' "$MOCK_LOG" || fail 'no public ls-remote in the B sandbox'
[[ "$(created)" == 2 ]] || fail "created $(created) sandboxes, not 2"
all_cleaned
nopat
# HOME_B alone, without SBX_SMOKE_CRED_TWO_USERS=1, is not used.
reset_state
credrun SBX_SMOKE_HOME_B="$TMP/home-b" >"$TMP/out" 2>&1 || fail "step 7 with an unused B exited $?"
has '# step 7: second-user check skipped (no second user)'
! grep -q "ok 7 - B's sandbox" "$TMP/out" || fail 'the second-user sub-step printed its own ok line'
! grep -q 'user=b' "$MOCK_LOG" || fail 'B was used without SBX_SMOKE_CRED_TWO_USERS=1'
pass "step 7's B check runs only with HOME_B and SBX_SMOKE_CRED_TWO_USERS=1"

# Failures: each `not ok 7`, exit 1, and the trap still deletes the credential, the branch and the sandbox.
credfail() { # credfail WHY ENV...
  local why="$1" rc=0
  shift
  reset_state
  credrun "$@" >"$TMP/out" 2>&1 || rc=$?
  [[ "$rc" == 1 ]] || fail "$why: exit $rc, not 1"
  grep -q "^not ok 7 - .*: .*$why" "$TMP/out" || fail "no 'not ok 7 - ...: ...$why'"
  all_cleaned
  [[ "$(live_creds)" == 0 ]] || fail "$why: a credential was left"
  [[ ! -s "$MOCK_DIR/remote-branches" ]] || fail "$why: the remote branch was left"
  nopat
}
credfail 'is not the PAT.s owner' MOCK_GH_WRONG=1
grep -q '^# cleanup: deleted credential smoke-' "$TMP/out" || fail 'the trap did not delete the credential'
grep -q '^# cleanup: deleted remote branch sbx-smoke-' "$TMP/out" || fail 'the trap did not delete the branch'
# A failed run is the case that keeps its logs, so it is the one that can prove nopat reads them.
nopat_sees_kept_logs
credfail 'got .200., not 401\|got .200. from api.github.com/user' MOCK_PLACEHOLDER_OK=1
credfail 'after the delete and 65 s the sandbox got' MOCK_CRED_STALE=1
credfail 'sbx credentials add .* --preset github' MOCK_FAIL=add
pass 'a wrong owner, a placeholder that works, a revocation that does not take, a failed add: each `not ok 7`, and the trap deletes the credential, the branch and the sandbox'

# --- #653: three step-7 cleanup gaps -------------------------------------------------------------
# These pin the cases the old cleanup could not tell apart: an ambiguous branch-delete code, a
# credential name the trap recorded but no add ever stored, and the fixed names two runs shared.

# 1. drop_branch believed the ambiguous codes. GitHub answers "Reference does not exist" with *both*
# 422 and 404 (cli/cli#11187), and 422 is also its default-branch/spam answer, so neither code on
# its own means the branch is gone: a revoked PAT leaves the branch and used to report success.
for code in 404 422; do
  reset_state
  credrun MOCK_SBX_DELBRANCH_FAIL=1 MOCK_BRANCH_DELETE_CODE="$code" >"$TMP/out" 2>&1 || true
  grep -q 'could not delete the remote branch sbx-smoke-' "$TMP/out" ||
    fail "a $code with the branch still there was reported as a deleted branch"
  ! grep -q '^# cleanup: deleted remote branch' "$TMP/out" ||
    fail "a $code with the branch still there printed a delete it did not do"
  [[ -s "$MOCK_DIR/remote-branches" ]] || fail "the test did not leave a branch behind to find"
  nopat
done
pass 'a 404 or 422 on the branch delete is confirmed, not believed: the branch is still there, so the trap says to delete it by hand'

# The same ambiguous codes, with the ref really gone: confirmed absent, so a success and no nagging.
for code in 404 422; do
  reset_state
  credrun MOCK_SBX_DELBRANCH_FAIL=1 MOCK_BRANCH_DELETE_CODE="$code" MOCK_BRANCH_GONE=1 >"$TMP/out" 2>&1 || true
  grep -q '^# cleanup: deleted remote branch sbx-smoke-' "$TMP/out" ||
    fail "a $code whose ref is confirmed absent was not accepted as deleted"
  ! grep -q 'could not delete the remote branch' "$TMP/out" ||
    fail "a $code with the branch really gone was reported as a leak"
  [[ ! -s "$MOCK_DIR/remote-branches" ]] || fail "the branch was left after a $code"
  nopat
done
pass 'a 404 or 422 whose ref is confirmed absent counts as deleted: an already-gone branch is not reported as a leak'

# A 404 because the PAT can no longer reach the repository is not "the branch is gone": the probe
# must separate the two, or a revoked PAT silently reports every leaked branch as cleaned up.
reset_state
credrun MOCK_SBX_DELBRANCH_FAIL=1 MOCK_BRANCH_DELETE_CODE=404 MOCK_BRANCH_GONE=1 MOCK_REPO_GONE=1 >"$TMP/out" 2>&1 || true
grep -q 'could not delete the remote branch sbx-smoke-' "$TMP/out" ||
  fail 'a 404 from an unreachable repository was reported as a deleted branch'
! grep -q '^# cleanup: deleted remote branch' "$TMP/out" ||
  fail 'a 404 from an unreachable repository printed a delete it could not have done'
nopat
pass 'a 404 from a repository the PAT cannot reach is not read as a deleted branch'

# 2. A failed add left a recorded name the trap then tried to delete, so a run whose add failed
# printed a cleanup failure for a credential that was never stored, and exited on that instead of
# on the add. The record must stay (an add whose answer is lost really did store it) and the trap
# must delete only what `credentials list` shows.
reset_state
rc=0
credrun MOCK_FAIL=add >"$TMP/out" 2>&1 || rc=$?
[[ "$rc" == 1 ]] || fail "a failed add: exit $rc, not 1"
! grep -q 'could not delete credential' "$TMP/out" ||
  fail 'a failed add left the trap reporting a delete failure for a credential that was never stored'
grep -q "^not ok 7 - .*sbx credentials add .* --preset github" "$TMP/out" ||
  fail 'the failed add is not what the run reported'
nopat
pass 'a failed add is not followed by a spurious delete failure for a credential that was never stored'

# The record-first contract still holds: an add whose answer is lost did store the credential, and
# the trap must still find it in `credentials list` and delete it.
reset_state
rc=0
credrun MOCK_CRED_ADD_LOST=1 >"$TMP/out" 2>&1 || rc=$?
[[ "$rc" == 1 ]] || fail "an add whose answer was lost: exit $rc, not 1"
grep -q '^# cleanup: deleted credential smoke-' "$TMP/out" ||
  fail 'the trap did not delete the credential of an add whose answer was lost'
[[ "$(live_creds)" == 0 ]] || fail "a credential was left after an add whose answer was lost: $(live_creds)"
nopat
pass 'an add whose answer was lost is still cleaned up: the trap deletes what `credentials list` shows'

# 3. The credential names were fixed (smoke-gh, smoke-gh-mcp) while the sandboxes were already
# namespaced per run, so two concurrent runs shared one credential and each deleted the other's.
reset_state
credrun SBX_SMOKE_GITHUB_MCP=1 >"$TMP/out" 2>&1 || fail "step 7 exited $?"
grep -q "sbx credentials add smoke-[0-9]*-[0-9]*-gh --preset github\$" "$MOCK_LOG" ||
  fail "the credential name is not namespaced per run: $(sed -n 's/.*credentials add \([^ ]*\) .*/\1/p' "$MOCK_LOG" | sort -u | tr '\n' ' ')"
grep -q "sbx credentials add smoke-[0-9]*-[0-9]*-gh-mcp --preset github-mcp\$" "$MOCK_LOG" ||
  fail 'the github-mcp credential name is not namespaced per run'
! grep -q 'credentials add smoke-gh ' "$MOCK_LOG" || fail 'the run still used the shared fixed name smoke-gh'
nopat
pass 'the credentials are named per run, so concurrent runs cannot share or revoke one another'
