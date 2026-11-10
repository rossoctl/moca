//go:build linux

package guestagent

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// The exec identity the lease tests drop to (global constraints: uid and gid 7000).
const testExecID = "7000"

// requireRootCgroupV2 skips a lease test unless it runs as root on a cgroup v2 host:
// the shim's privilege drop, and the cgroup work of the later lease tasks, need both.
// CI runs these in the microvm-gates job under sudo; `make test` skips them.
func requireRootCgroupV2(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("needs root and cgroup v2")
	}
	if _, err := os.Stat("/sys/fs/cgroup/cgroup.controllers"); err != nil {
		t.Skip("needs root and cgroup v2")
	}
}

// runInShim runs argv through the test binary acting as the lease shim, as the exec
// identity, and returns its combined output. The working directory is / because the
// package directory need not be traversable by uid 7000.
func runInShim(t *testing.T, home string, argv ...string) string {
	t.Helper()
	args := append([]string{ShimArg, testExecID, testExecID, home, "--"}, argv...)
	cmd := exec.Command(os.Args[0], args...)
	cmd.Dir = "/"
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("shim %v: %v\n%s", argv, err, out)
	}
	return string(out)
}

func TestShimDropsToTheExecUserWithNoPrivileges(t *testing.T) {
	requireRootCgroupV2(t)
	home := t.TempDir()
	out := runInShim(t, home, "bash", "-c",
		`echo "uid=$(id -u)"; echo "gid=$(id -g)"; echo "groups=$(id -G)"; echo "home=$HOME"; `+
			`grep -E '^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):' /proc/self/status`)

	got := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if k, v, ok := strings.Cut(line, "="); ok && !strings.Contains(k, ":") {
			got[k] = v
			continue
		}
		if k, v, ok := strings.Cut(line, ":"); ok {
			got[k] = strings.TrimSpace(v)
		}
	}
	want := map[string]string{
		"uid":        testExecID,
		"gid":        testExecID,
		"groups":     testExecID,
		"home":       home,
		"CapInh":     "0000000000000000",
		"CapPrm":     "0000000000000000",
		"CapEff":     "0000000000000000",
		"CapBnd":     "0000000000000000",
		"CapAmb":     "0000000000000000",
		"NoNewPrivs": "1",
		"Seccomp":    "2",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q\nfull output:\n%s", k, got[k], v, out)
		}
	}
}

// The shim must clear the inheritable set itself, not rely on the agent starting with
// it empty: CapInh survives setresuid and execve. AmbientCaps makes Go raise
// CAP_NET_BIND_SERVICE in the shim's permitted, inheritable and ambient sets before it
// execs the test binary, and root's execve keeps the inheritable set.
func TestShimClearsAnInheritedCapabilitySet(t *testing.T) {
	requireRootCgroupV2(t)
	args := []string{ShimArg, testExecID, testExecID, t.TempDir(), "--",
		"grep", "-E", "^(CapInh|CapAmb):", "/proc/self/status"}
	cmd := exec.Command(os.Args[0], args...)
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{AmbientCaps: []uintptr{unix.CAP_NET_BIND_SERVICE}}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("shim: %v\n%s", err, out)
	}
	for _, want := range []string{"CapInh:\t0000000000000000", "CapAmb:\t0000000000000000"} {
		if !strings.Contains(string(out), want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}

	// The setup above must actually hand the shim a non-empty inheritable set, or the
	// assertion is vacuous: the same launch without the shim shows it.
	probe := exec.Command("grep", "^CapInh:", "/proc/self/status")
	probe.SysProcAttr = &syscall.SysProcAttr{AmbientCaps: []uintptr{unix.CAP_NET_BIND_SERVICE}}
	pout, err := probe.CombinedOutput()
	if err != nil {
		t.Fatalf("probe: %v\n%s", err, pout)
	}
	if strings.Contains(string(pout), "0000000000000000") {
		t.Fatalf("AmbientCaps did not raise CapInh, so this test proves nothing: %s", pout)
	}
}

// Every call targets the caller itself, which an unfiltered process may do: TRACEME
// needs no tracer privilege and reading one's own memory passes the ptrace access
// check. So EPERM here is the filter's doing, not the uid drop's.
const ptraceAndProcessVMScript = `
import ctypes, os
libc = ctypes.CDLL(None, use_errno=True)
class iovec(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]
r = libc.ptrace(0, 0, None, None)
print("ptrace", r, ctypes.get_errno() if r == -1 else 0)
src = ctypes.create_string_buffer(b"lease", 8)
dst = ctypes.create_string_buffer(8)
local = iovec(ctypes.cast(dst, ctypes.c_void_p), 8)
remote = iovec(ctypes.cast(src, ctypes.c_void_p), 8)
libc.process_vm_readv.restype = ctypes.c_ssize_t
ctypes.set_errno(0)
r = libc.process_vm_readv(os.getpid(), ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
print("process_vm_readv", r, ctypes.get_errno() if r == -1 else 0)
libc.process_vm_writev.restype = ctypes.c_ssize_t
ctypes.set_errno(0)
r = libc.process_vm_writev(os.getpid(), ctypes.byref(remote), 1, ctypes.byref(local), 1, 0)
print("process_vm_writev", r, ctypes.get_errno() if r == -1 else 0)
libc.syscall.restype = ctypes.c_long
pidfd = libc.syscall(434, os.getpid(), 0)  # pidfd_open (434 on amd64 and arm64)
ctypes.set_errno(0)
r = libc.syscall(438, pidfd, 0, 0)  # pidfd_getfd(pidfd, fd 0, 0)
print("pidfd_getfd", r, ctypes.get_errno() if r == -1 else 0)
`

func TestShimSeccompDeniesPtraceAndProcessVM(t *testing.T) {
	requireRootCgroupV2(t)
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("needs python3")
	}
	out := runInShim(t, t.TempDir(), "python3", "-c", ptraceAndProcessVMScript)
	for _, want := range []string{"ptrace -1 1", "process_vm_readv -1 1", "process_vm_writev -1 1", "pidfd_getfd -1 1"} { // errno 1 = EPERM
		if !strings.Contains(out, want+"\n") {
			t.Errorf("output lacks %q (want EPERM):\n%s", want, out)
		}
	}
}

func TestShimSetuidBinaryDoesNotRegainRoot(t *testing.T) {
	requireRootCgroupV2(t)
	dir := t.TempDir()
	if mountIsNosuid(t, dir) {
		t.Skipf("%s is on a nosuid mount, so a setuid bit proves nothing there", dir)
	}
	// t.TempDir and its parent are 0700 root; uid 7000 must traverse them to exec.
	for _, d := range []string{filepath.Dir(dir), dir} {
		if err := os.Chmod(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	id := filepath.Join(dir, "id")
	copyFile(t, "/usr/bin/id", id)
	if err := os.Chown(id, 0, 0); err != nil {
		t.Fatal(err)
	}
	// After the chown: chown clears the setuid bit.
	if err := os.Chmod(id, os.ModeSetuid|0o755); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(id); err != nil || fi.Mode()&os.ModeSetuid == 0 {
		t.Fatalf("%s is not setuid: %v %v", id, fi.Mode(), err)
	}
	// id -u prints the effective uid, which a honoured setuid bit would make 0.
	if out := strings.TrimSpace(runInShim(t, t.TempDir(), id, "-u")); out != testExecID {
		t.Errorf("setuid-root id -u printed euid %q, want %s", out, testExecID)
	}
}

func TestSeccompFilterRefusesUnknownArch(t *testing.T) {
	if _, err := seccompFilter("mips"); err == nil {
		t.Error("seccompFilter(\"mips\") returned no error")
	}
	for _, arch := range []string{"amd64", "arm64"} {
		if p, err := seccompFilter(arch); err != nil || len(p) == 0 {
			t.Errorf("seccompFilter(%q) = %d instructions, %v", arch, len(p), err)
		}
	}
}

// seccompFilter spells the denied syscall numbers out per arch, because x/sys only
// defines SYS_* for the arch it is built for. This pins those literals to x/sys for the
// arch under test, so a typo cannot quietly allow ptrace.
func TestSeccompFilterDeniesTheBuildArchSyscalls(t *testing.T) {
	prog, err := seccompFilter(runtime.GOARCH)
	if err != nil {
		t.Skipf("no filter for %s: %v", runtime.GOARCH, err)
	}
	compared := map[uint32]bool{}
	for _, ins := range prog {
		if ins.Code == unix.BPF_JMP|unix.BPF_JEQ|unix.BPF_K {
			compared[ins.K] = true
		}
	}
	for name, nr := range map[string]uint32{
		"ptrace":            unix.SYS_PTRACE,
		"process_vm_readv":  unix.SYS_PROCESS_VM_READV,
		"process_vm_writev": unix.SYS_PROCESS_VM_WRITEV,
		"pidfd_getfd":       unix.SYS_PIDFD_GETFD,
	} {
		if !compared[nr] {
			t.Errorf("filter for %s never compares nr with %s (%d)", runtime.GOARCH, name, nr)
		}
	}
}

func TestShimArgsRejectAnEmptyHomeOrCommand(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"empty home", []string{"7000", "7000", "", "--", "true"}},
		{"empty argv[0]", []string{"7000", "7000", "/tmp/sbx-home", "--", ""}},
		{"no argv", []string{"7000", "7000", "/tmp/sbx-home", "--"}},
		{"root uid", []string{"0", "7000", "/tmp/sbx-home", "--", "true"}},
		{"no separator", []string{"7000", "7000", "/tmp/sbx-home", "true", "x"}},
	} {
		if _, _, _, _, err := parseShimArgs(tc.args); err == nil {
			t.Errorf("%s: parseShimArgs(%q) accepted it", tc.name, tc.args)
		}
	}
	if _, _, _, _, err := parseShimArgs([]string{"7000", "7000", "/tmp/sbx-home", "--", "true"}); err != nil {
		t.Errorf("valid args rejected: %v", err)
	}
	// The same check must be what the shim process does: step "args", exit 127.
	cmd := exec.Command(os.Args[0], ShimArg, "7000", "7000", "", "--", "true")
	out, err := cmd.CombinedOutput()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 127 || !strings.Contains(string(out), "guest-agent: lease-shim: args: ") {
		t.Errorf("shim with an empty home: err %v, output %q; want exit 127 at step args", err, out)
	}
}

func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	in, err := os.Open(src)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
}

// mountIsNosuid reports whether path's mount (the longest mount point that prefixes
// it in /proc/self/mountinfo) carries the nosuid per-mount option.
func mountIsNosuid(t *testing.T, path string) bool {
	t.Helper()
	path, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	best, nosuid := "", false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		// Fields: id parent major:minor root mountpoint options ...
		fields := strings.Fields(sc.Text())
		if len(fields) < 6 {
			continue
		}
		mp := fields[4]
		if mp != "/" && path != mp && !strings.HasPrefix(path, mp+"/") {
			continue
		}
		if len(mp) >= len(best) {
			best = mp
			nosuid = false
			for _, o := range strings.Split(fields[5], ",") {
				if o == "nosuid" {
					nosuid = true
				}
			}
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return nosuid
}

// newLeaseAgent starts an Agent in lease mode on a per-test cgroup root,
// /sys/fs/cgroup/moca-ga-test-<random>, which t.Cleanup removes after the agent is
// closed. It returns the agent and that root. The workspace is a tmpfs of its own,
// as /workspace is a mount in a guest: the first lease request remounts it nodev,nosuid.
// The user-namespace sysctl that request writes is a scratch file here, so the suite
// does not change the test host (TestLeaseFirstRequestDisablesUserNamespaces checks the
// real one). The workspace and HOME are made traversable, because t.TempDir and its
// parent are 0700 root and the Exec runs as 7000.
func newLeaseAgent(t *testing.T) (*Agent, string) {
	t.Helper()
	requireRootCgroupV2(t)
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	root := "/sys/fs/cgroup/moca-ga-test-" + hex.EncodeToString(b[:])
	t.Cleanup(func() { removeCgroupTree(t, root) })

	sysctl := filepath.Join(t.TempDir(), "max_user_namespaces")
	if err := os.WriteFile(sysctl, []byte("15000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	origSysctl := userNamespacesSysctl
	userNamespacesSysctl = sysctl
	t.Cleanup(func() { userNamespacesSysctl = origSysctl })

	work := t.TempDir()
	homeParent := t.TempDir()
	if err := unix.Mount("tmpfs", work, "tmpfs", 0, "size=4m,mode=0755"); err != nil {
		t.Fatalf("mount tmpfs workspace: %v", err)
	}
	// Registered before the agent's Close, so it runs after it (cleanups are LIFO).
	t.Cleanup(func() {
		if err := unix.Unmount(work, unix.MNT_DETACH); err != nil {
			t.Errorf("unmount workspace %s: %v", work, err)
		}
	})
	for _, d := range []string{filepath.Dir(work), work, homeParent} {
		if err := os.Chmod(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	id, _ := strconv.Atoi(testExecID)
	a, err := NewAgent(AgentOptions{
		WorkDir: work, ScratchDir: t.TempDir(),
		Lease: LeaseOptions{CgroupRoot: root, UID: id, GID: id, Home: filepath.Join(homeParent, "home"), ShimPath: os.Args[0]},
	})
	if err != nil {
		t.Fatalf("NewAgent: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return a, root
}

// removeCgroupTree removes root's per-Exec cgroups, then root. A cgroup left by a
// failed teardown may take a moment to empty after its cgroup.kill, so it retries.
func removeCgroupTree(t *testing.T, root string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		subs, _ := filepath.Glob(filepath.Join(root, "e*"))
		for _, s := range subs {
			_ = os.WriteFile(filepath.Join(s, "cgroup.kill"), []byte("1"), 0)
			_ = os.Remove(s)
		}
		err := os.Remove(root)
		if err == nil || errors.Is(err, os.ErrNotExist) {
			return
		}
		if time.Now().After(deadline) {
			t.Errorf("removing test cgroup %s: %v", root, err)
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func leaseReq(cmd string) Request { return Request{Command: cmd, Lease: true, CapBytes: 1 << 20} }

// procsMatching lists the live processes whose space-joined cmdline matches re and,
// if uid >= 0, whose real uid is uid. A zombie has an empty cmdline, so it never matches.
func procsMatching(t *testing.T, re *regexp.Regexp, uid int) []string {
	t.Helper()
	dirs, err := filepath.Glob("/proc/[0-9]*")
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, d := range dirs {
		raw, err := os.ReadFile(filepath.Join(d, "cmdline"))
		if err != nil || len(raw) == 0 {
			continue
		}
		cmd := strings.TrimSpace(strings.ReplaceAll(string(raw), "\x00", " "))
		if !re.MatchString(cmd) {
			continue
		}
		if uid >= 0 && procUID(d) != uid {
			continue
		}
		out = append(out, filepath.Base(d)+": "+cmd)
	}
	return out
}

func procUID(procDir string) int {
	st, err := os.ReadFile(filepath.Join(procDir, "status"))
	if err != nil {
		return -1
	}
	for _, line := range strings.Split(string(st), "\n") {
		if f := strings.Fields(line); len(f) >= 2 && f[0] == "Uid:" {
			n, _ := strconv.Atoi(f[1])
			return n
		}
	}
	return -1
}

func TestLeaseKillsEveryProcessTheExecStarted(t *testing.T) {
	a, root := newLeaseAgent(t)
	out, stderr, end, errMsg := drive(t, a, leaseReq(
		`sleep 300 & setsid sleep 301 & nohup sleep 302 >/dev/null 2>&1 & (sleep 303 &); ( setsid bash -c 'sleep 304 &' ); echo started`), nil)
	if errMsg != "" || end.ExitCode != 0 || out != "started\n" {
		t.Fatalf("end %+v, err %q, stdout %q, stderr %q", end, errMsg, out, stderr)
	}
	// Checked at once, not polled: the cgroup must be empty BEFORE End goes out.
	if left := procsMatching(t, regexp.MustCompile(`^sleep 30[0-4]$`), -1); len(left) > 0 {
		t.Errorf("processes the Exec started survived its End: %v", left)
	}
	if _, err := os.Stat(filepath.Join(root, "e1")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("%s/e1 still exists after End (stat err %v)", root, err)
	}
}

func TestLeaseEndDoesNotWaitForABackgroundPipeHolder(t *testing.T) {
	a, _ := newLeaseAgent(t)
	start := time.Now()
	out, _, end, errMsg := drive(t, a, leaseReq(`sleep 300 & echo hi`), nil)
	if el := time.Since(start); el > 5*time.Second {
		t.Fatalf("End took %s: it waited on the background job holding stdout", el)
	}
	if errMsg != "" || end.ExitCode != 0 || out != "hi\n" {
		t.Fatalf("end %+v, err %q, stdout %q", end, errMsg, out)
	}
}

// setChildSubreaperForTheRestOfTheBinary makes the test process a child subreaper, so
// an Exec's orphans reparent to it as they would to the agent as PID 1 in a guest.
// It cannot safely be unset (orphans already reparented would be left to whoever
// clears it), so it stays set for the rest of the test binary's life. Later tests are
// unaffected: os/exec waits on its own children by pidfd, and orphans of later tests
// become at worst zombies of this short-lived process.
func setChildSubreaperForTheRestOfTheBinary(t *testing.T) {
	t.Helper()
	if err := unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0); err != nil {
		t.Fatalf("PR_SET_CHILD_SUBREAPER: %v", err)
	}
}

// zombieChildren lists this process's children in state Z.
func zombieChildren(t *testing.T) []string {
	t.Helper()
	dirs, err := filepath.Glob("/proc/[0-9]*")
	if err != nil {
		t.Fatal(err)
	}
	self := os.Getpid()
	var out []string
	for _, d := range dirs {
		st, err := os.ReadFile(filepath.Join(d, "stat"))
		if err != nil {
			continue
		}
		// pid (comm) state ppid ...; comm may contain spaces and parentheses.
		i := strings.LastIndexByte(string(st), ')')
		if i < 0 {
			continue
		}
		f := strings.Fields(string(st[i+1:]))
		if len(f) < 2 || f[0] != "Z" {
			continue
		}
		if ppid, _ := strconv.Atoi(f[1]); ppid == self {
			out = append(out, string(st[:i+1]))
		}
	}
	return out
}

func TestLeaseReapsOrphansAndKeepsTheExitCode(t *testing.T) {
	requireRootCgroupV2(t)
	setChildSubreaperForTheRestOfTheBinary(t)
	a, _ := newLeaseAgent(t)
	for i := range 20 {
		_, stderr, end, errMsg := drive(t, a, leaseReq(`for i in 1 2 3; do sleep 100 & done; exit 7`), nil)
		if errMsg != "" || end.ExitCode != 7 {
			t.Fatalf("request %d: end %+v, err %q, stderr %q; want exit 7", i, end, errMsg, stderr)
		}
	}
	// The cgroup empties before the last orphans finish reparenting (cgroup_exit runs
	// before exit_notify), so their SIGCHLD can land just after End: allow the reaper
	// that moment, but no more.
	deadline := time.Now().Add(2 * time.Second)
	for {
		z := zombieChildren(t)
		if len(z) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d unreaped zombie children of the test process: %v", len(z), z)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestLeaseRunsEachExecInAFreshShell(t *testing.T) {
	a, _ := newLeaseAgent(t)
	if _, stderr, end, errMsg := drive(t, a, leaseReq(`export FOO=1; cd /; alias x=y; f(){ :; }`), nil); errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("request 1: end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	out, stderr, end, errMsg := drive(t, a, leaseReq(`echo "${FOO-unset}"; pwd; type f >/dev/null 2>&1 && echo has-f || echo no-f`), nil)
	if errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("request 2: end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	if want := "unset\n" + a.WorkDir() + "\nno-f\n"; out != want {
		t.Errorf("request 2 stdout %q, want %q: state leaked from request 1", out, want)
	}
}

func TestLeaseExecCannotLeaveOrTouchTheCgroupTree(t *testing.T) {
	a, root := newLeaseAgent(t)
	out, stderr, end, errMsg := drive(t, a, leaseReq(fmt.Sprintf(
		`echo $$ > %[1]s/cgroup.procs 2>/dev/null; echo procs=$?; mkdir %[1]s/evil 2>/dev/null; echo mkdir=$?; kill -STOP %[2]d 2>/dev/null; echo kill=$?`,
		root, os.Getpid())), nil)
	if errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	for _, step := range []string{"procs", "mkdir", "kill"} {
		m := regexp.MustCompile(`(?m)^` + step + `=(\d+)$`).FindStringSubmatch(out)
		if m == nil || m[1] == "0" {
			t.Errorf("%s: exit status %v, want non-zero\n%s", step, m, out)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "evil")); err == nil {
		t.Errorf("the Exec created %s/evil", root)
	}

	out, stderr, end, errMsg = drive(t, a, leaseReq(fmt.Sprintf(`echo $$; echo ---; cat %[1]s/e2/cgroup.procs; echo ---; cat %[1]s/cgroup.procs`, root)), nil)
	if errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("second Exec: end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	parts := strings.Split(out, "---\n")
	if len(parts) != 3 {
		t.Fatalf("second Exec output %q", out)
	}
	pid := strings.TrimSpace(parts[0])
	if !slicesContainsLine(parts[1], pid) {
		t.Errorf("pid %s is not in %s/e2/cgroup.procs (%q)", pid, root, parts[1])
	}
	if slicesContainsLine(parts[2], pid) {
		t.Errorf("pid %s is in %s/cgroup.procs, the root", pid, root)
	}
}

func slicesContainsLine(text, line string) bool {
	for _, l := range strings.Split(text, "\n") {
		if strings.TrimSpace(l) == line {
			return true
		}
	}
	return false
}

func TestLeaseTimeoutKillsTheCgroupAndKeepsTheAgent(t *testing.T) {
	a, _ := newLeaseAgent(t)
	req := leaseReq(`sleep 30 & sleep 30`)
	req.TimeoutS = 1
	if _, _, _, errMsg := drive(t, a, req, nil); errMsg != "timeout:1" {
		t.Fatalf("error %q, want timeout:1", errMsg)
	}
	// uid 7000 only: earlier parked-shell timeout tests in this binary leave root-owned
	// `sleep 30`s running for half a minute, and they are not this Exec's.
	if left := procsMatching(t, regexp.MustCompile(`^sleep 30$`), 7000); len(left) > 0 {
		t.Errorf("the timed-out Exec's processes survived: %v", left)
	}
	if out, _, end, errMsg := drive(t, a, leaseReq(`echo ok`), nil); errMsg != "" || end.ExitCode != 0 || out != "ok\n" {
		t.Fatalf("lease request after a timeout: end %+v, err %q, stdout %q", end, errMsg, out)
	}
}

func TestLeaseTeardownFailureMarksTheAgentDead(t *testing.T) {
	a, _ := newLeaseAgent(t)
	orig := waitCgroupEmpty
	waitCgroupEmpty = func(*execCgroup, time.Duration) error { return errors.New("injected: still populated") }
	t.Cleanup(func() { waitCgroupEmpty = orig })

	_, _, end, errMsg := drive(t, a, leaseReq(`echo hi; exit 3`), nil)
	if errMsg != "" || !end.TeardownFailed || end.ExitCode != 3 {
		t.Fatalf("end %+v, err %q; want teardown_failed with the command's exit 3", end, errMsg)
	}
	if _, _, _, errMsg := drive(t, a, leaseReq(`true`), nil); !strings.Contains(errMsg, "teardown failed") {
		t.Fatalf("next request's error %q, want it to say teardown failed", errMsg)
	}
}

func TestLeaseStdinWritesAFileAsTheExecUser(t *testing.T) {
	a, _ := newLeaseAgent(t)
	id, _ := strconv.Atoi(testExecID)
	if err := os.Chown(a.WorkDir(), id, id); err != nil {
		t.Fatal(err)
	}
	req := leaseReq(`base64 -d > f`)
	req.HasStdin = true
	if _, stderr, end, errMsg := drive(t, a, req, []byte("aGk=")); errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	path := filepath.Join(a.WorkDir(), "f")
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "hi" {
		t.Fatalf("f = %q, %v; want hi", got, err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st := fi.Sys().(*syscall.Stat_t); int(st.Uid) != id || int(st.Gid) != id {
		t.Errorf("f owned by %d:%d, want %d:%d", st.Uid, st.Gid, id, id)
	}
}

func TestLeaseLatchRefusesPerExecAfterTheFirstLease(t *testing.T) {
	a, _ := newLeaseAgent(t)
	if _, _, end, errMsg := drive(t, a, leaseReq(`true`), nil); errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("lease true: end %+v, err %q", end, errMsg)
	}
	_, _, _, errMsg := drive(t, a, Request{Command: "true", CapBytes: 1 << 20}, nil)
	if want := "guest-agent: this agent serves lease requests only"; errMsg != want {
		t.Fatalf("per-Exec request after a lease: error %q, want %q", errMsg, want)
	}
}

func TestLeaseLatchIsNotSetByPerExecRequests(t *testing.T) {
	a, _ := newLeaseAgent(t)
	pid := a.ShellPID()
	for i := range 2 {
		if _, _, end, errMsg := drive(t, a, Request{Command: "true", CapBytes: 1 << 20}, nil); errMsg != "" || end.ExitCode != 0 {
			t.Fatalf("per-Exec request %d: end %+v, err %q", i, end, errMsg)
		}
	}
	if a.leaseOn.Load() {
		t.Error("a per-Exec request set the lease latch")
	}
	if a.lease.r.Load() != nil {
		t.Error("a per-Exec request started the reaper")
	}
	if a.ShellPID() != pid {
		t.Errorf("ShellPID changed %d -> %d", pid, a.ShellPID())
	}
}

// The workspace newLeaseAgent makes is root-owned and 0755, so `touch` as 7000 fails
// unless normalisation ran first, and before the Exec.
func TestLeaseNormaliseWorkspaceHandsTheWorkspaceToTheExecUser(t *testing.T) {
	a, _ := newLeaseAgent(t)
	req := leaseReq(`touch f`)
	req.NormaliseWorkspace = true
	if _, stderr, end, errMsg := drive(t, a, req, nil); errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	id, _ := strconv.Atoi(testExecID)
	for _, p := range []string{a.WorkDir(), filepath.Join(a.WorkDir(), "f")} {
		var st unix.Stat_t
		if err := unix.Lstat(p, &st); err != nil {
			t.Fatal(err)
		}
		if int(st.Uid) != id || int(st.Gid) != id {
			t.Errorf("%s owned by %d:%d, want %d:%d", p, st.Uid, st.Gid, id, id)
		}
	}
}

// Not root-only: the first request's remount fails on the missing workspace before any
// cgroup or shim work, so the agent need not have been prepared for lease mode.
func TestLeaseFirstRequestRemountFailureDoesNotSetTheLatch(t *testing.T) {
	a := newTestAgent(t)
	a.opts.Lease.CgroupRoot = "/nonexistent/moca-ga-test"
	a.opts.WorkDir = filepath.Join(t.TempDir(), "missing")
	req := leaseReq(`true`)
	req.NormaliseWorkspace = true
	_, _, _, errMsg := drive(t, a, req, nil)
	if want := "guest-agent: lease: remount workspace nodev,nosuid: " + a.opts.WorkDir + ": "; !strings.HasPrefix(errMsg, want) {
		t.Fatalf("error %q, want it to start %q", errMsg, want)
	}
	if a.leaseOn.Load() {
		t.Error("a failed lease request set the lease latch")
	}
}

// A workspace mounted read-only lets the first request's remount and sysctl write
// through, then fails the normalise walk's first chown with EROFS. The latch must stay
// unset, and once the workspace is writable again the next request runs.
func TestLeaseNormaliseWorkspaceFailureDoesNotSetTheLatch(t *testing.T) {
	a, _ := newLeaseAgent(t)
	ws := a.WorkDir()
	if err := unix.Mount("", ws, "", unix.MS_REMOUNT|unix.MS_BIND|unix.MS_RDONLY, ""); err != nil {
		t.Fatalf("remount ro: %v", err)
	}
	req := leaseReq(`true`)
	req.NormaliseWorkspace = true
	_, _, _, errMsg := drive(t, a, req, nil)
	if want := "normalise workspace: " + ws + ": "; !strings.HasPrefix(errMsg, want) {
		t.Fatalf("error %q, want it to start %q", errMsg, want)
	}
	if a.leaseOn.Load() {
		t.Error("a failed normalisation set the lease latch")
	}
	if err := unix.Mount("", ws, "", unix.MS_REMOUNT|unix.MS_BIND, ""); err != nil {
		t.Fatalf("remount rw: %v", err)
	}
	if _, stderr, end, errMsg := drive(t, a, req, nil); errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("retry: end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	if !a.leaseOn.Load() {
		t.Error("the successful retry did not set the lease latch")
	}
}

// mountOptions returns the per-mount options of the mount at exactly mountPoint, from
// /proc/self/mountinfo (field 6), or fails the test if there is none.
func mountOptions(t *testing.T, mountPoint string) []string {
	t.Helper()
	raw, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		t.Fatal(err)
	}
	var opts []string
	for _, line := range strings.Split(string(raw), "\n") {
		if f := strings.Fields(line); len(f) >= 6 && f[4] == mountPoint {
			opts = strings.Split(f[5], ",") // the last match is the top of the stack
		}
	}
	if opts == nil {
		t.Fatalf("no mount at %s in /proc/self/mountinfo", mountPoint)
	}
	return opts
}

// Spec §3.3, no route back to root: a device node in the workspace (root left it, or
// a per-Exec run made it) is removed before the Exec uid is handed the tree, and the
// workspace is remounted nodev,nosuid with its other options kept.
func TestLeaseFirstRequestRemovesDevicesAndRemountsNoDevNoSuid(t *testing.T) {
	a, _ := newLeaseAgent(t)
	ws := a.WorkDir()
	if err := unix.Mount("", ws, "", unix.MS_REMOUNT|unix.MS_BIND|unix.MS_NOATIME, ""); err != nil {
		t.Fatalf("remount noatime: %v", err)
	}
	null := filepath.Join(ws, "null")
	if err := unix.Mknod(null, unix.S_IFCHR|0o666, int(unix.Mkdev(1, 3))); err != nil {
		t.Fatalf("mknod c 1 3: %v", err)
	}
	blk := filepath.Join(ws, "sub", "blk")
	if err := os.Mkdir(filepath.Dir(blk), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mknod(blk, unix.S_IFBLK|0o600, int(unix.Mkdev(7, 0))); err != nil {
		t.Fatalf("mknod b 7 0: %v", err)
	}
	req := leaseReq(`true`)
	req.NormaliseWorkspace = true
	if _, stderr, end, errMsg := drive(t, a, req, nil); errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	for _, p := range []string{null, blk} {
		if _, err := os.Lstat(p); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s survived normalisation (lstat err %v)", p, err)
		}
	}
	opts := mountOptions(t, ws)
	for _, want := range []string{"rw", "nodev", "nosuid", "noatime"} {
		if !slices.Contains(opts, want) {
			t.Errorf("workspace mount options %v lack %s", opts, want)
		}
	}
}

// The real sysctl, unlike the rest of the suite: the first lease request writes 0 to
// it, a per-Exec request does not. The test host's value is put back afterwards.
func TestLeaseFirstRequestDisablesUserNamespaces(t *testing.T) {
	a, _ := newLeaseAgent(t)
	userNamespacesSysctl = "/proc/sys/user/max_user_namespaces"
	orig, err := os.ReadFile(userNamespacesSysctl)
	if err != nil {
		t.Skipf("no user namespace sysctl: %v", err)
	}
	t.Cleanup(func() {
		if err := os.WriteFile("/proc/sys/user/max_user_namespaces", orig, 0); err != nil {
			t.Errorf("restoring max_user_namespaces to %q: %v", strings.TrimSpace(string(orig)), err)
		}
	})
	if strings.TrimSpace(string(orig)) == "0" {
		if err := os.WriteFile(userNamespacesSysctl, []byte("15000"), 0); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, end, errMsg := drive(t, a, Request{Command: "true", CapBytes: 1 << 20}, nil); errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("per-Exec request: end %+v, err %q", end, errMsg)
	}
	if got, _ := os.ReadFile(userNamespacesSysctl); strings.TrimSpace(string(got)) == "0" {
		t.Fatal("a per-Exec request disabled user namespaces")
	}
	if _, _, end, errMsg := drive(t, a, leaseReq(`true`), nil); errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("lease request: end %+v, err %q", end, errMsg)
	}
	if got, _ := os.ReadFile(userNamespacesSysctl); strings.TrimSpace(string(got)) != "0" {
		t.Errorf("max_user_namespaces is %q after the first lease request, want 0", strings.TrimSpace(string(got)))
	}
	if out, _, _, errMsg := drive(t, a, leaseReq(`unshare -U true 2>/dev/null; echo rc=$?`), nil); errMsg != "" || out == "rc=0\n" {
		t.Errorf("unshare -U in a lease Exec: %q, err %q; want it refused", out, errMsg)
	}
}

// Spec §3.3: every Exec runs with umask 0002. Inside the normalised workspace, whose
// root is setgid, a new directory inherits setgid, so mkdir gives 2775, not 775.
func TestLeaseExecUmaskIs0002(t *testing.T) {
	a, _ := newLeaseAgent(t)
	req := leaseReq(`umask; touch f; mkdir d; stat -c %a f d`)
	req.NormaliseWorkspace = true
	out, stderr, end, errMsg := drive(t, a, req, nil)
	if errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	if want := "0002\n664\n2775\n"; out != want {
		t.Errorf("stdout %q, want %q", out, want)
	}
}

// fd hygiene: the agent's listener, the request connection, the cgroup dir fd and the
// Exec's own pipe ends must not reach an Exec. Only 0, 1 and 2 (and bash's own 255, if
// it opens one) may be open in it. The open listener comes from listenSocket, the
// vsock listener's creation path (AF_UNIX, as the test host may lack vsock): Listen's
// unix: scheme goes through net.Listen, which is close-on-exec regardless.
func TestLeaseExecInheritsOnlyStdio(t *testing.T) {
	a, _ := newLeaseAgent(t)
	lfd, err := listenSocket(unix.AF_UNIX)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = unix.Close(lfd) })
	if err := unix.Bind(lfd, &unix.SockaddrUnix{Name: filepath.Join(t.TempDir(), "agent.sock")}); err != nil {
		t.Fatal(err)
	}
	if err := unix.Listen(lfd, 8); err != nil {
		t.Fatal(err)
	}
	// The shell lists its own fds, not ls's (a pipeline element's $BASHPID is its own
	// pid), and into a file: while a pipe or a $(...) runs, the shell holds its end.
	out, stderr, end, errMsg := drive(t, a, leaseReq(`p=$BASHPID; ls /proc/$p/fd >"$HOME/fdl"; sort -n "$HOME/fdl" | tr '\n' ' '`), nil)
	if errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	if got := strings.TrimSpace(out); got != "0 1 2" && got != "0 1 2 255" {
		t.Errorf("fds open in the Exec: %q, want 0 1 2 (and maybe 255)", got)
	}
}

// listenSocket is listenVsock's socket creation; AF_UNIX stands in for AF_VSOCK, which
// the test host may lack. Not root-only.
func TestListenSocketIsCloseOnExec(t *testing.T) {
	fd, err := listenSocket(unix.AF_UNIX)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	if err != nil {
		t.Fatal(err)
	}
	if flags&unix.FD_CLOEXEC == 0 {
		t.Error("the listening socket lacks FD_CLOEXEC: every lease Exec would inherit the agent's listener")
	}
}

// statOwner returns path's owner and mode bits without following a symlink.
func statOwner(t *testing.T, path string) (uid, gid int, mode uint32) {
	t.Helper()
	var st unix.Stat_t
	if err := unix.Lstat(path, &st); err != nil {
		t.Fatal(err)
	}
	return int(st.Uid), int(st.Gid), st.Mode & 0o7777
}

func TestNormaliseWorkspaceOwnsGroupWritesAndStaysInside(t *testing.T) {
	requireRootCgroupV2(t)
	ws, outside := t.TempDir(), t.TempDir()
	target := filepath.Join(outside, "target")
	if err := os.WriteFile(target, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, "a"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(ws, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, "d", "b"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(ws, "ln")); err != nil {
		t.Fatal(err)
	}
	m := filepath.Join(ws, "m")
	if err := os.Mkdir(m, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mount("tmpfs", m, "tmpfs", 0, "size=1m,mode=0755"); err != nil {
		t.Fatalf("mount tmpfs: %v", err)
	}
	t.Cleanup(func() {
		if err := unix.Unmount(m, unix.MNT_DETACH); err != nil {
			t.Errorf("unmount %s: %v", m, err)
		}
	})
	if err := os.WriteFile(filepath.Join(m, "x"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	// The umask must not decide the starting modes the assertions below build on.
	for p, mode := range map[string]os.FileMode{ws: 0o755, filepath.Join(ws, "a"): 0o644, filepath.Join(ws, "d"): 0o755, filepath.Join(ws, "d", "b"): 0o644} {
		if err := os.Chmod(p, mode); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := normaliseWorkspace(ws, 7000, 7000); err != nil {
		t.Fatalf("normaliseWorkspace: %v", err)
	}

	for rel, wantMode := range map[string]uint32{".": 0o2775, "a": 0o664, "d": 0o2775, "d/b": 0o664} {
		uid, gid, mode := statOwner(t, filepath.Join(ws, rel))
		if uid != 7000 || gid != 7000 {
			t.Errorf("%s owned by %d:%d, want 7000:7000", rel, uid, gid)
		}
		if mode != wantMode {
			t.Errorf("%s mode %04o, want %04o", rel, mode, wantMode)
		}
	}
	if uid, gid, _ := statOwner(t, filepath.Join(ws, "ln")); uid != 7000 || gid != 7000 {
		t.Errorf("ln owned by %d:%d, want 7000:7000", uid, gid)
	}
	if uid, gid, mode := statOwner(t, target); uid != 0 || gid != 0 || mode != 0o644 {
		t.Errorf("symlink target is %d:%d %04o, want 0:0 0644: the walk followed ln", uid, gid, mode)
	}
	for _, p := range []string{m, filepath.Join(m, "x")} {
		if uid, gid, _ := statOwner(t, p); uid != 0 || gid != 0 {
			t.Errorf("%s owned by %d:%d, want 0:0: the walk crossed the mount", p, uid, gid)
		}
	}
}

// A timeout and a failed teardown together must still reach the host as
// teardown_failed: a KindError would be an opaque guest error to vmpool (spec §3.1).
func TestLeaseTimeoutWithTeardownFailureStillReportsTeardownFailed(t *testing.T) {
	a, _ := newLeaseAgent(t)
	orig := waitCgroupEmpty
	waitCgroupEmpty = func(*execCgroup, time.Duration) error { return errors.New("injected: still populated") }
	t.Cleanup(func() { waitCgroupEmpty = orig })

	req := leaseReq(`sleep 30`)
	req.TimeoutS = 1
	_, _, end, errMsg := drive(t, a, req, nil)
	if errMsg != "" || !end.TeardownFailed || end.ExitCode != -1 {
		t.Fatalf("end %+v, err %q; want an End with teardown_failed and exit -1", end, errMsg)
	}
	if _, _, _, errMsg := drive(t, a, leaseReq(`true`), nil); !strings.Contains(errMsg, "teardown failed") {
		t.Fatalf("next request's error %q, want it to say teardown failed", errMsg)
	}
}

// The host aborts an Exec by closing the connection (vmpool's closeConn on ctx.Done).
// The cgroup must be killed then, as on a timeout, and the agent must take the next Exec.
func TestLeaseConnectionCloseKillsTheExec(t *testing.T) {
	a, _ := newLeaseAgent(t)
	host, guest := net.Pipe()
	served := make(chan struct{})
	go func() { _ = a.ServeConn(guest); close(served) }()
	if err := WriteJSON(host, KindRequest, leaseReq(`sleep 30 & sleep 30`)); err != nil {
		t.Fatal(err)
	}
	if err := WriteFrame(host, KindStdinEOF, nil); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	sleeps := regexp.MustCompile(`^sleep 30$`)
	if n := len(procsMatching(t, sleeps, 7000)); n != 2 {
		t.Fatalf("%d `sleep 30`s running as 7000 before the close, want 2: the test would prove nothing", n)
	}
	_ = host.Close()

	deadline := time.Now().Add(6 * time.Second)
	for len(procsMatching(t, sleeps, 7000)) > 0 {
		if time.Now().After(deadline) {
			t.Fatalf("the aborted Exec's processes survived 6 s: %v", procsMatching(t, sleeps, 7000))
		}
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case <-served:
	case <-time.After(6 * time.Second):
		t.Fatal("ServeConn did not return after the host closed the connection")
	}
	if out, _, end, errMsg := drive(t, a, leaseReq(`echo ok`), nil); errMsg != "" || end.ExitCode != 0 || out != "ok\n" {
		t.Fatalf("lease request after an abort: end %+v, err %q, stdout %q", end, errMsg, out)
	}
}

// Close must not wait for a running lease Exec: it once took the lease mutex, which
// runLease holds for the Exec's whole run.
func TestLeaseCloseDoesNotWaitForARunningExec(t *testing.T) {
	a, _ := newLeaseAgent(t)
	req := leaseReq(`sleep 30`)
	req.TimeoutS = 3 // ends the Exec on its own once the reaper is stopped
	done := make(chan struct{})
	go func() { defer close(done); _, _, _, _ = drive(t, a, req, nil) }()
	t.Cleanup(func() { <-done })
	sleeps := regexp.MustCompile(`^sleep 30$`)
	for deadline := time.Now().Add(2 * time.Second); len(procsMatching(t, sleeps, 7000)) == 0; {
		if time.Now().After(deadline) {
			t.Fatal("the Exec never started")
		}
		time.Sleep(10 * time.Millisecond)
	}
	closed := make(chan struct{})
	go func() { _ = a.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Close blocked on the running lease Exec")
	}
}
