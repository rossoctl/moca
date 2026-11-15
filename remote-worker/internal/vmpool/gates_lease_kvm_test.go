package vmpool

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	ga "github.com/rossoctl/moca/remote-worker/internal/guestagent"
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

// requireLeaseSnapshot skips with a NOT RUN message unless the gates run on the
// Firecracker arm against a snapshot that advertises lease-v1, and returns the snapshot's
// directory and manifest. Every lease gate calls it after requireKVM.
func requireLeaseSnapshot(t *testing.T) (string, Manifest) {
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
	return snapshotDir, m
}

// requireLeaseProcessesSnapshot is requireLeaseSnapshot for a gate's level-2 half (plan 5):
// it also skips, NOT RUN, unless the snapshot advertises lease-processes-v1. On a lease-v1
// snapshot without it, a gate's level-1 half still runs and only its level-2 subtest skips.
func requireLeaseProcessesSnapshot(t *testing.T) (string, Manifest) {
	t.Helper()
	snapshotDir, m := requireLeaseSnapshot(t)
	if !m.HasFeature(FeatureLeaseProcessesV1) {
		t.Skipf("NOT RUN (no signal, not a pass): snapshot %s does not advertise %q (features %v); "+
			"the level-2 half needs one built with deploy/microvm/build-snapshot.sh from this branch",
			snapshotDir, FeatureLeaseProcessesV1, m.Features)
	}
	return snapshotDir, m
}

// TestLeaseLevel2HalvesSkipWithoutTheFeature pins the split the level-2 halves rely on, where
// no rig is needed to see it: against a lease-v1 snapshot without lease-processes-v1, the
// lease check passes (a gate's level-1 half runs) and the level-2 check skips; with both
// features neither skips.
func TestLeaseLevel2HalvesSkipWithoutTheFeature(t *testing.T) {
	for _, tc := range []struct {
		features   []string
		level2Runs bool
	}{
		{[]string{FeatureLeaseV1}, false},
		{[]string{FeatureLeaseV1, FeatureLeaseProcessesV1}, true},
	} {
		dir := t.TempDir()
		b, err := json.Marshal(Manifest{Features: tc.features})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, fileManifest), b, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("SH_VMM", "firecracker")
		t.Setenv("SH_SNAPSHOT_IMAGE_DIR", dir)
		var level1, level2 *testing.T
		t.Run("level1", func(t *testing.T) { level1 = t; requireLeaseSnapshot(t) })
		t.Run("level2", func(t *testing.T) { level2 = t; requireLeaseProcessesSnapshot(t) })
		if level1.Skipped() || level2.Skipped() == tc.level2Runs {
			t.Errorf("features %v: level 1 skipped %v, level 2 skipped %v; want level 1 run, level 2 run %v",
				tc.features, level1.Skipped(), level2.Skipped(), tc.level2Runs)
		}
	}
}

// leaseGateVM restores and resumes one Firecracker VM from a lease-v1 snapshot, or skips
// with a NOT RUN message when the snapshot does not advertise lease-v1. id is short on
// purpose: the jailed firecracker.socket path must fit sun_path's 108 bytes under the
// rig's chroot base (see TestGateCredentialNeverInGuest).
func leaseGateVM(t *testing.T, id string) VM {
	t.Helper()
	snapshotDir, _ := requireLeaseSnapshot(t)
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

// leaseProcScanScript scans /proc in the guest, which has no procps: argv is
// <count|list> <any|orphan> <pattern>. It reads each pid's cmdline (NUL to space),
// skipping pids that vanish or cannot be read, and matches with re.search. The patterns
// are bracketed ([s]leep ...), so neither this scanner's argv nor the Exec's own bash
// command line, which carry them as text, can match.
//   - count prints the number of matches; with orphan, <matches>/<matches with PPid 1>.
//   - list prints `none`, or `<pid> <cmdline>` for each match.
//
// Any unexpected exception prints SCAN-ERROR:<msg>, so a broken probe fails loudly
// rather than reading as "nothing left".
const leaseProcScanScript = `
import os, re, sys
try:
    mode, want, pat = sys.argv[1], sys.argv[2], re.compile(sys.argv[3])
    me, hits = os.getpid(), []
    for d in os.listdir("/proc"):
        if not d.isdigit() or int(d) == me:
            continue
        try:
            with open("/proc/%s/cmdline" % d, "rb") as f:
                cmd = f.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
            ppid = None
            if want == "orphan":
                with open("/proc/%s/status" % d) as f:
                    for line in f:
                        if line.startswith("PPid:"):
                            ppid = int(line.split()[1])
        except OSError:
            continue
        if cmd and pat.search(cmd):
            hits.append((d, cmd, ppid))
    if mode == "count":
        if want == "orphan":
            print("%d/%d" % (len(hits), sum(1 for h in hits if h[2] == 1)))
        else:
            print(len(hits))
    elif hits:
        for d, cmd, _ in hits:
            print(d, cmd)
    else:
        print("none")
except Exception as e:
    print("SCAN-ERROR:%r" % (e,))
`

// scanProcs is the guest command that runs leaseProcScanScript. Its callers check for
// python3 first.
func scanProcs(mode, want, pattern string) string {
	return "python3 -c " + shQuote(leaseProcScanScript) + " " + mode + " " + want + " " + shQuote(pattern)
}

// leftoverProcs is a guest command that prints `none` when no process matches the
// (bracketed) pattern, and otherwise each match's pid and command line.
func leftoverProcs(pattern string) string {
	return `command -v python3 >/dev/null || { echo MISSING-PYTHON3; exit 0; }
` + scanProcs("list", "any", pattern)
}

// procWant is one process the positive control waits for. orphan additionally requires
// it to have been reparented to PID 1, as a daemon's final process is: otherwise the
// daemon's transient intermediate could satisfy the count on its own.
type procWant struct {
	pattern string
	orphan  bool
}

// want is the count line procWant expects: exactly one match, and for an orphan that
// one match with PPid 1.
func (w procWant) want() string {
	if w.orphan {
		return "1/1"
	}
	return "1"
}

// countProcs is the positive control: a guest command that, for each process in turn,
// polls for up to 3 s until the scanner reports exactly one match, then prints
// started=<index>:<count>. Without it, a Run 1 whose processes never started would make
// Run 2's `none` a pass for the wrong reason. Per process, not a total: a daemon's
// transient intermediate process could make a total right while one process never ran.
func countProcs(wants ...procWant) string {
	var b strings.Builder
	b.WriteString("command -v python3 >/dev/null || { echo MISSING-PYTHON3; exit 0; }\n")
	for i, w := range wants {
		mode := "any"
		if w.orphan {
			mode = "orphan"
		}
		fmt.Fprintf(&b, "i=0; while n=$(%s); [ \"$n\" != %s ] && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done; echo \"started=%d:$n\"\n",
			scanProcs("count", mode, w.pattern), w.want(), i)
	}
	return b.String()
}

// requireProbeWorked fails the gate when a /proc probe could not run.
func requireProbeWorked(t *testing.T, out string) {
	t.Helper()
	if strings.Contains(out, "MISSING-PYTHON3") {
		t.Fatalf("the snapshot has no python3, so the gate cannot scan /proc")
	}
	if strings.Contains(out, "SCAN-ERROR:") {
		t.Fatalf("the /proc scan failed in the guest:\n%s", out)
	}
}

// requireStarted asserts countProcs saw each wanted process.
func requireStarted(t *testing.T, out string, wants ...procWant) {
	t.Helper()
	requireProbeWorked(t, out)
	for i, w := range wants {
		m := regexp.MustCompile(`(?m)^started=` + strconv.Itoa(i) + `:(.*)$`).FindStringSubmatch(out)
		if m == nil || m[1] != w.want() {
			t.Errorf("Run 1: %v for %q, want %s -- the gate would check for leftovers of nothing", m, w.pattern, w.want())
		}
	}
	if t.Failed() {
		t.Fatalf("Run 1 output:\n%s", out)
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
	t.Run("level1", testLeaseExecKillsProcessesLevel1)
	t.Run("level2", testLeaseExecKillsProcessesLevel2)
}

// testLeaseExecKillsProcessesLevel1 is TestGateLeaseExecKillsProcesses's level-1 half.
// Each half is a subtest, so a level-1 failure cannot hide the level-2 result, and
// -run .../level2 runs level 2 alone.
func testLeaseExecKillsProcessesLevel1(t *testing.T) {
	run := leaseRunner(t, leaseGateVM(t, "vm-lkill"))

	// Built from variables so that the Exec's own bash command line, which the /proc scan
	// also sees, never carries the literal "sleep 30N" or the marker: only the started
	// processes match, in Run 1's count and in Run 2's search.
	const pattern = `[s]leep 30[0-3]|[l]ease-kill-marker`
	started := []procWant{
		{`[s]leep 300`, false}, {`[s]leep 301`, false}, {`[s]leep 302`, false}, {`[s]leep 303`, false},
		{`[l]ease-kill-marker`, true},
	}
	out := run(`s=30; m=lease-kill
sleep ${s}0 & setsid sleep ${s}1 & nohup sleep ${s}2 >/dev/null 2>&1 & (sleep ${s}3 &)
python3 -c ` + shQuote(leaseDaemonScript) + ` "$m-marker"
` + countProcs(started...))
	requireStarted(t, out, started...)

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

// leaseMountScript calls mount(2) directly and prints mountsys=<errno name>, or
// mountsys=ok if the mount succeeded.
const leaseMountScript = `
import ctypes, errno
libc = ctypes.CDLL(None, use_errno=True)
r = libc.mount(b"t", b"/tmp/sbx-home", b"tmpfs", 0, None)
e = ctypes.get_errno()
print("mountsys=" + ("ok" if r == 0 else errno.errorcode.get(e, str(e))))
`

// TestGateLeasePrivilege is the Exec half of spec §9's LeasePrivilege (plan 5 adds the
// tracked-process half): a lease Exec runs as uid 7000 with no capabilities and
// no_new_privs, on an image with no setuid or setgid file, and can leave its cgroup, make
// one, signal or open PID 1, mount, make a user namespace, or ptrace -- none of it. It
// inherits no fd but stdio, and /workspace is mounted nodev,nosuid. Then
// Run 2 shows that nothing Run 1 started, or created, is left.
//
// The cgroup escape is checked twice: by exit status, and by consequence. $BASHPID, not
// $$, because wrapCommand runs the command in a subshell whose $$ is its parent's pid.
// The marker starts AFTER the migration attempts and from that same shell, so if one had
// succeeded the marker would sit outside the Exec's cgroup, survive its kill, and Run 2
// would find it.
func TestGateLeasePrivilege(t *testing.T) {
	requireKVM(t)
	t.Run("level1", testLeasePrivilegeLevel1)
	t.Run("level2", testLeasePrivilegeLevel2)
}

// testLeasePrivilegeLevel1 is TestGateLeasePrivilege's level-1 half. Each half is a
// subtest, so a level-1 failure cannot hide the level-2 result, and -run .../level2
// runs level 2 alone.
func testLeasePrivilegeLevel1(t *testing.T) {
	run := leaseRunner(t, leaseGateVM(t, "vm-lpriv"))

	const pattern = `[l]ease-priv-marker`
	out := run(`echo $BASHPID > /sys/fs/cgroup/cgroup.procs 2>/dev/null; echo procs=$?
e=$(mktemp); { echo $BASHPID > /sys/fs/cgroup/moca-execs/cgroup.procs; } 2>"$e"; echo execsprocs=$?
echo "execsprocserr=$(tr '\n' ' ' <"$e")"; rm -f "$e"
u=$(mkdir /sys/fs/cgroup/moca-execs/x 2>&1); echo mkdir=$?; echo "mkdirerr=$(echo "$u" | tr '\n' ' ')"
kill -0 1 2>/dev/null; echo kill=$?
echo "capeff=$(awk '/^CapEff:/ {print $2}' /proc/$BASHPID/status)"
python3 -c ` + shQuote(leaseMountScript) + `
u=$(unshare -U true 2>&1); echo unshare=$?; echo "unshareerr=$(echo "$u" | tr '\n' ' ')"
python3 -c ` + shQuote(leaseProcMemScript) + `
python3 -c ` + shQuote(leasePtraceScript) + `
command -v find >/dev/null || echo MISSING-FIND
echo "suid=[$(find / -xdev -perm /6000 -type f 2>/dev/null | tr '\n' ' ')]"
echo "nnp=$(awk '/^NoNewPrivs:/ {print $2}' /proc/$BASHPID/status)"
echo uid=$(id -u)
p=$BASHPID; ls /proc/$p/fd >"$HOME/fdl"; echo "fdlist=$(sort -n "$HOME/fdl" | tr '\n' ' ')"
echo "mountopts=$(awk '$5 == "/workspace" {o = $6} END {print o}' /proc/self/mountinfo)"
m=lease-priv; python3 -c 'import time; time.sleep(300)' "$m-marker" >/dev/null 2>&1 &
` + countProcs(procWant{pattern, false}))
	requireStarted(t, out, procWant{pattern, false})

	// 127 is "command not found": the image lacks the tool, which proves nothing denied it.
	for _, step := range []string{"procs", "execsprocs", "mkdir", "kill", "unshare"} {
		m := regexp.MustCompile(`(?m)^` + step + `=(\d+)$`).FindStringSubmatch(out)
		if m == nil || m[1] == "0" || m[1] == "127" {
			t.Errorf("%s: exit status %v, want a non-zero status other than 127\n%s", step, m, out)
		}
	}
	// EACCES, not ENOENT: an ENOENT would mean the cgroup layout is broken, which also
	// fails the write and the mkdir but proves nothing about privilege.
	for _, step := range []string{"execsprocserr", "mkdirerr"} {
		if m := regexp.MustCompile(`(?m)^` + step + `=(.*)$`).FindStringSubmatch(out); m == nil || !strings.Contains(m[1], "Permission denied") {
			t.Errorf("%s: %v, want \"Permission denied\"\n%s", step, m, out)
		}
	}
	// The capability set itself, and mount(2) called directly: util-linux mount refuses a
	// non-root caller in userspace before any syscall, so its exit status proves nothing.
	if !strings.Contains(out, "\ncapeff=0000000000000000\n") {
		t.Errorf("the Exec has effective capabilities:\n%s", out)
	}
	if !strings.Contains(out, "\nmountsys=EPERM\n") {
		t.Errorf("mount(2) of a tmpfs did not fail with EPERM:\n%s", out)
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
	// Only stdio may reach an Exec: an inherited agent fd (the port-1024 listener, a
	// request connection) would hand uid 7000 the agent's channel to the host. bash may
	// hold 255 of its own. The subshell lists its own fds (not ls's: a pipeline
	// element's $BASHPID is its own pid) into a file, since it holds a pipe's end while
	// a pipe or $(...) runs.
	if m := regexp.MustCompile(`(?m)^fdlist=(.*)$`).FindStringSubmatch(out); m == nil ||
		(m[1] != "0 1 2 " && m[1] != "0 1 2 255 ") {
		t.Errorf("fds open in the Exec: %v, want exactly 0 1 2 (and maybe 255)\n%s", m, out)
	}
	// The first lease request remounts /workspace nodev,nosuid, so a device node or a
	// setuid file there is inert.
	if m := regexp.MustCompile(`(?m)^mountopts=(.*)$`).FindStringSubmatch(out); m == nil ||
		!slices.Contains(strings.Split(m[1], ","), "nodev") || !slices.Contains(strings.Split(m[1], ","), "nosuid") {
		t.Errorf("/workspace is not mounted nodev,nosuid: %v\n%s", m, out)
	}

	got := run(`test -e /sys/fs/cgroup/moca-execs/x && echo cgroup-x-exists; ` + leftoverProcs(pattern))
	requireProbeWorked(t, got)
	if got != "none\n" {
		t.Errorf("Run 2 found what Run 1 left behind (a marker here means a cgroup escape worked):\n%s", got)
	}

}

// The level-2 halves (plan 5, spec §7, §9): tracked processes, driven through the launcher
// as the level-1 halves are. A process kind is a lease request with Kind and Process set,
// answered as JSON on stdout (guestagent/tracked_linux.go).

// leaseProcess sends one process kind to vm and returns its stdout, or the guest's refusal.
// A process_start carries the default SH_LEASE_MAX_PROCESSES, as the pool sends it. An
// answer that is not a refusal must exit 0 and tear down cleanly.
func leaseProcess(t *testing.T, vm VM, kind ExecKind, args ProcessArgs, cmd string) (string, error) {
	t.Helper()
	c := Command{Command: cmd, Lease: true, TimeoutS: ProcessKindMinTimeoutS, CapBytes: OutputCapBytes,
		Kind: kind, Process: args}
	if kind == ExecKindProcessStart {
		c.MaxProcesses = DefaultLeaseMaxProcesses
	}
	var out capturingSink
	res, err := vm.Run(context.Background(), c, &out)
	if err != nil {
		return out.out(), err
	}
	if res.ExitCode != 0 || res.TeardownFailed {
		t.Fatalf("%s %+v: exit %d, teardown_failed %v, stdout %q, stderr %q",
			kind, args, res.ExitCode, res.TeardownFailed, out.out(), out.stderr.String())
	}
	return out.out(), nil
}

// gateTracked is process_start's answer.
type gateTracked struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	PID  int    `json:"pid"`
}

// parseTrackedStart decodes process_start's answer, failing unless it names a process.
func parseTrackedStart(t *testing.T, out string) gateTracked {
	t.Helper()
	var st gateTracked
	if err := json.Unmarshal([]byte(out), &st); err != nil || st.ID == "" || st.PID <= 0 {
		t.Fatalf("process_start answered %q (%v), want {id, name, pid}", out, err)
	}
	return st
}

// leaseStartTracked starts a tracked process on vm and returns it.
func leaseStartTracked(t *testing.T, vm VM, name, cmd string) gateTracked {
	t.Helper()
	out, err := leaseProcess(t, vm, ExecKindProcessStart, ProcessArgs{Name: name}, cmd)
	if err != nil {
		t.Fatalf("process_start %q: %v", name, err)
	}
	return parseTrackedStart(t, out)
}

// parseTrackedList decodes process_list's answer: the guest's table, as the host mirrors it.
func parseTrackedList(t *testing.T, out string) []TrackedProcess {
	t.Helper()
	var rows []ga.TrackedProcess
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("process_list answered %q: %v", out, err)
	}
	return trackedFromGuest(rows)
}

// leaseListTracked is vm's process_list.
func leaseListTracked(t *testing.T, vm VM) []TrackedProcess {
	t.Helper()
	out, err := leaseProcess(t, vm, ExecKindProcessList, ProcessArgs{}, "")
	if err != nil {
		t.Fatalf("process_list: %v", err)
	}
	return parseTrackedList(t, out)
}

// trackedByID is the row of ps with id, and whether there is one.
func trackedByID(ps []TrackedProcess, id string) (TrackedProcess, bool) {
	for _, tp := range ps {
		if tp.ID == id {
			return tp, true
		}
	}
	return TrackedProcess{}, false
}

// waitGate polls cond every 100 ms until it holds, failing after within.
func waitGate(t *testing.T, within time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s: not within %s", what, within)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// leaseWaitLogs polls vm's process_logs of args until they contain every want, and
// returns them.
func leaseWaitLogs(t *testing.T, vm VM, args ProcessArgs, wants ...string) string {
	t.Helper()
	var logs string
	waitGate(t, 15*time.Second, fmt.Sprintf("process_logs %+v holding %q", args, wants), func() bool {
		out, err := leaseProcess(t, vm, ExecKindProcessLogs, args, "")
		if err != nil {
			t.Fatalf("process_logs %+v: %v", args, err)
		}
		logs = out
		for _, w := range wants {
			if !strings.Contains(out, w) {
				return false
			}
		}
		return true
	})
	return logs
}

// trackedPIDs parses scanProcs list output (`<pid> <cmdline>` lines, or `none`) into pids.
func trackedPIDs(t *testing.T, out string) []int {
	t.Helper()
	requireProbeWorked(t, out)
	var pids []int
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "none" || line == "" {
			continue
		}
		f, _, _ := strings.Cut(line, " ")
		pid, err := strconv.Atoi(f)
		if err != nil {
			t.Fatalf("scan line %q: %v", line, err)
		}
		pids = append(pids, pid)
	}
	return pids
}

// leaseSleeper is a tracked command whose process sleeps 300 s with marker in its argv,
// built from a variable so the command text never carries the marker (as the level-1
// gates do): only the process itself matches its bracketed pattern.
func leaseSleeper(prefix, suffix string) string {
	return `m=` + prefix + `; exec python3 -c 'import time; time.sleep(300)' "$m-` + suffix + `"`
}

// testLeaseExecKillsProcessesLevel2: at level 2, process_start processes are an Exec's only
// survivors (spec §9). A tracked process, and a child it put in a session of its own, outlive
// every later Exec, each in the tracked process's cgroup; everything an Exec started is gone
// by the next one; and process_stop takes the tracked process's child with it.
func testLeaseExecKillsProcessesLevel2(t *testing.T) {
	requireLeaseProcessesSnapshot(t)
	vm := leaseGateVM(t, "vm-lkill2")
	run := leaseRunner(t, vm)
	run("true") // the lease's first request, which normalises the workspace

	const execPattern = `[s]leep 30[0-3]|[l]ease-kill-marker`
	const mainPattern, childPattern = `[l]ease-tracked-marker-main`, `[l]ease-tracked-marker-child`
	st := leaseStartTracked(t, vm, "survivor", `m=lease-tracked
setsid python3 -c 'import time; time.sleep(300)' "$m-marker-child" >/dev/null 2>&1 &
exec python3 -c 'import time; time.sleep(300)' "$m-marker-main"`)

	started := []procWant{
		{`[s]leep 300`, false}, {`[s]leep 301`, false}, {`[s]leep 302`, false}, {`[s]leep 303`, false},
		{`[l]ease-kill-marker`, true}, {mainPattern, false}, {childPattern, false},
	}
	out := run(`s=30; m=lease-kill
sleep ${s}0 & setsid sleep ${s}1 & nohup sleep ${s}2 >/dev/null 2>&1 & (sleep ${s}3 &)
python3 -c ` + shQuote(leaseDaemonScript) + ` "$m-marker"
` + countProcs(started...))
	requireStarted(t, out, started...)

	got := run(leftoverProcs(execPattern))
	requireProbeWorked(t, got)
	if got != "none\n" {
		t.Errorf("processes an Exec started survived into the next one at level 2:\n%s", got)
	}
	mains := trackedPIDs(t, run(leftoverProcs(mainPattern)))
	children := trackedPIDs(t, run(leftoverProcs(childPattern)))
	if len(mains) != 1 || mains[0] != st.PID || len(children) != 1 {
		t.Fatalf("after two Execs: tracked process pids %v (process_start said %d), its child %v; want each alive once",
			mains, st.PID, children)
	}
	// Both in the tracked process's own cgroup, not in an Exec's and not at the root.
	want := "/tracked/p" + st.ID
	for _, pid := range []int{mains[0], children[0]} {
		if cg := strings.TrimSpace(run(fmt.Sprintf("cat /proc/%d/cgroup", pid))); !strings.HasPrefix(cg, "0::/") || !strings.HasSuffix(cg, want) {
			t.Errorf("pid %d is in cgroup %q, want one ending %s", pid, cg, want)
		}
	}
	if tp, ok := trackedByID(leaseListTracked(t, vm), st.ID); !ok || !tp.running() || tp.PID != st.PID || tp.DisplayName() != "survivor" {
		t.Fatalf("process_list row for %s = %+v (found %v), want survivor running as pid %d", st.ID, tp, ok, st.PID)
	}

	if _, err := leaseProcess(t, vm, ExecKindProcessStop, ProcessArgs{Name: "survivor"}, ""); err != nil {
		t.Fatalf("process_stop survivor: %v", err)
	}
	for _, pat := range []string{mainPattern, childPattern} {
		if got := run(leftoverProcs(pat)); got != "none\n" {
			t.Errorf("after process_stop, %s is still alive:\n%s", pat, got)
		}
	}
}

// leaseVictimScript is a tracked process that holds a canary in memory: it prints its
// buffer's address, pid, identity, HOME and umask, then checks the canary every 0.2 s,
// printing CHANGED if it ever differs. Once /workspace/.lease-victim-check exists it prints
// the canary as it then reads it. argv[1] is the canary, argv[2] the marker.
const leaseVictimScript = `
import ctypes, os, sys, time
canary = sys.argv[1].encode()
buf = ctypes.create_string_buffer(canary, 64)
um = os.umask(0); os.umask(um)
print("addr=%d len=%d pid=%d uid=%d gid=%d home=%s umask=%04o" % (ctypes.addressof(buf), len(canary),
      os.getpid(), os.getuid(), os.getgid(), os.environ.get("HOME", ""), um), flush=True)
told = False
while True:
    if buf.value != canary:
        print("CHANGED", buf.value, flush=True)
    if not told and os.path.exists("/workspace/.lease-victim-check"):
        print("canary=" + buf.value.decode("utf-8", "replace"), flush=True)
        told = True
    time.sleep(0.2)
`

// leaseAttackScript runs, as a lease Exec, every route spec §3.3 closes from an Exec to a
// running tracked process: argv is <pid> <addr> <len>. It prints one <route>=<errno name>
// (or <route>=ok when the call succeeded) per route.
const leaseAttackScript = `
import ctypes, errno, os, signal, sys
libc = ctypes.CDLL(None, use_errno=True)
pid, addr, n = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
def report(name, r):
    e = ctypes.get_errno()
    print("%s=%s" % (name, "ok" if r != -1 else errno.errorcode.get(e, str(e))), flush=True)
class iovec(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]
for name, req in (("ptrace_attach", 16), ("ptrace_seize", 0x4206)):
    report(name, libc.ptrace(ctypes.c_long(req), ctypes.c_long(pid), None, None))
mine = ctypes.create_string_buffer(b"X" * n, n)
local, remote = iovec(ctypes.addressof(mine), n), iovec(addr, n)
libc.process_vm_writev.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong]
libc.process_vm_readv.argtypes = libc.process_vm_writev.argtypes
report("vm_writev", libc.process_vm_writev(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0))
report("vm_readv", libc.process_vm_readv(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0))
try:
    fd = os.open("/proc/%d/mem" % pid, os.O_RDWR)
    try:
        os.pwrite(fd, b"X" * n, addr)
        print("mem=written")
    except OSError as e:
        print("mem=opened-" + errno.errorcode.get(e.errno, str(e.errno)))
    os.close(fd)
except OSError as e:
    print("mem=" + errno.errorcode.get(e.errno, str(e.errno)))
for name, sig in (("kill_term", signal.SIGTERM), ("kill_zero", 0)):
    try:
        os.kill(pid, sig)
        print(name + "=ok")
    except OSError as e:
        print(name + "=" + errno.errorcode.get(e.errno, str(e.errno)))
`

// testLeasePrivilegeLevel2 is the tracked half of TestGateLeasePrivilege (spec §3.3, §9,
// Review Focus 2): a tracked process runs under its own uid from the tracked range, in the
// sbx-ws group, with no capabilities, no_new_privs, the seccomp filter, umask 0002 and its
// own HOME; and a lease Exec can neither ptrace, process_vm_writev, write /proc/<pid>/mem
// of, nor signal it, nor move itself into its cgroup. The process's memory and command are
// unchanged afterwards, and it is still running.
func testLeasePrivilegeLevel2(t *testing.T) {
	requireLeaseProcessesSnapshot(t)
	vm := leaseGateVM(t, "vm-lpriv2")
	run := leaseRunner(t, vm)
	run("true")

	const canary = "lease-victim-canary-5f1e0c"
	st := leaseStartTracked(t, vm, "victim", "m=lease-victim; exec python3 -c "+shQuote(leaseVictimScript)+
		" "+shQuote(canary)+` "$m-marker"`)
	logs := leaseWaitLogs(t, vm, ProcessArgs{Name: "victim"}, "addr=")
	m := regexp.MustCompile(`addr=(\d+) len=(\d+) pid=(\d+) uid=(\d+) gid=(\d+) home=(\S*) umask=(\d+)`).FindStringSubmatch(logs)
	if m == nil {
		t.Fatalf("the victim's first line is missing from its logs:\n%s", logs)
	}
	addr, n, pid, uid := m[1], m[2], m[3], m[4]
	if pid != strconv.Itoa(st.PID) {
		t.Fatalf("the victim reports pid %s, process_start said %d", pid, st.PID)
	}
	if u, _ := strconv.Atoi(uid); u < 20000 || u >= 20000+DefaultLeaseMaxProcesses || m[5] != "7000" {
		t.Errorf("the tracked process runs as uid %s gid %s, want a uid in 20000..%d and gid 7000 (sbx-ws)",
			uid, m[5], 20000+DefaultLeaseMaxProcesses-1)
	}
	if m[6] != "/tmp/sbx-proc/"+uid || m[7] != "0002" {
		t.Errorf("HOME %q umask %s, want /tmp/sbx-proc/%s and 0002 (ruling P5-R12, spec §3.3)", m[6], m[7], uid)
	}

	cmdline := fmt.Sprintf(`tr '\0' ' ' </proc/%s/cmdline; echo`, pid)
	before := run(cmdline)
	if !strings.Contains(before, "lease-victim-marker") {
		t.Fatalf("an Exec reads the victim's command line as %q, want its marker: the later comparison would prove nothing", before)
	}
	status := run(fmt.Sprintf(`awk '/^(Uid|Gid|CapEff|CapBnd|NoNewPrivs|Seccomp):/' /proc/%s/status
stat -c 'home=%%a:%%u' /tmp/sbx-proc/%s`, pid, uid))
	for _, want := range []string{
		"Uid:\t" + uid + "\t" + uid + "\t" + uid + "\t" + uid + "\n", "Gid:\t7000\t7000\t7000\t7000\n",
		"CapEff:\t0000000000000000\n", "CapBnd:\t0000000000000000\n", "NoNewPrivs:\t1\n", "Seccomp:\t2\n",
		"home=700:" + uid + "\n",
	} {
		if !strings.Contains(status, want) {
			t.Errorf("the tracked process's status lacks %q:\n%s", want, status)
		}
	}

	// The attack, from a lease Exec (uid 7000), and the cgroup move it would need instead.
	out := run(`python3 -c ` + shQuote(leaseAttackScript) + " " + pid + " " + addr + " " + n + `
e=$(mktemp); { echo $BASHPID > /sys/fs/cgroup/moca-execs/tracked/p` + st.ID + `/cgroup.procs; } 2>"$e"; echo trackedprocs=$?
echo "trackedprocserr=$(tr '\n' ' ' <"$e")"; rm -f "$e"`)
	for _, route := range []string{"ptrace_attach", "ptrace_seize", "vm_writev", "vm_readv"} {
		if !strings.Contains(out, "\n"+route+"=EPERM\n") && !strings.HasPrefix(out, route+"=EPERM\n") {
			t.Errorf("%s on the tracked process did not fail with EPERM:\n%s", route, out)
		}
	}
	if !strings.Contains(out, "\nmem=EACCES\n") && !strings.Contains(out, "\nmem=EPERM\n") {
		t.Errorf("opening the tracked process's /proc/<pid>/mem for writing did not fail with EACCES or EPERM:\n%s", out)
	}
	for _, route := range []string{"kill_term", "kill_zero"} {
		if !strings.Contains(out, "\n"+route+"=EPERM\n") {
			t.Errorf("%s on the tracked process did not fail with EPERM:\n%s", route, out)
		}
	}
	if m := regexp.MustCompile(`(?m)^trackedprocs=(\d+)$`).FindStringSubmatch(out); m == nil || m[1] == "0" {
		t.Errorf("an Exec wrote its pid into the tracked cgroup: %v\n%s", m, out)
	}
	if m := regexp.MustCompile(`(?m)^trackedprocserr=(.*)$`).FindStringSubmatch(out); m == nil || !strings.Contains(m[1], "Permission denied") {
		t.Errorf("the tracked cgroup.procs write: %v, want \"Permission denied\"\n%s", m, out)
	}

	// Unchanged: the victim reads its canary as it was, has never seen it change, and its
	// command line and pid are the same.
	run("touch /workspace/.lease-victim-check")
	logs = leaseWaitLogs(t, vm, ProcessArgs{Name: "victim"}, "canary=")
	if !strings.Contains(logs, "canary="+canary+"\n") || strings.Contains(logs, "CHANGED") {
		t.Errorf("the tracked process's memory changed under the attack:\n%s", logs)
	}
	if after := run(cmdline); after != before {
		t.Errorf("the tracked process's command line changed: %q, then %q", before, after)
	}
	if tp, ok := trackedByID(leaseListTracked(t, vm), st.ID); !ok || !tp.running() || tp.PID != st.PID {
		t.Errorf("after the attack the victim's row is %+v (found %v), want running as pid %d", tp, ok, st.PID)
	}
}
