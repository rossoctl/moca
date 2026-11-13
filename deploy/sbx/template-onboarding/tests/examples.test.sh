#!/usr/bin/env bash
# Tests for deploy/sbx/template-onboarding/examples/: every sample is a template spec whose fields
# the control plane's create rules accept (governance/GATING-RULES.md M1, M7, M8, M9, checked here
# field by field with jq), names no registry host, account id or token, and a gate record shipped
# beside a sample is the one its spec names (X10). The control plane's own test
# (packages/control-plane/test/template-create.test.ts) creates both samples through the policy.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TPL="$SRC/deploy/sbx/template-onboarding"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
command -v jq >/dev/null || fail 'jq is required'

# M1 as the policy reads it (isPinnedImage in packages/control-plane/src/template-policy.ts): the
# distribution reference grammar, an optional host[:port]/ (a first component with a `.` or a `:`,
# or localhost), lowercase path components, no tag, pinned by digest, at most 255 characters before
# the `@`.
M1_JQ='(split("@")[0] | length) <= 255 and test("^(?:(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?))+(?::[0-9]+)?|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?):[0-9]+|localhost(?::[0-9]+)?)/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[0-9a-f]{64}$")'

# The M1 filter itself, on references the policy's test accepts and refuses.
D="@sha256:$(printf '0%.0s' {1..64})"
for ok in "images/x$D" "ghcr.io/a/b-c$D" "GHCR.io/x$D" "localhost:5000/x$D" "a__b/c.d$D"; do
  jq -en --arg r "$ok" "\$r | $M1_JQ" >/dev/null || fail "M1 refuses $ok"
done
for bad in "Images/X$D" "-x$D" "a//b$D" "../x$D" "x:tag$D" "ghcr.io/x:1$D" "x" "x@sha256:abc" \
  "$(printf 'a%.0s' {1..256})$D"; do
  ! jq -en --arg r "$bad" "\$r | $M1_JQ" >/dev/null || fail "M1 accepts $bad"
done
pass 'the M1 check takes the distribution reference grammar, pinned by digest, no tag'

# check SPEC: the fields the create rules read, each well formed (M1, M7, M8, M9).
check() {
  local spec="$1" name
  name="$(basename "$spec")"
  jq -e '.schema == "moca-sbx-template-spec/1"' "$spec" >/dev/null || fail "$name is not a spec"
  jq -e '.id | test("^[a-z0-9][a-z0-9-]{0,30}$")' "$spec" >/dev/null || fail "$name: id (M7)"
  jq -e ".image | strings | $M1_JQ" "$spec" >/dev/null ||
    fail "$name: image not a reference pinned by digest (M1)"
  # Parenthesized throughout: jq 1.8 parses `a and b as $g | c` differently from 1.6 and 1.7.
  jq -e '((has("guest_mb") and has("guest_ram_mb")) | not) and
    ((.guest_mb // .guest_ram_mb) as $g | ($g | type) == "number" and $g >= 128) and
    (.vcpus | type) == "number" and .vcpus >= 1 and .vcpus <= 32' "$spec" >/dev/null ||
    fail "$name: guest size or vcpus (M7)"
  jq -e '(.egress | type) == "boolean" and (.seed | type) == "string" and
    (.description | type) == "string" and (.description | length) > 0' "$spec" >/dev/null ||
    fail "$name: egress, seed or description (M7)"
  jq -e '(.tools | type) == "array" and (.tools | length) == (.tools | unique | length)' \
    "$spec" >/dev/null || fail "$name: tools (M7)"
  jq -e '.probe | (.cmd | type) == "string" and (.cmd | length) > 0 and
    (.timeout_s >= 1 and .timeout_s <= 86400) and (.expect_rc >= 0 and .expect_rc <= 255) and
    ((.expect // []) | all(type == "string" and length > 0))' "$spec" >/dev/null ||
    fail "$name: probe (M7)"
  jq -e '.guest_home == null or (.guest_home | test("^/tmp(/[A-Za-z0-9._-]+)+$"))' "$spec" \
    >/dev/null || fail "$name: guest_home (M7)"
  jq -e '(.guest_home_gitconfig == true and (.guest_home == null or .skip_git_identity_check == true))
    | not' "$spec" >/dev/null || fail "$name: guest_home_gitconfig (M8)"
  jq -e '.probe_status != "unmeasured" and .probe_status != "none"' "$spec" >/dev/null ||
    fail "$name: an unmeasured probe (M9)"
}

n=0
for spec in "$TPL"/examples/*.json; do
  [[ "$spec" != *.gate-record.json ]] || continue
  check "$spec"
  n=$((n + 1))
done
((n >= 2)) || fail "want at least two sample specs, found $n"
pass "the examples directory holds $n template specs, each well formed"

jq -e '.image | startswith("ghcr.io/")' "$TPL/examples/default.json" >/dev/null ||
  fail 'default.json does not name the public sandbox image'
pass 'default.json names the public sandbox image by digest'
jq -e '.image | startswith("images/")' "$TPL/examples/django__django-11133.json" >/dev/null ||
  fail "the SWE-bench sample is not host-free (its registry is the build host's default)"
jq -e '.egress == false and .probe_status == "vm" and (.guest_ram_mb == 4096) and .vcpus == 2' \
  "$TPL/examples/django__django-11133.json" >/dev/null ||
  fail 'the SWE-bench sample is not a benchmark template (X11, X14, X15)'
pass 'django__django-11133.json is host-free, offline, measured and in the benchmark envelope'

# The samples never carry a registry host, an account id or a token.
! grep -l -E 'amazonaws|dkr\.ecr|ghp_|github_pat_|[0-9]{12}\.' "$TPL"/examples/*.json >/dev/null ||
  fail 'a sample names a private registry, an account id or a token'
pass 'no sample names a private registry, an account id or a token'

# A gate record shipped beside a sample is that sample's: same image digest as its
# source_record_digest (X10), its gate passed (X1), and commits refused where the spec skips the
# identity check (X12).
for g in "$TPL"/examples/*.gate-record.json; do
  spec="${g%.gate-record.json}.json"
  [[ -f "$spec" ]] || fail "$(basename "$g") has no sample spec beside it"
  [[ "$(jq -r .image.digest "$g")" == "$(jq -r .source_record_digest "$spec")" ]] ||
    fail "$(basename "$g") is not the gate record $(basename "$spec") names"
  [[ "$(jq -r .image.digest "$g")" == "$(jq -r '.image | split("@")[1]' "$spec")" ]] ||
    fail "$(basename "$g") is for another image than $(basename "$spec")"
  jq -e '.gate.passed == true' "$g" >/dev/null || fail "$(basename "$g"): its gate did not pass"
  if jq -e '.skip_git_identity_check == true' "$spec" >/dev/null; then
    jq -e '.observed.testbed.agent_can_commit == "no" and .observed.guest.git_identity == "none"' \
      "$g" >/dev/null || fail "$(basename "$g") does not show commits refused (X12)"
  fi
done
pass 'every gate record beside a sample is the one its spec names, passed, and backs its skip'
