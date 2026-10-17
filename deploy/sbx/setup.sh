#!/usr/bin/env bash
# deploy/sbx/setup.sh -- install or update the SBX0 front door in one namespace of a shared OpenShift
# cluster (docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md §8.1).
#
#   deploy/sbx/setup.sh [--env-file FILE]
#
# Inputs (environment, or FILE sourced with `set -a`): SBX_NAMESPACE (must exist), SBX_ATTACH_HOST,
# SBX_EXEC_HOST, SBX_IMAGE, SBX_WORKERS (template worker ids), SBX_CLIENTS (1a: team members given
# static client tokens), optional SBX_{ATTACH,EXEC}_TLS_{CERT,KEY}.
#
# Re-runnable: every token, password and certificate is generated once and kept. A worker or client
# dropped from the lists has its token revoked and its bundle deleted. The relay reads worker tokens on
# each attach, so those changes act at once; it reads MOCA_RELAY_CLIENT_TOKENS only at boot, so the
# generated overlay stamps a hash of that value on the relay's pod template, and any change to the
# client list rolls the relay. Values never reach argv or the log: they travel through jq's
# environment or a builtin printf into a pipe, and messages name keys only.
#
# Writes deploy/sbx/.generated/: the applied overlay, workers/<id>/ (worker.env [+ relay-ca.crt], for
# deploy/sbx/install-host.sh on the KVM host) and clients/<name>/ (client.env [+ exec-ca.crt]). Copy
# each bundle straight to its owner and delete the copy.
set -euo pipefail

SBX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="$SBX_DIR/.generated"
OVERLAY_REL=../../k8s/overlays/ocp-sbx # from $GEN

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
# No '-' in a client name: its 1a token admits workspace keys under sbx-exec-<name>-, and with a '-'
# allowed, client bob's prefix sbx-exec-bob- would also be a prefix of client bob-x's keys.
CLIENT_RE='^[a-z0-9][a-z0-9_]{0,30}$'
HOST_RE='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
NS_RE='^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'

validate() {
  [[ "${SBX_NAMESPACE:-}" =~ $NS_RE ]] || die 'SBX_NAMESPACE is required and must be a namespace name'
  [[ "${SBX_ATTACH_HOST:-}" =~ $HOST_RE ]] || die 'SBX_ATTACH_HOST is required and must be a DNS name'
  [[ "${SBX_EXEC_HOST:-}" =~ $HOST_RE ]] || die 'SBX_EXEC_HOST is required and must be a DNS name'
  [[ "$SBX_ATTACH_HOST" != "$SBX_EXEC_HOST" ]] || die 'SBX_ATTACH_HOST and SBX_EXEC_HOST must differ (one certificate each)'
  [[ -n "${SBX_IMAGE:-}" && "$SBX_IMAGE" != *[[:space:]]* ]] || die 'SBX_IMAGE is required (the relay image)'
  [[ -n "${SBX_WORKERS:-}" ]] || die 'SBX_WORKERS is required: the template worker ids, space-separated'
  local seen=' ' w c
  for w in $SBX_WORKERS; do
    [[ "$w" =~ $WORKER_RE ]] || die "worker id '$w' must match $WORKER_RE (the relay looks it up by name)"
    [[ "$w" != DIR ]] || die "worker id 'DIR' is reserved (SH_RELAY_TOKEN_DIR)"
    [[ "$seen" != *" $w "* ]] || die "worker id '$w' is listed twice"
    seen+="$w "
  done
  seen=' '
  for c in ${SBX_CLIENTS:-}; do
    [[ "$c" =~ $CLIENT_RE ]] ||
      die "client name '$c' must match $CLIENT_RE, with no '-': its token admits workspace keys under sbx-exec-$c-, which would then also prefix another client's keys (bob and bob-x). Rename it (e.g. bob_x) and re-run; until then the old name's token stays valid in the relay"
    [[ "$seen" != *" $c "* ]] || die "client name '$c' is listed twice"
    seen+="$c "
  done
  # One space between ids from here on: every later membership test (" $SBX_WORKERS " == *" $k "*)
  # matches spaces only, so a newline- or tab-separated list would read every id as stale and revoke it.
  # shellcheck disable=SC2086 # split on any whitespace; the ids are validated identifiers
  SBX_WORKERS="$(printf '%s ' $SBX_WORKERS)"
  SBX_WORKERS="${SBX_WORKERS% }"
  # shellcheck disable=SC2086
  SBX_CLIENTS="$(printf '%s ' ${SBX_CLIENTS:-})"
  SBX_CLIENTS="${SBX_CLIENTS% }"
  local pair
  for pair in ATTACH EXEC; do
    local cert="SBX_${pair}_TLS_CERT" key="SBX_${pair}_TLS_KEY"
    [[ -z "${!cert:-}" && -z "${!key:-}" ]] || [[ -f "${!cert:-/nonexistent}" && -f "${!key:-/nonexistent}" ]] ||
      die "$cert and $key must both name readable files, or both be unset"
  done
  NS="$SBX_NAMESPACE"
}

preflight() {
  local t
  for t in kubectl jq openssl; do command -v "$t" >/dev/null || die "needs $t on PATH"; done
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

# The base relay requires both: SH_RELAY_TOKEN (the attach fallback for an id with no directory token)
# and MOCA_RELAY_EXEC_TOKEN (the harness caller). SBX0 hands out neither; they exist so the relay
# boots, and are random so nobody can use them.
ensure_relay_secret() {
  local json relay exec_token
  json="$(secret_json moca-relay)"
  relay="$(json_value "$json" SH_RELAY_TOKEN)"
  exec_token="$(json_value "$json" MOCA_RELAY_EXEC_TOKEN)"
  [[ -n "$relay" ]] || { log 'generating SH_RELAY_TOKEN'; relay="$(rand_hex)"; }
  [[ -n "$exec_token" ]] || { log 'generating MOCA_RELAY_EXEC_TOKEN'; exec_token="$(rand_hex)"; }
  [[ "$relay" != "$exec_token" ]] || die 'moca-relay holds equal tokens: delete the Secret and re-run'
  (
    export S_0="$relay" S_1="$exec_token"
    apply_secret moca-relay SH_RELAY_TOKEN MOCA_RELAY_EXEC_TOKEN
  )
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

# 1a only (spec §3.1): the prototype relay's static client tokens, each limited to workspace keys
# under sbx-exec-<client>-. One per client, on the FIRST worker in SBX_WORKERS only: that is the one
# its bundle names (1a ships one template worker, spec §11), and a token nobody is handed should not
# be live in the relay. 1b's per-sandbox tokens replace these. The tokens are kept per (client,
# worker) pair in sbx-relay-client-keys; the relay reads the joined list from sbx-relay-clients.
ensure_client_tokens() {
  local keys_json pairs=() c first stale patch
  keys_json="$(secret_json sbx-relay-client-keys)"
  first="${SBX_WORKERS%% *}"
  for c in ${SBX_CLIENTS:-}; do pairs+=("$c.$first"); done
  (
    i=0
    joined=''
    for p in "${pairs[@]+"${pairs[@]}"}"; do
      tok="$(json_value "$keys_json" "$p")"
      [[ -n "$tok" ]] || { log "generating the client token for ${p%%.*} on ${p#*.}"; tok="$(rand_hex)"; }
      export "S_$i=$tok"
      joined+="${joined:+,}${p#*.}:sbx-exec-${p%%.*}-:$tok"
      i=$((i + 1))
    done
    apply_secret sbx-relay-client-keys "${pairs[@]+"${pairs[@]}"}"
    export S_0="$joined"
    apply_secret sbx-relay-clients MOCA_RELAY_CLIENT_TOKENS
  )
  # Revoke any (client, worker) pair not delivered now -- a dropped client, or a client's token on a
  # worker other than the first -- with an explicit null patch.
  stale="$(printf '%s' "$keys_json" | jq -r '.data // {} | keys[]' | while read -r k; do
    [[ " ${pairs[*]+"${pairs[*]}"} " == *" $k "* ]] || printf '%s\n' "$k"
  done)"
  if [[ -n "$stale" ]]; then
    log "revoking the client token(s) no longer delivered: $(printf '%s' "$stale" | tr '\n' ' ')"
    patch="$(printf '%s\n' "$stale" | jq -Rnc '{data: ([inputs | {key: ., value: null}] | from_entries)}')"
    kc patch secret sbx-relay-client-keys -n "$NS" --type=merge -p "$patch" >/dev/null
  fi
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

# 16 hex characters of the SHA-256 of the relay's MOCA_RELAY_CLIENT_TOKENS, as applied. Not secret
# (a hash of random tokens), but computed through a pipe all the same: the value never reaches argv.
client_tokens_hash() {
  local json
  # `|| return`: this runs in a command substitution, where errexit does not apply.
  json="$(secret_json sbx-relay-clients)" || return 1
  json_value "$json" MOCA_RELAY_CLIENT_TOKENS | openssl dgst -sha256 -hex |
    awk '{print substr($NF, 1, 16)}'
}

write_overlay() {
  local hash
  hash="$(client_tokens_hash)"
  [[ "$hash" =~ ^[0-9a-f]{16}$ ]] || die 'could not hash MOCA_RELAY_CLIENT_TOKENS: reading sbx-relay-clients failed (kubectl get), or openssl dgst did'
  mkdir -p "$GEN"
  {
    printf '# GENERATED by deploy/sbx/setup.sh on every run. Do not edit; gitignored.\n'
    printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n'
    printf 'namespace: %s\nresources:\n  - %s\npatches:\n' "$NS" "$OVERLAY_REL"
    printf '  - target: { kind: Route, name: moca-relay }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$SBX_ATTACH_HOST"
    printf '  - target: { kind: Route, name: sbx-exec }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$SBX_EXEC_HOST"
    # The relay reads its client tokens only at boot: a new hash changes the pod template, so the
    # apply rolls it. p4-relay already gives the template an annotations map; this adds one key.
    printf '  - target: { kind: Deployment, name: sandbox-relay }\n    patch: |-\n'
    printf '      - { op: add, path: /spec/template/metadata/annotations/sbx.moca.dev~1client-tokens-hash, value: "%s" }\n' "$hash"
    printf 'images:\n'
    image_entry ghcr.io/rossoctl/moca "$SBX_IMAGE"
  } >"$GEN/kustomization.yaml"
}

apply_stack() {
  kc apply -k "$GEN" >/dev/null
  kc rollout status statefulset/redis -n "$NS" --timeout=300s
  kc rollout status deployment/sandbox-relay -n "$NS" --timeout=300s
}

write_bundles() {
  local json keys d id tok
  json="$(secret_json moca-relay-sandbox-tokens)"
  for d in "$GEN"/workers/*/ "$GEN"/clients/*/; do
    [[ -d "$d" ]] || continue
    id="$(basename "$d")"
    case "$d" in
    */workers/*) [[ " $SBX_WORKERS " == *" $id "* ]] || { log "deleting the bundle of worker $id"; rm -rf "$d"; } ;;
    */clients/*) [[ " ${SBX_CLIENTS:-} " == *" $id "* ]] || { log "deleting the bundle of client $id"; rm -rf "$d"; } ;;
    esac
  done
  (
    umask 077
    for id in $SBX_WORKERS; do
      d="$GEN/workers/$id"
      tok="$(json_value "$json" "$id")"
      [[ -n "$tok" ]] || die "moca-relay-sandbox-tokens has no token for worker $id: re-run setup.sh"
      mkdir -p "$d"
      printf 'RELAY_ADDR=%s:443\nRELAY_TLS=true\nSANDBOX_ID=%s\nSANDBOX_TOKEN=%s\n' \
        "$SBX_ATTACH_HOST" "$id" "$tok" >"$d/worker.env"
      if [[ -f "$GEN/attach-ca.crt" ]]; then cp "$GEN/attach-ca.crt" "$d/relay-ca.crt"; else rm -f "$d/relay-ca.crt"; fi
    done
    keys="$(secret_json sbx-relay-client-keys)"
    local first
    first="${SBX_WORKERS%% *}"
    for id in ${SBX_CLIENTS:-}; do
      d="$GEN/clients/$id"
      tok="$(json_value "$keys" "$id.$first")"
      [[ -n "$tok" ]] || die "sbx-relay-client-keys has no token for client $id on $first: re-run setup.sh"
      mkdir -p "$d"
      {
        printf 'SBX_ADDR=%s:443\nSBX_TLS=1\nSBX_SANDBOX_ID=%s\n' "$SBX_EXEC_HOST" "$first"
        printf 'SBX_WORKSPACE_KEY_PREFIX=sbx-exec-%s-\nSBX_TOKEN=%s\n' "$id" "$tok"
        # Relative to the bundle: README §3 has the owner source it there and export the absolute path.
        [[ ! -f "$GEN/exec-ca.crt" ]] || printf 'SBX_CA_FILE=exec-ca.crt\n'
      } >"$d/client.env"
      if [[ -f "$GEN/exec-ca.crt" ]]; then cp "$GEN/exec-ca.crt" "$d/exec-ca.crt"; else rm -f "$d/exec-ca.crt"; fi
    done
    chmod 700 "$GEN" "$GEN"/workers "$GEN"/workers/* 2>/dev/null || true
  )
  log "worker bundles: $GEN/workers/<id>  (copy to the KVM host, run deploy/sbx/install-host.sh, delete the copy)"
  [[ -z "${SBX_CLIENTS:-}" ]] || log "client bundles: $GEN/clients/<name>  (hand each to its owner, delete the copy)"
}

main() {
  parse_args "$@"
  validate
  preflight
  ensure_redis_secret
  ensure_relay_secret
  ensure_worker_tokens
  ensure_client_tokens
  route_cert moca-relay-tls "$SBX_ATTACH_HOST" "${SBX_ATTACH_TLS_CERT:-}" "${SBX_ATTACH_TLS_KEY:-}" "$GEN/attach-ca.crt"
  route_cert sbx-exec-tls "$SBX_EXEC_HOST" "${SBX_EXEC_TLS_CERT:-}" "${SBX_EXEC_TLS_KEY:-}" "$GEN/exec-ca.crt"
  write_overlay
  apply_stack
  write_bundles
  log "front door ready: attach https://$SBX_ATTACH_HOST:443  exec https://$SBX_EXEC_HOST:443"
}

main "$@"
