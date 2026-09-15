#!/usr/bin/env bash
# Actually RUN e8-density.sh, both arms, against a mocked supervisor, stub and container runtime.
#
# Why this exists alongside e8-arms.test.sh, which greps the driver: greps prove a call is present,
# not that the ladder reaches it, that its arguments survive quoting, or that a refusal fires before
# the run commits to hardware time. Issue #254 is a case study in the difference -- its whole subject
# is numbers that were published because a path was never exercised on the shape it claimed to
# measure. This file drives the real script end to end and asserts on what it did.
#
# Mocked: curl (/health, /metrics, /profile, /turn), podman stats (cumulative CPUNano). NOT mocked:
# tsx, so detectKnee and the basis table are the real ones.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAIL=0
ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  FAIL=1
}

command -v jq >/dev/null || {
  echo "ok - SKIP (jq not installed; the driver needs it)"
  exit 0
}
[ -x ../../experiments/node_modules/.bin/tsx ] || {
  echo "ok - SKIP (tsx not built; run pnpm install)"
  exit 0
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# --- the mocked supervisor + stub ------------------------------------------------------------
# One curl that dispatches on the URL in its arguments. $TMP/profile.json and $TMP/cpu hold the two
# things individual cases vary, so a case can change the stub profile or the sandbox CPU without
# rewriting the mock.
cat >"$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac done
case "$url" in
*/health) exit 0 ;;
*/profile) cat "$TMPDIR_FIXTURES/profile.json" ;;
*/metrics)
  # Two workers. cpu_seconds GROWS between reads, so the driver's per-rung delta is positive and the
  # per-turn figure is a real division rather than a NaN passthrough.
  n="$(cat "$TMPDIR_FIXTURES/metrics-calls" 2>/dev/null || echo 0)"
  echo $((n + 1)) >"$TMPDIR_FIXTURES/metrics-calls"
  cpu="$(awk -v n="$n" 'BEGIN {printf "%.2f", 1 + n * 0.05}')"
  jq -nc --argjson cpu "$cpu" --argjson cap "$(cat "$TMPDIR_FIXTURES/cap" 2>/dev/null || echo 13)" '{
    workers: [
      {id: 0, pid: 101, inFlight: 0, healthy: true, loop_lag_p99_ms: 1.2, rss_bytes: 100000000, cpu_seconds: $cpu},
      {id: 1, pid: 102, inFlight: 0, healthy: true, loop_lag_p99_ms: 1.1, rss_bytes: 100000000, cpu_seconds: $cpu}
    ],
    counters: {restarts: 0, handoff_retries: 0, handoff_failures: 0, over_admission: 0, spurious_refusals: 0, head_truncations: 0},
    lease_saturation: 0.33, lag_resolution_ms: 1, file_op_p95_ms: "NaN", sandbox_pool_size: 3,
    cores: 8,
    env: {ANTHROPIC_BASE_URL: "http://127.0.0.1:18081", KAGENTI_SANDBOX_CAP: ($cap | tostring)}
  }'
  ;;
*/turn) printf '0.010000\t200' ;;
*) exit 1 ;;
esac
MOCK

# podman stats: cumulative sandbox CPU read from a file, so a case can make the tier busy or idle.
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
case "$*" in
*stats*)
  n="$(cat "$TMPDIR_FIXTURES/podman-calls" 2>/dev/null || echo 0)"
  echo $((n + 1)) >"$TMPDIR_FIXTURES/podman-calls"
  step="$(cat "$TMPDIR_FIXTURES/cpu-step")"
  awk -v n="$n" -v s="$step" 'BEGIN {
    for (i = 0; i < 3; i++) printf "sh-sandbox-%d %.0f\n", i, n * s * 1e9 / 3
    print "sh-redis 900000000000"
  }'
  ;;
*) exit 0 ;;
esac
MOCK
chmod +x "$TMP/bin/curl" "$TMP/bin/podman"

FAST='{"ttftMs":10,"tokenDelayMs":1,"outputTokens":64,"toolCallRate":0.5}'
SLOW='{"ttftMs":300,"tokenDelayMs":12,"outputTokens":64,"toolCallRate":0.5}'

# Run the driver with a given arm, stub profile and sandbox CPU step (seconds of sandbox CPU added
# per /metrics-cycle; the ladder is short, so a big step means a busy tier).
run_e8() {
  local arm="$1" profile="$2" cpu_step="$3" cap="${4:-13}"
  printf '%s' "$profile" >"$TMP/profile.json"
  printf '%s' "$cpu_step" >"$TMP/cpu-step"
  printf '%s' "$cap" >"$TMP/cap"
  rm -f "$TMP/metrics-calls" "$TMP/podman-calls" "$TMP/results.md"
  env PATH="$TMP/bin:$PATH" TMPDIR_FIXTURES="$TMP" \
    V_LIVE=1 V_ARM="$arm" V_LADDER="1 2" V_TURNS_PER_RUNG=2 V_MIN_C=1 \
    V_RESULTS="$TMP/results.md" V_STUB_URL="http://127.0.0.1:18081" \
    SH_WORKERS=2 SH_TURNS_PER_WORKER=4 \
    bash ./e8-density.sh >"$TMP/out" 2>&1
}

# =============================================================================================
# 1. The capacity arm runs to completion on a fast stub and an idle sandbox tier.
# =============================================================================================
if run_e8 capacity "$FAST" 0.01; then
  ok "the capacity arm completes against a fast stub and an idle sandbox tier"
else
  ko "the capacity arm failed to complete: $(tail -5 "$TMP/out" | tr '\n' ' ')"
fi

grep -q 'E8_RESULT arm=capacity' "$TMP/out" &&
  ok "E8_RESULT names the capacity arm" ||
  ko "E8_RESULT does not name the arm: $(grep E8_RESULT "$TMP/out")"

# The gates must have actually fired, in order, before the ladder.
grep -q 'stub profile is fast' "$TMP/out" &&
  ok "the per-arm stub profile pin ran" || ko "the stub profile pin did not run"
grep -qE 'admitted.*clears the top rung|admitted and .* concurrent leases' "$TMP/out" &&
  ok "the admission-cap headroom check ran" || ko "the headroom check did not run"
grep -q 'sandbox utilisation' "$TMP/out" &&
  ok "the utilisation ceiling was evaluated" || ko "the utilisation ceiling never ran"
# Every rung, not just c=1.
if [ "$(grep -c 'sandbox utilisation .* is within' "$TMP/out")" -ge 2 ]; then
  ok "the ceiling was evaluated at every rung ($(grep -c 'is within' "$TMP/out") rungs)"
else
  ko "the ceiling ran on fewer rungs than the ladder has"
fi

# The record must carry the new fields as real numbers, not NaN passthroughs.
REC="$(sed -n '/^```json/,/^```/p' "$TMP/results.md" | sed '1d;$d')"
if [ -z "$REC" ]; then
  ko "no per-rung JSON record was written"
else
  for f in arm worker_cpu_ms_per_turn worker_cpu_util sandbox_util lag_resolution_ms duty_basis; do
    if printf '%s' "$REC" | jq -e --arg f "$f" 'all(.[]; has($f))' >/dev/null; then
      ok "every rung records $f"
    else
      ko "a rung is missing $f"
    fi
  done
  printf '%s' "$REC" | jq -e 'all(.[]; .arm == "capacity")' >/dev/null &&
    ok "every rung is labelled with its arm" || ko "a rung is not labelled capacity"
  # duty_basis must be the explicit "none", never blank -- §2.3 as amended.
  printf '%s' "$REC" | jq -e 'all(.[]; .duty_basis | test("none"))' >/dev/null &&
    ok "the capacity arm records duty_basis as an explicit none, not a blank" ||
    ko "duty_basis is not the explicit none value: $(printf '%s' "$REC" | jq -r '.[0].duty_basis')"
  # Per-turn worker CPU must be a NUMBER: this is the metric the issue exists to add, and a NaN here
  # would mean the plumbing reached the record without ever carrying a reading.
  if printf '%s' "$REC" | jq -e 'all(.[]; .worker_cpu_ms_per_turn | tonumber? // null | . != null and . > 0)' >/dev/null; then
    ok "per-turn worker CPU is a real positive number on every rung"
  else
    ko "per-turn worker CPU is not a usable number: $(printf '%s' "$REC" | jq -r '[.[].worker_cpu_ms_per_turn] | @csv')"
  fi
fi

# worker_cpu_util must be computed against the TARGET's cores (the mock reports 8), never against the
# generator's: the driver's own `nproc` describes a different, smaller box on the required topology, and
# dividing the target's CPU by it inflates every utilisation by the ratio between the two machines.
if grep -q 'cores on the TARGET (as the supervisor reports them): 8' "$TMP/out"; then
  ok "the driver takes its worker-CPU denominator from the target, not from its own box"
else
  ko "the driver did not report the target's core count: $(grep -i cores "$TMP/out" | tr '\n' ' ')"
fi

# And the report must carry the two statements that stop the number being misread.
grep -qi 'upper bound' "$TMP/results.md" &&
  ok "the record says the capacity number is an upper bound" ||
  ko "the record does not label the capacity number an upper bound"
grep -q 'must not be quoted as a fraction of an' "$TMP/results.md" &&
  ok "the record carries the throughput-vs-ideal prohibition" ||
  ko "the record omits the throughput-vs-ideal prohibition"

# =============================================================================================
# 2. A capacity arm over the utilisation ceiling is REFUSED, mid-ladder.
# =============================================================================================
# 8 seconds of sandbox CPU per metrics cycle across a sub-second rung: far past 25% of three
# containers, i.e. the shape of the published run this arm exists to stop producing.
if run_e8 capacity "$FAST" 8; then
  ko "a capacity arm at a saturated sandbox tier COMPLETED -- the ceiling did not refuse it"
else
  ok "a capacity arm over the utilisation ceiling is refused"
  grep -q 'exceeds the 25% ceiling' "$TMP/out" &&
    ok "the refusal names the ceiling it crossed" ||
    ko "the refusal message is not the ceiling's: $(tail -3 "$TMP/out" | tr '\n' ' ')"
  # The rung's own record must be on stdout, so the refusal can be checked against its numbers.
  grep -q 'rung record: {' "$TMP/out" &&
    ok "the refused rung's record is echoed for diagnosis" ||
    ko "the refused rung's telemetry was discarded"
fi

# =============================================================================================
# 3. An arm mislabelled against its stub profile is REFUSED, before any rung runs.
# =============================================================================================
if run_e8 capacity "$SLOW" 0.01; then
  ko "a CAPACITY arm ran against the 300/12 stub -- it would report the stub's sleep as the harness ceiling"
else
  ok "a capacity arm against the slow stub is refused"
  grep -q 'not a fast profile' "$TMP/out" &&
    ok "the refusal explains which profile it found" ||
    ko "the refusal message is not the profile pin's: $(tail -3 "$TMP/out" | tr '\n' ' ')"
  # Before the ladder: no turn may have been issued.
  grep -q '^-- rung c=' "$TMP/out" &&
    ko "the mislabel was caught only after a rung had already run" ||
    ok "the mislabel is caught before any rung runs"
fi

if run_e8 realism "$FAST" 0.01; then
  ko "a REALISM arm ran against the capacity arm's fast stub"
else
  ok "a realism arm against the fast stub is refused (the mislabel is symmetric)"
fi

# =============================================================================================
# 4. The realism arm still behaves exactly as before: floor, basis, no ceiling.
# =============================================================================================
# W=2 S=4 at the e6-ocp duty implies K >= ceil(8 * 0.079) = 1, and the mock pool reports 3.
if run_e8 realism "$SLOW" 0.01; then
  ok "the realism arm completes unchanged against the calibrated stub"
  grep -q 'sandbox pool satisfies the floor' "$TMP/out" &&
    ok "the realism arm still checks the pool FLOOR" ||
    ko "the realism arm lost its floor check"
  grep -q 'sandbox utilisation' "$TMP/out" &&
    ko "the realism arm applied the capacity arm's utilisation ceiling" ||
    ok "the realism arm does not apply the ceiling"
  grep -qE 'E8_RESULT arm=realism' "$TMP/out" &&
    ok "E8_RESULT names the realism arm" || ko "E8_RESULT does not name the realism arm"
  REC2="$(sed -n '/^```json/,/^```/p' "$TMP/results.md" | sed '1d;$d')"
  printf '%s' "$REC2" | jq -e 'all(.[]; .duty_basis == "e6-ocp")' >/dev/null &&
    ok "the realism arm records its §2.3 row" ||
    ko "the realism arm's duty_basis is not the row it ran: $(printf '%s' "$REC2" | jq -r '.[0].duty_basis')"
else
  ko "the realism arm failed to complete: $(tail -5 "$TMP/out" | tr '\n' ' ')"
fi

# =============================================================================================
# 5. An unmeasurable sandbox tier must not pass the ceiling vacuously.
# =============================================================================================
# No podman on PATH at all: the off-box generator case, where the old helper returned a confident 0.
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
exit 127
MOCK
chmod +x "$TMP/bin/podman"
if run_e8 capacity "$FAST" 0.01; then
  ko "a capacity arm with NO measurable sandbox CPU completed -- the ceiling passed vacuously, which is the exact reading that exonerates a saturated tier"
else
  ok "an unmeasurable sandbox tier is refused, not treated as idle"
  grep -q 'V_SANDBOX_CPU_CMD' "$TMP/out" &&
    ok "the refusal names the off-box remedy" ||
    ko "the refusal does not name V_SANDBOX_CPU_CMD: $(tail -3 "$TMP/out" | tr '\n' ' ')"
  # It must refuse by REFUSING, not by falling over. The first version of the NaN path died here at
  # `-- rung c=1` with exit 127 and no message at all: `podman | awk` under the driver's own
  # `pipefail` returns podman's status even though awk printed the NaN, and the enclosing
  # `CPU0="$(sandbox_cpu_seconds)"` assignment then aborted the run under `set -e`. A silent 127 and a
  # diagnosed refusal are both non-zero exits, so only the message distinguishes them.
  grep -qE 'sandbox utilisation is UNMEASURED' "$TMP/out" &&
    ok "the refusal is the ceiling's own diagnosis, not a bare pipeline failure" ||
    ko "the run failed without the ceiling's diagnosis (a pipefail abort, not a refusal): $(tail -2 "$TMP/out" | tr '\n' ' ')"
fi

# The REALISM arm has no ceiling, so the same missing runtime must NOT stop it: it recorded "0.00"
# before this change and records "NaN" now, and either way an off-box realism run is legitimate. This
# is the regression the NaN-instead-of-0 fix could most easily have caused.
if run_e8 realism "$SLOW" 0.01; then
  ok "a realism arm still completes with no container runtime visible (off-box generator)"
  REC3="$(sed -n '/^```json/,/^```/p' "$TMP/results.md" | sed '1d;$d')"
  printf '%s' "$REC3" | jq -e 'all(.[]; .sandbox_cpu == "NaN")' >/dev/null &&
    ok "its unmeasured sandbox CPU is recorded as NaN, not as a confident 0" ||
    ko "sandbox_cpu is not NaN on an unmeasurable tier: $(printf '%s' "$REC3" | jq -r '[.[].sandbox_cpu] | @csv')"
else
  ko "a realism arm was blocked by an unmeasurable sandbox tier -- the ceiling is capacity-only: $(tail -3 "$TMP/out" | tr '\n' ' ')"
fi

# And the hook makes that case runnable again. Spelled out rather than routed through run_e8, because
# this case is the only one that needs V_SANDBOX_CPU_CMD in the environment.
printf '%s' "$FAST" >"$TMP/profile.json"
printf '0.01' >"$TMP/cpu-step"
printf '13' >"$TMP/cap"
rm -f "$TMP/metrics-calls" "$TMP/results.md"
if env PATH="$TMP/bin:$PATH" TMPDIR_FIXTURES="$TMP" \
  V_LIVE=1 V_ARM=capacity V_LADDER="1 2" V_TURNS_PER_RUNG=2 V_MIN_C=1 \
  V_RESULTS="$TMP/results.md" V_STUB_URL="http://127.0.0.1:18081" \
  V_SANDBOX_CPU_CMD='echo 0.02' \
  SH_WORKERS=2 SH_TURNS_PER_WORKER=4 \
  bash ./e8-density.sh >"$TMP/out" 2>&1; then
  ok "V_SANDBOX_CPU_CMD makes an off-box capacity run possible"
else
  ko "V_SANDBOX_CPU_CMD did not satisfy the ceiling: $(tail -5 "$TMP/out" | tr '\n' ' ')"
fi

# =============================================================================================
# 6. A lease pool below the ladder is refused (the KAGENTI_SANDBOX_CAP=4 run).
# =============================================================================================
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
case "$*" in
*stats*)
  n="$(cat "$TMPDIR_FIXTURES/podman-calls" 2>/dev/null || echo 0)"
  echo $((n + 1)) >"$TMPDIR_FIXTURES/podman-calls"
  awk -v n="$n" 'BEGIN { for (i = 0; i < 3; i++) printf "sh-sandbox-%d %.0f\n", i, n * 3333333 }'
  ;;
*) exit 0 ;;
esac
MOCK
chmod +x "$TMP/bin/podman"
# 3 sandboxes x cap 1 = 3 concurrent leases against a top rung of 2 needing 2x = 4.
if run_e8 capacity "$FAST" 0.01 1; then
  ko "a capacity arm whose lease pool cannot cover the ladder completed -- it would measure the lease pool"
else
  ok "a lease pool below the ladder is refused"
  grep -q 'KAGENTI_SANDBOX_CAP' "$TMP/out" &&
    ok "the refusal names the lease cap" ||
    ko "the refusal does not name the lease cap: $(tail -3 "$TMP/out" | tr '\n' ' ')"
fi

[ "$FAIL" = 0 ] && echo "# e8-arms-live-mock: all checks passed" || echo "# e8-arms-live-mock: FAILURES"
exit "$FAIL"
