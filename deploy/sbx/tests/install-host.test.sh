#!/usr/bin/env bash
# Tests for deploy/sbx/install-host.sh with systemctl and journalctl mocked: what it writes, that
# two workers never share a slice, jail or workspace root (SBX0 §8.2), that --uninstall leaves
# workspace data alone, and that moca-egress is installed and wired beside the worker (#623).
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Short: the worker's jail path must fit a Unix socket (install-host.sh checks it), and macOS's
# default temp directory is too long for that.
TMP="$(mktemp -d /tmp/ih.XXXX)"
# The reaper's tests below leave live `sleep`s in fake cgroup.procs files on a failure: end them too.
trap 'cat "$TMP"/cgroup/*/*/*/cgroup.procs 2>/dev/null | while read -r p; do kill -KILL "$p" 2>/dev/null || true; done; rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log" MOCK_ENABLED_DIR="$TMP/enabled"
mkdir -p "$TMP/bin" "$MOCK_ENABLED_DIR"
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }

cat >"$TMP/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$MOCK_LOG"
[[ "$1" == show ]] && { echo "InvocationID=abc123"; exit 0; }
# enable and disable keep each unit's boot state as a file in MOCK_ENABLED_DIR (the unit is the last
# argument: `disable --now UNIT` too), so a test can check what a re-install leaves enabled.
case "$1" in
enable) touch "$MOCK_ENABLED_DIR/${!#}" ;;
disable) rm -f "$MOCK_ENABLED_DIR/${!#}" ;;
esac
# MOCK_ACTIVE_RC is every unit's is-active answer; MOCK_EGRESS_ACTIVE_RC overrides moca-egress's.
[[ "$1" == is-active ]] && { [[ "$3" == moca-egress.service ]] && exit "${MOCK_EGRESS_ACTIVE_RC:-${MOCK_ACTIVE_RC:-0}}"; exit "${MOCK_ACTIVE_RC:-0}"; }
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
# findmnt: MOCK_FINDMNT_MAJMIN is the MAJ:MIN of every path; unset, nothing is mounted, so the
# read-ahead is skipped with a warning (the blocks before the read-ahead one never touch it).
cat >"$TMP/bin/findmnt" <<'MOCK'
#!/usr/bin/env bash
printf 'findmnt %s\n' "$*" >>"$MOCK_LOG"
[[ -n "${MOCK_FINDMNT_MAJMIN:-}" ]] || exit 1
echo "$MOCK_FINDMNT_MAJMIN"
MOCK
chmod +x "$TMP/bin/systemctl" "$TMP/bin/journalctl" "$TMP/bin/findmnt"
export PATH="$TMP/bin:$PATH" SBX_UNIT_DIR="$TMP/units" SBX_ENV_DIR="$TMP/etc" SBX_SRV="$TMP/srv"
export SBX_SYSFS="$TMP/sys" # the read-ahead's sysfs, faked in its block
export SBX_SKIP_ROOT_CHECK=1 SBX_ATTACH_TIMEOUT=2 SBX_ATTACH_SETTLE=1 SBX_LIBEXEC_DIR="$TMP/libexec"
INSTALL="$SRC/deploy/sbx/install-host.sh"
# A snapshot as build-snapshot.sh writes it, as far as install-host.sh reads one: its guest RAM.
snap() { mkdir -p "$SBX_SRV/snapshots/$1"; printf '{\n  "hash": "x",\n  "guest_ram_mb": %s\n}\n' "${2:-256}" >"$SBX_SRV/snapshots/$1/manifest.json"; }
snap default
snap py312
# moca-egress is the operator's binary, and the worker waits for its control socket: fake both, so
# every install below passes the binary check and the socket wait. A socket FILE is all `-S` tests.
export SBX_BIN_DIR="$TMP/usrbin" MOCA_EGRESS_SOCKET="$TMP/run/control.sock" MOCA_EGRESS_READY_TIMEOUT=2
mkdir -p "$SBX_BIN_DIR" "$TMP/run"
fake_egress() { : >"$SBX_BIN_DIR/moca-egress"; chmod +x "$SBX_BIN_DIR/moca-egress"; }
export SBX_WORKER_BIN="$SBX_BIN_DIR/microvm-worker"
: >"$SBX_WORKER_BIN"; chmod +x "$SBX_WORKER_BIN"
fake_socket() { rm -f "$MOCA_EGRESS_SOCKET"; python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$MOCA_EGRESS_SOCKET"; }
fake_egress
fake_socket

bundle() { # bundle ID [EXTRA_LINES]: a worker bundle as setup.sh writes it, plus EXTRA_LINES
  local d="$TMP/bundles/$1"
  mkdir -p "$d"
  printf 'RELAY_ADDR=sbx-attach.apps.example.invalid:443\nRELAY_TLS=true\nSANDBOX_ID=%s\nSANDBOX_TOKEN=%s\n%s' \
    "$1" "$(printf '%064d' 7)" "${2-$'SH_WORKSPACE_IDLE=216h\nSH_WORKSPACE_IMAGE_MB=2048\nSH_LEASE_IDLE_CEILING_S=1800\n'}" >"$d/worker.env"
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
for extra in 'SH_WORKSPACE_IDLE=9d' 'SH_WORKSPACE_IDLE=0h' 'SH_WORKSPACE_IMAGE_MB=2g' 'SH_WORKSPACE_IMAGE_MB=0' \
  'SH_LEASE_IDLE_CEILING_S=30m' 'SH_LEASE_IDLE_CEILING_S=1.5' 'SH_LEASE_IDLE_CEILING_S=0' 'SH_LEASE_IDLE_CEILING_S=299' 'SH_LEASE_IDLE_CEILING_S=86401' 'SH_LEASE_IDLE_CEILING_S= '; do
  : >"$MOCK_LOG"
  # The bad line last: env_value takes the last one, so it overrides the valid idle before it.
  ! bash "$INSTALL" "$(bundle sbx_bad $'SH_WORKSPACE_IDLE=216h\n'"$extra"$'\n')" --snapshot default >"$TMP/out" 2>&1 || fail "accepted $extra"
  grep -q "${extra%%=*} in" "$TMP/out" || fail "the $extra refusal does not name the setting"
  ! grep -q systemctl "$MOCK_LOG" || fail "touched systemd before refusing $extra"
done
# A bundle with no SH_WORKSPACE_IDLE predates 1b's rule (idle = lifetime + 2 days): refused, not defaulted.
: >"$MOCK_LOG"
! bash "$INSTALL" "$(bundle sbx_bad $'SH_WORKSPACE_IMAGE_MB=2048\n')" --snapshot default >"$TMP/out" 2>&1 || fail 'accepted a bundle with no SH_WORKSPACE_IDLE'
grep -q 'SH_WORKSPACE_IDLE' "$TMP/out" && grep -q 'deploy/sbx/setup.sh' "$TMP/out" ||
  fail 'the missing-idle refusal does not name SH_WORKSPACE_IDLE and setup.sh'
! grep -q systemctl "$MOCK_LOG" || fail 'touched systemd before refusing a bundle with no SH_WORKSPACE_IDLE'
# setup.sh's cap (review #4569829097): the ceiling's refusal names the 300-86400 range.
! bash "$INSTALL" "$(bundle sbx_bad $'SH_WORKSPACE_IDLE=216h\nSH_LEASE_IDLE_CEILING_S=86401\n')" --snapshot default >"$TMP/out" 2>&1 ||
  fail 'accepted a ceiling above 86400 s'
grep -q 'SH_LEASE_IDLE_CEILING_S in .* must be a whole number of seconds, 300-86400' "$TMP/out" ||
  fail "the ceiling refusal does not name 300-86400: $(cat "$TMP/out")"
pass 'refuses a missing snapshot, a missing --snapshot, a malformed token (without printing it), a missing or bad idle, a bad image size or idle ceiling'

# py312 has a template record (template-build.sh's); default has none.
mkdir -p "$SBX_SRV/templates" && printf '{\n  "schema": "moca-sbx-template/1",\n  "id": "py312",\n  "worker": "sbx_py312"\n}\n' >"$SBX_SRV/templates/py312.json"
bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'install sbx_default'
bash "$INSTALL" "$(bundle sbx_py312 $'SH_WORKSPACE_IDLE=240h\nSH_WORKSPACE_IMAGE_MB=4096\nSH_LEASE_IDLE_CEILING_S=3600\n')" --snapshot py312 --budget-mb 8192 \
  >"$TMP/out" 2>&1 || fail 'install sbx_py312'

A="$SBX_ENV_DIR/workers/sbx_default.env" B="$SBX_ENV_DIR/workers/sbx_py312.env"
for f in "$A" "$B"; do
  [[ "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" == 600 ]] || fail "$f is not 0600"
  grep -qx 'RELAY_TLS=true' "$f" || fail "$f: RELAY_TLS"
done
grep -qx 'SH_WORKSPACE_IDLE=216h' "$A" || fail "$A: SH_WORKSPACE_IDLE is not the bundle's 216h"
grep -qx 'SH_WORKSPACE_IMAGE_MB=2048' "$A" || fail "$A: SH_WORKSPACE_IMAGE_MB is not the bundle's 2048"
grep -qx 'SH_WORKSPACE_IDLE=240h' "$B" || fail "$B: SH_WORKSPACE_IDLE is not the bundle's 240h"
grep -qx 'SH_WORKSPACE_IMAGE_MB=4096' "$B" || fail "$B: SH_WORKSPACE_IMAGE_MB is not the bundle's 4096"
grep -qx 'SH_LEASE_IDLE_CEILING_S=1800' "$A" || fail "$A: SH_LEASE_IDLE_CEILING_S is not the bundle's 1800"
grep -qx 'SH_LEASE_IDLE_CEILING_S=3600' "$B" || fail "$B: SH_LEASE_IDLE_CEILING_S is not the bundle's 3600"
[[ "$(grep -c '^SH_LEASE_IDLE_CEILING_S=' "$B")" == 1 ]] || fail "$B: SH_LEASE_IDLE_CEILING_S written twice"
[[ "$(grep -c '^SH_WORKSPACE_IDLE=' "$B")" == 1 ]] || fail "$B: SH_WORKSPACE_IDLE written twice"
grep -qx 'SH_SNAPSHOT_IMAGE=py312' "$B" || fail 'snapshot not set'
grep -qx 'SH_MAX_COMMITTED_MB=8192' "$B" || fail 'budget not set'
for k in SH_PARENT_CGROUP SH_CHROOT_BASE SH_WORKSPACE_ROOT; do
  va="$(grep "^$k=" "$A" | cut -d= -f2-)" vb="$(grep "^$k=" "$B" | cut -d= -f2-)"
  [[ -n "$va" && "$va" != "$vb" ]] || fail "$k is shared between workers ($va)"
done
grep -qx 'SH_PARENT_CGROUP=sbx.slice/sbx-sbx_py312.slice' "$B" || fail 'parent cgroup is not the worker slice'
grep -qx "SH_TEMPLATE_RECORD=$SBX_SRV/templates/py312.json" "$B" || fail "$B: SH_TEMPLATE_RECORD does not name the snapshot's record"
! grep -q '^SH_TEMPLATE_RECORD=' "$A" || fail "$A: SH_TEMPLATE_RECORD set with no record"
grep -qx 'SANDBOX_TEMPLATE=py312' "$B" || fail "$B: SANDBOX_TEMPLATE is not the record's id"
! grep -q '^SANDBOX_TEMPLATE=' "$A" || fail "$A: SANDBOX_TEMPLATE set with no record"
grep -qx "SH_VERIFY_CACHE_DIR=$SBX_SRV/verify-cache" "$B" || fail 'the verify cache is not under SBX_SRV'
pass "two workers: 0600 env files, own slice, jail and workspace root, the bundle's idle, image size and idle ceiling, the template record and its id as SANDBOX_TEMPLATE when there is one"

# The jail is keyed by a short digest of the worker id, so the longest worker id SBX0 can have
# (a 31-character template) still fits the VMs' API socket paths; too long a SBX_SRV is refused.
LONG=sbx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_0123456789ab
bash "$INSTALL" "$(bundle $LONG)" --snapshot default >"$TMP/out" 2>&1 || fail "install the longest worker id: $(cat "$TMP/out")"
jb="$(grep '^SH_CHROOT_BASE=' "$SBX_ENV_DIR/workers/$LONG.env" | cut -d= -f2-)"
[[ "$jb" =~ ^$SBX_SRV/jail/j[0-9a-f]{12}$ && -d "$jb" ]] || fail "the jail is not $SBX_SRV/jail/j<12 hex>: $jb"
p="$jb/firecracker/vm-99999999999999999999/root/run/firecracker.socket"
((${#p} < 108)) || fail "the worst-case API socket path is ${#p} bytes"
[[ "$(grep -h '^SH_CHROOT_BASE=' "$SBX_ENV_DIR"/workers/*.env | sort | uniq -d)" == '' ]] || fail 'two workers share a jail'
bash "$INSTALL" --uninstall $LONG >"$TMP/out" 2>&1 || fail 'uninstall the longest worker id'
grep -qF "left in place: $SBX_SRV/workspaces/$LONG and $jb" "$TMP/out" || fail "uninstall does not name the jail: $(cat "$TMP/out")"
DEEP="$TMP/$(printf 'x%.0s' {1..40})"
mkdir -p "$DEEP/snapshots/default"
cp "$SBX_SRV/snapshots/default/manifest.json" "$DEEP/snapshots/default/"
rc=0; SBX_SRV="$DEEP" bash "$INSTALL" "$(bundle sbx_deep)" --snapshot default >"$TMP/out" 2>&1 || rc=$?
[[ ! -e "$SBX_ENV_DIR/workers/sbx_deep.env" ]] || fail 'too long a SBX_SRV still wrote the worker env'
[[ "$rc" != 0 ]] && grep -q 'jail path is too long for a Unix socket' "$TMP/out" || fail "too long a SBX_SRV was not refused: $(cat "$TMP/out")"
pass 'the jail is <SBX_SRV>/jail/j<12 hex of the id>: the longest worker id fits; too long a SBX_SRV is refused'

# A snapshot with template-build.sh's record ($SBX_SRV/templates/<snapshot>.json): the worker env
# points the worker at it and names the template, so the worker checks the record at start. A record
# for another worker is refused before anything is written; no record writes neither line (above).
snap py-tools-0123456789ab && mkdir -p "$SBX_SRV/templates"
printf '{"schema":"moca-sbx-template/1","id":"py-tools","worker":"sbx_py_tools_0123456789ab","snapshot":"py-tools-0123456789ab"}\n' \
  >"$SBX_SRV/templates/py-tools-0123456789ab.json"
bash "$INSTALL" "$(bundle sbx_py_tools_0123456789ab)" --snapshot py-tools-0123456789ab >"$TMP/out" 2>&1 || fail 'install a worker with a template record'
R="$SBX_ENV_DIR/workers/sbx_py_tools_0123456789ab.env"
grep -qx "SH_TEMPLATE_RECORD=$SBX_SRV/templates/py-tools-0123456789ab.json" "$R" || fail "$R: SH_TEMPLATE_RECORD is not the snapshot's record"
grep -qx 'SANDBOX_TEMPLATE=py-tools' "$R" || fail "$R: SANDBOX_TEMPLATE is not the record's id"
! grep -q '^SH_TEMPLATE_RECORD=\|^SANDBOX_TEMPLATE=' "$A" || fail "$A: a snapshot without a record got SH_TEMPLATE_RECORD"
# The checks below read what the earlier installs logged: keep it, and look at this refusal alone.
cp "$MOCK_LOG" "$TMP/mock.kept"; : >"$MOCK_LOG"
! bash "$INSTALL" "$(bundle sbx_other_0123456789ab)" --snapshot py-tools-0123456789ab >"$TMP/out" 2>&1 || fail "installed another worker's bundle on a recorded snapshot"
grep -q 'is for worker sbx_py_tools_0123456789ab, not this bundle' "$TMP/out" || fail 'the record refusal does not name both workers'
[[ ! -e "$SBX_ENV_DIR/workers/sbx_other_0123456789ab.env" ]] && ! grep -q systemctl "$MOCK_LOG" || fail 'wrote or touched systemd before refusing the record'
printf '{"schema":"other/1"}\n' >"$SBX_SRV/templates/py-tools-0123456789ab.json"
! bash "$INSTALL" "$(bundle sbx_py_tools_0123456789ab)" --snapshot py-tools-0123456789ab >"$TMP/out" 2>&1 || fail 'accepted a record of another schema'
grep -q 'is not a template record' "$TMP/out" || fail 'the schema refusal does not say why'
bash "$INSTALL" --uninstall sbx_py_tools_0123456789ab >"$TMP/out" 2>&1 || fail 'uninstall the recorded worker'
rm -rf "$SBX_SRV/templates" "$SBX_SRV/snapshots/py-tools-0123456789ab"
cat "$TMP/mock.kept" >"$MOCK_LOG"
pass "a snapshot's template record is wired into the worker env (SH_TEMPLATE_RECORD, SANDBOX_TEMPLATE); another worker's is refused"

# A worker installed before the digest-keyed jail had $SBX_SRV/jail/<id>. A reinstall and an uninstall
# remove that worker's own old jail (its hard-linked files stay) and say so; another worker's is kept.
legacy_jail() { # legacy_jail ID: an old jail with a VM chroot holding a hard link to a workspace file
  mkdir -p "$SBX_SRV/jail/$1/firecracker/vm-1/root" "$SBX_SRV/workspaces/$1"
  printf 'DATA\n' >"$SBX_SRV/workspaces/$1/ws.img"
  ln "$SBX_SRV/workspaces/$1/ws.img" "$SBX_SRV/jail/$1/firecracker/vm-1/root/ws.img"
}
legacy_jail sbx_default
legacy_jail sbx_py312
bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail "reinstall over a legacy jail: $(cat "$TMP/out")"
[[ ! -e "$SBX_SRV/jail/sbx_default" ]] || fail 'the reinstall left the legacy jail'
grep -qF "removed $SBX_SRV/jail/sbx_default " "$TMP/out" || fail "the reinstall does not say it removed the legacy jail: $(cat "$TMP/out")"
[[ "$(cat "$SBX_SRV/workspaces/sbx_default/ws.img")" == DATA ]] || fail 'the legacy jail removal took the workspace file'
[[ -d "$SBX_SRV/jail/sbx_py312" ]] || fail "the reinstall removed another worker's legacy jail"
[[ -d "$(grep '^SH_CHROOT_BASE=' "$A" | cut -d= -f2-)" ]] || fail 'the reinstall has no current jail'
bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'reinstall with no legacy jail'
! grep -q "removed $SBX_SRV/jail/" "$TMP/out" || fail 'a reinstall with no legacy jail says it removed one'
bash "$INSTALL" "$(bundle sbx_unin)" --snapshot default >"$TMP/out" 2>&1 || fail 'install sbx_unin'
legacy_jail sbx_unin
bash "$INSTALL" --uninstall sbx_unin >"$TMP/out" 2>&1 || fail 'uninstall over a legacy jail'
[[ ! -e "$SBX_SRV/jail/sbx_unin" ]] || fail 'the uninstall left the legacy jail'
grep -qF "removed $SBX_SRV/jail/sbx_unin " "$TMP/out" || fail "the uninstall does not say it removed the legacy jail: $(cat "$TMP/out")"
[[ "$(cat "$SBX_SRV/workspaces/sbx_unin/ws.img")" == DATA ]] || fail 'the uninstall took the workspace file'
[[ -d "$SBX_SRV/jail/sbx_py312" ]] || fail "the uninstall removed another worker's legacy jail"
# An id shaped like a current jail's name could be another worker's jail: left, and said so.
mkdir -p "$SBX_SRV/jail/j0123456789ab/firecracker"
bash "$INSTALL" --uninstall j0123456789ab >"$TMP/out" 2>&1 || fail 'uninstall j0123456789ab'
[[ -d "$SBX_SRV/jail/j0123456789ab" ]] || fail 'removed a jail named like a current one'
grep -qF "left in place: $SBX_SRV/jail/j0123456789ab " "$TMP/out" || fail "the jail-shaped id's message is missing: $(cat "$TMP/out")"
rm -rf "$SBX_SRV/jail/j0123456789ab" "$SBX_SRV/jail/sbx_py312"
pass "a reinstall and an uninstall remove the worker's own legacy jail <SBX_SRV>/jail/<id>, keep its files' data, and say so"

# A bundle without SH_WORKSPACE_IMAGE_MB gets microvm-worker's default, 2048 MiB; one from before the
# lease policy (no SH_LEASE_IDLE_CEILING_S) gets 1800 s, the default of both the worker and setup.sh.
bash "$INSTALL" "$(bundle sbx_old $'SH_WORKSPACE_IDLE=216h\n')" --snapshot default >"$TMP/out" 2>&1 || fail 'install a bundle with no image size'
grep -qx 'SH_WORKSPACE_IMAGE_MB=2048' "$SBX_ENV_DIR/workers/sbx_old.env" || fail 'SH_WORKSPACE_IMAGE_MB is not the 2048 default'
grep -qx 'SH_LEASE_IDLE_CEILING_S=1800' "$SBX_ENV_DIR/workers/sbx_old.env" || fail 'SH_LEASE_IDLE_CEILING_S is not the 1800 default'
bash "$INSTALL" --uninstall sbx_old >"$TMP/out" 2>&1 || fail 'uninstall sbx_old'
pass 'a bundle without the image size or the idle ceiling gets the 2048 MiB and 1800 s defaults'

# A worker install deletes the lease boot marker (review #4569829075): a worker binary from before the
# marker never writes lease=off, so after a rollback past it the marker could still say lease=on. With
# none, the next lease-on boot marks root_wrote on every known state, conservatively.
WS="$SBX_SRV/workspaces/sbx_mark"
mkdir -p "$WS/.lease-state"
echo 'lease=on' >"$WS/.lease-state/.boot"
echo '{"known":true}' >"$WS/.lease-state/sbx-aaaa.json"
bash "$INSTALL" "$(bundle sbx_mark)" --snapshot default >"$TMP/out" 2>&1 || fail "install sbx_mark: $(cat "$TMP/out")"
[[ ! -e "$WS/.lease-state/.boot" ]] || fail 'the install left the lease boot marker'
[[ -f "$WS/.lease-state/sbx-aaaa.json" ]] || fail "the install removed a key's lease state file"
# A symlinked marker is removed as the link, never what it points to.
echo keep >"$TMP/elsewhere"
ln -s "$TMP/elsewhere" "$WS/.lease-state/.boot"
bash "$INSTALL" "$(bundle sbx_mark)" --snapshot default >"$TMP/out" 2>&1 || fail "reinstall sbx_mark: $(cat "$TMP/out")"
[[ ! -e "$WS/.lease-state/.boot" && ! -L "$WS/.lease-state/.boot" ]] || fail 'the symlinked marker is still there'
[[ "$(cat "$TMP/elsewhere")" == keep ]] || fail "the marker's symlink target was touched"
# A symlinked .lease-state is refused before systemd is touched, and nothing it points to is removed.
rm -rf "$WS/.lease-state"
mkdir -p "$TMP/planted"
echo 'lease=on' >"$TMP/planted/.boot"
ln -s "$TMP/planted" "$WS/.lease-state"
n0="$(wc -l <"$MOCK_LOG")" # the checks below read the log of the installs above: keep it
! bash "$INSTALL" "$(bundle sbx_mark)" --snapshot default >"$TMP/out" 2>&1 || fail 'installed over a symlinked .lease-state'
grep -q '.lease-state' "$TMP/out" || fail "the symlinked .lease-state refusal does not name it: $(cat "$TMP/out")"
! tail -n +$((n0 + 1)) "$MOCK_LOG" | grep -q systemctl || fail 'touched systemd before refusing a symlinked .lease-state'
[[ -f "$TMP/planted/.boot" ]] || fail 'removed a .boot through a symlinked .lease-state'
rm -f "$WS/.lease-state"
bash "$INSTALL" --uninstall sbx_mark >"$TMP/out" 2>&1 || fail 'uninstall sbx_mark'
pass "a worker install deletes the lease boot marker (a symlink as the link), keeps the keys' state, and refuses a symlinked .lease-state"

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

# SBX_WORKER_AT_BOOT (#796): 1, the default, enables the unit for boot; 0 installs and starts it but
# leaves it disabled; a re-install applies the value it is given. A bad value is refused before any
# systemctl call or file.
! grep -qx 'systemctl disable sbx-worker@sbx_py312.service' "$MOCK_LOG" || fail 'the default install disabled the worker'
[[ -f "$MOCK_ENABLED_DIR/sbx-worker@sbx_py312.service" ]] || fail 'the default install left the worker disabled'
for v in 2 yes '' ' 1' 01; do
  : >"$MOCK_LOG"
  ! SBX_WORKER_AT_BOOT="$v" bash "$INSTALL" "$(bundle sbx_noboot)" --snapshot default >"$TMP/out" 2>&1 ||
    fail "accepted SBX_WORKER_AT_BOOT='$v'"
  grep -q "SBX_WORKER_AT_BOOT='$v' must be 1" "$TMP/out" || fail "the SBX_WORKER_AT_BOOT='$v' refusal does not say why"
  ! grep -q systemctl "$MOCK_LOG" || fail "touched systemd before refusing SBX_WORKER_AT_BOOT='$v'"
  [[ ! -e "$SBX_ENV_DIR/workers/sbx_noboot.env" ]] || fail "wrote the env file before refusing SBX_WORKER_AT_BOOT='$v'"
done
pass 'refuses SBX_WORKER_AT_BOOT other than 0 or 1 (2, yes, an explicit empty value, " 1", 01) before touching anything'

: >"$MOCK_LOG"
SBX_WORKER_AT_BOOT=0 bash "$INSTALL" "$(bundle sbx_noboot)" --snapshot default >"$TMP/out" 2>&1 || fail 'install with SBX_WORKER_AT_BOOT=0'
[[ -f "$SBX_ENV_DIR/workers/sbx_noboot.env" ]] || fail 'SBX_WORKER_AT_BOOT=0 did not install the worker'
! grep -q 'systemctl enable sbx-worker@sbx_noboot' "$MOCK_LOG" || fail 'SBX_WORKER_AT_BOOT=0 enabled the worker'
[[ ! -e "$MOCK_ENABLED_DIR/sbx-worker@sbx_noboot.service" ]] || fail 'SBX_WORKER_AT_BOOT=0 left the worker enabled'
[[ "$(grep -cx 'systemctl restart sbx-worker@sbx_noboot.service' "$MOCK_LOG")" == 1 ]] || fail 'SBX_WORKER_AT_BOOT=0 did not start the worker exactly once'
grep -A1 -x 'systemctl reset-failed sbx-worker@sbx_noboot.service' "$MOCK_LOG" | grep -qx 'systemctl restart sbx-worker@sbx_noboot.service' ||
  fail 'SBX_WORKER_AT_BOOT=0: reset-failed does not run right before the restart'
grep -q 'sbx-worker@sbx_noboot attached to the relay' "$TMP/out" || fail 'SBX_WORKER_AT_BOOT=0 did not wait for the attach'
bash "$INSTALL" --uninstall sbx_noboot >"$TMP/out" 2>&1 || fail 'uninstall sbx_noboot'
pass 'SBX_WORKER_AT_BOOT=0 installs the worker and starts it once (and waits for the attach) without enabling it for boot'

# sbx_default was enabled by its install above: a re-install with 0 disables it, one with 1 enables it again.
[[ -f "$MOCK_ENABLED_DIR/sbx-worker@sbx_default.service" ]] || fail 'sbx_default is not enabled before the re-install'
: >"$MOCK_LOG"
SBX_WORKER_AT_BOOT=0 bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 're-install sbx_default with SBX_WORKER_AT_BOOT=0'
grep -qx 'systemctl disable sbx-worker@sbx_default.service' "$MOCK_LOG" || fail 'a re-install with 0 did not disable the worker'
[[ ! -e "$MOCK_ENABLED_DIR/sbx-worker@sbx_default.service" ]] || fail 'a re-install with 0 left the worker enabled'
[[ "$(grep -cx 'systemctl restart sbx-worker@sbx_default.service' "$MOCK_LOG")" == 1 ]] || fail 'a re-install with 0 did not restart the worker once'
: >"$MOCK_LOG"
SBX_WORKER_AT_BOOT=1 bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 're-install sbx_default with SBX_WORKER_AT_BOOT=1'
grep -qx 'systemctl enable sbx-worker@sbx_default.service' "$MOCK_LOG" || fail 'a re-install with 1 did not enable the worker'
! grep -q 'systemctl disable sbx-worker@sbx_default' "$MOCK_LOG" || fail 'a re-install with 1 disabled the worker'
[[ -f "$MOCK_ENABLED_DIR/sbx-worker@sbx_default.service" ]] || fail 'a re-install with 1 left the worker disabled'
pass 'a re-install keeps the chosen boot behavior: 0 disables a unit an earlier install enabled, 1 enables it again'

# #795: the worker's VMs live in pool-N cgroups beside the unit's own, which KillMode=control-group
# does not reach; the unit's ExecStopPost= helper ends them after every exit.
REAP="$SBX_LIBEXEC_DIR/sbx-reap-vms.sh"
grep -qxF "ExecStopPost=-$REAP %i" "$SBX_UNIT_DIR/sbx-worker@.service" ||
  fail "the unit does not run $REAP %i after the worker exits: $(grep ExecStopPost "$SBX_UNIT_DIR/sbx-worker@.service")"
[[ -f "$REAP" && "$(stat -c %a "$REAP" 2>/dev/null || stat -f %Lp "$REAP")" == 755 ]] || fail "$REAP is not installed 0755"
cmp -s "$REAP" "$SRC/deploy/sbx/reap-vms.sh" || fail "$REAP is not deploy/sbx/reap-vms.sh"
grep -qx "unit $REAP" "$SBX_ENV_DIR/manifest" || fail "the manifest does not record $REAP as a shared unit file"
: >"$MOCK_LOG"
! SBX_LIBEXEC_DIR='/tmp/a b' bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'accepted a non-plain SBX_LIBEXEC_DIR'
grep -q 'SBX_LIBEXEC_DIR=.* must be a plain absolute path' "$TMP/out" || fail 'the SBX_LIBEXEC_DIR refusal does not say why'
! grep -q systemctl "$MOCK_LOG" || fail 'touched systemd before refusing a non-plain SBX_LIBEXEC_DIR'
pass "the unit's ExecStopPost= runs the installed, recorded VM reaper; a non-plain SBX_LIBEXEC_DIR is refused first"

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
[[ ! -e "$REAP" ]] || fail "$REAP kept after the last worker"
grep -q "removed $REAP" "$TMP/out" || fail "the last uninstall does not say it removed $REAP"
grep -q "removed $SBX_UNIT_DIR/sbx-worker@.service" "$TMP/out" && grep -q "removed $SBX_UNIT_DIR/sbx.slice" "$TMP/out" ||
  fail 'the last uninstall does not say it removed the shared units'
[[ ! -s "$M" ]] || fail "the manifest still lists something after the last worker: $(cat "$M")"
[[ -d "$SBX_SRV/workspaces/sbx_default" ]] || fail 'the last uninstall removed workspace data'
# daemon-reload runs after the unit files are gone, so systemd forgets them.
bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'reinstall sbx_default'
: >"$MOCK_LOG"
bash "$INSTALL" --uninstall sbx_default >"$TMP/out" 2>&1 || fail 'uninstall sbx_default again'
[[ "$(tail -1 "$MOCK_LOG")" == 'systemctl daemon-reload' ]] || fail "daemon-reload is not the last step of the undo: $(tail -1 "$MOCK_LOG")"
# sbx.slice is stopped before its file goes: removed alone, it stays loaded in systemd until a reboot.
grep -qx 'systemctl stop sbx.slice' "$MOCK_LOG" || fail 'the last uninstall does not stop sbx.slice'
[[ "$(grep -n 'systemctl stop sbx.slice' "$MOCK_LOG" | cut -d: -f1)" -lt "$(grep -n 'systemctl daemon-reload' "$MOCK_LOG" | tail -1 | cut -d: -f1)" ]] ||
  fail 'sbx.slice is stopped after the daemon-reload'
! grep -q 'systemctl stop sbx-worker@.service' "$MOCK_LOG" || fail 'tried to stop the template unit file itself'
[[ ! -e "$SBX_UNIT_DIR/sbx-worker@.service" ]] || fail 'reinstall + uninstall left the template unit'
pass '--uninstall of the last worker stops sbx.slice, removes it, the shared unit and its VM reaper, then daemon-reloads; workspace data stays'

# The reaper itself (deploy/sbx/reap-vms.sh), on a fake cgroup v2 tree under SBX_CGROUP_ROOT. Each
# fake cgroup holds one real, detached `sleep` (not this shell's child, so a killed one is reaped
# and kill -0 sees it gone). A fake kernel in the background plays cgroup.kill and cgroup.events:
# a `1` in cgroup.kill kills the cgroup's pids, after a delay the reaper has to wait out; a cgroup
# whose pids are all gone is emptied. Either way the cgroup then reports `populated 0`.
CG="$TMP/cgroup"
fake_cg() { # fake_cg DIR [nokill]: a populated cgroup holding one live process; nokill = no cgroup.kill
  mkdir -p "$1"
  (sleep 300 >/dev/null 2>&1 &
    echo $! >"$1/cgroup.procs")
  printf 'populated 1\nfrozen 0\n' >"$1/cgroup.events"
  [[ "${2-}" == nokill ]] || : >"$1/cgroup.kill"
}
alive() { kill -0 "$(cat "$1/cgroup.procs")" 2>/dev/null; }
fake_kernel() {
  local d pid live
  for _ in $(seq 1 200); do
    for d in "$CG"/*/*/*/; do
      d="${d%/}"
      [[ -s "$d/cgroup.procs" ]] || continue
      if [[ -f "$d/cgroup.kill" ]] && grep -qx 1 "$d/cgroup.kill"; then
        sleep 0.5
        while read -r pid; do kill -KILL "$pid" 2>/dev/null || true; done <"$d/cgroup.procs"
      fi
      live=''
      while read -r pid; do ! kill -0 "$pid" 2>/dev/null || live=1; done <"$d/cgroup.procs"
      [[ -n "$live" ]] || { : >"$d/cgroup.procs"; printf 'populated 0\nfrozen 0\n' >"$d/cgroup.events"; }
    done
    sleep 0.05
  done
}
S1="$CG/sbx.slice/sbx-w1.slice" S2="$CG/sbx.slice/sbx-w2.slice"
fake_cg "$S1/pool-0"
fake_cg "$S1/pool-1" nokill # a kernel before 5.14: no cgroup.kill, so SIGKILL from cgroup.procs
fake_cg "$S1/sbx-worker@w1.service"
fake_cg "$S1/pool-x"
fake_cg "$S1/vm-vm-3.scope"
fake_cg "$S2/pool-0"
mkdir -p "$S1/pool-2" && printf 'populated 0\nfrozen 0\n' >"$S1/pool-2/cgroup.events" && : >"$S1/pool-2/cgroup.kill" # already empty
fake_kernel &
KPID=$!
SBX_CGROUP_ROOT="$CG" SERVICE_RESULT=timeout bash "$SRC/deploy/sbx/reap-vms.sh" w1 >"$TMP/out" 2>&1 || fail 'the reaper failed the stop'
kill "$KPID" 2>/dev/null || true
wait "$KPID" 2>/dev/null || true
for p in pool-0 pool-1; do
  grep -qx 'populated 0' "$S1/$p/cgroup.events" || fail "$p was not emptied before the reaper returned"
done
grep -qx 1 "$S1/pool-0/cgroup.kill" || fail 'pool-0 was not killed through cgroup.kill'
grep -q '2 VM cgroup(s) of worker w1 emptied' "$TMP/out" || fail 'the reaper does not report the two cgroups it emptied'
[[ ! -s "$S1/pool-2/cgroup.kill" ]] || fail 'the reaper wrote cgroup.kill of an already empty pool-2'
for d in "$S1/sbx-worker@w1.service" "$S1/pool-x" "$S1/vm-vm-3.scope" "$S2/pool-0"; do
  alive "$d" || fail "the reaper killed ${d#"$CG"/}, which is not one of worker w1's pool-N cgroups"
  [[ ! -f "$d/cgroup.kill" || ! -s "$d/cgroup.kill" ]] || fail "the reaper wrote ${d#"$CG"/}/cgroup.kill"
  kill -KILL "$(cat "$d/cgroup.procs")" 2>/dev/null || true
done
pass "the reaper kills worker w1's pool-N cgroups (cgroup.kill, or SIGKILL without it) and waits for them; w2's slice, the unit's own cgroup and other names untouched"

# It never fails the stop: a missing slice, a bad id and a cgroup that never empties all exit 0.
SBX_CGROUP_ROOT="$CG" bash "$SRC/deploy/sbx/reap-vms.sh" w9 >"$TMP/out" 2>&1 || fail 'a missing slice failed the stop'
[[ ! -s "$TMP/out" ]] || fail "a missing slice is not a silent no-op: $(cat "$TMP/out")"
SBX_CGROUP_ROOT="$CG" bash "$SRC/deploy/sbx/reap-vms.sh" '../w1' >"$TMP/out" 2>&1 || fail 'a bad id failed the stop'
grep -q 'not a worker id' "$TMP/out" || fail 'a bad id is not logged'
fake_cg "$S1/pool-5"
SBX_CGROUP_ROOT="$CG" SBX_REAP_TIMEOUT=1 bash "$SRC/deploy/sbx/reap-vms.sh" w1 >"$TMP/out" 2>&1 || fail 'a cgroup that never empties failed the stop'
grep -q 'pool-5: still populated after 1s' "$TMP/out" || fail "a cgroup that never empties is not logged: $(cat "$TMP/out")"
kill -KILL "$(cat "$S1/pool-5/cgroup.procs")" 2>/dev/null || true
pass 'the reaper exits 0 on a missing slice (silently), a bad id and a cgroup still populated at its timeout (logged)'

# The janitor (spec §8.3): --janitor BUNDLE_DIR installs the script, its env, its token and the two
# units, enables the timer and records all of it as its own manifest kind; --uninstall-janitor
# reverses it; uninstalling the last worker leaves it alone.
JTOKEN="$(printf 'k%.0s' {1..64})"
jbundle() { # jbundle [ENV_TEXT]: a janitor bundle as setup.sh writes it
  local d="$TMP/jbundle"
  rm -rf "$d" && mkdir -p "$d"
  printf '%s' "${1-$'SBX_API_URL=https://sbx-api.apps.example.invalid\nSBX_JANITOR_AGE=3900\n'}" >"$d/janitor.env"
  printf '%s' "$JTOKEN" >"$d/janitor.token"
  echo "$d"
}
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
M="$SBX_ENV_DIR/manifest"

# Refusals, before anything is written or systemd is touched.
for bad in 'SBX_API_URL=http://sbx-api.example.invalid' 'SBX_API_URL=https://x/../y' 'SBX_JANITOR_AGE=1h' \
  $'SBX_API_URL=https://sbx-api.example.invalid\nSBX_JANITOR_AGE=03600' $'SBX_API_URL=https://sbx-api.example.invalid\nSBX_JANITOR_AGE=0900' \
  $'SBX_API_URL=https://sbx-api.example.invalid\nSBX_JANITOR_AGE=60' $'SBX_API_URL=https://sbx-api.example.invalid\nSBX_JANITOR_AGE=0' \
  $'SBX_API_URL=https://sbx-api.example.invalid\nSBX_JANITOR_AGE=3900\nSBX_JANITOR_TOKEN=leaked'; do
  : >"$MOCK_LOG"
  ! bash "$INSTALL" --janitor "$(jbundle "$bad"$'\n')" >"$TMP/out" 2>&1 || fail "installed a janitor bundle with: $bad"
  ! grep -q systemctl "$MOCK_LOG" || fail "touched systemd before refusing: $bad"
  [[ ! -e "$SBX_LIBEXEC_DIR/sbx-janitor.sh" ]] || fail "wrote the janitor before refusing: $bad"
done
d="$(jbundle)"; printf 'tooShortSecret' >"$d/janitor.token"
! bash "$INSTALL" --janitor "$d" >"$TMP/out" 2>&1 || fail 'installed a token under 32 characters'
! grep -q tooShortSecret "$TMP/out" || fail 'the short-token refusal printed the token'
d="$(jbundle)"; printf 'not a cert' >"$d/api-ca.crt"
! bash "$INSTALL" --janitor "$d" >"$TMP/out" 2>&1 || fail 'installed an api-ca.crt that holds no certificate'
mkdir -p "$TMP/nojq"
for t in bash cat grep sed install mkdir chmod rm mv id tail cut touch dirname; do ln -sf "$(command -v "$t")" "$TMP/nojq/$t"; done
ln -sf "$TMP/bin/systemctl" "$TMP/nojq/systemctl"
! PATH="$TMP/nojq" "$TMP/nojq/bash" "$INSTALL" --janitor "$(jbundle)" >"$TMP/out" 2>&1 || fail 'installed the janitor on a host without jq and curl'
grep -q 'needs jq' "$TMP/out" || fail 'the missing-jq refusal does not say so'
pass '--janitor refuses a bad URL, a wait with a leading zero or of 60 s or less, a token in janitor.env, a short token, a bad CA, and a host without jq/curl'

: >"$MOCK_LOG"
d="$(jbundle)"
printf -- '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' >"$d/api-ca.crt"
bash "$INSTALL" --janitor "$d" >"$TMP/out" 2>&1 || fail 'install the janitor'
JE="$SBX_ENV_DIR/janitor.env" JT="$SBX_ENV_DIR/janitor.token" JS="$SBX_LIBEXEC_DIR/sbx-janitor.sh"
[[ "$(mode "$JE")" == 600 && "$(mode "$JT")" == 600 && "$(mode "$JS")" == 755 ]] ||
  fail "modes: env $(mode "$JE"), token $(mode "$JT"), script $(mode "$JS")"
[[ "$(cat "$JT")" == "$JTOKEN" ]] || fail 'janitor.token is not the bundle token'
! grep -qF "$JTOKEN" "$JE" || fail 'the token is in janitor.env'
grep -qx 'SBX_API_URL=https://sbx-api.apps.example.invalid' "$JE" && grep -qx 'SBX_JANITOR_AGE=3900' "$JE" || fail "janitor.env: $(cat "$JE")"
grep -qx "SBX_API_CA_FILE=$SBX_ENV_DIR/janitor-api-ca.crt" "$JE" || fail 'janitor.env does not point at the installed API CA'
[[ -f "$SBX_ENV_DIR/janitor-api-ca.crt" ]] || fail 'the API CA was not installed'
cmp -s "$JS" "$SRC/deploy/sbx/janitor.sh" || fail 'the installed script is not deploy/sbx/janitor.sh'
S="$SBX_UNIT_DIR/sbx-janitor.service"
grep -qx "EnvironmentFile=$SBX_ENV_DIR/janitor.env" "$S" || fail 'the service does not read the installed janitor.env'
grep -qx "Environment=SBX_JANITOR_TOKEN_FILE=$SBX_ENV_DIR/janitor.token" "$S" || fail 'the service does not name the installed token'
grep -qx "Environment=SBX_ENV_DIR=$SBX_ENV_DIR" "$S" && grep -qx "Environment=SBX_SRV=$SBX_SRV" "$S" || fail 'the service does not name the env dir and srv'
grep -qx "ReadWritePaths=-$SBX_SRV/workspaces" "$S" || fail 'the service cannot write the workspace roots'
grep -qx "ExecStart=$JS" "$S" || fail 'the service does not run the installed script'
! grep -q '/etc/sbx\|/srv/sbx\|/usr/local/libexec' "$S" || fail "the service keeps a default path: $(grep -n '/etc/sbx\|/srv/sbx\|/usr/local/libexec' "$S")"
cmp -s "$SBX_UNIT_DIR/sbx-janitor.timer" "$SRC/deploy/sbx/sbx-janitor.timer" || fail 'the timer is not deploy/sbx/sbx-janitor.timer'
grep -A1 -x 'systemctl daemon-reload' "$MOCK_LOG" | grep -qx 'systemctl enable --now sbx-janitor.timer' || fail "the timer is not enabled after a daemon-reload: $(cat "$MOCK_LOG")"
! grep -qF "$JTOKEN" "$MOCK_LOG" "$TMP/out" || fail 'the token reached systemctl argv or the log'
for f in "$JE" "$JT" "$JS" "$S" "$SBX_UNIT_DIR/sbx-janitor.timer" "$SBX_ENV_DIR/janitor-api-ca.crt"; do
  grep -qx "janitor $f" "$M" || fail "the manifest does not record janitor $f: $(cat "$M")"
done
! grep -q '^unit .*janitor' "$M" || fail 'the janitor is recorded as a shared unit (the last worker uninstall would remove it)'
pass '--janitor installs the 0755 script, 0600 env and token, the CA and both units, enables the timer, records each as janitor'

# Re-run without a CA: the CA and its env line go; nothing else changes.
bash "$INSTALL" --janitor "$(jbundle)" >"$TMP/out" 2>&1 || fail 're-install the janitor without a CA'
! grep -q SBX_API_CA_FILE "$JE" && [[ ! -e "$SBX_ENV_DIR/janitor-api-ca.crt" ]] || fail 'a re-install without a CA keeps it'
! grep -qx "janitor $SBX_ENV_DIR/janitor-api-ca.crt" "$M" || fail 'the manifest keeps the dropped CA'
[[ "$(grep -c "^janitor $JE\$" "$M")" == 1 ]] || fail 'a re-install records janitor.env twice'
pass 'a re-install without api-ca.crt drops it and records nothing twice'

# The installed janitor runs from its unit's environment: SBX_ENV_DIR's env file and token.
mkdir -p "$TMP/jbin"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>%q\necho %q\n' "$TMP/jcurl.log" '{"live":[],"terminated":[]}' >"$TMP/jbin/curl"
chmod +x "$TMP/jbin/curl"
(
  set -a
  # shellcheck disable=SC1090 # the installed env file
  . "$JE"
  set +a
  SBX_JANITOR_TOKEN_FILE="$JT" PATH="$TMP/jbin:$PATH" "$JS"
) >"$TMP/out" 2>&1 || fail 'the installed janitor does not run from its env file'
grep -q '"janitor":"summary"' "$TMP/out" || fail 'the installed janitor printed no summary'
pass 'the installed janitor runs from the installed env file and token'

# Uninstalling the last worker leaves the janitor; --uninstall-janitor removes exactly it.
bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'install sbx_default beside the janitor'
bash "$INSTALL" --uninstall sbx_default >"$TMP/out" 2>&1 || fail 'uninstall the last worker'
[[ ! -e "$SBX_UNIT_DIR/sbx-worker@.service" ]] || fail 'the last worker uninstall left the template unit'
[[ -f "$S" && -f "$SBX_UNIT_DIR/sbx-janitor.timer" && -f "$JS" && -f "$JE" && -f "$JT" ]] || fail 'the last worker uninstall removed the janitor'
grep -q '^janitor ' "$M" || fail 'the last worker uninstall dropped the janitor from the manifest'
bash "$INSTALL" "$(bundle sbx_py312)" --snapshot py312 >"$TMP/out" 2>&1 || fail 'install sbx_py312 beside the janitor'
: >"$MOCK_LOG"
bash "$INSTALL" --uninstall-janitor >"$TMP/out" 2>&1 || fail '--uninstall-janitor'
[[ -f "$SBX_ENV_DIR/workers/sbx_py312.env" && -f "$SBX_UNIT_DIR/sbx-worker@.service" && -f "$SBX_UNIT_DIR/sbx-sbx_py312.slice" ]] ||
  fail "--uninstall-janitor removed a worker's files"
grep -q '^worker sbx-worker@sbx_py312 ' "$M" && grep -q '^unit ' "$M" || fail "--uninstall-janitor dropped worker lines: $(cat "$M")"
! grep -q 'disable --now sbx-worker' "$MOCK_LOG" || fail '--uninstall-janitor stopped a worker'
grep -qx 'systemctl disable --now sbx-janitor.timer' "$MOCK_LOG" || fail 'the timer was not disabled'
[[ "$(tail -1 "$MOCK_LOG")" == 'systemctl daemon-reload' ]] || fail 'daemon-reload is not the last step of --uninstall-janitor'
for f in "$S" "$SBX_UNIT_DIR/sbx-janitor.timer" "$JS" "$JE" "$JT"; do [[ ! -e "$f" ]] || fail "--uninstall-janitor left $f"; done
! grep -q '^janitor ' "$M" || fail "--uninstall-janitor left manifest lines: $(cat "$M")"
[[ -d "$SBX_SRV/workspaces/sbx_default" ]] || fail '--uninstall-janitor removed workspace data'
bash "$INSTALL" --uninstall-janitor >"$TMP/out" 2>&1 || fail 'a second --uninstall-janitor fails (it should be a no-op)'
bash "$INSTALL" --uninstall sbx_py312 >"$TMP/out" 2>&1 || fail 'uninstall sbx_py312'
[[ ! -s "$M" ]] || fail "the manifest is not empty once the janitor and every worker are gone: $(cat "$M")"
! bash "$INSTALL" --janitor "$(jbundle)" --uninstall sbx_py312 >"$TMP/out" 2>&1 || fail 'accepted --janitor with --uninstall'
pass 'the last worker uninstall leaves the janitor; --uninstall-janitor removes exactly its files and lines, never a worker'

# Egress (#623): one moca-egress per host, a seeded allowlist, the worker wired to its socket. The
# state is clean here (no worker, no janitor, an empty manifest), so the first install installs the unit.
EM="$SBX_ENV_DIR/manifest"
sha_of() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1 || sha256sum "$1" | cut -d' ' -f1; }
# The default seed is deploy/sbx/egress-allow.env beside the installer.
EXPECTED_ALLOW="$(sed -n 's/^MOCA_EGRESS_ALLOW=//p' "$SRC/deploy/sbx/egress-allow.env" | tail -1)"
[[ -n "$EXPECTED_ALLOW" ]] || fail 'deploy/sbx/egress-allow.env has no MOCA_EGRESS_ALLOW line'
U="$SBX_UNIT_DIR/moca-egress.service" E="$SBX_ENV_DIR/moca-egress.env"
[[ ! -e "$U" && ! -s "$EM" ]] || fail 'the egress block does not start from a clean host'
: >"$MOCK_LOG"
bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 'install with egress'
grep -qx "EnvironmentFile=$E" "$U" || fail 'egress unit does not read this host env file'
! grep -q '^#' "$U" || fail 'egress unit kept source comments'
grep -qx 'ExecStart=/usr/local/bin/moca-egress' "$U" || fail 'egress unit lost its ExecStart'
[[ "$(mode "$E")" == 644 ]] || fail "the egress env file is not 0644 ($(mode "$E"))"
grep -qxF "MOCA_EGRESS_ALLOW=$EXPECTED_ALLOW" "$E" || fail 'allowlist not seeded from deploy/sbx/egress-allow.env'
grep -qx 'MOCA_EGRESS_CONTROL_SOCK=/run/moca-egress/control.sock' "$SBX_ENV_DIR/workers/sbx_eg.env" || fail 'worker not wired to the egress socket'
D="$SBX_UNIT_DIR/sbx-worker@sbx_eg.service.d/egress.conf"
[[ "$(cat "$D" 2>/dev/null)" == $'[Unit]\nAfter=moca-egress.service\nWants=moca-egress.service' ]] || fail "the egress worker's drop-in is not After=/Wants=moca-egress: $(cat "$D" 2>&1)"
! grep -v '^#' "$SBX_UNIT_DIR/sbx-worker@.service" | grep -q 'moca-egress' || fail 'the shared worker unit names moca-egress: every worker would start it'
grep -qx 'systemctl enable moca-egress.service' "$MOCK_LOG" || fail 'moca-egress not enabled'
e="$(grep -nx 'systemctl restart moca-egress.service\|systemctl start moca-egress.service' "$MOCK_LOG" | head -1 | cut -d: -f1)"
w="$(grep -nx 'systemctl restart sbx-worker@sbx_eg.service' "$MOCK_LOG" | cut -d: -f1)"
[[ -n "$e" && -n "$w" ]] && ((e < w)) || fail "moca-egress not started before the worker (egress line '$e', worker line '$w')"
grep -qx "egress unit $U $(sha_of "$U")" "$EM" && grep -qx "egress file $E $(sha_of "$E")" "$EM" || fail "egress files and their digests not in the manifest: $(cat "$EM")"
pass 'installs moca-egress before the worker, seeds the allowlist, wires the socket, records it'

# A --no-egress worker never depends on moca-egress, whatever unit of it the host has; re-installing
# the egress worker with --no-egress drops its drop-in, and --uninstall removes it.
bash "$INSTALL" "$(bundle sbx_noeg)" --snapshot default --no-egress >"$TMP/out" 2>&1 || fail "install --no-egress beside an egress worker: $(cat "$TMP/out")"
[[ ! -e "$SBX_UNIT_DIR/sbx-worker@sbx_noeg.service.d" ]] || fail 'a --no-egress worker got a moca-egress drop-in'
bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default --no-egress >"$TMP/out" 2>&1 || fail 're-install the egress worker with --no-egress'
[[ ! -e "$SBX_UNIT_DIR/sbx-worker@sbx_eg.service.d" ]] || fail 'a re-install with --no-egress kept the moca-egress drop-in'
bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 're-install the egress worker with egress'
[[ -f "$D" ]] || fail 'the drop-in did not come back with egress'
bash "$INSTALL" --uninstall sbx_noeg >"$TMP/out" 2>&1 || fail 'uninstall the --no-egress worker'
pass 'only an egress worker depends on moca-egress (its own drop-in); --no-egress drops it'

# A second worker shares the one moca-egress: nothing to restart, and the unit stays when one worker goes.
: >"$MOCK_LOG"
bash "$INSTALL" "$(bundle sbx_eg2)" --snapshot default >"$TMP/out" 2>&1 || fail 'install a second worker with egress'
! grep -q 'systemctl \(re\)\{0,1\}start moca-egress' "$MOCK_LOG" || fail 'an unchanged moca-egress was restarted'
grep -qx 'systemctl enable moca-egress.service' "$MOCK_LOG" || fail 'the second install did not keep moca-egress enabled'
bash "$INSTALL" --uninstall sbx_eg2 >"$TMP/out" 2>&1 || fail 'uninstall the second worker'
[[ -f "$U" && -f "$E" ]] || fail 'uninstalling one of two workers removed the shared moca-egress'
pass 'a second worker shares moca-egress without restarting it; one uninstall leaves it'

# A moca-egress that is not running is started (after clearing a failed state), not just enabled.
: >"$MOCK_LOG"
MOCK_ACTIVE_RC=3 bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 're-install with moca-egress inactive'
grep -A1 -x 'systemctl reset-failed moca-egress.service' "$MOCK_LOG" | grep -qx 'systemctl start moca-egress.service' ||
  fail 'an inactive moca-egress was not reset and started'
pass 'starts an inactive moca-egress (reset-failed first)'

# An operator's edit survives a re-run.
echo 'MOCA_EGRESS_ALLOW=pypi.org' >"$E"
bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 're-install with egress'
grep -qx 'MOCA_EGRESS_ALLOW=pypi.org' "$E" || fail 'a re-run overwrote the allowlist'
pass 'a re-run keeps an edited allowlist'

# The last uninstall removes the unit it installed, and keeps an env file the operator edited.
bash "$INSTALL" --uninstall sbx_eg >"$TMP/out" 2>&1 || fail 'uninstall sbx_eg'
[[ ! -e "$U" ]] || fail 'the last uninstall kept the egress unit it installed'
grep -qx 'systemctl disable --now moca-egress.service' "$MOCK_LOG" || fail 'moca-egress was not stopped before its unit was removed'
[[ "$(cat "$E")" == 'MOCA_EGRESS_ALLOW=pypi.org' ]] && grep -q "kept $E (edited)" "$TMP/out" || fail 'the last uninstall dropped an edited allowlist'
! grep -q '^egress' "$EM" || fail "egress lines left in the manifest: $(cat "$EM")"
rm -f "$E"
bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 're-install sbx_eg'
bash "$INSTALL" --uninstall sbx_eg >"$TMP/out" 2>&1 || fail 'uninstall sbx_eg again'
[[ ! -e "$U" && ! -e "$E" ]] || fail 'the last uninstall kept an unedited egress env file'
pass 'the last uninstall removes the egress unit, and the env file unless it was edited'

# Without egress-allow.env beside it, the script falls back to the GitHub hosts and says so -- but
# only when the default is actually consumed: a run with MOCA_EGRESS_ALLOW exported, or --no-egress,
# never seeds from it and so never warns.
COPY="$TMP/scriptcopy/deploy/sbx"
mkdir -p "$COPY/../microvm"
cp "$SRC/deploy/sbx/install-host.sh" "$SRC/deploy/sbx/sbx.slice" "$SRC/deploy/sbx/sbx-worker@.service" "$SRC/deploy/sbx/reap-vms.sh" "$COPY/"
cp "$SRC/deploy/microvm/moca-egress.service" "$COPY/../microvm/"
bash "$COPY/install-host.sh" "$(bundle sbx_fb)" --snapshot default >"$TMP/out" 2>&1 || fail 'install from a script copy without egress-allow.env'
grep -q 'falling back to the GitHub hosts' "$TMP/out" || fail 'no fallback warning beside a missing egress-allow.env'
grep -qx 'MOCA_EGRESS_ALLOW=api.github.com,github.com,codeload.github.com,objects.githubusercontent.com' "$E" ||
  fail 'the fallback did not seed the GitHub hosts'
bash "$INSTALL" --uninstall sbx_fb >"$TMP/out" 2>&1 || fail 'uninstall sbx_fb'
MOCA_EGRESS_ALLOW=pypi.org bash "$COPY/install-host.sh" "$(bundle sbx_fb2)" --snapshot default >"$TMP/out" 2>&1 ||
  fail 'install from a script copy with MOCA_EGRESS_ALLOW set'
! grep -q 'falling back to the GitHub hosts' "$TMP/out" || fail 'warned although MOCA_EGRESS_ALLOW was set'
grep -qx 'MOCA_EGRESS_ALLOW=pypi.org' "$E" || fail 'the exported allowlist was not seeded'
bash "$COPY/install-host.sh" "$(bundle sbx_fb3)" --snapshot default --no-egress >"$TMP/out" 2>&1 ||
  fail 'install from a script copy with --no-egress'
! grep -q 'falling back to the GitHub hosts' "$TMP/out" || fail 'warned although --no-egress was given'
for id in sbx_fb2 sbx_fb3; do bash "$INSTALL" --uninstall "$id" >"$TMP/out" 2>&1 || fail "uninstall $id"; done
rm -rf "$TMP/scriptcopy"
pass 'seeds the GitHub hosts (with a warning) when egress-allow.env is missing beside the script, and stays quiet when the default is not used'

# A unit this script did not install is reused, not overwritten.
echo '# P6-owned' >"$U"
: >"$MOCK_LOG"
bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 'install beside a P6 moca-egress'
[[ "$(cat "$U")" == '# P6-owned' ]] || fail 'overwrote a moca-egress.service it did not install'
grep -q 'reusing the existing moca-egress.service' "$TMP/out" || fail 'did not say it reused the unit'
! grep -q '^egress' "$EM" || fail 'recorded a unit it does not own'
[[ ! -e "$E" ]] || fail 'wrote an allowlist beside a unit it does not own'
! grep -v 'is-active' "$MOCK_LOG" | grep -q 'moca-egress.service' || fail 'changed a moca-egress.service it does not own'
grep -qx 'MOCA_EGRESS_CONTROL_SOCK=/run/moca-egress/control.sock' "$SBX_ENV_DIR/workers/sbx_eg.env" || fail 'worker not wired to the reused moca-egress'
bash "$INSTALL" --uninstall sbx_eg >"$TMP/out" 2>&1 || fail 'uninstall beside P6'
[[ "$(cat "$U")" == '# P6-owned' ]] || fail 'uninstall removed a unit it did not install'
rm -f "$U"
pass 'reuses (and never removes) a moca-egress.service it did not install'

# Refusals and the opt-out.
rm "$SBX_BIN_DIR/moca-egress"; : >"$MOCK_LOG"
! bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 'installed with no moca-egress binary'
grep -q 'go build -o /usr/local/bin/moca-egress' "$TMP/out" || fail 'missing-binary refusal does not name the build'
! grep -q 'systemctl' "$MOCK_LOG" || fail 'touched systemd before refusing a missing binary'
[[ ! -e "$U" ]] || fail 'wrote the egress unit before refusing a missing binary'
bash "$INSTALL" "$(bundle sbx_ne)" --snapshot default --no-egress >"$TMP/out" 2>&1 || fail '--no-egress install'
! grep -q MOCA_EGRESS_CONTROL_SOCK "$SBX_ENV_DIR/workers/sbx_ne.env" || fail '--no-egress still wired the socket'
[[ ! -e "$U" ]] || fail '--no-egress installed the egress unit'
bash "$INSTALL" --uninstall sbx_ne >"$TMP/out" 2>&1 || fail 'uninstall sbx_ne'
pass 'refuses a missing binary before touching systemd; --no-egress installs a worker without egress'

# A socket that never appears fails, naming moca-egress's journal.
fake_egress; rm -f "$MOCA_EGRESS_SOCKET"
! bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 'succeeded with no control socket'
grep -q 'journalctl -u moca-egress' "$TMP/out" || fail 'socket timeout does not name the journal'
fake_socket
bash "$INSTALL" --uninstall sbx_eg >"$TMP/out" 2>&1 || fail 'uninstall after the socket timeout'
rm -f "$E"
[[ ! -s "$EM" ]] || fail "the manifest is not empty after the egress block: $(cat "$EM")"
pass 'fails naming journalctl -u moca-egress when the control socket never appears'

# Ownership is by content (review of #627). setup-microvm.sh (P6) overwrites moca-egress.service at the
# same path with its own copy; after that this script must reuse it, never rewrite or remove it.
bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 'install before the P6 overwrite'
printf '[Service]\nEnvironmentFile=/etc/serverless-harness/moca-egress.env\nExecStart=/usr/local/bin/moca-egress\n' >"$U"
P6="$(cat "$U")"
: >"$MOCK_LOG"
bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 're-run after the P6 overwrite'
[[ "$(cat "$U")" == "$P6" ]] || fail 'a re-run overwrote a unit another install had replaced'
grep -q 'changed by another install; reusing it' "$TMP/out" || fail 'did not say the unit was changed by another install'
! grep -q "^egress unit" "$EM" || fail 'kept its claim on a unit another install replaced'
! grep -q 'moca-egress.service' <(grep -v 'is-active' "$MOCK_LOG") || fail 'touched a unit another install replaced'
bash "$INSTALL" --uninstall sbx_eg >"$TMP/out" 2>&1 || fail 'uninstall after the P6 overwrite'
[[ "$(cat "$U")" == "$P6" ]] || fail 'the last uninstall removed a unit another install had replaced'
! grep -q 'disable --now moca-egress' "$MOCK_LOG" || fail 'the last uninstall stopped a moca-egress it no longer owns'
rm -f "$U" "$E"
pass 'a unit replaced by another install is reused on a re-run and kept on the last uninstall'

# Reusing a unit that is not running dies with its own message, before any worker restart.
echo '# P6-owned' >"$U"
: >"$MOCK_LOG"
! MOCK_EGRESS_ACTIVE_RC=3 bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 'reused an inactive moca-egress'
grep -q 'not installed by this script) is not running: start it or fix the install that owns it' "$TMP/out" || fail 'no inactive-reuse message'
! grep -q 'restart sbx-worker' "$MOCK_LOG" || fail 'restarted the worker beside an inactive moca-egress'
rm -f "$U"
# And a socket that never appears beside a reused unit names the env file THAT unit reads.
printf '[Service]\nEnvironmentFile=/etc/serverless-harness/moca-egress.env\n' >"$U"
rm -f "$MOCA_EGRESS_SOCKET"
! bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 'succeeded with no control socket beside a reused unit'
grep -q 'bad /etc/serverless-harness/moca-egress.env' "$TMP/out" || fail "the hint does not name the reused unit's env file"
fake_socket; rm -f "$U"
pass 'reusing a stopped unit fails before the worker restart; the socket hint names the reused unit'"'"'s env file'

# The env file is judged unedited by its recorded digest, not by the uninstaller's MOCA_EGRESS_ALLOW.
MOCA_EGRESS_ALLOW=pypi.org bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 'install with a custom allowlist'
grep -qx 'MOCA_EGRESS_ALLOW=pypi.org' "$E" || fail 'custom allowlist not seeded'
bash "$INSTALL" --uninstall sbx_eg >"$TMP/out" 2>&1 || fail 'uninstall without MOCA_EGRESS_ALLOW'
[[ ! -e "$E" && ! -e "$U" ]] || fail 'an unedited custom-seeded env file (or the unit) survived the uninstall'
MOCA_EGRESS_ALLOW=pypi.org bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 'install again'
echo 'MOCA_EGRESS_ALLOW=pypi.org,example.org' >"$E"
bash "$INSTALL" --uninstall sbx_eg >"$TMP/out" 2>&1 || fail 'uninstall with an edited env'
[[ -f "$E" ]] && grep -q "kept $E (edited)" "$TMP/out" || fail 'an edited env file was not kept'
rm -f "$E"
pass 'an env seeded from a custom allowlist is removed by its digest; an edited one is kept'

# A manifest from before digests (two fields) still uninstalls cleanly, and an unknown kind survives.
bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 'install for the old-manifest case'
sed -i.bak 's/^\(egress [a-z]* [^ ]*\) [0-9a-f]\{64\}$/\1/' "$EM"; rm -f "$EM.bak"
! grep -Eq '^egress .* [0-9a-f]{64}$' "$EM" && grep -q '^egress unit ' "$EM" || fail "could not build a two-field manifest: $(cat "$EM")"
echo "egress foo $TMP/foo.file" >>"$EM"; echo keep >"$TMP/foo.file"
bash "$INSTALL" --uninstall sbx_eg >"$TMP/out" 2>&1 || fail 'uninstall with a two-field manifest'
[[ ! -e "$U" && ! -e "$E" ]] || fail 'a two-field manifest did not uninstall the unit and env file'
grep -qx "egress foo $TMP/foo.file" "$EM" && [[ -f "$TMP/foo.file" ]] || fail 'an unknown egress kind was dropped'
sed -i.bak '/^egress foo /d' "$EM"; rm -f "$EM.bak"
[[ ! -s "$EM" ]] || fail "manifest not empty at the end: $(cat "$EM")"
pass 'a two-field manifest uninstalls cleanly; an unknown egress kind is left alone'

# An env file holding the legacy GitHub-only seed was written by an older script's fresh install,
# not by an operator: with no digest recorded, the last uninstall removes it too.
bash "$INSTALL" "$(bundle sbx_eg)" --snapshot default >"$TMP/out" 2>&1 || fail 'install for the legacy-seed case'
printf 'MOCA_EGRESS_ALLOW=api.github.com,github.com,codeload.github.com,objects.githubusercontent.com\n' >"$E"
sed -i.bak 's/^\(egress [a-z]* [^ ]*\) [0-9a-f]\{64\}$/\1/' "$EM"; rm -f "$EM.bak"
bash "$INSTALL" --uninstall sbx_eg >"$TMP/out" 2>&1 || fail 'uninstall with the legacy seed'
[[ ! -e "$E" && ! -e "$U" ]] || fail 'an untouched legacy seed was kept as an edit'
pass 'an env file holding the legacy GitHub-only seed is removed by the last uninstall'

# Egress credentials (SBX0.2b, spec §6.2): --egress installs the host CA, the token and a unit drop-in;
# a worker install checks the snapshot's egress_ca_sha256 once the drop-in exists.
CD="$SBX_ENV_DIR/egress" DROPIN="$SBX_UNIT_DIR/moca-egress.service.d/sbx-credentials.conf"
TOKEN="$(printf 'ab%.0s' $(seq 32))"
ebundle() { # ebundle [API_CA]: an egress bundle as setup.sh writes it
  local d="$TMP/ebundle"
  rm -rf "$d"; mkdir -p "$d"
  printf 'MOCA_EGRESS_CREDENTIALS_URL=https://sbx-api.apps.example.invalid\n' >"$d/egress.env"
  printf '%s' "$TOKEN" >"$d/egress.token"
  [[ -z "${1:-}" ]] || printf -- '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' >"$d/api-ca.crt"
  echo "$d"
}
fp_of() { openssl x509 -in "$1" -outform DER | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1; }
snap_with() { # snap_with NAME FINGERPRINT-or-empty
  mkdir -p "$SBX_SRV/snapshots/$1"
  if [[ -n "$2" ]]; then
    printf '{\n  "hash": "x",\n  "guest_ram_mb": 256,\n  "egress_ca_sha256": "sha256:%s"\n}\n' "$2" >"$SBX_SRV/snapshots/$1/manifest.json"
  else
    printf '{\n  "hash": "x",\n  "guest_ram_mb": 256\n}\n' >"$SBX_SRV/snapshots/$1/manifest.json"
  fi
}
[[ ! -s "$EM" ]] || fail 'the credentials block does not start from a clean host'
bash "$INSTALL" "$(bundle sbx_cr)" --snapshot default >"$TMP/out" 2>&1 || fail 'install the worker before --egress'
# No drop-in yet: no fingerprint check (chunk 1's behaviour), the snapshot above has no manifest.json.

# A bad bundle is refused before anything is written.
: >"$MOCK_LOG"
b="$(ebundle)"; printf 'MOCA_EGRESS_CREDENTIALS_URL=http://x\n' >"$b/egress.env"
! bash "$INSTALL" --egress "$b" >"$TMP/out" 2>&1 || fail 'accepted an http credentials URL'
b="$(ebundle)"; printf 'MOCA_EGRESS_CREDENTIALS_URL=https://x.invalid\nOTHER=1\n' >"$b/egress.env"
! bash "$INSTALL" --egress "$b" >"$TMP/out" 2>&1 || fail 'accepted an extra line in egress.env'
b="$(ebundle)"; printf 'short' >"$b/egress.token"
! bash "$INSTALL" --egress "$b" >"$TMP/out" 2>&1 || fail 'accepted a short token'
! grep -q short "$TMP/out" || fail 'the refusal printed the token'
[[ ! -e "$CD" && ! -e "$DROPIN" ]] || fail 'wrote credential files before refusing a bad bundle'
pass '--egress refuses a bad URL, an extra line and a malformed token before writing anything'

: >"$MOCK_LOG"
bash "$INSTALL" --egress "$(ebundle api)" >"$TMP/out" 2>&1 || fail '--egress'
[[ "$(mode "$CD/ca.crt")" == 644 && "$(mode "$CD/ca.key")" == 600 && "$(mode "$CD/token")" == 600 ]] ||
  fail "credential file modes are not 644/600/600 ($(mode "$CD/ca.crt") $(mode "$CD/ca.key") $(mode "$CD/token"))"
FP1="$(fp_of "$CD/ca.crt")"
openssl x509 -in "$CD/ca.crt" -noout -text | grep -q 'CA:TRUE' || fail 'the host CA is not a CA'
for l in "LoadCredential=egress-token:$CD/token" "LoadCredential=egress-ca.crt:$CD/ca.crt" "LoadCredential=egress-ca.key:$CD/ca.key" \
  "LoadCredential=egress-api-ca.crt:$CD/api-ca.crt" 'Environment=MOCA_EGRESS_CREDENTIALS_URL=https://sbx-api.apps.example.invalid'; do
  grep -qx "$l" "$DROPIN" || fail "the drop-in lacks $l"
done
! grep -rq "$TOKEN" "$SBX_UNIT_DIR" "$TMP/out" || fail 'the token appears in a unit file or the output'
! grep -q "$TOKEN" "$MOCK_LOG" || fail 'the token appears in a command line'
! grep -q 'PRIVATE KEY' "$TMP/out" || fail 'the CA key was printed'
[[ "$(cat "$CD/token")" == "$TOKEN" ]] || fail 'the token file does not hold the token'
for f in "$DROPIN" "$CD/ca.crt" "$CD/ca.key" "$CD/token" "$CD/api-ca.crt"; do grep -qx "egress credential $f" "$EM" || fail "manifest lacks egress credential $f"; done
grep -qx 'systemctl daemon-reload' "$MOCK_LOG" && grep -qx 'systemctl restart moca-egress.service' "$MOCK_LOG" || fail '--egress did not daemon-reload and restart moca-egress'
pass '--egress: CA 0644/0600, token 0600, drop-in with the four LoadCredential lines and the URL, no token leak, recorded'

bash "$INSTALL" --egress "$(ebundle)" >"$TMP/out" 2>&1 || fail '--egress re-run'
[[ "$(fp_of "$CD/ca.crt")" == "$FP1" ]] || fail 'a re-run regenerated the CA'
! grep -q 'egress-api-ca.crt' "$DROPIN" && [[ ! -e "$CD/api-ca.crt" ]] || fail 'a re-run without an api CA kept the old one'
[[ "$(bash "$INSTALL" --egress-ca-out)" == "$CD/ca.crt" ]] || fail '--egress-ca-out does not print the CA path'
[[ "$(fp_of "$CD/ca.crt")" == "$FP1" ]] || fail '--egress-ca-out regenerated the CA'
pass 'the CA is generated once: the fingerprint survives a re-run; --egress-ca-out prints its path'

# The fingerprint check: before any systemctl call, naming the rebuild command.
for case in missing mismatch; do
  snap_with fpbad "$([[ $case == mismatch ]] && printf '%064d' 1)"
  : >"$MOCK_LOG"
  ! bash "$INSTALL" "$(bundle sbx_cr)" --snapshot fpbad >"$TMP/out" 2>&1 || fail "installed a worker on a $case fingerprint"
  grep -q "deploy/microvm/build-snapshot.sh --egress-ca $CD/ca.crt --out $SBX_SRV/snapshots/<new image>" "$TMP/out" || fail "the $case refusal does not name the rebuild command"
  ! grep -q systemctl "$MOCK_LOG" || fail "touched systemd before refusing a $case fingerprint"
done
snap_with fpok "$FP1"
bash "$INSTALL" "$(bundle sbx_cr)" --snapshot fpok >"$TMP/out" 2>&1 || fail 'refused a matching fingerprint'
pass 'a worker install refuses a missing or mismatched egress_ca_sha256 before systemctl, and accepts a match'

# --egress warns (never refuses: the fresh-host order installs the worker first) for each installed
# worker whose snapshot does not trust this host's CA. sbx_cr now runs fpok, which does.
bash "$INSTALL" --egress "$(ebundle)" >"$TMP/out" 2>&1 || fail '--egress with a trusting worker snapshot'
! grep -q 'WARNING' "$TMP/out" || fail "warned although the worker's snapshot trusts the CA"
for case in missing mismatch; do
  snap_with fpwarn "$([[ $case == mismatch ]] && printf '%064d' 1)"
  sed -i.bak 's/^SH_SNAPSHOT_IMAGE=.*/SH_SNAPSHOT_IMAGE=fpwarn/' "$SBX_ENV_DIR/workers/sbx_cr.env" && rm -f "$SBX_ENV_DIR/workers/sbx_cr.env.bak"
  bash "$INSTALL" --egress "$(ebundle)" >"$TMP/out" 2>&1 || fail "--egress refused a $case fingerprint (it must only warn)"
  grep -qF "WARNING: worker sbx_cr runs snapshot fpwarn, which does not trust this host's CA; guests will see TLS failures on intercepted hosts until it is reinstalled on a snapshot built with --egress-ca" "$TMP/out" ||
    fail "no warning for a $case fingerprint"
done
# A --no-egress worker's guest has no network: no warning for it, whatever its snapshot.
cp "$SBX_ENV_DIR/workers/sbx_cr.env" "$SBX_ENV_DIR/workers/sbx_off.env"
sed -i.bak -e '/^MOCA_EGRESS_CONTROL_SOCK=/d' "$SBX_ENV_DIR/workers/sbx_off.env" && rm -f "$SBX_ENV_DIR/workers/sbx_off.env.bak"
bash "$INSTALL" --egress "$(ebundle)" >"$TMP/out" 2>&1 || fail '--egress beside a --no-egress worker'
grep -q 'WARNING: worker sbx_cr runs snapshot fpwarn' "$TMP/out" || fail 'the egress worker on an untrusting snapshot is no longer warned about'
! grep -q 'WARNING: worker sbx_off' "$TMP/out" || fail 'a --no-egress worker was warned about'
rm -f "$SBX_ENV_DIR/workers/sbx_off.env"
sed -i.bak 's/^SH_SNAPSHOT_IMAGE=.*/SH_SNAPSHOT_IMAGE=fpok/' "$SBX_ENV_DIR/workers/sbx_cr.env" && rm -f "$SBX_ENV_DIR/workers/sbx_cr.env.bak"
pass '--egress warns for a worker whose snapshot lacks or mismatches the CA fingerprint, and stays quiet for a match or a --no-egress worker'

# Uninstall: the drop-in, token and api CA go; the CA stays.
bash "$INSTALL" --egress "$(ebundle api)" >"$TMP/out" 2>&1 || fail '--egress for the uninstall case'
: >"$MOCK_LOG"
bash "$INSTALL" --uninstall-egress >"$TMP/out" 2>&1 || fail '--uninstall-egress'
[[ ! -e "$DROPIN" && ! -e "$CD/token" && ! -e "$CD/api-ca.crt" ]] || fail '--uninstall-egress left the drop-in, token or api CA'
[[ -f "$CD/ca.crt" && -f "$CD/ca.key" && "$(fp_of "$CD/ca.crt")" == "$FP1" ]] || fail '--uninstall-egress removed the CA'
grep -q 'kept for the snapshot' "$TMP/out" || fail 'did not log that the CA is kept for the snapshot'
grep -qx 'systemctl restart moca-egress.service' "$MOCK_LOG" || fail '--uninstall-egress did not restart moca-egress'
grep -q '^egress credential' "$EM" && ! grep -q "egress credential $DROPIN" "$EM" || fail "manifest after --uninstall-egress: $(cat "$EM")"
bash "$INSTALL" "$(bundle sbx_cr)" --snapshot default >"$TMP/out" 2>&1 || fail 'no check once the drop-in is gone'
pass '--uninstall-egress removes the drop-in, token and api CA, keeps the CA, restarts moca-egress'

# The last worker's uninstall removes the credential files the same way.
bash "$INSTALL" --egress "$(ebundle api)" >"$TMP/out" 2>&1 || fail '--egress before the last uninstall'
bash "$INSTALL" --uninstall sbx_cr >"$TMP/out" 2>&1 || fail 'last uninstall with credentials'
[[ ! -e "$DROPIN" && ! -e "$CD/token" && ! -e "$CD/api-ca.crt" && ! -e "$U" ]] || fail 'the last uninstall left credential files or the unit'
[[ -f "$CD/ca.crt" ]] || fail 'the last uninstall removed the CA'
grep -qF 'credential injection removed with the last worker; re-run install-host.sh --egress after installing a worker' "$TMP/out" ||
  fail 'the last uninstall did not say it removed credential injection'
SBX_ENV_DIR='/tmp/a b' bash "$INSTALL" --egress-ca-out >"$TMP/out" 2>&1 && fail '--egress-ca-out accepted a non-plain SBX_ENV_DIR'
grep -q 'must be a plain absolute path' "$TMP/out" || fail '--egress-ca-out did not name the path rule'
pass 'the last-worker uninstall removes the credential files, keeps the CA and says to re-run --egress; --egress-ca-out checks SBX_ENV_DIR'

# A foreign moca-egress.service is never configured from here.
echo '# P6-owned' >"$U"; : >"$MOCK_LOG"
! bash "$INSTALL" --egress "$(ebundle)" >"$TMP/out" 2>&1 || fail '--egress accepted a foreign moca-egress.service'
grep -q "P6" "$TMP/out" && grep -q 'own installer' "$TMP/out" || fail 'the foreign refusal does not name the P6 unit and its installer'
[[ ! -e "$DROPIN" && ! -s "$MOCK_LOG" ]] || fail 'wrote or touched systemd before refusing a foreign unit'
rm -f "$U"
pass '--egress refuses a moca-egress.service this script did not install'

# Clean up the kept CA: the host is empty again.
rm -rf "$CD"; sed -i.bak '/^egress credential /d' "$EM"; rm -f "$EM.bak"
[[ ! -s "$EM" ]] || fail "manifest not empty at the end of the credentials block: $(cat "$EM")"

# The guest RAM comes from the snapshot's manifest, never the unit's 256: a 4096 MiB snapshot sized as
# 256 would be admitted at a sixteenth of its cost and run in a cgroup too small for its memfile.
snap big 4096
bash "$INSTALL" "$(bundle sbx_big)" --snapshot big --budget-mb 16384 >"$TMP/out" 2>&1 || fail 'install a 4096 MiB snapshot'
grep -qx 'SH_GUEST_RAM_MB=4096' "$SBX_ENV_DIR/workers/sbx_big.env" || fail 'SH_GUEST_RAM_MB is not the manifest guest_ram_mb'
bash "$INSTALL" "$(bundle sbx_small)" --snapshot default >"$TMP/out" 2>&1 || fail 'install a 256 MiB snapshot'
grep -qx 'SH_GUEST_RAM_MB=256' "$SBX_ENV_DIR/workers/sbx_small.env" || fail "sbx_small: SH_GUEST_RAM_MB is not its snapshot's 256"
for w in sbx_big sbx_small; do bash "$INSTALL" --uninstall "$w" >"$TMP/out" 2>&1 || fail "uninstall $w"; done
# A budget that cannot hold one session ((4096 + 32) x 3 + 1024 = 13408) is refused, naming the need.
: >"$MOCK_LOG"
! bash "$INSTALL" "$(bundle sbx_big)" --snapshot big --budget-mb 8192 >"$TMP/out" 2>&1 || fail 'accepted a budget below one session'
grep -q 'needs at least 13408 MiB' "$TMP/out" || fail 'the budget refusal does not name the 13408 MiB need'
! grep -q systemctl "$MOCK_LOG" || fail 'touched systemd before refusing a small budget'
# A manifest without guest_ram_mb, or no manifest at all, is refused before systemd is touched.
for case in field file; do
  mkdir -p "$SBX_SRV/snapshots/noram"
  if [[ $case == field ]]; then printf '{"hash": "x"}\n' >"$SBX_SRV/snapshots/noram/manifest.json"; else rm -f "$SBX_SRV/snapshots/noram/manifest.json"; fi
  : >"$MOCK_LOG"
  ! bash "$INSTALL" "$(bundle sbx_noram)" --snapshot noram >"$TMP/out" 2>&1 || fail "installed a snapshot with no guest_ram_mb ($case)"
  grep -q 'has no guest_ram_mb' "$TMP/out" || fail "the no-guest_ram_mb refusal ($case) does not say why"
  ! grep -q systemctl "$MOCK_LOG" || fail "touched systemd before refusing no guest_ram_mb ($case)"
done
pass "the worker's SH_GUEST_RAM_MB is its snapshot's guest_ram_mb; a manifest without it, or a budget below one session, is refused"

# SBX_WORKER_BIN: the unit runs that binary (never deploy/microvm's /usr/local/bin/microvm-worker),
# and a missing one is refused before systemd is touched.
bash "$INSTALL" "$(bundle sbx_bin)" --snapshot default >"$TMP/out" 2>&1 || fail 'install with SBX_WORKER_BIN'
grep -qx "ExecStart=$SBX_WORKER_BIN" "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'the unit does not run SBX_WORKER_BIN'
bash "$INSTALL" --uninstall sbx_bin >"$TMP/out" 2>&1 || fail 'uninstall sbx_bin'
: >"$MOCK_LOG"
! SBX_WORKER_BIN="$TMP/nowhere/microvm-worker" bash "$INSTALL" "$(bundle sbx_bin)" --snapshot default >"$TMP/out" 2>&1 ||
  fail 'installed with a missing SBX_WORKER_BIN'
grep -q "no worker binary $TMP/nowhere/microvm-worker" "$TMP/out" || fail 'the missing-binary refusal does not name the path'
! grep -q systemctl "$MOCK_LOG" || fail 'touched systemd before refusing a missing worker binary'
# Unset, it is SBX0's own build under libexec, never the /usr/local/bin one another install runs.
: >"$MOCK_LOG"
! env -u SBX_WORKER_BIN bash "$INSTALL" "$(bundle sbx_bin)" --snapshot default >"$TMP/out" 2>&1 ||
  fail 'installed with the default SBX_WORKER_BIN on a host without it'
grep -q 'no worker binary /usr/local/libexec/sbx/microvm-worker' "$TMP/out" || fail 'the default SBX_WORKER_BIN is not /usr/local/libexec/sbx/microvm-worker'
! grep -q systemctl "$MOCK_LOG" || fail 'touched systemd before refusing the missing default worker binary'
# A path ExecStart's sed rewrite could not carry (# or &) is refused, even if it exists and runs.
odd="$TMP/odd#dir/microvm-worker"; mkdir -p "${odd%/*}"; : >"$odd"; chmod +x "$odd"
: >"$MOCK_LOG"
! SBX_WORKER_BIN="$odd" bash "$INSTALL" "$(bundle sbx_bin)" --snapshot default >"$TMP/out" 2>&1 ||
  fail 'installed with a SBX_WORKER_BIN holding #'
! grep -q systemctl "$MOCK_LOG" || fail 'touched systemd before refusing an unusable SBX_WORKER_BIN'
pass 'the unit runs SBX_WORKER_BIN (default /usr/local/libexec/sbx/microvm-worker); a missing one is refused before systemd'

# The budget check's copies of the unit's standby depth and reserve match the unit, so they cannot drift.
for k in STANDBY_DEPTH MEMORY_RESERVE_MB; do
  unit="$(sed -n "s/^Environment=SH_${k}=//p" "$SRC/deploy/sbx/sbx-worker@.service")"
  script="$(grep -oE "(^| )${k}=[0-9]+" "$INSTALL" | head -n1 | cut -d= -f2)"
  [[ -n "$unit" && "$unit" == "$script" ]] || fail "install-host.sh's $k ($script) is not the unit's ($unit)"
done
pass "install-host.sh's standby depth and memory reserve are the unit's"
# Snapshot read-ahead: a fake sysfs with a partitioned disk (nvme1n1p1, 259:1), a dm device
# (dm-0, 253:0) and a device without a queue (7:9). The install finds the device by MAJ:MIN at
# every run, records the value before the first install, and the last uninstall writes it back.
SYS="$SBX_SYSFS" RAU="$SBX_UNIT_DIR/sbx-read-ahead.service" RAO="$SBX_ENV_DIR/read-ahead.orig" RAH="$SBX_LIBEXEC_DIR/sbx-read-ahead.sh"
DISK="$SYS/devices/pci0/nvme/nvme1/nvme1n1" DM="$SYS/devices/virtual/block/dm-0"
mkdir -p "$DISK/queue" "$DISK/nvme1n1p1" "$DM/queue" "$SYS/devices/virtual/noqueue" "$SYS/dev/block"
: >"$DISK/nvme1n1p1/partition"
ln -s ../../devices/pci0/nvme/nvme1/nvme1n1/nvme1n1p1 "$SYS/dev/block/259:1"
ln -s ../../devices/virtual/block/dm-0 "$SYS/dev/block/253:0"
ln -s ../../devices/virtual/noqueue "$SYS/dev/block/7:9"
echo 128 >"$DISK/queue/read_ahead_kb"; echo 256 >"$DM/queue/read_ahead_kb"
[[ ! -s "$EM" ]] || fail 'the read-ahead block does not start from a clean host'
export MOCK_FINDMNT_MAJMIN=259:1

# A bad value is refused before anything is written or systemd is touched.
for bad in abc -1 08 1.5 16385 99999 ' 512'; do
  : >"$MOCK_LOG"
  ! SBX_READ_AHEAD_KB="$bad" bash "$INSTALL" "$(bundle sbx_ra)" --snapshot default >"$TMP/out" 2>&1 || fail "accepted SBX_READ_AHEAD_KB='$bad'"
  grep -q 'SBX_READ_AHEAD_KB=' "$TMP/out" || fail "the '$bad' refusal does not name SBX_READ_AHEAD_KB"
  ! grep -q systemctl "$MOCK_LOG" || fail "touched systemd before refusing SBX_READ_AHEAD_KB='$bad'"
  [[ ! -e "$RAU" && ! -e "$SBX_ENV_DIR/workers/sbx_ra.env" ]] || fail "wrote files before refusing SBX_READ_AHEAD_KB='$bad'"
done
[[ "$(cat "$DISK/queue/read_ahead_kb")" == 128 ]] || fail 'a refused value changed the device'
pass 'refuses an SBX_READ_AHEAD_KB that is not 0..16384 in decimal before touching anything'

# The default, on a partition: the parent disk's queue is set, the unit carries 512.
: >"$MOCK_LOG"
bash "$INSTALL" "$(bundle sbx_ra)" --snapshot default >"$TMP/out" 2>&1 || fail 'install with the default read-ahead'
[[ "$(cat "$DISK/queue/read_ahead_kb")" == 512 ]] || fail "the disk under the partition was not set to 512: $(cat "$DISK/queue/read_ahead_kb")"
grep -q 'nvme1n1 read_ahead_kb 128 -> 512' "$TMP/out" || fail 'the install does not say what it changed'
grep -qx "ExecStart=$RAH set $SBX_SRV 512" "$RAU" || fail "the unit does not carry 512: $(cat "$RAU")"
for l in Type=oneshot RemainAfterExit=yes WantedBy=multi-user.target "RequiresMountsFor=$SBX_SRV" Before=sbx.slice; do
  grep -qx "$l" "$RAU" || fail "the unit lacks $l: $(cat "$RAU")"
done
grep '^After=' "$SBX_UNIT_DIR/sbx-worker@.service" | grep -q 'sbx-read-ahead.service' || fail 'the worker is not ordered after sbx-read-ahead'
! grep -q nvme1n1 "$RAU" || fail 'the unit names the device (it must find it by path at boot)'
cmp -s "$RAH" "$SRC/deploy/sbx/sbx-read-ahead.sh" && [[ "$(mode "$RAH")" == 755 ]] || fail 'the helper is not installed 0755'
[[ "$(cat "$RAO")" == 128 && "$(mode "$RAO")" == 600 ]] || fail "the original value was not recorded 0600: $(cat "$RAO")"
for f in "$RAU" "$RAO" "$RAH"; do grep -qx "readahead $f" "$EM" || fail "the manifest lacks readahead $f"; done
e="$(grep -nx 'systemctl enable sbx-read-ahead.service' "$MOCK_LOG" | cut -d: -f1)"
w="$(grep -nx 'systemctl restart sbx-worker@sbx_ra.service' "$MOCK_LOG" | cut -d: -f1)"
[[ -n "$e" && -n "$w" && "$e" -lt "$w" ]] || fail "sbx-read-ahead not enabled before the worker restart ('$e', '$w')"
pass 'the default 512 goes into the unit and onto the partition'"'"'s disk; the old value is recorded; enabled before the worker starts'

# A re-run with another value rewrites the unit and keeps the first recorded value; the boot run works.
SBX_READ_AHEAD_KB=1024 bash "$INSTALL" "$(bundle sbx_ra)" --snapshot default >"$TMP/out" 2>&1 || fail 're-run with 1024'
[[ "$(cat "$DISK/queue/read_ahead_kb")" == 1024 && "$(cat "$RAO")" == 128 ]] || fail 'a re-run did not set 1024 or lost the first recorded value'
grep -qx "ExecStart=$RAH set $SBX_SRV 1024" "$RAU" || fail 'the unit does not carry 1024'
[[ "$(grep -c '^readahead ' "$EM")" == 3 ]] || fail "a re-run recorded readahead lines twice: $(cat "$EM")"
echo 128 >"$DISK/queue/read_ahead_kb" # a reboot
"$RAH" set "$SBX_SRV" 1024 >"$TMP/out" 2>&1 || fail 'the boot run failed'
[[ "$(cat "$DISK/queue/read_ahead_kb")" == 1024 ]] || fail 'the boot run did not set the value'
pass 'a re-run rewrites the unit, keeps the first recorded value; the unit'"'"'s command sets it again after a reboot'

# The last uninstall writes the recorded value back and removes the unit, helper and record.
: >"$MOCK_LOG"
bash "$INSTALL" --uninstall sbx_ra >"$TMP/out" 2>&1 || fail 'the last uninstall with read-ahead'
[[ "$(cat "$DISK/queue/read_ahead_kb")" == 128 ]] || fail "the last uninstall did not restore 128: $(cat "$DISK/queue/read_ahead_kb")"
grep -qx 'systemctl disable --now sbx-read-ahead.service' "$MOCK_LOG" || fail 'sbx-read-ahead was not disabled and stopped'
[[ ! -e "$RAU" && ! -e "$RAO" && ! -e "$RAH" ]] || fail 'the last uninstall left a read-ahead file'
[[ ! -s "$EM" ]] || fail "the manifest is not empty after the last uninstall: $(cat "$EM")"
pass 'the last uninstall restores the recorded value, disables and removes the unit, helper and record'

# One of two workers going leaves it; a dm device has its own queue.
export MOCK_FINDMNT_MAJMIN=253:0
bash "$INSTALL" "$(bundle sbx_ra)" --snapshot default >"$TMP/out" 2>&1 || fail 'install on dm'
# The second worker is not started at boot (SBX_WORKER_AT_BOOT=0, a host agent's): the read-ahead still is.
: >"$MOCK_LOG"
SBX_WORKER_AT_BOOT=0 bash "$INSTALL" "$(bundle sbx_ra2)" --snapshot default >"$TMP/out" 2>&1 || fail 'install a second worker on dm'
[[ "$(cat "$DM/queue/read_ahead_kb")" == 512 && "$(cat "$DISK/queue/read_ahead_kb")" == 128 ]] || fail 'dm-0 was not set alone'
grep -qx 'systemctl enable sbx-read-ahead.service' "$MOCK_LOG" || fail 'SBX_WORKER_AT_BOOT=0 left sbx-read-ahead not enabled for boot'
! grep -q 'systemctl enable sbx-worker@sbx_ra2' "$MOCK_LOG" || fail 'SBX_WORKER_AT_BOOT=0 enabled the worker'
bash "$INSTALL" --uninstall sbx_ra2 >"$TMP/out" 2>&1 || fail 'uninstall one of two'
[[ -f "$RAU" && "$(cat "$DM/queue/read_ahead_kb")" == 512 ]] || fail 'uninstalling one of two workers removed the read-ahead'
pass 'a dm device is set through its own queue; SBX_WORKER_AT_BOOT=0 keeps the read-ahead enabled for boot; one of two uninstalls keeps it'

# SBX_READ_AHEAD_KB=0 on a host that has the unit: the value goes back and the unit goes.
: >"$MOCK_LOG"
SBX_READ_AHEAD_KB=0 bash "$INSTALL" "$(bundle sbx_ra)" --snapshot default >"$TMP/out" 2>&1 || fail 're-run with 0'
[[ "$(cat "$DM/queue/read_ahead_kb")" == 256 && ! -e "$RAU" && ! -e "$RAO" ]] || fail '0 did not restore and remove the read-ahead'
! grep -q '^readahead ' "$EM" || fail "0 left readahead lines: $(cat "$EM")"
# ... and on a host without it, 0 installs nothing and never looks at the device.
: >"$MOCK_LOG"
SBX_READ_AHEAD_KB=0 bash "$INSTALL" "$(bundle sbx_ra2)" --snapshot default >"$TMP/out" 2>&1 || fail 'install with 0'
[[ ! -e "$RAU" && "$(cat "$DM/queue/read_ahead_kb")" == 256 ]] || fail '0 installed a unit or changed the device'
! grep -q 'findmnt\|sbx-read-ahead' "$MOCK_LOG" || fail '0 still looked at the device or the unit'
for id in sbx_ra sbx_ra2; do bash "$INSTALL" --uninstall "$id" >"$TMP/out" 2>&1 || fail "uninstall $id"; done
pass 'SBX_READ_AHEAD_KB=0 restores and removes an installed read-ahead, and on a clean host installs none'

# Not resolvable (nothing mounted, tmpfs's anonymous device, a device without a queue): a warning,
# never a failure, and no unit.
for mm in '' 0:42 7:9; do
  : >"$MOCK_LOG"
  MOCK_FINDMNT_MAJMIN="$mm" bash "$INSTALL" "$(bundle sbx_ra)" --snapshot default >"$TMP/out" 2>&1 || fail "failed the install on an unresolvable device ('$mm')"
  grep -q "WARNING: no block device found under $SBX_SRV: read-ahead not set" "$TMP/out" || fail "no warning for an unresolvable device ('$mm')"
  [[ ! -e "$RAU" && ! -e "$RAH" && ! -e "$RAO" ]] || fail "installed the read-ahead on an unresolvable device ('$mm')"
  ! grep -q sbx-read-ahead "$MOCK_LOG" || fail "touched sbx-read-ahead on an unresolvable device ('$mm')"
  grep -qx 'systemctl restart sbx-worker@sbx_ra.service' "$MOCK_LOG" || fail "the worker was not started ('$mm')"
done
MOCK_FINDMNT_MAJMIN='' "$SRC/deploy/sbx/sbx-read-ahead.sh" set "$SBX_SRV" 512 >"$TMP/out" 2>&1 || fail 'the boot run fails on an unresolvable device'
grep -q 'read-ahead not set' "$TMP/out" || fail 'the boot run does not warn on an unresolvable device'
bash "$INSTALL" --uninstall sbx_ra >"$TMP/out" 2>&1 || fail 'uninstall after the unresolvable cases'
pass 'an unresolvable device (no mount, tmpfs, no queue) is a warning: the worker installs, no unit, and the boot run exits 0'

# A value the device does not take: a warning, the old value kept, the install goes on. A read-only
# file stands in for the device's refusal, which root would write through: skipped as root.
if [[ "$(id -u)" != 0 ]]; then
  chmod 0444 "$DM/queue/read_ahead_kb"
  bash "$INSTALL" "$(bundle sbx_ra)" --snapshot default >"$TMP/out" 2>&1 || fail 'failed the install on a value the device refused'
  grep -q 'WARNING: sbx-read-ahead: dm-0 did not take read_ahead_kb 512; it is 256' "$TMP/out" || fail 'no warning for a refused value'
  [[ "$(cat "$DM/queue/read_ahead_kb")" == 256 ]] || fail 'a refused value changed the device'
  bash "$INSTALL" --uninstall sbx_ra >"$TMP/out" 2>&1 || fail 'uninstall after a refused value'
  chmod 0644 "$DM/queue/read_ahead_kb"
  pass 'a value the device does not take is a warning; the old value stays'
else
  echo 'skip - a value the device does not take (running as root)'
fi
[[ ! -s "$EM" ]] || fail "manifest not empty at the end of the read-ahead block: $(cat "$EM")"
