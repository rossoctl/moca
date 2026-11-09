package vmpool

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The lease level-1 gates (spec §9). Unlike every other gate in this package they drive
// the launcher directly -- Restore, Resume, several Runs, Destroy -- because a lease is
// exactly one VM serving many Execs, and the pool has no lease path until plan 2
// (TestGateNoVMReuse stays the pool's rule). Each gate checks the guest's state through a
// LATER Run in the same VM: that is the property a lease must keep.
//
// Firecracker only, not launcherForArm: chvWrapCommand mounts virtiofs inside every Run,
// which a lease Exec (uid 7000, no capabilities) cannot do. The Firecracker arm mounts
// /workspace once in Resume, as root, before the first lease request sets the guest's
// lease latch.
//
// Every process pattern below is bracketed ([s]leep, [l]ease-...) so that it does not
// match the command line of the Exec's own bash, which carries the pattern as text. Each
// gate has its own marker, so a leftover from one can never satisfy or fail another.

// leaseGateVM restores and resumes one Firecracker VM from a lease-v1 snapshot, or skips
// with a NOT RUN message when the snapshot does not advertise lease-v1. id is short on
// purpose: the jailed firecracker.socket path must fit sun_path's 108 bytes under the
// rig's chroot base (see TestGateCredentialNeverInGuest).
func leaseGateVM(t *testing.T, id string) VM {
	t.Helper()
	if v := envOr("SH_VMM", "firecracker"); v != "firecracker" {
		t.Skipf("NOT RUN (no signal, not a pass): SH_VMM=%q; the lease gates run on the Firecracker arm only", v)
	}
	snapshotDir := envOr("SH_SNAPSHOT_IMAGE_DIR", "/srv/snapshots/swebench-py311")
	m, err := LoadManifest(snapshotDir)
	if err != nil {
		t.Fatalf("LoadManifest: %v", err)
	}
	if !m.HasFeature(FeatureLeaseV1) {
		t.Skipf("NOT RUN (no signal, not a pass): snapshot %s does not advertise %q (features %v); "+
			"build one with deploy/microvm/build-snapshot.sh from this branch", snapshotDir, FeatureLeaseV1, m.Features)
	}
	lc := fcLauncher(t)
	vm, err := lc.Restore(context.Background(), RestoreRequest{
		ID: id, Key: "lease-gate", WorkspaceDir: sameDeviceSiblingDir(t, snapshotDir), GuestRAMBytes: 256 << 20,
	})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	t.Cleanup(func() { _ = vm.Destroy() })
	if err := vm.Resume(context.Background()); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	return vm
}

// leaseRunner returns a function that runs one lease Exec on vm and returns its stdout.
// The first call also asks the guest to normalise the workspace for the exec uid, as a
// lease's first Exec does. Every Run must exit 0 and tear down cleanly.
func leaseRunner(t *testing.T, vm VM) func(cmd string) string {
	first := true
	return func(cmd string) string {
		t.Helper()
		var out capturingSink
		res, err := vm.Run(context.Background(), Command{
			Command: cmd, Lease: true, NormaliseWorkspace: first, TimeoutS: 30, CapBytes: OutputCapBytes,
		}, &out)
		first = false
		if err != nil {
			t.Fatalf("Run %q: %v", cmd, err)
		}
		if res.ExitCode != 0 || res.TeardownFailed {
			t.Fatalf("Run %q: exit %d, teardown_failed %v, stdout %q, stderr %q",
				cmd, res.ExitCode, res.TeardownFailed, out.out(), out.stderr.String())
		}
		return out.out()
	}
}

// leftoverProcs is a guest command that prints `none` when no process matches the
// (bracketed) pgrep -f pattern, and otherwise each match's command line. Without pgrep it
// prints MISSING-PGREP, and on a pgrep error (status > 1) PGREP-ERROR:<status>, so a
// broken probe fails loudly rather than reading as "nothing left".
func leftoverProcs(pattern string) string {
	return `command -v pgrep >/dev/null || { echo MISSING-PGREP; exit 0; }
pids=$(pgrep -f '` + pattern + `'); rc=$?
if [ $rc -gt 1 ]; then echo PGREP-ERROR:$rc; exit 0; fi
if [ -z "$pids" ]; then echo none; else for p in $pids; do tr '\0' ' ' </proc/$p/cmdline; echo; done; fi`
}

// countProcs is the positive control: a guest command that polls for up to 3 s until
// `pgrep -fc pattern` reports want, then prints started=<count>. Without it, a Run 1 whose
// processes never started would make Run 2's `none` a pass for the wrong reason.
func countProcs(pattern string, want int) string {
	return fmt.Sprintf(`command -v pgrep >/dev/null || { echo MISSING-PGREP; exit 0; }
i=0; while n=$(pgrep -fc '%s'); [ "$n" != %d ] && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done
echo started=$n`, pattern, want)
}

// requireProbeWorked fails the gate when a pgrep probe could not run.
func requireProbeWorked(t *testing.T, out string) {
	t.Helper()
	if strings.Contains(out, "MISSING-PGREP") {
		t.Fatalf("the snapshot has no pgrep (procps), so the gate cannot look")
	}
	if strings.Contains(out, "PGREP-ERROR:") {
		t.Fatalf("pgrep failed in the guest:\n%s", out)
	}
}

// requireStarted asserts countProcs's line reports want processes.
func requireStarted(t *testing.T, out string, want int) {
	t.Helper()
	requireProbeWorked(t, out)
	if m := regexp.MustCompile(`(?m)^started=(\d+)$`).FindStringSubmatch(out); m == nil || m[1] != strconv.Itoa(want) {
		t.Fatalf("Run 1 started %v marked processes, want %d -- the gate would check for leftovers of nothing:\n%s", m, want, out)
	}
}

// leaseDaemonScript forks, lets the parent exit, setsids in the child and forks again,
// leaving a grandchild in its own session that sleeps; argv[1] is the marker.
const leaseDaemonScript = `
import os, sys, time
if os.fork():
    sys.exit(0)
os.setsid()
if os.fork():
    sys.exit(0)
fd = os.open("/dev/null", os.O_RDWR)
for i in (0, 1, 2):
    os.dup2(fd, i)
time.sleep(300)
`

// TestGateLeaseExecKillsProcesses: every process an Exec started -- backgrounded,
// setsid'd, nohup'd, double-forked, or a daemon in its own session -- is gone by the next
// Exec in the same VM (spec §9).
func TestGateLeaseExecKillsProcesses(t *testing.T) {
	requireKVM(t)
	run := leaseRunner(t, leaseGateVM(t, "vm-lkill"))

	// Built from variables so that the Exec's own bash command line, which pgrep -f also
	// sees, never carries the literal "sleep 30N" or the marker: only the started
	// processes match, in Run 1's count and in Run 2's search.
	const pattern = `[s]leep 30[0-3]|[l]ease-kill-marker`
	out := run(`s=30; m=lease-kill
sleep ${s}0 & setsid sleep ${s}1 & nohup sleep ${s}2 >/dev/null 2>&1 & (sleep ${s}3 &)
python3 -c ` + shQuote(leaseDaemonScript) + ` "$m-marker"
` + countProcs(pattern, 5))
	requireStarted(t, out, 5)

	got := run(leftoverProcs(pattern))
	requireProbeWorked(t, got)
	if got != "none\n" {
		t.Errorf("processes Run 1 started survived into Run 2:\n%s", got)
	}
}

// TestGateLeaseFreshShell: no shell state crosses Execs -- not a variable, a directory, a
// function or an alias -- and each Exec is a different shell process. $$ is the check that
// sees through wrapCommand's subshell: a persistent shell would lose FOO to the subshell
// too, but it would keep its pid.
func TestGateLeaseFreshShell(t *testing.T) {
	requireKVM(t)
	run := leaseRunner(t, leaseGateVM(t, "vm-lfresh"))

	pid1 := strings.TrimSpace(run(`export FOO=1; cd /; alias x=y; f(){ :; }; echo $$`))
	got := run(`echo "${FOO-unset}"; pwd; type f >/dev/null 2>&1 && echo has-f || echo no-f; ` +
		`alias x >/dev/null 2>&1 && echo has-x || echo no-x; echo $$`)
	lines := strings.Split(strings.TrimSuffix(got, "\n"), "\n")
	if len(lines) != 5 {
		t.Fatalf("Run 2 stdout %q: want 5 lines", got)
	}
	if want := []string{"unset", "/workspace", "no-f", "no-x"}; strings.Join(lines[:4], "\n") != strings.Join(want, "\n") {
		t.Errorf("Run 2 printed %q, want %q: state leaked from Run 1", lines[:4], want)
	}
	if pid1 == "" || lines[4] == pid1 {
		t.Errorf("Run 1 and Run 2 ran in the same shell (pid %q, %q)", pid1, lines[4])
	}
}

// leasePtraceScript is guestagent's ptraceAndProcessVMScript, ptrace half only (test code
// is not imported across packages): PTRACE_TRACEME must fail with errno 1, EPERM.
const leasePtraceScript = `
import ctypes
libc = ctypes.CDLL(None, use_errno=True)
r = libc.ptrace(0, 0, None, None)
print("ptrace", r, ctypes.get_errno() if r == -1 else 0)
`

// leaseProcMemScript opens PID 1's memory for writing and prints mem=<errno name>, or
// mem=opened. Opening, not reading: a read at offset 0 fails with EIO even when the
// open succeeded, so `cat /proc/1/mem` failing proves nothing.
const leaseProcMemScript = `
import errno, os
try:
    os.close(os.open("/proc/1/mem", os.O_WRONLY))
    print("mem=opened")
except OSError as e:
    print("mem=" + errno.errorcode.get(e.errno, str(e.errno)))
`

// TestGateLeasePrivilege is the Exec half of spec §9's LeasePrivilege (plan 5 adds the
// tracked-process half): a lease Exec runs as uid 7000 with no_new_privs, on an image
// with no setuid or setgid file, and can leave its cgroup, make one, signal or open PID
// 1, mount, make a user namespace, or ptrace -- none of it. Then Run 2 shows that nothing
// Run 1 started, or created, is left.
//
// The cgroup escape is checked twice: by exit status, and by consequence. $BASHPID, not
// $$, because wrapCommand runs the command in a subshell whose $$ is its parent's pid.
// The marker starts AFTER the migration attempts and from that same shell, so if one had
// succeeded the marker would sit outside the Exec's cgroup, survive its kill, and Run 2
// would find it.
func TestGateLeasePrivilege(t *testing.T) {
	requireKVM(t)
	run := leaseRunner(t, leaseGateVM(t, "vm-lpriv"))

	const pattern = `[l]ease-priv-marker`
	out := run(`echo $BASHPID > /sys/fs/cgroup/cgroup.procs 2>/dev/null; echo procs=$?
echo $BASHPID > /sys/fs/cgroup/moca-execs/cgroup.procs 2>/dev/null; echo execsprocs=$?
mkdir /sys/fs/cgroup/moca-execs/x 2>/dev/null; echo mkdir=$?
kill -0 1 2>/dev/null; echo kill=$?
mount -t tmpfs t /tmp/sbx-home 2>/dev/null; echo mount=$?
u=$(unshare -U true 2>&1); echo unshare=$?; echo "unshareerr=$(echo "$u" | tr '\n' ' ')"
python3 -c ` + shQuote(leaseProcMemScript) + `
python3 -c ` + shQuote(leasePtraceScript) + `
command -v find >/dev/null || echo MISSING-FIND
echo "suid=[$(find / -xdev -perm /6000 -type f 2>/dev/null | tr '\n' ' ')]"
echo "nnp=$(awk '/^NoNewPrivs:/ {print $2}' /proc/self/status)"
echo uid=$(id -u)
m=lease-priv; python3 -c 'import time; time.sleep(300)' "$m-marker" >/dev/null 2>&1 &
` + countProcs(pattern, 1))
	requireStarted(t, out, 1)

	// 127 is "command not found": the image lacks the tool, which proves nothing denied it.
	for _, step := range []string{"procs", "execsprocs", "mkdir", "kill", "mount", "unshare"} {
		m := regexp.MustCompile(`(?m)^` + step + `=(\d+)$`).FindStringSubmatch(out)
		if m == nil || m[1] == "0" || m[1] == "127" {
			t.Errorf("%s: exit status %v, want a non-zero status other than 127\n%s", step, m, out)
		}
	}
	// A usage message would also exit non-zero; these are the kernel's refusals.
	if m := regexp.MustCompile(`(?m)^unshareerr=(.*)$`).FindStringSubmatch(out); m == nil ||
		!(strings.Contains(m[1], "Operation not permitted") || strings.Contains(m[1], "No space left on device") ||
			strings.Contains(m[1], "Invalid argument")) {
		t.Errorf("unshare -U did not fail with EPERM, ENOSPC or EINVAL: %v\n%s", m, out)
	}
	if !strings.Contains(out, "\nmem=EACCES\n") && !strings.Contains(out, "\nmem=EPERM\n") {
		t.Errorf("opening /proc/1/mem for writing did not fail with EACCES or EPERM:\n%s", out)
	}
	if !strings.Contains(out, "ptrace -1 1\n") { // errno 1 = EPERM
		t.Errorf("ptrace(PTRACE_TRACEME) did not fail with EPERM:\n%s", out)
	}
	if strings.Contains(out, "MISSING-FIND") {
		t.Errorf("the snapshot has no find, so the setuid check cannot look:\n%s", out)
	} else if !strings.Contains(out, "\nsuid=[]\n") {
		t.Errorf("setuid or setgid files on the root filesystem:\n%s", out)
	}
	if !strings.Contains(out, "\nnnp=1\n") {
		t.Errorf("the Exec does not have no_new_privs set:\n%s", out)
	}
	if !strings.Contains(out, "\nuid=7000\n") {
		t.Errorf("the Exec is not uid 7000:\n%s", out)
	}

	got := run(`test -e /sys/fs/cgroup/moca-execs/x && echo cgroup-x-exists; ` + leftoverProcs(pattern))
	requireProbeWorked(t, got)
	if got != "none\n" {
		t.Errorf("Run 2 found what Run 1 left behind (a marker here means a cgroup escape worked):\n%s", got)
	}
}
