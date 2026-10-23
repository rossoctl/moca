#!/usr/bin/env bash
# Static test for docker-compose.yml (#342). Renders the file through Compose's own resolver
# (`config --format json`, which needs no daemon) against controlled .env files, and asserts on
# what Compose will actually run -- not on the YAML text, which interpolation and defaults make a
# poor proxy for it.
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$COMPOSE_DIR/../.." && pwd)"
VM_ENV="$REPO_ROOT/deploy/vm/env"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "ok - $*"; }

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
elif [[ -n "${CI:-}" ]]; then
  fail "CI has no Docker Compose, so docker-compose.yml would go unchecked"
else
  echo "SKIP: no 'docker compose' or 'docker-compose' on this machine; docker-compose.yml UNCHECKED"
  exit 0
fi
command -v jq >/dev/null || fail "jq is required"

# render NAME ENV_LINES... -> path to Compose's resolved JSON for that .env (or fails).
# `env -i`: the caller's own shell (ANTHROPIC_*, SH_*) must not leak into interpolation.
render() {
  local name="$1"
  shift
  mkdir -p "$TMP/$name"
  cp "${RENDER_SRC:-$COMPOSE_DIR/docker-compose.yml}" "$TMP/$name/docker-compose.yml"
  printf '%s\n' "$@" >"$TMP/$name/.env"
  (cd "$TMP/$name" && env -i PATH="$PATH" HOME="$HOME" "${COMPOSE[@]}" config --format json) \
    >"$TMP/$name/out.json" 2>"$TMP/$name/err" || return 1
  echo "$TMP/$name/out.json"
}

BASE_ENV=('SH_RELAY_TOKEN=tok-under-test' 'MOCA_RELAY_EXEC_TOKEN=exec-under-test' 'SH_TURNS_PER_WORKER=3')
OUT="$(render base "${BASE_ENV[@]}")" || fail "compose config failed: $(cat "$TMP/base/err")"
# The same stack with the MU1 control plane on: the profile, and the four secrets install.sh generates.
CP_ENV=("${BASE_ENV[@]}" 'COMPOSE_PROFILES=control-plane' 'SH_GITHUB_CLIENT_ID=Iv1.test'
  'SH_SESSION_TOKEN_PRIVATE_KEY=priv-under-test' 'SH_SESSION_TOKEN_PUBLIC_KEYS=kid:pub-under-test'
  'SH_CREDENTIAL_KEK=kek-under-test' 'SH_EXCHANGE_TOKEN=xchg-under-test')
OUT_CP="$(render cp "${CP_ENV[@]}")" || fail "compose config failed with the control plane: $(cat "$TMP/cp/err")"

svc_env() { jq -r --arg s "$1" --arg k "$2" '.services[$s].environment[$k] // "<absent>"' "$OUT"; }
cp_env() { jq -r --arg s "$1" --arg k "$2" '.services[$s].environment[$k] // "<absent>"' "$OUT_CP"; }

# --- 1. exactly one supervisor, and nothing that could multiply its worker pool -----------------
# The supervisor forks its W workers with child_process.fork() (packages/supervisor/src/main.ts):
# the pool lives in ONE process tree, so it can only ever live in one container. A second service
# running the supervisor or a worker entrypoint, or a replica count on the one that does, is a
# topology the fork()-based pool cannot manage.
runs_supervisor="$(jq -r '.services | to_entries[]
  | select((.value.working_dir // "") | test("packages/supervisor$")) | .key' "$OUT")"
[[ "$runs_supervisor" == supervisor ]] ||
  fail "exactly one service, named 'supervisor', must run packages/supervisor; got: '${runs_supervisor//$'\n'/, }'"
runs_worker="$(jq -r '.services | to_entries[]
  | select(((.value.command // []) + (.value.entrypoint // []) | join(" ")) | test("worker\\.ts|--role=turn"))
  | .key' "$OUT")"
[[ -z "$runs_worker" ]] ||
  fail "a service runs a turn worker directly ($runs_worker): workers are the supervisor's fork() children"
replicas="$(jq -r '.services.supervisor.deploy.replicas // .services.supervisor.scale // 1' "$OUT")"
[[ "$replicas" == 1 ]] ||
  fail "the supervisor service has $replicas replicas: scale W with SH_WORKERS inside the container"
pass "one supervisor service owns the worker pool; no second worker-bearing service, no replicas"

# --- 2. env mirrors deploy/vm/env/*.env.example var-for-var, only addressing changed ----------
# override <service>.<key>: the value compose must carry where it may differ from the VM example,
# else nothing (and exit 1). A case, not `declare -A`: the suite must also run under macOS's bash 3.2.
override() {
  case "$1" in
  # Addressing: on a compose network the peers are service names, not 127.0.0.1.
  supervisor.REDIS_URL | sandbox-relay.REDIS_URL) echo 'redis://redis:6379' ;;
  supervisor.SH_RELAY_ADDR) echo 'sandbox-relay:9444' ;;
  sandbox-relay.MOCA_RELAY_EXEC_ADDR) echo '172.31.250.10:9444' ;;
  supervisor.SH_CONTROL_PLANE_URL) echo 'http://control-plane:8080' ;;
  # Keys an example leaves empty or commented are operator inputs, so compose takes them from .env.
  supervisor.SH_TURNS_PER_WORKER) echo '3' ;;
  sandbox-relay.SH_RELAY_TOKEN) echo 'tok-under-test' ;;
  sandbox-relay.MOCA_RELAY_EXEC_TOKEN | supervisor.MOCA_RELAY_EXEC_TOKEN) echo 'exec-under-test' ;;
  # Defaults compose deliberately does not share with the VM. The VM always installs a control plane,
  # so it requires auth; a compose trial may run without one (the control-plane profile is opt-in), so
  # plain /turn stays open unless .env sets SH_REQUIRE_AUTH=true.
  supervisor.SH_REQUIRE_AUTH) echo 'false' ;;
  *) return 1 ;;
  esac
}
check_mirror() {
  local svc="$1" example="$2" key val want got
  while IFS='=' read -r key val; do
    want="$(override "$svc.$key")" || want="$val"
    got="$(svc_env "$svc" "$key")"
    [[ "$got" == "$want" ]] ||
      fail "$svc: $key is '$got', expected '$want' (mirroring ${example#"$REPO_ROOT/"})"
  done < <(grep -E '^[A-Z_]+=' "$example"; grep -E '^#(SH_RELAY_TOKEN|MOCA_RELAY_EXEC_TOKEN|SH_CONTROL_PLANE_URL)=' "$example" | sed 's/^#//')
}
check_mirror supervisor "$VM_ENV/supervisor.env.example"
check_mirror sandbox-relay "$VM_ENV/relay.env.example"
pass "supervisor and sandbox-relay env mirror deploy/vm/env/*.env.example, addressing aside"

# Parity (P6.3). The tier list validates a session at creation (control plane) and places its turns
# (supervisor): a mismatch strands sessions (spec §7). The affinity TTL is read by the relay (the
# detach mark it writes) and the supervisor (the mark it honours): the env examples say the two must
# match. Each pair must be absent in both services by default, and identical when .env sets it.
# PAIRS: "<service A> <service B> <key> <value set in .env>".
PAIRS=(
  'supervisor control-plane SH_SANDBOX_TIERS container,microvm'
  'supervisor control-plane SH_SANDBOX_DEFAULT_TIER microvm'
  'supervisor sandbox-relay SH_SANDBOX_AFFINITY_TTL_SECONDS 120'
)
# parity_check <compose file> <tag>: 0 iff every pair holds in that file; the first breach on stderr.
# A function of the file, so the negative cases below can run it on a mutated copy.
parity_check() {
  local src="$1" tag="$2" absent on pair a b key value got_a got_b
  local env_set=("${CP_ENV[@]}")
  for pair in "${PAIRS[@]}"; do
    read -r a b key value <<<"$pair"
    env_set+=("$key=$value")
  done
  absent="$(RENDER_SRC="$src" render "$tag-absent" "${CP_ENV[@]}")" ||
    { echo "compose config failed: $(cat "$TMP/$tag-absent/err")" >&2; return 1; }
  on="$(RENDER_SRC="$src" render "$tag-set" "${env_set[@]}")" ||
    { echo "compose config failed with the pairs set: $(cat "$TMP/$tag-set/err")" >&2; return 1; }
  for pair in "${PAIRS[@]}"; do
    read -r a b key value <<<"$pair"
    got_a="$(jq -r --arg s "$a" --arg k "$key" '.services[$s].environment[$k] // "<absent>"' "$absent")"
    got_b="$(jq -r --arg s "$b" --arg k "$key" '.services[$s].environment[$k] // "<absent>"' "$absent")"
    [[ "$got_a" == '<absent>' && "$got_b" == '<absent>' ]] ||
      { echo "$key unset in .env: $a has '$got_a', $b has '$got_b'; both must be absent" >&2; return 1; }
    got_a="$(jq -r --arg s "$a" --arg k "$key" '.services[$s].environment[$k] // "<absent>"' "$on")"
    got_b="$(jq -r --arg s "$b" --arg k "$key" '.services[$s].environment[$k] // "<absent>"' "$on")"
    [[ "$got_a" == "$value" && "$got_b" == "$value" ]] ||
      { echo "$key=$value in .env: $a has '$got_a', $b has '$got_b'; both must carry it" >&2; return 1; }
  done
}
parity_check "$COMPOSE_DIR/docker-compose.yml" parity 2>"$TMP/parity.err" || fail "$(cat "$TMP/parity.err")"
pass "tiers (supervisor, control plane) and affinity TTL (supervisor, relay): absent by default, identical when set (spec §7)"

# The check must catch a service that loses its line: run it on copies of docker-compose.yml with one
# service's entry deleted (sed), and require it to FAIL on each.
# line_of <file> <service> <key>: the line number of <key>: inside <service>'s block.
line_of() {
  awk -v svc="$2" -v key="$3" '/^  [A-Za-z0-9_-]+:$/ { in_svc = ($1 == svc ":") }
    in_svc && $1 == key ":" { print NR; exit }' "$1"
}
for drop in 'sandbox-relay SH_SANDBOX_AFFINITY_TTL_SECONDS' 'supervisor SH_SANDBOX_AFFINITY_TTL_SECONDS' \
  'control-plane SH_SANDBOX_TIERS' 'supervisor SH_SANDBOX_DEFAULT_TIER'; do
  read -r svc key <<<"$drop"
  n="$(line_of "$COMPOSE_DIR/docker-compose.yml" "$svc" "$key")"
  [[ -n "$n" ]] || fail "no $key line in $svc's block of docker-compose.yml to drop (the negative case proves nothing)"
  mkdir -p "$TMP/mutant"
  sed "${n}d" "$COMPOSE_DIR/docker-compose.yml" >"$TMP/mutant/docker-compose.yml"
  if parity_check "$TMP/mutant/docker-compose.yml" "mutant-$svc-$key" 2>/dev/null; then
    fail "the parity check passed on a docker-compose.yml whose $svc lost its $key line"
  fi
done
pass "the parity check fails when one service loses its line (four mutations)"

# SH_WORKERS is commented out in the VM template (the default is availableParallelism(), which
# respects the container's CPU limit since #341). Unset must mean unset, not SH_WORKERS=''.
[[ "$(svc_env supervisor SH_WORKERS)" == '<absent>' ]] ||
  fail "SH_WORKERS reaches the supervisor as '$(svc_env supervisor SH_WORKERS)' when .env does not set it"
OUT_W="$(render workers "${BASE_ENV[@]}" 'SH_WORKERS=2')" || fail "compose config failed with SH_WORKERS"
[[ "$(jq -r '.services.supervisor.environment.SH_WORKERS' "$OUT_W")" == 2 ]] ||
  fail "SH_WORKERS=2 in .env does not reach the supervisor"
pass "SH_WORKERS is absent unless .env sets it, and passes through when it does"

# --- 3. one SH_RELAY_PORT drives the attach side, MOCA_RELAY_EXEC_PORT the exec side ----------
# relay.env.example warns the exec address and SH_RELAY_ADDR MUST agree and nothing checks them;
# here both derive from one .env value each, so moving a port moves both ends that describe it.
OUT_P="$(render port "${BASE_ENV[@]}" 'SH_RELAY_PORT=7777' 'MOCA_RELAY_EXEC_PORT=7778')" || fail "compose config failed with ports"
[[ "$(jq -r '.services["sandbox-relay"].environment.SH_RELAY_PORT' "$OUT_P")" == 7777 ]] ||
  fail "SH_RELAY_PORT in .env does not move the relay's attach bind"
[[ "$(jq -r '.services.sandbox.environment.RELAY_ADDR' "$OUT_P")" == sandbox-relay:7777 ]] ||
  fail "SH_RELAY_PORT moved the relay but not the sandbox's RELAY_ADDR"
[[ "$(jq -r '.services["sandbox-relay"].environment.MOCA_RELAY_EXEC_ADDR' "$OUT_P")" == 172.31.250.10:7778 ]] ||
  fail "MOCA_RELAY_EXEC_PORT does not move the relay's exec bind"
[[ "$(jq -r '.services.supervisor.environment.SH_RELAY_ADDR' "$OUT_P")" == sandbox-relay:7778 ]] ||
  fail "MOCA_RELAY_EXEC_PORT moved the exec bind but not the supervisor's SH_RELAY_ADDR"
pass "SH_RELAY_PORT drives the attach side, MOCA_RELAY_EXEC_PORT the exec side, each end agreeing"

# --- 4. the sandbox authenticates with the relay's own token, under its own id ------------------
[[ "$(svc_env sandbox SANDBOX_TOKEN)" == tok-under-test ]] ||
  fail "the sandbox's SANDBOX_TOKEN is not the relay's SH_RELAY_TOKEN; every attach fails closed"
[[ "$(svc_env sandbox SANDBOX_ID)" != '<absent>' ]] ||
  fail "SANDBOX_ID unset: remote-worker defaults to sbx-laptop-1 and collides with any other"
pass "the sandbox dials the relay with the relay's token and an explicit SANDBOX_ID"

# --- 4b. the exec token reaches the relay and the supervisor, and never a sandbox (MI1 R5) -------
[[ "$(svc_env sandbox-relay MOCA_RELAY_EXEC_TOKEN)" == exec-under-test ]] ||
  fail "the relay does not receive MOCA_RELAY_EXEC_TOKEN; it refuses to boot without it"
[[ "$(svc_env supervisor MOCA_RELAY_EXEC_TOKEN)" == exec-under-test ]] ||
  fail "the supervisor does not receive MOCA_RELAY_EXEC_TOKEN; every exec would be refused"
[[ "$(svc_env sandbox MOCA_RELAY_EXEC_TOKEN)" == '<absent>' ]] ||
  fail "a sandbox received MOCA_RELAY_EXEC_TOKEN: only the relay and the supervisor may hold it"
render no-exec 'SH_RELAY_TOKEN=tok' 'SH_TURNS_PER_WORKER=3' >/dev/null &&
  fail "compose accepted an .env with no MOCA_RELAY_EXEC_TOKEN"
grep -q MOCA_RELAY_EXEC_TOKEN "$TMP/no-exec/err" || fail "the refusal must name MOCA_RELAY_EXEC_TOKEN"
pass "the exec token reaches the relay and the supervisor only, and is required"

# --- 5. required inputs fail at `compose config`, before any container starts --------------------
render no-token 'SH_TURNS_PER_WORKER=3' 'MOCA_RELAY_EXEC_TOKEN=x' >/dev/null &&
  fail "compose accepted an .env with no SH_RELAY_TOKEN (the relay fails closed on every attach)"
grep -q SH_RELAY_TOKEN "$TMP/no-token/err" || fail "the refusal must name SH_RELAY_TOKEN: $(cat "$TMP/no-token/err")"
render no-s 'SH_RELAY_TOKEN=tok' 'MOCA_RELAY_EXEC_TOKEN=x' >/dev/null &&
  fail "compose accepted an .env with no SH_TURNS_PER_WORKER (readConfig refuses to start without it)"
grep -q SH_TURNS_PER_WORKER "$TMP/no-s/err" || fail "the refusal must name SH_TURNS_PER_WORKER"
pass "a missing SH_RELAY_TOKEN or SH_TURNS_PER_WORKER stops compose with the variable named"

# --- 6. only the supervisor's data port is reachable from the host, and only on loopback ------
# Redis runs with no auth and holds sh:sandbox:records -- whoever writes there picks the executor
# for every turn (see deploy/vm/setup-vm.sh's start_redis). The relay and sandbox talk over the
# compose network. The admin listener is unauthenticated and must stay unpublished.
published="$(jq -r '.services | to_entries[] | select(.value.ports) | .key' "$OUT")"
[[ "$published" == supervisor ]] || fail "only the supervisor may publish ports; got: ${published//$'\n'/, }"
jq -e '.services.supervisor.ports | length == 1 and .[0].host_ip == "127.0.0.1" and .[0].target == 8080' \
  "$OUT" >/dev/null || fail "supervisor must publish exactly 8080, on 127.0.0.1: $(jq -c .services.supervisor.ports "$OUT")"
published_cp="$(jq -r '.services | to_entries[] | select(.value.ports) | .key' "$OUT_CP" | sort | tr '\n' ' ')"
[[ "$published_cp" == 'control-plane supervisor ' ]] ||
  fail "with the control plane on, only it and the supervisor may publish ports; got: $published_cp"
jq -e '.services["control-plane"].ports | length == 1 and .[0].host_ip == "127.0.0.1" and .[0].target == 8080
  and .[0].published == "8090"' "$OUT_CP" >/dev/null ||
  fail "the control plane must publish exactly 127.0.0.1:8090->8080: $(jq -c '.services["control-plane"].ports' "$OUT_CP")"
[[ "$(jq -r '.services.redis.image' "$OUT")" == docker.io/redis:7-alpine ]] ||
  fail "redis image must match deploy/vm/setup-vm.sh's start_redis (docker.io/redis:7-alpine)"
pass "only the supervisor's 8080 (and the control plane's 8090) are published, on loopback; redis is the VM path's image"

# --- 7. the sandbox shares no network with Redis, the supervisor or anything else (MI1 R8) ---------
nets() { jq -r --arg s "$1" '(.services[$s].networks // {}) | keys[]' "$OUT" | sort | tr '\n' ' '; }
[[ "$(nets sandbox)" == 'moca-sandbox ' ]] || fail "the sandbox must be on moca-sandbox only, is on: $(nets sandbox)"
[[ "$(nets redis)" == 'moca-brain ' ]] || fail "redis must be on moca-brain only, is on: $(nets redis)"
[[ "$(nets supervisor)" == 'moca-brain ' ]] || fail "the supervisor must be on moca-brain only, is on: $(nets supervisor)"
[[ "$(nets sandbox-relay)" == 'moca-brain moca-sandbox ' ]] || fail "the relay bridges both networks, is on: $(nets sandbox-relay)"
[[ "$(OUT="$OUT_CP" nets control-plane)" == 'moca-brain ' ]] ||
  fail "the control plane must be on moca-brain only, is on: $(OUT="$OUT_CP" nets control-plane)"
on_sandbox_net_cp="$(jq -r '.services | to_entries[] | select((.value.networks // {}) | has("moca-sandbox")) | .key' "$OUT_CP" | sort | tr '\n' ' ')"
[[ "$on_sandbox_net_cp" == 'sandbox sandbox-relay ' ]] ||
  fail "with the control plane on, still only sandboxes and the relay may join moca-sandbox: $on_sandbox_net_cp"
# `has()`, not `!= null`: Compose resolves the short-form `networks: [moca-sandbox]` (sandbox's own
# style below) to {"moca-sandbox": null} -- the key is present with a null value, which `!= null`
# would misread as absent.
on_sandbox_net="$(jq -r '.services | to_entries[] | select((.value.networks // {}) | has("moca-sandbox")) | .key' "$OUT" | sort | tr '\n' ' ')"
[[ "$on_sandbox_net" == 'sandbox sandbox-relay ' ]] ||
  fail "only sandboxes and the relay may join moca-sandbox (a future service must not): $on_sandbox_net"
brain_ip="$(jq -r '.services["sandbox-relay"].networks["moca-brain"].ipv4_address' "$OUT")"
[[ "$(svc_env sandbox-relay MOCA_RELAY_EXEC_ADDR)" == "$brain_ip:9444" ]] ||
  fail "the relay's exec listener must bind its moca-brain address ($brain_ip), not every interface"
pass "sandboxes reach only the relay; its exec listener binds the brain side only"

# --- 8. model settings pass through when set and stay absent when not --------------------------
# An empty SH_MODEL reaches run-turn.ts as '' and `env.SH_MODEL ?? default` keeps it.
[[ "$(svc_env supervisor SH_MODEL)" == '<absent>' && "$(svc_env supervisor ANTHROPIC_API_KEY)" == '<absent>' ]] ||
  fail "unset model variables reach the supervisor as empty strings"
OUT_M="$(render model "${BASE_ENV[@]}" 'ANTHROPIC_API_KEY=sk-fabricated' 'SH_MODEL=m-1')" || # notsecret
  fail "compose config failed with model settings"
[[ "$(jq -r '.services.supervisor.environment.ANTHROPIC_API_KEY' "$OUT_M")" == sk-fabricated ]] || # notsecret
  fail "ANTHROPIC_API_KEY in .env does not reach the supervisor"
[[ "$(jq -r '.services.supervisor.environment.SH_MODEL' "$OUT_M")" == m-1 ]] ||
  fail "SH_MODEL in .env does not reach the supervisor"
pass "model settings in .env reach the supervisor; unset ones stay unset"

# --- 9. the MU1 control plane (#348) --------------------------------------------------------------
# Off without the profile, so a stack with no GitHub client id still comes up.
[[ "$(jq -r '.services | has("control-plane")' "$OUT")" == false ]] ||
  fail "the control plane runs without COMPOSE_PROFILES=control-plane; it cannot boot with no client id"
[[ "$(jq -r '.services["control-plane"].working_dir' "$OUT_CP")" == /app/packages/control-plane ]] ||
  fail "the control-plane service must run packages/control-plane (tsx resolves from the package dir)"
pass "the control plane is the control-plane profile, off by default"

# The profile's secrets are NOT required at interpolation: Compose checks `:?` for every service,
# profile active or not, so a required one would break the default stack above.
grep -qE 'SH_(SESSION_TOKEN_PRIVATE_KEY|CREDENTIAL_KEK|EXCHANGE_TOKEN|GITHUB_CLIENT_ID):\?' "$COMPOSE_DIR/docker-compose.yml" &&
  fail "a control-plane secret is :?-required; that breaks every stack without the profile"
pass "the control plane's secrets never block a stack that runs without it"

# Redis: a named volume and AOF, matching the VM path (#410). Without the volume, `docker compose
# down` -- which the restart claim in smoke.sh runs, and which an operator runs to change .env --
# silently forgets every session, the ownership index and the lease store. Without AOF, Redis
# snapshots only on its `save` points, so the volume comes back short of the last window's writes.
jq -e '.services.redis.volumes | any(.type == "volume" and .source == "moca-redis" and .target == "/data")' \
  "$OUT" >/dev/null ||
  fail "redis must mount the moca-redis named volume at /data, or sessions die with the container:" \
    "$(jq -c .services.redis.volumes "$OUT")"
jq -e '.services.redis.command | index("--appendonly") as $i | $i != null and .[$i + 1] == "yes"' \
  "$OUT" >/dev/null ||
  fail "redis must run with --appendonly yes: $(jq -c .services.redis.command "$OUT")"
pass "redis keeps sessions on the moca-redis named volume with AOF on"

# Credentials: the file store, on a NAMED volume at the path the image creates for uid 1000.
[[ "$(cp_env control-plane SH_CREDENTIAL_STORE)" == file ]] ||
  fail "the compose control plane must use SH_CREDENTIAL_STORE=file (there is no Kubernetes here)"
cred_dir="$(cp_env control-plane SH_CREDENTIAL_DIR)"
jq -e --arg d "$cred_dir" '.services["control-plane"].volumes | any(.type == "volume" and .source == "moca-credentials" and .target == $d)' \
  "$OUT_CP" >/dev/null ||
  fail "SH_CREDENTIAL_DIR ($cred_dir) must be the moca-credentials named volume, or credentials die with the container"
grep -qF "$cred_dir" "$REPO_ROOT/Dockerfile" ||
  fail "the Dockerfile does not create $cred_dir: a fresh volume there would be root-owned and unwritable by uid 1000"
[[ "$(jq -r '.services["control-plane"].user' "$OUT_CP")" == 1000:1000 ]] ||
  fail "the control plane must run as 1000:1000, the owner the Dockerfile gives $cred_dir"
pass "credentials live in the file store on the moca-credentials named volume"

# Secrets: each from .env, and the private key and the KEK reach ONLY the control plane.
for k in SH_SESSION_TOKEN_PRIVATE_KEY SH_CREDENTIAL_KEK SH_EXCHANGE_TOKEN SH_GITHUB_CLIENT_ID; do
  want="$(printf '%s\n' "${CP_ENV[@]}" | sed -n "s/^$k=//p")"
  [[ "$(cp_env control-plane "$k")" == "$want" ]] || fail "control-plane: $k does not come from .env"
done
for svc in supervisor sandbox-relay sandbox redis; do
  for k in SH_SESSION_TOKEN_PRIVATE_KEY SH_CREDENTIAL_KEK SH_GITHUB_CLIENT_ID; do
    [[ "$(cp_env "$svc" "$k")" == '<absent>' ]] || fail "$svc received $k: only the control plane may hold it"
  done
done
for svc in sandbox-relay sandbox redis; do
  for k in SH_EXCHANGE_TOKEN SH_SESSION_TOKEN_PUBLIC_KEYS; do
    [[ "$(cp_env "$svc" "$k")" == '<absent>' ]] || fail "$svc received $k"
  done
done
pass "the signing key and the KEK reach the control plane only"

# The supervisor's side of the hop: the control plane's public keys, its exchange token, its address.
[[ "$(cp_env supervisor SH_SESSION_TOKEN_PUBLIC_KEYS)" == kid:pub-under-test ]] ||
  fail "the supervisor does not get SH_SESSION_TOKEN_PUBLIC_KEYS from .env; every mocactl turn fails token_invalid"
[[ "$(cp_env supervisor SH_EXCHANGE_TOKEN)" == "$(cp_env control-plane SH_EXCHANGE_TOKEN)" ]] ||
  fail "the supervisor's SH_EXCHANGE_TOKEN differs from the control plane's; every exchange is refused"
cp_port="$(cp_env control-plane SH_CONTROL_PLANE_PORT)"
[[ "$(cp_env supervisor SH_CONTROL_PLANE_URL)" == "http://control-plane:$cp_port" ]] ||
  fail "SH_CONTROL_PLANE_URL ($(cp_env supervisor SH_CONTROL_PLANE_URL)) does not name the control plane's listen port $cp_port"
jq -e --argjson p "$cp_port" '.services["control-plane"].ports[0].target == $p' "$OUT_CP" >/dev/null ||
  fail "the control plane publishes a container port other than the one it listens on ($cp_port)"
[[ "$(cp_env supervisor SH_REQUIRE_AUTH)" == false ]] ||
  fail "SH_REQUIRE_AUTH must default to false, so plain /turn keeps working for a trial"
OUT_RA="$(render require-auth "${CP_ENV[@]}" 'SH_REQUIRE_AUTH=true')" || fail "compose config failed with SH_REQUIRE_AUTH"
[[ "$(jq -r '.services.supervisor.environment.SH_REQUIRE_AUTH' "$OUT_RA")" == true ]] ||
  fail "SH_REQUIRE_AUTH=true in .env does not reach the supervisor"
# Without the profile the supervisor still gets no key material it was not given.
[[ "$(svc_env supervisor SH_SESSION_TOKEN_PUBLIC_KEYS)" == '<absent>' && "$(svc_env supervisor SH_EXCHANGE_TOKEN)" == '<absent>' ]] ||
  fail "unset MU1 settings reach the supervisor as empty strings"
pass "the supervisor verifies against the control plane's keys and dials it by service name"

# Discovery: the control plane advertises the harness at the port the HOST reaches it on.
[[ "$(cp_env control-plane SH_PUBLIC_HARNESS_URL)" == http://127.0.0.1:8080 ]] ||
  fail "SH_PUBLIC_HARNESS_URL must be the supervisor as the user reaches it, got $(cp_env control-plane SH_PUBLIC_HARNESS_URL)"
OUT_PORTS="$(render cp-ports "${CP_ENV[@]}" 'SH_PORT=18080' 'SH_CP_PORT=18090')" || fail "compose config failed with SH_PORT/SH_CP_PORT"
[[ "$(jq -r '.services["control-plane"].environment.SH_PUBLIC_HARNESS_URL' "$OUT_PORTS")" == http://127.0.0.1:18080 ]] ||
  fail "moving SH_PORT does not move the advertised harness URL"
jq -e '.services["control-plane"].ports[0].published == "18090"' "$OUT_PORTS" >/dev/null ||
  fail "SH_CP_PORT does not move the control plane's published port"
pass "discovery advertises http://127.0.0.1:\$SH_PORT, and SH_CP_PORT moves the control plane"

# Operator-key fallback is opt-in: absent unless .env sets it (spec §6.4).
for k in SH_ALLOW_OPERATOR_FALLBACK SH_OPERATOR_INFERENCE_TOKEN SH_OPERATOR_INFERENCE_HEADER SH_DEFAULT_INFERENCE_ENDPOINT SH_MODEL_CATALOG_HOSTS; do
  [[ "$(cp_env control-plane "$k")" == '<absent>' ]] || fail "control-plane: $k is set without .env setting it"
done
OUT_FB="$(render fallback "${CP_ENV[@]}" 'SH_ALLOW_OPERATOR_FALLBACK=true' 'SH_OPERATOR_INFERENCE_TOKEN=sk-op-fabricated' 'SH_OPERATOR_INFERENCE_HEADER=x-api-key')" || # notsecret
  fail "compose config failed with the fallback on"
[[ "$(jq -r '.services["control-plane"].environment.SH_ALLOW_OPERATOR_FALLBACK' "$OUT_FB")" == true ]] ||
  fail "SH_ALLOW_OPERATOR_FALLBACK=true in .env does not reach the control plane"
[[ "$(jq -r '.services["control-plane"].environment.SH_OPERATOR_INFERENCE_HEADER' "$OUT_FB")" == x-api-key ]] ||
  fail "SH_OPERATOR_INFERENCE_HEADER in .env does not reach the control plane (#368)"
OUT_CAT="$(render catalog "${CP_ENV[@]}" 'SH_MODEL_CATALOG_HOSTS=litellm.internal')" || fail "compose config failed with SH_MODEL_CATALOG_HOSTS set"
[[ "$(jq -r '.services["control-plane"].environment.SH_MODEL_CATALOG_HOSTS' "$OUT_CAT")" == litellm.internal ]] ||
  fail "SH_MODEL_CATALOG_HOSTS in .env does not reach the control plane"
[[ "$(jq -r '.services.supervisor.environment.SH_OPERATOR_INFERENCE_TOKEN // "<absent>"' "$OUT_FB")" == '<absent>' ]] ||
  fail "the operator inference token reached the supervisor; only the control plane hands it out"
pass "the operator-key fallback is off unless .env turns it on"
