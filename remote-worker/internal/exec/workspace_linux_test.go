//go:build linux

package exec_test

import (
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

// The reviewed scenario end to end, with the real /proc scan: an Exec backgrounds a child
// in a still-empty workspace and returns. Past EmptyIdle the directory stays while the
// child runs, and goes once it has exited.
func TestSweepKeepsAnEmptyWorkspaceWithABackgroundChild(t *testing.T) {
	w, clock := newWorkspaceRunner(t, wexec.BashRunner{})
	pid, err := strconv.Atoi(runIn(t, w, "bg", "nohup sleep 60 >/dev/null 2>&1 & echo $!"))
	if err != nil {
		t.Fatal(err)
	}
	child, _ := os.FindProcess(pid)
	t.Cleanup(func() { _ = child.Kill() })

	clock.t = clock.t.Add(2 * wexec.DefaultWorkspaceEmptyIdle)
	if got := w.Sweep(); len(got) != 0 {
		t.Fatalf("Sweep reclaimed %v while a background child is in the workspace", got)
	}
	if _, err := os.Stat(filepath.Join(w.Root, "bg")); err != nil {
		t.Fatalf("workspace removed under a background child: %v", err)
	}

	_ = child.Signal(syscall.SIGKILL)
	// The child is bash's, not ours, so it cannot be waited for: poll until /proc no
	// longer shows it in the directory (it is reaped by init, or left a zombie with no cwd).
	deadline := time.Now().Add(10 * time.Second)
	for {
		got := w.Sweep()
		if len(got) == 1 && got[0] == (wexec.Reclaimed{Key: "bg", Empty: true}) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Sweep reclaimed %v after the child was killed, want [{bg true}]", got)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
