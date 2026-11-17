//go:build linux

package exec

import (
	"os/exec"
	"path/filepath"
	"testing"
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
