#!/usr/bin/env bash
# V -- live gate for the VM path (P6 spec Sec 5.5). NOT a third experiment.
#
# A small real-model run (E6's L1 workload, c<=6) proving the path is genuine end to end:
# a real model answers, a real tool call reaches a real sandbox container, and a session
# rehydrates from Redis. It reports pass/fail. It does NOT produce a density number, and it
# appends no ladder to EXPERIMENTS.md -- quoting a c<=6 real-model run as a density result is
# precisely the confusion Sec 5.5 exists to prevent. This is not a density number.
#
# Convention follows deploy/knative's E6_LIVE gate: nothing happens without V_LIVE=1.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=./lib-vm.sh
source ./lib-vm.sh

FAIL=0

[ "${V_LIVE:-0}" = "1" ] || {
  echo "SKIP (set V_LIVE=1 to run the VM live gate)"
  exit 0
}

BASE="${V_BASE:-http://127.0.0.1:8080}"
METRICS_BASE="${V_METRICS_BASE:-http://127.0.0.1:8081}"
C="${V_GATE_C:-4}"
[ "$C" -le 6 ] || {
  # The cap is the point: this is a validation run against a real model, and a bigger one both
  # costs real tokens and invites someone to quote it as a density figure.
  ko "V_GATE_C=$C exceeds the Sec 5.5 cap of 6; use run-experiments.sh for density"
  exit 1
}

# A real model, explicitly. If ANTHROPIC_BASE_URL points at the stub the gate proves nothing,
# so refuse rather than pass vacuously.
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set: this gate runs against a REAL model}"
case "${ANTHROPIC_BASE_URL:-}" in
*stub* | *127.0.0.1* | *localhost*)
  ko "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL} looks like the stub; the live gate must use a real model"
  exit 1
  ;;
esac

curl -sf --max-time 5 "$BASE/health" >/dev/null || {
  ko "no supervisor answering at $BASE"
  exit 1
}
ok "supervisor is up at $BASE"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# E6's L1 workload: a code-review turn that must actually run a tool in the sandbox.
BODY="${V_GATE_BODY:-{\"prompt\":\"List the files in /workspace, then summarise what this project does.\"}}"

# Cumulative sandbox CPU BEFORE any turn runs, so the check below can difference it. Sampled here
# rather than at the top of the file so nothing between the two samples but the gate's own turns.
SBX_CPU0="$(sandbox_cpu_seconds)"

for i in $(seq 1 "$C"); do
  (
    SID="v-gate-$i"
    vm_turn "$BASE" "$SID" "$BODY" >"$WORK/turn.$i"
    # Second turn on the same session id: proves rehydration from Redis, which is the assumption
    # Sec 2.4 rests the whole routing decision on.
    vm_turn "$BASE" "$SID" "$BODY" >>"$WORK/turn.$i"
  ) &
done
wait

for i in $(seq 1 "$C"); do
  BAD="$(cut -f2 "$WORK/turn.$i" | grep -vc '^200$' || true)"
  if [ "$BAD" = 0 ]; then
    ok "session $i: both turns returned 200"
  else
    ko "session $i: $BAD non-200 responses ($(cut -f2 "$WORK/turn.$i" | tr '\n' ' '))"
  fi
done

# A tool call must have reached a sandbox. Zero sandbox CPU means the model answered from text
# alone and the hands tier was never exercised -- the gate would be green on a path that cannot
# actually do work.
#
# This must be a DELTA across the turns, and it did not used to be: `sandbox_cpu_seconds` returned an
# instantaneous CPU PERCENT, so a single sample above zero meant "some container is busy right now".
# It is now cumulative CPU since each container booted, and a single sample of that is above zero for
# any container that has ever run a process -- which is every container, always. The one-sample form
# would therefore pass this gate on precisely the path its own comment above says it exists to
# refuse. $SBX_CPU0 is captured before the turns are driven (see above).
SBX_CPU1="$(sandbox_cpu_seconds)"
SBX_DELTA="$(cpu_delta "$SBX_CPU0" "$SBX_CPU1")"
case "$SBX_DELTA" in
NaN)
  # Unmeasurable, not zero: no container runtime visible from here (this gate normally runs on the
  # target, but nothing enforces that). Say so rather than passing or failing on a number nobody has.
  ko "sandbox CPU is UNMEASURABLE from this box ($SBX_CPU0 -> $SBX_CPU1), so this gate cannot prove a tool call reached a container; run it on the target, or set V_SANDBOX_CPU_CMD"
  ;;
*)
  if awk -v c="$SBX_DELTA" 'BEGIN {exit !(c + 0 > 0)}'; then
    ok "sandbox pool consumed ${SBX_DELTA}s of CPU across the gate turns: a tool call reached a container"
  else
    ko "no sandbox CPU consumed during the gate turns (delta ${SBX_DELTA}s): no tool call reached a sandbox, so this gate proves nothing"
  fi
  ;;
esac

M="$(worker_metrics "$METRICS_BASE")"
S429="$(printf '%s' "$M" | jq -r '.counters.spurious_refusals // 0')"
if [ "$S429" = 0 ]; then
  ok "no refusals during the gate"
else
  ko "$S429 refusals at c=$C: admission control is mis-set, not a capacity finding"
fi

[ "$FAIL" = 0 ] || {
  echo "V_GATE: FAIL"
  exit 1
}
echo "V_GATE: PASS (c=$C, real model, tool call observed, session rehydrated)"
echo "This is a validation result. It is not a density number -- see run-experiments.sh."
