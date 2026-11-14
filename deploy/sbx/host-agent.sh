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
# the proxy's audit events, with no field added, removed or changed, to POST /v1/hosts/<id>/egress, where each event
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
#     egressSids (older than openapi 1.14.0) gets nothing: an error line, no journal read, the cursor kept.
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
#   - A stale cursor is an error. journalctl itself fails only on a cursor it cannot parse: one whose
#     entry was vacuumed resumes at the nearest kept entry, and another machine's falls back to time
#     and reads across boots, both with exit 0 (the second could re-send entries the control plane
#     cannot tell from new ones). So before its first read the step checks that the cursor still
#     names an entry (journalctl --cursor prints that entry first); if not, or if journalctl fails
#     on it, the cursor is kept as $SBX_SRV/egress.cursor.stale and the step restarts from this boot.
#     Entries rotated away before they were sent are lost with the journal; the error says so.
#     Entries it already sent are not sent again: beside the cursor, $SBX_SRV/egress.mark (0600) keeps the last sent
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
#   SBX_MEM_FLOOR_MIB        optional; the memory the control plane never places workers into
#                            (memory-aware placement): a whole number of MiB, at least 1. Unset: 10%
#                            of MemTotal, at least 4096. The inventory reports the effective floor
#                            (memFloorMib)
#   SBX_MEM_PRESSURE_LIMIT   default 10: while memory PSI `full avg10` (a percentage) is above it, the
#                            host takes no new start (what it runs is kept); a number, more than 0,
#                            at most 100, up to two decimals
#   SBX_START_CONCURRENCY    default 4: at most this many workers STARTING at once (started, not yet
#                            attached to the relay: the start limit, §6.5); a whole
#                            number, at least 1 (0 is refused). Not SBX_ACTIVE_LIMIT, which caps running ones
#   SBX_START_WINDOW_S       default 300: with a control plane that sends no `starting` (older than
#                            openapi 1.13.0), a worker this agent started less than this many seconds ago,
#                            whose unit is active and which is still wanted, counts as starting. With
#                            `starting`, the most a listed worker counts as starting: past it, it is
#                            stuck (an error line each run) and holds no start slot
#   SBX_IDLE_GRACE_S         default 0 (off): how long the control plane keeps a released build's running
#                            worker before it is stopped (the idle grace); a whole number
#                            of seconds, at most 86400 (a day), without a leading zero. Reported in the
#                            inventory's limits (idleGraceSeconds); the control plane decides the grace
#   SBX_TEMPLATE_BUILD       default <repo>/deploy/sbx/template-onboarding/template-build.sh (a test seam)
#   SBX_REGISTRY             optional; template-build.sh --registry. With it set, no build is claimed
#                            until REGISTRY_AUTH_FILE (default /run/containers/0/auth.json) holds a
#                            login for it
#   SBX_SYS_ROOT             default /: where /proc and /sys/fs/cgroup are read from (a test seam)
#
# The inventory's memory, sent on every run, so the control plane places workers by memory as well
# as by SBX_ACTIVE_LIMIT: `memory: {memTotalMib, memAvailableMib, memPressureFull10, memFloorMib,
# memPressureLimit, runningWorkers, vmCommittedMib, memfileMismatch}`.
#   - memTotalMib, memAvailableMib: /proc/meminfo; memFloorMib the effective floor. Without the two,
#     none of the three is sent (an error line): the control plane then places by SBX_ACTIVE_LIMIT
#     alone, as with an older agent.
#   - memPressureFull10: /proc/pressure/memory's `full avg10`. With no /proc/pressure (an older kernel,
#     or psi=0 at boot) it is left out, which is no brake, never "no starts"; the summary says
#     "psi":"absent", once per run.
#   - runningWorkers: the workers of the held builds whose sbx-worker@<id> unit is active (a worker
#     pins its snapshot's memory file whole at start, attached to the relay or not).
#   - vmCommittedMib: per running worker, what its VMs hold that the kernel cannot reclaim, from its
#     slice's memory.stat (cgroup v2, sbx.slice/sbx-<id>.slice): anon + shmem + kernel (kernel_stack +
#     pagetables + slab on a kernel without the `kernel` line). Never memory.current: that counts the
#     page cache the VMs' files fill (rootfs, workspace), several GiB a worker that the kernel takes
#     back at need. The pinned memory file is file-backed and mlocked, so it is in neither: the
#     worker's cost counts it. A slice whose memory.stat cannot be read, or has no anon line, is left
#     out, never guessed; the summary lists it ("sliceUnread").
#   - memfileMismatch: the held builds whose memory file (snapshots/<snapshot>/memfile) is not exactly
#     the manifest's guest_ram_mb x 1 MiB (or is missing): each is an error line, the summary counts
#     them ("memfileMismatch"), the control plane never places one here, and this agent refuses to
#     start one (reported `refused`) whatever a control plane asks.
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
# The start limit (§6.5), in activation(): a cold worker reads and pins its whole memory file before
# it attaches, and starts at once share the disk, so the agent starts at most SBX_START_CONCURRENCY
# less those starting now, per run, in the wanted answer's order (oldest lease first); the rest wait
# for the next run (15 s) and are counted in the summary (startQueued). activation() never waits for
# a start: `systemctl start` of the Type=simple worker unit returns at once.
#   - "Starting" comes from the control plane: the wanted answer's `starting` (openapi 1.13.0) lists the
#     builds placed here whose worker is not attached to the relay; a listed build whose unit is active
#     is starting. A control plane without `starting` cannot say what is attached, so the agent counts
#     its own: the workers it started less than SBX_START_WINDOW_S ago that are still active and wanted.
#     The limit thus holds with an older control plane too (it is the agent's). Either way a start
#     counts for SBX_START_WINDOW_S at most: a listed worker still not attached after it (one that
#     crash-loops, hangs, or cannot reach the relay) is stuck, said in an error line each run, and
#     holds no slot, so a few such workers cannot stop every other start on the host.
#   - $SBX_SRV/start-times (0600) keeps each start: worker, build id, epoch (and `seen` for a listed
#     worker this agent did not start, timed from when it was first seen; it gives no start time). A start is done when the
#     wanted answer still lists its build in `run` but no longer in `starting`; its time (to within the
#     15 s poll) goes into $SBX_SRV/start-seconds (0600, the last 10), and the inventory's limits report
#     their mean as startSeconds (absent until a start is done, so always with an older control plane),
#     beside startConcurrency.
#
# The idle grace (§6.5): with SBX_IDLE_GRACE_S > 0, the control plane keeps a released build in `run`
# for that long after its last lease ends (if the host has the slot and the memory), and lists it in
# the wanted answer's `graced`; a wanted build that needs the slot moves it to `stop`. The agent
# applies the answer as ever (a graced worker's unit runs, so nothing is started for it), never starts
# a graced build whose unit is not running (a grace keeps a worker, it never starts one), and counts
# the graced workers it runs in the summary ("graced":<n>).
#
# The token never reaches argv or a log: curl reads it from a 0600 header file, and no egress event is
# printed. Output: one JSON line per action, then one summary line {"agent":"summary","claimed","built",
# "failed","started","stopped","errors"}, in a --wanted-only run followed by "egress":"on"|"off" and
# "egressRead","egressAccepted","egressRefused","egressSkipped","egressRejected","egressNotOurs"; then,
# when there is something to say about memory, "psi":"absent", "sliceUnread":[<worker id>...] and
# "memfileMismatch":<n>; then "startQueued":<n> when the start limit left wanted workers for a later
# run; then "graced":<n> when the idle grace keeps any. A refusal of its own settings is exit 2.
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
: "${SBX_SYS_ROOT:=/}" # a test seam: /proc, /sys
MEM_SUMMARY='' START_SUMMARY='' GRACE_SUMMARY='' INFLIGHT=0
BUILD_ID_RE='^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$'
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
  : "${SBX_START_CONCURRENCY:=4}" "${SBX_START_WINDOW_S:=300}"
  [[ "$SBX_START_CONCURRENCY" =~ ^[1-9][0-9]{0,8}$ ]] ||
    refuse 'SBX_START_CONCURRENCY must be a whole number, at least 1, without a leading zero (0 would start no worker)'
  [[ "$SBX_START_WINDOW_S" =~ ^[1-9][0-9]{0,8}$ ]] ||
    refuse 'SBX_START_WINDOW_S must be a whole number of seconds, at least 1, without a leading zero'
  : "${SBX_IDLE_GRACE_S:=0}"
  if ! [[ "$SBX_IDLE_GRACE_S" =~ ^(0|[1-9][0-9]{0,4})$ ]] || ((SBX_IDLE_GRACE_S > 86400)); then
    refuse 'SBX_IDLE_GRACE_S must be a whole number of seconds, 0 (off) to 86400, without a leading zero'
  fi
  for v in SBX_DISK_FLOOR_GB SBX_BUILD_CONCURRENCY SBX_ACTIVE_LIMIT SBX_IDLE_LIMIT_S; do
    [[ -z "${!v:-}" || "${!v}" =~ ^(0|[1-9][0-9]{0,8})$ ]] || refuse "$v must be a whole number without a leading zero"
  done
  : "${SBX_DISK_FLOOR_GB:=60}" "${SBX_BUILD_CONCURRENCY:=1}" "${SBX_ACTIVE_LIMIT:=0}" "${SBX_IDLE_LIMIT_S:=0}"
  ((SBX_BUILD_CONCURRENCY >= 1 && SBX_BUILD_CONCURRENCY <= 4)) || refuse 'SBX_BUILD_CONCURRENCY must be 1-4'
  [[ -z "${SBX_MEM_FLOOR_MIB:-}" || "$SBX_MEM_FLOOR_MIB" =~ ^[1-9][0-9]{0,8}$ ]] ||
    refuse 'SBX_MEM_FLOOR_MIB must be a whole number of MiB, at least 1, without a leading zero'
  : "${SBX_MEM_PRESSURE_LIMIT:=10}"
  if ! [[ "$SBX_MEM_PRESSURE_LIMIT" =~ ^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$ ]] ||
    ! awk -v v="$SBX_MEM_PRESSURE_LIMIT" 'BEGIN { exit !(v > 0 && v <= 100) }'; then
    refuse 'SBX_MEM_PRESSURE_LIMIT must be a number more than 0 and at most 100 (PSI full avg10, a percentage)'
  fi
  [[ "$SBX_SYS_ROOT" == /* ]] || refuse 'SBX_SYS_ROOT must be an absolute path'
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

# A file's size in bytes (GNU stat, then BSD's); empty when it is not there.
file_size() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || true; }

# The records of the snapshots this host holds, as template-build.sh writes them.
held_records() {
  local f
  for f in "$SBX_SRV"/templates/*.json; do
    [[ -f "$f" ]] || continue
    jq -e '.schema == "moca-sbx-template/1" and (.manifest_hash | test("^sha256:[0-9a-f]{64}$"))' "$f" >/dev/null 2>&1 || continue
    printf '%s\n' "$f"
  done
}

# The inventory's memory object (see the header) into $WORK/memory.json, without the figures (and an
# error line) when /proc/meminfo gives no MemTotal or MemAvailable. Notes for the summary go into
# MEM_SUMMARY, and the builds whose memory file does not match into $WORK/memfile-mismatch (one
# manifest hash a line), which activation() refuses to start.
memory_report() {
  local root="${SBX_SYS_ROOT%/}" total avail psi='' floor rec hash snap w guest size cur mm=0
  local running="$WORK/mem.running" committed="$WORK/mem.committed" unread="$WORK/mem.unread"
  : >"$running"; : >"$committed"; : >"$unread"; : >"$WORK/memfile-mismatch"
  MEM_SUMMARY=''
  total="$(awk '$1 == "MemTotal:" { printf "%d", $2 / 1024 }' "$root/proc/meminfo" 2>/dev/null || true)"
  avail="$(awk '$1 == "MemAvailable:" { printf "%d", $2 / 1024 }' "$root/proc/meminfo" 2>/dev/null || true)"
  # PSI's `full avg10`: absent with no /proc/pressure (no brake), said once in the summary.
  if [[ -r "$root/proc/pressure/memory" ]]; then
    psi="$(awk '$1 == "full" { for (i = 2; i <= NF; i++) if ($i ~ /^avg10=/) { sub(/^avg10=/, "", $i); print $i } }' "$root/proc/pressure/memory" 2>/dev/null || true)"
  fi
  [[ "$psi" =~ ^[0-9]{1,3}(\.[0-9]+)?$ ]] || { psi=''; MEM_SUMMARY+=',"psi":"absent"'; }
  while IFS= read -r rec; do
    hash="$(jq -r .manifest_hash "$rec")" snap="$(jq -r '.snapshot // empty' "$rec")" w="$(jq -r '.worker // empty' "$rec")"
    # The memory file a worker pins is the guest's whole RAM (a Full snapshot): its size must be
    # guest_ram_mb x 1 MiB exactly, or the build's cost is not what the control plane counts.
    guest='' size=''
    if [[ "$snap" =~ ^[A-Za-z0-9._-]+$ && "$snap" != . && "$snap" != .. ]]; then
      guest="$(jq -r '.guest_ram_mb // empty' "$SBX_SRV/snapshots/$snap/manifest.json" 2>/dev/null || true)"
      size="$(file_size "$SBX_SRV/snapshots/$snap/memfile")"
    fi
    if ! [[ "$guest" =~ ^[1-9][0-9]*$ && "$size" =~ ^[0-9]+$ ]] || ((size != guest * 1048576)); then
      mm=$((mm + 1))
      printf '%s\n' "$hash" >>"$WORK/memfile-mismatch"
      error "memfile mismatch: build $hash (snapshot ${snap:-?}): its memory file is ${size:-missing}${size:+ bytes}, not guest_ram_mb ${guest:-?} x 1 MiB; it is not placed or started on this host"
    fi
    [[ "$w" =~ $WORKER_RE ]] || continue
    grep -qxF -- "$w" "$running" && continue
    systemctl is-active --quiet "sbx-worker@$w.service" || continue
    printf '%s\n' "$w" >>"$running"
    # Its VMs' unreclaimable memory: anon + shmem + kernel, bytes to MiB; no anon line: unread.
    cur="$(awk '$2 ~ /^[0-9]+$/ { v[$1] = $2 }
      END { if (!("anon" in v)) exit
            k = ("kernel" in v) ? v["kernel"] : v["kernel_stack"] + v["pagetables"] + v["slab"]
            printf "%d", (v["anon"] + v["shmem"] + k) / 1048576 }' \
      "$root/sys/fs/cgroup/sbx.slice/sbx-$w.slice/memory.stat" 2>/dev/null || true)"
    if [[ "$cur" =~ ^[0-9]+$ ]]; then
      printf '%s\t%s\n' "$w" "$cur" >>"$committed"
    else
      printf '%s\n' "$w" >>"$unread"
      say "{\"agent\":\"note\",\"worker\":\"$w\",\"why\":\"its slice's memory.stat is unreadable: its VMs' memory is not reported\"}"
    fi
  done < <(held_records)
  [[ ! -s "$unread" ]] || MEM_SUMMARY+=",\"sliceUnread\":$(jq -Rsc 'split("\n") | map(select(length > 0))' "$unread")"
  ((mm == 0)) || MEM_SUMMARY+=",\"memfileMismatch\":$mm"
  # Without MemTotal and MemAvailable, the object carries no memory figures (the control plane then
  # places by SBX_ACTIVE_LIMIT alone), but still the workers and the mismatches.
  if [[ "$total" =~ ^[0-9]+$ && "$avail" =~ ^[0-9]+$ ]] && ((total > 0)); then
    if [[ -n "${SBX_MEM_FLOOR_MIB:-}" ]]; then
      floor="$SBX_MEM_FLOOR_MIB"
    else
      floor=$((total / 10))
      ((floor >= 4096)) || floor=4096
    fi
  else
    total='' avail='' floor=''
    error 'no MemTotal or MemAvailable in /proc/meminfo: no memory figures reported, so placement here is by SBX_ACTIVE_LIMIT alone'
  fi
  jq -n --arg total "$total" --arg avail "$avail" --arg psi "$psi" --arg floor "$floor" \
    --argjson limit "$SBX_MEM_PRESSURE_LIMIT" --rawfile r "$running" --rawfile c "$committed" --rawfile m "$WORK/memfile-mismatch" \
    '(if $total == "" then {} else
        {memTotalMib: ($total | tonumber), memAvailableMib: ($avail | tonumber), memFloorMib: ($floor | tonumber)} end)
     + (if $psi == "" then {} else {memPressureFull10: ($psi | tonumber)} end)
     + {memPressureLimit: $limit,
        runningWorkers: ($r | split("\n") | map(select(length > 0))),
        vmCommittedMib: ($c | split("\n") | map(select(length > 0) | split("\t") | {key: .[0], value: (.[1] | tonumber)}) | from_entries),
        memfileMismatch: ($m | split("\n") | map(select(length > 0)) | unique)}' >"$WORK/memory.json"
}

# The snapshots this host holds, by manifest hash, as template-build.sh's records name them, each
# with whether its worker's unit is running (the control plane counts running workers against
# SBX_ACTIVE_LIMIT and keeps a running build on this host); its limits, with its start limit,
# measured start time and idle grace; and its memory.
inventory() {
  local f w r out="$WORK/inventory.json" mem='{}' secs
  if memory_report; then mem="$(jq -c '{memory: .}' "$WORK/memory.json")" || mem='{}'; fi
  secs="$(start_seconds)"
  {
    printf '{"holds":['
    local sep=''
    while IFS= read -r f; do
      w="$(jq -r '.worker // ""' "$f")" r=false
      if [[ "$w" =~ $WORKER_RE ]] && systemctl is-active --quiet "sbx-worker@$w.service"; then r=true; fi
      printf '%s%s' "$sep" "$(jq -c --argjson r "$r" '{template: .id, manifestHash: .manifest_hash, running: $r}' "$f")"
      sep=','
    done < <(held_records)
    printf '],"limits":{"activeLimit":%d,"idleLimitSeconds":%d,"buildConcurrency":%d,"diskFreeGb":%d,"diskFloorGb":%d,"startConcurrency":%d,"idleGraceSeconds":%d%s}}' \
      "$SBX_ACTIVE_LIMIT" "$SBX_IDLE_LIMIT_S" "$SBX_BUILD_CONCURRENCY" "$(free_gb)" "$SBX_DISK_FLOOR_GB" \
      "$SBX_START_CONCURRENCY" "$SBX_IDLE_GRACE_S" "${secs:+,\"startSeconds\":$secs}"
  } | jq -c --argjson m "$mem" '. + $m' >"$out"
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

# The mean of the last completed starts' seconds ($SBX_SRV/start-seconds), rounded; empty with none.
start_seconds() {
  [[ -s "$SBX_SRV/start-seconds" ]] || return 0
  awk '$1 ~ /^[0-9]+$/ { s += $1; n++ } END { if (n) printf "%d", s / n + 0.5 }' "$SBX_SRV/start-seconds"
}

# The start book (see the header), before this run's starts. Of $SBX_SRV/start-times it keeps the
# starts still in flight, records the time of each one done, and drops the rest (stopped, no longer
# wanted, or, with no `starting` from the control plane, SBX_START_WINDOW_S old). Then sets INFLIGHT,
# the workers starting now, none counted past SBX_START_WINDOW_S (stuck). Reads $WORK/run.tsv (worker, build a line), $WORK/starting.ids and
# $WORK/graced.ids (a graced build is kept running, not wanted: its start, if any, is dropped).
start_book() { # start_book NOW HAS_STARTING
  local now="$1" has="$2" w b t a book="$SBX_SRV/start-times" keep="$WORK/start-times.keep" fin="$WORK/start-seconds.new"
  : >"$keep"; : >"$fin"
  if [[ -f "$book" ]]; then
    while IFS=$'\t' read -r w b t a; do
      [[ "$w" =~ $WORKER_RE && "$b" =~ $BUILD_ID_RE && "$t" =~ ^[0-9]{1,12}$ ]] || continue
      grep -qxF -- "$w"$'\t'"$b" "$WORK/run.tsv" || continue
      # Released before it was seen attached, and kept by the idle grace: no start time to take.
      ! grep -qxF -- "$b" "$WORK/graced.ids" || continue
      systemctl is-active --quiet "sbx-worker@$w.service" || continue
      if ((has == 1)); then
        if grep -qxF -- "$b" "$WORK/starting.ids"; then
          if [[ "$a" == seen ]]; then printf '%s\t%s\t%s\tseen\n' "$w" "$b" "$t"; else printf '%s\t%s\t%s\n' "$w" "$b" "$t"; fi >>"$keep"
        elif [[ "$a" == seen ]] || ((now - t >= SBX_START_WINDOW_S)); then
          # Not started by this agent (timed from when first seen), or done only after it was stuck:
          # neither is a cold start's time.
          say "{\"agent\":\"attached\",\"worker\":\"$w\"}"
        elif ((now >= t)); then
          printf '%s\n' "$((now - t))" >>"$fin"
          say "{\"agent\":\"attached\",\"worker\":\"$w\",\"startSeconds\":$((now - t))}"
        fi
      elif ((now - t < SBX_START_WINDOW_S)); then
        printf '%s\t%s\t%s\n' "$w" "$b" "$t" >>"$keep"
      fi
    done <"$book"
  fi
  rm -f "$book.tmp"
  (umask 077 && cat "$keep" >"$book.tmp") && mv -f "$book.tmp" "$book"
  if [[ -s "$fin" ]]; then
    (umask 077 && cat "$SBX_SRV/start-seconds" "$fin" 2>/dev/null | tail -n 10 >"$SBX_SRV/start-seconds.tmp") || true
    mv -f "$SBX_SRV/start-seconds.tmp" "$SBX_SRV/start-seconds"
  fi
  INFLIGHT=0
  if ((has == 1)); then
    # The control plane's list, whoever started the unit: a listed build whose unit is active, for
    # SBX_START_WINDOW_S from its start. One the book does not hold (started by hand, or before this
    # agent kept a book) is entered as first seen now. Past the window it is stuck (it crash-loops,
    # hangs, or cannot reach the relay): no longer counted, so it holds no start slot, and said.
    while IFS=$'\t' read -r w b; do
      if ! [[ "$w" =~ $WORKER_RE ]] || ! grep -qxF -- "$b" "$WORK/starting.ids"; then continue; fi
      systemctl is-active --quiet "sbx-worker@$w.service" || continue
      t="$(awk -F'\t' -v w="$w" -v b="$b" '$1 == w && $2 == b { print $3; exit }' "$book")"
      if [[ -z "$t" ]]; then
        t="$now"
        if [[ "$b" =~ $BUILD_ID_RE ]]; then
          (umask 077 && printf '%s\t%s\t%s\tseen\n' "$w" "$b" "$now" >>"$book")
        fi
      fi
      if ((now - t >= SBX_START_WINDOW_S)); then
        error "worker $w started $((now - t)) s ago and is not attached: it no longer holds a start slot"
        continue
      fi
      INFLIGHT=$((INFLIGHT + 1))
    done <"$WORK/run.tsv"
  else
    INFLIGHT="$(wc -l <"$book" | tr -d ' ')"
  fi
}

# Records a start in the start book, in place of an earlier one of the same worker.
start_record() { # start_record WORKER BUILD NOW
  local book="$SBX_SRV/start-times"
  (umask 077 && { grep -v -- "^$1"$'\t' "$book" 2>/dev/null || true; printf '%s\t%s\t%s\n' "$1" "$2" "$3"; } >"$book.tmp") &&
    mv -f "$book.tmp" "$book"
}

# Start what is wanted and installed; stop what is not wanted (the control plane leaves out a worker
# with live sandboxes). Readiness is the relay's attached record, never this report. Under a lock, so
# the build poll's pass and the --wanted-only one never start or stop the same worker at once; the
# one that does not get it skips (the other is applying the same wanted state). At most
# SBX_START_CONCURRENCY workers are starting at once (the start limit, see the header); a start is
# never waited on.
activation() {
  local wanted w b unit now has=0 slots queued=0 graced=0
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
  now="$(date +%s)"
  jq -r '.run[] | [.worker, .buildId] | @tsv' <<<"$wanted" >"$WORK/run.tsv"
  : >"$WORK/starting.ids"
  if jq -e '(.starting | type) == "array"' >/dev/null 2>&1 <<<"$wanted"; then
    has=1
    jq -r '.starting[] | strings' <<<"$wanted" >"$WORK/starting.ids"
  fi
  # The idle grace's builds: kept running, never started. Absent: none. The last
  # answer's list ($SBX_SRV/graced, 0600) says which stop ends a grace.
  jq -r 'if (.graced | type) == "array" then .graced[] | strings else empty end' <<<"$wanted" >"$WORK/graced.ids" 2>/dev/null ||
    : >"$WORK/graced.ids"
  if [[ -f "$SBX_SRV/graced" ]]; then cp "$SBX_SRV/graced" "$WORK/graced.prev"; else : >"$WORK/graced.prev"; fi
  (umask 077 && cat "$WORK/graced.ids" >"$SBX_SRV/graced.tmp") && mv -f "$SBX_SRV/graced.tmp" "$SBX_SRV/graced"
  # Stops first, so a slot (or the memory) a stopped worker frees is free before a start uses it.
  while IFS=$'\t' read -r w b; do
    [[ "$w" =~ $WORKER_RE ]] || { error 'a worker id to stop is malformed'; continue; }
    unit="sbx-worker@$w.service"
    systemctl is-active --quiet "$unit" || continue
    if systemctl stop "$unit"; then
      # A stop of a worker the idle grace kept is logged as such: a wanted build needed
      # its slot, its grace ended, or its build was released with stopNow.
      STOPPED=$((STOPPED + 1)); worker_report "$b" detached; say "{\"agent\":\"stopped\",\"worker\":\"$w\"$(! grep -qxF -- "$b" "$WORK/graced.prev" || printf ',"was":"graced"')}"
    else
      error "stop $unit failed"
    fi
  done < <(jq -r '.stop[] | [.worker, .buildId] | @tsv' <<<"$wanted")
  # The start book after the stops: a worker stopped just now is no longer starting.
  start_book "$now" "$has"
  slots=$((SBX_START_CONCURRENCY - INFLIGHT))
  while IFS=$'\t' read -r w b; do
    [[ "$w" =~ $WORKER_RE ]] || { error 'a wanted worker id is malformed'; continue; }
    unit="sbx-worker@$w.service"
    if [[ -s "$WORK/graced.ids" ]] && grep -qxF -- "$b" "$WORK/graced.ids"; then
      # A grace keeps a running worker; it never starts one (its unit stopped since the inventory).
      if systemctl is-active --quiet "$unit"; then graced=$((graced + 1)); fi
      continue
    fi
    if [[ ! -f "$SBX_ENV_DIR/workers/$w.env" ]]; then
      worker_report "$b" refused 'worker not installed on this host (install-host.sh with its setup.sh bundle)'
      say "{\"agent\":\"refused\",\"worker\":\"$w\",\"why\":\"not installed\"}"
      continue
    fi
    systemctl is-active --quiet "$unit" && continue
    # A build whose memory file does not match its guest size (memory_report) is never started here,
    # whatever the control plane asks (one older than openapi 1.12.0 does not read memfileMismatch).
    if [[ -s "$WORK/memfile-mismatch" ]] && grep -qxF -- "$b" "$WORK/memfile-mismatch"; then
      worker_report "$b" refused 'memfile mismatch: its memory file is not guest_ram_mb x 1 MiB on this host'
      say "{\"agent\":\"refused\",\"worker\":\"$w\",\"why\":\"memfile mismatch\"}"
      continue
    fi
    # The start limit: with no slot left, it waits for a later run (in order: it goes first then).
    if ((slots <= 0)); then
      queued=$((queued + 1))
      continue
    fi
    slots=$((slots - 1))
    # Returns at once (Type=simple): the worker reads its snapshot and attaches after this.
    if systemctl start "$unit"; then
      STARTED=$((STARTED + 1)); worker_report "$b" attached; say "{\"agent\":\"started\",\"worker\":\"$w\"}"
      [[ ! "$b" =~ $BUILD_ID_RE ]] || start_record "$w" "$b" "$now"
    else
      worker_report "$b" refused "systemctl start $unit failed"; error "start $unit failed"
    fi
  done <"$WORK/run.tsv"
  if ((queued > 0)); then
    START_SUMMARY=",\"startQueued\":$queued"
    say "{\"agent\":\"queued\",\"workers\":$queued,\"why\":\"$INFLIGHT starting, SBX_START_CONCURRENCY $SBX_START_CONCURRENCY: started in a later run\"}"
  fi
  ((graced == 0)) || GRACE_SUMMARY=",\"graced\":$graced"
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
  # control plane counts it as dropped in that sandbox's log. No field is added, removed or changed:
  # the values are kept, not the bytes, as jq decodes each MESSAGE and writes it out again (Go's
  # `\u003c` comes out as `<`); the control plane hashes its own serialization, so no digest changes.
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

# True when egress.cursor names an entry of moca-egress's journal: journalctl --cursor starts AT it,
# so the first entry it prints carries that very cursor. A cursor it cannot parse fails; one whose
# entry is gone (vacuumed, or another machine's) starts elsewhere, at the nearest entry or by time.
egress_cursor_ok() {
  local c first
  c="$(<"$SBX_SRV/egress.cursor")"
  first="$({ journalctl -u moca-egress.service -o json --all --no-pager --cursor "$c" 2>/dev/null || true; } |
    head -n 1 | jq -r '.__CURSOR // empty' 2>/dev/null)" || first=''
  [[ "$first" == "$c" ]]
}

# A stale cursor (see the header): kept aside, the step restarts from this boot, skipping what the
# position mark says was sent; without a mark, the re-send is an error line of its own.
egress_stale() {
  mv -f "$SBX_SRV/egress.cursor" "$SBX_SRV/egress.cursor.stale"
  error 'egress: the journal cursor is no longer valid; restarting from this boot (the old one is in egress.cursor.stale; entries rotated away before they were sent are lost)'
  if [[ -s "$SBX_SRV/egress.mark" ]]; then
    (umask 077 && : >"$SBX_SRV/egress.catchup")
  else
    error 'egress: no position mark: entries of this boot already sent are sent again, and the control plane stores them twice'
  fi
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
    error 'egress: the wanted state has no egressSids (a control plane older than openapi 1.14.0); nothing sent, the cursor kept'
    exec 8>&-
    return
  fi
  (umask 077 && jq -c '.egressSids' "$WORK/wanted.json" >"$sids")
  if [[ -f "$pending" ]]; then
    egress_post || { error "egress post failed: the cursor stays, the next run retries (HTTP $EG_CODE)"; exec 8>&-; return; }
  fi
  local rc mb mm skipped n_bad
  # A cursor whose entry is gone is not an error to journalctl (see the header): checked here first.
  [[ ! -s "$SBX_SRV/egress.cursor" ]] || egress_cursor_ok || egress_stale
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
        egress_stale
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

summary() { # summary [MORE]: MORE follows "errors" in the line (the egress counts)
  say "{\"agent\":\"summary\",\"claimed\":$CLAIMED,\"built\":$BUILT,\"failed\":$FAILED,\"started\":$STARTED,\"stopped\":$STOPPED,\"errors\":$ERRORS${1:-}$MEM_SUMMARY$START_SUMMARY$GRACE_SUMMARY}"
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
