#!/usr/bin/env bash
# E8 must not name a bound when the ladder never found one.
#
# With saturated=no the top rung was still healthy, so nothing ran out. Attributing a tier anyway
# gives a run that degraded nowhere a cause, which is the failure this whole attribution block was
# written to avoid ("a guessed tier would put a cause into a document people cite").
#
# Observed at W=4 S=16: every rung answered 1920/1920 with p95 flat at ~1420ms and worst-worker loop
# lag flat at ~11ms, and the run still reported bound=sandbox-pool -- because lease_saturation 1.33
# cleared the 0.95 threshold. That is 1.33 leases per SANDBOX against a cap of 13, i.e. about a tenth
# of the pool, named as the binding constraint. The scale mismatch is tracked separately; this guard
# is independent of it, since with nothing saturated no threshold should be consulted at all.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAIL=0
ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  FAIL=1
}

# --- 1. The default, before any tier is considered, is "not observed". -------------------------
if grep -q '"tag": "not-observed"' e8-density.sh; then
  ok "the bound defaults to not-observed"
else
  ko "no not-observed default -- a healthy ladder will still be given a tier"
fi

# --- 2. Tier attribution is gated on the ladder having saturated. -----------------------------
DEF_LINE="$(grep -n '"tag": "not-observed"' e8-density.sh | head -1 | cut -d: -f1)"
GATE_LINE="$(grep -n 'if \[ "\$SATURATED" = yes \]; then' e8-density.sh | head -1 | cut -d: -f1)"
JQ_LINE="$(grep -n '^BOUND_JSON="\$(printf' e8-density.sh | head -1 | cut -d: -f1)"
if [ -z "$DEF_LINE" ] || [ -z "$GATE_LINE" ] || [ -z "$JQ_LINE" ]; then
  ko "could not locate the default, the saturated gate, and the attribution jq (got '$DEF_LINE' '$GATE_LINE' '$JQ_LINE')"
elif [ "$DEF_LINE" -lt "$GATE_LINE" ] && [ "$GATE_LINE" -lt "$JQ_LINE" ]; then
  ok "the attribution jq runs only inside the saturated=yes branch (lines $DEF_LINE < $GATE_LINE < $JQ_LINE)"
else
  ko "ordering is wrong: default=$DEF_LINE gate=$GATE_LINE jq=$JQ_LINE"
fi

# --- 3. "not observed" must not trip the unattributed WARN. -----------------------------------
# They mean different things: `unattributed` is a telemetry gap at a real knee; `not-observed` is a
# true statement that no knee was reached. Conflating them would warn on every healthy run.
if grep -q '\[ "\$BOUND_TAG" != unattributed \]' e8-density.sh &&
  ! grep -q '\[ "\$BOUND_TAG" != not-observed \]' e8-density.sh; then
  ok "the unattributed WARN is keyed to unattributed only, so a healthy ladder does not warn"
else
  ko "the unattributed WARN does not distinguish not-observed from unattributed"
fi

# --- 4. The claim sentence must still describe an unsaturated ladder as a ladder limit. -------
if grep -q 'was still healthy: this is the ladder' e8-density.sh; then
  ok "an unsaturated run is reported as the ladder's limit, not the machine's"
else
  ko "an unsaturated run no longer says the limit is the ladder's"
fi

# --- 5. Why the guard is load-bearing: the threshold really does fire at ~10% of the pool. ----
# Documents the scale mismatch as a fact rather than an opinion, using the observed value. The outer
# parentheses matter -- see check 6.
GOT="$(jq -nr '(((1.33 | tonumber?) // 0) >= 0.95)')"
if [ "$GOT" = "true" ]; then
  ok "confirmed: lease_saturation 1.33 clears the 0.95 threshold, though it is ~10% of a cap-13 pool"
else
  ko "expected 1.33 >= 0.95 to hold; the scale premise of this guard is wrong"
fi

# --- 6. The threshold's own parentheses are load-bearing. -------------------------------------
# In jq, `//` binds LOOSER than `>=`, so `(x | tonumber?) // 0 >= 0.95` parses as
# `x // (0 >= 0.95)` and evaluates to the NUMBER 1.33 rather than a boolean. jq treats any
# non-false/non-null value as true, so dropping the outer parens would make the sandbox-pool branch
# fire for ANY non-zero lease_saturation -- silently, with no syntax error. Verified below, and it
# is the same precedence trap that produced a wrong first version of this very test.
BAD="$(jq -nr '(1.33 | tonumber?) // 0 >= 0.95')"
if [ "$BAD" = "1.33" ]; then
  ok "confirmed: without the outer parens the condition yields 1.33, which jq treats as true"
else
  ko "expected the unparenthesised form to yield 1.33, got '$BAD'"
fi
# Asserted as the PROPERTY (each `// 0` is parenthesised before its comparison) rather than as one
# exact line: the sandbox-pool condition now spans two lines, because convicting the lease pool also
# requires the tier's MEASURED utilisation to agree -- a tier at 5.5% busy was once named the bound on
# lease saturation alone. Every numeric threshold in the branch is checked here, so a new one cannot be
# added unparenthesised.
for expr in \
  '(($k.lease_saturation | tonumber?) // 0) >= 0.95' \
  '(($k.sandbox_util | tonumber?) // 0) >= $sbx_bound_pct' \
  '(($k.worker_cpu_util | tonumber?) // 0) >= $wcpu_pct'; do
  if grep -qF "$expr" e8-density.sh; then
    ok "parenthesised threshold present: $expr"
  else
    ko "missing or unparenthesised threshold: $expr"
  fi
done

exit "$FAIL"
