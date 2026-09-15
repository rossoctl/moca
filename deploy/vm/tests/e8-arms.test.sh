#!/usr/bin/env bash
# E8's two arms (spec §5.2): the CAPACITY arm measures the supervisor + worker tier with the sandbox
# tier held deliberately non-binding and non-competing; the REALISM arm keeps the calibrated duty.
# Each arm's number is not the other's, and each has a precondition pointing the OPPOSITE way -- so
# the hazard this file exists for is an arm running with the other arm's gate.
#
# Why every check here is worth its lines, from the three runs recorded in the P6 density findings:
#
#  1. THE CEILING CANNOT BE BUILT ON A PERCENTAGE. `sandbox_cpu_seconds` used to sum
#     `podman stats --format '{{.CPU}}'`, which is an INSTANTANEOUS PERCENT, and e8-density.sh
#     differenced two such samples per rung. Verified against podman: `{{.CPU}}` -> `1.0714`
#     (percent) while `{{.CPUNano}}` -> `4596421884000` (cumulative ns, matching that container's
#     own `cpu_time: 1h16m36s`). A utilisation ceiling computed from a percent delta is not a
#     utilisation; it can even be negative. So the fix is load-bearing for the gate, not hygiene.
#
#  2. AN UNMEASURABLE SANDBOX TIER MUST NOT READ AS AN IDLE ONE. podman runs on the DRIVER's box,
#     and the authoritative topology puts the generator off-box (EXPERIMENTS.md, "Where the
#     generator ran"), where `podman stats` enumerates the generator's containers -- none. A `0`
#     there passes a <=25% ceiling vacuously, i.e. the one reading that exonerates the exact run
#     the ceiling exists to refuse. NaN, and a refusal, is the only honest answer.
#
#  3. AN ARM MISLABELLED AGAINST ITS STUB PROFILE MEASURES THE OTHER ARM. ~1.42s of the calibrated
#     run's 1.537s turn was the stub's own programmed wait (300/12/64), so an in-flight turn is
#     mostly a sleeping promise: at that profile the box cannot be filled at any concurrency the
#     admission cap permits, and a "capacity" arm run against it reports the stub's latency as the
#     harness's ceiling. assert_stub_pinned already refuses a supervisor pointed at a DIFFERENT
#     stub; this is the same idea one level in -- the right stub, running the wrong PROFILE.
#
#  4. A CAP BELOW THE LADDER IS THE CAP'S NUMBER, NOT THE MACHINE'S. Two zero-duty runs swept to
#     c=64 with p95 flat within 6ms and reported `bound=not-observed`, because `W x S` was the top
#     rung by construction. And the same ladder with the shipped `KAGENTI_SANDBOX_CAP=4` produced
#     exactly 360 successes at two rungs (12 leases x 30 turns) with throughput pinned at 10.4/s --
#     a run that measured the LEASE POOL and would have been published as a VM density figure had
#     the success-rate floor not caught it. Hence headroom on both caps, asserted before the ladder.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAIL=0
ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  FAIL=1
}

# lib-vm.sh's own ok/ko are overwritten by sourcing it; keep this file's reporting separate so a
# gate that calls ko internally cannot make this suite print "ok" for its own assertion.
t_ok() { echo "ok - $1"; }
t_ko() {
  echo "not ok - $1"
  FAIL=1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# shellcheck source=../lib-vm.sh
source ./lib-vm.sh

# Run a gate in a SUBSHELL: every gate here refuses by `exit 1`, matching require_live_arm and
# stub_profile's convention, so calling one in-process would end this suite instead of testing it.
# Returns the gate's exit status; its output lands in $TMP/out for message assertions.
#
# 127 (function not defined) is converted to 0, deliberately. Bash exits 127 on an undefined
# command, which is non-zero, which every "...must be refused" assertion below would otherwise read
# as a correct refusal -- so a driver that simply LACKS a gate would score those checks as passes.
# Reporting the missing gate as an acceptance makes the corresponding assertion fail loudly instead.
run_gate() {
  local rc
  ("$@") >"$TMP/out" 2>&1
  rc=$?
  if [ "$rc" = 127 ] || grep -q 'command not found' "$TMP/out"; then
    echo "MISSING GATE: $1 is not defined in lib-vm.sh" >>"$TMP/out"
    return 0
  fi
  return "$rc"
}

# A gate that ACCEPTED its input, as distinct from one that is not there at all. run_gate maps a
# missing function (127) to success so that every "...must be refused" assertion fails loudly rather
# than counting the absence as a refusal -- but that mapping would then score the "...must be
# accepted" half as a pass against a driver with no gates whatsoever. Half the suite would go green
# on an empty lib-vm.sh. Every must-pass call therefore goes through this instead of run_gate.
gate_accepted() {
  run_gate "$@" || return 1
  ! grep -q 'MISSING GATE' "$TMP/out"
}

# =============================================================================================
# 1. sandbox_cpu_seconds: CUMULATIVE seconds, or NaN. Never a percentage, never 0.
# =============================================================================================

# A podman that answers with cumulative nanoseconds, the only field a per-rung DELTA can come from.
# The pool is two sandboxes (12.5s and 2.5s of CPU since boot) alongside the OTHER containers this
# same box runs -- setup-vm.sh starts Redis and the relay here too, and the old implementation summed
# every container's CPU into a field named `sandbox_cpu`. Redis is given a large number precisely so
# an implementation that forgets to filter cannot pass.
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
case "$*" in
*stats*)
  echo "sh-sandbox-0 12500000000"
  echo "sh-sandbox-1 2500000000"
  echo "sh-redis 900000000000"
  ;;
*) exit 0 ;;
esac
MOCK
chmod +x "$TMP/bin/podman"
PATH="$TMP/bin:$PATH"

CPU="$(sandbox_cpu_seconds)"
if [ "$CPU" = "15.00" ]; then
  t_ok "sandbox_cpu_seconds sums cumulative CPU nanoseconds into seconds (15.00)"
elif [ "$CPU" = "915.00" ]; then
  t_ko "sandbox_cpu_seconds returned 915.00 -- it summed EVERY container (Redis, relay, stub), not the sandbox pool"
else
  t_ko "sandbox_cpu_seconds returned '$CPU', expected 15.00 from 12.5s + 2.5s of sandbox CPUNano"
fi

if grep -qE 'CPUNano' lib-vm.sh; then
  t_ok "sandbox_cpu_seconds reads {{.CPUNano}}"
else
  t_ko "sandbox_cpu_seconds does not read {{.CPUNano}} -- a per-rung delta needs a CUMULATIVE source"
fi
# The percent field must be gone: differencing two instantaneous percentages is not a CPU delta.
if grep -E "podman stats" lib-vm.sh | grep -qE '\{\{\.CPU\}\}'; then
  t_ko "lib-vm.sh still reads podman stats {{.CPU}} (an instantaneous PERCENT) for a differenced metric"
else
  t_ok "the instantaneous {{.CPU}} percent is no longer the source of a differenced metric"
fi

# No podman at all -> NaN, never 0. A 0 reads as "the sandbox tier was idle" and exonerates it.
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
exit 127
MOCK
chmod +x "$TMP/bin/podman"
CPU="$(sandbox_cpu_seconds)"
if [ "$CPU" = "NaN" ]; then
  t_ok "an unreachable container runtime reads NaN, not 0"
else
  t_ko "sandbox_cpu_seconds returned '$CPU' with no working podman; must be NaN (0 exonerates an unmeasured tier)"
fi

# Running, but no sandbox containers (the off-box generator case) -> NaN, for the same reason.
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$TMP/bin/podman"
CPU="$(sandbox_cpu_seconds)"
if [ "$CPU" = "NaN" ]; then
  t_ok "a runtime with no sandbox containers reads NaN (the off-box generator case)"
else
  t_ko "sandbox_cpu_seconds returned '$CPU' with no sandbox containers; must be NaN"
fi

# The off-box hook: an operator supplies the number from the target, and it is used verbatim.
CPU="$(V_SANDBOX_CPU_CMD='echo 41.5' sandbox_cpu_seconds)"
if [ "$CPU" = "41.50" ]; then
  t_ok "V_SANDBOX_CPU_CMD supplies sandbox CPU seconds for an off-box generator"
else
  t_ko "V_SANDBOX_CPU_CMD produced '$CPU', expected 41.50"
fi
# A hook that fails must not degrade to 0 either.
CPU="$(V_SANDBOX_CPU_CMD='exit 3' sandbox_cpu_seconds)"
if [ "$CPU" = "NaN" ]; then
  t_ok "a failing V_SANDBOX_CPU_CMD reads NaN"
else
  t_ko "a failing V_SANDBOX_CPU_CMD produced '$CPU'; must be NaN"
fi

# =============================================================================================
# 2. cpu_utilisation: cpu_seconds / (wall_seconds x containers), the MEASURED quantity 2b wants.
# =============================================================================================

U="$(cpu_utilisation 2.35 1000 3)"
if [ "$U" = "78.3" ]; then
  t_ok "cpu_utilisation reproduces the findings' 2.35-of-3 arithmetic (78.3%)"
else
  t_ko "cpu_utilisation 2.35s over 1s x 3 containers gave '$U', expected 78.3"
fi
U="$(cpu_utilisation 0.15 30000 3)"
if [ "$U" = "0.2" ]; then
  t_ok "a trivial-exec arm reads a fraction of a percent (0.2%)"
else
  t_ko "cpu_utilisation 0.15s over 30s x 3 gave '$U', expected 0.2"
fi
# NaN in, NaN out: an unmeasured input must never become a number the ceiling can pass.
for bad in NaN '' 0; do
  case "$bad" in
  0) U="$(cpu_utilisation 1 0 3)" ;; # zero wall time
  *) U="$(cpu_utilisation "$bad" 1000 3)" ;;
  esac
  if [ "$U" = "NaN" ]; then
    t_ok "cpu_utilisation refuses to invent a number from '${bad:-<empty>}'"
  else
    t_ko "cpu_utilisation('${bad:-<empty>}') = '$U'; an unmeasurable input must read NaN"
  fi
done

# =============================================================================================
# 3. assert_sandbox_ceiling: the capacity arm's precondition, pointing the OPPOSITE way to the floor.
# =============================================================================================

if gate_accepted assert_sandbox_ceiling 5.0 25 "c=1"; then
  t_ok "a 5% sandbox tier passes the 25% ceiling"
else
  t_ko "assert_sandbox_ceiling refused 5% against a 25% ceiling: $(cat "$TMP/out")"
fi

if run_gate assert_sandbox_ceiling 78.3 25 "c=32"; then
  t_ko "assert_sandbox_ceiling ACCEPTED 78.3% against a 25% ceiling -- this is the run the arm exists to refuse"
else
  t_ok "a capacity arm at 78.3% sandbox utilisation is refused"
  grep -qiE 'utilis|utiliz' "$TMP/out" && grep -q '78.3' "$TMP/out" &&
    t_ok "the refusal names the measured utilisation" ||
    t_ko "the refusal does not name the measured utilisation: $(cat "$TMP/out")"
fi

if run_gate assert_sandbox_ceiling NaN 25 "c=1"; then
  t_ko "assert_sandbox_ceiling ACCEPTED an unmeasured (NaN) sandbox tier -- a ceiling passed vacuously is worse than no ceiling"
else
  t_ok "an unmeasurable sandbox tier is refused rather than passed vacuously"
  grep -q 'V_SANDBOX_CPU_CMD' "$TMP/out" &&
    t_ok "the NaN refusal names the off-box remedy (V_SANDBOX_CPU_CMD)" ||
    t_ko "the NaN refusal does not name the remedy: $(cat "$TMP/out")"
fi

# The exact boundary: <= the ceiling passes, above it refuses.
gate_accepted assert_sandbox_ceiling 25.0 25 "c=1" && t_ok "utilisation exactly at the ceiling passes" ||
  t_ko "utilisation exactly at the ceiling was refused"
run_gate assert_sandbox_ceiling 25.1 25 "c=1" && t_ko "utilisation just above the ceiling passed" ||
  t_ok "utilisation just above the ceiling is refused"

# =============================================================================================
# 4. assert_arm_stub_profile: an arm cannot be labelled one thing while measuring the other's stub.
# =============================================================================================

FAST='{"ttftMs":10,"tokenDelayMs":1,"outputTokens":64,"toolCallRate":0.5}'
SLOW='{"ttftMs":300,"tokenDelayMs":12,"outputTokens":64,"toolCallRate":0.5}'

gate_accepted assert_arm_stub_profile capacity "$FAST" 25 2 &&
  t_ok "the capacity arm accepts a fast stub (ttft 10ms, delay 1ms)" ||
  t_ko "the capacity arm refused its own fast profile: $(cat "$TMP/out")"

if run_gate assert_arm_stub_profile capacity "$SLOW" 25 2; then
  t_ko "a CAPACITY arm was accepted against the 300/12 stub -- it would report the stub's sleep as the harness ceiling"
else
  t_ok "a capacity arm against the slow stub is refused"
  grep -q 'capacity' "$TMP/out" && grep -qE '300' "$TMP/out" &&
    t_ok "the refusal names the arm and the profile it actually found" ||
    t_ko "the refusal does not name arm and profile: $(cat "$TMP/out")"
fi

gate_accepted assert_arm_stub_profile realism "$SLOW" 25 2 &&
  t_ok "the realism arm accepts the calibrated 300/12/64 profile" ||
  t_ko "the realism arm refused its own profile: $(cat "$TMP/out")"

if run_gate assert_arm_stub_profile realism "$FAST" 25 2; then
  t_ko "a REALISM arm was accepted against the fast stub -- a density claim measured without the model tier it names"
else
  t_ok "a realism arm against the capacity arm's fast stub is refused (the mislabel is symmetric)"
fi

# One knob short of fast is still not fast: both bounds must bind, or a half-fast profile slips through.
run_gate assert_arm_stub_profile capacity '{"ttftMs":10,"tokenDelayMs":12,"outputTokens":64,"toolCallRate":0.5}' 25 2 &&
  t_ko "the capacity arm accepted a fast ttft with the slow token delay" ||
  t_ok "the capacity arm requires BOTH ttft and token delay to be fast"

# A profile field that is absent or non-numeric must REFUSE, not slip through on a string comparison.
# `jq -r` renders a missing field as the literal `null`, and awk compares two non-numeric operands as
# STRINGS -- `"null" > "0"` is true -- so `awk 'BEGIN {exit !(r > 0)}'` used to ACCEPT a profile with
# no toolCallRate at all. Same class as the strtod trap cpu_utilisation documents.
for bad in \
  '{"ttftMs":10,"tokenDelayMs":1,"outputTokens":64}' \
  '{"ttftMs":10,"tokenDelayMs":1,"outputTokens":64,"toolCallRate":"abc"}' \
  '{"ttftMs":null,"tokenDelayMs":1,"outputTokens":64,"toolCallRate":0.5}' \
  '{}'; do
  if run_gate assert_arm_stub_profile capacity "$bad" 25 2; then
    t_ko "a non-numeric/absent profile field was ACCEPTED: $bad"
  else
    t_ok "a profile this gate cannot read is refused, not compared as a string: $bad"
  fi
done

# The realism arm must be PINNED to a profile, not merely "not fast". Asserting only `fast = no`
# accepted ttft=50/delay=5 -- and an empty profile, which it announced as "the calibrated one".
if run_gate assert_arm_stub_profile realism '{"ttftMs":50,"tokenDelayMs":5,"outputTokens":64,"toolCallRate":0.5}' 25 2; then
  t_ko "the realism arm accepted ttft=50/delay=5 -- neither its own pinned profile nor the capacity arm-s"
else
  t_ok "the realism arm is pinned to its declared profile, not merely to being slower than fast"
fi
# ...and the pin is overridable for a deliberate second profile point, which then IS the pinned one.
if V_REALISM_TTFT_MS=50 V_REALISM_TOKEN_DELAY_MS=5 \
  gate_accepted assert_arm_stub_profile realism '{"ttftMs":50,"tokenDelayMs":5,"outputTokens":64,"toolCallRate":0.5}' 25 2; then
  t_ok "V_REALISM_* moves the pin for a deliberate second profile point"
else
  t_ko "V_REALISM_* did not move the realism pin: $(cat "$TMP/out")"
fi

# A profile that never emits a tool call has no hands tier at all, in either arm (§5.4).
run_gate assert_arm_stub_profile capacity '{"ttftMs":10,"tokenDelayMs":1,"outputTokens":64,"toolCallRate":0}' 25 2 &&
  t_ko "an arm was accepted against a stub with toolCallRate=0 -- no session ever reaches a sandbox" ||
  t_ok "toolCallRate=0 is refused in the capacity arm too (the exec must stay on the path)"

# =============================================================================================
# 5. assert_capacity_headroom: the caps must not be the variable the ladder finds.
# =============================================================================================

# W x S = 512 admitted and 6 sandboxes x cap 43 = 258 leases against a top rung of 128: neither cap
# can be what knees. (A lease is held per SESSION, not per exec -- the shipped-cap run proved it:
# 3 sandboxes x cap 4 = 12 leases yielded exactly 360 successes = 12 sessions x 30 turns, so the
# quantity that must clear the rung is concurrent leases against concurrent sessions.)
gate_accepted assert_capacity_headroom 128 512 258 2 &&
  t_ok "512 admitted and 258 leases clear a c=128 top rung at 2x headroom" ||
  t_ko "headroom refused a well-provisioned capacity arm: $(cat "$TMP/out")"

if run_gate assert_capacity_headroom 64 64 39 2; then
  t_ko "a ladder whose top rung EQUALS the admission cap was accepted -- this is the published not-observed run"
else
  t_ok "a top rung at the admission cap is refused (W x S is a config choice, not a machine limit)"
  grep -qE 'admission|W ?x ?S|W\*S' "$TMP/out" &&
    t_ok "the refusal names the admission cap" ||
    t_ko "the refusal does not name the admission cap: $(cat "$TMP/out")"
fi

if run_gate assert_capacity_headroom 128 512 12 2; then
  t_ko "12 concurrent leases were accepted under a c=128 top rung -- the KAGENTI_SANDBOX_CAP=4 run, exactly"
else
  t_ok "a lease pool below the ladder is refused (the 360-successes run)"
  grep -q 'KAGENTI_SANDBOX_CAP' "$TMP/out" &&
    t_ok "the refusal names KAGENTI_SANDBOX_CAP" ||
    t_ko "the refusal does not name the lease cap: $(cat "$TMP/out")"
fi

# =============================================================================================
# 6. The wiring: e8-density.sh must actually USE the gates, in the right arm, in the right order.
# =============================================================================================

D=e8-density.sh
CODE="$(grep -vE '^\s*#' "$D")"

printf '%s' "$CODE" | grep -qE 'V_ARM' &&
  ok "$D takes an arm (V_ARM)" || ko "$D has no V_ARM: the two arms of §5.2 are not selectable"

# The unobserved-pool refusal is identical in both arms and must not have been folded into the
# floor branch: it catches a turn that bypassed pool selection, and that hazard has no arm.
if printf '%s' "$CODE" | grep -qE 'sandbox pool size unreported'; then
  ok "the pool-never-observed refusal survives the arm split"
else
  ko "the pool-never-observed refusal is gone -- the /turn-ran-tools-locally defect is unguarded again"
fi

for fn in assert_sandbox_ceiling assert_arm_stub_profile assert_capacity_headroom cpu_utilisation; do
  printf '%s' "$CODE" | grep -q "$fn" ||
    ko "$D never calls $fn"
done
printf '%s' "$CODE" | grep -q assert_sandbox_ceiling && ok "$D applies the utilisation ceiling"
printf '%s' "$CODE" | grep -q assert_capacity_headroom && ok "$D asserts cap headroom"
printf '%s' "$CODE" | grep -q assert_arm_stub_profile && ok "$D pins the stub profile per arm"

# The floor must survive for the realism arm: this issue narrows where it applies, it does not
# delete it. A capacity-only driver would silently stop guarding the deployable number.
printf '%s' "$CODE" | grep -q 'duty_basis_sandbox_floor' &&
  ok "the realism arm's sandbox floor is still derived" ||
  ko "duty_basis_sandbox_floor is gone -- the realism arm lost its pool floor"

# The ceiling is checked at EVERY rung, not once: sandbox load grows with offered concurrency, so a
# c=1 check alone would clear a ladder that crosses the ceiling at its top rung (78% at c=32 in the
# published run, against 2.4% at c=1).
CEIL_LINE="$(grep -n 'assert_sandbox_ceiling' "$D" | grep -v '^\s*[0-9]*:\s*#' | head -1 | cut -d: -f1)"
RUNG_LINE="$(grep -n 'for C in \$LADDER' "$D" | head -1 | cut -d: -f1)"
DONE_LINE="$(grep -n '^done' "$D" | head -1 | cut -d: -f1)"
if [ -n "$CEIL_LINE" ] && [ -n "$RUNG_LINE" ] && [ -n "$DONE_LINE" ] &&
  [ "$CEIL_LINE" -gt "$RUNG_LINE" ] && [ "$CEIL_LINE" -lt "$DONE_LINE" ]; then
  ok "the utilisation ceiling is evaluated inside the rung loop (every rung, not just c=1)"
else
  ko "assert_sandbox_ceiling is outside the rung loop: a ladder that crosses the ceiling later would pass"
fi

# Headroom and the profile pin are PRECONDITIONS: after them the run is committed to hardware time,
# so both must precede the first rung.
for fn in assert_capacity_headroom assert_arm_stub_profile; do
  L="$(grep -n "$fn" "$D" | grep -v '^\s*[0-9]*:\s*#' | head -1 | cut -d: -f1)"
  if [ -n "$L" ] && [ -n "$RUNG_LINE" ] && [ "$L" -lt "$RUNG_LINE" ]; then
    ok "$fn runs before the ladder starts"
  else
    ko "$fn does not precede the rung loop -- a refusal after an hour of measurement costs the run"
  fi
done

# =============================================================================================
# 7. Reporting: per-turn worker CPU recorded, the arm labelled, and no "% of ideal" capacity claim.
# =============================================================================================

for field in worker_cpu_ms_per_turn worker_cpu_util sandbox_util arm; do
  printf '%s' "$CODE" | grep -q "$field" ||
    ko "$D does not record $field per rung"
done
printf '%s' "$CODE" | grep -q worker_cpu_ms_per_turn &&
  ok "per-turn worker CPU is recorded (the metric whose absence made the knee ambiguous)"
printf '%s' "$CODE" | grep -q 'worker-cpu' &&
  ok "a knee can be attributed to real worker CPU, distinctly from a slow stub" ||
  ko "no worker-cpu attribution: 'the worker tier is full' is still indistinguishable from 'the stub is slow'"

printf '%s' "$CODE" | grep -q 'arm=' &&
  ok "E8_RESULT names the arm" || ko "E8_RESULT does not name the arm"

# "88% of ideal throughput" was computed against a denominator that is mostly stub sleep. The
# driver must not present any such ratio as a capacity figure.
if printf '%s' "$CODE" | grep -qE '% of ideal|percent of ideal|pct_of_ideal|ideal_throughput'; then
  ko "$D presents a '% of ideal' figure: with a stub-sleep-bound denominator that measures how well the harness hides a fixed wait, not capacity"
else
  ok "no '% of ideal' capacity figure in the driver"
fi

# The capacity arm's own number must carry its meaning: an upper bound on the harness tier, never a
# deployable density.
if grep -qiE 'upper bound' "$D"; then
  ok "the capacity arm's number is labelled an upper bound, not a deployable density"
else
  ko "the capacity arm's report does not say its number is an upper bound on the harness tier"
fi

[ "$FAIL" = 0 ] && echo "# e8-arms: all checks passed" || echo "# e8-arms: FAILURES"
exit "$FAIL"
