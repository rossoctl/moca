package vmpool

import (
	"context"
	"regexp"
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
// prints MISSING-PGREP, so a snapshot lacking procps fails loudly rather than reading as
// "nothing left".
func leftoverProcs(pattern string) string {
	return `command -v pgrep >/dev/null || { echo MISSING-PGREP; exit 0; }
pids=$(pgrep -f '` + pattern + `')
if [ -z "$pids" ]; then echo none; else for p in $pids; do tr '\0' ' ' </proc/$p/cmdline; echo; done; fi`
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

	if got := run(`sleep 300 & setsid sleep 301 & nohup sleep 302 >/dev/null 2>&1 & (sleep 303 &); ` +
		`python3 -c ` + shQuote(leaseDaemonScript) + ` lease-kill-marker; echo started`); got != "started\n" {
		t.Fatalf("Run 1 stdout %q, want %q", got, "started\n")
	}
	got := run(leftoverProcs(`[s]leep 30[0-3]|[l]ease-kill-marker`))
	if strings.Contains(got, "MISSING-PGREP") {
		t.Fatalf("the snapshot has no pgrep (procps), so the gate cannot look")
	}
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

// TestGateLeasePrivilege is the Exec half of spec §9's LeasePrivilege (plan 5 adds the
// tracked-process half): a lease Exec runs as uid 7000 and can leave its cgroup, make
// one, signal or read PID 1, become root, mount, make a user namespace, or ptrace -- none
// of it. Then Run 2 shows that nothing Run 1 started, or created, is left.
func TestGateLeasePrivilege(t *testing.T) {
	requireKVM(t)
	run := leaseRunner(t, leaseGateVM(t, "vm-lpriv"))

	out := run(`python3 -c 'import time; time.sleep(300)' lease-priv-marker >/dev/null 2>&1 &
echo $$ > /sys/fs/cgroup/cgroup.procs 2>/dev/null; echo procs=$?
mkdir /sys/fs/cgroup/moca-execs/x 2>/dev/null; echo mkdir=$?
kill -0 1 2>/dev/null; echo kill=$?
cat /proc/1/mem >/dev/null 2>&1; echo mem=$?
su -c id </dev/null >/dev/null 2>&1; echo su=$?
mount -t tmpfs t /mnt 2>/dev/null; echo mount=$?
unshare -U true 2>/dev/null; echo unshare=$?
python3 -c ` + shQuote(leasePtraceScript) + `
echo uid=$(id -u)`)
	for _, step := range []string{"procs", "mkdir", "kill", "mem", "su", "mount", "unshare"} {
		m := regexp.MustCompile(`(?m)^` + step + `=(\d+)$`).FindStringSubmatch(out)
		// 127 is "command not found": the image lacks the tool, which proves nothing denied it.
		if m == nil || m[1] == "0" || m[1] == "127" {
			t.Errorf("%s: exit status %v, want a non-zero status other than 127\n%s", step, m, out)
		}
	}
	if !strings.Contains(out, "ptrace -1 1\n") { // errno 1 = EPERM
		t.Errorf("ptrace(PTRACE_TRACEME) did not fail with EPERM:\n%s", out)
	}
	if !strings.Contains(out, "uid=7000\n") {
		t.Errorf("the Exec is not uid 7000:\n%s", out)
	}

	got := run(`test -e /sys/fs/cgroup/moca-execs/x && echo cgroup-x-exists; ` + leftoverProcs(`[l]ease-priv-marker`))
	if strings.Contains(got, "MISSING-PGREP") {
		t.Fatalf("the snapshot has no pgrep (procps), so the gate cannot look")
	}
	if got != "none\n" {
		t.Errorf("Run 2 found what Run 1 left behind:\n%s", got)
	}
}
