#!/usr/bin/env bash
# Cluster-free tests for deploy/sbx/setup.sh (SBX0 1a). kubectl is a mock on PATH that keeps Secrets
# as JSON files and logs every argv, so the tests can prove what was applied and that no token ever
# reached argv.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log" MOCK_STATE="$TMP/state"
mkdir -p "$TMP/bin" "$MOCK_STATE"

fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }

# A copy of the repo's deploy tree, so .generated/ lands in TMP.
REPO="$TMP/repo"
mkdir -p "$REPO/deploy"
cp -R "$SRC/deploy/sbx" "$REPO/deploy/sbx"
rm -rf "$REPO/deploy/sbx/.generated"
SETUP="$REPO/deploy/sbx/setup.sh"

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
  name="$(printf '%s' "$doc" | jq -r .metadata.name)"
  f="$MOCK_STATE/secret-$name.json"
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
'apply -k')
  cp "$3/kustomization.yaml" "$MOCK_STATE/applied-kustomization.yaml"
  exit 0 ;;
'rollout status') exit 0 ;;
esac
echo "mock kubectl: unhandled: $*" >&2
exit 1
MOCK
chmod +x "$TMP/bin/kubectl"
export PATH="$TMP/bin:$PATH"

base_env() {
  export SBX_NAMESPACE=moca-sbx-test SBX_ATTACH_HOST=sbx-attach.apps.example.invalid
  export SBX_EXEC_HOST=sbx-exec.apps.example.invalid SBX_IMAGE=ghcr.io/example/moca:sbx-1a
  export SBX_WORKERS='sbx_default sbx_py312' SBX_CLIENTS='alice bob'
}
run_setup() { (base_env; "$@"; bash "$SETUP") >"$TMP/out" 2>&1; }
secret_val() { jq -r --arg k "$2" '.data[$k] // empty' "$MOCK_STATE/secret-$1.json" | base64 --decode; }

# 1. Refusals, each before anything is applied.
for bad in 'unset SBX_NAMESPACE' 'export SBX_WORKERS=sbx-dash' 'export SBX_WORKERS=DIR' \
  'export SBX_WORKERS="a a"' 'export SBX_CLIENTS=Alice' 'export SBX_EXEC_HOST=$SBX_ATTACH_HOST' \
  'unset SBX_IMAGE' 'export SBX_CLIENTS=bob-x' 'export SBX_CLIENTS="bob bob-x"'; do
  : >"$MOCK_LOG"
  ! run_setup eval "$bad" || fail "accepted: $bad"
  ! grep -q 'apply' "$MOCK_LOG" || fail "applied something before refusing: $bad"
done
pass 'refuses missing or malformed inputs before applying anything'

# A '-' in a client name would let one client's key prefix (sbx-exec-bob-) cover another's keys.
! run_setup export SBX_CLIENTS='bob bob-x' || fail 'accepted client names bob and bob-x'
grep -q "client name 'bob-x' must match .* no '-'" "$TMP/out" || fail "the '-' refusal does not say why"
grep -q 'also prefix another client' "$TMP/out" || fail "the '-' refusal does not name the prefix collision"
pass "refuses a client name with '-' and says why (its key prefix would cover another client's keys)"

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
run_setup true || fail 'first run failed'
for s in moca-redis moca-relay moca-relay-sandbox-tokens sbx-relay-clients moca-relay-tls sbx-exec-tls; do
  [[ -f "$MOCK_STATE/secret-$s.json" ]] || fail "no Secret $s"
done
[[ "$(secret_val moca-relay-sandbox-tokens sbx_default)" =~ ^[0-9a-f]{64}$ ]] || fail 'no worker token for sbx_default'
[[ "$(secret_val moca-relay SH_RELAY_TOKEN)" != "$(secret_val moca-relay MOCA_RELAY_EXEC_TOKEN)" ]] || fail 'equal relay tokens'
clients="$(secret_val sbx-relay-clients MOCA_RELAY_CLIENT_TOKENS)"
[[ "$(printf '%s\n' "$clients" | tr ',' '\n' | wc -l | tr -d ' ')" == 2 ]] || fail "want 2 client entries (one per client): $clients"
printf '%s' "$clients" | tr ',' '\n' | grep -Eqx 'sbx_default:sbx-exec-bob-:[0-9a-f]{64}' || fail "no bob/sbx_default entry: $clients"
! printf '%s' "$clients" | grep -q 'sbx_py312:' || fail "a client token was minted for a worker no bundle names: $clients"
[[ "$(jq -r '.data | keys | join(" ")' "$MOCK_STATE/secret-sbx-relay-client-keys.json")" == 'alice.sbx_default bob.sbx_default' ]] ||
  fail "sbx-relay-client-keys holds more than the delivered pairs: $(jq -r '.data | keys | join(" ")' "$MOCK_STATE/secret-sbx-relay-client-keys.json")"
pass 'creates every Secret, one worker token per worker, one client token per client on the first worker only'

K="$MOCK_STATE/applied-kustomization.yaml"
grep -qx 'namespace: moca-sbx-test' "$K" || fail 'generated overlay has the wrong namespace'
grep -q 'value: sbx-attach.apps.example.invalid' "$K" || fail 'attach Route host not set'
grep -q 'value: sbx-exec.apps.example.invalid' "$K" || fail 'exec Route host not set'
grep -q 'newName: ghcr.io/example/moca' "$K" && grep -q 'newTag: sbx-1a' "$K" || fail 'image not set'
pass 'applies a generated overlay with the namespace, both hosts and the image'

# The relay reads MOCA_RELAY_CLIENT_TOKENS once, at boot: the overlay stamps its hash on the pod
# template so a changed client list rolls the relay.
tokens_hash() { # the annotation value in the applied overlay
  sed -n 's#.*path: /spec/template/metadata/annotations/sbx.moca.dev~1client-tokens-hash, value: "\([0-9a-f]*\)".*#\1#p' "$K"
}
grep -q 'target: { kind: Deployment, name: sandbox-relay }' "$K" || fail 'no patch targets the relay Deployment'
[[ "$(tokens_hash)" == "$(printf '%s' "$clients" | openssl dgst -sha256 -hex | awk '{print substr($NF, 1, 16)}')" ]] ||
  fail "the client-tokens-hash annotation is not the hash of MOCA_RELAY_CLIENT_TOKENS: $(tokens_hash)"
pass 'stamps the hash of the client tokens on the relay pod template'

W="$REPO/deploy/sbx/.generated/workers/sbx_py312"
grep -qx 'RELAY_ADDR=sbx-attach.apps.example.invalid:443' "$W/worker.env" || fail 'worker bundle RELAY_ADDR'
grep -qx 'RELAY_TLS=true' "$W/worker.env" || fail 'worker bundle RELAY_TLS'
grep -qx "SANDBOX_TOKEN=$(secret_val moca-relay-sandbox-tokens sbx_py312)" "$W/worker.env" || fail 'worker bundle token'
[[ -f "$W/relay-ca.crt" ]] || fail 'self-signed attach certificate not shipped in the worker bundle'
[[ "$(stat -c %a "$W/worker.env" 2>/dev/null || stat -f %Lp "$W/worker.env")" == 600 ]] || fail 'worker.env is not 0600'
C="$REPO/deploy/sbx/.generated/clients/alice/client.env"
grep -qx 'SBX_ADDR=sbx-exec.apps.example.invalid:443' "$C" || fail 'client bundle SBX_ADDR'
grep -qx 'SBX_WORKSPACE_KEY_PREFIX=sbx-exec-alice-' "$C" || fail 'client bundle prefix'
pass 'writes 0600 worker and client bundles in the P6.2 / prototype formats'

# 3. No token value ever reached argv.
for v in "$(secret_val moca-relay-sandbox-tokens sbx_default)" "$(secret_val moca-relay MOCA_RELAY_EXEC_TOKEN)" \
  "$(secret_val moca-redis REDIS_PASSWORD)"; do
  ! grep -qF "$v" "$MOCK_LOG" || fail 'a token value appears in kubectl argv'
done
printf '%s' "$clients" | tr ',' '\n' | cut -d: -f3 | while read -r t; do
  ! grep -qF "$t" "$MOCK_LOG" || fail 'a client token appears in kubectl argv'
  ! grep -qF "$t" "$TMP/out" || fail 'a client token appears in the log'
done
pass 'no token reaches argv or the log'

# 4. Idempotent: a re-run keeps every token.
before="$(cat "$MOCK_STATE"/secret-*.json | jq -S .data | sha256sum 2>/dev/null || cat "$MOCK_STATE"/secret-*.json | jq -S .data | shasum -a 256)"
run_setup true || fail 'second run failed'
after="$(cat "$MOCK_STATE"/secret-*.json | jq -S .data | sha256sum 2>/dev/null || cat "$MOCK_STATE"/secret-*.json | jq -S .data | shasum -a 256)"
[[ "$before" == "$after" ]] || fail 'a re-run changed a Secret value'
pass 'a re-run keeps every token, password and certificate'
hash_before="$(tokens_hash)"

# 4a. Lists separated by newlines or tabs are the same lists: nothing is revoked, nothing rotates.
: >"$MOCK_LOG"
run_setup export SBX_WORKERS=$'sbx_default\nsbx_py312' SBX_CLIENTS=$'alice\tbob' || fail 'newline-separated run failed'
after="$(cat "$MOCK_STATE"/secret-*.json | jq -S .data | sha256sum 2>/dev/null || cat "$MOCK_STATE"/secret-*.json | jq -S .data | shasum -a 256)"
[[ "$before" == "$after" ]] || fail 'a newline/tab-separated list changed or revoked a token'
! grep -q 'kubectl patch secret' "$MOCK_LOG" || fail 'a newline/tab-separated list revoked something'
grep -qx "SANDBOX_TOKEN=$(secret_val moca-relay-sandbox-tokens sbx_default)" "$REPO/deploy/sbx/.generated/workers/sbx_default/worker.env" ||
  fail 'the sbx_default bundle lost its token'
grep -qx 'SBX_SANDBOX_ID=sbx_default' "$REPO/deploy/sbx/.generated/clients/bob/client.env" || fail 'client bundle names the wrong worker'
[[ "$(tokens_hash)" == "$hash_before" ]] || fail 'the client-tokens hash moved on a re-run with the same inputs'
pass 'newline- or tab-separated SBX_WORKERS / SBX_CLIENTS keep every token, and the relay hash is stable'

# 4b. A token for a pair no bundle delivers (a client on a worker other than the first, as the
# all-pairs 1a script minted) is revoked on re-run with the explicit null patch.
jq --arg v "$(printf '%064d' 9 | base64 | tr -d '\n')" '.data["alice.sbx_py312"] = $v' \
  "$MOCK_STATE/secret-sbx-relay-client-keys.json" >"$TMP/k.json" && mv "$TMP/k.json" "$MOCK_STATE/secret-sbx-relay-client-keys.json"
: >"$MOCK_LOG"
run_setup true || fail 'run with an undelivered pair failed'
[[ -z "$(secret_val sbx-relay-client-keys alice.sbx_py312)" ]] || fail 'the undelivered alice.sbx_py312 token was not revoked'
[[ -n "$(secret_val sbx-relay-client-keys alice.sbx_default)" ]] || fail 'the delivered alice.sbx_default token was lost'
grep -q 'kubectl patch secret sbx-relay-client-keys' "$MOCK_LOG" || fail 'the undelivered pair was not revoked by an explicit null patch'
! secret_val sbx-relay-clients MOCA_RELAY_CLIENT_TOKENS | grep -q 'sbx_py312:' || fail 'the relay list still names sbx_py312'
pass 'revokes a client token on a worker other than the first (never delivered) on re-run'

# 5. Removing a worker or a client revokes exactly it (with explicit null patch, not apply pruning).
: >"$MOCK_LOG"
run_setup export SBX_WORKERS=sbx_default SBX_CLIENTS=alice || fail 'shrinking run failed'
[[ -z "$(secret_val moca-relay-sandbox-tokens sbx_py312)" ]] || fail 'sbx_py312 token not revoked'
[[ -n "$(secret_val moca-relay-sandbox-tokens sbx_default)" ]] || fail 'sbx_default token lost'
[[ ! -d "$REPO/deploy/sbx/.generated/workers/sbx_py312" ]] || fail 'stale worker bundle kept'
[[ ! -d "$REPO/deploy/sbx/.generated/clients/bob" ]] || fail 'stale client bundle kept'
[[ "$(secret_val sbx-relay-clients MOCA_RELAY_CLIENT_TOKENS)" =~ ^sbx_default:sbx-exec-alice-:[0-9a-f]{64}$ ]] ||
  fail 'client entries not narrowed to alice/sbx_default'
[[ -n "$(tokens_hash)" && "$(tokens_hash)" != "$hash_before" ]] || fail 'the client-tokens hash did not change with SBX_CLIENTS'
# Verify no bob.* keys remain in sbx-relay-client-keys (they were revoked).
[[ -z "$(printf '%s' "$(<"$MOCK_STATE/secret-sbx-relay-client-keys.json")" | jq -r '.data | keys[] | select(startswith("bob."))')" ]] ||
  fail 'bob.* keys not revoked from sbx-relay-client-keys'
# Verify the patch secret call was made (not relying on apply pruning).
grep -qE 'kubectl patch secret moca-relay-sandbox-tokens' "$MOCK_LOG" ||
  fail 'no kubectl patch secret call for moca-relay-sandbox-tokens (revocation not explicit)'
pass 'dropping a worker or client revokes its token and deletes its bundle (via explicit null patch)'

# 6. No clients (SBX_CLIENTS unset): run twice, must both succeed.
run_setup unset SBX_CLIENTS || fail 'run with no clients failed'
# Second run with no clients must succeed (sbx-relay-client-keys has no .data field after first run).
run_setup unset SBX_CLIENTS || fail 'second run with no clients failed'
# .data field must be absent (the Secret exists but has no keys).
[[ ! -f "$MOCK_STATE/secret-sbx-relay-client-keys.json" || -z "$(jq -r '.data // empty' "$MOCK_STATE/secret-sbx-relay-client-keys.json")" ]] ||
  fail 'sbx-relay-client-keys has a .data field after zero clients'
pass 'tolerates empty client list (no .data field on empty Secret)'

# 7. Clients → no clients: revokes all client keys, deletes client bundles, leaves MOCA_RELAY_CLIENT_TOKENS empty.
run_setup true || fail 're-populate clients run failed'
[[ -d "$REPO/deploy/sbx/.generated/clients/alice" ]] || fail 'client bundle not created'
run_setup unset SBX_CLIENTS || fail 'shrink to zero clients run failed'
# All client.* keys must be gone.
[[ -z "$(jq -r '.data // {} | keys[]' "$MOCK_STATE/secret-sbx-relay-client-keys.json" 2>/dev/null)" ]] ||
  fail 'client keys not all revoked'
[[ ! -d "$REPO/deploy/sbx/.generated/clients/alice" && ! -d "$REPO/deploy/sbx/.generated/clients/bob" ]] ||
  fail 'stale client bundles not deleted'
# MOCA_RELAY_CLIENT_TOKENS must be empty string (not null, to preserve the key).
[[ "$(secret_val sbx-relay-clients MOCA_RELAY_CLIENT_TOKENS)" == "" ]] ||
  fail 'MOCA_RELAY_CLIENT_TOKENS not empty after zero clients'
pass 'revokes all client tokens when SBX_CLIENTS becomes empty'

# 8. A token that reads back empty is never written into a bundle as `SANDBOX_TOKEN=`.
run_setup true || fail 're-populate run failed'
cp -R "$MOCK_STATE" "$TMP/state.keep"
! run_setup export MOCK_BLANK_GET=moca-relay-sandbox-tokens || fail 'wrote a worker bundle with an empty token'
grep -q 'no token for worker sbx_default' "$TMP/out" || fail 'the empty-worker-token refusal does not name the id'
! grep -qx 'SANDBOX_TOKEN=' "$REPO/deploy/sbx/.generated/workers/sbx_default/worker.env" || fail 'worker bundle holds SANDBOX_TOKEN='
rm -rf "$MOCK_STATE" && mv "$TMP/state.keep" "$MOCK_STATE"
! run_setup export MOCK_BLANK_GET=sbx-relay-client-keys || fail 'wrote a client bundle with an empty token'
grep -q 'no token for client alice on sbx_default' "$TMP/out" || fail 'the empty-client-token refusal does not name the id'
for v in $(jq -r '.data[]' "$MOCK_STATE/secret-sbx-relay-client-keys.json" | while read -r b; do printf '%s\n' "$b" | base64 --decode; echo; done); do
  ! grep -qF "$v" "$TMP/out" || fail 'the refusal printed a token value'
done
pass 'refuses, naming the id and no value, when a worker or client token reads back empty'

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
run_setup export SBX_IMAGE="ghcr.io/example/moca:sbx-1a@$D" || fail 'run with repo:tag@digest failed'
grep -qx '    newName: ghcr.io/example/moca' "$K" || fail "newName keeps the tag: $(grep newName "$K")"
grep -qx "    digest: $D" "$K" || fail 'digest not set'
! grep -q 'newTag' "$K" || fail 'newTag set alongside a digest'
run_setup export SBX_IMAGE="registry.example.invalid:5000/moca@$D" || fail 'run with host:port/repo@digest failed'
grep -qx '    newName: registry.example.invalid:5000/moca' "$K" || fail "newName lost the registry port: $(grep newName "$K")"
pass 'a digest-pinned image renders newName without the tag (and keeps a registry port)'
