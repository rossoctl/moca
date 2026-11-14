#!/usr/bin/env bash
# deploy/sbx/host-agent.sh -- sbx-host-agent, a KVM host's template agent
# (docs/specs/2026-11-03-template-lifecycle-and-provenance-design.md §6.1). One run is one poll:
# report the inventory, claim queued builds, build each with template-build.sh, report the outcome.
# The control plane registers or rejects a built build by policy (§8.2); nothing here does.
#
# It installs no worker: a registered build's worker is installed by an operator (install-host.sh,
# from the template record template-build.sh wrote, with its relay token from setup.sh).
#
#   sudo deploy/sbx/host-agent.sh --once          one poll (the unit's timer runs it)
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
# The token never reaches argv or a log: curl reads it from a 0600 header file. Output: one JSON line
# per action, then one summary line {"agent":"summary","claimed","built","failed","errors"}. A refusal
# of its own settings is exit 2.
set -euo pipefail
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${SBX_TEMPLATE_BUILD:=$REPO_ROOT/deploy/sbx/template-onboarding/template-build.sh}"
HOST_ID_RE='^[a-z0-9][a-z0-9-]{0,30}$'
HANDLE_RE='^b-[0-9a-f]{26}$'
TEMPLATE_ID_RE='^[a-z0-9][a-z0-9-]{0,30}$'
DIGEST_RE='^sha256:[0-9a-f]{64}$'

say() { printf '%s\n' "$*"; }
refuse() { echo "sbx-host-agent: $*" >&2; exit 2; }
CLAIMED=0 BUILT=0 FAILED=0 ERRORS=0
error() { ERRORS=$((ERRORS + 1)); say "{\"agent\":\"error\",\"why\":$(jq -Rn --arg w "$1" '$w')}"; }

check_settings() {
  local t
  for t in jq curl df mktemp base64 sha256sum; do command -v "$t" >/dev/null || refuse "needs $t on PATH"; done
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

# The snapshots this host holds, by manifest hash, as template-build.sh's records name them, and
# its limits.
inventory() {
  local f out="$WORK/inventory.json"
  {
    printf '{"holds":['
    local sep=''
    while IFS= read -r f; do
      printf '%s%s' "$sep" "$(jq -c '{template: .id, manifestHash: .manifest_hash}' "$f")"
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

main() {
  [[ $# -eq 1 && "$1" == --once ]] || { echo 'usage: host-agent.sh --once' >&2; exit 2; }
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
  say "{\"agent\":\"summary\",\"claimed\":$CLAIMED,\"built\":$BUILT,\"failed\":$FAILED,\"errors\":$ERRORS}"
}

main "$@"
