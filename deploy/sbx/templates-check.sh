#!/usr/bin/env bash
# deploy/sbx/templates-check.sh -- check, against a deployed SBX0, that a client chooses the template
# its sandbox runs on (the template API: GET /v1/templates, POST /v1/sandboxes {template}, and the
# sandbox token's worker). It does nothing unless SBX_LIVE_CHECK=1.
#
#   SBX_LIVE_CHECK=1 SBX_API_URL=https://<api host> SBX_CHECK_HOME_A=<home> SBX_CHECK_HOME_B=<home> \
#     SBX_CHECK_TEMPLATES=default,django-django-11133 deploy/sbx/templates-check.sh
#
# Inputs, from the environment only:
#   SBX_API_URL             https://<api host>, the sandbox control plane
#   SBX_CHECK_HOME_A, _B    two HOMEs logged in as two different enrolled users (`mocactl sbx login`
#                           in each, as for the live smoke); every mocactl runs with HOME set to one
#                           of them and XDG_CONFIG_HOME / XDG_STATE_HOME unset
#   SBX_CHECK_TEMPLATES     two or more template ids, comma-separated, each served by its own worker
#   SBX_CHECK_PROBE_<ID>    optional, per template (the id upper-cased, dashes as underscores): a
#                           shell command whose stdout, in a sandbox of that template only, must be
#                           exactly `yes`. It shows the commands ran on that template's image. Run in
#                           every other template's sandboxes too, where it must print anything else.
#   SBX_CHECK_EXEC          1 (default) or 0: 0 checks the control plane alone (no worker needed):
#                           everything below except the commands in the sandboxes (4) and `sbx up`
#                           (6), which pushes into the sandbox
#   MOCACTL                 a mocactl to test (default: this checkout's packages/mocactl/dist/mocactl.mjs)
#   SBX_CHECK_PYTHON        Python 3.10+ with grpcio and grpcio-tools (default python3), for the
#                           direct-client checks (the cross-template refusal)
#
# Checks, each printing `ok N - ...`, `ok N - ... # SKIP why` or `not ok N - ...: why`:
#   1. list: `sbx templates --json` names every template in SBX_CHECK_TEMPLATES, and no worker id.
#   2. create: user A creates one sandbox of each template; each record's template is the one asked.
#      A create with an unknown template is refused, naming unknown_template, and creates nothing.
#   3. routing: each sandbox's token (`sbx env`) names a worker; the templates' workers all differ,
#      and two sandboxes of the same template share their worker but not their workspace key.
#   4. hands: (SBX_CHECK_EXEC=1) a command in each sandbox answers, and each template's probe says
#      `yes` in its own sandboxes and something else in the others'.
#   5. isolation: a token for one template's sandbox, sent with another template's worker id, is
#      PERMISSION_DENIED at the relay (direct client); user B cannot see or mint for user A's sandbox.
#   6. up: `sbx up --template T` in a repository bound to a sandbox of another template refuses.
#
# What it creates: sandboxes named tc-<run>-..., deleted at exit (an EXIT trap, also on failure or
# interrupt), and temp files, removed at exit. It never prints a token: tokens go to 0600 files.
#
# Exit: 0 every check ok or skipped; 1 a check failed; 2 a usage or settings error.
# Runs on bash 3.2 (macOS's /bin/bash) as well as bash 4+: no associative arrays, no ${v^^}.
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
if [[ "${SBX_LIVE_CHECK:-}" != 1 ]]; then
  echo "SKIP: skipped (SBX_LIVE_CHECK not set); set SBX_LIVE_CHECK=1 to check a deployed service's templates"
  exit 0
fi

die() { echo "deploy/sbx/templates-check.sh: $*" >&2; exit 2; }
[[ $# -eq 0 ]] || die "takes no arguments (got '$1'): every input is an environment variable (see --help)"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ID_RE='^sbx-[0-9a-f]{26}$'
WORKER_RE='^[A-Za-z_][A-Za-z0-9_]*$'
TEMPLATE_RE='^[a-z0-9][a-z0-9-]{0,30}$'

[[ "${SBX_API_URL:-}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] || die 'set SBX_API_URL=https://<api host>'
SBX_API_URL="${SBX_API_URL%/}"
for v in SBX_CHECK_HOME_A SBX_CHECK_HOME_B; do
  [[ -n "${!v:-}" && -d "${!v}" ]] || die "set $v to a logged-in HOME (a directory)"
done
HOME_A="$(cd "$SBX_CHECK_HOME_A" && pwd -P)" HOME_B="$(cd "$SBX_CHECK_HOME_B" && pwd -P)"
[[ "$HOME_A" != "$HOME_B" ]] || die 'SBX_CHECK_HOME_A and SBX_CHECK_HOME_B must be two different users'
TEMPLATES=()
[[ -z "${SBX_CHECK_TEMPLATES:-}" ]] || IFS=, read -ra TEMPLATES <<<"$SBX_CHECK_TEMPLATES"
((${#TEMPLATES[@]} >= 2)) || die 'set SBX_CHECK_TEMPLATES to two or more template ids, comma-separated'
for t in "${TEMPLATES[@]}"; do [[ "$t" =~ $TEMPLATE_RE ]] || die "SBX_CHECK_TEMPLATES: '$t' is not a template id"; done
EXEC="${SBX_CHECK_EXEC:-1}"
[[ "$EXEC" == 0 || "$EXEC" == 1 ]] || die 'SBX_CHECK_EXEC must be 0 or 1'
MOCACTL="${MOCACTL:-$SRC/packages/mocactl/dist/mocactl.mjs}"
[[ -f "$MOCACTL" ]] || die "no mocactl at $MOCACTL: build it (cd packages/mocactl && npm run build) or set MOCACTL"
PY="${SBX_CHECK_PYTHON:-python3}"
for t in jq git node; do command -v "$t" >/dev/null || die "needs $t on PATH"; done
probe_var() { printf 'SBX_CHECK_PROBE_%s' "$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; }

RUN="tc-$(date +%s)-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sbx-templates-check.XXXXXX")"
chmod 700 "$WORK"
LOGS="$WORK/logs"
mkdir -p "$LOGS"
FAILS=0 N=0 CREATED_A='' CREATED_B=''

as() { # as a|b ARGS...: mocactl sbx as that user
  local h="$HOME_A"
  [[ "$1" == a ]] || h="$HOME_B"
  shift
  env -u XDG_CONFIG_HOME -u XDG_STATE_HOME HOME="$h" MOCACTL_SBX_URL="$SBX_API_URL" node "$MOCACTL" sbx "$@"
}
cleanup() {
  local rc=$? id
  set +e
  for id in $CREATED_A; do as a rm --force "$id" >>"$LOGS/cleanup.log" 2>&1 </dev/null || { echo "# cleanup: could not delete $id (user A)"; rc=1; }; done
  for id in $CREATED_B; do as b rm --force "$id" >>"$LOGS/cleanup.log" 2>&1 </dev/null || { echo "# cleanup: could not delete $id (user B)"; rc=1; }; done
  # A create that succeeded but whose answer was lost: every name this run gives starts with $RUN-.
  for u in a b; do
    for id in $(as "$u" ls --json 2>/dev/null </dev/null | jq -r --arg p "$RUN-" '.[] | select((.name // "") | startswith($p)) | select(.state != "terminated") | .id' 2>/dev/null); do
      as "$u" rm --force "$id" >>"$LOGS/cleanup.log" 2>&1 </dev/null || { echo "# cleanup: could not delete stray $id"; rc=1; }
    done
  done
  if [[ "$rc" != 0 || "$FAILS" -gt 0 ]]; then
    mkdir -p "${TMPDIR:-/tmp}/sbx-templates-check-logs"
    rm -f "$WORK"/tok-*
    mv "$LOGS" "${TMPDIR:-/tmp}/sbx-templates-check-logs/$RUN" && echo "# logs kept in ${TMPDIR:-/tmp}/sbx-templates-check-logs/$RUN"
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ok() { N=$((N + 1)); echo "ok $N - $1"; }
skip() { N=$((N + 1)); echo "ok $N - $1 # SKIP $2"; }
notok() { N=$((N + 1)); FAILS=$((FAILS + 1)); echo "not ok $N - $1: $2"; }
lastline() { { grep -v '^[[:space:]]*$' "$1" 2>/dev/null || true; } | tail -n 1 | tr -cd '[:print:]' | cut -c1-200; }
x() { local n="$1"; shift; RC=0; "$@" >"$LOGS/$n.out" 2>"$LOGS/$n.err" </dev/null || RC=$?; }

echo "# SBX0 templates check: $SBX_API_URL, templates ${TEMPLATES[*]}, exec $EXEC, run $RUN"

# 1. list ------------------------------------------------------------------------------------
x templates as a templates --json
if [[ "$RC" != 0 ]]; then
  notok 'list: sbx templates' "$(lastline "$LOGS/templates.err")"
  exit 1
fi
missing=''
for t in "${TEMPLATES[@]}"; do jq -e --arg t "$t" 'any(.[]; .id == $t)' "$LOGS/templates.out" >/dev/null || missing+=" $t"; done
if [[ -n "$missing" ]]; then
  notok 'list: every template is listed' "missing:$missing"
elif jq -e 'any(.[]; has("worker"))' "$LOGS/templates.out" >/dev/null; then
  notok 'list: no worker ids' 'a template carries its worker id'
else
  ok "list: $(jq -r '[.[].id] | join(", ")' "$LOGS/templates.out") (no worker ids)"
fi

# 2. create ----------------------------------------------------------------------------------
# Per template, by its index in TEMPLATES: its first sandbox, that sandbox's worker and workspace key.
SBX1=() WRK=() WSK=()
create() { # create a|b TEMPLATE TAG -> SBX_ID
  x "create-$3" as "$1" create --template "$2" --name "$RUN-$3" --json
  SBX_ID=''
  [[ "$RC" == 0 ]] || return 1
  SBX_ID="$(jq -r '.id' "$LOGS/create-$3.out")"
  [[ "$SBX_ID" =~ $ID_RE ]] || { SBX_ID=''; return 1; }
  if [[ "$1" == a ]]; then CREATED_A+=" $SBX_ID"; else CREATED_B+=" $SBX_ID"; fi
  [[ "$(jq -r '.template' "$LOGS/create-$3.out")" == "$2" ]]
}
bad=''
for i in "${!TEMPLATES[@]}"; do
  t="${TEMPLATES[$i]}"
  create a "$t" "$t-1" || bad+=" $t: $(lastline "$LOGS/create-$t-1.err")"
  SBX1[i]="$SBX_ID"
done
if [[ -n "$bad" ]]; then notok 'create: one sandbox per template, each recording its template' "$bad"; exit 1; fi
before="$(as a ls --json </dev/null | jq length)"
x create-unknown as a create --template "no-such-template-$$" --name "$RUN-unknown" --json
after="$(as a ls --json </dev/null | jq length)"
if [[ "$RC" == 0 ]]; then
  notok 'create: an unknown template is refused' 'it was accepted'
elif ! grep -q 'unknown_template\|no such template' "$LOGS/create-unknown.err" "$LOGS/create-unknown.out"; then
  notok 'create: an unknown template is refused, naming unknown_template' "$(lastline "$LOGS/create-unknown.err")"
elif [[ "$before" != "$after" ]]; then
  notok 'create: an unknown template creates nothing' "sandboxes $before before, $after after"
else
  ok "create: one sandbox per template, each recording its template; an unknown template is refused ($(lastline "$LOGS/create-unknown.err"))"
fi

# 3. routing ---------------------------------------------------------------------------------
envof() { # envof a|b ID -> E_ADDR E_TLS E_WRK E_WSK E_CA
  local f="$LOGS/env-$2.out" k v
  x "env-$2" as "$1" env "$2"
  [[ "$RC" == 0 ]] || return 1
  for k in ADDR:SBX_ADDR TLS:SBX_TLS WRK:SBX_SANDBOX_ID WSK:SBX_WORKSPACE_KEY CA:SBX_CA_FILE; do
    v="$(sed -n "s/^export ${k#*:}='\(.*\)'\$/\1/p" "$f")"
    printf -v "E_${k%%:*}" '%s' "$v"
  done
  [[ "$E_WRK" =~ $WORKER_RE && "$E_WSK" =~ $ID_RE ]]
}
bad=''
for i in "${!TEMPLATES[@]}"; do
  t="${TEMPLATES[$i]}"
  if envof a "${SBX1[$i]}"; then WRK[i]="$E_WRK"; WSK[i]="$E_WSK"; else bad+=" $t: $(lastline "$LOGS/env-${SBX1[$i]}.err")"; fi
done
if [[ -n "$bad" ]]; then
  notok 'routing: each sandbox names its worker' "$bad"
else
  distinct="$(printf '%s\n' "${WRK[@]}" | sort -u | wc -l | tr -d ' ')"
  t0="${TEMPLATES[0]}"
  create a "$t0" "$t0-2" || true
  if [[ "$distinct" != "${#TEMPLATES[@]}" ]]; then
    notok 'routing: every template has its own worker' "workers: ${WRK[*]}"
  elif [[ -z "$SBX_ID" ]] || ! envof a "$SBX_ID"; then
    notok "routing: a second $t0 sandbox" "$(lastline "$LOGS/create-$t0-2.err")"
  elif [[ "$E_WRK" != "${WRK[0]}" || "$E_WSK" == "${WSK[0]}" ]]; then
    notok "routing: two $t0 sandboxes share their worker, not their workspace" "worker $E_WRK vs ${WRK[0]}, workspace $E_WSK vs ${WSK[0]}"
  else
    pairs=''
    for i in "${!TEMPLATES[@]}"; do pairs+=" ${TEMPLATES[$i]}->${WRK[$i]}"; done
    ok "routing: each template's sandboxes go to its own worker:$pairs; two $t0 sandboxes share it, with their own workspaces"
  fi
fi

# 4. hands -----------------------------------------------------------------------------------
if [[ "$EXEC" != 1 ]]; then
  skip 'hands: a command in each sandbox, and each template'"'"'s probe' 'SBX_CHECK_EXEC=0 (the control plane alone)'
else
  bad='' seen=''
  for i in "${!TEMPLATES[@]}"; do
    t="${TEMPLATES[$i]}"
    x "hello-$t" as a run --sandbox "${SBX1[$i]}" --timeout 300 -- sh -c 'echo "hello $(cat /etc/moca-rootfs-source 2>/dev/null | tr "\n" " ")"'
    if [[ "$RC" != 0 ]] || ! grep -q '^hello' "$LOGS/hello-$t.out"; then
      bad+=" $t: exit $RC, $(lastline "$LOGS/hello-$t.err")"
      continue
    fi
    seen+=" $t=[$(sed -n 's/^hello //p' "$LOGS/hello-$t.out" | grep -o 'digest=sha256:[0-9a-f]\{12\}' | head -1)]"
    for p in "${TEMPLATES[@]}"; do
      pv="$(probe_var "$p")"
      [[ -n "${!pv:-}" ]] || continue
      x "probe-$p-on-$t" as a run --sandbox "${SBX1[$i]}" --timeout 300 -- sh -c "${!pv}"
      got="$(tr -d '\r' <"$LOGS/probe-$p-on-$t.out" | tail -n 1)"
      if [[ "$p" == "$t" && "$got" != yes ]]; then bad+=" $p's probe in its own sandbox printed '$got'"; fi
      if [[ "$p" != "$t" && "$got" == yes ]]; then bad+=" $p's probe also said yes in a $t sandbox"; fi
    done
  done
  if [[ -n "$bad" ]]; then notok 'hands: the commands ran on each template'"'"'s own image' "$bad"; else ok "hands: each sandbox answers on its template's image:$seen"; fi
fi

# 5. isolation -------------------------------------------------------------------------------
t0="${TEMPLATES[0]}" t1="${TEMPLATES[1]}"
if ! "$PY" -c 'import grpc, grpc_tools' 2>/dev/null; then
  skip 'isolation: cross-template refusal at the relay' "$PY has no grpcio and grpcio-tools"
else
  mkdir -p "$WORK/py"
  "$PY" -m grpc_tools.protoc -I "$SRC/proto" --python_out="$WORK/py" --grpc_python_out="$WORK/py" sandbox/v1/sandbox.proto >"$LOGS/protoc.log" 2>&1
  (umask 077; as a token "${SBX1[0]}" >"$WORK/tok-a" 2>"$LOGS/token-a.err" </dev/null) || true
  envof a "${SBX1[0]}" || true
  ca="$E_CA"; [[ -n "$ca" ]] || ca=-
  # The token for t0's sandbox, sent with t1's worker id and t0's own workspace key.
  "$PY" - "$WORK/py" "$SRC/docs/api/examples" "$WORK/tok-a" "$E_ADDR" "${WRK[1]:-}" "${WSK[0]:-}" "${E_TLS:-1}" "$ca" \
    >"$LOGS/cross.out" 2>"$LOGS/cross.err" <<'PY' || true
import sys
sys.path[:0] = sys.argv[1:3]
import grpc
from sandbox_v1_client import Sandbox, TokenSource
tok, addr, wrk, wsk, tls, ca = open(sys.argv[3]).read().strip(), *sys.argv[4:9]
sbx = Sandbox(addr, wrk, wsk, TokenSource(static=tok), tls=tls == "1", ca_file=None if ca == "-" else ca)
try:
    sbx._exec(1, "true", b"", 30, [("authorization", f"Bearer {tok}")])
    print("outcome=end")
except grpc.RpcError as e:
    print(f"outcome=rpc code={e.code().name}")
except Exception as e:
    print(f"outcome=error {type(e).__name__}: {str(e)[:160]}")
PY
  rm -f "$WORK/tok-a"
  if grep -q 'PERMISSION_DENIED' "$LOGS/cross.out" "$LOGS/cross.err"; then
    ok "isolation: a $t0 sandbox's token sent to $t1's worker (${WRK[1]:-}) is PERMISSION_DENIED"
  else
    notok "isolation: a $t0 sandbox's token sent to $t1's worker is refused" "$(lastline "$LOGS/cross.out") $(lastline "$LOGS/cross.err")"
  fi
fi
x b-get as b env "${SBX1[0]}"
rcget="$RC"
x b-tok as b token "${SBX1[0]}"
if [[ "$rcget" != 0 && "$RC" != 0 ]] && grep -q 'no such sandbox' "$LOGS/b-get.err" "$LOGS/b-tok.err"; then
  ok "isolation: user B gets 'no such sandbox' for user A's $t0 sandbox (env and token)"
else
  notok "isolation: user B cannot reach user A's sandbox" "env exit $rcget, token exit $RC: $(lastline "$LOGS/b-tok.err")"
fi
rm -f "$LOGS/b-tok.out"

# 6. up --------------------------------------------------------------------------------------
# `sbx up` pushes the working tree, a command in the sandbox: it needs a worker.
if [[ "$EXEC" != 1 ]]; then
  skip "up: sbx up --template refuses a bound sandbox of another template" 'SBX_CHECK_EXEC=0 (up pushes into the sandbox)'
  echo "# $N checks, $FAILS failed"
  ((FAILS == 0)) || exit 1
  exit 0
fi
repo="$WORK/repo"
git init -q "$repo" && (cd "$repo" && git config user.email tc@example.invalid && git config user.name tc &&
  echo x >f && git add f && git commit -qm init)
x up1 sh -c "cd '$repo' && exec env -u XDG_CONFIG_HOME -u XDG_STATE_HOME HOME='$HOME_A' MOCACTL_SBX_URL='$SBX_API_URL' node '$MOCACTL' sbx up --template '$t0' --name '$RUN-up' --no-agent-config"
upid="$(jq -r '.id // empty' "$repo/.sbx/sandbox.json" 2>/dev/null || true)"
[[ -z "$upid" ]] || CREATED_A+=" $upid"
if [[ "$RC" != 0 || -z "$upid" ]]; then
  notok "up: sbx up --template $t0" "$(lastline "$LOGS/up1.err")"
else
  x up2 sh -c "cd '$repo' && exec env -u XDG_CONFIG_HOME -u XDG_STATE_HOME HOME='$HOME_A' MOCACTL_SBX_URL='$SBX_API_URL' node '$MOCACTL' sbx up --template '$t1' --no-agent-config"
  if [[ "$RC" != 0 ]] && grep -q "has template $t0, not $t1" "$LOGS/up2.err" "$LOGS/up2.out"; then
    ok "up: a repository bound to a $t0 sandbox refuses sbx up --template $t1"
  else
    notok "up: sbx up --template $t1 on a $t0-bound repository is refused" "exit $RC: $(lastline "$LOGS/up2.err")"
  fi
fi

echo "# $N checks, $FAILS failed"
((FAILS == 0)) || exit 1
