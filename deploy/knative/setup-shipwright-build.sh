#!/usr/bin/env bash
# deploy/knative/setup-shipwright-build.sh
# Builds the moca (and optionally sandbox) image IN-CLUSTER using
# Shipwright, so you don't need a local Docker daemon or a registry reachable from
# your laptop. Prints the resulting image ref(s) to feed into
# setup-k8s.sh --image/--sandbox-image.
#
# This is one option for the "prebuilt images" setup-k8s.sh expects — the sibling of
# building locally with `docker build` (see README-k8s.md). It does NOT replace
# setup-k8s.sh; run this first to produce image refs, then pass them to setup-k8s.sh.
#
# Prerequisites:
#   - kubectl configured to the target cluster (--context or current-context)
#   - Shipwright Build controller already installed on the cluster, with a
#     ClusterBuildStrategy that can push to your registry (e.g. the "buildah" sample
#     strategy for a registry with real TLS/auth, or an insecure-push variant like
#     "buildah-insecure-direct" for a plain-HTTP in-cluster registry — see
#     https://github.com/shipwright-io/build/tree/main/samples/buildstrategy)
#   - A registry the cluster's node runtime can push to AND later pull from (an
#     in-cluster registry works, but if it's plain HTTP it must be configured as an
#     insecure/mirror registry in the node container runtime, e.g. containerd's
#     registry config, or the kubelet won't be able to pull the image back)
#   - A git remote (fork or branch) the cluster can reach over HTTPS containing the
#     Dockerfile you want built — this defaults to the current repo's origin/HEAD
#
# Usage:
#   ./deploy/knative/setup-shipwright-build.sh --image-repo <registry>/moca [OPTIONS]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ----------------------------------------------------------------------------
# Defaults (all overridable via flags)
# ----------------------------------------------------------------------------
DRY_RUN=false
NAMESPACE="default"
GIT_URL=""
GIT_REVISION=""
STRATEGY="buildah"
IMAGE_REPO=""
TAG="dev"
BUILD_NAME=""
BUILD_SANDBOX=false
WAIT_TIMEOUT="20m"
KUBECTL_CONTEXT=""

# ----------------------------------------------------------------------------
# Logging (stderr, so --dry-run stdout stays clean YAML)
# ----------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}→${NC} $1" >&2; }
log_success() { echo -e "${GREEN}✓${NC} $1" >&2; }
log_warn()    { echo -e "${YELLOW}⚠${NC} $1" >&2; }
log_error()   { echo -e "${RED}✗${NC} $1" >&2; }

usage() {
  cat <<EOF
Usage: $0 --image-repo <ref> [OPTIONS]

Build the moca image (and optionally the sandbox image) in-cluster
via Shipwright, then print the resulting image ref(s) for setup-k8s.sh.

Required:
  --image-repo <ref>     Registry + repo to push to, e.g. registry.example.com:5000/moca
                         (the sandbox image is pushed to the same repo with "-sandbox" appended)

Options:
  --namespace <ns>       Namespace to create the Build/BuildRun in (default: ${NAMESPACE})
  --git-url <url>        Git URL Shipwright clones from (default: this repo's origin)
  --git-revision <ref>   Branch/tag/commit to build (default: current checked-out branch)
  --strategy <name>      ClusterBuildStrategy to use (default: ${STRATEGY})
  --tag <tag>            Image tag (default: ${TAG})
  --build-name <name>    Build object name prefix, so this doesn't collide with an existing
                         Build named "moca" in the namespace (default: derived
                         from --tag, e.g. "moca-dev")
  --with-sandbox         Also build the sandbox image (deploy/knative/sandbox.Dockerfile)
  --wait-timeout <dur>   Max time to wait per build (default: ${WAIT_TIMEOUT})
  --context <ctx>        kubectl context to target (default: current-context)
  --dry-run              Print rendered Build manifests without applying/building
  -h, --help             Show this help

Output:
  On success, prints lines you can eval or copy into setup-k8s.sh:
    HARNESS_IMAGE=<image-repo>:<tag>
    SANDBOX_IMAGE=<image-repo>-sandbox:<tag>   (only with --with-sandbox)

Examples:
  $0 --image-repo registry.cr-system.svc.cluster.local:5000/moca \\
     --namespace moca --with-sandbox

  # Then:
  ./deploy/knative/setup-k8s.sh --namespace moca \\
     --image <ref printed above> --sandbox-image <ref printed above>
EOF
}

# ----------------------------------------------------------------------------
# Argument parsing
# ----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image-repo)     IMAGE_REPO="$2"; shift 2 ;;
    --namespace)      NAMESPACE="$2"; shift 2 ;;
    --git-url)        GIT_URL="$2"; shift 2 ;;
    --git-revision)   GIT_REVISION="$2"; shift 2 ;;
    --strategy)       STRATEGY="$2"; shift 2 ;;
    --tag)            TAG="$2"; shift 2 ;;
    --build-name)     BUILD_NAME="$2"; shift 2 ;;
    --with-sandbox)   BUILD_SANDBOX=true; shift ;;
    --wait-timeout)   WAIT_TIMEOUT="$2"; shift 2 ;;
    --context)        KUBECTL_CONTEXT="$2"; shift 2 ;;
    --dry-run)        DRY_RUN=true; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) log_error "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if [[ -z "$IMAGE_REPO" ]]; then
  log_error "--image-repo is required"
  usage
  exit 1
fi

KUBECTL=(kubectl)
[[ -n "$KUBECTL_CONTEXT" ]] && KUBECTL=(kubectl --context "$KUBECTL_CONTEXT")

if [[ -z "$GIT_URL" ]]; then
  GIT_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  if [[ -z "$GIT_URL" ]]; then
    log_error "Could not determine git URL from 'origin' — pass --git-url"
    exit 1
  fi
  # Shipwright clones over plain HTTPS inside the build pod (no SSH agent/keys there),
  # so normalize an SSH-style origin (git@github.com:org/repo.git) to HTTPS.
  if [[ "$GIT_URL" == git@*:* ]]; then
    GIT_URL="$(sed -E 's#^git@([^:]+):#https://\1/#' <<<"$GIT_URL")"
  fi
  GIT_URL="${GIT_URL%.git}"
fi

if [[ -z "$GIT_REVISION" ]]; then
  GIT_REVISION="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -z "$GIT_REVISION" || "$GIT_REVISION" == "HEAD" ]]; then
    log_error "Could not determine current branch — pass --git-revision"
    exit 1
  fi
  log_warn "--git-revision not set, defaulting to current local branch: ${GIT_REVISION}"
  log_warn "Shipwright clones this from ${GIT_URL:-origin} over the network — make sure"
  log_warn "your latest commits are actually pushed there, not just committed locally."
fi

HARNESS_IMAGE="${IMAGE_REPO}:${TAG}"
SANDBOX_IMAGE="${IMAGE_REPO}-sandbox:${TAG}"

# Default Build object names include the tag, so a test/experimental run (different
# --tag) doesn't silently overwrite an existing Build's revision/output — e.g. a real
# "moca" Build already pointed at a stable branch. Pass --build-name to
# reuse/update a specific existing Build on purpose — it's a prefix, so the sandbox
# Build gets "-sandbox" appended rather than colliding with the harness Build's name.
BUILD_NAME_PREFIX="${BUILD_NAME:-moca-${TAG}}"
BUILD_NAME_HARNESS="$BUILD_NAME_PREFIX"
BUILD_NAME_SANDBOX="${BUILD_NAME_PREFIX}-sandbox"

warn_if_build_exists_with_different_spec() {
  local name="$1" revision="$2" image="$3"
  local get_err
  get_err="$(mktemp)"
  local existing_rev existing_image
  if ! existing_rev="$("${KUBECTL[@]}" -n "$NAMESPACE" get build "$name" \
      -o jsonpath='{.spec.source.git.revision}' 2>"$get_err")"; then
    if grep -qi 'NotFound' "$get_err"; then
      rm -f "$get_err"
      return 0
    fi
    log_warn "Could not check for an existing Build/${name} (kubectl error below) — proceeding anyway:"
    cat "$get_err" >&2
    rm -f "$get_err"
    return 0
  fi
  rm -f "$get_err"
  existing_image="$("${KUBECTL[@]}" -n "$NAMESPACE" get build "$name" \
    -o jsonpath='{.spec.output.image}' 2>/dev/null)"
  if [[ "$existing_rev" != "$revision" || "$existing_image" != "$image" ]]; then
    log_warn "Build/${name} already exists with a different revision/output — this run will"
    log_warn "overwrite it. Pass a different --build-name (or --tag) to avoid clobbering it."
  fi
}

# ----------------------------------------------------------------------------
# Render + apply one Build, create a BuildRun, wait for it, return the BuildRun name
# ----------------------------------------------------------------------------
render_build() {
  local template="$1" name="$2" image="$3"
  # Substitute placeholders with bash literal string replacement rather than sed, so a value
  # containing sed-significant characters (a '#' in a git URL/image ref that would break the
  # 's#...#...#' delimiter, or '&'/'\' in the replacement) can't corrupt the output.
  local content
  content="$(cat "$template")"
  content="${content//__NAME__/$name}"
  content="${content//__NAMESPACE__/$NAMESPACE}"
  content="${content//__GIT_URL__/$GIT_URL}"
  content="${content//__GIT_REVISION__/$GIT_REVISION}"
  content="${content//__STRATEGY__/$STRATEGY}"
  content="${content//__IMAGE__/$image}"
  printf '%s\n' "$content"
}

run_build() {
  local name="$1" template="$2" image="$3"

  if $DRY_RUN; then
    render_build "$template" "$name" "$image"
    echo "---"
    return 0
  fi

  warn_if_build_exists_with_different_spec "$name" "$GIT_REVISION" "$image"

  log_info "Applying Build/${name} (revision: ${GIT_REVISION}, output: ${image})"
  render_build "$template" "$name" "$image" | "${KUBECTL[@]}" apply -f -

  log_info "Starting BuildRun for ${name}"
  local buildrun
  buildrun="$("${KUBECTL[@]}" create -n "$NAMESPACE" -f - <<EOF | awk '{print $1}' | sed 's#^buildrun.shipwright.io/##; s#^buildrun/##'
apiVersion: shipwright.io/v1beta1
kind: BuildRun
metadata:
  generateName: ${name}-
spec:
  build:
    name: ${name}
EOF
)"
  log_info "Waiting for BuildRun/${buildrun} (timeout: ${WAIT_TIMEOUT})"
  if ! "${KUBECTL[@]}" -n "$NAMESPACE" wait "buildrun/${buildrun}" \
      --for=condition=Succeeded --timeout="$WAIT_TIMEOUT"; then
    log_error "Build failed — logs:"
    "${KUBECTL[@]}" -n "$NAMESPACE" logs "buildrun.shipwright.io/${buildrun}" --all-containers >&2 || true
    exit 1
  fi
  log_success "Build/${name} succeeded -> ${image}"
}

run_build "$BUILD_NAME_HARNESS" "$SCRIPT_DIR/shipwright/build-harness.yaml" "$HARNESS_IMAGE"

if $BUILD_SANDBOX; then
  run_build "$BUILD_NAME_SANDBOX" "$SCRIPT_DIR/shipwright/build-sandbox.yaml" "$SANDBOX_IMAGE"
fi

if ! $DRY_RUN; then
  echo "HARNESS_IMAGE=${HARNESS_IMAGE}"
  # Use an if, not `$BUILD_SANDBOX && echo ...`: as the script's last statement under `set -e`,
  # that && short-circuits to a non-zero exit when BUILD_SANDBOX is false — making a successful
  # harness-only build wrongly report failure (exit 1).
  if $BUILD_SANDBOX; then
    echo "SANDBOX_IMAGE=${SANDBOX_IMAGE}"
  fi
fi
