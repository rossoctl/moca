#!/usr/bin/env bash
# check-docs-site.sh: build the rossoctl.dev site with this checkout's docs/ as its Moca section,
# the way the site's own deploy does, and fail when the Moca section would not publish or build.
#
# The site (rossoctl/.github) syncs docs/ at build time: scripts/sync-docs.sh copies it, leaves out
# the design records, and skips the whole Moca section when a file matches the publish denylist.
# A docs change can therefore break the live section in ways check-docs-publish.sh (strings) and
# check-doc-links.py (relative links) do not see: Markdown the site cannot build, a sidebar
# _category_.json it rejects, a link or anchor that only breaks once the tree is rewritten. This
# runs the real sync and build and fails on any of those.
#
# Usage: scripts/check-docs-site.sh <site-dir>
#   <site-dir> is a rossoctl/.github checkout with its dependencies installed (npm ci).
#   Network: the sync clones rossoctl/rossoctl and rossoctl/cortex as the deploy does.
set -euo pipefail

site="${1:?usage: check-docs-site.sh <site-dir>}"
repo="$(git rev-parse --show-toplevel)"
log_dir="${LOG_DIR:-$(mktemp -d)}"
mkdir -p "$log_dir"

echo "docs-site: syncing $repo/docs into $site/moca"
if ! (cd "$site" && MOCA_SRC_REPO="$repo" npm run --silent sync-docs) >"$log_dir/sync.log" 2>&1; then
  cat "$log_dir/sync.log" >&2
  echo "docs-site: the site's sync failed" >&2
  exit 1
fi
grep -E 'moca|Moca|!!' "$log_dir/sync.log" || true
if [[ ! -f "$site/moca/index.md" ]]; then
  echo "docs-site: the sync did not publish the Moca section (see the lines above): rossoctl.dev would drop it" >&2
  exit 1
fi

echo "docs-site: building the site"
if ! (cd "$site" && npm run --silent build) >"$log_dir/build.log" 2>&1; then
  tail -60 "$log_dir/build.log" >&2
  echo "docs-site: the site build failed with this docs/ (full log: $log_dir/build.log)" >&2
  exit 1
fi

# The site builds with onBrokenLinks/onBrokenMarkdownLinks set to 'warn', so a broken Moca link
# is a warning there, never an error: make it one here. Other sections' warnings are not ours.
broken="$(grep -E 'in source file "[^"]*moca/|source page path = /moca/' "$log_dir/build.log" || true)"
if [[ -n "$broken" ]]; then
  printf '%s\n' "$broken" >&2
  echo "docs-site: the build reports broken links or anchors in the Moca section" >&2
  exit 1
fi
pages="$(find "$site/build/moca" -name index.html | wc -l | tr -d ' ')"
echo "docs-site: the Moca section publishes and builds: $pages pages, no broken links"
