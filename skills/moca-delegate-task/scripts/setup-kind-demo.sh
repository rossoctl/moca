#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-moca-delegate-demo}"
KUBE_CONTEXT="kind-$CLUSTER_NAME"
STATE_CONFIG_MAP="moca-delegate-demo-state"
CONTEXT_SERVICE_REF="${CONTEXT_SERVICE_REF:-main}"
BUILD_LOCAL=false

for argument in "$@"; do
  if [ "$argument" = "--build" ]; then
    BUILD_LOCAL=true
  fi
done

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

load_anthropic_credential() {
  if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
    return
  fi
  if [ -z "${MOCA_ANTHROPIC_OP_REF:-}" ]; then
    die "set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or MOCA_ANTHROPIC_OP_REF"
  fi
  require_command op
  local account_args=()
  if [ -n "${MOCA_OP_ACCOUNT:-}" ]; then
    account_args=(--account "$MOCA_OP_ACCOUNT")
  fi
  local credential
  credential="$(op read "${account_args[@]}" "$MOCA_ANTHROPIC_OP_REF")" || die "could not read the Anthropic credential from 1Password"
  if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
    export ANTHROPIC_AUTH_TOKEN="$credential"
  else
    export ANTHROPIC_API_KEY="$credential"
  fi
}

if [ "${1:-}" = "--delete" ]; then
  require_command kind
  require_command kubectl
  active_context="$(kubectl config current-context 2>/dev/null || true)"
  previous_context="$(kubectl --context "$KUBE_CONTEXT" -n kube-public get configmap "$STATE_CONFIG_MAP" \
    -o jsonpath='{.data.previous-context}' 2>/dev/null || true)"
  kind delete cluster --name "$CLUSTER_NAME"
  if [ "$active_context" = "$KUBE_CONTEXT" ] && [ -n "$previous_context" ] && \
      kubectl config get-contexts "$previous_context" -o name >/dev/null 2>&1; then
    kubectl config use-context "$previous_context" >/dev/null
    echo "Restored Kubernetes context: $previous_context"
  fi
  exit 0
fi

for command_name in base64 curl docker kind kubectl openssl sed; do
  require_command "$command_name"
done
load_anthropic_credential

previous_context="$(kubectl config current-context 2>/dev/null || true)"
restore_context_on_error() {
  status=$?
  if [ "$status" -ne 0 ] && [ -n "$previous_context" ] && [ "$previous_context" != "$KUBE_CONTEXT" ]; then
    kubectl config use-context "$previous_context" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap restore_context_on_error ERR

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  proxy_url="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}"
  if [[ "$proxy_url" =~ ^https?://(127\.0\.0\.1|localhost)(:|/) ]]; then
    env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
      kind create cluster --name "$CLUSTER_NAME" --config "$SKILL_DIR/deploy/kind.yaml"
  else
    kind create cluster --name "$CLUSTER_NAME" --config "$SKILL_DIR/deploy/kind.yaml"
  fi
fi
kubectl config use-context "$KUBE_CONTEXT" >/dev/null
[ "$(kubectl config current-context)" = "$KUBE_CONTEXT" ] || die "could not select $KUBE_CONTEXT"

if [ -n "$previous_context" ] && [ "$previous_context" != "$KUBE_CONTEXT" ]; then
  kubectl --context "$KUBE_CONTEXT" -n kube-public create configmap "$STATE_CONFIG_MAP" \
    --from-literal=previous-context="$previous_context" \
    --dry-run=client -o yaml | kubectl --context "$KUBE_CONTEXT" apply -f - >/dev/null
fi

existing_token_data="$(kubectl --context "$KUBE_CONTEXT" -n default get secret \
  context-service-control-plane -o jsonpath='{.data.token}' 2>/dev/null || true)"
existing_token=""
if [ -n "$existing_token_data" ]; then
  existing_token="$(printf '%s' "$existing_token_data" | base64 --decode)"
fi
if [ -n "${CONTEXT_SERVICE_TOKEN:-}" ] && [ -n "$existing_token" ] && \
    [ "$CONTEXT_SERVICE_TOKEN" != "$existing_token" ]; then
  die "CONTEXT_SERVICE_TOKEN differs from the existing demo token; delete the demo cluster before rotating it"
fi
export CONTEXT_SERVICE_TOKEN="${CONTEXT_SERVICE_TOKEN:-${existing_token:-$(openssl rand -hex 32)}}"
kubectl --context "$KUBE_CONTEXT" -n default create secret generic context-service-control-plane \
  --from-literal=token="$CONTEXT_SERVICE_TOKEN" \
  --dry-run=client -o yaml | kubectl --context "$KUBE_CONTEXT" apply -f -
kubectl --context "$KUBE_CONTEXT" -n default create secret generic context-service-client \
  --from-literal=url=http://context-service.default.svc.cluster.local:8080 \
  --from-literal=public-url=http://127.0.0.1:8081 \
  --from-literal=token="$CONTEXT_SERVICE_TOKEN" \
  --from-literal=shared-access-mode=ReadWriteOnce \
  --dry-run=client -o yaml | kubectl --context "$KUBE_CONTEXT" apply -f -

export CLUSTER_NAME
"$REPO_ROOT/deploy/knative/setup-kind.sh" "$@"
[ "$(kubectl config current-context)" = "$KUBE_CONTEXT" ] || die "setup changed the Kubernetes context"

# Batch delegation queues its runs; these KEDA-scaled workers consume that queue.
kubectl --context "$KUBE_CONTEXT" apply -f "$REPO_ROOT/deploy/knative/leaf-scaledjob.yaml"

if [ "$BUILD_LOCAL" = "true" ]; then
  context_service_repo="${CONTEXT_SERVICE_REPO:-$REPO_ROOT/../../rossoctl/context-service}"
  [ -f "$context_service_repo/deploy/context-service.yaml" ] ||
    die "set CONTEXT_SERVICE_REPO to a Context Service checkout when using --build"
  docker build --load -t dev.local/context-service:demo "$context_service_repo"
  kind load docker-image dev.local/context-service:demo --name "$CLUSTER_NAME"
  sed \
    -e 's/namespace: serverless-harness/namespace: default/g' \
    -e 's#ghcr.io/rossoctl/context-service:latest#dev.local/context-service:demo#' \
    -e 's#ghcr.io/rossoctl/serverless-harness-sandbox:latest#ghcr.io/rossoctl/moca-sandbox:latest#' \
    "$context_service_repo/deploy/context-service.yaml" |
    kubectl --context "$KUBE_CONTEXT" apply -f -
  kubectl --context "$KUBE_CONTEXT" rollout restart deployment/context-service -n default
else
  curl -fsSL "https://raw.githubusercontent.com/rossoctl/context-service/${CONTEXT_SERVICE_REF}/deploy/context-service.yaml" |
    sed \
      -e 's/namespace: serverless-harness/namespace: default/g' \
      -e 's#ghcr.io/rossoctl/serverless-harness-sandbox:latest#ghcr.io/rossoctl/moca-sandbox:latest#' |
    kubectl --context "$KUBE_CONTEXT" apply -f -
fi

kubectl --context "$KUBE_CONTEXT" patch service kourier -n kourier-system --type merge \
  -p '{"spec":{"type":"NodePort","ports":[{"name":"http2","port":80,"targetPort":8080,"nodePort":30080}]}}'
kubectl --context "$KUBE_CONTEXT" patch service context-service -n default --type merge \
  -p '{"spec":{"type":"NodePort","ports":[{"name":"http","port":8080,"targetPort":"http","nodePort":30081}]}}'
kubectl --context "$KUBE_CONTEXT" rollout status deployment/context-service -n default --timeout=2m

curl --retry 20 --retry-connrefused --retry-delay 2 -fsS http://127.0.0.1:8081/healthz >/dev/null
curl --retry 20 --retry-connrefused --retry-delay 2 -fsS \
  -H 'Host: serverless-harness.default.example.com' http://127.0.0.1:8080/health >/dev/null

trap - ERR

echo
echo "MOCA and Context Service are ready."
echo "Kubernetes context: $KUBE_CONTEXT"
echo "export SH_URL=http://127.0.0.1:8080"
echo "export SH_HOST=serverless-harness.default.example.com"
echo "Next: skills/moca-delegate-task/references/demo.md"
