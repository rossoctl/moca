#!/usr/bin/env bash
# Renders deploy/k8s/overlays/ocp-combined with the real `kubectl kustomize` (no cluster needed) and
# asserts what the combined control plane needs (docs/specs/2026-11-05-combined-control-plane-
# design.md §3.6): the harness's supervisor beside SBX0's relay Routes and template store, the
# control plane on the combined profile with both profiles' credentials, the relay taking both Exec
# callers, one namespace, every address in it, and NO cluster-scoped object.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
command -v kubectl >/dev/null || { echo "FAIL: kubectl is required (kubectl kustomize)" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq is required" >&2; exit 1; }
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
OUT="$TMPD/render.yaml" JSON="$TMPD/render.json"
kubectl kustomize "$ROOT/deploy/k8s/overlays/ocp-combined" >"$OUT"
KUBECONFIG=/dev/null kubectl label --local -f "$OUT" combined-render- -o json | jq -s . >"$JSON"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
q() { local f="$1"; shift; jq -r "$@" "$f" "$JSON"; }
obj() { q '.[] | select(.kind == $k and .metadata.name == $n)' --arg k "$1" --arg n "$2" -c; }
has() { [[ -n "$(obj "${1%%/*}" "${1#*/}")" ]] || fail "missing $1"; }
env_of() { # env_of KIND NAME CONTAINER VAR -> its literal value, or "<ref>" when from a source
  obj "$1" "$2" | jq -r --arg c "$3" --arg v "$4" \
    '.spec.template.spec.containers[] | select(.name == $c) | .env[]? | select(.name == $v) | (.value // "<ref>")'
}

[[ "$(q 'length')" -gt 0 ]] || fail 'the render converted to no objects'

for o in Deployment/moca-control-plane Deployment/moca-supervisor Deployment/sandbox-relay \
  StatefulSet/redis Route/moca Route/moca-api Route/moca-relay Route/sbx-exec \
  PersistentVolumeClaim/moca-sbx-templates PersistentVolumeClaim/moca-credentials \
  Service/sandbox-relay-exec Service/sbx-relay-exec-tls; do
  has "$o"
done
[[ -z "$(obj Route moca-control-plane)" ]] || fail 'a second API Route (moca-control-plane) is rendered'
pass 'renders the supervisor and its Route beside the relay Routes, one API Route, the template store '

# Namespaced only: the scope a namespace grant covers.
n="$(q '[.[] | select(.kind | test("^(Namespace|ClusterRole|ClusterRoleBinding|SecurityContextConstraints|PersistentVolume|StorageClass|CustomResourceDefinition)$"))] | length')"
[[ "$n" == 0 ]] || fail "renders $n cluster-scoped objects"
[[ "$(q '[.[] | .metadata.namespace] | unique | join(",")')" == moca-sbx-combined ]] || fail 'more than one namespace'
! grep -q 'moca-single' "$OUT" || fail 'an address still names the ocp-single placeholder'
pass 'renders no cluster-scoped object, one namespace, and no address of another'

[[ "$(env_of Deployment moca-control-plane control-plane SH_ROUTE_PROFILE)" == combined ]] || fail 'the control plane is not on the combined profile'
[[ "$(env_of Deployment moca-control-plane control-plane SH_ALLOWED_SUBJECTS)" == '<ref>' ]] || fail 'no SH_ALLOWED_SUBJECTS'
[[ "$(env_of Deployment moca-control-plane control-plane SH_PROVENANCE_DIR)" == /var/lib/moca/templates ]] || fail 'no template store'
items="$(obj Deployment moca-control-plane | jq -r '.spec.template.spec.volumes[] | select(.name == "credentials") | .projected.sources[] | (.secret.items // [])[] | .key' | sort | tr '\n' ' ')"
for k in SH_CREDENTIAL_KEK SH_EXCHANGE_TOKEN SH_JANITOR_TOKEN SH_SESSION_TOKEN_PRIVATE_KEY; do
  [[ " $items" == *" $k "* ]] || fail "the control plane does not mount $k"
done
[[ "$(env_of Deployment moca-control-plane control-plane SH_CREDENTIAL_STORE)" == file ]] || fail 'the harness credential store is not the file store'
[[ "$(q '[.[] | select(.kind == "Role" or .kind == "RoleBinding")] | length')" == 0 ]] || fail 'a Role over the namespace is rendered'
[[ "$(obj Deployment moca-control-plane | jq -r '.spec.template.spec.automountServiceAccountToken')" == false ]] || fail 'the control plane mounts a service account token'
pass 'puts the control plane on the combined profile, with both profiles'"'"' settings and credentials, files only: no Role, no API token'

[[ "$(env_of Deployment sandbox-relay sandbox-relay MOCA_RELAY_EXEC_TOKEN)" == '<ref>' ]] || fail 'the relay lost the harness exec token'
[[ "$(env_of Deployment sandbox-relay sandbox-relay SH_SANDBOX_TOKEN_PUBLIC_KEYS)" == '<ref>' ]] || fail 'the relay has no sandbox keyset'
[[ "$(env_of Deployment moca-supervisor supervisor SH_RELAY_ADDR)" == sandbox-relay-exec.moca-sbx-combined.svc:9444 ]] || fail 'the supervisor does not reach the relay in this namespace'
pass 'lets the relay take both Exec callers, and the supervisor reach it in the namespace'

echo 'all ocp-combined overlay tests passed'
