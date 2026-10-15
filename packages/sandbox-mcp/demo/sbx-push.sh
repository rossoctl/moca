#!/bin/sh
# SPIKE: replace the sandbox's /workspace with this repo's working tree (tracked + untracked,
# minus .gitignore'd files and .git). The sandbox commits it as the baseline sbx-pull.sh diffs.
set -eu
SBX_URL="${SBX_URL:-http://localhost:8787}"
cd "$(git rev-parse --show-toplevel)"
git ls-files -z --cached --others --exclude-standard \
  | COPYFILE_DISABLE=1 tar `# macOS tar: no ._ AppleDouble files` \
 --null -T - -czf - \
  | curl -fsS --data-binary @- -H 'content-type: application/gzip' "$SBX_URL/push" \
  | { read -r rev; read -r files; echo "pushed $files files (sandbox baseline $rev)"; }
