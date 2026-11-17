//go:build linux

package exec

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The Linux scan sees a real background child's cwd, which is what keeps an empty
// workspace in place while a server or a delayed write still runs there.
func TestProcCwdsSeesABackgroundChild(t *testing.T) {
	SkipIfAProcessHidesItsCwd(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command("sleep", "30")
	child.Dir = dir
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })

	cwds, err := procCwds()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cwds[dir]; !ok {
		t.Fatalf("procCwds does not list %s, the cwd of pid %d", dir, child.Process.Pid)
	}
}

// procFile is one fake /proc file: its content, or the error reading it returns.
type procFile struct {
	data string
	err  error
}

// fakeProc is a /proc with pids 10 and 11 and self. Pid 10's cwd is always readable; pid
// 11's cwd read fails with cwdErr, and its status and cgroup files, and self's cgroup,
// read as given.
func fakeProc(t *testing.T, cwdErr error, status, cgroup, selfCgroup procFile) (string, func(string) (string, error), func(string) ([]byte, error)) {
	t.Helper()
	proc := t.TempDir()
	for _, pid := range []string{"10", "11", "self"} {
		if err := os.Mkdir(filepath.Join(proc, pid), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	readlink := func(p string) (string, error) {
		if filepath.Base(filepath.Dir(p)) == "10" {
			return "/workspace/live", nil
		}
		return "", &fs.PathError{Op: "readlink", Path: p, Err: cwdErr}
	}
	files := map[string]procFile{
		filepath.Join(proc, "11", "status"):   status,
		filepath.Join(proc, "11", "cgroup"):   cgroup,
		filepath.Join(proc, "self", "cgroup"): selfCgroup,
	}
	readFile := func(p string) ([]byte, error) {
		f, ok := files[p]
		if !ok {
			return nil, &fs.PathError{Op: "open", Path: p, Err: syscall.ENOENT}
		}
		if f.err != nil {
			return nil, &fs.PathError{Op: "open", Path: p, Err: f.err}
		}
		return []byte(f.data), nil
	}
	return proc, readlink, readFile
}

const ourUID = 1000

func statusWithUID(real, eff int) procFile {
	return procFile{data: fmt.Sprintf("Name:\tagent\nUmask:\t0022\nState:\tS (sleeping)\nUid:\t%d\t%d\t%d\t%d\nGid:\t0\t0\t0\t0\n",
		real, eff, eff, eff)}
}

// v2 is a cgroup v2 /proc/<pid>/cgroup file for path.
func v2(path string) procFile { return procFile{data: "0::" + path + "\n"} }

// v1 is a pure cgroup v1 file (no unified line) whose name=systemd path is path.
func v1(path string) procFile {
	return procFile{data: "12:memory:/other\n3:cpu,cpuacct:/other\n1:name=systemd:" + path + "\n"}
}

// How an unreadable cwd link is treated, by cause. Skipped: an exited process, another
// user's process, and one of the worker's own uid outside the worker's cgroup subtree (no
// session command can be there). Failing the scan, which keeps every empty workspace: one
// of the worker's own uid (non-dumpable, so the link is refused) in the worker's cgroup
// or below it, every such process when the worker's cgroup is its namespace's root, and
// any refusal whose owner or cgroup cannot be read.
func TestScanCwdsSplitsUnreadableLinksByCause(t *testing.T) {
	own := statusWithUID(ourUID, ourUID)
	self := v2("/kubepods/pod1/worker")
	for name, tc := range map[string]struct {
		cwdErr                    error
		status, cgroup, selfGroup procFile
		wantErr                   bool
	}{
		"exited (ENOENT)":                      {cwdErr: syscall.ENOENT},
		"exited (ESRCH)":                       {cwdErr: syscall.ESRCH},
		"another uid (EACCES)":                 {cwdErr: syscall.EACCES, status: statusWithUID(0, 0)},
		"another uid (EPERM)":                  {cwdErr: syscall.EPERM, status: statusWithUID(2000, 2000)},
		"exited before the status read":        {cwdErr: syscall.EACCES, status: procFile{err: syscall.ENOENT}},
		"owner unreadable":                     {cwdErr: syscall.EACCES, status: procFile{err: syscall.EACCES}, wantErr: true},
		"status without a Uid line":            {cwdErr: syscall.EACCES, status: procFile{data: "Name:\tagent\n"}, wantErr: true},
		"own uid, same cgroup (EACCES)":        {cwdErr: syscall.EACCES, status: own, cgroup: self, selfGroup: self, wantErr: true},
		"own uid, same cgroup (EPERM)":         {cwdErr: syscall.EPERM, status: own, cgroup: self, selfGroup: self, wantErr: true},
		"own uid as effective only":            {cwdErr: syscall.EACCES, status: statusWithUID(0, ourUID), cgroup: self, selfGroup: self, wantErr: true},
		"own uid, below the worker's cgroup":   {cwdErr: syscall.EACCES, status: own, cgroup: v2("/kubepods/pod1/worker/sub"), selfGroup: self, wantErr: true},
		"own uid, outside (a sibling)":         {cwdErr: syscall.EACCES, status: own, cgroup: v2("/kubepods/pod1/agent"), selfGroup: self},
		"own uid, outside (a name prefix)":     {cwdErr: syscall.EACCES, status: own, cgroup: v2("/kubepods/pod1/worker2"), selfGroup: self},
		"own uid, outside (host daemon)":       {cwdErr: syscall.EACCES, status: own, cgroup: v2("/system.slice/agent.service"), selfGroup: v2("/system.slice/runner.service")},
		"own uid, worker at namespace root":    {cwdErr: syscall.EACCES, status: own, cgroup: v2("/anything"), selfGroup: v2("/"), wantErr: true},
		"own uid, outside the namespace (/..)": {cwdErr: syscall.EACCES, status: own, cgroup: v2("/../host.slice/agent"), selfGroup: v2("/")},
		"own uid, v1 host, same cgroup":        {cwdErr: syscall.EACCES, status: own, cgroup: v1("/user.slice/worker"), selfGroup: v1("/user.slice/worker"), wantErr: true},
		"own uid, v1 host, outside":            {cwdErr: syscall.EACCES, status: own, cgroup: v1("/system.slice/agent"), selfGroup: v1("/user.slice/worker")},
		"own uid, exited before cgroup read":   {cwdErr: syscall.EACCES, status: own, cgroup: procFile{err: syscall.ENOENT}, selfGroup: self},
		"own uid, cgroup unreadable":           {cwdErr: syscall.EACCES, status: own, cgroup: procFile{err: syscall.EACCES}, selfGroup: self, wantErr: true},
		"own uid, cgroup unparseable":          {cwdErr: syscall.EACCES, status: own, cgroup: procFile{data: "garbage\n"}, selfGroup: self, wantErr: true},
		"own uid, worker's cgroup unreadable":  {cwdErr: syscall.EACCES, status: own, cgroup: v2("/elsewhere"), selfGroup: procFile{err: syscall.EACCES}, wantErr: true},
	} {
		t.Run(name, func(t *testing.T) {
			proc, readlink, readFile := fakeProc(t, tc.cwdErr, tc.status, tc.cgroup, tc.selfGroup)
			cwds, err := scanCwds(proc, readlink, readFile, ourUID)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("scan succeeded with %v; want an error that keeps every empty workspace", cwds)
				}
				return
			}
			if err != nil {
				t.Fatalf("scan failed: %v; want pid 11 skipped", err)
			}
			if _, ok := cwds["/workspace/live"]; !ok || len(cwds) != 1 {
				t.Fatalf("cwds = %v, want only pid 10's", cwds)
			}
		})
	}
}

// The error a namespace-root worker fails the scan with says why, since it is what an
// operator sees in the log when no empty workspace is reclaimed early.
func TestScanCwdsNamesTheNamespaceRootCase(t *testing.T) {
	proc, readlink, readFile := fakeProc(t, syscall.EACCES, statusWithUID(ourUID, ourUID), v2("/x"), v2("/"))
	_, err := scanCwds(proc, readlink, readFile, ourUID)
	if err == nil || !strings.Contains(err.Error(), "root of its cgroup namespace") {
		t.Fatalf("err = %v; want it to name the cgroup namespace root", err)
	}
	// Typed, so SkipIfAProcessHidesItsCwd can tell it from a broken scan, which is not.
	var hidden *hiddenCwdError
	if !errors.As(err, &hidden) || hidden.pid != "11" {
		t.Fatalf("err = %#v; want a hiddenCwdError for pid 11", err)
	}
	proc, readlink, readFile = fakeProc(t, syscall.EACCES, statusWithUID(ourUID, ourUID), procFile{err: syscall.EACCES}, v2("/"))
	if _, err := scanCwds(proc, readlink, readFile, ourUID); err == nil || errors.As(err, &hidden) {
		t.Fatalf("unreadable cgroup: err = %v; want an error that is not a hiddenCwdError", err)
	}
}

// cgroupPath prefers the unified line, falls back to name=systemd on a pure v1 host, and
// agrees with the kernel: a child started now is in this process's cgroup.
func TestCgroupPathReadsV2AndV1(t *testing.T) {
	for data, want := range map[string]string{
		"0::/a/b\n": "/a/b",
		"12:memory:/m\n1:name=systemd:/s\n0::/u\n": "/u",
		"12:memory:/m\n1:name=systemd:/s\n":        "/s",
	} {
		got, err := cgroupPath(func(string) ([]byte, error) { return []byte(data), nil }, "cgroup")
		if err != nil || got != want {
			t.Errorf("cgroupPath(%q) = %q, %v; want %q", data, got, err, want)
		}
	}
	self, err := cgroupPath(os.ReadFile, "/proc/self/cgroup")
	if err != nil {
		t.Skipf("no usable /proc/self/cgroup here: %v", err)
	}
	child := exec.Command("sleep", "30")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
	got, err := cgroupPath(os.ReadFile, fmt.Sprintf("/proc/%d/cgroup", child.Process.Pid))
	if err != nil || !inCgroupSubtree(got, self) {
		t.Fatalf("child's cgroup %q, %v; want it in this process's %q", got, err, self)
	}
}

// A real same-uid non-dumpable process: the test binary re-executed as a helper that
// calls prctl(PR_SET_DUMPABLE, 0) and waits in a directory. Its cwd link is refused
// (the worker holds no CAP_SYS_PTRACE) and it is in the worker's (this test's) cgroup, so
// it could be a session's child, and procCwds must fail rather than skip it.
func TestProcCwdsFailsOnASameUIDNonDumpableProcess(t *testing.T) {
	if os.Getenv("MOCA_TEST_NONDUMPABLE_HELPER") == "1" {
		const prSetDumpable = 4
		if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetDumpable, 0, 0); errno != 0 {
			os.Exit(3)
		}
		fmt.Println("ready")
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	if os.Geteuid() == 0 {
		t.Skip("root holds CAP_SYS_PTRACE and reads every cwd link")
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestProcCwdsFailsOnASameUIDNonDumpableProcess$")
	child.Dir = dir
	child.Env = append(os.Environ(), "MOCA_TEST_NONDUMPABLE_HELPER=1")
	out, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
	buf := make([]byte, 6)
	if n, err := out.Read(buf); err != nil || !strings.HasPrefix(string(buf[:n]), "ready") {
		t.Fatalf("helper did not become non-dumpable: %q, %v", buf[:n], err)
	}
	if _, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", child.Process.Pid)); !errors.Is(err, fs.ErrPermission) {
		t.Skipf("the helper's cwd link is readable here (%v): this environment grants ptrace read access", err)
	}

	if cwds, err := procCwds(); err == nil {
		t.Fatalf("procCwds = %v, nil; want an error for pid %d", cwds, child.Process.Pid)
	}
}
