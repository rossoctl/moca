#!/usr/bin/env bash
# deploy/knative/tests/mocactl-quickstart.test.sh
#
# Cluster-free tests for mocactl-quickstart.sh. kubectl, openssl, curl and sleep are mocked on PATH
# and the call log is asserted, the way every other test in this directory works (Makefile:15-19).
# What makes the quickstart safe to hand a new user is all observable there:
#
#   - an EXISTING signing key is reused, never replaced (replacing it would orphan every token and
#     every harness already trusting it);
#   - secret values never reach argv or the transcript;
#   - the control plane advertises the harness as the USER reaches it (the port-forward), and the
#     harness gets the public key -- without which every mocactl turn is refused;
#   - SH_REQUIRE_AUTH is left alone, so the other smokes keep working while this runs;
#   - --teardown undoes the key, min-scale, the manifest and the Secrets.
#
# No cluster required. Run: bash deploy/knative/tests/mocactl-quickstart.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/mocactl-quickstart.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  fails=$((fails + 1))
fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
export MOCK_LOG="$TMP/calls.log"

# kubectl: log everything. `get ksvc -o json` feeds set_ksvc_env's REAL jq, so the patch payload in the
# log is the one a cluster would receive. MOCK_SECRETS=1 makes the three Secrets already exist.
cat >"$TMP/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
echo "kubectl $*" >> "$MOCK_LOG"
args=" $* "
case "$args" in
  *" get ksvc "*" -o json "*)
    echo '{"spec":{"template":{"spec":{"containers":[{"env":[{"name":"SH_REQUIRE_AUTH","value":"false"},{"name":"SH_SESSION_TOKEN_PUBLIC_KEYS","value":"old:KEY"}]}]}}}}'
    exit 0 ;;
  *" get ksvc "*"latestReadyRevisionName"*) echo "moca-00007"; exit 0 ;;
  *" get pod "*) echo "pod/moca-00007-deployment-abc"; exit 0 ;;
  *" get secret "*"jsonpath"*) printf 'RVhJU1RJTkctS0VZ'; exit 0 ;;
  *" get secret "*) [ "${MOCK_SECRETS:-0}" = 1 ] && exit 0 || exit 1 ;;
esac
exit 0
EOF
# openssl: files where -out names one; a fixed digest; a recognisable "secret" from rand, so the test
# can prove it never reaches the log or the transcript.
cat >"$TMP/bin/openssl" <<'EOF'
#!/usr/bin/env bash
echo "openssl $*" >> "$MOCK_LOG"
# MOCK_NO_ED25519=1: an openssl without ed25519 (older LibreSSL) -- genpkey fails, writing nothing.
[ "${MOCK_NO_ED25519:-0}" = 1 ] && [ "${1:-}" = genpkey ] && exit 1
prev=""
for a in "$@"; do [ "$prev" = -out ] && printf 'KEYBYTES' > "$a"; prev="$a"; done
case "${1:-}" in
  dgst) echo "SHA2-256(x)= 00112233445566778899aabbccddeeff"; exit 0 ;;
  rand) echo "MOCK-SECRET-VALUE"; exit 0 ;;
  base64) case " $* " in *" -d "*) cat ;; *) echo "UFVCS0VZ" ;; esac; exit 0 ;;
esac
exit 0
EOF
# curl: discovery advertises MOCK_ADVERTISED (default: the default forwarded harness URL), or 404s
# when MOCK_DISCOVERY=404. Everything else succeeds.
cat >"$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$MOCK_LOG"
case " $* " in
  *"/v1/discovery"*)
    if [ "${MOCK_DISCOVERY:-}" = 404 ]; then
      case " $* " in *"http_code"*) printf '404' ;; *) echo '{"error":"not_found"}' ;; esac
    else
      echo "{\"harnessUrl\":\"${MOCK_ADVERTISED:-http://localhost:18081}\"}"
    fi ;;
esac
exit 0
EOF
printf '#!/usr/bin/env bash\nexit 0\n' >"$TMP/bin/sleep"
chmod +x "$TMP/bin"/*

# run <outfile> [env assignments...] -- [script args...]; prints the exit code.
run() {
  local out="$1"
  shift
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
    envs+=("$1")
    shift
  done
  shift
  : >"$MOCK_LOG"
  (env PATH="$TMP/bin:$PATH" ${envs[@]+"${envs[@]}"} bash "$SCRIPT" "$@") >"$out" 2>&1
  echo $?
}
count() { grep -c -- "$1" "$MOCK_LOG" || true; }
patches() { grep '^kubectl patch ksvc' "$MOCK_LOG" || true; }

echo "== the script exists and is shellcheck-shaped"
check "script exists" "$([ -f "$SCRIPT" ] && echo yes || echo no)" "yes"
check "has set -euo pipefail" "$(grep -c '^set -euo pipefail' "$SCRIPT")" "1"
check "sources lib.sh" "$(grep -c '^source ./lib.sh' "$SCRIPT")" "1"

echo "== without SH_GITHUB_CLIENT_ID it refuses, with the fix, and touches nothing"
code="$(run "$TMP/out" SH_GITHUB_CLIENT_ID= -- --no-forward)"
check "exits 2" "$code" "2"
check "names Device Flow in the fix" "$(grep -c 'Enable Device Flow' "$TMP/out")" "1"
check "applies nothing" "$(count 'apply -f')" "0"

echo "== an openssl without ed25519 is refused before the cluster is touched"
code="$(run "$TMP/out" SH_GITHUB_CLIENT_ID=Ov23li.mock MOCK_NO_ED25519=1 -- --no-forward)"
check "exits 1" "$code" "1"
check "says to install OpenSSL 3" "$(grep -c 'install OpenSSL 3' "$TMP/out")" "1"
check "touches no Secret" "$(count 'secret')" "0"
check "applies nothing" "$(count 'apply -f')" "0"

echo "== a fresh cluster: creates the Secrets and wires both sides"
code="$(run "$TMP/out" SH_GITHUB_CLIENT_ID=Ov23li.mock -- --no-forward)"
check "exits 0" "$code" "0"
check "creates the signing key" "$(count 'create secret generic sh-session-token-key')" "1"
check "creates the KEK from a file" "$(count 'create secret generic sh-credential-kek -n default --from-file=SH_CREDENTIAL_KEK=')" "1"
check "creates the exchange token from a file" "$(count 'create secret generic sh-exchange-token -n default --from-file=SH_EXCHANGE_TOKEN=')" "1"
check "no secret on any command line" "$(count 'from-literal')" "0"
check "no secret value in the call log" "$(count 'MOCK-SECRET-VALUE')" "0"
check "no secret value in the transcript" "$(grep -c 'MOCK-SECRET-VALUE' "$TMP/out" || true)" "0"
check "applies the opt-in control-plane manifest" "$(count '^kubectl apply -f control-plane.yaml$')" "1"
check "sets the client id and advertises the forwarded harness" \
  "$(count 'set env deploy/sh-control-plane -n default SH_GITHUB_CLIENT_ID=Ov23li.mock SH_PUBLIC_HARNESS_URL=http://localhost:18081')" "1"
check "restarts the control plane (a same-tag image rolls nothing)" "$(count 'rollout restart deploy/sh-control-plane')" "1"
check "publishes the public key as kid:base64, replacing the old one" \
  "$(patches | grep -c '"name":"SH_SESSION_TOKEN_PUBLIC_KEYS","value":"0011223344556677:UFVCS0VZ"')" "1"
check "keeps no stale key alongside it" "$(patches | grep -c 'old:KEY')" "0"
check "pins min-scale to 1" "$(patches | grep -c 'min-scale":"1')" "1"
check "stamps build-ts, so a re-loaded same-tag image is served" \
  "$(patches | grep -c 'min-scale":"1","deploy.sh/build-ts":"[0-9]')" "1"
check "leaves SH_REQUIRE_AUTH as it was" "$(patches | grep -c '"name":"SH_REQUIRE_AUTH","value":"true"')" "0"
check "starts no port-forward with --no-forward" "$(count 'port-forward')" "0"

echo "== an existing signing key is reused, never replaced"
code="$(run "$TMP/out" SH_GITHUB_CLIENT_ID=Ov23li.mock MOCK_SECRETS=1 -- --no-forward)"
check "exits 0" "$code" "0"
check "creates no Secret" "$(count 'create secret')" "0"
check "reads the existing key back" "$(count 'get secret sh-session-token-key -n default -o jsonpath')" "1"
check "still publishes its public half" "$(patches | grep -c 'SH_SESSION_TOKEN_PUBLIC_KEYS","value":"0011223344556677:')" "1"

echo "== custom ports flow through to what discovery advertises"
code="$(run "$TMP/out" SH_GITHUB_CLIENT_ID=Ov23li.mock MOCACTL_HARNESS_PORT=19999 -- --no-forward)"
check "advertises the custom harness port" "$(count 'SH_PUBLIC_HARNESS_URL=http://localhost:19999')" "1"

echo "== with port-forwards: forwards the latest revision's pod and prints the one URL"
code="$(run "$TMP/out" SH_GITHUB_CLIENT_ID=Ov23li.mock --)"
check "forwards the control plane" "$(count 'port-forward -n default svc/sh-control-plane 18080:8080')" "1"
check "picks the latest ready revision's running pod" \
  "$(count 'get pod -n default -l serving.knative.dev/revision=moca-00007 --field-selector=status.phase=Running')" "1"
check "forwards that pod, not Kourier" \
  "$(count 'port-forward -n default pod/moca-00007-deployment-abc 18081:8080')" "1"
check "checks discovery through the forward" "$(count 'localhost:18080/v1/discovery')" "1"
check "prints the one URL to export" "$(grep -c 'export SH_CONTROL_PLANE_URL=http://localhost:18080' "$TMP/out")" "1"
# The mocked forwards exit at once, so the script reports it and exits 1 -- the reconnect path.
check "says when a forward stops" "$(grep -c 'a port-forward stopped' "$TMP/out")" "1"

echo "== an old control-plane image is named as the problem, not a network error"
code="$(run "$TMP/out" SH_GITHUB_CLIENT_ID=Ov23li.mock MOCK_DISCOVERY=404 --)"
check "exits 1" "$code" "1"
check "says the image predates /v1/discovery" "$(grep -c 'predates it' "$TMP/out")" "1"
check "prints no 'Ready'" "$(grep -c '^Ready' "$TMP/out" || true)" "0"

echo "== a control plane advertising some other harness URL is refused"
code="$(run "$TMP/out" SH_GITHUB_CLIENT_ID=Ov23li.mock MOCK_ADVERTISED=http://elsewhere:1 --)"
check "exits 1" "$code" "1"
check "names both URLs" "$(grep -c 'advertises http://elsewhere:1, expected http://localhost:18081' "$TMP/out")" "1"

echo "== --teardown undoes the key, min-scale, the manifest and the Secrets"
code="$(run "$TMP/out" -- --teardown)"
check "exits 0 without a client id" "$code" "0"
check "removes the published key" "$(patches | grep -c 'SH_SESSION_TOKEN_PUBLIC_KEYS')" "0"
check "patches the env (the removal)" "$(patches | grep -c '"name":"SH_REQUIRE_AUTH","value":"false"')" "1"
check "returns min-scale to 0" "$(patches | grep -c 'min-scale":"0')" "1"
check "deletes the manifest" "$(count 'delete -f control-plane.yaml')" "1"
check "deletes the three Secrets" \
  "$(count 'delete secret sh-session-token-key sh-credential-kek sh-exchange-token')" "1"
check "warns that stored credentials go too" "$(grep -c 'stored credentials removed' "$TMP/out")" "1"

echo "== the Makefile exposes it"
MK="$DIR/../../Makefile"
check "make mocactl-quickstart exists" "$(grep -c '^mocactl-quickstart:' "$MK")" "1"
check "make mocactl-quickstart-teardown exists" "$(grep -c '^mocactl-quickstart-teardown:' "$MK")" "1"

if [ "$fails" -gt 0 ]; then
  echo "FAILED: $fails"
  exit 1
fi
echo "all ok"
