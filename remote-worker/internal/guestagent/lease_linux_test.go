//go:build linux

package guestagent

import (
	"bufio"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"

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

// All three calls target the caller itself, which an unfiltered process may do: TRACEME
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
`

func TestShimSeccompDeniesPtraceAndProcessVM(t *testing.T) {
	requireRootCgroupV2(t)
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("needs python3")
	}
	out := runInShim(t, t.TempDir(), "python3", "-c", ptraceAndProcessVMScript)
	for _, want := range []string{"ptrace -1 1", "process_vm_readv -1 1", "process_vm_writev -1 1"} { // errno 1 = EPERM
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
