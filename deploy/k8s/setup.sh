#!/usr/bin/env bash
# deploy/k8s/setup.sh -- bring up P6 on Kubernetes (docs/specs/2026-10-02-p6-on-kubernetes-slice1-design.md §4).
#
#   deploy/k8s/setup.sh --target kind|kind-ci|ocp|ocp-single [--image IMG] [--sandbox-image IMG]
#                       [--build|--skip-build] [--tls-cert FILE --tls-key FILE]
#                       [--relay-tls-cert FILE --relay-tls-key FILE] [--tls-secret NAME]
#
# Environment: SH_GITHUB_CLIENT_ID, SH_ADMIN_SUBJECTS, SH_ALLOW_OPERATOR_FALLBACK (default false),
# SH_SANDBOX_COUNT (default 2, at most 4 digits; 0 runs no container sandboxes), SH_WAIT_SECONDS
# (default 120), SH_P4_SANDBOX_IDS (ocp only: comma-separated IDs of P4 microVM hosts outside the cluster, each
# attaching to the relay over TLS; with SH_SANDBOX_COUNT>0 too, the stack is tiered
# (SH_SANDBOX_DEFAULT_TIER, default container; spec P6.3 §7)), SH_SANDBOX_DEFAULT_TIER (container or
# microvm: the tier a session gets when it names none, on a tiered stack), SH_SINGLE_NAMESPACE
# (ocp-single only: the one namespace everything lands in; default moca-single, must already exist),
# SH_ROUTE_DOMAIN (ocp-single only: opt in to Routes -- the public DNS domain whose hosts
# moca.<domain> and moca-control-plane.<domain> are the Route hostnames; see README §12.5),
# SH_SANDBOX_EGRESS_EXCEPT (every target: comma-separated IPv4 CIDRs the sandbox's internet egress
# rule excepts on top of the private, CGNAT and link-local ranges -- e.g. a publicly routable node
# network; README §6, #446), SH_API_TOKEN_TTL_SECONDS and SH_SESSION_TOKEN_TTL_SECONDS (the
# control plane's token lifetimes, whole seconds; empty means its defaults, 900 and 300; #432),
# SH_SOURCE_ONLY=1 (define the functions and stop, for tests).
#
# Idempotent: a re-run converges and never rotates a secret. Inputs are sticky: a re-run keeps every
# setting, --image, --sandbox-image (ocp), SH_SANDBOX_COUNT, SH_P4_SANDBOX_IDS,
# SH_SANDBOX_DEFAULT_TIER (not kind), SH_SANDBOX_EGRESS_EXCEPT and, on ocp-single, SH_ROUTE_DOMAIN
# and --tls-secret it is not given; an explicitly empty variable (SH_ADMIN_SUBJECTS=) clears it. No secret value is ever put on
# a command line -- values travel through pipes and through the environment of the one jq that
# writes each Secret.
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
RELAY_TLS_CERT=''
RELAY_TLS_KEY=''
# The loaded images' IDs on kind (ensure_images), stamped on the pod templates by write_overlay.
HARNESS_IMAGE_ID=''
SANDBOX_IMAGE_ID=''
# P4 sandbox IDs (P6.2), space-separated once normalised; resolved against moca-setup in load_setup_inputs.
P4_IDS=''
P4_IDS_GIVEN=''
# SH_SANDBOX_DEFAULT_TIER was set (even to empty) -- set in parse_args, resolved in load_setup_inputs.
DEFAULT_TIER_GIVEN=''
# ocp-single's namespace (README §12), validated in parse_args.
SINGLE_NS=''
# ocp-single's optional Routes (README §12.5): the public DNS domain when SH_ROUTE_DOMAIN opted in,
# empty when the stack is reached by port-forward. Validated in parse_args, resolved sticky in
# load_setup_inputs.
ROUTE_DOMAIN=''
# SH_SANDBOX_EGRESS_EXCEPT (#446), space-separated once normalised; resolved sticky in
# load_setup_inputs. EGRESS_EXCEPT_GIVEN: the variable was set (even to empty) -- set in parse_args.
EGRESS_EXCEPT=''
EGRESS_EXCEPT_GIVEN=''
# --tls-secret: a preinstalled kubernetes.io/tls Secret to serve the supervisor's Route with,
# instead of --tls-cert or a generated self-signed one. ocp-single only, and only with Routes.
TLS_SECRET=''

log() { printf '==> %s\n' "$*" >&2; }
die() {
  printf 'setup.sh: %s\n' "$*" >&2
  exit 1
}
usage() { awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

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
    --relay-tls-cert) need_value "$1" $# "${2-}"; RELAY_TLS_CERT="$2"; shift 2 ;;
    --relay-tls-key) need_value "$1" $# "${2-}"; RELAY_TLS_KEY="$2"; shift 2 ;;
    --tls-secret) need_value "$1" $# "${2-}"; TLS_SECRET="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
    esac
  done
  case "$TARGET" in
  kind | kind-ci | ocp | ocp-single) ;;
  '') die '--target is required: kind, kind-ci, ocp or ocp-single' ;;
  *) die "unknown --target '$TARGET': kind, kind-ci, ocp or ocp-single" ;;
  esac
  if [[ -n "$TLS_CERT$TLS_KEY" ]]; then
    [[ "$TARGET" == ocp || "$TARGET" == ocp-single ]] || die '--tls-cert/--tls-key apply to --target ocp or ocp-single only'
    [[ -n "$TLS_CERT" && -n "$TLS_KEY" ]] || die '--tls-cert and --tls-key go together'
    [[ -r "$TLS_CERT" && -r "$TLS_KEY" ]] || die "cannot read $TLS_CERT or $TLS_KEY"
    # Not also coupled to SH_ROUTE_DOMAIN here: the domain may be the earlier run's sticky value,
    # resolved in load_setup_inputs long after parse_args. ensure_tls refuses the combination,
    # the same deferral --tls-secret's validation documents.
  fi
  if [[ -n "$TLS_CERT$TLS_KEY" && -n "$TLS_SECRET" ]]; then
    die '--tls-cert/--tls-key and --tls-secret are two certificate sources; pass one'
  fi
  if [[ -n "$RELAY_TLS_CERT$RELAY_TLS_KEY" ]]; then
    [[ "$TARGET" == ocp ]] || die '--relay-tls-cert/--relay-tls-key apply to --target ocp only'
    [[ -n "$RELAY_TLS_CERT" && -n "$RELAY_TLS_KEY" ]] || die '--relay-tls-cert and --relay-tls-key go together'
    [[ -r "$RELAY_TLS_CERT" && -r "$RELAY_TLS_KEY" ]] || die "cannot read $RELAY_TLS_CERT or $RELAY_TLS_KEY"
  fi
  # Normalised and validated here, before anything touches a cluster. Unset means "the earlier run's
  # IDs" (load_setup_inputs); set-but-empty means none.
  P4_IDS_GIVEN="${SH_P4_SANDBOX_IDS+x}"
  # Same rule for the default tier: unset keeps the earlier run's, set-but-empty clears it. A GIVEN
  # value is checked here on every target, kind too, before anything touches a cluster (kind stores
  # none, but a typo should not pass silently); a stored one is checked in load_setup_inputs.
  DEFAULT_TIER_GIVEN="${SH_SANDBOX_DEFAULT_TIER+x}"
  case "${SH_SANDBOX_DEFAULT_TIER-}" in
  '' | container | microvm) ;;
  *) die "SH_SANDBOX_DEFAULT_TIER='$SH_SANDBOX_DEFAULT_TIER' must be container or microvm" ;;
  esac
  P4_IDS="$(normalize_p4_ids "${SH_P4_SANDBOX_IDS-}")"
  # The extra sandbox egress exceptions: same rule, unset keeps the earlier run's, set-but-empty
  # clears them. Validated here, so a malformed CIDR never reaches kustomize or the cluster.
  EGRESS_EXCEPT_GIVEN="${SH_SANDBOX_EGRESS_EXCEPT+x}"
  EGRESS_EXCEPT="$(normalize_egress_except "${SH_SANDBOX_EGRESS_EXCEPT-}")"
  [[ -z "$P4_IDS" ]] || [[ "$TARGET" == ocp ]] ||
    die "SH_P4_SANDBOX_IDS ($P4_IDS) needs --target ocp: a P4 host outside the cluster reaches the relay through an OpenShift Route, and $TARGET has none"
  if [[ -n "$TLS_SECRET" ]]; then
    [[ "$TARGET" == ocp-single ]] || die '--tls-secret applies to --target ocp-single only'
    # Not also coupled to SH_ROUTE_DOMAIN here: the domain may be the earlier run's sticky value,
    # resolved in load_setup_inputs long after parse_args. ensure_tls refuses the combination.
  fi  # ocp-single's optional Routes (README §12.5): validated here, before anything touches a cluster.
  # The domain cannot be read at cluster scope with namespace rights, so it is given, not found.
  if [[ "$TARGET" == ocp-single && -n "${SH_ROUTE_DOMAIN-}" ]]; then
    [[ "$SH_ROUTE_DOMAIN" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)+$ ]] ||
      die "SH_ROUTE_DOMAIN='$SH_ROUTE_DOMAIN' is not a DNS name (lowercase labels separated by dots)"
  fi
  # A domain on any other target is a mistake: those targets either have Routes by other means
  # (ocp, whose hosts the cluster's apps domain sets) or none at all (kind). Only the set-and-
  # nonempty case is refused; set-and-empty on ocp-single means "Routes off" (load_setup_inputs).
  if [[ -n "${SH_ROUTE_DOMAIN-}" && "$TARGET" != ocp-single ]]; then
    die "SH_ROUTE_DOMAIN ($SH_ROUTE_DOMAIN) needs --target ocp-single: it names the domain your namespace's Routes are served on (README §12.5)"
  fi
  # ocp-single's namespace: validated here, before anything touches a cluster. It must already
  # exist -- creating one needs cluster scope, which this target assumes you lack.
  if [[ "$TARGET" == ocp-single ]]; then
    SINGLE_NS="${SH_SINGLE_NAMESPACE:-moca-single}"
    [[ "$SINGLE_NS" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
      die "SH_SINGLE_NAMESPACE='$SINGLE_NS' is not a namespace name (lowercase alphanumerics and '-', 1-63 chars)"
    [[ "$SINGLE_NS" != moca && "$SINGLE_NS" != moca-sandbox && "$SINGLE_NS" != moca-credentials ]] ||
      die "SH_SINGLE_NAMESPACE='$SINGLE_NS' collides with the base's namespace names; pick a dedicated one"
  fi
  # Validated here, before anything touches a cluster; an unset or empty count is resolved later,
  # from the earlier run's value (load_setup_inputs). At most 4 digits: $((10#...)) overflows
  # silently on a longer one, and could come out negative ("not 0", so tiered; negative replicas).
  SH_SANDBOX_COUNT="${SH_SANDBOX_COUNT:-}"
  [[ -z "$SH_SANDBOX_COUNT" || "$SH_SANDBOX_COUNT" =~ ^[0-9]{1,4}$ ]] ||
    die "SH_SANDBOX_COUNT='$SH_SANDBOX_COUNT' must be a whole number of at most 4 digits (0 runs no container sandboxes)"
  # The token lifetimes: validated here when given; a stored one is checked in write_settings.
  local ttl
  for ttl in SH_API_TOKEN_TTL_SECONDS SH_SESSION_TOKEN_TTL_SECONDS; do
    valid_ttl "${!ttl-}" || die "$ttl='${!ttl}' must be a whole number of seconds, 1 to 8 digits (empty: the control plane's default)"
  done
  SH_WAIT_SECONDS="${SH_WAIT_SECONDS:-120}"
}

# valid_ttl VALUE: empty (the control plane's default) or a positive whole number of seconds. At
# most 8 digits (over three years): the control plane silently takes its default for anything it
# cannot read as a positive number, so a typo must be refused here instead.
valid_ttl() { [[ -z "$1" || "$1" =~ ^[1-9][0-9]{0,7}$ ]]; }

is_kind() { [[ "$TARGET" == kind || "$TARGET" == kind-ci ]]; }

# ocp-single: every workload, Secret, Role and policy in ONE namespace (README §12). Resolved in
# parse_args (SH_SINGLE_NAMESPACE validation) and applied here, after parse_args, so TARGET is
# known. SINGLE_NS is the validated value; NS and SBX_NS both collapse to it.
resolve_namespaces() {
  if [[ "$TARGET" == ocp-single ]]; then
    NS="$SINGLE_NS"
    SBX_NS="$SINGLE_NS"
  fi
}

# Every cluster call goes through here. On Kind it is pinned to the kind-moca context, never the
# ambient one: a Kind run must not apply a stack to whatever cluster the shell happens to point at.
kc() {
  if is_kind; then kubectl --context "$KIND_CONTEXT" "$@"; else kubectl "$@"; fi
}

# version_ge A B: A >= B, dotted numeric.
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

preflight() {
  local need='kubectl openssl jq' missing='' c v
  if is_kind; then need="$need kind docker"; elif [[ "$TARGET" != ocp-single ]]; then need="$need oc"; fi
  # ocp-single runs kubectl only: no SCC grant and no Route reads, so oc is never needed.
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
    if [[ "$TARGET" == ocp-single ]]; then
      # The tenant's kubeconfig IS the login; nothing reads cluster-scoped objects.
      log "target cluster: $(kubectl config current-context)"
    else
      oc whoami >/dev/null 2>&1 || die 'not logged in to OpenShift: run `oc login` first'
      log "target cluster: $(kubectl config current-context)"
    fi
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
  # A rebuilt image keeps its `:local` tag, so the apply sees an unchanged pod template and rolls
  # nothing: the pods go on running the old image. write_overlay stamps these IDs on the templates so a
  # new image is a template change. Read on --skip-build too (an image built and loaded by hand); one
  # that is not in the local docker reads as '' -- stable across runs, so it rolls nothing.
  HARNESS_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$LOCAL_HARNESS" 2>/dev/null || true)"
  SANDBOX_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$LOCAL_SANDBOX" 2>/dev/null || true)"
}

# The harness image as the cluster runs it (for the one-shot key generator pod).
harness_ref() { if is_kind; then echo "$LOCAL_HARNESS"; else echo "${IMAGE:-ghcr.io/rossoctl/moca:latest}"; fi; }

# Namespaces alone first, so Secrets can land before any workload that mounts them.
ensure_namespaces() {
  if [[ "$TARGET" == ocp-single ]]; then
    # The one namespace must already exist: creating one needs cluster scope, which this target
    # assumes you lack. A readable GET is also the permission check for everything that follows.
    kc get namespace "$NS" >/dev/null 2>&1 ||
      die "namespace $NS does not exist (or is unreadable). --target ocp-single cannot create it: have the cluster's admin create it, then re-run"
  else
    kc apply -f "$K8S_DIR/base/namespaces.yaml" >/dev/null
  fi
}

# configmap_json NAME: the ConfigMap in $NS as JSON, or nothing when it does not exist. Any other
# API error fails, and the caller's assignment aborts the run (set -e, outside any conditional): an
# unreadable ConfigMap must never look like a missing one, or this run would reset every input the
# operator gave an earlier one. One command, like secret_json: a command substitution does not
# inherit set -e, so a failure inside a longer body here would be swallowed.
configmap_json() { kc get configmap "$1" -n "$NS" --ignore-not-found -o json; }

# cm_value JSON KEY: KEY's value from configmap_json's output (possibly empty), or nothing.
cm_value() { printf '%s' "$1" | jq -r --arg k "$2" '.data[$k] // empty'; }

# normalize_p4_ids "a, b,," -> "a b": comma-separated; each entry trimmed, empty entries dropped. An
# ID must match the relay's token-directory rule (spec §2.1: the relay reads <dir>/<id>) and appear
# once -- two hosts with one ID would share a token and a workspace. DIR is reserved: the relay
# refuses it before any lookup, since SH_RELAY_TOKEN_DIR is its token-directory setting.
normalize_p4_ids() {
  [[ -n "$1" ]] || return 0
  [[ "$1" != *$'\n'* ]] || die "SH_P4_SANDBOX_IDS must be one line"
  local -a parts
  local id out=''
  IFS=',' read -ra parts <<<"$1"
  for id in ${parts[@]+"${parts[@]}"}; do
    id="${id#"${id%%[![:space:]]*}"}"
    id="${id%"${id##*[![:space:]]}"}"
    [[ -n "$id" ]] || continue
    [[ "$id" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
      die "SH_P4_SANDBOX_IDS: '$id' must match ^[A-Za-z_][A-Za-z0-9_]*\$ (the relay looks its token up by this name)"
    [[ "$id" != DIR ]] ||
      die "SH_P4_SANDBOX_IDS: 'DIR' is reserved: SH_RELAY_TOKEN_DIR is the relay's token-directory setting, so the relay refuses that ID"
    case " $out " in *" $id "*) die "SH_P4_SANDBOX_IDS lists '$id' twice" ;; esac
    out="${out:+$out }$id"
  done
  printf '%s' "$out"
}

# The ranges the sandbox's internet egress rule always excepts (base/sandbox.yaml and
# overlays/ocp-single/patch-policies.yaml): RFC 1918, CGNAT, link-local.
BUILTIN_EGRESS_EXCEPT='10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16'

# normalize_egress_except "203.0.113.0/24, 198.51.100.7/32,," -> "203.0.113.0/24 198.51.100.7/32":
# comma-separated, each entry trimmed, empty entries dropped. Each must be an IPv4 CIDR in canonical
# form (no host bits set, no leading zeros) with a prefix of 1-32: the rule's cidr is 0.0.0.0/0, and
# an except entry must be a strict subset of it. A range listed twice, or one the rule already
# excepts, is refused rather than rendered twice.
normalize_egress_except() {
  [[ -n "$1" ]] || return 0
  [[ "$1" != *$'\n'* ]] || die "SH_SANDBOX_EGRESS_EXCEPT must be one line"
  local -a parts
  local c out='' o1 o2 o3 o4 len ip octet='(0|[1-9][0-9]{0,2})'
  IFS=',' read -ra parts <<<"$1"
  for c in ${parts[@]+"${parts[@]}"}; do
    c="${c#"${c%%[![:space:]]*}"}"
    c="${c%"${c##*[![:space:]]}"}"
    [[ -n "$c" ]] || continue
    [[ "$c" =~ ^$octet\.$octet\.$octet\.$octet/([1-9]|[12][0-9]|3[0-2])$ ]] ||
      die "SH_SANDBOX_EGRESS_EXCEPT: '$c' is not an IPv4 CIDR a.b.c.d/N with N 1-32"
    o1="${BASH_REMATCH[1]}" o2="${BASH_REMATCH[2]}" o3="${BASH_REMATCH[3]}" o4="${BASH_REMATCH[4]}" len="${BASH_REMATCH[5]}"
    ((o1 <= 255 && o2 <= 255 && o3 <= 255 && o4 <= 255)) ||
      die "SH_SANDBOX_EGRESS_EXCEPT: '$c' has an octet above 255"
    ip=$(((o1 << 24) | (o2 << 16) | (o3 << 8) | o4))
    ((len == 32 || (ip & ((1 << (32 - len)) - 1)) == 0)) ||
      die "SH_SANDBOX_EGRESS_EXCEPT: '$c' has host bits set; give the network address of the range"
    case " $BUILTIN_EGRESS_EXCEPT " in *" $c "*) die "SH_SANDBOX_EGRESS_EXCEPT: '$c' is always excepted already" ;; esac
    case " $out " in *" $c "*) die "SH_SANDBOX_EGRESS_EXCEPT lists '$c' twice" ;; esac
    out="${out:+$out }$c"
  done
  printf '%s' "$out"
}

# Sandbox tiers (P6.3, docs/specs/2026-10-04-p6-on-kubernetes-slice3-design.md §7): a stack with BOTH
# container sandboxes and P4 hosts is tiered -- each session stays in the tier it was created in.
# A single-tier stack stays untiered on purpose: a pre-P6.3 worker advertises no tier and a tiered
# supervisor would exclude it, so tiering it would only risk capacity.
derive_tiers() {
  TIERS='' DEFAULT_TIER=''
  [[ "$SH_SANDBOX_COUNT" != 0 && -n "$P4_IDS" ]] || return 0
  TIERS='container,microvm'
  DEFAULT_TIER="${STORED_DEFAULT_TIER:-container}"
  log "two sandbox tiers (container, microvm; default $DEFAULT_TIER): each session stays in its tier"
}

# --- Sticky inputs (moca-setup) -------------------------------------------------------------------
# A re-run is how an operator changes ONE input (README "Re-running"), so it must not reset the ones
# it is not given: without this, a rotation recipe that sets one variable rolled an OCP stack back to
# :latest, scaled the sandboxes back to 2 and the control plane to 0. --image, --sandbox-image,
# SH_SANDBOX_COUNT, SH_P4_SANDBOX_IDS and SH_SANDBOX_DEFAULT_TIER are kept in the non-secret ConfigMap
# moca-setup and reused when not given. Kind ignores the stored images: it always runs the locally
# loaded dev.local tags, and --image there only picks what to pull, so only the sandbox count is
# stored for it (and kind runs no P4 hosts, so it is never tiered and keeps no default tier).
load_setup_inputs() {
  local json stored
  json="$(configmap_json moca-setup)"
  if ! is_kind; then
    [[ -n "$IMAGE" ]] || IMAGE="$(cm_value "$json" IMAGE)"
    [[ -n "$SANDBOX_IMAGE" ]] || SANDBOX_IMAGE="$(cm_value "$json" SANDBOX_IMAGE)"
    [[ -n "$P4_IDS_GIVEN" ]] || {
      stored="$(cm_value "$json" SH_P4_SANDBOX_IDS)"
      P4_IDS="$(normalize_p4_ids "$stored")"
    }
    # Stored even while the stack has one tier (ocp-single always does), unused until it has two.
    # Validated here, before moca-setup is written below, so a refused value -- given or stored --
    # stores nothing.
    if [[ -n "$DEFAULT_TIER_GIVEN" ]]; then
      STORED_DEFAULT_TIER="$SH_SANDBOX_DEFAULT_TIER" # parse_args has validated it
    else
      STORED_DEFAULT_TIER="$(cm_value "$json" SH_SANDBOX_DEFAULT_TIER)"
      # A stored value names where it came from, and how to clear it, as the stored count's does.
      case "$STORED_DEFAULT_TIER" in
      '' | container | microvm) ;;
      *) die "ConfigMap moca-setup holds SH_SANDBOX_DEFAULT_TIER='$STORED_DEFAULT_TIER', which must be container or microvm: re-run with SH_SANDBOX_DEFAULT_TIER set to one of them, or set but empty (SH_SANDBOX_DEFAULT_TIER=) to clear it" ;;
      esac
    fi
  fi
  [[ -n "$SH_SANDBOX_COUNT" ]] || SH_SANDBOX_COUNT="$(cm_value "$json" SH_SANDBOX_COUNT)"
  [[ -n "$SH_SANDBOX_COUNT" ]] || SH_SANDBOX_COUNT=2
  [[ "$SH_SANDBOX_COUNT" =~ ^[0-9]{1,4}$ ]] ||
    die "moca-setup holds SH_SANDBOX_COUNT='$SH_SANDBOX_COUNT': re-run with SH_SANDBOX_COUNT set to a whole number of at most 4 digits"
  # Normalised once, so every later comparison may be a string one: 00 is 0 (no container
  # sandboxes, so untiered), and 08 is 8, not an octal error.
  SH_SANDBOX_COUNT=$((10#$SH_SANDBOX_COUNT))
  derive_tiers
  local data
  if is_kind; then
    data="$(jq -nc --arg n "$SH_SANDBOX_COUNT" '{SH_SANDBOX_COUNT: $n}')"
  else
    data="$(jq -nc --arg n "$SH_SANDBOX_COUNT" --arg i "$IMAGE" --arg s "$SANDBOX_IMAGE" --arg p "${P4_IDS// /,}" \
      --arg t "$STORED_DEFAULT_TIER" \
      '{SH_SANDBOX_COUNT: $n, IMAGE: $i, SANDBOX_IMAGE: $s, SH_P4_SANDBOX_IDS: $p, SH_SANDBOX_DEFAULT_TIER: $t}
        | with_entries(select(.value != ""))')"
  fi
  # The extra sandbox egress exceptions apply on every target, Kind too (#446).
  [[ -n "$EGRESS_EXCEPT_GIVEN" ]] || EGRESS_EXCEPT="$(normalize_egress_except "$(cm_value "$json" SH_SANDBOX_EGRESS_EXCEPT)")"
  data="$(jq -nc --argjson d "$data" --arg e "${EGRESS_EXCEPT// /,}" \
    '($d + {SH_SANDBOX_EGRESS_EXCEPT: $e}) | with_entries(select(.value != ""))')"
  # ocp-single adds its namespace, so a later smoke.sh finds it without being told
  # (smoke.sh reads this key to pick its own -n). SH_ROUTE_DOMAIN is sticky the same way as every
  # other input: unset keeps the earlier run's value (Routes stay on), set-and-empty turns them
  # off, a new value moves them.
  if [[ "$TARGET" == ocp-single ]]; then
    data="$(jq -nc --argjson d "$data" --arg ns "$NS" '$d + {SH_SINGLE_NAMESPACE: $ns}')"
    if [[ -n "${SH_ROUTE_DOMAIN+x}" ]]; then ROUTE_DOMAIN="$SH_ROUTE_DOMAIN"; else ROUTE_DOMAIN="$(cm_value "$json" SH_ROUTE_DOMAIN)"; fi
    [[ -z "$ROUTE_DOMAIN" || "$ROUTE_DOMAIN" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)+$ ]] ||
      die "moca-setup holds SH_ROUTE_DOMAIN='$ROUTE_DOMAIN': re-run with SH_ROUTE_DOMAIN set to a DNS name or empty (Routes off)"
    data="$(jq -nc --argjson d "$data" --arg dom "$ROUTE_DOMAIN" '($d + {SH_ROUTE_DOMAIN: $dom}) | with_entries(select(.value != ""))')"
    # --tls-secret is sticky too: with Routes kept on (SH_ROUTE_DOMAIN unset), a re-run without
    # the flag must not fall back to a self-signed certificate over the operator's Secret.
    # --tls-cert/--tls-key, given on this run, replaces the source: the saved name is not loaded,
    # so it cannot silently beat the pair, and the key's absence from the ConfigMap below makes
    # the server-side apply drop it -- a later re-run with no certificate input cannot resurrect
    # it over what this run installed.
    if [[ -z "$TLS_SECRET" && -z "$TLS_CERT" && -n "$ROUTE_DOMAIN" ]]; then TLS_SECRET="$(cm_value "$json" SH_TLS_SECRET)"; fi
    # A certificate source with no Routes is refused HERE, before moca-setup is applied, so the
    # mistake is never recorded (and the Secret check below, which names the Secret, does not
    # mask it): a certificate nothing serves would leave the operator thinking theirs is in use.
    if [[ -n "$TLS_SECRET$TLS_CERT" && -z "$ROUTE_DOMAIN" ]]; then
      die '--tls-secret/--tls-cert need SH_ROUTE_DOMAIN: without it there is no Route to serve'
    fi
    # Before the ConfigMap apply, so a bad name is never recorded (a re-run cannot inherit the
    # mistake) -- even when the domain came from this same ConfigMap and Routes stay on.
    check_tls_secret
    if [[ -n "$TLS_SECRET" ]]; then
      data="$(jq -nc --argjson d "$data" --arg s "$TLS_SECRET" '$d + {SH_TLS_SECRET: $s}')"
    fi
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

# P4 hosts' attach tokens (spec §4.3): one key per P4 ID in moca-relay-sandbox-tokens, which the relay
# reads on every attach from its SH_RELAY_TOKEN_DIR mount (base/relay.yaml). Generated once and
# kept; a key whose ID is no longer listed is removed -- that is revocation. Removal uses an
# idempotent merge patch (nulling absent keys is a no-op), so it does not depend on whether the
# API server's server-side apply pruned the dropped stringData key itself. With no IDs the Secret
# stays, empty: the relay's mount of it is optional, but an emptied Secret revokes deterministically
# where a deleted one may not. Never in moca-sandbox: no P4 host runs there.
P4_TOKENS_SECRET=moca-relay-sandbox-tokens
ensure_p4_tokens() {
  [[ "$TARGET" == ocp ]] || return 0
  local json relay_json exec_token stale
  json="$(secret_json "$P4_TOKENS_SECRET" "$NS")"
  if [[ -n "$P4_IDS" ]]; then
    relay_json="$(secret_json moca-relay "$NS")"
    exec_token="$(json_value "$relay_json" MOCA_RELAY_EXEC_TOKEN)"
    (
      i=0
      for id in $P4_IDS; do
        tok="$(json_value "$json" "$id")"
        [[ -n "$tok" ]] || { log "generating the relay token for P4 sandbox $id"; tok="$(rand_hex)"; }
        # The relay refuses a directory token equal to the exec token (spec §2.2); never hand one out.
        while [[ "$tok" == "$exec_token" ]]; do
          log "the relay token for $id equals MOCA_RELAY_EXEC_TOKEN; regenerating it"
          tok="$(rand_hex)"
        done
        export "S_$i=$tok"
        i=$((i + 1))
      done
      # shellcheck disable=SC2086 # one argument per ID; IDs are validated identifiers
      apply_secret "$P4_TOKENS_SECRET" "$NS" $P4_IDS
    )
  fi
  [[ -n "$json" ]] || return 0
  stale="$(printf '%s' "$json" | jq -r --arg keep "$P4_IDS" \
    '($keep | split(" ")) as $k | .data // {} | keys[] | select(. as $x | ($k | index($x)) == null)')"
  [[ -n "$stale" ]] || return 0
  log "revoking the relay token of P4 sandbox(es) no longer listed: $(printf '%s' "$stale" | tr '\n' ' ')"
  kc patch secret "$P4_TOKENS_SECRET" -n "$NS" --type=merge \
    -p "$(printf '%s\n' "$stale" | jq -Rnc '{data: ([inputs | {key: ., value: null}] | from_entries)}')" >/dev/null
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
  ensure_p4_tokens
  ensure_redis_secret
  ensure_mu1_secret
}

# --- Settings, TLS, SCC, the generated overlay, apply, wait (spec §4.1 steps 5-7) -----------------
SUP_HOST=''
CP_HOST=''
RELAY_HOST=''
SETTINGS_HASH=''
# The sandbox tiers (derive_tiers): both '' on a single-tier stack. STORED_DEFAULT_TIER is the sticky
# SH_SANDBOX_DEFAULT_TIER input as resolved by load_setup_inputs (possibly ''); DEFAULT_TIER is what
# moca-settings gets.
TIERS=''
DEFAULT_TIER=''
STORED_DEFAULT_TIER=''
GEN_DIR=''
RELAY_CA="$K8S_DIR/.generated/ocp/moca-relay-ca.crt"
# The supervisor's self-issued certificate, when it has one (refresh_supervisor_ca), and on
# --target ocp the file mocactl users trust: that certificate plus the cluster's ingress CA (#432).
SUP_CA=''
TRUST_CA="$K8S_DIR/.generated/ocp/moca-ca.crt"
P4_BUNDLES="$K8S_DIR/.generated/ocp/p4"
ROUTE_CERT_MADE=''

route_hosts() {
  local domain
  domain="$(oc get ingresses.config/cluster -o jsonpath='{.spec.domain}')"
  [[ -n "$domain" ]] || die 'could not read the cluster apps domain (ingresses.config/cluster .spec.domain)'
  SUP_HOST="moca-$NS.$domain"
  CP_HOST="moca-control-plane-$NS.$domain"
  RELAY_HOST="moca-relay-$NS.$domain"
}

# The client id as resolved by write_settings (sticky: the earlier run's value when
# SH_GITHUB_CLIENT_ID is unset). write_overlay and wait_ready decide replicas from this, never from
# the raw environment, so a re-run without the variable keeps the control plane running.
CLIENT_ID=''
client_id() { printf '%s' "$CLIENT_ID"; }

public_harness_url() {
  if is_kind; then echo 'http://127.0.0.1:8080'
  elif [[ "$TARGET" == ocp-single ]]; then
    # Routes are opt-in (README §12.5): with a domain, the supervisor's passthrough Route is the
    # public URL; without one, the port-forward localhost one.
    if [[ -n "$ROUTE_DOMAIN" ]]; then echo "https://moca.$ROUTE_DOMAIN"; else echo 'http://127.0.0.1:8080'; fi
  else echo "https://$SUP_HOST"; fi
}

# sha256: stdin's SHA-256, hex. sha256sum (Linux, coreutils) or shasum (macOS), whichever is present.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1
}

# Non-secret settings, read by the control plane (and the tiers by the supervisor too) through
# configMapKeyRef. Env from a ConfigMap is read only at container start, so write_overlay stamps
# SETTINGS_HASH on both pod templates: a change rolls them through the apply itself. Nothing
# remembers "changed" between runs, so a run that writes new settings and then fails cannot lose the
# roll -- the next run renders the same new hash.
#
# Sticky: each input variable that is UNSET keeps the value moca-settings already holds; one that is
# set, even to empty (SH_ADMIN_SUBJECTS=), replaces it. SH_PUBLIC_HARNESS_URL is not an input: it is
# derived from the target (and the Route host) on every run; nor are SH_SANDBOX_TIERS and
# SH_SANDBOX_DEFAULT_TIER, which derive_tiers derives from the stack (its sticky input lives in
# moca-setup). They are written even when '' so every stack hashes the same eight keys; an empty
# token lifetime is the control plane's default.
write_settings() {
  local before after admins fb api_ttl session_ttl
  before="$(configmap_json moca-settings)"
  if [[ -n "${SH_GITHUB_CLIENT_ID+x}" ]]; then CLIENT_ID="$SH_GITHUB_CLIENT_ID"; else CLIENT_ID="$(cm_value "$before" SH_GITHUB_CLIENT_ID)"; fi
  if [[ -z "$CLIENT_ID" && "$TARGET" == kind-ci ]]; then
    # The CI smoke mints its own API tokens; no login ever runs, but the control plane needs a value.
    CLIENT_ID='Iv1.k8s-smoke-unused'
  fi
  if [[ -n "${SH_ADMIN_SUBJECTS+x}" ]]; then admins="$SH_ADMIN_SUBJECTS"; else admins="$(cm_value "$before" SH_ADMIN_SUBJECTS)"; fi
  if [[ -n "${SH_ALLOW_OPERATOR_FALLBACK+x}" ]]; then fb="$SH_ALLOW_OPERATOR_FALLBACK"; else fb="$(cm_value "$before" SH_ALLOW_OPERATOR_FALLBACK)"; fi
  fb="${fb:-false}"
  if [[ -n "${SH_API_TOKEN_TTL_SECONDS+x}" ]]; then api_ttl="$SH_API_TOKEN_TTL_SECONDS"; else api_ttl="$(cm_value "$before" SH_API_TOKEN_TTL_SECONDS)"; fi
  if [[ -n "${SH_SESSION_TOKEN_TTL_SECONDS+x}" ]]; then session_ttl="$SH_SESSION_TOKEN_TTL_SECONDS"; else session_ttl="$(cm_value "$before" SH_SESSION_TOKEN_TTL_SECONDS)"; fi
  # A given value was checked in parse_args; a stored one names where it came from, and how to clear it.
  valid_ttl "$api_ttl" ||
    die "moca-settings holds SH_API_TOKEN_TTL_SECONDS='$api_ttl': re-run with it set to a whole number of seconds, or set but empty (SH_API_TOKEN_TTL_SECONDS=) for the default"
  valid_ttl "$session_ttl" ||
    die "moca-settings holds SH_SESSION_TOKEN_TTL_SECONDS='$session_ttl': re-run with it set to a whole number of seconds, or set but empty (SH_SESSION_TOKEN_TTL_SECONDS=) for the default"
  # Valid but long: a stray extra digit must not mint near-permanent bearer tokens unnoticed.
  ((${api_ttl:-0} <= 604800)) ||
    log "WARNING: SH_API_TOKEN_TTL_SECONDS=$api_ttl is over 7 days: every API token a login mints stays valid that long"
  ((${session_ttl:-0} <= 604800)) ||
    log "WARNING: SH_SESSION_TOKEN_TTL_SECONDS=$session_ttl is over 7 days: every session token stays valid that long"
  after="$(jq -ncS --arg id "$CLIENT_ID" --arg admins "$admins" --arg url "$(public_harness_url)" \
    --arg fb "$fb" --arg tiers "$TIERS" --arg dtier "$DEFAULT_TIER" --arg api_ttl "$api_ttl" --arg session_ttl "$session_ttl" \
    '{SH_GITHUB_CLIENT_ID: $id, SH_ADMIN_SUBJECTS: $admins, SH_PUBLIC_HARNESS_URL: $url, SH_ALLOW_OPERATOR_FALLBACK: $fb,
      SH_SANDBOX_TIERS: $tiers, SH_SANDBOX_DEFAULT_TIER: $dtier,
      SH_API_TOKEN_TTL_SECONDS: $api_ttl, SH_SESSION_TOKEN_TTL_SECONDS: $session_ttl}')"
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

# route_cert SECRET HOST CERT KEY CA: a passthrough Route needs a certificate valid for HOST, which
# service-ca cannot issue. With CERT/KEY (an operator certificate), install them into SECRET.
# Otherwise -- only when SECRET does not exist yet -- generate a self-signed one for HOST, valid
# 825 days, and write its certificate to CA. Sets ROUTE_CERT_MADE=self-signed when it generated one.
# Never call this inside $(...): a command substitution drops set -e, and a failed GET there would
# read as "absent" and replace an operator certificate.
route_cert() {
  local secret="$1" host="$2" cert="$3" key="$4" ca="$5" existing dir
  ROUTE_CERT_MADE=''
  if [[ -n "$cert" ]]; then
    log "installing the $secret certificate from $cert"
    kc create secret tls "$secret" -n "$NS" --cert="$cert" --key="$key" --dry-run=client -o json |
      kc apply --server-side --force-conflicts --field-manager=moca-setup -f - >/dev/null
    return 0
  fi
  # Absent reads as empty; any other API error aborts (set -e, outside any conditional), so an
  # unreadable operator certificate is never replaced by a self-signed one.
  existing="$(kc get secret "$secret" -n "$NS" --ignore-not-found -o name)"
  [[ -z "$existing" ]] || return 0
  mkdir -p "$(dirname "$ca")"
  dir="$(mktemp -d)"
  # A subshell, so its EXIT trap removes the private key on every path: success, a failed openssl,
  # a failed apply (set -e exits the subshell; the caller then aborts on its status).
  (
    trap 'rm -rf "$dir"' EXIT
    chmod 700 "$dir"
    # openssl's stderr is progress noise on success; on failure it is the reason, so show it.
    if ! openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$host" \
      -addext "subjectAltName=DNS:$host" -keyout "$dir/tls.key" -out "$ca" 2>"$dir/openssl.err"; then
      cat "$dir/openssl.err" >&2
      die "openssl could not create the self-signed certificate for $host"
    fi
    kc create secret tls "$secret" -n "$NS" --cert="$ca" --key="$dir/tls.key" --dry-run=client -o json |
      kc apply --server-side --force-conflicts --field-manager=moca-setup -f - >/dev/null
  )
  ROUTE_CERT_MADE=self-signed
}

# check_tls_secret: the --tls-secret (or saved SH_TLS_SECRET) must exist and be kubernetes.io/tls.
# Called from load_setup_inputs BEFORE moca-setup is applied, so a mistyped name is refused without
# ever being recorded -- a later re-run cannot inherit the mistake. A failed GET aborts, never reads
# as "absent" (secret_json's rule).
check_tls_secret() {
  [[ -n "$TLS_SECRET" ]] || return 0
  local json
  json="$(secret_json "$TLS_SECRET" "$NS")"
  [[ -n "$json" ]] || die "Secret $TLS_SECRET does not exist (or is unreadable): --tls-secret needs a preinstalled kubernetes.io/tls Secret"
  [[ "$(printf '%s' "$json" | jq -r '.type // empty')" == 'kubernetes.io/tls' ]] ||
    die "Secret $TLS_SECRET is not a kubernetes.io/tls Secret; the ghostunnel sidecar needs tls.crt and tls.key"
}

ensure_tls() {
  if [[ "$TARGET" == ocp-single ]]; then
    SUP_CA="$K8S_DIR/.generated/ocp-single/moca-supervisor-ca.crt"
    # A certificate source with no Routes was already refused in load_setup_inputs (which sees
    # the sticky domain, and refuses before moca-setup records anything); by here Routes are on.
    # Without them nothing serves a certificate, so an earlier run's CA file is stale.
    [[ -n "$ROUTE_DOMAIN" ]] || { rm -f "$SUP_CA"; return 0; }
    # --tls-secret: a preinstalled certificate the sidecar references by name; no copy is made, so
    # an operator's Secret is never duplicated (and never rotated by a later self-signed default).
    if [[ -n "$TLS_SECRET" ]]; then
      check_tls_secret
      log "serving the supervisor Route with the preinstalled Secret $TLS_SECRET"
      refresh_supervisor_ca "$TLS_SECRET"
      return 0
    fi
    local host="moca.$ROUTE_DOMAIN"
    route_cert moca-supervisor-tls "$host" "$TLS_CERT" "$TLS_KEY" "$SUP_CA"
    [[ "$ROUTE_CERT_MADE" != self-signed ]] ||
      log "WARNING: no --tls-cert given, so the supervisor uses a SELF-SIGNED certificate for $host."
    refresh_supervisor_ca moca-supervisor-tls
    return 0
  fi
  [[ "$TARGET" == ocp ]] || return 0
  SUP_CA="$K8S_DIR/.generated/ocp/moca-supervisor-ca.crt"
  route_cert moca-supervisor-tls "$SUP_HOST" "$TLS_CERT" "$TLS_KEY" "$SUP_CA"
  [[ "$ROUTE_CERT_MADE" != self-signed ]] ||
    log "WARNING: no --tls-cert given, so the supervisor uses a SELF-SIGNED certificate for $SUP_HOST."
  refresh_supervisor_ca moca-supervisor-tls
  write_trust_file
  [[ -n "$P4_IDS" ]] || return 0
  route_cert moca-relay-tls "$RELAY_HOST" "$RELAY_TLS_CERT" "$RELAY_TLS_KEY" "$RELAY_CA"
  [[ "$ROUTE_CERT_MADE" != self-signed ]] ||
    log "no --relay-tls-cert given: the relay Route uses a SELF-SIGNED certificate for $RELAY_HOST; every P4 bundle carries it as relay-ca.crt"
  refresh_relay_ca
}

# self_issued_crt JSON NAME: the tls.crt of secret_json's output for Secret NAME when it is
# self-issued (subject == issuer: the self-signed one route_cert made, or an operator's own), else
# nothing. A certificate that chains to an issuer needs no file: mocactl keeps the system pool
# (NODE_EXTRA_CA_CERTS only adds), and an operator who uses a private issuer trusts it already. An
# unreadable one is said, not silently treated as issued: the supervisor cannot serve it either.
self_issued_crt() {
  local crt subject issuer
  crt="$(json_value "$1" tls.crt)"
  if [[ -n "$crt" ]] &&
    subject="$(printf '%s\n' "$crt" | openssl x509 -noout -subject_hash 2>/dev/null)" &&
    issuer="$(printf '%s\n' "$crt" | openssl x509 -noout -issuer_hash 2>/dev/null)"; then
    [[ "$subject" != "$issuer" ]] || printf '%s\n' "$crt"
    return 0
  fi
  log "WARNING: Secret $2 holds no readable certificate (tls.crt), so no trust file carries the supervisor's: fix or delete the Secret and re-run"
}

# refresh_supervisor_ca SECRET: SUP_CA holds SECRET's certificate when it is self-issued, and is
# absent otherwise. Read back from the Secret on every run (#432), so the file -- and the trust
# line print_access shows -- is right whichever run, or checkout, created the certificate.
refresh_supervisor_ca() {
  local json crt
  json="$(secret_json "$1" "$NS")"
  crt="$(self_issued_crt "$json" "$1")"
  mkdir -p "$(dirname "$SUP_CA")"
  if [[ -n "$crt" ]]; then
    # $(...) dropped the final newline; without it write_trust_file would glue the ingress CA onto
    # this certificate's END line, and Node then ignores the whole NODE_EXTRA_CA_CERTS file.
    printf '%s\n' "$crt" >"$SUP_CA"
    chmod 644 "$SUP_CA"
  else
    rm -f "$SUP_CA"
  fi
}

# write_trust_file (ocp): TRUST_CA holds what mocactl must trust to reach both Routes -- SUP_CA (the
# supervisor's passthrough Route) and the cluster's default ingress CA, which signs the control
# plane's edge Route and is usually not publicly trusted either (#432). Reading the ingress CA is
# best effort: without it the file still serves the supervisor, and the run says what is missing.
write_trust_file() {
  local json='' bundle='' err
  err="$(mktemp)"
  if json="$(kc get configmap default-ingress-cert -n openshift-config-managed --ignore-not-found -o json 2>"$err")"; then
    bundle="$(cm_value "$json" ca-bundle.crt)"
    [[ -n "$bundle" ]] ||
      log "WARNING: openshift-config-managed/default-ingress-cert is missing or has no ca-bundle.crt, so $TRUST_CA lacks the ingress CA"
  else
    log "WARNING: could not read openshift-config-managed/default-ingress-cert, so $TRUST_CA lacks the ingress CA: $(head -c 300 "$err")"
  fi
  rm -f "$err"
  mkdir -p "$(dirname "$TRUST_CA")"
  {
    [[ ! -f "$SUP_CA" ]] || printf '%s\n' "$(cat "$SUP_CA")"
    [[ -z "$bundle" ]] || printf '%s\n' "$bundle"
  } >"$TRUST_CA"
  if [[ -s "$TRUST_CA" ]]; then chmod 644 "$TRUST_CA"; else rm -f "$TRUST_CA"; fi
}

# trust_line: what every mocactl user must export, printed on every run (#432), not only on the run
# that made the certificate. Nothing when there is nothing to trust.
trust_line() {
  if [[ "$TARGET" == ocp && -f "$TRUST_CA" ]]; then
    if [[ -f "$SUP_CA" ]]; then
      printf "The supervisor's certificate is SELF-SIGNED. Every mocactl user must trust it and the cluster's ingress CA, both in one file:\n"
    else
      printf "If mocactl does not trust the cluster's ingress certificate (the control plane Route), trust its CA:\n"
    fi
    printf '  export NODE_EXTRA_CA_CERTS=%s\n' "$TRUST_CA"
  elif [[ "$TARGET" == ocp-single && -n "$SUP_CA" && -f "$SUP_CA" ]]; then
    printf "The supervisor's certificate is SELF-SIGNED. Every mocactl user must trust it:\n"
    printf '  export NODE_EXTRA_CA_CERTS=%s\n' "$SUP_CA"
  fi
}

# The CA a P4 host must trust (spec §4.4), read back from moca-relay-tls on every run so it is right
# whichever checkout created the certificate: the certificate itself when it is self-issued (the
# self-signed one route_cert made), nothing when it is an operator's -- that chains to an issuer
# the host trusts system-wide, and the worker keeps the system pool (RELAY_CA_FILE only adds).
refresh_relay_ca() {
  local json crt subject issuer
  json="$(secret_json moca-relay-tls "$NS")"
  crt="$(json_value "$json" tls.crt)"
  [[ -n "$crt" ]] || die 'moca-relay-tls has no tls.crt: delete the Secret and re-run, or pass --relay-tls-cert'
  subject="$(printf '%s\n' "$crt" | openssl x509 -noout -subject_hash)" || die 'moca-relay-tls holds no readable certificate'
  issuer="$(printf '%s\n' "$crt" | openssl x509 -noout -issuer_hash)" || die 'moca-relay-tls holds no readable certificate'
  mkdir -p "$(dirname "$RELAY_CA")"
  if [[ "$subject" == "$issuer" ]]; then
    printf '%s\n' "$crt" >"$RELAY_CA"
    chmod 644 "$RELAY_CA"
  else
    rm -f "$RELAY_CA"
  fi
}

# One bundle per P4 ID (spec §4.5): what `setup-microvm.sh --remote` installs on that host. The
# token reaches worker.env through the builtin printf, never argv. A bundle whose ID is no longer
# listed is deleted, like its token.
write_p4_bundles() {
  [[ "$TARGET" == ocp ]] || return 0
  local json id tok dir d
  if [[ -d "$P4_BUNDLES" ]]; then
    for d in "$P4_BUNDLES"/*/; do
      [[ -d "$d" ]] || continue
      id="$(basename "$d")"
      case " $P4_IDS " in
      *" $id "*) ;;
      *) log "deleting the bundle of $id (no longer in SH_P4_SANDBOX_IDS)"; rm -rf "$d" ;;
      esac
    done
  fi
  [[ -n "$P4_IDS" ]] || return 0
  json="$(secret_json "$P4_TOKENS_SECRET" "$NS")"
  for id in $P4_IDS; do
    tok="$(json_value "$json" "$id")"
    [[ -n "$tok" ]] || die "$P4_TOKENS_SECRET has no token for $id"
    dir="$P4_BUNDLES/$id"
    (
      umask 077
      mkdir -p "$dir"
      chmod 700 "$P4_BUNDLES" "$dir"
      printf 'RELAY_ADDR=%s:443\nRELAY_TLS=true\nSANDBOX_ID=%s\nSANDBOX_TOKEN=%s\n' "$RELAY_HOST" "$id" "$tok" >"$dir/worker.env"
      chmod 600 "$dir/worker.env"
      if [[ -f "$RELAY_CA" ]]; then
        cp "$RELAY_CA" "$dir/relay-ca.crt"
        chmod 600 "$dir/relay-ca.crt"
      else
        rm -f "$dir/relay-ca.crt"
      fi
    )
  done
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
  # kind loads local `:local` images, whose IDs ensure_images read; elsewhere the cluster pulls by
  # ref, so there is no ID and these stay empty (the render is exactly the pre-image-ID one).
  local harness_ann='' sandbox_ann=''
  if is_kind; then
    harness_ann=", moca.dev/image-id: \"$HARNESS_IMAGE_ID\""
    sandbox_ann="moca.dev/image-id: \"$SANDBOX_IMAGE_ID\""
  fi
  {
    printf '# GENERATED by deploy/k8s/setup.sh on every run. Do not edit; gitignored.\n'
    printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../../overlays/%s\n' "$TARGET"
    # P6.2 (spec §4.6): the relay's external path, only with P4 hosts; with none, slice 1's render.
    [[ -z "$P4_IDS" ]] || printf 'components:\n  - ../../overlays/ocp/p4-relay\n'
    # ocp-single's Routes (README §12.5), only when SH_ROUTE_DOMAIN opted in; with none, the
    # port-forward render §12 describes. ocp-single refuses P4 IDs, so the two components never
    # coexist and each printf is the only writer of the components: block.
    if [[ "$TARGET" == ocp-single && -n "$ROUTE_DOMAIN" ]]; then
      printf 'components:\n  - ../../overlays/ocp-single/routes\n'
    fi
    printf 'patches:\n'
    # base/control-plane.yaml's pod template has no annotations, so "add" creates the map.
    printf '  - target: { kind: Deployment, name: moca-control-plane }\n    patch: |-\n      - { op: replace, path: /spec/replicas, value: %s }\n' "$cp_replicas"
    printf '      - { op: add, path: /spec/template/metadata/annotations, value: { moca.dev/settings-hash: "%s"%s } }\n' "$SETTINGS_HASH" "$harness_ann"
    # The supervisor reads the tiers from moca-settings too (base/supervisor.yaml); roll it on a change.
    # Its pod template has no annotations in any overlay either, ocp-single's supervisor entry below
    # patches only env, and ocp-single's routes component (and the --tls-secret volume patch) touch
    # only the containers and volumes, so this stays the one "add" of the map.
    printf '  - target: { kind: Deployment, name: moca-supervisor }\n    patch: |-\n      - { op: add, path: /spec/template/metadata/annotations, value: { moca.dev/settings-hash: "%s"%s } }\n' "$SETTINGS_HASH" "$harness_ann"
    printf '  - target: { kind: StatefulSet, name: moca-sandbox }\n    patch: |-\n      - { op: replace, path: /spec/replicas, value: %s }\n' "$SH_SANDBOX_COUNT"
    if is_kind; then
      # Neither pod template carries annotations on kind (the relay's only one is ocp's p4-relay).
      printf '      - { op: add, path: /spec/template/metadata/annotations, value: { %s } }\n' "$sandbox_ann"
      printf '  - target: { kind: Deployment, name: sandbox-relay }\n    patch: |-\n      - { op: add, path: /spec/template/metadata/annotations, value: { moca.dev/image-id: "%s" } }\n' "$HARNESS_IMAGE_ID"
    fi
    # SH_SANDBOX_EGRESS_EXCEPT (#446): appended to the sandbox internet rule's except list, which is
    # egress[1] in the base and in ocp-single's patch-policies.yaml. The test op makes kustomize
    # fail loudly, rather than patch the wrong rule, if that ever moves.
    if [[ -n "$EGRESS_EXCEPT" ]]; then
      printf '  - target: { kind: NetworkPolicy, name: moca-sandbox }\n    patch: |-\n'
      printf '      - { op: test, path: /spec/egress/1/to/0/ipBlock/cidr, value: 0.0.0.0/0 }\n'
      local cidr
      for cidr in $EGRESS_EXCEPT; do
        printf '      - { op: add, path: /spec/egress/1/to/0/ipBlock/except/-, value: %s }\n' "$cidr"
      done
    fi
    if [[ "$TARGET" == ocp ]]; then
      printf '  - target: { kind: Route, name: moca }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$SUP_HOST"
      printf '  - target: { kind: Route, name: moca-control-plane }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$CP_HOST"
      [[ -z "$P4_IDS" ]] ||
        printf '  - target: { kind: Route, name: moca-relay }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$RELAY_HOST"
      if [[ -n "$IMAGE$SANDBOX_IMAGE" ]]; then
        printf 'images:\n'
        [[ -z "$IMAGE" ]] || image_entry ghcr.io/rossoctl/moca "$IMAGE"
        [[ -z "$SANDBOX_IMAGE" ]] || image_entry ghcr.io/rossoctl/moca-remote-worker "$SANDBOX_IMAGE"
      fi
    fi
    if [[ "$TARGET" == ocp-single ]]; then
      if [[ "$NS" != moca-single ]]; then
        # The env strings the overlay hard-coded against its moca-single placeholder
        # ("...moca-single.svc" hostnames, the credential and sandbox namespace settings):
        # strategic-merge patches, which replace an env var by name without touching the rest of
        # the list. They belong under patches:, so they come before the namespace: key below.
        printf '  - target: { kind: Deployment, name: moca-supervisor }\n'
        printf '    patch: |-\n'
        printf '      apiVersion: apps/v1\n      kind: Deployment\n      metadata: { name: moca-supervisor }\n'
        printf '      spec:\n        template:\n          spec:\n            containers:\n              - name: supervisor\n                env:\n'
        printf '                  - { name: SH_RELAY_ADDR, value: "sandbox-relay-exec.%s.svc:9444" }\n' "$NS"
        printf '                  - { name: SH_CONTROL_PLANE_URL, value: "http://moca-control-plane.%s.svc:8080" }\n' "$NS"
        printf '  - target: { kind: Deployment, name: moca-control-plane }\n'
        printf '    patch: |-\n'
        printf '      apiVersion: apps/v1\n      kind: Deployment\n      metadata: { name: moca-control-plane }\n'
        printf '      spec:\n        template:\n          spec:\n            containers:\n              - name: control-plane\n                env:\n'
        printf '                  - { name: SH_CREDENTIAL_NAMESPACE, value: "%s" }\n' "$NS"
        printf '                  - { name: SH_SANDBOX_NAMESPACE, value: "%s" }\n' "$NS"
        printf '  - target: { kind: StatefulSet, name: moca-sandbox }\n'
        printf '    patch: |-\n'
        printf '      apiVersion: apps/v1\n      kind: StatefulSet\n      metadata: { name: moca-sandbox }\n'
        printf '      spec:\n        template:\n          spec:\n            containers:\n              - name: sandbox\n                env:\n'
        printf '                  - { name: RELAY_ADDR, value: "sandbox-relay-attach.%s.svc:9443" }\n' "$NS"
      fi
      # ocp-single's Routes (README §12.5): the component's placeholder hosts, replaced with the
      # domain SH_ROUTE_DOMAIN gave; and with --tls-secret, the sidecar's volume points at the
      # preinstalled Secret by name instead of the moca-supervisor-tls the other two TLS sources
      # write (a strategic-merge patch on the volume by name; the material is never copied). Like
      # the env-string patches above, these belong under patches:, before the namespace: key.
      if [[ -n "$ROUTE_DOMAIN" ]]; then
        printf '  - target: { kind: Route, name: moca }\n    patch: |-\n      - { op: replace, path: /spec/host, value: moca.%s }\n' "$ROUTE_DOMAIN"
        printf '  - target: { kind: Route, name: moca-control-plane }\n    patch: |-\n      - { op: replace, path: /spec/host, value: moca-control-plane.%s }\n' "$ROUTE_DOMAIN"
        if [[ -n "$TLS_SECRET" && "$TLS_SECRET" != moca-supervisor-tls ]]; then
          printf '  - target: { kind: Deployment, name: moca-supervisor }\n'
          printf '    patch: |-\n'
          printf '      apiVersion: apps/v1\n      kind: Deployment\n      metadata: { name: moca-supervisor }\n'
          printf '      spec:\n        template:\n          spec:\n            volumes:\n              - name: tls\n                secret:\n                  secretName: %s\n' "$TLS_SECRET"
        fi
      fi
      # The namespace, as a transformer on the generated overlay: every object, every Service DNS
      # name the transformer rewrites, and the RoleBinding's subjects follow it. The checked-in
      # overlay builds against the moca-single placeholder, so with the default the env-string
      # patches above are skipped (the overlay already carries the right strings).
      printf 'namespace: %s\n' "$NS"
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
  elif [[ "$TARGET" == ocp-single ]]; then
    if [[ -n "$ROUTE_DOMAIN" ]]; then
      cat >&2 <<EOF
P6 is up on OpenShift, namespace $NS (single-namespace dev/test target), served by Routes:
  harness:        https://moca.$ROUTE_DOMAIN   (TLS passthrough to the supervisor's L4 sidecar)
  control plane:  https://moca-control-plane.$ROUTE_DOMAIN
then:  mocactl --control-plane-url https://moca-control-plane.$ROUTE_DOMAIN login
EOF
      trust_line >&2
    else
      cat >&2 <<EOF
P6 is up on OpenShift, namespace $NS (single-namespace dev/test target; no Routes). Reach it by port-forward:
  kubectl -n $NS port-forward svc/moca-supervisor 8080:8080
  kubectl -n $NS port-forward svc/moca-control-plane 8090:8080
then:  mocactl --control-plane-url http://127.0.0.1:8090 login
EOF
    fi
  else
    cat >&2 <<EOF
P6 is up on OpenShift.
  harness:        https://$SUP_HOST   (TLS passthrough to the supervisor's L4 sidecar)
  control plane:  https://$CP_HOST
then:  mocactl --control-plane-url https://$CP_HOST login
EOF
    trust_line >&2
    if [[ -n "$P4_IDS" ]]; then
      local id dir
      printf 'P4 hosts attach to https://%s (the relay, TLS passthrough). One bundle each -- it holds\n' "$RELAY_HOST" >&2
      printf "that host's relay token, so copy it straight to the host, install it, then delete the copy:\n" >&2
      for id in $P4_IDS; do
        dir="$P4_BUNDLES/$id"
        printf '  %s:  %s\n' "$id" "$dir" >&2
        printf '    ssh <kvm-host> rm -r moca-p4-%s   (an earlier copy, if any: scp -r would nest into it)\n' "$id" >&2
        printf '    scp -r %s <kvm-host>:moca-p4-%s\n' "$dir" "$id" >&2
        printf '    on <kvm-host>, from a moca checkout:  sudo deploy/microvm/setup-microvm.sh --remote ~/moca-p4-%s\n' "$id" >&2
      done
    fi
  fi
}

main() {
  parse_args "$@"
  resolve_namespaces
  preflight
  ensure_images
  ensure_namespaces
  load_setup_inputs
  ensure_secrets
  [[ "$TARGET" != ocp ]] || route_hosts
  ensure_tls
  write_p4_bundles
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
