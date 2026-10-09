#!/bin/sh
# Dev-machine trial bootstrap (#342): fetches deploy/compose/docker-compose.yml, writes a .env
# next to it (generating SH_RELAY_TOKEN when none is supplied, and -- when SH_GITHUB_CLIENT_ID turns
# the MU1 control plane on -- its secrets, #348) and runs `docker compose up -d`.
#
#   curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/deploy/compose/install.sh | sh
#
# This is the TRIAL path. The production path is deploy/vm/setup-vm.sh (see deploy/compose/README.md).
#
# POSIX sh, not bash: the one-liner above pipes this file into whatever `sh` the machine has, so
# nothing here may rely on bash, on BASH_SOURCE, or on this file's own location on disk.
#
# Environment (all optional):
#   SH_COMPOSE_DIR       Where the compose file and .env live (default $HOME/.serverless-harness)
#   SH_COMPOSE_BASE_URL  Where to fetch docker-compose.yml from (default: this repo's main branch)
#   SH_RELAY_TOKEN       The relay's shared secret; generated (32 random bytes, hex) if unset
#   SH_TURNS_PER_WORKER  Per-worker in-flight turn cap (default 4 -- a trial value, not an E8 result)
#   SH_GITHUB_CLIENT_ID  A GitHub OAuth app's client id, device flow enabled: turns on the control
#                        plane (the `control-plane` profile) that mocactl logs in through
#   SH_HARNESS_IMAGE     The harness image; also runs the key generator (default: the published one)
#   ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, OPENAI_API_KEY, OPENAI_BASE_URL,
#   SH_MODEL, SH_MODEL_PROVIDER, SH_MODEL_API, SH_MODEL_BASE_URL, SH_MODEL_AUTH, SH_MODEL_CUSTOM
#                        Model settings copied into .env when set (a turn needs a model)
set -eu

: "${SH_COMPOSE_DIR:=$HOME/.serverless-harness}"
: "${SH_COMPOSE_BASE_URL:=https://raw.githubusercontent.com/rossoctl/moca/main/deploy/compose}"

DEFAULT_HARNESS_IMAGE='ghcr.io/rossoctl/moca:latest'
MODEL_VARS='ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL OPENAI_API_KEY OPENAI_BASE_URL
SH_MODEL SH_MODEL_PROVIDER SH_MODEL_API SH_MODEL_BASE_URL SH_MODEL_AUTH SH_MODEL_CUSTOM'

log() { printf '==> %s\n' "$*"; }
die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

# Sets COMPOSE to the compose entrypoint this machine has: the v2 plugin if present, else the
# standalone docker-compose binary. Word-split on purpose where it is used.
detect_compose() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE='docker compose'
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE='docker-compose'
  else
    die "needs Docker with Compose: neither 'docker compose' nor 'docker-compose' works on this machine"
  fi
  command -v curl >/dev/null 2>&1 || die "needs curl to fetch the compose file"
}

fetch_compose_file() {
  log "fetching docker-compose.yml into $SH_COMPOSE_DIR"
  mkdir -p "$SH_COMPOSE_DIR"
  curl -fsSL -o "$SH_COMPOSE_DIR/docker-compose.yml.tmp" "$SH_COMPOSE_BASE_URL/docker-compose.yml"
  mv "$SH_COMPOSE_DIR/docker-compose.yml.tmp" "$SH_COMPOSE_DIR/docker-compose.yml"
}

# 32 bytes from the kernel CSPRNG as 64 hex chars. The token only ever travels through a pipe and
# the shell's own variables -- never an argv -- because /proc/<pid>/cmdline is world-readable.
generate_token() {
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
}

# The value of KEY in an env file, or empty. `|| true`: a missing key is an answer, not an error.
env_file_value() {
  { grep -E "^$1=" "$2" 2>/dev/null || true; } | tail -1 | cut -d= -f2-
}

# Written once. A re-run never clobbers it: the operator may have edited it, and replacing
# SH_RELAY_TOKEN under running sandboxes would stop every one of them authenticating.
write_env_file() {
  env_file="$SH_COMPOSE_DIR/.env"
  if [ -e "$env_file" ]; then
    log "keeping existing $env_file"
    return 0
  fi
  log "writing $env_file"
  token="${SH_RELAY_TOKEN:-}"
  [ -n "$token" ] || token="$(generate_token)"
  [ -n "$token" ] || die "could not generate SH_RELAY_TOKEN from /dev/urandom"
  # umask before the first byte lands, so the secret is never briefly world-readable.
  (
    umask 077
    {
      printf '# Written by deploy/compose/install.sh. Edit freely; install.sh never overwrites it.\n'
      printf '# The relay rejects every sandbox attach unless this matches SANDBOX_TOKEN (fail-closed).\n'
      printf 'SH_RELAY_TOKEN=%s\n' "$token"
      printf '# The workers'"'"' credential for the relay'"'"'s SandboxExec. Never give it to a sandbox.\n'
      printf 'MOCA_RELAY_EXEC_TOKEN=%s\n' "$(generate_token)"
      printf '# REQUIRED by the supervisor. %s is a trial value; for E8 it is a measured output.\n' \
        "${SH_TURNS_PER_WORKER:-4}"
      printf 'SH_TURNS_PER_WORKER=%s\n' "${SH_TURNS_PER_WORKER:-4}"
      printf '# SH_WORKERS defaults to the CPUs this container may use; set it to pin W.\n'
      printf '#SH_WORKERS=2\n'
      printf '# The MU1 control plane (mocactl login, sessions, credentials) is the control-plane\n'
      printf '# profile; install.sh turns it on when given SH_GITHUB_CLIENT_ID. Operator-key fallback:\n'
      printf '# OFF by default. Turned on, EVERY user without their own credential spends this key.\n'
      printf '#SH_ALLOW_OPERATOR_FALLBACK=true\n'
      printf '#SH_OPERATOR_INFERENCE_TOKEN=\n'
      printf '# A gateway token: the gateway origin. An Anthropic API key: https://api.anthropic.com AND\n'
      printf '# SH_OPERATOR_INFERENCE_HEADER=x-api-key. The control plane refuses to boot on a mismatch.\n'
      printf '#SH_DEFAULT_INFERENCE_ENDPOINT=https://api.anthropic.com\n'
      printf '#SH_OPERATOR_INFERENCE_HEADER=x-api-key\n'
      printf '# Model settings (a turn needs one). Only variables that were set are listed.\n'
      for var in $MODEL_VARS; do
        eval "is_set=\${$var+x}"
        # shellcheck disable=SC2154 # assigned by the eval above
        if [ -n "$is_set" ]; then
          eval "value=\$$var"
          # shellcheck disable=SC2154 # assigned by the eval above
          printf '%s=%s\n' "$var" "$value"
        fi
      done
    } >"$env_file"
  )
}

# Same fail-closed preflight as deploy/vm/setup-vm.sh's require_relay_token: starting sandboxes
# against a relay with no token guarantees attaches that can never succeed.
require_relay_token() {
  env_file="$SH_COMPOSE_DIR/.env"
  if [ -z "$(env_file_value SH_RELAY_TOKEN "$env_file")" ]; then
    die "SH_RELAY_TOKEN is not set in $env_file: the relay's token validation is fail-closed, so" \
      "every sandbox attach would be rejected. Set it there to a shared secret, then re-run."
  fi
}

# The exec token is shared only by the relay and the supervisor, both of which compose restarts, so
# unlike SH_RELAY_TOKEN it is safe to create on an upgrade. Appended, never rewritten.
# Terminate an operator-edited file's last line before appending to it: `>>` onto a file with no final
# newline glues the new assignment onto the last one (SH_RELAY_TOKEN=<t>MOCA_RELAY_EXEC_TOKEN=...),
# silently changing that value. $(...) strips a trailing newline, so it is empty only when the file
# already ends in one.
end_with_newline() {
  if [ -s "$1" ] && [ -n "$(tail -c 1 "$1")" ]; then printf '\n' >>"$1"; fi
}

ensure_exec_token() {
  env_file="$SH_COMPOSE_DIR/.env"
  [ -n "$(env_file_value MOCA_RELAY_EXEC_TOKEN "$env_file")" ] && return 0
  exec_token="$(generate_token)"
  [ -n "$exec_token" ] || die "could not generate MOCA_RELAY_EXEC_TOKEN from /dev/urandom"
  log "adding MOCA_RELAY_EXEC_TOKEN to $env_file"
  (
    umask 077
    end_with_newline "$env_file"
    printf 'MOCA_RELAY_EXEC_TOKEN=%s\n' "$exec_token" >>"$env_file"
  )
}

# Appends one KEY=VALUE line to .env, under umask 077. The value only ever travels through this
# shell's variables and a builtin printf -- never an argv (/proc/<pid>/cmdline is world-readable).
append_env() {
  (
    umask 077
    end_with_newline "$SH_COMPOSE_DIR/.env"
    printf '%s=%s\n' "$1" "$2" >>"$SH_COMPOSE_DIR/.env"
  )
}

# KEY's value in the key generator's output ($GENERATED), checked against an extended regex so a
# truncated or garbled line can never be written into .env as a secret.
generated_value() {
  v="$(printf '%s\n' "$GENERATED" | sed -n "s/^$1=//p" | tail -1)"
  printf '%s\n' "$v" | grep -Eq "^$2\$" ||
    die "the key generator produced no usable $1 (image: $harness_image)"
  printf '%s' "$v"
}

# The four MU1 secrets (#348): the control plane's ed25519 signing key and credential KEK, the
# supervisor's copy of the public key, and the exchange token both hold. Generated inside the harness
# image (packages/control-plane/src/genkeys.ts) so the host needs no openssl, and only for what .env
# lacks -- a re-run never replaces one: a new KEK would make every stored credential undecryptable,
# and a new signing key would invalidate every live session token.
ensure_mu1_secrets() {
  env_file="$SH_COMPOSE_DIR/.env"
  have_priv="$(env_file_value SH_SESSION_TOKEN_PRIVATE_KEY "$env_file")"
  have_pub="$(env_file_value SH_SESSION_TOKEN_PUBLIC_KEYS "$env_file")"
  have_kek="$(env_file_value SH_CREDENTIAL_KEK "$env_file")"
  have_xchg="$(env_file_value SH_EXCHANGE_TOKEN "$env_file")"
  # The two halves of the signing key are one secret: generating the missing half would pair it with
  # the wrong key and every session token would fail to verify.
  if { [ -n "$have_priv" ] && [ -z "$have_pub" ]; } || { [ -z "$have_priv" ] && [ -n "$have_pub" ]; }; then
    die "$env_file has only one of SH_SESSION_TOKEN_PRIVATE_KEY and SH_SESSION_TOKEN_PUBLIC_KEYS." \
      "They are one keypair: remove both lines to generate a fresh pair, or restore the missing one."
  fi
  if [ -n "$have_priv" ] && [ -n "$have_kek" ] && [ -n "$have_xchg" ]; then
    return 0
  fi
  command -v docker >/dev/null 2>&1 ||
    die "needs the docker CLI to generate the control plane's keys inside the harness image"
  harness_image="${SH_HARNESS_IMAGE:-$(env_file_value SH_HARNESS_IMAGE "$env_file")}"
  harness_image="${harness_image:-$DEFAULT_HARNESS_IMAGE}"
  log "generating control-plane keys (in $harness_image)"
  # No network, the image's own uid, and the secrets on stdout only.
  GENERATED="$(docker run --rm --network none --user 1000:1000 -w /app/packages/control-plane \
    "$harness_image" node --import tsx src/genkeys.ts)" ||
    die "could not run the key generator in $harness_image"
  # Every value is extracted and checked BEFORE the first append, so a garbled generator can never
  # leave .env holding half a set.
  [ -n "$have_priv" ] || {
    priv="$(generated_value SH_SESSION_TOKEN_PRIVATE_KEY '[A-Za-z0-9+/]+=*')" || exit 1
    pub="$(generated_value SH_SESSION_TOKEN_PUBLIC_KEYS '[0-9a-f]{16}:[A-Za-z0-9+/]+=*')" || exit 1
  }
  [ -n "$have_kek" ] || { kek="$(generated_value SH_CREDENTIAL_KEK '[A-Za-z0-9+/]{43}=')" || exit 1; }
  [ -n "$have_xchg" ] || { xchg="$(generated_value SH_EXCHANGE_TOKEN '[0-9a-f]{64}')" || exit 1; }
  if [ -z "$have_priv" ]; then
    log "adding SH_SESSION_TOKEN_PRIVATE_KEY and SH_SESSION_TOKEN_PUBLIC_KEYS to $env_file"
    append_env SH_SESSION_TOKEN_PRIVATE_KEY "$priv"
    append_env SH_SESSION_TOKEN_PUBLIC_KEYS "$pub"
  fi
  if [ -z "$have_kek" ]; then
    log "adding SH_CREDENTIAL_KEK to $env_file"
    append_env SH_CREDENTIAL_KEK "$kek"
  fi
  if [ -z "$have_xchg" ]; then
    log "adding SH_EXCHANGE_TOKEN to $env_file"
    append_env SH_EXCHANGE_TOKEN "$xchg"
  fi
  GENERATED=''
}

# The control plane needs a GitHub OAuth app (device flow ENABLED -- it is off by default) for login.
# Given one, record it and turn on the control-plane profile. An existing COMPOSE_PROFILES line is the
# operator's and is left alone, so CONTROL_PLANE is set from what that line ENABLES, not from the
# client id alone: the closing message and the key generation both follow it.
ensure_control_plane_profile() {
  env_file="$SH_COMPOSE_DIR/.env"
  if [ -n "${SH_GITHUB_CLIENT_ID:-}" ] && [ -z "$(env_file_value SH_GITHUB_CLIENT_ID "$env_file")" ]; then
    log "adding SH_GITHUB_CLIENT_ID to $env_file"
    append_env SH_GITHUB_CLIENT_ID "$SH_GITHUB_CLIENT_ID"
  fi
  CONTROL_PLANE=''
  [ -n "$(env_file_value SH_GITHUB_CLIENT_ID "$env_file")" ] || return 0
  if ! grep -Eq '^COMPOSE_PROFILES=' "$env_file"; then
    log "enabling the control-plane profile in $env_file"
    append_env COMPOSE_PROFILES control-plane
  fi
  # Comma-separated, as Compose reads it; spaces around entries are tolerated.
  case ",$(env_file_value COMPOSE_PROFILES "$env_file" | tr -d ' ')," in
  *,control-plane,*) CONTROL_PLANE=1 ;;
  *)
    log "WARNING: $env_file sets COMPOSE_PROFILES without control-plane, so the control plane will" \
      "not run. Add control-plane to that line and re-run install.sh to enable it."
    ;;
  esac
}

# A port as compose will publish it: the caller's environment wins over .env, as it does for compose.
published_port() {
  eval "from_env=\${$1:-}"
  # shellcheck disable=SC2154 # assigned by the eval above
  port="${from_env:-$(env_file_value "$1" "$SH_COMPOSE_DIR/.env")}"
  printf '%s' "${port:-$2}"
}

main() {
  detect_compose
  fetch_compose_file
  write_env_file
  require_relay_token
  ensure_exec_token
  ensure_control_plane_profile
  # Only a control plane needs the MU1 secrets, and generating them needs the docker CLI and a harness
  # image that ships the generator. A stack without the profile needs neither; a later re-run with a
  # client id fills them in.
  [ -z "$CONTROL_PLANE" ] || ensure_mu1_secrets
  log "starting the stack ($COMPOSE up -d)"
  # Compose reads .env from the project directory, so the token reaches the containers from that
  # file and never from this command line.
  cd "$SH_COMPOSE_DIR"
  $COMPOSE up -d
  sh_port="$(published_port SH_PORT 8080)"
  log "done. Supervisor: http://127.0.0.1:$sh_port  (logs: cd $SH_COMPOSE_DIR && $COMPOSE logs -f)"
  if [ -n "$CONTROL_PLANE" ]; then
    cp_url="http://127.0.0.1:$(published_port SH_CP_PORT 8090)"
    log "control plane: $cp_url  (mocactl --control-plane-url $cp_url login)"
    log "no mocactl yet? curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh"
  else
    log "no control plane (mocactl needs one): re-run with SH_GITHUB_CLIENT_ID set to a GitHub OAuth" \
      "app's client id, device flow enabled"
  fi
}

main "$@"
