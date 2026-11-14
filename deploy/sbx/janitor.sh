#!/usr/bin/env bash
# deploy/sbx/janitor.sh -- free the disk of ended SBX0 sandboxes on this KVM host
# (docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md §8.3). Run by sbx-janitor.timer,
# installed by `deploy/sbx/install-host.sh --janitor BUNDLE_DIR`.
#
# Environment (the unit sets it from /etc/sbx/janitor.env):
#   SBX_API_URL             https://<api host>, the control plane
#   SBX_JANITOR_TOKEN_FILE  default $SBX_ENV_DIR/janitor.token: the bearer, SH_JANITOR_TOKEN (32+
#                           characters), alone in a file owned by the running user, no group or
#                           other permission bits (0600)
#   SBX_JANITOR_AGE         seconds after a sandbox ends before its workspace is freed (setup.sh
#                           makes it exceed the token lifetime plus the 30 s leeway)
#   SBX_API_CA_FILE         optional; the CA to verify the API Route with
#   SBX_SRV                 default /srv/sbx: workspace roots are $SBX_SRV/workspaces/<worker>
#   SBX_ENV_DIR             default /etc/sbx: this host's workers are $SBX_ENV_DIR/workers/<id>.env
#
# One GET /v1/janitor/sandboxes ({live, terminated}) decides everything. In each worker's root it
# frees, by rename to .reclaiming-<wsk>-<ts> and then removal (the worker's own detach pattern, so
# no workspace key can reach the tree being removed):
#   - a sandbox terminated more than SBX_JANITOR_AGE ago, when the root is that record's worker's
#     and the worker is installed here;
#   - an UNKNOWN directory (named as a workspace key, in neither list) whose newest mtime (the
#     directory's or its workspace.img's) is older than that worker's SH_WORKSPACE_IDLE: no live
#     sandbox can be that stale (spec §5.4.1), even if the control plane lost its records;
#   - .reclaiming-* trees older than one hour, left by a crashed worker or janitor. The age is the
#     time in the name (the janitor's .reclaiming-<wsk>-<s>, the worker's .reclaiming-<key>-<ns>-<n>),
#     never the mtime, which a rename keeps; a name without one falls back to the ctime.
# With a workspace it frees, it removes the worker's lease state file for that key,
# .lease-state/<wsk>.json in the same root; and the state file of a sandbox terminated more than
# SBX_JANITOR_AGE ago whose workspace is already gone (the worker's own idle reclaim keeps the file:
# the sandbox still existed). Only a regular file in a real .lease-state directory, with rm -f; the
# worker never writes a removed one back (retireLeaseState in remote-worker/internal/vmpool).
#
# Every number read (the wait, terminatedAt, SH_WORKSPACE_IDLE, stat and date output) is matched
# as decimal digits without a leading zero, or forced to base 10, before any arithmetic: bash reads
# 03600 as octal.
# Everything else stays: a live sandbox (live wins over any terminated record), a recent
# termination, a newer unknown directory (reported), a known one in another worker's root, the
# worker's _probe key and any other name that is not a workspace key, symlinks and what they point
# to, and every tree of a worker with no usable env file. When the control plane cannot be asked,
# or answers anything but the expected shape, NOTHING is touched.
#
# Output: one JSON line per action or anomaly, then exactly one summary line
# {"janitor":"summary","ts","examined","removed","unknown","bytes_freed","errors"}; or, when it did
# nothing, one {"janitor":"skipped","ts","why"} line. A refusal of its own settings (exit 2) writes
# neither, only its reason on stderr: status.sh reads the service's result for that. The token never reaches argv or the log: curl reads it
# from a 0600 header file (-H @file).
set -euo pipefail
shopt -s nullglob
export LC_ALL=C # byte semantics for every regex and glob below: no locale widens a character range

# Spelled out, not ranges: a workspace key is the sandbox id (the control plane's SANDBOX_ID_RE).
KEY_RE='^sbx-[0123456789abcdef]{26}$'
WORKER_RE='^[A-Za-z_][A-Za-z0-9_]*$'     # a worker id (setup.sh, install-host.sh)
TOMB_RE='^\.reclaiming-[A-Za-z0-9._-]+$' # a tombstone: no '/', so always directly in its root
TOMB_AGE_S=3600

say() { printf '%s\n' "$*"; }
refuse() { echo "sbx-janitor: $*" >&2; exit 2; }

declare -A ROOT=()      # worker id -> its validated workspace root (realpath); safe to remove tombstones in
declare -A INSTALLED=() # worker id -> 1 when its env file is here and names that root
declare -A IDLE_S=()    # worker id -> its SH_WORKSPACE_IDLE in seconds
declare -A LEASE_DIR=() # worker id -> its root's .lease-state, when an installed root has a real one
declare -A KNOWN=()     # wsk -> 1 for every live or terminated record
declare -A LIVE=()      # wsk -> 1 for every live record
declare -A RECLAIM=()   # "<wrk>/<wsk>" -> 1: terminated more than SBX_JANITOR_AGE ago
EXAMINED=0 REMOVED=0 UNKNOWN=0 FREED=0 ERRORS=0

error() { # error WRK WSK WHY: count and report an anomaly; never fatal
  ERRORS=$((ERRORS + 1))
  say "{\"janitor\":\"error\",\"wrk\":\"$1\",\"wsk\":\"$2\",\"why\":\"$3\"}"
}

env_value() { # env_value KEY FILE: the last KEY=... line's value, without grep
  local line v=''
  while IFS= read -r line || [[ -n "$line" ]]; do [[ "$line" != "$1="* ]] || v="${line#*=}"; done <"$2"
  printf '%s' "$v"
}

check_settings() {
  local t
  for t in jq curl realpath stat du mktemp mv rm date id; do command -v "$t" >/dev/null || refuse "needs $t on PATH"; done
  # The flavour of stat and rm, once: GNU (the host) or BSD (a developer's Mac running the tests).
  if stat -c %Y / >/dev/null 2>&1; then
    STAT=(stat -c %Y) STAT_CTIME=(stat -c %Z) STAT_MODE=(stat -c '%a %u')
  else
    STAT=(stat -f %m) STAT_CTIME=(stat -f %c) STAT_MODE=(stat -f '%Lp %u')
  fi
  pick_mv
  if rm --version >/dev/null 2>&1; then RM=(rm -rf --one-file-system); else RM=(rm -rfx); fi
  # `-`, not `:-`: an EMPTY SBX_SRV is refused, not silently replaced by the default.
  SBX_SRV="${SBX_SRV-/srv/sbx}"
  SBX_ENV_DIR="${SBX_ENV_DIR-/etc/sbx}"
  while [[ "$SBX_SRV" == */ && "$SBX_SRV" != / ]]; do SBX_SRV="${SBX_SRV%/}"; done
  # Absolute, at least one component, none of them `.`, `..` or hidden: `/`, `//`, `/srv/..` and a
  # relative path are refused before any path is built from it.
  [[ "$SBX_SRV" =~ ^(/[A-Za-z0-9_][A-Za-z0-9._-]*)+$ ]] ||
    refuse "refusing the workspace root SBX_SRV='$SBX_SRV': it must be an absolute path other than / (no '.' or '..' components)"
  if [[ -e "$SBX_SRV" ]]; then
    SRV_REAL="$(realpath "$SBX_SRV")"
    [[ "$SRV_REAL" =~ ^(/[^/]+)+$ ]] || refuse "refusing SBX_SRV='$SBX_SRV': it resolves to '$SRV_REAL'"
  else
    SRV_REAL=''
  fi
  [[ "$SBX_ENV_DIR" == /* && "$SBX_ENV_DIR" != / ]] || refuse "SBX_ENV_DIR='$SBX_ENV_DIR' must be an absolute directory"
  [[ "${SBX_API_URL:-}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || refuse 'SBX_API_URL must be https://<api host>'
  : "${SBX_JANITOR_AGE:=3600}"
  # No leading zero: (( )) would read 03600 as octal (1920 s), and 0900 not at all.
  [[ "$SBX_JANITOR_AGE" =~ ^(0|[1-9][0-9]{0,8})$ ]] ||
    refuse "SBX_JANITOR_AGE='$SBX_JANITOR_AGE' must be whole seconds, in decimal without a leading zero"
  AGE_S=$((10#$SBX_JANITOR_AGE))
  : "${SBX_JANITOR_TOKEN_FILE:=$SBX_ENV_DIR/janitor.token}"
  [[ -f "$SBX_JANITOR_TOKEN_FILE" && -r "$SBX_JANITOR_TOKEN_FILE" ]] || refuse 'SBX_JANITOR_TOKEN_FILE must name a readable file'
  local mode_owner
  mode_owner="$("${STAT_MODE[@]}" "$SBX_JANITOR_TOKEN_FILE" 2>/dev/null)" || refuse "cannot stat $SBX_JANITOR_TOKEN_FILE"
  [[ "$mode_owner" =~ ^[0-7]*[0-7]00\ ([0-9]+)$ && "${BASH_REMATCH[1]}" == "$(id -u)" ]] ||
    refuse "$SBX_JANITOR_TOKEN_FILE must be owned by uid $(id -u) with no group or other access (chmod 600); it is: mode/uid $mode_owner"
  [[ "$(<"$SBX_JANITOR_TOKEN_FILE")" =~ ^[!-~]{32,}$ ]] ||
    refuse "$SBX_JANITOR_TOKEN_FILE does not hold a token of 32+ printable characters"
  [[ -z "${SBX_API_CA_FILE:-}" || (-f "$SBX_API_CA_FILE" && -r "$SBX_API_CA_FILE") ]] ||
    refuse 'SBX_API_CA_FILE must name a readable file'
  NOW="$(date +%s)"
  [[ "$NOW" =~ ^[1-9][0-9]{0,11}$ ]] || refuse "date +%s gave '$NOW'"
}

# pick_mv: MV, the rename that never follows a symlink planted at its target, found by trying it:
# in a fresh mktemp -d, each candidate (-T, GNU; -h, BSD) must rename a directory to a new name, and
# must leave the directory a symlink at the target points to empty. Neither works: refuse, before
# anything else. The probe is cleaned with rmdir and rm -f, never a recursive removal.
pick_mv() {
  local probe f n=0 d v ok=''
  probe="$(mktemp -d)" || refuse 'mktemp -d failed (needed to probe mv)'
  for f in -T -h; do
    n=$((n + 1)) d="$probe/$n"
    mkdir "$d" "$d/a" "$d/c" "$d/victim" && ln -s "$d/victim" "$d/link" || break
    if mv "$f" -- "$d/a" "$d/b" >/dev/null 2>&1 && [[ -d "$d/b" && ! -e "$d/a" ]]; then
      mv "$f" -- "$d/c" "$d/link" >/dev/null 2>&1 || true
      v=("$d/victim"/* "$d/victim"/.[!.]*)
      [[ ${#v[@]} -ne 0 || ! -d "$d/victim" ]] || ok="$f"
    fi
    rm -f "$d/link" 2>/dev/null || true
    for v in "$d/victim/c" "$d/victim" "$d/link" "$d/a" "$d/b" "$d/c" "$d"; do rmdir "$v" 2>/dev/null || true; done
    [[ -z "$ok" ]] || break
  done
  rmdir "$probe" 2>/dev/null || true
  [[ -n "$ok" ]] || refuse 'this mv supports neither -T (GNU) nor -h (BSD) as a rename that never follows a symlink at its target: refusing to rename workspaces with it'
  MV=(mv "$ok" --)
}

# dec VALUE: VALUE when it is a decimal count without a leading zero (12 digits at most), else fail.
# Every number the janitor reads passes here (or an equivalent match) before it is used.
dec() { [[ "$1" =~ ^(0|[1-9][0-9]{0,11})$ ]]; }

# fetch: the control plane's lists into KNOWN, LIVE and RECLAIM. Returns 1, having set SKIP_WHY,
# when it cannot be asked or the answer is not the expected shape.
fetch() {
  local hdr body rows rc=0 kind wsk wrk at
  hdr="$(umask 077 && mktemp)"
  # shellcheck disable=SC2064 # expand now: the trap must remove exactly this file
  trap "rm -f '$hdr'" EXIT
  printf 'Authorization: Bearer %s\n' "$(<"$SBX_JANITOR_TOKEN_FILE")" >"$hdr"
  local ca=()
  [[ -z "${SBX_API_CA_FILE:-}" ]] || ca=(--cacert "$SBX_API_CA_FILE")
  body="$(curl -fsS --max-time 20 --proto =https "${ca[@]}" -H "@$hdr" "$SBX_API_URL/v1/janitor/sandboxes")" || rc=$?
  rm -f "$hdr"
  if ((rc != 0)); then SKIP_WHY="control plane unreachable or refused (curl exit $rc)"; return 1; fi
  if ! jq -e '(.live | type) == "array" and (.terminated | type) == "array"
      and all(.live[], .terminated[]; type == "object")' >/dev/null 2>&1 <<<"$body"; then
    SKIP_WHY='the control plane answer is not {live: [...], terminated: [...]}'
    return 1
  fi
  # Only well-formed keys are emitted, so no value can carry a tab, a newline or a path; a bad
  # worker or time is emitted as '-' and counted as an error below. A record with a valid key still
  # makes the key KNOWN whatever else is wrong with it: it keeps, never frees.
  rows="$(jq -r --arg re "$KEY_RE" --arg wre "$WORKER_RE" '
    def key: (.wsk | type) == "string" and (.wsk | test($re));
    (.live[] | select(key) | "L\t\(.wsk)"),
    (.terminated[] | select(key) | "K\t\(.wsk)"),
    (.terminated[] | select(key)
      | "T\t\(.wsk)\t\(if (.wrk | type) == "string" and (.wrk | test($wre)) then .wrk else "-" end)\t\(
          if (.terminatedAt | type) == "number" and .terminatedAt >= 0 and .terminatedAt < 1e12
          then (.terminatedAt | floor | tostring) else "-" end)")' <<<"$body")" || {
    SKIP_WHY='the control plane answer could not be read'
    return 1
  }
  while IFS=$'\t' read -r kind wsk wrk at; do
    [[ "$wsk" =~ $KEY_RE ]] || continue
    KNOWN[$wsk]=1
    case "$kind" in
    L) LIVE[$wsk]=1 ;;
    T)
      if [[ ! "$wrk" =~ $WORKER_RE ]] || ! dec "$at"; then
        error "${wrk//[^A-Za-z0-9_-]/?}" "$wsk" 'terminated record with a bad wrk or terminatedAt; kept'
        continue
      fi
      if ((10#$at + AGE_S < NOW)); then RECLAIM["$wrk/$wsk"]=1; fi
      ;;
    esac
  done <<<"$rows"
  return 0
}

# validate_root WRK: ROOT[WRK] once $SRV_REAL/workspaces/WRK is a real directory (no symlink in
# any component below $SBX_SRV); INSTALLED[WRK] and IDLE_S[WRK] from its env file, only when that
# file names this same root.
validate_root() {
  local wrk="$1" root env idle sh_root
  [[ "$wrk" =~ $WORKER_RE && -n "$SRV_REAL" ]] || return 1
  root="$SRV_REAL/workspaces/$wrk"
  if [[ -L "$root" || ! -d "$root" || "$(realpath "$root")" != "$root" ]]; then
    error "$wrk" '' 'workspace root is a symlink or not a directory; skipped'
    return 1
  fi
  ROOT[$wrk]="$root"
  env="$SBX_ENV_DIR/workers/$wrk.env"
  [[ -f "$env" ]] || return 0 # not installed here: examined, never freed
  sh_root="$(env_value SH_WORKSPACE_ROOT "$env")"
  if [[ -z "$sh_root" || ! -d "$sh_root" || "$(realpath "$sh_root")" != "$root" ]]; then
    error "$wrk" '' 'the worker env names another SH_WORKSPACE_ROOT; nothing freed there'
    return 0
  fi
  INSTALLED[$wrk]=1
  idle="$(env_value SH_WORKSPACE_IDLE "$env")"
  [[ ! "$idle" =~ ^[1-9][0-9]{0,5}h$ ]] || IDLE_S[$wrk]=$((10#${idle%h} * 3600))
  local state_dir="$root/.lease-state" # the worker's lease state files: only through a real directory
  if [[ -L "$state_dir" || (-e "$state_dir" && ! -d "$state_dir") || (-d "$state_dir" && "$(realpath "$state_dir")" != "$state_dir") ]]; then
    error "$wrk" '' '.lease-state is a symlink or not a directory; no lease state file removed there'
  elif [[ -d "$state_dir" ]]; then
    LEASE_DIR[$wrk]="$state_dir"
  fi
}

# remove_tree WRK NAME: THE ONE DELETION. Only a .reclaiming-* real directory directly inside the
# validated root of WRK, re-checked here whatever the caller did, and never across a mount.
remove_tree() {
  local wrk="$1" name="$2" root target
  root="${ROOT[$wrk]:-}"
  [[ "$wrk" =~ $WORKER_RE && -n "$SRV_REAL" && "$root" == "$SRV_REAL/workspaces/$wrk" ]] ||
    { echo "sbx-janitor: remove_tree: '$wrk' is not a validated root" >&2; return 1; }
  [[ "$name" =~ $TOMB_RE ]] || { echo "sbx-janitor: remove_tree: '$name' is not a tombstone name" >&2; return 1; }
  target="$root/$name"
  [[ -d "$target" && ! -L "$target" && "$(realpath "$target")" == "$target" ]] ||
    { echo "sbx-janitor: remove_tree: $target is not a directory inside $root" >&2; return 1; }
  "${RM[@]}" -- "$target"
}

# remove_lease_state WRK WSK: the worker's lease state file for WSK, once WSK's workspace is gone.
# Only a regular file directly in the validated .lease-state of an installed worker.
remove_lease_state() {
  local wrk="$1" wsk="$2" dir="${LEASE_DIR[$1]:-}" file
  [[ -n "$dir" && "$wsk" =~ $KEY_RE ]] || return 0
  file="$dir/$wsk.json"
  [[ -e "$file" || -L "$file" ]] || return 0
  if [[ -L "$file" || ! -f "$file" ]]; then error "$wrk" "$wsk" 'its lease state file is a symlink or not a file; left alone'; return 0; fi
  rm -f -- "$file" || { error "$wrk" "$wsk" 'removal of its lease state file failed'; return 0; }
  say "{\"janitor\":\"lease_state_removed\",\"wrk\":\"$wrk\",\"wsk\":\"$wsk\"}"
}

kb_of() { local out; out="$(du -skx -- "$1" 2>/dev/null)" || out=0; out="${out%%[[:space:]]*}"; [[ "$out" =~ ^[0-9]+$ ]] || out=0; printf '%s' "$out"; }

# reclaim WRK WSK WHY: rename out of the key's name space, then remove.
reclaim() {
  local wrk="$1" wsk="$2" why="$3" root src tomb kb
  [[ -n "${INSTALLED[$wrk]:-}" && "$wsk" =~ $KEY_RE ]] || { error "$wrk" "$wsk" 'refused: not an installed worker or a key'; return 0; }
  root="${ROOT[$wrk]}" src="${ROOT[$wrk]}/$wsk"
  [[ -d "$src" && ! -L "$src" ]] || return 0 # gone meanwhile: nothing to do
  tomb=".reclaiming-$wsk-$NOW"
  [[ ! -e "$root/$tomb" && ! -L "$root/$tomb" ]] || { error "$wrk" "$wsk" 'tombstone name taken'; return 0; }
  kb="$(kb_of "$src")"
  "${MV[@]}" "$src" "$root/$tomb" || { error "$wrk" "$wsk" 'rename failed'; return 0; }
  if remove_tree "$wrk" "$tomb"; then
    REMOVED=$((REMOVED + 1)) FREED=$((FREED + kb * 1024))
    say "{\"janitor\":\"reclaimed\",\"wrk\":\"$wrk\",\"wsk\":\"$wsk\",\"why\":\"$why\",\"bytes\":$((kb * 1024))}"
  else
    error "$wrk" "$wsk" "removal of $tomb failed; retried as a stale tombstone"
  fi
  remove_lease_state "$wrk" "$wsk" # the key's tree is out of its name space either way
}

newest_mtime() { # newest_mtime DIR: the newer of DIR's and DIR/workspace.img's, or nothing
  local m n
  m="$("${STAT[@]}" "$1" 2>/dev/null)" || return 0
  dec "$m" || return 0
  if [[ -e "$1/workspace.img" || -L "$1/workspace.img" ]]; then
    n="$("${STAT[@]}" "$1/workspace.img" 2>/dev/null)" || return 0
    dec "$n" || return 0
    ((10#$n <= 10#$m)) || m="$n"
  fi
  printf '%s' "$m"
}

# tomb_time NAME PATH: when the tombstone was made, in seconds: the time in its name, or its ctime
# (which a rename sets) when the name carries none or a time later than now (a skewed clock must
# not keep a tombstone forever). Prints `bad` when a time cannot be read, so the caller counts it.
tomb_time() {
  local name="$1" t=''
  if [[ "$name" =~ ^\.reclaiming-sbx-[0123456789abcdef]{26}-([1-9][0-9]{0,11})$ ]]; then
    t="${BASH_REMATCH[1]}" # the janitor's own: .reclaiming-<wsk>-<unix s>
  elif [[ "$name" =~ ^\.reclaiming-.+-([1-9][0-9]{18})-[0-9]+$ ]]; then
    # The worker's: .reclaiming-<key>-<unix ns>-<seq>. Go wrote an int64, so 19 digits above
    # 2^63 - 1 are no time it made: unreadable. Checked in two parts, so nothing here can wrap.
    t="${BASH_REMATCH[1]}"
    if ((10#${t:0:18} > 922337203685477580 || (10#${t:0:18} == 922337203685477580 && 10#${t:18} > 7))); then
      printf 'bad'
      return 0
    fi
    t="${t:0:10}" # the seconds: the first ten digits, cut as text
  fi
  if [[ -n "$t" ]]; then
    dec "$t" || { printf 'bad'; return 0; }
    ((10#$t > NOW)) || { printf '%s' "$t"; return 0; }
  fi
  t="$("${STAT_CTIME[@]}" "$2" 2>/dev/null)" || { printf 'bad'; return 0; }
  if dec "$t"; then printf '%s' "$t"; else printf 'bad'; fi
}

sweep_root() { # sweep_root WRK: every workspace-key entry of a validated root
  local wrk="$1" path wsk m
  for path in "${ROOT[$wrk]}"/*; do
    wsk="${path##*/}"
    [[ "$wsk" =~ $KEY_RE ]] || continue # _probe, and anything else no sandbox owns
    EXAMINED=$((EXAMINED + 1))
    if [[ -L "$path" || ! -d "$path" ]]; then error "$wrk" "$wsk" 'not a directory (symlink or file); left alone'; continue; fi
    [[ -z "${LIVE[$wsk]:-}" ]] || continue
    if [[ -n "${RECLAIM["$wrk/$wsk"]:-}" ]]; then
      [[ -z "${INSTALLED[$wrk]:-}" ]] || reclaim "$wrk" "$wsk" terminated
      continue
    fi
    [[ -z "${KNOWN[$wsk]:-}" ]] || continue
    UNKNOWN=$((UNKNOWN + 1))
    if [[ -z "${INSTALLED[$wrk]:-}" || -z "${IDLE_S[$wrk]:-}" ]]; then
      error "$wrk" "$wsk" "unknown, and no SH_WORKSPACE_IDLE in $SBX_ENV_DIR/workers/$wrk.env to judge it by; kept"
      continue
    fi
    m="$(newest_mtime "$path")"
    if [[ -z "$m" ]]; then error "$wrk" "$wsk" 'unknown, and its mtime cannot be read; kept'; continue; fi
    if ((10#$m + IDLE_S[$wrk] < NOW)); then
      reclaim "$wrk" "$wsk" unknown_idle
    else
      say "{\"janitor\":\"unknown_kept\",\"wrk\":\"$wrk\",\"wsk\":\"$wsk\",\"idle_s\":$((NOW - 10#$m)),\"reclaim_after_s\":${IDLE_S[$wrk]}}"
    fi
  done
}

# sweep_lease_states WRK: the state files of sandboxes terminated more than the wait ago, on this
# worker, whose workspace is gone already (reclaim removed the rest). The glob skips the dot files:
# the worker's boot marker and its temp files.
sweep_lease_states() {
  local wrk="$1" path wsk
  [[ -n "${LEASE_DIR[$wrk]:-}" ]] || return 0
  for path in "${LEASE_DIR[$wrk]}"/*.json; do
    wsk="${path##*/}"
    wsk="${wsk%.json}"
    [[ "$wsk" =~ $KEY_RE && -n "${RECLAIM["$wrk/$wsk"]:-}" && -z "${LIVE[$wsk]:-}" ]] || continue
    [[ ! -e "${ROOT[$wrk]}/$wsk" && ! -L "${ROOT[$wrk]}/$wsk" ]] || continue
    remove_lease_state "$wrk" "$wsk"
  done
}

sweep_tombstones() { # sweep_tombstones WRK: .reclaiming-* trees older than an hour
  local wrk="$1" path name m kb
  for path in "${ROOT[$wrk]}"/.reclaiming-*; do
    name="${path##*/}"
    [[ "$name" =~ $TOMB_RE ]] || continue
    if [[ -L "$path" || ! -d "$path" ]]; then error "$wrk" '' "$name is not a directory; left alone"; continue; fi
    m="$(tomb_time "$name" "$path")"
    if ! dec "$m"; then error "$wrk" '' "$name: its age cannot be read; left alone"; continue; fi
    ((10#$m + TOMB_AGE_S < NOW)) || continue
    kb="$(kb_of "$path")"
    if remove_tree "$wrk" "$name"; then
      FREED=$((FREED + kb * 1024))
      say "{\"janitor\":\"tombstone_removed\",\"wrk\":\"$wrk\",\"bytes\":$((kb * 1024))}"
    else
      error "$wrk" '' "removal of $name failed"
    fi
  done
}

main() {
  check_settings
  SKIP_WHY=''
  if ! fetch; then
    say "{\"janitor\":\"skipped\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"why\":\"$SKIP_WHY; nothing touched\"}"
    return 0
  fi
  local ws path wrk
  if [[ -n "$SRV_REAL" && (-e "$SRV_REAL/workspaces" || -L "$SRV_REAL/workspaces") ]]; then
    ws="$SRV_REAL/workspaces"
    if [[ -L "$ws" || ! -d "$ws" || "$(realpath "$ws")" != "$ws" ]]; then
      error '' '' "$ws is a symlink or not a directory; nothing touched"
    else
      for path in "$ws"/*; do
        wrk="${path##*/}"
        [[ "$wrk" =~ $WORKER_RE && -d "$path" ]] || continue
        validate_root "$wrk" || continue
        sweep_root "$wrk"
        sweep_lease_states "$wrk"
        sweep_tombstones "$wrk"
      done
    fi
  fi
  say "{\"janitor\":\"summary\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"examined\":$EXAMINED,\"removed\":$REMOVED,\"unknown\":$UNKNOWN,\"bytes_freed\":$FREED,\"errors\":$ERRORS}"
}

# Sourced by the tests to reach remove_tree directly; run, it does the work.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
