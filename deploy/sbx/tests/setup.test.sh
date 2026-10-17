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
  if [[ -f "$f" && "$3" == "${MOCK_BLANK_GET:-}" ]]; then jq -c 'del(.data)' "$f"; elif [[ -f "$f" ]]; then cat "$f"; fi
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
'delete secret')
  rm -f "$MOCK_STATE/secret-$3.json"
  exit 0 ;;
'apply -k')
  cp "$3/kustomization.yaml" "$MOCK_STATE/applied-kustomization.yaml"
  exit 0 ;;
'rollout status')
  # MOCK_ROLLOUT_FAIL=KIND/NAME: that rollout times out.
  [[ "$3" != "${MOCK_ROLLOUT_FAIL:-}" ]] || { echo "error: timed out waiting for the condition on $3" >&2; exit 1; }
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
[[ "$cp_hash" =~ ^[0-9a-f]{16}$ && "$relay_hash" == "$cp_hash" ]] ||
  fail "want one settings hash on both pod templates: control plane '$cp_hash', relay '$relay_hash'"
pass 'applies an overlay that renders with the namespace, three hosts, the image and one settings hash on both pods'

W="$GEN/workers/sbx_py312"
grep -qx 'RELAY_ADDR=sbx-attach.apps.example.invalid:443' "$W/worker.env" || fail 'worker bundle RELAY_ADDR'
grep -qx 'RELAY_TLS=true' "$W/worker.env" || fail 'worker bundle RELAY_TLS'
grep -qx "SANDBOX_TOKEN=$(secret_val moca-relay-sandbox-tokens sbx_py312)" "$W/worker.env" || fail 'worker bundle token'
grep -qx 'SH_WORKSPACE_IDLE=216h' "$W/worker.env" || fail 'worker bundle idle is not lifetime + 2 days'
grep -qx 'SH_WORKSPACE_IMAGE_MB=2048' "$W/worker.env" || fail 'worker bundle image size'
[[ -f "$W/relay-ca.crt" ]] || fail 'self-signed attach certificate not shipped in the worker bundle'
[[ "$(stat -c %a "$W/worker.env" 2>/dev/null || stat -f %Lp "$W/worker.env")" == 600 ]] || fail 'worker.env is not 0600'
pass 'writes 0600 worker bundles in the P6.2 format, with the idle derived from the lifetime and the image size'

# 3. No token or key value ever reached argv or the log.
for v in "$(secret_val moca-relay-sandbox-tokens sbx_default)" "$(secret_val moca-relay SH_RELAY_TOKEN)" \
  "$(secret_val moca-redis REDIS_PASSWORD)" "$priv"; do
  ! grep -qF "$v" "$MOCK_LOG" || fail 'a token value appears in kubectl argv'
  ! grep -qF "$v" "$TMP/out" || fail 'a token value appears in the log'
done
pass 'no token or key reaches argv or the log'

# 4. Idempotent: a re-run keeps every token and key, and the settings hash.
before="$(state_hash)"
run_setup true || fail 'second run failed'
[[ "$before" == "$(state_hash)" ]] || fail 'a re-run changed a Secret value'
[[ "$(secret_val moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY)" == "$priv" ]] || fail 'a re-run rotated the signing key'
render
[[ "$(pod_hash moca-control-plane)" == "$cp_hash" ]] || fail 'the settings hash moved on a re-run with the same inputs'
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

# Acknowledged: applied, with the hosts to reinstall named. A settings change moves the hash on both
# pods (so the apply rolls them); the idle follows.
run_setup export SBX_LIFETIME_DAYS=10 SBX_MAX_INFLIGHT=4 SBX_ACK_HOSTS=1 || fail 'an acknowledged longer lifetime failed'
grep -q 'WARNING: SH_WORKSPACE_IDLE changes from 216h to 288h' "$TMP/out" || fail 'the acknowledged run does not warn'
grep -q 're-run deploy/sbx/install-host.sh now on the host of each of: sbx_default sbx_py312' "$TMP/out" ||
  fail 'the acknowledged run does not end by naming the hosts to reinstall'
[[ "$(cm sbx-settings SH_SANDBOX_LIFETIME_SECONDS)" == 864000 && "$(cm sbx-settings SH_SANDBOX_MAX_INFLIGHT)" == 4 ]] ||
  fail 'lifetime or in-flight cap not written'
grep -qx 'SH_WORKSPACE_IDLE=288h' "$GEN/workers/sbx_default/worker.env" || fail 'the idle does not follow the lifetime (10 d -> 288h)'
render
[[ "$(pod_hash moca-control-plane)" != "$cp_hash" && "$(pod_hash sandbox-relay)" == "$(pod_hash moca-control-plane)" ]] ||
  fail 'a settings change did not move the hash on both pods'
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
[[ "$(pod_hash moca-control-plane)" == "$cp_hash" ]] || fail 'the hash is not a function of the settings'
pass 'the settings hash is a function of the settings'

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
render
awk '/^kind: Route$/,/^---$/' "$TMP/render.yaml" | grep -q 'BEGIN CERTIFICATE' || fail 'the API Route has no certificate'
awk '/^kind: Route$/,/^---$/' "$TMP/render.yaml" | grep -q 'BEGIN PRIVATE KEY' || fail 'the API Route has no key'
[[ "$(stat -c %a "$GEN/api-route-tls.json" 2>/dev/null || stat -f %Lp "$GEN/api-route-tls.json")" == 600 ]] ||
  fail 'the API Route key file is not 0600'
leaf_key_line="$(sed -n 2p "$TMP/leaf.key")"
! grep -qF "$leaf_key_line" "$MOCK_LOG" "$TMP/out" || fail 'the API key reached argv or the log'
run_setup true || fail 'the run back to the router certificate failed'
[[ ! -f "$GEN/api-route-tls.json" ]] || fail 'a dropped API certificate leaves its key file behind'
render
! awk '/^kind: Route$/,/^---$/' "$TMP/render.yaml" | grep -q 'BEGIN PRIVATE KEY' || fail 'a dropped API certificate is still rendered'
pass 'an issued exec certificate advertises no CA; the API Route takes an operator certificate, from a 0600 file'

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
