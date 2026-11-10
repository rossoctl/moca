package vmpool

import (
	"context"
	"fmt"
	"regexp"
	"slices"
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
