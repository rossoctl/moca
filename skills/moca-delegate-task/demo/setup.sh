#!/usr/bin/env bash
# Bring up Moca P6 and Context Service on a local Kind cluster for the moca-delegate-task demo.
#
#   setup.sh [--build|--skip-build]   create or converge the demo (cluster moca-demo)
#   setup.sh --delete                 delete the demo cluster and the demo's local state
#
# Environment:
#   CONTEXT_SERVICE_REF   Context Service commit to install (default: the pin below)
#   CONTEXT_SERVICE_REPO  a local Context Service clone to export that commit from, instead of
#                         fetching it from GitHub; its checkout is never touched
#   MOCA_DEMO_STATE       demo-only mocactl login, contextctl and results (default
#                         ${XDG_STATE_HOME:-~/.local/state}/moca-kind-demo)
#   SH_SANDBOX_COUNT      container sandboxes (default 2)
#
# Hosts reach the stack through kind.yaml's 127.0.0.1 port mappings and NodePorts: no port-forward.
# Every kubectl call names the kind-moca-demo context, and the context that was current before
# is restored on exit (kind create switches it).

set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEMO_DIR/../../.." && pwd)"
CLUSTER=moca-demo
KUBE_CONTEXT=kind-moca-demo
MOCA_NS=moca
CS_NS=context-service
CS_IMAGE=dev.local/context-service:demo
# Context Service main with #56 (ctx pack, workspace bundles), #54 (start-up digest retry), #57.
CONTEXT_SERVICE_REF="${CONTEXT_SERVICE_REF:-79518260ea626299048657030ed87acce448d2f5}"
CONTEXT_SERVICE_GIT_URL=https://github.com/rossoctl/context-service.git
STATE_DIR="${MOCA_DEMO_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/moca-kind-demo}"
STATE_MARKER=.moca-kind-demo
CP_URL=http://127.0.0.1:8090
HARNESS_URL=http://127.0.0.1:8080
CS_URL=http://127.0.0.1:8081
# The demo's API token lifetime: no refresh token comes with it, so it simply expires.
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
    [ -f "$STATE_DIR/$STATE_MARKER" ] || die "refusing to delete $STATE_DIR: it has no $STATE_MARKER marker"
    rm -rf "$STATE_DIR"
  fi
  exit 0
  ;;
--build | --skip-build) BUILD_ARG="$1" ;;
'') ;;
-h | --help)
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
  ;;
*) die "unknown argument: $1 (see --help)" ;;
esac
[ "$#" -le 1 ] || die 'usage: setup.sh [--build|--skip-build|--delete]'

for c in kind docker kubectl jq git curl openssl mocactl; do need "$c"; done

# 1. The cluster, created with kind.yaml's port mappings, or reused when it has them.
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  ports="$(docker port "$CLUSTER-control-plane" 2>/dev/null || true)"
  for p in '30080/tcp -> 127.0.0.1:8080' '30081/tcp -> 127.0.0.1:8081' '30082/tcp -> 127.0.0.1:8090'; do
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

# 2. Moca P6 through deploy/k8s/setup.sh. --target kind-ci, not kind: it adds the loopback mock
# model to the supervisor pod, so the demo needs no model key, and a placeholder GitHub client ID,
# since the demo mints its API token instead of a device login. That script names its cluster moca,
# so it is sourced (SH_SOURCE_ONLY=1) and pointed at this one; its port-forward hints are dropped.
(
  # shellcheck source-path=SCRIPTDIR source=../../../deploy/k8s/setup.sh
  SH_SOURCE_ONLY=1 . "$REPO_ROOT/deploy/k8s/setup.sh"
  KIND_CLUSTER="$CLUSTER"
  KIND_CONTEXT="$KUBE_CONTEXT"
  print_access() { :; }
  SH_SANDBOX_COUNT="${SH_SANDBOX_COUNT:-2}"
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
# The matching client, for ctx pack (#56 is needed on the client as well as the server).
mkdir -p "$STATE_DIR/bin"
: >"$STATE_DIR/$STATE_MARKER"
if command -v go >/dev/null 2>&1; then
  (cd "$cs_src" && go build -o "$STATE_DIR/bin/contextctl" ./cmd/contextctl)
  log "built $STATE_DIR/bin/contextctl"
else
  log 'go not found: contextctl not built; run.sh uses the contextctl on PATH'
fi

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
# A rebuilt image keeps its tag: restart so the pod runs it.
kc -n "$CS_NS" rollout restart deployment/context-service >/dev/null

# 5. Turn the workloads routes on (MOCA_CONTEXT_WORKLOADS_ENABLED and the rest, read by
# deploy/k8s/base/supervisor.yaml).
kc -n "$MOCA_NS" create configmap moca-context-service \
  --from-literal=enabled=1 \
  --from-literal=url="http://context-service.$CS_NS.svc:8080" \
  --from-literal=public-url="$CS_URL" \
  --from-literal=namespace="$CS_NS" \
  --dry-run=client -o yaml | kc apply -f - >/dev/null

# 6. Host access: NodePorts behind kind.yaml's mappings. Moca's namespace is default-deny, so admit
# node-forwarded traffic to the two user-facing pods' port 8080 and nothing else; the pod CIDR
# (kind.yaml's podSubnet) stays excluded, so other pods remain denied.
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

# The supervisor reads the ConfigMap and Secret only at start.
kc -n "$MOCA_NS" rollout restart deployment/moca-supervisor >/dev/null
kc -n "$MOCA_NS" rollout status deployment/moca-supervisor --timeout=3m
kc -n "$CS_NS" rollout status deployment/context-service --timeout=3m
for u in "$HARNESS_URL/health" "$CP_URL/healthz" "$CS_URL/healthz"; do
  curl --retry 30 --retry-connrefused --retry-delay 2 -fsS -o /dev/null "$u" || die "$u is not answering"
done

# 7. DEMO-ONLY login: mint an API token inside the control-plane pod with its own signing key (as
# deploy/k8s/smoke.sh does) and write it where mocactl caches a login, in a demo-only config dir.
# There is no refresh token: after DEMO_TOKEN_TTL seconds, re-run setup.sh. Never do this on a
# real deployment; use `mocactl login`.
export XDG_CONFIG_HOME="$STATE_DIR/config" XDG_STATE_HOME="$STATE_DIR/state"
# mocactl prefers these over its config file; pin them so a real deployment's never wins.
export SH_CONTROL_PLANE_URL="$CP_URL" SH_HARNESS_URL="$HARNESS_URL"
api="$(kc -n "$MOCA_NS" exec deploy/moca-control-plane -c control-plane -- \
  node --import tsx --input-type=module -e \
  "import { readFileSync } from 'node:fs'; import { makeSigner } from './src/token.ts';
   const s = makeSigner(readFileSync('/run/credentials/SH_SESSION_TOKEN_PRIVATE_KEY', 'utf8'));
   process.stdout.write(s.mint({ sub: 'demo:1', tenant: 'demo:1', roles: [], scope: ['api'], ttlSeconds: $TOKEN_TTL }));")"
[ -n "$api" ] || die 'could not mint an API token in the control-plane pod'
mkdir -p "$XDG_CONFIG_HOME/mocactl" "$XDG_STATE_HOME"
chmod 700 "$STATE_DIR" "$XDG_CONFIG_HOME" "$XDG_CONFIG_HOME/mocactl"
(
  umask 077
  DEMO_API_TOKEN="$api" jq -n --arg url "$CP_URL" --argjson exp "$(($(date +%s) + TOKEN_TTL))" \
    '{apiToken: env.DEMO_API_TOKEN, subject: "demo:1", roles: [], expiresAt: $exp, controlPlaneUrl: $url}' \
    >"$XDG_CONFIG_HOME/mocactl/auth.json"
  jq -n --arg cp "$CP_URL" --arg h "$HARNESS_URL" '{controlPlaneUrl: $cp, harnessUrl: $h}' \
    >"$XDG_CONFIG_HOME/mocactl/config.json"
)
unset api

# The mock model's credential: it answers on the supervisor pod's loopback and takes any token.
if ! mocactl credentials --json | jq -e '.credentials[] | select(.name == "demo-mock")' >/dev/null; then
  printf '%s' mock-not-a-secret | mocactl credentials add demo-mock --host 127.0.0.1 --kind bearer \
    --endpoint http://127.0.0.1:18099 >/dev/null
fi

cat <<EOF

Moca P6 and Context Service are ready on Kind cluster $CLUSTER (context $KUBE_CONTEXT).
  harness:         $HARNESS_URL
  control plane:   $CP_URL
  Context Service: $CS_URL (uploads)
mocactl (demo-only login) and contextctl live under $STATE_DIR.

Next:  $DEMO_DIR/run.sh
Done:  $DEMO_DIR/setup.sh --delete
EOF
