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
REAL_PATH="$PATH"
export REAL_PATH
REAL_BASH="$(command -v bash)"
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
  obj="$(jq 'if .stringData then .data = ((.data // {}) + (.stringData | map_values(@base64))) | del(.stringData) else . end' <<<"$obj")"
  printf '%s\n' "$obj" >"$(store "$(jq -r .metadata.namespace <<<"$obj")" "$(jq -r .kind <<<"$obj")" "$(jq -r .metadata.name <<<"$obj")")" ;;
"apply -f") : ;; # a file path (namespaces.yaml); stdin applies all go through --server-side
"apply -k")
  if [[ -n "${MOCK_APPLY_K_FAIL-}" ]]; then echo 'error: the server was unable to return a response in the time allotted' >&2; exit 1; fi
  cp "$3/kustomization.yaml" "$MOCK_STATE/applied-kustomization.yaml" ;;
"create configmap")
  jq -n --arg n "$3" --arg ns "$ns" '{apiVersion: "v1", kind: "ConfigMap", metadata: {name: $n, namespace: $ns}, data: {"mock-anthropic.mjs": "x"}}' ;;
"create secret")
  if [[ -n "${MOCK_TLS_CREATE_FAIL-}" ]]; then echo 'error: failed to load key pair' >&2; exit 1; fi
  jq -n --arg n "$4" --arg ns "$ns" '{apiVersion: "v1", kind: "Secret", type: "kubernetes.io/tls", metadata: {name: $n, namespace: $ns}, data: {"tls.crt": "Y3J0", "tls.key": "a2V5"}}' ;;
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
"rollout status" | "rollout restart") : ;;
"exec redis-0") echo "${MOCK_RECORDS:-2}" ;;
"get storageclass")
  if [[ -n "${MOCK_GET_SC_FAIL-}" ]]; then echo 'Error from server (Forbidden): storageclasses is forbidden' >&2; exit 1; fi
  if [[ -n "${MOCK_NO_DEFAULT_SC-}" ]]; then echo '{"items":[{"metadata":{"name":"slow"}}]}'
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
expect_out 'apply to --target ocp only'
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
# The control plane's configMapKeyRefs are not optional: a missing key stops the pod opaquely.
[[ "$(jq -c '.data | keys' "$MOCK_STATE/moca__ConfigMap__moca-settings.json")" == '["SH_ADMIN_SUBJECTS","SH_ALLOW_OPERATOR_FALLBACK","SH_GITHUB_CLIENT_ID","SH_PUBLIC_HARNESS_URL"]' ]] ||
  fail 'moca-settings must hold exactly the four keys the control plane references'
expect_out 'port-forward svc/moca-supervisor 8080:8080'
pass 'kind: generated overlay applied; control plane held at 0 without a client id; access printed'

hash_of() { gen | grep -oE 'moca.dev/settings-hash: "[0-9a-f]{64}"' | grep -oE '[0-9a-f]{64}'; }
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
[[ "$(replicas_of moca-control-plane)" == 1 ]] || fail 'a client id must render the control plane at 1 replica'
h1="$(hash_of)"
[[ -n "$h1" ]] || fail 'the generated overlay carries no settings hash on the control plane pod template'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
[[ "$(hash_of)" == "$h1" ]] || fail 'an unchanged re-run changed the settings hash (it would roll the control plane for nothing)'
(export SH_GITHUB_CLIENT_ID=Iv1.b; expect_ok --target kind --skip-build)
h2="$(hash_of)"
[[ -n "$h2" && "$h2" != "$h1" ]] || fail 'a changed client id did not change the settings hash'
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.b ]] || fail 'the new client id was not written'
pass 'the settings hash is stable for unchanged settings and changes with them (Review Focus 2)'

# The retry case: a run that wrote client id B and then failed before the roll. Nothing is
# remembered between runs, so the next run renders B's hash and the apply still rolls the pods.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
[[ "$(hash_of)" == "$h1" ]] || fail 'the settings hash depends on more than the settings'
(export SH_GITHUB_CLIENT_ID=Iv1.b MOCK_APPLY_K_FAIL=1; expect_fail --target kind --skip-build)
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.b ]] || fail 'the failed run did not get as far as writing the new settings'
[[ "$(hash_of)" == "$h1" ]] || fail 'the failed apply still recorded an applied kustomization'
(export SH_GITHUB_CLIENT_ID=Iv1.b; expect_ok --target kind --skip-build)
[[ "$(hash_of)" == "$h2" ]] || fail 'after a failed run, the re-run did not roll the control plane onto the new settings'
! grep -q 'rollout restart' "$MOCK_LOG" || fail 'the control plane is rolled by the hash; nothing may rollout restart it'
pass 'a settings change survives a failed run: the re-run applies the new hash'

if [[ -x "$TMP/bin/sha256sum" && -x "$TMP/bin/shasum" ]]; then
  mv "$TMP/bin/sha256sum" "$TMP/bin/sha256sum.off"
  (export SH_GITHUB_CLIENT_ID=Iv1.b; expect_ok --target kind --skip-build)
  mv "$TMP/bin/sha256sum.off" "$TMP/bin/sha256sum"
  [[ "$(hash_of)" == "$h2" ]] || fail 'shasum and sha256sum disagree on the settings hash'
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
h1="$(hash_of)"
(unset SH_GITHUB_CLIENT_ID SH_ADMIN_SUBJECTS SH_ALLOW_OPERATOR_FALLBACK; expect_ok --target kind --skip-build)
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.a ]] || fail 'a re-run without SH_GITHUB_CLIENT_ID dropped the client id'
[[ "$(setting SH_ADMIN_SUBJECTS)" == github:alice ]] || fail 'a re-run without SH_ADMIN_SUBJECTS dropped the admins'
[[ "$(setting SH_ALLOW_OPERATOR_FALLBACK)" == true ]] || fail 'a re-run without SH_ALLOW_OPERATOR_FALLBACK reset it'
[[ "$(replicas_of moca-control-plane)" == 1 ]] || fail 'a re-run without SH_GITHUB_CLIENT_ID scaled the control plane to 0'
! grep -q 'no SH_GITHUB_CLIENT_ID' "$TMP/out" || fail 'a re-run with a stored client id still warned that there is none'
[[ "$(hash_of)" == "$h1" ]] || fail 'a re-run with no inputs changed the settings hash (it would roll the control plane)'
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

echo "setup.test.sh: all passed"
