#!/usr/bin/env bash
# Cluster-free tests for deploy/k8s/setup.sh (#423). kubectl, kind, docker and oc are mocks that log
# their argv and keep a small JSON object store; every other external setup.sh can reach goes
# through a logging shim. PATH is the shim dir alone, so nothing real stands in for a mock, and the
# argv log is complete -- which is what lets this test prove no secret reaches any process's argv
# (spec §4.2). Same approach as deploy/compose/tests/install.test.sh.
set -euo pipefail

SRC_K8S="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log" MOCK_STATE="$TMP/state" SH_WAIT_SECONDS=2
# Sticky input: a value in the caller's shell would be a GIVEN default tier in every run below.
unset SH_SANDBOX_DEFAULT_TIER SH_SANDBOX_EGRESS_EXCEPT
REAL_PATH="$PATH"
export REAL_PATH
# The bash that launched this suite, not the first one on PATH (#440): `/bin/bash setup.test.sh`
# on macOS must exercise bash 3.2, and `command -v bash` would hand it Homebrew's 5.x instead.
# $BASH is the running interpreter's own path; the fallback is for a sourced run, where it is unset.
REAL_BASH="${BASH:-$(command -v bash)}"
mkdir -p "$TMP/bin" "$MOCK_STATE"

fail() {
  echo "FAIL: $*" >&2
  [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2
  exit 1
}
pass() { echo "ok - $*"; }

# A throwaway copy of the repo layout setup.sh expects, so .generated/ lands in $TMP, not the checkout.
REPO="$TMP/repo"
mkdir -p "$REPO/deploy/microvm" "$REPO/remote-worker"
cp -R "$SRC_K8S" "$REPO/deploy/k8s"
rm -rf "$REPO/deploy/k8s/.generated"
cp "$SRC_K8S/../microvm/mock-anthropic.mjs" "$REPO/deploy/microvm/"
: >"$REPO/Dockerfile"
: >"$REPO/remote-worker/Dockerfile"
SETUP="$REPO/deploy/k8s/setup.sh"

for cmd in awk base64 basename cat chmod cp cut dirname grep head jq mkdir mktemp mv openssl rm sed sha256sum shasum sleep sort tail tr wc; do
  real="$(command -v "$cmd" 2>/dev/null)" || continue
  [[ "$real" == /* ]] || continue
  printf '#!/bin/sh\nprintf "%%s %%s\\n" %s "$*" >>"$MOCK_LOG"\nexec %s "$@"\n' "$cmd" "$real" >"$TMP/bin/$cmd"
  chmod +x "$TMP/bin/$cmd"
done
# macOS mktemp -d ignores TMPDIR, so the key-cleanup test redirects it here instead: with
# MOCK_MKTEMP_DIR set, a bare `mktemp -d` lands in that directory, where the test can look.
real_mktemp="$(command -v mktemp)"
cat >"$TMP/bin/mktemp" <<SHIM
#!/bin/sh
printf "%s %s\\n" mktemp "\$*" >>"\$MOCK_LOG"
if [ -n "\${MOCK_MKTEMP_DIR-}" ] && [ "\$*" = "-d" ]; then exec $real_mktemp -d "\$MOCK_MKTEMP_DIR/tmp.XXXXXX"; fi
exec $real_mktemp "\$@"
SHIM
chmod +x "$TMP/bin/mktemp"

cat >"$TMP/bin/kubectl" <<'MOCK'
#!/usr/bin/env bash
# Mock kubectl. Secrets and ConfigMaps live as JSON files in $MOCK_STATE/<ns>__<Kind>__<name>.json.
printf 'kubectl %s\n' "$*" >>"$MOCK_LOG"
export PATH="$REAL_PATH"
set -euo pipefail
if [[ "${1-}" == --context ]]; then shift 2; fi
ns=default
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
  -n) ns="$2"; shift 2 ;;
  *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]}"
store() { printf '%s/%s__%s__%s.json' "$MOCK_STATE" "$1" "$2" "$3"; }
case "${1-} ${2-}" in
"config current-context") echo "${MOCK_CURRENT_CONTEXT:-kind-moca}" ;;
"version --client") echo 'Client Version: v1.31.0' ;;
"get secret" | "get configmap")
  kind=Secret
  [[ "$2" == configmap ]] && kind=ConfigMap
  # MOCK_GET_FAIL=1 fails every Secret GET; MOCK_GET_FAIL=NAME fails only Secret NAME's.
  if [[ "$kind" == Secret && -n "${MOCK_GET_FAIL-}" && ("$MOCK_GET_FAIL" == 1 || "$MOCK_GET_FAIL" == "$3") ]]; then
    echo 'Error from server (InternalError): etcd timeout' >&2
    exit 1
  fi
  # MOCK_GET_CM_FAIL=NAME fails ConfigMap NAME's GET.
  if [[ "$kind" == ConfigMap && "${MOCK_GET_CM_FAIL-}" == "$3" ]]; then
    echo 'Error from server (InternalError): etcd timeout' >&2
    exit 1
  fi
  f="$(store "$ns" "$kind" "$3")"
  if [[ ! -f "$f" ]]; then
    [[ " $* " != *" --ignore-not-found "* ]] || exit 0
    echo "Error from server (NotFound): $2 \"$3\" not found" >&2
    exit 1
  fi
  if [[ " $* " == *" -o name "* ]]; then echo "$2/$3"; else cat "$f"; fi ;;
"apply --server-side")
  obj="$(cat)"
  # With MOCK_SSA_PRUNE=1, simulate server-side apply pruning: data becomes exactly the applied stringData keys
  if [[ -n "${MOCK_SSA_PRUNE-}" && "$(jq -r '.kind' <<<"$obj")" == Secret && -n "$(jq -r '.stringData // empty' <<<"$obj")" ]]; then
    obj="$(jq '.data = (.stringData | map_values(@base64)) | del(.stringData)' <<<"$obj")"
  else
    obj="$(jq 'if .stringData then .data = ((.data // {}) + (.stringData | map_values(@base64))) | del(.stringData) else . end' <<<"$obj")"
  fi
  printf '%s\n' "$obj" >"$(store "$(jq -r .metadata.namespace <<<"$obj")" "$(jq -r .kind <<<"$obj")" "$(jq -r .metadata.name <<<"$obj")")" ;;
"apply -f") : ;; # a file path (namespaces.yaml); stdin applies all go through --server-side
"apply -k")
  if [[ -n "${MOCK_APPLY_K_FAIL-}" ]]; then echo 'error: the server was unable to return a response in the time allotted' >&2; exit 1; fi
  cp "$3/kustomization.yaml" "$MOCK_STATE/applied-kustomization.yaml" ;;
"create configmap")
  jq -n --arg n "$3" --arg ns "$ns" '{apiVersion: "v1", kind: "ConfigMap", metadata: {name: $n, namespace: $ns}, data: {"mock-anthropic.mjs": "x"}}' ;;
"create secret")
  if [[ -n "${MOCK_TLS_CREATE_FAIL-}" ]]; then echo 'error: failed to load key pair' >&2; exit 1; fi
  crt=''
  for a in "$@"; do [[ "$a" != --cert=* ]] || crt="$(base64 <"${a#--cert=}" | tr -d '\n')"; done
  jq -n --arg n "$4" --arg ns "$ns" --arg c "${crt:-Y3J0}" '{apiVersion: "v1", kind: "Secret", type: "kubernetes.io/tls", metadata: {name: $n, namespace: $ns}, data: {"tls.crt": $c, "tls.key": "a2V5"}}' ;;
"patch secret")
  f="$(store "$ns" Secret "$3")"
  [[ -f "$f" ]] || { echo "Error from server (NotFound): secrets \"$3\" not found" >&2; exit 1; }
  p=''
  while [[ $# -gt 0 ]]; do [[ "$1" == -p ]] && { p="$2"; break; }; shift; done
  # Reject JSON Patch (array) bodies; only merge patch (object with data) is allowed.
  if jq -e '. | type == "array"' <<<"$p" >/dev/null 2>&1; then
    echo "error: the server does not support JSON Patch on this Secret; use merge patch" >&2
    exit 1
  fi
  jq --argjson p "$p" '.data = ((.data // {}) + ($p.data // {}) | with_entries(select(.value != null)))' "$f" >"$f.new"
  mv "$f.new" "$f" ;;
"run moca-genkeys")
  hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
  if [[ -n "${MOCK_GENKEYS_BAD-}" ]]; then
    printf 'SH_SESSION_TOKEN_PRIVATE_KEY=MC4C%s\n' "$(hex 16)"
    printf 'SH_SESSION_TOKEN_PUBLIC_KEYS=%s:MCow\n' "$(hex 8)"
    printf 'SH_CREDENTIAL_KEK=not a key\n'
    printf 'SH_EXCHANGE_TOKEN=%s\n' "$(hex 32)"
    exit 0
  fi
  printf 'SH_SESSION_TOKEN_PRIVATE_KEY=MC4CAQAwBQYDK2VwBCIEI%s\n' "$(hex 22)"
  printf 'SH_SESSION_TOKEN_PUBLIC_KEYS=%s:MCowBQYDK2VwAyEA%s\n' "$(hex 8)" "$(hex 22)"
  printf 'SH_CREDENTIAL_KEK=%s=\n' "$(hex 22 | cut -c1-43)"
  printf 'SH_EXCHANGE_TOKEN=%s\n' "$(hex 32)" ;;
"delete pod") : ;;
# ADR-0045: turning test users off deletes their Secret, so the mock must actually remove the file
# the assertions look at -- otherwise the on->off case would pass without the delete happening.
"delete secret") rm -f "$(store "$ns" Secret "$3")" ;;
# Turning SH_WORKLOAD_SANDBOXES off: the component's objects, and with --delete-workload-sandboxes the
# workloads' own. Deleting the StatefulSets clears MOCK_WORKLOAD_STS's stand-in.
"delete statefulsets,services,secrets,persistentvolumeclaims") rm -f "$MOCK_STATE/workload-sts" ;;
"delete deployment/moca-provisioner" | "delete role/moca-provisioner" | "delete validatingadmissionpolicybinding/moca-provisioner") : ;;
# A workload's StatefulSets, PVCs and Secrets in moca-sandbox: one name per line in $MOCK_STATE/workload-sts.
"get statefulsets,persistentvolumeclaims,secrets") [[ ! -f "$MOCK_STATE/workload-sts" ]] || cat "$MOCK_STATE/workload-sts" ;;
# The provisioner, while the last apply listed the component; stopped (and started again) on disable.
# MOCK_PROVISIONER_STUCK=1: its pod never goes away.
"get deployment")
  if [[ "$3" == moca-control-plane ]]; then
    # The upgrade migration reads the control plane Deployment from the store, like a Secret or
    # ConfigMap; --ignore-not-found on a missing one prints nothing and exits 0.
    f="$(store "$ns" Deployment moca-control-plane)"
    if [[ ! -f "$f" ]]; then
      [[ " $* " != *" --ignore-not-found "* ]] || exit 0
      echo "Error from server (NotFound): deployments \"moca-control-plane\" not found" >&2
      exit 1
    fi
    cat "$f"
  else
    ! grep -q workload-sandboxes "$MOCK_STATE/applied-kustomization.yaml" 2>/dev/null || echo deployment.apps/moca-provisioner
  fi ;;
# The 0.8 upgrade migration: a trailing dash removes the env entry from the stored Deployment.
"set env")
  [[ "$3" == deployment/moca-control-plane && "$4" == -c && "$5" == control-plane && "$6" == SH_MODEL_CATALOG_HOSTS- ]] ||
    { echo "mock kubectl: unhandled: $*" >&2; exit 2; }
  f="$(store "$ns" Deployment moca-control-plane)"
  [[ -f "$f" ]] || { echo "Error from server (NotFound): deployments \"moca-control-plane\" not found" >&2; exit 1; }
  jq '(.spec.template.spec.containers[] | select(.name == "control-plane") | .env) |=
      map(select(.name != "SH_MODEL_CATALOG_HOSTS"))' "$f" >"$f.new"
  mv "$f.new" "$f" ;;
"scale deployment/moca-provisioner") : ;;
"get pods") [[ -z "${MOCK_PROVISIONER_STUCK-}" ]] || echo pod/moca-provisioner-0 ;;
# kube_api_egress's reads. MOCK_NO_VAP=1: a cluster older than 1.30; MOCK_NO_API_ENDPOINTS=1: no
# addresses; MOCK_RAW_FAIL=1: kubectl itself fails (auth, an unreachable API server).
"get --raw")
  if [[ -n "${MOCK_RAW_FAIL-}" ]]; then echo 'error: You must be logged in to the server (Unauthorized)' >&2; exit 1; fi
  if [[ -n "${MOCK_NO_VAP-}" ]]; then echo '{"resources":[{"name":"mutatingwebhookconfigurations"}]}'
  else echo '{"resources":[{"name":"validatingadmissionpolicies"},{"name":"validatingadmissionpolicybindings"}]}'; fi ;;
"get service")
  [[ "$3" == kubernetes && "$ns" == default ]] || { echo "mock kubectl: unhandled: $*" >&2; exit 2; }
  echo '{"spec":{"clusterIP":"10.96.0.1","clusterIPs":["10.96.0.1"],"ports":[{"name":"https","port":443,"protocol":"TCP"}]}}' ;;
"get endpointslices")
  if [[ -n "${MOCK_NO_API_ENDPOINTS-}" ]]; then echo '{"items":[]}'
  else echo '{"items":[{"endpoints":[{"addresses":["172.18.0.2"]}],"ports":[{"name":"https","port":6443,"protocol":"TCP"}]}]}'; fi ;;
"rollout status" | "rollout restart") : ;;
"exec redis-0") echo "${MOCK_RECORDS:-2}" ;;
"get namespace")
  # ocp-single's existence check. MOCK_NO_NAMESPACE=NAME fails NAME's GET (NotFound).
  if [[ -n "${MOCK_NO_NAMESPACE-}" && "$MOCK_NO_NAMESPACE" == "$3" ]]; then
    echo "Error from server (NotFound): namespaces \"$3\" not found" >&2
    exit 1
  fi ;;
"get storageclass")
  if [[ -n "${MOCK_GET_SC_FAIL-}" ]]; then echo 'Error from server (Forbidden): storageclasses is forbidden' >&2; exit 1; fi
  if [[ -n "${MOCK_NO_DEFAULT_SC-}" ]]; then echo '{"items":[{"metadata":{"name":"slow"}}]}'
  elif [[ -n "${MOCK_SC_SLOW-}" ]]; then echo '{"items":[{"metadata":{"name":"standard","annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}},{"metadata":{"name":"slow"}}]}'
  else echo '{"items":[{"metadata":{"name":"standard","annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}]}'; fi ;;
*) echo "mock kubectl: unhandled: $*" >&2; exit 2 ;;
esac
MOCK

cat >"$TMP/bin/kind" <<'MOCK'
#!/usr/bin/env bash
printf 'kind %s\n' "$*" >>"$MOCK_LOG"
case "$*" in
version) echo "${MOCK_KIND_VERSION_OUT:-kind v${MOCK_KIND_VERSION:-0.27.0} go1.23.4 linux/amd64}" ;;
"get clusters") [[ -z "${MOCK_KIND_CLUSTERS-moca}" ]] || echo "${MOCK_KIND_CLUSTERS-moca}" ;;
"create cluster"* | "load docker-image"*) : ;;
*) echo "mock kind: unhandled: $*" >&2; exit 2 ;;
esac
MOCK

cat >"$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$MOCK_LOG"
case "${1-}" in
pull) [[ -z "${MOCK_PULL_FAIL-}" ]] ;;
tag | build) : ;;
# `image inspect --format {{.Id}} TAG`: MOCK_IMAGE_GEN stands in for a rebuild (a new ID, same tag).
image) echo "sha256:${MOCK_IMAGE_GEN:-1}-${5##*/}" ;;
*) echo "mock docker: unhandled: $*" >&2; exit 2 ;;
esac
MOCK

cat >"$TMP/bin/oc" <<'MOCK'
#!/usr/bin/env bash
printf 'oc %s\n' "$*" >>"$MOCK_LOG"
case "$*" in
whoami) echo kube:admin ;;
"get ingresses.config/cluster"*) echo apps.example.test ;;
"adm policy add-scc-to-user"*) : ;;
*) echo "mock oc: unhandled: $*" >&2; exit 2 ;;
esac
MOCK
# run_setup's PATH is $TMP/bin alone, where `#!/usr/bin/env bash` finds no bash: pin the mocks' interpreter.
for m in kubectl kind docker oc; do
  { printf '#!%s\n' "$REAL_BASH"; tail -n +2 "$TMP/bin/$m"; } >"$TMP/bin/$m.new"
  mv "$TMP/bin/$m.new" "$TMP/bin/$m"
done
chmod +x "$TMP/bin/kubectl" "$TMP/bin/kind" "$TMP/bin/docker" "$TMP/bin/oc"

reset_state() {
  rm -rf "$MOCK_STATE" "$REPO/deploy/k8s/.generated"
  mkdir -p "$MOCK_STATE"
  : >"$MOCK_LOG"
}
# The run's environment is whatever the caller exported (use a subshell: `(export X=1; expect_ok …)`).
run_setup() { PATH="$TMP/bin" "$REAL_BASH" "$SETUP" "$@" >"$TMP/out" 2>&1; }
expect_ok() { run_setup "$@" || fail "setup.sh $* failed"; }
expect_fail() { if run_setup "$@"; then fail "setup.sh $* succeeded; expected a refusal"; fi; }
expect_out() { grep -qF -- "$1" "$TMP/out" || fail "output lacks: $1"; }
sv() { jq -r --arg k "$3" '.data[$k] // empty' "$MOCK_STATE/$1__Secret__$2.json" | base64 --decode; }
assert_no_secret_in_argv() {
  local f k v b
  for f in "$MOCK_STATE"/*__Secret__*.json; do
    [[ -e "$f" ]] || continue
    for k in $(jq -r '.data | keys[]' "$f"); do
      [[ "$k" != redis.conf ]] || continue # multi-line; its password is checked through REDIS_PASSWORD
      v="$(jq -r --arg k "$k" '.data[$k]' "$f" | base64 --decode)"
      [[ ${#v} -ge 16 ]] || continue
      if grep -qF -- "$v" "$MOCK_LOG"; then fail "secret $k of $(basename "$f") reached a process argv"; fi
      b="$(printf '%s' "$v" | base64 | tr -d '\n')"
      [[ ${#b} -ge 16 ]] || continue
      if grep -qF -- "$b" "$MOCK_LOG"; then fail "secret $k of $(basename "$f") reached a process argv (base64)"; fi
    done
  done
}

echo "== Task 12: arguments, preflight, context pinning, images"
reset_state
expect_fail
expect_out '--target is required'
expect_fail --target prod
expect_out "unknown --target 'prod'"
touch "$TMP/c.pem" "$TMP/k.pem"
expect_fail --target kind --tls-cert "$TMP/c.pem" --tls-key "$TMP/k.pem"
expect_out 'apply to --target ocp or ocp-single only'
(export SH_SANDBOX_COUNT=abc; expect_fail --target kind)
expect_out "SH_SANDBOX_COUNT='abc'"
(export MOCK_KIND_VERSION=0.23.0; expect_fail --target kind)
expect_out 'kind v0.24.0 or newer is required'
pass 'bad arguments and an old kind are refused, naming the fix'
for flag in --target --image --sandbox-image --tls-cert --tls-key; do
  expect_fail --target ocp "$flag"
  expect_out "$flag needs a value"
done
expect_fail --target
expect_out '--target needs a value'
pass 'a value flag given no value is refused, naming the flag'
(export MOCK_KIND_VERSION_OUT='kind: something unexpected'; expect_fail --target kind)
expect_out 'could not read a version from `kind version`'
pass 'unrecognised `kind version` output is refused with a message, not a silent exit'

reset_state
(export MOCK_CURRENT_CONTEXT=prod-cluster SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind)
bad="$(grep '^kubectl ' "$MOCK_LOG" | grep -v '^kubectl --context kind-moca ' || true)"
[[ -z "$bad" ]] || fail "kubectl ran without --context kind-moca: $bad"
grep -q '^kubectl --context kind-moca apply -f ' "$MOCK_LOG" || fail 'no kubectl --context kind-moca apply -f was logged on kind'
reset_state
(export MOCK_CURRENT_CONTEXT=prod-cluster; expect_ok --target kind-ci --skip-build)
bad="$(grep '^kubectl ' "$MOCK_LOG" | grep -v '^kubectl --context kind-moca ' || true)"
[[ -z "$bad" ]] || fail "kubectl ran without --context kind-moca on kind-ci: $bad"
grep -q '^kubectl --context kind-moca apply -f ' "$MOCK_LOG" || fail 'no kubectl --context kind-moca apply -f was logged on kind-ci'
pass 'every kubectl call on kind and kind-ci is pinned to kind-moca, and the applies did run there (Review Focus 1)'
reset_state
(export MOCK_CURRENT_CONTEXT=prod-cluster SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind)
for pair in 'ghcr.io/rossoctl/moca:latest dev.local/moca:local' \
  'ghcr.io/rossoctl/moca-remote-worker:latest dev.local/moca-remote-worker:local'; do
  src="${pair% *}"
  tag="${pair#* }"
  grep -qx "docker pull $src" "$MOCK_LOG" || fail "no docker pull of $src"
  grep -qx "docker tag $src $tag" "$MOCK_LOG" || fail "no docker tag $src -> $tag"
  grep -qx "kind load docker-image $tag --name moca" "$MOCK_LOG" || fail "no kind load of $tag"
done
pass 'images are pulled, retagged and loaded into kind'

reset_state
(export MOCK_PULL_FAIL=1 SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind)
grep -qF "docker build --load -t dev.local/moca:local -f $REPO/Dockerfile $REPO" "$MOCK_LOG" || fail 'no fallback build of the harness image'
grep -qF "docker build --load -t dev.local/moca-remote-worker:local -f $REPO/remote-worker/Dockerfile $REPO" "$MOCK_LOG" || fail 'no fallback build of the sandbox image'
pass 'a failed pull falls back to building from the checkout'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
! grep -qE '^(docker (pull|build)|kind load)' "$MOCK_LOG" || fail '--skip-build still touched images'
reset_state
(export MOCK_KIND_CLUSTERS='' SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
grep -q '^kind create cluster --name moca$' "$MOCK_LOG" || fail 'a missing kind cluster was not created'
pass '--skip-build skips images; a missing cluster is created'

# A rebuilt image keeps its `:local` tag, so only a changed pod template makes the apply roll it.
applied() { cat "$MOCK_STATE/applied-kustomization.yaml"; }
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
k1="$(applied)"
grep -qF 'moca.dev/image-id: "sha256:1-moca:local"' <<<"$k1" || fail 'the harness image ID is not stamped on kind'
grep -qF 'moca.dev/image-id: "sha256:1-moca-remote-worker:local"' <<<"$k1" || fail 'the sandbox image ID is not stamped on kind'
[[ "$(grep -cF 'moca.dev/image-id: "sha256:1-moca:local"' <<<"$k1")" == 3 ]] ||
  fail 'the harness image ID must be on exactly the control plane, the supervisor and the relay'
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
[[ "$(applied)" == "$k1" ]] || fail 'an unchanged image changed the rendered overlay (it would roll every pod)'
(export SH_GITHUB_CLIENT_ID=Iv1.test MOCK_IMAGE_GEN=2; expect_ok --target kind --skip-build)
grep -qF 'moca.dev/image-id: "sha256:2-moca:local"' <<<"$(applied)" || fail 'a rebuilt harness image did not change the rendered overlay'
grep -qF 'moca.dev/image-id: "sha256:2-moca-remote-worker:local"' <<<"$(applied)" || fail 'a rebuilt sandbox image did not change the rendered overlay'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target ocp)
! grep -q 'moca.dev/image-id' <<<"$(applied)" || fail 'ocp pulls by ref and must carry no image ID'
pass 'kind stamps the loaded image IDs, so a rebuilt image rolls and an unchanged one does not; ocp carries none'

echo "== Task 13: secrets"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
relay="$(sv moca moca-relay SH_RELAY_TOKEN)"
exec_t="$(sv moca moca-relay MOCA_RELAY_EXEC_TOKEN)"
[[ "$relay" =~ ^[0-9a-f]{64}$ && "$exec_t" =~ ^[0-9a-f]{64}$ && "$relay" != "$exec_t" ]] || fail 'relay tokens are not two distinct 32-byte hex values'
sbx_secrets=("$MOCK_STATE"/moca-sandbox__Secret__*.json) # an unmatched glob stays literal: -e catches it
[[ ${#sbx_secrets[@]} == 1 && -e "${sbx_secrets[0]}" ]] || fail 'moca-sandbox must hold exactly one Secret'
[[ "$(jq -c '.data | keys' "$MOCK_STATE/moca-sandbox__Secret__moca-relay-attach.json")" == '["SH_RELAY_TOKEN"]' ]] || fail 'the attach Secret must carry SH_RELAY_TOKEN only'
[[ "$(sv moca-sandbox moca-relay-attach SH_RELAY_TOKEN)" == "$relay" ]] || fail 'the attach token differs from the relay token'
pw="$(sv moca moca-redis REDIS_PASSWORD)"
[[ "$(sv moca moca-redis REDIS_URL)" == "redis://:$pw@redis.moca.svc:6379" ]] || fail 'REDIS_URL does not carry the password'
sv moca moca-redis redis.conf | grep -qx "requirepass $pw" || fail 'redis.conf does not require the password'
[[ "$(sv moca moca-mu1 SH_EXCHANGE_TOKEN)" =~ ^[0-9a-f]{64}$ ]] || fail 'no exchange token'
[[ "$(sv moca moca-mu1 SH_SESSION_TOKEN_PUBLIC_KEYS)" =~ ^[0-9a-f]{16}: ]] || fail 'no public keyset'
[[ -n "$(sv moca moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY)" && -n "$(sv moca moca-mu1 SH_CREDENTIAL_KEK)" ]] || fail 'missing MU1 key'
pass 'a first run creates the four Secrets with the spec §4.2 keys'
assert_no_secret_in_argv
pass 'no generated secret value reached any process argv'
grep 'run moca-genkeys' "$MOCK_LOG" | grep -q '"runAsUser":65532' || fail 'the kind genkeys pod has no explicit UID'
if grep -E '^kubectl .* apply .*-f -$' "$MOCK_LOG" | grep -v -- '--server-side' | grep -q .; then fail 'a stdin apply without --server-side (it would copy values into an annotation)'; fi
del_line="$(grep -n 'delete pod moca-genkeys -n moca --ignore-not-found --wait=true' "$MOCK_LOG" | head -1 | cut -d: -f1)"
run_line="$(grep -n 'run moca-genkeys' "$MOCK_LOG" | head -1 | cut -d: -f1)"
[[ -n "$del_line" && "$del_line" -lt "$run_line" ]] || fail 'a leftover moca-genkeys pod is not deleted before the run'
grep 'run moca-genkeys' "$MOCK_LOG" | grep -q '"stdin":true,"stdinOnce":true' || fail 'the genkeys override drops the container stdin that -i attaches to'
pass 'genkeys runs as 65532 on kind; every stdin apply is server-side'
grep 'run moca-genkeys' "$MOCK_LOG" | grep -q '"command":\["sh","-c","timeout 60 cat >/dev/null; exec node --import tsx src/genkeys.ts"\]' ||
  fail 'the generator writes before the attach is up (an attach does not replay earlier output)'
pass 'a leftover genkeys pod is deleted first; the override keeps stdin for the attach'
pass 'the generator writes only once the attach has closed its stdin'

snapshot() { for f in "$MOCK_STATE"/*__Secret__*.json; do jq -cS .data "$f"; done; }
before="$(snapshot)"
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
[[ "$(snapshot)" == "$before" ]] || fail 'a re-run changed a secret'
! grep -q 'run moca-genkeys' "$MOCK_LOG" || fail 'a re-run regenerated keys it already had'
pass 'a re-run rotates nothing'

# An API error on GET (timeout, 5xx, RBAC, expired token) is not "missing": treating it as missing
# would silently rotate every value -- for SH_CREDENTIAL_KEK, every stored credential lost.
if (export MOCK_GET_FAIL=1 SH_GITHUB_CLIENT_ID=Iv1.test; run_setup --target kind --skip-build); then get_fail_rc=0; else get_fail_rc=1; fi
[[ "$(snapshot)" == "$before" ]] || fail 'a failed GET rotated a secret'
[[ "$get_fail_rc" == 1 ]] || fail 'setup.sh succeeded although every Secret GET failed'
expect_out 'etcd timeout'
pass 'a failed GET aborts the run and rotates nothing'

mu1="$MOCK_STATE/moca__Secret__moca-mu1.json"
priv="$(sv moca moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY)"
xchg="$(sv moca moca-mu1 SH_EXCHANGE_TOKEN)"
jq 'del(.data.SH_CREDENTIAL_KEK)' "$mu1" >"$mu1.tmp" && mv "$mu1.tmp" "$mu1"
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
[[ -n "$(sv moca moca-mu1 SH_CREDENTIAL_KEK)" ]] || fail 'a missing KEK was not filled'
[[ "$(sv moca moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY)" == "$priv" && "$(sv moca moca-mu1 SH_EXCHANGE_TOKEN)" == "$xchg" ]] || fail 'filling one key changed another'
assert_no_secret_in_argv
pass 'a missing key is patched in alone'

jq 'del(.data.SH_SESSION_TOKEN_PUBLIC_KEYS)' "$mu1" >"$mu1.tmp" && mv "$mu1.tmp" "$mu1"
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_fail --target kind --skip-build)
expect_out 'half a signing keypair'
pass 'half a keypair is refused, naming the fix'

reset_state
(export MOCK_GENKEYS_BAD=1 SH_GITHUB_CLIENT_ID=Iv1.test; expect_fail --target kind --skip-build)
expect_out 'produced no usable SH_CREDENTIAL_KEK'
[[ ! -f "$MOCK_STATE/moca__Secret__moca-mu1.json" ]] || fail 'a garbled generator left a partial moca-mu1'
pass 'a garbled key generator writes nothing'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target ocp)
! grep 'run moca-genkeys' "$MOCK_LOG" | grep -q runAsUser || fail 'the OCP genkeys pod pins a UID (the SCC assigns one)'
assert_no_secret_in_argv
pass 'on OCP the genkeys pod takes its UID from the SCC, and no secret reaches argv'

echo "== Task 14: settings, overlay, apply, wait"
gen() { cat "$MOCK_STATE/applied-kustomization.yaml"; }
replicas_of() { gen | grep -A2 "name: $1 }" | grep -oE 'value: [0-9]+' | grep -oE '[0-9]+'; }
setting() { jq -r --arg k "$1" '.data[$k]' "$MOCK_STATE/moca__ConfigMap__moca-settings.json"; }

reset_state
expect_ok --target kind --skip-build
[[ "$(replicas_of moca-control-plane)" == 0 ]] || fail 'no client id must render the control plane at 0 replicas'
expect_out 'no SH_GITHUB_CLIENT_ID'
grep -q "^kubectl --context kind-moca apply -k $REPO/deploy/k8s/.generated/kind\$" "$MOCK_LOG" || fail 'not applied from the generated overlay'
grep -q '^  - ../../overlays/kind$' "$MOCK_STATE/applied-kustomization.yaml" || fail 'the generated overlay does not build on overlays/kind'
[[ "$(setting SH_PUBLIC_HARNESS_URL)" == http://127.0.0.1:8080 ]] || fail 'kind advertises the wrong harness URL'
# The control plane's configMapKeyRefs are not optional, bar the two tier keys and the catalog
# allow-list: a missing key stops the pod opaquely. Those and the token lifetimes are written on
# every run too ('' when untiered, defaulted or empty, as here), so the hash input is the same fifteen
# keys on every stack (SH_TEST_USERS is '0' unless an operator asked for test users, ADR-0045).
[[ "$(jq -c '.data | keys' "$MOCK_STATE/moca__ConfigMap__moca-settings.json")" == '["SH_ADMIN_SUBJECTS","SH_ALLOW_OPERATOR_FALLBACK","SH_API_TOKEN_TTL_SECONDS","SH_GITHUB_CLIENT_ID","SH_IDENTITY_PROVIDER","SH_MODEL_CATALOG_HOSTS","SH_OIDC_CLIENT_ID","SH_OIDC_ISSUER","SH_OIDC_REDIRECT_URI","SH_OIDC_SCOPE","SH_PUBLIC_HARNESS_URL","SH_SANDBOX_DEFAULT_TIER","SH_SANDBOX_TIERS","SH_SESSION_TOKEN_TTL_SECONDS","SH_TEST_USERS"]' ]] ||
  fail 'moca-settings must hold exactly the fifteen keys the control plane and the supervisor reference'
[[ -z "$(setting SH_SANDBOX_TIERS)" && -z "$(setting SH_SANDBOX_DEFAULT_TIER)" ]] || fail 'kind is never tiered'
expect_out 'port-forward svc/moca-supervisor 8080:8080'
pass 'kind: generated overlay applied; control plane held at 0 without a client id; access printed'

# --- PR #701: the oidc settings are sticky, clearable, and validated -----------------------------
reset_state
(export SH_IDENTITY_PROVIDER=oidc SH_OIDC_ISSUER=https://id.example.invalid \
  SH_OIDC_CLIENT_ID=fake-oidc-client SH_OIDC_REDIRECT_URI=https://cp.example.invalid/v1/auth/oidc/callback \
  SH_GITHUB_CLIENT_ID=Iv1.gh; expect_ok --target ocp)
[[ "$(setting SH_IDENTITY_PROVIDER)" == oidc ]] || fail 'the oidc provider did not land in moca-settings'
[[ "$(setting SH_OIDC_ISSUER)" == https://id.example.invalid ]] || fail 'SH_OIDC_ISSUER did not land'
[[ "$(setting SH_OIDC_CLIENT_ID)" == fake-oidc-client ]] || fail 'SH_OIDC_CLIENT_ID did not land'
[[ "$(setting SH_OIDC_SCOPE)" == 'openid email profile' ]] || fail 'the default scope did not land'
pass 'oidc: settings written, scope defaulted'

# Sticky: a re-run WITHOUT reset_state and without the variables keeps the stored block, github
# id and all -- the same stickiness every other moca-settings key has.
(expect_ok --target ocp)
[[ "$(setting SH_IDENTITY_PROVIDER)" == oidc && "$(setting SH_OIDC_ISSUER)" == https://id.example.invalid ]] ||
  fail 'a re-run without the oidc variables dropped the stored block'
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.gh ]] || fail 'a re-run dropped the stored github client id'
pass 'oidc: sticky on re-run'

# Set-but-empty SH_IDENTITY_PROVIDER clears back to github and empties the block.
reset_state
(export SH_IDENTITY_PROVIDER=; expect_ok --target ocp)
[[ "$(setting SH_IDENTITY_PROVIDER)" == github ]] || fail 'set-but-empty did not clear to github'
[[ -z "$(setting SH_OIDC_ISSUER)" && -z "$(setting SH_OIDC_CLIENT_ID)" ]] ||
  fail 'clearing the provider left oidc values behind'
pass 'oidc: set-but-empty clears back to github'

# oidc without an issuer dies at setup, naming the variable.
reset_state
(export SH_IDENTITY_PROVIDER=oidc; expect_fail --target ocp)
expect_out 'SH_IDENTITY_PROVIDER=oidc needs SH_OIDC_ISSUER'
pass 'oidc: no issuer refuses at setup'

# A near-miss provider name dies too.
reset_state
(export SH_IDENTITY_PROVIDER=oidp; expect_fail --target ocp)
expect_out "must be exactly 'github' or 'oidc'"
pass 'oidc: a near-miss provider name refuses at setup'

# ADR-0045: test users. The COUNT is a sticky setting; the SECRET is generated into moca-mu1 and
# never rotated, like every other value there.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
[[ "$(setting SH_TEST_USERS)" == 0 ]] || fail 'SH_TEST_USERS defaults to 0'
[[ -z "$(sv moca moca-test-users SH_TEST_USER_SECRET)" ]] || fail 'no test users must mean no generated secret'
(export SH_GITHUB_CLIENT_ID=Iv1.test SH_TEST_USERS=10; expect_ok --target kind --skip-build)
[[ "$(setting SH_TEST_USERS)" == 10 ]] || fail 'SH_TEST_USERS was not stored'
tsec="$(sv moca moca-test-users SH_TEST_USER_SECRET)"
[[ "$tsec" =~ ^[0-9a-f]{64}$ ]] || fail "switching test users on did not generate a secret (got '$tsec')"
# Its own value, not a copy of the exchange token: generated_value reads the generator's output by
# key name, so asking it for SH_EXCHANGE_TOKEN twice would have produced the same string twice.
[[ "$tsec" != "$(sv moca moca-mu1 SH_EXCHANGE_TOKEN)" ]] || fail 'the test-user secret equals the exchange token'
expect_out 'SH_TEST_USERS=10'
assert_no_secret_in_argv
# Sticky, and not rotated by a re-run that does not mention it.
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
[[ "$(setting SH_TEST_USERS)" == 10 ]] || fail 'a plain re-run dropped SH_TEST_USERS'
[[ "$(sv moca moca-test-users SH_TEST_USER_SECRET)" == "$tsec" ]] || fail 'a re-run rotated the test-user secret'
# An operator-supplied secret is used as given, so CI can know it before the stack exists.
(export SH_GITHUB_CLIENT_ID=Iv1.test SH_TEST_USERS=3 SH_TEST_USER_SECRET=given-secret-0123456789; expect_ok --target kind --skip-build)
[[ "$(sv moca moca-test-users SH_TEST_USER_SECRET)" == given-secret-0123456789 ]] || fail 'a given SH_TEST_USER_SECRET was not used'
# Explicitly off again, and refusals.
(export SH_GITHUB_CLIENT_ID=Iv1.test SH_TEST_USERS=; expect_ok --target kind --skip-build)
[[ "$(setting SH_TEST_USERS)" == 0 ]] || fail 'SH_TEST_USERS= did not turn test users off'
(export SH_GITHUB_CLIENT_ID=Iv1.test SH_TEST_USERS=ten; expect_fail --target kind --skip-build)
expect_out 'whole number'
(export SH_GITHUB_CLIENT_ID=Iv1.test SH_TEST_USERS=1001; expect_fail --target kind --skip-build)
expect_out 'at most 1000'
pass 'SH_TEST_USERS: sticky count, a generated non-rotating secret, and refusals'

# The k8s-kind-e2e failure (#620, review): the secret lives in a Secret OF ITS OWN, written only
# while test users are on and DELETED when they go off. credentialValue treats an empty file as an
# error and only ENOENT as "unset", so an empty value anywhere on this path crash-loops the control
# plane before identity.ts runs -- and a leftover secret with test users off makes
# testUserSecretFromEnv refuse to boot ("set but SH_TEST_USERS is not").
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
[[ ! -f "$MOCK_STATE/moca__Secret__moca-test-users.json" ]] ||
  fail 'test users off must leave no moca-test-users Secret at all'
# On: the Secret appears, with a real value (never empty).
(export SH_GITHUB_CLIENT_ID=Iv1.test SH_TEST_USERS=4; expect_ok --target kind --skip-build)
tsec="$(sv moca moca-test-users SH_TEST_USER_SECRET)"
[[ "$tsec" =~ ^[0-9a-f]{64}$ ]] || fail "switching test users on did not generate a secret (got '$tsec')"
[[ "$tsec" != "$(sv moca moca-mu1 SH_EXCHANGE_TOKEN)" ]] || fail 'the test-user secret equals the exchange token'
# moca-mu1 must NOT carry it: that is what projected an empty required item and broke the pod.
! jq -e '.data | has("SH_TEST_USER_SECRET")' "$MOCK_STATE/moca__Secret__moca-mu1.json" >/dev/null ||
  fail 'the test-user secret must not live in moca-mu1 (an empty required item crash-loops the pod)'
assert_no_secret_in_argv
# Sticky, and not rotated by a plain re-run.
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
[[ "$(setting SH_TEST_USERS)" == 4 ]] || fail 'a plain re-run dropped SH_TEST_USERS'
[[ "$(sv moca moca-test-users SH_TEST_USER_SECRET)" == "$tsec" ]] || fail 'a re-run rotated the test-user secret'
# OFF again: the Secret must be DELETED, not emptied -- else the next boot refuses with
# "SH_TEST_USER_SECRET is set but SH_TEST_USERS is not".
(export SH_GITHUB_CLIENT_ID=Iv1.test SH_TEST_USERS=; expect_ok --target kind --skip-build)
[[ "$(setting SH_TEST_USERS)" == 0 ]] || fail 'SH_TEST_USERS= did not turn test users off'
[[ ! -f "$MOCK_STATE/moca__Secret__moca-test-users.json" ]] ||
  fail 'turning test users off left the secret behind (the control plane would refuse to boot)'
pass 'the test-user secret is its own Secret: written when on, deleted when off, never in moca-mu1'

# --target ocp is the shared-cluster target, so test users there need an explicit acknowledgement.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test SH_TEST_USERS=2; expect_fail --target ocp)
expect_out 'dev/test feature and this is the shared-cluster target'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test SH_TEST_USERS=2 SH_TEST_USERS_ACK=i-know-this-is-not-for-production; expect_ok --target ocp)
[[ "$(setting SH_TEST_USERS)" == 2 ]] || fail 'the acknowledged ocp run did not store SH_TEST_USERS'
pass 'test users on --target ocp need SH_TEST_USERS_ACK'

# The settings-hash must cover the test-user SECRET, not just the count: otherwise changing the
# secret rewrites the Secret while the running control plane keeps the old value, and --test-user
# logins fail against a secret the operator just set.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test SH_TEST_USERS=2 SH_TEST_USER_SECRET=first-secret-0123456789; expect_ok --target kind --skip-build)
h1="$(grep -o 'settings-hash: "[0-9a-f]*"' "$MOCK_STATE/applied-kustomization.yaml" | head -1)"
[[ -n "$h1" ]] || fail 'could not read the settings-hash from the generated overlay'
(export SH_GITHUB_CLIENT_ID=Iv1.test SH_TEST_USERS=2 SH_TEST_USER_SECRET=second-secret-0123456789; expect_ok --target kind --skip-build)
h2="$(grep -o 'settings-hash: "[0-9a-f]*"' "$MOCK_STATE/applied-kustomization.yaml" | head -1)"
[[ "$h1" != "$h2" ]] || fail 'changing SH_TEST_USER_SECRET with the same count did not change the settings-hash (the pod would keep the old value)'
# ...and the digest is a digest: the secret itself must never reach the overlay or the ConfigMap.
! grep -q 'second-secret-0123456789' "$MOCK_STATE/applied-kustomization.yaml" || fail 'the test-user secret leaked into the generated overlay'
! grep -q 'second-secret-0123456789' "$MOCK_STATE/moca__ConfigMap__moca-settings.json" || fail 'the test-user secret leaked into moca-settings'
pass 'the settings-hash covers the test-user secret, by digest, without leaking it'


reset_state
(export SH_PUBLIC_HARNESS_URL=http://127.0.0.1:18080; expect_ok --target kind --skip-build)
[[ "$(setting SH_PUBLIC_HARNESS_URL)" == http://127.0.0.1:18080 ]] ||
  fail 'kind: SH_PUBLIC_HARNESS_URL did not override the derived URL'
expect_out 'port-forward svc/moca-supervisor 18080:8080'
# Sticky: a plain re-run without the variable keeps the stored URL (the whole point of the fix).
expect_ok --target kind --skip-build
[[ "$(setting SH_PUBLIC_HARNESS_URL)" == http://127.0.0.1:18080 ]] ||
  fail 'kind: a plain re-run reverted the stored URL to the default'
expect_out 'port-forward svc/moca-supervisor 18080:8080'
# Set-but-empty clears back to the default.
(export SH_PUBLIC_HARNESS_URL=; expect_ok --target kind --skip-build)
[[ "$(setting SH_PUBLIC_HARNESS_URL)" == http://127.0.0.1:8080 ]] ||
  fail 'kind: SH_PUBLIC_HARNESS_URL= did not clear the stored override'
pass 'kind: SH_PUBLIC_HARNESS_URL is sticky; a re-run keeps it, set-but-empty clears it'

reset_state
for bad in not-a-url https://127.0.0.1:8080 http://127.0.0.1 http://127.0.0.1:8080/path; do
  (export SH_PUBLIC_HARNESS_URL="$bad"; expect_fail --target kind --skip-build)
  expect_out 'must be http://HOST:PORT'
done
pass 'kind: non-URL, https, missing port, and path all refused up front'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_PUBLIC_HARNESS_URL=http://127.0.0.1:18080; expect_ok --target ocp-single)
[[ "$(jq -r '.data.SH_PUBLIC_HARNESS_URL' "$MOCK_STATE/moca-single__ConfigMap__moca-settings.json")" == http://127.0.0.1:18080 ]] ||
  fail 'ocp-single without Routes: SH_PUBLIC_HARNESS_URL did not reach the ConfigMap'
expect_out 'port-forward svc/moca-supervisor 18080:8080'
pass 'ocp-single without Routes: SH_PUBLIC_HARNESS_URL overrides, and the printed port-forward matches'

reset_state
# A preinstalled TLS Secret, as the ocp-single-with-Routes tests below also stage.
jq -nc '{apiVersion: "v1", kind: "Secret", metadata: {name: "op-cert", namespace: "moca-single"},
  type: "kubernetes.io/tls", data: {"tls.crt": "Y3J0", "tls.key": "a2V5"}}' >"$MOCK_STATE/moca-single__Secret__op-cert.json"
# Given this run alongside SH_ROUTE_DOMAIN -- refused once load_setup_inputs resolves the domain.
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=example.test SH_PUBLIC_HARNESS_URL=http://127.0.0.1:18080;
  expect_fail --target ocp-single --tls-secret op-cert)
expect_out 'meaningless when Routes are on'
# Stored SH_ROUTE_DOMAIN -- seed moca-setup directly so a failing seeder would not confuse the
# diagnostic -- no env override, same refusal.
jq -nc '{apiVersion: "v1", kind: "ConfigMap", metadata: {name: "moca-setup", namespace: "moca-single"},
  data: {SH_ROUTE_DOMAIN: "example.test"}}' >"$MOCK_STATE/moca-single__ConfigMap__moca-setup.json"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_PUBLIC_HARNESS_URL=http://127.0.0.1:18080;
  expect_fail --target ocp-single)
expect_out 'meaningless when Routes are on'
pass 'ocp-single with Routes: SH_PUBLIC_HARNESS_URL is refused, given or stored SH_ROUTE_DOMAIN'

# hash_of DEPLOYMENT: every settings hash the generated overlay stamps on DEPLOYMENT's pod template,
# one per line (nothing when there is none). A Deployment may have several patch entries (ocp-single
# adds an env patch for the supervisor), so every entry targeting it is read.
hash_of() {
  gen | awk -v t="kind: Deployment, name: $1 }" '/^  - target: /{ on = index($0, t) > 0; next } /^[^ ]/{ on = 0 } on' |
    { grep -oE 'moca.dev/settings-hash: "[0-9a-f]{64}"' || true; } | grep -oE '[0-9a-f]{64}' || true
}
# settings_hash: THE settings hash of the generated overlay. Both Deployments that read moca-settings
# (the control plane and the supervisor) carry it exactly once, and the two agree -- read per target,
# so a patch that stamped one but not the other, or two different values, cannot hide behind a match.
settings_hash() {
  local cp sup
  cp="$(hash_of moca-control-plane)"
  sup="$(hash_of moca-supervisor)"
  [[ -n "$cp" && "$cp" != *$'\n'* ]] || fail "the control plane's pod template must carry exactly one settings hash, got '$cp'"
  [[ -n "$sup" && "$sup" != *$'\n'* ]] || fail "the supervisor's pod template must carry exactly one settings hash, got '$sup'"
  [[ "$sup" == "$cp" ]] || fail "the supervisor's settings hash ($sup) differs from the control plane's ($cp)"
  printf '%s' "$cp"
}
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
[[ "$(replicas_of moca-control-plane)" == 1 ]] || fail 'a client id must render the control plane at 1 replica'
h1="$(settings_hash)"
[[ -n "$h1" ]] || fail 'the generated overlay carries no settings hash'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
[[ "$(settings_hash)" == "$h1" ]] || fail 'an unchanged re-run changed the settings hash (it would roll the control plane for nothing)'
(export SH_GITHUB_CLIENT_ID=Iv1.b; expect_ok --target kind --skip-build)
h2="$(settings_hash)"
[[ -n "$h2" && "$h2" != "$h1" ]] || fail 'a changed client id did not change the settings hash'
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.b ]] || fail 'the new client id was not written'
pass 'the settings hash is stable for unchanged settings and changes with them (Review Focus 2)'

# The retry case: a run that wrote client id B and then failed before the roll. Nothing is
# remembered between runs, so the next run renders B's hash and the apply still rolls the pods.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
[[ "$(settings_hash)" == "$h1" ]] || fail 'the settings hash depends on more than the settings'
(export SH_GITHUB_CLIENT_ID=Iv1.b MOCK_APPLY_K_FAIL=1; expect_fail --target kind --skip-build)
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.b ]] || fail 'the failed run did not get as far as writing the new settings'
[[ "$(settings_hash)" == "$h1" ]] || fail 'the failed apply still recorded an applied kustomization'
(export SH_GITHUB_CLIENT_ID=Iv1.b; expect_ok --target kind --skip-build)
[[ "$(settings_hash)" == "$h2" ]] || fail 'after a failed run, the re-run did not roll the control plane onto the new settings'
! grep -q 'rollout restart' "$MOCK_LOG" || fail 'the control plane is rolled by the hash; nothing may rollout restart it'
pass 'a settings change survives a failed run: the re-run applies the new hash'

if [[ -x "$TMP/bin/sha256sum" && -x "$TMP/bin/shasum" ]]; then
  mv "$TMP/bin/sha256sum" "$TMP/bin/sha256sum.off"
  (export SH_GITHUB_CLIENT_ID=Iv1.b; expect_ok --target kind --skip-build)
  mv "$TMP/bin/sha256sum.off" "$TMP/bin/sha256sum"
  [[ "$(settings_hash)" == "$h2" ]] || fail 'shasum and sha256sum disagree on the settings hash'
  grep -q '^shasum -a 256' "$MOCK_LOG" || fail 'without sha256sum, shasum was not used'
  pass 'without sha256sum the hash comes from shasum -a 256, and is the same'
fi

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=3 MOCK_RECORDS=3; expect_ok --target kind --skip-build)
[[ "$(replicas_of moca-sandbox)" == 3 ]] || fail 'SH_SANDBOX_COUNT=3 did not set 3 replicas'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=3 MOCK_RECORDS=2; expect_fail --target kind --skip-build)
expect_out 'only 2 of 3 sandboxes attached'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0; expect_ok --target kind --skip-build)
[[ "$(replicas_of moca-sandbox)" == 0 ]] || fail 'SH_SANDBOX_COUNT=0 did not set 0 replicas'
! grep -q 'exec redis-0' "$MOCK_LOG" || fail 'SH_SANDBOX_COUNT=0 still waited for presence records'
pass 'SH_SANDBOX_COUNT drives replicas and the presence wait; 0 skips it (Review Focus 3)'

reset_state
expect_ok --target kind-ci --skip-build
grep -qF -- "--from-file=mock-anthropic.mjs=$REPO/deploy/microvm/mock-anthropic.mjs" "$MOCK_LOG" || fail 'kind-ci did not load the mock model ConfigMap'
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.k8s-smoke-unused ]] || fail 'kind-ci needs the placeholder client id'
[[ "$(replicas_of moca-control-plane)" == 1 ]] || fail 'kind-ci must run the control plane'
pass 'kind-ci: mock model ConfigMap, placeholder client id, control plane on'

# #429: kind and kind-ci share one cluster, hence one moca-settings. The placeholder above is
# therefore the one setting that must NOT be sticky -- a kind re-run that inherited it would come up
# at 1 replica with an id nobody can log in with, and no warning. No reset_state between the runs:
# the leftover store IS the bug. The suite's top-level unset does not cover SH_GITHUB_CLIENT_ID.
ci_h="$(settings_hash)"
(unset SH_GITHUB_CLIENT_ID; expect_ok --target kind --skip-build)
[[ "$(setting SH_GITHUB_CLIENT_ID)" != Iv1.k8s-smoke-unused ]] || fail 'kind inherited the kind-ci placeholder client id (#429)'
[[ "$(replicas_of moca-control-plane)" == 0 ]] || fail 'kind ran the control plane on the kind-ci placeholder id (#429)'
expect_out 'no SH_GITHUB_CLIENT_ID'
# The other half: the filter must not cost kind-ci its convergence. It re-derives the same string,
# so a second kind-ci run still hashes identically and rolls no pod (README §"re-run ... converges").
expect_ok --target kind-ci --skip-build
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.k8s-smoke-unused ]] || fail 'the kind-ci placeholder was not re-derived after a kind run cleared it'
[[ "$(settings_hash)" == "$ci_h" ]] || fail 'a kind-ci re-run changed the settings hash (it would roll the control plane for nothing)'
pass 'the kind-ci placeholder does not leak into kind, and kind-ci still converges on it (#429)'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
[[ "$(grep -c '^oc adm policy add-scc-to-user nonroot-v2' "$MOCK_LOG")" == 5 ]] || fail 'expected 5 SCC grants'
last_scc="$(grep -n '^oc adm policy' "$MOCK_LOG" | tail -1 | cut -d: -f1)"
apply_at="$(grep -n 'apply -k' "$MOCK_LOG" | cut -d: -f1)"
[[ "$last_scc" -lt "$apply_at" ]] || fail 'SCC grants must precede the apply'
gen | grep -q 'value: moca-moca.apps.example.test' || fail 'the supervisor Route host was not set'
gen | grep -q 'value: moca-control-plane-moca.apps.example.test' || fail 'the control plane Route host was not set'
[[ "$(setting SH_PUBLIC_HARNESS_URL)" == https://moca-moca.apps.example.test ]] || fail 'OCP advertises the wrong harness URL'
grep -q '^openssl req -x509' "$MOCK_LOG" || fail 'no self-signed certificate without --tls-cert'
[[ -f "$REPO/deploy/k8s/.generated/ocp/moca-supervisor-ca.crt" ]] || fail 'the self-signed CA file is missing'
expect_out 'NODE_EXTRA_CA_CERTS='
pass 'ocp: SCC before apply, Route hosts, https harness URL, self-signed cert with the trust line'

: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
! grep -q 'create secret tls' "$MOCK_LOG" || fail 'an existing TLS Secret was replaced without --tls-cert'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp --tls-cert "$TMP/c.pem" --tls-key "$TMP/k.pem" --image ghcr.io/me/moca:v1 --sandbox-image quay.io/me/rw@sha256:abc)
grep -qF -- "--cert=$TMP/c.pem" "$MOCK_LOG" || fail '--tls-cert was not installed'
gen | grep -q 'newName: ghcr.io/me/moca$' && gen | grep -q 'newTag: v1$' || fail '--image was not rendered'
gen | grep -q 'digest: sha256:abc$' || fail '--sandbox-image digest was not rendered'
assert_no_secret_in_argv
pass 'ocp: an existing cert is kept; --tls-cert replaces it; --image/--sandbox-image render'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_NO_DEFAULT_SC=1; expect_ok --target kind --skip-build)
expect_out 'no default StorageClass'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
! grep -q 'no default StorageClass' "$TMP/out" || fail 'warned about a default StorageClass that exists'
pass 'a cluster with no default StorageClass gets a warning before Redis waits on its PVC (spec §10)'

# An API error is never "missing" (same class as Task 13): an unreadable TLS Secret must not be
# replaced by a self-signed one.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
[[ -f "$MOCK_STATE/moca__Secret__moca-supervisor-tls.json" ]] || fail 'the first OCP run wrote no TLS Secret'
: >"$MOCK_LOG"
# MOCK_GET_FAIL=1 only proves the earlier abort in ensure_secrets; the MOCK_GET_FAIL=moca-supervisor-tls case below is the real ensure_tls test.
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_GET_FAIL=1; expect_fail --target ocp)
! grep -q 'create secret tls' "$MOCK_LOG" || fail 'a failed GET replaced the TLS Secret'
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_GET_FAIL=moca-supervisor-tls; expect_fail --target ocp)
expect_out 'etcd timeout'
! grep -q 'create secret tls' "$MOCK_LOG" || fail 'a failed GET of moca-supervisor-tls alone replaced it with a self-signed one'
pass 'ocp: a failed GET of the TLS Secret aborts the run and keeps the operator certificate'

# A failed openssl or apply must not leave the self-signed private key behind.
reset_state
mkdir -p "$TMP/tmpdir"
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_MKTEMP_DIR="$TMP/tmpdir" MOCK_TLS_CREATE_FAIL=1; expect_fail --target ocp)
[[ -z "$(ls -A "$TMP/tmpdir")" ]] || fail "a failed TLS apply left the self-signed key behind: $(ls -A "$TMP/tmpdir")"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_MKTEMP_DIR="$TMP/tmpdir"; expect_ok --target ocp)
[[ -z "$(ls -A "$TMP/tmpdir")" ]] || fail 'a successful run left the self-signed key behind'
pass 'ocp: the self-signed private key is removed whether the TLS install succeeds or fails'

echo "== sticky inputs: a re-run keeps every input it is not given"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ADMIN_SUBJECTS=github:alice SH_ALLOW_OPERATOR_FALLBACK=true; expect_ok --target kind --skip-build)
h1="$(settings_hash)"
(unset SH_GITHUB_CLIENT_ID SH_ADMIN_SUBJECTS SH_ALLOW_OPERATOR_FALLBACK; expect_ok --target kind --skip-build)
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.a ]] || fail 'a re-run without SH_GITHUB_CLIENT_ID dropped the client id'
[[ "$(setting SH_ADMIN_SUBJECTS)" == github:alice ]] || fail 'a re-run without SH_ADMIN_SUBJECTS dropped the admins'
[[ "$(setting SH_ALLOW_OPERATOR_FALLBACK)" == true ]] || fail 'a re-run without SH_ALLOW_OPERATOR_FALLBACK reset it'
[[ "$(replicas_of moca-control-plane)" == 1 ]] || fail 'a re-run without SH_GITHUB_CLIENT_ID scaled the control plane to 0'
! grep -q 'no SH_GITHUB_CLIENT_ID' "$TMP/out" || fail 'a re-run with a stored client id still warned that there is none'
[[ "$(settings_hash)" == "$h1" ]] || fail 'a re-run with no inputs changed the settings hash (it would roll the control plane)'
grep -q 'rollout status deployment/moca-control-plane' "$MOCK_LOG" || fail 'the re-run did not wait for the control plane it keeps running'
pass 'settings are sticky: a re-run without them keeps the client id, admins, fallback, replicas and hash'
(export SH_ADMIN_SUBJECTS=; expect_ok --target kind --skip-build)
[[ -z "$(setting SH_ADMIN_SUBJECTS)" ]] || fail 'SH_ADMIN_SUBJECTS= (explicitly empty) did not clear the admins'
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.a ]] || fail 'clearing the admins touched the client id'
(export SH_GITHUB_CLIENT_ID=; expect_ok --target kind --skip-build)
[[ -z "$(setting SH_GITHUB_CLIENT_ID)" && "$(replicas_of moca-control-plane)" == 0 ]] || fail 'SH_GITHUB_CLIENT_ID= did not clear the client id'
pass 'an explicitly empty variable clears its setting'
(export MOCK_GET_CM_FAIL=moca-settings SH_ADMIN_SUBJECTS=github:bob; expect_fail --target kind --skip-build)
expect_out 'etcd timeout'
[[ -z "$(setting SH_ADMIN_SUBJECTS)" ]] || fail 'a failed moca-settings read still wrote the settings'
(export MOCK_GET_CM_FAIL=moca-setup; expect_fail --target kind --skip-build)
expect_out 'etcd timeout'
pass 'a failed read of moca-settings or moca-setup aborts the run instead of resetting the inputs'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=3 MOCK_RECORDS=3; expect_ok --target kind --skip-build)
(export MOCK_RECORDS=3; expect_ok --target kind --skip-build)
[[ "$(replicas_of moca-sandbox)" == 3 ]] || fail 'a re-run without SH_SANDBOX_COUNT reset the sandbox count'
[[ "$(jq -r '.data.SH_SANDBOX_COUNT' "$MOCK_STATE/moca__ConfigMap__moca-setup.json")" == 3 ]] || fail 'moca-setup does not hold the sandbox count'
(export SH_SANDBOX_COUNT=1 MOCK_RECORDS=1; expect_ok --target kind --skip-build)
[[ "$(replicas_of moca-sandbox)" == 1 ]] || fail 'a given SH_SANDBOX_COUNT did not replace the stored one'
pass 'SH_SANDBOX_COUNT is sticky, and a given value replaces it'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp --image ghcr.io/me/moca:v1 --sandbox-image quay.io/me/rw@sha256:abc)
: >"$MOCK_LOG"
(unset SH_GITHUB_CLIENT_ID; expect_ok --target ocp)
gen | grep -q 'newName: ghcr.io/me/moca$' && gen | grep -q 'newTag: v1$' || fail 'an OCP re-run without --image rolled the harness image back'
gen | grep -q 'digest: sha256:abc$' || fail 'an OCP re-run without --sandbox-image rolled the sandbox image back'
[[ "$(replicas_of moca-control-plane)" == 1 ]] || fail 'an OCP re-run without SH_GITHUB_CLIENT_ID scaled the control plane to 0'
(expect_ok --target ocp --image ghcr.io/me/moca:v2)
gen | grep -q 'newTag: v2$' || fail 'a given --image did not replace the stored one'
gen | grep -q 'digest: sha256:abc$' || fail 'a given --image dropped the stored --sandbox-image'
pass 'ocp: --image and --sandbox-image are sticky; a given one replaces only itself'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build --image ghcr.io/me/moca:v1)
! gen | grep -q 'images:' || fail 'kind rendered an images: override (it runs the locally loaded images)'
pass 'kind: images are for the local load only, never the overlay'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_GET_SC_FAIL=1; expect_ok --target kind --skip-build)
expect_out 'could not list StorageClasses'
! grep -q 'no default StorageClass' "$TMP/out" || fail 'an unreadable StorageClass list was reported as no default'
pass 'an unreadable StorageClass list is reported as such, and the advisory check does not abort'

echo "== P6.2 Task 5: P4 inputs"
p4_stored() { jq -r '.data.SH_P4_SANDBOX_IDS // empty' "$MOCK_STATE/moca__ConfigMap__moca-setup.json"; }

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=' moca_microvm_0 , moca_microvm_1,'; expect_ok --target ocp)
[[ "$(p4_stored)" == moca_microvm_0,moca_microvm_1 ]] || fail "spaces and a trailing comma were not normalised: '$(p4_stored)'"
pass 'SH_P4_SANDBOX_IDS: spaces trimmed, empty entries dropped, stored comma-joined (Review Focus 1)'

(unset SH_P4_SANDBOX_IDS; export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
[[ "$(p4_stored)" == moca_microvm_0,moca_microvm_1 ]] || fail 'a re-run without SH_P4_SANDBOX_IDS dropped the stored IDs'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=; expect_ok --target ocp)
[[ -z "$(p4_stored)" ]] || fail 'SH_P4_SANDBOX_IDS= (explicitly empty) did not clear the IDs'
pass 'SH_P4_SANDBOX_IDS is sticky, and an explicitly empty value clears it'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=moca-microvm-0; expect_fail --target ocp)
expect_out "'moca-microvm-0' must match"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=a,b,a; expect_fail --target ocp)
expect_out "lists 'a' twice"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS='*'; expect_fail --target ocp)
expect_out "'*' must match"
# The relay refuses the ID DIR before any lookup (spec §2.1): such a host could never attach.
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=moca_microvm_0,DIR; expect_fail --target ocp)
expect_out "'DIR' is reserved"
expect_out 'SH_RELAY_TOKEN_DIR'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=a; expect_fail --target kind --skip-build)
expect_out 'needs --target ocp'
! grep -q '^kubectl' "$MOCK_LOG" || fail 'a refused ID list still reached the cluster'
pass 'refused: an ID with a dash, a duplicate, glob char, the reserved DIR, P4 IDs on kind -- before anything touches a cluster'

# The live switch from a slice-1 stack: moca-setup already holds SH_SANDBOX_COUNT=2. Slice 2 refused
# P4 IDs here (one tier per stack); P6.3 tiers the stack instead (slice-3 spec §7).
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=moca_microvm_0; expect_ok --target ocp)
[[ "$(setting SH_SANDBOX_TIERS)" == container,microvm ]] || fail "the stored count of 2 plus a P4 ID did not tier the stack: '$(setting SH_SANDBOX_TIERS)'"
[[ "$(setting SH_SANDBOX_DEFAULT_TIER)" == container ]] || fail "a mixed stack's default tier is not container: '$(setting SH_SANDBOX_DEFAULT_TIER)'"
[[ "$(p4_stored)" == moca_microvm_0 ]] || fail 'the switch to a mixed stack did not store the ID'
[[ "$(replicas_of moca-sandbox)" == 2 ]] || fail 'the switch to a mixed stack dropped the container sandboxes'
expect_out 'two sandbox tiers'
pass 'the stored count of 2 plus P4 IDs is a tiered stack (container,microvm; default container), not a refusal'

reset_state
expect_fail --target kind --relay-tls-cert "$TMP/c.pem" --relay-tls-key "$TMP/k.pem"
expect_out 'apply to --target ocp only'
expect_fail --target ocp --relay-tls-cert "$TMP/c.pem"
expect_out 'go together'
expect_fail --target ocp --relay-tls-cert
expect_out '--relay-tls-cert needs a value'
expect_ok --help
expect_out 'SH_P4_SANDBOX_IDS'
expect_out '--relay-tls-cert FILE --relay-tls-key FILE'
pass '--relay-tls-cert/--relay-tls-key: ocp only, a pair, a value each; --help lists them'

# Bash 3.2 compatibility: normalize_p4_ids must work on bash < 4.4 with set -u
# The bug: unset empty array with "set -u" causes "parts[@]: unbound variable".
# Tests the exact call paths: empty input, all-comma input, mixed spaces/commas, and real parse_args path.
if [[ -x /bin/bash ]]; then
  bash3_version="$(/bin/bash --version 2>&1 | head -1)"
  if [[ "$bash3_version" == *"version 3."* ]]; then
    test_output=$(/bin/bash -euo pipefail -c "
      SH_SOURCE_ONLY=1
      . '$SETUP'
      # Test each problematic input path under bash 3.2 with set -u
      normalize_p4_ids '' || exit 1
      normalize_p4_ids ',' || exit 1
      normalize_p4_ids ' , ' || exit 1
      result=\$(normalize_p4_ids 'a,b')
      [[ \"\$result\" == 'a b' ]] || exit 1
      unset SH_P4_SANDBOX_IDS SH_SANDBOX_DEFAULT_TIER
      parse_args --target kind || exit 1
      [[ -z \"\$DEFAULT_TIER_GIVEN\" ]] || exit 1
      SH_SANDBOX_DEFAULT_TIER= parse_args --target kind || exit 1
      [[ -n \"\$DEFAULT_TIER_GIVEN\" ]] || exit 1
      SH_SANDBOX_COUNT=2 P4_IDS=a STORED_DEFAULT_TIER=''
      derive_tiers 2>/dev/null
      [[ \"\$TIERS,\$DEFAULT_TIER\" == 'container,microvm,container' ]] || exit 1
      echo 'all tests passed'
    " 2>&1)
    [[ "$test_output" == *"all tests passed"* ]] || fail "the bash 3.2 checks failed with set -u: $test_output"
    pass "normalize_p4_ids, parse_args (SH_SANDBOX_DEFAULT_TIER unset and empty) and derive_tiers work on bash 3.2 with set -u"
  else
    echo "skip - bash 3.2 not available (version is: $bash3_version)"
  fi
else
  echo "skip - bash 3.2 not available at /bin/bash"
fi

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=$'a,b\nc,d'; expect_fail --target ocp)
expect_out 'must be one line'
pass 'multiline SH_P4_SANDBOX_IDS is refused'

echo "== P6.2 Task 6: P4 tokens, relay certificate, bundles"
P4B="$REPO/deploy/k8s/.generated/ocp/p4"
RCA="$REPO/deploy/k8s/.generated/ocp/moca-relay-ca.crt"
p4_ok() { (export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS="$1"; shift; expect_ok --target ocp "$@"); }
tok() { sv moca moca-relay-sandbox-tokens "$1"; }
tok_keys() { jq -r '.data // {} | keys | join(",")' "$MOCK_STATE/moca__Secret__moca-relay-sandbox-tokens.json"; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

reset_state
p4_ok moca_microvm_0,moca_microvm_1
[[ "$(tok_keys)" == moca_microvm_0,moca_microvm_1 ]] || fail "expected one token key per ID, got '$(tok_keys)'"
[[ "$(tok moca_microvm_0)" =~ ^[0-9a-f]{64}$ && "$(tok moca_microvm_1)" =~ ^[0-9a-f]{64}$ ]] || fail 'a P4 token is not 64 hex'
[[ "$(tok moca_microvm_0)" != "$(tok moca_microvm_1)" ]] || fail 'two P4 IDs share a token'
[[ "$(tok moca_microvm_0)" != "$(sv moca moca-relay MOCA_RELAY_EXEC_TOKEN)" ]] || fail 'a P4 token equals the exec token'
[[ ! -e "$MOCK_STATE/moca-sandbox__Secret__moca-relay-sandbox-tokens.json" ]] || fail 'P4 tokens reached moca-sandbox'
assert_no_secret_in_argv
pass 'one 64-hex token per P4 ID in moca-relay-sandbox-tokens, distinct, never the exec token, never in moca-sandbox'

t0="$(tok moca_microvm_0)"
p4_ok moca_microvm_0,moca_microvm_1
[[ "$(tok moca_microvm_0)" == "$t0" ]] || fail 'a re-run rotated a P4 token'
: >"$MOCK_LOG"
p4_ok moca_microvm_0
[[ "$(tok_keys)" == moca_microvm_0 ]] || fail "the dropped ID's token was not revoked: '$(tok_keys)'"
[[ "$(tok moca_microvm_0)" == "$t0" ]] || fail 'revoking one ID rotated another'
grep -q '^kubectl patch secret moca-relay-sandbox-tokens' "$MOCK_LOG" || fail 'revocation did not patch the Secret'
[[ ! -e "$P4B/moca_microvm_1" ]] || fail "the dropped ID's bundle was kept"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=; expect_ok --target ocp)
[[ -z "$(tok_keys)" ]] || fail "clearing the IDs left tokens: '$(tok_keys)'"
[[ ! -e "$P4B/moca_microvm_0" ]] || fail 'clearing the IDs left a bundle'
pass 'tokens are kept on a re-run; a dropped ID loses its token and bundle; clearing the list empties the Secret'

# Revocation uses an idempotent merge patch: the patch succeeds even when the stale key is already
# absent (e.g., the API server pruned it during server-side apply). When MOCK_SSA_PRUNE=1, the
# mock simulates server-side apply pruning keys it no longer applies, so the stale key is gone
# before the patch runs.
p4_ok moca_microvm_0,moca_microvm_1
t_mv0="$(tok moca_microvm_0)"
# Now run with only moca_microvm_0, with API server pruning enabled. The apply will remove
# moca_microvm_1 from the Secret, making it truly absent before revocation tries to patch it.
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=moca_microvm_0 MOCK_SSA_PRUNE=1; expect_ok --target ocp)
# Revocation should have tried to patch and succeeded despite moca_microvm_1 already being absent.
grep -q '^kubectl patch secret moca-relay-sandbox-tokens' "$MOCK_LOG" || fail 'revocation patch was not called'
[[ "$(tok moca_microvm_0)" == "$t_mv0" ]] || fail 'moca_microvm_0 token was rotated'
[[ "$(tok_keys)" == moca_microvm_0 ]] || fail 'moca_microvm_1 token was not revoked or another key remained'
[[ ! -e "$P4B/moca_microvm_1" ]] || fail "moca_microvm_1 bundle was not deleted"
pass 'revocation is idempotent: the merge patch succeeds when the stale key is absent (server-side apply pruned it)'

# A stored token equal to the exec token (the relay would refuse it, spec §2.2) is regenerated.
reset_state
p4_ok moca_microvm_0
exec_b64="$(jq -r '.data.MOCA_RELAY_EXEC_TOKEN' "$MOCK_STATE/moca__Secret__moca-relay.json")"
jq --arg v "$exec_b64" '.data.moca_microvm_0 = $v' "$MOCK_STATE/moca__Secret__moca-relay-sandbox-tokens.json" >"$TMP/t.json"
mv "$TMP/t.json" "$MOCK_STATE/moca__Secret__moca-relay-sandbox-tokens.json"
p4_ok moca_microvm_0
[[ "$(tok moca_microvm_0)" != "$(sv moca moca-relay MOCA_RELAY_EXEC_TOKEN)" ]] || fail 'a P4 token equal to the exec token was kept'
pass 'a P4 token equal to the exec token is regenerated'

t0="$(tok moca_microvm_0)"
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=moca_microvm_0 MOCK_GET_FAIL=moca-relay-sandbox-tokens; expect_fail --target ocp)
expect_out 'etcd timeout'
[[ "$(tok moca_microvm_0)" == "$t0" ]] || fail 'a failed GET of the token Secret rotated a token'
pass 'a failed GET of moca-relay-sandbox-tokens aborts the run and rotates nothing'

reset_state
p4_ok moca_microvm_0
grep -q '^openssl req -x509 .*CN=moca-relay-moca.apps.example.test' "$MOCK_LOG" || fail 'no self-signed relay certificate for the relay Route host'
[[ -f "$MOCK_STATE/moca__Secret__moca-relay-tls.json" ]] || fail 'no moca-relay-tls Secret'
[[ -s "$RCA" ]] || fail 'the relay CA file is missing'
: >"$MOCK_LOG"
p4_ok moca_microvm_0
! grep -q 'create secret tls moca-relay-tls' "$MOCK_LOG" || fail 'an existing relay certificate was replaced'
[[ -s "$RCA" ]] || fail 'a re-run lost the relay CA file'
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=moca_microvm_0 MOCK_GET_FAIL=moca-relay-tls; expect_fail --target ocp)
expect_out 'etcd timeout'
! grep -q 'create secret tls moca-relay-tls' "$MOCK_LOG" || fail 'a failed GET of moca-relay-tls replaced it with a self-signed one'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
[[ ! -e "$MOCK_STATE/moca__Secret__moca-relay-tls.json" ]] || fail 'a stack with no P4 IDs got a relay certificate'
pass 'relay certificate: self-signed for the Route host once, kept, fail-closed on GET, absent with no P4 IDs'

# The bundle (spec §4.5) is what setup-microvm.sh --remote installs (Task 8).
reset_state
p4_ok moca_microvm_0
b="$P4B/moca_microvm_0"
printf 'RELAY_ADDR=moca-relay-moca.apps.example.test:443\nRELAY_TLS=true\nSANDBOX_ID=moca_microvm_0\nSANDBOX_TOKEN=%s\n' "$(tok moca_microvm_0)" >"$TMP/want.env"
cmp -s "$b/worker.env" "$TMP/want.env" || fail "worker.env is wrong: $(cat "$b/worker.env")"
cmp -s "$b/relay-ca.crt" "$RCA" || fail 'the bundle does not carry the self-signed relay CA'
[[ "$(mode_of "$P4B")" == 700 && "$(mode_of "$b")" == 700 ]] || fail 'bundle directories are not 0700'
[[ "$(mode_of "$b/worker.env")" == 600 && "$(mode_of "$b/relay-ca.crt")" == 600 ]] || fail 'bundle files are not 0600'
assert_no_secret_in_argv
pass 'bundle: worker.env with the Route host, TLS, ID and token; the relay CA; 0700/0600; the token never on argv'

# An operator certificate: a leaf signed by a CA (so not self-issued). The bundle carries no CA.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=test-ca -keyout "$TMP/ca.key" -out "$TMP/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj /CN=moca-relay-moca.apps.example.test -keyout "$TMP/leaf.key" -out "$TMP/leaf.csr" 2>/dev/null
openssl x509 -req -in "$TMP/leaf.csr" -CA "$TMP/ca.crt" -CAkey "$TMP/ca.key" -CAcreateserial -days 2 -out "$TMP/leaf.crt" 2>/dev/null
reset_state
p4_ok moca_microvm_0 --relay-tls-cert "$TMP/leaf.crt" --relay-tls-key "$TMP/leaf.key"
grep -qF -- "--cert=$TMP/leaf.crt" "$MOCK_LOG" || fail '--relay-tls-cert was not installed'
[[ ! -e "$RCA" && ! -e "$P4B/moca_microvm_0/relay-ca.crt" ]] || fail 'an operator certificate still produced a relay CA file'
pass 'an operator relay certificate is installed, and the bundle carries no CA (the host trusts its issuer)'

echo "== P6.2 Task 7: rendering and printing"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
! gen | grep -q 'p4-relay\|moca-relay' || fail 'a stack with no P4 IDs rendered the p4-relay component'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=moca_microvm_0; expect_ok --target ocp)
gen | grep -qx '  - ../../overlays/ocp/p4-relay' || fail 'the p4-relay component is not listed'
gen | grep -q 'name: moca-relay }' || fail 'the relay Route is not patched'
gen | grep -q 'value: moca-relay-moca.apps.example.test' || fail 'the relay Route host is wrong'
expect_out "$REPO/deploy/k8s/.generated/ocp/p4/moca_microvm_0"
# scp -r into an existing target nests the copy, so an earlier copy is removed first, then copied.
expect_out 'ssh <kvm-host> rm -r moca-p4-moca_microvm_0   (an earlier copy, if any: scp -r would nest into it)'
expect_out "scp -r $REPO/deploy/k8s/.generated/ocp/p4/moca_microvm_0 <kvm-host>:moca-p4-moca_microvm_0"
[[ "$(grep -n 'rm -r moca-p4-moca_microvm_0' "$TMP/out" | cut -d: -f1)" -lt "$(grep -n '^ *scp -r ' "$TMP/out" | cut -d: -f1)" ]] ||
  fail 'the earlier copy is not removed before the scp'
expect_out 'sudo deploy/microvm/setup-microvm.sh --remote ~/moca-p4-moca_microvm_0'
pass 'P4 IDs render the p4-relay component and the relay Route host, and print each host command; none render nothing'

echo "== ocp-single: single-namespace, no-SCC target"
reset_state
expect_fail --target prod-single
expect_out 'kind, kind-ci, ocp or ocp-single'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_fail --target ocp-single --tls-cert "$TMP/c.pem" --tls-key "$TMP/k.pem")
expect_out 'need SH_ROUTE_DOMAIN'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_fail --target kind --tls-secret some-secret)
expect_out 'applies to --target ocp-single only'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_fail --target ocp-single --tls-secret some-secret)
expect_out 'need SH_ROUTE_DOMAIN'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=moca_microvm_0; expect_fail --target ocp-single)
expect_out 'needs --target ocp'
pass 'ocp-single: unknown targets, TLS flags (without a domain) and P4 IDs are refused, naming the fix'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp-single)
# No oc was needed (oc would be mocked, but preflight must not even require it: the PATH holds the
# mocks, so assert on the absence of oc's whoami in the argv log instead).
grep -q '^oc whoami' "$MOCK_LOG" && fail 'ocp-single ran oc, which the target must not need'
# No SCC grant: the whole run never calls oc adm.
grep -q 'oc adm' "$MOCK_LOG" && fail 'ocp-single granted an SCC, which the target must not do'
# The namespace existence check ran, against the default moca-single.
grep -q 'kubectl get namespace moca-single' "$MOCK_LOG" || fail 'the namespace existence check did not run'
# The generated overlay sets the namespace transformer and rewrites the env strings off the
# placeholder only when the namespace is custom; the default keeps the overlay's own strings.
gen | grep -qx 'namespace: moca-single' || fail 'the generated overlay does not set the namespace transformer'
! grep -q 'SH_RELAY_ADDR' "$MOCK_STATE/applied-kustomization.yaml" ||
  fail 'the default namespace rewrote env strings that the overlay already carries'
pass 'ocp-single: needs no oc and no SCC, checks the namespace exists, sets the namespace transformer'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SINGLE_NAMESPACE=moca-tenant-1; expect_ok --target ocp-single)
gen | grep -qx 'namespace: moca-tenant-1' || fail 'a custom SH_SINGLE_NAMESPACE did not reach the generated overlay'
gen | grep -q 'sandbox-relay-exec.moca-tenant-1.svc:9444' || fail 'the supervisor env string was not rewritten'
gen | grep -q 'moca-control-plane.moca-tenant-1.svc:8080' || fail 'the control plane URL was not rewritten'
gen | grep -q 'sandbox-relay-attach.moca-tenant-1.svc:9443' || fail 'the sandbox env string was not rewritten'
jq -e -r '.data.SH_SINGLE_NAMESPACE' "$MOCK_STATE/moca-tenant-1__ConfigMap__moca-setup.json" >/dev/null 2>&1 ||
  fail 'moca-setup does not record SH_SINGLE_NAMESPACE for the smoke to read'
grep -q 'kubectl get namespace moca-tenant-1' "$MOCK_LOG" || fail 'the custom namespace existence check did not run'
expect_out 'namespace moca-tenant-1'
pass 'ocp-single: SH_SINGLE_NAMESPACE drives the transformer, the env strings and moca-setup'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SINGLE_NAMESPACE=Bad_NS; expect_fail --target ocp-single)
expect_out 'is not a namespace name'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SINGLE_NAMESPACE=moca; expect_fail --target ocp-single)
expect_out 'collides with the base'
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_NO_NAMESPACE=moca-single; expect_fail --target ocp-single)
expect_out 'cannot create it'
pass 'ocp-single: an invalid, a colliding and a missing namespace are refused, naming the fix'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp-single)
expect_out 'kubectl -n moca-single port-forward svc/moca-supervisor'
! grep -q 'https://' "$TMP/out" || fail 'ocp-single printed an https URL; it has no Routes'
pass 'ocp-single: access is printed as port-forward commands, never a Route URL'

echo "== ocp-single: optional Routes (SH_ROUTE_DOMAIN, README §12.5)"
reset_state
# A preinstalled kubernetes.io/tls Secret, as an operator's wildcard certificate would be.
jq -nc '{apiVersion: "v1", kind: "Secret", metadata: {name: "op-cert", namespace: "moca-single"},
  type: "kubernetes.io/tls", data: {"tls.crt": "Y3J0", "tls.key": "a2V5"}}' >"$MOCK_STATE/moca-single__Secret__op-cert.json"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=example.test; expect_ok --target ocp-single --tls-secret op-cert)
# The component and both hosts reach the generated overlay, and the volume follows --tls-secret.
gen | grep -qx 'components:' || fail 'no components: block with SH_ROUTE_DOMAIN'
gen | grep -q 'ocp-single/routes' || fail 'the routes component is not listed'
gen | grep -q 'value: moca.example.test' || fail 'the supervisor Route host was not set'
gen | grep -q 'value: moca-control-plane.example.test' || fail 'the control plane Route host was not set'
gen | grep -q 'secretName: op-cert' || fail '--tls-secret did not reach the sidecar volume'
# The preinstalled Secret was checked, never copied or generated.
grep -q 'kubectl get secret op-cert' "$MOCK_LOG" || fail 'the --tls-secret Secret was never checked'
[[ ! -e "$MOCK_STATE/moca-single__Secret__moca-supervisor-tls.json" ]] || fail '--tls-secret still wrote a moca-supervisor-tls Secret'
# The run never called oc: Routes render with kubectl only, like the rest of the target.
grep -q '^oc ' "$MOCK_LOG" && fail 'ocp-single with Routes ran oc'
# The settings follow: the public URL is the supervisor Route, and moca-setup records both inputs.
grep -q 'https://moca.example.test' "$MOCK_STATE/moca-single__ConfigMap__moca-settings.json" ||
  fail 'SH_PUBLIC_HARNESS_URL is not the supervisor Route URL'
jq -e -r '.data.SH_ROUTE_DOMAIN' "$MOCK_STATE/moca-single__ConfigMap__moca-setup.json" >/dev/null 2>&1 ||
  fail 'moca-setup does not record SH_ROUTE_DOMAIN'
jq -e -r '.data.SH_TLS_SECRET' "$MOCK_STATE/moca-single__ConfigMap__moca-setup.json" >/dev/null 2>&1 ||
  fail 'moca-setup does not record SH_TLS_SECRET'
expect_out 'https://moca-control-plane.example.test'
expect_out 'mocactl --control-plane-url https://moca-control-plane.example.test'
pass 'ocp-single: SH_ROUTE_DOMAIN renders the component, the hosts and the Route access text'

# Sticky: a re-run without SH_ROUTE_DOMAIN keeps the Routes and the Secret; empty turns both off.
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp-single)
gen | grep -q 'value: moca.example.test' || fail 'a re-run without SH_ROUTE_DOMAIN dropped the Routes'
jq -e -r '.data.SH_TLS_SECRET' "$MOCK_STATE/moca-single__ConfigMap__moca-setup.json" >/dev/null 2>&1 ||
  fail 'a re-run without --tls-secret dropped the recorded Secret name'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=; expect_ok --target ocp-single)
! gen | grep -q 'ocp-single/routes' || fail 'SH_ROUTE_DOMAIN= left the component rendered'
jq -e 'has("SH_ROUTE_DOMAIN") or .data.SH_ROUTE_DOMAIN' "$MOCK_STATE/moca-single__ConfigMap__moca-setup.json" >/dev/null 2>&1 ||
  pass 'SH_ROUTE_DOMAIN= cleared the recorded domain'
expect_out 'kubectl -n moca-single port-forward'
# The Routes-on run stored the Route URL in moca-settings; the Routes-off re-run must not reuse it.
# Discovery would otherwise advertise a dead Route host and the printed port extraction would miss.
[[ "$(jq -r '.data.SH_PUBLIC_HARNESS_URL' "$MOCK_STATE/moca-single__ConfigMap__moca-settings.json")" == http://127.0.0.1:8080 ]] ||
  fail 'ocp-single Routes-off transition reused the stored https Route URL for SH_PUBLIC_HARNESS_URL'
pass 'ocp-single: SH_ROUTE_DOMAIN and --tls-secret are sticky; empty turns Routes off (and resets the harness URL)'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=Example.Test; expect_fail --target ocp-single)
expect_out 'is not a DNS name'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=no_dots; expect_fail --target ocp-single)
expect_out 'is not a DNS name'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=example.test; expect_fail --target kind)
expect_out 'needs --target ocp-single'
pass 'ocp-single: an invalid domain is refused before anything touches a cluster'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=example.test; expect_ok --target ocp-single)
# No --tls-secret and no --tls-cert: a self-signed moca-supervisor-tls is generated, and the run
# says so (the NODE_EXTRA_CA_CERTS line), as --target ocp does.
[[ -n "$(sv moca-single moca-supervisor-tls tls.crt)" ]] || fail 'no self-signed supervisor certificate was generated'
expect_out 'SELF-SIGNED'
expect_out 'NODE_EXTRA_CA_CERTS'
# The default volume name needs no patch: only --tls-secret writes one (checked above).
! gen | grep -q 'secretName:' || fail 'the self-signed path wrote a volume patch; only --tls-secret should'
pass 'ocp-single: without --tls-secret or --tls-cert a self-signed certificate is generated and said'

# --tls-secret names a Secret that does not exist, or exists but is not kubernetes.io/tls: both
# abort BEFORE moca-setup is applied, so a mistyped name is never recorded (a re-run cannot inherit
# the mistake) and never silently falls back to a self-signed one.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=example.test; expect_fail --target ocp-single --tls-secret missing-cert)
expect_out 'does not exist'
[[ ! -e "$MOCK_STATE/moca-single__Secret__moca-supervisor-tls.json" ]] || fail 'a refused --tls-secret still generated a certificate'
if [[ -e "$MOCK_STATE/moca-single__ConfigMap__moca-setup.json" ]] &&
  jq -e 'has("SH_TLS_SECRET")' "$MOCK_STATE/moca-single__ConfigMap__moca-setup.json" >/dev/null 2>&1; then
  fail 'a refused --tls-secret was recorded in moca-setup'
fi
jq -nc '{apiVersion: "v1", kind: "Secret", metadata: {name: "opaque", namespace: "moca-single"}, type: "Opaque", data: {}}' \
  >"$MOCK_STATE/moca-single__Secret__opaque.json"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=example.test; expect_fail --target ocp-single --tls-secret opaque)
expect_out 'not a kubernetes.io/tls Secret'
pass 'ocp-single: a missing or mistyped --tls-secret aborts, recording and generating nothing'

# The three certificate inputs are mutually exclusive, and the saved one never silently beats a
# given pair: --tls-cert on a re-run replaces the saved source, and drops it from moca-setup.
reset_state
jq -nc '{apiVersion: "v1", kind: "Secret", metadata: {name: "op-cert", namespace: "moca-single"},
  type: "kubernetes.io/tls", data: {"tls.crt": "Y3J0", "tls.key": "a2V5"}}' >"$MOCK_STATE/moca-single__Secret__op-cert.json"
touch "$TMP/c.pem" "$TMP/k.pem"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=example.test
  expect_fail --target ocp-single --tls-secret op-cert --tls-cert "$TMP/c.pem" --tls-key "$TMP/k.pem")
expect_out 'two certificate sources; pass one'
pass 'ocp-single: --tls-secret and --tls-cert together are refused, naming the conflict'

# A sticky-domain re-run (SH_ROUTE_DOMAIN unset) can swap in --tls-cert: the domain comes from
# moca-setup, the pair replaces the saved Secret, and moca-setup no longer records the name.
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=example.test; expect_ok --target ocp-single --tls-secret op-cert)
jq -e -r '.data.SH_TLS_SECRET' "$MOCK_STATE/moca-single__ConfigMap__moca-setup.json" >/dev/null ||
  fail 'the setup with --tls-secret did not record it'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp-single --tls-cert "$TMP/c.pem" --tls-key "$TMP/k.pem")
gen | grep -q 'value: moca.example.test' || fail 'the sticky domain was lost on the --tls-cert re-run'
grep -qF -- "--cert=$TMP/c.pem" "$MOCK_LOG" || fail 'the --tls-cert pair was not installed'
grep -q 'kubectl create secret tls moca-supervisor-tls' "$MOCK_LOG" || fail 'the pair did not install into moca-supervisor-tls'
jq -e 'has("SH_TLS_SECRET")' "$MOCK_STATE/moca-single__ConfigMap__moca-setup.json" >/dev/null 2>&1 &&
  fail 'the saved SH_TLS_SECRET survived a --tls-cert re-run'
gen | grep -q 'secretName: op-cert' && fail 'the saved --tls-secret still drives the sidecar volume'
pass 'ocp-single: --tls-cert replaces the saved --tls-secret (volume, ConfigMap key), sticky domain intact'

echo "== P6.3 Task 16: sandbox tiers on a mixed stack; a sticky default tier"
setup_cm() { cat "$MOCK_STATE/${1:-moca}__ConfigMap__moca-setup.json"; }
dtier_stored() { setup_cm "${1:-moca}" | jq -r '.data.SH_SANDBOX_DEFAULT_TIER // empty'; }
# annotation_adds DEPLOYMENT: how many patch ops of the generated overlay add DEPLOYMENT's pod
# template annotations. More than one and the second "add" replaces the first's map.
annotation_adds() {
  gen | awk -v t="kind: Deployment, name: $1 }" '/^  - target: /{ on = index($0, t) > 0; next } /^[^ ]/{ on = 0 } on' |
    grep -c 'path: /spec/template/metadata/annotations' || true
}
untiered() { [[ -z "$(setting SH_SANDBOX_TIERS)" && -z "$(setting SH_SANDBOX_DEFAULT_TIER)" ]]; }

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
untiered || fail "a containers-only stack was tiered: '$(setting SH_SANDBOX_TIERS)' / '$(setting SH_SANDBOX_DEFAULT_TIER)'"
! grep -q 'two sandbox tiers' "$TMP/out" || fail 'a containers-only stack logged two tiers'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=moca_microvm_0; expect_ok --target ocp)
untiered || fail "a P4-only stack was tiered: '$(setting SH_SANDBOX_TIERS)' / '$(setting SH_SANDBOX_DEFAULT_TIER)'"
pass 'a single-tier stack (containers only, or P4 only) stays untiered: both settings are empty'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=2 SH_P4_SANDBOX_IDS=moca_microvm_0; expect_ok --target ocp)
[[ "$(setting SH_SANDBOX_TIERS)" == container,microvm && "$(setting SH_SANDBOX_DEFAULT_TIER)" == container ]] ||
  fail 'a mixed stack is not tiered container,microvm with default container'
[[ "$(annotation_adds moca-control-plane)" == 1 && "$(annotation_adds moca-supervisor)" == 1 ]] ||
  fail 'ocp: each Deployment that reads moca-settings needs exactly one pod-template annotations add'
h_c="$(settings_hash)"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_DEFAULT_TIER=microvm; expect_ok --target ocp)
[[ "$(setting SH_SANDBOX_DEFAULT_TIER)" == microvm ]] || fail 'SH_SANDBOX_DEFAULT_TIER=microvm was not written'
[[ "$(dtier_stored)" == microvm ]] || fail 'moca-setup does not hold the default tier'
h_m="$(settings_hash)"
[[ "$h_m" != "$h_c" ]] || fail 'a changed default tier did not change the settings hash (neither Deployment would roll)'
expect_out 'default microvm'
pass 'a mixed stack is tiered; SH_SANDBOX_DEFAULT_TIER picks the default, and a change rolls both Deployments'

(unset SH_SANDBOX_DEFAULT_TIER; export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
[[ "$(setting SH_SANDBOX_DEFAULT_TIER)" == microvm ]] || fail 'a re-run without SH_SANDBOX_DEFAULT_TIER dropped the stored default'
[[ "$(settings_hash)" == "$h_m" ]] || fail 'a re-run with the same default changed the settings hash'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=; expect_ok --target ocp)
untiered || fail 'clearing the P4 IDs left the stack tiered'
[[ "$(dtier_stored)" == microvm ]] || fail 'a single-tier run dropped the stored default (it is kept, unused)'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=moca_microvm_0; expect_ok --target ocp)
[[ "$(setting SH_SANDBOX_DEFAULT_TIER)" == microvm ]] || fail 'the stored default was not used when the stack became mixed again'
pass 'SH_SANDBOX_DEFAULT_TIER is sticky, and kept (unused) while the stack has one tier'

(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_DEFAULT_TIER=; expect_ok --target ocp)
[[ -z "$(dtier_stored)" ]] || fail 'SH_SANDBOX_DEFAULT_TIER= (explicitly empty) did not clear the stored default'
[[ "$(setting SH_SANDBOX_DEFAULT_TIER)" == container ]] || fail 'a cleared default did not fall back to container'
(unset SH_SANDBOX_DEFAULT_TIER; export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
[[ "$(setting SH_SANDBOX_DEFAULT_TIER)" == container ]] || fail 'the run after a clear did not write container'
pass 'an explicitly empty SH_SANDBOX_DEFAULT_TIER clears it; the default is container again'

before_setup="$(setup_cm)"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_DEFAULT_TIER=gpu SH_SANDBOX_COUNT=3; expect_fail --target ocp)
expect_out "SH_SANDBOX_DEFAULT_TIER='gpu' must be container or microvm"
[[ "$(setup_cm)" == "$before_setup" ]] || fail 'a refused default tier still rewrote moca-setup'
[[ "$(setting SH_SANDBOX_DEFAULT_TIER)" == container ]] || fail 'a refused default tier still rewrote moca-settings'
jq '.data.SH_SANDBOX_DEFAULT_TIER = "gpu"' "$MOCK_STATE/moca__ConfigMap__moca-setup.json" >"$TMP/cm.json"
mv "$TMP/cm.json" "$MOCK_STATE/moca__ConfigMap__moca-setup.json"
before_setup="$(setup_cm)"
(unset SH_SANDBOX_DEFAULT_TIER; export SH_GITHUB_CLIENT_ID=Iv1.a; expect_fail --target ocp)
# A stored value names where it came from, and how to clear it, as the stored count's refusal does.
expect_out "ConfigMap moca-setup holds SH_SANDBOX_DEFAULT_TIER='gpu', which must be container or microvm: re-run with SH_SANDBOX_DEFAULT_TIER set to one of them, or set but empty (SH_SANDBOX_DEFAULT_TIER=) to clear it"
[[ "$(setup_cm)" == "$before_setup" ]] || fail 'a refused stored default tier still rewrote moca-setup'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_DEFAULT_TIER=; expect_ok --target ocp)
[[ -z "$(dtier_stored)" ]] || fail "SH_SANDBOX_DEFAULT_TIER= did not clear a bad stored default: '$(dtier_stored)'"
pass 'a default tier other than container or microvm, given or stored, is refused and stores nothing; a stored one names moca-setup and SH_SANDBOX_DEFAULT_TIER= clears it'

# Kind is never tiered and stores no default tier, but a bad GIVEN value is still a typo to
# refuse -- before anything touches the cluster, as on the other targets (M3).
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_DEFAULT_TIER=gpu; expect_fail --target kind --skip-build)
expect_out "SH_SANDBOX_DEFAULT_TIER='gpu' must be container or microvm"
! grep -q '^kubectl' "$MOCK_LOG" || fail 'a refused SH_SANDBOX_DEFAULT_TIER on kind still reached the cluster'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_DEFAULT_TIER=microvm; expect_ok --target kind --skip-build)
[[ -z "$(dtier_stored)" ]] || fail "kind stored a default tier: '$(dtier_stored)'"
untiered || fail 'kind was tiered'
pass 'kind: a bad SH_SANDBOX_DEFAULT_TIER is refused before the cluster is touched; a good one is stored nowhere'

# SH_SANDBOX_COUNT=00 is zero container sandboxes: a P4-only stack, untiered (d). Compared as a
# string it was "not 0", and the stack was tiered with no container sandbox for the default tier.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=00 SH_P4_SANDBOX_IDS=moca_microvm_0; expect_ok --target ocp)
untiered || fail "SH_SANDBOX_COUNT=00 with a P4 ID was tiered: '$(setting SH_SANDBOX_TIERS)' / '$(setting SH_SANDBOX_DEFAULT_TIER)'"
[[ "$(setup_cm | jq -r '.data.SH_SANDBOX_COUNT')" == 0 ]] || fail "SH_SANDBOX_COUNT=00 was not stored as 0: '$(setup_cm | jq -r '.data.SH_SANDBOX_COUNT')'"
[[ "$(replicas_of moca-sandbox)" == 0 ]] || fail "SH_SANDBOX_COUNT=00 did not scale moca-sandbox to 0: '$(replicas_of moca-sandbox)'"
expect_out 'SH_SANDBOX_COUNT=0: no container sandboxes to wait for'
pass 'SH_SANDBOX_COUNT=00 with P4 IDs is a P4-only stack: untiered, stored and applied as 0'

# $((10#...)) overflows silently on a long count (it can come out negative: "not 0", so tiered, and
# negative replicas). At most 4 digits, given or stored.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=99999999999999999999; expect_fail --target ocp)
expect_out "SH_SANDBOX_COUNT='99999999999999999999' must be a whole number of at most 4 digits"
! grep -q '^kubectl' "$MOCK_LOG" || fail 'a 20-digit SH_SANDBOX_COUNT still reached the cluster'
[[ -z "$(setup_cm 2>/dev/null)" ]] || fail 'a 20-digit SH_SANDBOX_COUNT stored something'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0001 MOCK_RECORDS=1; expect_ok --target ocp)
[[ "$(replicas_of moca-sandbox)" == 1 ]] || fail "a 4-digit SH_SANDBOX_COUNT=0001 was not 1: '$(replicas_of moca-sandbox)'"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
jq '.data.SH_SANDBOX_COUNT = "99999999999999999999"' "$MOCK_STATE/moca__ConfigMap__moca-setup.json" >"$TMP/cm.json"
mv "$TMP/cm.json" "$MOCK_STATE/moca__ConfigMap__moca-setup.json"
before_setup="$(setup_cm)"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_fail --target ocp)
expect_out "moca-setup holds SH_SANDBOX_COUNT='99999999999999999999': re-run with SH_SANDBOX_COUNT set to a whole number of at most 4 digits"
[[ "$(setup_cm)" == "$before_setup" ]] || fail 'a refused stored SH_SANDBOX_COUNT still rewrote moca-setup'
pass 'SH_SANDBOX_COUNT is at most 4 digits, given (refused before the cluster, nothing stored) or stored (refused, moca-setup unchanged)'

# ocp-single runs no P4 hosts (SH_P4_SANDBOX_IDS needs --target ocp), so it is never tiered; the
# sticky default is still stored there, unused. Its supervisor already has an env patch entry when
# the namespace is custom: the settings-hash entry is a second one, and the two must not collide.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SINGLE_NAMESPACE=moca-tenant-1 SH_SANDBOX_DEFAULT_TIER=microvm; expect_ok --target ocp-single)
[[ "$(dtier_stored moca-tenant-1)" == microvm ]] || fail 'ocp-single did not store the sticky default tier'
[[ -z "$(jq -r '.data.SH_SANDBOX_TIERS' "$MOCK_STATE/moca-tenant-1__ConfigMap__moca-settings.json")" ]] || fail 'ocp-single was tiered'
[[ "$(annotation_adds moca-control-plane)" == 1 && "$(annotation_adds moca-supervisor)" == 1 ]] ||
  fail 'ocp-single: each Deployment that reads moca-settings needs exactly one pod-template annotations add'
gen | grep -q 'sandbox-relay-exec.moca-tenant-1.svc:9444' || fail "the supervisor's env patch was lost beside its settings-hash patch"
settings_hash >/dev/null
pass 'ocp-single: never tiered, the default is stored; one annotations add per Deployment beside the env patches'

# Both ocp-single features at once: Routes (with --tls-secret, which adds a second moca-supervisor
# patch entry and the routes component's sidecar patch) and the sticky default tier. moca-setup
# holds both sides' sticky keys, and each Deployment still gets exactly one annotations add.
reset_state
jq -nc '{apiVersion: "v1", kind: "Secret", metadata: {name: "op-cert", namespace: "moca-single"},
  type: "kubernetes.io/tls", data: {"tls.crt": "Y3J0", "tls.key": "a2V5"}}' >"$MOCK_STATE/moca-single__Secret__op-cert.json"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=example.test SH_SANDBOX_DEFAULT_TIER=microvm
  expect_ok --target ocp-single --tls-secret op-cert)
for k in SH_SINGLE_NAMESPACE SH_ROUTE_DOMAIN SH_TLS_SECRET SH_SANDBOX_DEFAULT_TIER SH_SANDBOX_COUNT; do
  setup_cm moca-single | jq -e --arg k "$k" '.data | has($k)' >/dev/null || fail "ocp-single with Routes: moca-setup lacks $k"
done
[[ "$(jq -r '.data | keys | length' "$MOCK_STATE/moca-single__ConfigMap__moca-settings.json")" == 15 ]] ||
  fail 'ocp-single with Routes: moca-settings does not hold exactly fifteen keys'
[[ "$(jq -r '.data.SH_PUBLIC_HARNESS_URL' "$MOCK_STATE/moca-single__ConfigMap__moca-settings.json")" == https://moca.example.test ]] ||
  fail 'ocp-single with Routes: SH_PUBLIC_HARNESS_URL is not the supervisor Route'
[[ "$(annotation_adds moca-control-plane)" == 1 && "$(annotation_adds moca-supervisor)" == 1 ]] ||
  fail 'ocp-single with Routes: each Deployment that reads moca-settings needs exactly one pod-template annotations add'
gen | grep -q 'secretName: op-cert' || fail '--tls-secret was lost beside the settings-hash patch'
(unset SH_SANDBOX_DEFAULT_TIER SH_ROUTE_DOMAIN; export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp-single)
[[ "$(dtier_stored moca-single)" == microvm ]] || fail 'a Routes re-run dropped the sticky default tier'
gen | grep -q 'value: moca.example.test' || fail 'a default-tier re-run dropped the sticky Routes'
pass 'ocp-single: Routes, --tls-secret and the sticky default tier coexist; one annotations add per Deployment'

echo "== SH_SANDBOX_EGRESS_EXCEPT: extra sandbox egress exceptions (#446)"
egress_stored() { setup_cm "${1:-moca}" | jq -r '.data.SH_SANDBOX_EGRESS_EXCEPT // empty'; }
egress_adds() { gen | grep -c 'path: /spec/egress/1/to/0/ipBlock/except/-' || true; }
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind)
! gen | grep -q 'name: NetworkPolicy\|kind: NetworkPolicy' || fail 'no SH_SANDBOX_EGRESS_EXCEPT still patched the sandbox policy'
[[ -z "$(egress_stored)" ]] || fail 'no SH_SANDBOX_EGRESS_EXCEPT still recorded one'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_EGRESS_EXCEPT=' 203.0.113.0/24, 198.51.100.7/32,,'; expect_ok --target kind)
gen | grep -qF -- '- target: { kind: NetworkPolicy, name: moca-sandbox }' || fail 'SH_SANDBOX_EGRESS_EXCEPT did not patch the sandbox policy'
gen | grep -qF -- '- { op: test, path: /spec/egress/1/to/0/ipBlock/cidr, value: 0.0.0.0/0 }' || fail 'the egress patch lacks its test op'
gen | grep -qF 'value: 203.0.113.0/24 }' && gen | grep -qF 'value: 198.51.100.7/32 }' || fail 'the egress patch lacks a range'
[[ "$(egress_adds)" == 2 ]] || fail 'the egress patch does not add exactly the two ranges'
[[ "$(egress_stored)" == 203.0.113.0/24,198.51.100.7/32 ]] || fail "moca-setup holds '$(egress_stored)', not the normalised ranges"
pass 'kind: SH_SANDBOX_EGRESS_EXCEPT is normalised, rendered as a guarded patch and recorded'

# Sticky: a re-run without it keeps the ranges; set-but-empty clears them.
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind)
[[ "$(egress_adds)" == 2 ]] || fail 'a re-run without SH_SANDBOX_EGRESS_EXCEPT dropped the ranges'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_EGRESS_EXCEPT=; expect_ok --target kind)
[[ "$(egress_adds)" == 0 && -z "$(egress_stored)" ]] || fail 'SH_SANDBOX_EGRESS_EXCEPT= did not clear the ranges'
pass 'SH_SANDBOX_EGRESS_EXCEPT is sticky; empty clears it'

# Refused before anything touches a cluster: nothing is applied, nothing recorded.
for bad in 203.0.113.1/24 0.0.0.0/0 203.0.113.0 256.0.0.0/8 010.1.0.0/16 2001:db8::/32 10.0.0.0/8 203.0.113.0/24,203.0.113.0/24; do
  reset_state
  (export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_EGRESS_EXCEPT="$bad"; expect_fail --target kind)
  expect_out 'SH_SANDBOX_EGRESS_EXCEPT'
  ! grep -q '^kubectl .*apply' "$MOCK_LOG" || fail "SH_SANDBOX_EGRESS_EXCEPT='$bad' reached kubectl apply"
done
# A bad stored value names where it came from and refuses the run.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind)
jq '.data.SH_SANDBOX_EGRESS_EXCEPT = "203.0.113.1/24"' "$MOCK_STATE/moca__ConfigMap__moca-setup.json" >"$TMP/cm" &&
  mv "$TMP/cm" "$MOCK_STATE/moca__ConfigMap__moca-setup.json"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_fail --target kind)
expect_out 'host bits set'
pass 'SH_SANDBOX_EGRESS_EXCEPT: malformed, overlapping-built-in and duplicate ranges are refused, given or stored'

# ocp-single under a custom namespace: the policy patch sits under patches:, before namespace:.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SINGLE_NAMESPACE=moca-tenant-1 SH_SANDBOX_EGRESS_EXCEPT=203.0.113.0/24
  expect_ok --target ocp-single)
[[ "$(egress_adds)" == 1 ]] || fail 'ocp-single: SH_SANDBOX_EGRESS_EXCEPT did not patch the sandbox policy'
[[ "$(egress_stored moca-tenant-1)" == 203.0.113.0/24 ]] || fail 'ocp-single did not record SH_SANDBOX_EGRESS_EXCEPT'
pass 'ocp-single: SH_SANDBOX_EGRESS_EXCEPT is rendered and recorded in its namespace'

echo "== #432: the combined trust file, the trust line on every run, settable token lifetimes"
# pem_count FILE: the certificates FILE PARSES to -- not its BEGIN lines, which still count two
# PEMs glued onto one line (END----------BEGIN), a file OpenSSL and Node reject whole.
pem_count() {
  openssl crl2pkcs7 -nocrl -certfile "$1" 2>/dev/null | openssl pkcs7 -print_certs -noout 2>/dev/null |
    grep -c '^subject=' || true
}
GEN_OCP="$REPO/deploy/k8s/.generated/ocp"
# The cluster's ingress CA, as openshift-config-managed/default-ingress-cert holds it.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=ingress-operator@test' \
  -keyout "$TMP/ingress.key" -out "$TMP/ingress.crt" 2>/dev/null
seed_ingress_ca() {
  jq -n --rawfile c "$TMP/ingress.crt" '{apiVersion: "v1", kind: "ConfigMap",
    metadata: {name: "default-ingress-cert", namespace: "openshift-config-managed"}, data: {"ca-bundle.crt": $c}}' \
    >"$MOCK_STATE/openshift-config-managed__ConfigMap__default-ingress-cert.json"
}
reset_state
seed_ingress_ca
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
[[ "$(pem_count "$GEN_OCP/moca-ca.crt")" == 2 ]] || fail 'moca-ca.crt must hold the supervisor certificate and the ingress CA'
grep -qF "$(sed -n 2p "$TMP/ingress.crt")" "$GEN_OCP/moca-ca.crt" || fail 'moca-ca.crt lacks the ingress CA'
grep -qF "$(sed -n 2p "$GEN_OCP/moca-supervisor-ca.crt")" "$GEN_OCP/moca-ca.crt" || fail 'moca-ca.crt lacks the supervisor certificate'
! grep -q 'END CERTIFICATE-----.' "$GEN_OCP/moca-ca.crt" || fail 'moca-ca.crt glues a PEM onto an END line'
expect_out "export NODE_EXTRA_CA_CERTS=$GEN_OCP/moca-ca.crt"
pass 'ocp: moca-ca.crt holds the self-signed supervisor certificate and the ingress CA, and the run names it'

: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
! grep -q 'create secret tls' "$MOCK_LOG" || fail 'a re-run replaced the TLS Secret'
expect_out "export NODE_EXTRA_CA_CERTS=$GEN_OCP/moca-ca.crt"
expect_out 'SELF-SIGNED'
# A second checkout: no local CA file, the Secret is the only record of the certificate.
sup_crt="$(sv moca moca-supervisor-tls tls.crt)"
rm -rf "$GEN_OCP"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
# Byte for byte, final newline included: $(cat ...) would strip it, and a file without one glues
# the next PEM onto its END line in moca-ca.crt.
printf '%s\n' "$sup_crt" | cmp -s - "$GEN_OCP/moca-supervisor-ca.crt" || fail 'the CA file is not the Secret tls.crt, newline-terminated'
[[ "$(pem_count "$GEN_OCP/moca-ca.crt")" == 2 ]] || fail 'a second checkout did not rebuild moca-ca.crt'
expect_out "export NODE_EXTRA_CA_CERTS=$GEN_OCP/moca-ca.crt"
pass 'ocp: the trust line is printed on every run, and a second checkout rebuilds the files from the Secret'

# An operator certificate that chains to an issuer: nothing of the supervisor's needs trusting, so
# only the ingress CA is in the file, and the line says so.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=test-ca' -keyout "$TMP/ca.key" -out "$TMP/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=moca-moca.apps.example.test' -keyout "$TMP/leaf.key" -out "$TMP/leaf.csr" 2>/dev/null
openssl x509 -req -in "$TMP/leaf.csr" -CA "$TMP/ca.crt" -CAkey "$TMP/ca.key" -CAcreateserial -days 1 -out "$TMP/leaf.crt" 2>/dev/null
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp --tls-cert "$TMP/leaf.crt" --tls-key "$TMP/leaf.key")
[[ ! -e "$GEN_OCP/moca-supervisor-ca.crt" ]] || fail 'an issued operator certificate left a supervisor CA file'
[[ "$(pem_count "$GEN_OCP/moca-ca.crt")" == 1 ]] || fail 'with an issued operator certificate moca-ca.crt must hold the ingress CA alone'
! grep -q 'SELF-SIGNED' "$TMP/out" || fail 'an issued operator certificate was called self-signed'
expect_out "ingress certificate"
expect_out "export NODE_EXTRA_CA_CERTS=$GEN_OCP/moca-ca.crt"
pass 'ocp: with an issued --tls-cert, moca-ca.crt is the ingress CA alone and nothing is called self-signed'

# A tls.crt that does not parse is said, not silently treated as an issued certificate.
jq '.data["tls.crt"] = "Y3J0"' "$MOCK_STATE/moca__Secret__moca-supervisor-tls.json" >"$TMP/s" &&
  mv "$TMP/s" "$MOCK_STATE/moca__Secret__moca-supervisor-tls.json"
rm -f "$MOCK_STATE/openshift-config-managed__ConfigMap__default-ingress-cert.json"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
expect_out 'Secret moca-supervisor-tls holds no readable certificate'
expect_out 'default-ingress-cert is missing or has no ca-bundle.crt'
[[ ! -e "$GEN_OCP/moca-ca.crt" ]] || fail 'with nothing to trust, moca-ca.crt was still written'
pass 'ocp: an unreadable supervisor certificate and a missing ingress CA are both said'

# The ingress CA is best effort: unreadable, the file still carries the supervisor's, and the run says so.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_GET_CM_FAIL=default-ingress-cert; expect_ok --target ocp)
[[ "$(pem_count "$GEN_OCP/moca-ca.crt")" == 1 ]] || fail 'without the ingress CA, moca-ca.crt must still hold the supervisor certificate'
expect_out 'could not read openshift-config-managed/default-ingress-cert'
expect_out "export NODE_EXTRA_CA_CERTS=$GEN_OCP/moca-ca.crt"
pass 'ocp: an unreadable ingress CA is a warning, not a failure'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=example.test; expect_ok --target ocp-single)
: >"$MOCK_LOG"
(unset SH_ROUTE_DOMAIN; export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp-single)
! grep -q 'create secret tls' "$MOCK_LOG" || fail 'an ocp-single re-run replaced the TLS Secret'
expect_out "export NODE_EXTRA_CA_CERTS=$REPO/deploy/k8s/.generated/ocp-single/moca-supervisor-ca.crt"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ROUTE_DOMAIN=; expect_ok --target ocp-single)
! grep -q 'NODE_EXTRA_CA_CERTS' "$TMP/out" || fail 'ocp-single without Routes still printed a trust line'
pass 'ocp-single: the trust line is printed on every run with Routes, and not without them'

# The token lifetimes: sticky settings, like the others.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_API_TOKEN_TTL_SECONDS=28800 SH_SESSION_TOKEN_TTL_SECONDS=600; expect_ok --target kind --skip-build)
[[ "$(setting SH_API_TOKEN_TTL_SECONDS)" == 28800 && "$(setting SH_SESSION_TOKEN_TTL_SECONDS)" == 600 ]] ||
  fail 'the token lifetimes were not written to moca-settings'
h_ttl="$(settings_hash)"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
[[ "$(setting SH_API_TOKEN_TTL_SECONDS)" == 28800 && "$(setting SH_SESSION_TOKEN_TTL_SECONDS)" == 600 ]] ||
  fail 'a re-run without the token lifetimes dropped them'
[[ "$(settings_hash)" == "$h_ttl" ]] || fail 'an unchanged re-run changed the settings hash'
! grep -q 'over 7 days' "$TMP/out" || fail 'an 8-hour API token lifetime was warned about'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_API_TOKEN_TTL_SECONDS=2592000; expect_ok --target kind --skip-build)
expect_out 'SH_API_TOKEN_TTL_SECONDS=2592000 is over 7 days'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_API_TOKEN_TTL_SECONDS=28800; expect_ok --target kind --skip-build)
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_API_TOKEN_TTL_SECONDS=; expect_ok --target kind --skip-build)
[[ -z "$(setting SH_API_TOKEN_TTL_SECONDS)" && "$(setting SH_SESSION_TOKEN_TTL_SECONDS)" == 600 ]] ||
  fail 'SH_API_TOKEN_TTL_SECONDS= did not clear only the API token lifetime'
[[ "$(settings_hash)" != "$h_ttl" ]] || fail 'a changed token lifetime did not change the settings hash (the control plane would not roll)'
grep -q 'key: SH_API_TOKEN_TTL_SECONDS' "$REPO/deploy/k8s/base/control-plane.yaml" &&
  grep -q 'key: SH_SESSION_TOKEN_TTL_SECONDS' "$REPO/deploy/k8s/base/control-plane.yaml" ||
  fail 'the control plane does not read the token lifetimes from moca-settings'
pass 'SH_API_TOKEN_TTL_SECONDS and SH_SESSION_TOKEN_TTL_SECONDS are sticky settings; empty is the default; a change rolls; over 7 days warns'

for bad in 0 -5 1h 3600.5 123456789; do
  reset_state
  (export SH_GITHUB_CLIENT_ID=Iv1.a SH_API_TOKEN_TTL_SECONDS="$bad"; expect_fail --target kind --skip-build)
  expect_out "SH_API_TOKEN_TTL_SECONDS='$bad'"
  ! grep -q '^kubectl .*apply' "$MOCK_LOG" || fail "SH_API_TOKEN_TTL_SECONDS='$bad' reached kubectl apply"
done
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SESSION_TOKEN_TTL_SECONDS=5m; expect_fail --target kind --skip-build)
expect_out "SH_SESSION_TOKEN_TTL_SECONDS='5m'"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
jq '.data.SH_SESSION_TOKEN_TTL_SECONDS = "5m"' "$MOCK_STATE/moca__ConfigMap__moca-settings.json" >"$TMP/cm" &&
  mv "$TMP/cm" "$MOCK_STATE/moca__ConfigMap__moca-settings.json"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_fail --target kind --skip-build)
expect_out "moca-settings holds SH_SESSION_TOKEN_TTL_SECONDS='5m'"
pass 'a malformed token lifetime is refused, given (before any apply) or stored'

# The catalog allow-list: a sticky setting like the others.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_MODEL_CATALOG_HOSTS=gw.example.com,litellm.team-a.svc; expect_ok --target kind --skip-build)
[[ "$(setting SH_MODEL_CATALOG_HOSTS)" == 'gw.example.com,litellm.team-a.svc' ]] ||
  fail 'SH_MODEL_CATALOG_HOSTS was not written to moca-settings'
h_hosts="$(settings_hash)"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
[[ "$(setting SH_MODEL_CATALOG_HOSTS)" == 'gw.example.com,litellm.team-a.svc' ]] ||
  fail 'a re-run without SH_MODEL_CATALOG_HOSTS dropped it'
[[ "$(settings_hash)" == "$h_hosts" ]] || fail 'an unchanged re-run changed the settings hash'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_MODEL_CATALOG_HOSTS=; expect_ok --target kind --skip-build)
[[ -z "$(setting SH_MODEL_CATALOG_HOSTS)" ]] || fail 'SH_MODEL_CATALOG_HOSTS= did not clear the allow-list'
[[ "$(settings_hash)" != "$h_hosts" ]] || fail 'a cleared allow-list did not change the settings hash (the control plane would not roll)'
grep -q 'key: SH_MODEL_CATALOG_HOSTS' "$REPO/deploy/k8s/base/control-plane.yaml" ||
  fail 'the control plane does not read the catalog allow-list from moca-settings'
pass 'SH_MODEL_CATALOG_HOSTS is a sticky setting; empty is the default; a change rolls'

for bad in 'https://gw.example.com' 'gw.example.com:4000' 'gw example.com' 'user@gw.example.com' 'gw.example.com/path'; do
  reset_state
  (export SH_GITHUB_CLIENT_ID=Iv1.a SH_MODEL_CATALOG_HOSTS="$bad"; expect_fail --target kind --skip-build)
  expect_out "SH_MODEL_CATALOG_HOSTS='$bad'"
  ! grep -q '^kubectl .*apply' "$MOCK_LOG" || fail "SH_MODEL_CATALOG_HOSTS='$bad' reached kubectl apply"
done
# An embedded newline: read -r in valid_catalog_hosts sees only the first line, so without the
# up-front rejection this would validate here and crashloop the control plane at boot.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_MODEL_CATALOG_HOSTS=$'gw.example.com\nhttps://x'; expect_fail --target kind --skip-build)
expect_out 'must be comma-separated bare hostnames'
! grep -q '^kubectl .*apply' "$MOCK_LOG" || fail 'an embedded newline in SH_MODEL_CATALOG_HOSTS reached kubectl apply'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
jq '.data.SH_MODEL_CATALOG_HOSTS = "gw.example.com\nhttps://x"' "$MOCK_STATE/moca__ConfigMap__moca-settings.json" >"$TMP/cm" &&
  mv "$TMP/cm" "$MOCK_STATE/moca__ConfigMap__moca-settings.json"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_fail --target kind --skip-build)
expect_out 'moca-settings holds SH_MODEL_CATALOG_HOSTS'
pass 'an embedded newline in the catalog allow-list is refused, given (before any apply) or stored'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_MODEL_CATALOG_HOSTS='GW.Example.Com'; expect_ok --target kind --skip-build)
[[ "$(setting SH_MODEL_CATALOG_HOSTS)" == 'GW.Example.Com' ]] ||
  fail 'upper-case hostnames were mangled instead of passed through for the control plane to lower-case'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
jq '.data.SH_MODEL_CATALOG_HOSTS = "gw.example.com:4000"' "$MOCK_STATE/moca__ConfigMap__moca-settings.json" >"$TMP/cm" &&
  mv "$TMP/cm" "$MOCK_STATE/moca__ConfigMap__moca-settings.json"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_fail --target kind --skip-build)
expect_out "moca-settings holds SH_MODEL_CATALOG_HOSTS='gw.example.com:4000'"
pass 'a malformed catalog allow-list is refused, given (before any apply) or stored'

# The 0.8 upgrade of a hand-patched allow-list: before the manifests wired it into moca-settings
# (5615ffd6), the only way to set it on k8s was a hand patch of the control plane Deployment -- a
# literal env value owned by another field manager. The manifests now apply that env entry as a
# configMapKeyRef, and server-side apply never declares `value`, so the literal survives the merge
# and the API server rejects the Deployment ("may not be specified when `value` is not empty").
# setup.sh must carry the hand-patched value into moca-settings (a pre-0.8 ConfigMap has no catalog
# key, so the strip would otherwise delete the only copy) and strip the env before the apply.
seed_control_plane_env() { # $1: the SH_MODEL_CATALOG_HOSTS env entry, as strict JSON (--argjson)
  jq -n --argjson entry "$1" '{apiVersion: "apps/v1", kind: "Deployment",
    metadata: {name: "moca-control-plane", namespace: "moca"},
    spec: {template: {spec: {containers: [{name: "control-plane",
      env: [{name: "HOME", value: "/tmp"}, $entry]}]}}}}' \
    >"$MOCK_STATE/moca__Deployment__moca-control-plane.json"
}
reset_state
seed_control_plane_env '{"name": "SH_MODEL_CATALOG_HOSTS", "value": "litellm.cb.example.com"}'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
grep -q ' set env deployment/moca-control-plane .*SH_MODEL_CATALOG_HOSTS-$' "$MOCK_LOG" ||
  fail 'a hand-patched SH_MODEL_CATALOG_HOSTS env value was not stripped'
[[ "$(setting SH_MODEL_CATALOG_HOSTS)" == litellm.cb.example.com ]] ||
  fail 'the hand-patched allow-list was dropped instead of carried into moca-settings'
strip_line="$(grep -n ' set env deployment/moca-control-plane ' "$MOCK_LOG" | head -1 | cut -d: -f1)"
apply_line="$(grep -n 'apply -k' "$MOCK_LOG" | head -1 | cut -d: -f1)"
[[ -n "$strip_line" && -n "$apply_line" && "$strip_line" -lt "$apply_line" ]] ||
  fail 'the hand patch was not stripped before the apply (the API server would see value and valueFrom together)'
jq -e '(.spec.template.spec.containers[0].env // []) | map(select(.name == "SH_MODEL_CATALOG_HOSTS")) | length == 0' \
  "$MOCK_STATE/moca__Deployment__moca-control-plane.json" >/dev/null ||
  fail 'the strip left the SH_MODEL_CATALOG_HOSTS entry on the live Deployment'
# The hand patch is the last resort: a value given for this run, and one an earlier run stored,
# both win over it -- an operator who replaced or cleared the allow-list is never dragged back.
reset_state
seed_control_plane_env '{"name": "SH_MODEL_CATALOG_HOSTS", "value": "litellm.cb.example.com"}'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_MODEL_CATALOG_HOSTS=gw.override.example.com; expect_ok --target kind --skip-build)
[[ "$(setting SH_MODEL_CATALOG_HOSTS)" == gw.override.example.com ]] ||
  fail 'a SH_MODEL_CATALOG_HOSTS given for the run did not win over the hand patch'
grep -q ' set env deployment/moca-control-plane ' "$MOCK_LOG" ||
  fail 'the hand patch outlived a run that replaced its value'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_MODEL_CATALOG_HOSTS=gw.stored.example.com; expect_ok --target kind --skip-build)
seed_control_plane_env '{"name": "SH_MODEL_CATALOG_HOSTS", "value": "litellm.cb.example.com"}'
: >"$MOCK_LOG" # only this run's calls: the stored value must win with the hand patch present
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
[[ "$(setting SH_MODEL_CATALOG_HOSTS)" == gw.stored.example.com ]] ||
  fail 'a stored SH_MODEL_CATALOG_HOSTS did not win over the hand patch'
grep -q ' set env deployment/moca-control-plane ' "$MOCK_LOG" ||
  fail 'the hand patch outlived the run that ignored its value'
# A malformed hand-patched value is refused like a malformed given or stored one, naming where it
# lives, and never reaches the stack apply (the Secret applies before write_settings are fine:
# the stored-value refusal behaves the same way).
reset_state
seed_control_plane_env '{"name": "SH_MODEL_CATALOG_HOSTS", "value": "gw.example.com:4000"}'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_fail --target kind --skip-build)
expect_out "deployment/moca-control-plane holds SH_MODEL_CATALOG_HOSTS='gw.example.com:4000'"
! grep -q 'apply -k' "$MOCK_LOG" || fail 'a malformed hand-patched allow-list reached the stack apply'
# Without a hand patch there is nothing to strip: an absent entry (a stack that never set the
# allow-list) and a valueFrom one (a stack this setup.sh already applied) must not be touched,
# or every re-run would roll the control plane for nothing.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
! grep -q ' set env deployment/moca-control-plane' "$MOCK_LOG" ||
  fail 'a Deployment without the hand patch was patched anyway'
reset_state
seed_control_plane_env '{"name": "SH_MODEL_CATALOG_HOSTS", "valueFrom": {"configMapKeyRef": {"name": "moca-settings", "key": "SH_MODEL_CATALOG_HOSTS"}}}'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
! grep -q ' set env deployment/moca-control-plane' "$MOCK_LOG" ||
  fail 'a valueFrom SH_MODEL_CATALOG_HOSTS (a stack this setup.sh applied) was stripped, rolling the control plane for nothing'
pass 'the 0.8 upgrade carries a hand-patched SH_MODEL_CATALOG_HOSTS into moca-settings and strips the env before the apply, and strips nothing without one'
echo "== workload sandboxes (SH_WORKLOAD_SANDBOXES, workload sandboxes spec §4)"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
! grep -qE 'workload-sandboxes|moca-provisioner|ResourceQuota|PodTemplate' "$MOCK_STATE/applied-kustomization.yaml" ||
  fail 'the generated overlay names a workload-sandboxes object with the feature off'
[[ ! -f "$MOCK_STATE/moca__Secret__moca-provisioner.json" ]] || fail 'a moca-provisioner Secret was made with the feature off'
! grep -qE 'get (--raw|endpointslices|statefulsets)|delete .*provisioner' "$MOCK_LOG" || fail 'the feature off read or deleted its objects'
pass 'off by default: no component, quota, provisioner Secret or provisioner reads'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=1; expect_ok --target kind --skip-build)
grep -q '^  - ../../base/workload-sandboxes$' "$MOCK_STATE/applied-kustomization.yaml" || fail 'the component is not listed'
[[ "$(sv moca moca-provisioner MOCA_ATTACH_PUBLIC_KEYS)" =~ ^[0-9a-f]{16}: ]] || fail 'no attach public keyset'
[[ -n "$(sv moca moca-provisioner MOCA_ATTACH_PRIVATE_KEY)" ]] || fail 'no attach signing key'
[[ "$(sv moca moca-provisioner MOCA_PROVISIONER_TOKEN)" =~ ^[0-9a-f]{64}$ ]] || fail 'no provisioner service token'
[[ "$(sv moca moca-provisioner MOCA_ATTACH_PUBLIC_KEYS)" != "$(sv moca moca-mu1 SH_SESSION_TOKEN_PUBLIC_KEYS)" ]] ||
  fail 'the attach key is the session-token key'
grep -q 'rollout status deployment/moca-provisioner' "$MOCK_LOG" || fail 'the provisioner rollout is not awaited'
attach_key="$(sv moca moca-provisioner MOCA_ATTACH_PRIVATE_KEY)"
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
grep -q '^  - ../../base/workload-sandboxes$' "$MOCK_STATE/applied-kustomization.yaml" || fail 'SH_WORKLOAD_SANDBOXES is not sticky'
[[ "$(sv moca moca-provisioner MOCA_ATTACH_PRIVATE_KEY)" == "$attach_key" ]] || fail 'a re-run rotated the attach key'
! grep -q 'run moca-genkeys' "$MOCK_LOG" || fail 'a re-run regenerated keys it already had'
grep -qF '{ op: replace, path: /spec/egress, value: [{"to":[{"ipBlock":{"cidr":"10.96.0.1/32"}}],"ports":[{"protocol":"TCP","port":443}]},{"to":[{"ipBlock":{"cidr":"172.18.0.2/32"}}],"ports":[{"protocol":"TCP","port":6443}]}] }' "$MOCK_STATE/applied-kustomization.yaml" ||
  fail "the provisioner's egress is not the API server's ClusterIP and endpoint"
grep -qF '{ op: replace, path: /spec/hard/pods, value: "34" }' "$MOCK_STATE/applied-kustomization.yaml" ||
  fail 'the sandbox pod quota is not SH_SANDBOX_COUNT + 32'
grep -q 'target: { kind: PodTemplate, name: moca-workload-sandbox }' "$MOCK_STATE/applied-kustomization.yaml" ||
  fail 'the workload sandbox template gets no image ID on kind'
grep -q '^    newName: dev.local/moca-remote-worker$' "$MOCK_STATE/applied-kustomization.yaml" ||
  fail "the component's images are not mapped to kind's loaded tags"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=; expect_ok --target kind --skip-build)
! grep -q 'workload-sandboxes' "$MOCK_STATE/applied-kustomization.yaml" || fail 'SH_WORKLOAD_SANDBOXES= did not turn it off'
grep -q 'delete -n moca deployment/moca-provisioner' "$MOCK_LOG" || fail 'turning it off left the provisioner running'
grep -q 'networkpolicy/moca-provisioner-redis networkpolicy/allow-openshift-dns-provisioner' "$MOCK_LOG" ||
  fail "turning it off left the provisioner's Redis and DNS policies"
grep -q 'delete validatingadmissionpolicybinding/moca-provisioner' "$MOCK_LOG" || fail 'turning it off left the admission policy'
! grep -q 'images:' "$MOCK_STATE/applied-kustomization.yaml" || fail 'the off render on kind is not the pre-feature one'
pass 'SH_WORKLOAD_SANDBOXES=1 adds the component and makes the provisioner Secret once; sticky; empty turns it off and removes the provisioner'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=1; expect_ok --target kind --skip-build)
printf 'statefulset.apps/w-%s\n' "$(printf 'a%.0s' {1..32})" >"$MOCK_STATE/workload-sts"
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=; expect_fail --target kind --skip-build)
expect_out 'workload sandboxes still exist in moca-sandbox (1 StatefulSet(s)'
expect_out 'DELETE /workloads/{id}'
expect_out '--delete-workload-sandboxes'
expect_out 'labelled app=moca-workload-sandbox,app.kubernetes.io/managed-by=moca-provisioner'
# The provisioner is stopped BEFORE the check, so no activate can slip between it and the delete,
# and the check uses the delete's selector; a refusal starts the provisioner again.
scale0="$(grep -n 'scale deployment/moca-provisioner -n moca --replicas=0' "$MOCK_LOG" | head -1 | cut -d: -f1)"
check="$(grep -nF 'get statefulsets,persistentvolumeclaims,secrets -n moca-sandbox -l app=moca-workload-sandbox,app.kubernetes.io/managed-by=moca-provisioner -o name' "$MOCK_LOG" | head -1 | cut -d: -f1)"
[[ -n "$scale0" && -n "$check" && "$scale0" -lt "$check" ]] ||
  fail 'the provisioner was not scaled to 0 before the workload sandboxes check, with the delete selector'
grep -q 'get pods -n moca -l app=moca-provisioner -o name' "$MOCK_LOG" || fail 'the provisioner pod was not waited out'
grep -q 'scale deployment/moca-provisioner -n moca --replicas=1' "$MOCK_LOG" || fail 'a refused disable left the provisioner stopped'
# The namespaces apply comes first on every run; neither the stack nor moca-setup is written.
! grep -qE '^kubectl .*apply (-k|--server-side)' "$MOCK_LOG" || fail 'a refused disable reached kubectl apply'
! grep -q '^kubectl .* delete ' "$MOCK_LOG" || fail 'a refused disable deleted something'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES='' MOCK_PROVISIONER_STUCK=1; expect_fail --target kind --skip-build)
expect_out "moca-provisioner's pod is still running"
! grep -q '^kubectl .* delete ' "$MOCK_LOG" || fail 'a disable whose provisioner did not stop deleted something'
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
grep -q '^  - ../../base/workload-sandboxes$' "$MOCK_STATE/applied-kustomization.yaml" || fail 'a refused disable was recorded'
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=; expect_ok --target kind --skip-build --delete-workload-sandboxes)
grep -qF 'delete statefulsets,services,secrets,persistentvolumeclaims -n moca-sandbox -l app=moca-workload-sandbox,app.kubernetes.io/managed-by=moca-provisioner' "$MOCK_LOG" ||
  fail "--delete-workload-sandboxes did not delete the workloads' objects by label"
[[ ! -f "$MOCK_STATE/workload-sts" ]] || fail 'the workload StatefulSets are still there'
! grep -q 'scale deployment/moca-provisioner -n moca --replicas=1' "$MOCK_LOG" || fail 'a finished disable started the provisioner again'
! grep -q 'workload-sandboxes' "$MOCK_STATE/applied-kustomization.yaml" || fail '--delete-workload-sandboxes did not turn it off'
pass 'turning SH_WORKLOAD_SANDBOXES off is refused while workload sandboxes exist, and stays on; --delete-workload-sandboxes deletes them and turns it off'

reset_state
# A PVC (user data) left without its StatefulSet still refuses the disable, and the flag deletes by
# label even when no StatefulSet is left at all.
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=1; expect_ok --target kind --skip-build)
printf 'persistentvolumeclaim/w-%s\n' "$(printf 'b%.0s' {1..32})" >"$MOCK_STATE/workload-sts"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=; expect_fail --target kind --skip-build)
expect_out 'workload sandboxes still exist in moca-sandbox (1 StatefulSet(s), PVC(s) or Secret(s)'
rm -f "$MOCK_STATE/workload-sts"
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=; expect_ok --target kind --skip-build --delete-workload-sandboxes)
grep -qF 'delete statefulsets,services,secrets,persistentvolumeclaims -n moca-sandbox -l app=moca-workload-sandbox,app.kubernetes.io/managed-by=moca-provisioner' "$MOCK_LOG" ||
  fail '--delete-workload-sandboxes did not delete by label with no StatefulSet left'
pass 'a workload PVC or Secret without its StatefulSet refuses the disable; --delete-workload-sandboxes always deletes by label'

reset_state
# Workload PVC StorageClasses (spec §5.4, §6.3): unset, the cluster's default class as rwo; given,
# exactly those, sticky; every other class of the cluster is zeroed in the quota.
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=1; expect_ok --target kind --skip-build)
gen="$MOCK_STATE/applied-kustomization.yaml"
grep -qF "{ op: replace, path: /spec/variables/7/expression, value: \"['standard']\" }" "$gen" ||
  fail "the admission policy's allowlist is not the default class"
grep -qF '{ op: replace, path: /spec/variables/8/expression, value: "[]" }' "$gen" || fail 'the default class was allowed rwx'
grep -qF '{ name: MOCA_WORKLOAD_STORAGE_CLASSES, value: "standard:rwo" }' "$gen" || fail 'the workers and provisioner were not given the default class'
! grep -q 'storageclass.storage.k8s.io' "$gen" || fail 'a cluster with only the allowed class got a zeroed class'
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_SC_SLOW=1 SH_WORKLOAD_STORAGE_CLASSES=' standard:rwo , slow:rwx'; expect_ok --target kind --skip-build)
grep -qF "value: \"['standard','slow']\"" "$gen" || fail 'SH_WORKLOAD_STORAGE_CLASSES is not the allowlist'
grep -qF "{ op: replace, path: /spec/variables/8/expression, value: \"['slow']\" }" "$gen" || fail 'an rwx class is not rwx'
grep -qF '{ name: MOCA_WORKLOAD_STORAGE_CLASSES, value: "standard:rwo,slow:rwx" }' "$gen" || fail 'the classes did not reach the workers and provisioner'
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_SC_SLOW=1 SH_WORKLOAD_STORAGE_CLASSES=slow:rwo; expect_ok --target kind --skip-build)
grep -qF 'path: /spec/hard/standard.storageclass.storage.k8s.io~1requests.storage, value: "0"' "$gen" ||
  fail 'a class outside the allowlist is not zeroed in the quota'
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_SC_SLOW=1; expect_ok --target kind --skip-build)
grep -qF '{ name: MOCA_WORKLOAD_STORAGE_CLASSES, value: "slow:rwo" }' "$gen" || fail 'SH_WORKLOAD_STORAGE_CLASSES is not sticky'
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_STORAGE_CLASSES='standard:rwo,fsat:rwx'; expect_fail --target kind --skip-build)
expect_out 'SH_WORKLOAD_STORAGE_CLASSES names StorageClass(es) this cluster does not have: fsat'
! grep -q '^kubectl .*apply -k' "$MOCK_LOG" || fail 'an unknown workload StorageClass reached kubectl apply -k'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_STORAGE_CLASSES=fast; expect_fail --target kind --skip-build)
expect_out "SH_WORKLOAD_STORAGE_CLASSES: 'fast' is not <class>:rwo or <class>:rwx"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=1 MOCK_NO_DEFAULT_SC=1; expect_fail --target kind --skip-build)
expect_out 'the cluster has no default StorageClass for workload PVCs'
! grep -q '^kubectl .*apply -k' "$MOCK_LOG" || fail 'a stack with no workload StorageClass reached kubectl apply -k'
pass 'SH_WORKLOAD_STORAGE_CLASSES: default class when unset, the allowlist when set, sticky; other classes zeroed; malformed, unknown or no default refused'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=1 MOCK_NO_API_ENDPOINTS=1; expect_fail --target kind --skip-build)
expect_out 'has no ClusterIP or no endpoint addresses'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=1 MOCK_NO_VAP=1; expect_fail --target kind --skip-build)
expect_out 'needs ValidatingAdmissionPolicy'
# kubectl failing is not the API missing: its own error shows, and the message says it could not ask.
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=1 MOCK_RAW_FAIL=1; expect_fail --target kind --skip-build)
expect_out 'could not ask the API server which admission APIs it serves'
expect_out 'You must be logged in to the server (Unauthorized)'
! grep -qF 'which this cluster does not serve' "$TMP/out" || fail 'a kubectl failure was reported as a missing API'
! grep -q '^kubectl .*apply -k' "$MOCK_LOG" || fail 'an undeterminable API server address reached kubectl apply -k'
pass "SH_WORKLOAD_SANDBOXES=1 refuses a cluster whose API server address it cannot read, or without ValidatingAdmissionPolicy, rather than open the provisioner's egress"

reset_state
(export SH_WORKLOAD_SANDBOXES=yes; expect_fail --target kind --skip-build)
expect_out "SH_WORKLOAD_SANDBOXES='yes' must be 1"
(export SH_WORKLOAD_SANDBOXES=1; expect_fail --target ocp-single)
expect_out 'SH_WORKLOAD_SANDBOXES=1 needs a separate sandbox namespace'
! grep -q '^kubectl .*apply' "$MOCK_LOG" || fail 'a refused SH_WORKLOAD_SANDBOXES reached kubectl apply'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=1; expect_ok --target ocp)
[[ "$(grep -c '^oc adm policy add-scc-to-user nonroot-v2' "$MOCK_LOG")" == 7 ]] || fail 'the provisioner and workload sandboxes got no SCC grant on ocp'
grep -q '^oc adm policy add-scc-to-user nonroot-v2 -z moca-workload-sandbox -n moca-sandbox$' "$MOCK_LOG" ||
  fail 'the workload sandbox ServiceAccount got no SCC grant on ocp'
# openshift-dns:5353 for workload pods: the ocp component, listed after the feature's own.
grep -A1 '^  - ../../base/workload-sandboxes$' "$MOCK_STATE/applied-kustomization.yaml" | grep -q '^  - ../../overlays/ocp/workload-sandboxes$' ||
  fail "workload sandboxes on ocp get no openshift-dns rule"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_WORKLOAD_SANDBOXES=1; expect_ok --target kind --skip-build)
! grep -q 'overlays/ocp/workload-sandboxes' "$MOCK_STATE/applied-kustomization.yaml" || fail 'kind got the ocp DNS rule'
pass 'SH_WORKLOAD_SANDBOXES: a bad value and ocp-single are refused before any apply; ocp grants the provisioner and workload sandboxes their SCC and adds their openshift-dns rule'

echo "== #440: the bash 3.2 wiring that runs this suite on macOS still exists"
# Without this, the arrangement is a claim with nothing behind it: a workflow or Makefile edit
# could remove the macOS job and the only symptom would be that 3.2 regressions stop being caught
# -- silently, since every remaining job is bash 5 and would stay green. Same reasoning, and the
# same substring-level matching, as TestTheCIWorkflowsRunTheGates in
# remote-worker/internal/vmpool/gates_inventory_test.go: assert that the pieces are wired, not
# their YAML, because a brittle assertion here gets edited away rather than satisfied.
REPO_ROOT="$(cd "$SRC_K8S/../.." && pwd)"
if [[ -f "$REPO_ROOT/.github/workflows/ci.yml" && -f "$REPO_ROOT/Makefile" ]]; then
  grep -q '^test-deploy-bash32:' "$REPO_ROOT/Makefile" ||
    fail 'the Makefile has no test-deploy-bash32 target -- nothing runs these suites on bash 3.2 (#440)'
  # The full path, not the basename: deploy/sbx/tests/setup.test.sh is a different suite.
  grep -qF 'deploy/k8s/tests/setup.test.sh' "$REPO_ROOT/Makefile" ||
    fail 'test-deploy-bash32 no longer lists this suite, so macOS CI stopped covering setup.sh (#440)'
  grep -q '^  deploy-scripts-bash32:' "$REPO_ROOT/.github/workflows/ci.yml" ||
    fail 'ci.yml has no deploy-scripts-bash32 job -- bash 3.2 is no longer tested on any PR (#440)'
  grep -q 'runs-on: macos-latest' "$REPO_ROOT/.github/workflows/ci.yml" ||
    fail 'ci.yml has no macOS runner, so /bin/bash 3.2 is unreachable in CI (#440)'
  grep -qF 'make test-deploy-bash32' "$REPO_ROOT/.github/workflows/ci.yml" ||
    fail 'the macOS job no longer runs make test-deploy-bash32 (#440)'
  pass 'the macOS bash 3.2 job and its Makefile target are still wired to this suite'
else
  echo "skip - not run from a repository checkout, so the CI wiring cannot be checked"
fi

echo "setup.test.sh: all passed"
