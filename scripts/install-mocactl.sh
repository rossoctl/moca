#!/bin/sh
# Installs mocactl, the MOCA terminal client, as a single file on PATH
# (docs/specs/2026-10-08-mocactl-installer-design.md §6):
#
#   curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh
#
# It downloads mocactl.mjs (mocactl and all its dependencies in one file) from a GitHub release,
# checks it against the SHA-256 published beside it, and installs it as `mocactl`. Re-running it
# upgrades in place. It needs Node.js 22 or later; it never edits a shell rc file.
#
# POSIX sh, not bash: the one-liner above pipes this file into whatever `sh` the machine has, so
# nothing here may rely on bash, on BASH_SOURCE, or on this file's own location on disk.
#
# Environment (all optional):
#   MOCACTL_VERSION      latest (default: the newest release), edge (a build of main, rebuilt on every
#                        push), or a release tag such as v0.6.0
#   MOCACTL_INSTALL_DIR  Where mocactl is written (default $HOME/.local/bin)
#   MOCACTL_BASE_URL     The releases URL, https only (default https://github.com/rossoctl/moca/releases)
set -eu

: "${MOCACTL_VERSION:=latest}"
: "${MOCACTL_INSTALL_DIR:=$HOME/.local/bin}"
: "${MOCACTL_BASE_URL:=https://github.com/rossoctl/moca/releases}"

NODE_MAJOR_MIN=22

log() { printf '==> %s\n' "$*"; }
die() {
  printf 'install-mocactl.sh: %s\n' "$*" >&2
  exit 1
}

preflight() {
  command -v curl >/dev/null 2>&1 || die "needs curl to download mocactl"
  command -v node >/dev/null 2>&1 ||
    die "needs Node.js $NODE_MAJOR_MIN or later, and found no \`node\` on PATH: install it from" \
      "https://nodejs.org (standalone mocactl binaries that need no Node are planned)"
  node_version="$(node -p 'process.versions.node' 2>/dev/null)" || node_version=''
  node_major="${node_version%%.*}"
  case "$node_major" in
  '' | *[!0-9]*) die "could not read a version from \`node\` (it printed '$node_version')" ;;
  esac
  [ "$node_major" -ge "$NODE_MAJOR_MIN" ] ||
    die "needs Node.js $NODE_MAJOR_MIN or later, and found $node_version: upgrade it from https://nodejs.org"
  # sha256sum on Linux; stock macOS has only shasum.
  if command -v sha256sum >/dev/null 2>&1; then
    SHA256='sha256sum'
  elif command -v shasum >/dev/null 2>&1; then
    SHA256='shasum -a 256'
  else
    die "needs sha256sum or shasum to verify the download"
  fi
}

# Checked before it reaches a URL: a tag is v<digit> followed by tag characters only, so a value like
# `v1/../x` can never point the download somewhere else.
check_version() {
  case "$MOCACTL_VERSION" in
  latest | edge) return 0 ;;
  v[0-9]*) case "$MOCACTL_VERSION" in *[!A-Za-z0-9._-]*) ;; *) return 0 ;; esac ;;
  esac
  die "MOCACTL_VERSION must be latest, edge or a release tag such as v0.6.0 (got '$MOCACTL_VERSION')"
}

# Where GitHub serves the version's assets. Edge is the rolling `mocactl-edge` prerelease, which is
# never "Latest", so latest/download always means the newest real release.
asset_url() {
  case "$MOCACTL_VERSION" in
  latest) printf '%s/latest/download' "$MOCACTL_BASE_URL" ;;
  edge) printf '%s/download/mocactl-edge' "$MOCACTL_BASE_URL" ;;
  *) printf '%s/download/%s' "$MOCACTL_BASE_URL" "$MOCACTL_VERSION" ;;
  esac
}

# What a failed download most likely means, for the channel asked for.
download_hint() {
  case "$MOCACTL_VERSION" in
  latest) printf '%s' "the latest release may predate mocactl's release asset; try MOCACTL_VERSION=edge" ;;
  edge) printf '%s' "the mocactl-edge prerelease may be mid-update; re-run in a minute" ;;
  *) printf '%s' "releases cut before mocactl shipped as a release asset have none; try MOCACTL_VERSION=latest or MOCACTL_VERSION=edge" ;;
  esac
}

download() {
  url="$(asset_url)"
  WORK_DIR="$(mktemp -d)"
  trap 'rm -rf "$WORK_DIR"' EXIT
  log "downloading mocactl ($MOCACTL_VERSION) from $url"
  # https only, redirects included (--proto also bounds them): GitHub's download URLs always redirect,
  # and neither the asset nor its checksum may ever arrive over plain http.
  for file in mocactl.mjs mocactl.mjs.sha256; do
    curl -fsSL --proto '=https' -o "$WORK_DIR/$file" "$url/$file" ||
      die "could not download $file for $MOCACTL_VERSION from $url: $(download_hint)"
  done
}

# Catches a corrupt or truncated download (the checksum comes over the same HTTPS origin, so this is
# not a signature: spec §8).
verify() {
  expected="$(cut -d' ' -f1 <"$WORK_DIR/mocactl.mjs.sha256")"
  actual="$($SHA256 "$WORK_DIR/mocactl.mjs" | cut -d' ' -f1)"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    die "checksum mismatch for mocactl.mjs ($MOCACTL_VERSION): expected '$expected', got '$actual'." \
      "Nothing was installed; re-run to retry the download"
  fi
}

# The bundle keeps its .mjs name and `mocactl` is a relative symlink to it: Node picks a main script's
# module type from its real path, so an extensionless copy would load as CommonJS (on Node 22.0-22.6,
# or under a "type": "commonjs" package.json above it) and print nothing. Each is made beside its
# target and renamed over it: a rename is atomic, so a running mocactl is never half-overwritten and a
# re-run upgrades in place.
install_file() {
  TARGET="$MOCACTL_INSTALL_DIR/mocactl"
  mkdir -p "$MOCACTL_INSTALL_DIR"
  cp "$WORK_DIR/mocactl.mjs" "$TARGET.mjs.tmp"
  chmod 755 "$TARGET.mjs.tmp"
  mv -f "$TARGET.mjs.tmp" "$TARGET.mjs"
  ln -sf mocactl.mjs "$TARGET.tmp"
  mv -f "$TARGET.tmp" "$TARGET"
}

# The rc file a user of this login shell usually puts PATH in. Only named in a hint, never edited.
# shellcheck disable=SC2088 # a path for the user to read, not one to open
rc_file() {
  case "${SHELL:-}" in
  */zsh) printf '~/.zshrc' ;;
  */bash) printf '~/.bashrc' ;;
  *) printf '~/.profile' ;;
  esac
}

report() {
  installed="$("$TARGET" --version)" || die "installed $TARGET, but it does not run: check \`node --version\`"
  [ -n "$installed" ] ||
    die "installed $TARGET, but it printed no version: check \`node --version\` (Node.js $NODE_MAJOR_MIN or later)"
  log "installed mocactl $installed at $TARGET"
  case ":$PATH:" in
  *":$MOCACTL_INSTALL_DIR:"*) ;;
  *)
    log "$MOCACTL_INSTALL_DIR is not on your PATH. Add this line to $(rc_file), then open a new shell:"
    # shellcheck disable=SC2016 # $PATH is meant literally: it is the line the user pastes
    printf '\n    export PATH="%s:$PATH"\n\n' "$MOCACTL_INSTALL_DIR"
    ;;
  esac
  log "next: export SH_CONTROL_PLANE_URL=<your MOCA server's URL>, then run: mocactl"
}

main() {
  check_version
  preflight
  download
  verify
  install_file
  report
}

main "$@"
