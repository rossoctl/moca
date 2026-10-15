#!/bin/sh
# SPIKE: fetch every change made in the sandbox since the last push, as a git patch.
# Writes .sbx.patch; with --apply, also applies it to this working tree.
set -eu
SBX_URL="${SBX_URL:-http://localhost:8787}"
cd "$(git rev-parse --show-toplevel)"
curl -fsS "$SBX_URL/pull" > .sbx.patch
if [ ! -s .sbx.patch ]; then echo "no changes in the sandbox"; rm -f .sbx.patch; exit 0; fi
git apply --stat .sbx.patch
if [ "${1:-}" = "--apply" ]; then git apply .sbx.patch && rm .sbx.patch && echo "applied"; else echo "wrote .sbx.patch (re-run with --apply to apply it)"; fi
