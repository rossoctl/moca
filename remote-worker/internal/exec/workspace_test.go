package exec_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

// specRunner records the Spec it was handed and, if block is set, holds the Exec open
// until release is closed — the "a command is running in this workspace" state a sweep
// must not touch.
type specRunner struct {
	mu      sync.Mutex
	got     []wexec.Spec
	started chan struct{}
	release chan struct{}
}

func (r *specRunner) Run(_ context.Context, s wexec.Spec, _ wexec.Sink) (int32, error) {
	r.mu.Lock()
	r.got = append(r.got, s)
	r.mu.Unlock()
	if r.started != nil {
		close(r.started)
	}
	if r.release != nil {
		<-r.release
	}
	return 0, nil
}

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }

func newWorkspaceRunner(t *testing.T, inner wexec.Runner) (*wexec.WorkspaceRunner, *fakeClock) {
	t.Helper()
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	return &wexec.WorkspaceRunner{
		Root:  t.TempDir(),
		Idle:  time.Hour,
		Inner: inner,
		Now:   clock.now,
	}, clock
}

func runIn(t *testing.T, w *wexec.WorkspaceRunner, key, cmd string) string {
	t.Helper()
	var rec recorder
	code, err := w.Run(context.Background(), wexec.Spec{Command: cmd, WorkspaceKey: key}, &rec)
	if err != nil || code != 0 {
		t.Fatalf("run %q under key %q: code=%d err=%v stderr=%q", cmd, key, code, err, rec.stderr)
	}
	return strings.TrimSpace(string(rec.stdout))
}

func TestWorkspaceKeysSeeDisjointDirectories(t *testing.T) {
	w, _ := newWorkspaceRunner(t, wexec.BashRunner{})

	if got, want := runIn(t, w, "sess-a", "pwd -P"), mustEval(t, filepath.Join(w.Root, "sess-a")); got != want {
		t.Fatalf("sess-a ran in %q, want %q", got, want)
	}
	runIn(t, w, "sess-a", "echo a > clone.txt")
	if got := runIn(t, w, "sess-b", "ls -A"); got != "" {
		t.Fatalf("sess-b sees %q; want an empty directory of its own", got)
	}
	if got := runIn(t, w, "sess-a", "cat clone.txt"); got != "a" {
		t.Fatalf("sess-a lost its file across Execs: got %q", got)
	}
}

func TestEmptyWorkspaceKeyKeepsTheSharedWorkspace(t *testing.T) {
	inner := &specRunner{}
	w, _ := newWorkspaceRunner(t, inner)
	if _, err := w.Run(context.Background(), wexec.Spec{Command: "true"}, &recorder{}); err != nil {
		t.Fatal(err)
	}
	if got := inner.got[0].Dir; got != "" {
		t.Fatalf("empty key set Dir=%q; want the worker's own cwd, unchanged", got)
	}
	entries, _ := os.ReadDir(w.Root)
	if len(entries) != 0 {
		t.Fatalf("empty key created %d entries under the root", len(entries))
	}
}

func TestInvalidWorkspaceKeyIsRefused(t *testing.T) {
	for _, key := range []string{"a/b", "..", ".", ".hidden", "../escape", "-dash", strings.Repeat("k", 129)} {
		t.Run(key, func(t *testing.T) {
			inner := &specRunner{}
			w, _ := newWorkspaceRunner(t, inner)
			_, err := w.Run(context.Background(), wexec.Spec{Command: "true", WorkspaceKey: key}, &recorder{})
			if err == nil || !strings.HasPrefix(err.Error(), "invalid-workspace-key: ") {
				t.Fatalf("key %q: err=%v, want an invalid-workspace-key refusal", key, err)
			}
			if len(inner.got) != 0 {
				t.Fatalf("key %q reached the inner runner", key)
			}
		})
	}
}

func TestSweepReclaimsOnlyIdleWorkspaces(t *testing.T) {
	w, clock := newWorkspaceRunner(t, wexec.BashRunner{})
	runIn(t, w, "old", "touch f")
	clock.t = clock.t.Add(50 * time.Minute)
	runIn(t, w, "recent", "touch f")
	clock.t = clock.t.Add(20 * time.Minute) // old: 70m idle, recent: 20m

	if got := w.Sweep(); len(got) != 1 || got[0] != (wexec.Reclaimed{Key: "old"}) {
		t.Fatalf("Sweep reclaimed %v, want [old]", got)
	}
	if _, err := os.Stat(filepath.Join(w.Root, "old")); !os.IsNotExist(err) {
		t.Fatalf("old workspace still present: %v", err)
	}
	if _, err := os.Stat(filepath.Join(w.Root, "recent", "f")); err != nil {
		t.Fatalf("recent workspace was touched: %v", err)
	}
	entries, _ := os.ReadDir(w.Root)
	if len(entries) != 1 {
		t.Fatalf("root holds %d entries after the sweep, want only recent (tombstone left behind?)", len(entries))
	}

	// A reclaimed key that comes back starts over in a fresh, empty directory.
	if got := runIn(t, w, "old", "ls -A"); got != "" {
		t.Fatalf("returning key sees %q, want an empty directory", got)
	}
}

func TestSweepSkipsAWorkspaceWithARunningExec(t *testing.T) {
	inner := &specRunner{started: make(chan struct{}), release: make(chan struct{})}
	w, clock := newWorkspaceRunner(t, inner)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = w.Run(context.Background(), wexec.Spec{Command: "sleep", WorkspaceKey: "busy"}, &recorder{})
	}()
	<-inner.started

	clock.t = clock.t.Add(2 * time.Hour) // started long ago, still running
	if got := w.Sweep(); len(got) != 0 {
		t.Fatalf("Sweep reclaimed %v while an Exec was running", got)
	}
	close(inner.release)
	<-done

	// Idle is measured from the END of the last Exec, not its start.
	if got := w.Sweep(); len(got) != 0 {
		t.Fatalf("Sweep reclaimed %v the instant the Exec finished", got)
	}
	clock.t = clock.t.Add(time.Hour)
	if got := w.Sweep(); len(got) != 1 {
		t.Fatalf("Sweep reclaimed %v an Idle after the Exec finished, want [busy]", got)
	}
}

// noCwds stands in for the process scan: no live process is in any workspace.
func noCwds() (map[string]struct{}, error) { return nil, nil }

// #551: a session that leaves its directory empty, as a read-only workload run that wrote
// no scratch does, must not leave it on the pod until Idle. Nothing is lost by removing
// it, because Run re-creates it before every Exec.
func TestSweepRemovesAnEmptyWorkspaceAfterEmptyIdle(t *testing.T) {
	w, clock := newWorkspaceRunner(t, wexec.BashRunner{})
	w.Cwds = noCwds
	runIn(t, w, "empty", "true")
	dir := filepath.Join(w.Root, "empty")

	// Literal durations rather than DefaultWorkspaceEmptyIdle, so the default itself is
	// pinned: 15 minutes, long enough to cover a pause between a session's commands.
	clock.t = clock.t.Add(15*time.Minute - time.Second)
	if got := w.Sweep(); len(got) != 0 {
		t.Fatalf("Sweep reclaimed %v inside EmptyIdle", got)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("empty workspace removed inside EmptyIdle: %v", err)
	}

	clock.t = clock.t.Add(time.Second) // at EmptyIdle, well inside Idle (an hour here)
	if got := w.Sweep(); len(got) != 1 || got[0] != (wexec.Reclaimed{Key: "empty", Empty: true}) {
		t.Fatalf("Sweep reclaimed %v, want [{empty true}]", got)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("empty workspace still present past EmptyIdle: %v", err)
	}

	// The session's next Exec runs as before, in its own (re-created) directory.
	if got, want := runIn(t, w, "empty", "pwd -P"), mustEval(t, dir); got != want {
		t.Fatalf("returning key ran in %q, want %q", got, want)
	}
}

func TestDefaultWorkspaceEmptyIdleIsFifteenMinutes(t *testing.T) {
	if wexec.DefaultWorkspaceEmptyIdle != 15*time.Minute {
		t.Fatalf("DefaultWorkspaceEmptyIdle = %s, want 15m", wexec.DefaultWorkspaceEmptyIdle)
	}
}

// EmptyIdle only ever shortens Idle: with Idle the smaller, an empty directory goes at
// Idle, reported as an idle reclaim, and not a moment before.
func TestEmptyIdleAboveIdleIsBoundedByIdle(t *testing.T) {
	w, clock := newWorkspaceRunner(t, wexec.BashRunner{})
	w.Cwds = noCwds
	w.Idle, w.EmptyIdle = 5*time.Minute, time.Hour
	runIn(t, w, "k", "true")

	clock.t = clock.t.Add(5*time.Minute - time.Second)
	if got := w.Sweep(); len(got) != 0 {
		t.Fatalf("Sweep reclaimed %v before Idle", got)
	}
	clock.t = clock.t.Add(time.Second)
	if got := w.Sweep(); len(got) != 1 || got[0] != (wexec.Reclaimed{Key: "k"}) {
		t.Fatalf("Sweep reclaimed %v at Idle, want [{k false}]", got)
	}
}

// The other half of #551, and #338's rule: a directory with anything in it is the
// session's state, and only Idle removes it, however long ago EmptyIdle passed.
func TestSweepKeepsAWorkspaceWithFilesUntilIdle(t *testing.T) {
	for name, cmd := range map[string]string{
		"file":   "echo note > scratch.txt",
		"hidden": "touch .scratch",
		"subdir": "mkdir -p out",
	} {
		t.Run(name, func(t *testing.T) {
			w, clock := newWorkspaceRunner(t, wexec.BashRunner{})
			w.Cwds = noCwds
			runIn(t, w, "live", cmd)
			before, _ := os.ReadDir(filepath.Join(w.Root, "live"))

			clock.t = clock.t.Add(w.Idle - time.Second)
			if got := w.Sweep(); len(got) != 0 {
				t.Fatalf("Sweep reclaimed %v before Idle", got)
			}
			after, err := os.ReadDir(filepath.Join(w.Root, "live"))
			if err != nil || len(after) != len(before) || len(after) == 0 {
				t.Fatalf("workspace with files changed before Idle: %v entries, err=%v", len(after), err)
			}

			clock.t = clock.t.Add(time.Second)
			if got := w.Sweep(); len(got) != 1 || got[0] != (wexec.Reclaimed{Key: "live"}) {
				t.Fatalf("Sweep reclaimed %v at Idle, want [{live false}]", got)
			}
		})
	}
}

// A background child still in an empty workspace (a server started with `nohup … &`, a
// delayed write) keeps it, however long ago the last Exec ended (#551).
// Driven through the Cwds seam so it runs on every platform; the Linux scan itself is
// TestProcCwdsSeesABackgroundChild.
func TestSweepKeepsAnEmptyWorkspaceThatIsAProcessCwd(t *testing.T) {
	w, clock := newWorkspaceRunner(t, wexec.BashRunner{})
	runIn(t, w, "bg", "true")
	dir := mustEval(t, filepath.Join(w.Root, "bg"))
	inside := map[string]struct{}{dir: {}}
	w.Cwds = func() (map[string]struct{}, error) { return inside, nil }

	clock.t = clock.t.Add(2 * wexec.DefaultWorkspaceEmptyIdle)
	if got := w.Sweep(); len(got) != 0 {
		t.Fatalf("Sweep reclaimed %v while a process is in the workspace", got)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("workspace removed under a process: %v", err)
	}
	// The child exits: the next sweep removes it.
	inside = nil
	if got := w.Sweep(); len(got) != 1 || !got[0].Empty {
		t.Fatalf("Sweep reclaimed %v once the process left, want [{bg true}]", got)
	}
}

// A scan that fails keeps every empty workspace for that sweep rather than guess.
func TestSweepKeepsEmptyWorkspacesWhenTheScanFails(t *testing.T) {
	w, clock := newWorkspaceRunner(t, wexec.BashRunner{})
	w.Cwds = func() (map[string]struct{}, error) { return nil, os.ErrPermission }
	runIn(t, w, "k", "true")
	clock.t = clock.t.Add(2 * wexec.DefaultWorkspaceEmptyIdle)
	if got := w.Sweep(); len(got) != 0 {
		t.Fatalf("Sweep reclaimed %v with no process list", got)
	}
}

// A regular file that took the directory's place is not the session's empty workspace,
// and the empty-directory removal leaves it alone (os.Remove would not: it unlinks first).
func TestSweepLeavesAFileThatReplacedTheWorkspace(t *testing.T) {
	w, clock := newWorkspaceRunner(t, wexec.BashRunner{})
	w.Cwds = noCwds
	runIn(t, w, "k", "true")
	dir := filepath.Join(w.Root, "k")
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir, []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}
	clock.t = clock.t.Add(wexec.DefaultWorkspaceEmptyIdle)
	if got := w.Sweep(); len(got) != 0 {
		t.Fatalf("Sweep reclaimed %v; want the file left alone", got)
	}
	if b, err := os.ReadFile(dir); err != nil || string(b) != "not a directory" {
		t.Fatalf("file replaced the workspace and was removed or changed: %q, %v", b, err)
	}
}

// An rmdir refused for another reason than "not empty" (EACCES here: the root is not
// writable) keeps the directory and the key, and the next sweep retries it.
func TestSweepKeepsAnEmptyWorkspaceWhoseRmdirIsRefused(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	w, clock := newWorkspaceRunner(t, wexec.BashRunner{})
	w.Cwds = noCwds
	runIn(t, w, "k", "true")
	if err := os.Chmod(w.Root, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(w.Root, 0o755) })

	clock.t = clock.t.Add(wexec.DefaultWorkspaceEmptyIdle)
	if got := w.Sweep(); len(got) != 0 {
		t.Fatalf("Sweep reclaimed %v though rmdir was refused", got)
	}
	if _, err := os.Stat(filepath.Join(w.Root, "k")); err != nil {
		t.Fatalf("workspace gone after a refused rmdir: %v", err)
	}
	if err := os.Chmod(w.Root, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := w.Sweep(); len(got) != 1 || !got[0].Empty {
		t.Fatalf("retry reclaimed %v, want [{k true}]", got)
	}
}

// An Exec in flight keeps even an empty directory: the command may be about to write there.
func TestSweepKeepsAnEmptyWorkspaceWithARunningExec(t *testing.T) {
	inner := &specRunner{started: make(chan struct{}), release: make(chan struct{})}
	w, clock := newWorkspaceRunner(t, inner)
	w.Cwds = noCwds
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = w.Run(context.Background(), wexec.Spec{Command: "sleep", WorkspaceKey: "busy"}, &recorder{})
	}()
	<-inner.started
	clock.t = clock.t.Add(2 * wexec.DefaultWorkspaceEmptyIdle)
	if got := w.Sweep(); len(got) != 0 {
		t.Fatalf("Sweep reclaimed %v while an Exec was running", got)
	}
	if _, err := os.Stat(filepath.Join(w.Root, "busy")); err != nil {
		t.Fatalf("running Exec's workspace removed: %v", err)
	}
	close(inner.release)
	<-done
}

// mustEval resolves symlinks, since t.TempDir is under /var -> /private/var on macOS and
// `pwd -P` reports the resolved path.
func mustEval(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
