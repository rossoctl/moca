#!/bin/sh
# Checks src/greet.py. Fails until greet("Ada") returns "Hello, Ada!".
cd "$(dirname "$0")" || exit 1
PYTHONDONTWRITEBYTECODE=1 python3 -c '
import sys
sys.path.insert(0, "src")
from greet import greet
got, want = greet("Ada"), "Hello, Ada!"
if got != want:
    sys.exit("FAIL: greet(\"Ada\") returned %r, want %r" % (got, want))
print("PASS: greet(\"Ada\") returned %r" % got)
'
