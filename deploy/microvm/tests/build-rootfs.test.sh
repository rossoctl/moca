#!/usr/bin/env bash
# deploy/microvm/tests/build-rootfs.test.sh
#
# Root-free, podman-free test for build-rootfs.sh. podman and id are mocked onto PATH; the mock
# `podman export` streams a tar of a fixture tree, so the test checks what the script does with an
# image's filesystem without having one.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/build-rootfs.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  fails=$((fails + 1))
fi; }

export MOCK_LOG="$TMP/mock.log" FIXTURE="$TMP/fixture"
mkdir -p "$TMP/bin"
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
printf 'podman %s\n' "$*" >>"$MOCK_LOG"
# MOCK_PULL_FAIL makes `podman pull` fail, as an offline host or a private registry does;
# MOCK_NO_LOCAL_IMAGE makes `image exists` fail, which is what a host holding no copy reports.
case "$1 ${2:-}" in
  "image exists") [ -z "${MOCK_NO_LOCAL_IMAGE:-}" ] || exit 1 ;;
  "pull "*) [ -z "${MOCK_PULL_FAIL:-}" ] || { echo "mock: unauthorized" >&2; exit 1; } ;;
  "image inspect") echo "sha256:0123abcd" ;;
  "create "*) echo "cid-42" ;;
  "export "*) tar -C "$FIXTURE" -cf - . ;;
  "rm "*) : ;;
esac
MOCK
cat >"$TMP/bin/id" <<'MOCK'
#!/usr/bin/env bash
[ "$*" = "-u" ] && echo "${MOCK_UID:-0}"
MOCK
chmod +x "$TMP/bin/podman" "$TMP/bin/id"
export PATH="$TMP/bin:$PATH"

make_fixture() { # make_fixture <tool>... : an image tree carrying exactly these tools
  rm -rf "$FIXTURE"
  mkdir -p "$FIXTURE/usr/bin" "$FIXTURE/usr/local/bin" "$FIXTURE/etc" "$FIXTURE/workspace"
  local t
  for t in "$@"; do printf '#!/bin/sh\n' >"$FIXTURE/usr/bin/$t"; chmod +x "$FIXTURE/usr/bin/$t"; done
  printf 'bin\n' >"$FIXTURE/usr/local/bin/remote-worker"; chmod +x "$FIXTURE/usr/local/bin/remote-worker"
}
# The script's own REQUIRED_TOOLS, read from it rather than copied: a hand-kept duplicate here
# would let the two drift apart with every test still green.
read -r -a ALL_TOOLS <<<"$(sed -nE 's/^REQUIRED_TOOLS=\((.*)\)$/\1/p' "$SCRIPT")"

echo "== REQUIRED_TOOLS covers every capability the container tier advertises"
# Pinned against cmd/worker's own `probed` list, as build-snapshot.test.sh pins the guest probe: a
# tool added to the container tier must also be required of the rootfs, or build-rootfs.sh keeps
# producing a tree that lacks it and the gap surfaces as a failed tool call. A superset, not
# equality: ls and cat are there for the harness's own file ops.
# `"bash", "rg", ...` -> `bash rg ...`
container_caps="$(sed -nE 's/^var probed = \[\]string\{(.*)\}$/\1/p' \
  "$DIR/../../remote-worker/cmd/worker/main.go" | tr -d '"' | tr ',' ' ')"
check "REQUIRED_TOOLS was found in the script" "$([ "${#ALL_TOOLS[@]}" -gt 0 ] && echo yes || echo no)" "yes"
check "the container tier's probed list was found" "$([ -n "$container_caps" ] && echo yes || echo no)" "yes"
for cap in $container_caps; do
  check "REQUIRED_TOOLS includes '$cap'" \
    "$(printf ' %s ' "${ALL_TOOLS[@]}" | grep -qF " $cap " && echo yes || echo no)" "yes"
done

echo "== shellcheck"
if command -v shellcheck >/dev/null; then
  shellcheck "$SCRIPT"; check "shellcheck clean" "$?" "0"
fi

echo "== a complete image becomes a rootfs tree"
make_fixture "${ALL_TOOLS[@]}"
: >"$MOCK_LOG"
bash "$SCRIPT" --out "$TMP/out1" --image example/img:1 >"$TMP/run1.log" 2>&1
check "exit 0" "$?" "0"
check "bash carried over" "$([ -x "$TMP/out1/usr/bin/bash" ] && echo yes || echo no)" "yes"
check "the container worker binary is stripped" \
  "$([ -e "$TMP/out1/usr/local/bin/remote-worker" ] && echo present || echo absent)" "absent"
check "provenance names the image" "$(grep -c '^image=example/img:1$' "$TMP/out1/etc/moca-rootfs-source")" "1"
check "provenance records the digest" "$(grep -c '^digest=sha256:0123abcd$' "$TMP/out1/etc/moca-rootfs-source")" "1"
for d in dev proc sys; do
  check "/$d exists as a mount point" "$([ -d "$TMP/out1/$d" ] && echo yes || echo no)" "yes"
done
check "the temporary container is removed" "$(grep -c '^podman rm -f cid-42$' "$MOCK_LOG")" "1"

echo "== --source-name: the recorded image is the caller's host-free name, never the pull reference"
make_fixture "${ALL_TOOLS[@]}"
: >"$MOCK_LOG"
bash "$SCRIPT" --out "$TMP/out-src" --image registry.example.com/team/img@sha256:0123abcd \
  --source-name team/img@sha256:0123abcd >"$TMP/run-src.log" 2>&1
check "exit 0" "$?" "0"
check "pulled the pull reference" "$(grep -c '^podman pull registry.example.com/team/img@sha256:0123abcd$' "$MOCK_LOG")" "1"
check "records the source name" "$(grep -c '^image=team/img@sha256:0123abcd$' "$TMP/out-src/etc/moca-rootfs-source")" "1"
check "no registry host in the guest's file" "$(grep -c 'registry.example.com' "$TMP/out-src/etc/moca-rootfs-source")" "0"
bash "$SCRIPT" --out "$TMP/out-src2" --image example/img:1 --source-name "" >"$TMP/run-src2.log" 2>&1
check "an empty --source-name is refused" "$?" "1"

echo "== the image is re-resolved on every build, not reused because a copy is present (#414)"
# `podman image exists || podman pull` pulled only on a host with NO copy, so a :latest pulled once
# was exported into every later snapshot -- and a snapshot is built once and run for a long time.
# The rig's copy predated #372 (HOME on the shared /workspace), which is the P4 half of #414.
make_fixture "${ALL_TOOLS[@]}"
: >"$MOCK_LOG"
bash "$SCRIPT" --out "$TMP/out-pull" --image example/img:1 >"$TMP/run-pull.log" 2>&1
check "exit 0" "$?" "0"
check "pulled the image" "$(grep -c '^podman pull example/img:1$' "$MOCK_LOG")" "1"
# The guard that let a present copy short-circuit the pull must be gone, not merely reordered.
check "a present local copy no longer skips the pull" \
  "$(grep -c '^podman image exists' "$MOCK_LOG")" "0"

echo "== a failed pull refuses the build, naming SH_SKIP_PULL"
make_fixture "${ALL_TOOLS[@]}"
MOCK_PULL_FAIL=1 bash "$SCRIPT" --out "$TMP/out-pullfail" --image example/img:1 >"$TMP/run-pullfail.log" 2>&1
check "exit 1" "$?" "1"
check "names the override" "$(grep -c 'SH_SKIP_PULL' "$TMP/run-pullfail.log")" "1"
# Refusing is only useful if it refuses BEFORE exporting: a tree built from the stale copy is the
# artifact this check exists to prevent, and leaving a partial one behind is worse than neither.
check "no rootfs tree was written" "$([ -e "$TMP/out-pullfail/usr" ] && echo present || echo absent)" "absent"

echo "== SH_SKIP_PULL builds from the local copy, and refuses when there is none"
make_fixture "${ALL_TOOLS[@]}"
: >"$MOCK_LOG"
SH_SKIP_PULL=1 MOCK_PULL_FAIL=1 bash "$SCRIPT" --out "$TMP/out-skip" --image example/img:1 \
  >"$TMP/run-skip.log" 2>&1
check "exit 0" "$?" "0"
check "did not pull" "$(grep -c '^podman pull' "$MOCK_LOG")" "0"
# The provenance file is what a later operator reads to find out which image a snapshot came from,
# so a skipped pull must not cost them that.
check "provenance still records the digest" \
  "$(grep -c '^digest=sha256:0123abcd$' "$TMP/out-skip/etc/moca-rootfs-source")" "1"
SH_SKIP_PULL=1 MOCK_NO_LOCAL_IMAGE=1 bash "$SCRIPT" --out "$TMP/out-skip2" --image example/img:1 \
  >"$TMP/run-skip2.log" 2>&1
check "exit 1 with no local copy to skip to" "$?" "1"
check "says the host has no copy" "$(grep -c 'no copy of example/img:1' "$TMP/run-skip2.log")" "1"

echo "== an image missing a required tool is refused, naming it"
make_fixture bash git python3 base64 file ls cat # no rg
: >"$MOCK_LOG"
bash "$SCRIPT" --out "$TMP/out2" --image example/img:1 >"$TMP/run2.log" 2>&1
check "exit 1" "$?" "1"
check "names rg" "$(grep -c "missing required tool.*rg" "$TMP/run2.log")" "1"
check "the temporary container is removed on failure too" "$(grep -c '^podman rm -f cid-42$' "$MOCK_LOG")" "1"

echo "== --require replaces the list: a benchmark image without gh builds; a listed tool is still required"
# A template's image carries its own tools plus the guest agent's minimum, not Moca's toolchain:
# gh in the default list refused every benchmark image.
make_fixture bash git python3 rg base64 file ls cat # no gh
bash "$SCRIPT" --out "$TMP/out-req" --image example/img:1 \
  --require "bash git python3 rg ls cat base64 file" >"$TMP/run-req.log" 2>&1
check "exit 0 without gh when gh is not required" "$?" "0"
bash "$SCRIPT" --out "$TMP/out-req2" --image example/img:1 >"$TMP/run-req2.log" 2>&1
check "the default list still requires gh" "$(grep -c 'missing required tool.*gh' "$TMP/run-req2.log")" "1"
make_fixture bash git python3 base64 file ls cat # no rg
bash "$SCRIPT" --out "$TMP/out-req3" --image example/img:1 \
  --require "bash git python3 rg ls cat base64 file" >"$TMP/run-req3.log" 2>&1
check "a tool --require names is still required" "$(grep -c 'missing required tool.*rg' "$TMP/run-req3.log")" "1"
bash "$SCRIPT" --out "$TMP/out-req4" --image example/img:1 --require "bash ../evil" >"$TMP/run-req4.log" 2>&1
check "a path is not a tool name (exit 2)" "$?" "2"

echo "== a non-empty --out is refused and left untouched"
mkdir -p "$TMP/out3"; echo keep >"$TMP/out3/precious"
make_fixture "${ALL_TOOLS[@]}"
bash "$SCRIPT" --out "$TMP/out3" --image example/img:1 >"$TMP/run3.log" 2>&1
check "exit 1" "$?" "1"
check "existing content kept" "$(cat "$TMP/out3/precious")" "keep"

echo "== non-root is refused (ownership inside the image must survive extraction)"
MOCK_UID=1000 bash "$SCRIPT" --out "$TMP/out4" >"$TMP/run4.log" 2>&1
check "exit 1" "$?" "1"
check "names root" "$(grep -c 'must run as root' "$TMP/run4.log")" "1"

if [ "$fails" -eq 0 ]; then echo "PASS"; else echo "FAIL ($fails)"; fi
exit "$fails"
