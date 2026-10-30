#!/usr/bin/env bash
# deploy/sbx/smoke.sh -- the SBX0 live smoke (docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md
# §10.6), against a deployed sandbox service. It does nothing unless SBX_LIVE_SMOKE=1.
#
#   SBX_LIVE_SMOKE=1 SBX_API_URL=https://<api host> \
#     SBX_SMOKE_HOME_A=<home> SBX_SMOKE_HOME_B=<home> deploy/sbx/smoke.sh
#
# Inputs, from the environment only (no arguments):
#   SBX_API_URL             https://<api host>, the sandbox control plane
#   SBX_SMOKE_HOME_A        a HOME in which user A ran `mocactl sbx login` (it may be your own HOME)
#   SBX_SMOKE_HOME_B        a second HOME, logged in as ANOTHER enrolled user (step 2; required
#                           unless only step 7 is selected, where it is optional, see below)
#                           Every mocactl here runs with HOME set to one of them and
#                           XDG_CONFIG_HOME / XDG_STATE_HOME unset. The smoke never logs in.
#   SBX_SMOKE_TEMPLATE      the template to create sandboxes from (default: default)
#   SBX_SMOKE_STEPS         the steps to run, e.g. 1,2,5 (default: all of 1-7; 3 takes ~5 min, 4
#                           waits for a token's exp, one token lifetime: ~16 min by default; 7 is a
#                           SKIP unless its inputs below are set). `7` alone needs only HOME_A.
#   SBX_SMOKE_AGENTS        the agents step 5 runs, among claude,opencode (default both); one not on
#                           PATH is a SKIP. Each needs its own login and model already configured.
#   SBX_SMOKE_HOST          an ssh target ([user@]host) for step 6, the KVM host running the
#                           template's worker and the janitor, with passwordless sudo; unset: SKIP
#   SBX_SMOKE_HOST_ENV_DIR, SBX_SMOKE_HOST_SRV, SBX_SMOKE_HOST_LIBEXEC
#                           that host's SBX_ENV_DIR, SBX_SRV and SBX_LIBEXEC_DIR, as given to
#                           install-host.sh (default /etc/sbx, /srv/sbx, /usr/local/libexec)
#   SBX_SMOKE_JANITOR_AGE   step 6's janitor wait (default: the host's own SBX_JANITOR_AGE, from its
#                           janitor.env, which setup.sh keeps above the token lifetime + 30 s). The
#                           run frees every workspace on the host terminated that long ago, not
#                           only this run's, so a value below the host's is refused; step 6 waits
#                           until its own deletion is that old (up to the wait, e.g. ~1 h)
#   MOCACTL                 a mocactl to test (a local build: packages/mocactl/dist/mocactl.mjs);
#                           unset: installed into a temp dir from the edge channel the user guide
#                           names (MOCACTL_VERSION=edge scripts/install-mocactl.sh)
#   SBX_SMOKE_GITHUB_TOKEN_FILE, SBX_SMOKE_GITHUB_REPO
#                           step 7 (egress credentials; both set, or it is a SKIP): a file holding a
#                           GitHub PAT (one trailing newline is ignored; the PAT is never taken from
#                           the environment, which `ps` and child processes can see) and OWNER/REPO, a
#                           repository the PAT can push to. Needs a sandbox service with
#                           SBX_EGRESS_CREDENTIALS and curl on this machine.
#   SBX_SMOKE_CRED_TTL      the egress credential cache TTL in seconds (default 60,
#                           SH_EGRESS_CREDENTIAL_TTL_SECONDS); step 7 waits TTL + 5 s after a delete
#   SBX_SMOKE_GITHUB_MCP    1: step 7 also checks the github-mcp preset (api.githubcopilot.com must
#                           be in the host's egress allowlist)
#   SBX_SMOKE_CRED_TWO_USERS 1, with SBX_SMOKE_HOME_B: step 7 also checks that user B's sandbox gets
#                           a 401 and a public clone works; else that check is a SKIP
#   SBX_SMOKE_PYTHON        Python 3.10+ with grpcio, and grpcio-tools unless the stubs are already
#                           generated in docs/api/examples (steps 2 and 4; default python3). It also
#                           runs the sample repository's tests locally.
#
# Steps (spec §10.6; 7 is SBX0.2b's), each printing `ok N - ...`, `ok N - ... # SKIP why` or `not ok N - ...: why`:
#   1. round trip: in a sample repository (one failing test), sbx up; sbx run fails the suite;
#      sbx put the fix; the suite passes in the sandbox; the local tree is unchanged until
#      sbx pull --apply, after which the suite passes locally.
#   2. two users: B's mint and env for A's sandbox are `no such sandbox` (404); B's token with A's
#      sandbox and workspace key is PERMISSION_DENIED (docs/api/examples/sandbox_v1_client.py); A and
#      B send the same req_id and command at once, each to its own sandbox of the same template,
#      and each gets its own sandbox's answer.
#   3. silence: sbx run of `sleep 300; echo survived` prints survived (keepalive under the load
#      balancer's idle cut).
#   4. delete: a token is minted and kept, the sandbox deleted, and the next mint refused at once
#      (sandbox was deleted). The kept token still runs `true`; a command started 20 s before its exp
#      is cancelled (DEADLINE_EXCEEDED) at exp plus the 30 s leeway; then the token is UNAUTHENTICATED.
#   5. agents: for each of SBX_SMOKE_AGENTS, in a fresh sample repository after sbx up, sbx doctor's
#      agent-config check passes (local tools denied), then headless `claude -p ... --mcp-config
#      .mcp.json --strict-mcp-config` or `opencode run ...` fixes the failing test through
#      `mocactl sbx mcp` (the flight recorder shows its calls). `git status --porcelain` is the same
#      as right after sbx up, and the local suite still fails, until sbx pull --apply; then it passes.
#   6. janitor (SBX_SMOKE_HOST): a deleted sandbox's workspace directory exists on the host; one
#      janitor run (`sudo ... sbx-janitor.sh`, janitor.env sourced, its own wait kept) frees it once
#      its deletion is that old (see SBX_SMOKE_JANITOR_AGE).
#   7. egress credentials (SBX_SMOKE_GITHUB_TOKEN_FILE and SBX_SMOKE_GITHUB_REPO): user A stores the
#      PAT (`credentials add <run>-gh --preset github`, on stdin from the file, never argv); in A's
#      sandbox git clone, commit, push of a branch and `gh api user` (else curl) see the PAT's owner;
#      the remote branch is deleted; the placeholder sent from this machine is a 401; after A deletes
#      the credential and TTL + 5 s the sandbox gets a 401. Opt-in: github-mcp (no Authorization
#      header sent by the client, yet `initialize` answers) and B's sandbox (401, public clone ok).
#      The trap deletes the remote branch, the credentials and the sandboxes. The PAT is never printed.
#
# What it creates: temp directories (sample repositories, a mocactl install, token files) and
# credentials (smoke-<ts>-<pid>-gh and -gh-mcp, named per run so two runs as the same user cannot
# revoke one another), a remote branch sbx-smoke-<ts> and sandboxes it records as it creates
# them. Each step deletes its own; an EXIT trap deletes whatever
# is left, on success, failure or interrupt. It deletes nothing it did not create, and never prints a
# token: tokens go to 0600 files in its temp directory, removed at exit. Logs are kept (path printed)
# when something failed.
#
# Exit: 0 every step ok or skipped; 1 a step failed; 2 a usage or settings error.
set -euo pipefail

if [[ "${1:-}" == -h || "${1:-}" == --help ]]; then
  while IFS= read -r line; do
    [[ "$line" == '#'* ]] || break
    [[ "$line" == '#!'* ]] && continue
    line="${line#\#}"
    printf '%s\n' "${line# }"
  done <"${BASH_SOURCE[0]}"
  exit 0
fi
if [[ "${SBX_LIVE_SMOKE:-}" != 1 ]]; then
  echo "SKIP: skipped (SBX_LIVE_SMOKE not set); set SBX_LIVE_SMOKE=1 to run the SBX0 live smoke against a deployed service"
  exit 0
fi

die() { echo "deploy/sbx/smoke.sh: $*" >&2; exit 2; }
[[ $# -eq 0 ]] || die "takes no arguments (got '$1'): every input is an environment variable (see --help)"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ID_RE='^sbx-[0-9a-f]{26}$'                # a sandbox id, and its workspace key
WORKER_RE='^[A-Za-z_][A-Za-z0-9_]*$'      # a worker id
PATH_RE='^(/[A-Za-z0-9._-]+)+$'           # a plain absolute path
LEEWAY_S=30                               # the relay's clock leeway past a token's exp (SBX0 §3.6)
AGENT_TIMEOUT_S=900                       # one agent run, at most
PROMPT='The test suite fails (python3 -m unittest). Fix it with a minimal change and run the tests.'

# --- Settings -------------------------------------------------------------------------------

[[ -n "${SBX_API_URL:-}" ]] || die "set SBX_API_URL=https://<api host> (the sandbox control plane)"
[[ "$SBX_API_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] || die "SBX_API_URL must be https://<api host> (got '$SBX_API_URL')"
homecheck() { # homecheck VAR: a set variable naming a directory
  [[ -n "${!1:-}" ]] || die "set $1 to a HOME already logged in with \`mocactl sbx login\` (see deploy/sbx/RUNBOOK.md, Live smoke)"
  [[ -d "${!1}" ]] || die "$1='${!1}' is not a directory"
}
homecheck SBX_SMOKE_HOME_A
HOME_A="$(cd "$SBX_SMOKE_HOME_A" && pwd -P)"
TEMPLATE="${SBX_SMOKE_TEMPLATE:-default}"
[[ "$TEMPLATE" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || die "SBX_SMOKE_TEMPLATE='$TEMPLATE' is not a template id"

STEPS=' '
IFS=, read -ra raw <<<"${SBX_SMOKE_STEPS-1,2,3,4,5,6,7}"
((${#raw[@]})) || die 'SBX_SMOKE_STEPS is empty: list steps 1-7, e.g. 1,2,5'
for s in "${raw[@]}"; do
  [[ "$s" =~ ^[1-7]$ ]] || die "SBX_SMOKE_STEPS: '$s' is not a step (1-7, comma-separated)"
  STEPS+="$s "
done
want() { [[ "$STEPS" == *" $1 "* ]]; }

# Step 7's inputs. Both set: it runs; else it is a SKIP. User B is needed by steps 1-6 (as ever) and by
# step 7 only when it is asked for twice over (SBX_SMOKE_CRED_TWO_USERS=1 and a HOME_B).
CRED_FILE="${SBX_SMOKE_GITHUB_TOKEN_FILE:-}" CRED_REPO="${SBX_SMOKE_GITHUB_REPO:-}"
CRED_TTL="${SBX_SMOKE_CRED_TTL:-60}"
CRED_ON=0 CRED_B=0 NEED_B=0
for s in 1 2 3 4 5 6; do ! want "$s" || NEED_B=1; done
if want 7 && [[ -n "$CRED_FILE" && -n "$CRED_REPO" ]]; then
  CRED_ON=1
  [[ "$CRED_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "SBX_SMOKE_GITHUB_REPO='$CRED_REPO' must be OWNER/REPO"
  [[ -f "$CRED_FILE" && -r "$CRED_FILE" && -s "$CRED_FILE" ]] || die 'SBX_SMOKE_GITHUB_TOKEN_FILE is not a readable, non-empty file'
  [[ "$CRED_TTL" =~ ^[1-9][0-9]{0,4}$ ]] || die "SBX_SMOKE_CRED_TTL='$CRED_TTL' must be whole seconds"
  if [[ "${SBX_SMOKE_CRED_TWO_USERS:-}" == 1 && -n "${SBX_SMOKE_HOME_B:-}" ]]; then CRED_B=1; NEED_B=1; fi
fi
HOME_B=''
if ((NEED_B)); then
  homecheck SBX_SMOKE_HOME_B
  HOME_B="$(cd "$SBX_SMOKE_HOME_B" && pwd -P)"
  [[ "$HOME_A" != "$HOME_B" ]] || die 'SBX_SMOKE_HOME_A and SBX_SMOKE_HOME_B are the same directory: user B needs a login of its own'
fi

AGENTS=''
IFS=, read -ra raw <<<"${SBX_SMOKE_AGENTS-claude,opencode}"
if ((${#raw[@]})); then
  for a in "${raw[@]}"; do
    case "$a" in claude | opencode) [[ " $AGENTS " == *" $a "* ]] || AGENTS+=" $a" ;; *) die "SBX_SMOKE_AGENTS: '$a' is not claude or opencode" ;; esac
  done
fi
if want 5 && [[ -z "$AGENTS" ]]; then die 'SBX_SMOKE_AGENTS is empty: name claude, opencode, or both (or leave 5 out of SBX_SMOKE_STEPS)'; fi

HOST="${SBX_SMOKE_HOST:-}"
[[ -z "$HOST" || "$HOST" =~ ^[A-Za-z0-9_][A-Za-z0-9_.@-]*$ ]] || die "SBX_SMOKE_HOST='$HOST' must be an ssh target, [user@]host"
H_ENV="${SBX_SMOKE_HOST_ENV_DIR:-/etc/sbx}" H_SRV="${SBX_SMOKE_HOST_SRV:-/srv/sbx}" H_LIBEXEC="${SBX_SMOKE_HOST_LIBEXEC:-/usr/local/libexec}"
for v in H_ENV H_SRV H_LIBEXEC; do [[ "${!v}" =~ $PATH_RE ]] || die "the host paths must be plain absolute paths (got '${!v}')"; done
JANITOR_AGE="${SBX_SMOKE_JANITOR_AGE:-}" # empty: the host's own SBX_JANITOR_AGE (janitor.env)
[[ -z "$JANITOR_AGE" || "$JANITOR_AGE" =~ ^[1-9][0-9]{0,8}$ ]] || die "SBX_SMOKE_JANITOR_AGE='$JANITOR_AGE' must be whole seconds, in decimal without a leading zero"

PY="${SBX_SMOKE_PYTHON:-python3}"
command -v "$PY" >/dev/null || die "no $PY on PATH: set SBX_SMOKE_PYTHON to a Python 3.10+"
command -v git >/dev/null || die 'needs git on PATH'
[[ -z "$HOST" ]] || ! want 6 || command -v ssh >/dev/null || die 'step 6 needs ssh on PATH'

# --- Work dirs and the cleanup trap --------------------------------------------------------

WORK="$(mktemp -d)"
LOGS="$(mktemp -d)"
chmod 700 "$WORK" "$LOGS"
RUN="smoke-$(date +%s)-$$"
# Step 7's credential names carry $RUN, as its sandboxes and its branch do: the names are a shared
# namespace per user, so two runs of this smoke as the same user (a retry over a still-running one,
# two CI jobs) would otherwise store one `smoke-gh` and each delete the other's mid-check. Both fit
# the 40-character credential name limit (mocactl's CREDENTIAL_NAME).
CRED_GH="$RUN-gh" CRED_MCP="$RUN-gh-mcp"
CREATED_A='' CREATED_B='' PIDS='' CRED_NAMES='' BRANCH=''
PASSES=0 FAILS=0 SKIPS=0

cleanup() {
  local rc=$? id u
  set +e
  # shellcheck disable=SC2086 # a list of pids
  [[ -z "$PIDS" ]] || kill $PIDS 2>/dev/null
  # Step 7's leftovers first: the branch needs the PAT (read from its file), not a sandbox.
  if [[ -n "$BRANCH" ]]; then drop_branch || rc=1; fi
  # Only the recorded names the service still holds: `cred_add` records a name *before* the add, so
  # that an add whose answer was lost is still cleaned up (the server stored it), but that also
  # records names no add ever stored -- a refused add, a connection that never opened. Deleting
  # those reported a cleanup failure for a credential that never existed and masked the real error.
  if [[ -n "$CRED_NAMES" ]]; then
    for id in $(stored_creds); do left_cred "$id" || rc=1; done
  fi
  for id in $CREATED_A; do left a "$id" || rc=1; done
  for id in $CREATED_B; do left b "$id" || rc=1; done
  # A create the server carried out but whose id never reached us (an interrupt, a lost answer):
  # every name this run gives starts with $RUN-, so anything live by that name is ours.
  for u in a b; do
    for id in $(strays "$u"); do left "$u" "$id" || rc=1; done
  done
  rm -rf "$WORK"
  if [[ "$rc" != 0 || "$FAILS" -gt 0 ]]; then echo "# logs kept in $LOGS"; else rm -rf "$LOGS"; fi
  exit "$rc"
}
strays() { # strays a|b: the live sandboxes of that user named by this run, from `sbx ls --json`
  as "$1" ls --json 2>/dev/null </dev/null | "$PY" -c '
import json, sys
for s in json.load(sys.stdin):
    if str(s.get("name") or "").startswith(sys.argv[1]) and s.get("state") != "terminated":
        print(s["id"])' "$RUN-" 2>/dev/null || true
}
left() { # left a|b ID: delete a sandbox this run created and a step did not
  if as "$1" rm --force "$2" >>"$LOGS/cleanup.log" 2>&1 </dev/null; then
    echo "# cleanup: deleted $2 (user $(upper "$1"))"
  else
    echo "# cleanup: could not delete $2 (user $(upper "$1")): delete it with \`mocactl sbx rm --force $2\`"
    return 1
  fi
}
stored_creds() { # the recorded names user A's `credentials list` still shows (see the cleanup)
  local listed
  listed="$(as a credentials --json 2>>"$LOGS/cleanup.log" </dev/null | "$PY" -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except ValueError:  # not JSON (an unmounted route, a transport error): say nothing is listed
    sys.exit(0)
for c in doc.get("credentials") or []:
    if c.get("name"):
        print(c["name"])' 2>>"$LOGS/cleanup.log")" || listed=''
  local n
  for n in $CRED_NAMES; do
    printf '%s\n' "$listed" | grep -qxF "$n" && printf '%s\n' "$n"
  done
  return 0
}
left_cred() { # left_cred NAME: delete a credential this run stored and a step did not
  if as a credentials delete "$1" >>"$LOGS/cleanup.log" 2>&1 </dev/null; then
    echo "# cleanup: deleted credential $1 (user A)"
  else
    echo "# cleanup: could not delete credential $1 (user A): delete it with \`mocactl sbx credentials delete $1\`"
    return 1
  fi
}
# The PAT, read from its file inside a function and handed to curl on stdin as a config line: not
# in argv, not in the environment, never echoed. One trailing newline is dropped.
pat() { local t; t="$(cat "$CRED_FILE"; printf x)" && t="${t%x}" && printf '%s' "${t%$'\n'}"; }
pat_curl() { printf 'user = "x-access-token:%s"\n' "$(pat)" | curl -sS -K - "$@"; }
api_code() { # api_code URL: the status of a GET with the PAT, '' if curl itself failed
  pat_curl -o /dev/null -w '%{http_code}' "$1" 2>>"$LOGS/cleanup.log" || printf ''
}
# Delete the remote branch from this machine. A branch that is really gone is fine, but GitHub's
# "gone" answers are ambiguous: it sends "Reference does not exist" as *both* 422 and 404
# (cli/cli#11187), 422 is also its answer for the default branch and for a spammed endpoint, and a
# 404 is what a PAT that can no longer reach the repository gets for every ref. Believing them
# reported a leaked branch as cleaned up -- the one case this cleanup exists to catch -- so anything
# but a 204 is confirmed: the repository still answers with this PAT, and the ref is really absent.
drop_branch() {
  local code ref
  code="$(pat_curl -X DELETE -o /dev/null -w '%{http_code}' "https://api.github.com/repos/$CRED_REPO/git/refs/heads/$BRANCH" 2>>"$LOGS/cleanup.log")" || code=''
  if [[ "$code" != 204 ]]; then
    ref="$(api_code "https://api.github.com/repos/$CRED_REPO/git/refs/heads/$BRANCH")"
    # The ref reads as absent: trust that only if the repository itself is still reachable, since a
    # revoked PAT answers 404 for both.
    if [[ "$ref" == 404 && "$(api_code "https://api.github.com/repos/$CRED_REPO")" == 200 ]]; then
      code=204
    fi
  fi
  case "$code" in
  204) echo "# cleanup: deleted remote branch $BRANCH"; BRANCH='' ;;
  *) echo "# cleanup: could not delete the remote branch $BRANCH of $CRED_REPO (HTTP ${code:-none}): delete it by hand"; return 1 ;;
  esac
}
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- mocactl, as user A and as user B -------------------------------------------------------

if [[ -n "${MOCACTL:-}" ]]; then
  [[ -f "$MOCACTL" ]] || die "MOCACTL='$MOCACTL' is not a file"
  MOCACTL="$(cd "$(dirname "$MOCACTL")" && pwd -P)/$(basename "$MOCACTL")"
else
  echo "# installing mocactl from the edge channel (scripts/install-mocactl.sh, MOCACTL_VERSION=edge)"
  MOCACTL_VERSION=edge MOCACTL_INSTALL_DIR="$WORK/mocactl" sh "$SRC/scripts/install-mocactl.sh" >"$LOGS/install.log" 2>&1 ||
    die "could not install mocactl from the edge channel: $(tail -n 1 "$LOGS/install.log" | tr -cd '[:print:]') (or set MOCACTL to a local build)"
  MOCACTL="$WORK/mocactl/mocactl"
fi
case "$MOCACTL" in
*.mjs | *.js) command -v node >/dev/null || die "MOCACTL is a .mjs: needs node on PATH"; RUNNER="node $(printf %q "$MOCACTL")" ;;
*) [[ -x "$MOCACTL" ]] || die "MOCACTL='$MOCACTL' is not executable"; RUNNER="$(printf %q "$MOCACTL")" ;;
esac
# A `mocactl` per user, on PATH for the agents too: Claude Code and OpenCode start `mocactl sbx mcp`
# themselves (.mcp.json, opencode.json), and it must log in as user A while they keep the real HOME.
for u in a b; do
  home="$HOME_A"
  [[ "$u" == a ]] || home="$HOME_B"
  [[ -n "$home" ]] || continue
  mkdir -p "$WORK/bin-$u"
  printf '#!/usr/bin/env bash\nexport HOME=%q MOCACTL_SBX_URL=%q\nunset XDG_CONFIG_HOME XDG_STATE_HOME\nexec %s "$@"\n' \
    "$home" "$SBX_API_URL" "$RUNNER" >"$WORK/bin-$u/mocactl"
  chmod 700 "$WORK/bin-$u/mocactl"
done
as() { local u="$1"; shift; "$WORK/bin-$u/mocactl" sbx "$@"; }

help1="$(as a --help 2>/dev/null </dev/null | head -n 1)" || true
[[ "$help1" == 'usage (the sandbox service, SBX0):' ]] ||
  die "$MOCACTL has no \`mocactl sbx\` (its \`sbx --help\` begins '${help1}'): use the edge channel or a build of this branch"

# --- The direct client (steps 2 and 4) -------------------------------------------------------

PYPATH=''
if want 2 || want 4; then
  "$PY" -c 'import grpc' 2>/dev/null || die "$PY has no grpcio: pip install grpcio grpcio-tools (or set SBX_SMOKE_PYTHON)"
  mkdir -p "$WORK/py"
  if "$PY" -m grpc_tools.protoc -I "$SRC/proto" --python_out="$WORK/py" --grpc_python_out="$WORK/py" sandbox/v1/sandbox.proto \
    >"$LOGS/protoc.log" 2>&1 && [[ -f "$WORK/py/sandbox/v1/sandbox_pb2_grpc.py" ]]; then
    PYPATH="$WORK/py"
  elif [[ -f "$SRC/docs/api/examples/sandbox/v1/sandbox_pb2_grpc.py" ]]; then
    PYPATH="$SRC/docs/api/examples"
  else
    die "cannot generate the sandbox/v1 stubs: $PY needs grpcio-tools (see docs/api/sandbox-v1-direct-client.md)"
  fi
fi
# key=value lines, never the token. `exec` calls the example client's own _exec with the caller's
# req_id and a static token (so nothing refreshes it), and reports how the call ended.
cat >"$WORK/smoke_client.py" <<'PYEOF'
import re, sys, time
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from sandbox_v1_client import (Sandbox, SandboxBusy, SandboxError, TokenExpiredDuringExec, TokenSource,
                               _NotStarted, _times_of)

def say(**kv):
    for k, v in kv.items():
        print(f"{k}={v}")

mode, token = sys.argv[3], open(sys.argv[4]).read().strip()
if mode == "exp":
    say(exp=_times_of(token)[1])
    sys.exit(0)
addr, sandbox_id, wsk, tls, ca, req_id, timeout, command = sys.argv[5:13]
sbx = Sandbox(addr, sandbox_id, wsk, TokenSource(static=token), tls=tls == "1", ca_file=None if ca == "-" else ca)
t0 = time.time()
try:
    r = sbx._exec(int(req_id), command, b"", int(timeout), [("authorization", f"Bearer {token}")])
    out = re.sub(r"[^ -~]", "?", r.stdout.decode(errors="replace").strip())[:200]
    say(outcome="end", exit_code=r.exit_code, timed_out=int(r.timed_out), stdout=out)
except _NotStarted:
    say(outcome="rpc", code="UNAUTHENTICATED")
except TokenExpiredDuringExec:
    say(outcome="rpc", code="DEADLINE_EXCEEDED")
except SandboxBusy:
    say(outcome="rpc", code="RESOURCE_EXHAUSTED")
except SandboxError as e:
    m = re.match(r"exec failed: ([A-Z_]+): ", str(e))
    say(outcome="rpc", code=m.group(1) if m else "MACHINERY", details=re.sub(r"[^ -~]", "?", str(e))[:200])
say(t_start=int(t0), t_end=int(time.time()))
PYEOF
client() { "$PY" "$WORK/smoke_client.py" "$PYPATH" "$SRC/docs/api/examples" "$@"; }

# --- Helpers -------------------------------------------------------------------------------

N=0
# x NAME CMD...: run CMD with stdout and stderr in $LOGS/NAME.{out,err}; RC is its exit code.
# In the background, waited on: a TERM is acted on at once, not when a 5-minute command returns, so
# a timeout's later SIGKILL never lands before the EXIT cleanup has run (bash runs a trap only
# between foreground commands, but interrupts `wait`).
job() { # job CMD...: run CMD as a background job, wait for it; its status
  local p rc=0
  # <&0: an asynchronous command's stdin would otherwise be /dev/null (no job control here).
  "$@" <&0 &
  p=$!
  PIDS="$PIDS $p"
  wait "$p" || rc=$?
  PIDS="${PIDS% $p}"
  return "$rc"
}
x() { local n="$1"; shift; RC=0; job "$@" >"$LOGS/$n.out" 2>"$LOGS/$n.err" </dev/null || RC=$?; }
# xin NAME FILE CMD...: x, with FILE on stdin.
xin() { local n="$1" f="$2"; shift 2; RC=0; job "$@" >"$LOGS/$n.out" 2>"$LOGS/$n.err" <"$f" || RC=$?; }
# lastline FILE: its last non-empty line, printable only, for a not-ok reason.
lastline() { { grep -v '^[[:space:]]*$' "$1" 2>/dev/null || true; } | tail -n 1 | tr -cd '[:print:]' | cut -c1-200; }
field() { sed -n "s/^$1=//p" "$2" | tail -n 1; }
fail() { WHY="$*"; return 1; }
sleep_until() { local d=$(($1 - $(date +%s))); if ((d > 0)); then job sleep "$d"; fi; }

record() { # record a|b ID: a sandbox this run created
  [[ "$2" =~ $ID_RE ]] || return 1
  if [[ "$1" == a ]]; then CREATED_A+=" $2"; else CREATED_B+=" $2"; fi
}
forget() { # forget a|b ID: deleted by its step
  local l
  if [[ "$1" == a ]]; then l=" $CREATED_A "; CREATED_A="${l/ $2 / }"; else l=" $CREATED_B "; CREATED_B="${l/ $2 / }"; fi
}
release() { # release a|b ID: delete a sandbox this run created, now its step is done with it
  x "rm-$2" as "$1" rm --force "$2"
  [[ "$RC" == 0 ]] || fail "sbx rm $2 (user $(upper "$1")): $(lastline "$LOGS/rm-$2.err")" || return 1
  forget "$1" "$2"
}
create() { # create a|b TAG: a new sandbox from TEMPLATE; its id in SBX
  N=$((N + 1))
  x "create-$1-$N" as "$1" create --template "$TEMPLATE" --name "$RUN-$N-$2"
  SBX="$(tail -n 1 "$LOGS/create-$1-$N.out")"
  if [[ "$RC" == 0 ]] && record "$1" "$SBX"; then return 0; fi
  fail "user $(upper "$1") cannot create a sandbox from '$TEMPLATE': $(lastline "$LOGS/create-$1-$N.err")"
}
envof() { # envof a|b ID PREFIX: PREFIX_ADDR, _TLS, _WRK, _WSK, _CA from `mocactl sbx env ID`
  local f="$LOGS/env-$2.out" k v
  x "env-$2" as "$1" env "$2"
  [[ "$RC" == 0 ]] || fail "sbx env $2: $(lastline "$LOGS/env-$2.err")" || return 1
  for k in ADDR:SBX_ADDR TLS:SBX_TLS WRK:SBX_SANDBOX_ID WSK:SBX_WORKSPACE_KEY CA:SBX_CA_FILE; do
    v="$(sed -n "s/^export ${k#*:}='\(.*\)'\$/\1/p" "$f")"
    printf -v "$3_${k%%:*}" '%s' "$v"
  done
  local addr="$3_ADDR" wrk="$3_WRK" wsk="$3_WSK" ca="$3_CA"
  [[ "${!addr}" =~ ^[A-Za-z0-9.-]+:[0-9]+$ && "${!wrk}" =~ $WORKER_RE && "${!wsk}" =~ $ID_RE ]] ||
    fail "sbx env $2 printed no usable SBX_ADDR / SBX_SANDBOX_ID / SBX_WORKSPACE_KEY" || return 1
  [[ -n "${!ca}" ]] || printf -v "$3_CA" '%s' -
}
mint() { # mint a|b ID NAME: a token for ID into $WORK/NAME (0600; never printed, never in the
  # logs, even when the mint was meant to be refused); its stderr in $LOGS/NAME.err
  RC=0
  (umask 077; as "$1" token "$2" >"$WORK/$3" 2>"$LOGS/$3.err" </dev/null) || RC=$?
}
call() { # call NAME PREFIX TOKENFILE REQ_ID TIMEOUT CMD: one Exec through the example client
  local addr="$2_ADDR" tls="$2_TLS" wrk="$2_WRK" wsk="$2_WSK" ca="$2_CA"
  x "$1" client exec "$3" "${!addr}" "${!wrk}" "${!wsk}" "${!tls:-1}" "${!ca}" "$4" "$5" "$6"
}
outcome() { # outcome NAME: "end <exit>" or "rpc <CODE>" from a call's output
  local o
  o="$(field outcome "$LOGS/$1.out")"
  case "$o" in end) echo "end $(field exit_code "$LOGS/$1.out")" ;; rpc) echo "rpc $(field code "$LOGS/$1.out")" ;; *) echo "none: $(lastline "$LOGS/$1.err")" ;; esac
}
reqid() { echo $(((RANDOM << 30 | RANDOM << 15 | RANDOM) + 1)); }

new_repo() { # new_repo NAME: a sample repository with one failing test, in $WORK/NAME
  local r="$WORK/$1"
  mkdir -p "$r"
  printf 'def add(a, b):\n    return a - b\n' >"$r/calc.py"
  printf 'import unittest\n\nfrom calc import add\n\n\nclass AddTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\n\nif __name__ == "__main__":\n    unittest.main()\n' >"$r/test_calc.py"
  printf '__pycache__/\n' >"$r/.gitignore"
  git -C "$r" init -q && git -C "$r" add -A &&
    git -C "$r" -c user.name=sbx-smoke -c user.email=sbx-smoke@localhost -c commit.gpgsign=false commit -q --no-verify -m 'sample: one failing test'
}
local_suite() { (cd "$1" && PYTHONDONTWRITEBYTECODE=1 "$PY" -m unittest -q >"$LOGS/local-$2.log" 2>&1); }
porcelain() { git -C "$1" status --porcelain --untracked-files=all; }
up_repo() { # up_repo a REPO: sbx up there; the new sandbox's id in SBX
  local r="$1" name
  name="$(basename "$r")"
  RC=0
  (cd "$r" && as a up --template "$TEMPLATE" --name "$RUN-$name") >"$LOGS/up-$name.out" 2>"$LOGS/up-$name.err" </dev/null || RC=$?
  # The binding names the sandbox even when up failed after creating it: the repository is this
  # run's own, so any sandbox bound in it is this run's too.
  SBX="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\(sbx-[0-9a-f]*\)".*/\1/p' "$r/.sbx/sandbox.json" 2>/dev/null | head -n 1)" || SBX=''
  [[ -z "$SBX" ]] || record a "$SBX" || SBX=''
  [[ "$RC" == 0 && -n "$SBX" ]] || fail "sbx up: $(lastline "$LOGS/up-$name.err")"
}
# in_repo DIR FN...: FN (x or xin) with DIR as the working directory; RC is FN's.
in_repo() { local r="$1" old="$PWD"; shift; cd "$r" || { RC=1; return 0; }; "$@"; cd "$old" || exit 2; }

# --- Preflight: both logins work, and are two users -----------------------------------------

x ls-a as a ls
[[ "$RC" == 0 ]] || die "user A (SBX_SMOKE_HOME_A) cannot list sandboxes: $(lastline "$LOGS/ls-a.err") (see deploy/sbx/RUNBOOK.md, Live smoke)"
if want 2 || ((CRED_B)); then
  x ls-b as b ls
  [[ "$RC" == 0 ]] || die "user B (SBX_SMOKE_HOME_B) cannot list sandboxes: $(lastline "$LOGS/ls-b.err")"
  # The login's subject only; the file's tokens are never read out.
  subject() { "$PY" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("subject", ""))' "$1/.config/mocactl/sbx-auth.json" 2>/dev/null || true; }
  sa="$(subject "$HOME_A")" sb="$(subject "$HOME_B")"
  [[ -z "$sa" || "$sa" != "$sb" ]] || die "SBX_SMOKE_HOME_A and SBX_SMOKE_HOME_B are both logged in as $sa: this check needs two users"
fi
echo "# SBX0 live smoke: $SBX_API_URL, template $TEMPLATE, steps${STEPS% }, run $RUN"

# --- The steps ------------------------------------------------------------------------------

step1() {
  local r="$WORK/r1" before
  new_repo r1 || fail 'could not make the sample repository' || return 1
  up_repo "$r" || return 1
  local id="$SBX"
  before="$(porcelain "$r")"
  in_repo "$r" x run1-fail as a run -- python3 -B -m unittest
  [[ "$RC" == 1 ]] || fail "sbx run of the failing suite exited $RC, not 1: $(lastline "$LOGS/run1-fail.err")" || return 1
  # -B: no bytecode cache, which keys on whole-second mtimes and would hide a put that soon after.
  printf 'def add(a, b):\n    return a + b\n' >"$WORK/fix.py"
  in_repo "$r" xin put1 "$WORK/fix.py" as a put calc.py
  [[ "$RC" == 0 ]] || fail "sbx put calc.py: $(lastline "$LOGS/put1.err")" || return 1
  in_repo "$r" x run1-pass as a run -- python3 -B -m unittest
  [[ "$RC" == 0 ]] || fail "the suite fails in the sandbox after the fix (exit $RC): $(lastline "$LOGS/run1-pass.err")" || return 1
  [[ "$(porcelain "$r")" == "$before" ]] || fail 'the local tree changed before sbx pull --apply' || return 1
  ! local_suite "$r" r1-before || fail 'the local suite passes before sbx pull --apply' || return 1
  in_repo "$r" x pull1 as a pull --apply
  [[ "$RC" == 0 ]] || fail "sbx pull --apply: $(lastline "$LOGS/pull1.err")" || return 1
  local_suite "$r" r1-after || fail "the local suite fails after sbx pull --apply: $(lastline "$LOGS/local-r1-after.log")" || return 1
  release a "$id"
}

step2() {
  local a b rid ma mb
  create a two-users || return 1
  a="$SBX"
  create b two-users || return 1
  b="$SBX"
  mint b "$a" mint-b-for-a
  [[ "$RC" == 1 ]] && grep -q 'no such sandbox' "$LOGS/mint-b-for-a.err" ||
    fail "B's sbx token for A's sandbox: exit $RC, not 1 with 'no such sandbox'" || return 1
  x env-b-for-a as b env "$a"
  [[ "$RC" == 1 ]] && grep -q 'no such sandbox' "$LOGS/env-b-for-a.err" ||
    fail "B's sbx env for A's sandbox: exit $RC, not 1 with 'no such sandbox'" || return 1
  envof a "$a" A && envof b "$b" B || return 1
  mint a "$a" tok-a && [[ "$RC" == 0 ]] || fail "sbx token (A): $(lastline "$LOGS/tok-a.err")" || return 1
  mint b "$b" tok-b && [[ "$RC" == 0 ]] || fail "sbx token (B): $(lastline "$LOGS/tok-b.err")" || return 1
  # B's token, with A's sandbox and workspace key, at the exec endpoint B was given.
  # shellcheck disable=SC2034 # read by call, through ${!X_...}
  local X_ADDR="$B_ADDR" X_TLS="$B_TLS" X_CA="$B_CA" X_WRK="$A_WRK" X_WSK="$A_WSK"
  call deny-b-to-a X "$WORK/tok-b" "$(reqid)" 60 true
  [[ "$(outcome deny-b-to-a)" == 'rpc PERMISSION_DENIED' ]] ||
    fail "B's token on A's sandbox: $(outcome deny-b-to-a), not PERMISSION_DENIED" || return 1
  # The same req_id and command, from both users at once: each must read its own sandbox's marker.
  ma="A-$RUN-$RANDOM" mb="B-$RUN-$RANDOM"
  printf '%s' "$ma" >"$WORK/marker-a"
  printf '%s' "$mb" >"$WORK/marker-b"
  xin put-a "$WORK/marker-a" as a put .smoke-marker --sandbox "$a"
  [[ "$RC" == 0 ]] || fail "sbx put (A): $(lastline "$LOGS/put-a.err")" || return 1
  xin put-b "$WORK/marker-b" as b put .smoke-marker --sandbox "$b"
  [[ "$RC" == 0 ]] || fail "sbx put (B): $(lastline "$LOGS/put-b.err")" || return 1
  rid="$(reqid)"
  call same-a A "$WORK/tok-a" "$rid" 120 'sleep 3; cat .smoke-marker' &
  local pa=$!
  call same-b B "$WORK/tok-b" "$rid" 120 'sleep 3; cat .smoke-marker' &
  local pb=$!
  PIDS="$pa $pb"
  wait "$pa" || true
  wait "$pb" || true
  PIDS=''
  [[ "$(outcome same-a)" == 'end 0' && "$(field stdout "$LOGS/same-a.out")" == "$ma" ]] ||
    fail "A's Exec with req_id $rid: $(outcome same-a), stdout '$(field stdout "$LOGS/same-a.out")', not A's marker" || return 1
  [[ "$(outcome same-b)" == 'end 0' && "$(field stdout "$LOGS/same-b.out")" == "$mb" ]] ||
    fail "B's Exec with the same req_id: $(outcome same-b), stdout '$(field stdout "$LOGS/same-b.out")', not B's marker" || return 1
  release a "$a" || return 1
  release b "$b"
}

step3() {
  create a silence || return 1
  local id="$SBX"
  echo '# step 3: a command that prints nothing for 300 s...'
  x silence as a run --sandbox "$id" --timeout 400 -- sh -c 'sleep 300; echo survived'
  [[ "$RC" == 0 && "$(cat "$LOGS/silence.out")" == survived ]] ||
    fail "exit $RC, stdout '$(lastline "$LOGS/silence.out")': $(lastline "$LOGS/silence.err")" || return 1
  release a "$id"
}

DELETED_ID='' DELETED_WRK='' DELETED_AT=0
step4() {
  local id exp t_end
  create a delete || return 1
  id="$SBX"
  envof a "$id" D || return 1
  x first-exec as a run --sandbox "$id" -- true
  [[ "$RC" == 0 ]] || fail "sbx run -- true: exit $RC: $(lastline "$LOGS/first-exec.err")" || return 1
  mint a "$id" tok-d
  [[ "$RC" == 0 ]] || fail "sbx token: $(lastline "$LOGS/tok-d.err")" || return 1
  x exp client exp "$WORK/tok-d"
  exp="$(field exp "$LOGS/exp.out")"
  [[ "$exp" =~ ^[1-9][0-9]*$ ]] || fail 'cannot read the minted token'"'"'s exp' || return 1
  x rm-delete as a rm --force "$id"
  [[ "$RC" == 0 ]] || fail "sbx rm: $(lastline "$LOGS/rm-delete.err")" || return 1
  forget a "$id"
  DELETED_ID="$id" DELETED_WRK="$D_WRK" DELETED_AT="$(date +%s)"
  mint a "$id" mint-deleted
  [[ "$RC" == 1 ]] && grep -q 'deleted' "$LOGS/mint-deleted.err" ||
    fail "the mint after delete: exit $RC, not refused as deleted: $(lastline "$LOGS/mint-deleted.err")" || return 1
  call kept-token D "$WORK/tok-d" "$(reqid)" 60 true
  [[ "$(outcome kept-token)" == 'end 0' ]] || fail "the kept token after delete: $(outcome kept-token), not a run of true" || return 1
  echo "# step 4: waiting until 20 s before the token's exp ($((exp - 20 - $(date +%s))) s)..."
  sleep_until $((exp - 20))
  call at-exp D "$WORK/tok-d" "$(reqid)" $((LEEWAY_S + 120)) "sleep $((LEEWAY_S + 90)); echo not-cancelled"
  t_end="$(field t_end "$LOGS/at-exp.out")"
  [[ "$(outcome at-exp)" == 'rpc DEADLINE_EXCEEDED' ]] ||
    fail "a command started before exp: $(outcome at-exp), not DEADLINE_EXCEEDED" || return 1
  [[ "$(field t_start "$LOGS/at-exp.out")" -lt "$exp" ]] || fail 'the command did not start before exp (a slow mint?)' || return 1
  local late=$((t_end - exp))
  ((late >= LEEWAY_S - 15 && late <= LEEWAY_S + 30)) ||
    fail "it was cancelled $late s after exp, not at exp + ${LEEWAY_S} s (this machine's clock against the control plane's)" || return 1
  echo "# step 4: cancelled $late s after exp"
  sleep_until $((t_end > exp + LEEWAY_S ? t_end + 10 : exp + LEEWAY_S + 10))
  call after-exp D "$WORK/tok-d" "$(reqid)" 60 true
  [[ "$(outcome after-exp)" == 'rpc UNAUTHENTICATED' ]] ||
    fail "the kept token after exp + ${LEEWAY_S} s: $(outcome after-exp), not UNAUTHENTICATED" || return 1
}

step5() {
  local agent="$1" r="$WORK/agent-$1" before recorder lines
  command -v "$agent" >/dev/null || { WHY="$agent not on PATH"; return 3; }
  new_repo "agent-$agent" || fail 'could not make the sample repository' || return 1
  up_repo "$r" || return 1
  local id="$SBX"
  before="$(porcelain "$r")"
  in_repo "$r" x "doctor-$agent" as a doctor
  grep -q '^ok - agent config' "$LOGS/doctor-$agent.out" "$LOGS/doctor-$agent.err" ||
    fail "sbx doctor's agent config check: $(cat "$LOGS/doctor-$agent.out" "$LOGS/doctor-$agent.err" | grep 'agent config' | tr -cd '[:print:]' | cut -c1-200)" || return 1
  recorder="$HOME_A/.local/state/mocactl/sbx/$id.log"
  echo "# step 5: $agent, headless, at most $AGENT_TIMEOUT_S s..."
  RC=0
  (
    cd "$r"
    export PATH="$WORK/bin-a:$PATH"
    case "$agent" in
    # --allowedTools puts the sandbox MCP tools on the session's own allowlist: headless
    # claude in a fresh workspace has NOT accepted the trust dialog, and an untrusted
    # workspace's .claude/settings.json allow entries are ignored (its deny entries are
    # not — local tools stay denied), so without this every mcp__sandbox__* call is
    # blocked at the permission gate and the agent exits 0 having done nothing.
    claude) exec claude -p "$PROMPT" --mcp-config .mcp.json --strict-mcp-config --allowedTools 'mcp__sandbox__*' ;;
    *) exec opencode run "$PROMPT" ;;
    esac
  ) >"$LOGS/agent-$agent.log" 2>&1 </dev/null &
  local pid=$!
  PIDS="$pid"
  (
    trap 'kill $s 2>/dev/null; exit 0' TERM
    sleep "$AGENT_TIMEOUT_S" &
    s=$!
    wait "$s" && kill "$pid"
  ) >/dev/null 2>&1 &
  local watch=$!
  PIDS="$pid $watch"
  wait "$pid" || RC=$?
  kill "$watch" 2>/dev/null || true
  PIDS=''
  [[ "$RC" == 0 ]] || fail "$agent exited $RC: $(lastline "$LOGS/agent-$agent.log")" || return 1
  lines="$(wc -l <"$recorder" 2>/dev/null | tr -d ' ')" || lines=0
  ((${lines:-0} > 0)) || fail "no call in the flight recorder: $agent did not use the sandbox MCP server" || return 1
  [[ "$(porcelain "$r")" == "$before" ]] || fail "the local tree changed during the $agent run, before sbx pull --apply" || return 1
  ! local_suite "$r" "$agent-before" || fail 'the local suite passes before sbx pull --apply' || return 1
  in_repo "$r" x "pull-$agent" as a pull --apply
  [[ "$RC" == 0 ]] || fail "sbx pull --apply: $(lastline "$LOGS/pull-$agent.err")" || return 1
  local_suite "$r" "$agent-after" ||
    fail "the local suite fails after sbx pull --apply (did $agent fix it? $(lastline "$LOGS/agent-$agent.log"))" || return 1
  release a "$id"
}

# Piped to `ssh HOST sudo -n bash -s -- WRK WSK ENV_DIR SRV LIBEXEC MODE AGE` (no checkout on the
# host). MODE probe: whether the workspace is there, and the host's own SBX_JANITOR_AGE. MODE run:
# janitor.env sourced, then the installed janitor with the unit's other settings; AGE `-` keeps the
# host's wait, a number (never below the host's: step6 checks) replaces it.
REMOTE_JANITOR='set -uo pipefail
wrk="$1" wsk="$2" envdir="$3" srv="$4" libexec="$5" mode="$6" age="$7"
dir="$srv/workspaces/$wrk/$wsk"
[[ -f "$envdir/janitor.env" ]] || { echo janitor_rc=no-janitor-env; exit 0; }
if [[ "$mode" == probe ]]; then
  if [[ -d "$dir" ]]; then echo before=present; else echo before=absent; fi
  echo "host_age=$(set -a; . "$envdir/janitor.env"; printf "%s" "${SBX_JANITOR_AGE:-}")"
  exit 0
fi
rc=0
out="$(set -a; . "$envdir/janitor.env"; set +a
  [[ "$age" == - ]] || SBX_JANITOR_AGE="$age"
  exec env SBX_ENV_DIR="$envdir" SBX_SRV="$srv" SBX_JANITOR_TOKEN_FILE="$envdir/janitor.token" \
    SBX_JANITOR_AGE="$SBX_JANITOR_AGE" "$libexec/sbx-janitor.sh" 2>&1)" || rc=$?
echo "janitor_rc=$rc"
printf "%s\n" "$out" | sed "s/^/janitor: /"
if [[ -e "$dir" ]]; then echo after=present; else echo after=absent; fi'
remote_janitor() { # remote_janitor NAME WRK WSK MODE AGE: one ssh, its output in $LOGS/NAME.out
  RC=0
  printf '%s\n' "$REMOTE_JANITOR" >"$WORK/janitor.sh"
  xin "$1" "$WORK/janitor.sh" ssh -o BatchMode=yes "$HOST" sudo -n bash -s -- "$2" "$3" "$H_ENV" "$H_SRV" "$H_LIBEXEC" "$4" "$5"
  [[ "$RC" == 0 ]] || fail "ssh $HOST: exit $RC: $(lastline "$LOGS/$1.err")"
}

step6() {
  [[ -n "$HOST" ]] || { WHY='SBX_SMOKE_HOST not set'; return 3; }
  local id="$DELETED_ID" wrk="$DELETED_WRK" host_age age
  if [[ -z "$id" ]]; then
    create a janitor || return 1
    id="$SBX"
    envof a "$id" J || return 1
    wrk="$J_WRK"
    x janitor-exec as a run --sandbox "$id" -- true
    [[ "$RC" == 0 ]] || fail "sbx run -- true: exit $RC: $(lastline "$LOGS/janitor-exec.err")" || return 1
    x rm-janitor as a rm --force "$id"
    [[ "$RC" == 0 ]] || fail "sbx rm: $(lastline "$LOGS/rm-janitor.err")" || return 1
    forget a "$id"
    DELETED_AT="$(date +%s)"
  fi
  local dir="$H_SRV/workspaces/$wrk/$id"
  remote_janitor janitor-probe "$wrk" "$id" probe - || return 1
  [[ "$(field janitor_rc "$LOGS/janitor-probe.out")" != no-janitor-env ]] ||
    fail "no $H_ENV/janitor.env on $HOST: install the janitor there (install-host.sh --janitor)" || return 1
  [[ "$(field before "$LOGS/janitor-probe.out")" == present ]] ||
    fail "no $dir on $HOST before the run (is it the template's host? SBX_SMOKE_HOST_SRV?)" || return 1
  host_age="$(field host_age "$LOGS/janitor-probe.out")"
  [[ "$host_age" =~ ^[1-9][0-9]{0,8}$ ]] || fail "$HOST's janitor.env has no usable SBX_JANITOR_AGE ('$host_age')" || return 1
  # The run frees every workspace on the host terminated longer ago than its wait, other users'
  # too: a wait under the host's (which setup.sh keeps above the token lifetime + 30 s) could free
  # one a still-valid token reaches. So the smoke may only lengthen it.
  age="${JANITOR_AGE:-$host_age}"
  ((age >= host_age)) ||
    fail "SBX_SMOKE_JANITOR_AGE=$age is below $HOST's own wait ($host_age s): it would free other users' workspaces early" || return 1
  # 15 s spare for this machine's clock against the control plane's terminatedAt.
  echo "# step 6: waiting until the deletion is $age s old ($((DELETED_AT + age + 15 - $(date +%s))) s)..."
  sleep_until $((DELETED_AT + age + 15))
  echo "# step 6: one janitor run on $HOST (SBX_JANITOR_AGE=$age)..."
  remote_janitor janitor "$wrk" "$id" run "${JANITOR_AGE:--}" || return 1
  [[ "$(field janitor_rc "$LOGS/janitor.out")" == 0 ]] ||
    fail "the janitor exited $(field janitor_rc "$LOGS/janitor.out"): $(grep '^janitor: ' "$LOGS/janitor.out" | tail -n 1 | tr -cd '[:print:]' | cut -c1-200)" || return 1
  [[ "$(field after "$LOGS/janitor.out")" == absent ]] ||
    fail "$dir is still there after the run: $(grep '"janitor":"summary"' "$LOGS/janitor.out" | tr -cd '[:print:]' | cut -c1-200)" || return 1
}

# Step 7. The sandbox commands carry no PAT: git and gh/curl in the sandbox send the placeholder,
# and the host's egress proxy puts the real credential on the wire.
SANDBOX_LOGIN='if command -v gh >/dev/null; then gh api user --jq .login; else curl -sS -H "Authorization: Bearer ${GH_TOKEN:-moca-placeholder}" https://api.github.com/user | python3 -c "import json,sys; print(json.load(sys.stdin)[\"login\"])"; fi'
SANDBOX_CODE='curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${GH_TOKEN:-moca-placeholder}" https://api.github.com/user'
cred_add() { # cred_add NAME PRESET: user A stores the PAT, on stdin from the file
  CRED_NAMES+=" $1" # recorded first: an add whose answer was lost is deleted by the trap
  xin "cred-add-$1" "$CRED_FILE" as a credentials add "$1" --preset "$2"
  [[ "$RC" == 0 ]] || fail "sbx credentials add $1 --preset $2: exit $RC: $(lastline "$LOGS/cred-add-$1.err")"
}
cred_del() { # cred_del NAME
  x "cred-del-$1" as a credentials delete "$1"
  [[ "$RC" == 0 ]] || fail "sbx credentials delete $1: exit $RC: $(lastline "$LOGS/cred-del-$1.err")" || return 1
  local l=" $CRED_NAMES "
  CRED_NAMES="${l/ $1 / }"
}
sbx_sh() { # sbx_sh NAME ID SCRIPT: sh -c SCRIPT in a sandbox, as user A (or B, with WHO=b)
  x "$1" as "${WHO:-a}" run --sandbox "$2" --timeout 180 -- sh -c "$3"
}
step7() {
  ((CRED_ON)) || { WHY='SBX_SMOKE_GITHUB_TOKEN_FILE and SBX_SMOKE_GITHUB_REPO not both set'; return 3; }
  command -v curl >/dev/null || fail 'step 7 needs curl on PATH' || return 1
  local owner id d="smoke-$RUN" code
  owner="$(pat_curl https://api.github.com/user 2>"$LOGS/owner.err" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["login"])' 2>>"$LOGS/owner.err")" || owner=''
  [[ "$owner" =~ ^[A-Za-z0-9-]+(\[bot\])?$ ]] || fail "api.github.com/user did not accept the PAT in SBX_SMOKE_GITHUB_TOKEN_FILE: $(lastline "$LOGS/owner.err")" || return 1
  cred_add "$CRED_GH" github || return 1
  create a credentials || return 1
  id="$SBX"
  # Clone, commit, push a branch: the credential rides git over HTTPS; the sandbox holds none.
  BRANCH="sbx-smoke-$(date +%s)"
  sbx_sh cred-git "$id" "set -e; rm -rf $d; git clone -q https://github.com/$CRED_REPO $d; cd $d; git -c user.name=sbx-smoke -c user.email=sbx-smoke@localhost -c commit.gpgsign=false commit -q --allow-empty -m 'sbx smoke'; git push -q origin HEAD:refs/heads/$BRANCH"
  [[ "$RC" == 0 ]] || fail "git clone / commit / push in the sandbox: exit $RC: $(lastline "$LOGS/cred-git.err")" || return 1
  sbx_sh cred-login "$id" "$SANDBOX_LOGIN"
  [[ "$RC" == 0 && "$(lastline "$LOGS/cred-login.out")" == "$owner" ]] ||
    fail "the sandbox's api.github.com/user login is not the PAT's owner (exit $RC): got '$(lastline "$LOGS/cred-login.out")' $(lastline "$LOGS/cred-login.err")" || return 1
  sbx_sh cred-delbranch "$id" "set -e; cd $d; git push -q origin --delete $BRANCH"
  [[ "$RC" == 0 ]] || fail "deleting the remote branch from the sandbox: exit $RC: $(lastline "$LOGS/cred-delbranch.err")" || return 1
  BRANCH=''
  # The placeholder is inert off the proxy.
  code="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer moca-placeholder' https://api.github.com/user 2>"$LOGS/cred-placeholder.err" </dev/null)" || true
  [[ "$code" == 401 ]] || fail "the placeholder sent from this machine to api.github.com/user got '${code:-none}', not 401" || return 1
  # User B has no credential: the same call is a 401, and a public clone works.
  if ((CRED_B)); then
    create b credentials-b || return 1
    local bid="$SBX"
    WHO=b sbx_sh cred-b-code "$bid" "$SANDBOX_CODE"
    [[ "$RC" == 0 && "$(lastline "$LOGS/cred-b-code.out")" == 401 ]] ||
      fail "user B's sandbox got '$(lastline "$LOGS/cred-b-code.out")' from api.github.com/user, not 401" || return 1
    WHO=b sbx_sh cred-b-public "$bid" 'git ls-remote https://github.com/cli/cli HEAD'
    [[ "$RC" == 0 ]] || fail "a public git ls-remote in user B's sandbox: exit $RC: $(lastline "$LOGS/cred-b-public.err")" || return 1
    release b "$bid" || return 1
  else
    echo '# step 7: second-user check skipped (no second user)'
  fi
  # Revocation: after the delete and the egress cache TTL, the sandbox is a 401.
  cred_del "$CRED_GH" || return 1
  echo "# step 7: waiting $((CRED_TTL + 5)) s for the egress credential cache..."
  job sleep $((CRED_TTL + 5))
  sbx_sh cred-revoked "$id" "$SANDBOX_CODE"
  [[ "$RC" == 0 && "$(lastline "$LOGS/cred-revoked.out")" == 401 ]] ||
    fail "after the delete and $((CRED_TTL + 5)) s the sandbox got '$(lastline "$LOGS/cred-revoked.out")' from api.github.com/user, not 401" || return 1
  if [[ "${SBX_SMOKE_GITHUB_MCP:-}" == 1 ]]; then
    cred_add "$CRED_MCP" github-mcp || return 1
    # No Authorization header from the client: the host sets it.
    sbx_sh cred-mcp "$id" "curl --http1.1 -sS -X POST https://api.githubcopilot.com/mcp/ -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"sbx-smoke\",\"version\":\"0\"}}}'"
    grep -q serverInfo "$LOGS/cred-mcp.out" ||
      fail "the github-mcp initialize without an Authorization header returned no serverInfo (exit $RC): $(lastline "$LOGS/cred-mcp.out")" || return 1
    cred_del "$CRED_MCP" || return 1
  fi
  release a "$id"
}

run_step() { # run_step N TITLE FN [ARG]
  local n="$1" title="$2" rc=0
  shift 2
  if ! want "$n"; then
    echo "ok $n - $title # SKIP not in SBX_SMOKE_STEPS"
    SKIPS=$((SKIPS + 1))
    return 0
  fi
  WHY=''
  "$@" || rc=$?
  case "$rc" in
  0) echo "ok $n - $title"; PASSES=$((PASSES + 1)) ;;
  3) echo "ok $n - $title # SKIP $WHY"; SKIPS=$((SKIPS + 1)) ;;
  *) echo "not ok $n - $title: ${WHY:-failed}"; FAILS=$((FAILS + 1)) ;;
  esac
}

run_step 1 'round trip: sbx up, run, put, pull --apply on a sample repository' step1
run_step 2 "two users: B is refused A's sandbox (404, PERMISSION_DENIED); one req_id from both gets each its own result" step2
run_step 3 'a command silent for 5 minutes completes' step3
run_step 4 'delete: the mint is refused at once; the kept token is cancelled at exp + leeway, then refused' step4
if want 5; then
  for agent in $AGENTS; do
    run_step 5 "$agent fixes the failing test through mocactl sbx mcp; the tree is unchanged until pull --apply" step5 "$agent"
  done
else
  run_step 5 'agents fix the failing test through mocactl sbx mcp' :
fi
run_step 6 "the janitor frees a deleted sandbox's directory" step6

run_step 7 'egress credentials: the PAT works from the sandbox without being in it; the placeholder is inert; delete revokes' step7

echo "# $PASSES ok, $FAILS not ok, $SKIPS skipped"
((FAILS == 0)) || exit 1
