#!/usr/bin/env bash
# shellcheck disable=SC2015 # `check && check || fail`: fail is the only fallback, by design
# Tests for deploy/sbx/template-onboarding/template-register.sh with setup.sh mocked: an add, a versioned update (the old
# worker stays), a retire (refused while it serves a template), a remove, the no-op re-run, the
# refusals, and that only SBX_WORKERS's line and the templates file change.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }
REG="$SRC/deploy/sbx/template-onboarding/template-register.sh"
cat >"$TMP/setup.sh" <<'MOCK'
#!/usr/bin/env bash
printf 'setup.sh %s\n' "$*" >>"$TMP_LOG"
MOCK
chmod +x "$TMP/setup.sh"
export SBX_SETUP="$TMP/setup.sh" TMP_LOG="$TMP/setup.log"

reset() {
  cat >"$TMP/sbx.env" <<EOF
# the operator's settings
SBX_NAMESPACE=moca-sbx-example
SBX_WORKERS="sbx_default"
SBX_TEMPLATES_FILE=$TMP/templates.json
SBX_ALLOWED_SUBJECTS=github:1
EOF
  chmod 600 "$TMP/sbx.env"
  printf '%s\n' '[{"id":"default","worker":"sbx_default","description":"bash, git, Python 3","tools":["bash","git","python3"]}]' \
    >"$TMP/templates.json"
  : >"$TMP_LOG"
}
# A record as template-build.sh writes it.
record() {
  jq -n --arg w "$2" --arg s "$3" '{schema: "moca-sbx-template/1", id: "acme-widget-1234", worker: $w,
    snapshot: $s, image: "r@sha256:x", egress: false, seed: "cp -a /opt/testbed-src/. /workspace/",
    description: "a benchmark instance at its baseline", tools: ["bash", "git", "python3"], min_budget_mb: 13408}' |
    jq "${4:-.}" >"$1"
}
run() { bash "$REG" --env-file "$TMP/sbx.env" "$@" >"$TMP/out" 2>&1; }
# shellcheck source=/dev/null # the test's own env file
workers() { (. "$TMP/sbx.env"; printf '%s' "$SBX_WORKERS"); }
W1=sbx_acme_widget_1234_aaaaaaaaaaaa W2=sbx_acme_widget_1234_cccccccccccc
record "$TMP/r1.json" "$W1" acme-widget-1234-aaaaaaaaaaaa
record "$TMP/r2.json" "$W2" acme-widget-1234-cccccccccccc

# 1. Add: the worker joins SBX_WORKERS, the entry the templates file; nothing else in the env file
# changes, its mode is kept, setup.sh is not run without --apply.
reset
cp "$TMP/sbx.env" "$TMP/env.before"
run "$TMP/r1.json" || fail 'an add failed'
[[ "$(workers)" == "sbx_default $W1" ]] || fail "SBX_WORKERS is '$(workers)'"
jq -e --arg w "$W1" 'length == 2 and .[1] == {id: "acme-widget-1234", worker: $w,
  description: "a benchmark instance at its baseline", tools: ["bash", "git", "python3"]}' "$TMP/templates.json" >/dev/null ||
  fail "the templates file is wrong: $(cat "$TMP/templates.json")"
[[ "$(diff "$TMP/env.before" "$TMP/sbx.env" | grep -c '^[<>]')" == 2 ]] || fail 'more than the SBX_WORKERS line changed'
[[ "$(stat -c '%a' "$TMP/sbx.env" 2>/dev/null || stat -f '%Lp' "$TMP/sbx.env")" == 600 ]] || fail 'the env file lost its mode'
[[ ! -s "$TMP_LOG" ]] || fail 'setup.sh ran without --apply'
grep -q 'next: .*setup.sh --env-file' "$TMP/out" && grep -q -- "--snapshot acme-widget-1234-aaaaaaaaaaaa --budget-mb <at least 13408> --no-egress" "$TMP/out" ||
  fail 'the add does not say what to run next'
pass 'an add puts the worker in SBX_WORKERS and the entry in the templates file, and changes nothing else'

# 2. A re-run is a no-op, and --apply then runs nothing either.
cp "$TMP/sbx.env" "$TMP/env.1"; cp "$TMP/templates.json" "$TMP/tpl.1"
run "$TMP/r1.json" --apply || fail 'the re-run failed'
cmp -s "$TMP/sbx.env" "$TMP/env.1" && cmp -s "$TMP/templates.json" "$TMP/tpl.1" || fail 'the re-run changed a file'
grep -q 'nothing to change' "$TMP/out" && [[ ! -s "$TMP_LOG" ]] || fail 'the no-op re-run ran setup.sh or did not say so'
pass 'a re-run with nothing new changes nothing and runs no setup.sh'

# 3. A versioned update: the entry moves, the old worker stays; --apply runs setup.sh once.
run "$TMP/r2.json" --apply || fail 'the update failed'
[[ "$(workers)" == "sbx_default $W1 $W2" ]] || fail "after the update SBX_WORKERS is '$(workers)'"
jq -e --arg w "$W2" 'length == 2 and .[1].worker == $w' "$TMP/templates.json" >/dev/null || fail 'the entry did not move'
grep -q "moves from $W1 to $W2: $W1 stays in SBX_WORKERS" "$TMP/out" || fail 'the update does not say the old worker stays'
[[ "$(cat "$TMP_LOG")" == "setup.sh --env-file $TMP/sbx.env" ]] || fail "--apply did not run setup.sh once: $(cat "$TMP_LOG")"
pass 'an update moves the template to the new worker, keeps the old one, and --apply runs setup.sh'

# 4. Retire: refused while the worker serves a template; then it leaves SBX_WORKERS only.
rc=0; run --retire "$W2" || rc=$?
[[ "$rc" == 1 ]] && grep -q "still serves template acme-widget-1234" "$TMP/out" || fail 'retiring a serving worker was not refused'
run --retire "$W1" || fail 'the retire failed'
[[ "$(workers)" == "sbx_default $W2" ]] || fail "after the retire SBX_WORKERS is '$(workers)'"
grep -q "install-host.sh --uninstall $W1" "$TMP/out" || fail 'the retire does not name the uninstall'
run --retire "$W1" || fail 'a second retire failed'
grep -q 'nothing to change' "$TMP/out" || fail 'a second retire was not a no-op'
pass 'retire refuses a worker that serves a template, drops a superseded one, and is a no-op twice'

# 5. Remove: the entry and its worker go; the last template cannot.
run --remove acme-widget-1234 || fail 'the remove failed'
[[ "$(workers)" == sbx_default ]] && jq -e 'length == 1' "$TMP/templates.json" >/dev/null || fail 'the remove left something'
grep -q "install-host.sh --uninstall $W2" "$TMP/out" || fail 'the remove does not name the uninstall'
rc=0; run --remove default || rc=$?
[[ "$rc" == 1 ]] && grep -q 'the only one' "$TMP/out" || fail 'removing the last template was not refused'
pass 'remove drops the template and its worker, and refuses the last template'

# 6. Refusals that change nothing.
reset
cp "$TMP/sbx.env" "$TMP/env.before"; cp "$TMP/templates.json" "$TMP/tpl.before"
record "$TMP/bad.json" "$W1" s '.schema = "moca-sbx-template-spec/1"'
rc=0; run "$TMP/bad.json" || rc=$?
[[ "$rc" == 1 ]] && grep -q 'is not a template record' "$TMP/out" || fail 'a spec passed as a record was not refused'
record "$TMP/clash.json" sbx_default s
rc=0; run "$TMP/clash.json" || rc=$?
[[ "$rc" == 1 ]] && grep -q 'already serves template default' "$TMP/out" || fail 'a worker serving another template was not refused'
# shellcheck disable=SC2016 # a literal line for the env file
printf 'export SBX_WORKERS="$A $B"\n' >>"$TMP/sbx.env"
rc=0; run "$TMP/r1.json" || rc=$?
[[ "$rc" == 1 ]] && grep -q 'exactly one line' "$TMP/out" || fail 'a second SBX_WORKERS assignment was not refused'
cp "$TMP/env.before" "$TMP/sbx.env"; printf 'SBX_EGRESS_HOSTS="kvm=sbx_default"\n' >>"$TMP/sbx.env"
rc=0; run "$TMP/r1.json" || rc=$?
[[ "$rc" == 1 ]] && grep -q 'SBX_EGRESS_HOSTS' "$TMP/out" || fail 'SBX_EGRESS_HOSTS was not refused'
cp "$TMP/env.before" "$TMP/sbx.env"
cmp -s "$TMP/templates.json" "$TMP/tpl.before" || fail 'a refusal changed the templates file'
rc=0; bash "$REG" --env-file "$TMP/sbx.env" "$TMP/r1.json" --retire x >"$TMP/out" 2>&1 || rc=$?
[[ "$rc" == 2 ]] || fail 'a record and --retire together were not a usage error'
pass 'refuses a non-record, a worker clash, an SBX_WORKERS it cannot rewrite, SBX_EGRESS_HOSTS, two actions'

# 7. Symlinked files: the env and templates files are links (as a config checkout often links them);
# the write goes through to each target with the target's mode, and the links stay links.
reset
mkdir -p "$TMP/real"
mv "$TMP/sbx.env" "$TMP/real/sbx.env" && ln -s real/sbx.env "$TMP/sbx.env"
mv "$TMP/templates.json" "$TMP/real/templates.json" && chmod 640 "$TMP/real/templates.json"
ln -s "$TMP/real/templates.json" "$TMP/templates.json"
run "$TMP/r1.json" || fail 'an add through symlinks failed'
[[ -L "$TMP/sbx.env" && -L "$TMP/templates.json" ]] || fail 'a symlinked file was replaced by a regular file'
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
[[ "$(mode_of "$TMP/real/sbx.env")" == 600 && "$(mode_of "$TMP/real/templates.json")" == 640 ]] ||
  fail "a target lost its mode: env $(mode_of "$TMP/real/sbx.env"), templates $(mode_of "$TMP/real/templates.json")"
[[ "$(workers)" == "sbx_default $W1" ]] || fail "SBX_WORKERS through the link is '$(workers)'"
jq -e 'length == 2' "$TMP/real/templates.json" >/dev/null || fail 'the templates target was not written'
[[ -z "$(find "$TMP" "$TMP/real" -maxdepth 1 \( -name 'sbx.env.??????' -o -name 'templates.json.??????' \) -print)" ]] || fail 'a temporary file was left behind'
pass 'a symlinked env or templates file is written through to its target, keeping the target'"'"'s mode; the links stay'
rm -f "$TMP/sbx.env" "$TMP/templates.json"
