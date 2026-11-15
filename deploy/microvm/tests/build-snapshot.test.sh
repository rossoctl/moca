#!/usr/bin/env bash
# deploy/microvm/tests/build-snapshot.test.sh
#
# Cluster-free, KVM-free tests for build-snapshot.sh. The script itself needs /dev/kvm
# and cannot run on every PR -- but its CONTRACT can rot silently, and a rotted
# contract produces a snapshot the worker then refuses at start (or worse, accepts):
#
#   - the manifest must carry the five fields vmpool.LoadManifest requires, or every
#     worker on the fleet fails its startup verification at once.
#   - the snapshot must be built on the target instance type (spec §2.4: restore
#     requires identical hardware), so the script must RECORD the type rather than
#     leaving it blank.
#   - the artifact must be root-owned and read-only (spec §5.5): only a 64-bit CRC
#     guards the state file and the VMM trusts these files.
#   - the agent must be static (CGO_ENABLED=0): the rootfs is minimal and a dynamic
#     agent would need a libc the image may not carry.
#
# Run: bash deploy/microvm/tests/build-snapshot.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/build-snapshot.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  fails=$((fails + 1))
fi; }

echo "== the script exists and is shellcheck-clean"
check "build-snapshot.sh present" "$([ -f "$SCRIPT" ] && echo yes || echo no)" "yes"
if command -v shellcheck >/dev/null; then
  shellcheck "$SCRIPT" && check "shellcheck" "$?" "0"
fi

echo "== the golden rootfs is attached READ-ONLY, and the kernel is told to mount it ro"
# Defect 11: the launcher HARDLINKS this snapshot's rootfs into every VM's jail (one shared
# inode), so a writable root device means the guest mutates the golden snapshot itself.
# Measured on the rig: an Exec whose command was literally `true` changed the rootfs hash,
# because mounting ext4 rw rewrites the superblock's mount count and last-mount time. The
# snapshot then failed its own Manifest.Verify and microvm-worker refused to start.
#
# Both halves are asserted, because either alone is insufficient: is_read_only without `ro`
# makes the kernel attempt a rw mount of a read-only device (an early boot failure), and
# `ro` without is_read_only leaves the device writable to anything that remounts.
check "the rootfs drive is is_read_only:true" \
  "$(grep -c '\\"drive_id\\":\\"rootfs\\".*\\"is_read_only\\":true' "$SCRIPT")" "1"
check "the rootfs drive is NOT is_read_only:false anywhere" \
  "$(grep -c '\\"drive_id\\":\\"rootfs\\".*\\"is_read_only\\":false' "$SCRIPT")" "0"
check "boot_args tell the kernel to mount root ro" \
  "$([ "$(grep -c 'boot_args.*[^a-z]ro[^a-z]' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
# The workspace drive must stay WRITABLE -- it is the one place a run is supposed to write,
# and making it read-only too would be a plausible over-correction of the above.
check "the workspace drive stays writable" \
  "$(grep -c '\\"drive_id\\":\\"workspace\\".*\\"is_read_only\\":false' "$SCRIPT")" "1"

echo "== it refuses to run without the inputs it cannot invent"
for missing in --kernel --rootfs --agent --image; do
  out=$(bash "$SCRIPT" 2>&1)
  case "$out" in *"$missing"*) ok=yes ;; *) ok=no ;; esac
  check "usage names $missing" "$ok" "yes"
done

echo "== it records the instance type rather than leaving it blank"
# Matches the exact manifest field, not the bare substring "instance_type" --
# fix-round-2 item C added detect_host_instance_type/ec2_instance_type, which
# contain that substring too and would otherwise inflate a plain occurrence count.
check "instance-type reaches the manifest" \
  "$([ "$(grep -cF '"instance_type": "$INSTANCE_TYPE"' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

echo "== fix-round-2 item C: --instance-type is an auto-detected override, not a required input"
check "--instance-type is optional in usage (bracketed)" \
  "$([ "$(grep -c '\[--instance-type TYPE\]' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "detect_host_instance_type helper exists" \
  "$([ "$(grep -c 'detect_host_instance_type()' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "required-args check no longer ORs in INSTANCE_TYPE" \
  "$(grep -cF -- 'IMAGE" ] || [ -z "$INSTANCE_TYPE" ]' "$SCRIPT")" "0"
out=$(bash "$SCRIPT" --kernel /nonexistent --rootfs /nonexistent --agent /nonexistent --image test 2>&1)
case "$out" in
  *"restore requires identical hardware and software"*) ok=no ;;
  *) ok=yes ;;
esac
check "running with only kernel/rootfs/agent/image (no --instance-type) does not hit usage" "$ok" "yes"
# main() calls require_root before preflight, so non-root CI stops there instead
# of reaching the /dev/kvm check -- either message proves arg validation was
# passed (usage() exits 2 with the text above; both of these exit 1).
case "$out" in
  *"must run as root"* | *"/dev/kvm is not present"*) ok=yes ;;
  *) ok=no ;;
esac
check "it proceeds past arg validation (into require_root/preflight) instead" "$ok" "yes"

echo "== the artifact is made read-only and root-owned"
check "chmod 0444 on the snapshot files" \
  "$([ "$(grep -c 'chmod .*444' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "chown root on the snapshot dir" \
  "$([ "$(grep -c 'chown .*root' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

echo "== the guest agent is built static"
check "CGO_ENABLED=0" "$([ "$(grep -c 'CGO_ENABLED=0' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

echo "== nothing secret can enter the snapshot (spec §5.2's invariant)"
check "no SANDBOX_TOKEN in the build" \
  "$(grep -c 'SANDBOX_TOKEN' "$SCRIPT")" "0"
check "swap/cgroup preflight is present" \
  "$([ "$(grep -c 'cgroup' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

echo "== fix-round: rootfs/vmstate/memfile paths are jail-relative, not the ephemeral \$STAGE (items 1, 9)"
check "no path_on_host under \$STAGE (item 1)" \
  "$(grep -cF 'path_on_host\":\"$STAGE' "$SCRIPT")" "0"
check "firecracker rootfs drive path is jail-relative /rootfs" \
  "$([ "$(grep -cF 'path_on_host\":\"/rootfs\"' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "cloud-hypervisor --disk path is jail-relative /rootfs (item 9)" \
  "$([ "$(grep -cF -- '--disk "path=/rootfs' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "no snapshot_path/mem_file_path under \$OUT at restore time (item 9 corollary)" \
  "$(grep -cE 'snapshot_path\\":\\"\$OUT|mem_file_path\\":\\"\$OUT' "$SCRIPT")" "0"

echo "== fix-round: a workspace drive is provisioned for restored VMs (item 2)"
check "a workspace drive is configured" \
  "$([ "$(grep -c 'drive_id.*workspace\|/drives/workspace' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "ensure_workspace_image helper exists" \
  "$([ "$(grep -c 'ensure_workspace_image()' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

echo "== fix-round: every backgrounded VMM has stdin redirected (items 3, 10)"
check "count of backgrounded VMM launches equals count of </dev/null redirects" \
  "$(grep -c '&$' "$SCRIPT")" "$(grep -c '</dev/null' "$SCRIPT")"
check "at least four </dev/null redirects (build x2, verify x2)" \
  "$([ "$(grep -c '</dev/null' "$SCRIPT")" -ge 4 ] && echo yes || echo no)" "yes"

echo "== fix-round: every VMM API call is checked for failure (item 4)"
check "require_root helper exists" \
  "$([ "$(grep -c 'require_root()' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "require_root is called from main" \
  "$([ "$(grep -c '^  require_root$' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "api_put helper (curl -s -S, status checked) exists" \
  "$([ "$(grep -c 'api_put()' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "no bare unchecked curl PUT calls remain" \
  "$(grep -c "curl -s --unix-socket" "$SCRIPT")" "0"

echo "== fix-round: cloud-hypervisor boots with a cmdline and a read-only rootfs (items 7, 8)"
check "--cmdline is passed to cloud-hypervisor" \
  "$([ "$(grep -c -- '--cmdline "console=ttyS0 root=/dev/vda rw reboot=k panic=1"' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "cloud-hypervisor rootfs disk is readonly=on" \
  "$([ "$(grep -c -- 'readonly=on' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

# Fix-round-2 item B: the old form of this check, `grep -c -- '--cmdline.*pci=off'
# "$SCRIPT"` == "0", was non-discriminating -- pre-fix there was no --cmdline flag
# at ALL, so the grep matched zero times before the fix too, and the check could
# never fail regardless of whether pci=off was actually kept out of the cmdline.
# Rewritten as one coupled assertion about the ACTUAL flag value: the cmdline must
# be present, must contain root=/dev/vda, and must NOT contain pci=off, all three
# together -- this genuinely fails against the pre-fix text (no --cmdline at all).
ch_cmdline="$(grep -oE -- '--cmdline "[^"]*"' "$SCRIPT" | head -n1)"
ok=no
if [ -n "$ch_cmdline" ]; then
  case "$ch_cmdline" in
    *'root=/dev/vda'*)
      case "$ch_cmdline" in
        *'pci=off'*) ok=no ;;
        *) ok=yes ;;
      esac
      ;;
  esac
fi
check "cloud-hypervisor cmdline is present, has root=/dev/vda, and omits pci=off" "$ok" "yes"

echo "== fix-round: cloud-hypervisor restore uses the vm.restore API, not a --restore flag (11th finding)"
check "no --restore CLI flag" \
  "$(grep -cF -- '--restore "' "$SCRIPT")" "0"
check "vm.restore API call is present" \
  "$([ "$(grep -c 'vm.restore' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "config.json is preserved for cloud-hypervisor restores (item 9 corollary)" \
  "$([ "$(grep -c 'ch-config.json' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

echo "== fix-round-2 item A: CLEANUP_JAIL is armed before jail_mount_dev runs"
# A failure between the mount and the arm upgrade (a failing mkfs.ext4, a
# cross-device ln, anything) used to leave only the original `rm -rf "$STAGE"`
# trap active, leaking the /dev/kvm and /dev/urandom bind mounts onto the host.
# Fix-round-7 item 2 replaced the four per-function dynamic `trap '...' EXIT`
# strings with one script-scope CLEANUP_JAIL variable read by a single
# cleanup_on_exit (see that function's own comment for why: an EXIT trap fires
# at PROCESS exit, not function return, and bash pops function locals before a
# mid-function failure's already-armed trap runs, so a trap that named a local
# by reference was never actually safe). The property this test guards --
# "the thing that lets cleanup unmount /dev is set up before the mount, not
# after" -- still has to hold; only the mechanism changed, so the assertion is
# rewritten around CLEANUP_JAIL="$jail" instead of a `trap` line.
#
# Fix-round-9: this arming sequence (CLEANUP_JAIL="$jail" then jail_mount_dev)
# no longer lives in each of the four functions -- it was retyped four times,
# which is exactly the shape of drift that produced fix-rounds 8 and 9's rig
# failures, so it was extracted into the single shared prepare_jail helper (see
# that function's own definition, next to jail_mount_dev). The property now
# needs to hold just once, of prepare_jail's own body, rather than once per
# VMM function; each function's OWN obligation is reduced to "call prepare_jail
# at all", asserted separately below (fix-round-9 section).
start=$(grep -n "^prepare_jail() {" "$SCRIPT" | head -n1 | cut -d: -f1)
ok=no
if [ -n "$start" ]; then
  end=$(awk -v s="$start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$end" ]; then
    arm_line=$(awk -v s="$start" -v e="$end" \
      'NR>=s && NR<=e && /CLEANUP_JAIL="\$jail"/{print NR; exit}' "$SCRIPT")
    mount_line=$(awk -v s="$start" -v e="$end" \
      'NR>=s && NR<=e && /jail_mount_dev "\$jail"/{print NR; exit}' "$SCRIPT")
    if [ -n "$arm_line" ] && [ -n "$mount_line" ] && [ "$arm_line" -lt "$mount_line" ]; then
      ok=yes
    fi
  fi
fi
check "prepare_jail sets CLEANUP_JAIL before jail_mount_dev (source order)" "$ok" "yes"

echo "== fix-round-3: guest_client.go is generated inside \$AGENT_SRC's module, not \$STAGE"
# Go's internal-package rule keys off the IMPORTING FILE's own directory, not the
# working directory: `cd "$AGENT_SRC" && go build .../$STAGE/guest_client.go` was
# illegal regardless of the cd, because $STAGE sits outside the module tree and
# guest_client.go imports remote-worker/internal/guestagent. A source-level
# assertion is legitimate and sufficient here (no live `go build` needed): the
# generated file's path must be under $AGENT_SRC, and never under $STAGE.
check "guest_client.go is written to a tmp_pkg variable, not directly under \$STAGE" \
  "$([ "$(grep -cF 'cat >"$tmp_pkg/guest_client.go"' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "tmp_pkg is rooted under \$AGENT_SRC (module root), not under \$STAGE" \
  "$([ "$(grep -cE 'tmp_pkg="\$AGENT_SRC/' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "guest_client.go is no longer written under \$STAGE" \
  "$(grep -cF 'cat >"$STAGE/guest_client.go"' "$SCRIPT")" "0"
check "go build no longer reads guest_client.go out of \$STAGE" \
  "$(grep -cF '"$STAGE/guest_client.go"' "$SCRIPT")" "0"

# The temp package directory must be dot-prefixed, or `go build ./...`, `go vet
# ./...` and `gofmt -l .` (which this repo's own checks run against remote-worker)
# would pick up a lingering one and fail in a way that looks unrelated to this
# script.
check "the temp package dir under \$AGENT_SRC is dot-prefixed" \
  "$([ "$(grep -cE 'AGENT_SRC/\.[A-Za-z]' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

# Same discipline as fix-round-2 item A for the /dev bind mounts: cleanup must
# be armed BEFORE the directory is created, not after, so a failure between
# mkdir and go build (or inside the heredoc) still removes it. Fix-round-7 item
# 2 replaced this function's own one-off `trap '...' EXIT` (which embedded its
# local $tmp_pkg literally at arm time -- safe on its own, but one more trap
# idiom alongside the genuinely unsafe pid-referencing ones elsewhere in the
# file) with the same script-scope CLEANUP_EXTRA_DIR read by cleanup_on_exit.
# Source-order check within write_guest_client's own body, the same technique
# used for item A, rewritten around CLEANUP_EXTRA_DIR="$tmp_pkg" instead of a
# `trap` line.
start=$(grep -n "^write_guest_client() {" "$SCRIPT" | head -n1 | cut -d: -f1)
ok=no
if [ -n "$start" ]; then
  end=$(awk -v s="$start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$end" ]; then
    arm_line=$(awk -v s="$start" -v e="$end" \
      'NR>=s && NR<=e && /CLEANUP_EXTRA_DIR="\$tmp_pkg"/{print NR; exit}' "$SCRIPT")
    mkdir_line=$(awk -v s="$start" -v e="$end" \
      'NR>=s && NR<=e && /mkdir -p "\$tmp_pkg"/{print NR; exit}' "$SCRIPT")
    if [ -n "$arm_line" ] && [ -n "$mkdir_line" ] && [ "$arm_line" -lt "$mkdir_line" ]; then
      ok=yes
    fi
  fi
fi
check "write_guest_client sets CLEANUP_EXTRA_DIR before mkdir (source order)" "$ok" "yes"

echo "== fix-round-4 item 1: init exports a PATH before execing the agent"
# The kernel hands init an essentially empty environment (no PATH at all). init
# itself never needed one (every command it runs is absolute), but the agent it
# execs resolves the commands IT runs (bash, python3, curl, ...) by name via
# exec.LookPath, and an unset PATH makes every one of those fail even though the
# binary is present in the image -- this is exactly the bug that panicked the
# guest ("exec: \"bash\": executable file not found in \$PATH"). Scope every
# check to the init heredoc itself (between the `cat >.../sbin/init <<'INIT'`
# line and the closing bare `INIT` line), not the outer build script, so this
# can't accidentally pass by matching unrelated text elsewhere.
init_start=$(grep -nF 'cat >"$STAGE/rootfs-tree/sbin/init" <<'"'"'INIT'"'"'' "$SCRIPT" | head -n1 | cut -d: -f1)
init_end=""
if [ -n "$init_start" ]; then
  init_end=$(awk -v s="$init_start" 'NR>s && /^INIT$/{print NR; exit}' "$SCRIPT")
fi
ok=no
path_line=""
exec_line=""
if [ -n "$init_start" ] && [ -n "$init_end" ]; then
  path_line=$(awk -v s="$init_start" -v e="$init_end" \
    'NR>=s && NR<=e && /^export PATH=/{print NR; exit}' "$SCRIPT")
  exec_line=$(awk -v s="$init_start" -v e="$init_end" \
    'NR>=s && NR<=e && /^exec \/usr\/local\/bin\/agent/{print NR; exit}' "$SCRIPT")
  [ -n "$path_line" ] && ok=yes
fi
check "init exports a PATH" "$ok" "yes"

ok=no
if [ -n "$path_line" ]; then
  path_text=$(sed -n "${path_line}p" "$SCRIPT")
  case "$path_text" in
    *:/usr/bin:* | *:/usr/bin)
      case "$path_text" in
        *:/bin:* | *:/bin) ok=yes ;;
      esac
      ;;
  esac
fi
check "init's PATH covers both /usr/bin and /bin (merged-\$usr and split trees)" "$ok" "yes"

ok=no
if [ -n "$path_line" ] && [ -n "$exec_line" ] && [ "$path_line" -lt "$exec_line" ]; then
  ok=yes
fi
check "init's PATH export precedes the agent exec (source order)" "$ok" "yes"

ok=no
if [ -n "$init_start" ] && [ -n "$init_end" ]; then
  exec_check_line=$(awk -v s="$init_start" -v e="$init_end" \
    'NR>=s && NR<=e && /-x \/usr\/local\/bin\/agent/{print NR; exit}' "$SCRIPT")
  if [ -n "$exec_check_line" ] && [ -n "$exec_line" ] && [ "$exec_check_line" -lt "$exec_line" ]; then
    ok=yes
  fi
fi
check "init fails loudly if the agent binary is missing/non-executable, before exec" "$ok" "yes"

echo "== fix-round-4 item 2 (extracted in fix-round-11): a failed wait_for_agent preserves the guest console log"
# wait_for_agent's timeout path used to just print a generic timeout message and
# exit 1 -- and the EXIT trap then deletes \$STAGE, which is where the console
# log (the only artifact that explains a guest boot failure) lives. The failure
# most likely to occur on a new host was erasing its own diagnosis. A
# source-level assertion that the timeout path references and preserves
# \$console_log is legitimate and sufficient here (no live VMM needed).
#
# Fix-round-11: this save/tail logic moved out of wait_for_agent's own body
# and into a new shared helper, save_and_print_console_log, so that
# wait_for_socket's timeout path (below) could reuse it rather than
# reimplementing it a second time. These checks now look inside the helper's
# body, not wait_for_agent's.
sapcl_start=$(grep -n "^save_and_print_console_log() {" "$SCRIPT" | head -n1 | cut -d: -f1)
check "save_and_print_console_log helper exists" \
  "$([ -n "$sapcl_start" ] && echo yes || echo no)" "yes"

ok=no
if [ -n "$sapcl_start" ]; then
  sapcl_end=$(awk -v s="$sapcl_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$sapcl_end" ]; then
    save_line=$(awk -v s="$sapcl_start" -v e="$sapcl_end" \
      'NR>=s && NR<=e && /cp "\$console_log"/{print NR; exit}' "$SCRIPT")
    excerpt_line=$(awk -v s="$sapcl_start" -v e="$sapcl_end" \
      'NR>=s && NR<=e && /tail -n [0-9]+ "\$console_log"/{print NR; exit}' "$SCRIPT")
    if [ -n "$save_line" ] && [ -n "$excerpt_line" ]; then
      ok=yes
    fi
  fi
fi
check "save_and_print_console_log saves the console log and prints an excerpt" "$ok" "yes"

ok=no
if [ -n "$sapcl_start" ]; then
  sapcl_end=$(awk -v s="$sapcl_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$sapcl_end" ]; then
    saved_var_line=$(awk -v s="$sapcl_start" -v e="$sapcl_end" \
      'NR>=s && NR<=e && /saved_console=/{print NR; exit}' "$SCRIPT")
    if [ -n "$saved_var_line" ]; then
      saved_var_text=$(sed -n "${saved_var_line}p" "$SCRIPT")
      case "$saved_var_text" in
        *'$STAGE'*) ok=no ;;
        *) ok=yes ;;
      esac
    fi
  fi
fi
check "the saved console-log path is outside \$STAGE (survives the EXIT trap)" "$ok" "yes"

# wait_for_agent itself must not have regressed to inlining this logic again
# (that would silently reintroduce fix-round-11's exact "second copy" problem)
# -- it must instead call the shared helper, strictly before its own timeout
# message and exit.
wfa_start=$(grep -n "^wait_for_agent() {" "$SCRIPT" | head -n1 | cut -d: -f1)
ok=no
if [ -n "$wfa_start" ]; then
  wfa_end=$(awk -v s="$wfa_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$wfa_end" ]; then
    call_line=$(awk -v s="$wfa_start" -v e="$wfa_end" \
      'NR>=s && NR<=e && /save_and_print_console_log "\$console_log"/{print NR; exit}' "$SCRIPT")
    timeout_line=$(awk -v s="$wfa_start" -v e="$wfa_end" \
      'NR>=s && NR<=e && /never became reachable/{print NR; exit}' "$SCRIPT")
    exit_line=$(awk -v s="$wfa_start" -v e="$wfa_end" \
      'NR>=s && NR<=e && /^  exit 1$/{print NR; exit}' "$SCRIPT")
    if [ -n "$call_line" ] && [ -n "$timeout_line" ] && [ -n "$exit_line" ] \
      && [ "$call_line" -lt "$timeout_line" ] && [ "$timeout_line" -lt "$exit_line" ]; then
      ok=yes
    fi
  fi
fi
check "wait_for_agent's timeout path calls save_and_print_console_log before exiting" "$ok" "yes"
own_body_check=$(awk -v s="$wfa_start" 'NR>s && /^}$/{exit} NR>s' "$SCRIPT" | grep -c 'saved_console=')
check "wait_for_agent no longer inlines its own copy of the save/tail logic" "$own_body_check" "0"

echo "== fix-round-5 item 1: /vm is paused with PATCH, not PUT (Firecracker has no PUT /vm)"
# Confirmed against the real firecracker v1.17.0 binary: PUT /vm returns HTTP 400
# "Invalid request method and/or path: PUT vm.", while PATCH /vm (even before
# the VM is started, so it still fails, but for an unrelated reason) returns "The
# requested operation is not supported before starting the microVM." -- a state
# complaint, not a method/path complaint, proving PATCH is the method the route
# actually accepts. Firecracker's own swagger spec confirms /vm defines no PUT
# method at all; every other api_put call site in the script (/boot-source,
# /drives/{id} pre-boot, /vsock, /machine-config pre-boot, /actions,
# /snapshot/create, /snapshot/load, and cloud-hypervisor's uniformly-PUT
# /api/v1/vm.restore) was individually checked against the spec/docs and is
# already correct, so only the /vm pause call needed to change.
check "api_patch helper exists" \
  "$([ "$(grep -c '^api_patch()' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "the pause call uses api_patch, not api_put" \
  "$([ "$(grep -cE 'api_patch "\$api_sock" /vm ' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "no PUT call against /vm remains anywhere in the script" \
  "$(grep -cE 'api_put "\$api_sock" /vm ' "$SCRIPT")" "0"

echo "== fix-round-5 item 1 (cont'd): api_put and api_patch share one copy of the status-checking logic"
# Generalising api_put to take a method is fine; two independent copies of the
# non-2xx-is-fatal check would let them drift, so both wrappers must funnel
# through a single api_request.
check "api_request is the single shared implementation" \
  "$([ "$(grep -c '^api_request()' "$SCRIPT")" -eq 1 ] && echo yes || echo no)" "yes"
check "the non-2xx-is-fatal status check exists exactly once (not duplicated per verb)" \
  "$([ "$(grep -cF 'returned HTTP $status' "$SCRIPT")" -eq 1 ] && echo yes || echo no)" "yes"
check "api_put is a thin wrapper around api_request" \
  "$([ "$(grep -cF 'api_request PUT "$1" "$2" "$3"' "$SCRIPT")" -eq 1 ] && echo yes || echo no)" "yes"
check "api_patch is a thin wrapper around api_request" \
  "$([ "$(grep -cF 'api_request PATCH "$1" "$2" "$3"' "$SCRIPT")" -eq 1 ] && echo yes || echo no)" "yes"

echo "== fix-round-5 item 2: the EXIT-trap cleanup kills, waits, unmounts, then removes -- in that order"
# A killed process does not release its held file descriptors (including the
# /dev/kvm bind mount) synchronously -- `kill` only requests exit, it does not
# wait for it -- so `wait` must run before jail_unmount_dev can succeed, which
# must in turn run before the jail directory is removed. Fix-round-5 item 2
# made this true of each function's own one-off abnormal-exit trap string;
# fix-round-7 item 2 collapsed all four of those (each unsafe -- see
# cleanup_on_exit's own comment) into ONE cleanup_on_exit function, so the
# property now needs to hold just once, of that one function's body, rather
# than once per VMM function. The round-2/round-3 source-order idiom (comparing
# line numbers within a function's own span) still applies; cleanup_on_exit's
# actions are one per line now rather than packed into a single trap string, so
# this compares LINE order instead of the old same-line COLUMN order.
check "rm_rf_jail helper exists (guarded rm -rf that refuses over a live mount)" \
  "$([ "$(grep -c '^rm_rf_jail()' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "cleanup_on_exit is defined exactly once" \
  "$([ "$(grep -c '^cleanup_on_exit()' "$SCRIPT")" -eq 1 ] && echo yes || echo no)" "yes"
coe_start=$(grep -n "^cleanup_on_exit() {" "$SCRIPT" | head -n1 | cut -d: -f1)
ok=no
if [ -n "$coe_start" ]; then
  coe_end=$(awk -v s="$coe_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$coe_end" ]; then
    kill_line=$(awk -v s="$coe_start" -v e="$coe_end" \
      'NR>=s && NR<=e && /^  kill /{print NR; exit}' "$SCRIPT")
    wait_line=$(awk -v s="$coe_start" -v e="$coe_end" \
      'NR>=s && NR<=e && /^  wait /{print NR; exit}' "$SCRIPT")
    unmount_line=$(awk -v s="$coe_start" -v e="$coe_end" \
      'NR>=s && NR<=e && /jail_unmount_dev/{print NR; exit}' "$SCRIPT")
    rm_line=$(awk -v s="$coe_start" -v e="$coe_end" \
      'NR>=s && NR<=e && /^  rm_rf_jail/{print NR; exit}' "$SCRIPT")
    if [ -n "$kill_line" ] && [ -n "$wait_line" ] && [ -n "$unmount_line" ] && [ -n "$rm_line" ] \
      && [ "$kill_line" -lt "$wait_line" ] && [ "$wait_line" -lt "$unmount_line" ] \
      && [ "$unmount_line" -lt "$rm_line" ]; then
      ok=yes
    fi
  fi
fi
check "cleanup_on_exit kills, waits, unmounts, then removes (in that order)" "$ok" "yes"

echo "== fix-round-5 item 2 (cont'd) / fix-round-7 item 1: rm -rf on \$STAGE (and any extra dir) is routed through the mount-aware guard"
# rm -rf and rm_rf_jail together, over a live mountpoint, are a hazardous pair
# (see the rm_rf_jail comment): today the only bind mounts are device nodes, so
# a failed unmount just makes rm -rf fail loudly, but the shape is one small
# change away (a future directory bind mount) from rm -rf silently recursing
# through the mount and deleting whatever is on the other side of it. Every
# \$STAGE removal in the script should go through the guard. cleanup_on_exit
# builds an array (\$STAGE, plus CLEANUP_EXTRA_DIR -- the verify_root sibling
# of \$OUT introduced by fix-round-7 item 1 -- when one is live) and passes it
# to rm_rf_jail in one call, so the old literal 'rm_rf_jail "\$STAGE"' text no
# longer appears; assert the array-based form instead.
check "no bare 'rm -rf \"\$STAGE\"' remains anywhere in the script" \
  "$(grep -cF 'rm -rf "$STAGE"' "$SCRIPT")" "0"
check "cleanup_on_exit builds its rm targets from \$STAGE" \
  "$([ "$(grep -cF 'rm_targets=("$STAGE")' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "cleanup_on_exit's removal is routed through rm_rf_jail with that array" \
  "$([ "$(grep -cF 'rm_rf_jail "${rm_targets[@]}"' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

echo "== fix-round-6 item 1: /snapshot/create sends no resume_vm field"
# resume_vm belongs to /snapshot/load's SnapshotLoadParams, not /snapshot/create's
# SnapshotCreateParams -- confirmed against v1.17.0's firecracker.yaml, which lists
# only snapshot_path, mem_file_path, snapshot_type and sync_snapshot_files as valid
# fields on create, and against the real binary's own rejection of this exact
# request on the rig ("unknown field `resume_vm`, expected one of `snapshot_type`,
# `snapshot_path`, `mem_file_path`, `sync_snapshot_files`"). Pull out just the JSON
# body line following the /snapshot/create call so this assertion cannot be
# satisfied by resume_vm merely being absent from some unrelated line/comment.
snapshot_create_body=$(awk '/\/snapshot\/create \\$/{getline; print; exit}' "$SCRIPT")
check "a /snapshot/create call body was found" \
  "$([ -n "$snapshot_create_body" ] && echo yes || echo no)" "yes"
check "the /snapshot/create body contains no resume_vm field" \
  "$(printf '%s' "$snapshot_create_body" | grep -c 'resume_vm')" "0"
check "the /snapshot/create body still sets snapshot_type Full" \
  "$(printf '%s' "$snapshot_create_body" | grep -cF '\"snapshot_type\":\"Full\"')" "1"

echo "== fix-round-6 item 2: /snapshot/load's vsock_override is an object, not a bare string"
# vsock_override is the VsockOverride schema (a JSON object with one required
# property, uds_path), not a plain string -- confirmed against v1.17.0's
# firecracker.yaml and against Firecracker's own docs/vsock.md "Unix Domain Socket
# Renaming" section, whose worked example is
# `"vsock_override": {"uds_path": "./v.sock.2"}`. This call had never executed
# against the real binary before fix-round-6, so unlike item 1 this was caught by
# audit rather than by a rig failure. Pull out just the JSON body line following
# the /snapshot/load call for the same false-positive-avoidance reason as item 1.
snapshot_load_body=$(awk '/\/snapshot\/load \\$/{getline; print; exit}' "$SCRIPT")
check "a /snapshot/load call body was found" \
  "$([ -n "$snapshot_load_body" ] && echo yes || echo no)" "yes"
check "the /snapshot/load body's vsock_override is an object keyed by uds_path" \
  "$(printf '%s' "$snapshot_load_body" | grep -cF '\"vsock_override\":{\"uds_path\":')" "1"
check "the /snapshot/load body's vsock_override is not a bare string" \
  "$(printf '%s' "$snapshot_load_body" | grep -cF '\"vsock_override\":\"')" "0"
check "the /snapshot/load body still sets resume_vm true (valid here, unlike on create)" \
  "$(printf '%s' "$snapshot_load_body" | grep -cF '\"resume_vm\":true')" "1"

echo "== fix-round-7 item 2: an EXIT trap can never reference a function-local (structural fix)"
# Real rig failure: "line 1: fc_pid: unbound variable" -- an EXIT trap fires at
# WHOLE-PROCESS exit, not function return, and bash pops a function's locals
# off as soon as `set -e` unwinds out of its call frame, which for a
# mid-function failure happens BEFORE the trap body (already pointing at that
# now-gone local, by name) gets to run. This bit all four functions that armed
# their own `trap '...' EXIT` referencing a local pid/jail variable (both
# boot_quiesce_snapshot_* arms, both verify_restore_* arms) -- the fix is
# structural: a single trap, once, calling a function that only ever touches
# script-scope globals (never a popped local). These assertions try to catch
# the whole class, not just the one site that failed on the rig: no function
# anywhere in the file may still declare a `local` pid variable of this shape,
# and the three globals cleanup_on_exit depends on must never be shadowed
# `local` by anything (a shadow would silently revive the exact bug: a
# function-local of the same name, invisible to the trap's own copy of the
# global once that function returns -- no, worse, invisible to the *rest of
# the script* the moment such a shadow's frame is popped, same failure mode).
# Excludes comment-only lines throughout this block: the explanatory comments
# above (and the ones cleanup_on_exit itself carries) deliberately quote both
# the old buggy shape and the new fixed shape as prose, e.g. "the single
# `trap cleanup_on_exit EXIT` armed once at the top", which would otherwise
# double-count the real, live statement below.
check "exactly one 'trap ... EXIT' statement exists in the whole script" \
  "$(grep -cE '^[[:space:]]*trap ' "$SCRIPT")" "1"
check "the one remaining trap is 'trap cleanup_on_exit EXIT'" \
  "$([ "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -cF 'trap cleanup_on_exit EXIT')" -eq 1 ] && echo yes || echo no)" "yes"
check "cleanup_on_exit function is defined" \
  "$([ "$(grep -c '^cleanup_on_exit()' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "no LIVE 'local fc_pid' declaration remains anywhere in the script" \
  "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -cE '\blocal fc_pid\b')" "0"
check "no LIVE 'local ch_pid' declaration remains anywhere in the script" \
  "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -cE '\blocal ch_pid\b')" "0"
# Excludes comment-only lines: the explanatory comments above deliberately
# quote the old buggy code shape (e.g. "`trap 'kill "$fc_pid" ...' EXIT`") to
# document what this fixes, so a plain substring grep over the whole file
# would false-positive on the documentation, not the code.
check "no LIVE CODE line references \"\$fc_pid\" (only explanatory comments may)" \
  "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -cF '$fc_pid')" "0"
check "no LIVE CODE line references \"\$ch_pid\" (only explanatory comments may)" \
  "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -cF '$ch_pid')" "0"
for g in CLEANUP_PID CLEANUP_JAIL CLEANUP_EXTRA_DIR; do
  check "$g is never declared 'local' anywhere (stays script-scope)" \
    "$(grep -cE "local ${g}\b" "$SCRIPT")" "0"
done
check "CLEANUP_PID is assigned by every VMM-launching function" \
  "$([ "$(grep -cF 'CLEANUP_PID=$!' "$SCRIPT")" -eq 4 ] && echo yes || echo no)" "yes"

echo "== fix-round-7 item 1: verify_restore hard-links \$OUT's files via a same-device sibling, not \$STAGE"
# Real rig failure: 'ln: failed to create hard link ... Invalid cross-device
# link' -- \$STAGE lives on tmpfs (a genuine, deliberate speed win for
# assembling the rootfs tree and mkfs'ing the ext4 image, per the coordinator's
# explicit "do not move \$STAGE wholesale" instruction), but \$OUT is normally
# on persistent disk, and ln(1) across two filesystems is always EXDEV, not a
# permissions problem. new_verify_dir/link_snapshot_file move ONLY the
# verify-time jail onto a sibling directory of \$OUT (sharing \$OUT's device),
# leaving \$STAGE itself untouched and still tmpfs for everything else.
check "new_verify_dir helper exists" \
  "$([ "$(grep -c '^new_verify_dir()' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "new_verify_dir allocates its directory under dirname \"\$OUT\" (a sibling of \$OUT)" \
  "$([ "$(grep -cF 'mktemp -d "$base/.build-snapshot-verify.XXXXXX"' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "link_snapshot_file helper exists" \
  "$([ "$(grep -c '^link_snapshot_file()' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "link_snapshot_file attempts a hard link first" \
  "$([ "$(grep -cF 'if ln "$src" "$dst" 2>/dev/null; then' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "link_snapshot_file's fallback is a LOUD warning, not a silent copy" \
  "$([ "$(grep -c 'WARNING: could not hard-link' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "link_snapshot_file's warning names memfile/guest-RAM as the risk, not just \"a file\"" \
  "$([ "$(grep -cF 'ENTIRE guest RAM image' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "link_snapshot_file's fallback copy is cp -p (preserves mode/mtime), after the warning" \
  "$([ "$(grep -cF 'cp -p "$src" "$dst"' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "no bare 'ln \"\$PENDING/...' call site remains anywhere in the script" \
  "$(grep -cE 'ln "\$(PENDING|OUT)/' "$SCRIPT")" "0"
# $PENDING, not $OUT: fix-round-14 moved verification ahead of publication, so the
# files being linked into the verify jail are the sealed-but-unpublished ones. Same
# seven call sites, same device (both are siblings) -- see the fix-round-14 section.
check "both verify functions route the sealed snapshot's vmstate/memfile/rootfs/ch-config.json through link_snapshot_file" \
  "$([ "$(grep -cF 'link_snapshot_file "$PENDING/' "$SCRIPT")" -eq 7 ] && echo yes || echo no)" "yes"
check "both verify jails are rooted under new_verify_dir, not \$STAGE" \
  "$([ "$(grep -cF 'jail="$verify_root/verify-jail"' "$SCRIPT")" -eq 2 ] && echo yes || echo no)" "yes"
check "no verify jail is still rooted at \$STAGE/verify-jail" \
  "$(grep -cF 'jail="$STAGE/verify-jail"' "$SCRIPT")" "0"
check "both verify functions register their verify_root with CLEANUP_EXTRA_DIR" \
  "$([ "$(grep -cF 'CLEANUP_EXTRA_DIR="$verify_root"' "$SCRIPT")" -eq 2 ] && echo yes || echo no)" "yes"
check "both verify functions remove verify_root on their own normal-path teardown too" \
  "$([ "$(grep -cF 'rm_rf_jail "$verify_root"' "$SCRIPT")" -eq 2 ] && echo yes || echo no)" "yes"

echo "== fix-round-8: verify_restore_firecracker makes no boot-resource configuration calls before /snapshot/load"
# Real rig failure: PUT /snapshot/load returned HTTP 400 "Loading a microVM
# snapshot not allowed after configuring boot-specific resources." A restoring
# instance gets exactly ONE configuration call -- /snapshot/load itself, with
# vsock_override standing in for the one restore-time path override
# Firecracker offers. Any PUT /boot-source, /drives/..., /machine-config or
# /vsock issued between starting the VMM and calling /snapshot/load
# reproduces that rejection, no matter that the values being configured
# already match what the snapshot carries.
#
# Comment-collision trap (bit fix-round-7's tests): this file's own comments,
# and build-snapshot.sh's, deliberately quote "/vsock", "vsock_override" and
# "/vsock.sock" while explaining why a bare device PUT is forbidden -- a grep
# across the whole function body would match those explanations, not just
# live code. Strip comment lines first, every time.
restore_fc_body="$(awk '/^verify_restore_firecracker\(\)/{flag=1} flag{print} flag && /^}/{exit}' "$SCRIPT" | grep -v '^[[:space:]]*#')"
check "verify_restore_firecracker starts exactly one VMM (one CLEANUP_PID=\$!)" \
  "$([ "$(printf '%s\n' "$restore_fc_body" | grep -cF 'CLEANUP_PID=$!')" -eq 1 ] && echo yes || echo no)" "yes"
check "verify_restore_firecracker calls /snapshot/load exactly once" \
  "$([ "$(printf '%s\n' "$restore_fc_body" | grep -cF '/snapshot/load')" -eq 1 ] && echo yes || echo no)" "yes"
# The segment strictly between starting the VMM and the /snapshot/load call
# (the sed '$d' drops the /snapshot/load line itself, which is the range's
# terminator, not something "between" the two events).
restore_segment="$(printf '%s\n' "$restore_fc_body" | sed -n '/CLEANUP_PID=\$!/,/\/snapshot\/load/p' | sed '$d')"
check "no PUT /boot-source between starting the VMM and /snapshot/load" \
  "$(printf '%s\n' "$restore_segment" | grep -cF '/boot-source')" "0"
check "no PUT /drives/... between starting the VMM and /snapshot/load" \
  "$(printf '%s\n' "$restore_segment" | grep -cF '/drives/')" "0"
check "no PUT /machine-config between starting the VMM and /snapshot/load" \
  "$(printf '%s\n' "$restore_segment" | grep -cF '/machine-config')" "0"
# Word-boundary, not a bare substring match: the /snapshot/load body itself
# legitimately carries "/vsock.sock" (inside vsock_override's uds_path) and
# that must NOT trip this check -- only a standalone /vsock path argument
# (Firecracker's device-configuration endpoint) should.
check "no PUT /vsock (device config) between starting the VMM and /snapshot/load" \
  "$(printf '%s\n' "$restore_segment" | grep -cE '/vsock([[:space:]]|"|$)')" "0"

echo "== fix-round-9: build-vs-verify jail setup/teardown is shared, not retyped (BUG: CH build never created \$jail/ch-snapshot)"
# Real rig failure: Cloud Hypervisor's own ch-remote refused to snapshot with
# "Destination is not a directory: \"/ch-snapshot\"" -- boot_quiesce_snapshot_
# cloud_hypervisor never created \$jail/ch-snapshot before calling `ch-remote
# ... snapshot "file:///ch-snapshot"`, while verify_restore_cloud_hypervisor
# (which needs the same directory to stage files into before restore) did, via
# its own `mkdir -p "$jail/run" "$jail/ch-snapshot"`. This is the THIRD round
# of build-vs-verify drift the coordinator caught by execution (round 7: EXIT
# traps; round 8: a stray boot-resource PUT copied into verify) -- so instead
# of a fourth point-fix, the jail-prep/teardown sequence common to all four
# functions was extracted into two shared helpers, prepare_jail and
# teardown_jail, so the two cloud-hypervisor functions share ONE call pattern
# for this directory rather than each retyping mkdir independently.
check "prepare_jail helper exists" \
  "$([ "$(grep -c '^prepare_jail()' "$SCRIPT")" -eq 1 ] && echo yes || echo no)" "yes"
check "teardown_jail helper exists" \
  "$([ "$(grep -c '^teardown_jail()' "$SCRIPT")" -eq 1 ] && echo yes || echo no)" "yes"

# prepare_jail's own body: mkdir (the fixed step) must run before the binary is
# staged, which must run before the device mount -- same source-order idiom
# used throughout this file.
pj_start=$(grep -n "^prepare_jail() {" "$SCRIPT" | head -n1 | cut -d: -f1)
ok=no
if [ -n "$pj_start" ]; then
  pj_end=$(awk -v s="$pj_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$pj_end" ]; then
    mkdir_line=$(awk -v s="$pj_start" -v e="$pj_end" \
      'NR>=s && NR<=e && /mkdir -p "\$jail\/run" "\$@"/{print NR; exit}' "$SCRIPT")
    bin_line=$(awk -v s="$pj_start" -v e="$pj_end" \
      'NR>=s && NR<=e && /hardlink_or_copy_bin "\$bin"/{print NR; exit}' "$SCRIPT")
    mount_line=$(awk -v s="$pj_start" -v e="$pj_end" \
      'NR>=s && NR<=e && /jail_mount_dev "\$jail"/{print NR; exit}' "$SCRIPT")
    if [ -n "$mkdir_line" ] && [ -n "$bin_line" ] && [ -n "$mount_line" ] \
      && [ "$mkdir_line" -lt "$bin_line" ] && [ "$bin_line" -lt "$mount_line" ]; then
      ok=yes
    fi
  fi
fi
check "prepare_jail creates directories (incl. any extra dirs) before staging the binary, before mounting /dev" "$ok" "yes"

# The bug fix itself, as a direct regression test: both cloud-hypervisor
# functions' prepare_jail calls must pass "$jail/ch-snapshot" as an extra
# directory. Comment-collision trap: strip comment lines first -- this file's
# and build-snapshot.sh's own explanatory comments now discuss "ch-snapshot"
# and "prepare_jail" extensively in prose.
live_lines="$(grep -v '^[[:space:]]*#' "$SCRIPT")"
check "both cloud-hypervisor functions' prepare_jail calls create \$jail/ch-snapshot" \
  "$([ "$(printf '%s\n' "$live_lines" | grep -cF 'prepare_jail cloud-hypervisor "$jail" "$jail/ch-snapshot"')" -eq 2 ] && echo yes || echo no)" "yes"
check "both firecracker functions' prepare_jail calls take no extra directory" \
  "$([ "$(printf '%s\n' "$live_lines" | grep -cE 'prepare_jail firecracker "\$jail"[[:space:]]*$')" -eq 2 ] && echo yes || echo no)" "yes"
check "prepare_jail is called by exactly the four build/verify functions" \
  "$([ "$(printf '%s\n' "$live_lines" | grep -cE '^[[:space:]]*prepare_jail (firecracker|cloud-hypervisor) ')" -eq 4 ] && echo yes || echo no)" "yes"
check "teardown_jail is called by exactly the four build/verify functions" \
  "$([ "$(printf '%s\n' "$live_lines" | grep -cF 'teardown_jail "$jail"')" -eq 4 ] && echo yes || echo no)" "yes"

# No function should still retype the inline kill/wait/unmount teardown
# sequence -- if one did, it and teardown_jail could drift apart exactly like
# the two build/verify mkdir calls did. Exclude teardown_jail's own definition
# (the one legitimate site) by cutting it out of the search text first.
non_teardown_body="$(awk '/^teardown_jail\(\) \{/{skip=1} skip{if(/^}$/){skip=0}; next} {print}' "$SCRIPT")"
check "no function outside teardown_jail still kills/waits on \$CLEANUP_PID inline" \
  "$(printf '%s\n' "$non_teardown_body" | grep -v '^[[:space:]]*#' | grep -cF 'kill "$CLEANUP_PID"')" "0"
check "no function outside teardown_jail still calls jail_unmount_dev directly" \
  "$(printf '%s\n' "$non_teardown_body" | grep -v '^[[:space:]]*#' | grep -cF 'jail_unmount_dev "$jail"')" "0"

# Source-order regression guard for the fixed bug: within
# boot_quiesce_snapshot_cloud_hypervisor, the prepare_jail call (which now
# creates $jail/ch-snapshot) must precede the `ch-remote ... snapshot` call
# that requires the directory to already exist.
ch_start=$(grep -n "^boot_quiesce_snapshot_cloud_hypervisor() {" "$SCRIPT" | head -n1 | cut -d: -f1)
ok=no
if [ -n "$ch_start" ]; then
  ch_end=$(awk -v s="$ch_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$ch_end" ]; then
    prep_line=$(awk -v s="$ch_start" -v e="$ch_end" \
      'NR>=s && NR<=e && /^  prepare_jail cloud-hypervisor/{print NR; exit}' "$SCRIPT")
    snap_line=$(awk -v s="$ch_start" -v e="$ch_end" \
      'NR>=s && NR<=e && /ch-remote --api-socket "\$api_sock" snapshot/{print NR; exit}' "$SCRIPT")
    if [ -n "$prep_line" ] && [ -n "$snap_line" ] && [ "$prep_line" -lt "$snap_line" ]; then
      ok=yes
    fi
  fi
fi
check "boot_quiesce_snapshot_cloud_hypervisor creates \$jail/ch-snapshot before ch-remote snapshot needs it" "$ok" "yes"

# Deliberate-difference comments the audit called for must actually be present
# at their sites, not just in the fix-round report.
check "a comment explains cloud-hypervisor's lack of ensure_workspace_image (virtio-fs)" \
  "$([ "$(grep -cF 'virtio-fs' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "a comment explains cloud-hypervisor's virtiofsd-served workspace by name" \
  "$([ "$(grep -cF 'virtiofsd' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "each build function's fresh-boot-only block and workspace-image asymmetry both carry a deliberate-difference comment (2 sites x 2 VMM arms)" \
  "$([ "$(grep -cF 'Deliberate build-vs-verify asymmetry' "$SCRIPT")" -eq 4 ] && echo yes || echo no)" "yes"

echo "== fix-round-10: wait_for_socket -- nothing calls a VMM's API before its socket actually accepts connections"
# Real rig failure: 'curl: (7) Failed to connect to localhost over
# .../verify-ch-api.sock after 0 ms: Could not connect to server' --
# verify_restore_cloud_hypervisor's api_put ran as the very next statement
# after cloud-hypervisor was backgrounded, with nothing between "started" and
# "first call". verify_restore_firecracker only happened to pass: several
# statements (three link_snapshot_file calls, ensure_workspace_image) sit
# between its own CLEANUP_PID assignment and its first api_put, and
# firecracker itself binds its socket unusually fast -- so it was racy too,
# just not losing yet. wait_for_socket is the one implementation for all four
# VMM-launching functions, the same shape as fix-round-9's prepare_jail/
# teardown_jail.

check "wait_for_socket helper exists" \
  "$(grep -cE '^wait_for_socket\(\) \{' "$SCRIPT")" "1"

# One implementation, four callers, no room to drift: every call site uses the
# exact same invocation, so a fifth VMM-start site added later without this
# call is the one thing this count cannot silently tolerate.
check "wait_for_socket is called by exactly the four VMM-launching functions" \
  "$(grep -cF 'wait_for_socket "$api_sock"' "$SCRIPT")" "4"

wait_body="$(awk '/^wait_for_socket\(\) \{/{f=1} f{print} f && /^}$/{exit}' "$SCRIPT")"

# The helper must not settle for file existence: both real VMMs create the
# socket file before they are actually accept()ing on it (cloud-hypervisor's
# own rig failure is the proof -- the file existed, srwx------ root root, and
# curl still could not connect). It must attempt a real connection instead.
check "wait_for_socket attempts a real connection via curl --unix-socket, not a bare existence check" \
  "$(printf '%s\n' "$wait_body" | grep -v '^[[:space:]]*#' | grep -c 'curl.*--unix-socket')" "1"
check "wait_for_socket's own code contains no bare '[ -e \"\$sock\" ]' existence-only check" \
  "$(printf '%s\n' "$wait_body" | grep -v '^[[:space:]]*#' | grep -cF '[ -e "$sock"')" "0"

# Bounded polling, not a fixed sleep: a fixed delay either wastes time on an
# idle host or is too short on a loaded one, and either way it hides the
# failure instead of reporting it -- the helper must loop, and must not just
# sleep once for the whole timeout.
check "wait_for_socket polls in a loop rather than sleeping once" \
  "$(printf '%s\n' "$wait_body" | grep -v '^[[:space:]]*#' | grep -cE '^[[:space:]]*while ')" "1"
check "wait_for_socket does not sleep for the full \$timeout_s in one shot" \
  "$(printf '%s\n' "$wait_body" | grep -v '^[[:space:]]*#' | grep -cE 'sleep[[:space:]]+"?\$timeout_s"?')" "0"
check "wait_for_socket's failure message names both the socket path and the elapsed timeout bound" \
  "$(printf '%s\n' "$wait_body" | grep -c 'timed out after.*waiting for.*sock')" "1"

# Source-order regression guard for the fixed bug, per function: wait_for_socket
# must run strictly between CLEANUP_PID being set and the first call that
# touches the API socket. That gap is exactly where the bug lived.
check_wait_before_first_call() {
  local fn="$1" first_call_substr="$2"
  local start end body wait_line call_line ok=no
  start=$(grep -n "^${fn}() {" "$SCRIPT" | head -n1 | cut -d: -f1)
  if [ -n "$start" ]; then
    end=$(awk -v s="$start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
    if [ -n "$end" ]; then
      body="$(sed -n "${start},${end}p" "$SCRIPT")"
      wait_line=$(printf '%s\n' "$body" | grep -nF 'wait_for_socket "$api_sock"' | head -n1 | cut -d: -f1)
      call_line=$(printf '%s\n' "$body" | grep -nF "$first_call_substr" | head -n1 | cut -d: -f1)
      if [ -n "$wait_line" ] && [ -n "$call_line" ] && [ "$wait_line" -lt "$call_line" ]; then
        ok=yes
      fi
    fi
  fi
  echo "$ok"
}

check "boot_quiesce_snapshot_firecracker waits for the socket before its first api_put" \
  "$(check_wait_before_first_call boot_quiesce_snapshot_firecracker 'api_put "$api_sock" /boot-source')" "yes"
check "boot_quiesce_snapshot_cloud_hypervisor waits for the socket before its first ch-remote call" \
  "$(check_wait_before_first_call boot_quiesce_snapshot_cloud_hypervisor 'ch-remote --api-socket "$api_sock" pause')" "yes"
check "verify_restore_firecracker waits for the socket before /snapshot/load (THE call site the rig lost -- FC arm)" \
  "$(check_wait_before_first_call verify_restore_firecracker 'api_put "$api_sock" /snapshot/load')" "yes"
check "verify_restore_cloud_hypervisor waits for the socket before /api/v1/vm.restore (THE call site the rig lost -- CH arm)" \
  "$(check_wait_before_first_call verify_restore_cloud_hypervisor 'api_put "$api_sock" /api/v1/vm.restore')" "yes"

# Cloud Hypervisor's <socket>.lock file (Firecracker creates none) must be
# cleaned up in the one shared teardown, not re-typed per VMM arm.
teardown_body="$(awk '/^teardown_jail\(\) \{/{f=1} f{print} f && /^}$/{exit}' "$SCRIPT")"
check "teardown_jail removes any stale *.sock.lock left in the jail's run dir" \
  "$(printf '%s\n' "$teardown_body" | grep -v '^[[:space:]]*#' | grep -cF '.sock.lock')" "1"

echo "== fix-round-11 item 2: wait_for_socket's timeout path preserves the console log too"
# Real rig failure: verify_restore_cloud_hypervisor's chroot could not execve
# a jail binary (see the hardlink_or_copy_bin section below) and the ONLY way
# to read why was to manually defeat this script's cleanup, because
# wait_for_socket's timeout path -- unlike wait_for_agent's, since fix-round-4
# -- threw the console log away. This is the third occurrence of the same
# "a bounded timeout with no output destroys the evidence that would explain
# it" pattern; the fix reuses save_and_print_console_log rather than writing
# a second, independent copy of the same save/tail logic.
wfs_start=$(grep -n "^wait_for_socket() {" "$SCRIPT" | head -n1 | cut -d: -f1)
check "wait_for_socket helper still exists (unmoved by the round-11 refactor)" \
  "$([ -n "$wfs_start" ] && echo yes || echo no)" "yes"

ok=no
if [ -n "$wfs_start" ]; then
  wfs_end=$(awk -v s="$wfs_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$wfs_end" ]; then
    call_line=$(awk -v s="$wfs_start" -v e="$wfs_end" \
      'NR>=s && NR<=e && /save_and_print_console_log "\$console_log"/{print NR; exit}' "$SCRIPT")
    timeout_line=$(awk -v s="$wfs_start" -v e="$wfs_end" \
      'NR>=s && NR<=e && /timed out after/{print NR; exit}' "$SCRIPT")
    exit_line=$(awk -v s="$wfs_start" -v e="$wfs_end" \
      'NR>=s && NR<=e && /^  exit 1$/{print NR; exit}' "$SCRIPT")
    if [ -n "$call_line" ] && [ -n "$timeout_line" ] && [ -n "$exit_line" ] \
      && [ "$call_line" -lt "$timeout_line" ] && [ "$timeout_line" -lt "$exit_line" ]; then
      ok=yes
    fi
  fi
fi
check "wait_for_socket's timeout path calls save_and_print_console_log before exiting" "$ok" "yes"

# wait_for_socket's signature grew a console_log parameter to make this
# possible -- and every one of the four call sites must supply it, or the
# helper above receives an empty path and silently no-ops on the "no guest
# console log exists" branch instead of ever finding the real one.
check "wait_for_socket's signature takes a console_log parameter (2nd positional)" \
  "$(sed -n "$((wfs_start + 1))p" "$SCRIPT" | grep -cF 'console_log="$2"')" "1"
check "all four wait_for_socket call sites now pass a console_log argument" \
  "$(grep -cF 'wait_for_socket "$api_sock" "$console_log"' "$SCRIPT")" "4"

# The two verify_restore_* functions had no named console_log local before
# this round (only the literal string "$STAGE/verify-console.log" inlined in
# their chroot redirections) -- exactly the two sites where the coordinator's
# own bug manifested. A named variable must now exist in each, and the
# redirection must use it too (not keep the inline literal, which would let
# the two drift apart the moment either one is edited again).
for fn in verify_restore_firecracker verify_restore_cloud_hypervisor; do
  fn_start=$(grep -n "^${fn}() {" "$SCRIPT" | head -n1 | cut -d: -f1)
  ok=no
  if [ -n "$fn_start" ]; then
    fn_end=$(awk -v s="$fn_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
    if [ -n "$fn_end" ]; then
      body="$(sed -n "${fn_start},${fn_end}p" "$SCRIPT")"
      has_local=$(printf '%s\n' "$body" | grep -cF 'console_log="$STAGE/verify-console.log"')
      has_literal_left=$(printf '%s\n' "$body" | grep -v '^[[:space:]]*#' | grep -cF '>"$STAGE/verify-console.log"')
      if [ "$has_local" -ge 1 ] && [ "$has_literal_left" -eq 0 ]; then
        ok=yes
      fi
    fi
  fi
  check "$fn declares a named console_log local and uses it (not the inline literal) in its redirection" "$ok" "yes"
done

echo "== fix-round-11 item 1: hardlink_or_copy_bin resolves symlinks before linking"
# Real rig failure: /usr/local/bin/cloud-hypervisor was a symlink to a path
# under the coordinator's home directory. GNU `ln SRC DST` hardlinks whatever
# inode SRC names -- since SRC was itself a symlink, the hardlink duplicated
# the SYMLINK, not its target, so the jail ended up containing a symlink
# pointing at a path that does not exist inside the chroot. `ls` inside the
# jail showed the entry right there; chroot's own exec still failed with a
# confusing "No such file or directory". This is an entirely ordinary
# deployment shape (Debian's alternatives system, versioned installs, and
# manual PATH housekeeping all make binaries under /usr/bin symlinks), not an
# exotic one.
hocb_start=$(grep -n "^hardlink_or_copy_bin() {" "$SCRIPT" | head -n1 | cut -d: -f1)
check "hardlink_or_copy_bin helper still exists" \
  "$([ -n "$hocb_start" ] && echo yes || echo no)" "yes"

hocb_body=""
if [ -n "$hocb_start" ]; then
  hocb_end=$(awk -v s="$hocb_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$hocb_end" ]; then
    hocb_body="$(sed -n "${hocb_start},${hocb_end}p" "$SCRIPT")"
  fi
fi

ok=no
resolve_line=""
if [ -n "$hocb_body" ]; then
  resolve_line=$(printf '%s\n' "$hocb_body" | grep -nE 'realpath -e|readlink -f' | head -n1 | cut -d: -f1)
  ln_line=$(printf '%s\n' "$hocb_body" | grep -nF 'ln "$resolved" "$dst"' | head -n1 | cut -d: -f1)
  if [ -n "$resolve_line" ] && [ -n "$ln_line" ] && [ "$resolve_line" -lt "$ln_line" ]; then
    ok=yes
  fi
fi
check "hardlink_or_copy_bin resolves the symlink (realpath -e or readlink -f) before ln/cp" "$ok" "yes"

check "hardlink_or_copy_bin links the RESOLVED path, not the original possibly-symlinked \$src" \
  "$(printf '%s\n' "$hocb_body" | grep -cF 'ln "$src" "$dst"')" "0"

# Fail loudly rather than deferring to a confusing downstream chroot error:
# both a resolution failure (dangling symlink) and a non-executable resolved
# target must exit 1 with a message naming the tool, not silently proceed to
# stage a broken jail.
check "hardlink_or_copy_bin fails loudly if the resolved path does not exist (realpath -e's own contract)" \
  "$(printf '%s\n' "$hocb_body" | grep -cE 'resolved="\$\(realpath -e "\$src"\)" \|\|')" "1"
check "hardlink_or_copy_bin fails loudly if the resolved path is not executable" \
  "$(printf '%s\n' "$hocb_body" | grep -cF '[ ! -x "$resolved" ]')" "1"

# Behavioral assertion, not just source inspection: create a real symlink to a
# real file in a temp dir, actually RUN the helper against it, and assert the
# result is a regular file, not a symlink. A grep-only test cannot see this
# bug -- it can only see whether the source text CONTAINS a resolution call,
# not whether that call actually runs before the ln/cp it is meant to guard.
# The whole script cannot be sourced for this (it ends in an unconditional
# `main` call that would immediately demand real CLI flags and root), so the
# helper's own source is extracted into an isolated snippet and sourced by
# itself instead.
# GNU `realpath -e` is what the helper itself calls. BSD/macOS realpath has no -e at
# all ("illegal option -- e"), so on such a host the helper cannot resolve anything and
# this behavioral block would report a defect that does not exist in the code under
# test -- misattributing a property of the test RUNNER to the script. build-snapshot.sh
# only ever runs as root on the Linux rig, and CI runs this suite on ubuntu-latest, so
# the assertions below are exercised where they mean something. Probe for -e rather
# than for `uname`, because the capability is the thing that matters.
if realpath -e . >/dev/null 2>&1; then hocb_gnu_realpath=yes; else hocb_gnu_realpath=no; fi

hocb_ok=no
hocb_ok_resolved_content=no
if [ -n "$hocb_body" ] && [ "$hocb_gnu_realpath" = yes ]; then
  hocb_tmpdir="$(mktemp -d)"
  hocb_real_bin="$hocb_tmpdir/real-vmm-binary"
  printf '#!/bin/sh\necho hi\n' >"$hocb_real_bin"
  chmod +x "$hocb_real_bin"
  hocb_pathdir="$hocb_tmpdir/pathdir"
  mkdir -p "$hocb_pathdir"
  ln -s "$hocb_real_bin" "$hocb_pathdir/fake-vmm"
  hocb_dst="$hocb_tmpdir/jail-bin"
  hocb_snippet="$hocb_tmpdir/hocb.sh"
  printf '%s\n' "$hocb_body" >"$hocb_snippet"

  (
    PATH="$hocb_pathdir:$PATH"
    # shellcheck disable=SC1090
    . "$hocb_snippet"
    hardlink_or_copy_bin fake-vmm "$hocb_dst"
  ) >/dev/null 2>&1

  if [ -e "$hocb_dst" ] && [ ! -L "$hocb_dst" ]; then
    hocb_ok=yes
    if diff -q "$hocb_dst" "$hocb_real_bin" >/dev/null 2>&1; then
      hocb_ok_resolved_content=yes
    fi
  fi
  rm -rf "$hocb_tmpdir"
fi
if [ "$hocb_gnu_realpath" = yes ]; then
  check "hardlink_or_copy_bin, actually run against a symlinked PATH entry, produces a regular file (not a symlink)" \
    "$hocb_ok" "yes"
  check "...and that regular file's content matches the real binary the symlink pointed to" \
    "$hocb_ok_resolved_content" "yes"
else
  echo "  (skip: this host's realpath has no -e (BSD/macOS), which is the call the helper"
  echo "   itself makes, so the two behavioral symlink assertions cannot run here --"
  echo "   not run, not claimed verified. CI exercises them on ubuntu-latest.)"
fi

echo "== fix-round-12: cloud-hypervisor snapshot bakes a virtio-fs device (workspace shared, not empty)"
# Real gap: TestGateWriteDurability and TestGateNoCrossRunBleed both failed on
# the cloud-hypervisor arm because boot_quiesce_snapshot_cloud_hypervisor never
# passed --fs to cloud-hypervisor -- the restored guest's config.json had no
# virtio-fs device at all, so /workspace was empty on every restore. The tag is
# fixed by the coordinator (not a choice made here) to "workspace": it matches
# the in-guest mount point, the firecracker arm's own workspace.img naming, and
# what a reader of `mount -t virtiofs workspace /workspace` would expect.
live_lines="$(grep -v '^[[:space:]]*#' "$SCRIPT")"

check "cloud-hypervisor build invocation passes --fs with a tag and a socket" \
  "$([ "$(printf '%s\n' "$live_lines" | grep -cE -- '--fs "tag=[^,]+,socket=[^"]+"')" -ge 1 ] && echo yes || echo no)" "yes"

# The literal tag, pinned as its own assertion (the contract made executable):
# a rename on one side (this script's --fs vs. the guest-side mount the
# coordinator is dispatching separately) must fail THIS test, not reproduce
# the silent empty-workspace symptom the two §8 gates already caught once.
check "the virtio-fs tag is the literal 'workspace' (coordinator-fixed, not a free choice)" \
  "$([ "$(printf '%s\n' "$live_lines" | grep -cF -- '--fs "tag=workspace,socket=/fs.sock"')" -eq 1 ] && echo yes || echo no)" "yes"

# verify_restore_cloud_hypervisor must NOT set the tag itself -- it replays the
# golden config.json verbatim (already carrying "workspace"), so a second,
# independent --fs flag there would be drift waiting to happen, not a fix.
ch_verify_start=$(grep -n "^verify_restore_cloud_hypervisor() {" "$SCRIPT" | head -n1 | cut -d: -f1)
ch_verify_end=""
ch_verify_body=""
if [ -n "$ch_verify_start" ]; then
  ch_verify_end=$(awk -v s="$ch_verify_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$ch_verify_end" ]; then
    ch_verify_body="$(sed -n "${ch_verify_start},${ch_verify_end}p" "$SCRIPT")"
  fi
fi
check "verify_restore_cloud_hypervisor never passes its own --fs flag (replays the golden config.json's tag verbatim)" \
  "$(printf '%s\n' "$ch_verify_body" | grep -v '^[[:space:]]*#' | grep -cF -- '--fs ')" "0"

echo "== fix-round-13: cloud-hypervisor's --memory carries shared=on (vhost-user's --fs device requires MAP_SHARED guest RAM)"
# Real gap: cloud-hypervisor refused to start at all -- "Fatal error:
# ParsingConfig(Validation(VhostUserRequiresSharedMemory))" -- a config-
# validation failure at 0.001s, before any boot, identical whether or not
# virtiofsd's socket exists. Causal chain pinned by this assertion: --fs
# (round 12) is a vhost-user device; vhost-user devices are driven by an
# external daemon (virtiofsd) that needs direct access to guest RAM; cloud-
# hypervisor only allows that when the guest's memory is MAP_SHARED, which its
# own --memory flag controls via shared=on (default off/MAP_PRIVATE, per
# cloud-hypervisor's own docs/memory.md -- example there is literally
# `--memory size=1G,shared=on`). None of "virtio-fs", "vhost-user" or "shared
# memory" appears near a bare `--memory "size=...M"`, which is exactly why
# round 12 shipped this defect: pin the spelling here so it cannot silently
# regress the same way.
check "cloud-hypervisor build invocation's --memory carries shared=on" \
  "$([ "$(printf '%s\n' "$live_lines" | grep -cE -- '--memory "size=[^"]*shared=on[^"]*"')" -ge 1 ] && echo yes || echo no)" "yes"

# verify_restore_cloud_hypervisor must NOT set --memory itself -- same reason
# as the --fs assertion above: it replays the golden config.json (memory
# settings included) verbatim via vm.restore, so an independent --memory flag
# here would be drift waiting to happen, not a fix.
check "verify_restore_cloud_hypervisor never passes its own --memory flag (replays the golden config.json's memory settings verbatim)" \
  "$(printf '%s\n' "$ch_verify_body" | grep -v '^[[:space:]]*#' | grep -cF -- '--memory ')" "0"

# The firecracker arm has no vhost-user device (its workspace is a plain disk
# image, not virtio-fs) and must not acquire a shared-memory requirement it
# does not need -- configured instead via PUT /machine-config's mem_size_mib,
# a wholly different mechanism with no shared/private memory concept at all.
fc_build_start=$(grep -n "^boot_quiesce_snapshot_firecracker() {" "$SCRIPT" | head -n1 | cut -d: -f1)
fc_build_end=""
fc_build_body=""
if [ -n "$fc_build_start" ]; then
  fc_build_end=$(awk -v s="$fc_build_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$fc_build_end" ]; then
    fc_build_body="$(sed -n "${fc_build_start},${fc_build_end}p" "$SCRIPT")"
  fi
fi
check "boot_quiesce_snapshot_firecracker never passes a --memory flag or shared=on (no vhost-user device, no shared-memory requirement)" \
  "$(printf '%s\n' "$fc_build_body" | grep -v '^[[:space:]]*#' | grep -cE -- '--memory |shared=on')" "0"
check "boot_quiesce_snapshot_firecracker configures guest RAM via /machine-config's mem_size_mib instead" \
  "$([ "$(printf '%s\n' "$fc_build_body" | grep -v '^[[:space:]]*#' | grep -cF -- 'mem_size_mib')" -ge 1 ] && echo yes || echo no)" "yes"

echo "== fix-round-12: start_workspace_virtiofsd / teardown_virtiofsd -- one implementation, shared by build and verify"
check "start_workspace_virtiofsd helper exists" \
  "$([ "$(grep -c '^start_workspace_virtiofsd() {' "$SCRIPT")" -eq 1 ] && echo yes || echo no)" "yes"
check "teardown_virtiofsd helper exists" \
  "$([ "$(grep -c '^teardown_virtiofsd() {' "$SCRIPT")" -eq 1 ] && echo yes || echo no)" "yes"

swf_start=$(grep -n "^start_workspace_virtiofsd() {" "$SCRIPT" | head -n1 | cut -d: -f1)
swf_body=""
if [ -n "$swf_start" ]; then
  swf_end=$(awk -v s="$swf_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$swf_end" ]; then
    swf_body="$(sed -n "${swf_start},${swf_end}p" "$SCRIPT")"
  fi
fi

check "start_workspace_virtiofsd guards on virtiofsd being present on PATH (command -v)" \
  "$([ "$(printf '%s\n' "$swf_body" | grep -cF 'command -v virtiofsd')" -ge 1 ] && echo yes || echo no)" "yes"
check "start_workspace_virtiofsd passes --cache=never" \
  "$([ "$(printf '%s\n' "$swf_body" | grep -cF -- '--cache=never')" -ge 1 ] && echo yes || echo no)" "yes"
check "start_workspace_virtiofsd never passes --cache=auto (disconnects the session almost immediately on this host)" \
  "$(printf '%s\n' "$swf_body" | grep -cF -- '--cache=auto')" "0"
check "start_workspace_virtiofsd passes --sandbox=namespace" \
  "$([ "$(printf '%s\n' "$swf_body" | grep -cF -- '--sandbox=namespace')" -ge 1 ] && echo yes || echo no)" "yes"
check "start_workspace_virtiofsd never passes --sandbox=none" \
  "$(printf '%s\n' "$swf_body" | grep -cF -- '--sandbox=none')" "0"

# Source-order guard within start_workspace_virtiofsd itself: virtiofsd must be
# backgrounded (CLEANUP_FS_PID=\$!) before wait_for_socket is asked to block on
# its socket, and the wait call must use the "raw" proto -- virtiofsd's
# vhost-user socket does not speak HTTP the way the API sockets do.
ok=no
if [ -n "$swf_body" ]; then
  bg_line=$(printf '%s\n' "$swf_body" | grep -nF 'CLEANUP_FS_PID=$!' | head -n1 | cut -d: -f1)
  wait_line=$(printf '%s\n' "$swf_body" | grep -nF 'wait_for_socket "$sock" "$console_log" 5 raw' | head -n1 | cut -d: -f1)
  if [ -n "$bg_line" ] && [ -n "$wait_line" ] && [ "$bg_line" -lt "$wait_line" ]; then
    ok=yes
  fi
fi
check "start_workspace_virtiofsd backgrounds virtiofsd, then waits for its socket in raw mode" "$ok" "yes"

twf_start=$(grep -n "^teardown_virtiofsd() {" "$SCRIPT" | head -n1 | cut -d: -f1)
twf_body=""
if [ -n "$twf_start" ]; then
  twf_end=$(awk -v s="$twf_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$twf_end" ]; then
    twf_body="$(sed -n "${twf_start},${twf_end}p" "$SCRIPT")"
  fi
fi
check "teardown_virtiofsd kills and waits on \$CLEANUP_FS_PID" \
  "$([ "$(printf '%s\n' "$twf_body" | grep -cF 'CLEANUP_FS_PID')" -ge 2 ] && echo yes || echo no)" "yes"
check "teardown_virtiofsd clears CLEANUP_FS_PID afterwards" \
  "$([ "$(printf '%s\n' "$twf_body" | grep -cF 'CLEANUP_FS_PID=""')" -eq 1 ] && echo yes || echo no)" "yes"

echo "== fix-round-12: ordering -- virtiofsd up before the VMM starts, VMM torn down before virtiofsd"
# Both cloud-hypervisor functions must start virtiofsd before backgrounding
# cloud-hypervisor (CLEANUP_PID=\$!), and must call teardown_jail (which reaps
# the VMM) before teardown_virtiofsd -- the exact reverse of start order, and
# the order launcher_chv.go's own Destroy already uses.
for fn in boot_quiesce_snapshot_cloud_hypervisor verify_restore_cloud_hypervisor; do
  fn_start=$(grep -n "^${fn}() {" "$SCRIPT" | head -n1 | cut -d: -f1)
  ok_start_order=no
  ok_teardown_order=no
  if [ -n "$fn_start" ]; then
    fn_end=$(awk -v s="$fn_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
    if [ -n "$fn_end" ]; then
      swf_call_line=$(awk -v s="$fn_start" -v e="$fn_end" \
        'NR>=s && NR<=e && /start_workspace_virtiofsd "\$jail" "\$console_log"/{print NR; exit}' "$SCRIPT")
      cleanup_pid_line=$(awk -v s="$fn_start" -v e="$fn_end" \
        'NR>=s && NR<=e && /CLEANUP_PID=\$!/{print NR; exit}' "$SCRIPT")
      if [ -n "$swf_call_line" ] && [ -n "$cleanup_pid_line" ] && [ "$swf_call_line" -lt "$cleanup_pid_line" ]; then
        ok_start_order=yes
      fi
      teardown_jail_line=$(awk -v s="$fn_start" -v e="$fn_end" \
        'NR>=s && NR<=e && /^  teardown_jail "\$jail"$/{print NR; exit}' "$SCRIPT")
      teardown_fs_line=$(awk -v s="$fn_start" -v e="$fn_end" \
        'NR>=s && NR<=e && /^  teardown_virtiofsd$/{print NR; exit}' "$SCRIPT")
      if [ -n "$teardown_jail_line" ] && [ -n "$teardown_fs_line" ] && [ "$teardown_jail_line" -lt "$teardown_fs_line" ]; then
        ok_teardown_order=yes
      fi
    fi
  fi
  check "$fn starts virtiofsd before backgrounding the VMM" "$ok_start_order" "yes"
  check "$fn tears down the VMM (teardown_jail) before virtiofsd (teardown_virtiofsd)" "$ok_teardown_order" "yes"
done

echo "== fix-round-12: cleanup_on_exit also reaps the build-time virtiofsd on an abnormal exit"
coe_start=$(grep -n "^cleanup_on_exit() {" "$SCRIPT" | head -n1 | cut -d: -f1)
coe_body=""
if [ -n "$coe_start" ]; then
  coe_end=$(awk -v s="$coe_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$coe_end" ]; then
    coe_body="$(sed -n "${coe_start},${coe_end}p" "$SCRIPT")"
  fi
fi
ok=no
if [ -n "$coe_body" ]; then
  vmm_kill_line=$(printf '%s\n' "$coe_body" | grep -nF 'kill "${CLEANUP_PID:-}"' | head -n1 | cut -d: -f1)
  fs_kill_line=$(printf '%s\n' "$coe_body" | grep -nF 'kill "${CLEANUP_FS_PID:-}"' | head -n1 | cut -d: -f1)
  if [ -n "$vmm_kill_line" ] && [ -n "$fs_kill_line" ] && [ "$vmm_kill_line" -lt "$fs_kill_line" ]; then
    ok=yes
  fi
fi
check "cleanup_on_exit's trap reaps CLEANUP_FS_PID too, VMM first" "$ok" "yes"

echo "== fix-round-12: --vmm cloud-hypervisor preflight requires a --kernel with virtio-fs support"
# Coordinator's own rig-validated detection: strings | grep -c virtio_fs
# discriminated cleanly (0 on a Firecracker CI kernel, 68 on cloud-hypervisor's
# own recommended kernel) with no build tooling and no guest boot required.
# Gated on --vmm cloud-hypervisor only -- Firecracker has no virtio-fs support
# at all, so there is deliberately no inverse/informational check on that arm.
pf_start=$(grep -n "^preflight() {" "$SCRIPT" | head -n1 | cut -d: -f1)
check "preflight helper still exists" "$([ -n "$pf_start" ] && echo yes || echo no)" "yes"

pf_end=""
pf_body=""
if [ -n "$pf_start" ]; then
  pf_end=$(awk -v s="$pf_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$pf_end" ]; then
    pf_body="$(sed -n "${pf_start},${pf_end}p" "$SCRIPT")"
  fi
fi

# Scoped to preflight()'s own body, not the whole script: lock_down() has its
# own, unrelated "if [ \"\$VMM\" = \"cloud-hypervisor\" ]; then" (it decides
# whether to ship ch-config.json), which is a false-positive match for a
# whole-script grep and would make this check fail even when preflight's own
# gating is exactly right.
check "preflight's virtio-fs check is gated on cloud-hypervisor, and appears exactly once" \
  "$([ "$(printf '%s\n' "$pf_body" | grep -cE '^  if \[ "\$VMM" = "cloud-hypervisor" \]; then$')" -eq 1 ] && echo yes || echo no)" "yes"

check "no unconditional or firecracker-gated virtio-fs kernel check exists within preflight (no inverse check on that arm)" \
  "$([ "$(printf '%s\n' "$pf_body" | grep -cE '^  if \[ "\$VMM" = "firecracker" \]; then$')" -eq 0 ] && echo yes || echo no)" "yes"

check "preflight's kernel-version check runs before the virtio-fs check (both apply regardless of order, but keep the general gate first)" \
  "$([ "$(printf '%s\n' "$pf_body" | grep -nF 'kernel_at_least' | head -n1 | cut -d: -f1)" -lt "$(printf '%s\n' "$pf_body" | grep -nE '\[ "\$VMM" = "cloud-hypervisor" \]; then' | head -n1 | cut -d: -f1)" ] && echo yes || echo no)" "yes"

check "the virtio-fs preflight message names CONFIG_VIRTIO_FS, the --kernel path, and the strings/grep command it ran" \
  "$([ "$(printf '%s\n' "$pf_body" | grep -cF 'CONFIG_VIRTIO_FS')" -ge 1 ] && [ "$(printf '%s\n' "$pf_body" | grep -cF 'strings $KERNEL | grep -c virtio_fs')" -ge 1 ] && echo yes || echo no)" "yes"
check "the virtio-fs preflight message tells the operator Firecracker CI kernels do not carry the driver" \
  "$([ "$(printf '%s\n' "$pf_body" | grep -cF "Firecracker's CI kernels")" -ge 1 ] && echo yes || echo no)" "yes"
check "the virtio-fs preflight message directs the operator to cloud-hypervisor's own recommended kernel" \
  "$([ "$(printf '%s\n' "$pf_body" | grep -cF 'recommended kernel')" -ge 1 ] && echo yes || echo no)" "yes"

check "the virtio-fs preflight distinguishes a missing/unreadable --kernel from a kernel merely lacking the driver" \
  "$([ "$(printf '%s\n' "$pf_body" | grep -cF 'is missing or unreadable')" -eq 1 ] && echo yes || echo no)" "yes"
check "the virtio-fs preflight requires the 'strings' tool and names the binutils package if absent" \
  "$([ "$(printf '%s\n' "$pf_body" | grep -cF "'strings' is required")" -eq 1 ] && [ "$(printf '%s\n' "$pf_body" | grep -cF 'binutils')" -eq 1 ] && echo yes || echo no)" "yes"

# Behavioral assertion, not just source inspection: extract the virtio-fs
# if-block's own source (same extraction-and-sourcing pattern already used for
# hardlink_or_copy_bin) and actually RUN it, inside a stub function, against
# three synthetic --kernel files and one PATH-stripped environment, asserting
# real exit codes and real stderr content -- not merely that the right grep
# strings appear somewhere in the script.
# Anchored on the unique fix-round-12 comment that immediately precedes the
# block, then takes the first "if [" line after it -- NOT a grep for the
# literal `if [ "$VMM" = "cloud-hypervisor" ]; then` text itself. A literal-
# text match is fragile in exactly the way this behavioral extraction is
# meant to guard against: if a future edit renamed/restructured that one
# arm's gate condition, a bare-text grep would find zero matches at this
# (now-changed) block and silently fall through to whatever OTHER line in
# the script happens to read `if [ "$VMM" = "cloud-hypervisor" ]; then`
# verbatim (there is at least one, unrelated, elsewhere in the manifest-file
# list logic) -- extracting and running the WRONG block while still
# reporting "ok" on assertions that merely check "did $vfs_rc come back 0",
# because the wrong block also happens to no-op harmlessly for a firecracker
# scenario. Confirmed via mutation testing: inverting the real gate's
# condition text reproduced exactly this silent wrong-block fallthrough
# before this anchor fix.
vfs_anchor_line=$(grep -n '^  # Fix-round-12: cloud-hypervisor only, no inverse check on the firecracker arm\.$' "$SCRIPT" | head -n1 | cut -d: -f1)
vfs_block_start=""
if [ -n "$vfs_anchor_line" ]; then
  vfs_block_start=$(awk -v s="$vfs_anchor_line" 'NR>s && /^  if \[/{print NR; exit}' "$SCRIPT")
fi
vfs_block_body=""
if [ -n "$vfs_block_start" ]; then
  vfs_block_end=$(awk -v s="$vfs_block_start" 'NR>s && /^  fi$/{print NR; exit}' "$SCRIPT")
  if [ -n "$vfs_block_end" ]; then
    vfs_block_body="$(sed -n "${vfs_block_start},${vfs_block_end}p" "$SCRIPT")"
  fi
fi

vfs_ok_no_driver=no
vfs_ok_no_driver_stderr_1=no
vfs_ok_no_driver_stderr_2=no
vfs_ok_has_driver=no
vfs_ok_missing_kernel=no
vfs_ok_no_strings=no
vfs_ok_firecracker_skips=no
# Scenarios 3 and 4 below exercise the virtio_fs *content* check, which needs
# a real `strings` binary on THIS test-runner's own PATH (not the deliberately
# PATH-stripped subshell scenario 5 uses) -- a plain minimal container image
# (e.g. ubuntu:22.04 with no binutils installed) commonly lacks it. Skip those
# two scenarios' assertions rather than reporting a false FAIL that is really
# "this harness has no strings/binutils", same treatment this file already
# gives shellcheck above when it is not installed.
vfs_host_has_strings=no
command -v strings >/dev/null 2>&1 && vfs_host_has_strings=yes
if [ "$vfs_host_has_strings" = "no" ]; then
  echo "  (skipping the two virtio_fs-content scenarios: 'strings' is not on this test runner's own PATH; install binutils to exercise them)"
fi
if [ -n "$vfs_block_body" ]; then
  vfs_tmpdir="$(mktemp -d)"
  vfs_no_driver_kernel="$vfs_tmpdir/fc-kernel.bin"
  printf 'not a real kernel, no matching strings here\n' >"$vfs_no_driver_kernel"
  vfs_has_driver_kernel="$vfs_tmpdir/ch-kernel.bin"
  { for _ in $(seq 1 68); do printf 'virtio_fs\n'; done; } >"$vfs_has_driver_kernel"
  vfs_missing_kernel="$vfs_tmpdir/does-not-exist.bin"

  vfs_snippet="$vfs_tmpdir/vfs_check.sh"
  {
    echo 'log() { :; }'
    echo 'run_vfs_check() {'
    printf '%s\n' "$vfs_block_body"
    echo '}'
  } >"$vfs_snippet"

  # 1) firecracker arm: the block must not even engage.
  (
    VMM="firecracker"; KERNEL="$vfs_missing_kernel"
    # VMM/KERNEL are read by the dynamically sourced snippet below, invisible
    # to shellcheck's static analysis -- : "marks" them read so SC2034
    # ("appears unused") does not fire; a plain disable comment is not
    # reliable here (it only suppresses the FIRST same-line/-code warning,
    # and its effect on a later statement can depend on what else is in the
    # subshell -- see scenario 5, which needed this same fix).
    : "$VMM" "$KERNEL"
    # shellcheck disable=SC1090
    . "$vfs_snippet"
    run_vfs_check
  ) >/dev/null 2>&1
  vfs_rc=$?
  [ "$vfs_rc" -eq 0 ] && vfs_ok_firecracker_skips=yes

  # 2) cloud-hypervisor arm, kernel path does not exist: distinct "missing or
  #    unreadable" message, not "no virtio-fs support".
  vfs_out="$(
    (
      VMM="cloud-hypervisor"; KERNEL="$vfs_missing_kernel"
      : "$VMM" "$KERNEL"  # see scenario 1's comment above
      # shellcheck disable=SC1090
      . "$vfs_snippet"
      run_vfs_check
    ) 2>&1
  )"
  vfs_rc=$?
  if [ "$vfs_rc" -ne 0 ] && printf '%s' "$vfs_out" | grep -qF 'missing or unreadable'; then
    vfs_ok_missing_kernel=yes
  fi

  # 3) cloud-hypervisor arm, kernel with no virtio_fs strings: fails, names
  #    CONFIG_VIRTIO_FS and Firecracker's CI kernels. Needs a real `strings`
  #    on this test runner's PATH -- see vfs_host_has_strings above.
  if [ "$vfs_host_has_strings" = "yes" ]; then
    vfs_out="$(
      (
        VMM="cloud-hypervisor"; KERNEL="$vfs_no_driver_kernel"
        : "$VMM" "$KERNEL"  # see scenario 1's comment above
        # shellcheck disable=SC1090
        . "$vfs_snippet"
        run_vfs_check
      ) 2>&1
    )"
    vfs_rc=$?
    if [ "$vfs_rc" -ne 0 ]; then
      vfs_ok_no_driver=yes
    fi
    printf '%s' "$vfs_out" | grep -qF 'CONFIG_VIRTIO_FS' && vfs_ok_no_driver_stderr_1=yes
    printf '%s' "$vfs_out" | grep -qF 'Firecracker' && vfs_ok_no_driver_stderr_2=yes

    # 4) cloud-hypervisor arm, kernel WITH virtio_fs strings: passes (exit 0).
    (
      VMM="cloud-hypervisor"; KERNEL="$vfs_has_driver_kernel"
      : "$VMM" "$KERNEL"  # see scenario 1's comment above
      # shellcheck disable=SC1090
      . "$vfs_snippet"
      run_vfs_check
    ) >/dev/null 2>&1
    vfs_rc=$?
    [ "$vfs_rc" -eq 0 ] && vfs_ok_has_driver=yes
  fi

  # 5) cloud-hypervisor arm, 'strings' unavailable on PATH: distinct failure
  #    naming the binutils package, not misreported as "no virtio-fs support".
  vfs_out="$(
    (
      # PATH is deliberately overridden here (not appended to) so
      # command -v strings fails inside the sourced snippet, exercising the
      # preflight's own "'strings' is required" guard.
      # shellcheck disable=SC2123
      PATH="/nonexistent-vfs-test-path"
      VMM="cloud-hypervisor"; KERNEL="$vfs_has_driver_kernel"
      : "$VMM" "$KERNEL"  # see scenario 1's comment above
      # shellcheck disable=SC1090
      . "$vfs_snippet"
      run_vfs_check
    ) 2>&1
  )"
  vfs_rc=$?
  if [ "$vfs_rc" -ne 0 ] && printf '%s' "$vfs_out" | grep -qF 'binutils'; then
    vfs_ok_no_strings=yes
  fi

  rm -rf "$vfs_tmpdir"
fi
check "virtio-fs preflight check, actually run: firecracker arm never engages it (exits 0 even with a bogus --kernel)" "$vfs_ok_firecracker_skips" "yes"
check "virtio-fs preflight check, actually run: a missing --kernel file fails with 'missing or unreadable'" "$vfs_ok_missing_kernel" "yes"
if [ "$vfs_host_has_strings" = "yes" ]; then
  check "virtio-fs preflight check, actually run: a kernel with no virtio_fs strings fails (exit != 0)" "$vfs_ok_no_driver" "yes"
  check "...and that failure names CONFIG_VIRTIO_FS" "$vfs_ok_no_driver_stderr_1" "yes"
  check "...and that failure names Firecracker's CI kernels as the likely cause" "$vfs_ok_no_driver_stderr_2" "yes"
  check "virtio-fs preflight check, actually run: a kernel with virtio_fs strings passes (exit 0)" "$vfs_ok_has_driver" "yes"
fi
check "virtio-fs preflight check, actually run: 'strings' missing from PATH fails naming binutils" "$vfs_ok_no_strings" "yes"

echo "== fix-round-12/13: the A/B is not a clean VMM swap -- three differences, none chosen, recorded together for the Task 20/21 write-up"
check "the manifest or a header comment records that the two VMM arms use different kernels (caveat for any A/B comparison)" \
  "$([ "$(grep -ciF 'VMM-plus-kernel' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
# Fix-round-13 added two more differences chasing the shared=on defect down --
# both must land in the SAME comment block as the round-12 kernel caveat, not
# scattered, so a reader of the write-up finds all three together.
check "...and records that cloud-hypervisor v53.0 has no copy-on-write restore mode (second caveat item, same place)" \
  "$([ "$(grep -ciF 'No copy-on-write restore mode' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "...and records that the two arms now use different guest memory backing -- shared vs. private (third caveat item, same place)" \
  "$([ "$(grep -ciF 'Different guest memory backing' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "...and ties that third item explicitly to spec section 7.3's memory arithmetic / standby-density basis" \
  "$([ "$(grep -cF 'section 7.3' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

echo "== fix-round-14: the snapshot is VERIFIED before it is published, and a failed verify leaves the previous one intact"
# The defect this section pins: main() used to be write_manifest -> lock_down ->
# verify_restore, so the artifact was sealed into $OUT before anything proved it could
# restore, and nothing rolled it back. A failed verification therefore left $OUT holding
# a complete, root-owned, 0444/0555 snapshot whose manifest hash matches its own bytes --
# so every worker's startup verification PASSES and the tier boots on an artifact known
# not to restore. Compounding: a rebuild overwrote $OUT in place, so a failed rebuild
# destroyed a previously-good snapshot and replaced it with a broken one.
#
# Three checks, in increasing strength: the order in main(), that only publish_snapshot
# names $OUT at all, and then the behaviour itself -- main() actually run, with the real
# publish_snapshot and the real cleanup_on_exit, against real directories.
main_start=$(grep -n "^main() {" "$SCRIPT" | head -n1 | cut -d: -f1)
main_body=""
if [ -n "$main_start" ]; then
  main_end=$(awk -v s="$main_start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  if [ -n "$main_end" ]; then
    main_body="$(sed -n "${main_start},${main_end}p" "$SCRIPT")"
  fi
fi
check "main() was found" "$([ -n "$main_body" ] && echo yes || echo no)" "yes"
lock_line=$(printf '%s\n' "$main_body" | grep -nE '^  lock_down$' | head -n1 | cut -d: -f1)
verify_line=$(printf '%s\n' "$main_body" | grep -nE '^  verify_restore$' | head -n1 | cut -d: -f1)
publish_line=$(printf '%s\n' "$main_body" | grep -nE '^  publish_snapshot$' | head -n1 | cut -d: -f1)
check "main() calls publish_snapshot at all" "$([ -n "$publish_line" ] && echo yes || echo no)" "yes"
check "main() seals (lock_down) before it verifies" \
  "$([ -n "$lock_line" ] && [ -n "$verify_line" ] && [ "$lock_line" -lt "$verify_line" ] && echo yes || echo no)" "yes"
check "main() verifies BEFORE it publishes (the whole point: an unverified snapshot never reaches \$OUT)" \
  "$([ -n "$verify_line" ] && [ -n "$publish_line" ] && [ "$verify_line" -lt "$publish_line" ] && echo yes || echo no)" "yes"

# Only publish_snapshot may name $OUT as a destination. Scoped to each function's own
# body rather than grepped whole-script, because $OUT appears in a dozen comments.
fn_body() {
  local start end
  start=$(grep -n "^$1() {" "$SCRIPT" | head -n1 | cut -d: -f1)
  [ -n "$start" ] || return 0
  end=$(awk -v s="$start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  [ -n "$end" ] || return 0
  sed -n "${start},${end}p" "$SCRIPT" | grep -v '^\s*#'
}
check "lock_down installs into \$PENDING" \
  "$([ "$(fn_body lock_down | grep -cF 'install -m 0644 "$STAGE/$f" "$PENDING/$f"')" -ge 1 ] && echo yes || echo no)" "yes"
check "lock_down writes nothing under \$OUT" \
  "$(fn_body lock_down | grep -cF '"$OUT/')" "0"
check "lock_down registers the unpublished snapshot for cleanup" \
  "$([ "$(fn_body lock_down | grep -cF 'CLEANUP_PENDING_DIR="$PENDING"')" -ge 1 ] && echo yes || echo no)" "yes"
check "verify_restore_firecracker links out of \$PENDING, not \$OUT" \
  "$([ "$(fn_body verify_restore_firecracker | grep -cF 'link_snapshot_file "$PENDING/')" -ge 3 ] && [ "$(fn_body verify_restore_firecracker | grep -cF 'link_snapshot_file "$OUT/')" -eq 0 ] && echo yes || echo no)" "yes"
check "verify_restore_cloud_hypervisor links out of \$PENDING, not \$OUT" \
  "$([ "$(fn_body verify_restore_cloud_hypervisor | grep -cF 'link_snapshot_file "$PENDING/')" -ge 4 ] && [ "$(fn_body verify_restore_cloud_hypervisor | grep -cF 'link_snapshot_file "$OUT/')" -eq 0 ] && echo yes || echo no)" "yes"
check "cleanup_on_exit removes the unpublished snapshot on any exit path" \
  "$([ "$(fn_body cleanup_on_exit | grep -cF 'CLEANUP_PENDING_DIR')" -ge 1 ] && echo yes || echo no)" "yes"

# Behavioural: run the REAL main(), publish_snapshot and cleanup_on_exit against real
# directories, with the phases that need KVM and root stubbed out.
#
# The extracted snippet is written INSIDE this tests/ directory, not under /tmp: every
# path this suite reasons about is computed from $DIR, and a snippet living somewhere
# else has produced confidently wrong answers on this branch before.
#
# lock_down is the REAL function, extracted and run, with only `install` and `chown`
# shadowed by shell functions (a non-root CI runner cannot chown root:root, and
# install(1)'s -m/-o flags are not the property under test). That matters: it is
# lock_down's choice of DESTINATION that the pre-fix code got wrong, so a stubbed
# lock_down would have hidden the defect behind the harness. publish_snapshot,
# cleanup_on_exit and main are real too.
pub_tmproot="$(mktemp -d "$DIR/tests/.publish-scenario.XXXXXX")"
trap 'chmod -R u+rwX "$pub_tmproot" 2>/dev/null; rm -rf "$pub_tmproot"' EXIT
pub_snippet="$pub_tmproot/publish_snippet.sh"
{
  fn_body cleanup_on_exit
  fn_body lock_down
  fn_body publish_snapshot
  fn_body seed_verify_cache
  printf '%s\n' "$main_body"
} >"$pub_snippet"

# $1 = verify outcome (0 or 1), $2 = "pre" to seed a previously-good $OUT, $3 = the mock
# microvm-worker's exit code for the verify-cache seed ("none": no binary at all).
# Echoes "<exit code>|<manifest contents or MISSING>|<leftover pending/retired dirs>|<seed>",
# <seed> being the mock's argv and what $OUT held when it ran (manifest), or NONE.
run_publish_scenario() {
  local verify_rc="$1" seed="$2" worker_rc="${3:-0}"
  local root out rc manifest leftovers seeded
  root="$(mktemp -d "$pub_tmproot/scenario.XXXXXX")"
  out="$root/snapshots/default"
  if [ "$worker_rc" != none ]; then
    # The mock records its argv, its environment's SH_SNAPSHOT_DIR (env -i must clear it),
    # and the published manifest it was pointed at, then exits as told. Literal: the mock's
    # own shell expands these, not this one.
    # shellcheck disable=SC2016
    printf '#!/bin/sh\nprintf "%%s %%s %%s snapdir=%%s|" "$0" "$1" "$(cat "$2/manifest.json")" "${SH_SNAPSHOT_DIR:-unset}" >>"%s"\nexit %s\n' \
      "$root/seed.log" "$worker_rc" >"$root/microvm-worker"
    chmod 0755 "$root/microvm-worker"
  fi
  if [ "$seed" = "pre" ]; then
    mkdir -p "$out"
    printf 'PREVIOUS-GOOD\n' >"$out/manifest.json"
  fi
  rc=0
  (
    # set -e is what the real script runs under, and it is what makes a failing
    # verify_restore abort main() instead of falling through to publish_snapshot.
    set -euo pipefail
    OUT="$out"
    STAGE="$root/stage"
    mkdir -p "$STAGE"
    # What boot_quiesce_snapshot/write_manifest would have left in $STAGE for the real
    # lock_down to seal. manifest.json's contents are the marker the assertions read.
    for f in vmstate memfile kernel rootfs agent; do printf 'stub-%s\n' "$f" >"$STAGE/$f"; done
    printf 'FRESHLY-BUILT\n' >"$STAGE/manifest.json"
    VMM="firecracker"
    WORKER_BIN="$root/microvm-worker"
    export SH_SNAPSHOT_DIR="/must-not-reach-the-seed"
    PENDING=""
    CLEANUP_PID=""
    CLEANUP_JAIL=""
    CLEANUP_EXTRA_DIR=""
    CLEANUP_FS_PID=""
    CLEANUP_PENDING_DIR=""
    log() { :; }
    # rm_rf_jail's mount-table guard reads /proc/mounts, which does not exist on a
    # macOS dev machine; the property under test is what gets removed and when, not
    # that guard (which build-snapshot.test.sh covers elsewhere).
    rm_rf_jail() {
      # The real script runs as root, which ignores the 0555 lock_down applies. This
      # harness does not, so make the tree writable before removing it -- otherwise
      # the scenario's own cleanup, not the code under test, is what fails.
      chmod -R u+rwX "$@" 2>/dev/null || true
      rm -rf "$@"
    }
    jail_unmount_dev() { :; }
    require_root() { :; }
    preflight() { :; }
    build_agent() { :; }
    assemble_rootfs() { :; }
    boot_quiesce_snapshot() { :; }
    write_manifest() { :; }
    # Shadow only what a non-root runner cannot do. The real lock_down (sourced from
    # the snippet below) is what decides WHERE the snapshot is sealed, which is the
    # whole question here.
    install() { cp "${@:$#-1:1}" "${@:$#:1}"; }
    chown() { :; }
    verify_restore() { return "$verify_rc"; }
    : "$OUT" "$STAGE" "$PENDING" "$VMM" "$WORKER_BIN" "$CLEANUP_PID" "$CLEANUP_JAIL" \
      "$CLEANUP_EXTRA_DIR" "$CLEANUP_FS_PID" "$CLEANUP_PENDING_DIR"
    # shellcheck disable=SC1090
    . "$pub_snippet"
    trap cleanup_on_exit EXIT
    main
  ) >/dev/null 2>&1
  rc=$?
  # Deliberately NOT `( ... ) || rc=$?`: errexit is suppressed inside a compound command
  # that is the left operand of `||`, so the subshell's own `set -e` would not abort
  # main() on a failing verify_restore and both failure scenarios would report success --
  # observed while writing this test.
  if [ -f "$out/manifest.json" ]; then
    manifest="$(cat "$out/manifest.json")"
  else
    manifest="MISSING"
  fi
  leftovers="$(find "$root/snapshots" -maxdepth 1 -name '.build-snapshot-*' 2>/dev/null | wc -l | tr -d ' ')"
  seeded="NONE"
  if [ -f "$root/seed.log" ]; then
    seeded="$(sed -e "s#$root/microvm-worker#BIN#" -e "s#$out#OUT#" "$root/seed.log")"
  fi
  printf '%s|%s|%s|%s\n' "$rc" "$manifest" "$leftovers" "$seeded"
}

got="$(run_publish_scenario 0 pre)"
check "verify passes, previous snapshot present: main succeeds, \$OUT holds the NEW snapshot, nothing left behind, the verify cache is seeded from the published \$OUT with a cleared environment" \
  "$got" "0|FRESHLY-BUILT|0|BIN -verify-snapshot FRESHLY-BUILT snapdir=unset|"
got="$(run_publish_scenario 0 nopre)"
check "verify passes, no previous snapshot: main succeeds, \$OUT is created, nothing left behind, seeded" \
  "$got" "0|FRESHLY-BUILT|0|BIN -verify-snapshot FRESHLY-BUILT snapdir=unset|"
# The verify-cache seed is best-effort: a failing (e.g. older) or missing worker binary never fails a
# build that would otherwise succeed.
got="$(run_publish_scenario 0 pre 1)"
check "the seed fails (an older microvm-worker): the build still succeeds and \$OUT is published" \
  "$got" "0|FRESHLY-BUILT|0|BIN -verify-snapshot FRESHLY-BUILT snapdir=unset|"
got="$(run_publish_scenario 0 pre none)"
check "no microvm-worker binary: the build still succeeds, no seed" "$got" "0|FRESHLY-BUILT|0|NONE"
# The two that would have gone green on the pre-fix order, with $OUT holding a sealed,
# self-consistent snapshot that does not restore:
got="$(run_publish_scenario 1 pre)"
check "verify FAILS: main fails, the PREVIOUS good snapshot is untouched, the unverified one is removed, nothing seeded" \
  "$got" "1|PREVIOUS-GOOD|0|NONE"
got="$(run_publish_scenario 1 nopre)"
check "verify FAILS with no previous snapshot: main fails and \$OUT is never created" \
  "$got" "1|MISSING|0|NONE"
chmod -R u+rwX "$pub_tmproot" 2>/dev/null
rm -rf "$pub_tmproot"
trap - EXIT

echo "== the guest probe asks for every capability the container tier advertises"
# Parity is pinned against the container worker's OWN list, read from source, so a tool added
# there without being added here fails this test instead of drifting silently (#369 scope 2).
probe_line="$(grep -E 'for c in .*; do command -v' "$SCRIPT")"
# `"bash", "rg", ...` -> `bash rg ...`
container_caps="$(sed -nE 's/^var probed = \[\]string\{(.*)\}$/\1/p' \
  "$DIR/../../remote-worker/cmd/worker/main.go" | tr -d '"' | tr ',' ' ')"
check "container tier's probed list was found" "$([ -n "$container_caps" ] && echo yes || echo no)" "yes"
for cap in $container_caps; do
  check "guest probe includes '$cap'" \
    "$(printf '%s' "$probe_line" | grep -qE "(^| )$cap( |;)" && echo yes || echo no)" "yes"
done

echo "== #415: a snapshot is refused if the guest git has no identity"
# An agent's first `git commit` in a sandbox whose git has no user.name/user.email fails
# with exit 128 -- observed live on the VM demo's P4 tier, where every agent burned a tool
# call configuring one by hand. The sandbox image bakes a system /etc/gitconfig
# (remote-worker/Dockerfile, guarded by research_tooling_test.go) and the rootfs inherits
# it (build-rootfs.sh); check_git_identity is the gate that turns "image lost its gitconfig"
# into a build failure here instead of a demo failure later. These checks pin the gate's
# contract: it exists, both VMM arms call it before quiescing (a check that runs after
# quiesce would hang on a paused guest), and its git invocation actually fails on an
# unconfigured git rather than falling back to git's auto-guessed identity.
check "check_git_identity helper exists" \
  "$(grep -cE '^check_git_identity\(\) \{' "$SCRIPT")" "1"
check "check_git_identity is called by both VMM arms (after probe, before quiesce)" \
  "$(grep -cF 'check_git_identity "$vsock_uds"' "$SCRIPT")" "2"
# The call must sit between probe_capabilities and quiesce_guest in each arm's body. A
# count-based "2" alone would pass with both calls in one arm and none in the other.
gitid_order_ok=yes
for fn in boot_quiesce_snapshot_firecracker boot_quiesce_snapshot_cloud_hypervisor; do
  start=$(grep -n "^${fn}() {" "$SCRIPT" | head -n1 | cut -d: -f1)
  [ -n "$start" ] || { gitid_order_ok=no; continue; }
  end=$(awk -v s="$start" 'NR>s && /^}$/{print NR; exit}' "$SCRIPT")
  probe_ln=$(awk -v s="$start" -v e="$end" \
    'NR>=s && NR<=e && /probe_capabilities "\$vsock_uds"/{print NR; exit}' "$SCRIPT")
  id_ln=$(awk -v s="$start" -v e="$end" \
    'NR>=s && NR<=e && /check_git_identity "\$vsock_uds"/{print NR; exit}' "$SCRIPT")
  quiesce_ln=$(awk -v s="$start" -v e="$end" \
    'NR>=s && NR<=e && /quiesce_guest "\$vsock_uds"/{print NR; exit}' "$SCRIPT")
  [ -n "$probe_ln" ] && [ -n "$id_ln" ] && [ -n "$quiesce_ln" ] \
    && [ "$probe_ln" -lt "$id_ln" ] && [ "$id_ln" -lt "$quiesce_ln" ] || gitid_order_ok=no
done
check "in both arms, check_git_identity runs between probe and quiesce" "$gitid_order_ok" "yes"
# useConfigOnly is what makes an unconfigured git fail this check instead of silently
# passing with an auto-guessed identity -- without it the gate checks nothing.
check "the identity check pins user.useConfigOnly (fails closed on an unconfigured git)" \
  "$([ "$(grep -c 'user.useConfigOnly=true' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "the identity check runs a real empty commit, not just a config lookup" \
  "$([ "$(grep -c 'commit --allow-empty' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
# The throwaway repo MUST be removed inside the same guest command that created it:
# check_git_identity runs before quiesce_guest, and the snapshot captures guest RAM --
# /tmp's tmpfs included -- so a repo left behind ships in every sandbox restored from the
# artifact. And the cleanup must not swallow the commit's exit code: `rc=$?; ...; exit $rc`
# carries it across the rm, so a failed identity check still fails the build.
gitid_body="$(awk '/^check_git_identity\(\) \{/{f=1} f{print} f && /^}$/{exit}' "$SCRIPT")"
check "the identity check removes its throwaway repo inside the guest command" \
  "$(printf '%s' "$gitid_body" | grep -cF 'rm -rf /tmp/id-check')" "1"
check "the guest command carries the commit's exit code across the cleanup" \
  "$(printf '%s' "$gitid_body" | grep -cF 'rc=$?; cd / && rm -rf /tmp/id-check; exit $rc')" "1"
check "host-side guest_client stderr is captured, not discarded" \
  "$(printf '%s' "$gitid_body" | grep -cF '2>/dev/null')" "0"
check "the identity check names #415 for the reader who hits the failure" \
  "$([ "$(printf '%s' "$gitid_body" | grep -c '#415')" -ge 1 ] && echo yes || echo no)" "yes"
# A guest with no git passes (no commit to fail): the guest command tests for git first and
# prints no-git, and the host takes exactly that as a pass; anything else still goes through the
# real commit.
check "the identity check passes a guest with no git" \
  "$(printf '%s' "$gitid_body" | grep -cF 'command -v git >/dev/null 2>&1 || { echo no-git; exit 0; }')" "1"
check "only the exact no-git answer, with exit 0, skips the commit" \
  "$(printf '%s' "$gitid_body" | grep -cF '[ "$rc" -eq 0 ] && [ "$(printf '"'"'%s'"'"' "$out" | tr -d '"'"'[:space:]'"'"')" = "no-git" ]')" "1"

echo "== egress (P4.1): proxy env + inert placeholder baked into init, build-time listener probe, no NIC"
# The parked bash inherits the agent's env, which is init's env, so every Exec sees these.
# Each must be exported INSIDE the init heredoc and BEFORE the agent exec.
for v in 'HTTPS_PROXY=http://127.0.0.1:3128' 'https_proxy=http://127.0.0.1:3128' \
  'HTTP_PROXY=http://127.0.0.1:3128' 'http_proxy=http://127.0.0.1:3128' \
  'NO_PROXY=localhost,127.0.0.1,::1' 'no_proxy=localhost,127.0.0.1,::1' 'GH_TOKEN=moca-placeholder' 'GITHUB_TOKEN=moca-placeholder'; do
  ln=""
  if [ -n "$init_start" ] && [ -n "$init_end" ]; then
    ln=$(awk -v s="$init_start" -v e="$init_end" -v want="export $v" \
      'NR>=s && NR<=e && $0==want{print NR; exit}' "$SCRIPT")
  fi
  ok=no
  if [ -n "$ln" ] && [ -n "$exec_line" ] && [ "$ln" -lt "$exec_line" ]; then ok=yes; fi
  check "init exports $v before the agent exec" "$ok" "yes"
done
exec_text=""
[ -n "$exec_line" ] && exec_text=$(sed -n "${exec_line}p" "$SCRIPT")
check "the agent exec carries --egress-listen 127.0.0.1:3128" \
  "$(printf '%s' "$exec_text" | grep -cF -- '--egress-listen 127.0.0.1:3128')" "1"
check "the agent exec carries --egress-vsock-port 1025" \
  "$(printf '%s' "$exec_text" | grep -cF -- '--egress-vsock-port 1025')" "1"
init_body=""
[ -n "$init_start" ] && [ -n "$init_end" ] && init_body=$(sed -n "${init_start},${init_end}p" "$SCRIPT")
check "the init heredoc holds the placeholder" \
  "$([ "$(printf '%s' "$init_body" | grep -cF moca-placeholder)" -ge 1 ] && echo yes || echo no)" "yes"
check "the init heredoc matches no credential pattern" \
  "$(printf '%s' "$init_body" | grep -cE 'AKIA|ghp_|-----BEGIN')" "0"
check "assemble_rootfs appends a credential helper to the STAGED /etc/gitconfig" \
  "$([ "$(fn_body assemble_rootfs | grep -cF '>>"$STAGE/rootfs-tree/etc/gitconfig"')" -ge 1 ] && echo yes || echo no)" "yes"
check "the credential helper prints the placeholder password" \
  "$([ "$(fn_body assemble_rootfs | grep -cF 'password=moca-placeholder')" -ge 1 ] && echo yes || echo no)" "yes"
check "check_egress_listener dials the guest listener over /dev/tcp" \
  "$([ "$(fn_body check_egress_listener | grep -cF '/dev/tcp/127.0.0.1/3128')" -ge 1 ] && echo yes || echo no)" "yes"
check "check_egress_listener fails the build unless the output is 'listening'" \
  "$([ "$(fn_body check_egress_listener | grep -cF 'exit 1')" -ge 1 ] && echo yes || echo no)" "yes"
check "check_egress_listener is called as often as check_git_identity" \
  "$(grep -c '^  check_egress_listener "' "$SCRIPT")" "$(grep -c '^  check_git_identity "' "$SCRIPT")"
check "at least one VMM arm calls check_egress_listener" \
  "$([ "$(grep -c '^  check_egress_listener "' "$SCRIPT")" -ge 2 ] && echo yes || echo no)" "yes"

echo "== the guest has /dev/fd and /dev/std* (bash process substitution), checked at build time"
init_text="$(sed -n "/^  cat >\"\$STAGE\/rootfs-tree\/sbin\/init\" <<'INIT'\$/,/^INIT\$/p" "$SCRIPT")"
for l in '/proc/self/fd /dev/fd' '/proc/self/fd/0 /dev/stdin' '/proc/self/fd/1 /dev/stdout' '/proc/self/fd/2 /dev/stderr'; do
  check "init links ${l#* } -> ${l%% *}, never fatally" \
    "$(printf '%s\n' "$init_text" | grep -cF "ln -s $l || true")" "1"
done
check "the links come after /proc is mounted" \
  "$(printf '%s\n' "$init_text" | awk '/^mount -t proc/{p=NR} /ln -s \/proc\/self\/fd \/dev\/fd/{l=NR} END{print (p && l > p) ? "yes" : "no"}')" "yes"
check "check_dev_fd runs <(...) and reads /dev/stdin in the guest" \
  "$([ "$(fn_body check_dev_fd | grep -cF 'cat <(echo fd-ok) && echo stdin-ok | cat /dev/stdin')" -ge 1 ] && echo yes || echo no)" "yes"
check "check_dev_fd fails the build" \
  "$([ "$(fn_body check_dev_fd | grep -cF 'exit 1')" -ge 1 ] && echo yes || echo no)" "yes"
check "check_dev_fd is called as often as check_git_identity" \
  "$(grep -c '^  check_dev_fd "' "$SCRIPT")" "$(grep -c '^  check_git_identity "' "$SCRIPT")"

echo "== the guest's /var keeps the image's files and is writable (overlay, then copy, then tmpfs)"
check "init mounts an overlay on /var with the image's /var as its lower dir" \
  "$(printf '%s\n' "$init_text" | grep -cF 'mount -t overlay overlay -o lowerdir=/var,upperdir=/.moca-var/upper,workdir=/.moca-var/work /var')" "1"
check "its upper and work dirs are on a tmpfs outside /var" \
  "$(printf '%s\n' "$init_text" | grep -cF 'mount -t tmpfs -o mode=0700 tmpfs /.moca-var')" "1"
check "without overlayfs it copies the image's /var and binds it" \
  "$(printf '%s\n' "$init_text" | grep -cF 'cp -a /var/. /.moca-var/copy/ && mount --bind /.moca-var/copy /var')" "1"
check "the last resort is the old empty tmpfs" \
  "$(printf '%s\n' "$init_text" | grep -cxF '  mount -t tmpfs tmpfs /var')" "1"
check "no unconditional tmpfs over /var is left" \
  "$(printf '%s\n' "$init_text" | grep -cxF 'mount -t tmpfs tmpfs /var')" "0"
check "the build makes the /.moca-var mount point and refuses one outside the tree" \
  "$(sed -n '/^assemble_rootfs() {/,/^}/p' "$SCRIPT" | grep -cxF '  for d in usr/local/bin sbin tmp var workspace .moca-var; do')" "1"
check "check_var reads the probe file and writes /var, removing what it wrote" \
  "$([ "$(fn_body check_var | grep -cF 'echo x >/var/.moca-var-check && rm -f /var/.moca-var-check')" -ge 1 ] && echo yes || echo no)" "yes"
check "check_var fails the build" "$([ "$(fn_body check_var | grep -cF 'exit 1')" -ge 1 ] && echo yes || echo no)" "yes"
check "check_var is called as often as check_git_identity" \
  "$(grep -c '^  check_var "' "$SCRIPT")" "$(grep -c '^  check_git_identity "' "$SCRIPT")"
TMPDIR_PICK="$(mktemp)"
# The probe pick, on a scratch tree: a plain-named regular file, smallest path; none for an empty /var.
printf '%s\n' 'STAGE="$1"' "$(sed -n '/^  VAR_PROBE="\$(cd/,/head -1 || true)"$/p' "$SCRIPT")" 'printf "%s" "$VAR_PROBE"' >"$TMPDIR_PICK"
w="$(mktemp -d)"; mkdir -p "$w/rootfs-tree/var/lib/texmf" "$w/rootfs-tree/var/cache"
: >"$w/rootfs-tree/var/lib/texmf/pdflatex.fmt"; : >"$w/rootfs-tree/var/cache/a b"
check "VAR_PROBE picks a plain-named file" "$(bash "$TMPDIR_PICK" "$w")" "lib/texmf/pdflatex.fmt"
rm -rf "$w/rootfs-tree/var"/*
check "VAR_PROBE is empty for an empty /var" "$(bash "$TMPDIR_PICK" "$w")" ""
rm -rf "$w" "$TMPDIR_PICK"
# T7 regression fence: a NIC arriving quietly would void the no-network property.
check "no network-interfaces config anywhere in the build" \
  "$(grep -c 'network-interfaces' "$SCRIPT")" "0"

echo "== SBX0.2b: --egress-ca bakes the host's interception CA (public cert only) into the rootfs"
EGT="$(mktemp -d "${TMPDIR:-/tmp}/bs-egress-test.XXXXXX")"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=moca test ca" \
  -keyout "$EGT/ca.key" -out "$EGT/ca.crt" >/dev/null 2>&1
cat "$EGT/ca.key" "$EGT/ca.crt" >"$EGT/both.pem"
want_sha="sha256:$(openssl x509 -in "$EGT/ca.crt" -outform DER | sha256sum | cut -d' ' -f1)"

# Run the script's own functions (extracted, comments stripped) against a fake staged tree.
# chroot is stubbed to run the tool inside the tree path without needing root.
eg_harness() { # $1 = tree kind (debian|rhel|none), $2 = work dir
  local kind="$1" w="$2"
  mkdir -p "$w/stage/rootfs-tree/sbin" "$w/stage/rootfs-tree/usr/sbin" "$w/stage/rootfs-tree/usr/bin"
  cat >"$w/stage/rootfs-tree/sbin/init" <<'EOI'
#!/bin/sh
export GH_TOKEN=moca-placeholder
export GITHUB_TOKEN=moca-placeholder

exec /usr/local/bin/agent
EOI
  chmod 0555 "$w/stage/rootfs-tree/sbin/init"
  local tool=""
  [ "$kind" = debian ] && tool="$w/stage/rootfs-tree/usr/sbin/update-ca-certificates"
  [ "$kind" = rhel ] && tool="$w/stage/rootfs-tree/usr/bin/update-ca-trust"
  if [ -n "$tool" ]; then
    printf '#!/bin/sh\necho "$0 $*" >> "%s/calls"\n' "$w" >"$tool"
    chmod 0755 "$tool"
  fi
  {
    echo 'log() { echo "$*" >&2; }'
    echo 'chroot() { local t="$1"; shift; local c="$1"; shift; "$t$c" "$@"; }'
    echo "STAGE='$w/stage'"
    echo "EGRESS_CA='$EGT/ca.crt'"
    fn_body validate_egress_ca
    fn_body tree_dir_target
    fn_body tree_write_target
    fn_body install_egress_ca
    echo 'install_egress_ca'
  } >"$w/run.sh"
  bash "$w/run.sh" >"$w/out" 2>&1
  echo $?
}

w="$EGT/deb"; mkdir -p "$w"
check "debian tree: install_egress_ca succeeds" "$(eg_harness debian "$w")" "0"
check "debian: CA lands in usr/local/share/ca-certificates" \
  "$(cmp -s "$EGT/ca.crt" "$w/stage/rootfs-tree/usr/local/share/ca-certificates/moca-egress.crt" && echo yes || echo no)" "yes"
check "debian: update-ca-certificates ran once" "$(grep -c update-ca-certificates "$w/calls")" "1"
init="$w/stage/rootfs-tree/sbin/init"
check "debian: init exports NODE_EXTRA_CA_CERTS" \
  "$(grep -cFx 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/moca-egress.crt' "$init")" "1"
check "debian: init exports SSL_CERT_FILE" \
  "$(grep -cFx 'export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt' "$init")" "1"
check "debian: init exports REQUESTS_CA_BUNDLE" \
  "$(grep -cFx 'export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt' "$init")" "1"
check "debian: the exports sit after GITHUB_TOKEN and before the exec" \
  "$(awk '/GITHUB_TOKEN=/{g=NR} /NODE_EXTRA_CA_CERTS/{n=NR} /^exec /{e=NR} END{print (g<n && n<e) ? "yes":"no"}' "$init")" "yes"
check "debian: init stays 0555" "$(stat -c %a "$init" 2>/dev/null || stat -f %Lp "$init")" "555"

w="$EGT/rhel"; mkdir -p "$w"
check "rhel tree: install_egress_ca succeeds" "$(eg_harness rhel "$w")" "0"
check "rhel: CA lands in etc/pki/ca-trust/source/anchors" \
  "$(cmp -s "$EGT/ca.crt" "$w/stage/rootfs-tree/etc/pki/ca-trust/source/anchors/moca-egress.crt" && echo yes || echo no)" "yes"
check "rhel: update-ca-trust extract ran" "$(grep -c 'update-ca-trust extract' "$w/calls")" "1"
init="$w/stage/rootfs-tree/sbin/init"
check "rhel: NODE_EXTRA_CA_CERTS names the anchor" \
  "$(grep -cFx 'export NODE_EXTRA_CA_CERTS=/etc/pki/ca-trust/source/anchors/moca-egress.crt' "$init")" "1"
check "rhel: SSL_CERT_FILE is the RHEL bundle" \
  "$(grep -cFx 'export SSL_CERT_FILE=/etc/pki/tls/certs/ca-bundle.crt' "$init")" "1"
check "rhel: REQUESTS_CA_BUNDLE is the RHEL bundle" \
  "$(grep -cFx 'export REQUESTS_CA_BUNDLE=/etc/pki/tls/certs/ca-bundle.crt' "$init")" "1"

w="$EGT/none"; mkdir -p "$w"
check "tree with neither tool: install_egress_ca fails" "$([ "$(eg_harness none "$w")" != 0 ] && echo yes || echo no)" "yes"
check "neither tool: the message is the documented one" \
  "$(grep -cF -- '--egress-ca: the rootfs has neither update-ca-certificates nor update-ca-trust' "$w/out")" "1"

# The CA directory, or a directory above it, as an absolute symlink out of the tree: the build
# refuses, and the directory outside gains nothing.
for kind in debian rhel; do
  w="$EGT/link-$kind"; mkdir -p "$w/outside"
  if [ "$kind" = debian ]; then link=usr/local/share; else link=etc/pki/ca-trust/source/anchors; fi
  mkdir -p "$w/stage/rootfs-tree/$(dirname "$link")"
  ln -s "$w/outside" "$w/stage/rootfs-tree/$link"
  check "$kind: a CA directory linked out of the tree is refused" "$([ "$(eg_harness "$kind" "$w")" != 0 ] && echo yes || echo no)" "yes"
  check "$kind: the refusal says so" "$(grep -c 'resolves outside the tree' "$w/out")" "1"
  check "$kind: nothing is written outside the tree" "$(find "$w/outside" -mindepth 1 | wc -l | tr -d ' ')" "0"
done
w="$EGT/link-file"; mkdir -p "$w/stage/rootfs-tree/usr/local/share/ca-certificates"
printf 'OUTSIDE\n' >"$w/outside.crt"
ln -s "$w/outside.crt" "$w/stage/rootfs-tree/usr/local/share/ca-certificates/moca-egress.crt"
check "debian: a CA file that is a symlink is refused" "$([ "$(eg_harness debian "$w")" != 0 ] && echo yes || echo no)" "yes"
check "debian: the file outside is untouched" "$(cat "$w/outside.crt")" "OUTSIDE"

echo "== SBX0.2b: the CA file is validated before anything is staged"
mkdir -p "$EGT/tmp1"
out=$(TMPDIR="$EGT/tmp1" bash "$SCRIPT" --kernel /k --rootfs /r --agent /a --image t --egress-ca "$EGT/ca.key" 2>&1); rc=$?
check "a private key as --egress-ca is refused" "$([ "$rc" != 0 ] && echo yes || echo no)" "yes"
check "the refusal names the private key" "$(printf '%s' "$out" | grep -c 'PRIVATE KEY')" "1"
check "nothing was staged for the key" "$(find "$EGT/tmp1" -mindepth 1 | wc -l | tr -d ' ')" "0"
out=$(TMPDIR="$EGT/tmp1" bash "$SCRIPT" --kernel /k --rootfs /r --agent /a --image t --egress-ca "$EGT/both.pem" 2>&1); rc=$?
check "a cert+key bundle is refused" "$(printf '%s' "$out" | grep -c 'PRIVATE KEY')" "1"
echo "not a cert" >"$EGT/junk.pem"
out=$(TMPDIR="$EGT/tmp1" bash "$SCRIPT" --kernel /k --rootfs /r --agent /a --image t --egress-ca "$EGT/junk.pem" 2>&1); rc=$?
check "an unparseable file is refused" "$([ "$rc" != 0 ] && echo yes || echo no)" "yes"
check "nothing was staged for the junk" "$(find "$EGT/tmp1" -mindepth 1 | wc -l | tr -d ' ')" "0"
out=$(TMPDIR="$EGT/tmp1" bash "$SCRIPT" --kernel /k --rootfs /r --agent /a --image t --egress-ca "$EGT/ca.crt" 2>&1)
case "$out" in *"must run as root"* | *"/dev/kvm is not present"*) ok=yes ;; *) ok=no ;; esac
check "a good cert passes arg validation" "$ok" "yes"

echo "== SBX0.2b: more than one certificate is refused before staging"
cat "$EGT/ca.crt" "$EGT/ca.crt" >"$EGT/two.pem"
mkdir -p "$EGT/tmp2"
out=$(TMPDIR="$EGT/tmp2" bash "$SCRIPT" --kernel /k --rootfs /r --agent /a --image t --egress-ca "$EGT/two.pem" 2>&1); rc=$?
check "a two-certificate file is refused" "$([ "$rc" != 0 ] && echo yes || echo no)" "yes"
check "the refusal says more than one certificate" "$(printf '%s' "$out" | grep -c 'more than one certificate')" "1"
check "nothing was staged for the bundle" "$(find "$EGT/tmp2" -mindepth 1 | wc -l | tr -d ' ')" "0"

echo "== SBX0.2b: the rewrite works on the REAL init heredoc, and anchor drift fails loudly"
for drift in real drifted; do
  w="$EGT/real-$drift"; mkdir -p "$w/stage/rootfs-tree/sbin" "$w/stage/rootfs-tree/usr/sbin"
  printf '#!/bin/sh\necho "$0" >> "%s/calls"\n' "$w" >"$w/stage/rootfs-tree/usr/sbin/update-ca-certificates"
  chmod 0755 "$w/stage/rootfs-tree/usr/sbin/update-ca-certificates"
  # The init heredoc body, verbatim from build-snapshot.sh.
  sed -n "/^  cat >\"\$STAGE\/rootfs-tree\/sbin\/init\" <<'INIT'\$/,/^INIT\$/p" "$SCRIPT" | sed '1d;$d' >"$w/stage/rootfs-tree/sbin/init"
  [ "$drift" = drifted ] && sed -i.bak 's/^export GITHUB_TOKEN=moca-placeholder$/export GITHUB_TOKEN=changed/' "$w/stage/rootfs-tree/sbin/init"
  {
    echo 'chroot() { local t="$1"; shift; local c="$1"; shift; "$t$c" "$@"; }'
    echo "STAGE='$w/stage'; EGRESS_CA='$EGT/ca.crt'"
    fn_body tree_dir_target
    fn_body tree_write_target
    fn_body install_egress_ca
    echo 'install_egress_ca'
  } >"$w/run.sh"
  bash "$w/run.sh" >"$w/out" 2>&1; rc=$?
  if [ "$drift" = real ]; then
    check "real init: rewrite succeeds" "$rc" "0"
    check "real init: all three exports present" \
      "$(grep -cE '^export (NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|REQUESTS_CA_BUNDLE)=' "$w/stage/rootfs-tree/sbin/init")" "3"
  else
    check "drifted anchor: install_egress_ca fails" "$([ "$rc" != 0 ] && echo yes || echo no)" "yes"
    check "drifted anchor: the message names the anchor" "$(grep -cF 'export GITHUB_TOKEN=moca-placeholder' "$w/out")" "1"
  fi
done

echo "== SBX0.2b: the manifest fingerprint is the DER sha256, inside hash (version 2)"
mw="$EGT/mf"; mkdir -p "$mw/stage"
for mode in with without chv; do
  : >"$mw/stage/kernel"; : >"$mw/stage/rootfs"; : >"$mw/stage/agent"; : >"$mw/stage/vmstate"; : >"$mw/stage/memfile"
  vmm=firecracker
  [ "$mode" = chv ] && vmm=cloud-hypervisor
  {
    echo 'log() { :; }'
    echo "STAGE='$mw/stage'; IMAGE=i; VMM=$vmm; INSTANCE_TYPE=t; GUEST_RAM_MB=256; VCPUS=1; MANIFEST_CAPABILITIES=''; MANIFEST_GUEST_KERNEL=6.1.155-guest"
    if [ "$mode" = with ]; then
      echo "EGRESS_CA='$EGT/ca.crt'"
      fn_body validate_egress_ca
      echo 'validate_egress_ca'
    else
      echo "EGRESS_CA=''"
    fi
    # fn_body stops at the first bare `}`, which is inside write_manifest's JSON heredoc.
    sed -n '/^write_manifest() {/,/^MANIFEST$/p' "$SCRIPT"
    echo '}'
    echo 'write_manifest'
  } >"$mw/run.sh"
  bash "$mw/run.sh" >/dev/null 2>&1
  cp "$mw/stage/manifest.json" "$mw/$mode.json"
done
check "manifest carries egress_ca_sha256 with the flag" \
  "$(grep -cF "\"egress_ca_sha256\": \"$want_sha\"" "$mw/with.json")" "1"
check "manifest has no egress_ca_sha256 without the flag" "$(grep -c egress_ca "$mw/without.json")" "0"
check "the hash changes with the field (version 2 covers it)" \
  "$([ "$(grep '"hash"' "$mw/with.json")" != "$(grep '"hash"' "$mw/without.json")" ] && echo yes || echo no)" "yes"
check "the without-flag manifest is valid JSON" \
  "$(python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$mw/without.json" && echo yes || echo no)" "yes"
check "the manifest's kernel_release is the probed guest kernel" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["kernel_release"])' "$mw/without.json")" "6.1.155-guest"
check "the Firecracker manifest's features are [lease-v1, lease-processes-v1, balloon-fpr-v1]" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["features"])' "$mw/without.json")" "['lease-v1', 'lease-processes-v1', 'balloon-fpr-v1']"
# CHV cannot serve a lease (chvWrapCommand mounts the workspace inside every Run), so it
# advertises neither lease-v1 nor lease-processes-v1.
check "the Cloud Hypervisor manifest's features are []" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["features"])' "$mw/chv.json")" "[]"
check "the with-flag manifest is valid JSON" \
  "$(python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$mw/with.json" && echo yes || echo no)" "yes"
check "assemble_rootfs calls install_egress_ca only when the flag is set" \
  "$(fn_body assemble_rootfs | grep -cF '[ -n "$EGRESS_CA" ] && install_egress_ca')" "1"
echo "== manifest hash version 2 matches vmpool.Manifest.ComputeHash"
mv2="$EGT/mv2"; mkdir -p "$mv2/stage"
for f in kernel rootfs agent vmstate memfile; do printf '%s-bytes' "$f" >"$mv2/stage/$f"; done
mkdir -p "$mv2/rootfs/etc"
printf 'image=i@sha256:%s\ndigest=sha256:%s\n' "$(printf 'a%.0s' {1..64})" "$(printf 'a%.0s' {1..64})" >"$mv2/rootfs/etc/moca-rootfs-source"
{
  echo 'log() { :; }'
  echo "STAGE='$mv2/stage'; ROOTFS='$mv2/rootfs'; IMAGE=i; VMM=firecracker; INSTANCE_TYPE=t; GUEST_RAM_MB=256; VCPUS=1; EGRESS_CA=''; MANIFEST_GUEST_KERNEL=6.1.155-guest"
  printf '%s\n' "MANIFEST_CAPABILITIES='git"$'\n'"bash'"
  sed -n '/^write_manifest() {/,/^MANIFEST$/p' "$SCRIPT"
  echo '}'
  echo 'write_manifest'
} >"$mv2/run.sh"
bash "$mv2/run.sh" >/dev/null 2>&1
check "the version-2 manifest is valid JSON with hash_version 2" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["hash_version"])' "$mv2/stage/manifest.json" 2>/dev/null)" "2"
# Recompute the hash from the manifest's own fields, in the line format the Go side pins
# (TestManifestV2HashMatchesBuildSnapshot): a drift on either side fails one of the two.
check "the manifest records the rootfs's source image digest" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("source_image_digest",""))' "$mv2/stage/manifest.json")" "sha256:$(printf 'a%.0s' {1..64})"
check "the hash is the version-2 lines' sha256, computed from the manifest's fields" \
  "$(python3 - "$mv2/stage/manifest.json" <<'PY'
import hashlib, json, sys
m = json.load(open(sys.argv[1]))
lines = ["moca-snapshot-manifest/2"] + [f"{k}:{v}" for k, v in [
    ("image", m["image"]), ("vmm", m["vmm"]), ("instance_type", m["instance_type"]),
    ("kernel_release", m["kernel_release"]), ("guest_ram_mb", m["guest_ram_mb"]), ("vcpus", m["vcpus"]),
    ("capabilities", ",".join(sorted(m["capabilities"]))), ("built_at", m["built_at"]),
    ("kernel", m["kernel_sha256"]), ("rootfs", m["rootfs_sha256"]), ("agent", m["agent_sha256"]),
    ("vmstate", m["vmstate_sha256"]), ("memfile", m["memfile_sha256"]),
    ("ch_config", m.get("ch_config_sha256", "")), ("egress_ca", m.get("egress_ca_sha256", "")),
    ("source_image_digest", m.get("source_image_digest", ""))]]
print("ok" if m["hash"] == "sha256:" + hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest() else "mismatch")
PY
)" "ok"
# The capabilities are sorted by byte, as Go's sort.Strings is, whatever the build host's locale:
# en_US collates "a" before "B", byte order puts "B" first. (A host without that locale sorts by byte
# anyway, and the check still holds.)
{
  echo 'log() { :; }'
  echo "STAGE='$mv2/stage'; ROOTFS='$mv2/rootfs'; IMAGE=i; VMM=firecracker; INSTANCE_TYPE=t; GUEST_RAM_MB=256; VCPUS=1; EGRESS_CA=''; MANIFEST_GUEST_KERNEL=6.1.155-guest"
  printf '%s\n' "MANIFEST_CAPABILITIES='a"$'\n'"B'"
  sed -n '/^write_manifest() {/,/^MANIFEST$/p' "$SCRIPT"
  echo '}'
  echo 'write_manifest'
} >"$mv2/run-locale.sh"
LC_ALL=en_US.UTF-8 bash "$mv2/run-locale.sh" >/dev/null 2>&1
check "the manifest's capabilities are in byte order under an en_US locale" \
  "$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["capabilities"]))' "$mv2/stage/manifest.json" 2>/dev/null)" "B,a"
check "the Go golden lines hash to the digest snapshot_test.go pins" \
  "$(printf 'moca-snapshot-manifest/2\nimage:i\nvmm:firecracker\ninstance_type:t\nkernel_release:k\nguest_ram_mb:256\nvcpus:1\ncapabilities:bash,git\nbuilt_at:2026-11-03T00:00:00Z\nkernel:sha256:k\nrootfs:sha256:r\nagent:sha256:a\nvmstate:sha256:v\nmemfile:sha256:m\nch_config:\negress_ca:\nsource_image_digest:sha256:s\n' | sha256sum | cut -d' ' -f1)" \
  "$(sed -n 's/^const manifestV2Golden = "\([0-9a-f]*\)"$/\1/p' "$(dirname "$SCRIPT")/../../remote-worker/internal/vmpool/snapshot_test.go")"
rm -rf "$EGT"

echo "== balloon-fpr-v1: the Firecracker golden snapshot carries a reporting-only balloon"
# Spec §6 "Free-page reporting" and §16 item 5: one golden snapshot, for every mode, with a
# virtio-balloon that only reports freed pages (nothing ever inflates it). The device must be
# configured pre-boot, so the PUT sits between /machine-config and InstanceStart; a restored
# VM gets it back from the snapshot, so verify_restore_firecracker never sends it.
#
# A recorder, not a grep: boot_quiesce_snapshot_firecracker's own api_put/api_patch
# statements (comments stripped, continuation lines joined) run against stubs that log
# each call's method, path and EXPANDED body, so the order and the exact JSON are what
# Firecracker would receive.
BT="$(mktemp -d "${TMPDIR:-/tmp}/bs-balloon-test.XXXXXX")"
# shellcheck disable=SC2016 # the stubs and the grep pattern are literal, not expanded here
{
  printf '%s\n' 'api_put() { printf "PUT %s %s\n" "$2" "$3" >>"$REC"; }' \
    'api_patch() { printf "PATCH %s %s\n" "$2" "$3" >>"$REC"; }' \
    "REC='$BT/calls'; api_sock=/run/api.sock; GUEST_RAM_MB=256"
  printf '%s\n' "$fc_build_body" | grep -v '^[[:space:]]*#' | sed -e ':a' -e '/\\$/{N;s/\\\n//;ba' -e '}' |
    grep -E '^[[:space:]]*api_(put|patch) "\$api_sock"'
} >"$BT/run.sh"
bash "$BT/run.sh" >"$BT/out" 2>&1
balloon_call='PUT /balloon {"amount_mib":0,"deflate_on_oom":false,"free_page_reporting":true}'
mc_n=$(grep -n '^PUT /machine-config ' "$BT/calls" 2>/dev/null | head -n1 | cut -d: -f1)
bl_n=$(grep -nxF "$balloon_call" "$BT/calls" 2>/dev/null | head -n1 | cut -d: -f1)
start_n=$(grep -nxF 'PUT /actions {"action_type":"InstanceStart"}' "$BT/calls" 2>/dev/null | head -n1 | cut -d: -f1)
check "the Firecracker build sends PUT /balloon exactly once, with the reporting-only body" \
  "$(grep -c '^PUT /balloon ' "$BT/calls" 2>/dev/null)|$(grep -cxF "$balloon_call" "$BT/calls" 2>/dev/null)" "1|1"
check "PUT /balloon comes right after /machine-config and right before InstanceStart" \
  "$([ -n "$mc_n" ] && [ -n "$bl_n" ] && [ -n "$start_n" ] &&
    [ "$bl_n" -eq $((mc_n + 1)) ] && [ "$start_n" -eq $((bl_n + 1)) ] && echo yes || echo no)" "yes"
check "the restore path never configures the balloon (it comes back from the snapshot)" \
  "$(fn_body verify_restore_firecracker | grep -c '/balloon')" "0"
check "the Cloud Hypervisor arm is unchanged (no balloon)" \
  "$(fn_body boot_quiesce_snapshot_cloud_hypervisor | grep -ci 'balloon')" "0"
rm -rf "$BT"

echo "== lease-v1 image"
# Lease mode (one VM, many Execs, each as uid 7000 in its own cgroup) needs cgroup2
# mounted, a user-namespace sysctl the agent can turn off, the sbx identity in the
# rootfs and no setuid binaries.
# The build proves each in the booted guest with ONE per-Exec request (never lease:
# true, whose latch the snapshot would bake into every restored VM).
in_init() { # $1 = fixed string; prints its first line number inside the init heredoc
  awk -v s="$init_start" -v e="$init_end" -v want="$1" \
    'NR>=s && NR<=e && index($0, want){print NR; exit}' "$SCRIPT"
}
sysfs_ln=$(in_init 'mount -t sysfs sysfs /sys')
cg_ln=$(in_init 'mount -t cgroup2 cgroup2 /sys/fs/cgroup')
check "init mounts cgroup2 after sysfs" \
  "$([ -n "$cg_ln" ] && [ -n "$sysfs_ln" ] && [ "$sysfs_ln" -lt "$cg_ln" ] && echo yes || echo no)" "yes"
check "init names the reason when the cgroup2 mount fails" \
  "$(sed -n "${cg_ln:-1}p" "$SCRIPT" | grep -cF '|| { echo "init: cgroup2 mount failed (guest kernel lacks cgroup v2?)" >&2; exit 1; }')" "1"
# User namespaces are lease-only: the agent disables them at the first lease request,
# so a per-Exec VM restored from the same snapshot keeps them.
check "init leaves user namespaces enabled (the agent disables them for a lease)" \
  "$(awk -v s="$init_start" -v e="$init_end" 'NR>=s && NR<=e' "$SCRIPT" | grep -c 'max_user_namespaces')" "0"
check "the agent exec carries --lease-cgroup-root /sys/fs/cgroup/moca-execs" \
  "$(printf '%s' "$exec_text" | grep -cF -- '--lease-cgroup-root /sys/fs/cgroup/moca-execs')" "1"
# Level 2 (tracked processes): the agent's tracked uid range must be the one the image's
# sbxp<n> passwd lines name.
check "the agent exec carries --lease-tracked-uid-base 20000 --lease-tracked-uids 4" \
  "$(printf '%s' "$exec_text" | grep -cF -- '--lease-tracked-uid-base 20000 --lease-tracked-uids 4')" "1"
tracked_pw="$(eval "$(fn_body sbx_tracked_passwd)"; sbx_tracked_passwd 2>/dev/null)"
check "sbx_tracked_passwd prints the four tracked identities, HOME /tmp/sbx-proc/<uid>" "$tracked_pw" \
  "sbxp0:x:20000:7000::/tmp/sbx-proc/20000:/bin/bash
sbxp1:x:20001:7000::/tmp/sbx-proc/20001:/bin/bash
sbxp2:x:20002:7000::/tmp/sbx-proc/20002:/bin/bash
sbxp3:x:20003:7000::/tmp/sbx-proc/20003:/bin/bash"
check "the agent's tracked uid base and count match the passwd lines" \
  "$(printf '%s\n' "$tracked_pw" | awk -F: 'NR==1{b=$3} END{print "--lease-tracked-uid-base " b " --lease-tracked-uids " NR}')" \
  "--lease-tracked-uid-base 20000 --lease-tracked-uids 4"
check "assemble_rootfs adds the sbx identity" \
  "$(fn_body assemble_rootfs | grep -c '^  add_sbx_identity$')" "1"
check "the passwd entry is sbx:x:7000:7000::/tmp/sbx-home:/bin/bash" \
  "$(fn_body add_sbx_identity | grep -cF 'sbx:x:7000:7000::/tmp/sbx-home:/bin/bash')" "1"
check "the group entry is sbx-ws:x:7000:" \
  "$(fn_body add_sbx_identity | grep -cF 'sbx-ws:x:7000:')" "1"
check "nothing runs useradd/groupadd (comments aside)" \
  "$(grep -vE '^\s*#' "$SCRIPT" | grep -cE 'useradd|groupadd')" "0"
check "assemble_rootfs strips setuid and setgid bits" \
  "$(fn_body assemble_rootfs | grep -cF 'find "$STAGE/rootfs-tree" -xdev -type f -perm /6000 -exec chmod ug-s {} +')" "1"
# Last: after install_egress_ca (chroot hooks) and the gitconfig append, before mkfs.
check "the setuid strip is the last tree change, just before mkfs" \
  "$(fn_body assemble_rootfs | awk '/install_egress_ca/{c=NR} /etc\/gitconfig/{g=NR} /-perm \/6000/{f=NR} /mkfs.ext4/{m=NR} END{print (c<f && g<f && f<m) ? "yes":"no"}')" "yes"
for fn in probe_guest_kernel check_lease_support; do
  check "both boot paths call $fn" "$(grep -cF -- "$fn \"\$vsock_uds\"" "$SCRIPT")" "2"
done
check "the guest kernel is probed into MANIFEST_GUEST_KERNEL on both boot paths" \
  "$(grep -cF 'MANIFEST_GUEST_KERNEL="$(probe_guest_kernel "$vsock_uds")"' "$SCRIPT")" "2"
check "check_lease_support never sends a lease request" \
  "$(fn_body check_lease_support | grep -ciE 'lease"?: *true|-lease')" "0"
check "write_manifest records the guest kernel" \
  "$(grep -cF '"kernel_release": "$MANIFEST_GUEST_KERNEL"' "$SCRIPT")" "1"
check "write_manifest no longer records the build host's kernel" \
  "$(grep -cF '"kernel_release": "$(uname -r)"' "$SCRIPT")" "0"
check "write_manifest advertises lease-v1 on the Firecracker arm only" \
  "$(fn_body write_manifest | grep -cF 'if [ "$VMM" = firecracker ]; then')" "1"

# add_sbx_identity, run for real against fake trees.
LT="$(mktemp -d "${TMPDIR:-/tmp}/bs-lease-test.XXXXXX")"
id_harness() { # $1 = work dir (its tree's etc/passwd and etc/group already there), $2 = VMM
  {
    echo "STAGE='$1/stage'; VMM='${2:-firecracker}'"
    fn_body tree_dir_target
    fn_body tree_write_target
    fn_body sbx_tracked_passwd
    fn_body add_sbx_identity
    echo 'add_sbx_identity'
  } >"$1/run.sh"
  bash "$1/run.sh" >"$1/out" 2>&1
  echo $?
}
id_tree() { # $1 = work dir, $2 = passwd body, $3 = group body
  mkdir -p "$1/stage/rootfs-tree/etc"
  printf '%s' "$2" >"$1/stage/rootfs-tree/etc/passwd"
  printf '%s' "$3" >"$1/stage/rootfs-tree/etc/group"
}
w="$LT/clean"; id_tree "$w" 'root:x:0:0:root:/root:/bin/bash' 'root:x:0:'
check "clean tree: add_sbx_identity succeeds" "$(id_harness "$w")" "0"
check "clean tree: passwd gains the sbx line (missing trailing newline guarded)" \
  "$(grep -cFx 'sbx:x:7000:7000::/tmp/sbx-home:/bin/bash' "$w/stage/rootfs-tree/etc/passwd")" "1"
check "clean tree: root's line is intact" \
  "$(grep -cFx 'root:x:0:0:root:/root:/bin/bash' "$w/stage/rootfs-tree/etc/passwd")" "1"
check "clean tree: group gains the sbx-ws line" \
  "$(grep -cFx 'sbx-ws:x:7000:' "$w/stage/rootfs-tree/etc/group")" "1"
check "rerun is idempotent (exit 0)" "$(id_harness "$w")" "0"
check "rerun is idempotent (one sbx line)" "$(grep -c '^sbx:' "$w/stage/rootfs-tree/etc/passwd")" "1"
check "rerun is idempotent (one sbx-ws line)" "$(grep -c '^sbx-ws:' "$w/stage/rootfs-tree/etc/group")" "1"
check "clean tree: passwd gains the four tracked lines" \
  "$(grep -E '^sbxp' "$w/stage/rootfs-tree/etc/passwd")" "$tracked_pw"
check "rerun is idempotent (four sbxp lines)" "$(grep -c '^sbxp' "$w/stage/rootfs-tree/etc/passwd")" "4"
w="$LT/tuid"; id_tree "$w" $'root:x:0:0:root:/root:/bin/bash\nbuilder:x:20002:100::/home/b:/bin/sh\n' $'root:x:0:\n'
check "tracked uid 20002 under another name: refused" "$([ "$(id_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
check "tracked uid 20002 under another name: the message names it" "$(grep -cF 'builder:x:20002:100' "$w/out")" "1"
check "tracked uid 20002 under another name: passwd untouched" \
  "$(grep -cE '^(sbx|sbxp[0-9]):' "$w/stage/rootfs-tree/etc/passwd")" "0"
w="$LT/tname"; id_tree "$w" $'root:x:0:0:root:/root:/bin/bash\nsbxp1:x:3000:3000::/home/p:/bin/sh\n' $'root:x:0:\n'
check "the name sbxp1 under another uid: refused" "$([ "$(id_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
check "the name sbxp1 under another uid: the message names it" "$(grep -cF 'sbxp1:x:3000:3000' "$w/out")" "1"
w="$LT/tnum"; id_tree "$w" $'root:x:0:0:root:/root:/bin/bash\nzero:x:020001:100::/home/z:/bin/sh\n' $'root:x:0:\n'
check "tracked uid written as 020001: refused (uids compare as numbers)" \
  "$([ "$(id_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
w="$LT/tnear"; id_tree "$w" $'root:x:0:0:root:/root:/bin/bash\nnear:x:20004:100::/home/n:/bin/sh\n' $'root:x:0:\n'
check "uid 20004, just past the range: accepted" "$(id_harness "$w")" "0"
w="$LT/tgid0"; id_tree "$w" $'root:x:0:0:root:/root:/bin/bash\n' $'root:x:0:\nstaff7:x:07000:\n'
check "gid 7000 written as 07000 under another name: refused (gids compare as numbers)" \
  "$([ "$(id_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
# Level 2 is Firecracker-only (ruling P5-R15): a Cloud Hypervisor build adds no tracked
# identity and refuses nothing over the tracked range, exactly as before.
w="$LT/chv-tuid"; id_tree "$w" $'root:x:0:0:root:/root:/bin/bash\nbuilder:x:20000:100::/home/b:/bin/sh\n' $'root:x:0:\n'
check "cloud-hypervisor: an image holding uid 20000 builds" "$(id_harness "$w" cloud-hypervisor)" "0"
check "cloud-hypervisor: no sbxp lines are added" "$(grep -c '^sbxp' "$w/stage/rootfs-tree/etc/passwd")" "0"
check "cloud-hypervisor: the sbx line is still added" \
  "$(grep -cFx 'sbx:x:7000:7000::/tmp/sbx-home:/bin/bash' "$w/stage/rootfs-tree/etc/passwd")" "1"
check "cloud-hypervisor: the image's uid-20000 account is untouched" \
  "$(grep -cFx 'builder:x:20000:100::/home/b:/bin/sh' "$w/stage/rootfs-tree/etc/passwd")" "1"
w="$LT/fc-tuid"; id_tree "$w" $'root:x:0:0:root:/root:/bin/bash\nbuilder:x:20000:100::/home/b:/bin/sh\n' $'root:x:0:\n'
check "firecracker: the same image is refused" "$([ "$(id_harness "$w" firecracker)" != 0 ] && echo yes || echo no)" "yes"
w="$LT/uid"; id_tree "$w" $'root:x:0:0:root:/root:/bin/bash\nother:x:7000:100::/home/o:/bin/sh\n' $'root:x:0:\n'
check "uid 7000 under another name: refused" "$([ "$(id_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
check "uid 7000 under another name: the message names it" "$(grep -cF 'other:x:7000:100' "$w/out")" "1"
w="$LT/gid"; id_tree "$w" $'root:x:0:0:root:/root:/bin/bash\n' $'root:x:0:\nstaff7:x:7000:\n'
check "gid 7000 under another name: refused" "$([ "$(id_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
check "gid 7000 under another name: the message names it" "$(grep -cF 'staff7:x:7000:' "$w/out")" "1"
check "gid 7000 under another name: passwd untouched" "$(grep -c '^sbx:' "$w/stage/rootfs-tree/etc/passwd")" "0"
w="$LT/name"; id_tree "$w" $'sbx:x:1234:1234::/home/sbx:/bin/sh\n' $'root:x:0:\n'
check "the name sbx under another uid: refused" "$([ "$(id_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
# The image's etc/passwd, etc/group or etc itself as an absolute symlink out of the tree: refused,
# and the file outside untouched.
for f in passwd group; do
  w="$LT/link-$f"; id_tree "$w" $'root:x:0:0:root:/root:/bin/bash\n' $'root:x:0:\n'
  printf 'OUTSIDE\n' >"$w/outside"
  rm -f "$w/stage/rootfs-tree/etc/$f"; ln -s "$w/outside" "$w/stage/rootfs-tree/etc/$f"
  check "etc/$f linked out of the tree: refused" "$([ "$(id_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
  check "etc/$f linked out of the tree: the refusal says so" "$(grep -c "/etc/$f is a symlink" "$w/out")" "1"
  check "etc/$f linked out of the tree: the file outside is untouched" "$(cat "$w/outside")" "OUTSIDE"
done
w="$LT/link-etc"; mkdir -p "$w/outside" "$w/stage/rootfs-tree"
printf 'OUTSIDE\n' >"$w/outside/passwd"
ln -s "$w/outside" "$w/stage/rootfs-tree/etc"
check "etc linked out of the tree: refused" "$([ "$(id_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
check "etc linked out of the tree: the refusal says so" "$(grep -c 'resolves outside the tree' "$w/out")" "1"
check "etc linked out of the tree: the file outside is untouched" "$(cat "$w/outside/passwd")" "OUTSIDE"
check "etc linked out of the tree: nothing new outside" "$(find "$w/outside" -mindepth 1 | wc -l | tr -d ' ')" "1"
# The etc/gitconfig append, run from assemble_rootfs's own lines.
gc_harness() { # $1 = work dir
  {
    echo "STAGE='$1/stage'"
    fn_body tree_dir_target
    fn_body tree_write_target
    sed -n '/^  tree_write_target etc\/gitconfig$/,/^GITCONFIG$/p' "$SCRIPT"
  } >"$1/run.sh"
  bash "$1/run.sh" >"$1/out" 2>&1
  echo $?
}
# shellcheck disable=SC2016 # the pattern is literal
check "assemble_rootfs checks etc/gitconfig right before appending to it" \
  "$(sed -n '/^  tree_write_target etc\/gitconfig$/{n;p;}' "$SCRIPT" | grep -cF 'cat >>"$STAGE/rootfs-tree/etc/gitconfig"')" "1"
w="$LT/gc-plain"; mkdir -p "$w/stage/rootfs-tree"
check "a plain tree: the gitconfig append succeeds" "$(gc_harness "$w")" "0"
check "a plain tree: the credential helper is there" "$(grep -c 'password=moca-placeholder' "$w/stage/rootfs-tree/etc/gitconfig")" "1"
w="$LT/gc-link"; mkdir -p "$w/stage/rootfs-tree/etc"; printf 'OUTSIDE\n' >"$w/outside"
ln -s "$w/outside" "$w/stage/rootfs-tree/etc/gitconfig"
check "etc/gitconfig linked out of the tree: refused" "$([ "$(gc_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
check "etc/gitconfig linked out of the tree: the file outside is untouched" "$(cat "$w/outside")" "OUTSIDE"

# check_lease_support, run against a stub guest_client printing each possible answer.
ls_harness() { # $1 = work dir, $2 = what the guest prints, $3 = VMM (default firecracker)
  mkdir -p "$1/stage"
  printf '#!/bin/sh\nprintf "%%s" "%s"\n' "$2" >"$1/stage/guest_client"
  chmod 0755 "$1/stage/guest_client"
  {
    echo "STAGE='$1/stage'; VMM='${3:-firecracker}'"
    fn_body sbx_tracked_passwd
    fn_body check_lease_support
    echo 'check_lease_support /uds'
  } >"$1/run.sh"
  bash "$1/run.sh" >"$1/out" 2>&1
  echo $?
}
sbx_pw='sbx:x:7000:7000::/tmp/sbx-home:/bin/bash'
# The guest prints, one line each: cgroup2, the userns sysctl, the sbx line, the cgroup.kill
# probe, the tracked-range passwd entries (space-joined), the gid-7000 groups (space-joined),
# then the first setuid file, if any.
tracked_line="$(printf '%s\n' "$tracked_pw" | tr '\n' ' ')"
grp_line='sbx-ws:x:7000: '
check "lease support: cg2, userns-ok, sbx, kill-ok, tracked, sbx-ws, empty passes" "$(ls_harness "$LT/ok" "cg2
userns-ok
$sbx_pw
kill-ok
$tracked_line
$grp_line
")" "0"
check "lease support: no cgroup2 fails" "$([ "$(ls_harness "$LT/nocg" "no-cg2
userns-ok
$sbx_pw
kill-ok
$tracked_line
$grp_line
")" != 0 ] && echo yes || echo no)" "yes"
check "lease support: no cgroup2 is named" "$(grep -c 'cgroup2' "$LT/nocg/out")" "1"
check "lease support: an unwritable userns sysctl fails" "$([ "$(ls_harness "$LT/userns" "cg2
no-userns
$sbx_pw
kill-ok
$tracked_line
$grp_line
")" != 0 ] && echo yes || echo no)" "yes"
check "lease support: an unwritable userns sysctl is named" "$(grep -c 'max_user_namespaces' "$LT/userns/out")" "1"
check "lease support: no sbx account fails" "$([ "$(ls_harness "$LT/nosbx" $'cg2\nuserns-ok\nno-sbx\n')" != 0 ] && echo yes || echo no)" "yes"
check "lease support: no sbx account is named" "$(grep -c "no '$sbx_pw' line" "$LT/nosbx/out")" "1"
check "lease support: a wrong sbx line fails" "$([ "$(ls_harness "$LT/badsbx" $'cg2\nuserns-ok\nsbx:x:1000:1000::/home/sbx:/bin/sh\n')" != 0 ] && echo yes || echo no)" "yes"
check "lease support: the guest command greps passwd for sbx (no getent)" \
  "$(fn_body check_lease_support | grep -cF 'grep "^sbx:" /etc/passwd')" "1"
check "lease support: the guest command checks the userns sysctl is writable" \
  "$(fn_body check_lease_support | grep -cF 'test -w /proc/sys/user/max_user_namespaces && echo userns-ok')" "1"
# cgroup.kill (process_stop, every lease teardown) is never in the cgroup2 root, only in a child:
# the probe makes one, looks, and removes it, so nothing reaches the snapshot.
for k in no-kill no-mkdir probe-left; do
  check "lease support: a cgroup.kill probe answering $k fails" "$([ "$(ls_harness "$LT/$k" "cg2
userns-ok
$sbx_pw
$k
$tracked_line
$grp_line
")" != 0 ] && echo yes || echo no)" "yes"
  check "lease support: a cgroup.kill probe answering $k is named" "$(grep -c "cgroup.kill.*got '$k'" "$LT/$k/out")" "1"
done
# shellcheck disable=SC2016 # the guest command is literal
check "lease support: the guest command probes cgroup.kill in a child cgroup it then removes" \
  "$(fn_body check_lease_support | grep -cF 'd=/sys/fs/cgroup/moca-kill-probe; if mkdir "$d" 2>/dev/null; then k=no-kill; test -e "$d/cgroup.kill" && k=kill-ok; rmdir "$d" 2>/dev/null || k=probe-left; echo "$k"; else echo no-mkdir; fi')" "1"
check "lease support: the guest command lists the tracked names and uids from sbx_tracked_passwd" \
  "$(fn_body check_lease_support | grep -cF 'sbx_tracked_passwd | cut -d: -f3')" "1"
check "lease support: a tracked uid held by another account fails" "$([ "$(ls_harness "$LT/tclash" "cg2
userns-ok
$sbx_pw
kill-ok
builder:x:20001:100::/home/b:/bin/sh $tracked_line
$grp_line
")" != 0 ] && echo yes || echo no)" "yes"
check "lease support: the tracked clash is named" "$(grep -c 'builder:x:20001:100' "$LT/tclash/out")" "1"
check "lease support: missing tracked lines fail" "$([ "$(ls_harness "$LT/tnone" "cg2
userns-ok
$sbx_pw
kill-ok

$grp_line
")" != 0 ] && echo yes || echo no)" "yes"
check "lease support: missing tracked lines are named" "$(grep -c 'lease-processes-v1: the guest /etc/passwd' "$LT/tnone/out")" "1"
check "lease support: another gid-7000 group fails" "$([ "$(ls_harness "$LT/gclash" "cg2
userns-ok
$sbx_pw
kill-ok
$tracked_line
staff7:x:7000: $grp_line
")" != 0 ] && echo yes || echo no)" "yes"
check "lease support: the group clash is named" "$(grep -c 'staff7:x:7000:' "$LT/gclash/out")" "1"
check "lease support: a setuid binary fails" "$([ "$(ls_harness "$LT/suid" "cg2
userns-ok
$sbx_pw
kill-ok
$tracked_line
$grp_line
/usr/bin/su
")" != 0 ] && echo yes || echo no)" "yes"
check "lease support: the setuid binary is named" "$(grep -c '/usr/bin/su' "$LT/suid/out")" "1"
# Cloud Hypervisor (ruling P5-R15): the four answers of before, no cgroup.kill or tracked probe.
check "lease support, cloud-hypervisor: cg2, userns-ok, sbx, empty passes (no cgroup.kill asked)" \
  "$(ls_harness "$LT/chv-ok" "cg2
userns-ok
$sbx_pw
" cloud-hypervisor)" "0"
check "lease support, cloud-hypervisor: a setuid binary on line 4 still fails" "$([ "$(ls_harness "$LT/chv-suid" "cg2
userns-ok
$sbx_pw
/usr/bin/su
" cloud-hypervisor)" != 0 ] && echo yes || echo no)" "yes"
check "lease support, cloud-hypervisor: the setuid binary is named" "$(grep -c '/usr/bin/su' "$LT/chv-suid/out")" "1"

# The REAL guest command, run by /bin/sh against a fake guest tree: the stub rewrites the
# guest's absolute paths into it, and emulates cgroupfs (a new child cgroup has cgroup.kill).
rc_harness() { # $1 = work dir (its root/etc/passwd and root/etc/group already there), $2 = VMM
  mkdir -p "$1/stage" "$1/cg"
  : >"$1/cg/cgroup.controllers"
  {
    echo '#!/usr/bin/env bash'
    echo "T='$1'"
    cat <<'STUB'
while [ $# -gt 0 ]; do [ "$1" = -command ] && c="$2"; shift; done
printf '%s\n' "$c" >"$T/cmd"
c="$(printf '%s' "$c" | sed -e "s|/etc/|$T/root/etc/|g" -e "s|/sys/fs/cgroup|$T/cg|g" \
  -e "s|find / |find $T/root |" -e 's|test -w /proc/sys/user/max_user_namespaces|true|' \
  -e 's|test -e "$d/cgroup.kill"|test -d "$d"|')"
exec /bin/sh -c "$c"
STUB
  } >"$1/stage/guest_client"
  chmod 0755 "$1/stage/guest_client"
  {
    echo "STAGE='$1/stage'; VMM='${2:-firecracker}'"
    fn_body sbx_tracked_passwd
    fn_body check_lease_support
    echo 'check_lease_support /uds'
  } >"$1/run.sh"
  bash "$1/run.sh" >"$1/out" 2>&1
  echo $?
}
rc_tree() { # $1 = work dir, $2 = extra passwd lines, $3 = the tracked lines, $4 = group body
  mkdir -p "$1/root/etc"
  printf 'root:x:0:0:root:/root:/bin/bash\n%s%s\n%s\n' "$2" "$sbx_pw" "$3" >"$1/root/etc/passwd"
  printf '%s' "$4" >"$1/root/etc/group"
}
w="$LT/rc-ok"; rc_tree "$w" '' "$tracked_pw" $'root:x:0:\nsbx-ws:x:7000:\n'
check "real guest command: a correct image passes" "$(rc_harness "$w")" "0"
check "real guest command: the probe cgroup is removed" "$(find "$w/cg" -mindepth 1 -type d | wc -l | tr -d ' ')" "0"
w="$LT/rc-rev"; rc_tree "$w" '' "$(printf '%s\n' "$tracked_pw" | tail -r 2>/dev/null || printf '%s\n' "$tracked_pw" | tac)" \
  $'root:x:0:\nsbx-ws:x:7000:\n'
check "real guest command: the fake tree holds the tracked lines out of order" \
  "$(grep '^sbxp' "$w/root/etc/passwd" | head -1 | cut -d: -f1)" "sbxp3"
check "real guest command: the exact tracked lines out of order pass" "$(rc_harness "$w")" "0"
w="$LT/rc-uid0"; rc_tree "$w" $'zero:x:020001:100::/home/z:/bin/sh\n' "$tracked_pw" $'root:x:0:\nsbx-ws:x:7000:\n'
check "real guest command: uid 020001 held by another account fails" "$([ "$(rc_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
check "real guest command: the uid 020001 account is named" "$(grep -c 'zero:x:020001' "$w/out")" "1"
w="$LT/rc-gid0"; rc_tree "$w" '' "$tracked_pw" $'root:x:0:\nsbx-ws:x:7000:\nstaff7:x:07000:\n'
check "real guest command: gid 07000 held by another group fails" "$([ "$(rc_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
check "real guest command: the gid 07000 group is named" "$(grep -c 'staff7:x:07000:' "$w/out")" "1"
check "real guest command, firecracker: the command probes cgroup.kill and the tracked range" \
  "$(grep -c 'moca-kill-probe' "$LT/rc-ok/cmd")$(grep -c 'sbxp' "$LT/rc-ok/cmd")" "11"
w="$LT/rc-chv"; rc_tree "$w" $'builder:x:20000:100::/home/b:/bin/sh\n' '' $'root:x:0:\nsbx-ws:x:7000:\n'
check "real guest command, cloud-hypervisor: no sbxp lines and uid 20000 taken still pass" \
  "$(rc_harness "$w" cloud-hypervisor)" "0"
check "real guest command, cloud-hypervisor: no cgroup.kill, tracked or group probe is sent" \
  "$(grep -cE 'moca-kill-probe|sbxp|/etc/group' "$w/cmd")" "0"
mkdir -p "$LT/fail/stage"; printf '#!/bin/sh\necho "guest_client: dial: refused" >&2\nexit 1\n' >"$LT/fail/stage/guest_client"
chmod 0755 "$LT/fail/stage/guest_client"
{ echo "STAGE='$LT/fail/stage'"; fn_body sbx_tracked_passwd; fn_body check_lease_support; echo 'check_lease_support /uds'; } >"$LT/fail/run.sh"
bash "$LT/fail/run.sh" >"$LT/fail/out" 2>&1; rc=$?
check "lease support: a transport failure fails" "$([ "$rc" != 0 ] && echo yes || echo no)" "yes"
check "lease support: a transport failure shows guest_client's diagnostics" "$(grep -c 'dial: refused' "$LT/fail/out")" "1"
rm -rf "$LT"
echo "== --skip-git-identity-check and --guest-home are opt-in and off by default"
# Images that refuse agent commits on purpose (benchmark testbeds: the patch must stay a diff
# against an untouched baseline) carry no git identity, and the guest's HOME is otherwise the
# kernel's HOME=/ on a read-only rootfs. Both flags exist for that; neither may change a default
# build.
usage_text="$(bash "$SCRIPT" --help 2>&1)"
check "usage names --skip-git-identity-check" \
  "$(printf '%s' "$usage_text" | grep -c -- '--skip-git-identity-check')" "2"
check "usage names --guest-home" \
  "$(printf '%s' "$usage_text" | grep -c -- '--guest-home')" "3"
check "the identity check is skipped only behind the flag" \
  "$(printf '%s' "$gitid_body" | grep -c 'if \[ "\$SKIP_GIT_IDENTITY_CHECK" = 1 \]; then')" "1"
check "the skip is logged, never silent" \
  "$(printf '%s' "$gitid_body" | grep -c 'log "skipping the git identity check')" "1"
check "by default the identity check is required" \
  "$(grep -c '^SKIP_GIT_IDENTITY_CHECK=0$' "$SCRIPT")" "1"
check "by default no HOME is set for the guest" "$(grep -c '^GUEST_HOME=""$' "$SCRIPT")" "1"
check "the HOME insertion is guarded by --guest-home" \
  "$(grep -c '^  elif \[ -n "\$GUEST_HOME" \]; then$' "$SCRIPT")" "1"
check "root's git config is copied only with --guest-home-gitconfig (off by default)" \
  "$(grep -c '^GUEST_HOME_GITCONFIG=0$' "$SCRIPT") $(grep -c '^  if \[ -n "\$GUEST_HOME" \] && \[ "\$GUEST_HOME_GITCONFIG" = 1 \]; then$' "$SCRIPT")" "1 1"
rc=0
out="$(bash "$SCRIPT" --kernel k --rootfs r --agent a --image i --guest-home /home/x 2>&1)" || rc=$?
check "a --guest-home outside /tmp is refused before any build step (exit 2)" "$rc" "2"
check "the refusal names the rule" \
  "$(printf '%s' "$out" | grep -c 'must be a path under /tmp')" "1"
# The insertion itself, with the same sed the script runs. GNU sed only: the script runs on the
# KVM host (Linux), and BSD sed's `a` syntax differs.
if sed --version >/dev/null 2>&1; then
  t="$(mktemp)"
  printf '#!/bin/sh\nmount -t tmpfs -o mode=1777 tmpfs /tmp\nexport PATH=/usr/bin:/bin\nexec agent\n' >"$t"
  GUEST_HOME=/tmp/home # read by the eval'd block below
  export GUEST_HOME
  STAGE="$(mktemp -d)"; mkdir -p "$STAGE/rootfs-tree/sbin"; cp "$t" "$STAGE/rootfs-tree/sbin/init"
  blk="$(sed -n '/^  if \[ -n "\$GUEST_HOME" \] && \[ "\$GUEST_HOME_GITCONFIG" = 1 \]; then/,/^  fi/p' "$SCRIPT")"
  init0="$(cat "$t")"
  # Default: no copy of root's git config (an image whose root identity must not reach the agent).
  GUEST_HOME_GITCONFIG=0 eval "$blk"
  cp "$STAGE/rootfs-tree/sbin/init" "$t"
  check "by default init gets only mkdir and export HOME right after PATH" \
    "$(sed -n '4,5p' "$t" | tr '\n' '|')" "mkdir -p /tmp/home|export HOME=/tmp/home|"
  check "by default root's git config is never copied" "$(grep -c '/root/.gitconfig' "$t")" "0"
  # --guest-home-gitconfig: the copy of root's git config, between mkdir and export HOME.
  printf '%s\n' "$init0" >"$STAGE/rootfs-tree/sbin/init"
  GUEST_HOME_GITCONFIG=1 eval "$blk"
  cp "$STAGE/rootfs-tree/sbin/init" "$t"; rm -rf "$STAGE"
  check "with --guest-home-gitconfig init also copies root's git config" \
    "$(sed -n '4,7p' "$t" | tr '\n' '|')" \
    "mkdir -p /tmp/home|[ ! -f /root/.gitconfig ] || cp /root/.gitconfig /tmp/home/.gitconfig || true|[ ! -d /root/.config/git ] || { mkdir -p /tmp/home/.config && cp -R /root/.config/git /tmp/home/.config/git; } || true|export HOME=/tmp/home|"
  check "the init stays valid sh" "$(sh -n "$t" && echo yes || echo no)" "yes"
  check "init still execs the agent last" "$(tail -1 "$t")" "exec agent"
  rm -f "$t"
else
  echo "  skip: the init insertion check needs GNU sed (runs on the KVM host)"
fi

echo "== --vcpus is opt-in, default 1, validated, and reaches both VMMs and the manifest"
usage_text="$(bash "$SCRIPT" --help 2>&1)"
check "usage names --vcpus" "$(printf '%s' "$usage_text" | grep -c -- '--vcpus')" "2"
check "by default the guest has 1 vCPU" "$(grep -c '^VCPUS=1$' "$SCRIPT")" "1"
check "firecracker's machine-config takes the count" "$(grep -c 'vcpu_count\\":\$VCPUS' "$SCRIPT")" "1"
check "no hardcoded vcpu_count is left" "$(grep -c 'vcpu_count\\":1' "$SCRIPT")" "0"
check "cloud-hypervisor's --cpus takes the count" "$(grep -c -- '--cpus "boot=\$VCPUS"' "$SCRIPT")" "1"
check "the manifest records it" "$(grep -c '"vcpus": \$VCPUS,' "$SCRIPT")" "1"
for bad in 0 33 two -1; do
  rc=0
  out="$(bash "$SCRIPT" --kernel k --rootfs r --agent a --image i --vcpus "$bad" 2>&1)" || rc=$?
  check "--vcpus $bad is refused before any build step (exit 2)" "$rc" "2"
done
check "the refusal names the rule" "$(printf '%s' "$out" | grep -c 'from 1 to 32')" "1"

echo "== the option checks match the whole value: an embedded newline is refused"
# grep matches line by line, so a check written as printf | grep -Eq passed a value whose first line
# was valid. Each of these values reaches init, a sed script, the VMM's config or the manifest.
nl=$'\n'
for case_ in "--guest-home|/tmp/home${nl}x" "--guest-home|/tmp/home${nl}touch /x" \
  "--vcpus|4${nl},\"x\":1" "--vcpus|4${nl}" "--verify-timeout-s|60${nl}x"; do
  opt="${case_%%|*}" val="${case_#*|}"
  rc=0
  bash "$SCRIPT" --kernel k --rootfs r --agent a --image i --verify-command true "$opt" "$val" >/dev/null 2>&1 || rc=$?
  check "$opt with an embedded newline is refused before any build step (exit 2)" "$rc" "2"
done
check "no option is checked with grep any more" \
  "$(sed -n '/^# The three option checks/,/^OUT=/p' "$SCRIPT" | grep -c 'grep -E')" "0"
# shellcheck disable=SC2016 # the patterns are literal
check "the HOME insertion is checked with or without --guest-home-gitconfig" \
  "$(grep -B1 'grep -qx "export HOME=$GUEST_HOME"' "$SCRIPT" | head -1 | grep -c '^  if \[ -n "\$GUEST_HOME" \]; then$')" "1"

echo "== assemble_rootfs never writes through the image's symlinks"
# An image's /sbin/init is commonly an ABSOLUTE symlink (/lib/systemd/systemd); writing through it
# hits the build host's file. The fix unlinks the targets first and refuses out-of-tree directories.
asm_body="$(sed -n '/^assemble_rootfs() {/,/^}/p' "$SCRIPT")"
check "init and agent are unlinked before they are written" \
  "$(printf '%s' "$asm_body" | grep -c 'rm -f "$STAGE/rootfs-tree/sbin/init" "$STAGE/rootfs-tree/usr/local/bin/agent"')" "1"
unlink_line=$(printf '%s\n' "$asm_body" | grep -n 'rm -f "$STAGE/rootfs-tree/sbin/init"' | cut -d: -f1)
write_line=$(printf '%s\n' "$asm_body" | grep -n 'cat >"$STAGE/rootfs-tree/sbin/init"' | cut -d: -f1)
check "the unlink comes before the write" "$([ "$unlink_line" -lt "$write_line" ] && echo yes || echo no)" "yes"
check "every directory assemble_rootfs makes is checked by tree_dir_target" \
  "$(printf '%s' "$asm_body" | grep -cxF '  for d in usr/local/bin sbin tmp var workspace .moca-var; do')" "1"
check "assemble_rootfs runs no mkdir of its own (only tree_dir_target makes directories)" \
  "$(printf '%s\n' "$asm_body" | grep -v '^\s*#' | grep -c 'mkdir -p "$STAGE/rootfs-tree/')" "0"
# The loop itself, run from assemble_rootfs's own lines on scratch trees: a directory the build
# makes, or one above it, as an absolute symlink out of the tree is refused BEFORE anything is
# created through it.
ad_harness() { # $1 = work dir
  {
    echo "STAGE='$1/stage'"
    fn_body tree_dir_target
    printf '%s\n' "$asm_body" | sed -n '/^  for d in usr\/local\/bin sbin tmp var workspace .moca-var; do$/,/^  done$/p'
  } >"$1/run.sh"
  bash "$1/run.sh" >"$1/out" 2>&1
  echo $?
}
AD="$(mktemp -d "${TMPDIR:-/tmp}/bs-asmdir-test.XXXXXX")"
w="$AD/plain"; mkdir -p "$w/stage/rootfs-tree/usr"
check "a plain tree: the directories are made" "$(ad_harness "$w")" "0"
check "a plain tree: all six exist" \
  "$(cd "$w/stage/rootfs-tree" && for d in usr/local/bin sbin tmp var workspace .moca-var; do [ -d "$d" ] && echo y; done | wc -l | tr -d ' ')" "6"
w="$AD/inside"; mkdir -p "$w/stage/rootfs-tree/usr/sbin"; ln -s usr/sbin "$w/stage/rootfs-tree/sbin"
check "a symlink that stays inside the tree (sbin -> usr/sbin) is accepted" "$(ad_harness "$w")" "0"
for link in usr/local sbin tmp var workspace .moca-var; do
  w="$AD/link-$(printf '%s' "$link" | tr '/.' '__')"; mkdir -p "$w/outside" "$w/stage/rootfs-tree/$(dirname "$link")"
  ln -s "$w/outside" "$w/stage/rootfs-tree/$link"
  check "/$link linked out of the tree: refused" "$([ "$(ad_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
  check "/$link linked out of the tree: the refusal says so" "$(grep -c 'resolves outside the tree' "$w/out")" "1"
  check "/$link linked out of the tree: nothing is created outside" "$(find "$w/outside" -mindepth 1 | wc -l | tr -d ' ')" "0"
done
w="$AD/dangling"; mkdir -p "$w/stage/rootfs-tree/usr"; ln -s "$AD/nowhere" "$w/stage/rootfs-tree/usr/local"
check "a dangling absolute symlink is refused" "$([ "$(ad_harness "$w")" != 0 ] && echo yes || echo no)" "yes"
check "a dangling absolute symlink: nothing is created at its target" "$([ -e "$AD/nowhere" ] && echo yes || echo no)" "no"
rm -rf "$AD"
# The mechanism itself, on a scratch tree: an absolute symlink is replaced, its target untouched.
t="$(mktemp -d)"; mkdir -p "$t/host" "$t/tree/sbin"; printf 'HOST\n' >"$t/host/init"
ln -s "$t/host/init" "$t/tree/sbin/init"
rm -f "$t/tree/sbin/init"; printf 'GUEST\n' >"$t/tree/sbin/init"
check "the host file behind the symlink is untouched" "$(cat "$t/host/init")" "HOST"
check "the tree gets a regular file" "$([ -f "$t/tree/sbin/init" ] && [ ! -L "$t/tree/sbin/init" ] && echo yes || echo no)" "yes"
rm -rf "$t"

echo "== --verify-command is opt-in: by default the verify step still runs \`true\`"
usage_text="$(bash "$SCRIPT" --help 2>&1)"
check "usage names --verify-command" "$(printf '%s' "$usage_text" | grep -c -- '--verify-command')" "3"
check "usage names --verify-timeout-s" "$(printf '%s' "$usage_text" | grep -c -- '--verify-timeout-s')" "2"
check "by default no verify command is set" "$(grep -c '^VERIFY_COMMAND=""$' "$SCRIPT")" "1"
check "both verify arms run the one helper" "$(grep -c '^  run_verify_command "$vsock_uds" || exit_code=$?$' "$SCRIPT")" "2"
check "no verify arm runs a hardcoded \`true\` any more" \
  "$(grep -c -- '-timeout-s 30 -command true' "$SCRIPT")" "0"
for bad in 0 86401 ten -5; do
  rc=0
  out="$(bash "$SCRIPT" --kernel k --rootfs r --agent a --image i --verify-command true --verify-timeout-s "$bad" 2>&1)" || rc=$?
  check "--verify-timeout-s $bad is refused before any build step (exit 2)" "$rc" "2"
done
check "the refusal names the rule" "$(printf '%s' "$out" | grep -c 'from 1 to 86400')" "1"
rc=0
bash "$SCRIPT" --kernel k --rootfs r --agent a --image i --verify-command '' >/dev/null 2>&1 || rc=$?
check "an empty --verify-command is a usage error (exit 2)" "$rc" "2"

# The guest command itself, from the script's own functions, run here under bash with the mount
# lines stubbed (no guest): the command's exit code comes back, and only its log's tail.
# shellcheck disable=SC2034 # VERIFY_COMMAND is read by the eval'd verify_guest_command
{
eval "$(fn_body verify_guest_command)"
VERIFY_COMMAND=""
check "without --verify-command the guest runs exactly \`true\`" "$(verify_guest_command firecracker)" "true"
VERIFY_COMMAND='echo seeded; printf "x%.0s" $(seq 1 20000); echo; echo "42 passed"; exit 3'
for vmm in firecracker cloud-hypervisor; do
  g="$(verify_guest_command "$vmm")"
  case "$vmm" in
    firecracker) want_mount='mount -o rw,noatime /dev/vdb /workspace' ;;
    cloud-hypervisor) want_mount='mount -t virtiofs workspace /workspace' ;;
  esac
  check "$vmm: the workspace is mounted as the worker mounts it, before the command" \
    "$(printf '%s\n' "$g" | head -n1 | grep -cF "$want_mount")" "1"
  t="$(mktemp -d)"
  g_local="$(printf '%s\n' "$g" | sed -e '1d' -e "s|cd /workspace|cd $t|" -e "s|/tmp/.verify-command.log|$t/log|g")"
  rc=0; out="$(bash -c "$g_local")" || rc=$?
  check "$vmm: the command's exit code comes back" "$rc" "3"
  check "$vmm: the output's tail comes back" "$(printf '%s\n' "$out" | tail -n1)" "42 passed"
  check "$vmm: at most 16 KiB of it" "$([ "${#out}" -le 16384 ] && echo yes || echo no)" "yes"
  rm -rf "$t"
done
}

if [ "$fails" -eq 0 ]; then echo "PASS"; else echo "FAIL ($fails)"; fi
exit "$fails"
