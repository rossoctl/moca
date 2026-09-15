#!/usr/bin/env bash
# prepare-workload.sh must MEASURE duty, not compute it from the stub's profile.
#
# Two earlier versions were wrong, and the second is the interesting one.
#
# v1 aimed at ~470ms per tool call -- the reference workload's git cost. Wrong target: what the rig
# computes from is duty (`sandboxFloor = ceil(W*S*duty)`, `N ~ 1/duty`), not a millisecond figure.
#
# v2 aimed at duty, but DERIVED it as `rate * cost / (ttft + outputTokens*tokenDelay)`. That model was
# wrong twice over, and both errors were only visible by driving real turns:
#
#   - SH_STUB_TOOL_CALL_RATE is per REQUEST, and a tool turn spends TWO requests (the tool_use, then
#     the follow-up after the tool result). At rate 0.5 the tool fires on every even request, which is
#     once per TURN: an effective calls-per-turn of 1.0, not 0.5. Measured: 10 turns, 10 execs.
#   - `ttft + outputTokens*tokenDelay` is ONE model response. A tool turn pays a short tool_use
#     response, the exec, then a full 64-token response: 1068ms computed vs 1579ms measured.
#
# They pull opposite ways and do not cancel. The model reported duty 0.0707 while the measured value
# was 0.0950 -- above the band while claiming to be inside it. Which is why the contract is now
# "count the execs, time the turns, divide", and why this file pins that rather than any formula.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAIL=0
ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  FAIL=1
}

S=prepare-workload.sh
[ -f "$S" ] || {
  echo "not ok - $S missing"
  exit 1
}
CODE="$(grep -vE '^\s*#' "$S")"

# --- 1. No hardcoded millisecond target, and no transcribed duty numbers. ----------------------
if printf '%s' "$CODE" | grep -qE '^\s*:\s*"\$\{TARGET_MS:='; then
  ko "$S takes TARGET_MS as an input -- the target must come from the duty band"
else
  ok "no hardcoded millisecond target"
fi
if printf '%s' "$CODE" | grep -qE '0\.061|0\.079'; then
  ko "$S has duty numbers transcribed into it"
else
  ok "no duty numbers transcribed into the script"
fi
if printf '%s' "$CODE" | grep -q 'resolveBasis'; then
  ok "the duty band comes from experiments/src/basis.ts"
else
  ko "the duty band is not read from basis.ts -- a transcribed number will drift"
fi

# --- 2. Duty is MEASURED: real turns are driven, and execs are counted. ------------------------
# This is the load-bearing property. A script that models duty from the profile cannot see either of
# the two errors described above.
if printf '%s' "$CODE" | grep -q '\$BASE/turn'; then
  ok "duty is measured by driving real turns through the supervisor"
else
  ko "no turns are driven -- duty is being modelled rather than measured"
fi
if printf '%s' "$CODE" | grep -q 'COUNTER' && printf '%s' "$CODE" | grep -q 'wc -l'; then
  ok "sandbox execs are COUNTED, not inferred from the tool-call rate"
else
  ko "execs are not counted -- calls-per-turn cannot be read off the rate (that was the v2 defect)"
fi
# And the formula that was wrong must not be back.
if printf '%s' "$CODE" | grep -qE 'rate \* cost|cost / turn_ms|mid \* turn / rate'; then
  ko "the profile-derived duty formula is back in the script"
else
  ok "duty is not derived from rate x cost / computed-turn"
fi

# --- 3. It refuses rather than reporting a number it cannot stand behind. ----------------------
for pat in 'no sandbox exec was recorded' 'could not land duty' 'cannot pin a duty'; do
  if printf '%s' "$CODE" | grep -q "$pat"; then
    ok "refuses: '$pat'"
  else
    ko "missing refusal: '$pat'"
  fi
done
if printf '%s' "$CODE" | grep -q 'SH_STUB_TOOL_CALL_RATE'; then
  ok "a zero tool-call rate is refused, naming the knob"
else
  ko "a zero tool-call rate is not refused"
fi

# --- 4. The output carries every input, so the duty can be checked. ---------------------------
for want in 'MEASURED DUTY' 'execs per turn' 'mean turn' 'per-exec cost' 'tool-call rate' 'repeat count'; do
  if printf '%s' "$CODE" | grep -q "$want"; then
    ok "the output reports '$want'"
  else
    ko "the output omits '$want' -- a duty without its inputs cannot be checked"
  fi
done

# --- 5. The timed command must be brace-wrapped before the redirect. --------------------------
# `$cmd >/dev/null 2>&1` on a CHAIN redirects only the last command, so earlier output contaminates
# the timing samples. On the rig that made the median come back as a filename.
if printf '%s' "$CODE" | grep -qE '\{ \$cmd ; \} >/dev/null'; then
  ok "the timed command is brace-wrapped, so all of its output is redirected"
else
  ko "the timed command is not brace-wrapped -- earlier commands in the chain will leak into the samples"
fi
# Demonstrate the precedence, so this is a fact rather than a claim.
LEAK="$(bash -c 'eval "echo LEAKED && echo x | cat >/dev/null 2>&1"' 2>/dev/null)"
if [ "$LEAK" = "LEAKED" ]; then
  ok "confirmed: an unwrapped redirect on a chain leaks earlier output"
else
  ko "expected the unwrapped form to leak 'LEAKED', got '$LEAK'"
fi

# --- 6. The counter must NOT be left in the shipped workload. ---------------------------------
# It exists for calibration; leaving it would grow a file unboundedly across a real ladder.
if printf '%s' "$CODE" | grep -q 'restart_stub_final'; then
  ok "the stub is left running the workload without the exec counter"
else
  ko "no final restart -- the shipped workload would keep appending to the counter file"
fi

# --- 7. ARM=capacity: a trivial exec, but still an exec. ---------------------------------------
# E8's capacity arm needs the sandbox tier structurally present and load-free (§5.2 as amended): the
# relay hop, the lease acquire/release, the transport framing and the exec plumbing are all HARNESS
# work and must stay on the measured path -- only the command's COST goes away. So this mode removes
# the calibration, not the exec.
if printf '%s' "$CODE" | grep -qE '^\s*:\s*"\$\{ARM:='; then
  ok "prepare-workload.sh takes an ARM"
else
  ko "no ARM input -- the capacity arm has no way to ask for a trivial workload"
fi

if printf '%s' "$CODE" | grep -qE 'capacity'; then
  ok "the capacity arm is handled"
else
  ko "nothing in the script mentions the capacity arm"
fi

# EXACTLY ONE exec per turn, same as the calibrated arm. Two would double the plumbing per turn and
# make the two arms' per-turn harness cost incomparable; zero would delete the hands tier.
if printf '%s' "$CODE" | grep -qE 'trivial_turn_cmd|turn_cmd_trivial'; then
  ok "a trivial per-turn command exists as its own function"
else
  ko "no trivial command function -- the capacity arm would have to reuse the git chain"
fi

# The counting probe is what proves the exec REACHED a sandbox. In a trivial-exec arm that failure is
# nearly invisible: defect 1 was /turn never consulting the pool, so tool calls ran inside the worker
# process -- the hands tier absent and its cost charged to the worker tier. With `true` as the
# command, a worker-local exec and a sandbox exec look identical in every other measurement.
# The capacity arm's own block in main(), NOT "everything after the first lowercase `capacity`" --
# which was the first version of this and matched from `measure_raw`'s own `[ "$ARM" = capacity ]`
# onward, i.e. across the realism loop as well. Every assertion below then matched the realism path's
# text and could not fail. Anchored on the branch comment that opens the capacity arm instead, and
# bounded by the `return 0` that closes it. The anchor has to be a line of CODE, not the branch
# comment: $CODE has every comment line stripped, so a comment anchor matches nothing and the block
# comes back empty -- which the emptiness check below now catches instead of passing silently.
CAP_BLOCK="$(printf '%s\n' "$CODE" | sed -n '/local cduty/,/^    return 0/p')"
if [ -z "$CAP_BLOCK" ]; then
  ko "could not locate the capacity arm block in main() -- the assertions below would vacuously pass"
fi
if printf '%s' "$CODE" | grep -qE 'no sandbox exec was recorded'; then
  ok "the no-exec refusal is still present"
else
  ko "the no-exec refusal is gone -- a capacity arm whose tool call never reaches a sandbox would pass"
fi
if printf '%s' "$CAP_BLOCK" | grep -qE 'turn_cmd_counting|COUNTER'; then
  ok "the capacity path still runs the counting probe"
else
  ko "the capacity path does not count execs -- the /turn-ran-tools-locally defect would be invisible here"
fi

# The duty is RECORDED, not suppressed: ~0.005 is a fact about the arm, and its absence is what would
# let the capacity number be mistaken for a density claim later.
if printf '%s' "$CAP_BLOCK" | grep -qiE 'duty'; then
  ok "the capacity arm records its own (near-zero) measured duty"
else
  ko "the capacity arm does not record a duty -- a run with no duty field cannot be told from a density claim"
fi

# And it must still print SH_STUB_TOOL_INPUT in the same shape, or the operator has nothing to start
# the stub with.
if printf '%s' "$CODE" | grep -qE "SH_STUB_TOOL_INPUT='\\{\"command\""; then
  ok "SH_STUB_TOOL_INPUT is printed in the same shape for both arms"
else
  ko "SH_STUB_TOOL_INPUT is not printed in the documented shape"
fi

# --- 8. probe_duty's refusals must actually stop the run. --------------------------------------
# `read -r a b <<<"$(fn)"` MASKS a `die` inside fn: the here-string is expanded, the substitution exits
# 1, and the script continues with EMPTY values at exit status 0, because the enclosing command's status
# is `read`'s. Demonstrated below rather than asserted, because it is the kind of thing a future edit
# reintroduces while "simplifying". It matters here because probe_duty's "no sandbox exec was recorded"
# refusal is what proves the tool call reached a sandbox at all -- masked, calibration ran on with an
# empty duty until a later python expression died on the empty string, reporting a syntax error in place
# of the diagnosis.
MASK_DIR="$(mktemp -d)"
cat >"$MASK_DIR/a.sh" <<'EOS'
set -euo pipefail
f() { echo "FATAL" >&2; exit 1; }
read -r a b <<<"$(f)"
echo "continued"
EOS
cat >"$MASK_DIR/b.sh" <<'EOS'
set -euo pipefail
f() { echo "FATAL" >&2; exit 1; }
out="$(f)"
read -r a b <<<"$out"
echo "continued"
EOS
A_OUT="$(bash "$MASK_DIR/a.sh" 2>/dev/null || true)"
B_OUT="$(bash "$MASK_DIR/b.sh" 2>/dev/null || true)"
rm -rf "$MASK_DIR"
if [ "$A_OUT" = "continued" ] && [ "$B_OUT" != "continued" ]; then
  ok "confirmed: read <<<\"\$(fn)\" masks a die; a plain assignment does not"
else
  ko "the masking demonstration did not behave as expected (a='$A_OUT' b='$B_OUT') -- re-derive before trusting the assertion below"
fi

# So every call to a function that can `die` must capture into a variable FIRST.
for fn in probe_duty read_duty_band; do
  if printf '%s' "$CODE" | grep -qE "read -r [a-z_ ]+<<<\"\\\$\($fn"; then
    ko "$fn is called inside a read here-string -- its die would be masked and the run would continue on empty values"
  else
    ok "$fn is captured into a variable before being read, so its die stops the run"
  fi
done
# `local out="$(fn)"` masks it too, because `local` supplies its own exit status.
if printf '%s' "$CODE" | grep -qE 'local [a-z_]+="\$\((probe_duty|read_duty_band)'; then
  ko "a die-capable function is captured with 'local x=\$(...)', which masks the failure the same way"
else
  ok "no die-capable capture hides behind a local declaration"
fi

# The band check must NOT apply to the capacity arm: there is no §2.3 row to land in, and a trivial
# exec cannot reach 0.061-0.079 by construction. A shared exit path would refuse every capacity run.
if printf '%s' "$CODE" | grep -qE 'could not land duty in'; then
  BAND_LINE="$(printf '%s\n' "$CODE" | grep -nE 'could not land duty in' | head -1 | cut -d: -f1)"
  if printf '%s\n' "$CODE" | sed -n "1,${BAND_LINE}p" | grep -qE 'ARM.*=.*capacity|capacity.*ARM|\$ARM'; then
    ok "the duty-band refusal is reached only on the calibrated path"
  else
    ko "the duty-band refusal is unconditional -- it would refuse every capacity-arm run"
  fi
fi

exit "$FAIL"
