#!/usr/bin/env bash
# deploy/knative/setup-kind.sh
# One-shot setup: installs Knative Serving on Kind, deploys Redis + sandbox + harness.
#
# Prerequisites:
#   - kind cluster running (e.g., `kind create cluster --name sh-knative`)
#   - kubectl configured to the kind cluster
#   - docker available (for image build + kind load)
#   - ANTHROPIC_API_KEY env var set
#
# Usage:
#   ./deploy/knative/setup-kind.sh [--skip-build] [--build] [--image <ref>] [--sandbox-image <ref>] [--cluster-name <name>]
#
# Harness image (dev.local/moca:local, referenced by service.yaml):
#   default      Pull the published image ($SH_IMAGE) and load it into kind; if the pull is
#                unavailable (offline / image missing), transparently fall back to a local build.
#                A first-time quickstart therefore needs no local Docker build.
#   --build      Force a local build from this checkout (use when testing local source changes).
#   --skip-build Do neither; assume dev.local/moca:local is already loaded.
#   --image <ref> / SH_IMAGE=<ref>  Override the published image to pull.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-sh-knative}"
SKIP_BUILD="${SKIP_BUILD:-false}"
FORCE_BUILD="${FORCE_BUILD:-false}"
KNATIVE_VERSION="${KNATIVE_VERSION:-v1.14.0}"
# Published harness image pulled by default (public GHCR package under the rossoctl org).
SH_IMAGE="${SH_IMAGE:-ghcr.io/rossoctl/moca:latest}"
# Local tag the Knative manifests reference; the pulled/built image is (re)tagged to this.
LOCAL_IMAGE="${LOCAL_IMAGE:-dev.local/moca:local}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-ghcr.io/rossoctl/moca-sandbox:latest}"
LOCAL_SANDBOX_IMAGE="${LOCAL_SANDBOX_IMAGE:-dev.local/moca-sandbox:local}"

# Parse args
for arg in "$@"; do
  case $arg in
    --skip-build) SKIP_BUILD=true ;;
    --build) FORCE_BUILD=true ;;
    --cluster-name) shift; CLUSTER_NAME="$1" ;;
    --cluster-name=*) CLUSTER_NAME="${arg#*=}" ;;
    --image) shift; SH_IMAGE="$1" ;;
    --image=*) SH_IMAGE="${arg#*=}" ;;
    --sandbox-image) shift; SANDBOX_IMAGE="$1" ;;
    --sandbox-image=*) SANDBOX_IMAGE="${arg#*=}" ;;
  esac
  shift 2>/dev/null || true
done

# Provide the harness image referenced by service.yaml ($LOCAL_IMAGE). By default we pull the
# published image (fast path — no local build needed for a first-time quickstart) and fall back
# to a local build only if the pull is unavailable. --build forces a local build; --skip-build
# assumes the image is already loaded. Sets HARNESS_IMAGE_LOADED when it (re)loads an image.
ensure_harness_image() {
  HARNESS_IMAGE_LOADED=false
  if [ "$SKIP_BUILD" = "true" ]; then
    echo "--- Skipping harness image build/pull (--skip-build): expecting $LOCAL_IMAGE preloaded ---"
    return 0
  fi
  if [ "$FORCE_BUILD" != "true" ]; then
    echo "--- Pulling published harness image: $SH_IMAGE ---"
    if docker pull "$SH_IMAGE"; then
      docker tag "$SH_IMAGE" "$LOCAL_IMAGE"
      echo "--- Loading pulled image into kind ---"
      kind load docker-image "$LOCAL_IMAGE" --name "$CLUSTER_NAME"
      HARNESS_IMAGE_LOADED=true
      return 0
    fi
    echo "--- Pull unavailable ($SH_IMAGE); falling back to a local build ---"
  else
    echo "--- Building moca image locally (--build) ---"
  fi
  docker build --load -t "$LOCAL_IMAGE" "$REPO_ROOT"
  echo "--- Loading built image into kind ---"
  kind load docker-image "$LOCAL_IMAGE" --name "$CLUSTER_NAME"
  HARNESS_IMAGE_LOADED=true
}

ensure_sandbox_image() {
  if [ "$SKIP_BUILD" = "true" ]; then
    echo "--- Skipping sandbox image build/pull (--skip-build): expecting $LOCAL_SANDBOX_IMAGE preloaded ---"
    return 0
  fi
  if [ "$FORCE_BUILD" != "true" ]; then
    echo "--- Pulling published sandbox image: $SANDBOX_IMAGE ---"
    if docker pull "$SANDBOX_IMAGE"; then
      docker tag "$SANDBOX_IMAGE" "$LOCAL_SANDBOX_IMAGE"
      kind load docker-image "$LOCAL_SANDBOX_IMAGE" --name "$CLUSTER_NAME"
      return 0
    fi
    echo "--- Pull unavailable ($SANDBOX_IMAGE); falling back to a local build ---"
  else
    echo "--- Building sandbox image locally (--build) ---"
  fi
  docker build --load -f "$SCRIPT_DIR/sandbox.Dockerfile" -t "$LOCAL_SANDBOX_IMAGE" "$SCRIPT_DIR"
  kind load docker-image "$LOCAL_SANDBOX_IMAGE" --name "$CLUSTER_NAME"
}

# When sourced by tests (SH_SOURCE_ONLY=1), stop here so only the functions above are exposed.
if [ "${SH_SOURCE_ONLY:-0}" = "1" ]; then
  return 0
fi

echo "=== M4 Knative Setup (cluster: $CLUSTER_NAME) ==="

# 1. Create kind cluster if it doesn't exist
if ! kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "--- Creating kind cluster: $CLUSTER_NAME ---"
  kind create cluster --name "$CLUSTER_NAME"
fi
kubectl config use-context "kind-${CLUSTER_NAME}"

# 2. Install Knative Serving
echo "--- Installing Knative Serving $KNATIVE_VERSION ---"
kubectl apply -f "https://github.com/knative/serving/releases/download/knative-${KNATIVE_VERSION}/serving-crds.yaml"
kubectl apply -f "https://github.com/knative/serving/releases/download/knative-${KNATIVE_VERSION}/serving-core.yaml"

# 3. Install Kourier (networking layer)
echo "--- Installing Kourier ---"
kubectl apply -f "https://github.com/knative-extensions/net-kourier/releases/download/knative-${KNATIVE_VERSION}/kourier.yaml"

# Configure Knative to use Kourier
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'

# Configure external domain
kubectl patch configmap/config-domain \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"example.com":""}}'

# Tune autoscaler for faster scale-to-zero and single-pod-per-request (dev/testing)
kubectl patch configmap/config-autoscaler \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"stable-window":"20s","scale-to-zero-grace-period":"10s","container-concurrency-target-percentage":"100"}}'

# Skip tag resolution for local images
kubectl patch configmap/config-deployment \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"registries-skipping-tag-resolving":"kind.local,ko.local,dev.local"}}'

# Enable persistent-volume-claim support (read + write) so the leaf-session contract can
# mount the shared leaf-work PVC into the harness service (deploy/knative/leaf-pvc.yaml).
# The validating webhook rejects a writable PVC mount unless both flags are enabled.
# Also enable fieldRef and securityContext support used by the harness pod template.
kubectl patch configmap/config-features \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"kubernetes.podspec-persistent-volume-claim":"enabled","kubernetes.podspec-persistent-volume-write":"enabled","kubernetes.podspec-fieldref":"enabled","kubernetes.podspec-securitycontext":"enabled"}}'

# Install KEDA (event-driven autoscaling) — async leaf completion uses a KEDA ScaledJob.
KEDA_VERSION="${KEDA_VERSION:-v2.14.0}"
if ! kubectl get crd scaledjobs.keda.sh >/dev/null 2>&1; then
  echo "--- Installing KEDA $KEDA_VERSION ---"
  # The release asset filename drops the leading "v" (tag v2.14.0 → asset keda-2.14.0.yaml).
  kubectl apply --server-side -f "https://github.com/kedacore/keda/releases/download/${KEDA_VERSION}/keda-${KEDA_VERSION#v}.yaml"
fi
kubectl wait --for=condition=Available deployment --all -n keda --timeout=180s || true

# Wait for Knative components
echo "--- Waiting for Knative Serving to be ready ---"
kubectl wait --for=condition=Available deployment --all -n knative-serving --timeout=120s

# 4. Deploy Redis
echo "--- Deploying Redis ---"
kubectl apply -f "$SCRIPT_DIR/redis.yaml"
kubectl wait --for=condition=Available deployment/redis -n default --timeout=60s

# 5. Install agent-sandbox controller + CRDs (kubernetes-sigs/agent-sandbox v0.5.0)
echo "--- Installing agent-sandbox controller ---"
kubectl apply --server-side -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.0/manifest.yaml"
kubectl -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=180s
kubectl wait --for=condition=Established crd/sandboxes.agents.x-k8s.io --timeout=120s

# 6. Deploy the durable Sandbox POOL (issue #54: pool, not a single sandbox — the harness
#    resolves KAGENTI_SANDBOX_POOL_SELECTOR against all pool pods).
echo "--- Deploying Sandbox pool ---"
kubectl apply -f "$SCRIPT_DIR/sandbox-pool.yaml"
# Wait for every pool pod (sandbox-0..N-1) to go Ready via the common pool label.
POOL_SELECTOR="sh.kagenti.io/sandbox-pool=default"
for _ in $(seq 1 90); do
  ready=$(kubectl -n default get pods -l "$POOL_SELECTOR" \
    --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
  want=$(grep -c '^kind: Sandbox' "$SCRIPT_DIR/sandbox-pool.yaml")
  [ "$ready" -ge "$want" ] && break
  sleep 2
done
kubectl -n default wait --for=condition=Ready pod -l "$POOL_SELECTOR" --timeout=180s || {
  echo "sandbox pool not all Ready (label='$POOL_SELECTOR')"
  kubectl -n default get pods -l "$POOL_SELECTOR" -o wide | head -40
  exit 1
}

# 7. Provide the harness image ($LOCAL_IMAGE) referenced by service.yaml (pull by default,
#    local build with --build, or reuse a preloaded image with --skip-build).
ensure_harness_image
ensure_sandbox_image

# 7b. Deploy the harness's default-deny egress NetworkPolicy (DNS, Redis, relay, HTTPS —
# see harness-egress-policy.yaml). Unconditional and BEFORE service.yaml: modern kindnet
# enforces egress, so a harness pod scheduled before this exists would have unrestricted
# egress for a window, and a pod scheduled after some OTHER egress policy (e.g.
# control-plane.yaml's additive one) but before this one would have DNS silently broken
# (issue: every /turn credential exchange fails with "the harness is unavailable" because
# SH_CONTROL_PLANE_URL's hostname can't resolve). Step 8b below (SH_AUTHBRIDGE=1) applies
# harness-egress-ab1.yaml on top, which shares this policy's name and REPLACES it rather
# than stacking with it -- that swap only does the intended thing if this apply ran first.
echo "--- Deploying harness egress NetworkPolicy ---"
kubectl apply -f "$SCRIPT_DIR/harness-egress-policy.yaml"
kubectl apply -f "$SCRIPT_DIR/context-service-egress.yaml"

# 8. Create LLM credentials secret (supports direct API key or gateway bridge)
if [ "${SH_AUTHBRIDGE:-0}" = "1" ]; then
  # RC1-1 Hop 1: the harness never holds the real key. AB1 (the reverse-proxy gateway,
  # see deploy/knative/authbridge/ab1-deployment.yaml) holds it and injects it
  # per-request; the harness gets only the placeholder + AB1's base URL.
  REAL_KEY="${ANTHROPIC_API_KEY:?SH_AUTHBRIDGE=1 requires ANTHROPIC_API_KEY (the real key AB1 injects)}"
  kubectl create secret generic ab1-llm-cred --from-literal=api.anthropic.com="$REAL_KEY" \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl create secret generic llm-credentials \
    --from-literal=api-key=AB1-PLACEHOLDER \
    --from-literal=auth-token=AB1-PLACEHOLDER \
    --from-literal=base-url=http://authbridge-ab1:8080 \
    --dry-run=client -o yaml | kubectl apply -f -
else
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
    echo "ERROR: Set ANTHROPIC_API_KEY (direct) or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (gateway)"
    exit 1
  fi
  SECRET_ARGS=(--from-literal=api-key="${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN}}")
  [ -n "${ANTHROPIC_BASE_URL:-}" ] && SECRET_ARGS+=(--from-literal=base-url="$ANTHROPIC_BASE_URL")
  [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] && SECRET_ARGS+=(--from-literal=auth-token="$ANTHROPIC_AUTH_TOKEN")
  kubectl create secret generic llm-credentials "${SECRET_ARGS[@]}" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

# 8b. SH_AUTHBRIDGE=1: deploy the AB1 gateway stack (after the secrets, near where
# service.yaml is applied below) so the harness's egress is already scoped to AB1 before
# the Knative Service starts routing traffic.
if [ "${SH_AUTHBRIDGE:-0}" = "1" ]; then
  echo "--- Deploying AB1 gateway (ibac-stub + authbridge-ab1) ---"

  if [ "$SKIP_BUILD" != "true" ]; then
    # Official kext image (main #655 static-inject + #657 reverse-proxy fidelity fixes) —
    # multi-arch (linux/amd64 + linux/arm64), so it runs natively on any kind node. Pinned to
    # the kext main sha; one pull+load here covers both AB1 (below) and the 3 AB2 sidecars
    # applied later in this script, since AB1 runs first.
    echo "--- Pulling + loading AuthBridge proxy image (official kext image, #655/#657 on main) ---"
    docker pull ghcr.io/rossoctl/kagenti-extensions/authbridge:main-9c131ee
    kind load docker-image ghcr.io/rossoctl/kagenti-extensions/authbridge:main-9c131ee --name "$CLUSTER_NAME"
  fi

  kubectl apply -f "$SCRIPT_DIR/ibac-stub.yaml" -f "$SCRIPT_DIR/authbridge/ab1-deployment.yaml"
  # Applied AFTER any base egress policy so it overwrites the same NetworkPolicy name
  # (serverless-harness-egress) rather than stacking with it.
  kubectl apply -f "$SCRIPT_DIR/authbridge/harness-egress-ab1.yaml"
  kubectl -n default rollout status deploy/authbridge-ab1 --timeout=120s
  kubectl -n default rollout status deploy/ibac-stub --timeout=120s
fi

# 8c. SH_AUTHBRIDGE=1: deploy the AB2 egress forward-proxy stack (Hop 2) — see
# docs/plans/2026-07-10-rc1-authbridge/rc1-2-hop2-sandbox-egress.md. Builds/loads the
# echo-target image, seeds the REAL egress credential into a Secret the sandbox never reads
# directly, and applies the AB2-sidecar variant of the sandbox pool (OVERWRITES the base
# sandbox-0/1/2 CRs applied at step 6) so every pool pod picks up the authbridge-ab2 sidecar.
# Off ⇒ none of this runs; the base pool from step 6 is left as-is.
if [ "${SH_AUTHBRIDGE:-0}" = "1" ]; then
  echo "--- Deploying AB2 egress forward-proxy (Hop 2: echo-target + AB2 sidecar pool) ---"

  if [ "$SKIP_BUILD" != "true" ]; then
    echo "--- Building echo-target image ---"
    docker build --load -t dev.local/echo-target:rc1 "$SCRIPT_DIR/echo-target"
    echo "--- Loading echo-target image into kind ---"
    kind load docker-image dev.local/echo-target:rc1 --name "$CLUSTER_NAME"

    # Pre-baked sandbox image (tools baked in, no apk-at-startup) for the AB2 pool below —
    # same Dockerfile the OCP path uses (deploy/knative/sandbox.Dockerfile), built locally
    # here instead of in-cluster. Scoped context matches .github/workflows/build.yaml
    # (sandbox.Dockerfile has no COPY, so the build context is just deploy/knative).
    echo "--- Building sandbox image ---"
    docker build --load -f "$SCRIPT_DIR/sandbox.Dockerfile" -t dev.local/sandbox-rc1:rc1 "$SCRIPT_DIR"
    echo "--- Loading sandbox image into kind ---"
    kind load docker-image dev.local/sandbox-rc1:rc1 --name "$CLUSTER_NAME"
  fi

  # Real egress credential: seeded ONLY into this Secret; the sandbox container only ever
  # holds the placeholder (ECHO_CRED=PLACEHOLDER-TOKEN in sandbox-pool-ab2.yaml). AB2's
  # static-inject plugin resolves the real value by destination host (key_by: host -> a
  # secret file/key named "echo-target"). Synthetic demo value — echo doesn't authenticate.
  RC1_ECHO_REAL_CRED="${RC1_ECHO_REAL_CRED:-REAL-ECHO-EGRESS-CRED-rc1demo}"
  kubectl create secret generic ab2-egress-cred \
    --from-literal=echo-target="$RC1_ECHO_REAL_CRED" \
    --dry-run=client -o yaml | kubectl apply -f -

  kubectl apply -f "$SCRIPT_DIR/echo-target.yaml"
  kubectl apply -f "$SCRIPT_DIR/authbridge/ab2-config.yaml"
  kubectl -n default rollout status deploy/echo-target --timeout=120s

  # Overwrites the base sandbox-0/1/2 CRs (same names/namespace) with the AB2-sidecar
  # variant.
  kubectl apply -f "$SCRIPT_DIR/sandbox-pool-ab2.yaml"

  # The agent-sandbox controller does NOT roll existing pods when a Sandbox CR's spec
  # changes (no restart/rollout of the underlying pod on update) — a pre-existing pod
  # (e.g. sandbox-0 created by the base pool apply at step 6, or one already running from
  # a prior setup-kind.sh invocation on this cluster) would otherwise keep its OLD
  # 1-container spec (no authbridge-ab2 sidecar) forever. Force-delete the pool pods so the
  # controller recreates them from the just-applied AB2 spec.
  kubectl -n default delete pod -l "$POOL_SELECTOR" --ignore-not-found
  # Wait for the OLD pods to be fully gone before readiness-checking the new ones. Otherwise a
  # readiness probe (here or in leaf-smoke) can pass against a still-terminating old pod that
  # happens to have the tools, and the new pod isn't actually ready yet.
  kubectl -n default wait --for=delete pod -l "$POOL_SELECTOR" --timeout=180s || true

  # Re-wait for the pool to converge on the AB2 variant: each pod is recreated with 2
  # containers (sandbox + authbridge-ab2). Poll on per-container readiness (not just pod
  # phase) before the authoritative wait, since the old 1-container pods must terminate and
  # the new pods' sandbox container has to pull the (kind-loaded) baked image and start.
  # Generous timeout for the same reason.
  for _ in $(seq 1 150); do
    # `|| true`: under `set -euo pipefail`, `grep -c` exits 1 when the count is 0, and there IS
    # a guaranteed zero-ready window during the rollover (old 1-container pods terminating while
    # the new sandbox containers start up). Without the guard the assignment aborts the whole
    # script mid-poll. (The base poll at L115 needs no guard: it pipes kubectl, not a filtering
    # grep, into wc — so no stage exits non-zero. Mirroring that shape here would NOT help, since
    # grep-as-filter still exits 1 under pipefail; the `|| true` is the actual fix.)
    ready2=$(kubectl -n default get pods -l "$POOL_SELECTOR" \
      -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.ready}{"\n"}{end}{end}' \
      2>/dev/null | grep -c '^true$' || true)
    want2=$(( $(grep -c '^kind: Sandbox' "$SCRIPT_DIR/sandbox-pool-ab2.yaml") * 2 ))
    [ "$ready2" -ge "$want2" ] && break
    sleep 2
  done
  kubectl -n default wait --for=condition=Ready pod -l "$POOL_SELECTOR" --timeout=300s || {
    echo "AB2 sandbox pool not all Ready (label='$POOL_SELECTOR')"
    kubectl -n default get pods -l "$POOL_SELECTOR" -o wide | head -40
    exit 1
  }
fi

# 9. Deploy Knative Service
echo "--- Deploying serverless-harness Knative Service ---"
kubectl apply -f "$SCRIPT_DIR/service.yaml"

# The image tag (dev.local/moca:local) is mutable, so re-applying an unchanged
# service spec does NOT roll a new Revision — Knative would keep serving the previous Revision
# (pinned to the OLD image digest) and a freshly built image would never be deployed. Force a new
# Revision by stamping a build marker into the template so the (re)loaded image is always picked up.
# Stamp whenever we loaded an image this run (pull or build); skip when --skip-build reused one.
if [ "${HARNESS_IMAGE_LOADED:-false}" = "true" ]; then
  kubectl -n default patch ksvc serverless-harness --type merge \
    -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"deploy.sh/build-ts\":\"$(date +%s)\"}}}}}"
fi

# 10. Wait for service to become ready
echo "--- Waiting for Knative Service to be ready ---"
kubectl wait ksvc/serverless-harness --for=condition=Ready --timeout=120s

# 11. Print access info
KOURIER_IP=$(kubectl get svc kourier -n kourier-system -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "pending")
echo ""
echo "=== Setup complete ==="
echo ""
echo "Knative Service URL (in-cluster):"
echo "  http://serverless-harness.default.svc.cluster.local"
echo ""
echo "Kourier ClusterIP: $KOURIER_IP"
echo ""
echo "To access from host, run in a separate terminal:"
echo "  kubectl port-forward -n kourier-system svc/kourier 8080:80"
echo ""
echo "Then send requests with the Host header:"
echo "  curl -H 'Host: serverless-harness.default.example.com' \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"prompt\": \"Hello\"}' \\"
echo "       http://localhost:8080/turn"
echo ""
