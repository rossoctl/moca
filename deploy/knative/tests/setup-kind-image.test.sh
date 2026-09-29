#!/usr/bin/env bash
# deploy/knative/tests/setup-kind-image.test.sh
#
# Unit test for ensure_harness_image() in ../setup-kind.sh — the harness-image
# provisioning decision (pull-by-default, --build force, --skip-build reuse, and
# transparent fallback to a local build when the pull is unavailable).
#
# No cluster required: docker/kind are mocked on PATH and only the call log is
# asserted. Run: bash deploy/knative/tests/setup-kind-image.test.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/setup-kind.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/calls.log"

# --- mocks: log every invocation; `docker pull` exit code is controlled by MOCK_PULL_RC ---
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$MOCK_LOG"
[ "${1:-}" = "pull" ] && exit "${MOCK_PULL_RC:-0}"
exit 0
EOF
cat > "$TMP/bin/kind" <<'EOF'
#!/usr/bin/env bash
echo "kind $*" >> "$MOCK_LOG"
exit 0
EOF
chmod +x "$TMP/bin/docker" "$TMP/bin/kind"
export PATH="$TMP/bin:$PATH"

# Run ensure_harness_image() in a subshell with the given knobs; capture the call log.
# Args: SKIP_BUILD FORCE_BUILD MOCK_PULL_RC. Captured into named vars first because sourcing
# setup-kind.sh runs its arg-parse loop, which shifts away the subshell's positional params.
run_case() {
  : > "$MOCK_LOG"
  local sb="$1" fb="$2" prc="$3"
  # SKIP_BUILD/FORCE_BUILD/SH_IMAGE/LOCAL_IMAGE/CLUSTER_NAME are consumed by
  # ensure_harness_image, which is defined in the sourced setup-kind.sh — shellcheck
  # can't follow the source, hence the directives below.
  # shellcheck disable=SC2034
  (
    # shellcheck source=/dev/null
    SH_SOURCE_ONLY=1 source "$SCRIPT"
    SKIP_BUILD="$sb" FORCE_BUILD="$fb"
    SH_IMAGE="ghcr.io/rossoctl/moca:latest"
    LOCAL_IMAGE="dev.local/moca:local"
    CLUSTER_NAME="sh-test"
    export MOCK_PULL_RC="$prc"
    ensure_harness_image
  ) >/dev/null
}

FAILS=0
# assert_grep / assert_absent <pattern> <message>
assert_grep()   { if grep -q -- "$1" "$MOCK_LOG"; then echo "  ok: $2"; else echo "  FAIL: $2 (expected /$1/)"; FAILS=$((FAILS+1)); fi; }
assert_absent() { if grep -q -- "$1" "$MOCK_LOG"; then echo "  FAIL: $2 (unexpected /$1/)"; FAILS=$((FAILS+1)); else echo "  ok: $2"; fi; }

echo "case 1: default (pull succeeds) -> pull + tag + load, no build"
run_case false false 0
assert_grep   "docker pull ghcr.io/rossoctl/moca:latest" "pulls the published image"
assert_grep   "docker tag"        "retags to the local image"
assert_grep   "kind load"         "loads into kind"
assert_absent "docker build"      "does not build locally"

echo "case 2: default but pull fails -> falls back to local build"
run_case false false 1
assert_grep   "docker pull"       "attempts the pull first"
assert_grep   "docker build"      "falls back to a local build"
assert_grep   "kind load"         "loads the built image"

echo "case 3: --build (FORCE_BUILD) -> build only, never pulls"
run_case false true 0
assert_grep   "docker build"      "builds locally"
assert_grep   "kind load"         "loads the built image"
assert_absent "docker pull"       "does not pull"

echo "case 4: --skip-build -> neither pull nor build"
run_case true false 0
assert_absent "docker"            "runs no docker command"
assert_absent "kind"              "runs no kind command"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "PASS: all ensure_harness_image cases"
else
  echo "FAIL: $FAILS assertion(s) failed"
fi
exit "$FAILS"
