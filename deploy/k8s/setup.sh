#!/usr/bin/env bash
# deploy/k8s/setup.sh -- bring up P6 on Kubernetes (docs/specs/2026-10-02-p6-on-kubernetes-slice1-design.md §4).
#
#   deploy/k8s/setup.sh --target kind|kind-ci|ocp [--image IMG] [--sandbox-image IMG]
#                       [--build|--skip-build] [--tls-cert FILE --tls-key FILE]
#
# Environment: SH_GITHUB_CLIENT_ID, SH_ADMIN_SUBJECTS, SH_ALLOW_OPERATOR_FALLBACK (default false),
# SH_SANDBOX_COUNT (default 2; 0 runs no container sandboxes), SH_WAIT_SECONDS (default 120),
# SH_SOURCE_ONLY=1 (define the functions and stop, for tests).
#
# Idempotent: a re-run converges and never rotates a secret. Inputs are sticky: a re-run keeps every
# setting, --image, --sandbox-image (ocp) and SH_SANDBOX_COUNT it is not given; an explicitly empty
# setting variable (SH_ADMIN_SUBJECTS=) clears it. No secret value is ever put on a command line --
# values travel through pipes and through the environment of the one jq that writes each Secret.
set -euo pipefail

K8S_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$K8S_DIR/../.." && pwd)"
KIND_CLUSTER=moca
KIND_CONTEXT=kind-moca
MIN_KIND_VERSION=0.24.0
NS=moca
SBX_NS=moca-sandbox
LOCAL_HARNESS=dev.local/moca:local
LOCAL_SANDBOX=dev.local/moca-remote-worker:local

TARGET=''
IMAGE=''
SANDBOX_IMAGE=''
BUILD=auto
TLS_CERT=''
TLS_KEY=''

log() { printf '==> %s\n' "$*" >&2; }
die() {
  printf 'setup.sh: %s\n' "$*" >&2
  exit 1
}
usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# need_value FLAG ARGC [VALUE]: die unless FLAG was given a non-empty value. `shift 2` with one
# argument left fails without a word, and under set -e that is a silent exit.
need_value() { [[ "$2" -ge 2 && -n "${3-}" ]] || die "$1 needs a value"; }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --target) need_value "$1" $# "${2-}"; TARGET="$2"; shift 2 ;;
    --image) need_value "$1" $# "${2-}"; IMAGE="$2"; shift 2 ;;
    --sandbox-image) need_value "$1" $# "${2-}"; SANDBOX_IMAGE="$2"; shift 2 ;;
    --build) BUILD=always; shift ;;
    --skip-build) BUILD=never; shift ;;
    --tls-cert) need_value "$1" $# "${2-}"; TLS_CERT="$2"; shift 2 ;;
    --tls-key) need_value "$1" $# "${2-}"; TLS_KEY="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
    esac
  done
  case "$TARGET" in
  kind | kind-ci | ocp) ;;
  '') die '--target is required: kind, kind-ci or ocp' ;;
  *) die "unknown --target '$TARGET': kind, kind-ci or ocp" ;;
  esac
  if [[ -n "$TLS_CERT$TLS_KEY" ]]; then
    [[ "$TARGET" == ocp ]] || die '--tls-cert/--tls-key apply to --target ocp only'
    [[ -n "$TLS_CERT" && -n "$TLS_KEY" ]] || die '--tls-cert and --tls-key go together'
    [[ -r "$TLS_CERT" && -r "$TLS_KEY" ]] || die "cannot read $TLS_CERT or $TLS_KEY"
  fi
  # Validated here, before anything touches a cluster; an unset or empty count is resolved later,
  # from the earlier run's value (load_setup_inputs).
  SH_SANDBOX_COUNT="${SH_SANDBOX_COUNT:-}"
  [[ -z "$SH_SANDBOX_COUNT" || "$SH_SANDBOX_COUNT" =~ ^[0-9]+$ ]] ||
    die "SH_SANDBOX_COUNT='$SH_SANDBOX_COUNT' must be a whole number (0 runs no container sandboxes)"
  SH_WAIT_SECONDS="${SH_WAIT_SECONDS:-120}"
}

is_kind() { [[ "$TARGET" == kind || "$TARGET" == kind-ci ]]; }

# Every cluster call goes through here. On Kind it is pinned to the kind-moca context, never the
# ambient one: a Kind run must not apply a stack to whatever cluster the shell happens to point at.
kc() {
  if is_kind; then kubectl --context "$KIND_CONTEXT" "$@"; else kubectl "$@"; fi
}

# version_ge A B: A >= B, dotted numeric.
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

preflight() {
  local need='kubectl openssl jq' missing='' c v
  if is_kind; then need="$need kind docker"; else need="$need oc"; fi
  for c in $need; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || missing="$missing sha256sum|shasum"
  [[ -z "$missing" ]] || die "missing required commands:$missing"
  if is_kind; then
    # `|| true`: a grep that matches nothing would otherwise end the run here, under set -e and
    # pipefail, without a word.
    v="$(kind version | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
    v="${v#v}"
    [[ -n "$v" ]] || die "could not read a version from \`kind version\` (got: $(kind version 2>&1 | head -1)); kind v$MIN_KIND_VERSION or newer is required"
    version_ge "$v" "$MIN_KIND_VERSION" ||
      die "kind v$MIN_KIND_VERSION or newer is required (found v$v): it is the first whose default CNI enforces NetworkPolicy, and this deployment's isolation IS NetworkPolicy"
  else
    oc whoami >/dev/null 2>&1 || die 'not logged in to OpenShift: run `oc login` first'
    log "target cluster: $(kubectl config current-context)"
  fi
}

ensure_kind_cluster() {
  if ! kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
    log "creating kind cluster $KIND_CLUSTER"
    kind create cluster --name "$KIND_CLUSTER"
  fi
}

# local_image SOURCE_REF LOCAL_TAG DOCKERFILE: pull-else-build (setup-kind.sh's pattern), then load.
local_image() {
  local src="$1" tag="$2" dockerfile="$3"
  case "$BUILD" in
  never)
    log "--skip-build: assuming $tag is already loaded"
    return 0
    ;;
  always) docker build --load -t "$tag" -f "$dockerfile" "$REPO_ROOT" ;;
  auto)
    if docker pull "$src"; then
      docker tag "$src" "$tag"
    else
      log "could not pull $src; building $tag from this checkout"
      docker build --load -t "$tag" -f "$dockerfile" "$REPO_ROOT"
    fi
    ;;
  esac
  kind load docker-image "$tag" --name "$KIND_CLUSTER"
}

ensure_images() {
  is_kind || return 0
  ensure_kind_cluster
  local_image "${IMAGE:-ghcr.io/rossoctl/moca:latest}" "$LOCAL_HARNESS" "$REPO_ROOT/Dockerfile"
  local_image "${SANDBOX_IMAGE:-ghcr.io/rossoctl/moca-remote-worker:latest}" "$LOCAL_SANDBOX" "$REPO_ROOT/remote-worker/Dockerfile"
}

# The harness image as the cluster runs it (for the one-shot key generator pod).
harness_ref() { if is_kind; then echo "$LOCAL_HARNESS"; else echo "${IMAGE:-ghcr.io/rossoctl/moca:latest}"; fi; }

# Namespaces alone first, so Secrets can land before any workload that mounts them.
ensure_namespaces() { kc apply -f "$K8S_DIR/base/namespaces.yaml" >/dev/null; }

# configmap_json NAME: the ConfigMap in $NS as JSON, or nothing when it does not exist. Any other
# API error fails, and the caller's assignment aborts the run (set -e, outside any conditional): an
# unreadable ConfigMap must never look like a missing one, or this run would reset every input the
# operator gave an earlier one. One command, like secret_json: a command substitution does not
# inherit set -e, so a failure inside a longer body here would be swallowed.
configmap_json() { kc get configmap "$1" -n "$NS" --ignore-not-found -o json; }

# cm_value JSON KEY: KEY's value from configmap_json's output (possibly empty), or nothing.
cm_value() { printf '%s' "$1" | jq -r --arg k "$2" '.data[$k] // empty'; }

# --- Sticky inputs (moca-setup) -------------------------------------------------------------------
# A re-run is how an operator changes ONE input (README "Re-running"), so it must not reset the ones
# it is not given: without this, a rotation recipe that sets one variable rolled an OCP stack back to
# :latest, scaled the sandboxes back to 2 and the control plane to 0. --image, --sandbox-image and the
# resolved SH_SANDBOX_COUNT are kept in the non-secret ConfigMap moca-setup and reused when not given.
# Kind ignores the stored images: it always runs the locally loaded dev.local tags, and --image there
# only picks what to pull, so only the sandbox count is stored for it.
load_setup_inputs() {
  local json
  json="$(configmap_json moca-setup)"
  if ! is_kind; then
    [[ -n "$IMAGE" ]] || IMAGE="$(cm_value "$json" IMAGE)"
    [[ -n "$SANDBOX_IMAGE" ]] || SANDBOX_IMAGE="$(cm_value "$json" SANDBOX_IMAGE)"
  fi
  [[ -n "$SH_SANDBOX_COUNT" ]] || SH_SANDBOX_COUNT="$(cm_value "$json" SH_SANDBOX_COUNT)"
  [[ -n "$SH_SANDBOX_COUNT" ]] || SH_SANDBOX_COUNT=2
  [[ "$SH_SANDBOX_COUNT" =~ ^[0-9]+$ ]] ||
    die "moca-setup holds SH_SANDBOX_COUNT='$SH_SANDBOX_COUNT': re-run with SH_SANDBOX_COUNT set to a whole number"
  local data
  if is_kind; then
    data="$(jq -nc --arg n "$SH_SANDBOX_COUNT" '{SH_SANDBOX_COUNT: $n}')"
  else
    data="$(jq -nc --arg n "$SH_SANDBOX_COUNT" --arg i "$IMAGE" --arg s "$SANDBOX_IMAGE" \
      '{SH_SANDBOX_COUNT: $n, IMAGE: $i, SANDBOX_IMAGE: $s} | with_entries(select(.value != ""))')"
  fi
  jq -n --arg ns "$NS" --argjson data "$data" \
    '{apiVersion: "v1", kind: "ConfigMap", metadata: {name: "moca-setup", namespace: $ns}, data: $data}' |
    kc apply --server-side --force-conflicts --field-manager=moca-setup -f - >/dev/null
}

# --- Secrets (spec §4.2) -----------------------------------------------------------------------
# Generated once and never rotated: an existing value is always kept; only a missing key is filled.

# secret_json NAME NS: the Secret as JSON, or nothing when it does not exist (the normal first-run
# case). Any other API error -- timeout, 5xx, RBAC denial, expired token -- fails, and the caller's
# assignment aborts the run: an unreadable Secret must never look like a missing one, or the next
# apply would rotate it (for SH_CREDENTIAL_KEK, losing every stored credential).
secret_json() { kc get secret "$1" -n "$2" --ignore-not-found -o json; }

# json_value JSON KEY: KEY's decoded value from secret_json's output, or nothing. The JSON reaches
# jq on stdin (printf is a builtin), never on argv.
json_value() { printf '%s' "$1" | jq -r --arg k "$2" '.data[$k] // empty' | base64 --decode; }

rand_hex() { openssl rand -hex 32; }

# apply_secret NAME NS KEY...: the values are $S_0, $S_1, ... in this call's environment (callers
# export them in a subshell). jq reads them from its environment, so no value reaches argv.
# Server-side apply writes no last-applied-configuration annotation, which would copy every value.
apply_secret() {
  local name="$1" ns="$2"
  shift 2
  jq -n --arg name "$name" --arg ns "$ns" \
    '{apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: {name: $name, namespace: $ns},
      stringData: ([$ARGS.positional | to_entries[] | {key: .value, value: env["S_\(.key)"]}] | from_entries)}' \
    --args "$@" | kc apply --server-side --force-conflicts --field-manager=moca-setup -f - >/dev/null
}

ensure_relay_secrets() {
  local json relay exec_token
  json="$(secret_json moca-relay "$NS")"
  relay="$(json_value "$json" SH_RELAY_TOKEN)"
  exec_token="$(json_value "$json" MOCA_RELAY_EXEC_TOKEN)"
  [[ -n "$relay" ]] || { log 'generating SH_RELAY_TOKEN'; relay="$(rand_hex)"; }
  [[ -n "$exec_token" ]] || { log 'generating MOCA_RELAY_EXEC_TOKEN'; exec_token="$(rand_hex)"; }
  # The relay refuses to boot on equal tokens (MI1 §5 R5); say why here, before it crash-loops.
  [[ "$relay" != "$exec_token" ]] ||
    die 'moca-relay holds the same value for SH_RELAY_TOKEN and MOCA_RELAY_EXEC_TOKEN: delete the Secret and re-run'
  (
    export S_0="$relay" S_1="$exec_token"
    apply_secret moca-relay "$NS" SH_RELAY_TOKEN MOCA_RELAY_EXEC_TOKEN
  )
  # The only Secret any MOCA object references in the sandbox namespace: the attach token, nothing else.
  (
    export S_0="$relay"
    apply_secret moca-relay-attach "$SBX_NS" SH_RELAY_TOKEN
  )
}

ensure_redis_secret() {
  local json pw
  json="$(secret_json moca-redis "$NS")"
  pw="$(json_value "$json" REDIS_PASSWORD)"
  [[ -n "$pw" ]] || { log 'generating the Redis password'; pw="$(rand_hex)"; }
  # URL and config are re-derived from the password on every run, so the three can never disagree.
  (
    export S_0="$pw" S_1="redis://:$pw@redis.$NS.svc:6379"
    S_2="$(printf 'requirepass %s\nappendonly yes\ndir /data\n' "$pw")"
    export S_2
    apply_secret moca-redis "$NS" REDIS_PASSWORD REDIS_URL redis.conf
  )
}

# The control plane's key generator, run once in the harness image as a pod (no local Docker or
# Node needed). Pod Security in moca is restricted; on Kind the image (no USER) needs an explicit
# UID, while OpenShift's SCC assigns one.
genkeys() {
  local ref sc
  ref="$(harness_ref)"
  if is_kind; then
    sc='{"runAsNonRoot":true,"runAsUser":65532,"seccompProfile":{"type":"RuntimeDefault"}}'
  else
    sc='{"runAsNonRoot":true,"seccompProfile":{"type":"RuntimeDefault"}}'
  fi
  # A pod left behind by a crashed run would make `kc run` fail with AlreadyExists.
  kc delete pod moca-genkeys -n "$NS" --ignore-not-found --wait=true >/dev/null
  # An attach does not replay output written before it, and `kc run -i` attaches only after it sees
  # the pod Running: on a busy node that is late enough to lose every line (seen on a fresh kind
  # cluster). So the generator waits for stdin to close -- which happens only once the attach is up,
  # since kubectl forwards this </dev/null over it -- and only then writes. The timeout bounds the
  # wait if the attach never comes; kubectl's fallback then reads the lines from the pod's log.
  kc run moca-genkeys -n "$NS" --rm -i --quiet --restart=Never --image="$ref" \
    --overrides="$(jq -nc --arg ref "$ref" --argjson sc "$sc" '{spec: {automountServiceAccountToken: false,
      securityContext: $sc, containers: [{name: "moca-genkeys", image: $ref, imagePullPolicy: "IfNotPresent",
      stdin: true, stdinOnce: true, workingDir: "/app/packages/control-plane",
      command: ["sh", "-c", "timeout 60 cat >/dev/null; exec node --import tsx src/genkeys.ts"],
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}}}]}}')" </dev/null
}

GENKEYS_OUT=''
# generated_value KEY REGEX: KEY's value from GENKEYS_OUT if all of it matches REGEX (the regexes are
# deploy/compose/install.sh's); dies otherwise.
generated_value() {
  local v
  v="$(printf '%s\n' "$GENKEYS_OUT" | sed -n "s/^$1=//p" | tail -1)"
  printf '%s\n' "$v" | grep -Eq "^$2\$" || die "the key generator produced no usable $1 (image: $(harness_ref))"
  printf '%s' "$v"
}

ensure_mu1_secret() {
  local json priv pub kek xchg
  json="$(secret_json moca-mu1 "$NS")"
  priv="$(json_value "$json" SH_SESSION_TOKEN_PRIVATE_KEY)"
  pub="$(json_value "$json" SH_SESSION_TOKEN_PUBLIC_KEYS)"
  kek="$(json_value "$json" SH_CREDENTIAL_KEK)"
  xchg="$(json_value "$json" SH_EXCHANGE_TOKEN)"
  json=''
  if { [[ -n "$priv" ]] && [[ -z "$pub" ]]; } || { [[ -z "$priv" ]] && [[ -n "$pub" ]]; }; then
    die 'moca-mu1 holds half a signing keypair (SH_SESSION_TOKEN_PRIVATE_KEY without SH_SESSION_TOKEN_PUBLIC_KEYS, or the reverse): delete both keys and re-run to generate a matching pair'
  fi
  [[ -z "$priv" || -z "$kek" || -z "$xchg" ]] || return 0
  log 'generating the missing MU1 secrets (in the harness image)'
  GENKEYS_OUT="$(genkeys)" || die "could not run the key generator in $(harness_ref)"
  # Every value is extracted and checked BEFORE anything is written, so a garbled generator can
  # never leave half a set (deploy/compose/install.sh's rule).
  if [[ -z "$priv" ]]; then
    priv="$(generated_value SH_SESSION_TOKEN_PRIVATE_KEY '[A-Za-z0-9+/]+=*')"
    pub="$(generated_value SH_SESSION_TOKEN_PUBLIC_KEYS '[0-9a-f]{16}:[A-Za-z0-9+/]+=*')"
  fi
  [[ -n "$kek" ]] || kek="$(generated_value SH_CREDENTIAL_KEK '[A-Za-z0-9+/]{43}=')"
  [[ -n "$xchg" ]] || xchg="$(generated_value SH_EXCHANGE_TOKEN '[0-9a-f]{64}')"
  GENKEYS_OUT=''
  (
    export S_0="$priv" S_1="$pub" S_2="$kek" S_3="$xchg"
    apply_secret moca-mu1 "$NS" SH_SESSION_TOKEN_PRIVATE_KEY SH_SESSION_TOKEN_PUBLIC_KEYS SH_CREDENTIAL_KEK SH_EXCHANGE_TOKEN
  )
}

ensure_secrets() {
  ensure_relay_secrets
  ensure_redis_secret
  ensure_mu1_secret
}

# --- Settings, TLS, SCC, the generated overlay, apply, wait (spec §4.1 steps 5-7) -----------------
SUP_HOST=''
CP_HOST=''
SETTINGS_HASH=''
GEN_DIR=''

route_hosts() {
  local domain
  domain="$(oc get ingresses.config/cluster -o jsonpath='{.spec.domain}')"
  [[ -n "$domain" ]] || die 'could not read the cluster apps domain (ingresses.config/cluster .spec.domain)'
  SUP_HOST="moca-$NS.$domain"
  CP_HOST="moca-control-plane-$NS.$domain"
}

# The client id as resolved by write_settings (sticky: the earlier run's value when
# SH_GITHUB_CLIENT_ID is unset). write_overlay and wait_ready decide replicas from this, never from
# the raw environment, so a re-run without the variable keeps the control plane running.
CLIENT_ID=''
client_id() { printf '%s' "$CLIENT_ID"; }

public_harness_url() { if is_kind; then echo 'http://127.0.0.1:8080'; else echo "https://$SUP_HOST"; fi; }

# sha256: stdin's SHA-256, hex. sha256sum (Linux, coreutils) or shasum (macOS), whichever is present.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1
}

# Non-secret settings, read by the control plane through configMapKeyRef. Env from a ConfigMap is read
# only at container start, so write_overlay stamps SETTINGS_HASH on the control plane's pod template:
# a change rolls it through the apply itself. Nothing remembers "changed" between runs, so a run that
# writes new settings and then fails cannot lose the roll -- the next run renders the same new hash.
#
# Sticky: each input variable that is UNSET keeps the value moca-settings already holds; one that is
# set, even to empty (SH_ADMIN_SUBJECTS=), replaces it. SH_PUBLIC_HARNESS_URL is not an input: it is
# derived from the target (and the Route host) on every run.
write_settings() {
  local before after admins fb
  before="$(configmap_json moca-settings)"
  if [[ -n "${SH_GITHUB_CLIENT_ID+x}" ]]; then CLIENT_ID="$SH_GITHUB_CLIENT_ID"; else CLIENT_ID="$(cm_value "$before" SH_GITHUB_CLIENT_ID)"; fi
  if [[ -z "$CLIENT_ID" && "$TARGET" == kind-ci ]]; then
    # The CI smoke mints its own API tokens; no login ever runs, but the control plane needs a value.
    CLIENT_ID='Iv1.k8s-smoke-unused'
  fi
  if [[ -n "${SH_ADMIN_SUBJECTS+x}" ]]; then admins="$SH_ADMIN_SUBJECTS"; else admins="$(cm_value "$before" SH_ADMIN_SUBJECTS)"; fi
  if [[ -n "${SH_ALLOW_OPERATOR_FALLBACK+x}" ]]; then fb="$SH_ALLOW_OPERATOR_FALLBACK"; else fb="$(cm_value "$before" SH_ALLOW_OPERATOR_FALLBACK)"; fi
  fb="${fb:-false}"
  after="$(jq -ncS --arg id "$CLIENT_ID" --arg admins "$admins" --arg url "$(public_harness_url)" \
    --arg fb "$fb" \
    '{SH_GITHUB_CLIENT_ID: $id, SH_ADMIN_SUBJECTS: $admins, SH_PUBLIC_HARNESS_URL: $url, SH_ALLOW_OPERATOR_FALLBACK: $fb}')"
  jq -n --arg ns "$NS" --argjson data "$after" \
    '{apiVersion: "v1", kind: "ConfigMap", metadata: {name: "moca-settings", namespace: $ns}, data: $data}' |
    kc apply --server-side --force-conflicts --field-manager=moca-setup -f - >/dev/null
  SETTINGS_HASH="$(printf '%s' "$after" | sha256)"
}

# kind-ci's mock model, from the file itself: no kustomization reads outside its root.
ensure_mock_model() {
  [[ "$TARGET" == kind-ci ]] || return 0
  kc create configmap moca-mock-model -n "$NS" \
    --from-file=mock-anthropic.mjs="$REPO_ROOT/deploy/microvm/mock-anthropic.mjs" --dry-run=client -o json |
    kc apply --server-side --force-conflicts --field-manager=moca-setup -f - >/dev/null
}

# The passthrough Route needs a certificate valid for the Route host, which service-ca cannot issue.
ensure_tls() {
  [[ "$TARGET" == ocp ]] || return 0
  if [[ -n "$TLS_CERT" ]]; then
    log "installing the supervisor TLS certificate from $TLS_CERT"
    kc create secret tls moca-supervisor-tls -n "$NS" --cert="$TLS_CERT" --key="$TLS_KEY" --dry-run=client -o json |
      kc apply --server-side --force-conflicts --field-manager=moca-setup -f - >/dev/null
    return 0
  fi
  # Absent reads as empty; any other API error aborts (set -e, outside any conditional), so an
  # unreadable operator certificate is never replaced by a self-signed one.
  local existing dir ca="$K8S_DIR/.generated/ocp/moca-supervisor-ca.crt"
  existing="$(kc get secret moca-supervisor-tls -n "$NS" --ignore-not-found -o name)"
  [[ -z "$existing" ]] || return 0
  mkdir -p "$(dirname "$ca")"
  dir="$(mktemp -d)"
  # A subshell, so its EXIT trap removes the private key on every path: success, a failed openssl,
  # a failed apply (set -e exits the subshell; the caller then aborts on its status).
  (
    trap 'rm -rf "$dir"' EXIT
    chmod 700 "$dir"
    # openssl's stderr is progress noise on success; on failure it is the reason, so show it.
    if ! openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$SUP_HOST" \
      -addext "subjectAltName=DNS:$SUP_HOST" -keyout "$dir/tls.key" -out "$ca" 2>"$dir/openssl.err"; then
      cat "$dir/openssl.err" >&2
      die "openssl could not create the self-signed certificate for $SUP_HOST"
    fi
    kc create secret tls moca-supervisor-tls -n "$NS" --cert="$ca" --key="$dir/tls.key" --dry-run=client -o json |
      kc apply --server-side --force-conflicts --field-manager=moca-setup -f - >/dev/null
  )
  log "WARNING: no --tls-cert given, so the supervisor uses a SELF-SIGNED certificate for $SUP_HOST."
  log "  Every mocactl user must trust it: export NODE_EXTRA_CA_CERTS=$ca"
}

# Explicit non-root UIDs need nonroot-v2 (restricted-v2 does not reliably admit them; see
# deploy/knative/setup-ocp.sh). Granted BEFORE the apply, so no pod is rejected first.
grant_scc() {
  [[ "$TARGET" == ocp ]] || return 0
  local sa
  for sa in moca-supervisor sandbox-relay redis moca-control-plane; do
    oc adm policy add-scc-to-user nonroot-v2 -z "$sa" -n "$NS" >/dev/null
  done
  oc adm policy add-scc-to-user nonroot-v2 -z moca-sandbox -n "$SBX_NS" >/dev/null
}

# image_entry FROM REF: a kustomize images: entry rewriting FROM to REF (tag or digest).
image_entry() {
  local from="$1" ref="$2" name tag=''
  if [[ "$ref" == *@* ]]; then
    printf '  - name: %s\n    newName: %s\n    digest: %s\n' "$from" "${ref%@*}" "${ref#*@}"
    return 0
  fi
  name="$ref"
  if [[ "${ref##*/}" == *:* ]]; then
    name="${ref%:*}"
    tag="${ref##*:}"
  fi
  printf '  - name: %s\n    newName: %s\n' "$from" "$name"
  [[ -z "$tag" ]] || printf '    newTag: %s\n' "$tag"
}

# Per-run values go in a generated overlay on top of the checked-in one, so the checked-in
# manifests stay exactly what the manifest tests render. write_overlay DIR: main passes
# .generated/$TARGET; packages/supervisor/test/k8s/generated-overlay.test.ts passes a sibling at the
# same depth (.generated/test-ocp) to render this function's real output through kubectl kustomize.
write_overlay() {
  local cp_replicas=1
  if [[ -z "$(client_id)" ]]; then
    cp_replicas=0
    log 'no SH_GITHUB_CLIENT_ID (given or stored): the control plane is installed with 0 replicas (nobody can log in without one); re-run with it set'
  fi
  GEN_DIR="$1"
  mkdir -p "$GEN_DIR"
  {
    printf '# GENERATED by deploy/k8s/setup.sh on every run. Do not edit; gitignored.\n'
    printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../../overlays/%s\n' "$TARGET"
    printf 'patches:\n'
    # base/control-plane.yaml's pod template has no annotations, so "add" creates the map.
    printf '  - target: { kind: Deployment, name: moca-control-plane }\n    patch: |-\n      - { op: replace, path: /spec/replicas, value: %s }\n' "$cp_replicas"
    printf '      - { op: add, path: /spec/template/metadata/annotations, value: { moca.dev/settings-hash: "%s" } }\n' "$SETTINGS_HASH"
    printf '  - target: { kind: StatefulSet, name: moca-sandbox }\n    patch: |-\n      - { op: replace, path: /spec/replicas, value: %s }\n' "$SH_SANDBOX_COUNT"
    if [[ "$TARGET" == ocp ]]; then
      printf '  - target: { kind: Route, name: moca }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$SUP_HOST"
      printf '  - target: { kind: Route, name: moca-control-plane }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$CP_HOST"
      if [[ -n "$IMAGE$SANDBOX_IMAGE" ]]; then
        printf 'images:\n'
        [[ -z "$IMAGE" ]] || image_entry ghcr.io/rossoctl/moca "$IMAGE"
        [[ -z "$SANDBOX_IMAGE" ]] || image_entry ghcr.io/rossoctl/moca-remote-worker "$SANDBOX_IMAGE"
      fi
    fi
  } >"$GEN_DIR/kustomization.yaml"
}

apply_stack() {
  kc apply -k "$GEN_DIR" >/dev/null
}

# Redis's PVC binds only through a default StorageClass. Kind has one; some OpenShift clusters do not,
# and then redis-0 sits Pending and wait_ready times out with no hint why.
warn_storage_class() {
  # Advisory only (listing StorageClasses is cluster-scoped and may be denied), but a failed read is
  # reported as one, never as "no default".
  local json n
  if ! json="$(kc get storageclass -o json)"; then
    log 'WARNING: could not list StorageClasses; if redis-0 stays Pending, check that one is the default'
    return 0
  fi
  n="$(printf '%s' "$json" |
    jq '[.items[] | select(.metadata.annotations["storageclass.kubernetes.io/is-default-class"] == "true")] | length')"
  [[ "$n" != 0 ]] ||
    log 'WARNING: the cluster has no default StorageClass, so the Redis PVC cannot bind and redis-0 will stay Pending: mark one default (storageclass.kubernetes.io/is-default-class=true)'
}

wait_ready() {
  local w
  for w in statefulset/redis deployment/sandbox-relay deployment/moca-supervisor; do
    kc rollout status "$w" -n "$NS" --timeout=300s
  done
  [[ -z "$(client_id)" ]] || kc rollout status deployment/moca-control-plane -n "$NS" --timeout=300s
  [[ "$SH_SANDBOX_COUNT" == 0 ]] || kc rollout status statefulset/moca-sandbox -n "$SBX_NS" --timeout=300s
}

# The install is not done until the relay has mirrored every sandbox into sh:sandbox:records -- that
# is what the supervisor leases from. redis-cli authenticates from the container's REDISCLI_AUTH.
wait_records() {
  if [[ "$SH_SANDBOX_COUNT" == 0 ]]; then
    log 'SH_SANDBOX_COUNT=0: no container sandboxes to wait for'
    return 0
  fi
  local n waited=0
  while :; do
    n="$(kc exec -n "$NS" redis-0 -- sh -c 'redis-cli HLEN sh:sandbox:records' 2>/dev/null | tr -dc '0-9' || true)"
    [[ "${n:-0}" -lt "$SH_SANDBOX_COUNT" ]] || break
    [[ "$waited" -lt "$SH_WAIT_SECONDS" ]] ||
      die "only ${n:-0} of $SH_SANDBOX_COUNT sandboxes attached to the relay after ${SH_WAIT_SECONDS}s: see 'kubectl -n $NS logs deployment/sandbox-relay' and 'kubectl -n $SBX_NS logs statefulset/moca-sandbox'"
    sleep 2
    waited=$((waited + 2))
  done
  log "$n sandbox(es) attached to the relay"
}

print_access() {
  if is_kind; then
    cat >&2 <<EOF
P6 is up on kind (context $KIND_CONTEXT). Reach it with two port-forwards:
  kubectl --context $KIND_CONTEXT -n $NS port-forward svc/moca-supervisor 8080:8080
  kubectl --context $KIND_CONTEXT -n $NS port-forward svc/moca-control-plane 8090:8080
then:  mocactl --control-plane-url http://127.0.0.1:8090 login
EOF
  else
    cat >&2 <<EOF
P6 is up on OpenShift.
  harness:        https://$SUP_HOST   (TLS passthrough to the supervisor's L4 sidecar)
  control plane:  https://$CP_HOST
then:  mocactl --control-plane-url https://$CP_HOST login
EOF
  fi
}

main() {
  parse_args "$@"
  preflight
  ensure_images
  ensure_namespaces
  load_setup_inputs
  ensure_secrets
  [[ "$TARGET" != ocp ]] || route_hosts
  ensure_tls
  write_settings
  ensure_mock_model
  grant_scc
  write_overlay "$K8S_DIR/.generated/$TARGET"
  warn_storage_class
  apply_stack
  wait_ready
  wait_records
  print_access
}

[[ "${SH_SOURCE_ONLY:-}" == 1 ]] || main "$@"
