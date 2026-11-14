#!/usr/bin/env bash
# shellcheck disable=SC2015 # `check && check || fail`: fail is the only fallback, by design
# Tests for deploy/sbx/template-onboarding/template-build.sh with podman, df and the two builders mocked: the spec checks
# (each refused before anything is pulled), the names, the flags build-snapshot.sh gets, the guest
# verify command (run here under bash), the record, the free-space check, the digest check, and the
# "already built" short cut.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log"
mkdir -p "$TMP/bin"
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }
DIGEST="sha256:$(printf 'a%.0s' {1..12})$(printf 'b%.0s' {1..52})"

# podman: MOCK_DIGEST is what inspect reports (default the pinned one); exists answers no, so it pulls.
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
printf 'podman %s\n' "$*" >>"$MOCK_LOG"
case "$1 $2" in
'image exists') exit 1 ;;
'image inspect') echo "${MOCK_DIGEST:?}" ;;
'pull '*) [[ -z "${MOCK_PULL_FAIL:-}" ]] || { echo 'mock: unauthorized' >&2; exit 125; } ;;
esac
exit 0
MOCK
# df -Pk: MOCK_FREE_KB available.
cat >"$TMP/bin/df" <<'MOCK'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 1 1 %s 1%% /srv\n' "${MOCK_FREE_KB:?}"
MOCK
# The builders: record their argv (one arg per line); build-snapshot writes a manifest at --out
# unless MOCK_SNAPSHOT_FAIL, and saves its --verify-command for the tests to run.
cat >"$TMP/bin/build-rootfs" <<'MOCK'
#!/usr/bin/env bash
printf 'build-rootfs %s\n' "$*" >>"$MOCK_LOG"
mkdir -p "$2/etc"; printf '127.0.0.1 localhost\n' >"$2/etc/hosts"
MOCK
cat >"$TMP/bin/build-snapshot" <<'MOCK'
#!/usr/bin/env bash
printf 'build-snapshot\n' >>"$MOCK_LOG"
printf '%s\n' "$@" >"$MOCK_STATE/snapshot-args"
printf '%s\n' "${SH_VERIFY_CACHE_DIR:-}" >"$MOCK_STATE/snapshot-cache-dir"
out='' ca='' vmm='' ksha=''
while (($#)); do
  case "$1" in
  --out) out="$2"; shift 2 ;;
  --vmm) vmm="$2"; shift 2 ;;
  --kernel) ksha="sha256:$({ sha256sum "$2" 2>/dev/null || shasum -a 256 "$2"; } | cut -d' ' -f1)"; shift 2 ;;
  --verify-command) printf '%s' "$2" >"$MOCK_STATE/verify-command"; shift 2 ;;
  --egress-ca) ca="sha256:$(openssl x509 -in "$2" -outform DER | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"; shift 2 ;;
  *) shift ;;
  esac
done
[[ -z "${MOCK_SNAPSHOT_FAIL:-}" ]] || { echo 'build-snapshot.sh: the fresh snapshot restored but the --verify-command exited 91' >&2; exit 1; }
mkdir -p "$out"
jq -n --arg h "${MOCK_HASH:-h1}" --arg ca "$ca" --arg vmm "$vmm" --arg k "$ksha" \
  '{hash: $h, built_at: "2026-10-30T00:00:00Z", guest_ram_mb: 4096, vmm: $vmm, kernel_sha256: $k}
  + (if $ca == "" then {} else {egress_ca_sha256: $ca} end)' >"$out/manifest.json"
MOCK
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH" SBX_SRV="$TMP/srv" SBX_SKIP_ROOT_CHECK=1
export SBX_BUILD_ROOTFS="$TMP/bin/build-rootfs" SBX_BUILD_SNAPSHOT="$TMP/bin/build-snapshot"
export MOCK_STATE="$TMP/state" MOCK_DIGEST="$DIGEST" MOCK_FREE_KB=$((200 * 1024 * 1024))
mkdir -p "$MOCK_STATE" "$TMP/agent"
: >"$TMP/vmlinux"
BUILD="$SRC/deploy/sbx/template-onboarding/template-build.sh"

# The spec of a benchmark instance, as an image builder's records give it.
spec() {
  jq -n --arg image "registry.example.invalid/moca-microvm@$DIGEST" '{
    schema: "moca-sbx-template-spec/1", id: "acme-widget-1234", image: $image,
    guest_ram_mb: 4096, vcpus: 2, guest_home: "/tmp/home", skip_git_identity_check: true,
    egress: false, seed: "cp -a /opt/testbed-src/. /workspace/",
    probe: {cmd: "cd /testbed && pytest -rA tests/test_public.py", timeout_s: 900, expect_rc: 0, expect: ["\\b42 passed\\b"]},
    description: "a benchmark instance at its baseline", tools: ["bash", "git", "python3"]}' |
    jq "${1:-.}" "${@:2}" >"$TMP/spec.json"
}
run() { : >"$MOCK_LOG"; bash "$BUILD" "$TMP/spec.json" --kernel "$TMP/vmlinux" --agent "$TMP/agent" "$@" >"$TMP/out" 2>&1; }
NAME=acme-widget-1234-aaaaaaaaaaaa
WORKER=sbx_acme_widget_1234_aaaaaaaaaaaa

# 1. Spec errors: exit 2, naming the field, before podman or a builder runs.
bad=(
  '.id = "Acme__widget-1234" => id'
  '.id = "acme-widget-acme-widget-12345678" => id'
  '.image = "registry.example.invalid/moca-microvm:latest" => image must be pinned'
  '.guest_ram_mb = 64 => guest_ram_mb'
  '.vcpus = 0 => vcpus'
  '.guest_home = "/root" => guest_home'
  '.egress = "no" => egress must be true or false'
  'del(.seed) => seed must be a string'
  '.probe.expect_rc = 1.5 => probe must be'
  '.probe.timeout_s = 0 => probe must be'
  '.probe.cmd = "" => probe must be'
  '.probe.expect = ["("] => invalid extended regex'
  '.tools = ["git", "git"] => tools'
  '.etc_hosts_sha256 = "abc" => etc_hosts_sha256'
  '.probe_status = "unmeasured" => has not been measured'
  '.probe_status = "none" => has not been measured'
)
for case_ in "${bad[@]}"; do
  filter="${case_% => *}" want="${case_#* => }"
  spec "$filter"
  rc=0; run || rc=$?
  [[ "$rc" == 2 ]] || fail "spec '$filter' exited $rc, want 2"
  grep -q -- "$want" "$TMP/out" || fail "spec '$filter' does not say '$want'"
  [[ ! -s "$MOCK_LOG" ]] || fail "spec '$filter' ran something first: $(cat "$MOCK_LOG")"
done
pass 'refuses a bad id, an unpinned image, bad sizes, egress, seed, probe or tools, before anything runs (exit 2)'

# 2. A build: the names, the pull by digest, the builders' flags, the record.
spec
run || fail 'a good spec did not build'
grep -qx "podman pull registry.example.invalid/moca-microvm@$DIGEST" "$MOCK_LOG" || fail 'the image was not pulled by digest'
grep -q "^build-rootfs --out $SBX_SRV/build/$NAME/rootfs --image registry.example.invalid/moca-microvm@$DIGEST --source-name registry.example.invalid/moca-microvm@$DIGEST --require base64 bash cat file git ls python3$" "$MOCK_LOG" ||
  fail "build-rootfs did not get the build dir and the image: $(grep build-rootfs "$MOCK_LOG")"
A="$MOCK_STATE/snapshot-args"
want_args="$(printf '%s\n' --kernel "$TMP/vmlinux" --rootfs "$SBX_SRV/build/$NAME/rootfs" --agent "$TMP/agent" \
  --image "$NAME" --vmm firecracker --guest-ram-mb 4096 --vcpus 2 --out "$SBX_SRV/snapshots/$NAME")"
[[ "$(head -n 16 "$A")" == "$want_args" ]] || fail "build-snapshot's first flags differ: $(head -n 16 "$A")"
grep -qx -- --skip-git-identity-check "$A" && grep -qx -- --guest-home "$A" && grep -qx /tmp/home "$A" ||
  fail 'build-snapshot did not get --skip-git-identity-check and --guest-home /tmp/home'
grep -A1 -x -- --verify-timeout-s "$A" | tail -n1 | grep -qx 900 || fail 'the probe timeout is not --verify-timeout-s'
# The verify cache's seed: SBX0's own worker binary (never Moca's /usr/local/bin one), the cache under SBX_SRV.
grep -A1 -x -- --worker-bin "$A" | tail -n1 | grep -qx /usr/local/libexec/sbx/microvm-worker ||
  fail "build-snapshot's --worker-bin is not SBX0's worker binary"
grep -qx "$SBX_SRV/verify-cache" "$MOCK_STATE/snapshot-cache-dir" ||
  fail "build-snapshot's SH_VERIFY_CACHE_DIR is not under SBX_SRV: $(cat "$MOCK_STATE/snapshot-cache-dir")"
R="$SBX_SRV/templates/$NAME.json"
[[ -f "$R" ]] || fail 'no record written'
jq -e --arg w "$WORKER" --arg n "$NAME" '.schema == "moca-sbx-template/1" and .id == "acme-widget-1234"
  and .worker == $w and .snapshot == $n and .manifest_hash == "h1" and .egress == false
  and .seed == "cp -a /opt/testbed-src/. /workspace/" and .min_budget_mb == 13408' "$R" >/dev/null ||
  fail "the record is wrong: $(cat "$R")"
grep -q -- "--snapshot $NAME --budget-mb <at least 13408> --no-egress" "$TMP/out" || fail 'the install hint lacks the snapshot, budget or --no-egress'
grep -qx "podman rmi registry.example.invalid/moca-microvm@$DIGEST" "$MOCK_LOG" || fail 'the pulled image was not removed'
[[ ! -e "$SBX_SRV/build/$NAME" ]] || fail 'the rootfs tree was left behind'
pass 'builds by digest: snapshot <id>-<digest12>, worker sbx_<id>_<digest12>, the spec flags, a record, and cleans up'

# 3. The guest verify command, run here under bash in a scratch /workspace (testbed faked).
run_verify() {
  local t="$TMP/guest" cmd
  rm -rf "$t"; mkdir -p "$t/workspace" "$t/opt/testbed-src" "$t/tmp"
  echo src >"$t/opt/testbed-src/file"
  cmd="$(sed -e "s|/opt/testbed-src|$t/opt/testbed-src|g" -e "s|/workspace|$t/workspace|g" \
    -e "s|/tmp/.template-probe.log|$t/tmp/probe.log|g" -e "s|/tmp/.template-probe.txt|$t/tmp/probe.txt|g" \
    "$MOCK_STATE/verify-command")"
  (cd "$t/workspace" && bash -c "$cmd") >"$TMP/vout" 2>&1
}
spec '.probe.cmd = "ls /workspace/file && echo \"=== 42 passed in 0.70s ===\""'
run || fail 'the probe spec did not build'
run_verify || fail "the verify command failed on a passing probe: $(cat "$TMP/vout")"
grep -q 'the probe passed' "$TMP/vout" || fail 'a passing probe does not say so'
pass 'the verify command seeds /workspace, runs the probe and passes on the expected result'
# pytest colours its summary when it thinks it has a terminal: ESC[32mESC[1m42 passedESC[0m. A \b before
# the count would never match the raw log (the "m" before the digit is a word character).
spec '.probe.cmd = "printf \"\\033[32m\\033[1m42 passed\\033[0m\\033[32m, 1 skipped in 0.07s\\033[0m\\n\""'
run || fail 'the coloured probe spec did not build'
run_verify || fail "a coloured summary did not match \\b42 passed\\b: $(cat "$TMP/vout")"
! grep -q $'\033' "$TMP/vout" || fail 'the tail shown still has ANSI escapes'
pass 'matches the patterns against the probe output with ANSI colours stripped'
spec '.probe.cmd = "echo \"=== 178 passed, 1 failed in 0.70s ===\"; exit 1"'
run || fail 'the probe spec did not build'
rc=0; run_verify || rc=$?
[[ "$rc" == 91 ]] && grep -q 'want exit 0' "$TMP/vout" || fail "a probe with the wrong exit code gave $rc: $(cat "$TMP/vout")"
spec '.probe.cmd = "echo \"=== 178 passed in 0.70s ===\""'
run || fail 'the probe spec did not build'
rc=0; run_verify || rc=$?
[[ "$rc" == 92 ]] && grep -q 'no match for' "$TMP/vout" || fail "a probe without its pattern gave $rc: $(cat "$TMP/vout")"
spec '.seed = "false"'
run || fail 'the seed spec did not build'
rc=0; run_verify || rc=$?
[[ "$rc" == 90 ]] && grep -q 'the seed failed' "$TMP/vout" || fail "a failing seed gave $rc: $(cat "$TMP/vout")"
# shellcheck disable=SC2016 # $c is jq's variable
spec '.probe.cmd = $c' --arg c "echo \"it's\" \"\\\"quoted\\\"\" \"\$HOME\" '\$HOME'; echo '42 passed in 1s'"
run || fail 'the quoting spec did not build'
run_verify || fail "quotes and \$ in the probe broke the verify command: $(cat "$TMP/vout")"
grep -qF "it's \"quoted\" $HOME \$HOME" "$TMP/vout" || fail "the probe's quoting changed on the way: $(cat "$TMP/vout")"
pass 'the verify command fails on a wrong exit code (91), a missing pattern (92) or a failed seed (90), and quotes safely'

# 4. Already built: the same spec on the same snapshot is not rebuilt; --force rebuilds; a changed
# spec rebuilds.
spec
run || fail 'the first build failed'
run || fail 'the re-run failed'
grep -q 'already built' "$TMP/out" && ! grep -q 'build-snapshot' "$MOCK_LOG" || fail 'the same spec was rebuilt'
run --force || fail '--force failed'
grep -q 'build-snapshot' "$MOCK_LOG" || fail '--force did not rebuild'
spec '.description = "another"'
run || fail 'the changed spec failed'
grep -q 'build-snapshot' "$MOCK_LOG" || fail 'a changed spec was not rebuilt'
pass 'skips a snapshot already built from the same spec; --force or a changed spec rebuilds'

# 4b. The build inputs a snapshot depends on beyond the spec's description: each one changed, with no
# --force, rebuilds rather than reusing the snapshot.
rebuilt() { # rebuilt WHAT [ARGS]: a re-run with ARGS (after spec, if changed) builds the snapshot
  run "${@:2}" || fail "$1: the re-run failed: $(cat "$TMP/out")"
  grep -q build-snapshot "$MOCK_LOG" && ! grep -q 'already built' "$TMP/out" || fail "$1 was taken as already built"
}
spec; run --force || fail 'the base build failed'
rebuilt 'another --vmm' --vmm cloud-hypervisor
run --vmm cloud-hypervisor || fail 'the same --vmm re-run failed'
grep -q 'already built' "$TMP/out" || fail 'the same --vmm was rebuilt'
rebuilt 'back to the default --vmm'
printf 'another kernel\n' >"$TMP/vmlinux2"
rebuilt 'another --kernel' --kernel "$TMP/vmlinux2"
rebuilt 'back to the first --kernel'
spec '.guest_home = "/tmp/other"'; rebuilt 'another guest_home'
spec 'del(.guest_home)'; rebuilt 'no guest_home'
spec '.skip_git_identity_check = false'; rebuilt 'skip_git_identity_check switched off'
jq -e 'has("skip_git_identity_check") | not' "$SBX_SRV/templates/$NAME.json" >/dev/null || fail 'the record still says skip_git_identity_check'
HOSTS_SHA0="$({ sha256sum 2>/dev/null || shasum -a 256; } <<<'127.0.0.1 localhost' | cut -d' ' -f1)"
spec ".etc_hosts_sha256 = \"$HOSTS_SHA0\""; rebuilt 'a new etc_hosts_sha256'
jq -e --arg h "$HOSTS_SHA0" '.etc_hosts_sha256 == $h and .guest_home == "/tmp/home"' "$SBX_SRV/templates/$NAME.json" >/dev/null ||
  fail 'the record lacks etc_hosts_sha256 or guest_home'
spec ".etc_hosts_sha256 = \"$HOSTS_SHA0\""; run || fail 'the same etc_hosts_sha256 re-run failed'
grep -q 'already built' "$TMP/out" || fail 'the same etc_hosts_sha256 was rebuilt'
grep -q 'needed after a guest agent change' "$TMP/out" || fail 'already built does not say --force is needed after an agent change'
pass 'already built only with the same --vmm, --kernel, guest_home, skip_git_identity_check and etc_hosts_sha256; says --force is needed after an agent change'

# 4c. A failed pull stops the build there, naming the image, not later at the digest check.
spec
rc=0; MOCK_PULL_FAIL=1 run --force || rc=$?
[[ "$rc" == 1 ]] && grep -q "could not pull registry.example.invalid/moca-microvm@$DIGEST" "$TMP/out" || fail "a failed pull was not named: rc $rc, $(cat "$TMP/out")"
! grep -q 'podman image inspect' "$MOCK_LOG" && ! grep -q build-rootfs "$MOCK_LOG" || fail 'a failed pull went on to inspect or build'
pass 'a failed pull fails the build at once, naming the image'

# 5. Refusals that must leave nothing behind: low disk, a digest mismatch, a failed probe.
spec
rm -rf "$SBX_SRV"
rc=0; MOCK_FREE_KB=$((10 * 1024 * 1024)) run || rc=$?
[[ "$rc" == 1 ]] && grep -q '10 GiB free; a build needs 50' "$TMP/out" || fail "low disk was not refused: $(cat "$TMP/out")"
! grep -q 'podman' "$MOCK_LOG" || fail 'low disk still pulled'
rc=0; MOCK_DIGEST="sha256:$(printf 'c%.0s' {1..64})" run || rc=$?
[[ "$rc" == 1 ]] && grep -q 'but its digest is sha256:ccc' "$TMP/out" || fail "a digest mismatch was not refused: $(cat "$TMP/out")"
! grep -q build-rootfs "$MOCK_LOG" || fail 'a digest mismatch still built'
rc=0; MOCK_SNAPSHOT_FAIL=1 run || rc=$?
[[ "$rc" == 1 ]] || fail 'a failed snapshot build did not fail the run'
[[ ! -e "$SBX_SRV/templates/$NAME.json" && ! -e "$SBX_SRV/build/$NAME" ]] || fail 'a failed build left a record or a build dir'
pass 'refuses low disk before pulling, a digest mismatch before building, and a failed probe writes no record'

# 6. etc_hosts_sha256: the rootfs's /etc/hosts must have it, checked before the snapshot is built.
HOSTS_SHA="$(printf '127.0.0.1 localhost\n' | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"
spec ".etc_hosts_sha256 = \"$HOSTS_SHA\""
run --force || fail "a matching etc_hosts_sha256 did not build: $(cat "$TMP/out")"
grep -q 'etc/hosts as the spec says' "$TMP/out" || fail 'the hosts check did not run'
spec ".etc_hosts_sha256 = \"$(printf 'f%.0s' {1..64})\""
rc=0; run --force || rc=$?
[[ "$rc" == 1 ]] && grep -q "/etc/hosts has sha256 $HOSTS_SHA, not the spec's" "$TMP/out" || fail "a wrong etc_hosts_sha256 was not refused: $(cat "$TMP/out")"
! grep -q build-snapshot "$MOCK_LOG" || fail 'a wrong etc_hosts_sha256 still built the snapshot'
pass 'checks the rootfs /etc/hosts against etc_hosts_sha256 before building the snapshot'

# 7. --registry: an image without a registry host is pulled from HOST; one with a host as it is.
spec '.image = "team/moca-microvm@'"$DIGEST"'"'
run --force --registry registry.example.invalid:5000 || fail "--registry failed: $(cat "$TMP/out")"
grep -qx "podman pull registry.example.invalid:5000/team/moca-microvm@$DIGEST" "$MOCK_LOG" || fail "--registry did not prefix the pull: $(grep pull "$MOCK_LOG")"
grep -q -- "--image registry.example.invalid:5000/team/moca-microvm@$DIGEST" "$MOCK_LOG" || fail 'build-rootfs did not get the pulled reference'
# The guest's /etc/moca-rootfs-source names the spec's host-free image, never the pull reference.
grep -q -- "--source-name team/moca-microvm@$DIGEST --require" "$MOCK_LOG" || fail "build-rootfs did not get the host-free source name: $(grep build-rootfs "$MOCK_LOG")"
jq -e --arg i "team/moca-microvm@$DIGEST" '.image == $i' "$SBX_SRV/templates/$NAME.json" >/dev/null || fail 'the record does not keep the spec image (host-free)'
spec
run --force --registry other.example.invalid || fail '--registry with a hosted image failed'
grep -qx "podman pull registry.example.invalid/moca-microvm@$DIGEST" "$MOCK_LOG" || fail '--registry changed an image that names its registry'
pass '--registry pulls a host-free image from HOST and keeps the record and the guest'"'"'s source file host-free; a hosted image is pulled as is'

# 8. egress true: no --no-egress in the hint; a curated template's spec needs no seed.
spec '.egress = true | .seed = ""'
run || fail 'an egress spec did not build'
! grep -q -- '--no-egress' "$TMP/out" || fail 'egress true still says --no-egress'
! grep -q 'bash -c .*seed' "$MOCK_STATE/verify-command" && ! grep -q 'the seed failed' "$MOCK_STATE/verify-command" ||
  fail 'an empty seed still runs a seed'
pass 'egress true drops --no-egress from the hint; an empty seed runs nothing'

# 9. --egress-ca: passed to build-snapshot, its fingerprint in the record; refused for an offline
# template, for a private key, and a snapshot built with another CA (or none) is rebuilt.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=ca1 -days 1 \
  -keyout "$TMP/ca1.key" -out "$TMP/ca1.crt" 2>/dev/null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=ca2 -days 1 \
  -keyout "$TMP/ca2.key" -out "$TMP/ca2.crt" 2>/dev/null
CA1="sha256:$(openssl x509 -in "$TMP/ca1.crt" -outform DER | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"
spec
rc=0; run --egress-ca "$TMP/ca1.crt" || rc=$?
[[ "$rc" == 2 ]] && grep -q 'egress-ca is for a template with egress true' "$TMP/out" || fail "--egress-ca on an offline spec was not refused: $(cat "$TMP/out")"
spec '.egress = true | .seed = ""'
rc=0; run --egress-ca "$TMP/ca1.key" || rc=$?
[[ "$rc" == 1 ]] && grep -q 'holds a private key' "$TMP/out" || fail 'a private key was not refused'
! grep -q podman "$MOCK_LOG" || fail 'a private key still pulled'
run --force --egress-ca "$TMP/ca1.crt" || fail "--egress-ca failed: $(cat "$TMP/out")"
grep -A1 -x -- --egress-ca "$MOCK_STATE/snapshot-args" | tail -n1 | grep -qx "$TMP/ca1.crt" || fail 'build-snapshot did not get --egress-ca'
jq -e --arg ca "$CA1" '.egress_ca_sha256 == $ca' "$SBX_SRV/templates/$NAME.json" >/dev/null || fail 'the record lacks the CA fingerprint'
run --egress-ca "$TMP/ca1.crt" || fail 'the same CA re-run failed'
grep -q 'already built' "$TMP/out" || fail 'the same CA was rebuilt'
run --egress-ca "$TMP/ca2.crt" || fail 'another CA failed'
grep -q build-snapshot "$MOCK_LOG" || fail 'another CA was not rebuilt'
run || fail 'no CA failed'
grep -q build-snapshot "$MOCK_LOG" || fail 'a CA snapshot was taken as built for no CA'
jq -e 'has("egress_ca_sha256") | not' "$SBX_SRV/templates/$NAME.json" >/dev/null || fail 'a record without a CA names one'
pass '--egress-ca: passed through and recorded; refused offline or as a key; another CA or none rebuilds'

# 10. guest_home_gitconfig: opt-in, passed as --guest-home-gitconfig; refused without guest_home and
# with skip_git_identity_check (an image that refuses commits must not get its root identity).
spec
run --force || fail 'the default spec failed'
! grep -qx -- --guest-home-gitconfig "$MOCK_STATE/snapshot-args" || fail 'the copy of root git config is on by default'
for bad in '.guest_home_gitconfig = true' '.guest_home_gitconfig = true | .skip_git_identity_check = false | del(.guest_home)' '.guest_home_gitconfig = "yes"'; do
  spec "$bad"
  rc=0; run --force || rc=$?
  [[ "$rc" == 2 ]] || fail "spec '$bad' was not refused (rc $rc)"
done
spec '.guest_home_gitconfig = true'
rc=0; run --force || rc=$?; grep -q 'must not get its root identity' "$TMP/out" || fail 'the skip-identity refusal does not say why'
spec '.guest_home_gitconfig = true | .skip_git_identity_check = false'
run --force || fail "a gitconfig spec failed: $(cat "$TMP/out")"
grep -qx -- --guest-home-gitconfig "$MOCK_STATE/snapshot-args" || fail 'build-snapshot did not get --guest-home-gitconfig'
jq -e '.guest_home_gitconfig == true' "$SBX_SRV/templates/$NAME.json" >/dev/null || fail 'the record lacks guest_home_gitconfig'
spec '.skip_git_identity_check = false'
run || fail 'switching it off failed'
grep -q build-snapshot "$MOCK_LOG" || fail 'switching guest_home_gitconfig off was taken as already built'
pass 'guest_home_gitconfig: off by default, passed through, recorded; refused without guest_home or with skip_git_identity_check'

# 11. --gate-record (governance/GATING-RULES.md X1, X5, X10, X12): the gate record is checked against
# the spec before anything is pulled, and its evidence is carried in the template record.
gate() { # gate [jq filter]: a gate record as an image builder writes one, for this test's image
  jq -n --arg d "$DIGEST" '{schema: "example-builder/moca-microvm/1",
    image: {repository: "images/moca-microvm", digest: $d},
    testbed_image: {digest: "sha256:'"$(printf 'e%.0s' {1..64})"'"},
    recipe: {dockerfile_sha256: "d1", platform_layer_sha256: "p1", emitter: "oci-moca-microvm/1"},
    builder: {arch: "x86_64", engine: "podman", network: "host"}, built_at: "2026-10-15T00:00:00Z",
    gate: {passed: true, kind: "guest emulation", network: "none", rootfs: "read-only", user: "root"},
    observed: {testbed: {agent_can_commit: "no", commit_count: "1"}, guest: {git_identity: "none"}}}' |
    jq "${1:-.}" >"$TMP/gate.json"
}
spec ".source_record_digest = \"$DIGEST\" | .probe_status = \"vm\" | .proved_in_vm = true"
gate
run --force --gate-record "$TMP/gate.json" --gate-commit abc1234 || fail "a passing gate record failed: $(cat "$TMP/out")"
R="$SBX_SRV/templates/$NAME.json"
jq -e --arg d "$DIGEST" '.source_record_digest == $d and .probe_status == "vm" and .proved_in_vm == true
  and .skip_git_identity_check == true and .gate_record.passed == true and .gate_record.network == "none"
  and .gate_record.schema == "example-builder/moca-microvm/1" and .gate_record.commit == "abc1234"
  and .gate_record.commits_refused == true and (.gate_record.sha256 | startswith("sha256:"))
  and .gate_record.recipe.dockerfile_sha256 == "d1" and (.gate_record.base_digest | startswith("sha256:eee"))' "$R" >/dev/null ||
  fail "the record lacks the gate evidence: $(jq -c '{source_record_digest, gate_record}' "$R")"
GATE_SHA1="$(jq -r .gate_record.sha256 "$R")"
# The same snapshot cited against a changed gate record: the record is rewritten, the snapshot is not.
gate '.built_at = "2026-10-16T00:00:00Z"'
run --gate-record "$TMP/gate.json" || fail 'a changed gate record failed'
! grep -q build-snapshot "$MOCK_LOG" || fail 'a changed gate record rebuilt the snapshot'
[[ "$(jq -r .gate_record.sha256 "$R")" != "$GATE_SHA1" ]] || fail 'a changed gate record was not written into the record'
pass '--gate-record: the evidence (passed, how, base, recipe, builder, sha256, commit, commits refused) lands in the record; a new gate record rewrites it without a rebuild'

refused() { # refused WHY SPEC_FILTER GATE_FILTER [ARGS]: exit 2, saying WHY, before any pull
  spec "$2"; gate "$3"; local rc=0
  run --force "${@:4}" || rc=$?
  [[ "$rc" == 2 ]] && grep -q -- "$1" "$TMP/out" || fail "not refused ($1): rc $rc, $(cat "$TMP/out")"
  ! grep -q podman "$MOCK_LOG" || fail "pulled before refusing ($1)"
}
OK=".source_record_digest = \"$DIGEST\""
refused 'is not the image' ".source_record_digest = \"sha256:$(printf 'f%.0s' {1..64})\"" . --gate-record "$TMP/gate.json"
refused 'build it with --gate-record' "$OK" .
refused 'did not pass (X1)' "$OK" '.gate.passed = false' --gate-record "$TMP/gate.json"
refused "is for image sha256:000" "$OK" '.image.digest = "sha256:'"$(printf '0%.0s' {1..64})"'"' --gate-record "$TMP/gate.json"
refused 'does not show commits refused' "$OK" '.observed.testbed.agent_can_commit = "yes"' --gate-record "$TMP/gate.json"
refused 'does not show commits refused' "$OK" '.observed.guest.git_identity = "Builder <b@example.invalid>"' --gate-record "$TMP/gate.json"
# Fails closed: a record that never measured the guest's identity is no evidence.
refused 'does not show commits refused' "$OK" 'del(.observed.guest.git_identity)' --gate-record "$TMP/gate.json"
refused 'does not show commits refused' "$OK" 'del(.observed.guest)' --gate-record "$TMP/gate.json"
refused 'needs --gate-record' . . --gate-commit abc1234
pass '--gate-record refuses, before any pull: a source_record_digest that is not the image (X10), a gated spec built without its record, a failed gate (X1), another image, commits not refused under skip_git_identity_check (X5, X12), --gate-commit alone'

# A spec with no source_record_digest and no --gate-record builds as before, with no gate_record.
spec
run --force || fail 'a spec without gate evidence no longer builds'
jq -e 'has("gate_record") | not' "$SBX_SRV/templates/$NAME.json" >/dev/null || fail 'a record without a gate record names one'
pass 'a spec without gate evidence builds as before, and its record names no gate record'
