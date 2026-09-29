#!/usr/bin/env bash
# The images docker-compose.yml defaults to must exist and must be able to run what the compose
# file asks of them (#342). Both are facts about OTHER files -- the root Dockerfile and the
# build.yaml publish matrix -- which is exactly why they drift: nothing in either one knows the
# compose file depends on it. A `curl | sh` user has no checkout to build from, so a default image
# that is never published, or that cannot start the supervisor, fails on their machine only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/deploy/compose/docker-compose.yml"
DOCKERFILE="$REPO_ROOT/Dockerfile"
BUILD_WORKFLOW="$REPO_ROOT/.github/workflows/build.yaml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "ok - $*"; }

# --- 1. every default image is one build.yaml publishes ----------------------------------------
defaults="$(grep -oE '\$\{SH_[A-Z_]+_IMAGE:-[^}]+\}' "$COMPOSE_FILE" | sed -E 's/.*:-([^}]+)\}/\1/' | sort -u)"
[[ -n "$defaults" ]] || fail "found no \${SH_*_IMAGE:-default} in the compose file; this check would be vacuous"
published="$(grep -oE '^ +- image: [^ ]+' "$BUILD_WORKFLOW" | awk '{print $3}')"
[[ -n "$published" ]] || fail "found no matrix images in build.yaml; this check would be vacuous"
while read -r ref; do
  repo="${ref%:*}"
  grep -qxF "$repo" <<<"$published" ||
    fail "docker-compose.yml defaults to $ref, but build.yaml never publishes $repo"
  [[ "${ref##*:}" == latest ]] ||
    fail "$ref: build.yaml only tags :latest (and main-<sha>/semver) on main, so pin one of those"
done <<<"$defaults"
pass "every image docker-compose.yml defaults to is published by build.yaml"

# --- 2. the harness image installs the supervisor's and relay's dependencies ---------------------
# The Dockerfile copies workspace manifests one by one before `pnpm install --frozen-lockfile`, for
# layer caching. A package whose manifest is not among them gets no node_modules at all -- so no
# tsx, and `node --import tsx src/main.ts` in its working_dir dies at startup. The compose file
# runs from packages/supervisor and packages/sandbox-relay, and the supervisor forks
# packages/knative-server/src/worker.ts; each of those, and every workspace package they depend on,
# needs its manifest in before the install.
install_line="$(grep -nE '^RUN pnpm install' "$DOCKERFILE" | head -1 | cut -d: -f1)"
[[ -n "$install_line" ]] || fail "no 'RUN pnpm install' in $DOCKERFILE"
copied="$(head -n "$install_line" "$DOCKERFILE" | grep -oE '^COPY [^ ]+/package\.json' | awk '{print $2}')"

# Workspace packages, by name -> dir, from the manifests themselves.
declare -A DIR_OF
for manifest in "$REPO_ROOT"/packages/*/package.json "$REPO_ROOT"/harness/package.json; do
  name="$(sed -nE 's/^  "name": "([^"]+)".*/\1/p' "$manifest")"
  DIR_OF[$name]="$(dirname "${manifest#"$REPO_ROOT/"}")"
done
queue=(packages/supervisor packages/sandbox-relay packages/knative-server)
declare -A SEEN
while ((${#queue[@]})); do
  dir="${queue[0]}"
  queue=("${queue[@]:1}")
  [[ -z "${SEEN[$dir]:-}" ]] || continue
  SEEN[$dir]=1
  grep -qxF "$dir/package.json" <<<"$copied" ||
    fail "Dockerfile does not COPY $dir/package.json before 'pnpm install', so the image has no" \
      "node_modules for $dir and the compose service running it cannot load tsx"
  while read -r dep; do
    [[ -n "$dep" && -n "${DIR_OF[$dep]:-}" ]] && queue+=("${DIR_OF[$dep]}")
  done < <(grep -oE '"@moca/[^"]+": "workspace:' "$REPO_ROOT/$dir/package.json" | cut -d'"' -f2)
done
pass "the harness image installs dependencies for all ${#SEEN[@]} workspace packages compose runs"

# --- 3. the remote-worker image's Go toolchain satisfies go.work ---------------------------------
# The builder runs with GOTOOLCHAIN=local, so a golang:X base older than go.work's `go` line fails
# the build outright ("go.work requires go >= ..."). ci.yml takes its Go from go-version-file and
# never builds this Dockerfile, so the drift is invisible until someone -- or build.yaml's publish
# of the sandbox image compose defaults to -- actually builds it.
need="$(sed -nE 's/^go ([0-9]+\.[0-9]+).*/\1/p' "$REPO_ROOT/go.work")"
[[ -n "$need" ]] || fail "no go line in go.work"
have="$(sed -nE 's/^FROM golang:([0-9]+\.[0-9]+).*/\1/p' "$REPO_ROOT/remote-worker/Dockerfile" | head -1)"
[[ -n "$have" ]] || fail "remote-worker/Dockerfile: no FROM golang:<version> builder stage"
[[ "$(printf '%s\n%s\n' "$need" "$have" | sort -t. -k1,1n -k2,2n | head -1)" == "$need" ]] ||
  fail "remote-worker/Dockerfile builds with golang:$have but go.work requires go $need"
pass "remote-worker/Dockerfile's golang base satisfies go.work's go $need"
