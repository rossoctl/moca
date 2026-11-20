package vmpool

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

// #338: a Release of an idle run frees its standbys and its workspace at once, and the
// key is then refused for new Execs (so a turn still running after its session ended
// cannot re-create an empty workspace).
func TestReleaseOfAnIdleRunFreesItAndRefusesTheKey(t *testing.T) {
	p, lc, clk := testPool(t)
	var dir string
	lc.setBeforeRestore(func(r RestoreRequest) { dir = r.WorkspaceDir })
	primed(t, p, clk, "run-a")
	if err := os.WriteFile(filepath.Join(dir, "work"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := p.Release(context.Background(), "run-a")
	if err != nil || got != ReleaseReleased {
		t.Fatalf("Release = %q, %v; want %q", got, err, ReleaseReleased)
	}
	if s := p.Stats(); s.ActiveRuns != 0 || s.StandbysResident != 0 {
		t.Fatalf("Stats = %+v after Release, want no run and no standbys", s)
	}
	waitForValue(t, `lc.liveCount()`, func() int { return lc.liveCount() }, 0)
	// Detached under the lock (the key's path is free at once), removed on the reclaim
	// goroutine.
	waitGone(t, dir)

	_, err = p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{})
	if ReasonOf(err) != RefuseReleased {
		t.Fatalf("Exec after Release: err = %v, want a %s refusal", err, RefuseReleased)
	}
	if _, statErr := os.Stat(dir); !os.IsNotExist(statErr) {
		t.Fatalf("the refused Exec re-created the workspace %s", dir)
	}
	if n := p.Stats().Refusals[RefuseReleased]; n != 1 {
		t.Fatalf("Refusals[%s] = %d, want 1", RefuseReleased, n)
	}
}

// A Release never cuts an Exec: with one in flight the standbys go, the workspace is
// kept (kept_busy), and it is freed when that Exec ends, not at WorkspaceIdle.
func TestReleaseDuringAnExecKeepsTheWorkspaceUntilTheExecEnds(t *testing.T) {
	p, lc, clk := testPool(t)
	var dir string
	lc.setBeforeRestore(func(r RestoreRequest) { dir = r.WorkspaceDir })
	primed(t, p, clk, "run-a")

	release, entered := hold(lc)
	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "run-a", Exec{Command: "sleep", TimeoutS: 30}, &capturingSink{})
		done <- err
	}()
	<-entered
	marker := filepath.Join(dir, "being-written")
	if err := os.WriteFile(marker, []byte("mid-command"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := p.Release(context.Background(), "run-a")
	if err != nil || got != ReleaseKeptBusy {
		t.Fatalf("Release during an Exec = %q, %v; want %q", got, err, ReleaseKeptBusy)
	}
	if _, statErr := os.Stat(marker); statErr != nil {
		t.Fatalf("stat(%s) during the Exec: %v; a Release must not remove a running command's workspace", marker, statErr)
	}
	if s := p.Stats(); s.StandbysResident != 0 {
		t.Fatalf("StandbysResident = %d after Release, want 0", s.StandbysResident)
	}

	release()
	if err := <-done; err != nil {
		t.Fatalf("the in-flight Exec failed after a Release: %v", err)
	}
	// Freed by the Exec's own unwind: no clock advance, no sweep tick.
	if s := p.Stats(); s.ActiveRuns != 0 {
		t.Fatalf("ActiveRuns = %d after the Exec ended, want 0", s.ActiveRuns)
	}
	waitGone(t, dir)
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); ReasonOf(err) != RefuseReleased {
		t.Fatalf("Exec after the release completed: err = %v, want %s", err, RefuseReleased)
	}
}

// A key the pool holds nothing for is unknown_key, and is refused all the same: a release
// that overtakes a session's first Exec still stops it.
func TestReleaseOfAnUnknownKeyIsUnknownAndStillRefusesIt(t *testing.T) {
	p, _, _ := testPool(t)
	got, err := p.Release(context.Background(), "never-seen")
	if err != nil || got != ReleaseUnknownKey {
		t.Fatalf("Release = %q, %v; want %q", got, err, ReleaseUnknownKey)
	}
	if _, err := p.Exec(context.Background(), "never-seen", Exec{Command: "true"}, &capturingSink{}); ReasonOf(err) != RefuseReleased {
		t.Fatalf("Exec after Release: err = %v, want %s", err, RefuseReleased)
	}
}

// Idempotent: a second Release of a freed key is unknown_key, with no error.
func TestReleaseTwiceIsIdempotent(t *testing.T) {
	p, _, clk := testPool(t)
	primed(t, p, clk, "run-a")
	if got, err := p.Release(context.Background(), "run-a"); err != nil || got != ReleaseReleased {
		t.Fatalf("first Release = %q, %v", got, err)
	}
	if got, err := p.Release(context.Background(), "run-a"); err != nil || got != ReleaseUnknownKey {
		t.Fatalf("second Release = %q, %v; want %q", got, err, ReleaseUnknownKey)
	}
}

// The released set is bounded: after WorkspaceIdle the key is accepted again (as after an
// idle reclaim, a fresh workspace), and the sweep drops the entry.
func TestAReleasedKeyIsRefusedOnlyForWorkspaceIdle(t *testing.T) {
	p, _, clk := testPool(t)
	if _, err := p.Release(context.Background(), "run-a"); err != nil {
		t.Fatal(err)
	}
	clk.Advance(DefaultWorkspaceIdle / 2)
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); ReasonOf(err) != RefuseReleased {
		t.Fatalf("Exec within WorkspaceIdle: err = %v, want %s", err, RefuseReleased)
	}
	clk.Advance(DefaultWorkspaceIdle/2 + DefaultStandbyIdle)
	waitForValue(t, `len(released)`, func() int {
		pp := p.(*pool)
		pp.mu.Lock()
		defer pp.mu.Unlock()
		return len(pp.released)
	}, 0)
	if _, err := p.Exec(context.Background(), "run-b", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("an unrelated Exec: %v", err)
	}
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec past WorkspaceIdle: %v, want it accepted", err)
	}
}

// An invalid key is refused, as Exec refuses it, and is not recorded.
func TestReleaseRefusesAnInvalidKey(t *testing.T) {
	p, _, _ := testPool(t)
	if _, err := p.Release(context.Background(), "../escape"); ReasonOf(err) != RefuseInvalidKey {
		t.Fatalf("Release(../escape): err = %v, want %s", err, RefuseInvalidKey)
	}
	if _, err := p.Release(context.Background(), ""); ReasonOf(err) != RefuseEmptyKey {
		t.Fatalf("Release(\"\"): err = %v, want %s", err, RefuseEmptyKey)
	}
	// A call's error, not an Exec refusal: Refusals and Releases both stay empty.
	if s := p.Stats(); len(s.Refusals) != 0 || len(s.Releases) != 0 {
		t.Fatalf("Refusals = %v, Releases = %v after two refused Release calls, want both empty", s.Refusals, s.Releases)
	}
}

// Runner.Release puts the outcome on the wire, and a refusal as the error.
func TestRunnerReleaseMapsTheOutcome(t *testing.T) {
	p, _, clk := testPool(t)
	primed(t, p, clk, "run-a")
	r := Runner{Pool: p}
	if o, err := r.Release(context.Background(), "run-a"); err != nil || o != pb.ReleaseOutcome_RELEASE_OUTCOME_RELEASED {
		t.Fatalf("Runner.Release = %v, %v", o, err)
	}
	if o, err := r.Release(context.Background(), "run-a"); err != nil || o != pb.ReleaseOutcome_RELEASE_OUTCOME_UNKNOWN_KEY {
		t.Fatalf("second Runner.Release = %v, %v", o, err)
	}
	o, err := r.Release(context.Background(), "")
	if err == nil || o != pb.ReleaseOutcome_RELEASE_OUTCOME_UNSPECIFIED {
		t.Fatalf("Runner.Release(\"\") = %v, %v; want UNSPECIFIED and an error", o, err)
	}
	var re *RefusalError
	if !errors.As(err, &re) {
		t.Fatalf("Runner.Release(\"\") error %T, want a refusal", err)
	}
}

// A live lease keeps its workspace mounted between Execs, so a Release meets the run busy
// (kept_busy); once the lease ends (here sandbox_deleted, as the relay sends it for a lease
// sandbox), the next sweep frees the workspace without waiting for WorkspaceIdle.
func TestReleaseOfALeaseIsFreedWhenTheLeaseEnds(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("one", 1))
	if liveLease(p, "k") == nil {
		t.Fatal("no live lease after a lease Exec")
	}

	got, err := p.Release(context.Background(), "k")
	if err != nil || got != ReleaseKeptBusy {
		t.Fatalf("Release with a live lease = %q, %v; want %q", got, err, ReleaseKeptBusy)
	}
	if liveLease(p, "k") == nil {
		t.Fatal("Release ended the lease; it must never cut what is using the workspace")
	}
	if err := p.EndLease("k", LeaseEndSandboxDeleted); err != nil {
		t.Fatalf("EndLease: %v", err)
	}
	clk.Advance(p.cfg.ReclaimScanInterval + 1)
	waitForValue(t, `ActiveRuns`, func() int { return p.Stats().ActiveRuns }, 0)
	waitForValue(t, `lc.liveCount()`, func() int { return lc.liveCount() }, 0)
	if _, err := p.Exec(context.Background(), "k", leaseExec("two", 1), &capturingSink{}); ReasonOf(err) != RefuseReleased {
		t.Fatalf("lease Exec after the release: err = %v, want %s", err, RefuseReleased)
	}
}

// waitGone waits for dir to be removed (the reclaim goroutine runs the removal).
func waitGone(t *testing.T, dir string) {
	t.Helper()
	waitForValue(t, "workspace removed", func() bool {
		_, err := os.Stat(dir)
		return os.IsNotExist(err)
	}, true)
}

// Review M1: a Release that meets two Execs in flight is kept_busy, and the first Exec's
// end must not restore standbys for the released key: its destroy arms no replenish, and
// a timer armed before the release restores nothing.
func TestNoStandbyIsRestoredForAKeptBusyRelease(t *testing.T) {
	p, lc, clk := testPool(t)
	chA, chB := make(chan struct{}), make(chan struct{})
	in := make(chan string, 4)
	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
		in <- c.Command
		switch c.Command {
		case "a":
			<-chA
		case "b":
			<-chB
		}
		return Result{}, nil
	})
	doneA, doneB := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "k", Exec{Command: "a", TimeoutS: 600}, &capturingSink{})
		doneA <- err
	}()
	go func() {
		_, err := p.Exec(context.Background(), "k", Exec{Command: "b", TimeoutS: 600}, &capturingSink{})
		doneB <- err
	}()
	<-in
	<-in
	created := lc.createdCount()
	if o, err := p.Release(context.Background(), "k"); err != nil || o != ReleaseKeptBusy {
		t.Fatalf("Release = %q, %v; want %q", o, err, ReleaseKeptBusy)
	}
	close(chA)
	if err := <-doneA; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		clk.Advance(DefaultReplenishDelay)
	}
	if got := lc.createdCount(); got != created {
		t.Fatalf("created %d VMs after a kept_busy release, want %d: a standby was restored for a released key", got, created)
	}
	close(chB)
	if err := <-doneB; err != nil {
		t.Fatal(err)
	}
	waitForValue(t, `ActiveRuns`, func() int { return p.Stats().ActiveRuns }, 0)
	waitForValue(t, `lc.liveCount()`, func() int { return lc.liveCount() }, 0)
}

// Review M1, the warming case: a Release during a replenishment's warm is kept_busy (the
// warming makes the run busy); the warmed VM is destroyed, not kept as a standby, and the
// run is freed once nothing else uses it.
func TestAReleaseDuringAWarmingDestroysTheWarmedVM(t *testing.T) {
	p, lc, clk := testPool(t)
	if _, err := p.Exec(context.Background(), "k", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatal(err)
	}
	gate, at := make(chan struct{}), make(chan struct{}, 4)
	lc.setBeforeRestore(func(RestoreRequest) { at <- struct{}{}; <-gate })
	// The fake clock fires timers on the advancing goroutine, and this one blocks in
	// Restore until gate closes, so advance off the test goroutine.
	advanced := make(chan struct{})
	go func() { clk.Advance(DefaultReplenishDelay); close(advanced) }()
	<-at
	if o, err := p.Release(context.Background(), "k"); err != nil || o != ReleaseKeptBusy {
		t.Fatalf("Release during a warming = %q, %v; want %q", o, err, ReleaseKeptBusy)
	}
	lc.setBeforeRestore(nil)
	close(gate)
	<-advanced
	waitForValue(t, `ActiveRuns`, func() int { return p.Stats().ActiveRuns }, 0)
	waitForValue(t, `lc.liveCount()`, func() int { return lc.liveCount() }, 0)
	if s := p.Stats(); s.StandbysResident != 0 {
		t.Fatalf("StandbysResident = %d after a release during a warming, want 0", s.StandbysResident)
	}
}

// Review M2, deterministic: an Exec that passed ExecPhased's early check, with the
// Release landing before its acquire, must not re-create the released run with an empty
// workspace: it is refused where the run would be created.
func TestAnExecPastTheEarlyCheckCannotRecreateAReleasedRun(t *testing.T) {
	p, lc, clk := testPool(t)
	var dir string
	lc.setBeforeRestore(func(r RestoreRequest) { dir = r.WorkspaceDir })
	primed(t, p, clk, "k")
	gate, at := make(chan struct{}), make(chan struct{})
	afterReleaseCheck = func() { afterReleaseCheck = nil; close(at); <-gate }
	t.Cleanup(func() { afterReleaseCheck = nil })
	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "k", Exec{Command: "true"}, &capturingSink{})
		done <- err
	}()
	<-at
	if o, err := p.Release(context.Background(), "k"); err != nil || o != ReleaseReleased {
		t.Fatalf("Release = %q, %v; want %q", o, err, ReleaseReleased)
	}
	close(gate)
	if err := <-done; ReasonOf(err) != RefuseReleased {
		t.Fatalf("the Exec that passed the early check: err = %v, want %s", err, RefuseReleased)
	}
	clk.Advance(5 * DefaultReplenishDelay)
	if s := p.Stats(); s.ActiveRuns != 0 || s.StandbysResident != 0 {
		t.Fatalf("Stats = %+v: a released key has a live run again", s)
	}
	waitGone(t, dir)
}

// Releases are counted by outcome.
func TestReleasesAreCountedByOutcome(t *testing.T) {
	p, _, clk := testPool(t)
	primed(t, p, clk, "a")
	if _, err := p.Release(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Release(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	s := p.Stats()
	if s.Releases[ReleaseReleased] != 1 || s.Releases[ReleaseUnknownKey] != 1 || s.Releases[ReleaseKeptBusy] != 0 {
		t.Fatalf("Releases = %v, want released 1, unknown_key 1", s.Releases)
	}
}

// The failed-warm branch: a Release during a replenishment's warm that then FAILS frees
// the run at once, as the success branch does, without waiting for a sweep tick.
func TestAReleaseDuringAFailedWarmingFreesTheRunAtOnce(t *testing.T) {
	p, lc, clk := testPool(t)
	if _, err := p.Exec(context.Background(), "k", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatal(err)
	}
	gate, at := make(chan struct{}), make(chan struct{}, 4)
	lc.setBeforeRestore(func(RestoreRequest) { at <- struct{}{}; <-gate })
	lc.setRestoreErr(errors.New("restore failed"))
	advanced := make(chan struct{})
	go func() { clk.Advance(DefaultReplenishDelay); close(advanced) }()
	<-at
	if o, err := p.Release(context.Background(), "k"); err != nil || o != ReleaseKeptBusy {
		t.Fatalf("Release during a warming = %q, %v; want %q", o, err, ReleaseKeptBusy)
	}
	lc.setBeforeRestore(nil)
	close(gate)
	<-advanced
	// No clock advance past this point: the free comes from the failed warm's own branch.
	waitForValue(t, `ActiveRuns`, func() int { return p.Stats().ActiveRuns }, 0)
}
