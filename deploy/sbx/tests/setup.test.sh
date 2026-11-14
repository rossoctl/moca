#!/usr/bin/env bash
# Cluster-free tests for deploy/sbx/setup.sh (SBX0 1b). kubectl is a mock on PATH that keeps Secrets
# and ConfigMaps as JSON files and logs every argv, so the tests can prove what was applied and that
# no token or key ever reached argv. The generated overlay is also rendered with the real
# `kubectl kustomize`, so its patches are proven to apply.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REAL_KUBECTL="$(command -v kubectl || true)"
[[ -n "$REAL_KUBECTL" ]] || { echo "FAIL: kubectl is required (kubectl kustomize renders the generated overlay)" >&2; exit 1; }
export MOCK_LOG="$TMP/mock.log" MOCK_STATE="$TMP/state"
mkdir -p "$TMP/bin" "$MOCK_STATE"

fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }

# A copy of the repo's deploy tree, so .generated/ lands in TMP (and its overlay can be rendered).
REPO="$TMP/repo"
mkdir -p "$REPO/deploy"
cp -R "$SRC/deploy/sbx" "$REPO/deploy/sbx"
cp -R "$SRC/deploy/k8s" "$REPO/deploy/k8s"
rm -rf "$REPO/deploy/sbx/.generated" "$REPO/deploy/k8s/.generated"
SETUP="$REPO/deploy/sbx/setup.sh"
GEN="$REPO/deploy/sbx/.generated"

cat >"$TMP/bin/kubectl" <<'MOCK'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >>"$MOCK_LOG"
args=("$@")
ns=''
for ((i = 0; i < ${#args[@]}; i++)); do [[ "${args[$i]}" == -n ]] && ns="${args[$((i + 1))]}"; done
case "$1 $2" in
'get configmaps')
  [[ "$ns" != "${MOCK_NO_NAMESPACE:-}" ]] || { echo "Error from server (NotFound): namespaces \"$ns\" not found" >&2; exit 1; }
  exit 0 ;;
'get secret')
  f="$MOCK_STATE/secret-$3.json"
  # MOCK_BLANK_GET=NAME: that Secret reads back with no data (emptied by someone else mid-run).
  # MOCK_FAIL_GET=NAME: reading that Secret fails (a transient API or RBAC error).
  [[ "$3" != "${MOCK_FAIL_GET:-}" ]] || { echo 'Error from server (InternalError): etcdserver: request timed out' >&2; exit 1; }
  # MOCK_FAIL_GET_LATE=NAME: the same, but only once the relay's rollout has been waited on.
  [[ "$3" != "${MOCK_FAIL_GET_LATE:-}" || ! -f "$MOCK_STATE/relay-rolled" ]] ||
    { echo 'Error from server (InternalError): etcdserver: request timed out' >&2; exit 1; }
  if [[ -f "$f" && "$3" == "${MOCK_BLANK_GET:-}" ]]; then jq -c 'del(.data)' "$f"; elif [[ -f "$f" ]]; then cat "$f"; fi
  exit 0 ;;
'get statefulset')
  # A StatefulSet in MOCK_STATE/statefulset-NAME.json (none by default: a fresh namespace).
  [[ "$3" != "${MOCK_FAIL_GET:-}" ]] || { echo 'Error from server (InternalError): etcdserver: request timed out' >&2; exit 1; }
  f="$MOCK_STATE/statefulset-$3.json"
  [[ ! -f "$f" ]] || cat "$f"
  exit 0 ;;
'create secret')
  # create secret tls NAME -n NS --cert=F --key=F --dry-run=client -o json
  name="$4" cert='' key=''
  for a in "$@"; do case "$a" in --cert=*) cert="${a#--cert=}" ;; --key=*) key="${a#--key=}" ;; esac; done
  jq -n --arg n "$name" --arg ns "$ns" --arg c "$(base64 <"$cert" | tr -d '\n')" --arg k "$(base64 <"$key" | tr -d '\n')" \
    '{apiVersion:"v1",kind:"Secret",type:"kubernetes.io/tls",metadata:{name:$n,namespace:$ns},data:{"tls.crt":$c,"tls.key":$k}}'
  exit 0 ;;
'apply --server-side')
  doc="$(cat)"
  kind="$(printf '%s' "$doc" | jq -r '.kind | ascii_downcase')"
  name="$(printf '%s' "$doc" | jq -r .metadata.name)"
  f="$MOCK_STATE/$kind-$name.json"
  # Every apply's key list (names only), so a test can prove a Secret's keys all ride in each apply:
  # real server-side apply prunes the keys its field manager omits; this mock merges and would not.
  printf '%s %s %s\n' "$kind" "$name" "$(printf '%s' "$doc" | jq -r '(.stringData // .data // {}) | keys | join(",")')" >>"$MOCK_STATE/applies.log"
  # A ConfigMap is stored as given: every key it holds is this field manager's.
  [[ "$kind" != configmap ]] || { printf '%s' "$doc" >"$f"; exit 0; }
  # Merge stringData into existing .data (the way real server-side apply keeps foreign keys).
  # For TLS secrets, .data already contains the keys; for Opaque, we convert stringData to base64.
  # When .data becomes empty, delete the field (realistic API behavior).
  if [[ -f "$f" ]]; then
    existing="$(jq -c . "$f")"
  else
    existing='{"data":{}}'
  fi
  printf '%s' "$doc" | jq --argjson ex "$existing" '
    if .stringData then
      .data = (($ex.data // {}) + (.stringData | with_entries(.value |= @base64))) | del(.stringData)
    else
      .data = ($ex.data // {}) + (.data // {})
    end |
    if (.data // {}) == {} then del(.data) else . end' >"$f"
  exit 0 ;;
'patch secret')
  name="$3" patch=''
  # Extract the -p argument value
  args=("$@")
  for ((i = 0; i < ${#args[@]} - 1; i++)); do
    if [[ "${args[$i]}" == -p ]]; then
      patch="${args[$((i + 1))]}"
      break
    fi
  done
  f="$MOCK_STATE/secret-$name.json"
  [[ -f "$f" ]] || { printf '%s' '{"data":{}}' >"$f"; }
  # Apply merge patch: null values delete keys. Delete .data if it becomes empty.
  jq --argjson p "$patch" '
    .data = ((.data // {}) * ($p.data // {}) | with_entries(select(.value != null))) |
    if (.data // {}) == {} then del(.data) else . end' "$f" >"$f.tmp" && mv "$f.tmp" "$f"
  exit 0 ;;
'patch route')
  # The last patch of each Route, as given (a --patch-file is read, so its content is never argv).
  name="$3" patch=''
  for a in "$@"; do case "$a" in --patch-file=*) patch="$(cat "${a#--patch-file=}")" ;; esac; done
  for ((i = 0; i < $# - 1; i++)); do [[ "${args[$i]}" != -p ]] || patch="${args[$((i + 1))]}"; done
  printf '%s' "$patch" >"$MOCK_STATE/route-$name-patch.json"
  exit 0 ;;
'delete secret')
  rm -f "$MOCK_STATE/secret-$3.json"
  exit 0 ;;
'apply -k')
  cp "$3/kustomization.yaml" "$MOCK_STATE/applied-kustomization.yaml"
  exit 0 ;;
'rollout status')
  # MOCK_ROLLOUT_FAIL=KIND/NAME: that rollout times out.
  [[ "$3" != "${MOCK_ROLLOUT_FAIL:-}" ]] || { echo "error: timed out waiting for the condition on $3" >&2; exit 1; }
  [[ "$3" != deployment/sandbox-relay ]] || : >"$MOCK_STATE/relay-rolled"
  exit 0 ;;
esac
echo "mock kubectl: unhandled: $*" >&2
exit 1
MOCK
chmod +x "$TMP/bin/kubectl"
export PATH="$TMP/bin:$PATH"

cat >"$TMP/templates.json" <<'JSON'
[{"id":"default","worker":"sbx_default","description":"bash, git, Python 3","tools":["bash","git","python3"]},
 {"id":"py312","worker":"sbx_py312","description":"Python 3.12","tools":["python3.12"]}]
JSON
printf '%s\n' '[{"id":"default","worker":"sbx_default","description":"bash, git, Python 3","tools":["bash","git","python3"]}]' \
  >"$TMP/one.json"

base_env() {
  export SBX_NAMESPACE=moca-sbx-test SBX_ATTACH_HOST=sbx-attach.apps.example.invalid
  export SBX_EXEC_HOST=sbx-exec.apps.example.invalid SBX_IMAGE=ghcr.io/example/moca:sbx-1b
  export SBX_WORKERS='sbx_default sbx_py312'
  export SBX_API_HOST=sbx-api.apps.example.invalid SBX_GITHUB_CLIENT_ID=Iv1.example
  export SBX_ALLOWED_SUBJECTS='github:1,github:2' SBX_ADMIN_SUBJECTS='github:1'
  export SBX_TEMPLATES_FILE="$TMP/templates.json" SBX_WORKSPACE_FS_GIB=200
  unset SBX_CLIENTS
}
run_setup() { (base_env; "$@"; bash "$SETUP") >"$TMP/out" 2>&1; }
secret_val() { jq -r --arg k "$2" '.data[$k] // empty' "$MOCK_STATE/secret-$1.json" | base64 --decode; }
has_key() { jq -e --arg k "$2" '.data // {} | has($k)' "$MOCK_STATE/secret-$1.json" >/dev/null; }
cm() { jq -r --arg k "$2" '.data[$k] // empty' "$MOCK_STATE/configmap-$1.json"; }
state_hash() { cat "$MOCK_STATE"/secret-*.json | jq -S .data | { sha256sum 2>/dev/null || shasum -a 256; }; }
K="$MOCK_STATE/applied-kustomization.yaml"
# The generated overlay as the cluster would get it: the real kustomize over the copied tree.
render() { "$REAL_KUBECTL" kustomize "$GEN" >"$TMP/render.yaml" 2>"$TMP/render.err" || { cat "$TMP/render.err" >&2; fail 'the generated overlay does not render'; }; }
# The settings-hash annotation on one Deployment's pod template, from the rendered overlay.
pod_hash() {
  awk -v n="$1" '/^---$/ { d = 0; hit = 0 } /^kind: Deployment$/ { d = 1 } d && $1 == "name:" && $2 == n { hit = 1 }
    hit && $1 == "sbx.moca.dev/settings-hash:" { gsub(/"/, "", $2); print $2; exit }' "$TMP/render.yaml"
}

# 1. Refusals, each before anything is applied.
printf '%s\n' '[{"id":"x","worker":"sbx_other","description":"","tools":[]}]' >"$TMP/bad-worker.json"
printf '%s\n' '[{"id":"a","worker":"sbx_default","description":"","tools":[]},{"id":"a","worker":"sbx_py312","description":"","tools":[]}]' >"$TMP/bad-dup.json"
printf '%s\n' '[{"id":"a","worker":"sbx_default","description":"","tools":["bash",1]}]' >"$TMP/bad-tools.json"
printf '%s\n' '[{"id":"a","worker":"sbx_default","description":"","tools":["bash","bash"]}]' >"$TMP/bad-dup-tool.json"
printf '%s\n' '[{"id":"Bad","worker":"sbx_default","description":"","tools":[]}]' >"$TMP/bad-id.json"
printf '%s\n' '[{"id":"a","worker":"sbx_default","tools":[]}]' >"$TMP/bad-shape.json"
printf '%s\n' '[]' >"$TMP/bad-empty.json"
printf '%s\n' '[{"id":"a",' >"$TMP/bad-json.json"
printf '%s\n' '[{"id":"a","worker":"sbx_default","description":"","tools":[]},{"id":"b","worker":"sbx_default","description":"","tools":[]}]' >"$TMP/bad-two.json"
# Each refusal is `<inputs> => <what the message must say>`, so none passes for an unrelated reason.
refusals=(
  'unset SBX_NAMESPACE => SBX_NAMESPACE is required'
  'export SBX_WORKERS=sbx-dash => worker id .sbx-dash. must match'
  'export SBX_WORKERS=DIR => is reserved'
  'export SBX_WORKERS="a a" => is listed twice'
  'export SBX_WORKERS=" " => SBX_WORKERS is required.*only whitespace'
  "export SBX_WORKERS=\$'\\t\\n' => SBX_WORKERS is required.*only whitespace"
  'export SBX_EXEC_HOST=$SBX_ATTACH_HOST => SBX_ATTACH_HOST and SBX_EXEC_HOST must differ'
  'unset SBX_IMAGE => SBX_IMAGE is required'
  'export SBX_CLIENTS=alice => SBX_CLIENTS was increment 1a.*is gone'
  'unset SBX_API_HOST => SBX_API_HOST is required'
  'export SBX_API_HOST=Not_A_Host => SBX_API_HOST is required and must be a DNS name'
  'export SBX_API_HOST=$SBX_EXEC_HOST => SBX_API_HOST must differ'
  'export SBX_API_HOST=$SBX_ATTACH_HOST => SBX_API_HOST must differ'
  'unset SBX_GITHUB_CLIENT_ID => SBX_GITHUB_CLIENT_ID is required'
  'unset SBX_ALLOWED_SUBJECTS => SBX_ALLOWED_SUBJECTS is required'
  'export SBX_ALLOWED_SUBJECTS=alice => SBX_ALLOWED_SUBJECTS is required'
  'export SBX_ALLOWED_SUBJECTS="github:1, github:2" => SBX_ALLOWED_SUBJECTS is required'
  'export SBX_ADMIN_SUBJECTS=github:x => SBX_ADMIN_SUBJECTS must be'
  'unset SBX_WORKSPACE_FS_GIB => SBX_WORKSPACE_FS_GIB must be a positive whole number'
  'export SBX_WORKSPACE_FS_GIB=10 => exceeds 80% of SBX_WORKSPACE_FS_GIB'
  'export SBX_LIFETIME_DAYS=31 => SBX_LIFETIME_DAYS must be'
  'export SBX_LIFETIME_DAYS=0 => SBX_LIFETIME_DAYS must be'
  'export SBX_MAX_TOTAL=0 => SBX_MAX_TOTAL must be a positive whole number'
  'export SBX_MAX_PER_SUBJECT=x => SBX_MAX_PER_SUBJECT must be a positive whole number'
  'export SBX_TOKEN_TTL_MINUTES=4 => SBX_TOKEN_TTL_MINUTES must be a whole number of minutes, 5-60'
  'export SBX_TOKEN_TTL_MINUTES=61 => SBX_TOKEN_TTL_MINUTES must be'
  'export SBX_TOKEN_TTL_MINUTES=15m => SBX_TOKEN_TTL_MINUTES must be'
  'export SBX_RETENTION_DAYS=0 => SBX_RETENTION_DAYS must be a whole number of days, 1-90'
  'export SBX_RETENTION_DAYS=91 => SBX_RETENTION_DAYS must be'
  'export SBX_MAX_INFLIGHT=0 => SBX_MAX_INFLIGHT must be 1-8'
  'export SBX_MAX_INFLIGHT=9 => SBX_MAX_INFLIGHT must be 1-8'
  'export SBX_WORKSPACE_IMAGE_MB=-1 => SBX_WORKSPACE_IMAGE_MB must be a positive whole number'
  'export SBX_MAX_TOTAL=999999999 SBX_WORKSPACE_IMAGE_MB=999999999 SBX_WORKSPACE_FS_GIB=999999999 => SBX_MAX_TOTAL must be'
  'export SBX_MAX_TOTAL=1 SBX_WORKSPACE_IMAGE_MB=999999999 SBX_WORKSPACE_FS_GIB=999999999 => SBX_WORKSPACE_IMAGE_MB must be'
  'export SBX_MAX_PER_SUBJECT=999999999 => SBX_MAX_PER_SUBJECT must be'
  'export SBX_MAX_TOTAL=1000000 => SBX_MAX_TOTAL must be'
  'unset SBX_TEMPLATES_FILE => SBX_TEMPLATES_FILE is required'
  "export SBX_TEMPLATES_FILE=\$TMP/bad-worker.json => template worker 'sbx_other' is not in SBX_WORKERS"
  'export SBX_TEMPLATES_FILE=$TMP/bad-two.json => serves two templates'
  'export SBX_TEMPLATES_FILE=$TMP/bad-dup.json => is not a non-empty list'
  'export SBX_TEMPLATES_FILE=$TMP/bad-tools.json => is not a non-empty list'
  'export SBX_TEMPLATES_FILE=$TMP/bad-dup-tool.json => is not a non-empty list'
  'export SBX_TEMPLATES_FILE=$TMP/bad-id.json => is not a non-empty list'
  'export SBX_TEMPLATES_FILE=$TMP/bad-shape.json => is not a non-empty list'
  'export SBX_TEMPLATES_FILE=$TMP/bad-empty.json => is not a non-empty list'
  'export SBX_TEMPLATES_FILE=$TMP/bad-json.json => is not a non-empty list'
  'export SBX_API_TLS_CERT=$TMP/templates.json => SBX_API_TLS_CERT and SBX_API_TLS_KEY must both'
  'export SBX_JANITOR_WAIT_MINUTES=x => SBX_JANITOR_WAIT_MINUTES must be a positive whole number of minutes'
  'export SBX_JANITOR_WAIT_MINUTES=0 => SBX_JANITOR_WAIT_MINUTES must be a positive whole number of minutes'
  'export SBX_JANITOR_WAIT_MINUTES=15 => SBX_JANITOR_WAIT_MINUTES \(900 s\) must exceed the token lifetime plus the 30 s leeway \(930 s\)'
  'export SBX_TOKEN_TTL_MINUTES=60 SBX_JANITOR_WAIT_MINUTES=60 => SBX_JANITOR_WAIT_MINUTES \(3600 s\) must exceed the token lifetime plus the 30 s leeway \(3630 s\)'
  'export SBX_API_CA_FILE=$TMP/nonexistent.crt => SBX_API_CA_FILE must name a readable PEM certificate'
  'export SBX_API_CA_FILE=$TMP/templates.json => SBX_API_CA_FILE must name a readable PEM certificate'
)
for r in "${refusals[@]}"; do
  bad="${r%% => *}" want="${r#* => }"
  : >"$MOCK_LOG"
  ! run_setup eval "$bad" || fail "accepted: $bad"
  grep -Eq -- "$want" "$TMP/out" || fail "refused '$bad', but not with /$want/"
  ! grep -qE 'apply|patch|delete' "$MOCK_LOG" || fail "changed something before refusing: $bad"
done
pass 'refuses missing or malformed inputs before applying anything, each saying why'

# An openssl without Ed25519 (LibreSSL, OpenSSL < 1.1.1) is refused before anything is applied.
mkdir -p "$TMP/oldssl"
REAL_OPENSSL="$(command -v openssl)"
printf '#!/usr/bin/env bash\n[[ "$1" == genpkey ]] && { echo "unknown algorithm" >&2; exit 1; }\nexec %q "$@"\n' "$REAL_OPENSSL" >"$TMP/oldssl/openssl"
chmod +x "$TMP/oldssl/openssl"
: >"$MOCK_LOG"
! run_setup export PATH="$TMP/oldssl:$PATH" || fail 'ran with an openssl that cannot make Ed25519 keys'
grep -q 'cannot make Ed25519 keys' "$TMP/out" || fail 'the Ed25519 refusal does not say why'
! grep -qE 'apply|patch|delete' "$MOCK_LOG" || fail 'changed something before refusing the openssl'
pass 'refuses an openssl without Ed25519 before applying anything'

: >"$MOCK_LOG"
! run_setup export MOCK_NO_NAMESPACE=moca-sbx-test || fail 'ran against a missing namespace'
grep -q 'must already exist' "$TMP/out" || fail 'the missing-namespace refusal does not say why'
pass 'refuses a namespace that does not exist (never creates one)'

# 1a. Seed moca-relay-sandbox-tokens with no .data field (empty Secret from server).
printf '%s\n' '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"moca-relay-sandbox-tokens"}}' \
  >"$MOCK_STATE/secret-moca-relay-sandbox-tokens.json"
run_setup true || fail 'first run with empty worker-token Secret failed'
[[ "$(secret_val moca-relay-sandbox-tokens sbx_default)" =~ ^[0-9a-f]{64}$ ]] || fail 'no token for sbx_default after empty seed'
[[ "$(secret_val moca-relay-sandbox-tokens sbx_py312)" =~ ^[0-9a-f]{64}$ ]] || fail 'no token for sbx_py312 after empty seed'
pass 'succeeds with an empty worker-token Secret (no .data field)'

# 2. A first run.
: >"$MOCK_LOG"
run_setup true || fail 'first run failed'
for s in moca-redis moca-relay moca-relay-sandbox-tokens moca-mu1 sbx-token-keys moca-relay-tls sbx-exec-tls; do
  [[ -f "$MOCK_STATE/secret-$s.json" ]] || fail "no Secret $s"
done
for c in moca-settings sbx-settings; do [[ -f "$MOCK_STATE/configmap-$c.json" ]] || fail "no ConfigMap $c"; done
[[ ! -f "$MOCK_STATE/secret-sbx-relay-clients.json" && ! -f "$MOCK_STATE/secret-sbx-relay-client-keys.json" ]] ||
  fail 'a 1a client-token Secret was created'
[[ ! -d "$GEN/clients" ]] || fail 'a 1a client bundle was written'
[[ "$(secret_val moca-relay-sandbox-tokens sbx_default)" =~ ^[0-9a-f]{64}$ ]] || fail 'no worker token for sbx_default'
[[ "$(secret_val moca-relay SH_RELAY_TOKEN)" =~ ^[0-9a-f]{64}$ ]] || fail 'no SH_RELAY_TOKEN'
! has_key moca-relay MOCA_RELAY_EXEC_TOKEN || fail 'minted a harness exec token (SBX0 1b has none)'
pass 'creates every Secret and ConfigMap, one worker token per worker, no exec or client tokens'

# Redis refuses writes past 200 MB (under its container's 256 MiB) instead of being OOM-killed, and
# evicts nothing: every session and sandbox record is in it.
RC="$(secret_val moca-redis redis.conf)"
grep -qx 'maxmemory 200mb' <<<"$RC" && grep -qx 'maxmemory-policy noeviction' <<<"$RC" ||
  fail "redis.conf has no 200mb noeviction limit: $(grep -v requirepass <<<"$RC")"
grep -qx 'appendonly yes' <<<"$RC" && grep -qx 'dir /data' <<<"$RC" || fail 'redis.conf lost its persistence lines'
pass 'redis.conf caps Redis at 200mb with noeviction'

priv="$(secret_val moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY)"
[[ "$priv" =~ ^[A-Za-z0-9+/]+=*$ ]] || fail 'no signing key, or not one line of base64'
keyset="$(secret_val sbx-token-keys PUBLIC_KEYS)"
[[ "$keyset" =~ ^[0-9a-f]{16}:[A-Za-z0-9+/]+=*$ ]] || fail "keyset is not <kid>:<spki>: $keyset"
kid="$(printf '%s' "${keyset#*:}" | base64 --decode | openssl dgst -sha256 -hex | awk '{print $NF}' | cut -c1-16)"
[[ "${keyset%%:*}" == "$kid" ]] || fail 'the kid is not derived from the key (sha256 of the SPKI, 16 hex)'
printf '%s' "$priv" | base64 --decode >"$TMP/k.der"
[[ "$(openssl pkey -inform DER -in "$TMP/k.der" -pubout -outform DER | head -c 12 | od -An -tx1 | tr -d ' \n')" == 302a300506032b6570032100 ]] ||
  fail 'the signing key is not a PKCS#8 Ed25519 key'
pubkey="$(openssl pkey -inform DER -in "$TMP/k.der" -pubout -outform DER | base64 | tr -d '\n')"
rm -f "$TMP/k.der"
[[ "${keyset#*:}" == "$pubkey" ]] || fail 'the public key does not match the signing key'
! grep -qF "$priv" "$MOCK_LOG" "$TMP/out" || fail 'the signing key reached argv or the log'
pass 'generates one Ed25519 signing key and publishes its kid:SPKI keyset'

# The key pair and the issuer through the real code: the control plane's makeSigner mints a sandbox
# token, and the relay's verifier, built from the keyset and sbx-settings' issuer, accepts it. Needs
# node and the workspace (pnpm install); without them the openssl checks above still hold. CI runs
# this file from the check job with MOCA_REQUIRE_WORKSPACE=1, where a missing workspace is a FAILURE:
# skipped silently, the round-trip would stop being enforced.
if command -v node >/dev/null && [[ -x "$SRC/packages/sandbox-relay/node_modules/.bin/tsx" ]]; then
  (
    cd "$SRC/packages/sandbox-relay"
    ISSUER="$(cm sbx-settings SH_SANDBOX_TOKEN_ISSUER)"
    export KEYSET="$keyset" ISSUER
    printf '%s' "$priv" | node --import tsx --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { makeSigner, mintSandboxToken, parseKeyset } from "@moca/control-plane";
      import { makeSandboxTokenVerifier } from "./src/sandbox-auth.ts";
      const signer = makeSigner(readFileSync(0, "utf8"));
      if (!parseKeyset(process.env.KEYSET).has(signer.kid)) throw new Error("keyset lacks the signer kid");
      const now = Math.floor(Date.now() / 1000);
      const { token } = mintSandboxToken(signer, { sub: "github:1", tenant: "github:1", sbx: "s1", wrk: "sbx_default",
        wsk: "s1", ttlSeconds: 60, notAfter: now + 3600, iss: process.env.ISSUER, now });
      const verify = makeSandboxTokenVerifier({ SH_SANDBOX_TOKEN_PUBLIC_KEYS: process.env.KEYSET,
        SH_SANDBOX_TOKEN_ISSUER: process.env.ISSUER });
      if (!verify(token).claims) throw new Error("the relay refused the token: " + verify(token).reason);'
  ) >"$TMP/node.out" 2>&1 || { cat "$TMP/node.out" >&2; fail 'the generated key pair does not round-trip through makeSigner and the relay verifier'; }
  pass 'a token minted with the generated key verifies at the relay with the published keyset and issuer'
elif [[ "${MOCA_REQUIRE_WORKSPACE:-}" == 1 ]]; then
  fail "MOCA_REQUIRE_WORKSPACE=1, but node or packages/sandbox-relay's tsx is missing (pnpm install)"
else
  echo "SKIP: the makeSigner/relay round-trip needs node and the workspace (pnpm install)"
fi

[[ "$(cm sbx-settings SH_SANDBOX_EXEC_ENDPOINT)" == 'sbx-exec.apps.example.invalid:443' ]] || fail 'exec endpoint'
[[ "$(cm sbx-settings SH_SANDBOX_LIFETIME_SECONDS)" == 604800 ]] || fail 'lifetime'
[[ "$(cm sbx-settings SH_SANDBOX_MAX_PER_SUBJECT)" == 3 && "$(cm sbx-settings SH_SANDBOX_MAX_TOTAL)" == 40 ]] || fail 'quotas'
[[ "$(cm sbx-settings SH_SANDBOX_MAX_INFLIGHT)" == 2 ]] || fail 'in-flight cap'
[[ "$(cm sbx-settings SH_SANDBOX_TOKEN_TTL_SECONDS)" == 900 ]] || fail 'token TTL default (15 min)'
[[ "$(cm sbx-settings SH_SANDBOX_RETENTION_SECONDS)" == 1209600 ]] || fail 'retention default (14 d)'
[[ "$(cm sbx-settings SH_SANDBOX_TOKEN_ISSUER)" == sbx-control-plane ]] || fail 'issuer'
[[ "$(cm sbx-settings SH_ALLOWED_SUBJECTS)" == 'github:1,github:2' ]] || fail 'allowed subjects'
cm sbx-settings SH_SANDBOX_TEMPLATES | jq -e 'length == 2 and .[1].worker == "sbx_py312"' >/dev/null || fail 'templates'
cm sbx-settings SH_SANDBOX_EXEC_CA | grep -q 'BEGIN CERTIFICATE' || fail 'the self-signed exec CA is not advertised'
[[ "$(cm moca-settings SH_GITHUB_CLIENT_ID)" == Iv1.example ]] || fail 'client id'
[[ "$(cm moca-settings SH_ADMIN_SUBJECTS)" == github:1 ]] || fail 'admin subjects'
jq -e '.data | has("SH_API_TOKEN_TTL_SECONDS") and has("SH_SESSION_TOKEN_TTL_SECONDS")' \
  "$MOCK_STATE/configmap-moca-settings.json" >/dev/null || fail 'moca-settings lacks the token TTL keys the base reads'
pass 'writes moca-settings and sbx-settings, advertising the self-signed exec CA'

grep -qx 'namespace: moca-sbx-test' "$K" || fail 'generated overlay has the wrong namespace'
grep -q 'value: sbx-attach.apps.example.invalid' "$K" || fail 'attach Route host not set'
grep -q 'value: sbx-exec.apps.example.invalid' "$K" || fail 'exec Route host not set'
grep -q 'value: sbx-api.apps.example.invalid' "$K" || fail 'API Route host not set'
grep -q 'newName: ghcr.io/example/moca' "$K" && grep -q 'newTag: sbx-1b' "$K" || fail 'image not set'
! grep -q 'client-tokens-hash' "$K" || fail 'the 1a client-tokens hash is still stamped'
render
grep -q 'host: sbx-api.apps.example.invalid' "$TMP/render.yaml" || fail 'the rendered API Route has the placeholder host'
cp_hash="$(pod_hash moca-control-plane)" relay_hash="$(pod_hash sandbox-relay)"
[[ "$cp_hash" =~ ^[0-9a-f]{16}$ && "$relay_hash" =~ ^[0-9a-f]{16}$ && "$relay_hash" != "$cp_hash" ]] ||
  fail "want a settings hash on each pod template, each its own: control plane '$cp_hash', relay '$relay_hash'"
pass 'applies an overlay that renders with the namespace, three hosts, the image and a settings hash on each pod'

W="$GEN/workers/sbx_py312"
grep -qx 'RELAY_ADDR=sbx-attach.apps.example.invalid:443' "$W/worker.env" || fail 'worker bundle RELAY_ADDR'
grep -qx 'RELAY_TLS=true' "$W/worker.env" || fail 'worker bundle RELAY_TLS'
grep -qx "SANDBOX_TOKEN=$(secret_val moca-relay-sandbox-tokens sbx_py312)" "$W/worker.env" || fail 'worker bundle token'
grep -qx 'SH_WORKSPACE_IDLE=216h' "$W/worker.env" || fail 'worker bundle idle is not lifetime + 2 days'
grep -qx 'SH_WORKSPACE_IMAGE_MB=2048' "$W/worker.env" || fail 'worker bundle image size'
[[ -f "$W/relay-ca.crt" ]] || fail 'self-signed attach certificate not shipped in the worker bundle'
[[ "$(stat -c %a "$W/worker.env" 2>/dev/null || stat -f %Lp "$W/worker.env")" == 600 ]] || fail 'worker.env is not 0600'
pass 'writes 0600 worker bundles in the P6.2 format, with the idle derived from the lifetime and the image size'

# 2a. The janitor's token (spec §8.1): in moca-mu1 beside the signing key, in EVERY apply of that
# Secret (one field manager: an apply that omitted it would prune it), and bundled for the host in
# its own 0600 file -- never in janitor.env.
jtok="$(secret_val moca-mu1 SH_JANITOR_TOKEN)"
[[ "$jtok" =~ ^[0-9a-f]{64}$ ]] || fail 'no 64-hex SH_JANITOR_TOKEN in moca-mu1'
mu1_applies="$(grep '^secret moca-mu1 ' "$MOCK_STATE/applies.log")"
[[ -n "$mu1_applies" ]] || fail 'moca-mu1 was never applied'
! grep -vx 'secret moca-mu1 SH_JANITOR_TOKEN,SH_SESSION_TOKEN_PRIVATE_KEY' <<<"$mu1_applies" ||
  fail "an apply of moca-mu1 omits a key (server-side apply would prune it): $(sort -u <<<"$mu1_applies")"
JB="$GEN/janitor"
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
[[ -f "$JB/janitor.env" && -f "$JB/janitor.token" ]] || fail 'no janitor bundle (janitor.env + janitor.token)'
[[ "$(mode "$JB/janitor.env")" == 600 && "$(mode "$JB/janitor.token")" == 600 && "$(mode "$JB")" == 700 ]] ||
  fail "janitor bundle modes: dir $(mode "$JB"), env $(mode "$JB/janitor.env"), token $(mode "$JB/janitor.token")"
[[ "$(cat "$JB/janitor.token")" == "$jtok" && "$(wc -c <"$JB/janitor.token" | tr -d ' ')" == 64 ]] ||
  fail 'janitor.token is not exactly the Secret value (no newline)'
[[ "$(cat "$JB/janitor.env")" == $'SBX_API_URL=https://sbx-api.apps.example.invalid\nSBX_JANITOR_AGE=3600' ]] ||
  fail "janitor.env is not the API URL and the default wait (60 min at a 15 min TTL): $(cat "$JB/janitor.env")"
! grep -qF "$jtok" "$JB/janitor.env" || fail 'the janitor token is in janitor.env'
[[ ! -e "$JB/api-ca.crt" ]] || fail 'an API CA was bundled although SBX_API_CA_FILE is unset'
pass 'generates the janitor token in every moca-mu1 apply, and a 0600 janitor bundle with the token in its own file'

# 3. No token or key value ever reached argv or the log.
for v in "$(secret_val moca-relay-sandbox-tokens sbx_default)" "$(secret_val moca-relay SH_RELAY_TOKEN)" \
  "$(secret_val moca-redis REDIS_PASSWORD)" "$priv" "$jtok"; do
  ! grep -qF "$v" "$MOCK_LOG" || fail 'a token value appears in kubectl argv'
  ! grep -qF "$v" "$TMP/out" || fail 'a token value appears in the log'
done
pass 'no token or key reaches argv or the log'

# 4. Idempotent: a re-run keeps every token and key, and the settings hash.
before="$(state_hash)"
run_setup true || fail 'second run failed'
[[ "$before" == "$(state_hash)" ]] || fail 'a re-run changed a Secret value'
[[ "$(secret_val moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY)" == "$priv" ]] || fail 'a re-run rotated the signing key'
[[ "$(secret_val moca-mu1 SH_JANITOR_TOKEN)" == "$jtok" && "$(cat "$GEN/janitor/janitor.token")" == "$jtok" ]] ||
  fail 'a re-run rotated the janitor token'
render
[[ "$(pod_hash moca-control-plane)" == "$cp_hash" && "$(pod_hash sandbox-relay)" == "$relay_hash" ]] ||
  fail 'a settings hash moved on a re-run with the same inputs'
pass 'a re-run keeps every token, password, key and certificate, and the settings hash'

# 4a. A list separated by newlines or tabs is the same list: nothing is revoked, nothing rotates.
: >"$MOCK_LOG"
run_setup export SBX_WORKERS=$'sbx_default\n\tsbx_py312' || fail 'newline-separated run failed'
[[ "$before" == "$(state_hash)" ]] || fail 'a newline/tab-separated list changed or revoked a token'
! grep -q 'kubectl patch secret' "$MOCK_LOG" || fail 'a newline/tab-separated list revoked something'
grep -qx "SANDBOX_TOKEN=$(secret_val moca-relay-sandbox-tokens sbx_default)" "$GEN/workers/sbx_default/worker.env" ||
  fail 'the sbx_default bundle lost its token'
render
[[ "$(pod_hash moca-control-plane)" == "$cp_hash" ]] || fail 'the settings hash moved with only the list separators'
pass 'a newline- or tab-separated SBX_WORKERS keeps every token, and the settings hash is stable'

# 4b. A lifetime change alters the workers' SH_WORKSPACE_IDLE, which a running worker keeps until
# install-host.sh is re-run on its host: refused before anything is applied, unless acknowledged.
: >"$MOCK_LOG"
! run_setup export SBX_LIFETIME_DAYS=10 || fail 'a lifetime change was applied without SBX_ACK_HOSTS=1'
grep -q 'SH_WORKSPACE_IDLE changes from 216h to 288h' "$TMP/out" || fail 'the refusal does not name SH_WORKSPACE_IDLE and both values'
grep -q 'install-host.sh' "$TMP/out" || fail 'the refusal does not say to re-run install-host.sh'
grep -q 'SBX_ACK_HOSTS=1' "$TMP/out" || fail 'the refusal does not say how to acknowledge (SBX_ACK_HOSTS=1)'
grep -q 'sbx_default sbx_py312' "$TMP/out" || fail 'the refusal does not name the workers'
! grep -qE 'apply|patch|delete' "$MOCK_LOG" || fail 'the lifetime refusal changed something first'
[[ "$(cm sbx-settings SH_SANDBOX_LIFETIME_SECONDS)" == 604800 ]] || fail 'the refused lifetime reached sbx-settings'
grep -qx 'SH_WORKSPACE_IDLE=216h' "$GEN/workers/sbx_default/worker.env" || fail 'the refused run rewrote a bundle'
pass 'refuses a lifetime change that alters SH_WORKSPACE_IDLE without SBX_ACK_HOSTS=1, naming it and install-host.sh'

# Acknowledged: applied, with the hosts to reinstall named. The in-flight cap is the relay's too, so
# it moves the hash on both pods (the apply rolls them); the idle follows.
run_setup export SBX_LIFETIME_DAYS=10 SBX_MAX_INFLIGHT=4 SBX_ACK_HOSTS=1 || fail 'an acknowledged longer lifetime failed'
grep -q 'WARNING: SH_WORKSPACE_IDLE changes from 216h to 288h' "$TMP/out" || fail 'the acknowledged run does not warn'
grep -q 're-run deploy/sbx/install-host.sh now on the host of each of: sbx_default sbx_py312' "$TMP/out" ||
  fail 'the acknowledged run does not end by naming the hosts to reinstall'
[[ "$(cm sbx-settings SH_SANDBOX_LIFETIME_SECONDS)" == 864000 && "$(cm sbx-settings SH_SANDBOX_MAX_INFLIGHT)" == 4 ]] ||
  fail 'lifetime or in-flight cap not written'
grep -qx 'SH_WORKSPACE_IDLE=288h' "$GEN/workers/sbx_default/worker.env" || fail 'the idle does not follow the lifetime (10 d -> 288h)'
render
[[ "$(pod_hash moca-control-plane)" != "$cp_hash" && "$(pod_hash sandbox-relay)" != "$relay_hash" ]] ||
  fail 'a change to the in-flight cap did not move the hash on both pods'
pass 'with SBX_ACK_HOSTS=1 a lifetime change applies, warns, and the idle and the hash follow'

# A bundle from 1a carries no SH_WORKSPACE_IDLE: the refusal says that, not "SBX_LIFETIME_DAYS changed".
cp "$GEN/workers/sbx_default/worker.env" "$TMP/worker.env.keep"
grep -v '^SH_WORKSPACE_IDLE=' "$TMP/worker.env.keep" >"$GEN/workers/sbx_default/worker.env"
! run_setup export SBX_LIFETIME_DAYS=10 SBX_MAX_INFLIGHT=4 || fail 'a 1a bundle was overwritten without SBX_ACK_HOSTS=1'
grep -q 'changes from unset to 288h' "$TMP/out" && grep -q 'a bundle from before increment 1b' "$TMP/out" ||
  fail 'the refusal over a 1a bundle does not say the bundle predates 1b'
! grep -q 'SBX_LIFETIME_DAYS changed' "$TMP/out" || fail 'the refusal over a 1a bundle blames the lifetime'
cp "$TMP/worker.env.keep" "$GEN/workers/sbx_default/worker.env"
pass 'over a 1a bundle (no SH_WORKSPACE_IDLE) the refusal names the bundle, not the lifetime'

# An unchanged lifetime says nothing about hosts, and needs no ack.
run_setup export SBX_LIFETIME_DAYS=10 SBX_MAX_INFLIGHT=4 || fail 'a re-run with the same lifetime was refused'
! grep -q 'SH_WORKSPACE_IDLE' "$TMP/out" || fail 'an unchanged lifetime still warns about SH_WORKSPACE_IDLE'
pass 'an unchanged lifetime needs no ack and gives no warning'

run_setup export SBX_ACK_HOSTS=1 || fail 'the run back to the defaults failed'
render
[[ "$(pod_hash moca-control-plane)" == "$cp_hash" && "$(pod_hash sandbox-relay)" == "$relay_hash" ]] ||
  fail 'a hash is not a function of the settings'
pass 'the settings hashes are a function of the settings'

# 4b'. A template, subject or quota change is the control plane's alone: it rolls the control plane
# and not the relay, so running Execs survive it (RUNBOOK §5).
run_setup export SBX_TEMPLATES_FILE="$TMP/one.json" SBX_ALLOWED_SUBJECTS='github:1' SBX_MAX_PER_SUBJECT=7 ||
  fail 'a run with one template, one subject and a new quota failed'
render
[[ "$(pod_hash moca-control-plane)" != "$cp_hash" ]] || fail 'a template change did not move the control plane hash'
[[ "$(pod_hash sandbox-relay)" == "$relay_hash" ]] || fail 'a template, subject or quota change moved the relay hash'
run_setup true || fail 'the run back to the defaults failed'
pass 'a template, subject or quota change rolls the control plane and not the relay'

# 4c. The token lifetime and the retention are inputs, written in seconds, and in the hash.
run_setup export SBX_TOKEN_TTL_MINUTES=30 SBX_RETENTION_DAYS=30 || fail 'a run with a token TTL and retention failed'
[[ "$(cm sbx-settings SH_SANDBOX_TOKEN_TTL_SECONDS)" == 1800 ]] || fail 'SBX_TOKEN_TTL_MINUTES=30 is not 1800 s'
[[ "$(cm sbx-settings SH_SANDBOX_RETENTION_SECONDS)" == 2592000 ]] || fail 'SBX_RETENTION_DAYS=30 is not 2592000 s'
render
[[ "$(pod_hash moca-control-plane)" != "$cp_hash" ]] || fail 'the token TTL and retention are not in the settings hash'
grep -A4 -- '- name: SH_SANDBOX_TOKEN_TTL_SECONDS$' "$TMP/render.yaml" | grep -q 'name: sbx-settings' ||
  fail 'the control plane does not read SH_SANDBOX_TOKEN_TTL_SECONDS from sbx-settings'
grep -A4 -- '- name: SH_SANDBOX_RETENTION_SECONDS$' "$TMP/render.yaml" | grep -q 'name: sbx-settings' ||
  fail 'the control plane does not read SH_SANDBOX_RETENTION_SECONDS from sbx-settings'
run_setup true || fail 'the run back to the defaults failed'
render
[[ "$(pod_hash moca-control-plane)" == "$cp_hash" ]] || fail 'the hash did not return with the defaults'
pass 'SBX_TOKEN_TTL_MINUTES and SBX_RETENTION_DAYS reach sbx-settings in seconds, and move the hash'

# 4d. The janitor's wait (spec §8.1, §8.3): default max(60, TTL + 5) minutes, so the default at the
# longest token lifetime (60 min) is 65 min, not the refused 60; an explicit one must exceed TTL + 30 s.
run_setup export SBX_TOKEN_TTL_MINUTES=60 || fail 'the default janitor wait was refused at a 60 min token lifetime'
grep -qx 'SBX_JANITOR_AGE=3900' "$GEN/janitor/janitor.env" || fail "default wait at TTL 60 is not 65 min: $(cat "$GEN/janitor/janitor.env")"
run_setup export SBX_TOKEN_TTL_MINUTES=60 SBX_JANITOR_WAIT_MINUTES=61 || fail 'a 61 min wait was refused at a 60 min token lifetime'
grep -qx 'SBX_JANITOR_AGE=3660' "$GEN/janitor/janitor.env" || fail 'SBX_JANITOR_WAIT_MINUTES=61 is not 3660 s'
run_setup export SBX_JANITOR_WAIT_MINUTES=120 || fail 'a 120 min wait was refused'
grep -qx 'SBX_JANITOR_AGE=7200' "$GEN/janitor/janitor.env" || fail 'SBX_JANITOR_WAIT_MINUTES=120 is not 7200 s'
pass 'the janitor wait defaults to max(60, TTL + 5) min (65 at TTL 60), and an explicit one is written in seconds'

# 4e. An API CA (SBX_API_CA_FILE) for a Route certificate the host does not trust: bundled, then
# dropped from the bundle when unset again.
run_setup export SBX_API_CA_FILE="$GEN/attach-ca.crt" || fail 'a run with SBX_API_CA_FILE failed'
cmp -s "$GEN/attach-ca.crt" "$GEN/janitor/api-ca.crt" || fail 'SBX_API_CA_FILE is not bundled as api-ca.crt'
[[ "$(mode "$GEN/janitor/api-ca.crt")" == 600 ]] || fail 'api-ca.crt is not 0600'
run_setup true || fail 'the run without SBX_API_CA_FILE failed'
[[ ! -e "$GEN/janitor/api-ca.crt" ]] || fail 'a dropped SBX_API_CA_FILE leaves api-ca.crt in the bundle'
pass 'SBX_API_CA_FILE is bundled as api-ca.crt, and removed when unset'

# 5. Removing a worker revokes exactly it (with an explicit null patch, not apply pruning: the mock
# merges, as server-side apply keeps keys it did not set).
: >"$MOCK_LOG"
run_setup export SBX_WORKERS=sbx_default SBX_TEMPLATES_FILE="$TMP/one.json" || fail 'shrinking run failed'
[[ -z "$(secret_val moca-relay-sandbox-tokens sbx_py312)" ]] || fail 'sbx_py312 token not revoked'
[[ -n "$(secret_val moca-relay-sandbox-tokens sbx_default)" ]] || fail 'sbx_default token lost'
[[ ! -d "$GEN/workers/sbx_py312" ]] || fail 'stale worker bundle kept'
cm sbx-settings SH_SANDBOX_TEMPLATES | jq -e 'length == 1' >/dev/null || fail 'templates not narrowed'
grep -qE 'kubectl patch secret moca-relay-sandbox-tokens' "$MOCK_LOG" ||
  fail 'no kubectl patch secret call for moca-relay-sandbox-tokens (revocation not explicit)'
pass 'dropping a worker revokes its token and deletes its bundle (via explicit null patch)'

# 6. From 1a: the static client-token Secrets and bundles, and moca-relay's harness exec token, go.
printf '%s\n' '{"kind":"Secret","metadata":{"name":"sbx-relay-clients"},"data":{}}' >"$MOCK_STATE/secret-sbx-relay-clients.json"
printf '%s\n' '{"kind":"Secret","metadata":{"name":"sbx-relay-client-keys"},"data":{}}' >"$MOCK_STATE/secret-sbx-relay-client-keys.json"
mkdir -p "$GEN/clients/alice" && printf 'SBX_TOKEN=x\n' >"$GEN/clients/alice/client.env"
relay_tok="$(secret_val moca-relay SH_RELAY_TOKEN)"
jq --arg t "$(printf '%064d' 5 | base64 | tr -d '\n')" '.data.MOCA_RELAY_EXEC_TOKEN = $t' \
  "$MOCK_STATE/secret-moca-relay.json" >"$TMP/relay.json" && mv "$TMP/relay.json" "$MOCK_STATE/secret-moca-relay.json"
# A run that fails before the new relay is rolled out keeps the exec token: the 1a relay's template
# still requires it, and a pod restarted meanwhile would not start without it. The client-token
# Secrets may go at once: the 1a relay reads them through an optional reference.
: >"$MOCK_LOG"
! run_setup export MOCK_ROLLOUT_FAIL=deployment/sandbox-relay || fail 'a failed relay rollout was reported as success'
has_key moca-relay MOCA_RELAY_EXEC_TOKEN || fail 'the exec token was removed before the new relay rolled out'
! grep -q 'kubectl patch secret moca-relay ' "$MOCK_LOG" || fail 'moca-relay was patched although the relay rollout failed'
cp "$MOCK_LOG" "$TMP/failed-run.log"
: >"$MOCK_LOG"
run_setup true || fail 'the run over a 1a namespace failed'
awk '/^kubectl rollout status deployment\/sandbox-relay /{r = NR} /^kubectl patch secret moca-relay /{p = NR} END {exit !(r && p > r)}' "$MOCK_LOG" ||
  fail 'the exec token was not removed after the relay rollout succeeded'
[[ ! -f "$MOCK_STATE/secret-sbx-relay-clients.json" && ! -f "$MOCK_STATE/secret-sbx-relay-client-keys.json" ]] ||
  fail 'the 1a client-token Secrets were kept'
grep -qx 'kubectl delete secret sbx-relay-clients -n moca-sbx-test' "$TMP/failed-run.log" || fail 'sbx-relay-clients not deleted by name'
grep -qx 'kubectl delete secret sbx-relay-client-keys -n moca-sbx-test' "$TMP/failed-run.log" || fail 'sbx-relay-client-keys not deleted by name'
[[ ! -d "$GEN/clients" ]] || fail 'the 1a client bundles were kept'
! has_key moca-relay MOCA_RELAY_EXEC_TOKEN || fail 'the 1a harness exec token is still in moca-relay'
grep -q 'kubectl patch secret moca-relay -n moca-sbx-test --type=merge' "$MOCK_LOG" || fail 'the exec token was not removed with an explicit null patch'
[[ "$(secret_val moca-relay SH_RELAY_TOKEN)" == "$relay_tok" ]] || fail 'removing the exec token changed SH_RELAY_TOKEN'
! grep -qF "$(printf '%064d' 5)" "$MOCK_LOG" "$TMP/out" || fail 'the old exec token reached argv or the log'
: >"$MOCK_LOG"
run_setup true || fail 'the run after the 1a cleanup failed'
! grep -qE 'kubectl (delete|patch) secret' "$MOCK_LOG" || fail 'a clean namespace still deletes or patches something'
pass 'a 1a namespace loses its client-token Secrets and bundles, and the exec token only once the new relay is up'

# 7. Operator certificates: an issued exec certificate stops advertising a CA, and the API Route takes its own.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=Example Test CA' -keyout "$TMP/ca.key" -out "$TMP/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=sbx.apps.example.invalid' -keyout "$TMP/leaf.key" -out "$TMP/leaf.csr" >/dev/null 2>&1
openssl x509 -req -in "$TMP/leaf.csr" -CA "$TMP/ca.crt" -CAkey "$TMP/ca.key" -CAcreateserial -days 2 -out "$TMP/leaf.crt" >/dev/null 2>&1
: >"$MOCK_LOG"
run_setup export SBX_EXEC_TLS_CERT="$TMP/leaf.crt" SBX_EXEC_TLS_KEY="$TMP/leaf.key" \
  SBX_API_TLS_CERT="$TMP/leaf.crt" SBX_API_TLS_KEY="$TMP/leaf.key" || fail 'the run with operator certificates failed'
! jq -e '.data | has("SH_SANDBOX_EXEC_CA")' "$MOCK_STATE/configmap-sbx-settings.json" >/dev/null ||
  fail 'an issued exec certificate still advertises a CA'
P="$MOCK_STATE/route-sbx-api-patch.json"
jq -e '.spec.tls.certificate | contains("BEGIN CERTIFICATE")' "$P" >/dev/null || fail 'the API Route has no certificate'
jq -e '.spec.tls.key | contains("PRIVATE KEY")' "$P" >/dev/null || fail 'the API Route has no key'
grep -q 'kubectl patch route sbx-api .*--patch-file=' "$MOCK_LOG" || fail 'the API Route key was not patched from a file'
render
! grep -q 'PRIVATE KEY' "$TMP/render.yaml" "$GEN/kustomization.yaml" || fail 'the API key is in the applied overlay (and so in last-applied-configuration)'
! grep -rq 'PRIVATE KEY' "$GEN" || fail 'the API key was left on disk under .generated'
leaf_key_line="$(sed -n 2p "$TMP/leaf.key")"
! grep -qF "$leaf_key_line" "$MOCK_LOG" "$TMP/out" || fail 'the API key reached argv or the log'
run_setup true || fail 'the run back to the router certificate failed'
[[ "$(jq -c .spec.tls "$P")" == '{"certificate":null,"key":null}' ]] || fail 'a dropped API certificate stays on the Route'
pass 'an issued exec certificate advertises no CA; the API Route takes an operator certificate by a patch, never the overlay'

# 8. A token that reads back empty is never written into a bundle as `SANDBOX_TOKEN=`.
! run_setup export MOCK_BLANK_GET=moca-relay-sandbox-tokens || fail 'wrote a worker bundle with an empty token'
grep -q 'no token for worker sbx_default' "$TMP/out" || fail 'the empty-worker-token refusal does not name the id'
! grep -qx 'SANDBOX_TOKEN=' "$GEN/workers/sbx_default/worker.env" || fail 'worker bundle holds SANDBOX_TOKEN='
pass 'refuses, naming the id and no value, when a worker token reads back empty'

# 9. A failing `kubectl get` of a route certificate stops the run; it never reads as "no Secret",
# which would mint a new self-signed certificate and break the CA in every bundle already out.
run_setup true || fail 're-populate run failed'
before_tls="$(jq -S . "$MOCK_STATE/secret-moca-relay-tls.json")"
: >"$MOCK_LOG"
! run_setup export MOCK_FAIL_GET=moca-relay-tls || fail 'carried on past a failing kubectl get of moca-relay-tls'
! grep -q 'kubectl create secret tls moca-relay-tls' "$MOCK_LOG" || fail 'minted a new certificate after a failing kubectl get'
! grep -q 'kubectl apply -k' "$MOCK_LOG" || fail 'applied the stack after a failing kubectl get'
! grep -q 'self-signed one' "$TMP/out" || fail 'claimed to issue a self-signed certificate after a failing kubectl get'
[[ "$(jq -S . "$MOCK_STATE/secret-moca-relay-tls.json")" == "$before_tls" ]] || fail 'moca-relay-tls changed after a failing kubectl get'
pass 'a failing kubectl get of a route certificate fails the run and mints nothing'

# 10. An image pinned by digest: newName drops any tag (repo:tag@sha256:... renders invalid otherwise),
# and a registry port is not mistaken for a tag.
D="sha256:$(printf '%064d' 1)"
run_setup export SBX_IMAGE="ghcr.io/example/moca:sbx-1b@$D" || fail 'run with repo:tag@digest failed'
grep -qx '    newName: ghcr.io/example/moca' "$K" || fail "newName keeps the tag: $(grep newName "$K")"
grep -qx "    digest: $D" "$K" || fail 'digest not set'
! grep -q 'newTag' "$K" || fail 'newTag set alongside a digest'
render
grep -q "image: ghcr.io/example/moca@$D" "$TMP/render.yaml" || fail 'the digest-pinned image does not render as repo@digest'
run_setup export SBX_IMAGE="registry.example.invalid:5000/moca@$D" || fail 'run with host:port/repo@digest failed'
grep -qx '    newName: registry.example.invalid:5000/moca' "$K" || fail "newName lost the registry port: $(grep newName "$K")"
pass 'a digest-pinned image renders newName without the tag (and keeps a registry port)'

# 11. A failing `kubectl get` of moca-relay after the relay rolled fails the run; it never reads as
# "no exec token" and reports success with MOCA_RELAY_EXEC_TOKEN still in place.
rm -f "$MOCK_STATE/relay-rolled"
! run_setup export MOCK_FAIL_GET_LATE=moca-relay || fail 'carried on past a failing kubectl get of moca-relay'
! grep -q 'SBX0 ready' "$TMP/out" || fail 'reported ready after a failing kubectl get of moca-relay'
rm -f "$MOCK_STATE/relay-rolled"
pass 'a failing kubectl get of moca-relay in the exec-token cleanup fails the run'

# 12. A renewed attach or exec certificate rolls the relay: ghostunnel reads its certificate only at start.
openssl req -newkey rsa:2048 -nodes -subj '/CN=sbx.apps.example.invalid' -keyout "$TMP/leaf2.key" -out "$TMP/leaf2.csr" >/dev/null 2>&1
openssl x509 -req -in "$TMP/leaf2.csr" -CA "$TMP/ca.crt" -CAkey "$TMP/ca.key" -CAcreateserial -days 2 -out "$TMP/leaf2.crt" >/dev/null 2>&1
for pair in ATTACH EXEC; do
  run_setup export "SBX_${pair}_TLS_CERT=$TMP/leaf.crt" "SBX_${pair}_TLS_KEY=$TMP/leaf.key" || fail "the run with a $pair certificate failed"
  render
  h1="$(pod_hash sandbox-relay)"
  run_setup export "SBX_${pair}_TLS_CERT=$TMP/leaf2.crt" "SBX_${pair}_TLS_KEY=$TMP/leaf2.key" || fail "the run with a renewed $pair certificate failed"
  render
  [[ "$(pod_hash sandbox-relay)" != "$h1" ]] || fail "a renewed $pair certificate does not roll the relay"
done
pass 'a renewed attach or exec certificate moves the settings hash, so the relay rolls'

# 13. A moca-mu1 setup.sh did not write is refused: an SBX stack never signs with a MOCA control
# plane's key. One written before the label existed is adopted when sbx-token-keys already publishes it.
saved="$TMP/state-saved"
rm -rf "$saved"
cp -R "$MOCK_STATE" "$saved"
jq 'del(.metadata.labels)' "$MOCK_STATE/secret-moca-mu1.json" >"$TMP/mu1" && mv "$TMP/mu1" "$MOCK_STATE/secret-moca-mu1.json"
run_setup true || fail 'refused the pre-label moca-mu1 whose key sbx-token-keys already publishes'
[[ "$(secret_val moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY)" == "$priv" ]] || fail 'adopting the pre-label moca-mu1 rotated it'
jq -e '.metadata.labels["sbx.moca.dev/setup"] == "true"' "$MOCK_STATE/secret-moca-mu1.json" >/dev/null || fail 'the adopted moca-mu1 was not labelled'
openssl genpkey -algorithm ed25519 -outform DER -out "$TMP/foreign.der" 2>/dev/null
jq -n --arg k "$(base64 <"$TMP/foreign.der" | tr -d '\n' | base64 | tr -d '\n')" \
  '{apiVersion:"v1",kind:"Secret",metadata:{name:"moca-mu1"},data:{SH_SESSION_TOKEN_PRIVATE_KEY:$k}}' >"$MOCK_STATE/secret-moca-mu1.json"
before_keys="$(jq -S . "$MOCK_STATE/secret-sbx-token-keys.json")"
: >"$MOCK_LOG"
! run_setup true || fail 'signed with a moca-mu1 that setup.sh did not create'
grep -q 'moca-mu1 exists but was not created by deploy/sbx/setup.sh' "$TMP/out" || fail 'the foreign moca-mu1 refusal does not say why'
! grep -q 'kubectl apply -k' "$MOCK_LOG" || fail 'applied the stack with a foreign moca-mu1'
[[ "$(jq -S . "$MOCK_STATE/secret-sbx-token-keys.json")" == "$before_keys" ]] || fail 'published the foreign key'
rm -rf "$MOCK_STATE"
mv "$saved" "$MOCK_STATE"
pass 'refuses a moca-mu1 it did not create, and adopts its own from before the label'

# 14. Egress credentials (SBX0.2b, spec §4.3) behind SBX_EGRESS_CREDENTIALS=1.
reset_state() { rm -rf "$MOCK_STATE" "$GEN"; mkdir -p "$MOCK_STATE"; : >"$MOCK_LOG"; }
# A Secret's raw value (no trailing-newline stripping), for recomputing the settings hash.
raw_val() { jq -r --arg k "$2" '.data[$k] // empty' "$MOCK_STATE/secret-$1.json" | base64 --decode; }
# The set of Secret names ever applied, and the ConfigMap keys: what "the applied object set" means here.
applied_names() { awk '{print $1, $2}' "$MOCK_STATE/applies.log" | sort -u | tr '\n' ';'; }

# 14a. Off is byte-identical: the generated kustomization.yaml, both ConfigMaps, the applied object
# set and both hashes are today's, written out here as the golden copy (each recomputed from today's
# definition: the control plane's from every settings line, the relay's from its two, each with the
# keyset and the two route certificates).
reset_state
run_setup true || fail 'first run (egress off) failed'
HASH="$({
  printf '%s\n' 'SH_GITHUB_CLIENT_ID=Iv1.example' 'SH_ADMIN_SUBJECTS=github:1' 'SH_API_TOKEN_TTL_SECONDS=' 'SH_SESSION_TOKEN_TTL_SECONDS='
  printf '%s\n' 'SH_ALLOWED_SUBJECTS=github:1,github:2' "SH_SANDBOX_TEMPLATES=$(jq -c . "$TMP/templates.json")" \
    'SH_SANDBOX_EXEC_ENDPOINT=sbx-exec.apps.example.invalid:443' 'SH_SANDBOX_TOKEN_ISSUER=sbx-control-plane' \
    'SH_SANDBOX_LIFETIME_SECONDS=604800' 'SH_SANDBOX_TOKEN_TTL_SECONDS=900' 'SH_SANDBOX_RETENTION_SECONDS=1209600' \
    'SH_SANDBOX_MAX_PER_SUBJECT=3' 'SH_SANDBOX_MAX_TOTAL=40' 'SH_SANDBOX_MAX_INFLIGHT=2' "SH_SANDBOX_EXEC_CA=$(cat "$GEN/exec-ca.crt")"
  raw_val sbx-token-keys PUBLIC_KEYS
  raw_val moca-relay-tls tls.crt
  raw_val sbx-exec-tls tls.crt
} | openssl dgst -sha256 -hex | awk '{print substr($NF, 1, 16)}')"
RELAY_HASH="$({
  printf '%s\n' 'SH_SANDBOX_TOKEN_ISSUER=sbx-control-plane' 'SH_SANDBOX_MAX_INFLIGHT=2'
  raw_val sbx-token-keys PUBLIC_KEYS
  raw_val moca-relay-tls tls.crt
  raw_val sbx-exec-tls tls.crt
} | openssl dgst -sha256 -hex | awk '{print substr($NF, 1, 16)}')"
expected_off_kustomization() {
  cat <<GOLD
# GENERATED by deploy/sbx/setup.sh on every run. Do not edit; gitignored.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: moca-sbx-test
resources:
  - ../../k8s/overlays/ocp-sbx
patches:
  - target: { kind: Route, name: moca-relay }
    patch: |-
      - { op: replace, path: /spec/host, value: sbx-attach.apps.example.invalid }
  - target: { kind: Route, name: sbx-exec }
    patch: |-
      - { op: replace, path: /spec/host, value: sbx-exec.apps.example.invalid }
  - target: { kind: Route, name: sbx-api }
    patch: |-
      - { op: replace, path: /spec/host, value: sbx-api.apps.example.invalid }
  - target: { kind: Deployment, name: moca-control-plane }
    patch: |-
      - { op: add, path: /spec/template/metadata/annotations, value: { sbx.moca.dev/settings-hash: "$HASH" } }
  - target: { kind: Deployment, name: sandbox-relay }
    patch: |-
      - { op: add, path: /spec/template/metadata/annotations/sbx.moca.dev~1settings-hash, value: "$RELAY_HASH" }
images:
  - name: ghcr.io/rossoctl/moca
    newName: ghcr.io/example/moca
    newTag: sbx-1b
GOLD
}
diff <(expected_off_kustomization) "$K" >"$TMP/golden.diff" || { cat "$TMP/golden.diff" >&2; fail 'the generated kustomization.yaml with egress off is not today'"'"'s'; }
jq -e '.data | keys == ["SH_ADMIN_SUBJECTS","SH_API_TOKEN_TTL_SECONDS","SH_GITHUB_CLIENT_ID","SH_SESSION_TOKEN_TTL_SECONDS"]' \
  "$MOCK_STATE/configmap-moca-settings.json" >/dev/null || fail 'moca-settings keys changed with egress off'
jq -e '.data | keys == ["SH_ALLOWED_SUBJECTS","SH_SANDBOX_EXEC_CA","SH_SANDBOX_EXEC_ENDPOINT","SH_SANDBOX_LIFETIME_SECONDS","SH_SANDBOX_MAX_INFLIGHT","SH_SANDBOX_MAX_PER_SUBJECT","SH_SANDBOX_MAX_TOTAL","SH_SANDBOX_RETENTION_SECONDS","SH_SANDBOX_TEMPLATES","SH_SANDBOX_TOKEN_ISSUER","SH_SANDBOX_TOKEN_TTL_SECONDS"]' \
  "$MOCK_STATE/configmap-sbx-settings.json" >/dev/null || fail 'sbx-settings keys changed with egress off'
[[ "$(applied_names)" == 'configmap moca-settings;configmap sbx-settings;secret moca-mu1;secret moca-redis;secret moca-relay;secret moca-relay-sandbox-tokens;secret moca-relay-tls;secret sbx-exec-tls;secret sbx-token-keys;' ]] ||
  fail "the applied object set changed with egress off: $(applied_names)"
[[ ! -e "$MOCK_STATE/secret-sbx-egress.json" && ! -e "$GEN/egress" ]] || fail 'egress off left an sbx-egress Secret or bundle'
! grep -q 'sbx-egress' "$MOCK_LOG" || fail 'egress off touched sbx-egress'
cp "$K" "$TMP/off-kustomization.yaml"
run_setup export SBX_EGRESS_CREDENTIALS=0 SBX_EGRESS_HOSTS=ignored-while-off || fail 'SBX_EGRESS_CREDENTIALS=0 failed'
cmp -s "$TMP/off-kustomization.yaml" "$K" || fail 'SBX_EGRESS_CREDENTIALS=0 differs from unset'
pass 'egress off (unset or 0): kustomization.yaml, ConfigMaps, applied objects and both hashes are byte-identical to today'"'"'s'

# 14b. On: the KEK and one token per host in sbx-egress, generated once and kept; the bundle; the overlay.
EG=(export SBX_EGRESS_CREDENTIALS=1)
run_setup "${EG[@]}" || fail 'first egress run failed'
jq -e '.metadata.labels["sbx.moca.dev/setup"] == "true"' "$MOCK_STATE/secret-sbx-egress.json" >/dev/null || fail 'sbx-egress is not labelled'
kek="$(secret_val sbx-egress SH_CREDENTIAL_KEK)"
[[ "$(printf '%s' "$kek" | base64 --decode | wc -c | tr -d ' ')" == 32 && "$kek" != *$'\n'* ]] || fail 'SH_CREDENTIAL_KEK is not one line of base64 for 32 bytes'
etok="$(secret_val sbx-egress SH_EGRESS_TOKEN_KVM)"
[[ "$etok" =~ ^[0-9a-f]{64}$ ]] || fail 'no 64-hex token for the default host kvm'
[[ "$(jq -r '.data | keys | join(",")' "$MOCK_STATE/secret-sbx-egress.json")" == SH_CREDENTIAL_KEK,SH_EGRESS_TOKEN_KVM ]] || fail 'sbx-egress holds more than the KEK and kvm'"'"'s token'
[[ "$(cm sbx-settings SH_EGRESS_HOSTS)" == '[{"id":"kvm","workers":["sbx_default","sbx_py312"]}]' ]] ||
  fail "the default host is not kvm owning every worker: $(cm sbx-settings SH_EGRESS_HOSTS)"
! jq -e '.data | has("SH_EGRESS_CREDENTIAL_TTL_SECONDS")' "$MOCK_STATE/configmap-sbx-settings.json" >/dev/null || fail 'a TTL was written without being set'
! has_key moca-mu1 SH_CREDENTIAL_KEK || fail 'the KEK went into moca-mu1'
EB="$GEN/egress/kvm"
[[ "$(cat "$EB/egress.env")" == 'MOCA_EGRESS_CREDENTIALS_URL=https://sbx-api.apps.example.invalid' ]] || fail "egress.env: $(cat "$EB/egress.env")"
[[ "$(cat "$EB/egress.token")" == "$etok" && "$(wc -c <"$EB/egress.token" | tr -d ' ')" == 64 ]] || fail 'egress.token is not the token alone (64 bytes, no newline)'
[[ "$(mode "$GEN/egress/kvm")" == 700 && "$(mode "$EB/egress.env")" == 600 && "$(mode "$EB/egress.token")" == 600 ]] || fail 'egress bundle modes are not 0700/0600'
[[ ! -e "$EB/api-ca.crt" ]] || fail 'an API CA was bundled although SBX_API_CA_FILE is unset'
! grep -qF "$etok" "$EB/egress.env" || fail 'the host token is in egress.env'
grep -q "egress bundle: $GEN/egress/kvm" "$TMP/out" || fail 'the log does not name the egress bundle'
grep -q 'install-host.sh --egress' "$TMP/out" || fail 'the log does not name the copy-and-run step'
[[ "$(grep -c '^secret sbx-egress ' "$MOCK_STATE/applies.log")" -ge 1 && "$(grep '^secret sbx-egress ' "$MOCK_STATE/applies.log" | sort -u | wc -l | tr -d ' ')" == 1 ]] ||
  fail 'an apply of sbx-egress omits a key (server-side apply would prune it)'
for v in "$kek" "$etok"; do
  ! grep -qF "$v" "$MOCK_LOG" "$TMP/out" || fail 'the KEK or a host token reached argv or the log'
done
grep -q 'components:' "$K" && grep -q -- '- ../../k8s/overlays/ocp-sbx/egress-credentials' "$K" || fail 'the generated overlay does not include the credentials component'
render
grep -q 'name: moca-sbx-credentials' "$TMP/render.yaml" || fail 'the PVC does not render'
[[ "$(pod_hash moca-control-plane)" != "$HASH" ]] || fail 'turning egress on did not move the settings hash'
pass 'on: sbx-egress holds the KEK and the kvm token (labelled, in every apply), the bundle is 0700/0600, nothing secret reaches argv or the log'

before="$(state_hash)"
h_on="$(pod_hash moca-control-plane)"
run_setup "${EG[@]}" || fail 'egress re-run failed'
[[ "$before" == "$(state_hash)" ]] || fail 'an egress re-run changed a Secret value'
render
[[ "$(pod_hash moca-control-plane)" == "$h_on" ]] || fail 'the settings hash moved on an egress re-run'
pass 'a re-run keeps the KEK, the tokens and the settings hash'

# A new token rolls the control plane: same settings, different sbx-egress data, different hash.
jq 'del(.data.SH_EGRESS_TOKEN_KVM)' "$MOCK_STATE/secret-sbx-egress.json" >"$TMP/eg.json" && mv "$TMP/eg.json" "$MOCK_STATE/secret-sbx-egress.json"
run_setup "${EG[@]}" || fail 'regenerating a lost token failed'
[[ "$(secret_val sbx-egress SH_EGRESS_TOKEN_KVM)" =~ ^[0-9a-f]{64}$ && "$(secret_val sbx-egress SH_EGRESS_TOKEN_KVM)" != "$etok" ]] || fail 'the lost token was not regenerated'
[[ "$(secret_val sbx-egress SH_CREDENTIAL_KEK)" == "$kek" ]] || fail 'regenerating a token rotated the KEK'
render
[[ "$(pod_hash moca-control-plane)" != "$h_on" ]] || fail 'a new host token did not move the settings hash'
pass 'a new host token moves the settings hash, so the control plane rolls'

# The control plane's keksFromBase64 accepts a comma-separated ring, newest first: setup keeps it as is,
# and refuses a bad entry without telling the operator to delete a ring.
k1="$(openssl rand -base64 32 | tr -d '\n')"
k2="$(openssl rand -base64 32 | tr -d '\n')"
ring="$k1,$k2"
set_kek() { jq --arg v "$(printf '%s' "$1" | base64 | tr -d '\n')" '.data.SH_CREDENTIAL_KEK = $v' "$MOCK_STATE/secret-sbx-egress.json" >"$TMP/eg.json" && mv "$TMP/eg.json" "$MOCK_STATE/secret-sbx-egress.json"; }
set_kek "$ring"
run_setup "${EG[@]}" || fail 'a two-entry KEK ring was refused'
[[ "$(secret_val sbx-egress SH_CREDENTIAL_KEK)" == "$ring" ]] || fail 'a re-run rewrote the KEK ring'
set_kek "$k1,c2hvcnQ="
! run_setup "${EG[@]}" || fail 'a ring with a short entry was accepted'
grep -q 'SH_CREDENTIAL_KEK' "$TMP/out" || fail 'the refusal does not name SH_CREDENTIAL_KEK'
! grep -qi 'delete' "$TMP/out" || fail 'a ring refusal advises deleting the key'
[[ "$(secret_val sbx-egress SH_CREDENTIAL_KEK)" == "$k1,c2hvcnQ=" ]] || fail 'a refused ring was rewritten'
set_kek "$kek"
pass 'a KEK ring is kept across a re-run; a bad ring entry is refused with no deletion advice'

# 14c. Several hosts, a hyphenated id pinned to the TypeScript mapping (egressTokenEnvName), the TTL,
# the API CA; dropping a host revokes its token and deletes its bundle; the KEK and the others stay.
reset_state
MULTI='kvm-a=sbx_default;kvm-b=sbx_py312'
run_setup "${EG[@]}" SBX_EGRESS_HOSTS="$MULTI" SBX_EGRESS_CREDENTIAL_TTL_SECONDS=120 SBX_API_CA_FILE="$TMP/ca.crt" || fail 'the multi-host run failed'
has_key sbx-egress SH_EGRESS_TOKEN_KVM_A && has_key sbx-egress SH_EGRESS_TOKEN_KVM_B || fail 'kvm-a/kvm-b do not map to SH_EGRESS_TOKEN_KVM_A/_B'
[[ "$(cm sbx-settings SH_EGRESS_HOSTS)" == '[{"id":"kvm-a","workers":["sbx_default"]},{"id":"kvm-b","workers":["sbx_py312"]}]' ]] || fail "SH_EGRESS_HOSTS: $(cm sbx-settings SH_EGRESS_HOSTS)"
[[ "$(cm sbx-settings SH_EGRESS_CREDENTIAL_TTL_SECONDS)" == 120 ]] || fail 'the TTL did not reach sbx-settings'
ta="$(secret_val sbx-egress SH_EGRESS_TOKEN_KVM_A)" tb="$(secret_val sbx-egress SH_EGRESS_TOKEN_KVM_B)"
[[ "$ta" =~ ^[0-9a-f]{64}$ && "$tb" =~ ^[0-9a-f]{64}$ && "$ta" != "$tb" ]] || fail 'host tokens are not distinct 64-hex values'
[[ "$(cat "$GEN/egress/kvm-a/egress.token")" == "$ta" && "$(cat "$GEN/egress/kvm-b/egress.token")" == "$tb" ]] || fail 'a bundle carries the wrong host token'
cmp -s "$TMP/ca.crt" "$GEN/egress/kvm-a/api-ca.crt" && [[ "$(mode "$GEN/egress/kvm-a/api-ca.crt")" == 600 ]] || fail 'SBX_API_CA_FILE is not bundled as a 0600 api-ca.crt'
kek="$(secret_val sbx-egress SH_CREDENTIAL_KEK)"
: >"$MOCK_LOG"
run_setup "${EG[@]}" SBX_EGRESS_HOSTS='kvm-a=sbx_default,sbx_py312' || fail 'dropping a host failed'
! has_key sbx-egress SH_EGRESS_TOKEN_KVM_B || fail 'the dropped host'"'"'s token is still in sbx-egress'
[[ ! -e "$GEN/egress/kvm-b" ]] || fail 'the dropped host'"'"'s bundle is still on disk'
[[ "$(secret_val sbx-egress SH_EGRESS_TOKEN_KVM_A)" == "$ta" && "$(secret_val sbx-egress SH_CREDENTIAL_KEK)" == "$kek" ]] || fail 'dropping a host rotated the KEK or another token'
grep -q 'kubectl patch secret sbx-egress' "$MOCK_LOG" || fail 'the dropped token was not revoked by an explicit null patch'
! grep -qF "$tb" "$MOCK_LOG" "$TMP/out" || fail 'a token reached argv or the log'
pass 'several hosts: kvm-a -> SH_EGRESS_TOKEN_KVM_A, TTL and API CA reach their files, a dropped host loses its token and bundle'

# Off again: the Secret stays, the overlay loses the component.
run_setup true || fail 'turning egress off failed'
[[ "$(secret_val sbx-egress SH_EGRESS_TOKEN_KVM_A)" == "$ta" && "$(secret_val sbx-egress SH_CREDENTIAL_KEK)" == "$kek" ]] || fail 'turning egress off touched sbx-egress'
! grep -q 'egress' "$K" || fail 'the overlay still names egress after turning it off'
! jq -e '.data | has("SH_EGRESS_HOSTS")' "$MOCK_STATE/configmap-sbx-settings.json" >/dev/null || fail 'SH_EGRESS_HOSTS stays in sbx-settings after turning egress off'
pass 'turning egress off leaves sbx-egress in place and drops the component and the settings'

# 14d. Refusals, each before anything is applied.
egress_refusals=(
  'export SBX_EGRESS_CREDENTIALS=2 => SBX_EGRESS_CREDENTIALS must be unset, 0 or 1'
  'export SBX_EGRESS_CREDENTIALS=yes => SBX_EGRESS_CREDENTIALS must be unset, 0 or 1'
  'export SBX_EGRESS_HOSTS="a=sbx_default,sbx_default;b=sbx_py312" => worker .sbx_default. is listed twice'
  'export SBX_EGRESS_HOSTS="a=sbx_default;b=sbx_default,sbx_py312" => worker .sbx_default. is listed twice'
  'export SBX_EGRESS_HOSTS="a=sbx_default" => worker .sbx_py312. is not owned by any host'
  'export SBX_EGRESS_HOSTS="a=sbx_default,sbx_py312,sbx_other" => worker .sbx_other. is not in SBX_WORKERS'
  'export SBX_EGRESS_HOSTS="Kvm=sbx_default,sbx_py312" => host id .Kvm. must match'
  'export SBX_EGRESS_HOSTS="-a=sbx_default,sbx_py312" => host id .-a. must match'
  'export SBX_EGRESS_HOSTS="a=sbx_default;a=sbx_py312" => host id .a. is listed twice'
  'export SBX_EGRESS_HOSTS="a=sbx_default;;b=sbx_py312" => SBX_EGRESS_HOSTS has an empty entry'
  'export SBX_EGRESS_HOSTS="a=" => SBX_EGRESS_HOSTS entry .a=. lists no worker'
  'export SBX_EGRESS_HOSTS="a" => SBX_EGRESS_HOSTS entry .a. is not id=worker,worker'
  'export SBX_EGRESS_HOSTS="a=sbx_default, sbx_py312" => SBX_EGRESS_HOSTS must not contain whitespace'
  'export SBX_EGRESS_CREDENTIAL_TTL_SECONDS=4 => SBX_EGRESS_CREDENTIAL_TTL_SECONDS must be a whole number of seconds, 5-300'
  'export SBX_EGRESS_CREDENTIAL_TTL_SECONDS=301 => SBX_EGRESS_CREDENTIAL_TTL_SECONDS must be'
  'export SBX_EGRESS_CREDENTIAL_TTL_SECONDS=1m => SBX_EGRESS_CREDENTIAL_TTL_SECONDS must be'
)
for r in "${egress_refusals[@]}"; do
  bad="${r%% => *}" want="${r#* => }"
  reset_state
  ! run_setup eval "export SBX_EGRESS_CREDENTIALS=1; $bad" || fail "accepted: $bad"
  grep -Eq -- "$want" "$TMP/out" || fail "refused '$bad', but not with /$want/"
  ! grep -qE 'apply|patch|delete' "$MOCK_LOG" || fail "changed something before refusing: $bad"
done
# A worker in SBX_WORKERS with no template is not an egress worker (the control plane refuses it at boot):
# the default kvm host leaves it out, and naming it in SBX_EGRESS_HOSTS is refused before anything is applied.
reset_state
run_setup eval "export SBX_EGRESS_CREDENTIALS=1 SBX_WORKERS='sbx_default sbx_py312 sbx_nt'" || fail "non-template worker broke the default host: $(cat "$TMP/out")"
cm sbx-settings SH_EGRESS_HOSTS | jq -e '. == [{"id":"kvm","workers":["sbx_default","sbx_py312"]}]' >/dev/null || fail 'the default egress host owns a non-template worker'
reset_state
! run_setup eval "export SBX_EGRESS_CREDENTIALS=1 SBX_WORKERS='sbx_default sbx_py312 sbx_nt' SBX_EGRESS_HOSTS='a=sbx_default,sbx_py312,sbx_nt'" || fail 'accepted a non-template worker in SBX_EGRESS_HOSTS'
grep -q "worker 'sbx_nt' serves no template" "$TMP/out" || fail "non-template egress worker not named: $(cat "$TMP/out")"
! grep -qE 'apply|patch|delete' "$MOCK_LOG" || fail 'changed something before refusing a non-template egress worker'
pass 'egress hosts take only template workers: the default host skips others, an explicit one is refused'
pass 'refuses a bad switch, a worker listed twice or owned by no host, bad ids, bad separators and an out-of-range TTL'

# 15. The template store (template lifecycle spec §3.1, §6.1, §7.2) behind SBX_TEMPLATE_STORE=1.
reset_state
run_setup true || fail 'store off failed'
cp "$K" "$TMP/store-off.yaml"
run_setup export SBX_TEMPLATE_STORE=0 || fail 'SBX_TEMPLATE_STORE=0 failed'
cmp -s "$TMP/store-off.yaml" "$K" || fail 'SBX_TEMPLATE_STORE=0 differs from unset'
! grep -q 'template-store\|sbx-template-hosts' "$K" "$MOCK_LOG" || fail 'store off touched the store'
render
! grep -q 'moca-sbx-templates\|SH_PROVENANCE_DIR' "$TMP/render.yaml" || fail 'store off renders the store'
pass 'store off (unset or 0) changes nothing'

run_setup export SBX_TEMPLATE_STORE=1 || fail "store on without hosts failed: $(cat "$TMP/out")"
[[ "$(cm sbx-settings SH_TEMPLATE_HOSTS)" == '[]' ]] || fail "SH_TEMPLATE_HOSTS without hosts: $(cm sbx-settings SH_TEMPLATE_HOSTS)"
[[ -f "$MOCK_STATE/secret-sbx-template-hosts.json" ]] || fail 'store on without hosts applied no sbx-template-hosts (the credentials volume names it)'
[[ ! -e "$GEN/host-agent" ]] || fail 'store on without hosts wrote a host-agent bundle'
pass 'store on without hosts: no host, an empty sbx-template-hosts for the credentials volume, no bundle'

ST=(export SBX_TEMPLATE_STORE=1 SBX_TEMPLATE_HOSTS='kvm-a host-1')
run_setup "${ST[@]}" || fail "store on failed: $(cat "$TMP/out")"
grep -q -- '- ../../k8s/overlays/ocp-sbx/template-store' "$K" || fail 'the overlay does not include the template-store component'
[[ "$(cm sbx-settings SH_TEMPLATE_HOSTS)" == '[{"id":"kvm-a"},{"id":"host-1"}]' ]] || fail "SH_TEMPLATE_HOSTS: $(cm sbx-settings SH_TEMPLATE_HOSTS)"
ta="$(secret_val sbx-template-hosts SH_HOST_TOKEN_KVM_A)" tb="$(secret_val sbx-template-hosts SH_HOST_TOKEN_HOST_1)"
[[ "$ta" =~ ^[0-9a-f]{64}$ && "$tb" =~ ^[0-9a-f]{64}$ && "$ta" != "$tb" ]] || fail 'host tokens are not distinct 64-hex values'
jq -e '.metadata.labels["sbx.moca.dev/setup"] == "true"' "$MOCK_STATE/secret-sbx-template-hosts.json" >/dev/null || fail 'sbx-template-hosts is not labelled'
HB="$GEN/host-agent/kvm-a"
[[ "$(cat "$HB/host-agent.env")" == $'SBX_API_URL=https://sbx-api.apps.example.invalid\nSBX_HOST_ID=kvm-a' ]] || fail "host-agent.env: $(cat "$HB/host-agent.env")"
[[ "$(cat "$HB/host-agent.token")" == "$ta" && "$(mode "$HB")" == 700 && "$(mode "$HB/host-agent.token")" == 600 ]] || fail 'the host-agent bundle'
for v in "$ta" "$tb"; do ! grep -qF "$v" "$MOCK_LOG" "$TMP/out" "$HB/host-agent.env" || fail 'a host token reached argv, the log or the env file'; done
render
grep -q 'claimName: moca-sbx-templates' "$TMP/render.yaml" && grep -q 'value: /var/lib/moca/templates' "$TMP/render.yaml" || fail 'the store volume does not render'
grep -q 'name: sbx-template-hosts' "$TMP/render.yaml" || fail 'the host tokens are not mounted'
h1="$(pod_hash moca-control-plane)"
run_setup "${ST[@]}" || fail 'store re-run'
[[ "$(secret_val sbx-template-hosts SH_HOST_TOKEN_KVM_A)" == "$ta" ]] || fail 'a re-run rotated a host token'
render
[[ "$(pod_hash moca-control-plane)" == "$h1" ]] || fail 'a re-run moved the settings hash'
pass 'store on: the component, SH_TEMPLATE_HOSTS, a kept token per host (hyphen to underscore), 0700/0600 bundles, nothing secret in argv or the log, a re-run unchanged'

run_setup export SBX_TEMPLATE_STORE=1 SBX_TEMPLATE_HOSTS='kvm-a' || fail 'dropping a host failed'
! has_key sbx-template-hosts SH_HOST_TOKEN_HOST_1 || fail "the dropped host's token is still there"
[[ ! -e "$GEN/host-agent/host-1" ]] || fail "the dropped host's bundle is still there"
grep -q 'kubectl patch secret sbx-template-hosts' "$MOCK_LOG" || fail 'the dropped token was not revoked by a null patch'
render
[[ "$(pod_hash moca-control-plane)" != "$h1" ]] || fail 'revoking a host token did not roll the control plane'
pass 'a dropped host loses its token and bundle, and the control plane rolls'

# With egress too: both components, each with its own volume, and the credentials volume keeps
# every source.
run_setup export SBX_TEMPLATE_STORE=1 SBX_EGRESS_CREDENTIALS=1 || fail 'store with egress failed'
grep -q -- '- ../../k8s/overlays/ocp-sbx/egress-credentials' "$K" && grep -q -- '- ../../k8s/overlays/ocp-sbx/template-store' "$K" ||
  fail 'with egress and the store, the overlay does not list both components'
render
grep -q 'claimName: moca-sbx-templates' "$TMP/render.yaml" && grep -q 'claimName: moca-sbx-credentials' "$TMP/render.yaml" &&
  grep -q 'name: sbx-egress' "$TMP/render.yaml" && grep -q 'name: sbx-template-hosts' "$TMP/render.yaml" && grep -q 'name: moca-mu1' "$TMP/render.yaml" ||
  fail 'with egress and the store, a volume or a credentials source is missing'
pass 'with egress on as well, both volumes mount and the credentials volume mounts moca-mu1, sbx-egress and sbx-template-hosts'

# Turning it off drops the component and leaves the PVC: setup.sh deletes nothing of the store.
run_setup true || fail 'store off again failed'
! grep -q 'template-store' "$K" || fail 'the overlay still names the store after turning it off'
! grep -qE 'delete.*(pvc|persistentvolumeclaim).*moca-sbx-templates' "$MOCK_LOG" || fail 'turning the store off deleted its PVC'
pass 'turning the store off drops the component and leaves its PVC'

for r in 'export SBX_TEMPLATE_STORE=2 => SBX_TEMPLATE_STORE must be unset, 0 or 1' \
  'export SBX_TEMPLATE_STORE=yes => SBX_TEMPLATE_STORE must be unset, 0 or 1' \
  'export SBX_TEMPLATE_HOSTS=a => SBX_TEMPLATE_HOSTS needs SBX_TEMPLATE_STORE=1' \
  "export SBX_TEMPLATE_STORE=1 SBX_TEMPLATE_HOSTS='A' => template host id .A. must match" \
  "export SBX_TEMPLATE_STORE=1 SBX_TEMPLATE_HOSTS='a a' => listed twice"; do
  bad="${r%% => *}" want="${r#* => }"
  reset_state
  ! run_setup eval "$bad" || fail "accepted: $bad"
  grep -Eq -- "$want" "$TMP/out" || fail "refused '$bad', but not with /$want/"
  ! grep -qE 'apply|patch|delete' "$MOCK_LOG" || fail "changed something before refusing: $bad"
done
pass 'refuses a bad store switch, hosts without the store, a bad or repeated host id, before anything is applied'

# 16. SBX_REDIS_IMAGE: Redis 7 for data a Redis 7.4 wrote (Valkey 9 cannot read RDB format 12).
reset_state
R7='docker.io/redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499'
run_setup export SBX_REDIS_IMAGE="$R7" || fail "SBX_REDIS_IMAGE run failed: $(cat "$TMP/out")"
render
grep -q 'image: docker.io/redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499' "$TMP/render.yaml" || fail 'redis does not render as the pinned Redis 7'
! grep -q 'valkey/valkey' "$TMP/render.yaml" || fail 'valkey is still rendered with SBX_REDIS_IMAGE set'
reset_state
! run_setup export SBX_REDIS_IMAGE=docker.io/redis:7-alpine || fail 'accepted an unpinned SBX_REDIS_IMAGE'
grep -q 'SBX_REDIS_IMAGE must be pinned by digest' "$TMP/out" || fail 'the refusal does not say why'
! grep -qE 'apply|patch|delete' "$MOCK_LOG" || fail 'changed something before refusing SBX_REDIS_IMAGE'
pass 'SBX_REDIS_IMAGE renders Redis by digest in place of Valkey; an unpinned one is refused before anything is applied'

# 17. An existing Redis 7 namespace is never switched to Valkey by default (#811): Valkey 9 cannot read
# RDB format 12, and redis-0 would crash-loop. Refused before anything is applied, unless
# SBX_REDIS_IMAGE says which image to keep; a fresh namespace, or one on Valkey, is unaffected.
VK='docker.io/valkey/valkey:9-alpine@sha256:'"$(printf '%064d' 2)"
redis_sts() {
  jq -n --arg i "$1" '{apiVersion: "apps/v1", kind: "StatefulSet", metadata: {name: "redis"},
    spec: {template: {spec: {containers: [{name: "redis", image: $i}]}}}}' >"$MOCK_STATE/statefulset-redis.json"
}
for unset_it in 'unset SBX_REDIS_IMAGE' 'export SBX_REDIS_IMAGE='; do
  reset_state
  redis_sts "$R7"
  ! run_setup eval "$unset_it" || fail "switched a Redis 7 namespace to Valkey ($unset_it)"
  grep -qF "$R7" "$TMP/out" || fail "the Redis 7 refusal does not name the current image ($unset_it)"
  grep -q 'set SBX_REDIS_IMAGE to that image pinned by digest' "$TMP/out" || fail 'the Redis 7 refusal does not say to set SBX_REDIS_IMAGE'
  grep -q 'RUNBOOK.md §2' "$TMP/out" || fail 'the Redis 7 refusal does not point to RUNBOOK §2'
  ! grep -qE 'apply|patch|delete' "$MOCK_LOG" || fail 'changed something before refusing to switch Redis 7 to Valkey'
  [[ ! -f "$K" ]] || fail 'applied an overlay before refusing to switch Redis 7 to Valkey'
done
reset_state
redis_sts "$R7"
run_setup export SBX_REDIS_IMAGE="$R7" || fail "SBX_REDIS_IMAGE set to the running Redis 7 was refused: $(cat "$TMP/out")"
grep -qx '    newName: docker.io/redis' "$K" || fail 'SBX_REDIS_IMAGE did not reach the overlay'
reset_state
redis_sts "$VK"
run_setup true || fail "a namespace already on Valkey was refused: $(cat "$TMP/out")"
reset_state
redis_sts 'docker.io/valkey/valkey:9-alpine'
run_setup true || fail "a namespace on an unpinned Valkey was refused: $(cat "$TMP/out")"
reset_state
run_setup true || fail "a fresh namespace (no redis StatefulSet) was refused: $(cat "$TMP/out")"
grep -q 'kubectl get statefulset redis -n moca-sbx-test' "$MOCK_LOG" || fail 'setup.sh never read the redis StatefulSet'
reset_state
redis_sts "$VK"
! run_setup export MOCK_FAIL_GET=redis || fail 'carried on past a failing kubectl get of the redis StatefulSet'
! grep -qE 'apply|patch|delete' "$MOCK_LOG" || fail 'changed something after a failing kubectl get of the redis StatefulSet'
pass 'refuses to switch an existing non-Valkey redis StatefulSet to Valkey without SBX_REDIS_IMAGE, naming its image; Valkey, a fresh namespace or SBX_REDIS_IMAGE proceed'
