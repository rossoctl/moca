package exec_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

func release(t *testing.T, w *wexec.WorkspaceRunner, key string) pb.ReleaseOutcome {
	t.Helper()
	o, err := w.Release(context.Background(), key)
	if err != nil {
		t.Fatalf("Release(%q): %v", key, err)
	}
	return o
}

// #338 on the container tier: a Release of an idle key removes its directory at once, and
// an Exec for the key is refused after, without re-creating the directory.
func TestReleaseRemovesAnIdleWorkspaceAndRefusesTheKey(t *testing.T) {
	w, _ := newWorkspaceRunner(t, wexec.BashRunner{})
	runIn(t, w, "sess-a", "echo a > clone.txt")
	dir := filepath.Join(w.Root, "sess-a")

	if o := release(t, w, "sess-a"); o != pb.ReleaseOutcome_RELEASE_OUTCOME_RELEASED {
		t.Fatalf("Release = %v, want RELEASED", o)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("stat(%s) after Release = %v, want it removed", dir, err)
	}
	var rec recorder
	_, err := w.Run(context.Background(), wexec.Spec{Command: "true", WorkspaceKey: "sess-a"}, &rec)
	if err == nil || !strings.HasPrefix(err.Error(), "released: ") {
		t.Fatalf("Run after Release: err = %v, want a released: refusal", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the refused Exec re-created %s", dir)
	}
	// Other keys are unaffected.
	runIn(t, w, "sess-b", "true")
}

// A Release never cuts a running command: it answers kept_busy, the directory stays while
// the command runs, and it is removed when the command returns, not at Idle.
func TestReleaseDuringARunningExecRemovesTheWorkspaceWhenItReturns(t *testing.T) {
	inner := &specRunner{started: make(chan struct{}), release: make(chan struct{})}
	w, _ := newWorkspaceRunner(t, inner)
	done := make(chan error, 1)
	go func() {
		_, err := w.Run(context.Background(), wexec.Spec{Command: "sleep", WorkspaceKey: "sess-a"}, &recorder{})
		done <- err
	}()
	<-inner.started
	dir := filepath.Join(w.Root, "sess-a")
	if err := os.WriteFile(filepath.Join(dir, "mid"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	if o := release(t, w, "sess-a"); o != pb.ReleaseOutcome_RELEASE_OUTCOME_KEPT_BUSY {
		t.Fatalf("Release during a running Exec = %v, want KEPT_BUSY", o)
	}
	if _, err := os.Stat(filepath.Join(dir, "mid")); err != nil {
		t.Fatalf("the running command's workspace was touched: %v", err)
	}
	close(inner.release)
	if err := <-done; err != nil {
		t.Fatalf("the running Exec failed after a Release: %v", err)
	}
	// Detached when the command returned (the key's path is free at once), the tree
	// removed off the Exec's goroutine.
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s still exists 10s after the Exec returned", dir)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := w.Run(context.Background(), wexec.Spec{Command: "true", WorkspaceKey: "sess-a"}, &recorder{}); err == nil {
		t.Fatal("an Exec after the release was accepted")
	}
}

// A key this process has not run is unknown_key: its directory, if any, is left alone (Root
// is also the shared workspace), and the key is refused all the same.
func TestReleaseOfAnUnknownKeyLeavesTheDiskAndRefusesTheKey(t *testing.T) {
	w, _ := newWorkspaceRunner(t, &specRunner{})
	stray := filepath.Join(w.Root, "sess-x")
	if err := os.MkdirAll(stray, 0o755); err != nil {
		t.Fatal(err)
	}
	if o := release(t, w, "sess-x"); o != pb.ReleaseOutcome_RELEASE_OUTCOME_UNKNOWN_KEY {
		t.Fatalf("Release = %v, want UNKNOWN_KEY", o)
	}
	if _, err := os.Stat(stray); err != nil {
		t.Fatalf("an untracked directory was removed: %v", err)
	}
	if _, err := w.Run(context.Background(), wexec.Spec{Command: "true", WorkspaceKey: "sess-x"}, &recorder{}); err == nil {
		t.Fatal("an Exec for a released unknown key was accepted")
	}
}

// Idempotent, bounded and validated: a second Release is unknown_key; after Idle the key
// is accepted again; an invalid key is refused like Run refuses it.
func TestReleaseIsIdempotentBoundedAndValidated(t *testing.T) {
	w, clock := newWorkspaceRunner(t, &specRunner{})
	runIn(t, w, "sess-a", "true")
	if o := release(t, w, "sess-a"); o != pb.ReleaseOutcome_RELEASE_OUTCOME_RELEASED {
		t.Fatalf("first Release = %v", o)
	}
	if o := release(t, w, "sess-a"); o != pb.ReleaseOutcome_RELEASE_OUTCOME_UNKNOWN_KEY {
		t.Fatalf("second Release = %v, want UNKNOWN_KEY", o)
	}
	clock.t = clock.t.Add(w.Idle + time.Second)
	runIn(t, w, "sess-a", "true")

	if _, err := w.Release(context.Background(), "../x"); err == nil || !strings.HasPrefix(err.Error(), "invalid-workspace-key") {
		t.Fatalf("Release(../x): err = %v, want invalid-workspace-key", err)
	}
}

// A session directory can be a symlink (an image that links /workspace/<sid> to /testbed).
// A Release removes the link, never what it points to: renaming Root/key moves the link
// itself, so a later change that resolved it first (EvalSymlinks, then RemoveAll) would wipe
// the target, and fails here instead.
func TestReleaseOfASymlinkedWorkspaceLeavesItsTarget(t *testing.T) {
	w, _ := newWorkspaceRunner(t, &specRunner{})
	target := t.TempDir()
	kept := filepath.Join(target, "repo-file")
	if err := os.WriteFile(kept, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(w.Root, "sess-l")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	runIn(t, w, "sess-l", "true")

	if o := release(t, w, "sess-l"); o != pb.ReleaseOutcome_RELEASE_OUTCOME_RELEASED {
		t.Fatalf("Release = %v, want RELEASED", o)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("lstat(%s) after Release = %v, want the link gone", link, err)
	}
	if got, err := os.ReadFile(kept); err != nil || string(got) != "keep me" {
		t.Fatalf("the link's target lost %s: %q, %v", kept, got, err)
	}
}

// A Release whose rename fails (here: Root not writable) answers an error, not RELEASED,
// since the directory is still there; the key is refused all the same, and stays tracked,
// so a later Release (or the sweep) finishes the job. vmpool's Release answers the same.
func TestReleaseWhoseDetachFailsAnswersAnErrorNotReleased(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root renames in a read-only directory")
	}
	w, _ := newWorkspaceRunner(t, wexec.BashRunner{})
	runIn(t, w, "sess-d", "echo d > clone.txt")
	dir := filepath.Join(w.Root, "sess-d")
	if err := os.Chmod(w.Root, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(w.Root, 0o755) })

	o, err := w.Release(context.Background(), "sess-d")
	if err == nil || o != pb.ReleaseOutcome_RELEASE_OUTCOME_UNSPECIFIED {
		t.Fatalf("Release with a failing rename = (%v, %v), want (UNSPECIFIED, an error)", o, err)
	}
	// The error travels to the client and the relay's audit: no host path, no OS error text.
	if msg := err.Error(); strings.Contains(msg, "/") || strings.Contains(msg, w.Root) {
		t.Fatalf("Release's error %q names a path; it must be path-free", msg)
	}
	if _, err := os.Stat(filepath.Join(dir, "clone.txt")); err != nil {
		t.Fatalf("the workspace is gone though the rename failed: %v", err)
	}
	var rec recorder
	if _, err := w.Run(context.Background(), wexec.Spec{Command: "true", WorkspaceKey: "sess-d"}, &rec); err == nil ||
		!strings.HasPrefix(err.Error(), "released: ") {
		t.Fatalf("Run after a failed Release: err = %v, want a released: refusal", err)
	}

	if err := os.Chmod(w.Root, 0o755); err != nil {
		t.Fatal(err)
	}
	if o := release(t, w, "sess-d"); o != pb.ReleaseOutcome_RELEASE_OUTCOME_RELEASED {
		t.Fatalf("Release once the rename can succeed = %v, want RELEASED (the key stayed tracked)", o)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("stat(%s) after the retried Release = %v, want it removed", dir, err)
	}
}
