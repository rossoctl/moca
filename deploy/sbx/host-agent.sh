#!/usr/bin/env bash
# deploy/sbx/host-agent.sh -- sbx-host-agent, a KVM host's template agent
# (docs/specs/2026-11-03-template-lifecycle-and-provenance-design.md §6.1). One run is one poll:
# report the inventory, claim queued builds, build each with template-build.sh, report the outcome;
# then start and stop installed workers as the control plane wants (§6.3). The control plane
# registers or rejects a built build by policy (§8.2) and decides what runs; nothing here does.
#
# It installs no worker: a registered build's worker is installed by an operator (install-host.sh,
# from the template record template-build.sh wrote, with its relay token from setup.sh). A wanted
# build whose worker is not installed is reported `refused`, never installed here.
#
#   sudo deploy/sbx/host-agent.sh --once          one poll (the unit's timer runs it)
#   sudo deploy/sbx/host-agent.sh --wanted-only   the inventory and the wanted state only: no claim,
#                                                 no build (sbx-host-agent-wanted's timer, every 15 s,
#                                                 so an activation waits seconds, not behind a build);
#                                                 then the egress step below
#
# The wanted state (GET /v1/hosts/<id>/wanted): `run` lists the leased builds placed on this host,
# `stop` the ones it holds with no lease and no live sandbox (or that another host is placed on). The
# agent stops each `stop` worker whose unit is active, then starts each `run` worker whose
# sbx-worker@<id> unit is installed and not active, reporting each start (`attached`), refusal (`refused`, with why) and stop (`detached`) to POST
# /v1/hosts/<id>/workers/report. Readiness is the relay's attached record, never these reports. A
# lock ($SBX_SRV/.activation.lock, flock) keeps a build poll and a --wanted-only run from applying
# the wanted state at once: the one that does not get it skips, saying so.
#
# The egress step, in --wanted-only runs only: it READS moca-egress's journal and posts
# the proxy's audit events, as the proxy wrote them, to POST /v1/hosts/<id>/egress, where each event
# lands in its sandbox's egress log. It never touches moca-egress (no start, stop, restart or config):
# a failed post changes nothing on the host's egress, it only leaves the journal cursor where it was.
#   - Off when `systemctl is-active moca-egress.service` does not say active (a --no-egress host, none
#     installed, or a reused moca-egress not started): then no journal read, no post, no cursor file.
#     Active, not enabled: install-host.sh reuses a moca-egress.service another install owns (a P6
#     worker's) without enabling it, and that install may start it for a while only; what matters is
#     that a proxy serves this host's workers now. A read, so the agent still never acts on moca-egress.
#   - Only this host's sandboxes' events leave it: the wanted state's `egressSids` (the workspace keys
#     of the sandboxes on its workers, live or just ended) is the list, and an event whose sid is not in
#     it (a Moca P6 session's, served by the same proxy) is not sent, only counted (egressNotOurs).
#     An audit_dropped report (a count, no sid) is sent. A control plane whose wanted state has no
#     egressSids (older than openapi 1.8.0) gets nothing: an error line, no journal read, the cursor kept.
#     The list comes from activation()'s read of the wanted state; a run whose activation was skipped
#     for the lock reads it once itself. That read comes before the journal read, so a sandbox created
#     in between would be missing from it: a batch with any sid not in the list reads the wanted state
#     again, after the journal read, and is selected with both lists (one request per such batch), so
#     the first events of a new sandbox are not passed over. If that read fails, nothing is sent and
#     the cursor stays.
#   - A time budget: no new batch is started 120 s (EGRESS_BUDGET_S) after the step began, so slow
#     posts never hold the wanted unit (TimeoutStartSec 5 min) and its activations; the cursor stays at
#     the last batch taken, and the next run goes on from there.
#   - The cursor is $SBX_SRV/egress.cursor (0600), the journal position after the last event the
#     control plane took. With none, the step starts at this boot's first entry.
#   - Batches of up to 1000 journal entries, at most 10 per run, read with --all (without it a field
#     over 4096 bytes comes out null); a non-event line (the proxy's own log) is skipped, and an entry
#     whose MESSAGE is not text (not UTF-8: an array of bytes) is an error line, as it cannot be read. A batch is saved to $SBX_SRV/egress.pending.json (0600) before it is posted and re-sent
#     unchanged until it is taken, so a retry repeats its cursor and the control plane, idempotent by
#     (host, cursor), never stores it twice.
#   - A post that fails (the control plane down, a 5xx, or a 404 from one without the route) is an error
#     in the summary; the cursor stays, and the next run retries.
#   - A batch the control plane refuses as malformed (400 invalid_request or invalid_json) would fail
#     every retry, so it is moved to $SBX_SRV/egress.rejected/<UTC time>-<pid>.json (0600), the cursor
#     moves past it, and the error names the file: nothing is lost silently, and shipping goes on.
#   - A cursor journalctl can no longer seek to (rotated away, or another machine's) is an error; it is
#     kept as $SBX_SRV/egress.cursor.stale and the step restarts from this boot. Entries it already
#     sent are not sent again: beside the cursor, $SBX_SRV/egress.mark (0600) keeps the last sent
#     entry's _BOOT_ID and __MONOTONIC_TIMESTAMP. From the restart ($SBX_SRV/egress.catchup) until the
#     first entry past the mark, an entry of that boot at or before it is skipped (egressSkipped).
#     Without a mark, a restart re-sends this boot's entries, which the control plane would store twice
#     (its replay check is by cursor, and re-read entries come with new batch cursors): that is an
#     error line of its own, never silent. Entries of an earlier boot after the stale cursor that are
#     still in the journal are not read (-b is this boot only).
#
# Run it through the unit (systemctl start sbx-host-agent.service): the unit loads host-agent.env; a
# bare run sees none of it and refuses (SBX_API_URL). Installed outside the tree, it needs
# SBX_TEMPLATE_BUILD (the unit sets it to /srv/sbx/src/...).
#
# Environment (the unit sets it from /etc/sbx/host-agent.env):
#   SBX_API_URL              https://<api host>, the control plane
#   SBX_HOST_ID              this host's id, as in the control plane's SH_TEMPLATE_HOSTS
#   SBX_HOST_TOKEN_FILE      default $SBX_ENV_DIR/host-agent.token: SH_HOST_TOKEN_<ID>, 64 hex, alone
#                            in a 0600 file owned by the running user
#   SBX_KERNEL               the guest kernel template-build.sh boots (its --kernel)
#   SBX_API_CA_FILE          optional; the CA to verify the API Route with
#   SBX_SRV                  default /srv/sbx: snapshots under $SBX_SRV/snapshots, records under templates/
#   SBX_ENV_DIR              default /etc/sbx
#   SBX_DISK_FLOOR_GB        default 60: no build is claimed below this much free disk on $SBX_SRV
#                            (template-build.sh's own refusal)
#   SBX_BUILD_CONCURRENCY    default 1 (1-4): builds claimed per poll
#   SBX_ACTIVE_LIMIT, SBX_IDLE_LIMIT_S   reported to the control plane in the inventory's limits;
#                            default 0 (none set)
#   SBX_TEMPLATE_BUILD       default <repo>/deploy/sbx/template-onboarding/template-build.sh (a test seam)
#   SBX_REGISTRY             optional; template-build.sh --registry. With it set, no build is claimed
#                            until REGISTRY_AUTH_FILE (default /run/containers/0/auth.json) holds a
#                            login for it
#
# Nothing that names where an image lives leaves the host: a failed build's reason and its log are
# redacted (see redact()), the full log stays in $SBX_SRV/agent-logs (0700), and a template record or
# manifest that names SBX_REGISTRY is not sent (the build fails `leak_refused`). A failure's reason
# leads with a code a client can branch on: pull_failed, probe_failed, disk_floor, spec_refused,
# build_failed or leak_refused; or agent_error, when the agent cannot carry on with a build it
# claimed (a gate record fetch that failed or does not match its digest, a report not accepted, no
# template record or manifest after the build). Every claimed build is reported failed, best
# effort, on any way out short of `built`.
#
# The token never reaches argv or a log: curl reads it from a 0600 header file, and no egress event is
# printed. Output: one JSON line per action, then one summary line {"agent":"summary","claimed","built",
# "failed","started","stopped","errors"}, a --wanted-only one ending with "egress":"on"|"off" and
# "egressRead","egressAccepted","egressRefused","egressSkipped","egressRejected","egressNotOurs".
# A refusal of its own settings is exit 2.
set -euo pipefail
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${SBX_TEMPLATE_BUILD:=$REPO_ROOT/deploy/sbx/template-onboarding/template-build.sh}"
HOST_ID_RE='^[a-z0-9][a-z0-9-]{0,30}$'
HANDLE_RE='^b-[0-9a-f]{26}$'
WORKER_RE='^[A-Za-z_][A-Za-z0-9_]*$'
TEMPLATE_ID_RE='^[a-z0-9][a-z0-9-]{0,30}$'
DIGEST_RE='^sha256:[0-9a-f]{64}$'

say() { printf '%s\n' "$*"; }
refuse() { echo "sbx-host-agent: $*" >&2; exit 2; }
CLAIMED=0 BUILT=0 FAILED=0 ERRORS=0 STARTED=0 STOPPED=0
EGRESS=off EG_READ=0 EG_ACCEPTED=0 EG_REFUSED=0 EG_SKIPPED=0 EG_REJECTED=0 EG_NOT_OURS=0 EG_CODE=''
EGRESS_BATCH=1000 EGRESS_BATCHES=10 EGRESS_BUDGET_S=120
error() { ERRORS=$((ERRORS + 1)); say "{\"agent\":\"error\",\"why\":$(jq -Rn --arg w "$1" '$w')}"; }

check_settings() {
  local t
  for t in jq curl df mktemp base64 sha256sum systemctl flock; do command -v "$t" >/dev/null || refuse "needs $t on PATH"; done
  SBX_SRV="${SBX_SRV-/srv/sbx}" SBX_ENV_DIR="${SBX_ENV_DIR-/etc/sbx}"
  [[ "$SBX_SRV" =~ ^(/[A-Za-z0-9_][A-Za-z0-9._-]*)+$ ]] || refuse "SBX_SRV='$SBX_SRV' must be an absolute path other than /"
  [[ "${SBX_API_URL:-}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || refuse 'SBX_API_URL must be https://<api host>'
  [[ "${SBX_HOST_ID:-}" =~ $HOST_ID_RE ]] || refuse "SBX_HOST_ID must match $HOST_ID_RE"
  : "${SBX_HOST_TOKEN_FILE:=$SBX_ENV_DIR/host-agent.token}"
  [[ -f "$SBX_HOST_TOKEN_FILE" && -r "$SBX_HOST_TOKEN_FILE" ]] || refuse 'SBX_HOST_TOKEN_FILE must name a readable file'
  local mode
  mode="$(stat -c '%a %u' "$SBX_HOST_TOKEN_FILE" 2>/dev/null || stat -f '%Lp %u' "$SBX_HOST_TOKEN_FILE")"
  [[ "$mode" == "600 $(id -u)" ]] || refuse "$SBX_HOST_TOKEN_FILE must be mode 0600 and owned by the running user"
  [[ "$(<"$SBX_HOST_TOKEN_FILE")" =~ ^[0-9a-f]{64}$ ]] || refuse "$SBX_HOST_TOKEN_FILE must hold 64 hex characters"
  [[ -n "${SBX_KERNEL:-}" && -f "$SBX_KERNEL" ]] || refuse 'SBX_KERNEL must name the guest kernel file'
  [[ -x "$SBX_TEMPLATE_BUILD" ]] || refuse "no template-build.sh at $SBX_TEMPLATE_BUILD"
  for v in SBX_DISK_FLOOR_GB SBX_BUILD_CONCURRENCY SBX_ACTIVE_LIMIT SBX_IDLE_LIMIT_S; do
    [[ -z "${!v:-}" || "${!v}" =~ ^(0|[1-9][0-9]{0,8})$ ]] || refuse "$v must be a whole number without a leading zero"
  done
  : "${SBX_DISK_FLOOR_GB:=60}" "${SBX_BUILD_CONCURRENCY:=1}" "${SBX_ACTIVE_LIMIT:=0}" "${SBX_IDLE_LIMIT_S:=0}"
  ((SBX_BUILD_CONCURRENCY >= 1 && SBX_BUILD_CONCURRENCY <= 4)) || refuse 'SBX_BUILD_CONCURRENCY must be 1-4'
}

HDR=''
api() { # api METHOD PATH [BODY_FILE] -> the body on stdout; fails on any non-2xx
  local ca=() data=()
  [[ -z "${SBX_API_CA_FILE:-}" ]] || ca=(--cacert "$SBX_API_CA_FILE")
  [[ -z "${3:-}" ]] || data=(-H 'Content-Type: application/json' --data-binary "@$3")
  # ${a[@]+"${a[@]}"}: an empty array under set -u is an error in bash 3.2 (macOS's /bin/bash).
  curl -fsS --max-time 60 --proto =https ${ca[@]+"${ca[@]}"} -H "@$HDR" -X "$1" ${data[@]+"${data[@]}"} "$SBX_API_URL$2"
}

# registry_logged_in: REGISTRY_AUTH_FILE holds an entry for SBX_REGISTRY (podman's auth.json shape).
registry_logged_in() {
  local f="${REGISTRY_AUTH_FILE:-/run/containers/0/auth.json}"
  [[ -r "$f" ]] && jq -e --arg h "$SBX_REGISTRY" '.auths // {} | has($h)' "$f" >/dev/null 2>&1
}

free_gb() { df -Pk "$SBX_SRV" 2>/dev/null | awk 'NR==2 { printf "%d", $4 / 1048576 }'; }

# The records of the snapshots this host holds, as template-build.sh writes them.
held_records() {
  local f
  for f in "$SBX_SRV"/templates/*.json; do
    [[ -f "$f" ]] || continue
    jq -e '.schema == "moca-sbx-template/1" and (.manifest_hash | test("^sha256:[0-9a-f]{64}$"))' "$f" >/dev/null 2>&1 || continue
    printf '%s\n' "$f"
  done
}

# The snapshots this host holds, by manifest hash, as template-build.sh's records name them, each
# with whether its worker's unit is running (the control plane counts running workers against
# SBX_ACTIVE_LIMIT and keeps a running build on this host), and its limits.
inventory() {
  local f w r out="$WORK/inventory.json"
  {
    printf '{"holds":['
    local sep=''
    while IFS= read -r f; do
      w="$(jq -r '.worker // ""' "$f")" r=false
      if [[ "$w" =~ $WORKER_RE ]] && systemctl is-active --quiet "sbx-worker@$w.service"; then r=true; fi
      printf '%s%s' "$sep" "$(jq -c --argjson r "$r" '{template: .id, manifestHash: .manifest_hash, running: $r}' "$f")"
      sep=','
    done < <(held_records)
    printf '],"limits":{"activeLimit":%d,"idleLimitSeconds":%d,"buildConcurrency":%d,"diskFreeGb":%d,"diskFloorGb":%d}}' \
      "$SBX_ACTIVE_LIMIT" "$SBX_IDLE_LIMIT_S" "$SBX_BUILD_CONCURRENCY" "$(free_gb)" "$SBX_DISK_FLOOR_GB"
  } | jq -c . >"$out"
  api POST "/v1/hosts/$SBX_HOST_ID/inventory" "$out" >/dev/null
}

report() { # report HANDLE BODY_JSON
  printf '%s' "$2" >"$WORK/report.json"
  api POST "/v1/hosts/$SBX_HOST_ID/builds/$1/report" "$WORK/report.json"
}

# redact: stdin to stdout with registry hosts, account-shaped numbers, URLs and IP addresses masked.
# Build output names the image it pulls in full (build-rootfs.sh), and a private registry's host
# carries its account. The control plane keeps what it is sent, readable by clients and
# append-only in provenance, so nothing that names where an image lives leaves the host. The full
# log stays on the host (SBX_SRV/agent-logs).
redact() {
  # SBX_REGISTRY itself first, exactly, whatever its shape (the patterns below miss a
  # bare dotted name with an uncommon suffix). Then portable ERE (GNU and BSD sed): a host is a
  # dotted name, or localhost, with an optional port.
  local own=()
  [[ -z "${SBX_REGISTRY:-}" ]] || own=(-e "s#$(printf '%s' "$SBX_REGISTRY" | sed 's/[][\.*^$#+?(){}|]/\\&/g')#<registry>#g")
  sed -E ${own[@]+"${own[@]}"} \
    -e 's#https?://[^[:space:]"]+#<url>#g' \
    -e 's#([A-Za-z0-9-]+\.)+[A-Za-z]{2,}(:[0-9]+)?/#<registry>/#g' \
    -e 's#([A-Za-z0-9-]+\.)+(com|io|net|org|dev|cloud)([^A-Za-z0-9.-]|$)#<host>\3#g' \
    -e 's#(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9.]|$)#\1<ip>\3#g' \
    -e 's#(^|[^0-9])[0-9]{12}([^0-9]|$)#\1<account>\2#g'
}

log_tail() { # log_tail HANDLE FILE: the build log's last 200 lines, redacted, as entries
  tail -n 200 "$2" | redact | jq -Rs '{entries: (split("\n") | map(select(length > 0)) | map({level: "info", step: "build", message: .[0:4096]}))}' \
    >"$WORK/log.json"
  api POST "/v1/hosts/$SBX_HOST_ID/builds/$1/log" "$WORK/log.json" >/dev/null || error "log upload for $1 failed"
}

# fail_claimed HANDLE STEP WHY: a claimed build that the agent cannot carry on with is reported
# failed (best effort), so it does not stay `building`, and count against its owner's queue, until
# cancelled by hand. WHY is the agent's own fixed wording, never a build's output.
fail_claimed() {
  FAILED=$((FAILED + 1))
  report "$1" "$(jq -cn --arg s "$2" --arg m "agent_error: $3" '{event: "failed", step: $s, message: $m}')" >/dev/null ||
    error "report failed for $1 failed"
  say "{\"agent\":\"failed\",\"build\":\"$1\",\"step\":\"$2\",\"code\":\"agent_error\",\"why\":$(jq -Rn --arg w "$3" '$w')}"
}

build_one() { # build_one JOB_JSON
  local job="$1" handle tpl spec gate args=() rc=0 snap rec
  handle="$(jq -r .build <<<"$job")" tpl="$(jq -r .template <<<"$job")"
  # A malformed handle cannot be reported on; a good handle with a malformed template id is
  # claimed, so it is reported failed.
  [[ "$handle" =~ $HANDLE_RE ]] || { error 'the control plane handed out a malformed job'; return; }
  CLAIMED=$((CLAIMED + 1))
  [[ "$tpl" =~ $TEMPLATE_ID_RE ]] || { fail_claimed "$handle" job 'the job names a malformed template id'; return; }
  say "{\"agent\":\"claimed\",\"template\":\"$tpl\",\"build\":\"$handle\"}"
  spec="$WORK/$handle.spec.json"
  jq '.spec' <<<"$job" >"$spec"
  gate="$(jq -r '.gateRecord // empty' <<<"$job")"
  if [[ -n "$gate" ]]; then
    local d="${gate##*/}"
    [[ "$d" =~ $DIGEST_RE && "$gate" == "/v1/hosts/$SBX_HOST_ID/blobs/$d" ]] || { fail_claimed "$handle" gate 'the job names a malformed gate record path'; return; }
    api GET "$gate" | jq -r .base64 | base64 --decode >"$WORK/$handle.gate.json" || { fail_claimed "$handle" gate 'the gate record fetch failed'; return; }
    # The bytes must be the ones the policy trusted: their sha256 is the name.
    [[ "sha256:$(sha256sum "$WORK/$handle.gate.json" | cut -d' ' -f1)" == "$d" ]] || { fail_claimed "$handle" gate 'the gate record does not match its digest'; return; }
    args+=(--gate-record "$WORK/$handle.gate.json")
  fi
  [[ -z "${SBX_REGISTRY:-}" ]] || args+=(--registry "$SBX_REGISTRY")
  report "$handle" '{"event":"building"}' >/dev/null || { fail_claimed "$handle" report 'the building report was not accepted'; return; }
  "$SBX_TEMPLATE_BUILD" "$spec" --kernel "$SBX_KERNEL" ${args[@]+"${args[@]}"} >"$WORK/$handle.log" 2>&1 || rc=$?
  # The full, unredacted log stays on the host (root-only), for whoever runs it; only redacted text
  # leaves (log_tail, the failure report).
  if ! { install -d -m 0700 "$SBX_SRV/agent-logs" && install -m 0600 "$WORK/$handle.log" "$SBX_SRV/agent-logs/$handle.log"; }; then
    error "could not keep the build log of $handle"
  fi
  log_tail "$handle" "$WORK/$handle.log"
  if ((rc != 0)); then
    FAILED=$((FAILED + 1))
    local last
    # A build that died with no output (killed, out of memory) leaves no non-blank line: grep then
    # exits 1, which pipefail and errexit would turn into the end of the whole poll.
    last="$( { grep -v '^[[:space:]]*$' "$WORK/$handle.log" || true; } | tail -n 1 | redact | cut -c1-500)"
    # A fixed code a client can branch on, from template-build.sh's own wording; then the redacted line.
    local code=build_failed
    case "$last" in
    *"could not pull"* | *"pull"*"denied"* | *"unauthorized"*) code=pull_failed ;;
    *"probe exited"* | *"no match for"* | *"verify command exited"* | *"verify-command exited"*) code=probe_failed ;;
    *"GiB free"* | *"free disk"*) code=disk_floor ;;
    *"spec"*"must"* | *"is not a JSON"*) code=spec_refused ;;
    esac
    # The step a client reads without the code: where the build failed.
    local step=build
    case "$code" in pull_failed) step=pull ;; probe_failed) step=probe ;; disk_floor) step=disk ;; spec_refused) step=spec ;; esac
    report "$handle" "$(jq -cn --arg m "$code: template-build.sh exit $rc: $last" --arg s "$step" '{event: "failed", step: $s, message: $m}')" >/dev/null ||
      error "report failed for $handle failed"
    say "{\"agent\":\"failed\",\"build\":\"$handle\",\"rc\":$rc,\"step\":\"$step\",\"code\":\"$code\"}"
    return
  fi
  # template-build.sh names the snapshot <id>-<first 12 hex of the image digest> and writes its record
  # beside the snapshots (its "Names" rule), built now or already built.
  local digest
  digest="$(jq -r .image "$spec")"
  digest="${digest##*@sha256:}"
  rec="$SBX_SRV/templates/$tpl-${digest:0:12}.json"
  [[ -f "$rec" ]] || { fail_claimed "$handle" report 'template-build.sh wrote no template record'; return; }
  # A record that is not JSON or names no snapshot must not end the poll under errexit.
  local name
  name="$(jq -r '.snapshot // empty' "$rec" 2>/dev/null)" || name=''
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { fail_claimed "$handle" report 'the template record names no snapshot'; return; }
  snap="$SBX_SRV/snapshots/$name"
  [[ -f "$snap/manifest.json" ]] || { fail_claimed "$handle" report 'the snapshot has no manifest'; return; }
  # T and S go byte for byte (the control plane checks T against the create and hashes S), so they
  # cannot be redacted: one that names this host's registry is not sent at all.
  if [[ -n "${SBX_REGISTRY:-}" ]] && grep -qF -- "$SBX_REGISTRY" "$rec" "$snap/manifest.json"; then
    FAILED=$((FAILED + 1))
    report "$handle" '{"event":"failed","step":"report","message":"leak_refused: the template record or manifest names this host'"'"'s registry; not sent (name the image without its registry)"}' >/dev/null ||
      error "report failed for $handle failed"
    say "{\"agent\":\"failed\",\"build\":\"$handle\",\"why\":\"leak_refused\"}"
    return
  fi
  local out
  out="$(report "$handle" "$(jq -cn --rawfile t "$rec" --rawfile s "$snap/manifest.json" '{event: "built", templateRecord: $t, manifest: $s}')")" ||
    { fail_claimed "$handle" report 'the built report was not accepted'; return; }
  BUILT=$((BUILT + 1))
  say "{\"agent\":\"reported\",\"build\":\"$handle\",\"outcome\":$(jq -c . <<<"$out")}"
}

worker_report() { # worker_report BUILD_ID EVENT [REASON]
  jq -cn --arg b "$1" --arg e "$2" --arg r "${3:-}" '{buildId: $b, event: $e} + (if $r == "" then {} else {reason: $r} end)' \
    >"$WORK/worker.json"
  api POST "/v1/hosts/$SBX_HOST_ID/workers/report" "$WORK/worker.json" >/dev/null || error "worker report for $1 failed"
}

# Start what is wanted and installed; stop what is not wanted (the control plane leaves out a worker
# with live sandboxes). Readiness is the relay's attached record, never this report. Under a lock, so
# the build poll's pass and the --wanted-only one never start or stop the same worker at once; the
# one that does not get it skips (the other is applying the same wanted state).
activation() {
  local wanted w b unit
  exec 9>"$SBX_SRV/.activation.lock"
  if ! flock -n 9; then
    say '{"agent":"skipped","why":"another run is applying the wanted state"}'
    exec 9>&-
    return 0
  fi
  if ! wanted="$(api GET "/v1/hosts/$SBX_HOST_ID/wanted")"; then
    error 'wanted state unreadable'; exec 9>&-; return 0
  fi
  # Kept for egress(), which takes its egressSids from this read rather than asking again.
  (umask 077 && printf '%s' "$wanted" >"$WORK/wanted.json")
  if ! jq -e '(.run | type) == "array" and (.stop | type) == "array"' >/dev/null 2>&1 <<<"$wanted"; then
    error 'wanted state malformed'; exec 9>&-; return 0
  fi
  # Stops first, so a slot a stopped worker frees is free before a start uses it.
  while IFS=$'\t' read -r w b; do
    [[ "$w" =~ $WORKER_RE ]] || { error 'a worker id to stop is malformed'; continue; }
    unit="sbx-worker@$w.service"
    systemctl is-active --quiet "$unit" || continue
    if systemctl stop "$unit"; then
      STOPPED=$((STOPPED + 1)); worker_report "$b" detached; say "{\"agent\":\"stopped\",\"worker\":\"$w\"}"
    else
      error "stop $unit failed"
    fi
  done < <(jq -r '.stop[] | [.worker, .buildId] | @tsv' <<<"$wanted")
  while IFS=$'\t' read -r w b; do
    [[ "$w" =~ $WORKER_RE ]] || { error 'a wanted worker id is malformed'; continue; }
    unit="sbx-worker@$w.service"
    if [[ ! -f "$SBX_ENV_DIR/workers/$w.env" ]]; then
      worker_report "$b" refused 'worker not installed on this host (install-host.sh with its setup.sh bundle)'
      say "{\"agent\":\"refused\",\"worker\":\"$w\",\"why\":\"not installed\"}"
      continue
    fi
    systemctl is-active --quiet "$unit" && continue
    # Returns at once (Type=simple): the worker reads its snapshot and attaches after this.
    if systemctl start "$unit"; then
      STARTED=$((STARTED + 1)); worker_report "$b" attached; say "{\"agent\":\"started\",\"worker\":\"$w\"}"
    else
      worker_report "$b" refused "systemctl start $unit failed"; error "start $unit failed"
    fi
  done < <(jq -r '.run[] | [.worker, .buildId] | @tsv' <<<"$wanted")
  exec 9>&-
}

# The egress post, with curl's status rather than -f's failure, so a 400 can be told from a 503: the
# HTTP status on stdout (000: no answer), the answer's body in ANSWER_FILE. The token is in the header
# file, as for api(); neither the body nor the token is printed.
egress_api() { # egress_api BODY_FILE ANSWER_FILE
  local ca=()
  [[ -z "${SBX_API_CA_FILE:-}" ]] || ca=(--cacert "$SBX_API_CA_FILE")
  curl -sS --max-time 60 --proto =https ${ca[@]+"${ca[@]}"} -H "@$HDR" -H 'Content-Type: application/json' \
    -X POST --data-binary "@$1" -o "$2" -w '%{http_code}' "$SBX_API_URL/v1/hosts/$SBX_HOST_ID/egress"
}

# Moves the cursor (and the position mark) past the batch in FILE.
egress_advance() { # egress_advance BATCH_FILE
  (umask 077 && jq -j .cursor "$1" >"$SBX_SRV/egress.cursor.tmp") && mv -f "$SBX_SRV/egress.cursor.tmp" "$SBX_SRV/egress.cursor"
  [[ ! -f "$SBX_SRV/egress.pending.mark" ]] || mv -f "$SBX_SRV/egress.pending.mark" "$SBX_SRV/egress.mark"
}

# Posts the pending batch; on success records its cursor and drops it. A 400 invalid_request or
# invalid_json moves it to egress.rejected/ and records its cursor (see the header). Fails, keeping
# both, otherwise (EG_CODE says how).
egress_post() {
  local pending="$SBX_SRV/egress.pending.json" out="$WORK/egress.answer" rej
  : >"$out"
  EG_CODE="$(egress_api "$pending" "$out" 2>/dev/null)" || EG_CODE=000
  case "$EG_CODE" in
  2??)
    jq -e '(.accepted | type) == "number"' "$out" >/dev/null 2>&1 || return 1
    EG_ACCEPTED=$((EG_ACCEPTED + $(jq -r .accepted "$out")))
    EG_REFUSED=$((EG_REFUSED + $(jq -r '.refused // 0' "$out")))
    egress_advance "$pending"
    rm -f "$pending"
    ;;
  400)
    jq -e '.error == "invalid_request" or .error == "invalid_json"' "$out" >/dev/null 2>&1 || return 1
    (umask 077 && mkdir -p "$SBX_SRV/egress.rejected") && chmod 0700 "$SBX_SRV/egress.rejected"
    rej="$SBX_SRV/egress.rejected/$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
    mv -f "$pending" "$rej" && chmod 0600 "$rej"
    egress_advance "$rej"
    EG_REJECTED=$((EG_REJECTED + 1))
    error "egress: the control plane refused a batch as malformed (400 $(jq -r .error "$out")); kept in $rej, the cursor moved past it"
    ;;
  *) return 1 ;;
  esac
}

# Selects the batch to post from the journal entries in ENTRIES into egress.pending.json.all:
# {cursor, events, oversized} and the local counts notOurs and unreadable. MARK_BOOT and MARK_MONO
# are the position mark (entries of that boot at or before it were sent already).
egress_select() { # egress_select ENTRIES MARK_BOOT MARK_MONO
  # Each entry's MESSAGE is a proxy event when it is a JSON object from moca-egress; others are skipped.
  # A MESSAGE that is not text (journalctl prints bytes that are not UTF-8 as an array of numbers)
  # cannot be read for its sid: it is counted (unreadable) and said in an error line, never silent.
  # An event over 8 KiB (a guest's long path) is not sent; its sid is, as `oversized`, and the
  # control plane counts it as dropped in that sandbox's log. Nothing in an event is changed.
  # Only this host's sandboxes' events, and the proxy's audit_dropped reports (no sid); `notOurs`
  # counts the others, which stay on the host (it is read aside, and never posted).
  (umask 077 && jq -cs --arg b "$2" --argjson m "$3" --slurpfile s "$WORK/egress.sids" '(last | .__CURSOR) as $c
      | [.[] | select(._BOOT_ID != $b or ((.__MONOTONIC_TIMESTAMP // "0") | tonumber) > $m)]
      | [.[] | .MESSAGE | strings | (try fromjson catch null) | objects | select(.via == "moca-egress")] as $every
      | [$every[] | select((.decision == "audit_dropped" and ((.sid // "") == "")) or (.sid as $x | $s[0] | index([$x]) != null))] as $all
      | {cursor: $c, notOurs: (($every | length) - ($all | length)),
         unreadable: ([.[] | select(.MESSAGE != null and (.MESSAGE | type) != "string")] | length),
         events: [$all[] | select((tojson | utf8bytelength) <= 8192)],
         oversized: [$all[] | select((tojson | utf8bytelength) > 8192) | (.sid // "" | tostring | .[0:128])]}' \
    "$1" >"$SBX_SRV/egress.pending.json.all")
}

# Reads the wanted state again and adds its egressSids to the list (a union: a sid the first read
# named is kept). Fails, changing nothing, when the read or its egressSids fails.
egress_sids_refresh() {
  local fresh="$WORK/wanted.fresh"
  (umask 077 && api GET "/v1/hosts/$SBX_HOST_ID/wanted" >"$fresh") || return 1
  jq -e '.egressSids | type == "array" and all(type == "string")' "$fresh" >/dev/null 2>&1 || return 1
  (umask 077 && jq -cs '.[0] + .[1].egressSids | unique' "$WORK/egress.sids" "$fresh" >"$WORK/egress.sids.tmp") &&
    mv -f "$WORK/egress.sids.tmp" "$WORK/egress.sids"
}

# The egress step (see the header). Reads the journal only; never acts on moca-egress.
egress() {
  systemctl is-active --quiet moca-egress.service 2>/dev/null || return 0
  EGRESS=on
  command -v journalctl >/dev/null || { error 'egress: no journalctl on PATH'; return; }
  exec 8>"$SBX_SRV/.egress.lock"
  flock -n 8 || { say '{"agent":"skipped","why":"another run is shipping egress events"}'; return 0; }
  local pending="$SBX_SRV/egress.pending.json" n i pos entries started=$SECONDS sids="$WORK/egress.sids"
  # This host's sandboxes' workspace keys (see the header). activation() kept the wanted state; a run
  # whose activation skipped for the lock reads it here, once.
  if [[ ! -s "$WORK/wanted.json" ]]; then
    (umask 077 && api GET "/v1/hosts/$SBX_HOST_ID/wanted" >"$WORK/wanted.json") || { error 'egress: wanted state unreadable; nothing sent'; exec 8>&-; return; }
  fi
  if ! jq -e '.egressSids | type == "array" and all(type == "string")' "$WORK/wanted.json" >/dev/null 2>&1; then
    error 'egress: the wanted state has no egressSids (a control plane older than openapi 1.8.0); nothing sent, the cursor kept'
    exec 8>&-
    return
  fi
  (umask 077 && jq -c '.egressSids' "$WORK/wanted.json" >"$sids")
  if [[ -f "$pending" ]]; then
    egress_post || { error "egress post failed: the cursor stays, the next run retries (HTTP $EG_CODE)"; exec 8>&-; return; }
  fi
  local rc mb mm skipped n_bad
  for ((i = 0; i < EGRESS_BATCHES; i++)); do
    if ((SECONDS - started >= EGRESS_BUDGET_S)); then
      say "{\"agent\":\"skipped\",\"why\":\"egress: the ${EGRESS_BUDGET_S} s budget is spent; the next run goes on\"}"
      break
    fi
    pos=(-b)
    [[ ! -s "$SBX_SRV/egress.cursor" ]] || pos=(--after-cursor "$(<"$SBX_SRV/egress.cursor")")
    entries="$WORK/egress.entries"
    # journalctl's own exit status, written aside: the pipe's is head's, and head stopping early is a
    # SIGPIPE (141) for a full batch, not a failure. (A && B || C keeps set -e out of the subshell.)
    # --all: without it, journalctl prints a field over 4096 bytes as null, so an event of 4-8 KiB
    # would be passed over unsent and uncounted.
    { journalctl -u moca-egress.service -o json --all --no-pager "${pos[@]}" 2>"$WORK/egress.jerr" && echo 0 >"$WORK/egress.jrc" ||
      echo "$?" >"$WORK/egress.jrc"; } | head -n "$EGRESS_BATCH" >"$entries" || true
    rc="$(<"$WORK/egress.jrc")"
    n="$(wc -l <"$entries" | tr -d ' ')"
    if ((n == 0)) && [[ "$rc" != 0 && "$rc" != 141 ]]; then
      if [[ "${pos[0]}" == --after-cursor ]]; then
        mv -f "$SBX_SRV/egress.cursor" "$SBX_SRV/egress.cursor.stale"
        error 'egress: the journal cursor is no longer valid; restarting from this boot (the old one is in egress.cursor.stale)'
        if [[ -s "$SBX_SRV/egress.mark" ]]; then
          (umask 077 && : >"$SBX_SRV/egress.catchup")
        else
          error 'egress: no position mark: entries of this boot already sent are sent again, and the control plane stores them twice'
        fi
        continue
      fi
      error "egress: journalctl exited $rc"
      break
    fi
    ((n > 0)) || break
    EG_READ=$((EG_READ + n))
    # The position mark: the last sent entry's boot and monotonic time. An entry of that boot at or
    # before it was sent already (a restart from this boot re-reads it), so it is skipped.
    mb='' mm=-1
    if [[ -f "$SBX_SRV/egress.catchup" && -s "$SBX_SRV/egress.mark" ]]; then read -r mb mm <"$SBX_SRV/egress.mark" || true; fi
    [[ "$mm" =~ ^[0-9]+$ ]] || { mb='' mm=-1; }
    # A sid not in the list may be a sandbox created after the list was read (activation()'s GET
    # comes before this journal read): then the list is read again, now, after the read, and the
    # batch selected again with both lists, so a new sandbox's first events are never passed over.
    egress_select "$entries" "$mb" "$mm" ||
      { rm -f "$pending.all"; error 'egress: the journal batch did not parse'; break; }
    if [[ "$(jq .notOurs "$pending.all")" != 0 ]]; then
      if ! egress_sids_refresh; then
        rm -f "$pending.all"; error 'egress: the wanted state unreadable after the journal read; nothing sent, the cursor kept'; break
      fi
      egress_select "$entries" "$mb" "$mm" ||
        { rm -f "$pending.all"; error 'egress: the journal batch did not parse'; break; }
    fi
    (umask 077 && jq -c 'del(.notOurs, .unreadable)' "$pending.all" >"$pending") ||
      { rm -f "$pending" "$pending.all"; error 'egress: the journal batch did not parse'; break; }
    EG_NOT_OURS=$((EG_NOT_OURS + $(jq .notOurs "$pending.all")))
    n_bad="$(jq .unreadable "$pending.all")"
    ((n_bad == 0)) || error "egress: $n_bad journal entries of moca-egress have a MESSAGE that is not text; not sent"
    rm -f "$pending.all"
    # The skipped count, and the mark after this batch (never moved back within a boot).
    # '|'-joined: with tabs, read would collapse an empty boot id and shift the fields.
    IFS='|' read -r skipped mb mm < <(jq -rs --arg b "$mb" --argjson m "$mm" '
        ([.[] | select(._BOOT_ID == $b and ((.__MONOTONIC_TIMESTAMP // "0") | tonumber) <= $m)] | length) as $s
        | (last | [._BOOT_ID // "", ((.__MONOTONIC_TIMESTAMP // "0") | tonumber)]) as $l
        | [$s] + (if $l[0] == $b and $l[1] <= $m then [$b, $m] else $l end) | map(tostring) | join("|")' "$entries")
    EG_SKIPPED=$((EG_SKIPPED + skipped))
    # Caught up once the batch holds an entry past the mark.
    ((skipped == n)) || rm -f "$SBX_SRV/egress.catchup"
    [[ -z "$mb" ]] || (umask 077 && printf '%s %s\n' "$mb" "$mm" >"$SBX_SRV/egress.pending.mark")
    if [[ "$(jq '(.events | length) + (.oversized | length)' "$pending")" == 0 ]]; then
      egress_advance "$pending"
      rm -f "$pending"
    else
      egress_post || { error "egress post failed: the cursor stays, the next run retries (HTTP $EG_CODE)"; break; }
    fi
    ((n == EGRESS_BATCH)) || break
  done
  exec 8>&-
}

summary() { # summary [MORE]: MORE is appended to the line's fields (the egress counts)
  say "{\"agent\":\"summary\",\"claimed\":$CLAIMED,\"built\":$BUILT,\"failed\":$FAILED,\"started\":$STARTED,\"stopped\":$STOPPED,\"errors\":$ERRORS${1:-}}"
}

main() {
  [[ $# -eq 1 && ( "$1" == --once || "$1" == --wanted-only ) ]] ||
    { echo 'usage: host-agent.sh --once | --wanted-only' >&2; exit 2; }
  local mode="$1"
  command -v jq >/dev/null || refuse 'needs jq on PATH'
  check_settings
  WORK="$(umask 077 && mktemp -d)"
  HDR="$WORK/hdr"
  # shellcheck disable=SC2064 # expand now: the trap must remove exactly this directory
  trap "rm -rf '$WORK'" EXIT
  (umask 077 && printf 'Authorization: Bearer %s\n' "$(<"$SBX_HOST_TOKEN_FILE")" >"$HDR")
  if ! inventory; then
    say '{"agent":"skipped","why":"control plane unreachable or refused the inventory"}'
    return 0
  fi
  if [[ "$mode" == --wanted-only ]]; then
    activation
    egress
    summary ",\"egress\":\"$EGRESS\",\"egressRead\":$EG_READ,\"egressAccepted\":$EG_ACCEPTED,\"egressRefused\":$EG_REFUSED,\"egressSkipped\":$EG_SKIPPED,\"egressRejected\":$EG_REJECTED,\"egressNotOurs\":$EG_NOT_OURS"
    return 0
  fi
  local free
  free="$(free_gb)"
  # A build pulls its image: claiming one with no registry login fails it at the pull and loses it.
  # With SBX_REGISTRY set, require a login for it in REGISTRY_AUTH_FILE first.
  if [[ -n "${SBX_REGISTRY:-}" ]] && ! registry_logged_in; then
    say '{"agent":"skipped","why":"no registry login for SBX_REGISTRY in REGISTRY_AUTH_FILE: log in before builds"}'
  elif [[ -z "$free" ]] || ((free < SBX_DISK_FLOOR_GB)); then
    say "{\"agent\":\"skipped\",\"why\":\"free disk ${free:-?} GB is below the floor $SBX_DISK_FLOOR_GB GB\"}"
  else
    printf '{"max":%d}' "$SBX_BUILD_CONCURRENCY" >"$WORK/claim.json"
    local jobs
    if jobs="$(api POST "/v1/hosts/$SBX_HOST_ID/builds/claim" "$WORK/claim.json")" && jq -e '.builds | type == "array"' >/dev/null 2>&1 <<<"$jobs"; then
      while IFS= read -r job; do build_one "$job"; done < <(jq -c '.builds[]' <<<"$jobs")
    else
      error 'claim failed'
    fi
  fi
  # The wanted state is applied whether or not a build was claimed (a registry login or the disk
  # floor holds builds, never activations).
  activation
  summary
}

main "$@"
