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
# --wanted-only runs share; a retired build is removed only when named and matched by this host's own
# record, never under a running worker; and the agent refuses its own bad settings before it calls
# anything.
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
args=("$@") hdr='' url='' data='' method=GET
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ "${args[$i]}" == -H && "${args[$((i + 1))]:-}" == @* ]] && hdr="${args[$((i + 1))]#@}"
  [[ "${args[$i]}" == --data-binary ]] && data="${args[$((i + 1))]#@}"
  [[ "${args[$i]}" == -X ]] && method="${args[$((i + 1))]}"
  [[ "${args[$i]}" == https://* ]] && url="${args[$i]}"
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
"GET /v1/hosts/host-1/wanted") cat "$MOCK_STATE/wanted-answer" ;;
"POST /v1/hosts/host-1/workers/report") echo '{"recorded":"x"}' ;;
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
start) touch "$MOCK_STATE/active-$2" ;;
stop) rm -f "$MOCK_STATE/active-$2" ;;
esac
MOCK
# flock: util-linux on the hosts, absent on a developer's Mac. `flock -n FD` fails while
# $MOCK_STATE/locked exists, as a lock another run holds.
cat >"$TMP/bin/flock" <<'MOCK'
#!/usr/bin/env bash
[[ ! -e "$MOCK_STATE/locked" ]]
MOCK
# install-host.sh: logs its argv; --uninstall removes the worker's env file, as the real one does.
cat >"$TMP/bin/install-host" <<'MOCK'
#!/usr/bin/env bash
printf 'install-host %s\n' "$*" >>"$MOCK_LOG"
[[ -z "${MOCK_UNINSTALL_FAIL:-}" ]] || { echo '==> stopping'; echo 'install-host.sh: the unit would not stop' >&2; exit 1; }
[[ "$1" == --uninstall ]] && rm -f "$SBX_ENV_DIR/workers/$2.env"
MOCK
chmod +x "$TMP/bin/curl" "$TMP/bin/template-build" "$TMP/bin/systemctl" "$TMP/bin/flock" "$TMP/bin/install-host"
printf '{"run":[],"stop":[]}' >"$TMP/state/wanted-answer"
mkdir -p "$TMP/workers"
: >"$TMP/kernel"
(umask 077 && printf '%s' "$TOKEN" >"$TMP/token")
export PATH="$TMP/bin:$PATH" MOCK_LOG="$TMP/log" MOCK_STATE="$TMP/state" MOCK_TOKEN_FILE="$TMP/token" MOCK_GATE="$GATE"
export SBX_API_URL=https://cp.example.invalid SBX_HOST_ID=host-1 SBX_HOST_TOKEN_FILE="$TMP/token" SBX_KERNEL="$TMP/kernel"
export SBX_SRV="$TMP/srv" SBX_ENV_DIR="$TMP" SBX_TEMPLATE_BUILD="$TMP/bin/template-build" SBX_DISK_FLOOR_GB=0
export SBX_INSTALL_HOST="$TMP/bin/install-host"

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
grep -q '"agent":"summary","claimed":1,"built":1,"failed":0,"started":0,"stopped":0,"removed":0,"errors":0' "$TMP/out" || fail 'summary'
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
grep -q '"agent":"summary","claimed":1,"built":0,"failed":1,"started":0,"stopped":0,"removed":0,"errors":0' "$TMP/out" || fail 'summary of a gate mismatch'
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
grep -q '"agent":"summary","claimed":1,"built":0,"failed":1,"started":0,"stopped":0,"removed":0,"errors":0' "$TMP/out" || fail 'no summary after an empty build log'
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
grep -q '"agent":"summary","claimed":1,"built":0,"failed":1,"started":0,"stopped":0,"removed":0,"errors":0' "$TMP/out" || fail 'no summary after a record that is not JSON'
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
grep -q '"agent":"summary","claimed":0,"built":0,"failed":0,"started":1,"stopped":0,"removed":0,"errors":0' "$TMP/out" || fail 'the wanted-only summary'
rm -f "$TMP/state/active-sbx-worker@sbx_t2.service"; touch "$TMP/state/locked"; : >"$MOCK_LOG"
bash "$A" --wanted-only >"$TMP/out" 2>&1 || fail 'the locked run failed'
grep -q 'systemctl start' "$MOCK_LOG" && fail 'started a worker while another run held the lock'
grep -q 'another run is applying the wanted state' "$TMP/out" || fail 'the lock skip does not say why'
rm -f "$TMP/state/locked"
! bash "$A" --once --wanted-only >"$TMP/out" 2>&1 || fail 'accepted two modes'
printf '{"run":[],"stop":[]}' >"$TMP/state/wanted-answer"
pass 'with --wanted-only, applies the wanted state and claims nothing; one run at a time applies it'

# 13. Removal of retired builds (§6.1 step 7): only a build the control plane names AND this host's
#     own record matches (manifest hash and worker), never a running worker, nothing else deleted;
#     a worker in `stop` beside `remove` is stopped, then removed, in one run.
H="sha256:$(printf 'e%.0s' {1..64})" W=sbx_ret_1 OTHER="sha256:$(printf 'f%.0s' {1..64})"
mkdir -p "$TMP/srv/snapshots/ret-1" "$TMP/srv/snapshots/keep-1"
: >"$TMP/srv/snapshots/ret-1/manifest.json"; : >"$TMP/srv/snapshots/keep-1/manifest.json"
jq -n --arg h "$H" --arg w "$W" '{schema: "moca-sbx-template/1", id: "ret", worker: $w, snapshot: "ret-1", manifest_hash: $h}' >"$TMP/srv/templates/ret-1.json"
jq -n --arg h "$OTHER" '{schema: "moca-sbx-template/1", id: "keep", worker: "sbx_keep_1", snapshot: "keep-1", manifest_hash: $h}' >"$TMP/srv/templates/keep-1.json"
: >"$TMP/workers/$W.env"
wo() { : >"$MOCK_LOG"; rm -f "$TMP/state/POST_"*; bash "$A" --wanted-only >"$TMP/out" 2>&1; }
# A running worker the control plane names only in `remove` is not removed.
touch "$TMP/state/active-sbx-worker@$W.service"
jq -n --arg h "$H" --arg w "$W" '{run: [], stop: [], remove: [{template: "ret", buildId: $h, worker: $w}]}' >"$TMP/state/wanted-answer"
wo || fail 'the removal run failed'
grep -q 'still running' "$TMP/out" || fail 'a running worker was not skipped'
[[ -d "$TMP/srv/snapshots/ret-1" ]] || fail 'removed the snapshot of a running worker'
grep -q 'install-host --uninstall' "$MOCK_LOG" && fail 'uninstalled a running worker'
# In `stop` too: stopped, uninstalled, its snapshot and record gone, reported removed; the other untouched.
jq -n --arg h "$H" --arg w "$W" '{run: [], stop: [{template: "ret", buildId: $h, worker: $w}],
  remove: [{template: "ret", buildId: $h, worker: $w}]}' >"$TMP/state/wanted-answer"
wo || fail 'the removal run failed'
grep -q "\"agent\":\"stopped\",\"worker\":\"$W\"" "$TMP/out" || fail 'a retired worker was not stopped before its removal'
grep -q "\"agent\":\"removed\",\"worker\":\"$W\"" "$TMP/out" || fail 'a retired worker was not removed in the run that stopped it'
grep -qx "install-host --uninstall $W --keep-shared" "$MOCK_LOG" || fail 'the worker was not uninstalled alone (--keep-shared)'
[[ ! -e "$TMP/srv/snapshots/ret-1" && ! -e "$TMP/srv/templates/ret-1.json" ]] || fail 'the snapshot or its record is still there'
[[ -d "$TMP/srv/snapshots/keep-1" && -f "$TMP/srv/templates/keep-1.json" ]] || fail 'removed a build it was not asked to'
jq -e --arg h "$H" '.buildId == $h and .event == "removed"' "$TMP/state/POST_v1_hosts_host-1_workers_report" >/dev/null || fail 'the removal was not reported'
grep -q '"stopped":1,"removed":1,"errors":0' "$TMP/out" || fail 'the summary does not count the removal'
# A name this host's records do not match (a held build, another worker) deletes nothing; nor a malformed one.
jq -n --arg h "$OTHER" '{run: [], stop: [], remove: [{template: "keep", buildId: $h, worker: "sbx_wrong_1"}]}' >"$TMP/state/wanted-answer"
wo || fail 'the mismatched removal run failed'
[[ -d "$TMP/srv/snapshots/keep-1" && -f "$TMP/srv/templates/keep-1.json" ]] || fail 'removed a build whose worker did not match'
grep -q 'no template record here' "$TMP/out" || fail 'a mismatched removal does not say why'
grep -q 'workers/report' "$MOCK_LOG" && fail 'a mismatched removal was reported'
jq -n '{run: [], stop: [], remove: [{template: "x", buildId: "../../etc", worker: "sbx_x"}]}' >"$TMP/state/wanted-answer"
wo || fail 'the malformed removal run failed'
grep -q 'build id to remove is malformed' "$TMP/out" || fail 'a malformed build id was not refused'
# The name check before the delete: a record that matches but names no plain entry under snapshots/
# (a parent, a hidden entry, a path, an empty or missing name, a non-string) deletes nothing and
# reports nothing.
H2="sha256:$(printf 'd%.0s' {1..64})" W2=sbx_bad_1
mkdir -p "$TMP/srv/snapshots/.hidden" "$TMP/srv/snapshots/a/b" "$TMP/srv/snapshots/null"
rm_wanted() { jq -n --arg h "$1" --arg w "$2" '{run: [], stop: [], remove: [{template: "x", buildId: $h, worker: $w}]}' >"$TMP/state/wanted-answer"; }
rm_wanted "$H2" "$W2"
for name in '".."' '".hidden"' '"a/b"' '""' 'null' '42' '["x"]' '{}' 'absent'; do
  if [[ "$name" == absent ]]; then
    jq -n --arg h "$H2" --arg w "$W2" '{schema: "moca-sbx-template/1", worker: $w, manifest_hash: $h}'
  else
    jq -n --arg h "$H2" --arg w "$W2" --argjson n "$name" '{schema: "moca-sbx-template/1", worker: $w, snapshot: $n, manifest_hash: $h}'
  fi >"$TMP/srv/templates/bad-1.json"
  wo || fail "the removal run with snapshot $name failed"
  grep -q 'a template record names a bad snapshot' "$TMP/out" || fail "a record naming snapshot $name was not refused"
  [[ -f "$TMP/srv/templates/bad-1.json" && -d "$TMP/srv/snapshots/.hidden" && -d "$TMP/srv/snapshots/a/b" &&
    -d "$TMP/srv/snapshots/null" && -d "$TMP/srv/snapshots/keep-1" && -f "$TMP/srv/templates/keep-1.json" ]] ||
    fail "a record naming snapshot $name deleted something"
  ! grep -q 'install-host\|workers/report' "$MOCK_LOG" || fail "a record naming snapshot $name was uninstalled or reported"
done
rm -f "$TMP/srv/templates/bad-1.json"
# An uninstall that fails keeps the snapshot and its record, sends no report, and says why (its last
# lines: the log goes with the run's work directory). No install-host.sh at SBX_INSTALL_HOST, the same.
H3="sha256:$(printf 'c%.0s' {1..64})" W3=sbx_unin_1
mkdir -p "$TMP/srv/snapshots/unin-1"; : >"$TMP/srv/snapshots/unin-1/manifest.json"
jq -n --arg h "$H3" --arg w "$W3" '{schema: "moca-sbx-template/1", worker: $w, snapshot: "unin-1", manifest_hash: $h}' >"$TMP/srv/templates/unin-1.json"
: >"$TMP/workers/$W3.env"
rm_wanted "$H3" "$W3"
MOCK_UNINSTALL_FAIL=1 wo || fail 'the run with a failing uninstall failed'
grep -q "install-host.sh --uninstall $W3 failed: ==> stopping install-host.sh: the unit would not stop" "$TMP/out" ||
  fail 'a failed uninstall does not carry its last lines'
[[ -f "$TMP/srv/snapshots/unin-1/manifest.json" && -f "$TMP/srv/templates/unin-1.json" ]] || fail 'a failed uninstall lost the snapshot or its record'
! grep -q 'workers/report' "$MOCK_LOG" || fail 'a failed uninstall was reported'
SBX_INSTALL_HOST="$TMP/no-such-install-host" wo || fail 'the run with no install-host.sh failed'
grep -q "no install-host.sh at $TMP/no-such-install-host" "$TMP/out" || fail 'a missing install-host.sh is not named'
[[ -f "$TMP/srv/snapshots/unin-1/manifest.json" && -f "$TMP/srv/templates/unin-1.json" ]] || fail 'a missing install-host.sh lost the snapshot or its record'
! grep -q 'workers/report' "$MOCK_LOG" || fail 'a removal with no install-host.sh was reported'
# A snapshot that cannot be deleted keeps its record (the next run retries) and is not reported;
# once it can be, it goes. Skipped as root, whom a read-only directory does not stop.
if [[ "$(id -u)" != 0 ]]; then
  chmod 0555 "$TMP/srv/snapshots"
  wo || { chmod 0755 "$TMP/srv/snapshots"; fail 'the run with an undeletable snapshot failed'; }
  chmod 0755 "$TMP/srv/snapshots"
  grep -q 'could not delete snapshot unin-1: kept its record' "$TMP/out" || fail 'a failed delete does not say so'
  [[ -f "$TMP/srv/templates/unin-1.json" ]] || fail 'a failed delete dropped the record'
  ! grep -q 'workers/report' "$MOCK_LOG" || fail 'a failed delete was reported'
fi
wo || fail 'the retried removal failed'
[[ ! -e "$TMP/srv/snapshots/unin-1" && ! -e "$TMP/srv/templates/unin-1.json" ]] || fail 'the retried removal left the snapshot or its record'
jq -e --arg h "$H3" '.event == "removed" and .buildId == $h' "$TMP/state/POST_v1_hosts_host-1_workers_report" >/dev/null || fail 'the retried removal was not reported'
printf '{"run":[],"stop":[]}' >"$TMP/state/wanted-answer"
wo || fail 'a wanted state without remove failed'
grep -q '"removed":0,"errors":0' "$TMP/out" || fail 'a wanted state without remove (an older control plane) is not taken'
pass 'removes a retired build only when named and matched by its own record, never a running worker or a bad snapshot name; a failed uninstall or delete keeps the record and is not reported'

echo 'all host-agent.sh tests passed'
