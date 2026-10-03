#!/usr/bin/env bash
# Cluster-free, root-free test for setup-vm.sh. Mocks podman/systemctl/getent onto PATH and
# asserts on the recorded argv, plus checks all three unit files' ExecStart/WorkingDirectory
# pairing, their §4.3 hardening directives, the env-file contract each EnvironmentFile= line
# implies, and (last) a full main() run against the mocks.
set -euo pipefail

VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$VM_DIR/setup-vm.sh"
UNIT_SUPERVISOR="$VM_DIR/systemd/sh-supervisor.service"
UNIT_RELAY="$VM_DIR/systemd/sh-relay.service"
UNIT_CP="$VM_DIR/systemd/sh-control-plane.service"
CP_MAIN="$VM_DIR/../../packages/control-plane/src/main.ts"
ENV_SRC_DIR="$VM_DIR/env"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log"
# setup-vm.sh seeds control-plane.env from these; one exported in the developer's shell would configure
# every control plane below that the tests expect to stay unconfigured.
unset SH_GITHUB_CLIENT_ID SH_PUBLIC_HARNESS_URL
mkdir -p "$TMP/bin"
for cmd in podman getent pnpm nft; do
  cat >"$TMP/bin/$cmd" <<'MOCK'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >>"$MOCK_LOG"
MOCK
  chmod +x "$TMP/bin/$cmd"
done
# podman gets a richer mock than the log-only loop above: it records its own SANDBOX_TOKEN
# environment as well as its argv. Both halves are needed to assert the secret is passed BY NAME --
# that the value is absent from the command line (where /proc/<pid>/cmdline would expose it to any
# local user) while the container still receives it. Logging only argv could not tell "passed safely"
# apart from "not passed at all".
export MOCK_ENV_LOG="$TMP/mock-env.log"
# `podman network inspect` also needs real stdout: ensure_sandbox_network parses it back to detect
# a pre-existing network whose subnet/gateway or isolation differs from what is configured.
# MOCK_PODMAN_INSPECT (subnet/gateway), MOCK_PODMAN_ISOLATE (the isolate option) and MOCK_PODMAN_IFACE
# (the bridge interface name) let a test simulate such a network; their defaults match what
# setup-vm.sh configures, so every call site that sets none of them keeps passing.
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >>"$MOCK_LOG"
printf 'podman-env SANDBOX_TOKEN=%s\n' "${SANDBOX_TOKEN-<unset>}" >>"$MOCK_ENV_LOG"
# The exec token must never reach a sandbox by inheritance either (an `export`, a `set -a` over
# relay.env): record whether podman's own environment carries it.
printf 'podman-env MOCA_RELAY_EXEC_TOKEN=%s\n' "${MOCA_RELAY_EXEC_TOKEN-<unset>}" >>"$MOCK_ENV_LOG"
printf 'podman-env SH_EXCHANGE_TOKEN=%s\n' "${SH_EXCHANGE_TOKEN-<unset>}" >>"$MOCK_ENV_LOG"
if [[ "$1" == "network" && "$2" == "inspect" ]]; then
  if [[ "$*" == *isolate* ]]; then
    printf '%s\n' "${MOCK_PODMAN_ISOLATE-strict}"
  elif [[ "$*" == *NetworkInterface* ]]; then
    printf '%s\n' "${MOCK_PODMAN_IFACE-moca-sandbox0}"
  else
    printf '%s\n' "${MOCK_PODMAN_INSPECT:-10.89.40.0/24 10.89.40.1}"
  fi
fi
MOCK
chmod +x "$TMP/bin/podman"

# systemctl logs its argv like the others and answers --version as a systemd new enough for
# LoadCredential= (MOCK_SYSTEMCTL_VERSION overrides the first line, as `systemctl --version` prints it).
# <extra> is one more line of mock body; the podman-restart test below uses it to fail one unit.
write_systemctl_mock() {
  {
    cat <<'MOCK'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >>"$MOCK_LOG"
if [[ "${1:-}" == --version ]]; then printf '%s\n+PAM +AUDIT +SELINUX\n' "${MOCK_SYSTEMCTL_VERSION-systemd 252 (252.22-1)}"; fi
# is-active answers "inactive" (3, as systemctl does) unless MOCK_SYSTEMCTL_ACTIVE names the unit.
if [[ "${1:-}" == is-active ]]; then [[ " $* " == *" ${MOCK_SYSTEMCTL_ACTIVE:-<none>} "* ]] && exit 0; exit 3; fi
MOCK
    printf '%s\n' "${1:-}"
  } >"$TMP/bin/systemctl"
  chmod +x "$TMP/bin/systemctl"
}
write_systemctl_mock

# id needs real stdout (the caller parses `id -u`), not just a log line, so it gets its own
# mock rather than joining the log-only loop above. It reports uid 0 -- main() end to end
# below is standing in for a `sudo ./setup-vm.sh` invocation (B3).
cat >"$TMP/bin/id" <<'MOCK'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >>"$MOCK_LOG"
if [[ "$*" == "-u" ]]; then
  echo 0
fi
MOCK
chmod +x "$TMP/bin/id"
export PATH="$TMP/bin:$PATH"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

export SH_SOURCE_ONLY=1
export SH_UNIT_DIR="$TMP/units" SH_ENV_DIR="$TMP/etc" SH_SANDBOX_COUNT=3
mkdir -p "$SH_UNIT_DIR"
# shellcheck source=/dev/null
source "$SCRIPT"
# The real generator needs a built workspace (tsx); CI's deploy-scripts job has none. Keep it as
# real_generate_mu1 for the one guarded live check below, and stand in a counter-backed fake that
# emits values in each secret's exact form, distinct per call, so "never rotated" is observable.
eval "$(declare -f generate_mu1 | sed '1s/^generate_mu1/real_generate_mu1/')"
export GEN_COUNT="$TMP/gen.count"
# shellcheck disable=SC2329  # invoked indirectly, by ensure_mu1_secrets
generate_mu1() {
  local n
  n=$(($(cat "$GEN_COUNT" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$GEN_COUNT"
  printf 'SH_SESSION_TOKEN_PRIVATE_KEY=PRIV%dAAAA\n' "$n"
  printf 'SH_SESSION_TOKEN_PUBLIC_KEYS=%016x:PUB%dBBBB\n' "$n" "$n"
  printf 'SH_CREDENTIAL_KEK=K%042d=\n' "$n"
  printf 'SH_EXCHANGE_TOKEN=%064x\n' "$n"
}
gen_calls() { cat "$GEN_COUNT" 2>/dev/null || echo 0; }

# --- sourcing must not touch the machine -------------------------------------------------
[[ ! -s "$MOCK_LOG" ]] || fail "sourcing ran commands: $(cat "$MOCK_LOG")"
pass "SH_SOURCE_ONLY sources without side effects"

# --- units land, and each carries the right ExecStart/WorkingDirectory and §4.3 hardening -
install_units
[[ -f "$SH_UNIT_DIR/sh-supervisor.service" ]] || fail "supervisor unit not installed"
[[ -f "$SH_UNIT_DIR/sh-relay.service" ]] || fail "relay unit not installed"
[[ -f "$SH_UNIT_DIR/sh-control-plane.service" ]] || fail "control-plane unit not installed"
grep -q 'systemctl daemon-reload' "$MOCK_LOG" || fail "daemon-reload not invoked"

# unit -> package-dir pairs. WorkingDirectory must be the package's OWN dir (not the repo
# root) and ExecStart must match that package's own `start` script (`node --import tsx
# src/main.ts`) -- the same CWD-resolution fix already documented at
# deploy/knative/relay-deployment.yaml:20-32 and deploy/knative/control-plane.yaml:184-187:
# `node --import tsx` resolves the tsx loader relative to the CWD, and tsx is linked only
# into each package's own node_modules, never root-hoisted.
UNIT_PACKAGES=(
  "$UNIT_SUPERVISOR:supervisor:serverless-harness"
  "$UNIT_RELAY:sandbox-relay:serverless-harness"
  "$UNIT_CP:control-plane:moca-control-plane"
)
for triple in "${UNIT_PACKAGES[@]}"; do
  unit="${triple%%:*}"
  rest="${triple#*:}"
  pkg="${rest%%:*}"
  state="${rest#*:}"
  grep -qE "^WorkingDirectory=/opt/serverless-harness/packages/$pkg\$" "$unit" ||
    fail "$unit: WorkingDirectory must be the $pkg package dir, not the repo root"
  grep -qE '^ExecStart=/usr/bin/node --import tsx src/main\.ts$' "$unit" ||
    fail "$unit: ExecStart must run src/main.ts relative to WorkingDirectory"
  for directive in ProtectSystem=strict NoNewPrivileges=true SystemCallFilter TimeoutStopSec \
    "StateDirectory=$state"; do
    # These are the VM analogue of the pod securityContext. Present, and asserted so a future
    # edit cannot quietly drop them -- §4.3 does not CLAIM parity, but it does claim presence.
    grep -q "$directive" "$unit" || fail "$unit is missing $directive"
  done
  # Nothing in deploy/vm/systemd/ installs a redis.service -- Redis runs as a bare podman
  # container from start_redis() in this same script -- so a Requires= here would name a unit
  # that can never resolve and the service would fail to start.
  if grep -q '^Requires=' "$unit"; then
    fail "$unit: Requires= names a unit nothing installs"
  fi
done
pass "all three units: correct ExecStart/WorkingDirectory, §4.3 hardening present, no dangling Requires="

# --- the supervisor unit must not SIGTERM its own workers -------------------------------------
# KillMode=control-group makes systemd's stop job deliver SIGTERM to EVERY process in the cgroup.
# worker.ts installs no SIGTERM handler, so on `systemctl stop`/`restart` all W workers died
# immediately on Node's default disposition -- and main.ts::close()'s ordered drainAll() -> stop
# accepting -> awaitIdle(SHUTDOWN_GRACE_MS) then drained a pool that was already gone. §3.9's
# "in-flight turns run to completion" never happened on the real deployment, only in the tests.
# `mixed` sends SIGTERM to the main process only (what the drain assumes) and still SIGKILLs the
# whole tree at TimeoutStopSec, which is what control-group was here for.
grep -qE '^KillMode=mixed$' "$UNIT_SUPERVISOR" ||
  fail "sh-supervisor.service must use KillMode=mixed: control-group SIGTERMs every worker" \
    "alongside the supervisor, so the ordered drain in main.ts::close() has nothing left to drain"
if grep -qE '^KillMode=control-group$' "$UNIT_SUPERVISOR"; then
  fail "sh-supervisor.service is back on KillMode=control-group (see above)"
fi
pass "supervisor unit uses KillMode=mixed, so its own drain can actually run"

# --- the supervisor unit must set HOME -------------------------------------------------------
# deploy/knative/service.yaml, leaf-scaledjob.yaml and control-plane.yaml all set HOME=/tmp for
# this same harness code, each with a writable path behind it. This unit runs as User=harness
# (README: useradd --no-create-home) under ProtectHome=true and ProtectSystem=strict, so $HOME is
# nonexistent or masked and the only writable places are PrivateTmp's /tmp and StateDirectory. Any
# turn writing agent/session state under $HOME fails at runtime, after a green bring-up -- and the
# hardening loop above could not see it, because it only asserts what IS present.
grep -qE '^Environment=HOME=' "$UNIT_SUPERVISOR" ||
  fail "sh-supervisor.service must set Environment=HOME= (every Knative manifest running this" \
    "code sets HOME=/tmp; here ProtectHome=true and a --no-create-home user leave \$HOME unusable)"
HOME_PATH="$(grep -oE '^Environment=HOME=.*' "$UNIT_SUPERVISOR" | head -1 | cut -d= -f3-)"
# Whatever it is set to must be writable under this unit's own sandboxing: PrivateTmp gives /tmp,
# StateDirectory gives /var/lib/serverless-harness. Anything else is a path ProtectSystem=strict
# masks, i.e. the same runtime failure with an extra step.
case "$HOME_PATH" in
/tmp | /tmp/* | /var/lib/serverless-harness | /var/lib/serverless-harness/*)
  pass "supervisor unit sets HOME=$HOME_PATH, writable under its own PrivateTmp/StateDirectory"
  ;;
*)
  fail "sh-supervisor.service sets HOME=$HOME_PATH, which ProtectSystem=strict/ProtectHome=true" \
    "leave unwritable -- use /tmp (PrivateTmp) or /var/lib/serverless-harness (StateDirectory)"
  ;;
esac

# --- every EnvironmentFile= has a shipped template (general form of the relay.env gap) -----
# Derive the env names from the units themselves, not by hard-coding "supervisor"/"relay" --
# that is what makes this catch the next env file somebody adds.
ENV_NAMES=()
for unit in "$UNIT_SUPERVISOR" "$UNIT_RELAY" "$UNIT_CP"; do
  # R46: under `set -euo pipefail`, a no-match `grep` in this pipeline aborts the script
  # right here -- before the `[[ -n "$name" ]] || fail ...` guard below can ever run. `|| true`
  # makes the guard reachable so a future unit missing EnvironmentFile= gets the diagnostic
  # instead of a raw abort.
  name=$( (grep -oE '^EnvironmentFile=/etc/serverless-harness/[A-Za-z0-9_.-]+\.env$' "$unit" ||
    true) | sed -E 's#.*/([A-Za-z0-9_.-]+)\.env$#\1#')
  [[ -n "$name" ]] || fail "$unit: no EnvironmentFile= line found"
  [[ -f "$ENV_SRC_DIR/$name.env.example" ]] ||
    fail "$unit references $name.env but deploy/vm/env/$name.env.example does not exist"
  ENV_NAMES+=("$name")
done
pass "every EnvironmentFile= has a shipped template"

# --- env files are written once and never clobbered ----------------------------------------
install_env
for name in "${ENV_NAMES[@]}"; do
  [[ -f "$SH_ENV_DIR/$name.env" ]] || fail "install_env did not install $name.env"
done
grep -q 'SH_TURNS_PER_WORKER=' "$SH_ENV_DIR/supervisor.env" || fail "env template incomplete"
grep -q 'SH_SANDBOX_DISCOVERY=records' "$SH_ENV_DIR/supervisor.env" ||
  fail "VM env must select records discovery (no cluster on a VM)"
echo 'SH_TURNS_PER_WORKER=9' >>"$SH_ENV_DIR/supervisor.env"
echo 'SH_RELAY_PORT=7777' >>"$SH_ENV_DIR/relay.env"
echo 'SH_GITHUB_CLIENT_ID=Iv1.operator' >>"$SH_ENV_DIR/control-plane.env"
install_env
grep -q 'SH_TURNS_PER_WORKER=9' "$SH_ENV_DIR/supervisor.env" ||
  fail "install_env clobbered an operator-edited supervisor.env"
grep -q 'SH_RELAY_PORT=7777' "$SH_ENV_DIR/relay.env" ||
  fail "install_env clobbered an operator-edited relay.env"
grep -q 'SH_GITHUB_CLIENT_ID=Iv1.operator' "$SH_ENV_DIR/control-plane.env" ||
  fail "install_env clobbered an operator-edited control-plane.env"
pass "all three env files written once, operator edits preserved"

# --- SH_TURNS_PER_WORKER ships EMPTY -------------------------------------------------------
# §3.8: shipping a value would put a guess where an E8 output belongs.
grep -qE '^SH_TURNS_PER_WORKER=$' "$ENV_SRC_DIR/supervisor.env.example" ||
  fail "the example env must leave SH_TURNS_PER_WORKER empty"
pass "no default shipped for SH_TURNS_PER_WORKER"

# --- the control plane unit and its env contract (#366) ------------------------------------------
# Loopback, the file store in its OWN StateDirectory, ordered after the containers come back.
grep -qE '^SH_CONTROL_PLANE_PORT=8090$' "$ENV_SRC_DIR/control-plane.env.example" ||
  fail "control-plane.env.example must bind 8090 (8080 is the supervisor's)"
grep -qE '^SH_CONTROL_PLANE_HOST=127\.0\.0\.1$' "$ENV_SRC_DIR/control-plane.env.example" ||
  fail "control-plane.env.example must bind loopback: it speaks plain HTTP"
grep -qE '^SH_CREDENTIAL_STORE=file$' "$ENV_SRC_DIR/control-plane.env.example" ||
  fail "control-plane.env.example must select the file credential store"
grep -qE '^SH_CREDENTIAL_DIR=/var/lib/moca-control-plane$' "$ENV_SRC_DIR/control-plane.env.example" ||
  fail "SH_CREDENTIAL_DIR must be the unit's StateDirectory (/var/lib/moca-control-plane)"
grep -qE '^REDIS_URL=redis://127\.0\.0\.1:6379$' "$ENV_SRC_DIR/control-plane.env.example" ||
  fail "control-plane.env.example must use the loopback Redis start_redis publishes"
for k in SH_PUBLIC_HARNESS_URL SH_GITHUB_CLIENT_ID; do
  grep -qE "^$k=\$" "$ENV_SRC_DIR/control-plane.env.example" ||
    fail "control-plane.env.example must ship $k empty: it has no honest default"
done
grep -qE '^StateDirectoryMode=0700$' "$UNIT_CP" || fail "$UNIT_CP: the credential store's dir must be 0700"
grep -qE '^After=.*podman-restart\.service' "$UNIT_CP" ||
  fail "$UNIT_CP: order after podman-restart.service, which brings Redis back on boot"
pass "control plane: loopback :8090, file store in its own 0700 StateDirectory, after Redis"

# Every setting main.ts REQUIRES is either a systemd credential or a key in control-plane.env.example
# (VAULT_ADDR only for the vault store). A secret is never ALSO an env line: credentialValue refuses
# both at once. This is the var-for-var mirror deploy/compose/tests/compose.test.sh keeps for compose.
secrets_line="$(grep -E '^export const CONTROL_PLANE_SECRETS = \[' "$CP_MAIN")" ||
  fail "main.ts has no one-line CONTROL_PLANE_SECRETS export"
mapfile -t cp_secrets < <(grep -oE "'SH_[A-Z_]+'" <<<"$secrets_line" | tr -d "'")
mapfile -t cp_required < <(grep -oE "required\(env, '[A-Z_]+'\)" "$CP_MAIN" | grep -oE "'[A-Z_]+'" | tr -d "'" | sort -u)
# Non-empty guards: a main.ts refactor that renamed required() would otherwise pass both loops vacuously.
((${#cp_secrets[@]})) || fail "found no secret names in main.ts's CONTROL_PLANE_SECRETS line"
((${#cp_required[@]})) || fail "found no required(env, '...') settings in $CP_MAIN"
for name in "${cp_required[@]}"; do
  [[ "$name" == VAULT_ADDR ]] && continue
  if printf '%s\n' "${cp_secrets[@]}" | grep -qx "$name"; then
    grep -qE "^LoadCredential=$name:" "$UNIT_CP" || fail "$UNIT_CP does not load the required secret $name"
  else
    grep -qE "^$name=" "$ENV_SRC_DIR/control-plane.env.example" ||
      fail "control-plane.env.example has no $name, which main.ts requires"
  fi
done
for name in "${cp_secrets[@]}"; do
  grep -qE "^$name=" "$ENV_SRC_DIR/control-plane.env.example" &&
    fail "control-plane.env.example sets the secret $name as an env line"
done
pass "every setting main.ts requires is a credential or an env key, and no secret is both"

# The units load exactly the files setup-vm.sh writes (MU1_CREDENTIALS), at the default SH_ENV_DIR:
# a LoadCredential= naming a file nothing creates fails the unit before ExecStart.
for pair in "${MU1_CREDENTIALS[@]}"; do
  grep -qxF "LoadCredential=${pair%%:*}:/etc/serverless-harness/credentials/${pair#*:}" "$UNIT_CP" ||
    fail "$UNIT_CP must LoadCredential=${pair%%:*} from /etc/serverless-harness/credentials/${pair#*:}"
done
[[ "$(grep -c '^LoadCredential=' "$UNIT_CP")" == "${#MU1_CREDENTIALS[@]}" ]] ||
  fail "$UNIT_CP must load exactly the ${#MU1_CREDENTIALS[@]} credentials setup-vm.sh writes, found" \
    "$(grep -c '^LoadCredential=' "$UNIT_CP")"
if [[ "$(grep -c '^LoadCredential=' "$UNIT_SUPERVISOR")" != 1 ]] ||
  ! grep -qxF 'LoadCredential=SH_EXCHANGE_TOKEN:/etc/serverless-harness/credentials/exchange-token' "$UNIT_SUPERVISOR"; then
  fail "$UNIT_SUPERVISOR must load exactly one credential, the exchange token the control plane loads"
fi
grep -qE '^SH_EXCHANGE_TOKEN=' "$ENV_SRC_DIR/supervisor.env.example" &&
  fail "supervisor.env.example sets SH_EXCHANGE_TOKEN: it is a credential now, and both at once refuses to boot"
grep -qE '^SH_REQUIRE_AUTH=true$' "$ENV_SRC_DIR/supervisor.env.example" ||
  fail "supervisor.env.example must require auth: this VM always runs a control plane"
grep -qE '^SH_CONTROL_PLANE_URL=http://127\.0\.0\.1:8090$' "$ENV_SRC_DIR/supervisor.env.example" ||
  fail "supervisor.env.example must dial the control plane on loopback :8090"
pass "credentials: the units load exactly the files setup-vm.sh writes; no secret in any env template"

# --- the supervisor dials the relay's EXEC listener, and the two ports agree (F3, MI1 R5) ---------
# R46 (same as above): both assignments below can abort the pipeline on no-match under
# `set -euo pipefail`, before their `[[ -n ... ]] || fail ...` guards run -- `|| true` on the
# failure-capable stage in each, `grep -q` gating the second.
exec_port=$(grep -oE '^MOCA_RELAY_EXEC_ADDR=.*:[0-9]+$' "$ENV_SRC_DIR/relay.env.example" | grep -oE '[0-9]+$' || true)
if grep -qE '^SH_RELAY_ADDR=.*:[0-9]+$' "$ENV_SRC_DIR/supervisor.env.example"; then
  addr_port=$(grep -oE '^SH_RELAY_ADDR=.*:[0-9]+$' "$ENV_SRC_DIR/supervisor.env.example" | grep -oE '[0-9]+$')
else
  addr_port=""
fi
[[ -n "$exec_port" ]] || fail "relay.env.example is missing MOCA_RELAY_EXEC_ADDR"
[[ -n "$addr_port" ]] || fail "supervisor.env.example's SH_RELAY_ADDR has no port"
[[ "$exec_port" == "$addr_port" ]] ||
  fail "MOCA_RELAY_EXEC_ADDR's port ($exec_port) must equal SH_RELAY_ADDR's ($addr_port): they describe one wire"
grep -qE '^MOCA_RELAY_EXEC_ADDR=127\.0\.0\.1:' "$ENV_SRC_DIR/relay.env.example" ||
  fail "the exec listener must bind loopback, where no sandbox container can reach it"
pass "the supervisor dials the relay's loopback exec listener, on the port it binds"

# --- SANDBOX_IMAGE default is the remote-worker image ------------------------------------------
# Sandboxes here attach to the relay (SH_REMOTE_SANDBOX=1, SH_SANDBOX_DISCOVERY=records), so the
# container must run remote-worker -- the image compose's sandbox service uses. The Kubernetes
# scripts' moca-sandbox image is a pod the harness execs into; it never dials the
# relay, so with it every turn finds no sandbox presence records.
[[ "$SANDBOX_IMAGE" == "ghcr.io/rossoctl/moca-remote-worker:latest" ]] ||
  fail "SANDBOX_IMAGE default is '$SANDBOX_IMAGE', expected" \
    "ghcr.io/rossoctl/moca-remote-worker:latest (the image that attaches to the relay)"
compose_sandbox_image=$(grep -oE 'SH_SANDBOX_IMAGE:-[^}]+' "$VM_DIR/../compose/docker-compose.yml" | head -1)
[[ "${compose_sandbox_image#SH_SANDBOX_IMAGE:-}" == "$SANDBOX_IMAGE" ]] ||
  fail "SANDBOX_IMAGE default ('$SANDBOX_IMAGE') must match compose's sandbox image ('$compose_sandbox_image')"
pass "SANDBOX_IMAGE defaults to the remote-worker image, the one compose runs as a sandbox"

# --- sandbox count is honoured --------------------------------------------------------------
: >"$MOCK_LOG"
start_sandboxes
[[ "$(grep -c 'podman run .*sh-sandbox-' "$MOCK_LOG")" == "3" ]] ||
  fail "expected 3 sandbox containers, got: $(cat "$MOCK_LOG")"
pass "SH_SANDBOX_COUNT honoured"

# --- require_relay_token fails loudly on an unset token, passes once one is set (B5) --------
# relay.env.example ships SH_RELAY_TOKEN commented out (an operator secret, not a default),
# and the relay's validation is fail-closed (makeDefaultValidateToken in
# packages/sandbox-relay/src/main.ts) -- a fresh install would otherwise start sandbox
# containers that can never attach. require_relay_token takes an optional file override so this
# is testable without touching $SH_ENV_DIR/relay.env directly.
TOKENLESS_RELAY_ENV="$TMP/tokenless-relay.env"
cp "$ENV_SRC_DIR/relay.env.example" "$TOKENLESS_RELAY_ENV"
if token_err=$(require_relay_token "$TOKENLESS_RELAY_ENV" 2>&1); then
  fail "require_relay_token should fail when SH_RELAY_TOKEN is commented out"
fi
echo "$token_err" | grep -qi 'SH_RELAY_TOKEN' ||
  fail "require_relay_token's message must name SH_RELAY_TOKEN: $token_err"
pass "require_relay_token fails loudly on an unconfigured token"

TOKENED_RELAY_ENV="$TMP/tokened-relay.env"
cp "$ENV_SRC_DIR/relay.env.example" "$TOKENED_RELAY_ENV"
echo 'SH_RELAY_TOKEN=s3cr3t' >>"$TOKENED_RELAY_ENV"
require_relay_token "$TOKENED_RELAY_ENV" ||
  fail "require_relay_token should pass once SH_RELAY_TOKEN is set"
pass "require_relay_token passes once SH_RELAY_TOKEN is set"

# --- MI1 R5: the exec token is generated once, into BOTH env files, with one value -----------------
EXEC_DIR="$(mktemp -d)"
printf 'SH_RELAY_PORT=9443\nSH_RELAY_TOKEN=keep\n' >"$EXEC_DIR/relay.env"
printf 'PORT=8080\n' >"$EXEC_DIR/supervisor.env"
SH_ENV_DIR="$EXEC_DIR" ensure_exec_token || fail "ensure_exec_token failed"
relay_val="$(grep -E '^MOCA_RELAY_EXEC_TOKEN=' "$EXEC_DIR/relay.env" | cut -d= -f2-)"
sup_val="$(grep -E '^MOCA_RELAY_EXEC_TOKEN=' "$EXEC_DIR/supervisor.env" | cut -d= -f2-)"
[[ "$relay_val" =~ ^[0-9a-f]{64}$ ]] || fail "relay.env has no generated MOCA_RELAY_EXEC_TOKEN"
[[ "$sup_val" == "$relay_val" ]] || fail "supervisor.env's exec token differs from relay.env's"
SH_ENV_DIR="$EXEC_DIR" ensure_exec_token || fail "second ensure_exec_token failed"
[[ "$(grep -c '^MOCA_RELAY_EXEC_TOKEN=' "$EXEC_DIR/relay.env")" == 1 ]] || fail "re-run duplicated the token"
[[ "$(grep -E '^MOCA_RELAY_EXEC_TOKEN=' "$EXEC_DIR/relay.env" | cut -d= -f2-)" == "$relay_val" ]] ||
  fail "re-run replaced the token"
grep -q '^SH_RELAY_TOKEN=keep$' "$EXEC_DIR/relay.env" || fail "ensure_exec_token touched SH_RELAY_TOKEN"
pass "MOCA_RELAY_EXEC_TOKEN: generated once, same value in relay.env and supervisor.env"
rm -rf "$EXEC_DIR"

# An operator-edited relay.env whose last line has no newline: the append must not glue onto it.
EXEC_DIR="$(mktemp -d)"
printf 'SH_RELAY_PORT=9443\nSH_RELAY_TOKEN=keep' >"$EXEC_DIR/relay.env"
printf 'PORT=8080\n' >"$EXEC_DIR/supervisor.env"
SH_ENV_DIR="$EXEC_DIR" ensure_exec_token || fail "ensure_exec_token failed on a file with no final newline"
grep -q '^SH_RELAY_TOKEN=keep$' "$EXEC_DIR/relay.env" ||
  fail "appending to a relay.env with no final newline changed SH_RELAY_TOKEN: $(cat "$EXEC_DIR/relay.env")"
grep -qE '^MOCA_RELAY_EXEC_TOKEN=[0-9a-f]{64}$' "$EXEC_DIR/relay.env" ||
  fail "the exec token was not appended as its own line: $(cat "$EXEC_DIR/relay.env")"
pass "ensure_exec_token appends on its own line to a relay.env with no final newline"
rm -rf "$EXEC_DIR"

# --- MI1 R5: the exec listener and the supervisor's dial address move together ------------------
# Before MI1 the relay served everything on one listener and the supervisor dialed it at
# SH_RELAY_ADDR=127.0.0.1:9443. install_env never rewrites an existing env file, so a re-run on such
# a VM must migrate BOTH files together (relay: MOCA_RELAY_EXEC_ADDR, supervisor: SH_RELAY_ADDR);
# files that already agree are left alone; and any other combination -- one side migrated, or ports
# that disagree -- refuses, naming both values, rather than leaving the supervisor dialing a port
# nothing serves SandboxExec on.
LST_DIR="$(mktemp -d)"
sum_files() { cat "$LST_DIR/relay.env" "$LST_DIR/supervisor.env" | cksum; }
listener_env() { # <relay extra lines> <supervisor SH_RELAY_ADDR line or empty>
  printf 'SH_RELAY_PORT=9443\nREDIS_URL=redis://127.0.0.1:6379\nSH_RELAY_TOKEN=keep\n%s' "$1" >"$LST_DIR/relay.env"
  printf 'PORT=8080\nSH_TURNS_PER_WORKER=9\n%s\nREDIS_URL=redis://127.0.0.1:6379\n' "$2" >"$LST_DIR/supervisor.env"
  chmod 0640 "$LST_DIR/relay.env" "$LST_DIR/supervisor.env"
}
exec_addr_of() { grep -E '^MOCA_RELAY_EXEC_ADDR=' "$LST_DIR/relay.env" | cut -d= -f2-; }
dial_addr_of() { grep -E '^SH_RELAY_ADDR=' "$LST_DIR/supervisor.env" | cut -d= -f2-; }

# fresh: both files straight from the templates already agree -- a no-op
cp "$ENV_SRC_DIR/relay.env.example" "$LST_DIR/relay.env"
cp "$ENV_SRC_DIR/supervisor.env.example" "$LST_DIR/supervisor.env"
before="$(sum_files)"
SH_ENV_DIR="$LST_DIR" ensure_exec_listener || fail "ensure_exec_listener refused a fresh install's env files"
[[ "$(sum_files)" == "$before" ]] || fail "ensure_exec_listener rewrote a fresh install's env files"
pass "ensure_exec_listener: a fresh install is already consistent and left untouched"

# pre-MI1: no exec address, supervisor on the old default -- both migrate, nothing else changes
listener_env "" "SH_RELAY_ADDR=127.0.0.1:9443"
SH_ENV_DIR="$LST_DIR" ensure_exec_listener || fail "ensure_exec_listener failed to migrate a pre-MI1 pair"
[[ "$(exec_addr_of)" == "127.0.0.1:9444" ]] || fail "relay.env did not gain MOCA_RELAY_EXEC_ADDR=127.0.0.1:9444: $(cat "$LST_DIR/relay.env")"
[[ "$(dial_addr_of)" == "127.0.0.1:9444" ]] || fail "supervisor.env's SH_RELAY_ADDR was not moved to 127.0.0.1:9444: $(cat "$LST_DIR/supervisor.env")"
[[ "$(grep -c '^SH_RELAY_ADDR=' "$LST_DIR/supervisor.env")" == 1 ]] || fail "the migration duplicated SH_RELAY_ADDR"
grep -q '^SH_TURNS_PER_WORKER=9$' "$LST_DIR/supervisor.env" || fail "the migration lost an operator setting in supervisor.env"
grep -q '^SH_RELAY_TOKEN=keep$' "$LST_DIR/relay.env" || fail "the migration touched SH_RELAY_TOKEN"
[[ "$(stat -c %a "$LST_DIR/supervisor.env" 2>/dev/null || stat -f %Lp "$LST_DIR/supervisor.env")" == 640 ]] ||
  fail "the migration changed supervisor.env's mode"
pass "ensure_exec_listener: a pre-MI1 pair migrates both files together, and nothing else"

# already migrated: a second run is a byte-identical no-op
before="$(sum_files)"
SH_ENV_DIR="$LST_DIR" ensure_exec_listener || fail "ensure_exec_listener refused an already-migrated pair"
[[ "$(sum_files)" == "$before" ]] || fail "ensure_exec_listener rewrote an already-migrated pair"
pass "ensure_exec_listener: an already-migrated pair is left untouched"

# mismatches: each refuses, names both values, and writes nothing
for case_ in "MOCA_RELAY_EXEC_ADDR=127.0.0.1:9444|SH_RELAY_ADDR=127.0.0.1:9443|127.0.0.1:9444|127.0.0.1:9443" \
  "|SH_RELAY_ADDR=127.0.0.1:9444|<unset>|127.0.0.1:9444" \
  "MOCA_RELAY_EXEC_ADDR=127.0.0.1:9444|SH_RELAY_ADDR=127.0.0.1:9555|127.0.0.1:9444|127.0.0.1:9555" \
  "|SH_RELAY_ADDR=10.0.0.5:9443|<unset>|10.0.0.5:9443"; do
  IFS='|' read -r relay_line sup_line want_relay want_sup <<<"$case_"
  listener_env "${relay_line:+$relay_line
}" "$sup_line"
  before="$(sum_files)"
  if mm_err=$(SH_ENV_DIR="$LST_DIR" ensure_exec_listener 2>&1); then
    fail "ensure_exec_listener accepted relay '${relay_line:-<no exec addr>}' with supervisor '$sup_line'"
  fi
  echo "$mm_err" | grep -qF "MOCA_RELAY_EXEC_ADDR=$want_relay" ||
    fail "the refusal must name the relay's MOCA_RELAY_EXEC_ADDR ($want_relay): $mm_err"
  echo "$mm_err" | grep -qF "SH_RELAY_ADDR=$want_sup" ||
    fail "the refusal must name the supervisor's SH_RELAY_ADDR ($want_sup): $mm_err"
  [[ "$(sum_files)" == "$before" ]] || fail "a refused combination was still written to"
done
pass "ensure_exec_listener: a half-migrated or disagreeing pair refuses, naming both values"
rm -rf "$LST_DIR"

# --- #366: the MU1 secrets are generated once, as root-only credential files, never rotated -------
mu1_dir() { # a fresh SH_ENV_DIR with the three templates installed, as install_env leaves it
  local d
  d="$(mktemp -d)"
  cp "$ENV_SRC_DIR/supervisor.env.example" "$d/supervisor.env"
  cp "$ENV_SRC_DIR/control-plane.env.example" "$d/control-plane.env"
  cp "$ENV_SRC_DIR/relay.env.example" "$d/relay.env"
  printf '%s' "$d"
}
cred() { cat "$1/credentials/$2"; }
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; } # GNU, then BSD (macOS)

M="$(mu1_dir)"
: >"$GEN_COUNT"
SH_ENV_DIR="$M" ensure_mu1_secrets || fail "ensure_mu1_secrets failed on a fresh install"
[[ "$(gen_calls)" == 1 ]] || fail "a fresh install must run the generator exactly once, ran $(gen_calls)"
[[ "$(mode_of "$M/credentials")" == 700 ]] || fail "credentials dir is $(mode_of "$M/credentials"), want 700"
for pair in "${MU1_CREDENTIALS[@]}"; do
  f="$M/credentials/${pair#*:}"
  [[ -s "$f" ]] || fail "ensure_mu1_secrets did not write ${pair%%:*} to $f"
  [[ "$(mode_of "$f")" == 600 ]] || fail "$f is mode $(mode_of "$f"), want 600"
done
[[ "$(cred "$M" session-token-private-key)" == PRIV1AAAA ]] || fail "private key is not the generator's"
[[ "$(cred "$M" credential-kek)" == "K$(printf '%042d' 1)=" ]] || fail "KEK is not the generator's"
[[ "$(cred "$M" exchange-token)" == "$(printf '%064x' 1)" ]] || fail "exchange token is not the generator's"
# The public half lands in supervisor.env, from the SAME generator run as the private half.
[[ "$(env_file_value SH_SESSION_TOKEN_PUBLIC_KEYS "$M/supervisor.env")" == "$(printf '%016x' 1):PUB1BBBB" ]] ||
  fail "supervisor.env's public keyset is not the private key's pair: $(grep PUBLIC_KEYS "$M/supervisor.env")"
[[ "$(grep -c '^SH_SESSION_TOKEN_PUBLIC_KEYS=' "$M/supervisor.env")" == 1 ]] ||
  fail "the public keyset must replace the template's commented line, not be added beside it"
grep -q '^#SH_SESSION_TOKEN_PUBLIC_KEYS=' "$M/supervisor.env" &&
  fail "the template's commented #SH_SESSION_TOKEN_PUBLIC_KEYS= line was left behind"
[[ "$MU1_NEW_KEYPAIR" == 1 ]] || fail "MU1_NEW_KEYPAIR must be 1 on the run that generates the keypair"
# No secret in any env file. (No argv claim here: nothing ensure_mu1_secrets runs is mocked, so
# MOCK_LOG could not record one. The values pass only through builtins and awk's environment.)
for pair in "${MU1_CREDENTIALS[@]}"; do
  v="$(cred "$M" "${pair#*:}")"
  grep -rqF -- "$v" "$M"/*.env && fail "${pair%%:*}'s value appears in an env file"
done
pass "MU1 secrets: generated once into 0600 files under a 0700 dir; public half in supervisor.env"

before="$(cat "$M"/credentials/* "$M/supervisor.env" | cksum)"
SH_ENV_DIR="$M" ensure_mu1_secrets || fail "re-run failed"
[[ "$(gen_calls)" == 1 ]] || fail "a re-run with every secret present must not run the generator"
[[ "$(cat "$M"/credentials/* "$M/supervisor.env" | cksum)" == "$before" ]] || fail "a re-run rotated a secret"
[[ -z "$MU1_NEW_KEYPAIR" ]] || fail "MU1_NEW_KEYPAIR must be empty on a run that generated no keypair"
pass "MU1 secrets: a re-run never rotates one, and never runs the generator"

# One missing secret is generated alone; the others, the keypair included, are never touched.
priv_before="$(cred "$M" session-token-private-key)"
kek_before="$(cred "$M" credential-kek)"
pub_before="$(env_file_value SH_SESSION_TOKEN_PUBLIC_KEYS "$M/supervisor.env")"
rm "$M/credentials/exchange-token"
SH_ENV_DIR="$M" ensure_mu1_secrets || fail "regenerating a lone missing secret failed"
[[ "$(cred "$M" exchange-token)" == "$(printf '%064x' 2)" ]] || fail "the missing exchange token was not regenerated"
[[ "$(cred "$M" session-token-private-key)" == "$priv_before" ]] || fail "regenerating the exchange token replaced the private key"
[[ "$(cred "$M" credential-kek)" == "$kek_before" ]] || fail "regenerating the exchange token replaced the KEK"
[[ "$(env_file_value SH_SESSION_TOKEN_PUBLIC_KEYS "$M/supervisor.env")" == "$pub_before" ]] ||
  fail "regenerating the exchange token replaced the public keyset"
[[ -z "$MU1_NEW_KEYPAIR" ]] || fail "MU1_NEW_KEYPAIR set on a run that kept the keypair"
pass "MU1 secrets: a lone missing secret is generated alone"
rm -rf "$M"

# Refusals: each names what it found, and writes nothing.
refuses() { # <description> <expected message regex> -- runs ensure_mu1_secrets on $M, expects failure
  local out sum_before
  sum_before="$(find "$M" -type f -exec cat {} + 2>/dev/null | cksum)"
  if out="$(SH_ENV_DIR="$M" ensure_mu1_secrets 2>&1)"; then fail "$1: ensure_mu1_secrets succeeded"; fi
  grep -qE -- "$2" <<<"$out" || fail "$1: message does not match /$2/: $out"
  [[ "$(find "$M" -type f -exec cat {} + 2>/dev/null | cksum)" == "$sum_before" ]] || fail "$1: it wrote something"
}
M="$(mu1_dir)"
echo 'SH_EXCHANGE_TOKEN=hand-set' >>"$M/supervisor.env"
refuses "a hand-set SH_EXCHANGE_TOKEN in supervisor.env" "$M/supervisor.env sets SH_EXCHANGE_TOKEN"
rm -rf "$M"; M="$(mu1_dir)"
echo 'SH_CREDENTIAL_KEK=hand-set' >>"$M/control-plane.env"
refuses "a KEK as a control-plane.env line" "$M/control-plane.env sets SH_CREDENTIAL_KEK"
rm -rf "$M"; M="$(mu1_dir)"
echo 'SH_SESSION_TOKEN_PUBLIC_KEYS=0123456789abcdef:ELSEWHERE' >>"$M/supervisor.env"
refuses "a public keyset with no private key (a control plane elsewhere)" \
  "session-token-private-key.*SH_SESSION_TOKEN_PUBLIC_KEYS|SH_SESSION_TOKEN_PUBLIC_KEYS.*session-token-private-key"
rm -rf "$M"; M="$(mu1_dir)"
install -d -m 0700 "$M/credentials"; printf 'PRIVX\n' >"$M/credentials/session-token-private-key"
refuses "a private key with no public keyset" "session-token-private-key.*SH_SESSION_TOKEN_PUBLIC_KEYS"
rm -rf "$M"; M="$(mu1_dir)"
install -d -m 0700 "$M/credentials"; : >"$M/credentials/credential-kek"
refuses "an empty KEK file" "credential-kek is empty"
rm -rf "$M"; M="$(mu1_dir)"
generate_mu1_saved="$(declare -f generate_mu1)"
# shellcheck disable=SC2329  # invoked indirectly, by ensure_mu1_secrets
generate_mu1() { printf 'SH_SESSION_TOKEN_PRIVATE_KEY=PRIV\nSH_SESSION_TOKEN_PUBLIC_KEYS=trunc\n'; }
refuses "a garbled generator" "no usable SH_SESSION_TOKEN_PUBLIC_KEYS"
# Garbled in its LAST value only: the three before it are valid, so a check that ran after the first
# write would already have written them. Every value is checked before anything is written.
# shellcheck disable=SC2329  # invoked indirectly, by ensure_mu1_secrets
generate_mu1() {
  printf 'SH_SESSION_TOKEN_PRIVATE_KEY=PRIVAAAA\nSH_SESSION_TOKEN_PUBLIC_KEYS=0123456789abcdef:PUBBBBB\n'
  printf 'SH_CREDENTIAL_KEK=K%042d=\nSH_EXCHANGE_TOKEN=zz\n' 7
}
sup_before="$(cksum <"$M/supervisor.env")"
refuses "a generator garbled only in SH_EXCHANGE_TOKEN" "no usable SH_EXCHANGE_TOKEN"
for f in session-token-private-key credential-kek exchange-token; do
  [[ ! -e "$M/credentials/$f" ]] || fail "a generator garbled only in SH_EXCHANGE_TOKEN still wrote $f"
done
[[ "$(cksum <"$M/supervisor.env")" == "$sup_before" ]] ||
  fail "a generator garbled only in SH_EXCHANGE_TOKEN still changed supervisor.env"
generate_mu1() { return 3; }
refuses "a generator that fails" "could not run the key generator"
eval "$generate_mu1_saved"
rm -rf "$M"
pass "MU1 secrets: env-line secrets, a half keypair, an empty file and a bad generator all refuse, writing nothing"

# A write that fails partway (ENOSPC on /etc, say) fails ensure_mu1_secrets and leaves no secret file,
# empty or not, and no temp file behind -- even with errexit suspended, as it is under `|| rc=$?` here
# and under the `[[ -z ... ]] || write_secret` forms inside. printf is a builtin, so it is stubbed as a
# function that fails only when write_secret calls it (mu1_value's own printf calls still work).
write_fails() { # <description> <stub>: ensure_mu1_secrets on a fresh $M, with <stub> (a function) in place
  local rc=0 sup_before f
  M="$(mu1_dir)"
  sup_before="$(cksum <"$M/supervisor.env")"
  eval "$2" # after mu1_dir, which needs the real mktemp
  SH_ENV_DIR="$M" ensure_mu1_secrets 2>/dev/null || rc=$?
  unset -f mktemp mv printf
  ((rc != 0)) || fail "$1: ensure_mu1_secrets returned 0"
  for f in session-token-private-key credential-kek exchange-token; do
    [[ ! -e "$M/credentials/$f" ]] || fail "$1: $f exists anyway ($(wc -c <"$M/credentials/$f") bytes)"
  done
  [[ -z "$(find "$M/credentials" -name '.tmp.*' 2>/dev/null)" ]] || fail "$1: a temp file was left behind"
  [[ "$(cksum <"$M/supervisor.env")" == "$sup_before" ]] || fail "$1: supervisor.env changed anyway"
  rm -rf "$M"
}
# shellcheck disable=SC2016  # expanded by the stub itself, not here
write_fails "a failing write of the secret's value" \
  'printf() { [[ "${FUNCNAME[1]}" != write_secret ]] || return 1; builtin printf "$@"; }'
write_fails "a failing mktemp" 'mktemp() { return 1; }'
write_fails "a failing rename" 'mv() { return 1; }'
pass "MU1 secrets: a failing mktemp, write or rename fails whole, leaving no secret and no temp file"

# A lost KEK over a credential store that already holds records: a new KEK would make every one of them
# undecryptable, so it is refused -- before anything is written, the credentials dir included.
M="$(mu1_dir)"
STORE="$(mktemp -d)"
set_env_line "$M/control-plane.env" SH_CREDENTIAL_DIR "$STORE"
printf 'ciphertext\n' >"$STORE/github:1.json"
refuses "a missing KEK over a store with records" "credential-kek.*$STORE"
[[ ! -e "$M/credentials" ]] || fail "the lost-KEK refusal created $M/credentials"
out="$(SH_ENV_DIR="$M" ensure_mu1_secrets 2>&1)" && fail "the lost-KEK refusal succeeded on a second try"
grep -qi 'restore' <<<"$out" || fail "the lost-KEK refusal must say to restore the KEK: $out"
grep -qi 'empty' <<<"$out" || fail "the lost-KEK refusal must name emptying the store as the other way out: $out"
rm "$STORE/github:1.json"
SH_ENV_DIR="$M" ensure_mu1_secrets >/dev/null || fail "ensure_mu1_secrets refused a missing KEK over an EMPTY store"
[[ -s "$M/credentials/credential-kek" ]] || fail "an empty store did not get a generated KEK"
# The KEK present, the store full, another secret missing: nothing to refuse.
printf 'ciphertext\n' >"$STORE/github:1.json"
rm "$M/credentials/exchange-token"
SH_ENV_DIR="$M" ensure_mu1_secrets >/dev/null || fail "a full store refused a missing exchange token (the KEK is present)"
[[ -s "$M/credentials/exchange-token" ]] || fail "the missing exchange token was not generated beside a full store"
rm -rf "$M" "$STORE"
pass "MU1 secrets: a lost KEK over a store with records refuses, naming both ways out; an empty store generates"

# The REAL generator's two halves agree: the kid in the public keyset is the private key's own. Needs
# tsx, so it runs only where the workspace is built (a dev box), and says so where it is not (CI).
REAL_ROOT="$VM_DIR/../.."
if [[ -x "$REAL_ROOT/packages/control-plane/node_modules/.bin/tsx" ]]; then
  M="$(mu1_dir)"
  eval "$(declare -f real_generate_mu1 | sed '1s/^real_generate_mu1/generate_mu1/')"
  SH_REPO_ROOT="$REAL_ROOT" SH_ENV_DIR="$M" ensure_mu1_secrets || fail "the real generator failed"
  kid="$(cd "$REAL_ROOT/packages/control-plane" && node --import tsx --input-type=module -e \
    "import { readFileSync } from 'node:fs'; import { makeSigner } from './src/token.ts';
     process.stdout.write(makeSigner(readFileSync(process.argv[1], 'utf8').trim()).kid);" \
    "$M/credentials/session-token-private-key")"
  pub="$(env_file_value SH_SESSION_TOKEN_PUBLIC_KEYS "$M/supervisor.env")"
  [[ -n "$kid" && "${pub%%:*}" == "$kid" ]] || fail "public keyset kid '${pub%%:*}' is not the private key's '$kid'"
  eval "$generate_mu1_saved"
  rm -rf "$M"
  pass "MU1 secrets: the real generator's public keyset carries the private key's own kid"
else
  echo "skip - real genkeys.ts kid check (workspace not built: no packages/control-plane tsx)"
fi

S="$(mktemp)"
printf 'A=1\n#K=\nB=2' >"$S" # commented K, no final newline
set_env_line "$S" K v1
[[ "$(cat "$S")" == $'A=1\nK=v1\nB=2' ]] || fail "set_env_line must replace #K= in place: $(cat "$S")"
printf 'K=old\n#K=\nK=older' >"$S"
set_env_line "$S" K v2
[[ "$(grep -c '^K=' "$S")" == 1 && "$(env_file_value K "$S")" == v2 ]] ||
  fail "set_env_line must leave exactly one K=, the new value: $(cat "$S")"
printf 'A=1' >"$S"
set_env_line "$S" K v3
[[ "$(cat "$S")" == $'A=1\nK=v3' ]] || fail "set_env_line must append on its own line: $(cat "$S")"
chmod 0640 "$S"; set_env_line "$S" K v4
[[ "$(mode_of "$S")" == 640 ]] || fail "set_env_line changed the file's mode"
# A failing awk or mktemp must fail set_env_line and leave the file whole -- even with errexit
# suspended, as it is under every `set_env_line ... || return 1` caller.
sum_before="$(cksum <"$S")"
# shellcheck disable=SC2329  # invoked indirectly, by set_env_line
awk() { return 2; }
rc=0; set_env_line "$S" K v5 || rc=$?
unset -f awk
((rc != 0)) || fail "set_env_line returned 0 when awk failed"
[[ "$(cksum <"$S")" == "$sum_before" ]] || fail "set_env_line changed the file when awk failed: $(cat "$S")"
# shellcheck disable=SC2329  # invoked indirectly, by set_env_line
mktemp() { return 1; }
rc=0; set_env_line "$S" K v6 || rc=$?
unset -f mktemp
((rc != 0)) || fail "set_env_line returned 0 when mktemp failed"
[[ "$(cksum <"$S")" == "$sum_before" ]] || fail "set_env_line changed the file when mktemp failed: $(cat "$S")"
rm -f "$S"
pass "set_env_line: replaces in place, collapses duplicates, appends on its own line, keeps the mode, fails whole"

# --- #366: supervisor.env is wired to this VM's control plane, once --------------------------------
FIXTURE="$VM_DIR/tests/fixtures/supervisor.env.pre-cp"
{ grep -qE '^SH_REQUIRE_AUTH=false$' "$FIXTURE" && grep -qE '^#SH_CONTROL_PLANE_URL=' "$FIXTURE"; } ||
  fail "the pre-control-plane fixture is not today's template (see Task 4 Step 1)"

# An existing VM: supervisor.env from the pre-control-plane template, with an operator edit and NO
# final newline; relay.env configured; no control-plane.env and no credentials yet.
U="$(mktemp -d)"
printf '%s' "$(cat "$FIXTURE"; echo 'SH_TURNS_PER_WORKER=9')" >"$U/supervisor.env" # $(…) drops the final newline
cp "$ENV_SRC_DIR/relay.env.example" "$U/relay.env"
SH_ENV_DIR="$U" install_env >/dev/null
[[ -f "$U/control-plane.env" ]] || fail "an upgrade must install control-plane.env"
SH_ENV_DIR="$U" ensure_mu1_secrets >/dev/null || fail "ensure_mu1_secrets failed on an upgrade"
SH_ENV_DIR="$U" wire_supervisor_mu1 >/dev/null || fail "wire_supervisor_mu1 failed on an upgrade"
for kv in 'SH_CONTROL_PLANE_URL=http://127.0.0.1:8090' 'SH_REQUIRE_AUTH=true' 'SH_TURNS_PER_WORKER=9'; do
  [[ "$(grep -cxF "$kv" "$U/supervisor.env")" == 1 ]] || fail "upgraded supervisor.env lacks exactly one $kv: $(cat "$U/supervisor.env")"
done
for k in SH_CONTROL_PLANE_URL SH_REQUIRE_AUTH SH_SESSION_TOKEN_PUBLIC_KEYS; do
  [[ "$(grep -c "^$k=" "$U/supervisor.env")" == 1 ]] || fail "upgraded supervisor.env has more than one $k="
done
grep -qE '^SH_EXCHANGE_TOKEN=' "$U/supervisor.env" && fail "the upgrade put the exchange token in supervisor.env"
pass "upgrade: supervisor.env gains the control plane's URL, its public keyset and SH_REQUIRE_AUTH=true"

before="$(cat "$U/supervisor.env" "$U"/credentials/* | cksum)"
SH_ENV_DIR="$U" ensure_mu1_secrets >/dev/null || fail "ensure_mu1_secrets failed on a re-run after the upgrade"
SH_ENV_DIR="$U" wire_supervisor_mu1 >/dev/null || fail "wire_supervisor_mu1 failed on a re-run after the upgrade"
[[ "$(cat "$U/supervisor.env" "$U"/credentials/* | cksum)" == "$before" ]] || fail "a re-run after the upgrade changed something"
set_env_line "$U/supervisor.env" SH_REQUIRE_AUTH false # the operator opts out
SH_ENV_DIR="$U" ensure_mu1_secrets >/dev/null || fail "ensure_mu1_secrets failed after the operator's opt-out"
SH_ENV_DIR="$U" wire_supervisor_mu1 >/dev/null || fail "wire_supervisor_mu1 failed after the operator's opt-out"
grep -qxF 'SH_REQUIRE_AUTH=false' "$U/supervisor.env" || fail "a re-run overrode the operator's SH_REQUIRE_AUTH=false"
sed -i.bak '/^SH_CONTROL_PLANE_URL=/d' "$U/supervisor.env" || fail "could not delete SH_CONTROL_PLANE_URL"
rm -f "$U/supervisor.env.bak"
SH_ENV_DIR="$U" wire_supervisor_mu1 >/dev/null || fail "wire_supervisor_mu1 failed with no SH_CONTROL_PLANE_URL"
grep -qxF 'SH_CONTROL_PLANE_URL=http://127.0.0.1:8090' "$U/supervisor.env" || fail "a missing SH_CONTROL_PLANE_URL was not restored"
pass "re-runs: nothing rotated or rewritten; an operator's SH_REQUIRE_AUTH=false is kept"
rm -rf "$U"

# The URL follows the port the control plane actually binds; a port it would not bind is refused.
U="$(mu1_dir)"
set_env_line "$U/control-plane.env" SH_CONTROL_PLANE_PORT 8091
SH_ENV_DIR="$U" ensure_mu1_secrets >/dev/null || fail "ensure_mu1_secrets failed on a fresh install on :8091"
SH_ENV_DIR="$U" wire_supervisor_mu1 >/dev/null || fail "wire_supervisor_mu1 failed on a fresh install on :8091"
grep -qxF 'SH_CONTROL_PLANE_URL=http://127.0.0.1:8091' "$U/supervisor.env" || fail "SH_CONTROL_PLANE_URL did not follow SH_CONTROL_PLANE_PORT"
for bad in '' 'abc'; do
  set_env_line "$U/control-plane.env" SH_CONTROL_PLANE_PORT "$bad"
  out="$(MU1_NEW_KEYPAIR=1 SH_ENV_DIR="$U" wire_supervisor_mu1 2>&1)" && fail "SH_CONTROL_PLANE_PORT='$bad' was accepted"
  grep -q 'SH_CONTROL_PLANE_PORT' <<<"$out" || fail "the refusal does not name SH_CONTROL_PLANE_PORT: $out"
done
rm -rf "$U"
pass "SH_CONTROL_PLANE_URL follows SH_CONTROL_PLANE_PORT; an empty or non-numeric port is refused"

# --- relay_token strips one matched pair of surrounding quotes (systemd's EnvironmentFile=
# semantics) ----------------------------------------------------------------------------------
# An operator writing SH_RELAY_TOKEN="s3cr3t" in relay.env gets s3cr3t handed to the relay
# process by systemd, not "s3cr3t" (systemd.exec(5), "Environment Variables in Spawned
# Processes") -- relay_token must return the same value systemd actually hands the relay, or
# start_sandboxes would pass every container a SANDBOX_TOKEN that never matches while
# require_relay_token's non-empty check still passes happily: the exact silently-empty
# sh:sandbox:records outcome B5 exists to prevent, reachable through an ordinary quoting habit.
QUOTED_RELAY_ENV="$TMP/quoted-relay.env"
cp "$ENV_SRC_DIR/relay.env.example" "$QUOTED_RELAY_ENV"
echo 'SH_RELAY_TOKEN="s3cr3t"' >>"$QUOTED_RELAY_ENV"
[[ "$(relay_token "$QUOTED_RELAY_ENV")" == "s3cr3t" ]] ||
  fail "relay_token must strip a matched pair of surrounding quotes (systemd.exec(5)" \
    "EnvironmentFile= semantics), got: [$(relay_token "$QUOTED_RELAY_ENV")]"
pass "relay_token strips a matched pair of surrounding quotes"

# --- start_sandboxes passes each container its own SANDBOX_ID, a host-reaching RELAY_ADDR, and
# the relay token, and pins host.containers.internal explicitly (B5) ------------------------
# The real bug: a bare `podman run` with no -e flags leaves every container at
# remote-worker/cmd/worker/main.go's defaults (SANDBOX_ID=sbx-laptop-1, RELAY_ADDR=
# localhost:8443, SANDBOX_TOKEN=dev-token) -- every container collides on one Redis record,
# "localhost" resolves to the container itself rather than the host, and the token never
# matches a fail-closed relay. --add-host pins host.containers.internal explicitly rather
# than relying on netavark's automatic (rootless-default, version-dependent) population of
# /etc/hosts -- see podman-run(1)'s host-gateway special string.
: >"$MOCK_LOG"
cp "$TOKENED_RELAY_ENV" "$SH_ENV_DIR/relay.env"
start_sandboxes
grep -q -- '-e SANDBOX_ID=sh-sandbox-0' "$MOCK_LOG" ||
  fail "start_sandboxes must set a per-container SANDBOX_ID: $(cat "$MOCK_LOG")"
grep -q -- '-e SANDBOX_ID=sh-sandbox-1' "$MOCK_LOG" ||
  fail "start_sandboxes must set a distinct SANDBOX_ID per container (the real collision bug," \
    "B5): $(cat "$MOCK_LOG")"
grep -q -- '-e RELAY_ADDR=host.containers.internal:9443' "$MOCK_LOG" ||
  fail "start_sandboxes must set RELAY_ADDR to the host's relay port, taken from" \
    "SH_RELAY_PORT in relay.env: $(cat "$MOCK_LOG")"
# The token must reach the container WITHOUT appearing in argv. `-e SANDBOX_TOKEN` (no `=`) tells
# podman to take the value from its own environment; `-e SANDBOX_TOKEN=<value>` would put the secret
# in this process's command line, and /proc/<pid>/cmdline is world-readable on Linux unless hidepid
# is set. Three assertions, because any two of them alone would pass a broken implementation:
# by-name present, value absent from argv, value actually delivered.
grep -q -- '-e SANDBOX_TOKEN$\|-e SANDBOX_TOKEN ' "$MOCK_LOG" ||
  fail "start_sandboxes must pass SANDBOX_TOKEN by NAME (-e SANDBOX_TOKEN, no '='), so the secret" \
    "never enters argv: $(cat "$MOCK_LOG")"
grep -q -- 'SANDBOX_TOKEN=s3cr3t' "$MOCK_LOG" &&
  fail "the relay token appears in podman's argv, where /proc/<pid>/cmdline exposes it to any local" \
    "user: $(cat "$MOCK_LOG")"
grep -q -- 'podman-env SANDBOX_TOKEN=s3cr3t' "$MOCK_ENV_LOG" ||
  fail "the container does not actually receive SANDBOX_TOKEN: passing by name only works if the" \
    "value is in podman's own environment: $(cat "$MOCK_ENV_LOG")"
grep -q -- '--network moca-sandbox' "$MOCK_LOG" ||
  fail "sandboxes must run on the dedicated moca-sandbox network: $(cat "$MOCK_LOG")"
grep -q -- '--add-host host.containers.internal:10.89.40.1' "$MOCK_LOG" ||
  fail "host.containers.internal must point at the moca-sandbox gateway: $(cat "$MOCK_LOG")"
grep -q -- 'host-gateway' "$MOCK_LOG" &&
  fail "sandboxes must reach the host only through the moca-sandbox gateway, where the firewall" \
    "admits the relay's attach port and DNS alone -- not through host-gateway (MI1 R8): $(cat "$MOCK_LOG")"
pass "start_sandboxes: dedicated network, gateway-pinned host alias, no host-gateway"

# --- MI1 R8: the sandbox network and the firewall that confines it --------------------------------
: >"$MOCK_LOG"
ensure_sandbox_network ||
  fail "ensure_sandbox_network must pass when the live network matches the configured subnet/gateway"
grep -q -- 'podman network create --ignore --subnet 10.89.40.0/24 --gateway 10.89.40.1 --opt isolate=strict --interface-name moca-sandbox0 moca-sandbox' "$MOCK_LOG" ||
  fail "ensure_sandbox_network must create moca-sandbox idempotently with the fixed subnet," \
    "isolated from every other podman network: $(cat "$MOCK_LOG")"
grep -q -- 'podman network inspect moca-sandbox --format {{index .Options "isolate"}}' "$MOCK_LOG" ||
  fail "ensure_sandbox_network must read back the live isolate option: $(cat "$MOCK_LOG")"
grep -q -- 'podman network inspect moca-sandbox --format {{.NetworkInterface}}' "$MOCK_LOG" ||
  fail "ensure_sandbox_network must read back the live bridge interface name: $(cat "$MOCK_LOG")"
pass "ensure_sandbox_network creates the fixed-subnet, strictly isolated network and passes when it already matches"

# --- ensure_sandbox_network fails closed on a network that is not strictly isolated (MI1 R8) -----
# --ignore keeps a pre-existing moca-sandbox whatever its options, so a network created without
# isolate=strict (or by a netavark that does not record it) would put sandboxes on a bridge that
# reaches other podman networks -- Redis's among them. Unset and a weaker value both refuse.
for isolate in "" "<no value>" "true"; do
  export MOCK_PODMAN_ISOLATE="$isolate"
  if isolate_err=$(ensure_sandbox_network 2>&1); then
    fail "ensure_sandbox_network must fail when the live network's isolate option is '$isolate'"
  fi
  echo "$isolate_err" | grep -qF "strict" ||
    fail "the isolation message must name the expected value (strict): $isolate_err"
  echo "$isolate_err" | grep -qF "isolate=" ||
    fail "the isolation message must name the option and its actual value: $isolate_err"
done
unset MOCK_PODMAN_ISOLATE
pass "ensure_sandbox_network fails closed, naming expected and actual, on a network without isolate=strict"

# --- ensure_sandbox_network fails closed on a subnet/gateway mismatch ---------------------------
# podman network create --ignore keeps a pre-existing moca-sandbox network regardless of its
# actual subnet/gateway, and the firewall's rules are written against
# MOCA_SANDBOX_SUBNET/MOCA_SANDBOX_GATEWAY specifically -- a live network on different values
# would leave real sandbox traffic unmatched by any of those rules. MOCK_PODMAN_INSPECT controls
# what `podman network inspect` reports for this test; its default (unset, in effect for the
# passing case just above and every other ensure_sandbox_network call in this file) matches the
# configured subnet/gateway.
export MOCK_PODMAN_INSPECT="10.89.41.0/24 10.89.41.1"
if mismatch_err=$(ensure_sandbox_network 2>&1); then
  fail "ensure_sandbox_network must fail when the live network's subnet/gateway differ from" \
    "MOCA_SANDBOX_SUBNET/MOCA_SANDBOX_GATEWAY"
fi
echo "$mismatch_err" | grep -qF "10.89.40.0/24 10.89.40.1" ||
  fail "the mismatch message must name the expected subnet/gateway: $mismatch_err"
echo "$mismatch_err" | grep -qF "10.89.41.0/24 10.89.41.1" ||
  fail "the mismatch message must name the actual subnet/gateway: $mismatch_err"
unset MOCK_PODMAN_INSPECT
pass "ensure_sandbox_network fails closed and names both values on a subnet/gateway mismatch"

# --- ensure_sandbox_network fails closed on a bridge with another interface name (MI1 R8) ---------
# The firewall matches sandbox traffic by the bridge it arrives on, so a pre-existing moca-sandbox
# whose bridge has another name would leave that traffic unmatched by the per-bridge rules.
export MOCK_PODMAN_IFACE="podman1"
if iface_err=$(ensure_sandbox_network 2>&1); then
  fail "ensure_sandbox_network must fail when the live bridge interface is not moca-sandbox0"
fi
echo "$iface_err" | grep -qF "moca-sandbox0" || fail "the interface message must name the expected bridge: $iface_err"
echo "$iface_err" | grep -qF "podman1" || fail "the interface message must name the actual bridge: $iface_err"
unset MOCK_PODMAN_IFACE
pass "ensure_sandbox_network fails closed and names both values on a bridge interface mismatch"

cp "$TOKENED_RELAY_ENV" "$SH_ENV_DIR/relay.env"
: >"$MOCK_LOG"
install_sandbox_firewall
NFT="$SH_ENV_DIR/moca-sandbox.nft"
[[ -f "$NFT" ]] || fail "install_sandbox_firewall must render $NFT"
grep -qF 'iifname "moca-sandbox0" ip saddr 10.89.40.0/24 tcp dport 9443 accept' "$NFT" ||
  fail "the attach port must be allowed, over IPv4 from the sandbox bridge only: $(cat "$NFT")"
grep -qF 'iifname "moca-sandbox0" ip saddr 10.89.40.0/24 meta l4proto { tcp, udp } th dport 53 accept' "$NFT" ||
  fail "DNS to podman's resolver must be allowed, over IPv4 from the sandbox bridge only: $(cat "$NFT")"
# Pinned on its own: the IPv4-only sweep below exempts this rule, so dropping its iifname -- accepting
# established/related traffic from every interface -- would otherwise pass the whole file.
grep -qxF '    iifname "moca-sandbox0" ct state established,related accept' "$NFT" ||
  fail "the established/related accept must be scoped to the sandbox bridge: $(cat "$NFT")"
grep -qF 'iifname "moca-sandbox0" counter drop' "$NFT" ||
  fail "everything else arriving on the sandbox bridge -- IPv6 included -- must drop: $(cat "$NFT")"
grep -qF 'ip saddr 10.89.40.0/24 counter drop' "$NFT" ||
  fail "traffic from the sandbox subnet on any other interface must drop too: $(cat "$NFT")"
# Every accept other than the established/related one must be IPv4-only: an accept without
# `ip saddr` would let IPv6 (link-local is up on the bridge and in every container) through.
if grep -E 'accept' "$NFT" | grep -vE 'ct state established,related accept|policy accept' | grep -vqF 'ip saddr'; then
  fail "an accept rule without ip saddr would admit IPv6 from the sandbox bridge: $(cat "$NFT")"
fi
grep -q 'hook input' "$NFT" || fail "the table must filter traffic TO the host (input), not forwarding"
grep -q 'hook forward' "$NFT" && fail "S1 must not filter forwarded (internet) traffic; that is S5's"
grep -q 'nft -f' "$MOCK_LOG" || fail "install_sandbox_firewall must load the table now: $(cat "$MOCK_LOG")"
grep -q 'systemctl enable moca-sandbox-firewall.service' "$MOCK_LOG" ||
  fail "the firewall unit must be enabled so the table survives a reboot: $(cat "$MOCK_LOG")"
grep -qE '^systemctl start moca-sandbox-firewall\.service$' "$MOCK_LOG" ||
  fail "the firewall unit must be started so it is active for the units that require it: $(cat "$MOCK_LOG")"
grep -qE '^systemctl (restart|try-restart|reload-or-restart) moca-sandbox-firewall\.service$' "$MOCK_LOG" &&
  fail "the firewall unit must never be restarted: through RequiredBy= that restarts podman-restart.service and every container it manages: $(cat "$MOCK_LOG")"
pass "moca-sandbox: fixed subnet; host reachable only on the attach port and DNS; persistent; started, never restarted"

# --- install_sandbox_firewall follows sandbox_relay_addr()'s port, not relay_port()'s
# unconditionally --------------------------------------------------------------------------------
# SH_SANDBOX_RELAY_ADDR can point sandboxes at a different port than relay_port() returns; the
# firewall must open the port sandboxes actually dial.
: >"$MOCK_LOG"
SH_SANDBOX_RELAY_ADDR="host.containers.internal:7443" install_sandbox_firewall
grep -q 'tcp dport 7443' "$NFT" ||
  fail "install_sandbox_firewall must open the port from sandbox_relay_addr(), not relay_port(): $(cat "$NFT")"
grep -q '9443' "$NFT" &&
  fail "install_sandbox_firewall must not also open relay_port()'s value once" \
    "SH_SANDBOX_RELAY_ADDR overrides the port: $(cat "$NFT")"
pass "install_sandbox_firewall follows SH_SANDBOX_RELAY_ADDR's port when it overrides relay_port()"

grep -q '^ExecStart=@NFT@ -f @SH_ENV_DIR@/moca-sandbox\.nft$' "$VM_DIR/systemd/moca-sandbox-firewall.service" ||
  fail "the checked-in unit must use the @NFT@ and @SH_ENV_DIR@ placeholders (a literal path breaks" \
    "when nft is not in /usr/sbin or SH_ENV_DIR is customized):" \
    "$(grep '^ExecStart=' "$VM_DIR/systemd/moca-sandbox-firewall.service")"
grep -q '^Before=.*sh-relay.service' "$VM_DIR/systemd/moca-sandbox-firewall.service" ||
  fail "the firewall must be in place before the relay (and so before any sandbox) starts"
grep -q '^RequiredBy=.*sh-relay.service' "$VM_DIR/systemd/moca-sandbox-firewall.service" ||
  fail "RequiredBy=sh-relay.service must be set: Before= alone does not stop the relay from" \
    "starting if this oneshot's load fails at boot"
grep -q '^RequiredBy=.*podman-restart.service' "$VM_DIR/systemd/moca-sandbox-firewall.service" ||
  fail "RequiredBy=podman-restart.service must be set: Before= alone does not stop it from" \
    "starting if this oneshot's load fails at boot"
pass "moca-sandbox-firewall.service is ordered before, and required by, the relay and podman-restart"

INSTALLED_FIREWALL_UNIT="$SH_UNIT_DIR/moca-sandbox-firewall.service"
[[ -f "$INSTALLED_FIREWALL_UNIT" ]] ||
  fail "install_sandbox_firewall must install the firewall unit into $SH_UNIT_DIR"
grep -qF "ExecStart=$(command -v nft) -f $SH_ENV_DIR/moca-sandbox.nft" "$INSTALLED_FIREWALL_UNIT" ||
  fail "the installed unit must run the nft on PATH, with @SH_ENV_DIR@ substituted with the real" \
    "SH_ENV_DIR ($SH_ENV_DIR): $(cat "$INSTALLED_FIREWALL_UNIT")"
grep -q '@NFT@' "$INSTALLED_FIREWALL_UNIT" &&
  fail "the installed unit must not still contain the @NFT@ placeholder: $(cat "$INSTALLED_FIREWALL_UNIT")"
grep -q '@SH_ENV_DIR@' "$INSTALLED_FIREWALL_UNIT" &&
  fail "the installed unit must not still contain the @SH_ENV_DIR@ placeholder: $(cat "$INSTALLED_FIREWALL_UNIT")"
pass "install_sandbox_firewall renders @SH_ENV_DIR@ into the real SH_ENV_DIR when installing the unit"

# --- missing commands fail loudly -----------------------------------------------------------
if PATH="/nonexistent" require_cmds podman 2>/dev/null; then
  fail "require_cmds should fail when podman is absent"
fi
pass "require_cmds reports missing tools"

# A tool that exists but is off sudo's PATH: secure_path (Amazon Linux, RHEL) drops /usr/local/bin,
# where a static podman build installs. The refusal names where it is and the exact re-run command.
HINT_DIR="$TMP/usr-local-bin"
mkdir -p "$HINT_DIR"
printf '#!/bin/sh\n' >"$HINT_DIR/podman"
chmod +x "$HINT_DIR/podman"
hint_out="$(PATH="/nonexistent" SH_CMD_HINT_DIRS="$HINT_DIR" require_cmds podman 2>&1)" &&
  fail "require_cmds must still fail for a tool that is off PATH"
grep -qF "podman is at $HINT_DIR/podman" <<<"$hint_out" ||
  fail "require_cmds must say where an off-PATH tool is: $hint_out"
grep -qF "sudo env PATH=\"$HINT_DIR:\$PATH\"" <<<"$hint_out" ||
  fail "require_cmds must give the re-run command that puts it on PATH: $hint_out"
nohint_out="$(PATH="/nonexistent" SH_CMD_HINT_DIRS="$HINT_DIR" require_cmds nft 2>&1)" &&
  fail "require_cmds must fail for a tool that is nowhere"
grep -q 'sudo env PATH' <<<"$nohint_out" && fail "no PATH hint for a tool that is nowhere: $nohint_out"
pass "require_cmds names an off-PATH tool's location and the sudo env PATH= re-run"

# --- systemd 247+: LoadCredential= (#366) ----------------------------------------------------------
# An older systemd (RHEL 8's 239) ignores LoadCredential= with a warning: the control plane dies on a
# missing SH_SESSION_TOKEN_PRIVATE_KEY and the supervisor runs with SH_REQUIRE_AUTH=true and no
# exchange token. The mock's default answer is a 252.
require_systemd 247 || fail "require_systemd refused systemd 252"
export MOCK_SYSTEMCTL_VERSION='systemd 239 (239-78.el8)'
out="$(require_systemd 247 2>&1)" && fail "require_systemd accepted systemd 239"
for want in 239 247 LoadCredential=; do
  grep -qF "$want" <<<"$out" || fail "require_systemd's refusal of systemd 239 must name $want: $out"
done
for garbled in 'not systemd at all' ''; do
  export MOCK_SYSTEMCTL_VERSION="$garbled"
  out="$(require_systemd 247 2>&1)" && fail "require_systemd accepted a --version of '$garbled'"
  grep -q '247' <<<"$out" || fail "require_systemd's refusal of an unreadable version must name 247: $out"
done
unset MOCK_SYSTEMCTL_VERSION
cmds_line=$(declare -f main | grep -n 'require_cmds' | cut -d: -f1)
systemd_line=$(declare -f main | grep -n 'require_systemd 247' | cut -d: -f1)
[[ -n "$cmds_line" && -n "$systemd_line" ]] || fail "main() must run require_cmds and require_systemd 247"
((systemd_line == cmds_line + 1)) || fail "main() must run require_systemd right after require_cmds"
pass "require_systemd: 252 passes; 239 and an unreadable version refuse, naming 247; main() checks it"

# --- pnpm is a required command (B2) ---------------------------------------------------------
# node --import tsx src/main.ts needs tsx (a devDependency) and the workspace link: targets
# resolved -- both are products of `pnpm install`, which require_cmds never checked for.
grep -qE '^ {2}require_cmds .*\bpnpm\b' "$SCRIPT" ||
  fail "main() must require_cmds pnpm -- ExecStart needs a pnpm-installed workspace"
pass "require_cmds includes pnpm"

# --- require_build fails loudly on an unbuilt workspace, and passes on this one (B2) ---------
# Spec §9's build sequence (submodule init, pi-fork build, root pnpm install) is exactly what a
# fresh VM checkout has not run yet. require_build takes an optional root override so this test
# can point it at an empty tree without needing to break anything real.
EMPTY_ROOT="$TMP/empty-workspace"
mkdir -p "$EMPTY_ROOT"
if build_err=$(require_build "$EMPTY_ROOT" 2>&1); then
  fail "require_build should fail against an unbuilt workspace root"
fi
echo "$build_err" | grep -q 'pnpm install' || fail "require_build's message must name pnpm install (spec §9): $build_err"
echo "$build_err" | grep -q 'npm run build' || fail "require_build's message must name pi-fork's npm run build (spec §9): $build_err"
pass "require_build fails loudly and names spec §9's commands"

# The EMPTY_ROOT case above already covers require_build's failure path, and main()'s
# end-to-end test below covers its success path against a fabricated tree -- this assertion is
# guarded (not dropped) because it is the only one that exercises require_build against the
# REAL monorepo layout (three real relative paths, not paths this test invented), which is
# worth keeping for local/dev regression coverage. It is guarded because that real coverage
# depends on this worktree actually being built, which CI's toolchain-free deploy-scripts job
# (no repo-init step for pi-fork, no setup-node, no pnpm install, no pi-fork build -- see
# .github/workflows/ci.yml) deliberately never does; asserting it unconditionally would couple
# a script-testing job to a built workspace, inverting that job's own reason to exist.
REAL_ROOT="$(cd "$VM_DIR/../.." && pwd)"
if [[ -d "$REAL_ROOT/packages/supervisor/node_modules" &&
  -d "$REAL_ROOT/pi-fork/packages/ai/dist" &&
  -d "$REAL_ROOT/pi-fork/packages/coding-agent/dist" ]]; then
  require_build "$REAL_ROOT" ||
    fail "require_build must pass against this worktree, which is already built"
  pass "require_build passes against a built workspace"
else
  echo "skip - require_build-against-a-built-workspace: this worktree is not built here (no" \
    "pnpm install / pi-fork build -- expected in CI's toolchain-free deploy-scripts job);" \
    "covered instead by the EMPTY_ROOT case above and the fabricated-tree case in main()'s" \
    "end-to-end test below" >&2
fi

# --- require_root fails for a non-root uid and passes for uid 0 (B3) -------------------------
# The README shows a bare invocation with no `sudo`, but install -d -m 0750
# /etc/serverless-harness and systemctl enable both need root -- the script must say so plainly
# rather than dying on a confusing `install` permission error. require_root takes an optional
# uid override so this is testable without actually running as root or as another user.
if require_root 1000 2>/dev/null; then
  fail "require_root should fail for a non-root uid"
fi
require_root 0 || fail "require_root should pass for uid 0"
pass "require_root rejects non-root, accepts uid 0"

# --- Redis publishes on loopback only --------------------------------------------------------
# The same invariant the admin listener check below asserts, applied to the listener that matters
# more. `-p 6379:6379` binds 0.0.0.0 in podman, and this image runs with no --requirepass, no ACL and
# no TLS -- so on a cloud VM it is unauthenticated read/write access to the session log, the ownership
# index, the lease store and sh:sandbox:records.
#
# On THIS deployment that is the execution path, not data at rest: supervisor.env.example ships
# SH_SANDBOX_DISCOVERY=records, and select-sandbox.ts then never lists pods, so the only inventory of
# executors is a set of Redis records. Whoever writes them chooses the sandbox every turn dispatches
# to. Admission control, the fail-closed relay token and RestrictAddressFamilies are all bypassed
# because none of them sits in that path.
if grep -qE '\-p +127\.0\.0\.1:6379:6379' "$SCRIPT"; then
  pass "Redis publishes on 127.0.0.1 only"
else
  fail "start_redis must publish Redis on 127.0.0.1 (found: $(grep -n 'sh-redis' "$SCRIPT"))"
fi
# Comment lines are stripped first: setup-vm.sh deliberately quotes the unsafe form in a comment to
# explain why the bind is what it is, and without this the guard fires on its own documentation.
if grep -vE '^[[:space:]]*#' "$SCRIPT" | grep -qE '\-p +6379:6379'; then
  fail "start_redis still publishes Redis on all interfaces (-p 6379:6379)"
fi

# --- containers must come back after a reboot -------------------------------------------------
# Both units are WantedBy=multi-user.target, so systemd brings the supervisor and relay back on
# boot. Nothing brought the CONTAINERS back: `podman run -d` with no --restart and no generated
# unit means that after a reboot sh:sandbox:records is empty and every turn fails until an operator
# re-runs this script -- on a VM where `systemctl status` looks perfectly healthy. The unit's own
# comment ("the client retries on connect, so ordering against Redis is not load-bearing") is true
# of ORDERING and says nothing about a container that never starts at all.
#
# Two halves, because either alone is insufficient: --restart=always covers a container that exits,
# and podman-run(1) is explicit that it does NOT cover a host reboot -- podman-restart.service is
# the documented mechanism for that.
: >"$MOCK_LOG"
start_redis
start_sandboxes
run_lines="$(grep -c 'podman run ' "$MOCK_LOG")"
restart_lines="$(grep -c 'podman run .*--restart=always' "$MOCK_LOG")"
# Non-zero guard: without it, "all N of N carry the flag" passes vacuously if the mock ever stops
# recording podman invocations at all.
((run_lines >= 4)) ||
  fail "expected at least 4 podman run invocations (Redis + 3 sandboxes), got $run_lines"
[[ "$run_lines" == "$restart_lines" ]] ||
  fail "every podman run must carry --restart=always ($restart_lines of $run_lines do):" \
    "$(cat "$MOCK_LOG")"
pass "Redis and every sandbox container run with --restart=always"

: >"$MOCK_LOG"
enable_container_restart
grep -qE '^systemctl enable podman-restart\.service$' "$MOCK_LOG" ||
  fail "setup-vm.sh must enable podman-restart.service -- podman-run(1): --restart does NOT" \
    "restart containers after a system reboot: $(cat "$MOCK_LOG")"
pass "podman-restart.service enabled, so the containers survive a reboot"

# ...and it must not be fatal when that unit is unavailable: it is one podman package's unit name,
# and a host without it still has a working bring-up plus a documented reboot gap. `set -e` would
# otherwise abort the whole script on an older podman.
# shellcheck disable=SC2016  # expanded by the mock, not here
write_systemctl_mock '[[ "$*" != *podman-restart* ]] || exit 1'
: >"$MOCK_LOG"
if ! warn_out=$(enable_container_restart 2>&1); then
  fail "enable_container_restart must not fail the bring-up when podman-restart.service is absent"
fi
echo "$warn_out" | grep -qi 'reboot' ||
  fail "the warning must name the reboot consequence, not just the failed command: $warn_out"
pass "a missing podman-restart.service warns about the reboot gap instead of aborting"
# Restore the plain mock for the rest of the file (main() below asserts on systemctl argv).
write_systemctl_mock

# --- Redis's missing volume is stated, not left to be discovered on a reboot -------------------
# start_redis runs with no -v, so sessions, the ownership index and the lease store are lost on
# every reboot and every `podman rm`. That is a deliberate round-one choice (E8 rungs start from an
# empty Redis), but --restart=always above brings the CONTAINER back and not the data in it, which
# is exactly the kind of gap an operator should read rather than find.
grep -qi 'no volume' "$SCRIPT" ||
  fail "start_redis must state that Redis runs with no volume (state is lost on reboot)"
grep -qi 'does not survive a reboot' "$VM_DIR/README.md" ||
  fail "README.md must state that Redis state does not survive a reboot"
pass "Redis's lack of a volume is documented in both the script and the README"

# --- admin listener (Task 11): loopback only -------------------------------------------------
# Unauthenticated, and it echoes configuration. Bound to 0.0.0.0 on a cloud VM it is a
# configuration disclosure to the whole subnet, and no unit test can see the difference.
CONFIG_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/packages/supervisor/src/config.ts"
if grep -q "readHost(env, 'SH_ADMIN_HOST', '127\.0\.0\.1')" "$CONFIG_SRC"; then
  pass "admin listener defaults to 127.0.0.1 in code"
else
  fail "admin listener must default to 127.0.0.1 (found: $(grep -n "readHost.*SH_ADMIN_HOST" "$CONFIG_SRC"))"
fi

# The deployment must not ship SH_ADMIN_HOST set to anything other than 127.0.0.1 (or commented out).
# An operator could uncomment it, but the default shipped must be safe.
bad_admin_hosts=$(grep -E '^[^#]*SH_ADMIN_HOST=' "$UNIT_SUPERVISOR" "$ENV_SRC_DIR/supervisor.env.example" 2>/dev/null | grep -v '=127\.0\.0\.1$' || true)
if [ -z "$bad_admin_hosts" ]; then
  pass "no uncommented SH_ADMIN_HOST= with a non-loopback value in unit or env template"
else
  fail "SH_ADMIN_HOST must default to loopback in shipped unit and env; found: $bad_admin_hosts"
fi

# The unit file must not publish the admin port, and must not set it equal to PORT -- readConfig
# throws on the latter, which would be a boot failure discovered on the VM rather than here.
if grep -q 'SH_ADMIN_PORT' "$UNIT_SUPERVISOR" || grep -q 'SH_ADMIN_PORT' "$ENV_SRC_DIR/supervisor.env.example"; then
  ADMIN_PORT="$(grep -ho 'SH_ADMIN_PORT=[0-9]*' "$UNIT_SUPERVISOR" "$ENV_SRC_DIR/supervisor.env.example" |
    head -1 | cut -d= -f2)"
  DATA_PORT="$(grep -ho '\bPORT=[0-9]*' "$UNIT_SUPERVISOR" "$ENV_SRC_DIR/supervisor.env.example" |
    head -1 | cut -d= -f2)"
  if [ "$ADMIN_PORT" != "$DATA_PORT" ]; then
    pass "SH_ADMIN_PORT=$ADMIN_PORT differs from PORT=$DATA_PORT"
  else
    fail "SH_ADMIN_PORT equals PORT ($DATA_PORT): readConfig throws at boot"
  fi
else
  pass "unit file leaves SH_ADMIN_PORT at its 8081 default"
fi

# --- start_services enables the supervisor WITHOUT --now, but starts the relay (B4) ----------
# SH_TURNS_PER_WORKER ships empty on purpose and readConfig throws on blank, so the supervisor
# unit is EXPECTED to fail until the operator sets it. Restart=always + RestartSec=2 with no
# StartLimitIntervalSec=0 means systemd's default 5-starts-in-10s limit trips in about ten
# seconds if we `enable --now` it, after which the README's own `systemctl start
# sh-supervisor.service` is refused with "start request repeated too quickly" until
# `systemctl reset-failed`. Enabling without --now sidesteps the crash loop entirely: the unit
# is wired into multi-user.target for the next boot, but this run does not start it.
#
# A re-run must apply what it just wrote: `enable --now` does nothing to a unit that is already
# running, so env and unit changes would wait for the next reboot. The relay is restarted; the
# supervisor is try-restarted -- restarted if it is running, left stopped if it is not.
# Its own SH_ENV_DIR, with the UNCONFIGURED control-plane.env template: $TMP/etc's has a client id,
# and set_env_line below edits the file in place.
SE="$(mu1_dir)"
SH_ENV_DIR="$SE"
: >"$MOCK_LOG"
start_services
grep -qE '^systemctl enable sh-relay\.service$' "$MOCK_LOG" ||
  fail "start_services must enable the relay unit: $(cat "$MOCK_LOG")"
grep -qE '^systemctl restart sh-relay\.service$' "$MOCK_LOG" ||
  fail "start_services must restart the relay so a re-run's env takes effect: $(cat "$MOCK_LOG")"
grep -qE '^systemctl enable sh-supervisor\.service$' "$MOCK_LOG" ||
  fail "start_services must enable (without --now) the supervisor unit: $(cat "$MOCK_LOG")"
grep -qE '^systemctl try-restart sh-supervisor\.service$' "$MOCK_LOG" ||
  fail "start_services must try-restart the supervisor, so a running one picks up a re-run's" \
    "env: $(cat "$MOCK_LOG")"
grep -qE '^systemctl (enable --now|start|restart) sh-supervisor\.service$' "$MOCK_LOG" &&
  fail "start_services must NOT start a stopped supervisor (guaranteed crash loop while" \
    "SH_TURNS_PER_WORKER is unset): $(cat "$MOCK_LOG")"
pass "relay restarted; supervisor enabled and try-restarted, never started"

grep -qE '^systemctl enable sh-control-plane\.service$' "$MOCK_LOG" ||
  fail "start_services must enable the control plane: $(cat "$MOCK_LOG")"
grep -qE '^systemctl try-restart sh-control-plane\.service$' "$MOCK_LOG" ||
  fail "an unconfigured control plane must only be try-restarted: $(cat "$MOCK_LOG")"
grep -qE '^systemctl (enable --now|start|restart) sh-control-plane\.service$' "$MOCK_LOG" &&
  fail "start_services started an unconfigured control plane (it refuses to boot without" \
    "SH_GITHUB_CLIENT_ID, so Restart=always would trip the start limit): $(cat "$MOCK_LOG")"
cp_line=$(grep -n 'sh-control-plane.service' "$MOCK_LOG" | tail -1 | cut -d: -f1)
sup_line=$(grep -n 'try-restart sh-supervisor.service' "$MOCK_LOG" | head -1 | cut -d: -f1)
[[ -n "$cp_line" && -n "$sup_line" ]] || fail "start_services did not touch both units: $(cat "$MOCK_LOG")"
((cp_line < sup_line)) || fail "the control plane must come up before the supervisor is try-restarted"
pass "unconfigured control plane: enabled and try-restarted, never started, before the supervisor"

set_env_line "$SH_ENV_DIR/control-plane.env" SH_GITHUB_CLIENT_ID Iv1.demo
: >"$MOCK_LOG"; start_services
grep -qE '^systemctl restart sh-control-plane\.service$' "$MOCK_LOG" &&
  fail "a control plane with a client id but no SH_PUBLIC_HARNESS_URL must not be started"
set_env_line "$SH_ENV_DIR/control-plane.env" SH_PUBLIC_HARNESS_URL http://127.0.0.1:8080
: >"$MOCK_LOG"; start_services
grep -qE '^systemctl restart sh-control-plane\.service$' "$MOCK_LOG" ||
  fail "a configured control plane must be restarted, so a re-run's env reaches it: $(cat "$MOCK_LOG")"
pass "configured control plane (client id AND public harness URL): restarted on every run"
SH_ENV_DIR="$TMP/etc"
rm -rf "$SE"

# --- #368: the operator fallback's token is a systemd credential, loaded by a drop-in iff it exists --
OP="$(mu1_dir)"
OP_UNITS="$(mktemp -d)"
OP_DROPIN="$OP_UNITS/sh-control-plane.service.d/50-operator-inference-token.conf"
op_run() { SH_ENV_DIR="$OP" SH_UNIT_DIR="$OP_UNITS" ensure_operator_fallback; }
op_token() { install -d -m 0700 "$OP/credentials"; (umask 077 && printf '%s\n' "$1" >"$OP/credentials/operator-inference-token"); }
OP_SECRET='sk-ant-api03-fabricated-operator' # notsecret

# Default: no token, fallback off -> nothing installed, nothing refused.
op_run || fail "ensure_operator_fallback refused a default install"
[[ ! -e "$OP_DROPIN" ]] || fail "a drop-in was installed with no operator token"
pass "operator fallback: a default install installs no drop-in"

# Fallback on, token file forgotten -> refused, naming the file (Review Focus 1).
echo 'SH_ALLOW_OPERATOR_FALLBACK=true' >>"$OP/control-plane.env"
if op_err=$(op_run 2>&1); then fail "SH_ALLOW_OPERATOR_FALLBACK=true with no token file was accepted"; fi
grep -qF "$OP/credentials/operator-inference-token" <<<"$op_err" || fail "the refusal must name the token file: $op_err"
pass "operator fallback: on with no token file refuses, naming the file"

# Token present -> the drop-in loads it from the hardcoded path the units use; the value is nowhere.
op_token "$OP_SECRET"
op_run || fail "ensure_operator_fallback refused a present token"
grep -qxF 'LoadCredential=SH_OPERATOR_INFERENCE_TOKEN:/etc/serverless-harness/credentials/operator-inference-token' "$OP_DROPIN" ||
  fail "the drop-in does not load the token: $(cat "$OP_DROPIN" 2>/dev/null)"
grep -qxF '[Service]' "$OP_DROPIN" || fail "the drop-in has no [Service] section"
grep -rqF -- "$OP_SECRET" "$OP_UNITS" "$OP"/*.env && fail "the operator token's value was copied out of its file"
[[ "$(cat "$OP/credentials/operator-inference-token")" == "$OP_SECRET" ]] || fail "the token file was rewritten"
before="$(cksum <"$OP_DROPIN")"
op_run || fail "re-run failed"
[[ "$(cksum <"$OP_DROPIN")" == "$before" ]] || fail "a re-run changed the drop-in"
pass "operator fallback: a present token gets a LoadCredential= drop-in; the value never leaves its file"

# A readable-by-others token file is refused (it is a secret, like the MU1 files).
chmod 0644 "$OP/credentials/operator-inference-token"
if op_err=$(op_run 2>&1); then fail "a 0644 operator token was accepted"; fi
grep -qF '0600' <<<"$op_err" || fail "the refusal must say 0600: $op_err"
chmod 0400 "$OP/credentials/operator-inference-token"
op_run || fail "a 0400 operator token (read-only, root-only) was refused"
chmod 0600 "$OP/credentials/operator-inference-token"
pass "operator fallback: a token file readable by group or others refuses; 0400 and 0600 pass"

# A dangling symlink at the token path is not "no token": refused, not silently treated as absent.
mv "$OP/credentials/operator-inference-token" "$OP/credentials/token.real"
ln -s "$OP/credentials/nowhere" "$OP/credentials/operator-inference-token"
if op_err=$(op_run 2>&1); then fail "a dangling symlink at the token path was accepted"; fi
grep -qF 'symlink' <<<"$op_err" || fail "the refusal must say it is a dangling symlink: $op_err"
rm "$OP/credentials/operator-inference-token"
mv "$OP/credentials/token.real" "$OP/credentials/operator-inference-token"
pass "operator fallback: a dangling symlink at the token path refuses"

# A LIVE symlink is judged by its target, as LoadCredential= reads it (#411 review): a link to a 0600
# key passes, a link to a key others can read refuses, and the advice it prints then works.
mv "$OP/credentials/operator-inference-token" "$OP/credentials/token.real"
ln -s "$OP/credentials/token.real" "$OP/credentials/operator-inference-token"
op_run || fail "a symlink to a 0600 operator token was refused"
[[ -e "$OP_DROPIN" ]] || fail "a symlink to a 0600 operator token got no drop-in"
chmod 0644 "$OP/credentials/token.real"
if op_err=$(op_run 2>&1); then fail "a symlink to a 0644 operator token was accepted"; fi
grep -qF 'mode 644' <<<"$op_err" || fail "the refusal must report the TARGET's mode (644): $op_err"
chmod 0600 "$OP/credentials/token.real"
op_run || fail "after the advised chmod, the symlinked token was still refused"
rm "$OP/credentials/operator-inference-token"
mv "$OP/credentials/token.real" "$OP/credentials/operator-inference-token"
pass "operator fallback: a live symlink is judged by its target's mode"

# A hand-made drop-in loading the same credential -- what main's README told operators to write with
# `systemctl edit` before #411 (override.conf) -- is refused, naming it: with the token it doubles
# the line, and once the token goes it would fail the unit on the missing file.
install -d "$OP_UNITS/sh-control-plane.service.d"
printf '[Service]\nLoadCredential=SH_OPERATOR_INFERENCE_TOKEN:/etc/serverless-harness/credentials/operator-inference-token\n' \
  >"$OP_UNITS/sh-control-plane.service.d/override.conf"
for state in present absent; do
  [[ "$state" == absent ]] && mv "$OP/credentials/operator-inference-token" "$OP/token.aside"
  if op_err=$(op_run 2>&1); then fail "a hand-made drop-in loading the token was accepted (token $state)"; fi
  grep -qF 'override.conf' <<<"$op_err" || fail "the refusal must name override.conf (token $state): $op_err"
done
mv "$OP/token.aside" "$OP/credentials/operator-inference-token"
# systemd strips whitespace around `=` in unit files, and LoadCredentialEncrypted= loads it too.
for line in 'LoadCredential = SH_OPERATOR_INFERENCE_TOKEN:/etc/serverless-harness/credentials/operator-inference-token' \
  'LoadCredentialEncrypted=SH_OPERATOR_INFERENCE_TOKEN:/etc/credstore.encrypted/op' 'LoadCredential=SH_OPERATOR_INFERENCE_TOKEN'; do
  printf '[Service]\n%s\n' "$line" >"$OP_UNITS/sh-control-plane.service.d/override.conf"
  if op_run >/dev/null 2>&1; then fail "a hand-made drop-in was accepted: '$line'"; fi
done
rm "$OP_UNITS/sh-control-plane.service.d/override.conf"
op_run || fail "with the hand-made drop-in removed, a present token was refused"
pass "operator fallback: a hand-made drop-in loading the same credential refuses, naming it"

# An empty token file is refused, not loaded.
: >"$OP/credentials/operator-inference-token"
if op_err=$(op_run 2>&1); then fail "an empty operator token was accepted"; fi
grep -qF 'empty' <<<"$op_err" || fail "the refusal must say the file is empty: $op_err"
pass "operator fallback: an empty token file refuses"

# The token as an env line is refused, as the MU1 secrets are, and the value is not echoed.
op_token "$OP_SECRET"
# Every spelling systemd's EnvironmentFile= accepts: leading whitespace, and whitespace around `=`
# (parse_env_file_internal trims the key and skips blanks after `=`).
for line in "SH_OPERATOR_INFERENCE_TOKEN=$OP_SECRET" "  SH_OPERATOR_INFERENCE_TOKEN=$OP_SECRET" \
  "SH_OPERATOR_INFERENCE_TOKEN = $OP_SECRET" "SH_OPERATOR_INFERENCE_TOKEN =$OP_SECRET"; do
  printf '%s\n' "$line" >>"$OP/control-plane.env"
  if op_err=$(op_run 2>&1); then fail "SH_OPERATOR_INFERENCE_TOKEN as an env line was accepted: '$line'"; fi
  grep -qF 'systemd credential' <<<"$op_err" || fail "the refusal must say it is a systemd credential: $op_err"
  grep -qF -- "$OP_SECRET" <<<"$op_err" && fail "the refusal echoed the token"
  sed -i.bak '/SH_OPERATOR_INFERENCE_TOKEN/d' "$OP/control-plane.env" && rm -f "$OP/control-plane.env.bak"
done
pass "operator fallback: the token as an env line refuses without echoing it"

# Every spelling of the fallback line systemd's EnvironmentFile= reads as on (#411 review): indented,
# trailing-spaced, whitespace around `=`. Each is tested ALONE: the file's earlier unindented
# `SH_ALLOW_OPERATOR_FALLBACK=true` is removed first, or it would make every case pass by itself.
mv "$OP/credentials/operator-inference-token" "$OP/token.aside"
sed -i.bak '/SH_ALLOW_OPERATOR_FALLBACK/d' "$OP/control-plane.env" && rm -f "$OP/control-plane.env.bak"
op_run || fail "fixture: with no fallback line at all, a missing token file must pass"
for line in '  SH_ALLOW_OPERATOR_FALLBACK=true' 'SH_ALLOW_OPERATOR_FALLBACK=true  ' \
  'SH_ALLOW_OPERATOR_FALLBACK = true' 'SH_ALLOW_OPERATOR_FALLBACK= "true"'; do
  printf '%s\n' "$line" >>"$OP/control-plane.env"
  if op_err=$(op_run 2>&1); then fail "'$line' with no token file was accepted"; fi
  grep -qF 'does not exist' <<<"$op_err" || fail "'$line': the refusal must say the token file does not exist: $op_err"
  sed -i.bak '/SH_ALLOW_OPERATOR_FALLBACK/d' "$OP/control-plane.env" && rm -f "$OP/control-plane.env.bak"
done
mv "$OP/token.aside" "$OP/credentials/operator-inference-token"
pass "operator fallback: every spelling of the fallback line systemd reads as on counts, each alone"

# Token removed later with the fallback off -> the drop-in goes too (Review Focus 4).
sed -i.bak '/^SH_ALLOW_OPERATOR_FALLBACK=/d' "$OP/control-plane.env" && rm -f "$OP/control-plane.env.bak"
rm "$OP/credentials/operator-inference-token"
op_run || fail "removing the token with the fallback off was refused"
[[ ! -e "$OP_DROPIN" ]] || fail "the drop-in outlived its token file: LoadCredential= would fail the unit"
pass "operator fallback: removing the token removes the drop-in"
rm -rf "$OP" "$OP_UNITS"

# seed_control_plane_env: SH_GITHUB_CLIENT_ID and SH_PUBLIC_HARNESS_URL from the environment fill
# control-plane.env's EMPTY slots (the template ships both empty), as deploy/compose/install.sh does for
# the client id. A value already in the file is the operator's: kept, with a warning when the
# environment disagrees. Run in subshells, so the exports never reach the rest of this file.
SC="$(mu1_dir)"
cpf="$SC/control-plane.env"
seed_out="$(SH_ENV_DIR="$SC" SH_GITHUB_CLIENT_ID=Ov23liDemo SH_PUBLIC_HARNESS_URL=http://127.0.0.1:8080 \
  seed_control_plane_env 2>&1)" || fail "seed_control_plane_env failed on the template: $seed_out"
[[ "$(env_file_value SH_GITHUB_CLIENT_ID "$cpf")" == Ov23liDemo ]] ||
  fail "an empty SH_GITHUB_CLIENT_ID was not filled from the environment: $(cat "$cpf")"
[[ "$(env_file_value SH_PUBLIC_HARNESS_URL "$cpf")" == http://127.0.0.1:8080 ]] ||
  fail "an empty SH_PUBLIC_HARNESS_URL was not filled from the environment: $(cat "$cpf")"
(($(grep -cE '^SH_GITHUB_CLIENT_ID=' "$cpf") == 1)) || fail "seeding left a duplicate SH_GITHUB_CLIENT_ID= line"
(SH_ENV_DIR="$SC" cp_configured) || fail "a seeded control-plane.env must count as configured"
pass "seed_control_plane_env fills the template's empty client id and harness URL"

sum_before="$(cksum <"$cpf")"
seed_out="$(SH_ENV_DIR="$SC" SH_GITHUB_CLIENT_ID=Ov23liOther SH_PUBLIC_HARNESS_URL=http://10.0.0.5:8080 \
  seed_control_plane_env 2>&1)" || fail "a differing environment must warn, not fail: $seed_out"
[[ "$(cksum <"$cpf")" == "$sum_before" ]] || fail "seeding overwrote the operator's values: $(cat "$cpf")"
grep -qE 'SH_GITHUB_CLIENT_ID.*Ov23liDemo.*Ov23liOther|SH_GITHUB_CLIENT_ID.*Ov23liOther.*Ov23liDemo' <<<"$seed_out" ||
  fail "a differing SH_GITHUB_CLIENT_ID must be named in a warning, with both values: $seed_out"
grep -q 'SH_PUBLIC_HARNESS_URL' <<<"$seed_out" || fail "a differing SH_PUBLIC_HARNESS_URL must be warned about: $seed_out"
seed_out="$(SH_ENV_DIR="$SC" SH_GITHUB_CLIENT_ID=Ov23liDemo seed_control_plane_env 2>&1)"
[[ -z "$seed_out" ]] || fail "an environment that agrees with the file must be silent: $seed_out"
seed_out="$(SH_ENV_DIR="$SC" seed_control_plane_env 2>&1)" || fail "an unset environment must be a no-op: $seed_out"
[[ -z "$seed_out" && "$(cksum <"$cpf")" == "$sum_before" ]] || fail "an unset environment changed something: $seed_out"
pass "seed_control_plane_env keeps an operator's values (warning on a disagreement), is silent otherwise"

# A value reaches set_env_line, which writes it as one env line: a newline in it would add a line of
# the caller's choosing to a root-owned env file. Refused before anything is written.
rm -rf "$SC"; SC="$(mu1_dir)"; cpf="$SC/control-plane.env"
sum_before="$(cksum <"$cpf")"
# The shape, too: the docs' placeholder Ov23li... is URL-safe characters, and would stick if written.
for bad in $'Ov23li\nSH_ALLOW_OPERATOR_FALLBACK=true' 'Ov23 li' 'Ov23li"' 'Ov23li...' 'Ov23li…' \
  '.Ov23li' 'Iv1.' 'Ov23_li' '-Ov23li'; do
  rc=0; seed_out="$(SH_ENV_DIR="$SC" SH_GITHUB_CLIENT_ID="$bad" seed_control_plane_env 2>&1)" || rc=$?
  ((rc != 0)) || fail "a malformed client id was accepted: $(cat "$cpf")"
  grep -q 'SH_GITHUB_CLIENT_ID' <<<"$seed_out" || fail "the refusal must name SH_GITHUB_CLIENT_ID: $seed_out"
done
# A trailing backslash is a line continuation to systemd's EnvironmentFile= parser, and `$`/backticks
# have no business in a URL: the check is an allowlist of URL characters, not a denylist.
# And the shape, as the control plane's `new URL` parses it at boot: the last three are URL
# characters, but would crash-loop the unit under Restart=always rather than be refused here.
# shellcheck disable=SC1003,SC2016  # literal backslash, $ and backticks are the inputs under test
for bad in 'ftp://x' '127.0.0.1:8080' $'http://x\nSH_ALLOW_OPERATOR_FALLBACK=true' 'http://a b' \
  'http://x\' 'http://$HOME:8080' 'http://a`b`' 'http://a%' 'http://[::1' 'http://h:99999'; do
  rc=0; seed_out="$(SH_ENV_DIR="$SC" SH_PUBLIC_HARNESS_URL="$bad" seed_control_plane_env 2>&1)" || rc=$?
  ((rc != 0)) || fail "SH_PUBLIC_HARNESS_URL '$bad' was accepted: $(cat "$cpf")"
  grep -q 'SH_PUBLIC_HARNESS_URL' <<<"$seed_out" || fail "the refusal must name SH_PUBLIC_HARNESS_URL: $seed_out"
done
[[ "$(cksum <"$cpf")" == "$sum_before" ]] || fail "a refused value changed control-plane.env: $(cat "$cpf")"
# Both are checked before either is written: a bad URL must not leave a good client id behind.
rc=0; SH_ENV_DIR="$SC" SH_GITHUB_CLIENT_ID=Ov23liDemo SH_PUBLIC_HARNESS_URL='nope' seed_control_plane_env \
  >/dev/null 2>&1 || rc=$?
if ((rc == 0)) || [[ "$(cksum <"$cpf")" != "$sum_before" ]]; then
  fail "a bad URL next to a good client id must refuse both: $(cat "$cpf")"
fi
rm -rf "$SC"
pass "seed_control_plane_env refuses a malformed value whole, before writing anything"

# ...and the shapes GitHub issues, and the URLs a deployment uses, still pass.
for good in 'Ov23liAbCdEf01234567' '0123456789abcdef0123' 'Iv1.0123456789abcdef'; do
  SC="$(mu1_dir)"
  SH_ENV_DIR="$SC" SH_GITHUB_CLIENT_ID="$good" seed_control_plane_env >/dev/null 2>&1 ||
    fail "a well-formed client id '$good' was refused"
  rm -rf "$SC"
done
for good in 'http://127.0.0.1:8080' 'http://[::1]:8080' 'https://harness.example.com/' 'http://10.0.0.5:8080/moca'; do
  SC="$(mu1_dir)"
  SH_ENV_DIR="$SC" SH_PUBLIC_HARNESS_URL="$good" seed_control_plane_env >/dev/null 2>&1 ||
    fail "a well-formed harness URL '$good' was refused"
  rm -rf "$SC"
done
pass "seed_control_plane_env accepts GitHub's client id shapes and ordinary harness URLs"

# The file's value is compared the way systemd reads it: a quoted SH_GITHUB_CLIENT_ID="X" IS X, so an
# environment saying X is agreement, not a disagreement to warn about. And an operator who commented the
# slot out (#SH_GITHUB_CLIENT_ID=) has no value: the seed replaces that line, leaving one active line.
SC="$(mu1_dir)"; cpf="$SC/control-plane.env"
set_env_line "$cpf" SH_GITHUB_CLIENT_ID '"Ov23liDemo"'
seed_out="$(SH_ENV_DIR="$SC" SH_GITHUB_CLIENT_ID=Ov23liDemo seed_control_plane_env 2>&1)"
[[ -z "$seed_out" ]] || fail "a quoted file value equal to the environment's must be silent: $seed_out"
grep -qxF 'SH_GITHUB_CLIENT_ID="Ov23liDemo"' "$cpf" || fail "seeding rewrote a quoted value that agreed: $(cat "$cpf")"
rm -rf "$SC"; SC="$(mu1_dir)"; cpf="$SC/control-plane.env"
sed -i.bak 's/^SH_GITHUB_CLIENT_ID=$/#SH_GITHUB_CLIENT_ID=/' "$cpf" && rm -f "$cpf.bak"
grep -qxF '#SH_GITHUB_CLIENT_ID=' "$cpf" || fail "fixture: the template's slot was not commented out"
SH_ENV_DIR="$SC" SH_GITHUB_CLIENT_ID=Ov23liDemo seed_control_plane_env >/dev/null 2>&1 ||
  fail "seeding a commented-out slot failed"
if [[ "$(grep -cE '^#?SH_GITHUB_CLIENT_ID=' "$cpf")" != 1 ]] || ! grep -qxF 'SH_GITHUB_CLIENT_ID=Ov23liDemo' "$cpf"; then
  fail "a commented-out slot must become the one active line: $(grep -E 'SH_GITHUB_CLIENT_ID' "$cpf")"
fi
rm -rf "$SC"
pass "seed_control_plane_env reads quoted values as systemd does, and fills a commented-out slot"

# main() under errexit, as `sudo ./setup-vm.sh` runs it. `main || fail` would not do: bash ignores
# set -e inside anything on the left of ||, so a failing step would be skipped, not reported. errexit
# is suspended here only around a subshell that turns it back on; run_main <out> sets MAIN_RC.
run_main() {
  set +e
  (set -e; main) >"$1" 2>&1
  MAIN_RC=$?
  set -e
}

# --- main(), end to end, against mocks (last: exercises the real call order) ---------------
# require_cmds also needs `install` and `node`, which are on the real PATH (appended after the
# mock dir above) and deliberately not mocked here.
export SH_UNIT_DIR="$TMP/units2" SH_ENV_DIR="$TMP/etc2"
mkdir -p "$SH_UNIT_DIR" "$SH_ENV_DIR"
# Pre-seed relay.env with a token before main() runs: install_env_file never clobbers an
# existing file, so this stands in for an operator who has already set SH_RELAY_TOKEN --
# without it, main() would (correctly, per B5) refuse to start any sandbox containers, and
# this end-to-end run is checking the happy path's step ordering, not that refusal.
cp "$ENV_SRC_DIR/relay.env.example" "$SH_ENV_DIR/relay.env"
echo 'SH_RELAY_TOKEN=e2e-token' >>"$SH_ENV_DIR/relay.env"
# require_build (called inside main() with zero args) would otherwise resolve against this real
# worktree via SCRIPT_DIR/../.. -- exactly the coupling item 1 exists to break for CI's
# toolchain-free deploy-scripts job. Point it at a fabricated tree with just the three
# directories require_build probes, so this end-to-end run does not depend on pnpm install /
# pi-fork build having actually happened in this worktree.
FAKE_BUILT_ROOT="$TMP/fake-built-root"
mkdir -p "$FAKE_BUILT_ROOT/packages/supervisor/node_modules" \
  "$FAKE_BUILT_ROOT/pi-fork/packages/ai/dist" \
  "$FAKE_BUILT_ROOT/pi-fork/packages/coding-agent/dist"
export SH_REPO_ROOT="$FAKE_BUILT_ROOT"
: >"$MOCK_LOG"
run_main "$TMP/main.out"
main_output=$(cat "$TMP/main.out")
((MAIN_RC == 0)) || fail "main() failed (exit $MAIN_RC): $main_output"

grep -q 'id -u' "$MOCK_LOG" || fail "main() did not check for root (require_root)"
grep -q 'getent passwd harness' "$MOCK_LOG" || fail "main() did not check for the harness account"
[[ -f "$SH_UNIT_DIR/sh-supervisor.service" ]] || fail "main() did not install the supervisor unit"
[[ -f "$SH_UNIT_DIR/sh-relay.service" ]] || fail "main() did not install the relay unit"
[[ -f "$SH_ENV_DIR/supervisor.env" ]] || fail "main() did not install supervisor.env"
[[ -f "$SH_ENV_DIR/relay.env" ]] || fail "main() did not install relay.env"
[[ -f "$SH_UNIT_DIR/sh-control-plane.service" ]] || fail "main() did not install the control-plane unit"
[[ -f "$SH_ENV_DIR/control-plane.env" ]] || fail "main() did not install control-plane.env"
for pair in "${MU1_CREDENTIALS[@]}"; do
  [[ -s "$SH_ENV_DIR/credentials/${pair#*:}" ]] || fail "main() did not generate ${pair%%:*}"
done
grep -qxF 'SH_REQUIRE_AUTH=true' "$SH_ENV_DIR/supervisor.env" || fail "main() left the supervisor unauthenticated"
[[ ! -e "$SH_UNIT_DIR/sh-control-plane.service.d/50-operator-inference-token.conf" ]] ||
  fail "main() installed an operator-token drop-in on a default install"
mu1_line=$(declare -f main | grep -n 'ensure_mu1_secrets' | cut -d: -f1)
wire_line=$(declare -f main | grep -n 'wire_supervisor_mu1' | cut -d: -f1)
units_line=$(declare -f main | grep -n 'install_units' | cut -d: -f1)
token_line=$(declare -f main | grep -n 'require_relay_token' | cut -d: -f1)
listener_line=$(declare -f main | grep -n 'ensure_exec_listener' | cut -d: -f1)
env_line=$(declare -f main | grep -nw 'install_env' | cut -d: -f1)
seed_line=$(declare -f main | grep -n 'seed_control_plane_env' | cut -d: -f1)
services_line=$(declare -f main | grep -n 'start_services' | cut -d: -f1)
if [[ -z "$env_line" || -z "$seed_line" || -z "$services_line" ]] ||
  ((env_line > seed_line || seed_line > token_line || seed_line > services_line)); then
  fail "main() must seed control-plane.env after install_env and before require_relay_token (which" \
    "stops a first run) and start_services"
fi
[[ -n "$token_line" && -n "$listener_line" && -n "$mu1_line" && -n "$wire_line" && -n "$units_line" ]] ||
  fail "main() must run require_relay_token, ensure_exec_listener, ensure_mu1_secrets," \
    "wire_supervisor_mu1 and install_units"
((token_line < listener_line && listener_line < mu1_line && mu1_line < wire_line && wire_line < units_line)) ||
  fail "main() order must be require_relay_token < ensure_exec_listener < ensure_mu1_secrets <" \
    "wire_supervisor_mu1 < install_units"
# The exchange token -- which lets its holder obtain ANY user's decrypted credential from the control
# plane -- never reaches a sandbox, by argv or by inheritance.
xchg=$(cat "$SH_ENV_DIR/credentials/exchange-token")
grep -F -- "$xchg" "$MOCK_LOG" | grep -q 'sh-sandbox-' && fail "a sandbox's podman run carries the exchange token"
grep -qF -- "$xchg" "$MOCK_ENV_LOG" && fail "podman's environment carries the exchange token"

reload_line=$(grep -n 'systemctl daemon-reload' "$MOCK_LOG" | head -1 | cut -d: -f1)
redis_line=$(grep -n 'podman run .*sh-redis' "$MOCK_LOG" | head -1 | cut -d: -f1)
relay_enable_line=$(grep -n 'systemctl restart sh-relay.service' "$MOCK_LOG" | head -1 | cut -d: -f1)
[[ -n "$reload_line" && -n "$redis_line" && -n "$relay_enable_line" ]] ||
  fail "main() did not perform the expected steps: $(cat "$MOCK_LOG")"
((reload_line < redis_line)) ||
  fail "main() must install units (daemon-reload) before starting Redis"
((redis_line < relay_enable_line)) ||
  fail "main() must start Redis before enabling the relay unit"
grep -q -- 'podman-env SANDBOX_TOKEN=e2e-token' "$MOCK_ENV_LOG" ||
  fail "main() did not pass the pre-seeded SH_RELAY_TOKEN through to the sandbox containers" \
    "(B5 / require_relay_token wiring): $(cat "$MOCK_ENV_LOG")"
grep -q -- 'SANDBOX_TOKEN=e2e-token' "$MOCK_LOG" &&
  fail "the relay token leaked into podman's argv on the end-to-end path: $(cat "$MOCK_LOG")"
# The firewall is load-bearing only if it is in place before the first sandbox starts.
firewall_line=$(grep -n 'nft -f' "$MOCK_LOG" | head -1 | cut -d: -f1)
sandbox_line=$(grep -n 'podman run .*sh-sandbox-' "$MOCK_LOG" | head -1 | cut -d: -f1)
[[ -n "$firewall_line" && -n "$sandbox_line" ]] ||
  fail "main() must both load the firewall and start sandboxes: $(cat "$MOCK_LOG")"
((firewall_line < sandbox_line)) ||
  fail "main() must load the sandbox firewall before it starts the first sandbox"
# A sandbox never receives the exec token -- the credential that authorizes SandboxExec into ANY
# sandbox -- by any route: not by argv, not from an env file, not inherited.
exec_token=$(sed -n 's/^MOCA_RELAY_EXEC_TOKEN=//p' "$SH_ENV_DIR/relay.env")
[[ -n "$exec_token" ]] || fail "main() must have generated MOCA_RELAY_EXEC_TOKEN in relay.env"
grep -F -- "$exec_token" "$MOCK_LOG" | grep -q 'sh-sandbox-' &&
  fail "a sandbox's podman run carries the exec token in argv: $(cat "$MOCK_LOG")"
grep -qF -- "podman-env MOCA_RELAY_EXEC_TOKEN=$exec_token" "$MOCK_ENV_LOG" &&
  fail "podman inherits MOCA_RELAY_EXEC_TOKEN, so every sandbox it starts would too"
if grep 'podman run .*sh-sandbox-' "$MOCK_LOG" | grep -qE -- '--env-file|--env-host|--env-merge'; then
  fail "a sandbox is started with an env file or the host environment: $(cat "$MOCK_LOG")"
fi
# Only the three settings a sandbox worker needs are set, by -e.
bad_e=$(grep 'podman run .*sh-sandbox-' "$MOCK_LOG" | grep -oE -- '-e [A-Za-z_][A-Za-z0-9_]*' |
  sed 's/^-e //' | grep -vxE 'SANDBOX_ID|RELAY_ADDR|SANDBOX_TOKEN' | sort -u || true)
[[ -z "$bad_e" ]] || fail "a sandbox is given environment beyond SANDBOX_ID/RELAY_ADDR/SANDBOX_TOKEN: $bad_e"
declare -f main | grep -q 'ensure_exec_listener' ||
  fail "main() must run ensure_exec_listener, or a re-run on a pre-MI1 VM keeps the single listener"
pass "main() end to end: harness-account check, three units, three env files, MU1 secrets, correct ordering"

# A re-run of setup-vm.sh leaves every secret unchanged.
before="$(cat "$SH_ENV_DIR"/credentials/* "$SH_ENV_DIR/supervisor.env" | cksum)"
calls_before="$(gen_calls)"
run_main "$TMP/main-rerun.out"
((MAIN_RC == 0)) || fail "a second main() failed (exit $MAIN_RC): $(cat "$TMP/main-rerun.out")"
[[ "$(gen_calls)" == "$calls_before" ]] || fail "a second main() ran the key generator"
[[ "$(cat "$SH_ENV_DIR"/credentials/* "$SH_ENV_DIR/supervisor.env" | cksum)" == "$before" ]] ||
  fail "a second main() changed a secret or supervisor.env"
pass "main() re-run: every secret and supervisor.env unchanged, generator not run"

# An existing VM without a control plane upgrades by re-running setup-vm.sh.
export SH_UNIT_DIR="$TMP/units3" SH_ENV_DIR="$TMP/etc3"
mkdir -p "$SH_UNIT_DIR" "$SH_ENV_DIR"
cp "$VM_DIR/tests/fixtures/supervisor.env.pre-cp" "$SH_ENV_DIR/supervisor.env"
echo 'SH_TURNS_PER_WORKER=4' >>"$SH_ENV_DIR/supervisor.env"
cp "$ENV_SRC_DIR/relay.env.example" "$SH_ENV_DIR/relay.env"
echo 'SH_RELAY_TOKEN=upgrade-token' >>"$SH_ENV_DIR/relay.env"
: >"$MOCK_LOG"
run_main "$TMP/main-upgrade.out"
((MAIN_RC == 0)) || fail "main() failed on a VM with no control plane (exit $MAIN_RC): $(cat "$TMP/main-upgrade.out")"
[[ -f "$SH_UNIT_DIR/sh-control-plane.service" && -f "$SH_ENV_DIR/control-plane.env" ]] ||
  fail "the upgrade did not install the control plane"
grep -qxF 'SH_TURNS_PER_WORKER=4' "$SH_ENV_DIR/supervisor.env" || fail "the upgrade lost an operator setting"
grep -qxF 'SH_REQUIRE_AUTH=true' "$SH_ENV_DIR/supervisor.env" || fail "the upgrade did not require auth"
grep -qE '^systemctl try-restart sh-control-plane\.service$' "$MOCK_LOG" ||
  fail "the upgrade must not start an unconfigured control plane: $(cat "$MOCK_LOG")"
pass "main() upgrade: a VM with no control plane gains it, keeps its settings, requires auth"

# A fresh VM's FIRST run, given both control-plane settings: it stops at the relay-token check (no
# SH_RELAY_TOKEN yet), and the settings it was given must already be in control-plane.env -- the
# operator's second run, without them, then starts a configured control plane. Run, not inferred from
# main()'s line order.
export SH_UNIT_DIR="$TMP/units4" SH_ENV_DIR="$TMP/etc4"
mkdir -p "$SH_UNIT_DIR" "$SH_ENV_DIR"
SH_GITHUB_CLIENT_ID=Ov23liFirstRun SH_PUBLIC_HARNESS_URL=http://127.0.0.1:8080 run_main "$TMP/main-first.out"
((MAIN_RC != 0)) || fail "a first run with no SH_RELAY_TOKEN must stop: $(cat "$TMP/main-first.out")"
grep -q 'SH_RELAY_TOKEN is not set' "$TMP/main-first.out" ||
  fail "the first run must stop at the relay-token check: $(cat "$TMP/main-first.out")"
[[ "$(env_file_value SH_GITHUB_CLIENT_ID "$SH_ENV_DIR/control-plane.env")" == Ov23liFirstRun &&
  "$(env_file_value SH_PUBLIC_HARNESS_URL "$SH_ENV_DIR/control-plane.env")" == http://127.0.0.1:8080 ]] ||
  fail "a first run that stops at the relay token lost the settings it was given: $(cat "$SH_ENV_DIR/control-plane.env")"
cp_configured || fail "after the first run, the control plane must count as configured"
pass "main() first run: stops at the relay token, keeps the control-plane settings it was given"
export SH_UNIT_DIR="$TMP/units3" SH_ENV_DIR="$TMP/etc3"

# The unconfigured closing message must not offer `systemctl start`: with a setting missing the unit
# cannot boot, or boots advertising no harness. It names both settings and the sudo env route.
unconfigured_out="$(report_done 2>&1)"
grep -qE 'systemctl start sh-control-plane' <<<"$unconfigured_out" &&
  fail "the unconfigured closing message must not suggest starting the control plane: $unconfigured_out"
grep -qE 'sudo env SH_GITHUB_CLIENT_ID=.* SH_PUBLIC_HARNESS_URL=' <<<"$unconfigured_out" ||
  fail "the unconfigured closing message must name the sudo env route: $unconfigured_out"
pass "unconfigured closing message: both settings and the sudo env route, no bare systemctl start"

# The closing message must match the behaviour we actually land on: the supervisor is enabled
# but not started, so the message must say to set SH_TURNS_PER_WORKER and then start it --
# never "restart", which implies it is already running.
echo "$main_output" | grep -qi 'SH_TURNS_PER_WORKER' ||
  fail "closing message must tell the operator to set SH_TURNS_PER_WORKER: $main_output"
echo "$main_output" | grep -qE 'systemctl start sh-supervisor\.service' ||
  fail "closing message must say 'systemctl start' (not restart -- it was never started): $main_output"
# Matched with its "not started" context: install_env's own hint already names SH_GITHUB_CLIENT_ID.
echo "$main_output" | grep -qE 'control plane.* not started.*SH_GITHUB_CLIENT_ID' ||
  fail "closing message must say the control plane needs SH_GITHUB_CLIENT_ID: $main_output"
pass "closing message matches the enable-without-start behaviour"

# A re-run on a VM whose supervisor is running (every upgrade, every later run) try-restarts it: the
# closing message must say so, not tell the operator to set SH_TURNS_PER_WORKER and start it again.
running_out="$(MOCK_SYSTEMCTL_ACTIVE=sh-supervisor.service report_done 2>&1)"
grep -qE 'supervisor is running' <<<"$running_out" ||
  fail "a running supervisor must be reported as running: $running_out"
grep -qE 'systemctl start sh-supervisor|set SH_TURNS_PER_WORKER' <<<"$running_out" &&
  fail "a running supervisor must not be told to set SH_TURNS_PER_WORKER and start: $running_out"
stopped_out="$(report_done 2>&1)"
grep -qE 'set SH_TURNS_PER_WORKER.*systemctl start sh-supervisor\.service' <<<"$stopped_out" ||
  fail "a stopped supervisor must still be told to set SH_TURNS_PER_WORKER and start it: $stopped_out"
pass "closing message follows whether the supervisor is actually running"

echo "all setup-vm.sh tests passed"
