#!/usr/bin/env bash
# Writes the generated overlay exactly as `deploy/k8s/setup.sh` does, by sourcing setup.sh and
# calling its own write_overlay, so generated-overlay.test.ts cannot drift from the script.
#
#   write-generated-overlay.sh DIR
#
# Globals come from the environment as GO_<name>: GO_TARGET, GO_IMAGE, GO_SANDBOX_IMAGE, GO_SUP_HOST,
# GO_CP_HOST, GO_SANDBOX_COUNT, GO_CLIENT_ID, GO_SETTINGS_HASH, GO_P4_IDS, GO_RELAY_HOST, GO_ROUTE_DOMAIN,
# GO_TLS_SECRET, GO_HARNESS_IMAGE_ID, GO_SANDBOX_IMAGE_ID, GO_EGRESS_EXCEPT (space-separated CIDRs),
# GO_NS and GO_SBX_NS (ocp-single's namespace; default setup.sh's own), GO_WORKLOAD_SANDBOXES,
# GO_KUBE_API_EGRESS (the provisioner's egress list, JSON), GO_WORKLOAD_CLASSES and GO_OTHER_CLASSES
# (space-separated; workload_storage_classes), GO_REDIS_ACL_HASH (ensure_redis_secret's),
# GO_WORKSPACE_IDLE (write_settings' resolved SH_WORKSPACE_IDLE; default setup.sh's own) -- what
# setup.sh's earlier steps would have set. Prefixed because sourcing setup.sh resets its own globals
# (TARGET='' and so on).
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
  P4_IDS="${GO_P4_IDS-}"
  RELAY_HOST="${GO_RELAY_HOST-}"
  ROUTE_DOMAIN="${GO_ROUTE_DOMAIN-}"
  TLS_SECRET="${GO_TLS_SECRET-}"
  HARNESS_IMAGE_ID="${GO_HARNESS_IMAGE_ID-}"
  SANDBOX_IMAGE_ID="${GO_SANDBOX_IMAGE_ID-}"
  EGRESS_EXCEPT="${GO_EGRESS_EXCEPT-}"
  NS="${GO_NS-moca}"
  SBX_NS="${GO_SBX_NS-moca-sandbox}"
  WORKLOAD_SANDBOXES="${GO_WORKLOAD_SANDBOXES-}"
  KUBE_API_EGRESS="${GO_KUBE_API_EGRESS-}"
  WORKLOAD_CLASSES="${GO_WORKLOAD_CLASSES-}"
  OTHER_CLASSES="${GO_OTHER_CLASSES-}"
  REDIS_ACL_HASH="${GO_REDIS_ACL_HASH-}"
  WORKSPACE_IDLE="${GO_WORKSPACE_IDLE-$DEFAULT_WORKSPACE_IDLE}"
}
write_overlay "${1:?usage: write-generated-overlay.sh DIR}"
