#!/usr/bin/env bash
# deploy/sbx/setup.sh -- install or update SBX0 (the sandbox relay, Redis and the sandbox control
# plane) in one namespace of a shared OpenShift cluster
# (docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md §8.1).
#
#   deploy/sbx/setup.sh [--env-file FILE]
#
# Inputs (environment, or FILE sourced with `set -a`):
#   SBX_NAMESPACE           required; must exist
#   SBX_ATTACH_HOST, SBX_EXEC_HOST, SBX_API_HOST
#                           required; three distinct DNS names (one Route, one certificate each)
#   SBX_IMAGE               required; the relay and control-plane image
#   SBX_WORKERS             required; the template worker ids, whitespace-separated
#   SBX_GITHUB_CLIENT_ID    required; the deployment's own GitHub OAuth app (device-flow login)
#   SBX_ALLOWED_SUBJECTS    required; comma-separated github:<numeric id>, who may log in
#   SBX_ADMIN_SUBJECTS      optional; comma-separated github:<numeric id>
#   SBX_TEMPLATES_FILE      required; JSON list [{id, worker, description, tools}], every worker in
#                           SBX_WORKERS
#   SBX_WORKSPACE_FS_GIB    required; the KVM host's workspace filesystem size, for the disk check
#   SBX_LIFETIME_DAYS       optional; 1-30, default 7. A change alters every worker's
#                           SH_WORKSPACE_IDLE, which running workers keep until install-host.sh is
#                           re-run on their host: the run refuses unless SBX_ACK_HOSTS=1
#   SBX_TOKEN_TTL_MINUTES   optional; 5-60, default 15: the sandbox token's lifetime
#   SBX_RETENTION_DAYS      optional; 1-90, default 14: how long a terminated sandbox stays listed
#   SBX_MAX_PER_SUBJECT, SBX_MAX_TOTAL   optional; live-sandbox quotas, default 3 and 40
#   SBX_MAX_INFLIGHT        optional; 1-8, default 2: Execs one sandbox may have in flight
#   SBX_WORKSPACE_IMAGE_MB  optional; default 2048 (microvm-worker's SH_WORKSPACE_IMAGE_MB)
#   SBX_{ATTACH,EXEC,API}_TLS_{CERT,KEY}   optional; otherwise self-signed (attach, exec) or the
#                           router's default certificate (API)
# SBX_CLIENTS, increment 1a's static client tokens, is gone and refused.
#
# Re-runnable: every token, password, key and certificate is generated once and kept. A worker
# dropped from SBX_WORKERS has its token revoked and its bundle deleted; the relay reads worker
# tokens on each attach, so that acts at once. Both pods read everything else only at boot, so the
# generated overlay stamps a hash of the settings and the public keyset on both pod templates, and
# any change to them rolls both. Secret values never reach argv or the log: they travel through jq's
# environment or a builtin printf into a pipe, and messages name keys only.
#
# Writes deploy/sbx/.generated/: the applied overlay and workers/<id>/ (worker.env [+ relay-ca.crt],
# for deploy/sbx/install-host.sh on the KVM host). Copy each bundle straight to its host and delete
# the copy. Users log in with `mocactl sbx login`; nothing here is handed to them.
set -euo pipefail

SBX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="$SBX_DIR/.generated"
OVERLAY_REL=../../k8s/overlays/ocp-sbx # from $GEN
HOSTS_TO_REINSTALL='' # workers whose SH_WORKSPACE_IDLE this run changes (check_host_idle)

log() { printf '==> %s\n' "$*" >&2; }
die() { echo "deploy/sbx/setup.sh: $*" >&2; exit 1; }
kc() { kubectl "$@"; }

parse_args() {
  while (($#)); do
    case "$1" in
    --env-file)
      [[ $# -ge 2 && -f "$2" ]] || die '--env-file needs a readable file'
      set -a
      # shellcheck disable=SC1090 # the operator's own settings file
      . "$2"
      set +a
      shift 2
      ;;
    *) die "unknown argument: $1 (usage: setup.sh [--env-file FILE])" ;;
    esac
  done
}

WORKER_RE='^[A-Za-z_][A-Za-z0-9_]*$'
SUBJECTS_RE='^github:[0-9]+(,github:[0-9]+)*$'
# Positive whole numbers. The disk check multiplies SBX_MAX_TOTAL x SBX_WORKSPACE_IMAGE_MB x 10 and
# SBX_WORKSPACE_FS_GIB x 1024 x 8 in 64-bit shell arithmetic: six digits for the factors of the first
# (< 10^13) and nine for the filesystem size (< 10^13) keep both far from wrapping.
COUNT6_RE='^[1-9][0-9]{0,5}$'
COUNT9_RE='^[1-9][0-9]{0,8}$'
HOST_RE='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
NS_RE='^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'

validate() {
  [[ -z "${SBX_CLIENTS:-}" ]] ||
    die 'SBX_CLIENTS was increment 1a (static client tokens) and is gone: unset it; users now run `mocactl sbx login`'
  [[ "${SBX_NAMESPACE:-}" =~ $NS_RE ]] || die 'SBX_NAMESPACE is required and must be a namespace name'
  [[ "${SBX_ATTACH_HOST:-}" =~ $HOST_RE ]] || die 'SBX_ATTACH_HOST is required and must be a DNS name'
  [[ "${SBX_EXEC_HOST:-}" =~ $HOST_RE ]] || die 'SBX_EXEC_HOST is required and must be a DNS name'
  [[ "$SBX_ATTACH_HOST" != "$SBX_EXEC_HOST" ]] || die 'SBX_ATTACH_HOST and SBX_EXEC_HOST must differ (one certificate each)'
  [[ -n "${SBX_IMAGE:-}" && "$SBX_IMAGE" != *[[:space:]]* ]] || die 'SBX_IMAGE is required (the relay image)'
  [[ -n "${SBX_WORKERS:-}" ]] || die 'SBX_WORKERS is required: the template worker ids, space-separated'
  local seen=' ' w
  for w in $SBX_WORKERS; do
    [[ "$w" =~ $WORKER_RE ]] || die "worker id '$w' must match $WORKER_RE (the relay looks it up by name)"
    [[ "$w" != DIR ]] || die "worker id 'DIR' is reserved (SH_RELAY_TOKEN_DIR)"
    [[ "$seen" != *" $w "* ]] || die "worker id '$w' is listed twice"
    seen+="$w "
  done
  # One space between ids from here on: every later membership test (" $SBX_WORKERS " == *" $k "*)
  # matches spaces only, so a newline- or tab-separated list would read every id as stale and revoke it.
  # shellcheck disable=SC2086 # split on any whitespace; the ids are validated identifiers
  SBX_WORKERS="$(printf '%s ' $SBX_WORKERS)"
  SBX_WORKERS="${SBX_WORKERS% }"
  # A whitespace-only list normalises to nothing, and would revoke every worker token.
  [[ -n "$SBX_WORKERS" ]] || die 'SBX_WORKERS is required: the template worker ids, space-separated (it holds only whitespace)'

  [[ "${SBX_API_HOST:-}" =~ $HOST_RE ]] || die 'SBX_API_HOST is required and must be a DNS name'
  [[ "$SBX_API_HOST" != "$SBX_ATTACH_HOST" && "$SBX_API_HOST" != "$SBX_EXEC_HOST" ]] ||
    die 'SBX_API_HOST must differ from the attach and exec hosts'
  [[ "${SBX_GITHUB_CLIENT_ID:-}" =~ ^[A-Za-z0-9._-]+$ ]] ||
    die 'SBX_GITHUB_CLIENT_ID is required (the GitHub OAuth app for device-flow login)'
  [[ "${SBX_ALLOWED_SUBJECTS:-}" =~ $SUBJECTS_RE ]] ||
    die 'SBX_ALLOWED_SUBJECTS is required: comma-separated github:<numeric id>, no spaces'
  [[ -z "${SBX_ADMIN_SUBJECTS:-}" || "$SBX_ADMIN_SUBJECTS" =~ $SUBJECTS_RE ]] ||
    die 'SBX_ADMIN_SUBJECTS must be comma-separated github:<numeric id>, no spaces'

  : "${SBX_LIFETIME_DAYS:=7}" "${SBX_MAX_PER_SUBJECT:=3}" "${SBX_MAX_TOTAL:=40}" "${SBX_MAX_INFLIGHT:=2}"
  : "${SBX_WORKSPACE_IMAGE_MB:=2048}" "${SBX_TOKEN_TTL_MINUTES:=15}" "${SBX_RETENTION_DAYS:=14}"
  [[ "$SBX_LIFETIME_DAYS" =~ ^([1-9]|[12][0-9]|30)$ ]] || die 'SBX_LIFETIME_DAYS must be a whole number of days, 1-30'
  [[ "$SBX_TOKEN_TTL_MINUTES" =~ ^([5-9]|[1-5][0-9]|60)$ ]] || die 'SBX_TOKEN_TTL_MINUTES must be a whole number of minutes, 5-60'
  [[ "$SBX_RETENTION_DAYS" =~ ^([1-9]|[1-8][0-9]|90)$ ]] || die 'SBX_RETENTION_DAYS must be a whole number of days, 1-90'
  TOKEN_TTL_S=$((SBX_TOKEN_TTL_MINUTES * 60))
  RETENTION_S=$((SBX_RETENTION_DAYS * 86400))
  [[ "$SBX_MAX_INFLIGHT" =~ ^[1-8]$ ]] || die 'SBX_MAX_INFLIGHT must be 1-8'
  local v
  for v in SBX_MAX_PER_SUBJECT SBX_MAX_TOTAL SBX_WORKSPACE_IMAGE_MB; do
    [[ "${!v:-}" =~ $COUNT6_RE ]] || die "$v must be a positive whole number of at most six digits"
  done
  [[ "${SBX_WORKSPACE_FS_GIB:-}" =~ $COUNT9_RE ]] ||
    die 'SBX_WORKSPACE_FS_GIB must be a positive whole number of at most nine digits'
  # Workspace disk is not admission-controlled on the worker (SBX0 §5.3): the total quota is the
  # disk control, so every live sandbox's image must fit in 80 % of the workspace filesystem.
  ((SBX_MAX_TOTAL * SBX_WORKSPACE_IMAGE_MB * 10 <= SBX_WORKSPACE_FS_GIB * 1024 * 8)) ||
    die "SBX_MAX_TOTAL ($SBX_MAX_TOTAL) x SBX_WORKSPACE_IMAGE_MB ($SBX_WORKSPACE_IMAGE_MB) exceeds 80% of SBX_WORKSPACE_FS_GIB ($SBX_WORKSPACE_FS_GIB GiB)"
  # SBX0 §5.4: the worker's idle reclaim outlasts the sandbox, so it never reclaims a live one.
  LIFETIME_S=$((SBX_LIFETIME_DAYS * 86400))
  WORKSPACE_IDLE_H=$((SBX_LIFETIME_DAYS * 24 + 48))
  ((WORKSPACE_IDLE_H * 3600 > LIFETIME_S)) || die 'SH_WORKSPACE_IDLE must exceed SH_SANDBOX_LIFETIME_SECONDS'
  check_host_idle

  validate_templates

  local pair
  for pair in ATTACH EXEC API; do
    local cert="SBX_${pair}_TLS_CERT" key="SBX_${pair}_TLS_KEY"
    [[ -z "${!cert:-}" && -z "${!key:-}" ]] || [[ -f "${!cert:-/nonexistent}" && -f "${!key:-/nonexistent}" ]] ||
      die "$cert and $key must both name readable files, or both be unset"
  done
  NS="$SBX_NAMESPACE"
}

# The control plane rolls with a new lifetime at once, but a running worker keeps the
# SH_WORKSPACE_IDLE it was installed with until install-host.sh is re-run on its host. Raising the
# lifetime past that idle would let a worker reclaim a live sandbox's workspace (SBX0 §5.4), so a
# change against the bundles last written (the proxy for what the hosts run) is refused, before
# anything is applied, unless the operator acknowledges it with SBX_ACK_HOSTS=1.
check_host_idle() {
  local env id old changed='' olds=''
  for env in "$GEN"/workers/*/worker.env; do
    [[ -f "$env" ]] || continue
    id="$(basename "$(dirname "$env")")"
    [[ " $SBX_WORKERS " == *" $id "* ]] || continue # dropped: its token is revoked, it cannot attach
    old="$( (grep -E '^SH_WORKSPACE_IDLE=' "$env" || true) | tail -1 | cut -d= -f2-)"
    [[ "$old" != "${WORKSPACE_IDLE_H}h" ]] || continue
    changed+=" $id"
    [[ " $olds " == *" ${old:-unset} "* ]] || olds+=" ${old:-unset}"
  done
  [[ -n "$changed" ]] || return 0
  HOSTS_TO_REINSTALL="${changed# }"
  local cause='SBX_LIFETIME_DAYS changed'
  [[ " $olds " != *" unset "* ]] || cause='a bundle from before increment 1b carries none'
  if [[ "${SBX_ACK_HOSTS:-}" != 1 ]]; then
    die "SH_WORKSPACE_IDLE changes from${olds} to ${WORKSPACE_IDLE_H}h for worker(s) ${HOSTS_TO_REINSTALL} (${cause}), and a running worker keeps its old value until deploy/sbx/install-host.sh is re-run on its host. Re-run install-host.sh on every host first, or set SBX_ACK_HOSTS=1 to apply now and re-run install-host.sh with the new bundles on every host right after"
  fi
  log "WARNING: SH_WORKSPACE_IDLE changes from${olds} to ${WORKSPACE_IDLE_H}h (SBX_ACK_HOSTS=1): re-run deploy/sbx/install-host.sh with the new bundle on the host of each of: ${HOSTS_TO_REINSTALL}"
}

# The rules of the control plane's parseTemplates (packages/control-plane/src/sandbox-config.ts),
# checked here so a bad file is refused before anything is applied rather than as a pod that never
# boots; plus SBX0 §8.1's: every template's worker is in SBX_WORKERS, one template per worker.
validate_templates() {
  [[ -f "${SBX_TEMPLATES_FILE:-/nonexistent}" ]] ||
    die 'SBX_TEMPLATES_FILE is required: a JSON list of {id, worker, description, tools}'
  jq -e --arg wre "$WORKER_RE" 'type == "array" and length > 0 and all(.[];
      type == "object"
      and (.id | type == "string" and test("^[a-z0-9][a-z0-9-]{0,30}$"))
      and (.worker | type == "string" and test($wre) and . != "DIR")
      and (.description | type == "string")
      and (.tools | type == "array" and all(.[]; type == "string") and (unique | length) == length))
    and ([.[].id] | unique | length) == length' "$SBX_TEMPLATES_FILE" >/dev/null 2>&1 ||
    die "$SBX_TEMPLATES_FILE is not a non-empty list of {id, worker, description, tools}: ids [a-z0-9-] and unique, tools a list of distinct strings"
  local tw seen=' '
  for tw in $(jq -r '.[].worker' "$SBX_TEMPLATES_FILE"); do
    [[ " $SBX_WORKERS " == *" $tw "* ]] || die "template worker '$tw' is not in SBX_WORKERS"
    [[ "$seen" != *" $tw "* ]] || die "template worker '$tw' serves two templates (one worker per template)"
    seen+="$tw "
  done
  TEMPLATES_JSON="$(jq -c . "$SBX_TEMPLATES_FILE")"
}

preflight() {
  local t
  for t in kubectl jq openssl; do command -v "$t" >/dev/null || die "needs $t on PATH"; done
  local probe
  probe="$(mktemp -d)"
  openssl genpkey -algorithm ed25519 -out "$probe/k.pem" >/dev/null 2>&1 ||
    { rm -rf "$probe"; die "this openssl ($(openssl version 2>/dev/null)) cannot make Ed25519 keys: use OpenSSL 1.1.1 or later (macOS: brew install openssl@3)"; }
  rm -rf "$probe"
  # Namespace-scoped read: a shared cluster rarely grants `get namespace`, and this never creates one.
  kc get configmaps -n "$NS" -o name >/dev/null 2>&1 ||
    die "namespace $NS must already exist and be readable (this script creates nothing cluster-scoped)"
}

secret_json() { kc get secret "$1" -n "$NS" --ignore-not-found -o json; }
json_value() { printf '%s' "$1" | jq -r --arg k "$2" '.data[$k] // empty' | base64 --decode; }
rand_hex() { openssl rand -hex 32; }

# apply_secret NAME KEY...: the values are $S_0, $S_1, ... in the caller's (sub)shell environment;
# jq reads them from its environment, so no value reaches argv. Server-side apply with one field
# manager. Revocation (when a key is no longer listed) is handled by an explicit null patch after,
# never by relying on pruning stringData keys.
apply_secret() {
  local name="$1"
  shift
  jq -n --arg name "$name" --arg ns "$NS" \
    '{apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: {name: $name, namespace: $ns},
      stringData: ([$ARGS.positional | to_entries[] | {key: .value, value: env["S_\(.key)"]}] | from_entries)}' \
    --args "$@" | kc apply --server-side --force-conflicts --field-manager=sbx-setup -f - >/dev/null
}

ensure_redis_secret() {
  local json pw
  json="$(secret_json moca-redis)"
  pw="$(json_value "$json" REDIS_PASSWORD)"
  [[ -n "$pw" ]] || { log 'generating the Redis password'; pw="$(rand_hex)"; }
  (
    export S_0="$pw" S_1="redis://:$pw@redis.$NS.svc:6379"
    S_2="$(printf 'requirepass %s\nappendonly yes\ndir /data\n' "$pw")"
    export S_2
    apply_secret moca-redis REDIS_PASSWORD REDIS_URL redis.conf
  )
}

# The base relay requires SH_RELAY_TOKEN, the attach fallback for an id with no directory token.
# SBX0 hands it to nobody; it exists so the relay boots, and is random so nobody can use it. From
# 1b there is no harness exec token (spec §3.1): the overlay drops the env entry, and
# remove_exec_token drops a 1a namespace's key once the new relay is up.
ensure_relay_secret() {
  local json relay
  json="$(secret_json moca-relay)"
  relay="$(json_value "$json" SH_RELAY_TOKEN)"
  [[ -n "$relay" ]] || { log 'generating SH_RELAY_TOKEN'; relay="$(rand_hex)"; }
  (
    export S_0="$relay"
    apply_secret moca-relay SH_RELAY_TOKEN
  )
}

# A namespace set up by 1a holds MOCA_RELAY_EXEC_TOKEN in moca-relay, removed by explicit null patch
# (server-side apply does not prune it). Only AFTER the new relay has rolled out: the 1a relay's
# template requires that key, so removing it earlier, in a run that then fails, would leave any
# restarted 1a relay pod in CreateContainerConfigError.
remove_exec_token() {
  if secret_json moca-relay | jq -e '.data // {} | has("MOCA_RELAY_EXEC_TOKEN")' >/dev/null; then
    log "removing MOCA_RELAY_EXEC_TOKEN from moca-relay (SBX0 has no harness caller)"
    kc patch secret moca-relay -n "$NS" --type=merge -p '{"data":{"MOCA_RELAY_EXEC_TOKEN":null}}' >/dev/null
  fi
}

# One attach token per worker id in moca-relay-sandbox-tokens, which the relay reads on each attach
# (P6.2 §2.1). Generated once and kept; an id no longer listed is revoked with an explicit null patch.
ensure_worker_tokens() {
  local json stale patch
  json="$(secret_json moca-relay-sandbox-tokens)"
  (
    i=0
    for w in $SBX_WORKERS; do
      tok="$(json_value "$json" "$w")"
      [[ -n "$tok" ]] || { log "generating the attach token for worker $w"; tok="$(rand_hex)"; }
      export "S_$i=$tok"
      i=$((i + 1))
    done
    # shellcheck disable=SC2086 # one argument per id; ids are validated identifiers
    apply_secret moca-relay-sandbox-tokens $SBX_WORKERS
  )
  # Revoke any worker id no longer in SBX_WORKERS with an explicit null patch (not apply pruning).
  stale="$(printf '%s' "$json" | jq -r '.data // {} | keys[]' | while read -r k; do
    [[ " $SBX_WORKERS " == *" $k "* ]] || printf '%s\n' "$k"
  done)"
  if [[ -n "$stale" ]]; then
    log "revoking the attach token of worker(s) no longer listed: $(printf '%s' "$stale" | tr '\n' ' ')"
    patch="$(printf '%s\n' "$stale" | jq -Rnc '{data: ([inputs | {key: ., value: null}] | from_entries)}')"
    kc patch secret moca-relay-sandbox-tokens -n "$NS" --type=merge -p "$patch" >/dev/null
  fi
}

# Increment 1a's static client tokens (spec §3.1), revoked by deleting their Secrets; their
# bundles go too.
remove_client_tokens() {
  local s
  for s in sbx-relay-clients sbx-relay-client-keys; do
    [[ -z "$(secret_json "$s")" ]] || { log "removing $s (increment 1a's static client tokens)"; kc delete secret "$s" -n "$NS" >/dev/null; }
  done
  [[ ! -d "$GEN/clients" ]] || { log 'deleting the 1a client bundles'; rm -rf "$GEN/clients"; }
}

# The control plane's Ed25519 signing key (moca-mu1: PKCS#8 DER as one line of base64, the form
# token.ts's makeSigner takes) and the public keyset the relay verifies with (sbx-token-keys:
# <kid>:<base64 SPKI>). Generated once and kept. The kid is sha256(SPKI DER)[:16] hex -- token.ts's
# keyIdFor -- so the keyset parses with parseKeyset. The private key lives only in a 0700 temp dir
# and apply_secret's environment.
ensure_signing_key() {
  local json priv dir
  json="$(secret_json moca-mu1)"
  priv="$(json_value "$json" SH_SESSION_TOKEN_PRIVATE_KEY)"
  dir="$(mktemp -d)"
  (
    trap 'rm -rf "$dir"' EXIT
    chmod 700 "$dir"
    if [[ -z "$priv" ]]; then
      log 'generating the sandbox token signing key (Ed25519)'
      openssl genpkey -algorithm ed25519 -out "$dir/k.pem" 2>/dev/null || die 'openssl could not generate an Ed25519 key'
      openssl pkey -in "$dir/k.pem" -outform DER -out "$dir/k.der" 2>/dev/null || die 'openssl could not export the key as PKCS#8 DER'
      priv="$(base64 <"$dir/k.der" | tr -d '\n')"
    else
      printf '%s' "$priv" | base64 --decode >"$dir/k.der"
    fi
    openssl pkey -inform DER -in "$dir/k.der" -pubout -outform DER -out "$dir/pub.der" 2>/dev/null ||
      die 'moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY is not a PKCS#8 private key: delete the Secret and re-run (this rotates the key)'
    kid="$(openssl dgst -sha256 -hex <"$dir/pub.der" | awk '{print substr($NF, 1, 16)}')"
    spki="$(base64 <"$dir/pub.der" | tr -d '\n')"
    export S_0="$priv"
    apply_secret moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY
    export S_0="$kid:$spki"
    apply_secret sbx-token-keys PUBLIC_KEYS
  )
}

# apply_configmap NAME KEY=VALUE...: non-secret settings, so the values may appear in jq's argv
# (never kubectl's). Server-side apply with the one field manager: a key dropped from the list is
# removed, as SH_SANDBOX_EXEC_CA is once the exec certificate is issued.
apply_configmap() {
  local name="$1"
  shift
  jq -n --arg name "$name" --arg ns "$NS" \
    '{apiVersion: "v1", kind: "ConfigMap", metadata: {name: $name, namespace: $ns},
      data: ([$ARGS.positional[] | index("=") as $i | {key: .[:$i], value: .[$i + 1:]}] | from_entries)}' \
    --args "$@" | kc apply --server-side --force-conflicts --field-manager=sbx-setup -f - >/dev/null
}

# moca-settings (the keys base/control-plane.yaml reads) and sbx-settings (the sandbox profile's and
# the relay's), then SETTINGS_HASH: what both pods read at boot, with the public keyset, so a change
# to any of it rolls both (write_overlay). Runs after route_cert: it reads exec-ca.crt.
ensure_settings() {
  local ca='' moca sbx
  [[ ! -f "$GEN/exec-ca.crt" ]] || ca="$(cat "$GEN/exec-ca.crt")"
  # The TTLs are '' (the control plane's defaults); the base reads both keys, so both must exist.
  moca=("SH_GITHUB_CLIENT_ID=$SBX_GITHUB_CLIENT_ID" "SH_ADMIN_SUBJECTS=${SBX_ADMIN_SUBJECTS:-}"
    'SH_API_TOKEN_TTL_SECONDS=' 'SH_SESSION_TOKEN_TTL_SECONDS=')
  sbx=("SH_ALLOWED_SUBJECTS=$SBX_ALLOWED_SUBJECTS" "SH_SANDBOX_TEMPLATES=$TEMPLATES_JSON"
    "SH_SANDBOX_EXEC_ENDPOINT=$SBX_EXEC_HOST:443" 'SH_SANDBOX_TOKEN_ISSUER=sbx-control-plane'
    "SH_SANDBOX_LIFETIME_SECONDS=$LIFETIME_S" "SH_SANDBOX_TOKEN_TTL_SECONDS=$TOKEN_TTL_S"
    "SH_SANDBOX_RETENTION_SECONDS=$RETENTION_S" "SH_SANDBOX_MAX_PER_SUBJECT=$SBX_MAX_PER_SUBJECT"
    "SH_SANDBOX_MAX_TOTAL=$SBX_MAX_TOTAL" "SH_SANDBOX_MAX_INFLIGHT=$SBX_MAX_INFLIGHT")
  [[ -z "$ca" ]] || sbx+=("SH_SANDBOX_EXEC_CA=$ca")
  apply_configmap moca-settings "${moca[@]}"
  apply_configmap sbx-settings "${sbx[@]}"
  SETTINGS_HASH="$({
    printf '%s\n' "${moca[@]}" "${sbx[@]}"
    json_value "$(secret_json sbx-token-keys)" PUBLIC_KEYS
  } | openssl dgst -sha256 -hex | awk '{print substr($NF, 1, 16)}')"
  [[ "$SETTINGS_HASH" =~ ^[0-9a-f]{16}$ ]] || die 'could not hash the settings (openssl dgst)'
}

# route_cert SECRET HOST CERT KEY CAFILE: install the operator's certificate, or make a self-signed one
# once and keep it. CAFILE receives the certificate whenever it is self-issued (subject == issuer),
# so bundles can carry it; it is removed when an issued certificate is installed.
route_cert() {
  local secret="$1" host="$2" cert="$3" key="$4" ca="$5" json crt dir
  mkdir -p "$(dirname "$ca")"
  if [[ -n "$cert" ]]; then
    log "installing the $secret certificate from $cert"
    kc create secret tls "$secret" -n "$NS" --cert="$cert" --key="$key" --dry-run=client -o json |
      kc apply --server-side --force-conflicts --field-manager=sbx-setup -f - >/dev/null
  else
    # Captured first, so a failing `kubectl get` stops the run (errexit). Tested inside [[ ]], a
    # transient API or RBAC error would read as "no Secret" and replace the certificate every
    # bundle already handed out trusts.
    json="$(secret_json "$secret")"
    if [[ -z "$json" ]]; then
      dir="$(mktemp -d)"
      (
        trap 'rm -rf "$dir"' EXIT
        chmod 700 "$dir"
        openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$host" \
          -addext "subjectAltName=DNS:$host" -keyout "$dir/tls.key" -out "$dir/tls.crt" 2>"$dir/err" ||
          { cat "$dir/err" >&2; die "openssl could not create the self-signed certificate for $host"; }
        kc create secret tls "$secret" -n "$NS" --cert="$dir/tls.crt" --key="$dir/tls.key" --dry-run=client -o json |
          kc apply --server-side --force-conflicts --field-manager=sbx-setup -f - >/dev/null
      )
      log "WARNING: no certificate given for $host: using a self-signed one, shipped in every bundle"
    fi
  fi
  json="$(secret_json "$secret")"
  crt="$(json_value "$json" tls.crt)"
  [[ -n "$crt" ]] || die "$secret has no tls.crt"
  if [[ "$(printf '%s\n' "$crt" | openssl x509 -noout -subject_hash)" == "$(printf '%s\n' "$crt" | openssl x509 -noout -issuer_hash)" ]]; then
    printf '%s\n' "$crt" >"$ca"
  else
    rm -f "$ca"
  fi
}

image_entry() {
  local from="$1" ref="$2" name tag=''
  if [[ "$ref" == *@* ]]; then
    # repo:tag@sha256:... -- the digest pins the image; a tag left in newName renders an invalid ref.
    name="${ref%@*}"
    [[ "${name##*/}" != *:* ]] || name="${name%:*}"
    printf '  - name: %s\n    newName: %s\n    digest: %s\n' "$from" "$name" "${ref#*@}"
    return 0
  fi
  name="$ref"
  if [[ "${ref##*/}" == *:* ]]; then name="${ref%:*}"; tag="${ref##*:}"; fi
  printf '  - name: %s\n    newName: %s\n' "$from" "$name"
  [[ -z "$tag" ]] || printf '    newTag: %s\n' "$tag"
}

write_overlay() {
  mkdir -p "$GEN"
  # The API Route's operator certificate, as a JSON patch in a 0600 file: jq reads the key from its
  # file, so it never reaches argv. Without one the Route keeps the router's default certificate.
  rm -f "$GEN/api-route-tls.json"
  if [[ -n "${SBX_API_TLS_CERT:-}" ]]; then
    (
      umask 077
      jq -n --rawfile c "$SBX_API_TLS_CERT" --rawfile k "$SBX_API_TLS_KEY" \
        '[{op: "add", path: "/spec/tls/certificate", value: $c}, {op: "add", path: "/spec/tls/key", value: $k}]' \
        >"$GEN/api-route-tls.json"
    )
  fi
  {
    printf '# GENERATED by deploy/sbx/setup.sh on every run. Do not edit; gitignored.\n'
    printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n'
    printf 'namespace: %s\nresources:\n  - %s\npatches:\n' "$NS" "$OVERLAY_REL"
    printf '  - target: { kind: Route, name: moca-relay }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$SBX_ATTACH_HOST"
    printf '  - target: { kind: Route, name: sbx-exec }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$SBX_EXEC_HOST"
    printf '  - target: { kind: Route, name: sbx-api }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$SBX_API_HOST"
    [[ ! -f "$GEN/api-route-tls.json" ]] || printf '  - target: { kind: Route, name: sbx-api }\n    path: api-route-tls.json\n'
    # Both pods read their settings and keys only at boot: a new hash changes their pod templates,
    # so the apply rolls them. The control plane's template has no annotations map; p4-relay gives
    # the relay's one, so there this adds a key.
    printf '  - target: { kind: Deployment, name: moca-control-plane }\n    patch: |-\n'
    printf '      - { op: add, path: /spec/template/metadata/annotations, value: { sbx.moca.dev/settings-hash: "%s" } }\n' "$SETTINGS_HASH"
    printf '  - target: { kind: Deployment, name: sandbox-relay }\n    patch: |-\n'
    printf '      - { op: add, path: /spec/template/metadata/annotations/sbx.moca.dev~1settings-hash, value: "%s" }\n' "$SETTINGS_HASH"
    printf 'images:\n'
    image_entry ghcr.io/rossoctl/moca "$SBX_IMAGE"
  } >"$GEN/kustomization.yaml"
}

apply_stack() {
  kc apply -k "$GEN" >/dev/null
  kc rollout status statefulset/redis -n "$NS" --timeout=300s
  kc rollout status deployment/sandbox-relay -n "$NS" --timeout=300s
  remove_exec_token
  kc rollout status deployment/moca-control-plane -n "$NS" --timeout=300s
}

write_bundles() {
  local json d id tok
  json="$(secret_json moca-relay-sandbox-tokens)"
  for d in "$GEN"/workers/*/; do
    [[ -d "$d" ]] || continue
    id="$(basename "$d")"
    [[ " $SBX_WORKERS " == *" $id "* ]] || { log "deleting the bundle of worker $id"; rm -rf "$d"; }
  done
  (
    umask 077
    for id in $SBX_WORKERS; do
      d="$GEN/workers/$id"
      tok="$(json_value "$json" "$id")"
      [[ -n "$tok" ]] || die "moca-relay-sandbox-tokens has no token for worker $id: re-run setup.sh"
      mkdir -p "$d"
      # SH_WORKSPACE_IDLE: the lifetime plus two days (SBX0 §5.4); install-host.sh takes it from here.
      printf 'RELAY_ADDR=%s:443\nRELAY_TLS=true\nSANDBOX_ID=%s\nSANDBOX_TOKEN=%s\nSH_WORKSPACE_IDLE=%sh\nSH_WORKSPACE_IMAGE_MB=%s\n' \
        "$SBX_ATTACH_HOST" "$id" "$tok" "$WORKSPACE_IDLE_H" "$SBX_WORKSPACE_IMAGE_MB" >"$d/worker.env"
      if [[ -f "$GEN/attach-ca.crt" ]]; then cp "$GEN/attach-ca.crt" "$d/relay-ca.crt"; else rm -f "$d/relay-ca.crt"; fi
    done
    chmod 700 "$GEN" "$GEN"/workers "$GEN"/workers/* 2>/dev/null || true
  )
  log "worker bundles: $GEN/workers/<id>  (copy to the KVM host, run deploy/sbx/install-host.sh, delete the copy)"
  [[ -z "${HOSTS_TO_REINSTALL:-}" ]] ||
    log "WARNING: the SH_WORKSPACE_IDLE changed: re-run deploy/sbx/install-host.sh now on the host of each of: $HOSTS_TO_REINSTALL"
}

main() {
  parse_args "$@"
  validate
  preflight
  ensure_redis_secret
  ensure_relay_secret
  ensure_worker_tokens
  remove_client_tokens
  ensure_signing_key
  route_cert moca-relay-tls "$SBX_ATTACH_HOST" "${SBX_ATTACH_TLS_CERT:-}" "${SBX_ATTACH_TLS_KEY:-}" "$GEN/attach-ca.crt"
  route_cert sbx-exec-tls "$SBX_EXEC_HOST" "${SBX_EXEC_TLS_CERT:-}" "${SBX_EXEC_TLS_KEY:-}" "$GEN/exec-ca.crt"
  ensure_settings
  write_overlay
  apply_stack
  write_bundles
  log "SBX0 ready: api https://$SBX_API_HOST  attach https://$SBX_ATTACH_HOST:443  exec https://$SBX_EXEC_HOST:443"
}

main "$@"
