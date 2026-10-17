#!/usr/bin/env bash
# Tests for deploy/sbx/install-host.sh with systemctl and journalctl mocked: what it writes, that
# two workers never share a slice, jail or workspace root (SBX0 §8.2), and that --uninstall leaves
# workspace data alone.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log"
mkdir -p "$TMP/bin"
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }

cat >"$TMP/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$MOCK_LOG"
[[ "$1" == show ]] && { echo "InvocationID=abc123"; exit 0; }
exit 0
MOCK
# journalctl: MOCK_JOURNAL_DIR holds the whole journal as the Nth look sees it (files 1, 2, ...;
# the last one keeps being served), so a test can script the worker's log growing between looks.
cat >"$TMP/bin/journalctl" <<'MOCK'
#!/usr/bin/env bash
printf 'journalctl %s\n' "$*" >>"$MOCK_LOG"
if [[ -n "${MOCK_JOURNAL_DIR:-}" ]]; then
  n=$(($(cat "$MOCK_JOURNAL_DIR/count" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$MOCK_JOURNAL_DIR/count"
  while ((n > 1)) && [[ ! -f "$MOCK_JOURNAL_DIR/$n" ]]; do n=$((n - 1)); done
  cat "$MOCK_JOURNAL_DIR/$n"
  exit 0
fi
[[ -n "${MOCK_NO_ATTACH:-}" ]] || echo 'microvm-worker: attached, serving execs'
MOCK
chmod +x "$TMP/bin/systemctl" "$TMP/bin/journalctl"
export PATH="$TMP/bin:$PATH" SBX_UNIT_DIR="$TMP/units" SBX_ENV_DIR="$TMP/etc" SBX_SRV="$TMP/srv"
export SBX_SKIP_ROOT_CHECK=1 SBX_ATTACH_TIMEOUT=2 SBX_ATTACH_SETTLE=1
INSTALL="$SRC/deploy/sbx/install-host.sh"
mkdir -p "$SBX_SRV/snapshots/default" "$SBX_SRV/snapshots/py312"

bundle() { # bundle ID
  local d="$TMP/bundles/$1"
  mkdir -p "$d"
  printf 'RELAY_ADDR=sbx-attach.apps.example.invalid:443\nRELAY_TLS=true\nSANDBOX_ID=%s\nSANDBOX_TOKEN=%s\n' \
    "$1" "$(printf '%064d' 7)" >"$d/worker.env"
  printf -- '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' >"$d/relay-ca.crt"
  echo "$d"
}

# Refusals
! bash "$INSTALL" "$(bundle sbx_default)" >"$TMP/out" 2>&1 || fail 'installed without --snapshot'
! bash "$INSTALL" "$(bundle sbx_default)" --snapshot missing >"$TMP/out" 2>&1 || fail 'installed a missing snapshot'
grep -q 'no snapshot' "$TMP/out" || fail 'missing-snapshot refusal does not say why'
b="$(bundle sbx_bad)"; sed -i.bak 's/^SANDBOX_TOKEN=.*/SANDBOX_TOKEN=short/' "$b/worker.env"
! bash "$INSTALL" "$b" --snapshot default >"$TMP/out" 2>&1 || fail 'accepted a malformed token'
! grep -q 'short' "$TMP/out" || fail 'the refusal printed the token value'
pass 'refuses a missing snapshot, a missing --snapshot and a malformed token (without printing it)'

bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'install sbx_default'
bash "$INSTALL" "$(bundle sbx_py312)" --snapshot py312 --budget-mb 8192 >"$TMP/out" 2>&1 || fail 'install sbx_py312'

A="$SBX_ENV_DIR/workers/sbx_default.env" B="$SBX_ENV_DIR/workers/sbx_py312.env"
for f in "$A" "$B"; do
  [[ "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" == 600 ]] || fail "$f is not 0600"
  grep -qx 'SH_WORKSPACE_IDLE=216h' "$f" || fail "$f: SH_WORKSPACE_IDLE is not 216h"
  grep -qx 'RELAY_TLS=true' "$f" || fail "$f: RELAY_TLS"
done
grep -qx 'SH_SNAPSHOT_IMAGE=py312' "$B" || fail 'snapshot not set'
grep -qx 'SH_MAX_COMMITTED_MB=8192' "$B" || fail 'budget not set'
for k in SH_PARENT_CGROUP SH_CHROOT_BASE SH_WORKSPACE_ROOT; do
  va="$(grep "^$k=" "$A" | cut -d= -f2-)" vb="$(grep "^$k=" "$B" | cut -d= -f2-)"
  [[ -n "$va" && "$va" != "$vb" ]] || fail "$k is shared between workers ($va)"
done
grep -qx 'SH_PARENT_CGROUP=sbx.slice/sbx-sbx_py312.slice' "$B" || fail 'parent cgroup is not the worker slice'
pass 'two workers: 0600 env files, own slice, jail and workspace root, 9-day idle'

[[ -f "$SBX_UNIT_DIR/sbx-worker@.service" && -f "$SBX_UNIT_DIR/sbx.slice" ]] || fail 'template unit or parent slice missing'
[[ -f "$SBX_UNIT_DIR/sbx-sbx_py312.slice" ]] || fail 'per-worker slice missing'
grep -qx 'Slice=sbx-%i.slice' "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'unit is not in its worker slice'
grep -qx 'AssertPathExists=/dev/kvm' "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'unit lacks AssertPathExists=/dev/kvm'
grep -qx 'StartLimitIntervalSec=300' "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'unit lacks StartLimitIntervalSec=300'
grep -qx 'StartLimitBurst=5' "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'unit lacks StartLimitBurst=5'
grep -qx 'systemctl enable sbx-worker@sbx_py312.service' "$MOCK_LOG" || fail 'unit not enabled'
! grep -q 'systemctl enable --now' "$MOCK_LOG" || fail 'enable --now plus restart starts a fresh unit twice'
[[ "$(grep -cx 'systemctl restart sbx-worker@sbx_py312.service' "$MOCK_LOG")" == 1 ]] || fail 'the worker is not restarted exactly once'
grep -q 'sbx-worker@sbx_py312' "$SBX_ENV_DIR/manifest" || fail 'manifest does not record the worker'
pass 'installs the template unit, the slices, enables and restarts the worker once and records it'

# A worker that crash-looped into `failed` refuses a restart until reset: reset-failed comes first.
grep -A1 -x 'systemctl reset-failed sbx-worker@sbx_py312.service' "$MOCK_LOG" | grep -qx 'systemctl restart sbx-worker@sbx_py312.service' ||
  fail 'reset-failed does not run right before the restart (a failed unit would refuse it)'
pass 'clears a failed state (reset-failed) right before restarting the worker'

: >"$MOCK_LOG"
! MOCK_NO_ATTACH=1 bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'reported success with no attach'
grep -q 'journalctl -u sbx-worker@sbx_default _SYSTEMD_INVOCATION_ID=abc123' "$TMP/out" || fail 'no-attach failure does not name the journal'
grep -q 'about a minute to reach the relay' "$TMP/out" || fail 'the timeout does not mention the Secret sync delay'
pass 'fails, naming the journal and the token-sync delay, when the worker never logs an attach'

# The attach rule of setup-microvm.sh: an earlier refusal does not fail the wait, a later attach that
# holds succeeds, and an attach followed by `stream ended` with no re-attach fails.
ATTACHED='microvm-worker: attached, serving execs'
ENDED='microvm-worker: stream ended (rpc error: code = Unauthenticated desc = bad token); reconnecting in 612ms'
journal() { # journal DIR LOOK... -- each LOOK is the full journal at that look, lines separated by |
  local d="$1" i=0 look
  rm -rf "$d" && mkdir -p "$d" && shift
  for look in "$@"; do i=$((i + 1)); printf '%s\n' "$look" | tr '|' '\n' >"$d/$i"; done
}
journal "$TMP/j1" "$ATTACHED" "$ATTACHED|$ENDED" "$ATTACHED|$ENDED|$ATTACHED"
MOCK_JOURNAL_DIR="$TMP/j1" SBX_ATTACH_TIMEOUT=10 bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 ||
  fail 'a refusal followed by an attach that holds was reported as a failure'
grep -q 'sbx-worker@sbx_default attached to the relay' "$TMP/out" || fail 'no attached message'
pass 'an attach that holds after an earlier refusal (Secret not yet synced) succeeds'

journal "$TMP/j2" "$ATTACHED" "$ATTACHED|$ENDED"
! MOCK_JOURNAL_DIR="$TMP/j2" SBX_ATTACH_TIMEOUT=3 bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 ||
  fail 'an attach followed by stream ended and no re-attach was reported as attached'
grep -q 'journalctl -u sbx-worker@sbx_default _SYSTEMD_INVOCATION_ID=abc123' "$TMP/out" || fail 'the failure does not name the journal'
pass 'an attach that ends and never comes back fails, naming the journal'

: >"$MOCK_LOG"
! SBX_ATTACH_SETTLE=0 bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'accepted SBX_ATTACH_SETTLE=0'
grep -q 'SBX_ATTACH_SETTLE' "$TMP/out" || fail 'the SBX_ATTACH_SETTLE refusal does not say why'
! grep -q 'systemctl' "$MOCK_LOG" || fail 'touched systemd before refusing SBX_ATTACH_SETTLE=0'
pass 'refuses SBX_ATTACH_SETTLE below 1 before touching anything'

: >"$MOCK_LOG"
mkdir -p "$SBX_SRV/workspaces/sbx_py312/sbx-keepme"
bash "$INSTALL" --uninstall sbx_py312 >"$TMP/out" 2>&1 || fail 'uninstall'
grep -q 'systemctl disable --now sbx-worker@sbx_py312.service' "$MOCK_LOG" || fail 'unit not disabled'
grep -A1 'systemctl disable --now sbx-worker@sbx_py312.service' "$MOCK_LOG" | grep -qx 'systemctl stop sbx-sbx_py312.slice' ||
  fail 'the worker slice is not stopped after the unit is disabled (VMs left by a timed-out stop stay resident)'
[[ ! -f "$B" && ! -f "$SBX_UNIT_DIR/sbx-sbx_py312.slice" ]] || fail 'env file or slice kept'
[[ -d "$SBX_SRV/workspaces/sbx_py312/sbx-keepme" ]] || fail 'uninstall removed workspace data'
grep -q "left in place: $SBX_SRV/workspaces/sbx_py312" "$TMP/out" || fail 'uninstall does not say what it kept'
pass '--uninstall stops and removes the worker, keeps (and names) its workspace data'

# Uninstall matches the worker's manifest lines exactly: removing `a` keeps `ba`'s.
bash "$INSTALL" "$(bundle a)" --snapshot default >"$TMP/out" 2>&1 || fail 'install a'
bash "$INSTALL" "$(bundle ba)" --snapshot default >"$TMP/out" 2>&1 || fail 'install ba'
bash "$INSTALL" --uninstall a >"$TMP/out" 2>&1 || fail 'uninstall a'
M="$SBX_ENV_DIR/manifest"
! grep -q 'sbx-worker@a \|/a-relay-ca\.crt' "$M" || fail "a's manifest lines kept: $(cat "$M")"
grep -qx "worker sbx-worker@ba $SBX_ENV_DIR/workers/ba.env $SBX_UNIT_DIR/sbx-ba.slice" "$M" || fail "uninstalling a dropped ba's worker line: $(cat "$M")"
grep -qx "file $SBX_ENV_DIR/workers/ba-relay-ca.crt" "$M" || fail "uninstalling a dropped ba's CA line: $(cat "$M")"
[[ -f "$SBX_ENV_DIR/workers/ba-relay-ca.crt" && -f "$SBX_ENV_DIR/workers/ba.env" ]] || fail "uninstalling a removed ba's files"
pass "--uninstall a keeps worker ba's manifest lines and files (fixed-string match)"

# The shared units stay while any worker is left, and go with the last one (spec §8.2's undo).
[[ -f "$SBX_UNIT_DIR/sbx-worker@.service" && -f "$SBX_UNIT_DIR/sbx.slice" ]] || fail 'shared units removed while workers remain'
grep -qx "unit $SBX_UNIT_DIR/sbx.slice" "$M" || fail 'the manifest lost the shared units while workers remain'
bash "$INSTALL" --uninstall ba >"$TMP/out" 2>&1 || fail 'uninstall ba'
bash "$INSTALL" --uninstall sbx_default >"$TMP/out" 2>&1 || fail 'uninstall sbx_default (no worker after it)'
[[ ! -e "$SBX_UNIT_DIR/sbx-worker@.service" && ! -e "$SBX_UNIT_DIR/sbx.slice" ]] || fail 'shared units kept after the last worker'
grep -q "removed $SBX_UNIT_DIR/sbx-worker@.service" "$TMP/out" && grep -q "removed $SBX_UNIT_DIR/sbx.slice" "$TMP/out" ||
  fail 'the last uninstall does not say it removed the shared units'
[[ ! -s "$M" ]] || fail "the manifest still lists something after the last worker: $(cat "$M")"
[[ -d "$SBX_SRV/workspaces/sbx_default" ]] || fail 'the last uninstall removed workspace data'
# daemon-reload runs after the unit files are gone, so systemd forgets them.
bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'reinstall sbx_default'
: >"$MOCK_LOG"
bash "$INSTALL" --uninstall sbx_default >"$TMP/out" 2>&1 || fail 'uninstall sbx_default again'
[[ "$(tail -1 "$MOCK_LOG")" == 'systemctl daemon-reload' ]] || fail "daemon-reload is not the last step of the undo: $(tail -1 "$MOCK_LOG")"
[[ ! -e "$SBX_UNIT_DIR/sbx-worker@.service" ]] || fail 'reinstall + uninstall left the template unit'
pass '--uninstall of the last worker removes the shared unit and sbx.slice, then daemon-reloads; workspace data stays'
