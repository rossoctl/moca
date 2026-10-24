#!/usr/bin/env bash
# Bring up Moca P6 with per-workload sandboxes (SH_WORKLOAD_SANDBOXES=1) and Context Service on a
# local Kind cluster, with two demo users, Alice and Bob, for the two-user demo.
#
#   setup.sh [--build|--skip-build]   create or converge the demo (cluster moca-two-users)
#   setup.sh --delete                 delete the demo cluster and the demo's local state
#
# Environment:
#   CONTEXT_SERVICE_REF   Context Service commit to install (default: the phase 1 demo's pin)
#   CONTEXT_SERVICE_REPO  a local Context Service clone to export that commit from, instead of
#                         fetching it from GitHub; its checkout is never touched
#   MOCA_DEMO_STATE       demo-only logins, contextctl, mocactl and results (default
#                         ${XDG_STATE_HOME:-~/.local/state}/moca-two-users-demo)
#   DEMO_TOKEN_TTL        lifetime of each user's demo API token, in seconds (default 28800)
#
# Hosts reach the stack through kind.yaml's 127.0.0.1 port mappings and NodePorts: no port-forward.
# Every kubectl call names the kind-moca-two-users context, and the context that was current
# before is restored on exit (kind create switches it).

set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEMO_DIR/../../.." && pwd)"
CLUSTER=moca-two-users
KUBE_CONTEXT=kind-moca-two-users
MOCA_NS=moca
CS_NS=context-service
CS_IMAGE=dev.local/context-service:demo
# The phase 1 demo's pin: Context Service main with #56 (ctx pack, workspace bundles), #54, #57.
CONTEXT_SERVICE_REF="${CONTEXT_SERVICE_REF:-79518260ea626299048657030ed87acce448d2f5}"
CONTEXT_SERVICE_GIT_URL=https://github.com/rossoctl/context-service.git
STATE_DIR="${MOCA_DEMO_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/moca-two-users-demo}"
STATE_MARKER=.moca-two-users-demo
CP_URL=http://127.0.0.1:8190
HARNESS_URL=http://127.0.0.1:8180
CS_URL=http://127.0.0.1:8181
USERS='alice bob'
TOKEN_TTL="${DEMO_TOKEN_TTL:-28800}"
case "$TOKEN_TTL" in '' | *[!0-9]*) echo "setup.sh: DEMO_TOKEN_TTL must be whole seconds" >&2; exit 2 ;; esac
BUILD_ARG=''
WORK_DIR=''
PREVIOUS_CONTEXT=''

log() { printf '==> %s\n' "$*" >&2; }
die() {
  printf 'setup.sh: %s\n' "$*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }
kc() { kubectl --context "$KUBE_CONTEXT" "$@"; }

restore_context() {
  local now
  now="$(kubectl config current-context 2>/dev/null || true)"
  if [ -n "$PREVIOUS_CONTEXT" ] && [ "$now" != "$PREVIOUS_CONTEXT" ]; then
    kubectl config use-context "$PREVIOUS_CONTEXT" >/dev/null 2>&1 &&
      log "restored the Kubernetes context $PREVIOUS_CONTEXT"
  fi
}
on_exit() {
  status=$?
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
  restore_context
  exit "$status"
}

PREVIOUS_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
[ "$PREVIOUS_CONTEXT" != "$KUBE_CONTEXT" ] || PREVIOUS_CONTEXT=''
trap on_exit EXIT

case "${1:-}" in
--delete)
  [ "$#" -eq 1 ] || die 'usage: setup.sh --delete'
  need kind
  kind delete cluster --name "$CLUSTER"
  # Only a directory this script made: a mis-set MOCA_DEMO_STATE must never be removed.
  if [ -e "$STATE_DIR" ]; then
    [ -f "$STATE_DIR/$STATE_MARKER" ] ||
      die "cluster deleted, but refusing to delete $STATE_DIR: it has no $STATE_MARKER marker"
    rm -rf "$STATE_DIR"
  fi
  exit 0
  ;;
--build | --skip-build) BUILD_ARG="$1" ;;
'') ;;
-h | --help)
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
  ;;
*) die "unknown argument: $1 (see --help)" ;;
esac
[ "$#" -le 1 ] || die 'usage: setup.sh [--build|--skip-build|--delete]'

for c in kind docker kubectl jq git curl openssl node; do need "$c"; done
# This checkout's mocactl: the demo needs `workloads create --sandboxes/--mount`.
MOCACTL_MJS="$REPO_ROOT/packages/mocactl/bin/mocactl.mjs"
[ -d "$REPO_ROOT/packages/mocactl/node_modules" ] ||
  die "packages/mocactl has no node_modules: run pnpm install in $REPO_ROOT first"

# 1. The cluster, created with kind.yaml's port mappings, or reused when it has them.
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  ports="$(docker port "$CLUSTER-control-plane" 2>/dev/null || true)"
  for p in '30080/tcp -> 127.0.0.1:8180' '30081/tcp -> 127.0.0.1:8181' '30082/tcp -> 127.0.0.1:8190'; do
    printf '%s\n' "$ports" | grep -qxF "$p" ||
      die "Kind cluster $CLUSTER exists without kind.yaml's port mappings ($p); run setup.sh --delete first"
  done
  log "reusing Kind cluster $CLUSTER"
else
  # A host proxy would leak into the node through kind's environment and break image pulls.
  env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u NO_PROXY -u no_proxy \
    kind create cluster --name "$CLUSTER" --config "$DEMO_DIR/kind.yaml" --wait 2m
fi
# And clear one left in containerd's environment by an earlier create.
node="$CLUSTER-control-plane"
if docker exec "$node" test -e /etc/systemd/system/containerd.service.d/http-proxy.conf; then
  log "clearing the proxy from containerd in $node"
  docker exec "$node" sh -c 'rm -f /etc/systemd/system/containerd.service.d/http-proxy.conf &&
    systemctl daemon-reload && systemctl restart containerd'
fi

# 2. Moca P6 through deploy/k8s/setup.sh, as the phase 1 demo does (--target kind-ci: the in-pod
# mock model, so no model key), with SH_WORKLOAD_SANDBOXES=1: moca-provisioner, which gives a
# workload created with `sandboxes` pods and a PVC of its own. The cluster's default class
# (Kind's local-path `standard`) is the one allowlisted class. SH_PUBLIC_HARNESS_URL makes the
# control plane advertise this demo's harness port, not 8080.
(
  # shellcheck source-path=SCRIPTDIR source=../../../deploy/k8s/setup.sh
  SH_SOURCE_ONLY=1 . "$REPO_ROOT/deploy/k8s/setup.sh"
  # shellcheck disable=SC2034 # read by the sourced deploy/k8s/setup.sh
  KIND_CLUSTER="$CLUSTER"
  # shellcheck disable=SC2034
  KIND_CONTEXT="$KUBE_CONTEXT"
  print_access() { :; }
  export SH_SANDBOX_COUNT=2 SH_WORKLOAD_SANDBOXES=1 SH_PUBLIC_HARNESS_URL="$HARNESS_URL"
  if [ -n "$BUILD_ARG" ]; then main --target kind-ci "$BUILD_ARG"; else main --target kind-ci; fi
)

# 3. Context Service at the pinned commit, exported with git archive (no checkout is touched).
WORK_DIR="$(mktemp -d)"
cs_src="$WORK_DIR/context-service"
mkdir -p "$cs_src"
if [ -n "${CONTEXT_SERVICE_REPO:-}" ]; then
  git -C "$CONTEXT_SERVICE_REPO" archive "$CONTEXT_SERVICE_REF" | tar -x -C "$cs_src"
else
  git init -q --bare "$WORK_DIR/cs.git"
  git -C "$WORK_DIR/cs.git" fetch -q --depth 1 "$CONTEXT_SERVICE_GIT_URL" "$CONTEXT_SERVICE_REF"
  git -C "$WORK_DIR/cs.git" archive FETCH_HEAD | tar -x -C "$cs_src"
fi
[ -f "$cs_src/deploy/context-service.yaml" ] || die "Context Service $CONTEXT_SERVICE_REF has no deploy/context-service.yaml"
log "Context Service $CONTEXT_SERVICE_REF"
if [ "$BUILD_ARG" != --skip-build ]; then
  docker build --load -t "$CS_IMAGE" "$cs_src"
  kind load docker-image "$CS_IMAGE" --name "$CLUSTER"
elif ! docker exec "$CLUSTER-control-plane" crictl inspecti "$CS_IMAGE" >/dev/null 2>&1; then
  die "--skip-build: $CS_IMAGE is not on the cluster yet; run setup.sh once without --skip-build"
fi
# Mark only a directory this run creates, or one that is empty or already ours: --delete trusts
# the marker, so a mis-set MOCA_DEMO_STATE (say $HOME) must never be marked.
if [ -e "$STATE_DIR" ] && [ ! -f "$STATE_DIR/$STATE_MARKER" ] && [ -n "$(ls -A "$STATE_DIR")" ]; then
  die "refusing to use $STATE_DIR: it exists, is not empty and has no $STATE_MARKER marker; set MOCA_DEMO_STATE to a new or empty directory"
fi
mkdir -p "$STATE_DIR/bin"
: >"$STATE_DIR/$STATE_MARKER"
if command -v go >/dev/null 2>&1; then
  (cd "$cs_src" && go build -o "$STATE_DIR/bin/contextctl" ./cmd/contextctl)
  log "built $STATE_DIR/bin/contextctl"
else
  log 'go not found: contextctl not built; run.sh uses the contextctl on PATH'
fi
# run.sh runs this checkout's mocactl through this wrapper.
printf '#!/bin/sh\nexec %s %s "$@"\n' "'$(command -v node)'" "'$MOCACTL_MJS'" >"$STATE_DIR/bin/mocactl"
chmod 755 "$STATE_DIR/bin/mocactl"

# 4. The shared token Moca presents to Context Service. A re-run keeps it.
kc create namespace "$CS_NS" --dry-run=client -o yaml | kc apply -f - >/dev/null
token="$(kc -n "$CS_NS" get secret context-service-control-plane -o jsonpath='{.data.token}' 2>/dev/null || true)"
if [ -n "$token" ]; then token="$(printf '%s' "$token" | base64 --decode)"; else token="$(openssl rand -hex 32)"; fi
# Values go through stdin (jq builds each Secret), never onto a command line.
put_token() {
  printf '%s' "$token" | jq -Rs --arg ns "$1" --arg name "$2" \
    '{apiVersion:"v1",kind:"Secret",metadata:{name:$name,namespace:$ns},type:"Opaque",stringData:{token:.}}' |
    kc apply -f - >/dev/null
}
put_token "$CS_NS" context-service-control-plane
put_token "$MOCA_NS" moca-context-service
unset token
sed "s#ghcr.io/rossoctl/context-service:latest#$CS_IMAGE#" "$cs_src/deploy/context-service.yaml" | kc apply -f - >/dev/null
kc -n "$CS_NS" rollout restart deployment/context-service >/dev/null

# 5. Turn the workloads routes on.
kc -n "$MOCA_NS" create configmap moca-context-service \
  --from-literal=enabled=1 \
  --from-literal=url="http://context-service.$CS_NS.svc:8080" \
  --from-literal=public-url="$CS_URL" \
  --from-literal=namespace="$CS_NS" \
  --dry-run=client -o yaml | kc apply -f - >/dev/null

# 6. Host access: NodePorts behind kind.yaml's mappings, and a NetworkPolicy admitting node-forwarded
# traffic to the two user-facing pods' port 8080 only (the pod CIDR stays excluded).
kc -n "$MOCA_NS" patch service moca-supervisor --type merge \
  -p '{"spec":{"type":"NodePort","ports":[{"name":"http","port":8080,"targetPort":"http","nodePort":30080},{"name":"admin","port":8081,"targetPort":"admin"}]}}' >/dev/null
kc -n "$MOCA_NS" patch service moca-control-plane --type merge \
  -p '{"spec":{"type":"NodePort","ports":[{"name":"http","port":8080,"targetPort":"http","nodePort":30082}]}}' >/dev/null
kc -n "$CS_NS" patch service context-service --type merge \
  -p '{"spec":{"type":"NodePort","ports":[{"name":"http","port":8080,"targetPort":"http","nodePort":30081}]}}' >/dev/null
kc apply -f - >/dev/null <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: kind-demo-host-access, namespace: $MOCA_NS }
spec:
  podSelector:
    matchExpressions: [{ key: app, operator: In, values: [moca-supervisor, moca-control-plane] }]
  policyTypes: [Ingress]
  ingress:
    - from: [{ ipBlock: { cidr: 0.0.0.0/0, except: [10.244.0.0/16] } }]
      ports: [{ protocol: TCP, port: 8080 }]
EOF

kc -n "$MOCA_NS" rollout restart deployment/moca-supervisor >/dev/null
kc -n "$MOCA_NS" rollout status deployment/moca-supervisor --timeout=3m
kc -n "$MOCA_NS" rollout status deployment/moca-provisioner --timeout=3m
kc -n "$CS_NS" rollout status deployment/context-service --timeout=3m
for u in "$HARNESS_URL/health" "$CP_URL/healthz" "$CS_URL/healthz"; do
  curl --retry 30 --retry-connrefused --retry-delay 2 -fsS -o /dev/null "$u" || die "$u is not answering"
done

# 7. DEMO-ONLY logins: one API token per user, minted inside the control-plane pod with its own
# signing key (as deploy/k8s/smoke.sh does), with subjects demo:alice and demo:bob, each written
# where mocactl caches a login, in that user's own demo-only config dir. No refresh token: re-run
# setup.sh after DEMO_TOKEN_TTL seconds. Never do this on a real deployment; use `mocactl login`.
export SH_CONTROL_PLANE_URL="$CP_URL" SH_HARNESS_URL="$HARNESS_URL"
export PATH="$STATE_DIR/bin:$PATH"
chmod 700 "$STATE_DIR"
for user in $USERS; do
  subject="demo:$user"
  api="$(kc -n "$MOCA_NS" exec deploy/moca-control-plane -c control-plane -- \
    node --import tsx --input-type=module -e \
    "import { readFileSync } from 'node:fs'; import { makeSigner } from './src/token.ts';
     const s = makeSigner(readFileSync('/run/credentials/SH_SESSION_TOKEN_PRIVATE_KEY', 'utf8'));
     process.stdout.write(s.mint({ sub: '$subject', tenant: '$subject', roles: [], scope: ['api'], ttlSeconds: $TOKEN_TTL }));")"
  [ -n "$api" ] || die "could not mint an API token for $subject in the control-plane pod"
  cfg="$STATE_DIR/$user/config"
  mkdir -p "$cfg/mocactl" "$STATE_DIR/$user/state"
  chmod 700 "$STATE_DIR/$user" "$cfg" "$cfg/mocactl"
  (
    umask 077
    DEMO_API_TOKEN="$api" jq -n --arg url "$CP_URL" --arg sub "$subject" \
      --argjson exp "$(($(date +%s) + TOKEN_TTL))" \
      '{apiToken: env.DEMO_API_TOKEN, subject: $sub, roles: [], expiresAt: $exp, controlPlaneUrl: $url}' \
      >"$cfg/mocactl/auth.json"
    jq -n --arg cp "$CP_URL" --arg h "$HARNESS_URL" '{controlPlaneUrl: $cp, harnessUrl: $h}' \
      >"$cfg/mocactl/config.json"
  )
  unset api
  # Each user's own credential for the mock model (on the supervisor pod's loopback, any token).
  if ! XDG_CONFIG_HOME="$cfg" XDG_STATE_HOME="$STATE_DIR/$user/state" mocactl credentials --json |
    jq -e '.credentials[] | select(.name == "demo-mock")' >/dev/null; then
    printf '%s' mock-not-a-secret | XDG_CONFIG_HOME="$cfg" XDG_STATE_HOME="$STATE_DIR/$user/state" \
      mocactl credentials add demo-mock --host 127.0.0.1 --kind bearer \
      --endpoint http://127.0.0.1:18099 >/dev/null
  fi
  log "logged $subject in under $STATE_DIR/$user"
done

cat <<EOF

Moca P6 with per-workload sandboxes is ready on Kind cluster $CLUSTER (context $KUBE_CONTEXT).
  harness:         $HARNESS_URL
  control plane:   $CP_URL
  Context Service: $CS_URL (uploads)
Demo users demo:alice and demo:bob, with mocactl and contextctl, live under $STATE_DIR.

Next:  $DEMO_DIR/run.sh
Done:  $DEMO_DIR/setup.sh --delete
EOF
