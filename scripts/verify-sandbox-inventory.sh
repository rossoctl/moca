#!/usr/bin/env bash
# scripts/verify-sandbox-inventory.sh <image-ref>
#
# Verify a checked-in inventory against the image it describes: every declared binary must
# actually resolve inside the image. Requires docker (or podman, via CONTAINER_RUNTIME) and
# the image.
#
# All declared binaries are checked in a SINGLE container rather than one container per
# binary -- with 445 declared binaries and a ~0.2s container-start cost, one-per-binary would
# take well over a minute per run for no benefit: the check itself (`command -v`) is instant.
#
# The shape test (harness/test/promote.test.ts) cannot catch drift, because drift is a
# disagreement with reality rather than with the schema.
set -euo pipefail

IMAGE="${1:?usage: verify-sandbox-inventory.sh <image-ref>}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../harness/sandbox-inventory" && pwd)"
FILE="$DIR/$(printf '%s' "$IMAGE" | tr ':/' '__').json"

[ -f "$FILE" ] || { echo "no inventory for $IMAGE (expected $FILE)"; exit 1; }

RUNTIME="${CONTAINER_RUNTIME:-docker}"
mapfile -t declared < <(jq -r '.binaries[]' "$FILE")
# Third silent-pass path: process substitution failure does not trip `set -e`, so malformed JSON
# or a missing `.binaries` key would leave `declared` empty -- the container then checks nothing,
# still prints the sentinel, and the script would report "PASS ... (0 binaries verified)".
[ "${#declared[@]}" -gt 0 ] || { echo "ERROR: no binaries parsed from $FILE"; exit 1; }
echo "verifying ${#declared[@]} declared binaries in $IMAGE"

# A drift check that cannot fail is worthless, so the container's own failure must never be
# mistaken for "nothing missing". Two guards:
#
#   1. The runtime's exit status is captured explicitly. A blanket `|| true` here would swallow
#      a pull failure, an unrunnable image (wrong architecture), or a dead daemon, leaving
#      `missing` empty and reporting PASS for an image that was never inspected. That was a real
#      bug: pointed at a nonexistent ref, this script printed "PASS: inventory matches" and
#      exited 0.
#   2. The container prints a sentinel as its last act. If the inner shell dies partway through
#      -- OOM, a SIGKILL, a truncated stream -- the status can still be 0 while the output is
#      incomplete, which would read as "no binaries missing". No sentinel, no verdict.
#
# The inner loop deliberately always exits 0 (both `command -v` and `printf` succeed), so a
# non-zero status means the runtime or the image failed, never that a binary was absent.
set +e
out="$("$RUNTIME" run --rm --entrypoint sh "$IMAGE" -c '
  for b in "$@"; do command -v "$b" >/dev/null 2>&1 || printf "MISSING %s\n" "$b"; done
  printf "SENTINEL_VERIFIED\n"
' sh "${declared[@]}" 2>&1)"
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
  echo "ERROR: could not run $IMAGE with $RUNTIME (exit $rc). The inventory was NOT verified."
  echo "$out" | sed 's/^/  /'
  exit 1
fi

case $out in
  *SENTINEL_VERIFIED*) ;;
  *)
    echo "ERROR: $RUNTIME ran but the in-container check did not complete (no sentinel)."
    echo "The inventory was NOT verified. Output was:"
    echo "$out" | sed 's/^/  /'
    exit 1
    ;;
esac

missing="$(printf '%s\n' "$out" | sed -n 's/^MISSING //p')"
if [ -n "$missing" ]; then
  echo "INVENTORY DRIFT: $FILE declares binaries the image does not provide:"
  printf '%s\n' "$missing" | sed 's/^/  /'
  echo "Preflight would report these as present and pass a promotion that fails remotely."
  exit 1
fi
echo "PASS: inventory matches $IMAGE (${#declared[@]} binaries verified in-image)"
