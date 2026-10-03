#!/usr/bin/env bash
# Writes the generated overlay exactly as `deploy/k8s/setup.sh` does, by sourcing setup.sh and
# calling its own write_overlay, so generated-overlay.test.ts cannot drift from the script.
#
#   write-generated-overlay.sh DIR
#
# Globals come from the environment as GO_<name>: GO_TARGET, GO_IMAGE, GO_SANDBOX_IMAGE, GO_SUP_HOST,
# GO_CP_HOST, GO_SANDBOX_COUNT, GO_CLIENT_ID, GO_SETTINGS_HASH -- what setup.sh's earlier steps would
# have set. Prefixed because sourcing setup.sh resets its own globals (TARGET='' and so on).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../../../deploy/k8s/setup.sh
SH_SOURCE_ONLY=1 source "$here/../../../../../deploy/k8s/setup.sh"
# shellcheck disable=SC2034 # every one is read by the sourced write_overlay
{
  TARGET="${GO_TARGET:?}"
  IMAGE="${GO_IMAGE-}"
  SANDBOX_IMAGE="${GO_SANDBOX_IMAGE-}"
  SUP_HOST="${GO_SUP_HOST-}"
  CP_HOST="${GO_CP_HOST-}"
  SH_SANDBOX_COUNT="${GO_SANDBOX_COUNT:?}"
  CLIENT_ID="${GO_CLIENT_ID-}"
  SETTINGS_HASH="${GO_SETTINGS_HASH:?}"
}
write_overlay "${1:?usage: write-generated-overlay.sh DIR}"
