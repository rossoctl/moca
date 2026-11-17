#!/usr/bin/env bash
# deploy/sbx/status.sh -- the SBX0 operator's status view
# (docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md §8.4). Read-only: it reports, and
# changes nothing.
#
#   deploy/sbx/status.sh [--env-file FILE]                    the cluster side (kubectl)
#   sudo deploy/sbx/status.sh --host [--token-ttl-seconds N] [--max-lifetime-seconds N]
#                                                             on a KVM host
#
# The cluster side reads setup.sh's own env file (SBX_NAMESPACE, SBX_WORKERS) and, optionally,
# SBX_STATUS_HOSTS: ssh targets ([user@]host, whitespace-separated) on which it also runs the host
# side, by piping this script to `ssh TARGET sudo -n bash -s -- --host ...` (no checkout needed on
# the host; the ssh user needs passwordless sudo). It prints one `key: value` line each for:
#   - token lifetime: SH_SANDBOX_TOKEN_TTL_SECONDS from the sbx-settings ConfigMap;
#   - workers attached / not attached: each SBX_WORKERS id with a presence record in Redis's
#     sh:sandbox:records hash (the relay writes one per attached worker), and any record whose id is
#     not in SBX_WORKERS;
#   - sandboxes live: ZCOUNT sbx:live (<now> +inf (not deleted, not expired);
#   - sandboxes terminated (retained, approx.): ZCARD sbx:all minus live. Approximate: sbx:all drops
#     an id only when a listing finds its record gone after retention;
#   - exec last hour: from the relay's audit lines (`"audit":"sandbox_exec"`, spec §3.5) over
#     `kubectl logs --since=1h`. A call is an Exec the relay routed: outcome end, error, timeout,
#     expired or cancelled. p50 and p95 are nearest-rank over the calls' `ms`. The error rate counts
#     outcome `error` only (machinery: no live worker, a disconnect, a worker ExecError); a non-zero
#     exit code is the command's own result. Timeouts, token expiries and cancels are listed
#     apart ("cut short"), and so are refusals and busy refusals, which never reached a worker;
#   - then, for each SBX_STATUS_HOSTS target, the host side's lines prefixed `host TARGET `.
#
# The host side (root: it reads /etc/sbx/janitor.env, 0600, and the system journal) prints:
#   - unit sbx-worker@<id>.service and unit sbx-janitor.timer: `systemctl is-active`;
#   - workspace filesystem: `df -hP $SBX_SRV/workspaces`;
#   - janitor last run: its last summary (or skipped) line in the journal;
#   - janitor wait: SBX_JANITOR_AGE from the INSTALLED janitor.env, with a WARNING when it does not
#     exceed --token-ttl-seconds + 30 s (spec §8.1, §8.3). setup.sh refuses such a wait, but only
#     for the bundle it writes: a host still running an older bundle after SBX_TOKEN_TTL_MINUTES was
#     raised would free workspaces a valid token can still reach. The cluster side passes the
#     current lifetime.
#   - worker idle <id>: SH_WORKSPACE_IDLE from each INSTALLED workers/<id>.env, with a WARNING when
#     it does not exceed --max-lifetime-seconds: a worker whose idle is not above the longest
#     lifetime a sandbox can have may reclaim a live sandbox's workspace (#770). setup.sh refuses
#     such an idle for the bundles it writes; a host not reinstalled afterwards still runs the old
#     one. The cluster side passes SH_SANDBOX_MAX_LIFETIME_SECONDS (or, as the control plane does
#     when it is unset, SH_SANDBOX_LIFETIME_SECONDS).
# SBX_ENV_DIR and SBX_SRV default to /etc/sbx and /srv/sbx, as install-host.sh's do.
#
# Exit: 0 whenever it could report, even when something was unreachable (that is reported as
# `unavailable` or `unreachable`); 2 for a usage or settings error.
set -euo pipefail

USAGE='status.sh [--env-file FILE] | status.sh --host [--token-ttl-seconds N] [--max-lifetime-seconds N]'
die() { echo "deploy/sbx/status.sh: $*" >&2; exit 2; }
say() { printf '%s: %s\n' "$1" "$2"; }

# ---------------------------------------------------------------------------------------------
# The host side. Self-contained (no lib.sh): it also runs as a script piped over ssh.

env_value() { # env_value KEY FILE: the last KEY=... line's value
  local line v=''
  while IFS= read -r line || [[ -n "$line" ]]; do [[ "$line" != "$1="* ]] || v="${line#*=}"; done <"$2"
  printf '%s' "$v"
}

host_units() {
  local units u state
  units="$(systemctl list-units --all --plain --no-legend --no-pager 'sbx-worker@*' </dev/null 2>/dev/null | awk '{print $1}')" || units=''
  [[ -n "$units" ]] || say 'unit sbx-worker@*' 'none loaded'
  for u in $units; do
    [[ "$u" =~ ^sbx-worker@[A-Za-z0-9_]+\.service$ ]] || continue
    state="$(systemctl is-active "$u" </dev/null 2>/dev/null)" || true
    say "unit $u" "${state:-unknown}"
  done
  state="$(systemctl is-active sbx-janitor.timer </dev/null 2>/dev/null)" || true
  say 'unit sbx-janitor.timer' "${state:-unknown}"
}

host_disk() {
  local root="$SBX_SRV/workspaces" line
  [[ -d "$root" ]] || { say 'workspace filesystem' "unavailable (no $root)"; return 0; }
  line="$(df -hP "$root" </dev/null 2>/dev/null | awk 'NR == 2')" || line=''
  # Filesystem Size Used Avail Use% Mounted-on (POSIX format: one line per filesystem).
  # shellcheck disable=SC2086 # split into df's columns
  set -- $line
  (($# >= 6)) || { say 'workspace filesystem' 'unavailable (df failed)'; return 0; }
  local size="$2" used="$3" avail="$4" pct="$5"
  shift 5
  say 'workspace filesystem' "$pct used, $used of $size ($avail free) on $*"
}

host_janitor() {
  local last ttl="$1" env="$SBX_ENV_DIR/janitor.env" age
  last="$(journalctl -u sbx-janitor -o cat -n 200 --no-pager </dev/null 2>/dev/null |
    grep -E '^\{"janitor":"(summary|skipped)"' | tail -1)" || last=''
  say 'janitor last run' "${last:-none in the journal}"
  # A run that refused its settings (a bad token mode or URL) writes no JSON line, so the line above
  # would still show the last good one: the service's own result says whether the latest failed.
  local result started
  result="$(systemctl show sbx-janitor.service -p Result --value </dev/null 2>/dev/null)" || result=''
  started="$(systemctl show sbx-janitor.service -p ExecMainStartTimestamp --value </dev/null 2>/dev/null)" || started=''
  if [[ -n "$result" && "$result" != success ]]; then
    say 'janitor service' "latest run ${started:+at $started }FAILED ($result): journalctl -u sbx-janitor -n 20 says why"
  else
    say 'janitor service' "${result:-unknown}${started:+, last started $started}"
  fi
  if [[ ! -f "$env" ]]; then
    say 'janitor wait' 'not installed'
    return 0
  fi
  age="$(env_value SBX_JANITOR_AGE "$env")"
  # Decimal without a leading zero, as the janitor itself requires (bash reads 03600 as octal).
  if [[ ! "$age" =~ ^(0|[1-9][0-9]{0,8})$ ]]; then
    say 'janitor wait' "unreadable (SBX_JANITOR_AGE in $env is not whole seconds)"
  elif [[ -z "$ttl" ]]; then
    say 'janitor wait' "$age s (not checked: the token lifetime is unknown; pass --token-ttl-seconds, or run status.sh from the cluster side)"
  elif ((age > ttl + 30)); then
    say 'janitor wait' "$age s (outlasts the token lifetime $ttl s + 30 s)"
  else
    say 'janitor wait' "$age s; WARNING: not above the token lifetime $ttl s + 30 s, so the janitor can free a workspace a valid token still reaches: re-run deploy/sbx/setup.sh, then install-host.sh --janitor with the new janitor bundle on this host"
  fi
}

host_worker_idle() {
  local max="$1" f id idle h
  for f in "$SBX_ENV_DIR"/workers/*.env; do
    [[ -f "$f" ]] || continue
    id="$(basename "$f" .env)"
    idle="$(env_value SH_WORKSPACE_IDLE "$f")"
    if ! grep -q '^SH_WORKSPACE_IDLE=' "$f" </dev/null; then
      say "worker idle $id" "missing (no SH_WORKSPACE_IDLE in $f)"
      continue
    # Whole hours without a leading zero, as install-host.sh writes them.
    elif [[ ! "$idle" =~ ^[1-9][0-9]{0,5}h$ ]]; then
      say "worker idle $id" "unreadable (SH_WORKSPACE_IDLE in $f is not whole hours)"
      continue
    fi
    h="${idle%h}"
    if [[ -z "$max" ]]; then
      say "worker idle $id" "$idle (not checked: the longest lifetime is unknown; pass --max-lifetime-seconds, or run status.sh from the cluster side)"
    elif ((h * 3600 > max)); then
      say "worker idle $id" "$idle (outlasts the longest lifetime $max s)"
    else
      say "worker idle $id" "$idle; WARNING: not above the longest lifetime $max s, so this worker can reclaim a live sandbox's workspace: re-run deploy/sbx/install-host.sh with the current bundle"
    fi
  done
}

host_main() {
  local ttl='' max=''
  while (($#)); do
    case "$1" in
    --token-ttl-seconds)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]{0,5}$ ]] || die '--token-ttl-seconds needs whole seconds'
      ttl="$2"
      shift 2
      ;;
    --max-lifetime-seconds)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]{0,8}$ ]] || die '--max-lifetime-seconds needs whole seconds'
      max="$2"
      shift 2
      ;;
    *) die "unknown argument: $1 (usage: $USAGE)" ;;
    esac
  done
  : "${SBX_ENV_DIR:=/etc/sbx}" "${SBX_SRV:=/srv/sbx}"
  host_units
  host_disk
  host_janitor "$ttl"
  host_worker_idle "$max"
}

# ---------------------------------------------------------------------------------------------
# The cluster side.

redis() { kubectl exec -n "$NS" statefulset/redis -c redis -- redis-cli "$@" </dev/null 2>/dev/null; }

cluster_settings() {
  local json
  TTL='' MAXLIFE=''
  if json="$(kubectl get configmap sbx-settings -n "$NS" -o json </dev/null 2>/dev/null)"; then
    TTL="$(printf '%s' "$json" | jq -r '.data.SH_SANDBOX_TOKEN_TTL_SECONDS // empty' 2>/dev/null)" || TTL=''
    # The control plane falls back to SH_SANDBOX_LIFETIME_SECONDS when the maximum is unset.
    MAXLIFE="$(printf '%s' "$json" | jq -r '.data.SH_SANDBOX_MAX_LIFETIME_SECONDS // .data.SH_SANDBOX_LIFETIME_SECONDS // empty' 2>/dev/null)" || MAXLIFE=''
    [[ "$MAXLIFE" =~ ^[1-9][0-9]{0,8}$ ]] || MAXLIFE=''
  fi
  if [[ "$TTL" =~ ^[1-9][0-9]{0,5}$ ]]; then
    say 'token lifetime' "$TTL s"
  else
    TTL=''
    say 'token lifetime' 'unavailable (kubectl get configmap sbx-settings failed)'
  fi
}

cluster_workers() {
  local keys k on='' off='' stray=''
  local why='unavailable (kubectl exec redis-cli failed)'
  if ! keys="$(redis HKEYS sh:sandbox:records)"; then
    say 'workers attached' "$why"
    return 0
  fi
  for k in $keys; do
    [[ "$k" =~ $WORKER_RE ]] || { say 'workers attached' "$why"; return 0; }
  done
  for k in $SBX_WORKERS; do
    if [[ $'\n'"$keys"$'\n' == *$'\n'"$k"$'\n'* ]]; then on+=" $k"; else off+=" $k"; fi
  done
  for k in $keys; do [[ " $SBX_WORKERS " == *" $k "* ]] || stray+=" $k"; done
  on="${on# }" off="${off# }"
  say 'workers attached' "${on:-none}"
  say 'workers not attached' "${off:-none}"
  [[ -z "$stray" ]] || say 'workers attached, not in SBX_WORKERS' "${stray# }"
}

cluster_sandboxes() {
  local now live all why='unavailable (kubectl exec redis-cli failed)'
  now="$(date +%s)"
  live="$(redis ZCOUNT sbx:live "($now" +inf)" || live=''
  all="$(redis ZCARD sbx:all)" || all=''
  if [[ "$live" =~ ^[0-9]+$ ]]; then say 'sandboxes live' "$live"; else say 'sandboxes live' "$why"; fi
  if [[ "$live" =~ ^[0-9]+$ && "$all" =~ ^[0-9]+$ ]]; then
    local t=$((10#$all - 10#$live))
    ((t >= 0)) || t=0
    say 'sandboxes terminated (retained, approx.)' "$t"
  else
    say 'sandboxes terminated (retained, approx.)' "$why"
  fi
}

# The relay's stdout mixes non-JSON lines with the audit lines: grep pre-filters on the marker, and
# jq keeps only the lines that parse as an Exec audit object.
EXEC_STATS='
  [inputs | fromjson? | select(type == "object" and .audit == "sandbox_exec")] as $all
  | ($all | map(select(.outcome | IN("end", "error", "timeout", "expired", "cancelled")))) as $calls
  | ($calls | map(.ms | numbers) | sort) as $ms
  | def pct($q): $ms[((($q * ($ms | length)) | ceil) - 1)];
    def count($o): [$all[] | select(.outcome == $o)] | length;
  (if ($calls | length) == 0 then "0 calls"
   else "\($calls | length) calls, p50 \(pct(0.5)) ms, p95 \(pct(0.95)) ms, errors \(((100 * count("error") / ($calls | length)) + 0.5) | floor)%"
   end),
  "\(count("refused")) refused, \(count("busy")) busy",
  "\(count("timeout")) timeout, \(count("expired")) expired, \(count("cancelled")) cancelled"'

cluster_exec() {
  local log stats
  if ! log="$(kubectl logs deployment/sandbox-relay -c sandbox-relay -n "$NS" --since=1h </dev/null 2>/dev/null)"; then
    say 'exec last hour' 'unavailable (kubectl logs failed)'
    return 0
  fi
  stats="$(printf '%s\n' "$log" | { grep -F '"audit":"sandbox_exec"' || true; } | jq -R -n -r "$EXEC_STATS")" ||
    { say 'exec last hour' 'unavailable (the audit lines did not parse)'; return 0; }
  local calls refused cut
  { IFS= read -r calls; IFS= read -r refused; IFS= read -r cut; } <<<"$stats" || true
  say 'exec last hour' "$calls"
  say 'exec refused last hour' "$refused"
  say 'exec cut short last hour' "$cut"
}

HOST_TARGET_RE='^([A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$'

cluster_hosts() {
  local t rc remote err self="${BASH_SOURCE[0]:-}"
  [[ -n "${SBX_STATUS_HOSTS:-}" ]] || return 0
  remote='sudo -n bash -s -- --host'
  [[ -z "$TTL" ]] || remote+=" --token-ttl-seconds $TTL"
  [[ -z "$MAXLIFE" ]] || remote+=" --max-lifetime-seconds $MAXLIFE"
  err="$(mktemp)"
  for t in $SBX_STATUS_HOSTS; do
    rc=0
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$t" "$remote" <"$self" 2>"$err" | sed "s/^/host $t /" || rc=$?
    if ((rc == 255)); then
      say "host $t" 'unreachable (ssh exit 255)'
    elif ((rc != 0)); then
      say "host $t" "failed (exit $rc): $(head -1 "$err" | tr -cd '[:print:]')"
    fi
  done
  rm -f "$err"
}

cluster_main() {
  local SBX_DIR
  SBX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # parse_args (--env-file), WORKER_RE and NS_RE, shared with setup.sh.
  # shellcheck source=deploy/sbx/lib.sh
  . "$SBX_DIR/lib.sh"
  parse_args "$@"
  [[ "${SBX_NAMESPACE:-}" =~ $NS_RE ]] || die 'SBX_NAMESPACE is required and must be a namespace name (setup.sh --env-file FILE)'
  [[ -n "${SBX_WORKERS:-}" ]] || die 'SBX_WORKERS is required: the template worker ids, as given to setup.sh'
  local w
  for w in $SBX_WORKERS; do [[ "$w" =~ $WORKER_RE ]] || die "worker id '$w' must match $WORKER_RE"; done
  for w in ${SBX_STATUS_HOSTS:-}; do
    [[ "$w" =~ $HOST_TARGET_RE ]] || die "SBX_STATUS_HOSTS entry '$w' is not an ssh target ([user@]host)"
  done
  for w in kubectl jq; do command -v "$w" >/dev/null || die "needs $w on PATH"; done
  NS="$SBX_NAMESPACE"
  cluster_settings
  cluster_workers
  cluster_sandboxes
  cluster_exec
  cluster_hosts
}

if [[ "${1:-}" == --host ]]; then
  shift
  host_main "$@"
else
  cluster_main "$@"
fi
