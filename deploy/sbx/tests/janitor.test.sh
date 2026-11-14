#!/usr/bin/env bash
# Tests for deploy/sbx/janitor.sh (SBX0 §8.3, §10.5), with curl mocked on PATH and temp directories
# as the workspace roots. What may go: a terminated sandbox's workspace once the wait has passed, an
# unknown one once it has been idle longer than its worker's SH_WORKSPACE_IDLE, and stale
# tombstones. What must survive: everything else -- a live sandbox, a recent termination, a newer
# unknown directory, another worker's or an uninstalled worker's tree, any name that is not a
# workspace key, symlinks and what they point at -- and everything at all when the control plane
# cannot be asked. JANITOR_SH overrides the script under test (the mutation runs use it).
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }
J="${JANITOR_SH:-$SRC/deploy/sbx/janitor.sh}"

# curl: logs its argv; answers only a GET of the janitor route that carries the bearer from a header
# file (-H @file) -- otherwise 22, as curl -f does on a 401 -- and serves $MOCK_JSON.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$MOCK_LOG"
[[ -z "${MOCK_CURL_FAIL:-}" ]] || { echo 'curl: (6) Could not resolve host' >&2; exit 6; }
args=("$@") hdr='' url=''
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ "${args[$i]}" == -H && "${args[$((i + 1))]:-}" == @* ]] && hdr="${args[$((i + 1))]#@}"
  [[ "${args[$i]}" == https://* ]] && url="${args[$i]}"
done
[[ -n "$hdr" && "$(cat "$hdr")" == "Authorization: Bearer $(cat "$MOCK_TOKEN_FILE")" ]] || { echo 'curl: (22) 401' >&2; exit 22; }
[[ "$url" == "$MOCK_URL" ]] || { echo "curl: (22) 404 $url" >&2; exit 22; }
cat "$MOCK_JSON"
MOCK
# mv and rm: log their argv to $FS_LOG, then run the real tool, so a test can see the order.
for t in mv rm; do
  printf '#!/usr/bin/env bash\n[[ -z "${FS_LOG:-}" ]] || printf "%%s %%s\\n" %s "$*" >>"$FS_LOG"\nexec %q "$@"\n' "$t" "$(command -v "$t")" >"$TMP/bin/$t"
done
# stat: when the file asked about ends with MOCK_STAT_PATH, print MOCK_STAT_VAL instead (a test's
# way to give a tree an old ctime, which touch cannot, or an unreadable time).
printf '#!/usr/bin/env bash\nif [[ -n "${MOCK_STAT_PATH:-}" && "${!#}" == *"$MOCK_STAT_PATH" ]]; then printf "%%s\\n" "$MOCK_STAT_VAL"; exit 0; fi\nexec %q "$@"\n' "$(command -v stat)" >"$TMP/bin/stat"
chmod +x "$TMP/bin/curl" "$TMP/bin/mv" "$TMP/bin/rm" "$TMP/bin/stat"
export PATH="$TMP/bin:$PATH" MOCK_LOG="$TMP/curl.log" MOCK_JSON="$TMP/list.json"
export SBX_SRV="$TMP/srv" SBX_ENV_DIR="$TMP/etc" SBX_API_URL=https://sbx-api.example.invalid
export MOCK_URL="$SBX_API_URL/v1/janitor/sandboxes"
export SBX_JANITOR_TOKEN_FILE="$TMP/janitor.token" MOCK_TOKEN_FILE="$TMP/janitor.token" SBX_JANITOR_AGE=3600
TOKEN="$(printf 'j%.0s' {1..40})"
printf '%s' "$TOKEN" >"$SBX_JANITOR_TOKEN_FILE"
chmod 600 "$SBX_JANITOR_TOKEN_FILE"

NOW="$(date +%s)"
OLD=$((NOW - 7200))   # terminated two hours ago: past the one-hour wait
RECENT=$((NOW - 600)) # ten minutes ago: inside it
WS="$SBX_SRV/workspaces"
D="$WS/sbx_default" P="$WS/sbx_py312" U="$WS/sbx_gone" # sbx_gone: a root whose worker was uninstalled
k() { printf 'sbx-%s' "$(printf "$1%.0s" {1..26})"; } # k a -> sbx-aaaa... (26)
TERM_OLD="$(k a)" TERM_RECENT="$(k b)" LIVE="$(k c)" UNK_OLD="$(k d)" UNK_NEW="$(k e)"
LIVE_TOO="$(k f)" OTHER_WRK="$(k 1)" GONE_TERM="$(k 2)" GONE_UNK="$(k 3)" LINK="$(k 4)" FILE="$(k 5)" PY_TERM="$(k 6)"

old() { touch -t 202001010000 "$@"; } # mtime far past any idle
workspace() { mkdir -p "$1"; head -c 8192 /dev/zero >"$1/workspace.img"; }
setup_dirs() {
  rm -rf "$SBX_SRV" "$SBX_ENV_DIR" "$TMP/outside"
  mkdir -p "$SBX_ENV_DIR/workers" "$TMP/outside"
  touch "$TMP/outside/precious"
  for w in sbx_default sbx_py312; do # as install-host.sh writes them
    printf 'SH_WORKSPACE_ROOT=%s\nSH_WORKSPACE_IDLE=216h\n' "$WS/$w" >"$SBX_ENV_DIR/workers/$w.env"
  done
  for d in "$D/$TERM_OLD" "$D/$TERM_RECENT" "$D/$LIVE" "$D/$UNK_OLD" "$D/$UNK_NEW" "$D/$LIVE_TOO" \
    "$P/$OTHER_WRK" "$P/$PY_TERM" "$U/$GONE_TERM" "$U/$GONE_UNK" "$D/_probe" "$D/sbx-notakey" "$D/$(k Z)"; do
    workspace "$d"
  done
  # Every workspace idle for years, except the newer unknown one: only the records keep them.
  old "$D/$TERM_OLD" "$D/$TERM_OLD/workspace.img" "$D/$TERM_RECENT" "$D/$TERM_RECENT/workspace.img"
  old "$D/$LIVE" "$D/$LIVE/workspace.img" "$D/$UNK_OLD" "$D/$UNK_OLD/workspace.img" "$D/$LIVE_TOO" "$D/$LIVE_TOO/workspace.img"
  old "$P/$OTHER_WRK" "$P/$OTHER_WRK/workspace.img" "$U/$GONE_UNK" "$U/$GONE_UNK/workspace.img"
  old "$D/_probe" "$D/sbx-notakey" "$D/$(k Z)"
  old "$D/$UNK_NEW" # the directory is old, but its image was written just now
  ln -s "$TMP/outside" "$D/$LINK"
  printf 'not a directory' >"$D/$FILE"
  old -h "$D/$LINK" 2>/dev/null || true
  old "$D/$FILE"
}
list() { # the control plane's GET /v1/janitor/sandboxes
  cat >"$MOCK_JSON" <<JSON
{"live":[{"wsk":"$LIVE","wrk":"sbx_default"},{"wsk":"$LIVE_TOO","wrk":"sbx_default"}],
 "terminated":[{"wsk":"$TERM_OLD","wrk":"sbx_default","terminatedAt":$OLD},
  {"wsk":"$TERM_RECENT","wrk":"sbx_default","terminatedAt":$RECENT},
  {"wsk":"$LIVE_TOO","wrk":"sbx_default","terminatedAt":$OLD},
  {"wsk":"$OTHER_WRK","wrk":"sbx_default","terminatedAt":$OLD},
  {"wsk":"$PY_TERM","wrk":"sbx_py312","terminatedAt":$OLD},
  {"wsk":"$GONE_TERM","wrk":"sbx_gone","terminatedAt":$OLD},
  {"wsk":"$LINK","wrk":"sbx_default","terminatedAt":$OLD},
  {"wsk":"$FILE","wrk":"sbx_default","terminatedAt":$OLD},
  {"wsk":"_probe","wrk":"sbx_default","terminatedAt":$OLD},
  {"wsk":"sbx-notakey","wrk":"sbx_default","terminatedAt":$OLD},
  {"wsk":"$(k Z)","wrk":"sbx_default","terminatedAt":$OLD},
  {"wsk":"../sbx_py312","wrk":"sbx_default","terminatedAt":$OLD},
  {"wsk":"$(k 7)","wrk":"sbx_default","terminatedAt":$OLD},
  {"wsk":"$(k 8)","wrk":"../../etc","terminatedAt":$OLD},
  {"wsk":"x\nT\t$UNK_NEW\tsbx_default\t0","wrk":"sbx_default","terminatedAt":$OLD}]}
JSON
}
summary() { grep '"janitor":"summary"' "$TMP/out"; }
field() { jq -r ".$1" <<<"$(summary)"; }
snapshot() { (cd "$TMP" && find srv etc outside -print | LC_ALL=C sort); }

setup_dirs
list
: >"$MOCK_LOG"
FS_LOG="$TMP/fs.log" bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed'

# 1. Terminated more than the wait ago, on this worker: tombstoned, then removed.
[[ ! -e "$D/$TERM_OLD" ]] || fail 'a sandbox terminated two hours ago kept its workspace'
[[ -z "$(find "$D" -maxdepth 1 -name ".reclaiming-$TERM_OLD-*")" ]] || fail 'the tombstone of a reclaimed workspace was left behind'
grep -q "\"janitor\":\"reclaimed\".*\"wsk\":\"$TERM_OLD\".*\"why\":\"terminated\"" "$TMP/out" || fail 'no reclaimed line for the terminated sandbox'
[[ ! -e "$P/$PY_TERM" ]] || fail "another installed worker's terminated workspace was kept"
# Tombstones, then removes: the key's directory is only ever renamed; rm acts on the tombstone alone.
grep -Eq "^mv -(T|h) -- [^ ]*/sbx_default/$TERM_OLD [^ ]*/sbx_default/\\.reclaiming-$TERM_OLD-[0-9]+\$" "$TMP/fs.log" ||
  fail "the workspace was not renamed (mv -T/-h: never into a planted symlink) to .reclaiming-<wsk>-<ts> in its own root: $(cat "$TMP/fs.log")"
grep -Eq "^rm -rf(x| --one-file-system) -- [^ ]*/sbx_default/\\.reclaiming-$TERM_OLD-[0-9]+\$" "$TMP/fs.log" ||
  fail "the tombstone was not removed (one file system): $(cat "$TMP/fs.log")"
! grep -E '^rm -r' "$TMP/fs.log" | grep -v '/\.reclaiming-' | grep -q . || fail "a recursive rm named something other than a tombstone: $(cat "$TMP/fs.log")"
pass 'removes the workspace of a sandbox terminated more than the wait ago, on each installed worker: renamed, then removed'

# 2. Plan Review Focus 4: live, recently terminated, and live-and-terminated survive.
[[ -f "$D/$LIVE/workspace.img" ]] || fail 'removed a live (ready) sandbox'"'"'s workspace'
[[ -f "$D/$LIVE_TOO/workspace.img" ]] || fail 'removed a workspace listed as live (and also as terminated)'
[[ -f "$D/$TERM_RECENT/workspace.img" ]] || fail 'removed a workspace terminated less than the wait ago'
pass 'keeps a live sandbox, and one terminated less than the wait ago'

# 3. Only the listed worker's root: a record for wrk A never frees a tree in root B; an uninstalled
# worker's root keeps everything, and its unknown directories count as errors.
[[ -f "$P/$OTHER_WRK/workspace.img" ]] || fail 'freed a tree in sbx_py312 for a record of sbx_default'
[[ -f "$U/$GONE_TERM/workspace.img" ]] || fail 'freed a workspace of a worker not installed on this host'
[[ -f "$U/$GONE_UNK/workspace.img" ]] || fail 'freed an unknown workspace with no worker env to read its idle from'
grep -q "\"janitor\":\"error\".*\"wrk\":\"sbx_gone\".*\"wsk\":\"$GONE_UNK\"" "$TMP/out" || fail 'the unknown dir of an uninstalled worker is not reported as an error'
pass "touches only the record's own worker root, and nothing of an uninstalled worker"

# 4. Spec §8.3 step 3: an unknown directory idle past SH_WORKSPACE_IDLE goes; a newer one is reported
# and kept (its image's mtime counts, not only the directory's).
[[ ! -e "$D/$UNK_OLD" ]] || fail 'an unknown workspace idle for years was kept'
grep -q "\"janitor\":\"reclaimed\".*\"wsk\":\"$UNK_OLD\".*\"why\":\"unknown_idle\"" "$TMP/out" || fail 'no reclaimed line for the idle unknown dir'
[[ -f "$D/$UNK_NEW/workspace.img" ]] || fail 'removed an unknown workspace whose image was modified just now (or a record smuggled a row for it)'
grep -q "\"janitor\":\"unknown_kept\".*\"wsk\":\"$UNK_NEW\"" "$TMP/out" || fail 'the newer unknown directory is not reported'
pass 'removes an unknown directory idle past SH_WORKSPACE_IDLE; a newer unknown directory is reported and kept'

# 5. Names and file types: only real directories named as workspace keys, never through a symlink.
# sbx-ZZ..: not lower-case hex (and, on a case-insensitive filesystem, no other fixture differs from it only by case).
for n in _probe sbx-notakey "$(k Z)"; do [[ -d "$D/$n" ]] || fail "removed $n (not a workspace key)"; done
[[ -L "$D/$LINK" && -f "$TMP/outside/precious" ]] || fail 'removed a symlink named as a workspace key, or what it points at'
[[ -f "$D/$FILE" ]] || fail 'removed a regular file named as a workspace key'
[[ -d "$P" && -d "$SBX_ENV_DIR" ]] || fail 'a traversal in a record reached another root or the env dir'
pass 'never touches _probe, a non-key name, a symlink or its target, a file, or a path a record names'

# 6. The summary line, and the token's path to curl.
[[ "$(summary | wc -l | tr -d ' ')" == 1 ]] || fail 'not exactly one summary line'
summary | jq -e 'keys == (["bytes_freed","errors","examined","janitor","removed","ts","unknown"] | sort)' >/dev/null ||
  fail "summary keys: $(summary)"
[[ "$(field removed)" == 3 ]] || fail "removed: want 3 (two terminated, one idle unknown): $(summary)"
[[ "$(field unknown)" == 3 ]] || fail "unknown: want 3 (idle, newer, uninstalled worker's): $(summary)"
[[ "$(field examined)" == 12 ]] || fail "examined: want the 12 key-named entries: $(summary)"
[[ "$(field errors)" == 4 ]] || fail "errors: want 4 (the uninstalled worker's unknown dir, the symlink, the file, the ../../etc wrk record): $(summary)"
(($(field bytes_freed) >= 3 * 8192)) || fail "bytes_freed below three 8 KiB images: $(summary)"
[[ "$(field ts)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || fail "ts: $(field ts)"
grep -q -- "-fsS --max-time 20 " "$MOCK_LOG" || fail 'curl is not bounded (-fsS --max-time 20)'
! grep -qF "$TOKEN" "$MOCK_LOG" "$TMP/out" || fail 'the token reached argv or the log (use -H @file)'
pass 'one JSON summary line {ts, examined, removed, unknown, bytes_freed, errors}; the token never in argv'

# 7. Tolerates missing directories: a second run over the same list finds nothing more to free.
bash "$J" >"$TMP/out" 2>&1 || fail 'the second run failed'
[[ "$(field removed)" == 0 && "$(field errors)" == 4 ]] || fail "a re-run over vanished directories: $(summary)"
pass 'tolerates directories already gone'

# 8. Tombstones: older than an hour removed (in any root), newer kept; a symlinked one is not followed.
# The age is the time in the name -- the janitor's .reclaiming-<wsk>-<s>, the worker's
# .reclaiming-<key>-<ns>-<seq> -- never the mtime, which a rename keeps; without one, the ctime.
setup_dirs
echo '{"live":[],"terminated":[]}' >"$MOCK_JSON"
J_OLD=".reclaiming-$TERM_OLD-$((NOW - 7200))" J_NEW=".reclaiming-$UNK_OLD-$((NOW - 600))"
W_OLD=".reclaiming-x.y-$((NOW - 7200))123456789-3" W_NEW=".reclaiming-$LIVE-$((NOW - 600))123456789-4"
mkdir -p "$D/$J_OLD" "$U/$W_OLD" "$D/$J_NEW" "$D/$W_NEW" "$D/.reclaiming-fresh"
head -c 4096 /dev/zero >"$D/$J_OLD/workspace.img"
touch "$D/$J_OLD" "$U/$W_OLD"                         # renamed just now from... (mtime is no age)
old "$D/$J_NEW" "$D/$W_NEW" "$D/.reclaiming-fresh"    # ...trees idle for years: still fresh tombstones
ln -s "$TMP/outside" "$D/.reclaiming-link"
old -h "$D/.reclaiming-link" 2>/dev/null || true
bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed'
[[ ! -e "$D/$J_OLD" && ! -e "$U/$W_OLD" ]] || fail 'a tombstone named over an hour ago was kept (aged by its mtime?)'
[[ -d "$D/$J_NEW" && -d "$D/$W_NEW" ]] || fail 'a tombstone named ten minutes ago was removed because its tree is old (aged by mtime)'
[[ -d "$D/.reclaiming-fresh" ]] || fail 'a tombstone with no time in its name and a new ctime was removed (a worker may still be removing it)'
[[ -f "$TMP/outside/precious" && -L "$D/.reclaiming-link" ]] || fail 'followed or removed a symlinked tombstone'
grep -q '"why":".reclaiming-link is not a directory; left alone"' "$TMP/out" || fail 'the symlinked tombstone is not reported as left alone'
pass 'removes tombstones older than an hour by the time in their name (janitor or worker format; else ctime), never follows a symlinked one'

# 9. Unreachable, refused or malformed: nothing at all is touched.
for mode in unreachable refused malformed shape; do
  setup_dirs
  list
  before="$(snapshot)"
  case "$mode" in
  unreachable) export MOCK_CURL_FAIL=1 ;;
  refused) printf 'wrong-token-wrong-token-wrong-token-x' >"$TMP/other.token"; export MOCK_TOKEN_FILE="$TMP/other.token" ;;
  malformed) printf '<html>proxy error</html>' >"$MOCK_JSON" ;;
  # An object iterates to nothing in jq: without the shape check every directory would read as unknown.
  shape) echo '{"live":{},"terminated":[]}' >"$MOCK_JSON" ;;
  esac
  rc=0
  bash "$J" >"$TMP/out" 2>&1 || rc=$?
  unset MOCK_CURL_FAIL
  export MOCK_TOKEN_FILE="$SBX_JANITOR_TOKEN_FILE"
  [[ "$before" == "$(snapshot)" ]] || fail "touched the disk when the control plane was $mode"
  grep -q '"janitor":"skipped"' "$TMP/out" || fail "did not say why it did nothing ($mode)"
  case "$mode" in
  unreachable | refused) grep -q '"why":"control plane unreachable or refused' "$TMP/out" || fail "the $mode skip does not say so" ;;
  *) grep -q '"why":"the control plane answer is not' "$TMP/out" || fail "the $mode skip does not say the answer was malformed" ;;
  esac
  ! summary >/dev/null || fail "printed a summary although it did nothing ($mode)"
  case "$mode" in unreachable | refused) ((rc == 0)) || fail "exit $rc when the control plane was $mode (an outage is not a failure)" ;; esac
done
pass 'does nothing at all when the control plane is unreachable, refuses the token, or answers nonsense'

# 10. Refusals before anything else: the workspace root, the token, the URL, the tools.
setup_dirs
list
before="$(snapshot)"
: >"$MOCK_LOG"
for bad in 'SBX_SRV=/' 'SBX_SRV=' 'SBX_SRV=//' 'SBX_SRV=/srv/..' 'SBX_SRV=relative/srv' 'SBX_ENV_DIR=' \
  'SBX_JANITOR_AGE=1h' 'SBX_JANITOR_AGE=03600' 'SBX_JANITOR_AGE=0900' 'SBX_JANITOR_AGE=-1' \
  'SBX_API_URL=http://sbx-api.example.invalid' "SBX_JANITOR_TOKEN_FILE=$TMP/missing" \
  "SBX_API_CA_FILE=$TMP/missing.crt"; do
  ! env "$bad" bash "$J" >"$TMP/out" 2>&1 || fail "ran with $bad"
  grep -q 'sbx-janitor: ' "$TMP/out" || fail "the $bad refusal does not say why"
done
ln -s / "$TMP/rootlink"
! SBX_SRV="$TMP/rootlink" bash "$J" >"$TMP/out" 2>&1 || fail 'ran with an SBX_SRV that resolves to /'
grep -q "resolves to '/'" "$TMP/out" || fail 'the SBX_SRV -> / refusal does not say why'
for m in 640 604 644 400; do
  cp "$SBX_JANITOR_TOKEN_FILE" "$TMP/mode.token" && chmod "$m" "$TMP/mode.token"
  rc=0
  # Unreachable, so an accepted file gets only as far as the `skipped` line and touches nothing.
  MOCK_CURL_FAIL=1 SBX_JANITOR_TOKEN_FILE="$TMP/mode.token" bash "$J" >"$TMP/out" 2>&1 || rc=$?
  if [[ "$m" == 400 ]]; then
    ((rc == 0)) && grep -q '"janitor":"skipped"' "$TMP/out" || fail 'refused a 0400 token file (owner read only)'
    continue
  fi
  ((rc == 2)) || fail "ran with a token file of mode $m"
  grep -q 'chmod 600' "$TMP/out" || fail "the mode-$m refusal does not say what to do"
done
: >"$MOCK_LOG"
printf 'tooShortSecret' >"$TMP/small.token"
chmod 600 "$TMP/small.token"
! SBX_JANITOR_TOKEN_FILE="$TMP/small.token" bash "$J" >"$TMP/out" 2>&1 || fail 'ran with a token under 32 characters'
! grep -q tooShortSecret "$TMP/out" || fail 'the short-token refusal printed the token'
mkdir -p "$TMP/notools"
for t in bash date cat; do ln -sf "$(command -v "$t")" "$TMP/notools/$t"; done
! PATH="$TMP/notools" "$TMP/notools/bash" "$J" >"$TMP/out" 2>&1 || fail 'ran without jq and curl'
grep -q 'needs jq' "$TMP/out" || fail 'the missing-tool refusal does not name jq'
[[ ! -s "$MOCK_LOG" ]] || fail 'asked the control plane before refusing its own settings'
[[ "$before" == "$(snapshot)" ]] || fail 'a refused run touched the disk'
pass 'refuses a root that is / or empty (or relative, or a link to /), a wait with a leading zero (octal), a token file others can read, a bad token, URL or CA, and missing tools'

# 11. A worker whose root is a symlink, or whose env names a different root, is skipped, as an error.
setup_dirs
list
mkdir -p "$TMP/outside/$TERM_OLD"
rm -rf "$D" && ln -s "$TMP/outside" "$D"
printf 'SH_WORKSPACE_ROOT=/elsewhere\nSH_WORKSPACE_IDLE=216h\n' >"$SBX_ENV_DIR/workers/sbx_py312.env"
bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed'
[[ -d "$TMP/outside/$TERM_OLD" && -f "$TMP/outside/precious" ]] || fail 'followed a symlinked workspace root'
[[ -f "$P/$PY_TERM/workspace.img" ]] || fail "freed a workspace in a root its worker's env does not name"
grep -q '"janitor":"error","wrk":"sbx_default","wsk":"","why":"workspace root is a symlink' "$TMP/out" ||
  fail 'the symlinked root is not refused as such'
grep -q '"janitor":"error","wrk":"sbx_py312","wsk":"","why":"the worker env names another SH_WORKSPACE_ROOT' "$TMP/out" ||
  fail 'the root its env does not name is not reported'
pass "skips, as errors, a symlinked root and a root its worker's env does not name"

# 12. An unknown directory under a worker whose env has no valid SH_WORKSPACE_IDLE: kept, as an error.
setup_dirs
echo '{"live":[],"terminated":[]}' >"$MOCK_JSON"
printf 'SH_WORKSPACE_ROOT=%s\n' "$D" >"$SBX_ENV_DIR/workers/sbx_default.env"
bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed'
[[ -d "$D/$UNK_OLD" && -d "$D/$TERM_OLD" ]] || fail 'freed an unknown dir with no SH_WORKSPACE_IDLE to compare against'
(($(field errors) >= 6)) || fail "the unknown dirs with no idle are not errors: $(summary)"
pass 'keeps, as errors, unknown directories of a worker with no SH_WORKSPACE_IDLE'

# 13. The deletion choke point refuses anything but a tombstone directly in a validated root.
setup_dirs
(
  # shellcheck source=deploy/sbx/janitor.sh
  . "$J"
  check_settings
  validate_root sbx_default
  mkdir -p "$D/.reclaiming-ok" "$D/plain" "$TMP/outside/.reclaiming-out" "$P/.reclaiming-ok"
  ! remove_tree sbx_default plain 2>/dev/null || exit 11
  ! remove_tree sbx_default '.reclaiming-../../../outside' 2>/dev/null || exit 12
  ! remove_tree sbx_py312 .reclaiming-ok 2>/dev/null || exit 13 # sbx_py312's root was never validated
  ln -s "$TMP/outside/.reclaiming-out" "$D/.reclaiming-l"
  ! remove_tree sbx_default .reclaiming-l 2>/dev/null || exit 14
  ! remove_tree ../sbx_default .reclaiming-ok 2>/dev/null || exit 17
  remove_tree sbx_default .reclaiming-ok || exit 15
  # reclaim re-checks too: a worker not installed here, or a non-key name, is never renamed.
  validate_root sbx_gone
  reclaim sbx_gone "$GONE_TERM" terminated
  reclaim sbx_default _probe terminated
  [[ -d "$U/$GONE_TERM" && -d "$D/_probe" ]] || exit 18
  [[ -d "$D/plain" && -d "$TMP/outside/.reclaiming-out" && -L "$D/.reclaiming-l" && -d "$P/.reclaiming-ok" && ! -e "$D/.reclaiming-ok" ]] || exit 16
) >"$TMP/out" 2>&1 || fail "remove_tree accepted what it must refuse (step $?)"
pass 'remove_tree removes only a .reclaiming-* directory directly inside a validated root; reclaim re-checks its worker and key'

# 14. SBX_API_CA_FILE reaches curl as --cacert.
setup_dirs
list
printf -- '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' >"$TMP/api-ca.crt"
: >"$MOCK_LOG"
SBX_API_CA_FILE="$TMP/api-ca.crt" bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed with an API CA'
grep -qF -- "--cacert $TMP/api-ca.crt" "$MOCK_LOG" || fail 'SBX_API_CA_FILE is not passed as --cacert'
pass 'SBX_API_CA_FILE is passed to curl as --cacert'

# 15. The wait is decimal: a sandbox terminated 2000 s ago survives a 3600 s wait (bash would read
# 03600 as octal 1920, which the janitor refuses), and records it cannot read count as errors.
setup_dirs
cat >"$MOCK_JSON" <<JSON
{"live":[],"terminated":[{"wsk":"$TERM_OLD","wrk":"sbx_default","terminatedAt":$((NOW - 2000))},
 {"wsk":"$TERM_RECENT","wrk":"sbx_default","terminatedAt":"0900"},
 {"wsk":"$LIVE","wrk":"sbx_default","terminatedAt":$((NOW - 7200))000},
 {"wsk":"$UNK_OLD","wrk":["sbx_default"],"terminatedAt":$OLD},
 {"wsk":"$(k 7)","wrk":"sbx_default"},
 {"wsk":"$(k 8)","wrk":"sbx_default","terminatedAt":-5},
 {"wsk":"$(k 9)","wrk":null,"terminatedAt":$OLD},
 {"wsk":"$(k 0)","wrk":"../w1","terminatedAt":$OLD}]}
JSON
bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed'
for k in "$TERM_OLD" "$TERM_RECENT" "$LIVE" "$UNK_OLD"; do [[ -d "$D/$k" ]] || fail "removed $k"; done
# The fixture's own four (the symlink, the file, and the uninstalled worker's two dirs, both unknown
# under this list) plus one per bad record.
[[ "$(field errors)" == 11 ]] || fail "errors: want 11 (4 from the fixture, 7 bad records): $(summary)"
for b in "$TERM_RECENT:terminatedAt \"0900\"" "$LIVE:a millisecond terminatedAt" "$UNK_OLD:a wrk array" "$(k 7):no terminatedAt" \
  "$(k 8):a negative terminatedAt" "$(k 9):a null wrk" "$(k 0):a ../ wrk"; do
  [[ "$(grep -c "\"janitor\":\"error\".*\"wsk\":\"${b%%:*}\",\"why\":\"terminated record with a bad wrk or terminatedAt; kept\"" "$TMP/out")" == 1 ]] ||
    fail "not exactly one error line for the record with ${b#*:}"
done
! grep -qi 'value too great\|syntax error' "$TMP/out" || fail "an arithmetic error leaked: $(cat "$TMP/out")"
pass 'the wait is decimal (03600 refused; a 2000 s old termination survives 3600 s); each unreadable record is one error, kept'

# 16. Tombstone times that cannot be trusted: a name time beyond int64 is an error (kept, counted);
# a name time in the future (a skewed worker clock) falls back to the ctime, so it cannot stay forever.
setup_dirs
echo '{"live":[],"terminated":[]}' >"$MOCK_JSON"
BIG=.reclaiming-x-9999999999999999999-3 FUT=".reclaiming-$TERM_OLD-$((NOW + 86400))" FUTW=".reclaiming-y-$((NOW + 86400))000000000-1"
FUT_KEEP=".reclaiming-$UNK_OLD-$((NOW + 86400))" # never shimmed: its real (fresh) ctime counts
mkdir -p "$D/$BIG" "$D/$FUT" "$D/$FUTW" "$D/$FUT_KEEP"
old "$D/$BIG" "$D/$FUT" "$D/$FUTW" "$D/$FUT_KEEP"
# FUT and FUTW: years-old ctimes, through the shim (one at a time: it matches one path suffix).
MOCK_STAT_PATH="/$FUT" MOCK_STAT_VAL=1577836800 bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed'
[[ ! -e "$D/$FUT" ]] || fail 'a janitor tombstone named in the future was kept although its ctime is years old'
MOCK_STAT_PATH="/$FUTW" MOCK_STAT_VAL=1577836800 bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed'
[[ ! -e "$D/$FUTW" ]] || fail 'a worker tombstone named in the future was kept although its ctime is years old'
[[ -d "$D/$BIG" ]] || fail 'removed a tombstone whose name time overflows int64'
grep -q "\"why\":\"$BIG: its age cannot be read; left alone\"" "$TMP/out" || fail 'the overflowing tombstone time is not an error line'
[[ "$(field errors)" == 5 ]] || fail "errors: want 5 (4 from the fixture under an empty list, the overflow): $(summary)"
! grep -qi 'invalid\|value too great' "$TMP/out" || fail "an arithmetic error leaked: $(cat "$TMP/out")"
bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed'
[[ -d "$D/$FUT_KEEP" ]] || fail 'a future-named tombstone with a fresh ctime was removed'
pass 'a tombstone time beyond int64 is a counted error (kept); a future name time falls back to the ctime'

# 17. A directory whose mtime does not read as a decimal time is an error, kept -- even when its
# workspace.img's mtime (here: years old) reads fine.
setup_dirs
echo '{"live":[],"terminated":[]}' >"$MOCK_JSON"
MOCK_STAT_PATH="/$UNK_OLD" MOCK_STAT_VAL=0123 bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed'
[[ -d "$D/$UNK_OLD" ]] || fail 'removed an unknown dir whose mtime reads 0123'
grep -q "\"wsk\":\"$UNK_OLD\",\"why\":\"unknown, and its mtime cannot be read; kept\"" "$TMP/out" || fail 'the unreadable mtime is not an error line'
pass 'an unknown directory with an unreadable mtime is an error, kept'

# 18. A token file owned by another user is refused before anything is asked or touched.
setup_dirs
list
before="$(snapshot)"
mkdir -p "$TMP/idbin"
printf '#!/usr/bin/env bash\n[[ "$1" == -u ]] && { echo 4242; exit 0; }\nexec %q "$@"\n' "$(command -v id)" >"$TMP/idbin/id"
chmod +x "$TMP/idbin/id"
: >"$MOCK_LOG"
rc=0
PATH="$TMP/idbin:$PATH" bash "$J" >"$TMP/out" 2>&1 || rc=$?
((rc == 2)) || fail "exit $rc with a token file owned by another uid"
grep -q 'must be owned by uid 4242' "$TMP/out" || fail 'the owner refusal does not say why'
[[ ! -s "$MOCK_LOG" && "$before" == "$(snapshot)" ]] || fail 'asked the control plane or touched the disk before refusing the owner'
pass 'refuses a token file owned by another user: exit 2, no request, nothing touched'

# 19. An mv that cannot rename without following a symlink at its target is refused at startup.
# Two shims: one rejects -T and -h (busybox-like); one accepts them but ignores them (plain mv).
for kind in rejects ignores; do
  setup_dirs
  list
  before="$(snapshot)"
  mkdir -p "$TMP/mvbin-$kind"
  if [[ "$kind" == rejects ]]; then
    printf '#!/usr/bin/env bash\ncase "$1" in --version|-T|-h) echo "mv: unrecognized option $1" >&2; exit 1;; esac\nexec %q "$@"\n' "$(command -v mv)" >"$TMP/mvbin-$kind/mv"
  else
    printf '#!/usr/bin/env bash\ncase "$1" in --version) exit 1;; -T|-h) shift;; esac\n[[ "$1" != -- ]] || shift\nexec /bin/mv -- "$@"\n' >"$TMP/mvbin-$kind/mv"
  fi
  chmod +x "$TMP/mvbin-$kind/mv"
  : >"$MOCK_LOG"
  rc=0
  PATH="$TMP/mvbin-$kind:$PATH" bash "$J" >"$TMP/out" 2>&1 || rc=$?
  ((rc == 2)) || fail "exit $rc with an mv that $kind -T/-h"
  grep -q 'supports neither -T (GNU) nor -h (BSD)' "$TMP/out" || fail "the mv refusal ($kind) does not say why"
  [[ ! -s "$MOCK_LOG" && "$before" == "$(snapshot)" ]] || fail "asked the control plane or touched the disk with an mv that $kind -T/-h"
done
pass 'refuses, before anything else, an mv that rejects or ignores both -T and -h'

# 20. The worker's lease state files (<root>/.lease-state/<wsk>.json) follow the workspace: a reclaimed
# key's file goes (terminated or unknown-idle), and so does a terminated key's whose workspace the
# worker had already reclaimed; a live, a recent and an unlisted key's stay, and so does the boot
# marker. A symlinked .lease-state, or a symlinked state file, is refused and not followed.
setup_dirs
list
LS="$D/.lease-state"
mkdir -p "$LS" "$P/.lease-state"
for key in "$TERM_OLD" "$UNK_OLD" "$LIVE" "$LIVE_TOO" "$TERM_RECENT" "$UNK_NEW" "$(k 7)" "$(k 9)"; do
  printf '{"mode":"lease","epoch":1,"known":true}' >"$LS/$key.json"
done
printf '{"mode":"lease","epoch":1,"known":true}' >"$P/.lease-state/$PY_TERM.json"
printf 'lease=on\n' >"$LS/.boot"
bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed'
[[ ! -e "$LS/$TERM_OLD.json" ]] || fail "a reclaimed terminated sandbox kept its lease state file"
[[ ! -e "$P/.lease-state/$PY_TERM.json" ]] || fail "another installed worker's reclaimed sandbox kept its lease state file"
[[ ! -e "$LS/$UNK_OLD.json" ]] || fail 'a reclaimed idle unknown directory kept its lease state file'
[[ ! -e "$LS/$(k 7).json" ]] || fail 'a sandbox terminated more than the wait ago, its workspace already gone, kept its lease state file'
for key in "$LIVE" "$LIVE_TOO" "$TERM_RECENT" "$UNK_NEW" "$(k 9)"; do
  [[ -f "$LS/$key.json" ]] || fail "removed the lease state file of $key (live, recent, newer unknown or unlisted)"
done
[[ -f "$LS/.boot" ]] || fail 'removed the worker boot marker'
grep -q "\"janitor\":\"lease_state_removed\",\"wrk\":\"sbx_default\",\"wsk\":\"$TERM_OLD\"" "$TMP/out" || fail 'no lease_state_removed line'
[[ "$(field removed)" == 3 && "$(field errors)" == 4 ]] || fail "lease state files changed the counts: $(summary)"

setup_dirs
list
mkdir -p "$TMP/outside/ls"
printf '{}' >"$TMP/outside/ls/$TERM_OLD.json"
ln -s "$TMP/outside/ls" "$D/.lease-state"
bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed'
[[ -f "$TMP/outside/ls/$TERM_OLD.json" && -L "$D/.lease-state" ]] || fail 'removed a state file through a symlinked .lease-state'
grep -q '"janitor":"error","wrk":"sbx_default","wsk":"","why":".lease-state is a symlink or not a directory' "$TMP/out" ||
  fail 'the symlinked .lease-state is not refused as such'
[[ ! -e "$D/$TERM_OLD" ]] || fail 'a symlinked .lease-state stopped the workspace reclaim'

setup_dirs
list
mkdir -p "$D/.lease-state"
ln -s "$TMP/outside/precious" "$D/.lease-state/$TERM_OLD.json"
bash "$J" >"$TMP/out" 2>&1 || fail 'janitor failed'
[[ -f "$TMP/outside/precious" && -L "$D/.lease-state/$TERM_OLD.json" ]] || fail 'removed a symlinked state file or what it points at'
grep -q "\"janitor\":\"error\",\"wrk\":\"sbx_default\",\"wsk\":\"$TERM_OLD\",\"why\":\"its lease state file is a symlink or not a file" "$TMP/out" ||
  fail 'the symlinked state file is not refused as such'
pass 'removes the lease state file of a freed workspace (or of a terminated one already gone); keeps the rest; never through a symlink'
