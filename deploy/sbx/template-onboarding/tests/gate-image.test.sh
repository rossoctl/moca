#!/usr/bin/env bash
# Tests for deploy/sbx/template-onboarding/gate-image.py, the general gate (GUIDE.md §4b.5): its unit
# tests and one CLI run against a fake podman, in gate_image_test.py (Python 3's standard library only,
# no engine, image or network). This wrapper is what `make test-deploy` runs.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v python3 >/dev/null || { echo 'FAIL: python3 is required' >&2; exit 1; }
python3 -m unittest discover -s "$HERE" -p 'gate_image_test.py'
echo 'ok - gate-image.py'
