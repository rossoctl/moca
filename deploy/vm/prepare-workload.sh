#!/usr/bin/env bash
# Seed each sandbox with a git working copy and calibrate a per-turn tool command against the duty
# basis, then print the SH_STUB_TOOL_INPUT to run the stub with.
#
# WHY THIS EXISTS
#
# E8's tool call defaults to `ls -la /workspace` -- a few milliseconds at most. Spec §2.3's duty
# bases, which E8 quotes and which `duty_basis_sandbox_floor` derives its precondition from, describe
# workloads that occupy a sandbox 6.1-7.9% of the time. So the shipped configuration exercises the
# hands tier STRUCTURALLY (the exec really does traverse relay -> leaf -> container) while it carries
# almost no load, and the measured duty cycle therefore describes a cheaper workload than the basis it
# is compared against. Concurrency figures from that configuration are optimistic against their own
# denominator.
#
# WHAT IS CALIBRATED, AND WHY DUTY IS MEASURED RATHER THAN COMPUTED
#
# The quantity the rest of the rig computes from is the DUTY -- `sandboxFloor = ceil(W*S*duty)` and
# `N ~ 1/duty` both use it -- so that is what this calibrates. It MEASURES it end to end:
#
#   duty = (sandbox execs x per-exec cost) / (total turn wall time)
#
# It used to compute duty from the stub's profile as `rate * cost / (ttft + outputTokens*tokenDelay)`,
# and that model was wrong twice over. Both errors were found by driving real turns:
#
#  - SH_STUB_TOOL_CALL_RATE is per REQUEST, not per turn, and a tool turn costs TWO requests (the
#    tool_use, then the follow-up after the tool result). So at rate 0.5 (EVERY=2) the tool fires on
#    every even request, which is once per TURN -- an effective calls-per-turn of 1.0, not 0.5.
#    Measured: 10 turns produced exactly 10 execs.
#  - `ttft + outputTokens*tokenDelay` is the cost of ONE model response. A tool turn pays a short
#    tool_use response, then the exec, then a full 64-token response, so the real turn is ~1.5x that:
#    1068ms computed against 1579ms measured.
#
# Those errors pull in opposite directions and do not cancel: the profile model put duty at 0.0707
# when the measured value was 0.0950, i.e. above the band while reporting itself inside it. Measuring
# needs no model of the stub's schedule or of the harness's tool loop, and cannot drift from them.
#
# A related trap worth knowing: SH_STUB_TOOL_CALL_RATE's default of 0.07 is numerically equal to the
# e6-ocp duty but is a different quantity -- fraction of REQUESTS emitting a tool_use, versus fraction
# of wall time a sandbox is occupied. Rate 1.0 is unusable (every response is another tool_use: an
# infinite tool loop), so 0.5 is the working setting, and it yields one tool call per turn.
#
# WHY THE KNOB IS A REPEAT COUNT AND NOT THE CORPUS SIZE
#
# Growing the corpus is the obvious approach and it does not work. Measured on the rig: 1024 files cost
# 68ms, 2258 cost 55ms, 6158 cost 99ms -- non-monotonic, because at that size the cost is dominated by
# page-cache state rather than by the work. The search converged on a median (153ms) that an immediate
# re-measurement of the same sandbox did not reproduce (117ms).
#
# That is not a tolerance to widen. A per-turn cost that swings +/-30% makes the duty swing +/-30%, and
# duty is what the comparison rests on -- so an unstable workload is not a basis even when its median
# lands in the band. A repo small enough to stay in cache, iterated N times, has a cost that is linear
# and repeatable in N. N is the knob.
#
# TWO ARMS (§5.2 as amended, issue #254 item 2a)
#
# ARM=realism (default) is everything above: calibrate a git chain until the MEASURED duty lands in a
# §2.3 band. ARM=capacity prepares E8's capacity arm instead, whose whole point is a sandbox tier that
# is present but not competing -- so the command becomes trivial and there is nothing to converge.
#
# What the capacity arm does NOT drop is the exec itself. Exactly one exec per turn, same as the
# calibrated arm, because the relay hop, the lease acquire/release, the transport framing and the exec
# plumbing are all HARNESS work and belong on the path E8 is measuring; only the command's cost goes
# away. Nor does it drop the COUNTING probe: defect 1 on this rig was `/turn` never consulting the
# sandbox pool, so tool calls ran inside the worker process -- the hands tier absent and its cost
# charged to the worker tier. With `true` as the command that failure is nearly invisible, because a
# worker-local exec and a sandbox exec differ in no other measurement, which is exactly why the probe
# stays. And the resulting duty (~0.005) is RECORDED rather than suppressed: a capacity number with no
# duty beside it is one edit away from being quoted as a density claim.
#
# USAGE (on the target, as root)
#
#   ./prepare-workload.sh                       # calibrate against the e6-ocp duty band
#   BASIS=e6-kind ./prepare-workload.sh         # a different §2.3 row
#   ARM=capacity ./prepare-workload.sh          # trivial exec for E8's capacity arm, no calibration
#   SH_SANDBOX_COUNT=6 ./prepare-workload.sh
#   STUB_URL=http://127.0.0.1:18081 ./prepare-workload.sh
#
# It is idempotent: re-running reseeds from scratch.
set -euo pipefail

: "${SH_SANDBOX_COUNT:=3}"
# realism (default) preserves this script's existing behaviour exactly.
: "${ARM:=realism}"
: "${BASIS:=e6-ocp}"
# The capacity arm's stub profile: fast enough that a turn's duration approximates the harness's own
# cost rather than a programmed sleep. e8-density.sh refuses a capacity arm whose stub is slower than
# its own ceiling (assert_arm_stub_profile), so these defaults are the two halves of one contract --
# raise them here and that gate will reject the run.
: "${CAPACITY_TTFT_MS:=10}"
: "${CAPACITY_TOKEN_DELAY_MS:=1}"
: "${WORKSPACE:=/workspace}"
: "${STUB_URL:=http://127.0.0.1:18081}"
# The supervisor's data port: duty is measured by driving real turns through it, so this script needs
# the supervisor up, not just the sandboxes.
: "${BASE:=http://127.0.0.1:8080}"
# Turns per probe. Enough that one slow turn cannot move the ratio much; small enough to iterate.
: "${TURNS:=10}"
: "${MAX_ROUNDS:=10}"
: "${REPS_START:=8}"
: "${SAMPLES:=9}"
# Maximum acceptable (max-min)/median across samples. A workload noisier than this cannot pin a duty.
: "${MAX_SPREAD_PCT:=35}"
: "${TSX:=../../experiments/node_modules/.bin/tsx}"
# Fixed, deliberately small: large enough that git has real work per iteration, small enough to stay
# in page cache so the cost is repeatable.
: "${FILES:=256}"
# This script restarts the stub each round to change the workload, so it needs the entry point.
: "${STUB_JS:=/opt/serverless-harness/deploy/knative/model-stub/stub.js}"

log() { printf '==> %s\n' "$*"; }
die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 1
}

command -v podman >/dev/null || die "podman not found; run this on the target"
command -v curl >/dev/null || die "curl not found"
command -v python3 >/dev/null || die "python3 not found"
[ "$(id -u)" -eq 0 ] || die "run as root: the sandboxes are under root podman (setup-vm.sh requires root)"

sandboxes() {
  local i
  for ((i = 0; i < SH_SANDBOX_COUNT; i++)); do echo "sh-sandbox-$i"; done
}

# The duty band comes from experiments/src/basis.ts, never from a number typed here. That file throws
# on an unknown basis and on a blended row, so reading it is also the validation -- and transcribing
# 0.061/0.079 into this script would be exactly the drift the §2.3 conventions exist to prevent.
read_duty_band() {
  cd "$(dirname "$0")"
  [ -x "$TSX" ] || die "tsx not found at $TSX (run pnpm install in the workspace; see require_tsx in lib-vm.sh)"
  "$TSX" -e '
    import { resolveBasis } from "../../experiments/src/basis.ts";
    const b = resolveBasis(process.argv[1]);
    console.log(`${b.duty[0]} ${b.duty[1]} ${b.cite}`);
  ' "$BASIS"
}

# The stub reports its RESOLVED profile, so the turn duration and tool-call rate are read from the
# process actually generating the load rather than from this shell's idea of it -- the same reason both
# drivers fetch /profile instead of echoing their own environment.
read_stub_profile() {
  curl -sf --max-time 5 "$STUB_URL/profile" ||
    die "cannot reach the model stub at $STUB_URL/profile. Start it first: the turn duration and
    tool-call rate must come from the stub, because a duty computed from assumed values describes a
    workload nobody ran."
}

# Every sandbox must exist and carry git, or the workload cannot be what the basis assumes. The leaf
# advertises git in its `probed` capability list, so a sandbox without it is also advertising falsely.
preflight() {
  local sb
  for sb in $(sandboxes); do
    podman inspect "$sb" >/dev/null 2>&1 || die "$sb is not running (run setup-vm.sh first)"
    podman exec "$sb" sh -c 'command -v git >/dev/null' ||
      die "$sb has no git. The leaf advertises git in cmd/worker/main.go's \`probed\` list, so this
      image is advertising a capability it lacks -- rebuild with an image that installs it. Without
      git the tool call cannot resemble the workload spec §2.3's duty bases were measured from."
    podman exec "$sb" test -d "$WORKSPACE" ||
      die "$sb has no $WORKSPACE. Every exec would die on \`cd\` before running anything."
  done
  log "preflight ok: $SH_SANDBOX_COUNT sandbox(es), git present, $WORKSPACE present"
}

# Seed a repo with $FILES files across two commits, so status/diff/log all have real work. Content is
# generated deterministically so two sandboxes and two runs are comparable -- a random corpus would
# make the calibrated cost unreproducible, which is the same defect as a fabricated one.
seed_one() {
  local sb="$1"
  podman exec "$sb" sh -c "
    set -e
    rm -rf $WORKSPACE/repo
    mkdir -p $WORKSPACE/repo
    cd $WORKSPACE/repo
    git init -q .
    git config user.email harness@example.invalid
    git config user.name harness
    i=0
    while [ \$i -lt $FILES ]; do
      awk -v n=\$i 'BEGIN { for (l = 0; l < 200; l++) print \"pkg\" n \" line \" l \" tok\" (l * n % 97) }' > f\$i.txt
      i=\$((i + 1))
    done
    git add -A
    git commit -q -m base
    i=0
    while [ \$i -lt $FILES ]; do
      if [ \$((i % 3)) -eq 0 ]; then echo 'edited' >> f\$i.txt; fi
      i=\$((i + 1))
    done
    git add -A
    git commit -q -m edit
  "
}

# The per-turn command: a read-mostly git chain, repeated $1 times. Read-mostly and idempotent, or turn
# N would measure a different workspace from turn 1 and the rungs would not be comparable.
turn_cmd() {
  printf 'cd %s/repo && n=0; while [ $n -lt %d ]; do git status --porcelain; git diff HEAD~1 --stat; git log --oneline -20; n=$((n+1)); done' \
    "$WORKSPACE" "$1"
}

# The capacity arm's per-turn command: one exec, no cost. `true` is a shell builtin, so this measures
# the plumbing (relay -> leaf -> container, lease acquire/release, framing) and nothing else -- which
# is the harness work the capacity arm exists to measure, with the sandbox cost removed.
#
# `cd` into the workspace first, deliberately, even though `true` does not need it: defect 3 on this
# rig was leaf images that never created /workspace, so every tool call died on `cd` inside a healthy,
# attached sandbox. Keeping the `cd` means a trivial arm still fails on that breakage rather than
# passing where the calibrated arm would fail -- the two arms exercise the same preconditions.
trivial_turn_cmd() {
  printf 'cd %s/repo && true' "$WORKSPACE"
}

# The trivial command with the same counter append the calibrated path uses, so a capacity arm can
# prove its exec reached a sandbox. Same reason as turn_cmd_counting below; separate function because
# the trivial command takes no repeat count.
trivial_turn_cmd_counting() {
  printf 'echo x >> %s && %s' "$COUNTER" "$(trivial_turn_cmd)"
}

# The same command with one appended line to a counter file, so execs can be COUNTED exactly rather
# than inferred from the stub's schedule. Inferring is what produced a wrong duty: the rate is
# per-request and a tool turn spends two requests, so the calls-per-turn cannot be read off the rate.
# The append is a single line to a cached file; its cost is noise against a 100ms+ body.
turn_cmd_counting() {
  printf 'echo x >> %s && %s' "$COUNTER" "$(turn_cmd "$1")"
}

COUNTER="$WORKSPACE/.exec-count"

# Raw per-run millisecond samples of the tool command AS RUN IN THE SANDBOX.
#
# The command is wrapped in braces before the redirect. Written `$cmd >/dev/null 2>&1` the redirect
# binds to the LAST simple command only -- `&&` and `;` bind looser -- so every earlier command still
# wrote to stdout, its output mixed into the timing samples, and the median came back as a FILENAME.
# The `grep -E` is belt and braces on the same class: only pure integers can reach the median.
measure_raw() {
  local sb="$1" reps="$2" runs="${3:-$SAMPLES}" cmd
  if [ "$ARM" = capacity ]; then cmd="$(trivial_turn_cmd)"; else cmd="$(turn_cmd "$reps")"; fi
  podman exec "$sb" sh -c "
    i=0
    while [ \$i -lt $runs ]; do
      s=\$(date +%s%N)
      { $cmd ; } >/dev/null 2>&1 || true
      e=\$(date +%s%N)
      echo \$(( (e - s) / 1000000 ))
      i=\$((i + 1))
    done
  " | grep -E '^[0-9]+$'
}

# "median spread_pct". Both are needed: a stable median with a wide spread is still not a basis,
# because the duty it implies varies run to run. The cheapest sample is dropped as the cold-cache
# warm-up, so what is reported is the steady-state cost the §2.3 bases describe.
measure_stats() {
  measure_raw "$1" "$2" "${3:-$SAMPLES}" | python3 -c '
import sys
xs = sorted(int(l) for l in sys.stdin if l.strip().isdigit())
if not xs:
    print("")
    raise SystemExit
xs = xs[1:] or xs
med = xs[len(xs) // 2]
spread = 0 if med == 0 else round(100 * (xs[-1] - xs[0]) / med)
print(f"{med} {spread}")
'
}

# A measured 0 is legitimate for the capacity arm (a `true` builtin inside an already-warm shell can
# round to 0ms) and impossible for the calibrated one; either way this only rejects NON-NUMERIC input,
# which is the contamination it was written for -- the calibrated path's band check is what refuses a
# cost too small to be a real workload.
require_numeric() {
  case "${1:-}" in
  '' | *[!0-9]*)
    die "the measurement returned '${1:-<empty>}', which is not a millisecond count. Something other
    than the timing lines reached the median -- check that the timed command's output is fully
    redirected inside measure_raw."
    ;;
  esac
}

# Restart the stub with the counting tool command at this repeat count. The stub's other four values
# are preserved from its own /profile, so this changes the workload and nothing else.
restart_stub() {
  local reps="$1" ttft="$2" delay="$3" tokens="$4" rate="$5" cmd
  # The capacity arm's workload has no repeat count to vary; both arms still go through this one
  # function so the stub's lifecycle, its four preserved profile values and the counter are handled
  # identically -- a second copy of this would be a second place for them to drift.
  if [ "$ARM" = capacity ]; then cmd="$(trivial_turn_cmd_counting)"; else cmd="$(turn_cmd_counting "$reps")"; fi
  systemctl stop p6-model-stub 2>/dev/null || true
  systemctl reset-failed p6-model-stub 2>/dev/null || true
  sleep 1
  systemd-run --unit=p6-model-stub --setenv=PORT=18081 \
    --setenv="SH_STUB_TTFT_MS=$ttft" --setenv="SH_STUB_TOKEN_DELAY_MS=$delay" \
    --setenv="SH_STUB_OUTPUT_TOKENS=$tokens" --setenv="SH_STUB_TOOL_CALL_RATE=$rate" \
    --setenv="SH_STUB_TOOL_INPUT={\"command\":\"$cmd\"}" \
    /usr/bin/node "$STUB_JS" >/dev/null ||
    die "could not start the model stub. This script owns its lifecycle during calibration; restart it
    yourself afterwards if this failed midway."
  sleep 2
}

# The capacity arm's counterpart to restart_stub_final below: leave the stub running the trivial
# workload WITHOUT the counter, which exists for measurement only and would otherwise grow a file
# unboundedly across a ladder that runs many more turns than any published run.
restart_stub_capacity_final() {
  local ttft="$1" delay="$2" tokens="$3" rate="$4"
  systemctl stop p6-model-stub 2>/dev/null || true
  systemctl reset-failed p6-model-stub 2>/dev/null || true
  sleep 1
  systemd-run --unit=p6-model-stub --setenv=PORT=18081 \
    --setenv="SH_STUB_TTFT_MS=$ttft" --setenv="SH_STUB_TOKEN_DELAY_MS=$delay" \
    --setenv="SH_STUB_OUTPUT_TOKENS=$tokens" --setenv="SH_STUB_TOOL_CALL_RATE=$rate" \
    --setenv="SH_STUB_TOOL_INPUT={\"command\":\"$(trivial_turn_cmd)\"}" \
    /usr/bin/node "$STUB_JS" >/dev/null ||
    die "could not restart the model stub on the trivial workload."
  sleep 2
}

# WHY THESE ARE TWO STATEMENTS AND NOT ONE `read ... <<<"$(...)"`
#
# `read -r a b <<<"$(fn)"` MASKS a `die` inside fn. Verified under `set -euo pipefail`: the here-string
# is expanded, the substitution exits 1, and the script CONTINUES with empty values, exit status 0 --
# because the status of the enclosing command is `read`'s, not the substitution's. A plain assignment
# does abort (its status IS the substitution's), so the two-statement form is what makes a `die`
# inside probe_duty or read_duty_band actually stop the run.
#
# This was not cosmetic. probe_duty's "no sandbox exec was recorded" refusal is the load-bearing
# assertion that the tool call reached a sandbox at all -- the /turn-ran-tools-locally defect -- and
# masked, it let the calibration continue with an empty duty until some later python expression failed
# on the empty string, reporting a syntax error instead of the diagnosis. `local out; out="$(fn)"` is
# required too: `local out="$(fn)"` masks it again, because `local` supplies its own exit status.

# Drive TURNS turns and report "duty execs_per_turn mean_turn_ms cost_ms spread_pct".
probe_duty() {
  local reps="$1" ttft="$2" delay="$3" tokens="$4" rate="$5"
  local sb total=0 t ms execs=0 c cost spread

  for sb in $(sandboxes); do podman exec "$sb" sh -c "rm -f $COUNTER" 2>/dev/null || true; done
  restart_stub "$reps" "$ttft" "$delay" "$tokens" "$rate"

  local i
  for ((i = 0; i < TURNS; i++)); do
    t="$(curl -sf --max-time 180 -o /dev/null -w '%{time_total}' -XPOST "$BASE/turn" \
      -H 'content-type: application/json' -H "X-SH-Session-Id: calib-$reps-$i" \
      -d '{"prompt":"summarise the diff"}' || echo 0)"
    ms="$(python3 -c "print(int(round(float('$t') * 1000)))")"
    [ "$ms" -gt 0 ] || die "a turn against $BASE failed during calibration; the supervisor must be up
    and serving before duty can be measured."
    total=$((total + ms))
  done

  for sb in $(sandboxes); do
    c="$(podman exec "$sb" sh -c "wc -l < $COUNTER 2>/dev/null || echo 0" 2>/dev/null | tr -d ' \r')"
    case "$c" in '' | *[!0-9]*) c=0 ;; esac
    execs=$((execs + c))
  done
  [ "$execs" -gt 0 ] || die "no sandbox exec was recorded across $TURNS turns. The tool call is not
  reaching a sandbox at all, so there is no duty to calibrate -- check that /turn routes to the pool."

  read -r cost spread <<<"$(measure_stats sh-sandbox-0 "$reps")"
  require_numeric "$cost"

  python3 -c "
execs, cost, total, turns = $execs, $cost, $total, $TURNS
print(round(execs * cost / total, 4), round(execs / turns, 2), round(total / turns), cost, $spread)
"
}

main() {
  preflight

  # The band is the REALISM arm's target. The capacity arm takes no §2.3 row (§5.4 as amended): its
  # duty is whatever a trivial exec costs, and it is measured and reported rather than aimed at.
  # Resolving the band anyway would invite the reader to compare the two, which is the mistake.
  local dlow dhigh cite band
  if [ "$ARM" = capacity ]; then
    dlow=n/a dhigh=n/a cite="none (capacity arm)"
    log "arm capacity: no duty basis, trivial exec, no calibration -- the duty is MEASURED and recorded"
  else
    band="$(read_duty_band)"
    read -r dlow dhigh cite <<<"$band"
    log "duty basis $BASIS: $dlow-$dhigh [$cite]"
  fi

  local profile ttft delay tokens rate parsed
  profile="$(read_stub_profile)"
  parsed="$(printf '%s' "$profile" | python3 -c '
import json, sys
p = json.load(sys.stdin)
print(p["ttftMs"], p["tokenDelayMs"], p["outputTokens"], p["toolCallRate"])
')"
  read -r ttft delay tokens rate <<<"$parsed"
  log "stub profile: ttft=${ttft}ms delay=${delay}ms tokens=$tokens rate=$rate"
  # Every field must be a number before anything is decided from it. The old form was
  # `printf '%s' "$rate" | awk '{ exit !($1 > 0) }'`, which on EMPTY input runs no rules at all and
  # exits 0 -- so a failed profile parse (the masked here-string above could leave every variable
  # empty) sailed through the one check meant to prove the sandbox tier is reachable, and then passed
  # empty values into --setenv=SH_STUB_TOOL_CALL_RATE=. An END rule, or a BEGIN-only test as here,
  # is the difference between "the value is > 0" and "no value was examined".
  for f in "ttftMs=$ttft" "tokenDelayMs=$delay" "outputTokens=$tokens" "toolCallRate=$rate"; do
    case "${f#*=}" in
    '' | *[!0-9.]*) die "the stub profile field ${f%%=*} reads '${f#*=}', which is not a number. The
      profile could not be read, so nothing below can be calibrated against it: $profile" ;;
    esac
  done
  awk -v r="$rate" 'BEGIN { exit !(r + 0 > 0) }' ||
    die "toolCallRate is $rate: with no tool calls the sandbox is never occupied, so no repeat count
    can reach a non-zero duty. Start the stub with a non-zero SH_STUB_TOOL_CALL_RATE (0.5 works; 1.0
    is an infinite tool loop)."

  local mid
  if [ "$ARM" != capacity ]; then
    mid="$(python3 -c "print(($dlow + $dhigh) / 2)")"
    log "target duty: $mid (band $dlow-$dhigh), measured end to end over $TURNS turns per round"
  fi

  # Both arms seed the repo. The capacity arm never reads it, but its command still `cd`s into it
  # (see trivial_turn_cmd), so a sandbox missing /workspace/repo fails the same way in both arms
  # rather than only in the one that does real work.
  log "seeding $SH_SANDBOX_COUNT sandbox(es) with $FILES files (fixed; the repeat count is the knob)"
  local sb
  for sb in $(sandboxes); do seed_one "$sb"; done

  # --- capacity arm: measure once, converge on nothing, and stop. -----------------------------
  # probe_duty is the SAME function the calibrated path drives, which is what keeps the two arms'
  # duty figures the same quantity, measured the same way: turns driven through the real supervisor,
  # execs counted in the sandboxes, duty = execs x cost / total wall. Its no-exec refusal is the
  # load-bearing part here (a trivial arm whose tool call silently never reaches a sandbox is
  # invisible in every other measurement), and its reps argument is ignored by the trivial command.
  if [ "$ARM" = capacity ]; then
    local cduty ccpt cturn ccost cspread probed
    probed="$(probe_duty 0 "$CAPACITY_TTFT_MS" "$CAPACITY_TOKEN_DELAY_MS" "$tokens" "$rate")"
    read -r cduty ccpt cturn ccost cspread <<<"$probed"
    log "capacity arm: duty $cduty (execs/turn $ccpt, turn ${cturn}ms, per-exec ${ccost}ms, spread ${cspread}%)"
    # A trivial exec can measure 0ms: measure_raw times with `date +%s%N` and reports whole
    # milliseconds, and `cd && true` inside an already-warm shell is well under one. A bare "0.0" duty
    # would then be indistinguishable from "no sandbox work happened at all" -- the same
    # unmeasured-versus-empty ambiguity the pool-size field is careful about -- so when the cost lands
    # below the measurement resolution, what gets recorded is an explicit UPPER BOUND instead: one
    # exec cannot have cost more than 1ms, so the duty cannot exceed cpt x 1ms / turn.
    local duty_note="(measured end to end: execs per turn x per-exec cost / turn wall)"
    if [ "$ccost" = "0" ]; then
      cduty="$(python3 -c "print('<' + str(round($ccpt * 1.0 / $cturn, 5)))")"
      duty_note="(per-exec cost is below this rig's 1ms timing resolution, so this is an upper bound, not a point estimate)"
    fi
    # One exec per turn, exactly -- the same invariant the calibrated arm holds. Zero means the tool
    # call never reached a sandbox (probe_duty would already have died); anything above ~1 means the
    # stub is emitting more than one tool_use per turn, which would put a different amount of harness
    # plumbing on the path and make the two arms' per-turn cost incomparable.
    python3 -c "
import sys
sys.exit(0 if 0.9 <= $ccpt <= 1.1 else 1)" ||
      die "the capacity arm measured $ccpt execs per turn, not ~1.0. E8's capacity arm keeps EXACTLY one
      exec per turn so the relay hop, lease and framing cost are on the path once; check
      SH_STUB_TOOL_CALL_RATE (0.5 yields one call per turn)."
    restart_stub_capacity_final "$CAPACITY_TTFT_MS" "$CAPACITY_TOKEN_DELAY_MS" "$tokens" "$rate"
    for sb in $(sandboxes); do podman exec "$sb" sh -c "rm -f $COUNTER" 2>/dev/null || true; done
    cat <<EOF

==> prepared E8's CAPACITY arm: trivial exec, no calibration

  command                cd $WORKSPACE/repo && true   <-- one exec per turn, ~no cost
  per-exec cost          ${ccost}ms   (spread ${cspread}%)
  execs per turn         $ccpt        (measured, not inferred from the rate)
  mean turn              ${cturn}ms
  tool-call rate         $rate
  stub profile           ttft=${CAPACITY_TTFT_MS}ms delay=${CAPACITY_TOKEN_DELAY_MS}ms tokens=$tokens
  MEASURED DUTY          $cduty     <-- RECORD THIS. No §2.3 basis applies (§5.4)
                         $duty_note

This arm's number is an UPPER BOUND on the supervisor + worker tier, never a deployable density: the
sandbox tier is deliberately non-binding here, and e8-density.sh enforces that with a measured
utilisation ceiling per rung rather than trusting this preparation. Record the duty above in the run
record beside it -- a capacity figure with no duty next to it is one edit away from being quoted as a
density claim, which is the confusion the two arms exist to prevent.

Run it with BOTH caps well clear of the ladder -- e8-density.sh refuses the run otherwise, because a
knee at or below a cap is the cap's number and not the machine's. The supervisor must have been STARTED
with these; S and the lease cap are restart-time constants:

  SH_WORKERS=4 SH_TURNS_PER_WORKER=64    ->  256 admitted, clears a c=128 top rung by 2x
  KAGENTI_SANDBOX_CAP=86 (3 sandboxes)   ->  258 concurrent leases, likewise

  V_ARM=capacity V_LADDER='1 2 4 8 16 32 64 128' ./e8-density.sh

  SH_STUB_TOOL_INPUT='{"command":"$(trivial_turn_cmd)"}'
EOF
    return 0
  fi

  local reps="$REPS_START" round=0 duty=0 cpt=0 turn_ms=0 cost=0 spread=0 probed=
  while [ "$round" -lt "$MAX_ROUNDS" ]; do
    round=$((round + 1))
    probed="$(probe_duty "$reps" "$ttft" "$delay" "$tokens" "$rate")"
    read -r duty cpt turn_ms cost spread <<<"$probed"
    log "round $round: reps=$reps -> duty $duty (execs/turn $cpt, turn ${turn_ms}ms, cost ${cost}ms, spread ${spread}%)"

    if python3 -c "import sys; sys.exit(0 if $dlow <= $duty <= $dhigh else 1)"; then
      log "in band after $round round(s)"
      break
    fi
    # duty rises with cost, and cost is linear in reps -- but the turn lengthens too, so scale on the
    # non-sandbox remainder rather than on duty directly, and clamp so one noisy round cannot bolt.
    local next
    next="$(python3 -c "
mid, duty, reps, cpt, cost, turn = $mid, $duty, $reps, $cpt, $cost, $turn_ms
non_sandbox = turn - cpt * cost
want_cost = mid * non_sandbox / (cpt * (1 - mid)) if cpt else cost
n = round(reps * want_cost / cost) if cost else reps
n = max(1, min(n, reps * 4), reps // 4 or 1)
print(n if n != reps else reps + 1)
")"
    reps="$next"
  done

  python3 -c "import sys; sys.exit(0 if $dlow <= $duty <= $dhigh else 1)" ||
    die "could not land duty in $dlow-$dhigh within $MAX_ROUNDS rounds (last: $duty at reps=$reps).
    Do NOT run E8 against an uncalibrated workload and quote it against this basis."
  [ "$spread" -le "$MAX_SPREAD_PCT" ] ||
    die "the per-exec cost varies ${spread}% across samples (limit ${MAX_SPREAD_PCT}%), so this
    workload cannot pin a duty: the duty would vary by the same proportion during a run. Reduce
    \$FILES so the repo stays in page cache, or raise \$SAMPLES."

  # Every sandbox must agree, not just the one the search measured: rungs that lease a slower sandbox
  # would carry a different workload from rungs that lease the others.
  for sb in $(sandboxes); do
    local each espread
    read -r each espread <<<"$(measure_stats "$sb" "$reps")"
    require_numeric "$each"
    log "$sb: per-exec ${each}ms (spread ${espread}%)"
    python3 -c "
import sys
lo, hi = $cost * 0.85, $cost * 1.15
sys.exit(0 if lo <= $each <= hi else 1)" ||
      die "$sb costs ${each}ms against ${cost}ms on sh-sandbox-0 (>15% apart). Rungs that lease it
      would carry a different workload from rungs that lease the others."
  done

  # Leave the stub running the workload WITHOUT the counter: the counter exists for calibration and
  # would grow a file unboundedly across a real ladder.
  restart_stub_final() {
    systemctl stop p6-model-stub 2>/dev/null || true
    systemctl reset-failed p6-model-stub 2>/dev/null || true
    sleep 1
    systemd-run --unit=p6-model-stub --setenv=PORT=18081 \
      --setenv="SH_STUB_TTFT_MS=$ttft" --setenv="SH_STUB_TOKEN_DELAY_MS=$delay" \
      --setenv="SH_STUB_OUTPUT_TOKENS=$tokens" --setenv="SH_STUB_TOOL_CALL_RATE=$rate" \
      --setenv="SH_STUB_TOOL_INPUT={\"command\":\"$(turn_cmd "$reps")\"}" \
      /usr/bin/node "$STUB_JS" >/dev/null
    sleep 2
  }
  restart_stub_final
  for sb in $(sandboxes); do podman exec "$sb" sh -c "rm -f $COUNTER" 2>/dev/null || true; done

  cat <<EOF

==> calibrated against the $BASIS duty band, MEASURED end to end

  repo                   $FILES files (fixed)
  repeat count           $reps      <-- the calibrated knob
  per-exec cost          ${cost}ms   (spread ${spread}%)
  execs per turn         $cpt        (measured, not inferred from the rate)
  mean turn              ${turn_ms}ms
  tool-call rate         $rate
  MEASURED DUTY          $duty    (band $dlow-$dhigh)

The stub is already running this workload. Its /profile reports the rate and the token timings; it
cannot report the tool COST, so record everything above in the run record -- a duty quoted without its
inputs cannot be checked, and the cost belongs to THIS box's storage, so another box must recalibrate.

  SH_STUB_TOOL_INPUT='{"command":"$(turn_cmd "$reps")"}'
EOF
}

main "$@"
