#!/usr/bin/env bash
# Shared helpers for the P6 VM experiment drivers (E8, E9). Sourced, never executed.

ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  # shellcheck disable=SC2034  # read by the driver script that sources this file, not here
  FAIL=1
}

# Milliseconds since epoch, integer. Bash's own EPOCHREALTIME (seconds.microseconds, always
# 6 fractional digits, e.g. "1757622155.123456") rather than a python3 subprocess. vm_turn below
# no longer calls this at all -- it reads curl's own -w timing instead -- but the per-rung
# wall-clock timers in e8-density.sh and e9-tiers.sh still do, and a subprocess per call there is
# exactly the cost this part's B1 item exists to remove (see vm_turn's comment for the fuller
# story). If EPOCHREALTIME is ever unset (POSIX mode, an ancient bash), this prints garbage
# rather than failing loudly -- not a concern on the bash 5.x this repo already requires elsewhere.
now_ms() {
  local t="${EPOCHREALTIME/./}"
  printf '%s\n' "${t:0:-3}"
}

# p50/p95 from newline-separated integers on stdin. Nearest-rank, no interpolation — the same
# convention lib.sh's median uses, so E6 and E8 percentiles are comparable.
#
# Load-bearing coupling, written down rather than fixed (round 2, "one thing to write down"):
# on an all-failed rung this returns the literal string "NaN" (see the NR==0 branch below), which
# e8-density.sh passes to jq via --argjson; jq accepts NaN as a parser extension but serializes it
# back out as JSON null (confirmed: `jq -n --argjson p50 NaN '{p50:$p50}'` -> {"p50": null}), so
# a rung's p95Ms lands in POINTS (e8-density.sh) as JSON null. experiments/src/sharing.ts's
# detectKnee then evaluates `cur.p95Ms <= bound`, and in JS `null <= bound` coerces null to 0, so
# an all-failed rung's latency check passes as if it measured a PERFECT rung, not a missing one.
# The only thing stopping that from making an all-failed rung look healthy outright is
# detectKnee's OTHER half, the throughput check (an all-failed rung's throughput is 0, which
# fails `>= best` for any rung past c=1) — and the only thing keeping `bound` itself from being 0,
# which would make EVERY rung's latency check pass this way, is require_live_arm (this file)
# guaranteeing a non-empty c=1 sample. Three mechanisms in three different places, none aware of
# the others, currently balance to a safe result: today an all-failed rung's throughput (0) can
# never meet or beat a positive `best` (guaranteed positive by require_live_arm's c=1 floor), so
# the latency half's false "healthy" verdict is masked by the throughput half every time. See
# detectKnee's own comment (sharing.ts) for the other half of this — a future change to either
# file that stops guaranteeing one of those two things (e.g. a knee algorithm that no longer
# requires BOTH checks to pass, or a c=1 floor that no longer forbids ok_n=0) would surface this
# silently, not loudly.
percentile() {
  local p="$1"
  sort -n | awk -v p="$p" '{a[NR]=$1} END {
    if (NR==0) { print "NaN"; exit }
    i=int((p/100)*NR+0.9999); if (i<1) i=1; if (i>NR) i=NR; print a[i]
  }'
}

# One turn against the supervisor. Prints elapsed ms and the HTTP status, tab-separated, so the
# caller can separate "slow" from "refused" — conflating them is how a 429 storm reads as a knee.
#
# CURL_OPTS/CURL_HDR are read as globals here, the same way deploy/knative/lib.sh itself treats
# them (BASE/CURL_OPTS/CURL_HDR are globals there too, read at ~16 call sites) — this is that
# file's own convention, not a new one. It matters because e9-tiers.sh's Knative arm sources
# knative/lib.sh, which sets CURL_OPTS="-k..." whenever KSVC_URL is a Route (self-signed/ingress
# cert); without threading that through here, every Knative /turn request fails TLS verification,
# `|| echo 000` swallows it, and the arm reports a perfect floor for zero successful requests.
# e8-density.sh sources ONLY this file, never knative/lib.sh, so on that path CURL_OPTS/CURL_HDR
# are not merely empty, they are undeclared. `${CURL_OPTS:-}` and the `${CURL_HDR[@]+...}`
# existence test (lib.sh's own array guard) keep this safe under `set -u` either way. Against
# E8's plain http://127.0.0.1 target, CURL_OPTS is empty and CURL_HDR unset, so -k is simply
# absent and E8's request is byte-for-byte what it was before.
#
# B1 (final review fix, part 3): this used to call now_ms twice around the curl call -- three
# subprocesses per turn (python3, curl, python3), and at c=32 that is 32 concurrent chains of
# three spawns competing with the supervisor and its own workers for the same CPU the experiment
# is trying to measure. curl already times its own request, so one -w format now carries both the
# duration and the status code, and now_ms is gone from this function entirely.
#
# This is a measurement-boundary change, not just a speedup: curl's own %{time_total} excludes
# curl's own process startup (fork/exec, dynamic linking, TLS library init), where the old
# wall-clock measurement -- now_ms before spawning curl to now_ms after it exited -- included it.
# That is an improvement (the driver's own overhead should not be inside the number a rung
# reports), but it IS a change in what is measured, and whoever reads a knee number produced by
# this file deserves to know the two are not directly comparable to a pre-B1 run's numbers.
vm_turn() {
  local base="$1" sid="$2" body="$3" out ms code us
  # --max-time is LOAD-BEARING, and its absence cost a whole run. Without a deadline a turn the
  # server never answers blocks this curl forever, the rung's `wait` never returns, and the driver
  # hangs with no timeout at any level -- there is no rung deadline either. Observed: all four
  # supervisor workers exited simultaneously mid-rung (a Redis client leak, fixed separately), and
  # the four turns in flight on them simply never completed. The run sat at 874/960 for 19 minutes
  # until it was killed by hand, having reported nothing.
  #
  # A timeout converts that into data: curl exits 28, still emits its -w output with
  # %{http_code}=000 (the comment below verified exactly this case), so the turn is counted in
  # `attempts` but not in `ok_n` -- which drags the rung's success rate down and trips the 0.95
  # floor, i.e. the rung is correctly reported as not a capacity result instead of stalling.
  #
  # 60s default against a measured p95 of ~1.42s even at c=64 -- ~40x headroom, so it cannot clip a
  # legitimately slow turn, including spec §5.5's real-model gate. It bounds a pathological rung at
  # TURNS_PER_RUNG x 60s; a total hang at c=1 still fails fast, because require_live_arm rejects the
  # arm on the baseline rung before any taller one runs.
  # shellcheck disable=SC2086  # CURL_OPTS is intentionally word-split
  out="$(curl -s ${CURL_OPTS:-} --max-time "${V_TURN_TIMEOUT_S:-60}" \
    -o /dev/null -w '%{time_total}\t%{http_code}' -XPOST "$base/turn" \
    ${CURL_HDR[@]+"${CURL_HDR[@]}"} \
    -H 'content-type: application/json' -H "X-SH-Session-Id: $sid" -d "$body" || true)"
  # Verified empirically (connection-refused, DNS failure, --max-time timeout): curl still emits
  # its -w output on all three, with %{http_code}=000 and a real %{time_total} up to the failure,
  # so the `|| true` above exists only to stop `set -e` aborting the whole rung on one bad turn --
  # not, as the old `|| echo 000` was, to synthesize a fallback because curl printed nothing.
  ms="${out%%$'\t'*}"
  code="${out#*$'\t'}"
  # The empty-string defaults below guard the case where $out is truly empty (e.g. the curl
  # binary itself missing) -- NOT a malformed, non-empty, no-tab $out. If $out ever held some
  # non-empty string with no tab in it, both `${out%%$'\t'*}` and `${out#*$'\t'}` return $out
  # unchanged (neither pattern matches), so `ms` and `code` would both become that same non-empty
  # garbled string, not "" -- these defaults would not fire, and the arithmetic below would hard
  # error on a non-numeric $ms under `set -e`, aborting the run rather than silently recording a
  # wrong number. That is a real, undemonstrated gap (unlike the three failure modes verified
  # above, nothing here has been shown to actually produce a non-empty no-tab curl -w output),
  # named rather than fixed, per this file's own "fail loudly on a genuinely unmeasured case"
  # convention elsewhere (see e.g. worker_metrics' NaN fallback below).
  [ -n "$ms" ] || ms=0
  [ -n "$code" ] || code=000
  # Round to the nearest whole millisecond in pure bash arithmetic -- no awk subprocess (round 2,
  # item 6: this used to shell out to awk here, making vm_turn 2 subprocesses per turn, not the 1
  # task-3-report.md originally and wrongly claimed; see its round 2 addendum). curl's
  # %{time_total} is always S.FFFFFF -- exactly six fractional digits, confirmed against curl
  # 8.7.1 -- so stripping the "." turns it directly into a microsecond count as a decimal integer
  # (e.g. "0.001330" -> "0001330" -> 1330us = 1.330ms). `10#` forces base-10 parsing so a leading
  # zero (present on every sub-one-second turn, i.e. nearly always) is never misread as octal.
  # Adding 500us before the integer division rounds to the nearest ms rather than truncating --
  # matching the awk `%.0f` rounding this replaces. (The round 2 directive's own suggested
  # technique, `${d:0:-3}` with no rounding correction, truncates instead and would silently bias
  # every turn's latency down by up to just under 1ms; that suggestion was not used as-is.)
  us=$((10#${ms/./}))
  ms=$(( (us + 500) / 1000 ))
  printf '%s\t%s\n' "$ms" "$code"
}

# Event-loop lag p99 and RSS per worker, from the supervisor's loopback ADMIN listener (plan 1
# Task 11) — deliberately not the data port, which parses nothing per connection in the default
# leastInFlight mode and must keep it that way. Falls back to NaN rather than 0: a missing metric
# must be visibly missing in the record, because a 0 would read as "no lag" and would exonerate
# the tier that actually saturated.
worker_metrics() {
  local base="${1:-$METRICS_BASE}"
  # -f: curl itself fails (rather than returning the error body as if it were a metrics
  # payload) on a non-2xx response. Piped through `jq -c .` to validate the body actually
  # parses as JSON before it reaches a caller — a base pointed at the DATA port (which parses
  # nothing per connection in leastInFlight mode, see the comment above) rather than the admin
  # port would otherwise hand a caller plain text/HTML, which used to reach jq downstream (in
  # the caller) and abort the whole run under `set -e`. Either failure mode falls back to '{}',
  # matching the same "missing metric reads NaN, not 0" contract this function already documents.
  curl -sf --max-time 5 "$base/metrics" 2>/dev/null | jq -c . 2>/dev/null || echo '{}'
}

# Cumulative CPU seconds consumed by the sandbox pool since its containers booted — the `bash -c`
# churn term in §5.2, and the input the capacity arm's utilisation ceiling is computed from (§5.2,
# issue #254 item 2b). Callers difference two samples across a rung.
#
# THREE DEFECTS FIXED HERE, all of which produced a number that read fine.
#
# 1. IT WAS A PERCENTAGE. This used to sum `--format '{{.CPU}}'`, which podman documents as CPU
#    PERCENT and which is instantaneous, then e8-density.sh differenced two samples per rung. A
#    difference of two instantaneous percentages is not a CPU delta at all: it has the wrong units,
#    no time base, and it can be negative. Verified against podman 5.x:
#      {{.CPU}}     -> 1.071428524872072      (percent, right now)
#      {{.CPUNano}} -> 4596421884000          (cumulative ns; matches that container's cpu_time
#                                              field of 1h16m36.42s, i.e. 4596.42 s)
#    Only the cumulative field can be differenced, so that is what this reads. The old field name in
#    the record (`sandbox_cpu`) stayed the same while its meaning was wrong, which is why the ceiling
#    could not be built on it until this changed.
#
# 2. IT SUMMED EVERY CONTAINER ON THE BOX. setup-vm.sh runs Redis, the relay and the model stub under
#    the same podman as the sandboxes, so a field named `sandbox_cpu` was charging the sandbox tier
#    for all of them. Now filtered to the `sh-sandbox-` names setup-vm.sh creates.
#
# 3. A TIER IT COULD NOT MEASURE READ AS AN IDLE ONE. `awk '{s+=$1} END {printf "%.2f", s+0}'`
#    prints "0.00" for empty input, so no podman (or, far more likely, an OFF-BOX generator, which
#    EXPERIMENTS.md's own guidance requires) produced a confident zero. Under a utilisation CEILING
#    that zero is the single most dangerous reading available: it passes the gate vacuously, and the
#    run it lets through is exactly the one the gate exists to refuse. It now reads NaN, matching
#    load1/worker_metrics' "a missing metric reads NaN, never 0" contract, and assert_sandbox_ceiling
#    refuses on NaN rather than treating it as headroom.
#
# V_SANDBOX_CPU_CMD is the off-box seam, and its contract is exact because a wrong unit here is
# invisible: print one or more lines, each a bare number of cumulative sandbox CPU **SECONDS**, which
# are summed. Nanoseconds would over-report by 1e9 and no sanity check can catch that (there is no
# plausible upper bound on cumulative CPU), so the conversion belongs in the hook. A complete example:
#
#   V_SANDBOX_CPU_CMD='ssh target sudo podman stats --no-stream --format "{{.Name}} {{.CPUNano}}" \
#     | awk "\$1 ~ /^sh-sandbox-/ {s += \$2} END {printf \"%.2f\", s / 1e9}"'
#
# Set it and this function trusts the number; a hook that fails, or prints nothing numeric, reads NaN
# rather than 0 — which the capacity arm refuses on rather than treating as an idle tier.
# The container runtime's output is captured into a variable BEFORE being parsed, rather than piped
# straight into awk. Both callers run under the drivers' `set -euo pipefail`, and a pipeline's status
# under `pipefail` is the first non-zero in it: with no podman (or a podman that errors), the pipeline
# returns podman's status even though awk succeeded, and `CPU0="$(sandbox_cpu_seconds)"` — a plain
# assignment — then aborts the whole driver under `set -e`. Observed exactly that: the run died at
# `-- rung c=1` with exit 127 and NO message, in place of the refusal this function's NaN exists to
# trigger. So a missing runtime must leave this function's own exit status at 0 and let the NaN do the
# talking; `|| true` on the capture is what makes that true.
sandbox_cpu_seconds() {
  local out
  if [ -n "${V_SANDBOX_CPU_CMD:-}" ]; then
    out="$(eval "$V_SANDBOX_CPU_CMD" 2>/dev/null)" || out=""
    printf '%s\n' "$out" | awk 'NF && $1+0==$1 {s+=$1; n++} END {if (n) printf "%.2f\n", s; else print "NaN"}'
    return 0
  fi
  # `{{.Name}} {{.CPUNano}}`, filtered by name: a sandbox is what setup-vm.sh named `sh-sandbox-N`.
  out="$(podman stats --no-stream --format '{{.Name}} {{.CPUNano}}' 2>/dev/null || true)"
  printf '%s\n' "$out" |
    awk '$1 ~ /^sh-sandbox-/ && $2+0==$2 {s+=$2; n++} END {if (n) printf "%.2f\n", s/1e9; else print "NaN"}'
}

# Cumulative CPU seconds across the WORKER tier, from the supervisor's own /metrics — the worker-side
# counterpart to sandbox_cpu_seconds (§5.2's per-turn worker CPU, issue #254 item 2e). Summed across
# workers because the rung's denominator (turns served) is pool-wide; the per-worker readings travel
# separately in the record, where their ASYMMETRY is the finding (one hot worker is a routing problem,
# four equally busy ones are a full tier).
#
# NaN, never 0, when no worker has reported: on a build whose /metrics predates `cpu_seconds` every
# field is absent, and a 0 there would compute a per-turn worker CPU of zero and read as "the worker
# tier did no work" — which would attribute a knee away from the very tier this metric exists to
# attribute it to.
# Captured-then-parsed for the same `pipefail` reason as sandbox_cpu_seconds above: this must never
# hand its caller a non-zero status, because the caller assigns it in a command substitution and would
# abort the run instead of recording the NaN.
worker_cpu_seconds() {
  local base="${1:-$METRICS_BASE}" body out
  body="$(worker_metrics "$base" || true)"
  out="$(printf '%s' "$body" |
    jq -r '[.workers[]?.cpu_seconds | numbers] | if length == 0 then "NaN" else (add | tostring) end' 2>/dev/null || true)"
  [ -n "$out" ] && printf '%s\n' "$out" || printf 'NaN\n'
}

# b - a for two cumulative CPU readings, propagating NaN rather than inventing a number. Both
# endpoints must be real: an unmeasurable start or end makes the delta unmeasurable, and the one thing
# it must never silently become is 0 (see sandbox_cpu_seconds' defect 3 above — under a utilisation
# ceiling a confident zero is the reading that lets the bad run through).
#
# A NEGATIVE delta is also NaN, not a small number: cumulative counters only go up, so a decrease means
# the pool changed under the rung (a container replaced, a worker restarted and its CPU clock reset to
# zero), and the rung's own arithmetic no longer describes one continuous set of processes.
cpu_delta() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    num = "^-?[0-9]+([.][0-9]+)?$"
    if (a !~ num || b !~ num || b < a) { print "NaN"; exit }
    printf "%.2f\n", b - a
  }'
}

# Cumulative NON-IDLE CPU seconds for the TARGET host, all processes and kernel time included.
#
# Why this exists, measured: at 395 turns/s the capacity arm reported `worker_cpu_util` 52% of an 8-core
# target and `bound=unattributed`, while `top` on that target showed **0.9% idle** — 74.6% user, 21.2%
# system, 3.3% softirq. Doubling SH_WORKERS moved the ceiling not at all (395 -> 371 turns/s), which is
# the signature of a machine that is already full rather than a tier that is. The worker processes
# accounted for only about two thirds of it; the rest was the supervisor hand-off loop, the relay,
# Redis, the stub, sixteen sandbox leaves, and the kernel doing 400 connections a second.
#
# So a worker-tier figure cannot answer "did the box run out", and a run that only has one will keep
# reporting `unattributed` for the most basic bound there is. This is that missing denominator.
#
# V_HOST_CPU_CMD is the off-box seam, same contract as V_SANDBOX_CPU_CMD: print cumulative non-idle CPU
# SECONDS for the target as one bare number. On-box, /proc/stat is read directly. NaN when neither is
# available — never 0, which would read as an idle machine.
#
# /proc/stat's first line is jiffies since boot: user nice system idle iowait irq softirq steal ...
# Non-idle is everything except idle and iowait (iowait is not CPU spent). USER_HZ is 100 on Linux.
host_cpu_seconds() {
  local out
  if [ -n "${V_HOST_CPU_CMD:-}" ]; then
    out="$(eval "$V_HOST_CPU_CMD" 2>/dev/null)" || out=""
    printf '%s\n' "$out" | awk 'NF && $1+0==$1 {print; found=1; exit} END {if (!found) print "NaN"}'
    return 0
  fi
  [ -r /proc/stat ] || {
    printf 'NaN\n'
    return 0
  }
  awk '/^cpu /{
    total = 0
    for (i = 2; i <= NF; i++) total += $i
    nonidle = total - $5 - $6
    printf "%.2f\n", nonidle / 100
    exit
  }' /proc/stat
}

# Tier utilisation as a PERCENTAGE, measured: cpu_seconds / (wall_seconds x units). Used for both
# tiers, which is why it is not named for either — the sandbox tier's units are CONTAINERS (one
# container is one "sandbox-equivalent", the quantity §2.3's duty is expressed against, so this
# reproduces the findings' own arithmetic: 2.35 sandbox-equivalents busy out of 3 = 78%, from measured
# CPU rather than from a duty the capacity arm deliberately does not have).
#
# THE WORKER TIER'S UNITS ARE WORKERS, NOT CORES, and getting that wrong hides a saturated tier.
# Measured on hardware (W=4 on an 8-core target, capacity arm at c=128): 10.2 ms of worker CPU per turn
# at 402 turns/s = 4.1 cores busy, which reads as 51% of the box and 102% of the four cores four
# single-threaded event loops can actually occupy. Throughput plateaued and p99 loop lag rose 6.7x at
# that rung, i.e. the tier WAS full — while a box-normalised figure sat at half, below any sane
# threshold. An 80%-of-box threshold is unreachable by construction whenever W < cores. So the driver
# records BOTH: utilisation of the tier's own ceiling (min(W, cores) — a worker cannot use more than one
# core, and W workers cannot use more cores than the box has) for ATTRIBUTION, and utilisation of the
# box for SIZING.
#
# Any unmeasurable input yields NaN, never a number: a NaN in the numerator (no podman, off-box, a
# failed hook) must not silently become 0% headroom, and a zero wall time or container count has no
# utilisation to report. assert_sandbox_ceiling treats NaN as a refusal.
#
# The numeric test is a REGEX over the raw string, not `x+0 == x`. awk's number conversion goes
# through strtod, which parses "NaN" (and "nan", "inf", "-inf") as an actual IEEE value: with
# c="NaN", `c+0 != c` compares nan against the string "NaN" and does not reliably reject it —
# verified, it printed "nan" as the utilisation, i.e. the unmeasured case leaked through the guard
# wearing a lowercase disguise. Matching digits explicitly is the only test that cannot be fooled by
# a value strtod happens to understand.
cpu_utilisation() {
  local delta="$1" wall_ms="$2" units="$3"
  awk -v c="$delta" -v w="$wall_ms" -v k="$units" 'BEGIN {
    num = "^-?[0-9]+([.][0-9]+)?$"
    if (c !~ num || w !~ num || k !~ num) { print "NaN"; exit }
    if (w <= 0 || k <= 0 || c < 0) { print "NaN"; exit }
    printf "%.1f\n", 100 * c / ((w / 1000) * k)
  }'
}

# The CAPACITY arm's precondition, and it points the OPPOSITE way to the realism arm's pool floor
# (duty_basis_sandbox_floor): that one demands ENOUGH sandboxes for the duty, this one demands the
# sandbox tier be doing almost NOTHING, so the CPU under measurement belongs to the worker tier and
# the tail does not belong to queueing at a shared downstream with few servers.
#
# Refusal, not a warning. The published calibrated run sat at 78% sandbox utilisation at its top
# rung (2.35 sandbox-equivalents of 3, from duty 0.0735 x c=32); its p50 was flat within 9 ms and
# its worker loop lag flat while p95 rose 1.59x, which is the signature of that queueing rather than
# of worker saturation. A capacity arm allowed to run there produces precisely the number this arm
# exists to stop producing, so it must fail loudly instead of proceeding.
#
# Args: $1 = measured utilisation percent (or NaN), $2 = ceiling percent, $3 = a label naming the rung.
assert_sandbox_ceiling() {
  local util="$1" ceiling="$2" label="${3:-this rung}"
  case "$util" in
  '' | NaN | null)
    ko "capacity arm at $label: sandbox utilisation is UNMEASURED, so the ceiling cannot be checked and must not be assumed clear. podman is not visible from this generator (the off-box case EXPERIMENTS.md requires): set V_SANDBOX_CPU_CMD to a command printing the target's cumulative sandbox CPU seconds" >&2
    exit 1
    ;;
  esac
  awk -v u="$util" -v c="$ceiling" 'BEGIN { exit !(u <= c) }' || {
    ko "capacity arm at $label: measured sandbox utilisation ${util}% exceeds the ${ceiling}% ceiling — the sandbox tier is both competing for the CPU under measurement and queueing turns behind too few servers, so this rung's tail is the sandbox tier's, not the worker tier's. Use the trivial-exec workload (ARM=capacity ./prepare-workload.sh) or add containers" >&2
    exit 1
  }
  ok "capacity arm at $label: sandbox utilisation ${util}% is within the ${ceiling}% ceiling"
}

# An arm cannot be LABELLED one thing while MEASURING the other's stub profile.
#
# assert_stub_pinned above refuses a supervisor pointed at a different stub than the driver reads;
# this is the same fabrication path one level in — the right stub, running the wrong profile. It
# matters because ~1.42 s of the calibrated run's 1.537 s turn was the stub's own programmed wait
# (300/12/64): an in-flight turn is mostly a sleeping promise costing single-digit ms of CPU, so at
# that profile the box cannot be filled at any concurrency the admission cap permits, and a
# "capacity" arm run against it reports the stub's latency as the harness's ceiling.
#
# Symmetric, deliberately: a realism arm against the fast profile is equally wrong, because its
# density figure would name a model tier it never measured. Both directions turn on the same two
# thresholds, so there is one definition of "fast" in the tree rather than two that can drift.
#
# toolCallRate is checked in BOTH arms: §5.4's requirement that the rate is not optional has no arm.
# A stub that streams only text means no session ever reaches a sandbox, and a capacity arm's exec is
# the whole point of keeping one exec per turn — its plumbing is the harness work being measured.
#
# Args: $1 = arm, $2 = the stub's own /profile JSON, $3 = max ttft ms, $4 = max token delay ms.
assert_arm_stub_profile() {
  local arm="$1" profile="$2" max_ttft="$3" max_delay="$4" ttft delay rate fast
  ttft="$(printf '%s' "$profile" | jq -r '.ttftMs')"
  delay="$(printf '%s' "$profile" | jq -r '.tokenDelayMs')"
  rate="$(printf '%s' "$profile" | jq -r '.toolCallRate')"
  # Every comparison below is guarded by an explicit digit test FIRST, because awk compares two
  # non-numeric operands as STRINGS: `jq -r` renders a missing field as the literal `null`, and
  # `"null" > "0"` is true, so a profile with no toolCallRate at all used to pass this gate — the same
  # strtod/string hazard cpu_utilisation above documents, one function later. A field this function
  # cannot read is a refusal, not a pass; stub_profile's own four-field validation normally catches it
  # first, but this function is called directly by tests and must not depend on that.
  local num_re='^-?[0-9]+([.][0-9]+)?$'
  for v in "ttftMs=$ttft" "tokenDelayMs=$delay" "toolCallRate=$rate"; do
    [[ ${v#*=} =~ $num_re ]] || {
      ko "$arm arm: the stub profile field ${v%%=*} reads '${v#*=}', which is not a number, so this arm cannot be verified against its own profile: $profile" >&2
      exit 1
    }
  done
  awk -v r="$rate" 'BEGIN { exit !(r + 0 > 0) }' || {
    ko "$arm arm: the stub reports toolCallRate=$rate, so no session ever reaches a sandbox and the hands tier is absent from this run entirely (§5.4). Start the stub with a non-zero SH_STUB_TOOL_CALL_RATE (0.5 yields one tool call per turn; 1.0 is an infinite tool loop)" >&2
    exit 1
  }
  fast=no
  awk -v t="$ttft" -v d="$delay" -v mt="$max_ttft" -v md="$max_delay" \
    'BEGIN { exit !(t + 0 <= mt + 0 && d + 0 <= md + 0) }' && fast=yes
  case "$arm" in
  capacity)
    [ "$fast" = yes ] || {
      ko "capacity arm: the stub's own /profile reports ttft=${ttft}ms tokenDelay=${delay}ms, which is not a fast profile (ceiling ttft<=${max_ttft}ms tokenDelay<=${max_delay}ms). Most of each turn would be the stub's programmed wait, so the ladder would measure how well the harness hides a fixed sleep and top out at the admission cap. Restart the stub fast, or run V_ARM=realism" >&2
      exit 1
    }
    ok "capacity arm: stub profile is fast (ttft=${ttft}ms tokenDelay=${delay}ms), so turn duration approximates the harness's own cost"
    ;;
  realism)
    # PINNED to a declared profile, not merely "slower than the capacity ceiling". Asserting only
    # `fast = no` accepted ttft=50/delay=5 -- and, before the numeric guard above, an EMPTY profile,
    # which it then cheerfully announced as "the calibrated one (ttft=nullms)". §5.2's table names this
    # arm model tier as 300/12/64, so that is what the driver verifies. V_REALISM_* exists for a
    # deliberate second profile point; either way the profile actually run is what lands in the record.
    local want_ttft="${V_REALISM_TTFT_MS:-300}" want_delay="${V_REALISM_TOKEN_DELAY_MS:-12}"
    awk -v t="$ttft" -v d="$delay" -v wt="$want_ttft" -v wd="$want_delay" \
      'BEGIN { exit !(t + 0 == wt + 0 && d + 0 == wd + 0) }' || {
      ko "realism arm: the stub own /profile reports ttft=${ttft}ms tokenDelay=${delay}ms, but this arm is pinned to ttft=${want_ttft}ms tokenDelay=${want_delay}ms (§5.2). A deployable density figure must be measured against the model tier it names, or it describes a model nobody deploys. Restart the stub at the pinned profile, set V_REALISM_TTFT_MS/V_REALISM_TOKEN_DELAY_MS if this run deliberately uses another, or run V_ARM=capacity" >&2
      exit 1
    }
    ok "realism arm: stub profile is the pinned one (ttft=${ttft}ms tokenDelay=${delay}ms)"
    ;;
  *)
    ko "unknown arm '$arm': §5.2 defines exactly two, capacity and realism" >&2
    exit 1
    ;;
  esac
}

# The capacity arm's OTHER precondition: neither cap may be what the ladder finds.
#
# Both halves are evidenced. Two zero-duty runs swept to c=64 with p95 flat within 6 ms and reported
# `bound=not-observed`, because the admission cap `W x S` WAS the top rung — a config choice
# masquerading as a result. And the same ladder with the shipped `KAGENTI_SANDBOX_CAP=4` produced
# exactly 360 successes at two consecutive rungs (12 leases x 30 turns) with throughput pinned at
# 10.4/s: a run that measured the lease pool, and one that would have been published as a VM density
# figure had the 0.95 success-rate floor not caught it downstream.
#
# So the caps stop being the variable: both must clear the ladder's top rung by $4 (default 2x). This
# is not the W/S sweep that was vetoed — that veto held because the cap bound and nothing else could
# saturate, so another sweep bought another honest `not-observed`. Here the cap is moved out of the
# way and OFFERED CONCURRENCY is what sweeps.
#
# The two halves are checked at different TIMES, which is why $3 accepts "unknown". The admission cap
# is known from the environment before anything runs; the lease pool's size does not exist until a
# turn has leased (see check_sandbox_floor), so the caller passes "unknown" pre-ladder and calls again
# with the real number once the c=1 rung has been served. A deferred half says so out loud rather than
# being quietly skipped or, worse, passed a placeholder that always clears.
#
# Args: $1 = top rung c, $2 = admitted (W x S), $3 = concurrent leases available (pool x cap) or
#       "unknown" to defer that half, $4 = required headroom multiple.
assert_capacity_headroom() {
  local top="$1" admitted="$2" leases="$3" x="${4:-2}"
  awk -v t="$top" -v a="$admitted" -v x="$x" 'BEGIN { exit !(a >= t * x) }' || {
    ko "capacity arm: the admission cap W x S = $admitted is not ${x}x the ladder's top rung ($top), so a knee found here would be the CAP, not the machine — raise SH_WORKERS x SH_TURNS_PER_WORKER well past the expected knee (several hundred admitted) and sweep offered concurrency instead" >&2
    exit 1
  }
  case "$leases" in
  unknown | '' | NaN)
    ok "capacity arm: $admitted admitted clears the top rung ($top) by ${x}x; the lease-cap half is deferred until the pool has been observed"
    return 0
    ;;
  esac
  awk -v t="$top" -v l="$leases" -v x="$x" 'BEGIN { exit !(l >= t * x) }' || {
    ko "capacity arm: only $leases concurrent leases are available (sandbox pool x KAGENTI_SANDBOX_CAP) against a top rung of $top — leases would become the new artificial cap, the exact confusion the utilisation ceiling guards against. Raise KAGENTI_SANDBOX_CAP (deploy/vm/env/supervisor.env.example) or add containers" >&2
    exit 1
  }
  ok "capacity arm: $admitted admitted and $leases concurrent leases both clear the top rung ($top) by ${x}x, so neither cap can be this ladder's knee"
}

# tsx is a devDependency of experiments/ only, never root-hoisted, and deploy/ is not a
# workspace package -- `npx tsx` from either driver's CWD walks upward through node_modules,
# finds nothing, and either hard-fails offline or silently runs an unpinned fetched copy online
# (deploy/vm/systemd/sh-supervisor.service documents this exact bug class already hit once).
# Calling the workspace's own shim directly keeps resolution CWD-independent while leaving the
# driver's CWD, and therefore its import specifiers, unchanged.
TSX="../../experiments/node_modules/.bin/tsx"

# Same shape as require_build's preflight in setup-vm.sh: fail loudly and name the exact
# remediation rather than let a heredoc die later with ERR_MODULE_NOT_FOUND. Callers invoke this
# AFTER their own live gate, so a V_LIVE=0 run SKIPs and exits 0 without ever testing for tsx.
require_tsx() {
  [ -x "$TSX" ] || {
    echo "workspace is not built: $TSX is not executable (pnpm install has not run)" >&2
    echo "run: pnpm install" >&2
    exit 1
  }
}

# Dead-arm guard, shared by e8-density.sh and e9-tiers.sh (originally e9-tiers.sh-only; lifted
# here so no third caller can omit it by omission). Fires when an arm's c=1 baseline rung sees
# ZERO successful (200) responses. Without this, detectKnee (experiments/src/sharing.ts) seeds
# `best` from the c=1 throughput; if that throughput is 0, `cur.throughput >= best` is `0 >= 0`,
# trivially true forever, so a dead arm reports the ladder's TOP rung as a clean "floor" instead
# of erroring. Must fire regardless of *why* c=1 saw no 200s — wrong URL, expired cert, firewall,
# crashed revision, a dead supervisor that still answers /health — because none of those reasons
# make the resulting number less fabricated.
#
# Callers must do any of their OWN cleanup (e.g. removing a function-local work dir) BEFORE
# calling this: on a dead arm it calls `exit 1` rather than returning, so nothing after the call
# in the caller ever runs. `ko` (defined above) echoes to stdout by design — normally read by
# callers via `grep -q`, not captured — so callers whose stdout IS their return channel (e.g.
# e9-tiers.sh's run_arm, which prints a JSON points array to stdout for its caller to capture)
# must not let this function's message leak into that channel; hence the explicit >&2 here.
#
# Args: $1 = the rung's c (only fires when this is 1, the baseline rung); $2 = the success
# (200) count observed at that rung; $3 = a label naming the arm; $4 = the arm's base URL.
require_live_arm() {
  local rung="$1" ok_n="$2" label="$3" base="$4"
  [ "$rung" -eq 1 ] && [ "$ok_n" -eq 0 ] || return 0
  ko "$label arm: ZERO 200 responses at c=1 ($base) — refusing to run the ladder against an arm that never answered" >&2
  exit 1
}

# Fetches /profile from the model stub actually driving this run and prints it as JSON on
# stdout: {ttftMs, tokenDelayMs, outputTokens, toolCallRate}. Final review fix, part 3, item A:
# the stub is a separate long-lived process, configured by its OWN env at its OWN boot, so a
# driver's SH_STUB_* environment has no causal connection to what that process is actually doing
# — this is the only source of truth for the §5.7 claim sentence, which must quote what came
# back from here, never what the driver's own environment says.
#
# Unreachable (or a non-JSON body) is a HARD failure, not a fallback to a default — the same
# principle as require_live_arm above: a run whose profile cannot be established is not a
# result, and failing loudly here is cheaper than publishing a claim about load nobody verified.
# Shared by e8-density.sh and e9-tiers.sh so neither driver can drift onto reading its own
# environment again by omission.
stub_profile() {
  local url="$1" body
  body="$(curl -sf --max-time 5 "$url/profile" 2>/dev/null)" || {
    ko "stub profile unreachable at $url/profile — refusing to publish a load claim nobody verified" >&2
    exit 1
  }
  # Final review fix, round 2, item 3 (BLOCKING, C4 Path B): `jq -e '.'` only asserted the body
  # parses as JSON — it accepts `{}`, `[]`, `null`, or `{"unrelated":"key"}` just as happily as a
  # real profile. Consequences confirmed by the re-review: E8 would then publish
  # `ttft=nullms tokenDelay=nullms tokens=null toolRate=null` into the §5.7 claim sentence and
  # into EXPERIMENTS.md — a profile the stub never reported, via a path where the FETCH
  # succeeded, so nothing upstream of this function had any reason to suspect trouble. Worse in
  # E9: two stub endpoints that both merely answer `{}` compare byte-for-byte EQUAL as JSON text,
  # so PIN 1's diff check (this file's caller) passes and the run record claims the two stubs are
  # "verified to be running the identical resolved profile" when neither ever reported one.
  #
  # Fix: assert the four keys this profile shape requires are present AND are all numbers — not
  # merely "the body parses", but "the body IS a profile". `has(...)` catches a missing key;
  # `map(type=="number")|all` over the four NAMED fields (not `[.[]|numbers]|length==4` over the
  # whole object) catches a key present with the wrong type. Named fields, deliberately, not a
  # whole-object count: an object with all four correct fields PLUS an unrelated fifth numeric key
  # would pass a real profile check but fail `[.[]|numbers]|length==4` (that expression counts
  # every numeric value in the object, not just these four, so a fifth number make it 5, not 4) —
  # a false rejection this rewrite avoids by naming exactly the fields this shape requires.
  # Failing with the parsed body (not just "invalid") names exactly which field(s) are missing or
  # wrong-typed, the same "name what broke" convention this file's other hard failures follow.
  printf '%s' "$body" | jq -e \
    'has("ttftMs") and has("tokenDelayMs") and has("outputTokens") and has("toolCallRate")
       and ([.ttftMs, .tokenDelayMs, .outputTokens, .toolCallRate] | map(type=="number") | all)' \
    >/dev/null 2>&1 || {
    ko "stub profile at $url/profile is not a real profile (missing one of ttftMs/tokenDelayMs/outputTokens/toolCallRate, or one is not a number): $body" >&2
    exit 1
  }
  printf '%s\n' "$body"
}

# Final review fix, round 2, item 2 (BLOCKING, C4 Path A): ties a driver's own *_STUB_URL to
# what the supervisor's OWN /metrics reports its ANTHROPIC_BASE_URL actually is. Without this,
# an operator can start stub A with toolRate=0.07, point the supervisor at stub B with
# toolRate=0, and set the driver's *_STUB_URL to A: stub_profile above fetches A's /profile
# successfully, every gate passes, and the driver publishes A's ttft/tokenDelay/tokens/toolRate
# into a §5.7 claim for a run where no session ever reached a sandbox. e8-density.sh's own
# comment named this exact risk ("or, worse, quietly succeed against some OTHER stub, which is
# precisely the fabrication path this item exists to close") without closing it — this closes it.
#
# Lifted from e9-tiers.sh's existing PIN 1 verification (the ANTHROPIC_BASE_URL equality check
# only, not its SH_REMOTE_SANDBOX/SH_SANDBOX_DISCOVERY checks, which are E9's own PIN 2 tool-tier
# concern and stay inline there) — this is the second-caller pattern again: stub_profile was
# shared from the start, the check that makes its fetch CAUSAL rather than nominal was not.
# e9-tiers.sh's own inline check is deliberately left as-is rather than rewired through this
# function: it already batches three diagnostics (this one plus SH_REMOTE_SANDBOX and
# SH_SANDBOX_DISCOVERY) and reports all three before exiting once at the end, and this function's
# hard-exit-on-first-mismatch behaviour (matching require_live_arm/stub_profile's convention
# above) would silently regress that batching for E9's mismatched-on-two-things case — a
# diagnostic-completeness regression the directive that asked for this function did not ask for.
# E8 has only this one check to make, so the simpler hard-exit shape fits it directly.
#
# Exact match via jq -e, not a substring grep — same reasoning as stub_profile's caller-facing
# comments elsewhere: a substring match would also pass on a URL that merely CONTAINS stub_url
# (a stray query string, or a decoy host sharing a suffix), weaker than the equality this
# assertion exists to provide. Hard failure (exit 1), not a WARN: an unpinned stub is not a
# degraded result, it is not a result at all — same principle as stub_profile and
# require_live_arm above.
assert_stub_pinned() {
  local metrics_base="$1" stub_url="$2" label="${3:-supervisor}" env_json
  env_json="$(curl -sf --max-time 5 "$metrics_base/metrics" 2>/dev/null | jq -r '.env // {} | @json' 2>/dev/null)" || env_json=""
  if [ -z "$env_json" ] || [ "$env_json" = "{}" ]; then
    ko "$label's /metrics at $metrics_base did not return a usable env object — cannot verify ANTHROPIC_BASE_URL is pinned to $stub_url" >&2
    exit 1
  fi
  printf '%s' "$env_json" | jq -e --arg u "$stub_url" '.ANTHROPIC_BASE_URL == $u' >/dev/null 2>&1 || {
    ko "$label's /metrics does not show ANTHROPIC_BASE_URL=$stub_url exactly — refusing to publish a load claim for a stub the supervisor is not actually pointed at" >&2
    exit 1
  }
}

# Final review fix, part 3, item B2: where did the generator (this script) actually run,
# relative to the arm base URL it is about to drive? Derived, not declared: a flag someone sets
# can be wrong or stale in a way a loopback address cannot, because curl can only reach
# 127.0.0.1/localhost/::1 when the caller and the callee share a machine — that address IS the
# on-box proof, not merely a claim about it.
#
# Final review fix, round 2, item 4a: the original version of this function labelled every
# non-loopback base "off-box", on the reasoning that "this driver could not have reached that
# base URL without leaving the box, so leaving the box is what it did". That reasoning is wrong,
# and the re-review caught it: a box can also address itself by its own ROUTABLE address (its
# real interface IP, or a DNS name that happens to resolve back to it), not only by loopback --
# e.g. an E9 VM arm run with VM_BASE set to the VM's own 10.0.0.5 rather than 127.0.0.1 is still
# on-box, but the old code printed "off-box" for it with exactly the same unearned confidence
# loopback deserves and this one does not.
#
# Fix chosen (of the directive's two options -- rename to "undetermined", or resolve-and-compare
# host addresses): rename. Resolve-and-compare was considered and rejected FOR NOW: this driver's
# production target is the Linux VM (setup-vm.sh already requires getent/systemctl/podman, all
# Linux-only), but its test suite runs locally on macOS, and reliably resolving "is this base
# URL's host one of MY interface addresses" portably across both -- IPv6, containers, NAT'd
# interfaces, a hostname resolving to multiple A/AAAA records -- is exactly the kind of
# proof-shaped mechanism that, done carelessly, introduces a NEW false-confidence claim of the
# same species this item exists to remove. "undetermined" costs nothing and claims nothing it
# cannot back up; a real resolve-and-compare implementation is future work if the "off-box, on
# the same subnet" runs EXPERIMENTS.md already calls authoritative (see its "Where the generator
# ran" section) turn out to need the distinction sharpened further than on-box/undetermined gives.
# Recorded once per run, per arm (not per rung — placement does not change mid-ladder).
generator_placement() {
  local base="$1"
  case "$base" in
  *127.0.0.1* | *localhost* | *://\[::1\]* | *://::1*) echo "on-box" ;;
  *) echo "undetermined" ;;
  esac
}

# Final review fix, part 3, item B3: a per-rung contention indicator. The 1-minute load average
# (`uptime`) is the cheapest honest proxy available without adding a new dependency: it reflects
# everything else competing for this box's CPU while the rung ran, not just this driver's own
# curl calls or the supervisor's own workers. It is deliberately labelled `contention_load1`
# rather than something that implies precision or attribution to one process — it is a proxy for
# "how busy was this box overall", not a measurement scoped to the generator or the arm alone, and
# the point is exactly that: a co-located generator run that drives its own supervisor's load
# average up during a high-c rung will show it here, so that run cannot silently masquerade as a
# clean one just because throughput and the (failure-filtered) p95 still look healthy. `uptime`'s
# output differs cosmetically between Linux (comma-separated, "load average:") and macOS/BSD
# (space-separated, "load averages:") — the regex/awk below normalises both; the FIRST of the
# three trailing numbers is always the 1-minute average on both platforms. Falls back to "NaN",
# not "0", on any failure — same "missing metric reads NaN" contract worker_metrics already uses
# above, because a 0 would read as "no contention" and would exonerate a box that was actually busy.
load1() {
  local v
  v="$(uptime 2>/dev/null | sed -E 's/.*load average[s]?: *//' | awk -F'[, ]+' '{print $1}')"
  [ -n "$v" ] && printf '%s\n' "$v" || printf 'NaN\n'
}

# Final review fix, round 2, item 4b: `contention_load1` on its own is not comparable across
# boxes -- a load average of 4 means "saturated" on a 2-core box and "mostly idle" on a 16-core
# one, and neither e8-density.sh nor e9-tiers.sh recorded which box (or boxes, for E9's two arms)
# a given run's numbers came from. Recorded once per run (core counts do not change mid-ladder,
# same rationale as generator_placement above), not per rung, so a reader normalising
# `contention_load1` later (load1 / cores, a rough utilization fraction) has the denominator
# without having to go ask whoever ran it. `nproc` (Linux, always present alongside the
# systemctl/podman/getent this repo's setup-vm.sh already requires) first; `sysctl -n hw.ncpu`
# (macOS/BSD, this repo's own dev/test environment) as the fallback so this still works when
# exercised locally. Falls back to "NaN" on any failure -- same "missing metric reads NaN, never
# 0" contract load1/worker_metrics above already use, because a 0 core count is nonsensical and
# would make every load1 normalise to infinity rather than visibly read as unmeasured.
core_count() {
  local v
  v="$(nproc 2>/dev/null)"
  [ -n "$v" ] || v="$(sysctl -n hw.ncpu 2>/dev/null)"
  case "$v" in
  '' | *[!0-9]*) printf 'NaN\n' ;;
  *) printf '%s\n' "$v" ;;
  esac
}

# Resolves and validates a duty-basis name against experiments/src/basis.ts's §2.3 table and
# prints its one-line human-readable description on stdout. Shared by e8-density.sh and
# e9-tiers.sh — originally e8-density.sh-only, lifted here so a basis mistranscription (or a
# basis name the table doesn't have) can't drift between the two drivers by omission, the same
# reasoning as require_live_arm above.
#
# This is the basis-VALIDATION half only: resolveBasis (throws on an unknown name) +
# assertBasisConsistent (throws if the table's own duty/ratio pair for that row is internally
# inconsistent) + describeBasis (formats the result). The sandbox-pool-floor half
# (basis.ts's sandboxFloor) is deliberately NOT folded in here — see duty_basis_sandbox_floor
# below for why it stays e8-density.sh-only rather than being given a substitute here.
describe_duty_basis() {
  local basis="$1"
  "$TSX" -e '
    import { resolveBasis, describeBasis, assertBasisConsistent } from "../../experiments/src/basis.ts";
    const b = resolveBasis(process.argv[1]);
    // Belt and braces: if the table itself is ever mistranscribed, fail here.
    assertBasisConsistent(b.duty[1], b.ratio[0]);
    console.log(describeBasis(b));
  ' "$basis"
}

# K >= ceil(W * S * duty), the sandbox-pool floor for a (workers, turnsPerWorker) provisioning
# point (§2.3). e8-density.sh-ONLY, deliberately not called from e9-tiers.sh: sandboxFloor's
# inputs are a worker count and a per-worker in-flight-turn cap, both properties of E8's single
# supervisor, (W, S) provisioning model. E9 compares two DEPLOYMENT TIERS (a VM-supervisor arm
# against a Knative pod-per-session arm) via a concurrency ladder run directly against each
# arm's own base URL — it has no (W, S) point and no equivalent of either input. A per-arm
# container/pod count is not the same quantity a sandbox-pool floor measures, so rather than
# invent a substitute so E9 could call something under this same name, this stays asymmetric
# and documented: E9 currently has NO sandbox-pool-floor precondition, live or otherwise, so an
# E9 rung that queues on the VM arm's own lease pool would read exactly like the VM tier
# saturating, and nothing in e9-tiers.sh catches it today. See task-3-report.md's Part 2, Item 4.
duty_basis_sandbox_floor() {
  local basis="$1" workers="$2" turns_per_worker="$3"
  "$TSX" -e '
    import { resolveBasis, sandboxFloor } from "../../experiments/src/basis.ts";
    const b = resolveBasis(process.argv[1]);
    console.log(sandboxFloor(Number(process.argv[2]), Number(process.argv[3]), b.duty[1]));
  ' "$basis" "$workers" "$turns_per_worker"
}
