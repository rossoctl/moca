#!/bin/sh
# Dev-machine trial bootstrap (#342): fetches deploy/compose/docker-compose.yml, writes a .env
# next to it (generating SH_RELAY_TOKEN when none is supplied) and runs `docker compose up -d`.
#
#   curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/deploy/compose/install.sh | sh
#
# This is the TRIAL path. The production path is deploy/vm/setup-vm.sh (see deploy/compose/README.md).
#
# POSIX sh, not bash: the one-liner above pipes this file into whatever `sh` the machine has, so
# nothing here may rely on bash, on BASH_SOURCE, or on this file's own location on disk.
#
# Environment (all optional):
#   SH_COMPOSE_DIR       Where the compose file and .env live (default $HOME/.moca)
#   SH_COMPOSE_BASE_URL  Where to fetch docker-compose.yml from (default: this repo's main branch)
#   SH_RELAY_TOKEN       The relay's shared secret; generated (32 random bytes, hex) if unset
#   SH_TURNS_PER_WORKER  Per-worker in-flight turn cap (default 4 -- a trial value, not an E8 result)
#   ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, OPENAI_API_KEY, OPENAI_BASE_URL,
#   SH_MODEL, SH_MODEL_PROVIDER, SH_MODEL_API, SH_MODEL_BASE_URL, SH_MODEL_AUTH, SH_MODEL_CUSTOM
#                        Model settings copied into .env when set (a turn needs a model)
set -eu

: "${SH_COMPOSE_DIR:=$HOME/.moca}"
: "${SH_COMPOSE_BASE_URL:=https://raw.githubusercontent.com/rossoctl/moca/main/deploy/compose}"

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
      printf '# REQUIRED by the supervisor. %s is a trial value; for E8 it is a measured output.\n' \
        "${SH_TURNS_PER_WORKER:-4}"
      printf 'SH_TURNS_PER_WORKER=%s\n' "${SH_TURNS_PER_WORKER:-4}"
      printf '# SH_WORKERS defaults to the CPUs this container may use; set it to pin W.\n'
      printf '#SH_WORKERS=2\n'
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

main() {
  detect_compose
  fetch_compose_file
  write_env_file
  require_relay_token
  log "starting the stack ($COMPOSE up -d)"
  # Compose reads .env from the project directory, so the token reaches the containers from that
  # file and never from this command line.
  cd "$SH_COMPOSE_DIR"
  $COMPOSE up -d
  log "done. Supervisor: http://127.0.0.1:8080  (logs: cd $SH_COMPOSE_DIR && $COMPOSE logs -f)"
}

main "$@"
