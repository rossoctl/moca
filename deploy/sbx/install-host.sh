#!/usr/bin/env bash
# deploy/sbx/install-host.sh -- install, update or remove one SBX0 template worker on a KVM host
# (docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md §8.2).
#
#   sudo deploy/sbx/install-host.sh BUNDLE_DIR --snapshot IMAGE [--budget-mb N] [--no-egress]
#   sudo deploy/sbx/install-host.sh --uninstall WORKER_ID
#   sudo deploy/sbx/install-host.sh --janitor JANITOR_BUNDLE_DIR
#   sudo deploy/sbx/install-host.sh --uninstall-janitor
#   sudo deploy/sbx/install-host.sh --egress EGRESS_BUNDLE_DIR | --uninstall-egress | --egress-ca-out
#
# BUNDLE_DIR is deploy/sbx/.generated/workers/<id> from deploy/sbx/setup.sh. IMAGE names a golden
# snapshot under $SBX_SRV/snapshots (deploy/microvm/build-snapshot.sh --out $SBX_SRV/snapshots/IMAGE).
# Needs microvm-worker, firecracker, jailer and moca-egress in /usr/local/bin (deploy/microvm/P4-ON-P6.md;
# moca-egress: CGO_ENABLED=0 go build -o /usr/local/bin/moca-egress ./remote-worker/cmd/moca-egress).
#
# Guest egress (#623, P4.1): a worker install also installs and starts moca-egress, the host's
# allowlisted egress proxy, before the worker, and wires the worker to its control socket
# (MOCA_EGRESS_CONTROL_SOCK in the worker env). The rules:
#   - One moca-egress per host serves every template worker.
#   - It never clobbers a moca-egress.service this script did not install. A host that also runs
#     deploy/microvm's P6 worker already has one; if $SBX_UNIT_DIR/moca-egress.service exists and the
#     manifest has no `egress unit` line for it, it is reused: the workers are wired to its socket and
#     nothing else is touched.
#   - The binary is the operator's, like microvm-worker: a missing /usr/local/bin/moca-egress is
#     refused before anything is written or systemd is touched.
#   - $SBX_ENV_DIR/moca-egress.env (the allowlist; no secret, 0644) is written ONLY when absent,
#     seeded from MOCA_EGRESS_ALLOW in the environment or else deploy/sbx/egress-allow.env beside
#     this script, so an operator's edit survives a re-run. Restart moca-egress by hand after
#     editing it or rebuilding the binary.
#   - --no-egress installs the worker without MOCA_EGRESS_CONTROL_SOCK and installs no egress unit.
#
# Touches ONLY its own files: the template unit, sbx.slice, sbx-<id>.slice, $SBX_ENV_DIR, and the
# worker's directories under $SBX_SRV. Never another install on the same host. Every file it writes
# is listed in $SBX_ENV_DIR/manifest, and --uninstall is the undo (spec §8.2): it removes the
# worker's files and, once no worker is left in the manifest, the shared template unit and
# sbx.slice and the moca-egress unit it installed (and its env file, unless the operator edited it). It leaves workspace data in place (the janitor, or the operator, removes that).
#
# --egress takes deploy/sbx/.generated/egress (egress.env, egress.token [+ api-ca.crt]) and turns on
# credential injection in the moca-egress this script installed (spec §6.2; refused beside a
# moca-egress.service it did not install). It generates the host's interception CA ONCE
# ($SBX_ENV_DIR/egress/ca.crt 0644 and ca.key 0600; a re-run keeps it, to rotate delete both and
# re-run, then rebuild the snapshot), writes the token (0600) and the drop-in
# moca-egress.service.d/sbx-credentials.conf (every file via LoadCredential=: $SBX_ENV_DIR is 0700),
# restarts moca-egress and waits for its socket. Its files are the manifest kind `egress credential
# <path>`. --egress-ca-out prints the CA path (generating it if absent). --uninstall-egress removes
# the drop-in, token and api CA and KEEPS the CA (snapshots are built with it). Once the drop-in
# exists, a worker install refuses a snapshot whose manifest.json egress_ca_sha256 is not the CA's.
#
# --janitor takes deploy/sbx/.generated/janitor (janitor.env, janitor.token [+ api-ca.crt]) and
# installs the host janitor (spec §8.3): $SBX_LIBEXEC_DIR/sbx-janitor.sh, $SBX_ENV_DIR/janitor.env
# and janitor.token (0600), sbx-janitor.service and .timer (enabled). Its files are their own
# manifest kind, `janitor <path>`, so uninstalling the last worker leaves the janitor running (it
# still has workspaces to free); --uninstall-janitor removes exactly them.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${SBX_UNIT_DIR:=/etc/systemd/system}"
: "${SBX_ENV_DIR:=/etc/sbx}"
: "${SBX_SRV:=/srv/sbx}"
: "${SBX_LIBEXEC_DIR:=/usr/local/libexec}"
: "${SBX_ATTACH_TIMEOUT:=120}"
: "${SBX_ATTACH_SETTLE:=5}"
: "${SBX_BIN_DIR:=/usr/local/bin}"
# moca-egress's control socket: the path inside the unit is fixed (RuntimeDirectory=moca-egress); the
# override exists for tests only. The wait is as setup-microvm.sh's.
: "${MOCA_EGRESS_SOCKET:=/run/moca-egress/control.sock}"
: "${MOCA_EGRESS_READY_TIMEOUT:=30}"
# LEGACY_EGRESS_ALLOW is the GitHub-only default from before egress-allow.env existed: the
# fallback for a copy of this script without the file (default_egress_allow warns when it is
# used), and, in remove_egress, a seed an older script wrote still counts as unedited.
LEGACY_EGRESS_ALLOW='api.github.com,github.com,codeload.github.com,objects.githubusercontent.com'
# The default guest-egress allowlist: the MOCA_EGRESS_ALLOW= line of egress-allow.env beside this
# script (a systemd EnvironmentFile, so comments are allowed), resolved lazily from egress_seed.
default_egress_allow() {
  local v
  v="$(sed -n 's/^MOCA_EGRESS_ALLOW=//p' "$SCRIPT_DIR/egress-allow.env" 2>/dev/null | tail -1)" || v=''
  if [[ -n "$v" ]]; then
    printf '%s\n' "$v"
  else
    printf 'deploy/sbx/install-host.sh: no MOCA_EGRESS_ALLOW line in %s; falling back to the GitHub hosts\n' \
      "$SCRIPT_DIR/egress-allow.env" >&2
    printf '%s\n' "$LEGACY_EGRESS_ALLOW"
  fi
}
# A bundle from deploy/sbx/setup.sh carries SH_WORKSPACE_IDLE (the sandbox lifetime plus two days,
# spec §5.4) and SH_WORKSPACE_IMAGE_MB. A bundle without the idle predates that rule and is refused;
# the image size defaults to microvm-worker's own.
DEFAULT_IMAGE_MB=2048
DEFAULT_BUDGET_MB=8192

log() { printf '==> %s\n' "$*"; }
die() { echo "deploy/sbx/install-host.sh: $*" >&2; exit 1; }

env_value() { (grep -E "^$1=" "$2" 2>/dev/null || true) | tail -1 | cut -d= -f2-; }

BUNDLE='' SNAPSHOT='' BUDGET_MB="$DEFAULT_BUDGET_MB" UNINSTALL='' JANITOR='' UNINSTALL_JANITOR='' NO_EGRESS='' EGRESS_BUNDLE='' UNINSTALL_EGRESS='' EGRESS_CA_OUT=''
parse_args() {
  while (($#)); do
    case "$1" in
    --snapshot) [[ $# -ge 2 ]] || die '--snapshot needs a value'; SNAPSHOT="$2"; shift 2 ;;
    --budget-mb) [[ $# -ge 2 ]] || die '--budget-mb needs a value'; BUDGET_MB="$2"; shift 2 ;;
    --uninstall) [[ $# -ge 2 ]] || die '--uninstall needs a worker id'; UNINSTALL="$2"; shift 2 ;;
    --janitor) [[ $# -ge 2 ]] || die '--janitor needs the janitor bundle directory'; JANITOR="$2"; shift 2 ;;
    --uninstall-janitor) UNINSTALL_JANITOR=1; shift ;;
    --no-egress) NO_EGRESS=1; shift ;;
    --egress) [[ $# -ge 2 ]] || die '--egress needs the egress bundle directory'; EGRESS_BUNDLE="$2"; shift 2 ;;
    --uninstall-egress) UNINSTALL_EGRESS=1; shift ;;
    --egress-ca-out) EGRESS_CA_OUT=1; shift ;;
    -*) die "unknown flag: $1" ;;
    *) [[ -z "$BUNDLE" ]] || die 'one bundle directory at a time'; BUNDLE="$1"; shift ;;
    esac
  done
}

valid_id() { [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "$1" != DIR ]]; }

record() { mkdir -p "$SBX_ENV_DIR"; touch "$SBX_ENV_DIR/manifest"; grep -qxF "$1" "$SBX_ENV_DIR/manifest" || echo "$1" >>"$SBX_ENV_DIR/manifest"; }

sha256_of() { # sha256_of FILE -> its hex digest
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# The moca-egress.service this script installs: the P4 unit with this host's env file and without its
# comments (they name the P6 paths).
egress_unit_text() {
  sed -e '/^#/d' -e "s#^EnvironmentFile=.*#EnvironmentFile=$SBX_ENV_DIR/moca-egress.env#" "$SCRIPT_DIR/../microvm/moca-egress.service"
}

# egress_unit_is_ours UNIT [RECORDED_SHA256]: a unit counts as this script's only while its content is
# what the script wrote. deploy/microvm/setup-microvm.sh (the P6 installer) overwrites the same path
# with its own copy, which must then be left alone. With a recorded digest the unit is ours iff it still
# hashes to it; a manifest from before digests were recorded falls back to the text we generate now.
egress_unit_is_ours() {
  [[ -f "$1" ]] || return 1
  if [[ -n "${2:-}" ]]; then [[ "$(sha256_of "$1")" == "$2" ]]; else egress_unit_text | cmp -s - "$1"; fi
}

# egress_claimed KIND PATH: the manifest has an `egress KIND PATH [SHA256]` line for it.
egress_claimed() {
  [[ -f "$SBX_ENV_DIR/manifest" ]] &&
    awk -v k="$1" -v p="$2" '$1 == "egress" && $2 == k && $3 == p { f = 1 } END { exit !f }' "$SBX_ENV_DIR/manifest"
}
# egress_recorded_hash KIND PATH -> the SHA256 on that line, or nothing (a manifest from before digests).
egress_recorded_hash() {
  [[ -f "$SBX_ENV_DIR/manifest" ]] || return 0
  awk -v k="$1" -v p="$2" '$1 == "egress" && $2 == k && $3 == p { print $4; exit }' "$SBX_ENV_DIR/manifest"
}
# egress_forget KIND PATH: drop that line, whatever digest it carries.
egress_forget() {
  [[ -f "$SBX_ENV_DIR/manifest" ]] || return 0
  awk -v k="$1" -v p="$2" '!($1 == "egress" && $2 == k && $3 == p)' "$SBX_ENV_DIR/manifest" >"$SBX_ENV_DIR/manifest.new"
  mv "$SBX_ENV_DIR/manifest.new" "$SBX_ENV_DIR/manifest"
}

# egress_seed: what a fresh moca-egress.env is seeded with. MOCA_EGRESS_ALLOW from the
# environment wins, then DEFAULT_EGRESS_ALLOW, then default_egress_allow (the file, or the
# legacy GitHub hosts with a warning). Resolved here, lazily, so that warning prints only
# when the default is actually consumed: a --no-egress run, or one with MOCA_EGRESS_ALLOW
# exported, never seeds and so never warns.
egress_seed() { printf 'MOCA_EGRESS_ALLOW=%s\n' "${MOCA_EGRESS_ALLOW:-${DEFAULT_EGRESS_ALLOW:-$(default_egress_allow)}}"; }

# wait_egress_ready: the worker's startup probe Registers over moca-egress's control socket, so a
# moca-egress that exits at boot (a bad moca-egress.env) would otherwise surface much later, as the
# worker failing to attach. The unit is Type=notify, so a successful start already means the socket is
# bound; this wait is the belt to that, and it is what names moca-egress when it did not come up.
wait_egress_ready() { # wait_egress_ready ENV_FILE: the env file the ACTIVE unit reads, for the hint
  local envfile="$1" deadline=$((SECONDS + MOCA_EGRESS_READY_TIMEOUT))
  until [[ -S "$MOCA_EGRESS_SOCKET" ]]; do
    if ((SECONDS >= deadline)); then
      die "moca-egress did not bind $MOCA_EGRESS_SOCKET within ${MOCA_EGRESS_READY_TIMEOUT}s; the reason is in: journalctl -u moca-egress (often a bad $envfile). Fix it and re-run"
    fi
    sleep 1
  done
}

# install_egress: see the header for the rules. Runs before install_units and before any systemctl.
install_egress() {
  local unit="$SBX_UNIT_DIR/moca-egress.service" env="$SBX_ENV_DIR/moca-egress.env" tmp changed=0 hint reuse=1
  [[ -x "$SBX_BIN_DIR/moca-egress" ]] ||
    die "no $SBX_BIN_DIR/moca-egress: build it with CGO_ENABLED=0 go build -o /usr/local/bin/moca-egress ./remote-worker/cmd/moca-egress (or pass --no-egress to install the worker without guest egress)"
  if [[ -e "$unit" ]]; then
    if egress_claimed unit "$unit"; then
      if egress_unit_is_ours "$unit" "$(egress_recorded_hash unit "$unit")"; then
        reuse=0
      else
        log "moca-egress.service was changed by another install; reusing it"
        egress_forget unit "$unit"
      fi
    fi
  else
    reuse=0
  fi
  if ((reuse)); then
    local foreign_env
    log "reusing the existing moca-egress.service (not installed by this script)"
    systemctl is-active --quiet moca-egress.service ||
      die "the existing moca-egress.service (not installed by this script) is not running: start it or fix the install that owns it (journalctl -u moca-egress)"
    foreign_env="$(sed -n 's/^EnvironmentFile=-\{0,1\}//p' "$unit" | head -1)"
    wait_egress_ready "${foreign_env:-its EnvironmentFile}"
    return 0
  fi
  install -d -m 0755 "$SBX_UNIT_DIR"
  install -d -m 0700 "$SBX_ENV_DIR"
  tmp="$(mktemp)"
  egress_unit_text >"$tmp"
  if ! cmp -s "$tmp" "$unit" 2>/dev/null; then
    install -m 0644 "$tmp" "$unit"
    changed=1
  fi
  rm -f "$tmp"
  egress_forget unit "$unit"
  record "egress unit $unit $(sha256_of "$unit")"
  if [[ ! -e "$env" ]]; then
    (umask 022 && egress_seed >"$env")
    chmod 0644 "$env"
    changed=1
    egress_forget file "$env"
    record "egress file $env $(sha256_of "$env")"
  else
    # An env file already there is recorded only if nothing is: with no digest, uninstall falls back to
    # comparing it with the seed.
    egress_claimed file "$env" || record "egress file $env"
  fi
  systemctl daemon-reload
  systemctl enable moca-egress.service
  # A Type=notify start that exits or times out before READY=1 -- a bad moca-egress.env -- makes
  # systemctl itself fail, so it gets the same hint as a socket that never appears.
  hint="the reason is in: journalctl -u moca-egress (often a bad $env). Fix it and re-run"
  if ((changed)); then
    systemctl reset-failed moca-egress.service || true
    systemctl restart moca-egress.service || die "moca-egress failed to start; $hint"
  elif ! systemctl is-active --quiet moca-egress.service; then
    systemctl reset-failed moca-egress.service || true
    systemctl start moca-egress.service || die "moca-egress failed to start; $hint"
  fi
  wait_egress_ready "$env"
}

# ---- credential injection (spec §6.2) ----
EGRESS_CRED_DIR() { printf '%s/egress' "$SBX_ENV_DIR"; }
egress_dropin() { printf '%s/moca-egress.service.d/sbx-credentials.conf' "$SBX_UNIT_DIR"; }

# ca_fingerprint CRT -> the hex sha256 of the certificate's DER form, as build-snapshot.sh records it.
ca_fingerprint() {
  local der
  der="$(mktemp)"
  openssl x509 -in "$1" -outform DER >"$der" || { rm -f "$der"; die "cannot read the certificate $1"; }
  sha256_of "$der"
  rm -f "$der"
}

# ensure_host_ca: generate the interception CA once; a re-run (or --egress-ca-out) keeps it.
ensure_host_ca() {
  local d crt key
  d="$(EGRESS_CRED_DIR)" crt="$d/ca.crt" key="$d/ca.key"
  command -v openssl >/dev/null || die 'needs openssl on PATH to generate the host CA'
  install -d -m 0700 "$SBX_ENV_DIR" "$d"
  if [[ -s "$crt" && -s "$key" ]]; then
    chmod 0644 "$crt"; chmod 0600 "$key"
  else
    (
      umask 077
      openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
        -subj "/CN=moca-egress $(hostname)" -addext basicConstraints=critical,CA:TRUE,pathlen:0 \
        -addext keyUsage=critical,keyCertSign -keyout "$key" -out "$crt" >/dev/null 2>&1
    ) || die "could not generate the host CA in $d"
    chmod 0644 "$crt"; chmod 0600 "$key"
    log "generated the host interception CA $crt (kept across re-runs; rebuild the snapshot with it)" >&2
  fi
  record "egress credential $crt"
  record "egress credential $key"
}

# snapshot_ca_fingerprint IMAGE -> the egress_ca_sha256 recorded in the snapshot's manifest.json, or nothing.
snapshot_ca_fingerprint() {
  local m="$SBX_SRV/snapshots/$1/manifest.json"
  [[ -f "$m" ]] || return 0
  sed -n 's/.*"egress_ca_sha256"[[:space:]]*:[[:space:]]*"sha256:\([0-9a-f]\{64\}\)".*/\1/p' "$m" | head -1
}

# check_snapshot_ca: with credentials on (the drop-in exists) the snapshot must trust this host's CA.
check_snapshot_ca() {
  [[ -f "$(egress_dropin)" ]] || return 0
  local crt m want got
  crt="$(EGRESS_CRED_DIR)/ca.crt" m="$SBX_SRV/snapshots/$SNAPSHOT/manifest.json"
  want="$([[ -f "$crt" ]] && ca_fingerprint "$crt" || true)"
  got="$(snapshot_ca_fingerprint "$SNAPSHOT")"
  [[ -n "$want" && "$got" == "$want" ]] ||
    die "snapshot $SNAPSHOT does not trust this host's egress CA (egress_ca_sha256 in $m is missing or differs): rebuild it with deploy/microvm/build-snapshot.sh --egress-ca $crt --out $SBX_SRV/snapshots/<new image>"
}

install_egress_credentials() {
  local b="$EGRESS_BUNDLE" url tok line v d unit dropin
  d="$(EGRESS_CRED_DIR)" unit="$SBX_UNIT_DIR/moca-egress.service" dropin="$(egress_dropin)"
  for v in SBX_ENV_DIR SBX_UNIT_DIR; do
    [[ "${!v}" =~ $PLAIN_PATH_RE ]] || die "$v='${!v}' must be a plain absolute path"
  done
  [[ -f "$b/egress.env" && -f "$b/egress.token" ]] ||
    die "no $b/egress.env and egress.token: pass the bundle directory deploy/sbx/setup.sh wrote (egress/)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == MOCA_EGRESS_CREDENTIALS_URL=* ]] ||
      die "$b/egress.env has a line other than MOCA_EGRESS_CREDENTIALS_URL= (${line%%=*}): re-run deploy/sbx/setup.sh and copy the new bundle"
  done <"$b/egress.env"
  url="$(env_value MOCA_EGRESS_CREDENTIALS_URL "$b/egress.env")"
  [[ "$url" =~ $JANITOR_URL_RE ]] || die "MOCA_EGRESS_CREDENTIALS_URL in $b/egress.env must be https://<api host>"
  tok="$(<"$b/egress.token")"
  [[ "$tok" =~ ^[0-9a-f]{64}$ ]] || die "$b/egress.token is not 64 hex characters: copy the bundle again"
  if [[ -f "$b/api-ca.crt" ]]; then
    grep -q -- '-----BEGIN CERTIFICATE-----' "$b/api-ca.crt" || die "$b/api-ca.crt holds no PEM certificate"
  fi
  if [[ ! -e "$unit" ]]; then
    die "no $unit: install a worker first (this script installs moca-egress with it), then re-run --egress"
  fi
  egress_claimed unit "$unit" && egress_unit_is_ours "$unit" "$(egress_recorded_hash unit "$unit")" ||
    die "$unit is the P6-owned moca-egress (this script did not install it): configure its credentials with its own installer; the P6's proxy is not reconfigured from here"

  ensure_host_ca
  (umask 077 && printf '%s' "$tok" >"$d/token")
  chmod 0600 "$d/token"
  record "egress credential $d/token"
  if [[ -f "$b/api-ca.crt" ]]; then
    install -m 0644 "$b/api-ca.crt" "$d/api-ca.crt"
    record "egress credential $d/api-ca.crt"
  else
    rm -f "$d/api-ca.crt"
    egress_forget credential "$d/api-ca.crt"
  fi
  install -d -m 0755 "$SBX_UNIT_DIR/moca-egress.service.d"
  {
    printf '# Installed by deploy/sbx/install-host.sh --egress. LoadCredential= because %s is 0700.\n[Service]\n' "$SBX_ENV_DIR"
    printf 'LoadCredential=egress-token:%s/token\n' "$d"
    printf 'LoadCredential=egress-ca.crt:%s/ca.crt\n' "$d"
    printf 'LoadCredential=egress-ca.key:%s/ca.key\n' "$d"
    [[ ! -f "$d/api-ca.crt" ]] || printf 'LoadCredential=egress-api-ca.crt:%s/api-ca.crt\n' "$d"
    printf 'Environment=MOCA_EGRESS_CREDENTIALS_URL=%s\n' "$url"
  } >"$dropin"
  chmod 0644 "$dropin"
  record "egress credential $dropin"
  systemctl daemon-reload
  systemctl reset-failed moca-egress.service || true
  systemctl restart moca-egress.service || die 'moca-egress failed to start with credentials; the reason is in: journalctl -u moca-egress. Fix it and re-run'
  wait_egress_ready "$SBX_ENV_DIR/moca-egress.env"
  warn_untrusting_workers
  log "moca-egress now injects credentials; build snapshots with: deploy/microvm/build-snapshot.sh --egress-ca $d/ca.crt --out $SBX_SRV/snapshots/<image>"
}

# warn_untrusting_workers: a warning, not a refusal, because the fresh-host order installs the worker first.
warn_untrusting_workers() {
  local want f id img got
  want="$(ca_fingerprint "$(EGRESS_CRED_DIR)/ca.crt")"
  for f in "$SBX_ENV_DIR"/workers/*.env; do
    [[ -f "$f" ]] || continue
    id="$(basename "$f" .env)"
    img="$(env_value SH_SNAPSHOT_IMAGE "$f")"
    [[ -n "$img" ]] || continue
    got="$(snapshot_ca_fingerprint "$img")"
    [[ -n "$got" && "$got" == "$want" ]] ||
      printf "WARNING: worker %s runs snapshot %s, which does not trust this host's CA; guests will see TLS failures on intercepted hosts until it is reinstalled on a snapshot built with --egress-ca\n" "$id" "$img" >&2
  done
}

# remove_credential_file PATH: the drop-in, token and api CA go; the host CA stays (snapshots carry it).
remove_credential_file() {
  case "$1" in
  "$(EGRESS_CRED_DIR)/ca.crt" | "$(EGRESS_CRED_DIR)/ca.key") log "kept for the snapshot: $1 (it was built with this CA)"; return 1 ;;
  esac
  rm -f "$1"
  rmdir "$(dirname "$1")" 2>/dev/null || true
  log "removed $1"
}

uninstall_egress_credentials() {
  local unit="$SBX_UNIT_DIR/moca-egress.service" kind path sha
  if [[ -f "$SBX_ENV_DIR/manifest" ]]; then
    while read -r kind path sha; do
      [[ "$kind" == credential && -n "$path" ]] || continue
      if remove_credential_file "$path"; then egress_forget credential "$path"; fi
    done < <(sed -n 's/^egress //p' "$SBX_ENV_DIR/manifest")
  fi
  systemctl daemon-reload
  if egress_claimed unit "$unit" && egress_unit_is_ours "$unit" "$(egress_recorded_hash unit "$unit")" &&
    systemctl is-active --quiet moca-egress.service; then
    systemctl restart moca-egress.service || die 'moca-egress failed to restart; the reason is in: journalctl -u moca-egress'
    wait_egress_ready "$SBX_ENV_DIR/moca-egress.env"
  fi
}

install_units() {
  install -d -m 0755 "$SBX_UNIT_DIR"
  install -m 0644 "$SCRIPT_DIR/sbx.slice" "$SBX_UNIT_DIR/sbx.slice"
  sed "s#^EnvironmentFile=/etc/sbx/#EnvironmentFile=$SBX_ENV_DIR/#" "$SCRIPT_DIR/sbx-worker@.service" \
    >"$SBX_UNIT_DIR/sbx-worker@.service"
  chmod 0644 "$SBX_UNIT_DIR/sbx-worker@.service"
  record "unit $SBX_UNIT_DIR/sbx.slice"
  record "unit $SBX_UNIT_DIR/sbx-worker@.service"
}

# validate_worker reads and checks the bundle and the flags, setting W_ID, W_ADDR, W_TOK, W_IDLE and
# W_IMAGE_MB. It writes nothing and touches no unit, so a refusal comes before install_egress starts one.
validate_worker() {
  local env="$BUNDLE/worker.env" id addr tok idle image_mb
  [[ -f "$env" ]] || die "no $env: pass the bundle directory deploy/sbx/setup.sh wrote (workers/<id>)"
  id="$(env_value SANDBOX_ID "$env")"
  valid_id "$id" || die "SANDBOX_ID in $env is not a valid worker id"
  addr="$(env_value RELAY_ADDR "$env")"
  [[ "$addr" =~ ^[A-Za-z0-9.-]+:[0-9]+$ ]] || die "RELAY_ADDR in $env must be host:port"
  [[ "$(env_value RELAY_TLS "$env")" == true ]] || die "RELAY_TLS in $env must be true"
  tok="$(env_value SANDBOX_TOKEN "$env")"
  [[ "$tok" =~ ^[0-9a-f]{64}$ ]] || die "SANDBOX_TOKEN in $env is not 64 hex characters: copy the bundle again"
  idle="$(env_value SH_WORKSPACE_IDLE "$env")"
  [[ -n "$idle" ]] ||
    die "$env has no SH_WORKSPACE_IDLE (a bundle from before increment 1b): re-run deploy/sbx/setup.sh and copy the new bundle"
  [[ "$idle" =~ ^[1-9][0-9]*h$ ]] || die "SH_WORKSPACE_IDLE in $env must be whole hours, e.g. 216h"
  image_mb="$(env_value SH_WORKSPACE_IMAGE_MB "$env")"
  image_mb="${image_mb:-$DEFAULT_IMAGE_MB}"
  [[ "$image_mb" =~ ^[1-9][0-9]*$ ]] || die "SH_WORKSPACE_IMAGE_MB in $env must be a whole number of MiB"
  [[ -n "$SNAPSHOT" ]] || die '--snapshot IMAGE is required'
  [[ "$SNAPSHOT" =~ ^[A-Za-z0-9._-]+$ ]] || die '--snapshot must be a directory name'
  [[ -d "$SBX_SRV/snapshots/$SNAPSHOT" ]] || die "no snapshot $SBX_SRV/snapshots/$SNAPSHOT (build it with deploy/microvm/build-snapshot.sh)"
  [[ "$BUDGET_MB" =~ ^[1-9][0-9]*$ ]] && ((BUDGET_MB > 1024)) || die '--budget-mb must be a whole number of MiB above 1024 (the unit reserve)'
  check_snapshot_ca
  W_ID="$id" W_ADDR="$addr" W_TOK="$tok" W_IDLE="$idle" W_IMAGE_MB="$image_mb"
}

install_worker() {
  local id="$W_ID" addr="$W_ADDR" tok="$W_TOK" idle="$W_IDLE" image_mb="$W_IMAGE_MB" ca=''
  install -d -m 0700 "$SBX_ENV_DIR" "$SBX_ENV_DIR/workers"
  if [[ -f "$BUNDLE/relay-ca.crt" ]]; then
    grep -q -- '-----BEGIN CERTIFICATE-----' "$BUNDLE/relay-ca.crt" || die "$BUNDLE/relay-ca.crt holds no PEM certificate"
    install -m 0644 "$BUNDLE/relay-ca.crt" "$SBX_ENV_DIR/workers/$id-relay-ca.crt"
    ca="$SBX_ENV_DIR/workers/$id-relay-ca.crt"
    record "file $ca"
  fi
  install -d -m 0700 "$SBX_SRV/workspaces/$id" "$SBX_SRV/jail/$id"
  (
    umask 077
    {
      printf 'RELAY_ADDR=%s\nRELAY_TLS=true\nSANDBOX_ID=%s\nSANDBOX_TOKEN=%s\n' "$addr" "$id" "$tok"
      [[ -z "$ca" ]] || printf 'RELAY_CA_FILE=%s\n' "$ca"
      printf 'SH_SNAPSHOT_DIR=%s\nSH_SNAPSHOT_IMAGE=%s\n' "$SBX_SRV/snapshots" "$SNAPSHOT"
      printf 'SH_WORKSPACE_ROOT=%s\nSH_CHROOT_BASE=%s\n' "$SBX_SRV/workspaces/$id" "$SBX_SRV/jail/$id"
      printf 'SH_PARENT_CGROUP=sbx.slice/sbx-%s.slice\n' "$id"
      printf 'SH_MAX_COMMITTED_MB=%s\nSH_WORKSPACE_IDLE=%s\nSH_WORKSPACE_IMAGE_MB=%s\n' "$BUDGET_MB" "$idle" "$image_mb"
      [[ -n "$NO_EGRESS" ]] || printf 'MOCA_EGRESS_CONTROL_SOCK=/run/moca-egress/control.sock\n'
    } >"$SBX_ENV_DIR/workers/$id.env"
  )
  chmod 0600 "$SBX_ENV_DIR/workers/$id.env"
  printf '[Unit]\nDescription=SBX0 sandbox worker %s (slice)\n\n[Slice]\nMemorySwapMax=0\n' "$id" \
    >"$SBX_UNIT_DIR/sbx-$id.slice"
  record "worker sbx-worker@$id $SBX_ENV_DIR/workers/$id.env $SBX_UNIT_DIR/sbx-$id.slice"
  systemctl daemon-reload
  # enable, then exactly one restart: a first install starts the unit, a re-install picks up the new
  # env file once (enable --now followed by restart would start a fresh unit twice).
  systemctl enable "sbx-worker@$id.service"
  # A worker that crash-looped into `failed` (StartLimitBurst, e.g. a missing snapshot) refuses a
  # restart with "start request repeated too quickly" until reset; a re-run after the fix is how an
  # operator brings it back (as deploy/microvm/setup-microvm.sh does).
  systemctl reset-failed "sbx-worker@$id.service" || true
  systemctl restart "sbx-worker@$id.service"
  wait_attached "$id"
}

invocation() { # invocation WORKER_ID -> the unit's current InvocationID, or nothing
  systemctl show -p InvocationID --value "sbx-worker@$1.service" 2>/dev/null | sed 's/^InvocationID=//' || true
}

# attach_state <journal text> -> "<count of attached/ended lines> <last: attached|ended|none>"
attach_state() {
  local line n=0 last=none
  while IFS= read -r line; do
    case "$line" in
    *"attached, serving execs"*) n=$((n + 1)) last=attached ;;
    *"stream ended"*) n=$((n + 1)) last=ended ;;
    esac
  done <<<"$1"
  printf '%s %s' "$n" "$last"
}

# The rule of deploy/microvm/setup-microvm.sh --remote (attach_state, verify_attached_remote). The
# worker logs `attached, serving execs` as soon as its stream opens, before the relay reads the
# token; a refused token ends the stream milliseconds later (`stream ended (...); reconnecting`) and
# the worker retries after a backoff. Refusals are normal for a while after a template is added: the
# relay sees the new token file only once the kubelet syncs the Secret, about a minute. So an earlier
# refusal does not fail the wait; an attach counts once it HOLDS: in the current invocation the last
# attached/ended line is an attached one, and the count and the last line are unchanged across
# SBX_ATTACH_SETTLE seconds (at least 1, to outlast the worker's first backoff of at most 750ms).
# The journal is captured once per look, never piped into `grep -q`: under pipefail grep's early
# exit can SIGPIPE journalctl, and a negated check would then read as success. Bounded by the wall
# clock: polls start until SBX_ATTACH_TIMEOUT has passed, and the first one always runs.
wait_attached() {
  local id="$1" inv='' now out first deadline=$((SECONDS + SBX_ATTACH_TIMEOUT))
  while :; do
    inv="$(invocation "$id")"
    if [[ -n "$inv" ]]; then
      out="$(journalctl -q --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$inv" 2>/dev/null || true)"
      first="$(attach_state "$out")"
      if [[ "$first" == *" attached" ]]; then
        sleep "$SBX_ATTACH_SETTLE"
        now="$(invocation "$id")"
        out="$(journalctl -q --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$inv" 2>/dev/null || true)"
        if [[ "$now" == "$inv" && "$(attach_state "$out")" == "$first" ]]; then
          log "sbx-worker@$id attached to the relay"
          return 0
        fi
      fi
    fi
    ((SECONDS < deadline)) || break
    sleep 1
  done
  die "sbx-worker@$id did not stay attached within ${SBX_ATTACH_TIMEOUT}s (a wrong or revoked token, TLS or DNS; a newly added worker's token can take about a minute to reach the relay, so re-run or raise SBX_ATTACH_TIMEOUT). The reason is in: journalctl -u sbx-worker@$id _SYSTEMD_INVOCATION_ID=$inv"
}

drop_manifest_lines() { # drop_manifest_lines -e FIXED... : remove every manifest line containing one
  { grep -v -F "$@" "$SBX_ENV_DIR/manifest" || true; } >"$SBX_ENV_DIR/manifest.new"
  mv "$SBX_ENV_DIR/manifest.new" "$SBX_ENV_DIR/manifest"
}

# Once the manifest names no worker, the units it lists as shared (`unit <path>`: the template unit
# and sbx.slice) have nothing left to serve: remove them and their lines. Only what the manifest
# lists, so a host whose manifest is gone keeps whatever is there.
remove_shared_units() {
  local kind path
  [[ -f "$SBX_ENV_DIR/manifest" ]] || return 0
  ! grep -q '^worker ' "$SBX_ENV_DIR/manifest" || return 0
  while read -r kind path; do
    [[ "$kind" == unit && -n "$path" ]] || continue
    rm -f "$path"
    drop_manifest_lines -x -e "unit $path"
    log "removed $path (no SBX0 worker left on this host)"
  done < <(grep '^unit ' "$SBX_ENV_DIR/manifest" || true)
  remove_egress
}

# The moca-egress this script installed goes with the last worker: stopped, then its unit removed, but
# only while the unit still has the content this script wrote (another install, such as the P6
# setup-microvm.sh, may have replaced it and its worker depends on it). The env file is the operator's
# allowlist: it goes only if it still hashes to what was seeded (a manifest without a digest falls back
# to comparing with the seed -- or with the legacy GitHub-only seed, which an older script's fresh
# install wrote and which is not an operator's edit). A moca-egress.service the manifest does not list
# was never ours. An `egress <kind>` this script does not know (a later version's) is left alone, line
# and file.
remove_egress() {
  local kind path sha
  [[ -f "$SBX_ENV_DIR/manifest" ]] || return 0
  while read -r kind path sha; do
    [[ -n "$path" ]] || continue
    case "$kind" in
    unit)
      if egress_unit_is_ours "$path" "$sha"; then
        systemctl disable --now moca-egress.service || true
        rm -f "$path"
        log "removed $path (no SBX0 worker left on this host)"
      elif [[ -e "$path" ]]; then
        log "kept $path (changed by another install)"
      fi
      ;;
    file)
      if [[ ! -f "$path" ]]; then
        :
      elif [[ -n "$sha" && "$(sha256_of "$path")" != "$sha" ]] ||
        [[ -z "$sha" && "$(cat "$path")" != "$(egress_seed)" &&
          "$(cat "$path")" != "MOCA_EGRESS_ALLOW=$LEGACY_EGRESS_ALLOW" ]]; then
        log "kept $path (edited)"
      else
        rm -f "$path"
        log "removed $path"
      fi
      ;;
    credential)
      remove_credential_file "$path" || continue
      [[ "$path" != *sbx-credentials.conf ]] ||
        log 'credential injection removed with the last worker; re-run install-host.sh --egress after installing a worker'
      ;;
    *) continue ;;
    esac
    egress_forget "$kind" "$path"
  done < <(sed -n 's/^egress //p' "$SBX_ENV_DIR/manifest")
}

# The janitor's paths go into sed replacements and a unit file: plain absolute paths only.
PLAIN_PATH_RE='^/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$'
JANITOR_URL_RE='^https://[A-Za-z0-9.-]+(:[0-9]+)?$' # janitor.sh's own rule

install_janitor() {
  local b="$JANITOR" url age v line ca=''
  local t
  for t in jq curl; do command -v "$t" >/dev/null || die "needs $t on PATH: the janitor (deploy/sbx/janitor.sh) calls it"; done
  for v in SBX_ENV_DIR SBX_SRV SBX_LIBEXEC_DIR SBX_UNIT_DIR; do
    [[ "${!v}" =~ $PLAIN_PATH_RE ]] || die "$v='${!v}' must be a plain absolute path"
  done
  [[ -f "$b/janitor.env" && -f "$b/janitor.token" ]] ||
    die "no $b/janitor.env and janitor.token: pass the bundle directory deploy/sbx/setup.sh wrote (janitor/)"
  # Only the two settings: the token belongs in janitor.token alone (spec §8.1), never an env line.
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == SBX_API_URL=* || "$line" == SBX_JANITOR_AGE=* ]] ||
      die "$b/janitor.env has a line other than SBX_API_URL= or SBX_JANITOR_AGE= (${line%%=*}): re-run deploy/sbx/setup.sh and copy the new bundle"
  done <"$b/janitor.env"
  url="$(env_value SBX_API_URL "$b/janitor.env")"
  [[ "$url" =~ $JANITOR_URL_RE ]] || die "SBX_API_URL in $b/janitor.env must be https://<api host>"
  age="$(env_value SBX_JANITOR_AGE "$b/janitor.env")"
  # Decimal without a leading zero (the janitor's own rule: bash reads 03600 as octal), and above a
  # floor of 60 s. setup.sh's own minimum is 60 minutes; the real check against the token lifetime
  # stays there (spec §8.1), where the lifetime is known.
  [[ "$age" =~ ^(0|[1-9][0-9]{0,8})$ ]] || die "SBX_JANITOR_AGE in $b/janitor.env must be whole seconds, in decimal without a leading zero"
  ((10#$age > 60)) || die "SBX_JANITOR_AGE in $b/janitor.env is ${age} s: it must exceed 60 s (re-run deploy/sbx/setup.sh and copy the new bundle)"
  [[ "$(<"$b/janitor.token")" =~ ^[!-~]{32,}$ ]] || die "$b/janitor.token does not hold a token of 32+ printable characters: copy the bundle again"
  if [[ -f "$b/api-ca.crt" ]]; then
    grep -q -- '-----BEGIN CERTIFICATE-----' "$b/api-ca.crt" || die "$b/api-ca.crt holds no PEM certificate"
    ca="$SBX_ENV_DIR/janitor-api-ca.crt"
  fi

  install -d -m 0700 "$SBX_ENV_DIR"
  install -d -m 0755 "$SBX_LIBEXEC_DIR" "$SBX_UNIT_DIR"
  if [[ -n "$ca" ]]; then
    install -m 0644 "$b/api-ca.crt" "$ca"
    record "janitor $ca"
  else
    rm -f "$SBX_ENV_DIR/janitor-api-ca.crt"
    [[ ! -f "$SBX_ENV_DIR/manifest" ]] || drop_manifest_lines -x -e "janitor $SBX_ENV_DIR/janitor-api-ca.crt"
  fi
  (
    umask 077
    printf 'SBX_API_URL=%s\nSBX_JANITOR_AGE=%s\n' "$url" "$age" >"$SBX_ENV_DIR/janitor.env"
    [[ -z "$ca" ]] || printf 'SBX_API_CA_FILE=%s\n' "$ca" >>"$SBX_ENV_DIR/janitor.env"
  )
  chmod 0600 "$SBX_ENV_DIR/janitor.env"
  install -m 0600 "$b/janitor.token" "$SBX_ENV_DIR/janitor.token"
  install -m 0755 "$SCRIPT_DIR/janitor.sh" "$SBX_LIBEXEC_DIR/sbx-janitor.sh"
  # The installed unit drops the source's comments (they name the default paths) and takes this
  # host's: the validated paths hold no sed metacharacter.
  {
    printf '# Installed by deploy/sbx/install-host.sh --janitor from deploy/sbx/sbx-janitor.service.\n'
    sed -e '/^#/d' -e "s#/etc/sbx#$SBX_ENV_DIR#g" -e "s#/srv/sbx#$SBX_SRV#g" \
      -e "s#/usr/local/libexec#$SBX_LIBEXEC_DIR#g" "$SCRIPT_DIR/sbx-janitor.service"
  } >"$SBX_UNIT_DIR/sbx-janitor.service"
  chmod 0644 "$SBX_UNIT_DIR/sbx-janitor.service"
  install -m 0644 "$SCRIPT_DIR/sbx-janitor.timer" "$SBX_UNIT_DIR/sbx-janitor.timer"
  for v in "$SBX_ENV_DIR/janitor.env" "$SBX_ENV_DIR/janitor.token" "$SBX_LIBEXEC_DIR/sbx-janitor.sh" \
    "$SBX_UNIT_DIR/sbx-janitor.service" "$SBX_UNIT_DIR/sbx-janitor.timer"; do
    record "janitor $v"
  done
  systemctl daemon-reload
  systemctl enable --now sbx-janitor.timer
  log "sbx-janitor.timer enabled (every 15 min); its runs: journalctl -u sbx-janitor -o cat | grep '\"janitor\"'"
}

# Exactly the files the manifest lists as `janitor <path>`; a host whose manifest is gone keeps
# whatever is there, as remove_shared_units does.
uninstall_janitor() {
  local kind path
  systemctl disable --now sbx-janitor.timer || true
  systemctl stop sbx-janitor.service || true
  if [[ -f "$SBX_ENV_DIR/manifest" ]]; then
    while read -r kind path; do
      [[ "$kind" == janitor && -n "$path" ]] || continue
      rm -f "$path"
      drop_manifest_lines -x -e "janitor $path"
      log "removed $path"
    done < <(grep '^janitor ' "$SBX_ENV_DIR/manifest" || true)
  fi
  systemctl daemon-reload
  log "the janitor is removed; workspace data under $SBX_SRV/workspaces is left in place"
}

uninstall_worker() {
  local id="$1"
  valid_id "$id" || die "not a worker id: $id"
  systemctl disable --now "sbx-worker@$id.service" || true
  # A stop that hit TimeoutStopSec can leave the worker's VMs in its slice; stopping the slice ends them.
  systemctl stop "sbx-$id.slice" || true
  rm -f "$SBX_ENV_DIR/workers/$id.env" "$SBX_ENV_DIR/workers/$id-relay-ca.crt" "$SBX_UNIT_DIR/sbx-$id.slice"
  # Fixed strings, so worker `a` never takes `ba`'s lines: `@a ` and `/a-relay-ca.crt` are not
  # substrings of `@ba ` and `/ba-relay-ca.crt`.
  [[ ! -f "$SBX_ENV_DIR/manifest" ]] || drop_manifest_lines -e "worker sbx-worker@$id " -e "/$id-relay-ca.crt"
  log "removed sbx-worker@$id"
  remove_shared_units
  systemctl daemon-reload
  log "left in place: $SBX_SRV/workspaces/$id and $SBX_SRV/jail/$id (workspace data; remove by hand when no sandbox needs it)"
}

main() {
  parse_args "$@"
  [[ -n "${SBX_SKIP_ROOT_CHECK:-}" || "$(id -u)" == 0 ]] || die 'must run as root'
  local modes=0 m
  for m in "$BUNDLE" "$UNINSTALL" "$JANITOR" "$UNINSTALL_JANITOR" "$EGRESS_BUNDLE" "$UNINSTALL_EGRESS" "$EGRESS_CA_OUT"; do [[ -z "$m" ]] || modes=$((modes + 1)); done
  ((modes <= 1)) || die 'one of BUNDLE_DIR, --uninstall, --janitor, --uninstall-janitor, --egress, --uninstall-egress or --egress-ca-out at a time'
  if [[ -n "$UNINSTALL" ]]; then uninstall_worker "$UNINSTALL"; return; fi
  if [[ -n "$UNINSTALL_JANITOR" ]]; then uninstall_janitor; return; fi
  if [[ -n "$JANITOR" ]]; then install_janitor; return; fi
  if [[ -n "$EGRESS_CA_OUT" ]]; then
    [[ "$SBX_ENV_DIR" =~ $PLAIN_PATH_RE ]] || die "SBX_ENV_DIR='$SBX_ENV_DIR' must be a plain absolute path"
    ensure_host_ca
    printf '%s\n' "$(EGRESS_CRED_DIR)/ca.crt"
    return
  fi
  if [[ -n "$UNINSTALL_EGRESS" ]]; then uninstall_egress_credentials; return; fi
  [[ "$SBX_ATTACH_TIMEOUT" =~ ^[1-9][0-9]*$ ]] ||
    die "SBX_ATTACH_TIMEOUT='$SBX_ATTACH_TIMEOUT' must be a whole number of seconds, at least 1"
  # At least 1: the hold must outlast the worker's first reconnect backoff (at most 750ms), or a
  # refused token's attached -> stream ended -> attached cycle could fall outside the window.
  [[ "$SBX_ATTACH_SETTLE" =~ ^[1-9][0-9]*$ ]] ||
    die "SBX_ATTACH_SETTLE='$SBX_ATTACH_SETTLE' must be a whole number of seconds, at least 1, to outlast the worker's first reconnect backoff (at most 750ms)"
  [[ "$MOCA_EGRESS_READY_TIMEOUT" =~ ^[1-9][0-9]*$ ]] ||
    die "MOCA_EGRESS_READY_TIMEOUT='$MOCA_EGRESS_READY_TIMEOUT' must be a whole number of seconds, at least 1"
  if [[ -n "$EGRESS_BUNDLE" ]]; then install_egress_credentials; return; fi
  [[ -n "$BUNDLE" ]] || die 'usage: install-host.sh BUNDLE_DIR --snapshot IMAGE [--budget-mb N] [--no-egress] | --uninstall ID | --janitor DIR | --uninstall-janitor | --egress DIR | --uninstall-egress | --egress-ca-out'
  validate_worker
  [[ -n "$NO_EGRESS" ]] || install_egress
  install_units
  install_worker
}

main "$@"
