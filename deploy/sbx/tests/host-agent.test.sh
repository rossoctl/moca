#!/usr/bin/env bash
# Tests for deploy/sbx/host-agent.sh (template lifecycle spec §6.1), with curl and template-build.sh
# mocked on PATH: a fake control plane that hands out one build and records every report, and a fake
# build that writes a template record and manifest where template-build.sh would. What must hold:
# the token is sent only from a 0600 header file (never argv, never output); a successful build is
# reported `built` with the record and manifest as files; a failed one `failed` with its exit; a
# gate record is checked against its digest before the build; no build is claimed below the disk
# floor or without a registry login; nothing that names where an image lives leaves the host (a
# failure's reason and log redacted, a record naming SBX_REGISTRY not sent); the wanted state starts
# installed workers and stops unwanted ones (systemctl mocked), each reported, under a lock that
# --wanted-only runs share; the egress step (journalctl mocked) ships only this host's sandboxes'
# proxy events, as written, never acting on moca-egress; and the agent refuses its own bad settings
# before it calls anything.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }
A="$SRC/deploy/sbx/host-agent.sh"
TOKEN="$(printf 'a%.0s' {1..64})"
DIGEST="3d3e705ff379defc6684c220f97fc8701df4e06fce8fa8841c13d3ff8cef7746"
GATE='{"gate":{"passed":true}}'
GATE_SHA="$(printf '%s' "$GATE" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"

mkdir -p "$TMP/bin" "$TMP/srv/templates" "$TMP/srv/snapshots" "$TMP/state"
# curl: the fake control plane. Logs its argv; answers only with the bearer from a header file.
cat >"$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$MOCK_LOG"
args=("$@") hdr='' url='' data='' method=GET outf='' wfmt=''
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ "${args[$i]}" == -H && "${args[$((i + 1))]:-}" == @* ]] && hdr="${args[$((i + 1))]#@}"
  [[ "${args[$i]}" == --data-binary ]] && data="${args[$((i + 1))]#@}"
  [[ "${args[$i]}" == -X ]] && method="${args[$((i + 1))]}"
  [[ "${args[$i]}" == https://* ]] && url="${args[$i]}"
  [[ "${args[$i]}" == -o ]] && outf="${args[$((i + 1))]}"
  [[ "${args[$i]}" == -w ]] && wfmt=1
done
[[ -n "$hdr" && "$(cat "$hdr")" == "Authorization: Bearer $(cat "$MOCK_TOKEN_FILE")" ]] || { echo 'curl: (22) 401' >&2; exit 22; }
path="${url#https://cp.example.invalid}"
[[ -z "$data" ]] || cp "$data" "$MOCK_STATE/$(printf '%s' "$method$path" | tr '/' '_')"
case "$method $path" in
"POST /v1/hosts/host-1/inventory") echo '{"host":"host-1","holds":0}' ;;
"POST /v1/hosts/host-1/builds/claim") cat "$MOCK_STATE/claim-answer" ;;
"GET /v1/hosts/host-1/blobs/"*) printf '{"sha256":"x","base64":"%s"}' "$(printf '%s' "$MOCK_GATE" | base64)" ;;
"POST /v1/hosts/host-1/builds/"*/log) echo '{"appended":1}' ;;
"POST /v1/hosts/host-1/builds/"*/report) echo '{"status":"registered","buildId":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}' ;;
"GET /v1/hosts/host-1/wanted")
  # wanted-later: the answer from a run's second read on (a sandbox created after the first).
  if [[ -f "$MOCK_STATE/wanted-later" && -f "$MOCK_STATE/wanted-read" ]]; then cat "$MOCK_STATE/wanted-later"; else cat "$MOCK_STATE/wanted-answer"; fi
  touch "$MOCK_STATE/wanted-read" ;;
"POST /v1/hosts/host-1/workers/report") echo '{"recorded":"x"}' ;;
"POST /v1/hosts/host-1/egress")
  # As the agent calls it: -o ANSWER -w '%{http_code}', no -f. egress-fail: no answer at all;
  # egress-status: answer with that status (400 with invalid_request, 404 not_found, else an error).
  [[ -n "$outf" && -n "$wfmt" && " $* " != *" -fsS "* ]] || { echo 'curl: egress posted without -o/-w' >&2; exit 2; }
  [[ ! -f "$MOCK_STATE/egress-fail" ]] || { echo 'curl: (7) Failed to connect' >&2; printf 000; exit 7; }
  [[ ! -f "$MOCK_STATE/egress-sleep" ]] || sleep "$(<"$MOCK_STATE/egress-sleep")"
  if [[ -f "$MOCK_STATE/egress-status" ]]; then
    st="$(<"$MOCK_STATE/egress-status")"
    case "$st" in
    400) echo '{"error":"invalid_request","message":"events and oversized must be arrays"}' >"$outf" ;;
    404) echo '{"error":"not_found"}' >"$outf" ;;
    *) echo '{"error":"redis_unavailable"}' >"$outf" ;;
    esac
    printf '%s' "$st"; exit 0
  fi
  cat "$data" >>"$MOCK_STATE/egress-posts"
  printf '{"accepted":%d,"refused":0,"capped":0,"invalid":0,"dropped":0,"cursor":%s}' \
    "$(jq '.events | length' "$data")" "$(jq .cursor "$data")" >"$outf"
  printf 200 ;;
*) echo "curl: (22) 404 $method $path" >&2; exit 22 ;;
esac
MOCK
# template-build.sh: logs its argv; writes the record and manifest template-build.sh would, or fails.
cat >"$TMP/bin/template-build" <<'MOCK'
#!/usr/bin/env bash
printf 'build %s\n' "$*" >>"$MOCK_LOG"
[[ -z "${MOCK_BUILD_FAIL:-}" ]] || { echo 'build-snapshot.sh: the --verify-command exited 91'; exit 1; }
spec="$1" id="$(jq -r .id "$1")" d="$(jq -r .image "$1")"; d="${d##*@sha256:}"; name="$id-${d:0:12}"
mkdir -p "$SBX_SRV/snapshots/$name"
printf '{"hash_version":2,"hash":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","guest_ram_mb":1}' >"$SBX_SRV/snapshots/$name/manifest.json"
jq -n --arg n "$name" --arg id "$id" '{schema: "moca-sbx-template/1", id: $id, snapshot: $n, manifest_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}' \
  >"$SBX_SRV/templates/$name.json"
echo "==> built template $id"
MOCK
# systemctl: logs its argv; `is-active` answers from $MOCK_STATE/active-<unit>.
cat >"$TMP/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$MOCK_LOG"
case "$1" in
is-active) [[ -f "$MOCK_STATE/active-${!#}" ]] ;;
is-enabled) [[ -f "$MOCK_STATE/enabled-${!#}" ]] ;;
start) touch "$MOCK_STATE/active-$2" ;;
stop) rm -f "$MOCK_STATE/active-$2" ;;
esac
MOCK
# flock: util-linux on the hosts, absent on a developer's Mac. `flock -n FD` fails while
# $MOCK_STATE/locked exists, as a lock another run holds (or $MOCK_STATE/locked-FD, that fd's only).
cat >"$TMP/bin/flock" <<'MOCK'
#!/usr/bin/env bash
[[ ! -e "$MOCK_STATE/locked" && ! -e "$MOCK_STATE/locked-${!#}" ]]
MOCK
# journalctl: logs its argv; answers -o json entries from $MOCK_STATE/journal (one JSON entry a line,
# each with __CURSOR), from --cursor or after --after-cursor when given. As journalctl (257) does: a
# cursor it cannot parse (here: one with no digit) is "Failed to seek to cursor" and exit 1; a
# well-formed one no entry has (vacuumed, or another machine's) falls back and prints every entry,
# exit 0. Without --all, a MESSAGE over 4096 bytes is printed null. Exits 1 if anything else is asked.
cat >"$TMP/bin/journalctl" <<'MOCK'
#!/usr/bin/env bash
printf 'journalctl %s\n' "$*" >>"$MOCK_LOG"
at='' after=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ "${args[$i]}" == --after-cursor ]] && after="${args[$((i + 1))]}"
  [[ "${args[$i]}" == --cursor ]] && at="${args[$((i + 1))]}"
done
[[ " $* " == *" -u moca-egress.service -o json "* ]] || exit 1
full() { if [[ " $* " == *" --all "* ]]; then cat; else
  jq -c 'if (.MESSAGE | type) == "string" and (.MESSAGE | utf8bytelength) > 4096 then .MESSAGE = null else . end'; fi; }
c="${at:-$after}"
[[ -z "$c" || "$c" == *[0-9]* ]] || { echo 'Failed to seek to cursor: Invalid argument' >&2; exit 1; }
[[ -f "$MOCK_STATE/journal" ]] || exit 0
if [[ -z "$c" ]] || ! grep -qF "\"__CURSOR\":\"$c\"" "$MOCK_STATE/journal"; then cat "$MOCK_STATE/journal" | full "$@"
elif [[ -n "$at" ]]; then awk -v c="$c" 'index($0, "\"__CURSOR\":\"" c "\"") { seen = 1 } seen { print }' "$MOCK_STATE/journal" | full "$@"
else awk -v c="$c" 'seen { print } index($0, "\"__CURSOR\":\"" c "\"") { seen = 1 }' "$MOCK_STATE/journal" | full "$@"
fi
MOCK
chmod +x "$TMP/bin/curl" "$TMP/bin/template-build" "$TMP/bin/systemctl" "$TMP/bin/flock" "$TMP/bin/journalctl"
printf '{"run":[],"stop":[]}' >"$TMP/state/wanted-answer"
mkdir -p "$TMP/workers"
: >"$TMP/kernel"
(umask 077 && printf '%s' "$TOKEN" >"$TMP/token")
export PATH="$TMP/bin:$PATH" MOCK_LOG="$TMP/log" MOCK_STATE="$TMP/state" MOCK_TOKEN_FILE="$TMP/token" MOCK_GATE="$GATE"
export SBX_API_URL=https://cp.example.invalid SBX_HOST_ID=host-1 SBX_HOST_TOKEN_FILE="$TMP/token" SBX_KERNEL="$TMP/kernel"
export SBX_SRV="$TMP/srv" SBX_ENV_DIR="$TMP" SBX_TEMPLATE_BUILD="$TMP/bin/template-build" SBX_DISK_FLOOR_GB=0

job() { # job [GATE_SHA]: the claim answer, one build of the worked example
  jq -n --arg d "$DIGEST" --arg g "${1:-}" '{builds: [{template: "django-django-11133", build: "b-0123456789abcdef0123456789",
    image: ("images/moca-microvm@sha256:" + $d),
    spec: {id: "django-django-11133", image: ("images/moca-microvm@sha256:" + $d), guest_ram_mb: 4096}}
    + (if $g == "" then {} else {gateRecord: ("/v1/hosts/host-1/blobs/sha256:" + $g)} end)]}' >"$TMP/state/claim-answer"
}
run() { : >"$MOCK_LOG"; rm -f "$TMP/state/POST_"*; bash "$A" --once >"$TMP/out" 2>&1; }

# 1. A good build: claimed, built, reported with both files; the token only in a header file.
job "$GATE_SHA"
run || fail 'a good poll failed'
grep -q '"agent":"summary","claimed":1,"built":1,"failed":0,"started":0,"stopped":0,"errors":0' "$TMP/out" || fail 'summary'
R="$TMP/state/POST_v1_hosts_host-1_builds_b-0123456789abcdef0123456789_report"
jq -e '.event == "built" and (.templateRecord | fromjson | .manifest_hash == "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
  and (.manifest | fromjson | .hash_version == 2)' "$R" >/dev/null || fail 'the built report does not carry T and S as files'
grep -q -- "--gate-record $TMP" "$MOCK_LOG" || grep -q -- '--gate-record /' "$MOCK_LOG" || fail 'the build was not given its gate record'
grep -q -- "$TOKEN" "$MOCK_LOG" "$TMP/out" && fail 'the token reached argv or output'
jq -e '.limits.diskFloorGb == 0 and (.holds | length) == 0' "$TMP/state/POST_v1_hosts_host-1_inventory" >/dev/null || fail 'inventory'
pass 'a claimed build is built and reported built with its template record and manifest; the token stays in a 0600 header file'

# 2. The next poll's inventory names the snapshot it now holds.
job ''
printf '{"builds":[]}' >"$TMP/state/claim-answer"
run || fail 'second poll'
jq -e '.holds == [{template: "django-django-11133", manifestHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", running: false}]' "$TMP/state/POST_v1_hosts_host-1_inventory" >/dev/null ||
  fail 'the inventory does not name the held snapshot'
pass 'the inventory names the snapshots held, by manifest hash'

# 3. A failed build is reported failed, with template-build.sh's exit and last line.
job ''
MOCK_BUILD_FAIL=1 run || fail 'a failing build failed the poll'
jq -e '.event == "failed" and (.message | test("^probe_failed: template-build.sh exit 1: build-snapshot.sh: the --verify-command exited 91"))' "$R" >/dev/null ||
  fail 'the failure report'
grep -q '"failed":1' "$TMP/out" || fail 'summary of a failure'
pass 'a failed build is reported failed with its exit and last line'

# 4. A gate record whose bytes do not hash to its name is not built with.
job "$(printf 'b%.0s' {1..64})"
run || fail 'poll with a bad gate record'
grep -q '^build ' "$MOCK_LOG" && fail 'built with a gate record that does not match its digest'
grep -q 'does not match its digest' "$TMP/out" || fail 'the mismatch was not reported'
jq -e '.event == "failed" and .step == "gate" and .message == "agent_error: the gate record does not match its digest"' "$R" >/dev/null ||
  fail 'the claimed build was not reported failed on a gate digest mismatch'
grep -q '"agent":"summary","claimed":1,"built":0,"failed":1,"started":0,"stopped":0,"errors":0' "$TMP/out" || fail 'summary of a gate mismatch'
pass 'a gate record is checked against its digest before any build, and the claimed build reported failed'

# 5. Below the disk floor, nothing is claimed.
job ''
SBX_DISK_FLOOR_GB=999999999 run || fail 'poll below the floor'
grep -q 'builds/claim' "$MOCK_LOG" && fail 'claimed below the disk floor'
grep -q 'below the floor' "$TMP/out" || fail 'the floor skip was not said'
pass 'no build is claimed below the disk floor'

# 6. Its own settings, refused (exit 2) before any call.
for bad in 'SBX_HOST_ID=HOST-1' 'SBX_API_URL=http://cp.example.invalid' 'SBX_BUILD_CONCURRENCY=9' 'SBX_DISK_FLOOR_GB=060'; do
  : >"$MOCK_LOG"
  rc=0; env "$bad" bash "$A" --once >"$TMP/out" 2>&1 || rc=$?
  [[ "$rc" == 2 ]] || fail "accepted $bad (rc $rc)"
  [[ ! -s "$MOCK_LOG" ]] || fail "called the control plane before refusing $bad"
done
chmod 0644 "$TMP/token"
rc=0; bash "$A" --once >"$TMP/out" 2>&1 || rc=$?
if [[ "$rc" != 2 ]] || ! grep -q 'mode 0600' "$TMP/out"; then fail 'accepted a token file readable by others'; fi
chmod 0600 "$TMP/token"
rc=0; bash "$A" >"$TMP/out" 2>&1 || rc=$?
[[ "$rc" == 2 ]] || fail 'ran without --once'
pass 'refuses a bad host id, a non-https URL, a bad concurrency or floor, a shared token file, and no --once, before calling anything'

# 7. Nothing that names where an image lives leaves the host (a private registry's host carries its
#    account). A failure whose last line names one is reported redacted, the log upload too; the
#    full log stays on the host.
job ''
LEAK="build-rootfs.sh: could not pull 123456789012.registry.internal.example/images/moca-microvm@sha256:$DIGEST. Re-run"
cat >"$TMP/bin/template-build" <<MOCK
#!/usr/bin/env bash
printf 'build %s\\n' "\$*" >>"\$MOCK_LOG"
echo 'pulling from https://123456789012.registry.internal.example/v2/ at 10.1.2.3'
echo "$LEAK"
exit 1
MOCK
chmod +x "$TMP/bin/template-build"
run || fail 'the leaking poll failed'
for f in "$R" "$TMP/state/POST_v1_hosts_host-1_builds_b-0123456789abcdef0123456789_log"; do
  ! grep -qE 'internal\.example|123456789012|10\.1\.2\.3|https://' "$f" || fail "a registry host, account, IP or URL left the host in $(basename "$f")"
done
jq -e '.message | test("<registry>/images/moca-microvm@sha256:")' "$R" >/dev/null || fail 'the redacted reason lost the image path'
jq -e '.message | startswith("pull_failed: ")' "$R" >/dev/null || fail 'the reason does not lead with the pull_failed code'
grep -q 'internal.example' "$TMP/srv/agent-logs/b-0123456789abcdef0123456789.log" || fail 'the full log was not kept on the host'
[[ "$(stat -c %a "$TMP/srv/agent-logs" 2>/dev/null || stat -f %Lp "$TMP/srv/agent-logs")" == 700 ]] || fail 'agent-logs is not 0700'
pass 'a failed build reports redacted text only (no registry host, account, IP or URL); the full log stays on the host, root-only'

# 8. With SBX_REGISTRY set, no build is claimed until the registry login exists.
job ''
: >"$MOCK_LOG"
SBX_REGISTRY=reg.example.invalid REGISTRY_AUTH_FILE="$TMP/auth.json" bash "$A" --once >"$TMP/out" 2>&1 || fail 'no-login poll failed'
grep -q 'builds/claim' "$MOCK_LOG" && fail 'claimed a build with no registry login'
grep -q 'no registry login' "$TMP/out" || fail 'the skip does not say why'
printf '{"auths":{"reg.example.invalid":{"auth":"x"}}}' >"$TMP/auth.json"
: >"$MOCK_LOG"
SBX_REGISTRY=reg.example.invalid REGISTRY_AUTH_FILE="$TMP/auth.json" bash "$A" --once >"$TMP/out" 2>&1 || fail 'logged-in poll failed'
grep -q 'builds/claim' "$MOCK_LOG" || fail 'did not claim with a registry login'
! grep -q 'reg.example.invalid' "$TMP/out" || fail 'the registry host reached the output'
pass 'with SBX_REGISTRY, claims wait for a login in REGISTRY_AUTH_FILE, and the host is never printed'

# 9. SBX_REGISTRY is redacted exactly, whatever its shape (a bare name with an
#    uncommon suffix passed the patterns), and a built report whose template record or manifest
#    names it is not sent (T and S go byte for byte, so they cannot be masked).
reg_run() {
  : >"$MOCK_LOG"
  rm -f "$TMP/state/POST_"*
  SBX_REGISTRY=reg.internal REGISTRY_AUTH_FILE="$TMP/auth.json" bash "$A" --once >"$TMP/out" 2>&1
}
printf '{"auths":{"reg.internal":{"auth":"x"}}}' >"$TMP/auth.json"
job ''
cat >"$TMP/bin/template-build" <<'MOCK'
#!/usr/bin/env bash
printf 'build %s\n' "$*" >>"$MOCK_LOG"
echo 'build-rootfs.sh: could not pull reg.internal images/moca-microvm'
exit 1
MOCK
chmod +x "$TMP/bin/template-build"
reg_run || fail 'bare-host poll failed'
! grep -q 'reg\.internal' "$R" || fail 'a bare registry host with an uncommon suffix left the host in the reason'
jq -e '.message | test("<registry>")' "$R" >/dev/null || fail 'the registry was not marked redacted'
job ''
cat >"$TMP/bin/template-build" <<'MOCK'
#!/usr/bin/env bash
printf 'build %s\n' "$*" >>"$MOCK_LOG"
id="$(jq -r .id "$1")" d="$(jq -r .image "$1")"; d="${d##*@sha256:}"; name="$id-${d:0:12}"
mkdir -p "$SBX_SRV/snapshots/$name"
printf '{"hash_version":2,"hash":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}' >"$SBX_SRV/snapshots/$name/manifest.json"
jq -n --arg n "$name" --arg id "$id" '{schema: "moca-sbx-template/1", id: $id, snapshot: $n, image: "reg.internal/images/x@sha256:00"}' \
  >"$SBX_SRV/templates/$name.json"
MOCK
chmod +x "$TMP/bin/template-build"
reg_run || fail 'leaking-record poll failed'
jq -e '.event == "failed" and (.message | startswith("leak_refused: "))' "$R" >/dev/null || fail 'a record naming the registry was not refused'
! grep -q 'reg\.internal' "$R" || fail 'the refusal names the registry'
grep -q '"templateRecord"' "$R" && fail 'the template record was sent'
pass 'SBX_REGISTRY is redacted exactly, and a template record naming it is never reported'

# 10. The failure report's step comes from its code: `probe` for a probe failure.
job ''
cat >"$TMP/bin/template-build" <<'MOCK'
#!/usr/bin/env bash
printf 'build %s\n' "$*" >>"$MOCK_LOG"
echo 'build-snapshot.sh: the --verify-command exited 91'
exit 1
MOCK
chmod +x "$TMP/bin/template-build"
run || fail 'the probe-failure poll failed'
jq -e '.event == "failed" and .step == "probe" and (.message | startswith("probe_failed: "))' "$R" >/dev/null ||
  fail 'a probe failure is not reported with step probe'
pass 'reports a probe failure with step probe, beside its code'

# 11. A build that dies with no output (killed, out of memory) is still reported failed, and the
#     poll goes on to its summary (an empty log once ended the whole run under errexit).
job ''
cat >"$TMP/bin/template-build" <<'MOCK'
#!/usr/bin/env bash
printf 'build %s\n' "$*" >>"$MOCK_LOG"
printf '\n\n'
exit 137
MOCK
chmod +x "$TMP/bin/template-build"
run || fail 'a build with an empty log failed the poll'
jq -e '.event == "failed" and .step == "build" and (.message | startswith("build_failed: template-build.sh exit 137"))' "$R" >/dev/null ||
  fail 'a build with an empty log is not reported failed'
grep -q '"agent":"summary","claimed":1,"built":0,"failed":1,"started":0,"stopped":0,"errors":0' "$TMP/out" || fail 'no summary after an empty build log'
pass 'a build that dies with no output is reported failed, and the poll ends with its summary'

# 12. Every way out short of `built` after a claim reports the build failed (agent_error), so it
#     does not stay `building`: a gate record that cannot be fetched, a build that wrote no template
#     record, and one whose record is not JSON.
job "$GATE_SHA"
sed 's#"GET /v1/hosts/host-1/blobs/"\*)#"GET /v1/hosts/host-1/blobs/none")#' "$TMP/bin/curl" >"$TMP/bin/curl.noblob"
cp "$TMP/bin/curl" "$TMP/curl.keep"
mv "$TMP/bin/curl.noblob" "$TMP/bin/curl" && chmod +x "$TMP/bin/curl"
run || fail 'a poll whose gate fetch failed'
cp "$TMP/curl.keep" "$TMP/bin/curl"
grep -q '^build ' "$MOCK_LOG" && fail 'built without its gate record'
jq -e '.event == "failed" and .step == "gate" and .message == "agent_error: the gate record fetch failed"' "$R" >/dev/null ||
  fail 'a failed gate fetch was not reported failed'
job ''
cat >"$TMP/bin/template-build" <<'MOCK'
#!/usr/bin/env bash
printf 'build %s\n' "$*" >>"$MOCK_LOG"
rm -f "$SBX_SRV"/templates/*.json
exit 0
MOCK
chmod +x "$TMP/bin/template-build"
run || fail 'a poll whose build wrote no record'
jq -e '.event == "failed" and .step == "report" and .message == "agent_error: template-build.sh wrote no template record"' "$R" >/dev/null ||
  fail 'a build with no template record was not reported failed'
cat >"$TMP/bin/template-build" <<'MOCK'
#!/usr/bin/env bash
printf 'build %s\n' "$*" >>"$MOCK_LOG"
id="$(jq -r .id "$1")" d="$(jq -r .image "$1")"; d="${d##*@sha256:}"
printf 'not json' >"$SBX_SRV/templates/$id-${d:0:12}.json"
MOCK
chmod +x "$TMP/bin/template-build"
run || fail 'a poll whose record is not JSON ended early'
jq -e '.event == "failed" and .message == "agent_error: the template record names no snapshot"' "$R" >/dev/null ||
  fail 'a build with a record that is not JSON was not reported failed'
grep -q '"agent":"summary","claimed":1,"built":0,"failed":1,"started":0,"stopped":0,"errors":0' "$TMP/out" || fail 'no summary after a record that is not JSON'
rm -f "$TMP/srv/templates/"*.json
pass 'a claimed build is reported failed (agent_error) on a failed gate fetch, a missing record, or a record that is not JSON'

# 13. Activation: start a wanted, installed worker and report attached; refuse one not installed;
#     stop one no longer wanted and report detached; never start a malformed worker id.
job ''
printf '{"builds":[]}' >"$TMP/state/claim-answer"
: >"$TMP/workers/sbx_t1.env"
printf '{"run":[{"worker":"sbx_t1","buildId":"sha256:1"},{"worker":"sbx_t2","buildId":"sha256:2"}],"stop":[]}' >"$TMP/state/wanted-answer"
run || fail 'activation poll'
grep -q 'systemctl start sbx-worker@sbx_t1.service' "$MOCK_LOG" || fail 'did not start the wanted, installed worker'
grep -q 'systemctl start sbx-worker@sbx_t2.service' "$MOCK_LOG" && fail 'started a worker that is not installed'
grep -q '"started":1' "$TMP/out" || fail 'the start is not in the summary'
grep -q '"agent":"refused","worker":"sbx_t2"' "$TMP/out" || fail 'the refusal is not said'
W="$TMP/state/POST_v1_hosts_host-1_workers_report"
jq -e '.event == "refused" and .buildId == "sha256:2" and (.reason | test("not installed"))' "$W" >/dev/null ||
  fail 'the refusal was not reported to the control plane'
: >"$MOCK_LOG"
run || fail 'a second activation poll'
grep -q 'systemctl start sbx-worker@sbx_t1.service' "$MOCK_LOG" && fail 'started a worker whose unit is already active'
printf '{"run":[],"stop":[{"worker":"sbx_t1","buildId":"sha256:1"}]}' >"$TMP/state/wanted-answer"
run || fail 'stop poll'
grep -q 'systemctl stop sbx-worker@sbx_t1.service' "$MOCK_LOG" || fail 'did not stop the unwanted worker'
jq -e '.event == "detached" and .buildId == "sha256:1"' "$W" >/dev/null || fail 'detach not reported'
grep -q '"stopped":1' "$TMP/out" || fail 'the stop is not in the summary'
# The inventory says which held builds' worker units run: a record whose worker's unit is active.
jq -n '{schema: "moca-sbx-template/1", id: "t1", worker: "sbx_t1", snapshot: "t1-x", manifest_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111"}' \
  >"$SBX_SRV/templates/t1-x.json"
printf '{"run":[{"worker":"sbx_t1","buildId":"sha256:1"}],"stop":[]}' >"$TMP/state/wanted-answer"
run || fail 'restart poll'
run || fail 'running-inventory poll'
jq -e '.holds | map(select(.template == "t1")) == [{template: "t1", manifestHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111", running: true}]' \
  "$TMP/state/POST_v1_hosts_host-1_inventory" >/dev/null || fail 'the inventory does not say the running worker runs'
# Stops come before starts, so a freed slot is free before a start takes it.
printf '{"run":[{"worker":"sbx_t2","buildId":"sha256:2"}],"stop":[{"worker":"sbx_t1","buildId":"sha256:1"}]}' >"$TMP/state/wanted-answer"
: >"$TMP/workers/sbx_t2.env"; : >"$MOCK_LOG"
run || fail 'stop-and-start poll'
[[ "$(grep -E 'systemctl (start|stop) ' "$MOCK_LOG" | cut -d' ' -f2 | tr '\n' ' ')" == 'stop start ' ]] || fail 'did not stop before starting'
rm -f "$TMP/workers/sbx_t2.env" "$SBX_SRV/templates/t1-x.json" "$TMP/state/active-sbx-worker@sbx_t2.service"
printf '{"run":[{"worker":"../x","buildId":"sha256:1"}],"stop":[]}' >"$TMP/state/wanted-answer"
run || fail 'malformed wanted poll'
grep -q 'systemctl start' "$MOCK_LOG" && fail 'started a malformed worker id'
grep -q 'a wanted worker id is malformed' "$TMP/out" || fail 'the malformed id was not said'
printf '{"run":"x"}' >"$TMP/state/wanted-answer"
run || fail 'malformed wanted state'
grep -q 'wanted state malformed' "$TMP/out" || fail 'a malformed wanted state was not said'
printf '{"run":[],"stop":[]}' >"$TMP/state/wanted-answer"
pass 'starts wanted installed workers (attached), refuses uninstalled ones, stops unwanted ones (detached), refuses a malformed id'

# 14. --wanted-only: the inventory and the wanted state, never a claim or a build; the lock keeps it
#     and a build poll from applying the wanted state at once; usage refused otherwise.
job ''
: >"$TMP/workers/sbx_t2.env"
printf '{"run":[{"worker":"sbx_t2","buildId":"sha256:2"}],"stop":[]}' >"$TMP/state/wanted-answer"
: >"$MOCK_LOG"; rm -f "$TMP/state/POST_"* "$TMP/state/active-sbx-worker@sbx_t2.service"
bash "$A" --wanted-only >"$TMP/out" 2>&1 || fail 'the wanted-only run failed'
grep -q 'builds/claim' "$MOCK_LOG" && fail 'the wanted-only run claimed a build'
grep -q '^build ' "$MOCK_LOG" && fail 'the wanted-only run built'
grep -q 'hosts/host-1/inventory' "$MOCK_LOG" || fail 'the wanted-only run did not report the inventory'
grep -q 'systemctl start sbx-worker@sbx_t2.service' "$MOCK_LOG" || fail 'the wanted-only run did not start the wanted worker'
grep -q '"agent":"summary","claimed":0,"built":0,"failed":0,"started":1,"stopped":0,"errors":0' "$TMP/out" || fail 'the wanted-only summary'
rm -f "$TMP/state/active-sbx-worker@sbx_t2.service"; touch "$TMP/state/locked"; : >"$MOCK_LOG"
bash "$A" --wanted-only >"$TMP/out" 2>&1 || fail 'the locked run failed'
grep -q 'systemctl start' "$MOCK_LOG" && fail 'started a worker while another run held the lock'
grep -q 'another run is applying the wanted state' "$TMP/out" || fail 'the lock skip does not say why'
rm -f "$TMP/state/locked"
! bash "$A" --once --wanted-only >"$TMP/out" 2>&1 || fail 'accepted two modes'
printf '{"run":[],"stop":[]}' >"$TMP/state/wanted-answer"
pass 'with --wanted-only, applies the wanted state and claims nothing; one run at a time applies it'

# 13. The egress step, in --wanted-only runs: off unless moca-egress is enabled (no
#     journal read, no post, no cursor file); on, it posts the proxy's events exactly as written, in
#     batches of up to 1000, the token from the 0600 header file; a failed post keeps the cursor and
#     re-sends the same batch; a non-event line is skipped and never posted. example.com hosts only.
SID=sbx-0123456789abcdef0123456789
printf '{"run":[],"stop":[],"egressSids":["%s"]}' "$SID" >"$TMP/state/wanted-answer"
EV='{"time":"2026-11-08T12:00:00.5Z","via":"moca-egress","vm_id":"vm-1","sid":"sbx-0123456789abcdef0123456789","host":"pypi.example.com","dial_addr":"192.0.2.10:443","method":"CONNECT","status":200,"bytes_up":10,"bytes_down":20,"decision":"tunnel"}'
EV2='{"time":"2026-11-08T12:00:01Z","via":"moca-egress","vm_id":"vm-1","sid":"sbx-0123456789abcdef0123456789","host":"files.example.com","method":"GET","path":"/x/","status":403,"bytes_up":0,"bytes_down":0,"credential":"mirror","decision":"destination_denied","coalesced":2}'
# entry CURSOR MESSAGE [MONOTONIC]: a journal entry of boot b1; the monotonic time defaults to the
# cursor's number (c12 -> 12), so entries are in journal order.
entry() { jq -cn --arg c "$1" --arg m "$2" --arg t "${3:-${1#c}}" '{__CURSOR: $c, __MONOTONIC_TIMESTAMP: $t, _BOOT_ID: "b1", MESSAGE: $m, _SYSTEMD_UNIT: "moca-egress.service"}'; }
# entries FROM TO MESSAGE: entry c<FROM> ... c<TO>, all MESSAGE, in one jq run (a jq per entry is slow).
entries() { jq -cn --argjson a "$1" --argjson b "$2" --arg m "$3" 'range($a; $b + 1) | {__CURSOR: "c\(.)", __MONOTONIC_TIMESTAMP: "\(.)", _BOOT_ID: "b1", MESSAGE: $m, _SYSTEMD_UNIT: "moca-egress.service"}'; }
{ entry c1 "$EV"; entry c2 'moca-egress: serving 3 allowlist entries'; entry c3 "$EV2"; } >"$TMP/state/journal"
egress_run() { : >"$MOCK_LOG"; rm -f "$TMP/state/egress-posts" "$TMP/state/wanted-read"; bash "$A" --wanted-only >"$TMP/out" 2>&1; }
# Off: the unit is not active, even if it is enabled (a stopped proxy: nothing to ship).
rm -f "$TMP/state/active-moca-egress.service" "$TMP/srv/egress.cursor" "$TMP/srv/egress.pending.json"
touch "$TMP/state/enabled-moca-egress.service"
egress_run || fail 'the egress-off run failed'
grep -q '^journalctl' "$MOCK_LOG" && fail 'read the journal with moca-egress not active'
grep -q '/egress' "$MOCK_LOG" && fail 'posted with moca-egress not active'
[[ ! -e "$TMP/srv/egress.cursor" && ! -e "$TMP/srv/egress.pending.json" ]] || fail 'wrote a cursor or batch with egress off'
grep -q '"egress":"off","egressRead":0,"egressAccepted":0,"egressRefused":0,"egressSkipped":0,"egressRejected":0,"egressNotOurs":0' "$TMP/out" || fail 'the off summary'
grep -q 'systemctl is-active --quiet moca-egress.service' "$MOCK_LOG" || fail 'the switch did not ask is-active'
grep -Eq 'systemctl (start|stop|restart|enable|disable)[^@]*moca-egress' "$MOCK_LOG" && fail 'acted on moca-egress'
# On: active but NOT enabled (install-host.sh reuses a P6 moca-egress without enabling it): both events
# posted as written, the proxy's own log line skipped, the cursor at the last entry.
rm -f "$TMP/state/enabled-moca-egress.service"
touch "$TMP/state/active-moca-egress.service"
egress_run || fail 'the egress run failed'
grep -q 'journalctl -u moca-egress.service -o json --all --no-pager -b' "$MOCK_LOG" || fail 'the first read is not from this boot'
jq -e --argjson a "$EV" --argjson b "$EV2" '.events == [$a, $b] and .cursor == "c3" and .oversized == []' "$TMP/state/egress-posts" >/dev/null ||
  fail 'the post does not carry exactly the proxy events and the last cursor'
jq -e '[.events[] | keys[]] - ["time","via","vm_id","sid","sub","host","dial_addr","method","path","status","bytes_up","bytes_down","credential","decision","dropped","coalesced"] == []' \
  "$TMP/state/egress-posts" >/dev/null || fail 'a field beyond the proxy Event was posted'
[[ "$(<"$TMP/srv/egress.cursor")" == c3 ]] || fail 'the cursor is not the last entry'
[[ "$(stat -c %a "$TMP/srv/egress.cursor" 2>/dev/null || stat -f %Lp "$TMP/srv/egress.cursor")" == 600 ]] || fail 'the cursor file is not 0600'
[[ ! -e "$TMP/srv/egress.pending.json" ]] || fail 'the posted batch was kept'
grep -q 'curl .*-H @.*/v1/hosts/host-1/egress' "$MOCK_LOG" || fail 'the post did not use the header file'
grep -q -- "$TOKEN" "$MOCK_LOG" "$TMP/out" && fail 'the token reached argv or output'
grep -q 'pypi.example.com' "$TMP/out" && fail 'an egress event was printed'
grep -q '"egress":"on","egressRead":3,"egressAccepted":2,"egressRefused":0,"egressSkipped":0,"egressRejected":0,"egressNotOurs":0' "$TMP/out" || fail 'the on summary'
grep -qE 'systemctl (start|stop|restart|reload|kill)[^@]*moca-egress' "$MOCK_LOG" && fail 'acted on moca-egress'
# Nothing new: nothing posted, the cursor unchanged.
egress_run || fail 'the idle egress run failed'
grep -q 'journalctl .*--after-cursor c3' "$MOCK_LOG" || fail 'did not resume after the cursor'
[[ ! -e "$TMP/state/egress-posts" ]] || fail 'posted with nothing new'
# The control plane down: an error, the cursor where it was, the batch kept; the next run re-sends it.
entry c4 "$EV" >>"$TMP/state/journal"
touch "$TMP/state/egress-fail"
egress_run || fail 'the failing egress run failed'
[[ "$(<"$TMP/srv/egress.cursor")" == c3 ]] || fail 'the cursor moved on a failed post'
grep -q '"errors":1,"egress":"on"' "$TMP/out" || fail 'the failed post is not counted as an error'
grep -q 'egress post failed: the cursor stays' "$TMP/out" || fail 'the failed post is not said'
cp "$TMP/srv/egress.pending.json" "$TMP/pending.before"
entry c5 "$EV2" >>"$TMP/state/journal"
rm -f "$TMP/state/egress-fail"
egress_run || fail 'the retry run failed'
head -c "$(wc -c <"$TMP/pending.before")" "$TMP/state/egress-posts" | cmp -s - "$TMP/pending.before" || fail 'the retry did not re-send the same batch first'
jq -s -e '.[0].cursor == "c4" and .[1].cursor == "c5"' "$TMP/state/egress-posts" >/dev/null || fail 'the retry and the next batch'
[[ "$(<"$TMP/srv/egress.cursor")" == c5 ]] || fail 'the cursor after the retry'
# Batches of 1000: 1001 entries are two posts.
: >"$TMP/state/journal"
entries 6 1006 "$EV" >"$TMP/state/journal.new"
{ entry c5 "$EV2"; cat "$TMP/state/journal.new"; } >"$TMP/state/journal"
egress_run || fail 'the batch run failed'
jq -s -e '(map(.events | length) == [1000, 1]) and .[1].cursor == "c1006"' "$TMP/state/egress-posts" >/dev/null || fail 'not batches of 1000'
# An event over 8 KiB is kept back, and only its sid is sent, as oversized.
BIG="$(jq -cn --argjson e "$EV" '$e + {path: ("/" + ("a" * 9000))}')"
entry c1007 "$BIG" >>"$TMP/state/journal"
egress_run || fail 'the oversized run failed'
jq -e '.events == [] and .oversized == ["sbx-0123456789abcdef0123456789"]' "$TMP/state/egress-posts" >/dev/null || fail 'an oversized event'
# An event of 5 KiB (over journalctl's 4096-byte field limit without --all) is sent whole.
MID="$(jq -cn --argjson e "$EV" '$e + {path: ("/" + ("b" * 5000))}')"
entry c1008 "$MID" >>"$TMP/state/journal"
egress_run || fail 'the 5 KiB run failed'
jq -e --argjson m "$MID" '.events == [$m] and .oversized == []' "$TMP/state/egress-posts" >/dev/null || fail 'a 5 KiB event was not sent whole'
# A MESSAGE that is not text (journalctl's array of bytes) is not sent, and is said.
jq -cn '{__CURSOR: "c1009", __MONOTONIC_TIMESTAMP: "1009", _BOOT_ID: "b1", MESSAGE: [104, 255, 105], _SYSTEMD_UNIT: "moca-egress.service"}' >>"$TMP/state/journal"
egress_run || fail 'the unreadable run failed'
grep -q 'egress: 1 journal entries of moca-egress have a MESSAGE that is not text; not sent' "$TMP/out" || fail 'an unreadable MESSAGE was silent'
[[ "$(<"$TMP/srv/egress.cursor")" == c1009 ]] || fail 'the cursor after an unreadable entry'
pass 'ships egress events as written, only with moca-egress active (enabled or not), never acting on it; batches of 1000; a failed post keeps the cursor and retries the same batch'

# 14. A 400 invalid_request (a batch the control plane will never take) is set aside, never retried
#     forever: kept 0600 in egress.rejected/, the cursor past it, an error naming it; shipping goes on.
#     A 404 (an older control plane) and a 503 keep the batch and the cursor, and retry.
rm -f "$TMP/srv/egress.pending.json" "$TMP/srv/egress.mark" "$TMP/srv/egress.catchup"
{ entry c1 "$EV"; entry c2 "$EV2"; } >"$TMP/state/journal"
printf c1 >"$TMP/srv/egress.cursor"
for st in 404 503; do
  printf '%s' "$st" >"$TMP/state/egress-status"
  egress_run || fail "the $st run failed"
  [[ "$(<"$TMP/srv/egress.cursor")" == c1 ]] || fail "the cursor moved on a $st"
  [[ -f "$TMP/srv/egress.pending.json" ]] || fail "the batch was dropped on a $st"
  [[ ! -d "$TMP/srv/egress.rejected" ]] || fail "a $st batch was set aside as rejected"
  grep -q "egress post failed: the cursor stays, the next run retries (HTTP $st)" "$TMP/out" || fail "the $st error"
  grep -q '"egressRejected":0' "$TMP/out" || fail "the $st summary"
done
printf 400 >"$TMP/state/egress-status"
egress_run || fail 'the 400 run failed'
REJ="$(find "$TMP/srv/egress.rejected" -name '*.json' 2>/dev/null | head -1)"
[[ -n "$REJ" && ! -e "$TMP/srv/egress.pending.json" ]] || fail 'the refused batch was not set aside'
jq -e --argjson b "$EV2" '.events == [$b] and .cursor == "c2"' "$REJ" >/dev/null || fail 'the rejected file is not the batch'
[[ "$(stat -c %a "$REJ" 2>/dev/null || stat -f %Lp "$REJ")" == 600 ]] || fail 'the rejected file is not 0600'
[[ "$(<"$TMP/srv/egress.cursor")" == c2 ]] || fail 'the cursor did not move past the refused batch'
grep -q "refused a batch as malformed (400 invalid_request); kept in $REJ" "$TMP/out" || fail 'the 400 error does not name the file'
grep -q '"errors":1,.*"egressRejected":1' "$TMP/out" || fail 'the 400 summary'
grep -q -- "$TOKEN" "$MOCK_LOG" "$TMP/out" && fail 'the token reached argv or output'
grep -q 'events and oversized' "$TMP/out" && fail "the control plane's answer was printed"
rm -f "$TMP/state/egress-status"
entry c3 "$EV" >>"$TMP/state/journal"
egress_run || fail 'the run after a rejection failed'
jq -e '.cursor == "c3"' "$TMP/state/egress-posts" >/dev/null || fail 'shipping did not go on after a rejection'
pass 'a 400 batch is kept in egress.rejected/ (0600) and passed; a 404 or 503 keeps it and retries'

# 15. A stale cursor: one whose entry was rotated away (journalctl exits 0 for it and falls back, so the
#     agent checks with --cursor first) or one journalctl cannot parse (exit 1). An error, the old cursor
#     kept as egress.cursor.stale, a restart from this boot, and shipping goes on; entries already sent
#     (at or before egress.mark) are not sent again. Without a mark, the restart re-sends, and says so.
rm -f "$TMP/srv/egress.pending.json" "$TMP/srv/egress.cursor.stale" "$TMP/srv/egress.catchup" "$TMP/srv/egress.mark"
{ entry c10 "$EV"; entry c11 "$EV2"; } >"$TMP/state/journal"
egress_run || fail 'the first run of 15 failed'
[[ "$(<"$TMP/srv/egress.mark")" == 'b1 11' ]] || fail 'the position mark is not the last sent entry'
# The journal rotates: c10 and c11 are now under other cursors, and the agent's c11 is gone.
{ entry r10 "$EV" 10; entry r11 "$EV2" 11; entry r12 "$EV" 12; } >"$TMP/state/journal"
egress_run || fail 'the rotated run failed'
grep -q 'egress: the journal cursor is no longer valid; restarting from this boot' "$TMP/out" || fail 'no error for a rotated cursor'
grep -q 'journalctl -u moca-egress.service -o json --all --no-pager --cursor c11' "$MOCK_LOG" || fail 'the cursor was not checked with --cursor'
grep -q -- '--after-cursor c11' "$MOCK_LOG" && fail 'read after a stale cursor (journalctl falls back and re-reads)'
[[ "$(<"$TMP/srv/egress.cursor.stale")" == c11 ]] || fail 'the old cursor was not kept'
grep -q 'journalctl -u moca-egress.service -o json --all --no-pager -b' "$MOCK_LOG" || fail 'no restart from this boot'
jq -s -e --argjson a "$EV" '(map(.events) | add) == [$a] and .[-1].cursor == "r12"' "$TMP/state/egress-posts" >/dev/null ||
  fail 'the restart re-sent entries already sent, or did not ship the new one'
grep -q '"egressSkipped":2' "$TMP/out" || fail 'the skipped entries are not counted'
[[ "$(<"$TMP/srv/egress.cursor")" == r12 && ! -e "$TMP/srv/egress.catchup" ]] || fail 'not caught up after the restart'
entry r13 "$EV2" 13 >>"$TMP/state/journal"
egress_run || fail 'the run after the restart failed'
jq -e '.cursor == "r13" and (.events | length) == 1' "$TMP/state/egress-posts" >/dev/null || fail 'shipping did not go on after the restart'
grep -q '"errors":0' "$TMP/out" || fail 'an error after the restart'
# No mark: the restart says the control plane will store the re-sent entries twice.
rm -f "$TMP/srv/egress.mark"; printf gone >"$TMP/srv/egress.cursor"
egress_run || fail 'the no-mark run failed'
grep -q 'no position mark: entries of this boot already sent are sent again, and the control plane stores them twice' "$TMP/out" ||
  fail 'a re-send without a mark is silent'
jq -s -e '(map(.events | length) | add) == 4' "$TMP/state/egress-posts" >/dev/null || fail 'the no-mark restart did not re-send'
pass 'a rotated-away cursor is an error, kept as egress.cursor.stale, restarted from this boot without re-sending; no mark is said'

# 16. Only this host's sandboxes' events leave it: egressSids from the wanted state (one request, the
#     one activation made); another sid (a Moca P6 session's) is counted as egressNotOurs and never
#     posted; an audit_dropped report is sent. An older control plane (no egressSids): nothing sent.
rm -f "$TMP/srv/egress.pending.json" "$TMP/srv/egress.cursor" "$TMP/srv/egress.mark" "$TMP/srv/egress.catchup"
P6="$(jq -c '.sid = "p6-session-0001" | .host = "api.example.com"' <<<"$EV")"
DROP='{"time":"2026-11-08T12:00:02Z","via":"moca-egress","vm_id":"","sid":"","host":"","method":"","status":0,"bytes_up":0,"bytes_down":0,"decision":"audit_dropped","dropped":5}'
{ entry c1 "$EV"; entry c2 "$P6"; entry c3 "$DROP"; entry c4 "$P6"; } >"$TMP/state/journal"
egress_run || fail 'the filtered run failed'
jq -e --argjson a "$EV" --argjson d "$DROP" '.events == [$a, $d] and .cursor == "c4"' "$TMP/state/egress-posts" >/dev/null ||
  fail 'the post is not exactly our event and the drop report'
grep -q 'p6-session-0001\|api.example.com' "$TMP/state/egress-posts" "$TMP/out" && fail "another client's event left the host"
grep -q '"egressRead":4,"egressAccepted":2,.*"egressNotOurs":2' "$TMP/out" || fail 'egressNotOurs is not counted'
# A sid not in the list: the wanted state read again after the journal read (activation's and that one).
[[ "$(grep -c '/v1/hosts/host-1/wanted' "$MOCK_LOG")" == 2 ]] || fail 'a batch with another sid did not read the wanted state again'
[[ "$(<"$TMP/srv/egress.cursor")" == c4 ]] || fail 'the cursor after a filtered batch'
# A run whose activation is skipped for the lock reads the wanted state once, for egress; a batch of
# our sandbox's events only reads it no more.
entry c5 "$EV" >>"$TMP/state/journal"
touch "$TMP/state/locked-9" # the activation lock only
egress_run || fail 'the locked egress run failed'
rm -f "$TMP/state/locked-9"
[[ "$(grep -c '/v1/hosts/host-1/wanted' "$MOCK_LOG")" == 1 ]] || fail 'a lock-skipped run did not read the wanted state once'
jq -e '.cursor == "c5"' "$TMP/state/egress-posts" >/dev/null || fail 'a lock-skipped run did not ship'
# A sandbox created after activation's read of the wanted state: its first events are in the journal
# read, its sid only in the second read. They are sent, not counted egressNotOurs.
NEW=sbx-fedcba9876543210fedcba9876
EVN="$(jq -c --arg s "$NEW" '.sid = $s' <<<"$EV")"
entry c6 "$EVN" >>"$TMP/state/journal"
printf '{"run":[],"stop":[],"egressSids":["%s","%s"]}' "$SID" "$NEW" >"$TMP/state/wanted-later"
egress_run || fail 'the new-sandbox run failed'
jq -e --argjson n "$EVN" '.events == [$n] and .cursor == "c6"' "$TMP/state/egress-posts" >/dev/null ||
  fail "a new sandbox's first events were not sent"
grep -q '"egressNotOurs":0' "$TMP/out" || fail "a new sandbox's events were counted egressNotOurs"
# That second read failing: nothing sent, the cursor kept, an error line; the next run sends them.
entry c7 "$(jq -c '.host = "files.example.com"' <<<"$EVN")" >>"$TMP/state/journal"
printf x >"$TMP/state/wanted-later"
egress_run || fail 'the failed-refresh run failed'
[[ ! -e "$TMP/state/egress-posts" && "$(<"$TMP/srv/egress.cursor")" == c6 ]] || fail 'sent or moved the cursor without the second read'
grep -q 'egress: the wanted state unreadable after the journal read; nothing sent, the cursor kept' "$TMP/out" || fail 'the failed second read is not said'
printf '{"run":[],"stop":[],"egressSids":["%s","%s"]}' "$SID" "$NEW" >"$TMP/state/wanted-later"
egress_run || fail 'the run after the failed refresh failed'
jq -e '.cursor == "c7" and (.events | length) == 1' "$TMP/state/egress-posts" >/dev/null || fail 'the run after a failed second read did not send'
rm -f "$TMP/state/wanted-later"
# An older control plane: no egressSids, nothing sent, the cursor kept, an error line.
printf '{"run":[],"stop":[]}' >"$TMP/state/wanted-answer"
entry c8 "$EV" >>"$TMP/state/journal"
egress_run || fail 'the no-egressSids run failed'
[[ ! -e "$TMP/state/egress-posts" ]] || fail 'sent without egressSids'
grep -q '^journalctl' "$MOCK_LOG" && fail 'read the journal without egressSids'
grep -q 'the wanted state has no egressSids (a control plane older than openapi 1.8.0); nothing sent, the cursor kept' "$TMP/out" ||
  fail 'no error line for a missing egressSids'
[[ "$(<"$TMP/srv/egress.cursor")" == c7 ]] || fail 'the cursor moved without egressSids'
printf '{"run":[],"stop":[],"egressSids":["%s"]}' "$SID" >"$TMP/state/wanted-answer"
pass 'ships only the wanted state egressSids events (read again after the journal for an unknown sid) and drop reports, counts the rest egressNotOurs; nothing without egressSids'

# 17. The time budget: no new batch after EGRESS_BUDGET_S (120 s; 5 s here, by the test copy below,
#     with 3 s posts: SECONDS counts whole seconds, so the margins are wide),
#     the cursor at the last batch taken; the next run goes on.
sed 's/EGRESS_BUDGET_S=120$/EGRESS_BUDGET_S=5/' "$A" >"$TMP/host-agent-budget.sh"
grep -q 'EGRESS_BUDGET_S=5$' "$TMP/host-agent-budget.sh" || fail 'the budget constant is not EGRESS_BUDGET_S=120'
entries 7 3006 "$EV" >"$TMP/state/journal"
printf 3 >"$TMP/state/egress-sleep"
: >"$MOCK_LOG"; rm -f "$TMP/state/egress-posts"; printf c7 >"$TMP/srv/egress.cursor"
bash "$TMP/host-agent-budget.sh" --wanted-only >"$TMP/out" 2>&1 || fail 'the budget run failed'
rm -f "$TMP/state/egress-sleep"
[[ "$(jq -s length "$TMP/state/egress-posts")" == 2 ]] || fail "the budget did not stop the loop after 2 posts ($(jq -s length "$TMP/state/egress-posts"))"
grep -q 'egress: the 5 s budget is spent; the next run goes on' "$TMP/out" || fail 'the budget stop is not said'
[[ "$(<"$TMP/srv/egress.cursor")" == c2007 && ! -e "$TMP/srv/egress.pending.json" ]] || fail 'the cursor is not at the last batch taken'
grep -q '"errors":0' "$TMP/out" || fail 'the budget stop counted an error'
egress_run || fail 'the run after the budget failed'
jq -e '.cursor == "c3006" and (.events | length) == 999' "$TMP/state/egress-posts" >/dev/null || fail 'the next run did not go on'
grep -q 'EGRESS_BUDGET_S=120$' "$A" || fail 'the shipped budget is not 120 s'
rm -f "$TMP/state/active-moca-egress.service"
pass 'stops starting batches after the time budget, the cursor at the last batch taken; the next run goes on'

echo 'all host-agent.sh tests passed'
