package vmpool

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// capturingSink collects both streams. Sink is documented as never called
// concurrently, but the mutex costs nothing and makes -race meaningful if that
// ever regresses.
type capturingSink struct {
	mu     sync.Mutex
	stdout strings.Builder
	stderr strings.Builder
}

func (s *capturingSink) Stdout(b []byte) { s.mu.Lock(); s.stdout.Write(b); s.mu.Unlock() }
func (s *capturingSink) Stderr(b []byte) { s.mu.Lock(); s.stderr.Write(b); s.mu.Unlock() }
func (s *capturingSink) out() string     { s.mu.Lock(); defer s.mu.Unlock(); return s.stdout.String() }

// testPool wires a pool over the fake launcher and fake clock, with WorkspaceRoot
// in t.TempDir() so workspace creation and removal are real filesystem operations.
func testPool(t *testing.T) (Pool, *fakeLauncher, *fakeClock) {
	t.Helper()
	lc := newFakeLauncher()
	p, clk := testPoolWith(t, lc)
	return p, lc, clk
}

// testPoolWith is testPool for a test that needs its own Launcher implementation.
//
// It exists so the launcher goes in through New rather than being assigned afterwards.
// New starts `go p.reclaimLoop()` before it returns, and p.lc is read from warm, which
// that goroutine can reach — so `p.(*pool).lc = lc` after construction WAS an
// unsynchronized write to a field a live goroutine may read. That write would have stayed
// green under -race only because this helper leaves StandbyPerKey unset and the reclaim
// path therefore never reaches warm: a tripwire for whoever gave the helper a standby
// count, surfacing as a flake somewhere else entirely. Passing the launcher to New
// removes it rather than documenting it, so there is no live hazard here to hunt for.
func testPoolWith(t *testing.T, lc Launcher) (Pool, *fakeClock) {
	t.Helper()
	clk := newFakeClock()
	cfg := Config{
		VMM:               lc.Kind(),
		SnapshotDir:       t.TempDir(),
		WorkspaceRoot:     t.TempDir(),
		MaxRuns:           16,
		MaxCommittedBytes: 32 << 30,
	}
	p, err := New(cfg, lc, clk)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p, clk
}

func TestExecRunsOneCommandInAVMAndDestroysIt(t *testing.T) {
	p, lc, _ := testPool(t)
	var out capturingSink

	res, err := p.Exec(context.Background(), "run-a", Exec{ReqID: 1, Command: "echo hi", TimeoutS: 5}, &out)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0", res.ExitCode)
	}
	if got := out.out(); got != "echo hi" {
		t.Fatalf("stdout = %q, want %q", got, "echo hi")
	}
	// Build-step 2's proof, in three parts: a VM was made, it was destroyed, and
	// none is left alive.
	if n := lc.createdCount(); n != 1 {
		t.Errorf("created %d VMs, want 1", n)
	}
	if n := lc.destroyedFor("run-a"); n != 1 {
		t.Errorf("destroyed %d VMs for run-a, want 1", n)
	}
	if n := lc.liveCount(); n != 0 {
		t.Errorf("%d VMs still live after Exec returned, want 0", n)
	}
	if s := p.Stats(); s.InFlight != 0 || s.ActiveRuns != 1 {
		t.Errorf("Stats = %+v, want InFlight 0 and ActiveRuns 1", s)
	}
}

func TestExecCreatesTheRunWorkspaceOnce(t *testing.T) {
	p, lc, _ := testPool(t)
	var dirs []string
	lc.setBeforeRestore(func(r RestoreRequest) { dirs = append(dirs, r.WorkspaceDir) })
	for i := 0; i < 3; i++ {
		if _, err := p.Exec(context.Background(), "run-a", Exec{ReqID: uint64(i), Command: "true"}, &capturingSink{}); err != nil {
			t.Fatalf("Exec %d: %v", i, err)
		}
	}
	if len(dirs) != 3 {
		t.Fatalf("saw %d restores, want 3", len(dirs))
	}
	// Spec §4.3: a mounted VM is bound to ONE workspace, so pools are per-run. All
	// three VMs for one key must see the same host directory, and it must be a real
	// directory on disk — the mount source cannot be a path that does not exist.
	for i, d := range dirs {
		if d != dirs[0] {
			t.Fatalf("restore %d bound %q, want %q", i, d, dirs[0])
		}
	}
	if fi, err := osStat(dirs[0]); err != nil || !fi.IsDir() {
		t.Fatalf("workspace %q: stat err=%v isDir=%v", dirs[0], err, err == nil && fi.IsDir())
	}
}

func TestExecKeepsRunsInSeparateWorkspaces(t *testing.T) {
	p, lc, _ := testPool(t)
	seen := map[string]string{}
	lc.setBeforeRestore(func(r RestoreRequest) { seen[r.Key] = r.WorkspaceDir })
	for _, k := range []string{"run-a", "run-b"} {
		if _, err := p.Exec(context.Background(), k, Exec{Command: "true"}, &capturingSink{}); err != nil {
			t.Fatalf("Exec %s: %v", k, err)
		}
	}
	if seen["run-a"] == "" || seen["run-a"] == seen["run-b"] {
		t.Fatalf("run-a=%q run-b=%q: per-run workspaces must differ (spec §3.4)", seen["run-a"], seen["run-b"])
	}
}

func TestExecRefusesAKeyThatCouldEscapeTheWorkspaceRoot(t *testing.T) {
	p, lc, _ := testPool(t)
	for _, k := range []string{"../etc", "a/b", "..", "run a", "run\x00a", ".hidden", strings.Repeat("x", 200)} {
		_, err := p.Exec(context.Background(), k, Exec{Command: "true"}, &capturingSink{})
		if err == nil {
			t.Fatalf("Exec accepted workspace_key %q", k)
		}
		if got := ReasonOf(err); got != RefuseInvalidKey {
			t.Fatalf("key %q: reason = %q, want %q", k, got, RefuseInvalidKey)
		}
	}
	if n := lc.createdCount(); n != 0 {
		t.Fatalf("created %d VMs for invalid keys, want 0", n)
	}
}

func TestExecDestroysTheVMOnANonZeroExit(t *testing.T) {
	p, lc, _ := testPool(t)
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		out.Stderr([]byte("boom"))
		return Result{ExitCode: 7}, nil
	})
	res, err := p.Exec(context.Background(), "run-a", Exec{Command: "false"}, &capturingSink{})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if res.ExitCode != 7 {
		t.Fatalf("exit = %d, want 7", res.ExitCode)
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("%d VMs live after a failing command, want 0", n)
	}
}

func TestExecDestroysTheVMOnTimeout(t *testing.T) {
	p, lc, clk := testPool(t)
	started := make(chan struct{})
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		close(started)
		<-c.ctxDone // set by the fake: the run context's Done channel
		return Result{}, context.Canceled
	})
	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "run-a", Exec{Command: "sleep 99", TimeoutS: 30}, &capturingSink{})
		done <- err
	}()
	<-started
	clk.Advance(30 * time.Second)
	err := <-done
	// Spec §4.1: timeout, abort and success all terminate in ONE destroy path, and
	// the error must be ErrTimeout so the session emits ExecError{"timeout:<n>"}.
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("%d VMs live after a timeout, want 0", n)
	}
}

func TestExecDestroysTheVMOnAbort(t *testing.T) {
	p, lc, _ := testPool(t)
	started := make(chan struct{})
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		close(started)
		<-c.ctxDone
		return Result{}, context.Canceled
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(ctx, "run-a", Exec{Command: "sleep 99"}, &capturingSink{})
		done <- err
	}()
	<-started
	cancel()
	if err := <-done; !errors.Is(err, ErrAborted) {
		t.Fatalf("err = %v, want ErrAborted", err)
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("%d VMs live after an abort, want 0", n)
	}
}

func TestExecRefusesAVMBoundToAnotherKey(t *testing.T) {
	p, lc, _ := testPool(t)
	// Spec §6's "catastrophic bug" row, made cheap: the launcher hands back a VM
	// bound to someone else's workspace and Exec must not run in it.
	lc.setKeyOverride("run-b")
	_, err := p.Exec(context.Background(), "run-a", Exec{Command: "cat /workspace/secret"}, &capturingSink{})
	if !errors.Is(err, ErrKeyMismatch) {
		t.Fatalf("err = %v, want ErrKeyMismatch", err)
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("%d VMs live after a key mismatch, want 0 — the mismatched VM must still be destroyed", n)
	}
}

func TestExecReportsASpawnFailureAsARefusal(t *testing.T) {
	p, lc, _ := testPool(t)
	lc.setRestoreErr(errors.New("no /dev/kvm"))
	_, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{})
	if got := ReasonOf(err); got != RefuseSpawn {
		t.Fatalf("reason = %q, want %q (err=%v)", got, RefuseSpawn, err)
	}
	if got := p.Stats().Refusals[RefuseSpawn]; got != 1 {
		t.Fatalf("Refusals[%s] = %d, want 1", RefuseSpawn, got)
	}
}

func TestCloseDestroysEverythingAndRefusesFurtherExecs(t *testing.T) {
	p, lc, _ := testPool(t)
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("%d VMs live after Close, want 0", n)
	}
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Exec after Close: err = %v, want ErrClosed", err)
	}
}

// TestExecAbortedDuringColdAcquireIsNotASpawnFailure pins fix-round-1 finding 1:
// acquire's cold-warm error branch must check ctx.Err() BEFORE wrapping the
// launcher's error as RefuseSpawn, or a plain cancellation during Restore is
// misreported as a spawn failure — breaking the abort-sentinel-on-wire mapping
// and polluting by-cause exec-error metrics.
func TestExecAbortedDuringColdAcquireIsNotASpawnFailure(t *testing.T) {
	p, lc, _ := testPool(t)
	restoring := make(chan struct{})
	release := make(chan struct{})
	lc.setBeforeRestore(func(_ RestoreRequest) {
		close(restoring)
		<-release
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(ctx, "run-a", Exec{Command: "true"}, &capturingSink{})
		done <- err
	}()
	<-restoring
	cancel()
	close(release)
	err := <-done
	if !errors.Is(err, ErrAborted) {
		t.Fatalf("err = %v, want ErrAborted", err)
	}
	if got := p.Stats().Refusals[RefuseSpawn]; got != 0 {
		t.Fatalf("Refusals[%s] = %d, want 0 — an abort during acquire must not be counted as a spawn failure", RefuseSpawn, got)
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("%d VMs live after an abort during cold acquire, want 0", n)
	}
}

// TestExecTimesOutDuringColdAcquire pins fix-round-1 finding 2: TimeoutS must
// bound the whole Exec, including a cold acquire's VM boot, not just vm.Run —
// otherwise a wedged VMM hangs Exec indefinitely regardless of TimeoutS.
func TestExecTimesOutDuringColdAcquire(t *testing.T) {
	p, lc, clk := testPool(t)
	restoring := make(chan struct{})
	release := make(chan struct{})
	lc.setBeforeRestore(func(_ RestoreRequest) {
		close(restoring)
		<-release
	})
	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "run-a", Exec{Command: "sleep 99", TimeoutS: 5}, &capturingSink{})
		done <- err
	}()
	<-restoring
	clk.Advance(5 * time.Second)
	close(release)
	err := <-done
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("%d VMs live after a timeout during cold acquire, want 0", n)
	}
}

// TestExecTimesOutDuringResume pins fix-round-2: a TimeoutS expiry while Resume is
// in flight must classify as ErrTimeout, not as a RefuseSpawn resume failure — the
// same misclassification Finding 1 fixed for acquire, one step later in Exec.
func TestExecTimesOutDuringResume(t *testing.T) {
	p, lc, clk := testPool(t)
	resuming := make(chan struct{})
	release := make(chan struct{})
	lc.setResumeFn(func(_ *fakeVM, ctx context.Context) error {
		close(resuming)
		<-release
		return ctx.Err()
	})
	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "run-a", Exec{Command: "sleep 99", TimeoutS: 5}, &capturingSink{})
		done <- err
	}()
	<-resuming
	clk.Advance(5 * time.Second)
	close(release)
	err := <-done
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if got := p.Stats().Refusals[RefuseSpawn]; got != 0 {
		t.Fatalf("Refusals[%s] = %d, want 0 — a timeout during Resume must not be counted as a spawn failure", RefuseSpawn, got)
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("%d VMs live after a timeout during Resume, want 0", n)
	}
}
