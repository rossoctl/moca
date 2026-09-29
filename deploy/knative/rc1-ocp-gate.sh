#!/usr/bin/env bash
# deploy/knative/rc1-ocp-gate.sh
# RC1-4 (OCP) targeted live-gate wrapper.
#
# This is NOT setup-ocp.sh. It does not stand up a cluster or the base
# moca stack — it assumes an EXISTING, already-deployed
# moca stack in namespace `default` (ksvc + redis + sandbox pool +
# operators already up) and layers the RC1 AuthBridge two-hop egress-control path
# (deploy/knative/overlays/ocp-authbridge) onto it, runs the live leaf-smoke against
# the OpenShift Route, and then RESTORES the namespace to its pre-gate state
# (direct-Anthropic llm-credentials, base sandbox pool, base egress policy — via
# deploy/knative/overlays/ocp) — whether the smoke passed or failed.
#
# Modes:
#   up       - save pre-gate state, then apply the AuthBridge gate
#   smoke    - run leaf-smoke.sh against the Route (no state change)
#   restore  - return `default` to its pre-gate state (idempotent, safe anytime)
#   gate     - up -> smoke -> restore-always (default mode; this is what the
#              controller runs for the live gate)
#
# Usage: ./deploy/knative/rc1-ocp-gate.sh [up|smoke|restore|gate] [-h|--help]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NS="${NS:-default}"
KSVC=moca
LOG_DIR="${LOG_DIR:-/tmp/kagenti/rc1/ocp}"
OVERLAY="$SCRIPT_DIR/overlays/ocp-authbridge"
BASE_OVERLAY="$SCRIPT_DIR/overlays/ocp"
POOL_SELECTOR="sh.kagenti.io/sandbox-pool=default"
STATE_DIR="$LOG_DIR/restore"
RC1_ECHO_REAL_CRED="${RC1_ECHO_REAL_CRED:-REAL-ECHO-EGRESS-CRED-rc1demo}"
RC1_GATE_KEEP="${RC1_GATE_KEEP:-0}"

mkdir -p "$LOG_DIR" "$STATE_DIR"

# ----------------------------------------------------------------------------
# Logging helpers
# ----------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}->${NC} $1"; }
log_success() { echo -e "${GREEN}OK${NC} $1"; }
log_warn()    { echo -e "${YELLOW}!!${NC} $1"; }
log_error()   { echo -e "${RED}XX${NC} $1"; }

usage() {
  cat <<EOF
Usage: $0 [MODE] [-h|--help]

RC1-4 OCP targeted live-gate wrapper. Runs the RC1 AuthBridge gate against an
ALREADY-DEPLOYED moca stack in namespace "default" (does not stand
up the cluster or base stack — see setup-ocp.sh for that). Applies the
AuthBridge overlay, runs leaf-smoke.sh against the Route, then restores the
namespace to its pre-gate state.

Modes (default: gate):
  up       Save pre-gate state, then apply the AuthBridge gate (secrets +
           overlays/ocp-authbridge + roll workloads/pool/ksvc).
  smoke    Resolve the Route and run leaf-smoke.sh with the AuthBridge env
           contract. Does not change cluster state.
  restore  Return "default" to its pre-gate state: direct-mode llm-credentials,
           base sandbox pool, base egress policy, AB resources removed. Safe to
           run anytime; idempotent.
  gate     up -> smoke -> restore (always, unless RC1_GATE_KEEP=1). Prints
           "SMOKE_EXIT:<n>" and exits with the smoke exit code. This is the mode
           the controller drives for the live gate.

Environment:
  NS                   Target namespace (default: default)
  LOG_DIR              Where apply/kustomize logs + saved restore state go
                        (default: /tmp/kagenti/rc1/ocp)
  SH_MODEL             Model id passed to leaf-smoke.sh (default: claude-haiku-4-5)
  RC1_ECHO_REAL_CRED   Value seeded into the ab2-egress-cred secret's
                        echo-target key (default: REAL-ECHO-EGRESS-CRED-rc1demo)
  RC1_GATE_KEEP         1 to skip the automatic restore in "gate" mode, leaving
                        the AuthBridge gate applied for debugging (default: 0)

Examples:
  $0                 # gate: up, smoke, restore-always
  $0 up              # apply the gate only
  $0 smoke           # run the smoke only (gate must already be up)
  $0 restore         # restore pre-gate state
  RC1_GATE_KEEP=1 $0 gate   # gate but leave it up on exit
EOF
}

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------
preflight() {
  command -v kubectl &>/dev/null || { log_error "kubectl not found in PATH"; return 1; }
  kubectl cluster-info &>/dev/null || { log_error "Cannot reach a cluster (check KUBECONFIG / kubectl context)"; return 1; }
  kubectl -n "$NS" get ksvc "$KSVC" &>/dev/null || {
    log_error "ksvc/$KSVC not found in namespace $NS — this wrapper targets an ALREADY-DEPLOYED stack (run setup-ocp.sh first)"
    return 1
  }
  kubectl -n "$NS" get deploy redis &>/dev/null || {
    log_error "deploy/redis not found in namespace $NS — base stack does not look deployed (run setup-ocp.sh first)"
    return 1
  }
  log_success "Preflight: cluster reachable, ksvc/$KSVC and deploy/redis present in $NS"
}

# ----------------------------------------------------------------------------
# mode: up
# ----------------------------------------------------------------------------
mode_up() {
  preflight || return 1

  log_info "Reading current llm-credentials api-key in $NS"
  local real_key
  real_key="$(kubectl -n "$NS" get secret llm-credentials -o jsonpath='{.data.api-key}' 2>/dev/null | base64 -d || true)"

  if [ -z "$real_key" ] || [ "$real_key" = "AB1-PLACEHOLDER" ]; then
    log_error "llm-credentials api-key is empty or already AB1-PLACEHOLDER — gate appears already applied."
    log_error "Run 'restore' first, or the saved original is missing. Refusing to clobber saved state."
    exit 1
  fi

  if [ -f "$STATE_DIR/real-api-key" ]; then
    log_info "Saved real-api-key already present at $STATE_DIR/real-api-key — leaving it as-is (not overwriting)"
  else
    ( umask 077; printf '%s' "$real_key" > "$STATE_DIR/real-api-key" )
    chmod 600 "$STATE_DIR/real-api-key"
    log_success "Saved original llm-credentials api-key to $STATE_DIR/real-api-key (mode 600)"
  fi

  log_info "Seeding ab1-llm-cred + ab2-egress-cred"
  kubectl create secret generic ab1-llm-cred -n "$NS" \
    --from-literal="api.anthropic.com=$real_key" \
    --dry-run=client -o yaml | kubectl apply -f - >"$LOG_DIR/seed-ab1-llm-cred.log" 2>&1
  kubectl create secret generic ab2-egress-cred -n "$NS" \
    --from-literal="echo-target=$RC1_ECHO_REAL_CRED" \
    --dry-run=client -o yaml | kubectl apply -f - >"$LOG_DIR/seed-ab2-egress-cred.log" 2>&1
  log_success "Secrets ab1-llm-cred + ab2-egress-cred applied in $NS"

  log_info "Repointing llm-credentials to AB1 placeholders"
  kubectl create secret generic llm-credentials -n "$NS" \
    --from-literal=api-key=AB1-PLACEHOLDER \
    --from-literal=auth-token=AB1-PLACEHOLDER \
    --from-literal=base-url=http://authbridge-ab1:8080 \
    --dry-run=client -o yaml | kubectl apply -f - >"$LOG_DIR/repoint-llm-credentials.log" 2>&1
  log_success "llm-credentials repointed to AB1 placeholders"
  real_key=""  # never keep the real key around longer than needed

  log_info "Applying overlay $OVERLAY"
  if ! kubectl kustomize --load-restrictor LoadRestrictionsNone "$OVERLAY" \
      | kubectl -n "$NS" apply -f - >"$LOG_DIR/overlay-apply.log" 2>&1; then
    log_error "Overlay apply failed — see $LOG_DIR/overlay-apply.log"
    cat "$LOG_DIR/overlay-apply.log"
    exit 1
  fi
  log_success "Overlay applied (see $LOG_DIR/overlay-apply.log); tail:"
  tail -n 5 "$LOG_DIR/overlay-apply.log"

  log_info "Rolling authbridge-ab1, ibac-stub, echo-target deployments"
  kubectl -n "$NS" rollout status deploy/authbridge-ab1 --timeout=180s
  kubectl -n "$NS" rollout status deploy/ibac-stub --timeout=180s
  kubectl -n "$NS" rollout status deploy/echo-target --timeout=180s

  log_info "Force-rolling sandbox pool ($POOL_SELECTOR) — agent-sandbox controller does not roll pods on CR spec change"
  kubectl -n "$NS" delete pod -l "$POOL_SELECTOR" --ignore-not-found
  kubectl -n "$NS" wait --for=delete pod -l "$POOL_SELECTOR" --timeout=180s || true
  kubectl -n "$NS" wait --for=condition=Ready pod -l "$POOL_SELECTOR" --timeout=300s
  log_success "Sandbox pool rolled and Ready"

  log_info "Rolling ksvc/$KSVC to pick up the repointed secret"
  kubectl -n "$NS" patch ksvc "$KSVC" --type merge -p \
    "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"rc1.authbridge/gate-ts\":\"$(date +%s)\"}}}}}"
  kubectl -n "$NS" wait ksvc/"$KSVC" --for=condition=Ready --timeout=300s
  log_success "ksvc/$KSVC Ready with AuthBridge gate applied"
}

# ----------------------------------------------------------------------------
# mode: smoke
# ----------------------------------------------------------------------------
mode_smoke() {
  preflight || return 1

  log_info "Resolving Route for ksvc/$KSVC in $NS"
  local ksvc_url
  ksvc_url="$(kubectl -n "$NS" get ksvc "$KSVC" -o jsonpath='{.status.url}' 2>/dev/null || true)"
  if [ -z "$ksvc_url" ]; then
    log_error "Could not resolve ksvc/$KSVC status.url in $NS"
    return 1
  fi
  log_success "KSVC_URL=$ksvc_url"

  log_info "Running leaf-smoke.sh (SH_AUTHBRIDGE=1, NS=$NS, SH_MODEL=${SH_MODEL:-claude-haiku-4-5})"
  LEAF_LIVE_SMOKE=1 SH_AUTHBRIDGE=1 NS="$NS" KSVC_URL="$ksvc_url" \
    SH_MODEL="${SH_MODEL:-claude-haiku-4-5}" \
    bash "$SCRIPT_DIR/leaf-smoke.sh"
}

# ----------------------------------------------------------------------------
# mode: restore
# ----------------------------------------------------------------------------
mode_restore() {
  preflight || return 1

  if [ -f "$STATE_DIR/real-api-key" ]; then
    log_info "Restoring llm-credentials to direct mode (api-key only) from $STATE_DIR/real-api-key"
    kubectl create secret generic llm-credentials -n "$NS" \
      --from-literal="api-key=$(cat "$STATE_DIR/real-api-key")" \
      --dry-run=client -o yaml | kubectl apply -f - >"$LOG_DIR/restore-llm-credentials.log" 2>&1
    log_success "llm-credentials restored to direct mode"
  else
    log_warn "No saved key at $STATE_DIR/real-api-key — skipping llm-credentials restore (not guessing)"
  fi

  log_info "Re-applying base overlay $BASE_OVERLAY (drops AB2 sidecar pool + re-opens base egress policy)"
  if ! kubectl kustomize --load-restrictor LoadRestrictionsNone "$BASE_OVERLAY" \
      | kubectl -n "$NS" apply -f - >"$LOG_DIR/restore-base-apply.log" 2>&1; then
    log_error "Base overlay re-apply failed — see $LOG_DIR/restore-base-apply.log"
    cat "$LOG_DIR/restore-base-apply.log"
    exit 1
  fi
  log_success "Base overlay re-applied; tail:"
  tail -n 5 "$LOG_DIR/restore-base-apply.log"

  log_info "Deleting AB-only resources"
  kubectl -n "$NS" delete deploy authbridge-ab1 ibac-stub echo-target --ignore-not-found
  kubectl -n "$NS" delete svc authbridge-ab1 ibac-stub echo-target --ignore-not-found
  kubectl -n "$NS" delete configmap authbridge-ab1-config authbridge-ab2-config --ignore-not-found
  kubectl -n "$NS" delete secret ab1-llm-cred ab2-egress-cred --ignore-not-found
  log_success "AB-only resources removed"

  log_info "Force-rolling sandbox pool ($POOL_SELECTOR) so pods drop the AB2 sidecar"
  kubectl -n "$NS" delete pod -l "$POOL_SELECTOR" --ignore-not-found
  kubectl -n "$NS" wait --for=delete pod -l "$POOL_SELECTOR" --timeout=180s || true
  kubectl -n "$NS" wait --for=condition=Ready pod -l "$POOL_SELECTOR" --timeout=300s
  log_success "Sandbox pool rolled and Ready (base image, no sidecar)"

  log_info "Rolling ksvc/$KSVC to pick up the restored direct llm-credentials"
  kubectl -n "$NS" patch ksvc "$KSVC" --type merge -p \
    "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"rc1.authbridge/restore-ts\":\"$(date +%s)\"}}}}}"
  kubectl -n "$NS" wait ksvc/"$KSVC" --for=condition=Ready --timeout=300s
  log_success "ksvc/$KSVC Ready"

  log_success "RESTORE COMPLETE"
}

# ----------------------------------------------------------------------------
# mode: gate (up -> smoke -> restore-always)
# ----------------------------------------------------------------------------
mode_gate() {
  mode_up

  # Arm the restore as an EXIT trap (not a sequential call) so it fires on
  # ANY way this shell exits after the gate is up — an internal `exit` from
  # deeper in mode_smoke/preflight, a `set -e` abort, or the normal `exit
  # "$smoke_exit"` below. A sequential "if ! mode_smoke; then ...; fi"
  # cannot catch an `exit` call made inside mode_smoke's call graph, because
  # `exit` terminates the process immediately without returning control to
  # the caller. The trap is the only mechanism that is guaranteed to run
  # regardless of how the process exits.
  if [ "$RC1_GATE_KEEP" = "1" ]; then
    log_warn "RC1_GATE_KEEP=1 — skipping automatic restore; gate left applied in $NS for debugging"
  else
    log_info "Arming restore-on-exit trap (restore runs no matter how the smoke step exits)"
    trap 'mode_restore || true' EXIT
  fi

  local smoke_exit=0
  set +e
  mode_smoke
  smoke_exit=$?
  set -e

  echo "SMOKE_EXIT:$smoke_exit"
  exit "$smoke_exit"
}

# ----------------------------------------------------------------------------
# Entry point
# ----------------------------------------------------------------------------
MODE="${1:-gate}"
case "$MODE" in
  -h|--help) usage; exit 0 ;;
esac

case "$MODE" in
  up)      mode_up ;;
  smoke)   mode_smoke ;;
  restore) mode_restore ;;
  gate)    mode_gate ;;
  *) log_error "Unknown mode: $MODE"; echo; usage; exit 1 ;;
esac
