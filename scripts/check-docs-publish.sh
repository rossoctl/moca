#!/usr/bin/env bash
# check-docs-publish.sh: fail when a docs/ file that rossoctl.dev publishes matches
# docs/.publish-denylist.
#
# rossoctl.dev's Moca section (/moca/*) is synced from docs/ by rossoctl/.github's
# scripts/sync-docs.sh. That sync leaves out the design records listed in EXCLUDED below,
# and skips the WHOLE section when any other file matches the denylist (or SBX[0-9]). This
# runs the same check here, so a docs change cannot take the site's Moca section down.
# Keep EXCLUDED in step with MOCA_EXCLUDED in that script.
#
# Usage: scripts/check-docs-publish.sh   (from the repository root; offline, read-only)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
EXCLUDED='^docs/(specs|notes|plans|archive|demos|adrs)/|^docs/REORG-PLAN\.md$|^docs/\.publish-denylist$|^docs/_internal/'

patterns="$(mktemp)"
trap 'rm -f "$patterns"' EXIT
echo 'SBX[0-9]' >"$patterns"
grep -vE '^[[:space:]]*(#|$)' docs/.publish-denylist >>"$patterns" || true

published=()
while IFS= read -r f; do
  published+=("$f")
done < <(git ls-files docs | grep -vE "$EXCLUDED")

if hits="$(grep -nIE -f "$patterns" -- "${published[@]}")"; then
  printf '%s\n' "$hits" | cut -c1-200 >&2
  echo "docs-publish: $(printf '%s\n' "$hits" | cut -d: -f1 | sort -u | wc -l | tr -d ' ') published file(s) match docs/.publish-denylist; rossoctl.dev would skip the Moca section" >&2
  exit 1
fi
echo "docs-publish: ${#published[@]} published file(s), none matches docs/.publish-denylist"
