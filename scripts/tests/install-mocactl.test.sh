#!/usr/bin/env bash
# Network-free test for scripts/install-mocactl.sh. Mocks curl and node onto a PATH that holds
# nothing else but the plain tools the script needs, runs the script the way the one-liner does
# (under sh, from a pipe), and asserts on the URLs it fetched and the files it left behind. Same
# approach as deploy/compose/tests/install.test.sh.
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install-mocactl.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "ok - $*"; }

# The real digest tool, for building fixtures before PATH is narrowed.
if command -v sha256sum >/dev/null 2>&1; then digest() { sha256sum "$1" | cut -d' ' -f1; }; else
  digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

# Release fixtures, laid out the way GitHub serves them under MOCACTL_BASE_URL. Each fake bundle's
# second line carries the version the mock node prints for `mocactl --version`.
REL="$TMP/releases"
fixture() { # fixture <url dir> <version> [bad]
  mkdir -p "$REL/$1"
  printf '#!/usr/bin/env node\n// version %s\n' "$2" >"$REL/$1/mocactl.mjs"
  if [[ "${3-}" == bad ]]; then
    printf '%064d  mocactl.mjs\n' 0 >"$REL/$1/mocactl.mjs.sha256"
  else
    printf '%s  mocactl.mjs\n' "$(digest "$REL/$1/mocactl.mjs")" >"$REL/$1/mocactl.mjs.sha256"
  fi
}
fixture latest/download v0.6.0
fixture download/mocactl-edge edge-abc1234
fixture download/v0.6.0 v0.6.0
fixture download/v0.0.9 v0.0.9 bad
fixture download/v0.0.8 '' # runs, but prints no version: what Node does to an ESM file it loads as CommonJS
# download/v0.5.1 deliberately absent: a release cut before the workflow existed has no assets.

# Plain tools, symlinked: PATH below is these dirs alone, so no real curl or node can stand in for a
# mock. `tools` has everything but a digest tool; sha256sum and shasum each get their own dir so a
# case can offer one, the other, or neither.
mkdir -p "$TMP/tools" "$TMP/sha256sum" "$TMP/shasum" "$TMP/node" "$TMP/curl"
for cmd in cat chmod cp cut env head ln mkdir mktemp mv rm sed sh tr; do
  real="$(command -v "$cmd")" && ln -s "$real" "$TMP/tools/$cmd"
done
real="$(command -v sha256sum 2>/dev/null)" && ln -s "$real" "$TMP/sha256sum/sha256sum"
real="$(command -v shasum 2>/dev/null)" && ln -s "$real" "$TMP/shasum/shasum"
[[ -e "$TMP/sha256sum/sha256sum" || -e "$TMP/shasum/shasum" ]] || fail "this host has no digest tool"

# curl: serve the fixture named by the URL's path under MOCACTL_BASE_URL, or fail like curl -f. Every
# fetch must be pinned to https, redirects included (GitHub's download URLs always redirect), so a
# fetch without --proto '=https' fails here like curl's own "protocol not supported".
cat >"$TMP/curl/curl" <<MOCK
#!/bin/sh
out=''
url=''
proto=''
while [ \$# -gt 0 ]; do
  case "\$1" in
  -o) out="\$2"; shift 2 ;;
  --proto) proto="\$2"; shift 2 ;;
  -*) shift ;;
  *) url="\$1"; shift ;;
  esac
done
printf 'curl %s\n' "\$url" >>"\$MOCK_LOG"
[ "\$proto" = '=https' ] || { echo "mock curl: fetched without --proto '=https': \$url" >&2; exit 1; }
src="$REL/\${url#https://example.invalid/releases/}"
[ -f "\$src" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
cp "\$src" "\$out"
MOCK
# node: `node -p …` reports MOCK_NODE_VERSION (MOCK_NODE_VERSION=garbage for an unparseable one);
# `node <file> --version` prints the version line of the fake bundle it was handed.
cat >"$TMP/node/node" <<'MOCK'
#!/bin/sh
if [ "$1" = -p ]; then printf '%s\n' "${MOCK_NODE_VERSION:-22.11.0}"; exit 0; fi
sed -n 's|^// version ||p' "$1"
MOCK
chmod +x "$TMP/curl/curl" "$TMP/node/node"

DEFAULT_PATH="$TMP/tools:$TMP/curl:$TMP/node:$TMP/sha256sum:$TMP/shasum"
unset MOCACTL_VERSION MOCACTL_INSTALL_DIR MOCK_NODE_VERSION 2>/dev/null || true
export MOCACTL_BASE_URL="https://example.invalid/releases"
export TMPDIR="$TMP/tmpdir"

# run_install [PATH]: a fresh HOME and log for every run; output in $TMP/out, exit status in $status.
run_install() {
  rm -rf "${TMP:?}/home" "${TMPDIR:?}" && mkdir -p "$TMP/home" "$TMPDIR"
  : >"$MOCK_LOG"
  set +e
  HOME="$TMP/home" SHELL=/bin/zsh PATH="${1:-$DEFAULT_PATH}" sh <"$SCRIPT" >"$TMP/out" 2>&1
  status=$?
  set -e
}
out_has() { grep -qF -- "$1" "$TMP/out" || fail "output lacks '$1':"$'\n'"$(cat "$TMP/out")"; }
installed() { echo "$TMP/home/.local/bin/mocactl"; }
assert_nothing_installed() {
  [[ ! -d "$TMP/home/.local/bin" || -z "$(ls -A "$TMP/home/.local/bin")" ]] ||
    fail "a failed run left a file in the install dir: $(ls -A "$TMP/home/.local/bin")"
  [[ -z "$(ls -A "$TMPDIR")" ]] || fail "a failed run left its temp dir behind: $(ls -A "$TMPDIR")"
}

# 1. Default: the latest release, installed executable under ~/.local/bin, with the PATH hint.
run_install
[[ $status -eq 0 ]] || fail "default install exited $status: $(cat "$TMP/out")"
grep -qx "curl $MOCACTL_BASE_URL/latest/download/mocactl.mjs" "$MOCK_LOG" || fail "did not fetch latest: $(cat "$MOCK_LOG")"
grep -qx "curl $MOCACTL_BASE_URL/latest/download/mocactl.mjs.sha256" "$MOCK_LOG" || fail "did not fetch the checksum"
[[ -x "$(installed)" ]] || fail "mocactl is not installed executable"
# The bundle keeps its .mjs name and mocactl is a relative symlink to it: Node picks the module type
# of the real path, so an extensionless file would load as CommonJS under a "type": "commonjs"
# package.json above it, or on Node 22.0-22.6, and print nothing (packages/mocactl/test/bundle.test.ts).
[[ -L "$(installed)" && "$(readlink "$(installed)")" == mocactl.mjs ]] ||
  fail "mocactl is not a relative symlink to mocactl.mjs"
cmp -s "$(installed).mjs" "$REL/latest/download/mocactl.mjs" || fail "installed file differs from the release asset"
out_has "installed mocactl v0.6.0"
out_has "export PATH=\"$TMP/home/.local/bin:\$PATH\""
# shellcheck disable=SC2088 # the literal text of the hint, not a path
out_has "~/.zshrc"
out_has "SH_CONTROL_PLANE_URL"
[[ -z "$(ls -A "$TMPDIR")" ]] || fail "a successful run left its temp dir behind"
pass "default installs the latest release, with the PATH hint"

# 2. Edge and a pinned tag.
MOCACTL_VERSION=edge run_install
[[ $status -eq 0 ]] || fail "edge exited $status"
grep -qx "curl $MOCACTL_BASE_URL/download/mocactl-edge/mocactl.mjs" "$MOCK_LOG" || fail "did not fetch edge"
out_has "installed mocactl edge-abc1234"
MOCACTL_VERSION=v0.6.0 run_install
[[ $status -eq 0 ]] || fail "pinned tag exited $status"
grep -qx "curl $MOCACTL_BASE_URL/download/v0.6.0/mocactl.mjs" "$MOCK_LOG" || fail "did not fetch the tag"
pass "edge and a pinned tag resolve to their release URLs"

# 3. A version that is not latest, edge or a tag is refused before any download.
for bad in '1.0' 'v1;rm -rf x' 'v1/../../x' 'nightly'; do
  MOCACTL_VERSION="$bad" run_install
  [[ $status -ne 0 ]] || fail "accepted MOCACTL_VERSION='$bad'"
  [[ ! -s "$MOCK_LOG" ]] || fail "downloaded for MOCACTL_VERSION='$bad'"
  out_has "MOCACTL_VERSION must be latest, edge or a release tag"
done
pass "an invalid MOCACTL_VERSION is refused before any download"

# 4. A release without the asset (404) and a checksum mismatch both install nothing.
MOCACTL_VERSION=v0.5.1 run_install
[[ $status -ne 0 ]] || fail "a missing asset exited 0"
out_has "v0.5.1"
assert_nothing_installed
MOCACTL_VERSION=v0.0.9 run_install
[[ $status -ne 0 ]] || fail "a checksum mismatch exited 0"
out_has "checksum mismatch"
assert_nothing_installed
# The latest release predating the asset: the hint must point at edge, not back at latest.
MOCACTL_BASE_URL="https://example.invalid/releases/none" run_install
[[ $status -ne 0 ]] || fail "a latest release with no asset exited 0"
out_has "MOCACTL_VERSION=edge"
if grep -qF "MOCACTL_VERSION=latest" "$TMP/out"; then fail "told a user on latest to try latest"; fi
assert_nothing_installed
pass "a 404 or a checksum mismatch installs nothing and cleans up"

# 5. Node: too old, version unreadable, absent.
MOCK_NODE_VERSION=20.11.0 run_install
[[ $status -ne 0 ]] || fail "accepted Node 20"
out_has "needs Node.js 22 or later, and found 20.11.0"
assert_nothing_installed
MOCK_NODE_VERSION=garbage run_install
[[ $status -ne 0 ]] || fail "accepted an unreadable node version"
out_has "could not read a version from"
run_install "$TMP/tools:$TMP/curl:$TMP/sha256sum:$TMP/shasum"
[[ $status -ne 0 ]] || fail "ran without node"
out_has "found no \`node\` on PATH"
assert_nothing_installed
pass "a missing, unreadable or too-old Node is refused"

# 6. Digest tools: shasum alone (stock macOS) works; neither is refused.
run_install "$TMP/tools:$TMP/curl:$TMP/node:$TMP/shasum"
if [[ -e "$TMP/shasum/shasum" ]]; then
  [[ $status -eq 0 ]] || fail "shasum-only install exited $status: $(cat "$TMP/out")"
  pass "a machine with only shasum installs"
fi
run_install "$TMP/tools:$TMP/curl:$TMP/node"
[[ $status -ne 0 ]] || fail "installed with no digest tool"
out_has "needs sha256sum or shasum"
pass "a machine with no digest tool is refused"

# 7. An install dir on PATH gets no hint; one with a space in it works.
MOCACTL_INSTALL_DIR="$TMP/on path" run_install "$TMP/on path:$DEFAULT_PATH"
[[ $status -eq 0 ]] || fail "install into a dir with a space exited $status: $(cat "$TMP/out")"
[[ -x "$TMP/on path/mocactl" ]] || fail "not installed into the dir with a space"
if grep -qF "export PATH" "$TMP/out"; then fail "printed the PATH hint for a dir already on PATH"; fi
pass "an install dir with a space, already on PATH, installs with no hint"

# 8. A re-run upgrades in place and leaves no temp file.
mkdir -p "$TMP/keep"
MOCACTL_INSTALL_DIR="$TMP/keep" run_install
MOCACTL_INSTALL_DIR="$TMP/keep" MOCACTL_VERSION=edge run_install
[[ $status -eq 0 ]] || fail "re-run exited $status"
cmp -s "$TMP/keep/mocactl.mjs" "$REL/download/mocactl-edge/mocactl.mjs" || fail "re-run did not replace the file"
[[ "$(readlink "$TMP/keep/mocactl")" == mocactl.mjs ]] || fail "re-run broke the mocactl symlink"
[[ ! -e "$TMP/keep/mocactl.mjs.tmp" && ! -e "$TMP/keep/mocactl.tmp" ]] || fail "re-run left a temp file"
pass "a re-run upgrades in place"

# 9. A bundle that runs but prints no version is reported as broken, never as installed.
MOCACTL_VERSION=v0.0.8 run_install
[[ $status -ne 0 ]] || fail "an install whose mocactl printed no version exited 0"
out_has "printed no version"
if grep -qF "==> installed mocactl" "$TMP/out"; then fail "reported a silent mocactl as installed"; fi
pass "a mocactl that prints no version fails the install"

echo "all install-mocactl.sh tests passed"
