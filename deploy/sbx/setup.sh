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
#   SBX_MODES_ALLOWED       optional; default per-exec: the sandbox modes a user may pick, a comma list
#                           of per-exec, lease and lease+processes (lease-mode spec §8.1). Lease mode
#                           stays off (per-exec) until the live smoke and the security review's lease
#                           section (README)
#   SBX_IDLE_CEILING_S      optional; 300-86400, default 1800: the longest lease idle timeout an owner
#                           may set, in seconds. Also every worker bundle's SH_LEASE_IDLE_CEILING_S, so
#                           the control plane and the workers clamp alike; at least 300, the worker's
#                           default idle timeout, which it refuses to start above its ceiling
#   SBX_EGRESS_CREDENTIALS  optional; unset, 0 or 1 (SBX0.2b, spec §4.3). 1 turns on user-scoped egress
#                           credentials: the control plane's file store (a PVC) and credential routes,
#                           a KEK and one bearer per KVM host in the Secret sbx-egress, and an egress
#                           bundle per host. Unset or 0 changes nothing (a re-run is byte-identical);
#                           turning it off later leaves sbx-egress and the PVC in place
#   SBX_EGRESS_HOSTS        optional, with SBX_EGRESS_CREDENTIALS=1: kvm-a=sbx_default,sbx_py312;kvm-b=w3
#                           (host ids ^[a-z0-9][a-z0-9-]{0,30}$; every template worker, one listed in
#                           SBX_TEMPLATES_FILE, owned by exactly one host). Unset: one host, kvm,
#                           owning every template worker
#   SBX_EGRESS_CREDENTIAL_TTL_SECONDS   optional; 5-300 (the control plane's default is 60)
#   SBX_REDIS_IMAGE         optional; repository[:tag]@sha256:<digest>: the image Redis runs instead of the
#                           base's valkey/valkey:9-alpine. For a namespace whose data a Redis 7.4 wrote
#                           (RDB format 12, which Valkey 9 cannot read: its AOF load aborts), e.g.
#                           docker.io/redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
#                           (the pin before #670). Unset: the base's image, as before
#   SBX_TEMPLATE_STORE      optional; unset, 0 or 1 (template lifecycle spec §3.1, §7.2). 1 gives the
#                           control plane its template store: a PVC for SH_PROVENANCE_DIR (the
#                           template catalog and the provenance records; SBX_TEMPLATES_FILE is
#                           imported into it once, at the first start, and ignored after that), and
#                           with SBX_TEMPLATE_HOSTS the host agents' bearers. Unset or 0 changes
#                           nothing; turning it off leaves the PVC in place
#   SBX_TEMPLATE_HOSTS      optional, with SBX_TEMPLATE_STORE=1: space-separated host ids
#                           (^[a-z0-9][a-z0-9-]{0,30}$) whose sbx-host-agent may build templates
#                           (template lifecycle spec §6.1); one bearer each in the Secret
#                           sbx-template-hosts, and a host-agent bundle each
#   SBX_WORKSPACE_IMAGE_MB  optional; default 2048 (microvm-worker's SH_WORKSPACE_IMAGE_MB)
#   SBX_PROFILE             optional; sandbox (default) or combined. combined renders
#                           deploy/k8s/overlays/ocp-combined instead of ocp-sbx: one control plane on
#                           the combined route profile serving Moca Pi sessions (the supervisor and its
#                           Route, SBX_MOCA_HOST) beside sandboxes (combined control plane design §3.6).
#                           It turns the template store on, keeps the harness's exec token in moca-relay,
#                           and adds the harness's keys to moca-mu1 (SH_SESSION_TOKEN_PUBLIC_KEYS,
#                           SH_CREDENTIAL_KEK, SH_EXCHANGE_TOKEN). Egress credentials are refused with it
#                           (both would mount a KEK). Its namespace must be another than a sandbox one's:
#                           a namespace whose moca-mu1 holds SH_JANITOR_TOKEN but no SH_EXCHANGE_TOKEN, or
#                           that has the sbx-api Route, is refused, before anything is applied
#   SBX_CONVERT_TO_COMBINED optional; 1 turns that refusal off, to convert an SBX0 namespace on purpose
#   SBX_MOCA_HOST           required with SBX_PROFILE=combined: the supervisor Route's host (Moca Pi turns);
#                           SBX_MOCA_TLS_{CERT,KEY} its certificate, otherwise self-signed
#   SBX_SANDBOX_IMAGE       required with SBX_PROFILE=combined, pinned by digest: the in-cluster container
#                           sandbox's image (moca-remote-worker); SBX_SANDBOX_REPLICAS, default 0
#   SBX_{ATTACH,EXEC,API}_TLS_{CERT,KEY}   optional; otherwise self-signed (attach, exec) or the
#                           router's default certificate (API)
#   SBX_JANITOR_WAIT_MINUTES optional; default max(60, SBX_TOKEN_TTL_MINUTES + 5): how long after a
#                           sandbox ends the host janitor frees its workspace. Must exceed the token
#                           lifetime plus the relay's 30 s leeway (spec §8.1, §8.3), and, when
#                           SBX_MODES_ALLOWED names a lease mode, that plus SBX_IDLE_CEILING_S too
#   SBX_API_CA_FILE         optional; a PEM CA the janitor trusts for the API Route, when that Route's
#                           certificate (the router's default, say) is not publicly trusted
# SBX_CLIENTS, increment 1a's static client tokens, is gone and refused.
#
# Re-runnable: every token, password, key and certificate is generated once and kept. A worker
# dropped from SBX_WORKERS has its token revoked and its bundle deleted; the relay reads worker
# tokens on each attach, so that acts at once. Both pods read everything else only at boot, so the
# generated overlay stamps a hash on each pod template, over what that pod reads (the control
# plane's over every setting and the public keyset; the relay's over its own settings and the
# keyset), and a change rolls the pods that read it. Secret values never reach argv or the log: they travel through jq's
# environment or a builtin printf into a pipe, and messages name keys only.
#
# Writes deploy/sbx/.generated/: the applied overlay, workers/<id>/ (worker.env [+ relay-ca.crt],
# for deploy/sbx/install-host.sh on the KVM host), janitor/ (janitor.env, janitor.token
# [+ api-ca.crt], for install-host.sh --janitor) and, with SBX_EGRESS_CREDENTIALS=1, egress/<host id>/
# (egress.env, egress.token [+ api-ca.crt], for install-host.sh --egress). Copy each bundle straight to its host and delete
# the copy. With SBX_TEMPLATE_STORE=1 and SBX_TEMPLATE_HOSTS, also host-agent/<host id>/
# (host-agent.env, host-agent.token [+ api-ca.crt]) for deploy/sbx/host-agent.sh (the RUNBOOK's host
# agent section). Users log in with `mocactl sbx login`; nothing here is handed to them. With
# SBX_PROFILE=combined all of it goes to deploy/sbx/.generated-<SBX_NAMESPACE>/ instead, with
# moca-ca.crt (the supervisor Route's self-signed certificate, the CA its clients trust, e.g.
# NODE_EXTRA_CA_CERTS) beside the other CAs.
set -euo pipefail

SBX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="$SBX_DIR/.generated"
OVERLAY_REL=../../k8s/overlays/ocp-sbx # from $GEN; ocp-combined with SBX_PROFILE=combined (validate)
# GEN is .generated-<namespace> with SBX_PROFILE=combined (validate), at the same depth, so OVERLAY_REL holds.
API_ROUTE='sbx-api'
HOSTS_TO_REINSTALL='' # workers whose SH_WORKSPACE_IDLE this run changes (check_host_idle)

log() { printf '==> %s\n' "$*" >&2; }
die() { echo "deploy/sbx/setup.sh: $*" >&2; exit 1; }
kc() { kubectl "$@"; }

# parse_args (--env-file), WORKER_RE and NS_RE, shared with status.sh.
USAGE='setup.sh [--env-file FILE]'
# shellcheck source=deploy/sbx/lib.sh
. "$SBX_DIR/lib.sh"

SUBJECTS_RE='^github:[0-9]+(,github:[0-9]+)*$'
# Positive whole numbers. The disk check multiplies SBX_MAX_TOTAL x SBX_WORKSPACE_IMAGE_MB x 10 and
# SBX_WORKSPACE_FS_GIB x 1024 x 8 in 64-bit shell arithmetic: six digits for the factors of the first
# (< 10^13) and nine for the filesystem size (< 10^13) keep both far from wrapping.
COUNT6_RE='^[1-9][0-9]{0,5}$'
COUNT9_RE='^[1-9][0-9]{0,8}$'
HOST_RE='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
MODE_RE='(per-exec|lease|lease\+processes)'
MODES_RE="^$MODE_RE(,$MODE_RE)*\$"

validate() {
  [[ -z "${SBX_CLIENTS:-}" ]] ||
    die 'SBX_CLIENTS was increment 1a (static client tokens) and is gone: unset it; users now run `mocactl sbx login`'
  [[ "${SBX_NAMESPACE:-}" =~ $NS_RE ]] || die 'SBX_NAMESPACE is required and must be a namespace name'
  # Combined: its own generated folder, so a run from a checkout that also deploys an SBX0 namespace
  # never rewrites that one's overlay, CAs or bundles (it would delete worker bundles it does not list,
  # and rewrite a host-agent bundle with another namespace's token). Before check_host_idle reads it.
  [[ "${SBX_PROFILE:-sandbox}" != combined ]] || GEN="$SBX_DIR/.generated-$SBX_NAMESPACE"
  [[ "${SBX_ATTACH_HOST:-}" =~ $HOST_RE ]] || die 'SBX_ATTACH_HOST is required and must be a DNS name'
  [[ "${SBX_EXEC_HOST:-}" =~ $HOST_RE ]] || die 'SBX_EXEC_HOST is required and must be a DNS name'
  [[ "$SBX_ATTACH_HOST" != "$SBX_EXEC_HOST" ]] || die 'SBX_ATTACH_HOST and SBX_EXEC_HOST must differ (one certificate each)'
  [[ -n "${SBX_IMAGE:-}" && "$SBX_IMAGE" != *[[:space:]]* ]] || die 'SBX_IMAGE is required (the relay image)'
  [[ -z "${SBX_REDIS_IMAGE:-}" || "$SBX_REDIS_IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] ||
    die 'SBX_REDIS_IMAGE must be pinned by digest: repository[:tag]@sha256:<64 hex>'
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
  : "${SBX_MODES_ALLOWED:=per-exec}" "${SBX_IDLE_CEILING_S:=1800}"
  [[ "$SBX_LIFETIME_DAYS" =~ ^([1-9]|[12][0-9]|30)$ ]] || die 'SBX_LIFETIME_DAYS must be a whole number of days, 1-30'
  [[ "$SBX_TOKEN_TTL_MINUTES" =~ ^([5-9]|[1-5][0-9]|60)$ ]] || die 'SBX_TOKEN_TTL_MINUTES must be a whole number of minutes, 5-60'
  [[ "$SBX_RETENTION_DAYS" =~ ^([1-9]|[1-8][0-9]|90)$ ]] || die 'SBX_RETENTION_DAYS must be a whole number of days, 1-90'
  TOKEN_TTL_S=$((SBX_TOKEN_TTL_MINUTES * 60))
  RETENTION_S=$((SBX_RETENTION_DAYS * 86400))
  # The janitor frees a terminated sandbox's workspace only once its last token has expired: no Exec
  # outlives its token (spec §3.6), so the wait must exceed the lifetime plus the relay's 30 s
  # leeway (§8.1). The default keeps a margin at the longest lifetime (60 min -> 65 min).
  local wait_default=$((SBX_TOKEN_TTL_MINUTES + 5))
  ((wait_default >= 60)) || wait_default=60
  : "${SBX_JANITOR_WAIT_MINUTES:=$wait_default}"
  [[ "$SBX_JANITOR_WAIT_MINUTES" =~ $COUNT6_RE ]] ||
    die 'SBX_JANITOR_WAIT_MINUTES must be a positive whole number of minutes (at most six digits)'
  JANITOR_AGE_S=$((SBX_JANITOR_WAIT_MINUTES * 60))
  ((JANITOR_AGE_S > TOKEN_TTL_S + 30)) ||
    die "SBX_JANITOR_WAIT_MINUTES ($JANITOR_AGE_S s) must exceed the token lifetime plus the 30 s leeway ($((TOKEN_TTL_S + 30)) s): the janitor would free a workspace a still-valid token can reach"
  [[ -z "${SBX_API_CA_FILE:-}" ]] || { [[ -f "$SBX_API_CA_FILE" && -r "$SBX_API_CA_FILE" ]] && grep -q -- '-----BEGIN CERTIFICATE-----' "$SBX_API_CA_FILE"; } ||
    die 'SBX_API_CA_FILE must name a readable PEM certificate file (the CA the janitor trusts for the API Route)'
  [[ "$SBX_MAX_INFLIGHT" =~ ^[1-8]$ ]] || die 'SBX_MAX_INFLIGHT must be 1-8'
  # The control plane's modesAllowedFromEnv names, with no spaces; it refuses to boot on any other.
  [[ "$SBX_MODES_ALLOWED" =~ $MODES_RE ]] ||
    die 'SBX_MODES_ALLOWED must be a comma list of per-exec, lease and lease+processes, no spaces'
  # The control plane's floor is 30 s, but the same value is the workers' SH_LEASE_IDLE_CEILING_S, and
  # a worker refuses to start with a ceiling below its default idle timeout, 300 s.
  # At most a day: the janitor's wait must outlast it when a lease mode is allowed (below).
  [[ "$SBX_IDLE_CEILING_S" =~ $COUNT6_RE ]] && ((SBX_IDLE_CEILING_S >= 300 && SBX_IDLE_CEILING_S <= 86400)) ||
    die "SBX_IDLE_CEILING_S must be a whole number of seconds, 300-86400 (a worker's ceiling must be at least its default idle timeout, 300 s)"
  # A token minted just before a delete reaches the sandbox for its lifetime plus the relay's 30 s
  # leeway, and each Exec it sends restarts the lease's idle clock, so a lease can stay live that long
  # plus the idle timeout. The janitor must not free the workspace (and its lease state file) under
  # a lease still running: its wait must exceed all three (vmpool's retireLeaseState relies on it).
  if [[ "$SBX_MODES_ALLOWED" == *lease* ]]; then
    local lease_live_s=$((TOKEN_TTL_S + 30 + SBX_IDLE_CEILING_S))
    ((JANITOR_AGE_S > lease_live_s)) ||
      die "SBX_JANITOR_WAIT_MINUTES ($JANITOR_AGE_S s) must exceed the token lifetime plus the 30 s leeway plus SBX_IDLE_CEILING_S ($lease_live_s s) when a lease mode is allowed: the janitor would free a workspace under a lease that is still live; raise it to at least $((lease_live_s / 60 + 1)) minutes"
  fi
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
  validate_egress
  validate_profile
  validate_store

  local pair
  for pair in ATTACH EXEC API MOCA; do
    local cert="SBX_${pair}_TLS_CERT" key="SBX_${pair}_TLS_KEY"
    [[ -z "${!cert:-}" && -z "${!key:-}" ]] || [[ -f "${!cert:-/nonexistent}" && -f "${!key:-/nonexistent}" ]] ||
      die "$cert and $key must both name readable files, or both be unset"
  done
  NS="$SBX_NAMESPACE"
}

# SBX_PROFILE (combined control plane design §3.6). Sets COMBINED, the overlay and the API Route's
# name, and turns the template store on (the combined overlay mounts its Secret unconditionally).
COMBINED=''
validate_profile() {
  case "${SBX_PROFILE:-sandbox}" in
  sandbox) return 0 ;;
  combined) ;;
  *) die 'SBX_PROFILE must be sandbox or combined' ;;
  esac
  COMBINED=1
  OVERLAY_REL=../../k8s/overlays/ocp-combined
  API_ROUTE='moca-api'
  [[ "${SBX_MOCA_HOST:-}" =~ $HOST_RE ]] || die 'SBX_MOCA_HOST is required with SBX_PROFILE=combined (the supervisor Route host)'
  local h
  for h in "$SBX_ATTACH_HOST" "$SBX_EXEC_HOST" "$SBX_API_HOST"; do
    [[ "$SBX_MOCA_HOST" != "$h" ]] || die 'SBX_MOCA_HOST must differ from the attach, exec and API hosts'
  done
  [[ -z "$EGRESS_ON" ]] ||
    die 'SBX_EGRESS_CREDENTIALS=1 is not supported with SBX_PROFILE=combined yet: both would mount SH_CREDENTIAL_KEK'
  # Pinned by digest, as every image in the namespace: a tag can move under a run.
  [[ "${SBX_SANDBOX_IMAGE:-}" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] ||
    die 'SBX_SANDBOX_IMAGE is required with SBX_PROFILE=combined, pinned by digest: repository[:tag]@sha256:<64 hex>'
  [[ "$SBX_IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] ||
    die 'SBX_IMAGE must be pinned by digest with SBX_PROFILE=combined: repository[:tag]@sha256:<64 hex>'
  : "${SBX_SANDBOX_REPLICAS:=0}"
  [[ "$SBX_SANDBOX_REPLICAS" =~ ^[0-9]$ ]] || die 'SBX_SANDBOX_REPLICAS must be 0-9'
  [[ "${SBX_TEMPLATE_STORE:-1}" == 1 ]] || die 'SBX_PROFILE=combined needs the template store (SBX_TEMPLATE_STORE=1)'
  SBX_TEMPLATE_STORE=1
}

# SBX_TEMPLATE_STORE and SBX_TEMPLATE_HOSTS (template lifecycle spec §3.1, §6.1, §7.2). Sets STORE_ON,
# STORE_HOSTS (host ids, in order) and STORE_HOSTS_JSON.
STORE_ON=''
STORE_HOSTS=''
STORE_HOSTS_JSON='[]'
validate_store() {
  case "${SBX_TEMPLATE_STORE:-}" in
    '' | 0)
      [[ -z "${SBX_TEMPLATE_HOSTS:-}" ]] || die 'SBX_TEMPLATE_HOSTS needs SBX_TEMPLATE_STORE=1'
      return 0
      ;;
    1) STORE_ON=1 ;;
    *) die 'SBX_TEMPLATE_STORE must be unset, 0 or 1' ;;
  esac
  local id seen=' '
  for id in ${SBX_TEMPLATE_HOSTS:-}; do
    [[ "$id" =~ $EGRESS_HOST_RE ]] || die "template host id '$id' must match $EGRESS_HOST_RE"
    [[ "$seen" != *" $id "* ]] || die "template host id '$id' is listed twice in SBX_TEMPLATE_HOSTS"
    seen+="$id "
    STORE_HOSTS+="${STORE_HOSTS:+ }$id"
  done
  # shellcheck disable=SC2086 # one argument per host; ids hold no whitespace
  STORE_HOSTS_JSON="$(jq -nc '[$ARGS.positional[] | {id: .}]' --args $STORE_HOSTS)"
}

# SBX_EGRESS_CREDENTIALS and what it takes (spec §4.3). Sets EGRESS_ON, EGRESS_IDS (host ids, in
# order), EGRESS_SPEC ("id=w1,w2" per host) and EGRESS_HOSTS_JSON, and checks the hosts against
# the template workers: each owned by exactly one host, so a bad list is refused before anything is applied.
EGRESS_ON=''
EGRESS_IDS=''
EGRESS_SPEC=''
EGRESS_HOSTS_JSON=''
EGRESS_HOST_RE='^[a-z0-9][a-z0-9-]{0,30}$'
validate_egress() {
  case "${SBX_EGRESS_CREDENTIALS:-}" in
    '' | 0) return 0 ;;
    1) EGRESS_ON=1 ;;
    *) die 'SBX_EGRESS_CREDENTIALS must be unset, 0 or 1' ;;
  esac
  if [[ -n "${SBX_EGRESS_CREDENTIAL_TTL_SECONDS:-}" ]]; then
    [[ "$SBX_EGRESS_CREDENTIAL_TTL_SECONDS" =~ ^([5-9]|[1-9][0-9]|[12][0-9][0-9]|300)$ ]] ||
      die 'SBX_EGRESS_CREDENTIAL_TTL_SECONDS must be a whole number of seconds, 5-300'
  fi
  local spec="${SBX_EGRESS_HOSTS:-}" entry id ws w owned=' ' seen=' '
  if [[ -z "$spec" ]]; then
    # Only template workers: the control plane refuses an egress worker that serves no template.
    spec="kvm=$(printf '%s,' $TEMPLATE_WORKERS)"
    spec="${spec%,}"
  fi
  [[ "$spec" != *[[:space:]]* ]] || die 'SBX_EGRESS_HOSTS must not contain whitespace (kvm-a=w1,w2;kvm-b=w3)'
  local -a entries
  IFS=';' read -r -a entries <<<"$spec"
  for entry in "${entries[@]}"; do
    [[ -n "$entry" ]] || die 'SBX_EGRESS_HOSTS has an empty entry (kvm-a=w1,w2;kvm-b=w3)'
    [[ "$entry" == *=* ]] || die "SBX_EGRESS_HOSTS entry '$entry' is not id=worker,worker"
    id="${entry%%=*}" ws="${entry#*=}"
    [[ "$id" =~ $EGRESS_HOST_RE ]] || die "host id '$id' must match $EGRESS_HOST_RE"
    [[ "$seen" != *" $id "* ]] || die "host id '$id' is listed twice in SBX_EGRESS_HOSTS"
    seen+="$id "
    [[ -n "$ws" ]] || die "SBX_EGRESS_HOSTS entry '$entry' lists no worker"
    local -a wl
    IFS=',' read -r -a wl <<<"$ws"
    for w in "${wl[@]}"; do
      [[ -n "$w" ]] || die "SBX_EGRESS_HOSTS entry '$entry' has an empty worker"
      [[ " $SBX_WORKERS " == *" $w "* ]] || die "worker '$w' is not in SBX_WORKERS (SBX_EGRESS_HOSTS entry '$id')"
      [[ " $TEMPLATE_WORKERS " == *" $w "* ]] || die "worker '$w' serves no template in SBX_TEMPLATES_FILE (SBX_EGRESS_HOSTS entry '$id'): the control plane refuses an egress worker that is not a template worker"
      [[ "$owned" != *" $w "* ]] || die "worker '$w' is listed twice in SBX_EGRESS_HOSTS (one host owns each worker)"
      owned+="$w "
    done
    EGRESS_IDS+="${EGRESS_IDS:+ }$id"
    EGRESS_SPEC+="${EGRESS_SPEC:+ }$id=$ws"
  done
  for w in $TEMPLATE_WORKERS; do
    [[ "$owned" == *" $w "* ]] || die "worker '$w' is not owned by any host in SBX_EGRESS_HOSTS"
  done
  # shellcheck disable=SC2086 # one argument per host; entries hold no whitespace
  EGRESS_HOSTS_JSON="$(jq -nc '[$ARGS.positional[] | split("=") | {id: .[0], workers: (.[1] | split(","))}]' --args $EGRESS_SPEC)"
}

# The Secret key that carries a host's bearer: packages/control-plane/src/egress-config.ts
# egressTokenEnvName (kvm-a -> SH_EGRESS_TOKEN_KVM_A), which the control plane reads from
# $CREDENTIALS_DIRECTORY/<NAME>. tests/setup.test.sh pins one hyphenated id.
egress_key() { printf 'SH_EGRESS_TOKEN_%s' "$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; }

# The Secret key of a template host's bearer: packages/control-plane/src/host-config.ts
# hostTokenEnvName (kvm-a -> SH_HOST_TOKEN_KVM_A), read from $CREDENTIALS_DIRECTORY/<NAME>.
host_key() { printf 'SH_HOST_TOKEN_%s' "$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; }

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
TEMPLATE_WORKERS=''
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
  TEMPLATE_WORKERS="${seen# }"
  TEMPLATE_WORKERS="${TEMPLATE_WORKERS% }"
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
  check_redis_image
}

# Without SBX_REDIS_IMAGE the overlay runs the base's Valkey 9, which cannot read RDB format 12 (what
# Redis 7.4 writes): a namespace whose redis StatefulSet runs another image would crash-loop redis-0
# once switched (#811). So that is refused, before anything is applied; a fresh namespace (no
# StatefulSet) and one already on Valkey pass. RUNBOOK §2.
check_redis_image() {
  [[ -z "${SBX_REDIS_IMAGE:-}" ]] || return 0
  local json image repo
  # Captured first (errexit), as in route_cert: a failing get must not read as "no StatefulSet".
  json="$(kc get statefulset redis -n "$NS" --ignore-not-found -o json)"
  [[ -n "$json" ]] || return 0
  image="$(jq -r '(.spec.template.spec.containers // []) | (map(select(.name == "redis")) + .)[0].image // empty' <<<"$json")"
  [[ -n "$image" ]] || die "could not read the image of StatefulSet redis in $NS"
  repo="${image%%@*}"
  [[ "${repo##*/}" != *:* ]] || repo="${repo%:*}"
  [[ "$repo" != *valkey/valkey* ]] || return 0
  die "StatefulSet redis in $NS runs $image, not Valkey, and Valkey 9 (the default without SBX_REDIS_IMAGE) cannot read the RDB format 12 Redis 7.4 writes: redis-0 would crash-loop. Until the data is migrated, set SBX_REDIS_IMAGE to that image pinned by digest (repository[:tag]@sha256:<digest>; the running digest: kubectl -n $NS get pod redis-0 -o jsonpath='{.status.containerStatuses[0].imageID}'). See deploy/sbx/RUNBOOK.md §2"
}

# SBX_PROFILE=combined in an SBX0 namespace would add the harness's keys to its moca-mu1 and switch
# its overlay (combined design §3.6: a namespace of its own). Refused, before anything is applied,
# when moca-mu1 holds SBX0's janitor token but no exchange token, or the sbx-api Route exists, unless
# SBX_CONVERT_TO_COMBINED=1. Only key names are read, never a value.
check_combined_namespace() {
  [[ -n "$COMBINED" ]] || return 0
  if [[ "${SBX_CONVERT_TO_COMBINED:-}" == 1 ]]; then
    log "SBX_CONVERT_TO_COMBINED=1: not checking whether $NS is an SBX0 namespace"
    return 0
  fi
  [[ -z "${SBX_CONVERT_TO_COMBINED:-}" || "$SBX_CONVERT_TO_COMBINED" == 0 ]] ||
    die 'SBX_CONVERT_TO_COMBINED must be unset, 0 or 1'
  local json route why=''
  json="$(secret_json moca-mu1)" || die "could not read the Secret moca-mu1 in $NS"
  if [[ -n "$json" ]] &&
    jq -e '(.data // {}) | has("SH_JANITOR_TOKEN") and (has("SH_EXCHANGE_TOKEN") | not)' <<<"$json" >/dev/null; then
    why='its moca-mu1 holds SH_JANITOR_TOKEN but no SH_EXCHANGE_TOKEN'
  fi
  route="$(kc get route sbx-api -n "$NS" --ignore-not-found -o name)" || die "could not read the Routes in $NS"
  [[ -z "$route" ]] || why="${why:+$why, and }it has the sbx-api Route"
  [[ -z "$why" ]] ||
    die "namespace $NS looks like an SBX0 (sandbox profile) namespace: $why. SBX_PROFILE=combined needs a namespace of its own; set SBX_CONVERT_TO_COMBINED=1 only to convert this one on purpose"
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
    '{apiVersion: "v1", kind: "Secret", type: "Opaque",
      metadata: {name: $name, namespace: $ns, labels: {"sbx.moca.dev/setup": "true"}},
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
    S_2="$(printf 'requirepass %s\nappendonly yes\ndir /data\nmaxmemory 200mb\nmaxmemory-policy noeviction\n' "$pw")"
    export S_2
    apply_secret moca-redis REDIS_PASSWORD REDIS_URL redis.conf
  )
}

# The base relay requires SH_RELAY_TOKEN, the attach fallback for an id with no directory token.
# SBX0 hands it to nobody; it exists so the relay boots, and is random so nobody can use it. From
# 1b there is no harness exec token (spec §3.1): the overlay drops the env entry, and
# remove_exec_token drops a 1a namespace's key once the new relay is up.
ensure_relay_secret() {
  local json relay exec=''
  json="$(secret_json moca-relay)"
  relay="$(json_value "$json" SH_RELAY_TOKEN)"
  [[ -n "$relay" ]] || { log 'generating SH_RELAY_TOKEN'; relay="$(rand_hex)"; }
  if [[ -z "$COMBINED" ]]; then
    (
      export S_0="$relay"
      apply_secret moca-relay SH_RELAY_TOKEN
    )
    return 0
  fi
  # Combined (design §3.6): the harness is an Exec caller too, with its own token, which the
  # supervisor and the relay both read from moca-relay. The in-cluster container sandbox attaches
  # with SH_RELAY_TOKEN, from moca-relay-attach as deploy/k8s/setup.sh lays it out.
  exec="$(json_value "$json" MOCA_RELAY_EXEC_TOKEN)"
  [[ -n "$exec" ]] || { log 'generating MOCA_RELAY_EXEC_TOKEN (the harness Exec caller)'; exec="$(rand_hex)"; }
  [[ "$exec" != "$relay" ]] || die 'moca-relay MOCA_RELAY_EXEC_TOKEN equals SH_RELAY_TOKEN: delete one and re-run'
  (
    export S_0="$relay" S_1="$exec"
    apply_secret moca-relay SH_RELAY_TOKEN MOCA_RELAY_EXEC_TOKEN
    export S_0="$relay"
    apply_secret moca-relay-attach SH_RELAY_TOKEN
  )
}

# A namespace set up by 1a holds MOCA_RELAY_EXEC_TOKEN in moca-relay, removed by explicit null patch
# (server-side apply does not prune it). Only AFTER the new relay has rolled out: the 1a relay's
# template requires that key, so removing it earlier, in a run that then fails, would leave any
# restarted 1a relay pod in CreateContainerConfigError.
remove_exec_token() {
  [[ -z "$COMBINED" ]] || return 0 # the harness's caller token stays (combined design §3.6)
  local json
  # Captured first (errexit), as in route_cert: inside the `if`, a failing get would read as "no key".
  json="$(secret_json moca-relay)"
  if jq -e '.data // {} | has("MOCA_RELAY_EXEC_TOKEN")' <<<"$json" >/dev/null; then
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
# moca-mu1 also holds the host janitor's bearer, SH_JANITOR_TOKEN (spec §8.1: generated once and
# kept). Both keys ride in the one apply: with one field manager, an apply that omitted a key would
# prune it.
ensure_signing_key() {
  local json priv dir jtok foreign='' published
  json="$(secret_json moca-mu1)"
  # A moca-mu1 this script did not write is a MOCA control plane's key (a shared namespace, or a
  # copied Secret), and signing with it would tie the two stacks together: refused, below, unless
  # its public key is already the one sbx-token-keys publishes (a namespace set up before the label).
  if [[ -n "$json" ]] && ! jq -e '.metadata.labels["sbx.moca.dev/setup"] == "true"' <<<"$json" >/dev/null; then
    foreign=1
    published="$(json_value "$(secret_json sbx-token-keys)" PUBLIC_KEYS)"
  fi
  priv="$(json_value "$json" SH_SESSION_TOKEN_PRIVATE_KEY)"
  jtok="$(json_value "$json" SH_JANITOR_TOKEN)"
  # Combined: the harness's keys beside SBX0's (combined design §3.5), each generated once and kept.
  local kek='' xtok=''
  if [[ -n "$COMBINED" ]]; then
    kek="$(json_value "$json" SH_CREDENTIAL_KEK)"
    [[ -n "$kek" ]] || { log 'generating the credential KEK (SH_CREDENTIAL_KEK)'; kek="$(openssl rand -base64 32 | tr -d '\n')"; }
    xtok="$(json_value "$json" SH_EXCHANGE_TOKEN)"
    [[ -n "$xtok" ]] || { log 'generating the exchange token (SH_EXCHANGE_TOKEN)'; xtok="$(rand_hex)"; }
  fi
  if [[ -z "$jtok" ]]; then
    log 'generating the janitor token (SH_JANITOR_TOKEN)'
    jtok="$(rand_hex)"
  fi
  # The control plane refuses one under 32 characters; it travels in an HTTP header file, so no space.
  [[ "$jtok" =~ ^[!-~]{32,}$ ]] ||
    die 'moca-mu1 SH_JANITOR_TOKEN is not 32+ printable characters: delete the key and re-run (this rotates it)'
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
    [[ -z "$foreign" || "$published" == "$kid:$spki" ]] ||
      die 'moca-mu1 exists but was not created by deploy/sbx/setup.sh: SBX0 needs a namespace of its own (or delete the Secret, which rotates the key)'
    if [[ -n "$COMBINED" ]]; then
      # SH_SESSION_TOKEN_PUBLIC_KEYS is what the supervisor verifies session tokens with: the same
      # <kid>:<SPKI> as sbx-token-keys (genkeys.ts's format).
      export S_0="$priv" S_1="$jtok" S_2="$kid:$spki" S_3="$kek" S_4="$xtok"
      apply_secret moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY SH_JANITOR_TOKEN SH_SESSION_TOKEN_PUBLIC_KEYS \
        SH_CREDENTIAL_KEK SH_EXCHANGE_TOKEN
    else
      export S_0="$priv" S_1="$jtok"
      apply_secret moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY SH_JANITOR_TOKEN
    fi
    export S_0="$kid:$spki"
    apply_secret sbx-token-keys PUBLIC_KEYS
  )
}

# The egress Secret, sbx-egress (SBX_EGRESS_CREDENTIALS=1 only): SH_CREDENTIAL_KEK (32 random bytes,
# base64: what keksFromBase64 reads) and one bearer per host (rand_hex, 64 hex). Each generated once
# and kept. Separate from moca-mu1, so an off run leaves moca-mu1's apply unchanged and the KEK
# survives turning the feature off. A host no longer listed has its token removed by an explicit null
# patch (not apply pruning): the control plane then refuses it within one credential TTL. Every key
# rides in each apply: with one field manager, an apply that omitted one would prune it.
ensure_egress_secrets() {
  [[ -n "$EGRESS_ON" ]] || return 0
  local json kek id key stale patch k want=' '
  json="$(secret_json sbx-egress)"
  kek="$(json_value "$json" SH_CREDENTIAL_KEK)"
  [[ -n "$kek" ]] || { log 'generating the credential KEK (SH_CREDENTIAL_KEK)'; kek="$(openssl rand -base64 32 | tr -d '\n')"; }
  # keksFromBase64 reads a comma-separated ring, newest first: every entry must be 32 bytes. An
  # existing ring is never rewritten, and a bad one is not met with advice to delete it.
  local entry n=0 bad=''
  local -a ring
  IFS=',' read -r -a ring <<<"$kek"
  for entry in "${ring[@]}"; do
    entry="${entry//[[:space:]]/}"
    [[ -n "$entry" ]] || continue
    n=$((n + 1))
    [[ "$(printf '%s' "$entry" | base64 --decode 2>/dev/null | wc -c | tr -d ' ')" == 32 ]] || bad=1
  done
  if [[ -n "$bad" || "$n" == 0 ]]; then
    if [[ "$kek" == *,* ]]; then
      die 'sbx-egress SH_CREDENTIAL_KEK is a ring with an entry that is not 32 bytes of base64: fix that entry in the Secret by hand (every entry, newest first, must decode to 32 bytes)'
    fi
    die 'sbx-egress SH_CREDENTIAL_KEK is not 32 bytes of base64: delete the key and re-run (this makes stored credentials unreadable)'
  fi
  (
    export S_0="$kek"
    local i=1 tok names=''
    for id in $EGRESS_IDS; do
      key="$(egress_key "$id")"
      tok="$(json_value "$json" "$key")"
      [[ -n "$tok" ]] || { log "generating the egress token of host $id"; tok="$(rand_hex)"; }
      export "S_$i=$tok"
      names+=" $key"
      i=$((i + 1))
    done
    # shellcheck disable=SC2086 # one argument per key; the names are validated identifiers
    apply_secret sbx-egress SH_CREDENTIAL_KEK $names
  )
  for id in $EGRESS_IDS; do want+="$(egress_key "$id") "; done
  stale="$(printf '%s' "$json" | jq -r '.data // {} | keys[]' | while read -r k; do
    [[ "$k" == SH_EGRESS_TOKEN_* && "$want" != *" $k "* ]] && printf '%s\n' "$k"
    true
  done)"
  if [[ -n "$stale" ]]; then
    log "revoking the egress token of host(s) no longer listed: $(printf '%s' "$stale" | tr '\n' ' ')"
    patch="$(printf '%s\n' "$stale" | jq -Rnc '{data: ([inputs | {key: ., value: null}] | from_entries)}')"
    kc patch secret sbx-egress -n "$NS" --type=merge -p "$patch" >/dev/null
  fi
}

# The template hosts' Secret, sbx-template-hosts (SBX_TEMPLATE_STORE=1 only): one bearer per host
# (rand_hex), each generated once and kept, distinct from every egress and janitor token by
# construction (random). A host no longer listed has its token removed by an explicit null patch.
# Applied (empty when no host is listed) whenever the store is on: the control plane's projected
# credentials volume names it, and a missing Secret would keep the pod from starting.
ensure_store_secrets() {
  [[ -n "$STORE_ON" ]] || return 0
  local json id key tok stale patch k want=' ' names='' i=0
  json="$(secret_json sbx-template-hosts)"
  (
    for id in $STORE_HOSTS; do
      key="$(host_key "$id")"
      tok="$(json_value "$json" "$key")"
      [[ -n "$tok" ]] || { log "generating the template host token of host $id"; tok="$(rand_hex)"; }
      export "S_$i=$tok"
      names+=" $key"
      i=$((i + 1))
    done
    # shellcheck disable=SC2086 # one argument per key; the names are validated identifiers
    apply_secret sbx-template-hosts $names
  )
  for id in $STORE_HOSTS; do want+="$(host_key "$id") "; done
  stale="$(printf '%s' "$json" | jq -r '.data // {} | keys[]' | while read -r k; do
    [[ "$k" == SH_HOST_TOKEN_* && "$want" != *" $k "* ]] && printf '%s\n' "$k"
    true
  done)"
  if [[ -n "$stale" ]]; then
    log "revoking the template host token of host(s) no longer listed: $(printf '%s' "$stale" | tr '\n' ' ')"
    patch="$(printf '%s\n' "$stale" | jq -Rnc '{data: ([inputs | {key: ., value: null}] | from_entries)}')"
    kc patch secret sbx-template-hosts -n "$NS" --type=merge -p "$patch" >/dev/null
  fi
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
# the relay's), then two hashes of what each pod reads at boot (write_overlay stamps them, so a change
# rolls the pod that reads it): SETTINGS_HASH, the control plane's, covers every setting, the public
# keyset and the certificates; RELAY_HASH covers only the relay's (ocp-sbx/patch-relay.yaml: the
# issuer and the in-flight cap) with the keyset and the certificates. So a template, subject or quota
# change rolls the control plane alone and leaves running Execs be (RUNBOOK §5). Runs after
# route_cert: it reads exec-ca.crt.
ensure_settings() {
  local ca='' moca sbx relay keys attach_crt exec_crt moca_crt egress hosts
  [[ ! -f "$GEN/exec-ca.crt" ]] || ca="$(cat "$GEN/exec-ca.crt")"
  # The TTLs are '' (the control plane's defaults); the base reads both keys, so both must exist.
  moca=("SH_GITHUB_CLIENT_ID=$SBX_GITHUB_CLIENT_ID" "SH_ADMIN_SUBJECTS=${SBX_ADMIN_SUBJECTS:-}"
    'SH_API_TOKEN_TTL_SECONDS=' 'SH_SESSION_TOKEN_TTL_SECONDS=')
  # Combined: the keys the base's control plane reads beside these (base/control-plane.yaml), with
  # the harness's public URL the supervisor Route serves; no operator key fallback, no tiers.
  [[ -z "$COMBINED" ]] || moca+=("SH_PUBLIC_HARNESS_URL=https://$SBX_MOCA_HOST" 'SH_ALLOW_OPERATOR_FALLBACK=false'
    'SH_SANDBOX_TIERS=' 'SH_SANDBOX_DEFAULT_TIER=' 'SH_MODEL_CATALOG_HOSTS=' 'SH_TEST_USERS=0')
  sbx=("SH_ALLOWED_SUBJECTS=$SBX_ALLOWED_SUBJECTS" "SH_SANDBOX_TEMPLATES=$TEMPLATES_JSON"
    "SH_SANDBOX_EXEC_ENDPOINT=$SBX_EXEC_HOST:443" 'SH_SANDBOX_TOKEN_ISSUER=sbx-control-plane'
    "SH_SANDBOX_LIFETIME_SECONDS=$LIFETIME_S" "SH_SANDBOX_TOKEN_TTL_SECONDS=$TOKEN_TTL_S"
    "SH_SANDBOX_RETENTION_SECONDS=$RETENTION_S" "SH_SANDBOX_MAX_PER_SUBJECT=$SBX_MAX_PER_SUBJECT"
    "SH_SANDBOX_MAX_TOTAL=$SBX_MAX_TOTAL" "SH_SANDBOX_MAX_INFLIGHT=$SBX_MAX_INFLIGHT"
    "SH_SANDBOX_MODES_ALLOWED=$SBX_MODES_ALLOWED" "SH_SANDBOX_IDLE_CEILING_S=$SBX_IDLE_CEILING_S")
  [[ -z "$ca" ]] || sbx+=("SH_SANDBOX_EXEC_CA=$ca")
  [[ -z "$STORE_ON" ]] || sbx+=("SH_TEMPLATE_HOSTS=$STORE_HOSTS_JSON")
  if [[ -n "$EGRESS_ON" ]]; then
    sbx+=("SH_EGRESS_HOSTS=$EGRESS_HOSTS_JSON")
    [[ -z "${SBX_EGRESS_CREDENTIAL_TTL_SECONDS:-}" ]] || sbx+=("SH_EGRESS_CREDENTIAL_TTL_SECONDS=$SBX_EGRESS_CREDENTIAL_TTL_SECONDS")
  fi
  apply_configmap moca-settings "${moca[@]}"
  apply_configmap sbx-settings "${sbx[@]}"
  # Captured first, so a failing `kubectl get` stops the run (errexit) rather than hashing without it.
  # The certificates are in the hash because ghostunnel reads its own only at start: a renewed one
  # must roll the relay, or it keeps serving the old one until that expires.
  keys="$(secret_json sbx-token-keys)"
  attach_crt="$(secret_json moca-relay-tls)"
  exec_crt="$(secret_json sbx-exec-tls)"
  moca_crt=''
  [[ -z "$COMBINED" ]] || moca_crt="$(secret_json moca-supervisor-tls)"
  # With egress on, the Secret's data is hashed too (names and base64 values, sorted): a new host
  # token or KEK changes the pod template, so the control plane rolls and rereads its files.
  # With the store on, the host tokens' Secret likewise: a new or revoked host token rolls it.
  egress='' hosts=''
  [[ -z "$EGRESS_ON" ]] || egress="$(secret_json sbx-egress | jq -cS '.data // {}')"
  [[ -z "$STORE_ON" ]] || hosts="$(secret_json sbx-template-hosts | jq -cS '.data // {}')"
  SETTINGS_HASH="$({
    printf '%s\n' "${moca[@]}" "${sbx[@]}"
    json_value "$keys" PUBLIC_KEYS
    json_value "$attach_crt" tls.crt
    json_value "$exec_crt" tls.crt
    [[ -z "$COMBINED" ]] || json_value "$moca_crt" tls.crt
    [[ -z "$EGRESS_ON" ]] || printf '%s\n' "$egress"
    [[ -z "$STORE_ON" ]] || printf '%s\n' "$hosts"
  } | openssl dgst -sha256 -hex | awk '{print substr($NF, 1, 16)}')"
  [[ "$SETTINGS_HASH" =~ ^[0-9a-f]{16}$ ]] || die 'could not hash the settings (openssl dgst)'
  # The relay's env from sbx-settings, by key, as patch-relay.yaml names them.
  relay=('SH_SANDBOX_TOKEN_ISSUER=sbx-control-plane' "SH_SANDBOX_MAX_INFLIGHT=$SBX_MAX_INFLIGHT")
  RELAY_HASH="$({
    printf '%s\n' "${relay[@]}"
    json_value "$keys" PUBLIC_KEYS
    json_value "$attach_crt" tls.crt
    json_value "$exec_crt" tls.crt
  } | openssl dgst -sha256 -hex | awk '{print substr($NF, 1, 16)}')"
  [[ "$RELAY_HASH" =~ ^[0-9a-f]{16}$ ]] || die 'could not hash the relay settings (openssl dgst)'
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
  # From before the API Route certificate was patched in by api_route_cert: it held the key.
  rm -f "$GEN/api-route-tls.json"
  {
    printf '# GENERATED by deploy/sbx/setup.sh on every run. Do not edit; gitignored.\n'
    printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n'
    printf 'namespace: %s\nresources:\n  - %s\n' "$NS" "$OVERLAY_REL"
    # The combined overlay already holds the template store (and refuses egress, validate_profile).
    if [[ -z "$COMBINED" ]] && [[ -n "$EGRESS_ON" || -n "$STORE_ON" ]]; then
      printf 'components:\n'
      [[ -z "$EGRESS_ON" ]] || printf '  - %s/egress-credentials\n' "$OVERLAY_REL"
      [[ -z "$STORE_ON" ]] || printf '  - %s/template-store\n' "$OVERLAY_REL"
    fi
    printf 'patches:\n'
    printf '  - target: { kind: Route, name: moca-relay }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$SBX_ATTACH_HOST"
    printf '  - target: { kind: Route, name: sbx-exec }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$SBX_EXEC_HOST"
    printf '  - target: { kind: Route, name: %s }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$API_ROUTE" "$SBX_API_HOST"
    if [[ -n "$COMBINED" ]]; then
      printf '  - target: { kind: Route, name: moca }\n    patch: |-\n      - { op: replace, path: /spec/host, value: %s }\n' "$SBX_MOCA_HOST"
      # The supervisor reads the settings too (the public keyset, the exchange token): roll it with them.
      printf '  - target: { kind: Deployment, name: moca-supervisor }\n    patch: |-\n'
      printf '      - { op: add, path: /spec/template/metadata/annotations, value: { sbx.moca.dev/settings-hash: "%s" } }\n' "$SETTINGS_HASH"
      printf '  - target: { kind: StatefulSet, name: moca-sandbox }\n    patch: |-\n      - { op: replace, path: /spec/replicas, value: %s }\n' "$SBX_SANDBOX_REPLICAS"
      # ocp-combined's in-cluster addresses name its placeholder namespace; this one's, from here.
      combined_addresses
    fi
    # Both pods read their settings and keys only at boot: a new hash changes their pod templates,
    # so the apply rolls them, each on its own hash (ensure_settings). The control plane's template
    # has no annotations map; p4-relay gives the relay's one, so there this adds a key.
    printf '  - target: { kind: Deployment, name: moca-control-plane }\n    patch: |-\n'
    printf '      - { op: add, path: /spec/template/metadata/annotations, value: { sbx.moca.dev/settings-hash: "%s" } }\n' "$SETTINGS_HASH"
    printf '  - target: { kind: Deployment, name: sandbox-relay }\n    patch: |-\n'
    printf '      - { op: add, path: /spec/template/metadata/annotations/sbx.moca.dev~1settings-hash, value: "%s" }\n' "$RELAY_HASH"
    printf 'images:\n'
    image_entry ghcr.io/rossoctl/moca "$SBX_IMAGE"
    [[ -z "$COMBINED" ]] || image_entry ghcr.io/rossoctl/moca-remote-worker "$SBX_SANDBOX_IMAGE"
    # The base names Valkey; an override renames that image, so the StatefulSet's pod spec is untouched.
    [[ -z "${SBX_REDIS_IMAGE:-}" ]] || image_entry docker.io/valkey/valkey "$SBX_REDIS_IMAGE"
  } >"$GEN/kustomization.yaml"
}

# The literal in-cluster addresses ocp-combined writes against its placeholder namespace
# (patch-addressing.yaml), as strategic-merge patches for this run's namespace. Printed inside
# write_overlay's `patches:` list. Each names the overlay's own namespace (COMBINED_PLACEHOLDER_NS):
# a strategic merge patch matches an object by the namespace it had before this overlay renamed it.
COMBINED_PLACEHOLDER_NS='moca-sbx-combined'
combined_addresses() {
  [[ "$NS" != "$COMBINED_PLACEHOLDER_NS" ]] || return 0
  printf '  - patch: |-\n'
  printf '      apiVersion: apps/v1\n      kind: Deployment\n      metadata: { name: moca-supervisor, namespace: %s }\n' "$COMBINED_PLACEHOLDER_NS"
  printf '      spec: { template: { spec: { containers: [ { name: supervisor, env: [\n'
  printf '        { name: SH_RELAY_ADDR, value: "sandbox-relay-exec.%s.svc:9444" },\n' "$NS"
  printf '        { name: SH_CONTROL_PLANE_URL, value: "http://moca-control-plane.%s.svc:8080" } ] } ] } } }\n' "$NS"
  printf '  - patch: |-\n'
  printf '      apiVersion: apps/v1\n      kind: Deployment\n      metadata: { name: moca-control-plane, namespace: %s }\n' "$COMBINED_PLACEHOLDER_NS"
  printf '      spec: { template: { spec: { containers: [ { name: control-plane, env: [\n'
  printf '        { name: SH_SANDBOX_NAMESPACE, value: "%s" } ] } ] } } }\n' "$NS"
  printf '  - patch: |-\n'
  printf '      apiVersion: apps/v1\n      kind: StatefulSet\n      metadata: { name: moca-sandbox, namespace: %s }\n' "$COMBINED_PLACEHOLDER_NS"
  printf '      spec: { template: { spec: { containers: [ { name: sandbox, env: [\n'
  printf '        { name: RELAY_ADDR, value: "sandbox-relay-attach.%s.svc:9443" } ] } ] } } }\n' "$NS"
}

# The API Route's operator certificate, patched onto the live Route rather than put in the overlay:
# client-side `apply -k` would copy the key into the last-applied-configuration annotation, and the
# overlay would keep it on disk. The patch is read from a 0700 temp dir, never argv. A later apply
# leaves the fields alone (they are not in its last-applied), and without a certificate they are
# removed, so the Route returns to the router's default. Namespace readers (`view`) can still read a
# Route's spec.tls.key: that is how OpenShift Routes carry an edge key.
api_route_cert() {
  local dir
  if [[ -z "${SBX_API_TLS_CERT:-}" ]]; then
    kc patch route "$API_ROUTE" -n "$NS" --type=merge -p '{"spec":{"tls":{"certificate":null,"key":null}}}' >/dev/null
    return 0
  fi
  dir="$(mktemp -d)"
  (
    trap 'rm -rf "$dir"' EXIT
    chmod 700 "$dir"
    jq -n --rawfile c "$SBX_API_TLS_CERT" --rawfile k "$SBX_API_TLS_KEY" \
      '{spec: {tls: {certificate: $c, key: $k}}}' >"$dir/patch.json"
    kc patch route "$API_ROUTE" -n "$NS" --type=merge --patch-file="$dir/patch.json" >/dev/null
  )
}

apply_stack() {
  kc apply -k "$GEN" >/dev/null
  api_route_cert
  kc rollout status statefulset/redis -n "$NS" --timeout=300s
  kc rollout status deployment/sandbox-relay -n "$NS" --timeout=300s
  remove_exec_token
  kc rollout status deployment/moca-control-plane -n "$NS" --timeout=300s
  [[ -z "$COMBINED" ]] || kc rollout status deployment/moca-supervisor -n "$NS" --timeout=300s
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
      # SH_LEASE_IDLE_CEILING_S: the control plane's SH_SANDBOX_IDLE_CEILING_S, so both clamp alike.
      printf 'RELAY_ADDR=%s:443\nRELAY_TLS=true\nSANDBOX_ID=%s\nSANDBOX_TOKEN=%s\nSH_WORKSPACE_IDLE=%sh\nSH_WORKSPACE_IMAGE_MB=%s\nSH_LEASE_IDLE_CEILING_S=%s\n' \
        "$SBX_ATTACH_HOST" "$id" "$tok" "$WORKSPACE_IDLE_H" "$SBX_WORKSPACE_IMAGE_MB" "$SBX_IDLE_CEILING_S" >"$d/worker.env"
      if [[ -f "$GEN/attach-ca.crt" ]]; then cp "$GEN/attach-ca.crt" "$d/relay-ca.crt"; else rm -f "$d/relay-ca.crt"; fi
    done
    chmod 700 "$GEN" "$GEN"/workers "$GEN"/workers/* 2>/dev/null || true
  )
  write_janitor_bundle
  write_egress_bundles
  write_store_bundles
  log "worker bundles: $GEN/workers/<id>  (copy to the KVM host, run deploy/sbx/install-host.sh, delete the copy)"
  log "janitor bundle: $GEN/janitor  (copy to every KVM host, run deploy/sbx/install-host.sh --janitor, delete the copy)"
  [[ -z "${HOSTS_TO_REINSTALL:-}" ]] ||
    log "WARNING: the SH_WORKSPACE_IDLE changed: re-run deploy/sbx/install-host.sh now on the host of each of: $HOSTS_TO_REINSTALL"
}

# The host janitor's bundle (spec §8.1, §8.3): janitor.env (the API URL and the wait, in seconds;
# no secret), janitor.token (the bearer alone, no newline) and, with SBX_API_CA_FILE, api-ca.crt.
# The token is re-read from the Secret: ensure_signing_key ran in a subshell. It reaches the file
# through the printf builtin, never argv.
write_janitor_bundle() {
  local d="$GEN/janitor" jtok
  jtok="$(json_value "$(secret_json moca-mu1)" SH_JANITOR_TOKEN)"
  [[ -n "$jtok" ]] || die 'moca-mu1 has no SH_JANITOR_TOKEN: re-run setup.sh'
  (
    umask 077
    mkdir -p "$d"
    chmod 700 "$d"
    printf 'SBX_API_URL=https://%s\nSBX_JANITOR_AGE=%s\n' "$SBX_API_HOST" "$JANITOR_AGE_S" >"$d/janitor.env"
    printf '%s' "$jtok" >"$d/janitor.token"
    chmod 600 "$d/janitor.env" "$d/janitor.token"
    if [[ -n "${SBX_API_CA_FILE:-}" ]]; then
      cp "$SBX_API_CA_FILE" "$d/api-ca.crt.new" && chmod 600 "$d/api-ca.crt.new" && mv "$d/api-ca.crt.new" "$d/api-ca.crt"
    else
      rm -f "$d/api-ca.crt"
    fi
  )
}

# The egress bundle of each host (spec §6.2; install-host.sh --egress): egress.env (the API URL; no
# secret), egress.token (the host's bearer alone, no newline) and, with SBX_API_CA_FILE, api-ca.crt.
# Tokens are re-read from the Secret (ensure_egress_secrets ran in a subshell) and reach the files
# through the printf builtin, never argv. A host no longer listed loses its directory.
write_egress_bundles() {
  [[ -n "$EGRESS_ON" ]] || return 0
  local json d id tok
  json="$(secret_json sbx-egress)"
  for d in "$GEN"/egress/*/; do
    [[ -d "$d" ]] || continue
    id="$(basename "$d")"
    [[ " $EGRESS_IDS " == *" $id "* ]] || { log "deleting the egress bundle of host $id"; rm -rf "$d"; }
  done
  (
    umask 077
    for id in $EGRESS_IDS; do
      d="$GEN/egress/$id"
      tok="$(json_value "$json" "$(egress_key "$id")")"
      [[ "$tok" =~ ^[0-9a-f]{64}$ ]] || die "sbx-egress has no valid token for host $id: re-run setup.sh"
      mkdir -p "$d"
      chmod 700 "$GEN/egress" "$d"
      printf 'MOCA_EGRESS_CREDENTIALS_URL=https://%s\n' "$SBX_API_HOST" >"$d/egress.env"
      printf '%s' "$tok" >"$d/egress.token"
      chmod 600 "$d/egress.env" "$d/egress.token"
      if [[ -n "${SBX_API_CA_FILE:-}" ]]; then
        cp "$SBX_API_CA_FILE" "$d/api-ca.crt.new" && chmod 600 "$d/api-ca.crt.new" && mv "$d/api-ca.crt.new" "$d/api-ca.crt"
      else
        rm -f "$d/api-ca.crt"
      fi
    done
  )
  for id in $EGRESS_IDS; do
    log "egress bundle: $GEN/egress/$id  (copy to host $id, run deploy/sbx/install-host.sh --egress on it, delete the copy)"
  done
}

# The host-agent bundle of each template host (the RUNBOOK's host agent section): host-agent.env (the API URL and the
# host id; no secret), host-agent.token (the host's bearer alone, no newline) and, with
# SBX_API_CA_FILE, api-ca.crt. A host no longer listed loses its directory.
write_store_bundles() {
  [[ -n "$STORE_ON" ]] || return 0
  local json d id tok
  json="$(secret_json sbx-template-hosts)"
  for d in "$GEN"/host-agent/*/; do
    [[ -d "$d" ]] || continue
    id="$(basename "$d")"
    [[ " $STORE_HOSTS " == *" $id "* ]] || { log "deleting the host-agent bundle of host $id"; rm -rf "$d"; }
  done
  (
    umask 077
    for id in $STORE_HOSTS; do
      d="$GEN/host-agent/$id"
      tok="$(json_value "$json" "$(host_key "$id")")"
      [[ "$tok" =~ ^[0-9a-f]{64}$ ]] || die "sbx-template-hosts has no valid token for host $id: re-run setup.sh"
      mkdir -p "$d"
      chmod 700 "$GEN/host-agent" "$d"
      printf 'SBX_API_URL=https://%s\nSBX_HOST_ID=%s\n' "$SBX_API_HOST" "$id" >"$d/host-agent.env"
      printf '%s' "$tok" >"$d/host-agent.token"
      chmod 600 "$d/host-agent.env" "$d/host-agent.token"
      if [[ -n "${SBX_API_CA_FILE:-}" ]]; then
        cp "$SBX_API_CA_FILE" "$d/api-ca.crt.new" && chmod 600 "$d/api-ca.crt.new" && mv "$d/api-ca.crt.new" "$d/api-ca.crt"
      else
        rm -f "$d/api-ca.crt"
      fi
    done
  )
  for id in $STORE_HOSTS; do
    log "host-agent bundle: $GEN/host-agent/$id  (copy to host $id, install host-agent.sh as the RUNBOOK's host agent section says, delete the copy)"
  done
}

main() {
  parse_args "$@"
  validate
  preflight
  check_combined_namespace
  ensure_redis_secret
  ensure_relay_secret
  ensure_worker_tokens
  remove_client_tokens
  ensure_signing_key
  ensure_egress_secrets
  ensure_store_secrets
  route_cert moca-relay-tls "$SBX_ATTACH_HOST" "${SBX_ATTACH_TLS_CERT:-}" "${SBX_ATTACH_TLS_KEY:-}" "$GEN/attach-ca.crt"
  route_cert sbx-exec-tls "$SBX_EXEC_HOST" "${SBX_EXEC_TLS_CERT:-}" "${SBX_EXEC_TLS_KEY:-}" "$GEN/exec-ca.crt"
  # Combined: the supervisor's passthrough Route (Moca Pi turns) terminates TLS in its sidecar.
  [[ -z "$COMBINED" ]] || route_cert moca-supervisor-tls "$SBX_MOCA_HOST" "${SBX_MOCA_TLS_CERT:-}" "${SBX_MOCA_TLS_KEY:-}" "$GEN/moca-ca.crt"
  ensure_settings
  write_overlay
  apply_stack
  write_bundles
  if [[ -n "$COMBINED" ]]; then
    log "combined control plane ready: api https://$SBX_API_HOST  moca https://$SBX_MOCA_HOST  attach https://$SBX_ATTACH_HOST:443  exec https://$SBX_EXEC_HOST:443"
  else
    log "SBX0 ready: api https://$SBX_API_HOST  attach https://$SBX_ATTACH_HOST:443  exec https://$SBX_EXEC_HOST:443"
  fi
}

main "$@"
