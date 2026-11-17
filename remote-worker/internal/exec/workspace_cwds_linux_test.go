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

// fakeProc is a /proc with pids 10 and 11, whose cwd and status reads return what the
// test sets; pid 10's cwd is always readable.
func fakeProc(t *testing.T, cwdErr, statusErr error, status string) (string, func(string) (string, error), func(string) ([]byte, error)) {
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
	readFile := func(p string) ([]byte, error) {
		if statusErr != nil {
			return nil, &fs.PathError{Op: "open", Path: p, Err: statusErr}
		}
		return []byte(status), nil
	}
	return proc, readlink, readFile
}

const ourUID = 1000

func statusWithUID(real, eff int) string {
	return fmt.Sprintf("Name:\tagent\nUmask:\t0022\nState:\tS (sleeping)\nUid:\t%d\t%d\t%d\t%d\nGid:\t0\t0\t0\t0\n",
		real, eff, eff, eff)
}

// How an unreadable cwd link is treated, by cause: an exited process and another user's
// process are skipped; a process of the worker's own uid (non-dumpable, so the link is
// refused) fails the scan, which keeps every empty workspace; so does a refusal whose
// owner cannot be read.
func TestScanCwdsSplitsUnreadableLinksByCause(t *testing.T) {
	for name, tc := range map[string]struct {
		cwdErr, statusErr error
		status            string
		wantErr           bool
	}{
		"exited (ENOENT)":                {cwdErr: syscall.ENOENT},
		"exited (ESRCH)":                 {cwdErr: syscall.ESRCH},
		"another uid (EACCES)":           {cwdErr: syscall.EACCES, status: statusWithUID(0, 0)},
		"another uid (EPERM)":            {cwdErr: syscall.EPERM, status: statusWithUID(2000, 2000)},
		"own uid, non-dumpable (EACCES)": {cwdErr: syscall.EACCES, status: statusWithUID(ourUID, ourUID), wantErr: true},
		"own uid, non-dumpable (EPERM)":  {cwdErr: syscall.EPERM, status: statusWithUID(ourUID, ourUID), wantErr: true},
		"own uid as effective only":      {cwdErr: syscall.EACCES, status: statusWithUID(0, ourUID), wantErr: true},
		"exited before the status read":  {cwdErr: syscall.EACCES, statusErr: syscall.ENOENT},
		"owner unreadable":               {cwdErr: syscall.EACCES, statusErr: syscall.EACCES, wantErr: true},
		"status without a Uid line":      {cwdErr: syscall.EACCES, status: "Name:\tagent\n", wantErr: true},
	} {
		t.Run(name, func(t *testing.T) {
			proc, readlink, readFile := fakeProc(t, tc.cwdErr, tc.statusErr, tc.status)
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

// A real same-uid non-dumpable process: the test binary re-executed as a helper that
// calls prctl(PR_SET_DUMPABLE, 0) and waits in a directory. Its cwd link is refused
// (the worker holds no CAP_SYS_PTRACE), so procCwds must fail rather than skip it.
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
