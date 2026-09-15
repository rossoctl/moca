#!/usr/bin/env bash
# Guards E8's sandbox-pool precondition against the two ways it was wrong.
#
# It used to be `podman ps --format '{{.Names}}' | grep -c '^sh-sandbox-'`, evaluated wherever the
# driver happened to run:
#
#   1. WRONG BOX. setup-vm.sh starts containers under ROOT podman, so a driver run as a normal user
#      counted 0 against three running containers. And off-box -- the placement B4 and §8 require --
#      podman ps enumerates the GENERATOR's containers, which hold no sandboxes, so the gate could
#      never pass on the required topology.
#   2. WRONG QUANTITY. What a turn can lease is a presence RECORD, not a container. Observed on
#      hardware: three healthy sh-sandbox-* containers alongside an empty record set, because the
#      image carried no relay leaf. A container count passes this gate against a pool of zero --
#      exactly the run it exists to refuse.
#
# Every check below is a grep over the driver, so a revert fails the suite rather than passing it.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAIL=0
ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  FAIL=1
}

# Helper: grep that treats "no match" as a test failure rather than a silent pass. e9-tiers.test.sh
# had ordering assertions that short-circuited to ok on an empty grep result; this avoids that.
line_of() {
  local pat="$1" file="$2" n
  n="$(grep -nE "$pat" "$file" | head -1 | cut -d: -f1)"
  if [ -z "$n" ]; then
    echo ""
    return 1
  fi
  echo "$n"
}

# --- 1. The floor must not be counted from a local container runtime. -------------------------
if grep -nE "podman ps.*sh-sandbox-|sh-sandbox-.*podman ps" e8-density.sh | grep -vE '^\s*[0-9]+:\s*#' | grep -q .; then
  ko "e8-density.sh still counts the sandbox floor with a local podman ps"
else
  ok "e8-density.sh does not count the floor from a local container runtime"
fi

# --- 2. It must read the supervisor's own reported pool size. ----------------------------------
if grep -q 'sandbox_pool_size' e8-density.sh; then
  ok "e8-density.sh reads sandbox_pool_size from the supervisor"
else
  ko "e8-density.sh does not read sandbox_pool_size -- the floor is not sourced from the supervisor"
fi

# --- 3. It must read it from METRICS_BASE, not from the data port. -----------------------------
# Scoped to the function body, so this cannot be satisfied by METRICS_BASE appearing anywhere else
# in the driver (it appears in several places). An earlier version of this check had an alternation
# whose first branch was subsumed by the second, making half of it decoration.
if grep -A4 'check_sandbox_floor()' e8-density.sh | grep -q 'METRICS_BASE/metrics'; then
  ok "the floor check fetches from \$METRICS_BASE/metrics"
else
  ko "the floor check does not fetch from \$METRICS_BASE/metrics"
fi

# --- 4. "Never observed" must be handled explicitly, not treated as 0. ------------------------
if grep -A20 'check_sandbox_floor()' e8-density.sh | grep -qE '"NaN"|NaN'; then
  ok "the floor check handles an unobserved pool size explicitly"
else
  ko "the floor check does not distinguish an unobserved pool size from 0"
fi

# --- 5. Ordering: the floor is checked AFTER require_live_arm. --------------------------------
# The size only exists once a worker has selected, so checking it before a live rung would always
# read unobserved. Both greps must match or this is a failure, not a pass.
#
# The guard matches the CONDITION line and then requires the call within the next few lines, rather
# than pinning them to one physical line as it originally did: the once-only block grew a second
# statement when the capacity arm's deferred lease-headroom check joined it (issue #254 item 2d),
# which shares the same "not knowable until a turn has leased" constraint. The ordering this test
# exists to protect is unchanged, and is still asserted below.
LIVE_LINE="$(line_of 'require_live_arm "\$C"' e8-density.sh)"
GATE_LINE="$(line_of 'if \[ "\$SANDBOX_COUNT" = "unknown" \]' e8-density.sh)"
if [ -n "$GATE_LINE" ] &&
  ! sed -n "${GATE_LINE},$((GATE_LINE + 3))p" e8-density.sh | grep -q 'check_sandbox_floor'; then
  ko "the once-only block at line $GATE_LINE does not call check_sandbox_floor within 3 lines"
  GATE_LINE=""
fi
if [ -z "$LIVE_LINE" ] || [ -z "$GATE_LINE" ]; then
  ko "could not locate both require_live_arm and the floor-check call (greps found: live='$LIVE_LINE' gate='$GATE_LINE')"
elif [ "$GATE_LINE" -gt "$LIVE_LINE" ]; then
  ok "the floor is checked after require_live_arm (lines $LIVE_LINE then $GATE_LINE)"
else
  ko "the floor is checked at line $GATE_LINE, BEFORE require_live_arm at $LIVE_LINE -- it would always read unobserved"
fi

# --- 6. The check runs once, not per rung. ----------------------------------------------------
if grep -q 'SANDBOX_COUNT" = "unknown"' e8-density.sh; then
  ok "the floor check is guarded to run once, not on every rung"
else
  ko "the floor check is not guarded against re-running each rung"
fi

# --- 7. The record must not call the number a container count. ---------------------------------
if grep -qE '^\s*echo "- Sandbox pool: \$SANDBOX_COUNT containers' e8-density.sh; then
  ko "the results record still calls the pool size a container count"
else
  ok "the results record does not describe the pool size as containers"
fi

exit "$FAIL"
