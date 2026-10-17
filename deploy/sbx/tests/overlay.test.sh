#!/usr/bin/env bash
# Renders deploy/k8s/overlays/ocp-sbx with the real `kubectl kustomize` (no cluster needed) and
# asserts what SBX0 needs: the relay, Redis and the control plane on the sandbox profile, the two
# passthrough Routes and the API's edge Route, the exec listener bound to loopback, the relay on
# sandbox tokens alone, one namespace, and the relay and the control plane reachable from the router
# alone. Spec SBX0 §2, §3.1, §4.1, §8.1.
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
  NetworkPolicy/sandbox-relay-from-router Deployment/moca-control-plane Service/moca-control-plane \
  ServiceAccount/moca-control-plane NetworkPolicy/moca-control-plane Route/sbx-api \
  NetworkPolicy/moca-control-plane-from-router; do
  has "$o"
done
pass 'renders the relay, Redis, the control plane, the three Routes and their Services'

for o in Deployment/moca-supervisor StatefulSet/moca-sandbox \
  Role/moca-control-plane-credentials RoleBinding/moca-control-plane-credentials; do
  hasnt "$o"
done
pass 'renders no supervisor, sandbox pods or credentials Role'

# The control plane's Service, ServiceAccount and NetworkPolicy are expected (asserted above).
for n in moca-supervisor moca-sandbox; do
  for k in Service ServiceAccount NetworkPolicy; do hasnt "$k/$n"; done
done
pass 'renders no supervisor or sandbox Service, ServiceAccount or NetworkPolicy'

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

relay_ref() { obj Deployment sandbox-relay | jq -c --arg e "$1" '.spec.template.spec.containers[] | select(.name == "sandbox-relay") | .env[]? | select(.name == $e) | .valueFrom'; }
[[ -z "$(q '[.. | objects | select(.name? == "MOCA_RELAY_CLIENT_TOKENS")] | .[]' -c)" ]] || fail 'the 1a static client tokens are still wired'
[[ -z "$(relay_ref MOCA_RELAY_EXEC_TOKEN)$(relay_env sandbox-relay MOCA_RELAY_EXEC_TOKEN)" ]] || fail 'the relay still reads a harness exec token'
[[ "$(relay_ref SH_SANDBOX_TOKEN_PUBLIC_KEYS)" == '{"secretKeyRef":{"key":"PUBLIC_KEYS","name":"sbx-token-keys"}}' ]] ||
  fail "the relay does not read the sandbox public keys from sbx-token-keys/PUBLIC_KEYS: $(relay_ref SH_SANDBOX_TOKEN_PUBLIC_KEYS)"
[[ "$(relay_ref SH_SANDBOX_TOKEN_ISSUER)" == '{"configMapKeyRef":{"key":"SH_SANDBOX_TOKEN_ISSUER","name":"sbx-settings"}}' ]] ||
  fail 'the relay does not read the sandbox token issuer (it refuses to boot without one)'
[[ "$(relay_ref SH_SANDBOX_MAX_INFLIGHT)" == '{"configMapKeyRef":{"key":"SH_SANDBOX_MAX_INFLIGHT","name":"sbx-settings"}}' ]] ||
  fail 'the relay does not read the in-flight cap from sbx-settings'
pass 'the relay takes sandbox tokens and nothing else (no exec token, no static client tokens)'

CP="$(obj Deployment moca-control-plane)"
[[ -n "$CP" ]] || fail 'could not isolate the control-plane Deployment'
cp_env() { jq -c --arg e "$1" '.spec.template.spec.containers[] | select(.name == "control-plane") | .env[]? | select(.name == $e)' <<<"$CP"; }
[[ "$(cp_env SH_ROUTE_PROFILE | jq -r .value)" == sandbox ]] || fail 'control plane not on the sandbox profile'
for k in SH_CREDENTIAL_STORE SH_CREDENTIAL_NAMESPACE SH_SANDBOX_NAMESPACE SH_SANDBOX_TIERS \
  SH_SANDBOX_DEFAULT_TIER SH_PUBLIC_HARNESS_URL SH_ALLOW_OPERATOR_FALLBACK SH_CREDENTIAL_KEK SH_EXCHANGE_TOKEN; do
  ! grep -q "$k" <<<"$CP" || fail "the control plane still configures $k"
done
for k in SH_ALLOWED_SUBJECTS SH_SANDBOX_TEMPLATES SH_SANDBOX_EXEC_ENDPOINT SH_SANDBOX_EXEC_CA \
  SH_SANDBOX_TOKEN_ISSUER SH_SANDBOX_LIFETIME_SECONDS SH_SANDBOX_TOKEN_TTL_SECONDS SH_SANDBOX_RETENTION_SECONDS \
  SH_SANDBOX_MAX_PER_SUBJECT SH_SANDBOX_MAX_TOTAL; do
  [[ "$(cp_env "$k" | jq -r '.valueFrom.configMapKeyRef | "\(.name)/\(.key)"')" == "sbx-settings/$k" ]] ||
    fail "the control plane does not read $k from sbx-settings"
done
[[ "$(cp_env SH_SANDBOX_EXEC_CA | jq -r .valueFrom.configMapKeyRef.optional)" == true ]] ||
  fail 'SH_SANDBOX_EXEC_CA must be optional (absent when the exec certificate is issued)'
[[ "$(jq -c '[.spec.template.spec.volumes[] | select(.secret) | {s: .secret.secretName, k: [.secret.items[]?.key]}]' <<<"$CP")" == '[{"s":"moca-mu1","k":["SH_SESSION_TOKEN_PRIVATE_KEY"]}]' ]] ||
  fail "the control plane mounts more than its signing key: $(jq -c '[.spec.template.spec.volumes[] | select(.secret)]' <<<"$CP")"
[[ "$(jq -r .spec.template.spec.automountServiceAccountToken <<<"$CP")" == false ]] || fail 'the control plane still mounts a service account token'
pass 'the control plane runs the sandbox profile with only its signing key mounted'

# The control plane's own policy admits nothing (the base's supervisor ingress is reset).
[[ "$(obj NetworkPolicy moca-control-plane | jq -c '.spec.ingress')" == '[]' ]] ||
  fail "NetworkPolicy/moca-control-plane admits ingress: $(obj NetworkPolicy moca-control-plane | jq -c .spec.ingress)"
[[ "$(obj NetworkPolicy moca-control-plane | jq -c '.spec.policyTypes | index("Ingress") != null')" == true ]] ||
  fail 'NetworkPolicy/moca-control-plane does not govern Ingress (an empty ingress would then deny nothing)'
# Every policy that governs the control-plane pods' ingress, as for the relay: taken together, the
# router namespace on 8080 and nothing else, from moca-control-plane-from-router alone.
CP_INGRESS='[.[] | select(.kind == "NetworkPolicy")
  | select((.spec.policyTypes // ["Ingress"]) | index("Ingress"))
  | select(.spec.podSelector == {}
      or .spec.podSelector.matchLabels.app == "moca-control-plane"
      or ([.spec.podSelector.matchExpressions[]? | select(.key == "app" and .operator == "In" and (.values | index("moca-control-plane")))] | length > 0))
  | {name: .metadata.name, rule: (.spec.ingress // [])[]}]'
[[ "$(q "$CP_INGRESS"' | map({name, from: .rule.from, ports: .rule.ports})' -c)" == "[{\"name\":\"moca-control-plane-from-router\",\"from\":$ROUTER,\"ports\":[{\"port\":8080,\"protocol\":\"TCP\"}]}]" ]] ||
  fail "ingress to the control plane is not the router on 8080 alone: $(q "$CP_INGRESS" -c)"
pass 'the only ingress to the control plane is the router namespace, on 8080'

# The sandbox profile calls no Kubernetes API (no credential store, no service account token), so its
# egress is Redis and 443 (GitHub's device flow) only: the base's 6443 (kube API after DNAT) is dropped.
cp_ports="$(obj NetworkPolicy moca-control-plane | jq -r '[.spec.egress[].ports[]?.port] | sort | map(tostring) | join(" ")')"
[[ " $cp_ports " == *' 443 '* ]] || fail 'the control plane lost its 443 egress (GitHub device flow)'
[[ " $cp_ports " == *' 6379 '* ]] || fail 'the control plane lost its Redis egress'
[[ " $cp_ports " != *' 6443 '* ]] || fail 'the sandbox control plane still has 6443 (Kubernetes API) egress'
pass 'the control plane has no Kubernetes API egress (6443)'

[[ "$(obj Route sbx-api | jq -r .spec.tls.termination)" == edge ]] || fail 'the API Route is not edge-terminated'
[[ "$(obj Route sbx-api | jq -r .spec.to.name)" == moca-control-plane ]] || fail 'the API Route does not target the control plane'
[[ "$(q '[.[] | select(.kind == "Route" and .spec.tls.termination == "edge") | .metadata.name] | join(" ")')" == sbx-api ]] ||
  fail 'want one edge Route (the API)'
pass 'the API Route is edge-terminated, to the control plane'

for r in moca-relay sbx-exec; do
  [[ "$(obj Route "$r" | jq -r .spec.tls.termination)" == passthrough ]] ||
    fail "Route/$r must be passthrough (gRPC must not cross the router TLS termination)"
done
pass 'the attach and exec Routes are passthrough'
