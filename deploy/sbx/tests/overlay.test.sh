#!/usr/bin/env bash
# Renders deploy/k8s/overlays/ocp-sbx with the real `kubectl kustomize` (no cluster needed) and
# asserts what SBX0 1a needs: the relay and Redis only, both TLS Routes, the exec listener bound to
# loopback, one namespace, and the relay reachable from the router alone. Spec SBX0 §2, §8.1.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Fails, never skips: a skip would read as a pass for the overlay's security checks, and CI's
# deploy-scripts runner has kubectl (a recorded review ruling on PR #547).
command -v kubectl >/dev/null || { echo "FAIL: kubectl is required (kubectl kustomize)" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq is required" >&2; exit 1; }
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
OUT="$TMPD/render.yaml" JSON="$TMPD/render.json"
kubectl kustomize "$ROOT/deploy/k8s/overlays/ocp-sbx" >"$OUT"
# The same objects as one JSON array, so each assertion reads exactly one object. `label --local`
# with a no-op removal is only a YAML-to-JSON converter here: it never contacts a cluster.
KUBECONFIG=/dev/null kubectl label --local -f "$OUT" sbx-render- -o json | jq -s . >"$JSON"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

# q FILTER [jq args...]: run FILTER over the array of rendered objects.
q() { local f="$1"; shift; jq -r "$@" "$f" "$JSON"; }
# obj KIND NAME: the one rendered object (JSON), or nothing.
obj() { q '.[] | select(.kind == $k and .metadata.name == $n)' --arg k "$1" --arg n "$2" -c; }
has() { [[ -n "$(obj "${1%%/*}" "${1#*/}")" ]] || fail "missing $1"; }
hasnt() { [[ -z "$(obj "${1%%/*}" "${1#*/}")" ]] || fail "unexpected $1"; }

[[ "$(q 'length')" -gt 0 ]] || fail 'the render converted to no objects'

for o in Deployment/sandbox-relay StatefulSet/redis Route/moca-relay Route/sbx-exec \
  Service/sandbox-relay-tls Service/sbx-relay-exec-tls NetworkPolicy/sbx-relay-exec-from-router \
  NetworkPolicy/sandbox-relay-from-router; do
  has "$o"
done
pass 'renders the relay, Redis, both Routes and their Services'

for o in Deployment/moca-supervisor StatefulSet/moca-sandbox Deployment/moca-control-plane \
  Role/moca-control-plane-credentials RoleBinding/moca-control-plane-credentials; do
  hasnt "$o"
done
pass 'renders no supervisor, sandbox pods, control plane (1b) or credentials Role'

for n in moca-supervisor moca-sandbox moca-control-plane; do
  for k in Service ServiceAccount NetworkPolicy; do hasnt "$k/$n"; done
done
pass 'renders no supervisor, sandbox or control-plane Service, ServiceAccount or NetworkPolicy'

hasnt Service/sandbox-relay-attach
hasnt Service/sandbox-relay-exec
# What remains in front of the relay is the two ghostunnel Services, and the Routes target them.
[[ "$(obj Route moca-relay | jq -r .spec.to.name)" == sandbox-relay-tls ]] || fail 'Route/moca-relay does not target Service/sandbox-relay-tls'
[[ "$(obj Route sbx-exec | jq -r .spec.to.name)" == sbx-relay-exec-tls ]] || fail 'Route/sbx-exec does not target Service/sbx-relay-exec-tls'
[[ "$(obj Service sandbox-relay-tls | jq -c '[.spec.ports[].port]')" == '[8444]' ]] || fail 'Service/sandbox-relay-tls is not on 8444 only'
[[ "$(obj Service sbx-relay-exec-tls | jq -c '[.spec.ports[].port]')" == '[8445]' ]] || fail 'Service/sbx-relay-exec-tls is not on 8445 only'
pass 'no in-cluster relay Service (attach 9443, exec 9444); the Routes reach the sidecars on 8444/8445'

[[ "$(q '[.[] | .metadata.namespace // empty] | unique | join(" ")')" == moca-sbx ]] ||
  fail "objects outside moca-sbx: $(q '[.[] | .metadata.namespace // empty] | unique | join(" ")')"
pass 'every namespaced object is in the placeholder namespace'

# The relay's own NetworkPolicy keeps its Redis egress but admits nothing.
[[ "$(obj NetworkPolicy sandbox-relay | jq -c '.spec.ingress')" == '[]' ]] ||
  fail "NetworkPolicy/sandbox-relay admits ingress: $(obj NetworkPolicy sandbox-relay | jq -c .spec.ingress)"
[[ "$(obj NetworkPolicy sandbox-relay | jq -c '.spec.policyTypes | index("Ingress") != null')" == true ]] ||
  fail 'NetworkPolicy/sandbox-relay does not govern Ingress (an empty ingress would then deny nothing)'
pass 'NetworkPolicy/sandbox-relay has no ingress (ingress: [])'

# Every policy that governs the relay pods' ingress: an empty podSelector, app=sandbox-relay, or an
# `app In [...]` expression naming it. Its rules, taken together, must be the router namespace on
# 8444 (attach sidecar) and 8445 (exec sidecar), and nothing else.
RELAY_INGRESS='[.[] | select(.kind == "NetworkPolicy")
  | select((.spec.policyTypes // ["Ingress"]) | index("Ingress"))
  | select(.spec.podSelector == {}
      or .spec.podSelector.matchLabels.app == "sandbox-relay"
      or ([.spec.podSelector.matchExpressions[]? | select(.key == "app" and .operator == "In" and (.values | index("sandbox-relay")))] | length > 0))
  | {name: .metadata.name, rule: (.spec.ingress // [])[]}]'
ROUTER='[{"namespaceSelector":{"matchLabels":{"policy-group.network.openshift.io/ingress":""}}}]'
bad="$(q "$RELAY_INGRESS"' | map(select((.rule.from | tojson) != ($r | tojson) or (.rule.ports | length) != 1 or (.rule.ports[0].protocol // "TCP") != "TCP")) | map(.name) | join(" ")' --argjson r "$ROUTER")"
[[ -z "$bad" ]] || fail "an ingress rule to the relay pods admits more than the router on one TCP port: $bad"
ports="$(q "$RELAY_INGRESS"' | map(.rule.ports[0].port) | sort | map(tostring) | join(" ")')"
[[ "$ports" == '8444 8445' ]] || fail "ingress to the relay pods is on '$ports', want '8444 8445'"
[[ "$(q "$RELAY_INGRESS"' | map(select(.rule.ports[0].port == 8444) | .name) | join(" ")')" == sandbox-relay-from-router ]] ||
  fail 'router ingress on 8444 does not come from NetworkPolicy/sandbox-relay-from-router alone'
[[ "$(q "$RELAY_INGRESS"' | map(select(.rule.ports[0].port == 8445) | .name) | join(" ")')" == sbx-relay-exec-from-router ]] ||
  fail 'router ingress on 8445 does not come from NetworkPolicy/sbx-relay-exec-from-router alone'
pass 'the only ingress to the relay pods is the router namespace, on 8444 and 8445'

relay_env() { obj Deployment sandbox-relay | jq -r --arg c "$1" --arg e "$2" '.spec.template.spec.containers[] | select(.name == $c) | .env[]? | select(.name == $e) | .value // empty'; }
[[ "$(relay_env sandbox-relay MOCA_RELAY_EXEC_ADDR)" == 127.0.0.1:9444 ]] || fail 'the exec listener is not bound to loopback'
pass 'the exec listener is bound to loopback, so only the sidecar reaches it'

sidecar() { obj Deployment sandbox-relay | jq -r --arg c "$1" '.spec.template.spec.containers[] | select(.name == $c) | .args | join(" ")'; }
[[ "$(sidecar tls)" == *'--listen 0.0.0.0:8444 --target 127.0.0.1:9443 '* ]] || fail 'the attach sidecar does not forward 8444 -> 127.0.0.1:9443'
[[ "$(sidecar tls-exec)" == *'--listen 0.0.0.0:8445 --target 127.0.0.1:9444 '* ]] || fail 'the exec sidecar does not forward 8445 -> 127.0.0.1:9444'
[[ "$(obj Deployment sandbox-relay | jq -r '.spec.template.spec.volumes[] | select(.name == "exec-tls") | .secret.secretName')" == sbx-exec-tls ]] ||
  fail 'the exec sidecar does not mount sbx-exec-tls'
pass 'two ghostunnel sidecars: attach -> :9443, exec -> :9444'

[[ "$(obj Deployment sandbox-relay | jq -r '.spec.template.spec.containers[] | select(.name == "sandbox-relay") | .env[] | select(.name == "MOCA_RELAY_CLIENT_TOKENS") | .valueFrom.secretKeyRef.optional')" == true ]] ||
  fail 'MOCA_RELAY_CLIENT_TOKENS is not an optional Secret reference'
pass 'static client tokens come from an optional Secret (1a only)'

for r in moca-relay sbx-exec; do
  [[ "$(obj Route "$r" | jq -r .spec.tls.termination)" == passthrough ]] ||
    fail "Route/$r must be passthrough (gRPC must not cross the router TLS termination)"
done
pass 'both Routes are passthrough'
