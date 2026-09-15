#!/usr/bin/env bash
# E8 — single-VM turn density (P6 spec §5.1, §5.2, §5.4, §5.6).
#
# Sweeps OFFERED CONCURRENCY against one supervisor at one (W, S) point and reports the highest
# rung whose p95 stays within DEGRADE_X of its own c=1 baseline. The answer is a FLOOR: the
# ladder cannot see past its top rung.
#
# Two vocabularies, never conflated (§5.1):
#   - concurrent in-flight turns  -> what this measures; the resource-consuming quantity
#   - sessions addressable        -> a Redis capacity statement; NOT measured here
#
# Sweep (W, S) by invoking this repeatedly. S is SH_TURNS_PER_WORKER, a restart-time constant:
# changing it mid-ladder would reset every worker's in-flight state and mix a cold rung into a
# warm series.
#
# TWO ARMS, and their numbers are not interchangeable (§5.2, as amended):
#
#   V_ARM=realism  (default)  calibrated duty (prepare-workload.sh), stub at 300/12/64. The
#                             DEPLOYABLE density: sandbox-shaped by construction, and gated by the
#                             sandbox-pool FLOOR so a lease queue cannot masquerade as a worker knee.
#   V_ARM=capacity            trivial exec (ARM=capacity ./prepare-workload.sh), fast stub. An UPPER
#                             BOUND on the supervisor + worker tier only, with the sandbox tier held
#                             non-binding and non-competing, and gated by a measured utilisation
#                             CEILING -- the floor's mirror image, since here a busy sandbox tier is
#                             the defect rather than the precondition.
#
# Why the arms exist at all, from the runs recorded in the P6 density findings: ~1.42s of the
# calibrated run's 1.537s turn was the stub's own programmed wait, so 32 in-flight turns loaded the
# worker tier at a few percent and the ladder topped out at the admission cap W*S -- a config choice
# reported as `bound=not-observed`. Meanwhile the tail that DID move (p95 1546 -> 2457ms with p50 flat
# within 9ms) was queueing at three sandbox containers held ~78% busy. Neither number described the
# worker tier. The capacity arm removes both confounds; the realism arm keeps the duty and answers the
# separate question of whether the density figure survives a real tool cost.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=./lib-vm.sh
source ./lib-vm.sh

# Final review fix, round 2, item 1: pin the locale here in the driver rather than inside
# lib-vm.sh's helpers -- a future caller of now_ms/load1 that forgets this line would otherwise
# inherit the bug silently. Under a comma-radix locale (e.g. de_DE.UTF-8), bash's own
# EPOCHREALTIME and this platform's `uptime` load-average both render with a comma, not a dot:
# now_ms's `${t/./}` strip is then a no-op, `${t:0:-3}` yields a comma-containing string, and
# `$(($(now_ms) - t0))` below raises a bash arithmetic error under `set -e`, ending the run at
# the first rung. load1 degrades more quietly -- its `sed | awk` pipeline hands back "0" instead,
# the exact value load1's own comment says must never appear, because a 0 there reads as "no
# contention" and would exonerate a box that was actually busy.
#
# LC_ALL=C, not the narrower LC_NUMERIC=C: verified empirically that LC_ALL, once present in the
# environment, unconditionally overrides LC_NUMERIC for numeric-category resolution regardless of
# which was exported more recently --
#   $ export LC_ALL=de_DE.UTF-8; export LC_NUMERIC=C; echo "$EPOCHREALTIME"
#   1789271691,872501   <- still comma-radix; LC_NUMERIC=C had no effect
# So a driver that merely set LC_NUMERIC=C would leave the bug open on any operator whose ambient
# environment exports LC_ALL (common in container base images and systemd environment files) --
# precisely the variable the directive's own reproduction used. Only overriding LC_ALL itself,
# from within this process, is robust against every ambient combination. The tradeoff (message/
# collation locale is pinned too, not just numeric formatting) is accepted deliberately: this
# script emits no user-facing message text that depends on locale, and `sort -n` in
# lib-vm.sh's percentile() is itself LC_COLLATE-sensitive, so pinning the whole locale removes a
# second, previously-undiscussed risk along with the first.
export LC_ALL=C

FAIL=0
RESULTS="${V_RESULTS:-./EXPERIMENTS.md}"

# --- live gate, BEFORE any trap ------------------------------------------------------------
# Installing the trap first would mean a SKIP runs cleanup against a system it never touched.
[ "${V_LIVE:-0}" = "1" ] || {
  echo "SKIP (set V_LIVE=1 to run E8 against a live VM supervisor)"
  exit 0
}

# TSX and require_tsx come from lib-vm.sh. The check happens here, after the live gate, so a
# V_LIVE=0 run SKIPs and exits 0 without ever testing for the tsx binary.
require_tsx

BASE="${V_BASE:-http://127.0.0.1:8080}"
# Telemetry lives on the loopback admin listener (SH_ADMIN_PORT, plan 1 Task 11), not on $BASE.
METRICS_BASE="${V_METRICS_BASE:-http://127.0.0.1:8081}"
LADDER="${V_LADDER:-1 2 4 8 16 32}"
DEGRADE_X="${V_DEGRADE_X:-2}"
MIN_C="${V_MIN_C:-4}"
TURNS_PER_RUNG="${V_TURNS_PER_RUNG:-30}"
# realism (default) keeps every existing precondition and every existing default: an operator who
# does not know about the arms gets exactly the run this driver has always done.
ARM="${V_ARM:-realism}"
case "$ARM" in
realism | capacity) ok "arm: $ARM" ;;
*)
  ko "V_ARM='$ARM' is not one of §5.2's two arms (realism, capacity)"
  exit 1
  ;;
esac
BASIS="${V_DUTY_BASIS:-e6-ocp}"
# The capacity arm's utilisation ceiling, in percent of the sandbox tier's own capacity (§5.2). ~25%
# leaves the tier demonstrably non-binding: the published calibrated run sat at 78% and its tail came
# from there, not from the workers.
SANDBOX_UTIL_CEILING_PCT="${V_SANDBOX_UTIL_CEILING_PCT:-25}"
# How far the two caps must clear the ladder's top rung before the capacity arm will run. 2x, so a
# knee found at the top rung cannot be the cap: at 1x the cap binds exactly where the ladder looks.
CAP_HEADROOM_X="${V_CAP_HEADROOM_X:-2}"
# What counts as a "fast" stub profile, i.e. one whose turn duration approximates the harness's own
# cost rather than a programmed sleep. One definition, used in BOTH directions by
# assert_arm_stub_profile, so "capacity" and "not realism" can never drift apart.
CAPACITY_MAX_TTFT_MS="${V_CAPACITY_MAX_TTFT_MS:-25}"
CAPACITY_MAX_TOKEN_DELAY_MS="${V_CAPACITY_MAX_TOKEN_DELAY_MS:-2}"
# Worker-tier CPU utilisation (percent of this box's cores) at or above which a knee is attributed to
# real worker CPU rather than to anything else. 80%, deliberately short of 100: a tier does not need
# every core saturated to knee, because scheduling delay grows well before the last cycle is spent.
WORKER_CPU_BOUND_PCT="${V_WORKER_CPU_BOUND_PCT:-80}"
# Measured sandbox-tier utilisation at or above which the lease pool may be convicted as the bound. A
# lease saturation over its threshold is not enough on its own: that metric is leases per sandbox and a
# healthy run crosses it routinely, which is how a tier measured 5.5% busy was once named the bound.
SANDBOX_BOUND_PCT="${V_SANDBOX_BOUND_PCT:-50}"
# Optional. Unset means the memory bound is never attributed, rather than attributed against a
# number nobody chose: "RSS looked high" is not a budget, and how much RSS is too much depends
# on what else the VM runs. Set it to the per-worker RSS you are actually willing to pay for.
RSS_BUDGET_BYTES="${V_RSS_BUDGET_BYTES:-0}"
WORKERS="${SH_WORKERS:?SH_WORKERS must name the worker count this supervisor was started with}"
# No default, deliberately (§3.8): S is the per-worker cap on in-flight turns, and its right
# value is an OUTPUT of this experiment. A default here would quietly answer the question E8 asks.
TURNS_PER_WORKER="${SH_TURNS_PER_WORKER:?SH_TURNS_PER_WORKER must be set to the S this supervisor was started with}"
# Final review fix, part 3, item A: the stub this supervisor's ANTHROPIC_BASE_URL actually points
# at is a separate long-lived process, configured by ITS OWN env at ITS OWN boot -- this driver's
# own SH_STUB_* environment (if any) has no causal connection to it. No default: a wrong URL here
# would make stub_profile below either hang against nothing or, worse, quietly succeed against
# some OTHER stub, which is precisely the fabrication path this item exists to close.
# No apostrophe in this message: shellcheck cannot parse one inside a ${VAR:?msg} expansion
# (SC1073/SC1072 -- verified empirically, not a style nit) -- it reads the apostrophe as opening
# a single-quoted string and aborts parsing the rest of the file.
STUB_URL="${V_STUB_URL:?V_STUB_URL must be the model stub URL this supervisors ANTHROPIC_BASE_URL points at, so this driver can fetch /profile from the stub actually driving the run (see deploy/knative/model-stub/README.md)}"

# Final review fix, part 3, item B2: derived (not declared) from $BASE — see generator_placement's
# comment in lib-vm.sh. Recorded once per run, in the run summary below, not per rung.
GENERATOR_PLACEMENT="$(generator_placement "$BASE")"
# Final review fix, round 2, item 4b: recorded once per run, alongside placement, so
# contention_load1 (recorded per rung below) has the denominator a reader needs to normalise it
# (load1 / cores) — see core_count's comment in lib-vm.sh.
#
# THIS IS THE GENERATOR'S CORE COUNT, and it may only be used to normalise contention_load1, which is
# also generator-side. It is NOT the denominator for anything measured on the target: on the required
# topology the generator is a different and smaller box (4 cores against the target's 8 in the published
# runs), so dividing the target's worker CPU by this number inflates the result by the ratio between the
# two machines, and would fire the worker-CPU attribution at half the real utilisation.
CORE_COUNT="$(core_count)"
# The TARGET's core count, published by the supervisor itself (packages/supervisor/src/admin.ts) — the
# same box the worker CPU is measured on. "NaN" against a supervisor whose /metrics predates the field,
# in which case worker_cpu_util stays NaN and the worker-CPU attribution simply cannot fire: an
# unmeasurable denominator must not be substituted with a plausible one. A dead supervisor also reads
# NaN here, and the /health check below is what reports that.
TARGET_CORES="$(worker_metrics "$METRICS_BASE" | jq -r '.cores // "NaN"' 2>/dev/null || echo NaN)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== E8 density: W=$WORKERS S=$TURNS_PER_WORKER basis=$BASIS ladder='$LADDER' =="
echo "generator: $GENERATOR_PLACEMENT (derived from \$BASE=$BASE; loopback means on-box — see EXPERIMENTS.md)"
echo "cores on this box (the GENERATOR): $CORE_COUNT — the denominator for contention_load1 only"
echo "cores on the TARGET (as the supervisor reports them): $TARGET_CORES — the denominator for worker_cpu_util"

# --- refuse to measure something meaningless -----------------------------------------------
# detectKnee throws 'detectKnee: no c=1 baseline point' without this rung. Checking here costs
# nothing; discovering it after an hour of measurement costs the run.
case " $LADDER " in
*" 1 "*) ok "ladder includes the c=1 baseline rung" ;;
*)
  ko "ladder '$LADDER' has no c=1 baseline rung; detectKnee will throw"
  exit 1
  ;;
esac

# Resolve the duty basis and the sandbox floor it implies — one row, taken whole (§2.3).
# describe_duty_basis (lib-vm.sh) is the basis-VALIDATION half, shared with e9-tiers.sh;
# duty_basis_sandbox_floor stays here (e8-density.sh-only) — see its comment in lib-vm.sh for
# why that half is not lifted for E9.
#
# Per-arm (§5.4 as amended). The realism arm takes a §2.3 ROW and is gated on the floor that row
# implies. The capacity arm takes NO row, deliberately — its workload is a trivial exec, and pinning
# it to a duty band would mean calibrating the sandbox cost this arm exists to remove. Which makes
# the record's wording load-bearing: "none (capacity arm)" is a chosen basis, distinct from a basis
# field left blank, exactly as `check_sandbox_floor` keeps an unobserved pool distinct from an empty
# one. A blank would read as "nobody recorded it"; this says "this arm has no row, on purpose".
if [ "$ARM" = capacity ]; then
  DUTY_BASIS_DESC="none (capacity arm: sandbox tier held non-binding; no §2.3 row applies)"
  SANDBOX_FLOOR="n/a"
  echo "duty_basis: $DUTY_BASIS_DESC"
  echo "sandbox precondition: measured utilisation ceiling <= ${SANDBOX_UTIL_CEILING_PCT}% (no pool floor)"
else
  DUTY_BASIS_DESC="$(describe_duty_basis "$BASIS")"
  SANDBOX_FLOOR="$(duty_basis_sandbox_floor "$BASIS" "$WORKERS" "$TURNS_PER_WORKER")"
  echo "duty_basis: $DUTY_BASIS_DESC"
  echo "sandbox floor for W=$WORKERS S=$TURNS_PER_WORKER: K >= $SANDBOX_FLOOR"
fi

# The floor check itself is DEFERRED to just after the c=1 rung (see check_sandbox_floor below).
# It used to live here as `podman ps | grep -c '^sh-sandbox-'`, which was wrong twice over, and
# only one of the two was obvious:
#
#   1. It described whatever box the DRIVER ran on. setup-vm.sh starts every container under root
#      podman, so a driver run as a normal user counted 0 with three containers up; and off-box —
#      the placement B4 and §8 require — it enumerates the GENERATOR's containers, which hold no
#      sandboxes at all, so the gate could never pass on the required topology.
#   2. It counted the wrong QUANTITY. What can be leased is a presence record, not a container: on
#      hardware, three healthy `sh-sandbox-*` containers sat alongside an EMPTY record set because
#      the image carried no relay leaf. A container count would have passed this gate against a
#      pool of zero — precisely the run this gate exists to refuse.
#
# So the count now comes from the supervisor's own /metrics `sandbox_pool_size`, which is the pool
# as the selection path itself last saw it. That number does not exist until a turn has leased,
# which is why the check waits for c=1 — and why "not yet observed" must stay distinct from 0.
SANDBOX_COUNT="unknown"
# The per-sandbox lease cap, read from the supervisor rather than from this shell: it sets the scale
# `lease_saturation` saturates at, so a record that names the saturation without the cap cannot be
# read. "NaN" when the supervisor does not echo it (an older build whose ENV_ALLOWLIST predates it).
SANDBOX_CAP="NaN"

check_sandbox_floor() {
  local size body
  body="$(curl -sf --max-time 5 "$METRICS_BASE/metrics" 2>/dev/null)" || body=""
  size="$(printf '%s' "$body" | jq -r '.sandbox_pool_size // "NaN"' 2>/dev/null)" || size="NaN"
  # One fetch serves both: the cap is only ever read here, beside the size it scales.
  SANDBOX_CAP="$(printf '%s' "$body" | jq -r '.env.KAGENTI_SANDBOX_CAP // "NaN"' 2>/dev/null)" ||
    SANDBOX_CAP="NaN"
  SANDBOX_COUNT="$size"
  if [ "$size" = "NaN" ] || [ "$size" = "null" ] || ! [ "$size" -eq "$size" ] 2>/dev/null; then
    # Never observed. Not the same as an empty pool, and not something to shrug at either: after a
    # successful c=1 rung a turn HAS selected, so an unobserved pool means the turn never went
    # through pool selection at all — which is exactly the /turn-ran-tools-locally defect this rig
    # was blind to before. Refuse rather than measure a run with no hands tier.
    ko "sandbox pool size unreported by $METRICS_BASE/metrics after a live c=1 rung — the turn did not go through pool selection (tools may be running in the worker itself)"
    exit 1
  fi
  # Everything above this line applies to BOTH arms and must stay that way: a turn that bypassed pool
  # selection is the same defect whichever arm is running, and in a trivial-exec arm it is nearly
  # invisible by construction, so the capacity arm needs this refusal MORE, not less.
  #
  # The floor comparison is where the arms part. It asserts the pool is big ENOUGH for the duty; the
  # capacity arm asserts the opposite direction (a sandbox tier doing almost nothing), which is a
  # measured quantity rather than a predicted one and is therefore checked per rung against real CPU
  # by assert_sandbox_ceiling below — not here, and not from a duty this arm does not have.
  if [ "$ARM" = capacity ]; then
    ok "sandbox pool observed with $size leasable sandboxes (capacity arm: no floor; the utilisation ceiling is checked per rung)"
    return 0
  fi
  if [ "$size" -lt "$SANDBOX_FLOOR" ]; then
    # Do NOT proceed. Turns would queue on lease acquisition, and lease waits on a rung look
    # exactly like the worker tier saturating — the knee would be attributed to the wrong bound.
    ko "sandbox pool has $size leasable sandboxes, floor is $SANDBOX_FLOOR (SH_SANDBOX_COUNT=$SANDBOX_FLOOR ./setup-vm.sh)"
    exit 1
  fi
  ok "sandbox pool satisfies the floor ($size >= $SANDBOX_FLOOR, from the supervisor's own view)"
}

curl -sf --max-time 5 "$BASE/health" >/dev/null || {
  ko "no supervisor answering at $BASE"
  exit 1
}

# Final review fix, round 2, item 2 (BLOCKING, C4 Path A): before trusting $STUB_URL's /profile
# below, confirm THIS supervisor's own ANTHROPIC_BASE_URL actually points at it — see
# assert_stub_pinned's comment in lib-vm.sh for the fabrication path this closes (an operator
# pointing the supervisor at a different, unmeasured stub than the one $STUB_URL names). Placed
# after the /health check (a dead supervisor should fail with that message, not this one) and
# before stub_profile (no point fetching a profile this run cannot causally attribute anyway).
assert_stub_pinned "$METRICS_BASE" "$STUB_URL" "E8 supervisor"

# Final review fix, part 3, item A3: fetch the stub's OWN resolved profile rather than trust this
# driver's environment. stub_profile (lib-vm.sh) hard-fails (exit 1) if the stub is unreachable
# or returns something that is not valid JSON -- a run whose profile cannot be established is not
# a result, same principle as require_live_arm above.
STUB_PROFILE_JSON="$(stub_profile "$STUB_URL")"
STUB_TTFT="$(printf '%s' "$STUB_PROFILE_JSON" | jq -r '.ttftMs')"
STUB_TOKEN_DELAY="$(printf '%s' "$STUB_PROFILE_JSON" | jq -r '.tokenDelayMs')"
STUB_TOKENS="$(printf '%s' "$STUB_PROFILE_JSON" | jq -r '.outputTokens')"
STUB_TOOL_RATE="$(printf '%s' "$STUB_PROFILE_JSON" | jq -r '.toolCallRate')"
echo "model stub profile (from $STUB_URL/profile, as resolved at the stub's own boot): $STUB_PROFILE_JSON"

# assert_stub_pinned above proved this supervisor points at the stub whose profile we just read. This
# proves the PROFILE is the one this arm claims to be measuring (issue #254 item 2c) — the same
# fabrication path one level in. Without it an arm can be labelled "capacity" while measuring the
# 300/12/64 stub, whose programmed wait was ~1.42s of the calibrated run's 1.537s turn: the ladder
# would then report how well the harness hides a fixed sleep, top out at the admission cap, and carry
# the word "capacity" on it. Refuses in both directions, off one shared definition of "fast".
assert_arm_stub_profile "$ARM" "$STUB_PROFILE_JSON" \
  "$CAPACITY_MAX_TTFT_MS" "$CAPACITY_MAX_TOKEN_DELAY_MS"

# --- the capacity arm's caps must not be what the ladder finds (issue #254 item 2d) ----------
# Both caps are read from the supervisor's own /metrics, not from this shell: W and S come from the
# env the supervisor was STARTED with (already asserted above by their ${VAR:?} guards), and the
# lease cap is the supervisor's own echoed KAGENTI_SANDBOX_CAP. The pool size is not known until a
# turn has leased, so the lease half of the headroom check is completed after the c=1 rung, beside
# the pool-size checks that share that constraint.
TOP_RUNG="${LADDER##* }"
# A trailing space in V_LADDER (easy to paste) makes this EMPTY, and an empty top rung is quietly
# corrosive rather than loud: `assert_capacity_headroom "" 8 ...` compares `8 >= "" * 2` -> `8 >= 0`
# and passes, so the headroom gate stops guarding anything; and `[ "$KNEE" = "$TOP_RUNG" ]` below can
# never match, so a ladder that reached its top rung is reported as `saturated=yes` -- a knee
# presented as the machine's limit when it is the ladder's.
case "$TOP_RUNG" in
'' | *[!0-9]*)
  ko "the ladder's top rung reads '$TOP_RUNG' (V_LADDER='$LADDER'): not a positive integer, so neither the cap-headroom check nor the saturated/not-saturated verdict can be trusted. Check for a trailing space"
  exit 1
  ;;
esac
[ "$TOP_RUNG" -gt 0 ] || {
  ko "the ladder's top rung is $TOP_RUNG; a rung must offer at least one concurrent turn"
  exit 1
}
ADMITTED="$((WORKERS * TURNS_PER_WORKER))"
if [ "$ARM" = capacity ]; then
  # Admission half first, because it needs nothing live: a ladder whose top rung is its own admission
  # cap can only ever report `not-observed`, which is what two published zero-duty runs did at c=64.
  assert_capacity_headroom "$TOP_RUNG" "$ADMITTED" unknown "$CAP_HEADROOM_X"
fi

# What the per-rung record's `duty_basis` field says. "none (capacity arm)" is a CHOSEN value, not a
# blank: §2.3 as amended requires that "no basis" and "basis unrecorded" stay distinguishable, the
# same distinction check_sandbox_floor already makes between an unobserved pool and an empty one.
if [ "$ARM" = capacity ]; then
  BASIS_FIELD="none (capacity arm)"
else
  BASIS_FIELD="$BASIS"
fi

BODY="${V_BODY:-{\"prompt\":\"summarise the diff\"}}"
POINTS='[]'
RECORDS='[]'

for C in $LADDER; do
  echo "-- rung c=$C"
  # Truncate raw.$C, not lat.$C/code.$C: raw.$C is the file the loop below APPENDS to
  # (>>), so a repeated rung value in $LADDER (e.g. "1 2 2 4") would otherwise accumulate
  # both c=2 runs' output into one file. lat.$C and code.$C are each fully OVERWRITTEN
  # further down (the awk and cut lines both redirect with a plain >), so truncating them
  # here was dead code — round 2 minor item: removed the two dead truncations, added the
  # one that was missing.
  : >"$WORK/raw.$C"

  CPU0="$(sandbox_cpu_seconds)"
  # Worker-side counterpart (issue #254 item 2e). Cumulative CPU seconds per worker, summed across
  # the pool: differenced across the rung and divided by the turns actually served, this is per-turn
  # worker CPU — the metric whose absence made the first published knee ambiguous between "the worker
  # tier is full" and "the stub is slow". Summed here rather than per worker because the rung's
  # denominator (turns served) is pool-wide; the per-worker readings stay in the record separately.
  WCPU0="$(worker_cpu_seconds "$METRICS_BASE")"
  T0="$(now_ms)"

  # C concurrent virtual sessions, TURNS_PER_RUNG turns each. vm_turn (lib-vm.sh) opens one
  # curl connection per turn, not one per session. That is harmless here: both drivers leave
  # SH_ROUTING_POLICY at its leastInFlight default (deploy/vm/env/supervisor.env.example:7),
  # under which routing decides per REQUEST, not per session, so there is no session affinity
  # in play for a per-turn connection to defeat. This records what the driver actually does
  # (conns_per_turn: 1 below), not a knob — exercising stickyBySession's session affinity is a
  # separate, not-yet-covered gap, not something this rung loop measures.
  for i in $(seq 1 "$C"); do
    (
      for _ in $(seq 1 "$TURNS_PER_RUNG"); do
        vm_turn "$BASE" "e8-c$C-s$i" "$BODY"
      done
    ) >>"$WORK/raw.$C" &
  done
  wait

  WALL_MS="$(($(now_ms) - T0))"
  cut -f2 "$WORK/raw.$C" >"$WORK/code.$C"

  OK_N="$(grep -c '^200$' "$WORK/code.$C" || true)"
  ATTEMPTS="$(wc -l <"$WORK/code.$C" | tr -d ' ')"

  # Hard-fail HERE, before any further rung runs, on a dead arm — see lib-vm.sh's
  # require_live_arm for why (shared with e9-tiers.sh's run_arm, so neither driver can drift
  # out of sync with this check by omission). Unlike run_arm's own local work dir, $WORK here is
  # cleaned up by the EXIT trap installed above, so no cleanup is needed before this call.
  require_live_arm "$C" "$OK_N" "e8" "$BASE"

  # Sandbox-pool floor, checked once, immediately after the FIRST rung. It has to come after a
  # live rung because the supervisor learns its pool size from a worker's own selection, and it has
  # to come before any further rung because a pool below the floor makes every later rung's knee
  # attributable to lease queuing rather than to the tier it will be blamed on. require_live_arm
  # above guarantees this rung actually answered, so an unreported size here is a real signal
  # (no pool selection happened) rather than a race.
  if [ "$SANDBOX_COUNT" = "unknown" ]; then
    check_sandbox_floor
    # The deferred half of the capacity arm's headroom check (see assert_capacity_headroom): the pool
    # size does not exist until a turn has leased, and `pool x KAGENTI_SANDBOX_CAP` is the number of
    # concurrent leases available. A lease is held per SESSION, not per exec — the run with the
    # shipped cap of 4 proved it: 3 sandboxes x 4 = 12 leases yielded exactly 360 successes at two
    # consecutive rungs (12 sessions x 30 turns each) with throughput pinned at 12 / 1.15s, a run
    # that measured the lease pool and would have been published as a VM density figure had the
    # success-rate floor not caught it. So the quantity that must clear the top rung is leases
    # against concurrent SESSIONS, which is what the ladder's c is.
    if [ "$ARM" = capacity ]; then
      # Any non-integer cap, not just the "NaN" this driver substitutes when the field is absent: the
      # value is whatever string the supervisor has in its environment, and `$((...))` on a
      # non-numeric one aborts the run under `set -e` with a bash arithmetic error instead of a
      # diagnosis. Refuse with the reason, and name both remedies.
      case "$SANDBOX_CAP" in
      '' | *[!0-9]*)
        ko "capacity arm: the supervisor reports KAGENTI_SANDBOX_CAP='$SANDBOX_CAP', which is not an integer, so the lease ceiling cannot be established and leases could silently become this ladder's cap (fix the supervisor env, or run V_ARM=realism)"
        exit 1
        ;;
      esac
      assert_capacity_headroom "$TOP_RUNG" "$ADMITTED" \
        "$((SANDBOX_COUNT * SANDBOX_CAP))" "$CAP_HEADROOM_X"
    fi
  fi

  # Percentiles are computed over 200-coded rows ONLY. A latency sample that mixes fast
  # failures (a refused or errored request returns in a fraction of a real response's time)
  # with genuine responses is not a latency distribution: sorted ascending, the failures pile
  # up at the bottom, so the naive p95 over ALL rows is really the successes' own
  # (0.95-f)/(1-f) quantile, where f is the failure fraction — at f=0.5 that quietly reports
  # the successes' p90 labelled p95. See the synthetic demonstration in task-3-report.md.
  awk -F'\t' '$2==200{print $1}' "$WORK/raw.$C" >"$WORK/lat.$C"

  SPURIOUS_429="$(grep -c '^429$' "$WORK/code.$C" || true)"
  P50="$(percentile 50 <"$WORK/lat.$C")"
  P95="$(percentile 95 <"$WORK/lat.$C")"
  # The ternary MUST stay parenthesised: gawk (the system awk on Ubuntu/Amazon Linux, i.e. every
  # VM this driver is meant to run on) rejects `printf "fmt", cond ? a : b` outright --
  #   awk: cmd. line:1: BEGIN {printf "%.3f", ms>0 ? n*1000/ms : 0}
  #   awk: cmd. line:1:                            ^ syntax error
  # -- because the `?` is ambiguous inside printf's argument list, while macOS's BWK awk accepts
  # it. Unparenthesised, this aborted the run at the FIRST rung under `set -e` on real hardware
  # and was invisible to every test on a Mac. Same fix applies at e9-tiers.sh's identical site.
  THROUGHPUT="$(awk -v n="$OK_N" -v ms="$WALL_MS" 'BEGIN {printf "%.3f", (ms>0 ? n*1000/ms : 0)}')"

  # General success-rate floor (deploy/vm/EXPERIMENTS.md): unlike the SPURIOUS_429-only WARN
  # below, this fires on ANY failure mode — a 500/503/000 storm produces no field and no
  # warning today, and throughput saturates at the arm's real capacity regardless of which
  # status code did the refusing, so a heavily-failing rung can read healthy on both the
  # throughput and (percentile-filtered) latency criteria. 0.95 is this driver's floor; see the
  # report for why.
  if awk -v n="$OK_N" -v a="$ATTEMPTS" 'BEGIN {exit !(a>0 && n/a<0.95)}'; then
    echo "WARN rung c=$C succeeded on only $OK_N/$ATTEMPTS requests (below the 0.95 success-rate floor, see EXPERIMENTS.md) — this rung is not a capacity result"
  fi

  M1="$(worker_metrics "$METRICS_BASE")"
  LOOP_LAG_P99="$(printf '%s' "$M1" | jq -c '[.workers[]?.loop_lag_p99_ms // "NaN"]')"
  # The lag column's own denominator. Three published runs read 10.3-11.6ms at EVERY rung including
  # c=1 on a nearly idle tier; measured against this sampler shape, that is the histogram's
  # RESOLUTION FLOOR rather than delay (resolution 10 idles at 15.7-21.6ms; resolution 1 at
  # 1.9-6.4ms, and both move to ~50-57ms under a deliberately blocked loop). So a lag reading is
  # unreadable without the resolution it was sampled at, and the record now carries both.
  LAG_RESOLUTION_MS="$(printf '%s' "$M1" | jq -r '.lag_resolution_ms // "NaN"')"
  RSS_BYTES="$(printf '%s' "$M1" | jq -c '[.workers[]?.rss_bytes // "NaN"]')"
  FILE_OP_MS="$(printf '%s' "$M1" | jq -r '.file_op_p95_ms // "NaN"')"
  OVER_ADMISSION="$(printf '%s' "$M1" | jq -r '.counters.over_admission // "NaN"')"
  # Refusals the supervisor's own next `load` convicted as unnecessary. Distinct from
  # spurious_429 below: that one is what the CLIENT saw and is what truncates a rung; this one
  # is what attributes those 429s to IPC staleness rather than to genuine saturation.
  REFUSALS_CONVICTED="$(printf '%s' "$M1" | jq -r '.counters.spurious_refusals // "NaN"')"
  LEASE_SATURATION="$(printf '%s' "$M1" | jq -r '.lease_saturation // "NaN"')"
  # Both deltas read NaN, never 0, when either endpoint was unmeasurable — `cpu_delta` (lib-vm.sh)
  # exists so that an off-box generator (which sees no podman) cannot produce a confident zero here.
  # A zero sandbox delta would clear the capacity arm's utilisation ceiling vacuously, i.e. the one
  # reading that exonerates precisely the run the ceiling exists to refuse.
  SANDBOX_CPU="$(cpu_delta "$CPU0" "$(sandbox_cpu_seconds)")"
  WORKER_CPU="$(cpu_delta "$WCPU0" "$(worker_cpu_seconds "$METRICS_BASE")")"
  # Utilisation of each tier over this rung's own wall clock. The sandbox denominator is
  # containers x wall (one container = one sandbox-equivalent, the unit §2.3's duty is expressed in);
  # the worker denominator is cores x wall, because the worker tier is bounded by the box's CPUs.
  # NOTE the two sides count slightly different things, and it is worth knowing which: the numerator is
  # the CPU of the `sh-sandbox-*` CONTAINERS, while $SANDBOX_COUNT is the supervisor's
  # `sandbox_pool_size` — leasable presence RECORDS, which pool.ts documents as explicitly not a
  # container count. They coincide in a healthy pool (3 records, 3 containers, as in every run to date)
  # and diverge exactly when something is wrong: a container with no relay leaf has no record, so the
  # denominator shrinks while the numerator does not, and the utilisation reads HIGH — which fails the
  # ceiling. That is the safe direction for a gate to be wrong in, so it is recorded rather than
  # re-plumbed; the pool-never-observed refusal above catches the pathological case first.
  SANDBOX_UTIL="$(cpu_utilisation "$SANDBOX_CPU" "$WALL_MS" "$SANDBOX_COUNT")"
  # Two denominators, deliberately. WORKER_CPU_UTIL is against the worker tier's OWN ceiling: each
  # worker is one Node event loop and cannot exceed one core, so W workers cannot exceed min(W, cores).
  # That is the figure a saturation threshold can be set against. WORKER_CPU_UTIL_BOX is against the
  # box, which is what a reader needs for sizing ("half the machine was idle") and is NOT a saturation
  # signal when W < cores.
  WORKER_TIER_CORES="$(awk -v w="$WORKERS" -v c="$TARGET_CORES" 'BEGIN {
    if (c !~ /^[0-9]+$/) { print w; exit }
    print (w < c ? w : c)
  }')"
  WORKER_CPU_UTIL="$(cpu_utilisation "$WORKER_CPU" "$WALL_MS" "$WORKER_TIER_CORES")"
  WORKER_CPU_UTIL_BOX="$(cpu_utilisation "$WORKER_CPU" "$WALL_MS" "$TARGET_CORES")"
  # A worker that served turns cannot really have consumed zero CPU, so a 0.00 delta here is a
  # SAMPLING artefact, not a reading: workers report stats on an interval (SH_STATS_INTERVAL_MS,
  # default 1000ms), and a rung shorter than one interval can see the same stats message at both ends.
  # Most likely at c=1 against the fast stub -- i.e. exactly the baseline rung every other rung is
  # compared against. Recording it as 0 would be the same "confident zero" this change refuses for the
  # sandbox tier, so it reads NaN and says why.
  if [ "$WORKER_CPU" = "0.00" ] && [ "$OK_N" -gt 0 ]; then
    echo "WARN rung c=$C: the worker CPU delta was 0.00 over ${WALL_MS}ms — shorter than a stats interval (SH_STATS_INTERVAL_MS, default 1000ms), so both samples are likely the same report. Recorded as unmeasured; raise V_TURNS_PER_RUNG if per-turn worker CPU matters at this rung"
    WORKER_CPU=NaN
    WORKER_CPU_UTIL=NaN
  fi
  WORKER_CPU_MS_PER_TURN="$(awk -v c="$WORKER_CPU" -v n="$OK_N" 'BEGIN {
    if (c !~ /^-?[0-9]+([.][0-9]+)?$/ || n+0 <= 0) { print "NaN"; exit }
    printf "%.1f\n", 1000 * c / n
  }')"

  # Final review fix, part 3, item B3: contention proxy, read fresh at the end of THIS rung (not
  # once per run) so a rung that drove load up shows it at the rung it happened, not smeared
  # across the whole run. See load1's comment in lib-vm.sh for why this is 1-minute load average.
  CONTENTION_LOAD1="$(load1)"

  # A 429 storm is the dangerous reading: refusals shorten a rung's completed work, so
  # throughput flattens and the ladder reports a knee that is an admission-control artefact
  # rather than a machine limit (§3.9). Say so at the rung, not in a post-mortem.
  if [ "$SPURIOUS_429" -gt 0 ]; then
    echo "WARN rung c=$C saw $SPURIOUS_429 refusals (429); S=$TURNS_PER_WORKER may be under-set — a knee here is suspect"
  fi

  POINTS="$(printf '%s' "$POINTS" | jq -c \
    --argjson c "$C" --argjson t "$THROUGHPUT" --argjson p "$P95" \
    '. + [{c: $c, throughput: $t, p95Ms: $p}]')"
  RECORDS="$(printf '%s' "$RECORDS" | jq -c \
    --argjson c "$C" --argjson t "$THROUGHPUT" --argjson p50 "$P50" --argjson p95 "$P95" \
    --argjson lag "$LOOP_LAG_P99" --argjson rss "$RSS_BYTES" \
    --arg fop "$FILE_OP_MS" --arg scpu "$SANDBOX_CPU" --arg lease "$LEASE_SATURATION" \
    --arg over "$OVER_ADMISSION" --arg recon "$REFUSALS_CONVICTED" \
    --argjson s429 "$SPURIOUS_429" --arg basis "$BASIS_FIELD" \
    --argjson attempts "$ATTEMPTS" --argjson ok_n "$OK_N" \
    --arg load1 "$CONTENTION_LOAD1" --arg arm "$ARM" \
    --arg sutil "$SANDBOX_UTIL" --arg wcpu "$WORKER_CPU" \
    --arg wutil "$WORKER_CPU_UTIL" --arg wper "$WORKER_CPU_MS_PER_TURN" \
    --arg wutilbox "$WORKER_CPU_UTIL_BOX" --arg wtier "$WORKER_TIER_CORES" \
    --arg lagres "$LAG_RESOLUTION_MS" \
    '. + [{c: $c, arm: $arm, throughput: $t, p50Ms: $p50, p95Ms: $p95,
           loop_lag_p99: $lag, lag_resolution_ms: $lagres,
           rss_bytes: $rss, file_op_ms: $fop, sandbox_cpu: $scpu, sandbox_util: $sutil,
           worker_cpu_s: $wcpu, worker_cpu_util: $wutil, worker_cpu_ms_per_turn: $wper,
           worker_cpu_util_box: $wutilbox, worker_tier_cores: $wtier,
           lease_saturation: $lease, over_admission: $over, spurious_refusals: $recon,
           spurious_429: $s429, conns_per_turn: 1, duty_basis: $basis,
           attempts: $attempts, ok_n: $ok_n, contention_load1: $load1}]')"

  # The capacity arm's precondition, evaluated at EVERY rung against measured CPU. Not once at c=1:
  # sandbox load grows with offered concurrency, so a c=1 check alone would clear a ladder that
  # crosses the ceiling at its top rung — exactly the published run's shape (2.4% of the tier at c=1
  # against 78% at c=32).
  #
  # Deliberately the LAST thing in the rung: it refuses by exiting, and the numbers that explain the
  # refusal are in this rung's own record. Checking before the record was assembled would have thrown
  # them away and left the operator with a percentage and nothing to check it against — so the rung is
  # echoed first, then judged.
  if [ "$ARM" = capacity ]; then
    printf 'rung record: %s\n' "$(printf '%s' "$RECORDS" | jq -c '.[-1]')"
    assert_sandbox_ceiling "$SANDBOX_UTIL" "$SANDBOX_UTIL_CEILING_PCT" "c=$C"
  fi
done

# --- knee ----------------------------------------------------------------------------------
# Rungs below the 0.95 success-rate floor are TRUNCATED before the knee is computed, because
# EXPERIMENTS.md's contract is that such a rung "is not a capacity result and must not be quoted as
# one" -- and the knee IS the quote. Warning about it and then selecting it anyway is the same
# defect the WARN was added to catch, one level up.
#
# Observed on the first authoritative run: c=16 succeeded on 360/480 (0.75) and c=32 on 360/960
# (0.38), yet knee_floor came back 16. Neither criterion can catch that by construction -- the
# filtered p95 excludes every failure, so it stayed flat at ~1420ms on EVERY rung, and throughput
# plateaus at whatever the arm completed (10.4/s, the lease pool's ceiling) rather than falling. So
# a 25%-failing rung read healthy on both, exactly as EXPERIMENTS.md's own prose predicts.
#
# Truncate rather than filter out: failures grow with offered load, so below-floor rungs are a
# suffix of the ladder, and dropping one from the middle would hand detectKnee a non-contiguous
# series its patience window cannot interpret. Truncating says the honest thing instead -- the
# ladder cannot see past its last capacity result, which is the same shape as GC8's "a knee is a
# floor, never a ceiling".
# The success counts live in $RECORDS, not in $POINTS: this driver keeps TWO parallel arrays -- the
# lean {c, throughput, p95Ms} that detectKnee consumes, and the full per-rung record written to the
# results file. They are appended in lockstep, one entry per rung in ladder order, so an index found
# in one addresses the same rung in the other. Reading .attempts off $POINTS instead yields null,
# `null > 0` is false, and the ladder truncates at its FIRST rung -- which is exactly what this code
# did on its first run, refusing a healthy c=1 as "below the success floor".
CUT_INDEX="$(printf '%s' "$RECORDS" | jq -r '
  (map((.attempts // 0) > 0 and ((.ok_n // 0) / (.attempts // 1)) >= 0.95) | index(false)) as $i |
  if $i == null then -1 else $i end')"
if [ "$CUT_INDEX" = "-1" ]; then
  POINTS_FOR_KNEE="$POINTS"
  TRUNCATED_AT="none"
else
  POINTS_FOR_KNEE="$(printf '%s' "$POINTS" | jq -c --argjson i "$CUT_INDEX" '.[0:$i]')"
  TRUNCATED_AT="$(printf '%s' "$RECORDS" | jq -r --argjson i "$CUT_INDEX" '.[$i].c')"
fi
if [ "$TRUNCATED_AT" != "none" ]; then
  echo "NOTE ladder truncated at c=$TRUNCATED_AT for knee selection: that rung and every rung above it fell below the 0.95 success-rate floor, so they are not capacity results (EXPERIMENTS.md)"
fi
# A ladder whose FIRST rung is already below the floor leaves nothing to compute a knee from.
# require_live_arm only guarantees c=1 answered at all, not that it answered 95% of the time.
if [ "$(printf '%s' "$POINTS_FOR_KNEE" | jq -r 'length')" = "0" ]; then
  ko "every rung fell below the 0.95 success-rate floor — there is no capacity result to report"
  exit 1
fi

KNEE_JSON="$("$TSX" -e '
  import { detectKnee, sanityFloorPass } from "../../experiments/src/sharing.ts";
  const points = JSON.parse(process.argv[1]);
  const knee = detectKnee(points, Number(process.argv[2]), 2);
  console.log(JSON.stringify({ knee, pass: sanityFloorPass(knee, Number(process.argv[3])) }));
' "$POINTS_FOR_KNEE" "$DEGRADE_X" "$MIN_C")"
KNEE="$(printf '%s' "$KNEE_JSON" | jq -r .knee)"
PASS="$(printf '%s' "$KNEE_JSON" | jq -r .pass)"
[ "$PASS" = "true" ] || ko "knee floor $KNEE is below the sanity floor $MIN_C"

# TOP_RUNG was resolved before the ladder ran (it is an input to the capacity arm's headroom check).
SATURATED=yes
[ "$KNEE" = "$TOP_RUNG" ] && SATURATED=no

# --- which tier ran out (§5.7's "the bound observed at ...") --------------------------------
# §5.7's claim sentence names a tier, so the driver derives it from the rung's own telemetry
# instead of leaving it to whoever writes the sentence up later. The important branch is the
# last one: when nothing crossed a threshold the answer is `unattributed`, which is a true
# statement about the run. A guessed tier would put a cause into a document people cite, and
# `spurious_429` is checked FIRST because a truncated rung is not a tier bound at all — it is
# the knee reading early (§3.9).
#
# A tier is only attributed when the ladder actually FOUND a limit. With saturated=no the top rung
# was still healthy, so nothing ran out and there is no bound to name — attributing one anyway is
# how a run that degraded nowhere acquires a cause. Observed: at W=4 S=16 every rung answered
# 1920/1920 with p95 flat at 1420ms and loop lag flat at 11ms, and the run still reported
# `bound=sandbox-pool` because `lease_saturation` 1.33 cleared a 0.95 threshold — 1.33 leases per
# sandbox against a cap of 13, i.e. roughly a tenth of the pool, named as the binding constraint.
# The scale mismatch behind that threshold is recorded separately; this branch is independent of it,
# because with nothing saturated no threshold should be consulted at all.
BOUND_JSON='{ "tag": "not-observed", "prose": "not observed — the top rung was still healthy, so this ladder found no limit to attribute (extend V_LADDER, or raise W/S, to look further)" }'
if [ "$SATURATED" = yes ]; then
BOUND_JSON="$(printf '%s' "$RECORDS" | jq -c \
  --argjson knee "$KNEE" --argjson budget "$RSS_BUDGET_BYTES" \
  --argjson wcpu_pct "$WORKER_CPU_BOUND_PCT" \
  --argjson sbx_bound_pct "$SANDBOX_BOUND_PCT" '
  def num($x): if ($x | type) == "number" then $x else null end;
  def peak($a): [($a // [])[] | num(.)] | map(select(. != null))
                | if length == 0 then null else max end;
  (map(select(.c == 1)) | first) as $b |
  (map(select(.c <= $knee)) | last) as $k |
  (peak($k.loop_lag_p99)) as $lag | (peak($b.loop_lag_p99)) as $lag0 |
  if $k == null then
    { tag: "unattributed", prose: "unattributed (no rung at or below the knee)" }
  elif ($k.spurious_429 // 0) > 0 then
    { tag: "admission-control",
      prose: "admission control — \($k.spurious_429) refusals truncated the rung, so this knee reads early rather than marking a machine limit" }
  elif (($k.worker_cpu_util | tonumber?) // 0) >= $wcpu_pct then
    # MEASURED worker CPU. This is the attribution §5.2 lacked: with only lag and RSS, "the worker
    # tier is actually full" and "the stub is slow" produce identical records, and the first
    # published run was ambiguous between them at every rung.
    #
    # Checked FIRST of the tier branches -- ahead of the lease pool as well as the loop-lag ratio --
    # and that order is load-bearing rather than stylistic. lease_saturation is leases per SANDBOX
    # (held over pool size), so it saturates at KAGENTI_SANDBOX_CAP and not at 1.0, and its 0.95
    # threshold therefore fires at roughly ONE lease per sandbox. The capacity arm is required by its
    # own headroom gate to run concurrency well above the pool size, so that threshold is crossed at
    # every interesting rung: with the lease branch first, a rung at 93% worker CPU came back
    # attributed to `sandbox-pool`, and this metric could never win an attribution in the arm it was
    # built for. Measured CPU over cores x wall is a fraction of a real capacity, so unlike that
    # ratio it means what a reader assumes it means -- hence it goes first.
    #
    # No apostrophes in this comment: it sits inside a single-quoted jq program, where one would
    # terminate the quote and hand the rest of the file to bash as code.
    { tag: "worker-cpu",
      prose: "worker CPU — the worker tier ran at \($k.worker_cpu_util)% of the \($k.worker_tier_cores) cores its \($k.worker_cpu_util_box)%-of-box workers can occupy at the knee (\($k.worker_cpu_ms_per_turn)ms of CPU per turn served), so the tier is genuinely full rather than waiting on the model stub. Raise SH_WORKERS to buy more of the box" }
  elif (($k.lease_saturation | tonumber?) // 0) >= 0.95
        and (($k.sandbox_util | tonumber?) // 0) >= $sbx_bound_pct then
    # BOTH halves are required, and the second one is why. `lease_saturation` is leases per SANDBOX, so
    # it saturates at KAGENTI_SANDBOX_CAP rather than at 1.0 and its 0.95 threshold fires at roughly one
    # lease per sandbox — which a healthy run crosses constantly. Observed on hardware: a capacity arm
    # whose sandbox tier measured 5.5% busy at the knee was reported as `bound=sandbox-pool` on a
    # saturation of 1.81 (about 2% of a 16 x 86 lease capacity), and the record advised
    # "provision more containers" for a tier that was almost entirely idle. Now the measured CPU of the
    # tier has to agree before it can be convicted.
    { tag: "sandbox-pool",
      prose: "the sandbox lease pool (saturation \($k.lease_saturation), tier measured \($k.sandbox_util)% busy) — provision more containers and re-run before quoting this as a VM limit" }
  elif ($lag != null and $lag0 != null and $lag0 > 0 and ($lag / $lag0) >= 4) then
    { tag: "event-loop",
      prose: "the event loop — worst-worker p99 loop lag \($lag)ms against \($lag0)ms at c=1" }
  elif ($budget > 0 and (peak($k.rss_bytes) // 0) >= $budget) then
    { tag: "memory", prose: "memory — worst-worker RSS \(peak($k.rss_bytes)) bytes against the \($budget)-byte budget" }
  else
    { tag: "unattributed",
      prose: "unattributed — no tier crossed its threshold at the knee, so the bound is not identified by this run" }
  end')"
fi
BOUND_TAG="$(printf '%s' "$BOUND_JSON" | jq -r .tag)"
BOUND="$(printf '%s' "$BOUND_JSON" | jq -r .prose)"
[ "$BOUND_TAG" != unattributed ] ||
  echo "WARN bound unattributed: §5.2's columns did not identify a tier (all NaN? see plan 1 Task 11)"

echo "E8_RESULT arm=$ARM knee_floor=$KNEE degrade_x=$DEGRADE_X min_c=$MIN_C workers=$WORKERS s=$TURNS_PER_WORKER saturated=$SATURATED bound=$BOUND_TAG"

{
  echo ""
  echo "### E8 run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "- **Arm: $ARM.**"
  if [ "$ARM" = capacity ]; then
    echo "  - This number is an **UPPER BOUND on the supervisor + worker tier**, not a deployable"
    echo "    density. The sandbox tier was held deliberately non-binding and non-competing (a"
    echo "    trivial exec, measured utilisation ${SANDBOX_UTIL_CEILING_PCT}% ceiling enforced per rung), so a real"
    echo "    tool cost will bring it down. The deployable figure is the **realism** arm's, and"
    echo "    neither arm's number may be quoted as the other's."
    echo "  - The sandbox tier's OWN capacity is not this experiment's subject: that is P4 §7.2"
    echo "    (E10) and §7.3 (E11). E11 records \"lease saturation one tier up\" for the mirror-image"
    echo "    hazard — a harness-side refusal misread as a VM-tier limit."
  else
    echo "  - This is the **deployable** figure: sandbox-shaped by construction, measured against the"
    echo "    calibrated duty, and gated on the sandbox-pool floor that duty implies. It answers"
    echo "    \"does the density survive a real tool cost\", not \"how many turns can the harness"
    echo "    tier push\" — the capacity arm answers that one and its number is higher by"
    echo "    construction."
  fi
  echo "- **Concurrent in-flight turns sustained (floor): $KNEE** at W=$WORKERS, S=$TURNS_PER_WORKER."
  if [ "$SATURATED" = no ]; then
    echo "  - Top rung ($TOP_RUNG) was still healthy: this is the ladder's limit, **not the machine's**."
    echo "    Extend \`V_LADDER\` to find the machine's."
  fi
  echo "- Criterion: p95 within ${DEGRADE_X}x its own c=1 baseline, patience 2. Sanity floor $MIN_C: $PASS."
  echo "- **This is a turn-concurrency number, not a session count.** Sessions addressable is a"
  echo "  Redis capacity statement and is not measured here (§5.1)."
  echo "- duty_basis: $DUTY_BASIS_DESC"
  echo "- conns_per_turn: 1. Each vm_turn call is its own connection; harmless under"
  echo "  SH_ROUTING_POLICY=leastInFlight (the only policy either driver sets — routing decides"
  echo "  per request, not per session, so there is no session affinity here to preserve)."
  if [ "$ARM" = capacity ]; then
    echo "- Sandbox pool: $SANDBOX_COUNT leasable sandboxes, as reported by the supervisor's own"
    echo "  /metrics — presence records the selection path can actually lease, not a container count"
    echo "  on whichever box the driver happened to run on. **No pool floor applies to this arm**"
    echo "  (it takes no §2.3 row); the precondition is the opposite one, a measured utilisation"
    echo "  ceiling of ${SANDBOX_UTIL_CEILING_PCT}%, checked at EVERY rung against the \`sandbox_util\` column below."
    echo "- Admission and lease caps were both required to clear the top rung ($TOP_RUNG) by"
    echo "  ${CAP_HEADROOM_X}x before this ran: W×S=$ADMITTED admitted, $SANDBOX_COUNT×$SANDBOX_CAP concurrent leases."
    echo "  A ladder whose top rung is its own cap can only report \`not-observed\`, which is what"
    echo "  two earlier zero-duty runs did at c=64."
  else
    echo "- Sandbox pool: $SANDBOX_COUNT leasable sandboxes (floor $SANDBOX_FLOOR), as reported by the"
    echo "  supervisor's own /metrics — presence records the selection path can actually lease, not a"
    echo "  container count on whichever box the driver happened to run on."
  fi
  echo "- **Per-turn worker CPU** is recorded per rung (\`worker_cpu_ms_per_turn\`, with"
  echo "  \`worker_cpu_util\` as its fraction of the **target's** $TARGET_CORES cores, as the supervisor"
  echo "  itself reports them — not the $CORE_COUNT cores this driver's own box has, which describes the"
  echo "  generator and is the denominator for \`contention_load1\` alone). This is what attributes a"
  echo "  knee to \"the worker tier is actually full\" as distinct from \"the stub is slow\" — with"
  echo "  only loop lag and RSS the two are indistinguishable, which is why the first published"
  echo "  density record could not tell them apart."
  echo "- **Throughput must not be quoted as a fraction of an \"ideal\" figure derived from"
  echo "  concurrency ÷ mean turn.** When most of a turn is the stub's programmed wait, that"
  echo "  denominator is mostly sleep, so the ratio measures how well the harness hides a fixed"
  echo "  wait — a concurrency-plumbing check, not a capacity ceiling. The capacity arm exists"
  echo "  precisely because that ratio was being read as one."
  echo "- \`loop_lag_p99\` must be read against \`lag_resolution_ms\`, recorded beside it. A"
  echo "  \`monitorEventLoopDelay\` histogram reports its own resolution as a floor: at the"
  echo "  previously shipped resolution of 10ms an IDLE loop reads ~11-21ms, which is why three"
  echo "  earlier runs read ~11ms at every rung including c=1 and the column looked inert. It does"
  echo "  discriminate a starved loop (~50-57ms under a deliberately blocked one); it cannot"
  echo "  discriminate anything below its own floor."
  echo "- Model stub profile (fetched from $STUB_URL/profile, as resolved at the stub's own boot — not this driver's environment): ttft=${STUB_TTFT}ms tokenDelay=${STUB_TOKEN_DELAY}ms tokens=${STUB_TOKENS} toolRate=${STUB_TOOL_RATE}"
  echo "- Generator placement: **$GENERATOR_PLACEMENT** (derived from \`\$BASE=$BASE\`, not"
  echo "  declared). An **on-box** run is a caveated result, not an equivalent one — see"
  echo "  EXPERIMENTS.md's \"Where the generator ran\" section for why and for the off-box/pinning"
  echo "  guidance."
  echo "- Cores on this box: **$CORE_COUNT** — normalise per-rung \`contention_load1\` against this"
  echo "  (load1 / cores, a rough utilization fraction), not against a raw load-average number"
  echo "  alone."
  echo "- Bound observed at: **$BOUND**"
  echo "- \`lease_saturation\` is now sourced: a worker reports the leases it holds and the pool its"
  echo "  own selection last saw, so the sandbox-pool tier is attributable. **Read its scale with"
  echo "  care** — it is leases per SANDBOX (held ÷ pool size), so it saturates at the per-sandbox"
  echo "  lease cap (\`KAGENTI_SANDBOX_CAP=$SANDBOX_CAP\`), not at 1.0. A reader who assumes a 0–1"
  echo "  ratio will overstate how full the pool was, and the attribution threshold fires at 0.95 —"
  echo "  around one lease per sandbox, well under real lease capacity. Corroborate a sandbox-pool"
  echo "  verdict against the arithmetic ($SANDBOX_COUNT sandboxes × $SANDBOX_CAP = concurrent"
  echo "  leases available) before quoting it."
  echo "- \`file_op_ms\` still reads \`NaN\`: no file-op-p95 counter exists anywhere in"
  echo "  \`harness/src\` or \`packages/k8s-sandbox/src\` for a worker to report (plan 1 Task 11's"
  echo "  note). That is a known gap in the shipped surface, not a defect in this driver — the"
  echo "  relay tier is therefore **unattributed** by this run rather than given a fabricated"
  echo "  reading."
  echo ""
  echo "**§5.7 claim, as measured.** Quote this sentence; do not rewrite it from the numbers above:"
  echo ""
  echo "> On a single VM, $WORKERS workers each admitting up to $TURNS_PER_WORKER in-flight turns"
  echo "> sustained **$KNEE concurrent turns** with p95 within ${DEGRADE_X}x the single-session"
  echo "> baseline, with the model tier modelled at ttft=${STUB_TTFT}ms"
  echo "> tokenDelay=${STUB_TOKEN_DELAY}ms tokens=${STUB_TOKENS}"
  echo "> toolRate=${STUB_TOOL_RATE} (as reported by the stub's own /profile route, not this"
  echo "> driver's environment), and the bound observed at $BOUND."
  if [ "$SATURATED" = no ]; then
    echo ">"
    echo "> _Ladder-limited: $KNEE was the top rung, so the sentence understates the machine._"
  fi
  echo ""
  echo "§5.7's sentence has a second half — what the Knative pod-per-session arm sustained against"
  echo "this same stub — and E9 produces it. A P6 claim quoting only the half above is incomplete:"
  echo "a density figure with nothing to compare it to is not an argument for either architecture."
  echo ""
  echo "Per-rung records (§5.2 attribution: loop_lag_p99 -> worker CPU/mux; rss_bytes -> memory per"
  echo "live session; file_op_ms -> relay round trip; sandbox_cpu -> \`bash -c\` churn;"
  echo "lease_saturation -> pool provisioning; over_admission -> IPC staleness; spurious_429 -> a"
  echo "knee read early rather than a real ceiling; contention_load1 -> 1-minute load average, a"
  echo "contention PROXY not a generator-specific measurement — see EXPERIMENTS.md):"
  echo ""
  echo '```json'
  printf '%s\n' "$RECORDS" | jq .
  echo '```'
} >>"$RESULTS"

[ "$FAIL" = 0 ] || exit 1
