package vmpool

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// primed leaves key with a full complement of D Ready standbys and a lastExec of
// "now", so a test can then just advance the clock.
func primed(t *testing.T, p Pool, clk *fakeClock, key string) {
	t.Helper()
	if _, err := p.Exec(context.Background(), key, Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("prime %s: %v", key, err)
	}
	clk.Advance(time.Duration(DefaultStandbyDepth+1) * DefaultReplenishDelay)
	if s := p.Stats(); s.StandbysResident < DefaultStandbyDepth {
		t.Fatalf("prime %s: StandbysResident = %d, want %d", key, s.StandbysResident, DefaultStandbyDepth)
	}
}

// Spec §4.2's case a request-triggered sweep cannot cover: a host whose last run
// went quiet receives no further Exec to hang a sweep off, so the ticker must
// converge it to zero standbys on its own.
func TestTheTickerSweepsWithNoFurtherExec(t *testing.T) {
	p, lc, clk := testPool(t)
	primed(t, p, clk, "run-a")
	// No further Exec of any kind from here on.
	clk.Advance(DefaultStandbyIdle + DefaultStandbyIdle/4 + time.Second)
	waitFor(t, func() bool { return p.Stats().StandbysResident == 0 })
	waitFor(t, func() bool { return lc.liveCount() == 0 })
	if s := p.Stats(); s.ParkedRuns != 1 {
		t.Fatalf("ParkedRuns = %d, want 1 — the run is RunParked, not gone", s.ParkedRuns)
	}
}

// Spec §8: "StandbyIdle drops a run's standbys and LEAVES its workspace on disk, so
// the next Exec for that key is a cold acquire against the same tree rather than a
// fresh one."
func TestStandbyIdleDropsStandbysAndKeepsTheWorkspace(t *testing.T) {
	p, lc, clk := testPool(t)
	var dir string
	lc.setBeforeRestore(func(r RestoreRequest) { dir = r.WorkspaceDir })
	primed(t, p, clk, "run-a")

	// Leave a marker in the workspace: "the same tree" has to mean the same bytes,
	// not merely the same path.
	marker := dir + "/converged"
	if err := os.WriteFile(marker, []byte("pinned commit"), 0o600); err != nil {
		t.Fatalf("write marker: %v", err)
	}

	clk.Advance(DefaultStandbyIdle + DefaultStandbyIdle/4 + time.Second)
	waitFor(t, func() bool { return p.Stats().StandbysResident == 0 })
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("workspace %s gone at StandbyIdle: %v — RAM is urgent, disk is not (spec §4.4)", dir, err)
	}

	before := p.Stats().ColdAcquires[ColdParked]
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "resume"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec after parking: %v", err)
	}
	if got := p.Stats().ColdAcquires[ColdParked] - before; got != 1 {
		t.Fatalf("ColdAcquires[parked] rose by %d, want 1 — a gate-resumed run must not read as replenishment lag (spec §4.4)", got)
	}
	if b, err := os.ReadFile(marker); err != nil || string(b) != "pinned commit" {
		t.Fatalf("marker after resume: %q, err=%v — the resumed run must see the same tree", b, err)
	}
}

// Spec §7.4's prediction 5, and §8's third reclamation unit test: "a run's final
// Exec mints ITS REPLACEMENT standby after ReplenishDelay, leaving D idle, which
// StandbyIdle ages out rather than reclaiming immediately".
func TestAFinalExecMintsItsReplacementWhichStandbyIdleThenAgesOut(t *testing.T) {
	p, _, clk := testPool(t)
	primed(t, p, clk, "run-a")

	// The final Exec — in production this is cleanupWorkspace, indistinguishable
	// from work. It pops one standby, leaving D-1 Ready.
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "worktree remove"}, &capturingSink{}); err != nil {
		t.Fatalf("final Exec: %v", err)
	}
	if got, want := p.Stats().StandbysResident, DefaultStandbyDepth-1; got != want {
		t.Fatalf("StandbysResident = %d immediately after the final Exec, want %d", got, want)
	}
	// Its replacement is minted, so the full complement of D stands idle for a run
	// that is over. This is the residual only spec §9's Release can remove.
	clk.Advance(2 * DefaultReplenishDelay)
	if got := p.Stats().StandbysResident; got != DefaultStandbyDepth {
		t.Fatalf("StandbysResident = %d after ReplenishDelay, want D = %d", got, DefaultStandbyDepth)
	}
	if got := p.Stats().IdleStandbyResidency; got != 0 {
		t.Fatalf("IdleStandbyResidency = %d before StandbyIdle/2, want 0", got)
	}
	// Past StandbyIdle/2 they are reported as idle residency — memory spent on VMs
	// that will most likely never serve a command (spec §7.1).
	clk.Advance(DefaultStandbyIdle/2 + time.Second)
	if got := p.Stats().IdleStandbyResidency; got != DefaultStandbyDepth {
		t.Fatalf("IdleStandbyResidency = %d past StandbyIdle/2, want %d", got, DefaultStandbyDepth)
	}
	// And StandbyIdle ages them out within one ReclaimScanInterval.
	clk.Advance(DefaultStandbyIdle/2 + DefaultStandbyIdle/4 + time.Second)
	waitFor(t, func() bool { return p.Stats().StandbysResident == 0 })
	if got := p.Stats().IdleStandbyResidency; got != 0 {
		t.Fatalf("IdleStandbyResidency = %d after the sweep, want 0", got)
	}
}

// Spec §8: "a sweep destroys at most MaxReclaimsPerScan VMs, leaving the rest for
// the next tick". Spec §6's reason: bulk munmap contends with the hot path, so
// convergence is a slope, not a stall.
func TestASweepDestroysAtMostMaxReclaimsPerScan(t *testing.T) {
	lc := newFakeLauncher()
	clk := newFakeClock()
	cfg := Config{
		VMM: lc.Kind(), SnapshotDir: t.TempDir(), WorkspaceRoot: t.TempDir(),
		MaxRuns: 16, MaxCommittedBytes: 1 << 40,
		MaxReclaimsPerScan: 2,
	}
	p, err := New(cfg, lc, clk)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = p.Close() }()

	// Three runs x D=2 standbys = 6 idle VMs; at 2 per scan that is three ticks.
	for _, k := range []string{"run-a", "run-b", "run-c"} {
		primed(t, p, clk, k)
	}
	if got := p.Stats().StandbysResident; got != 6 {
		t.Fatalf("setup: StandbysResident = %d, want 6", got)
	}
	interval := cfg.ReclaimScanIntervalForTest()
	clk.Advance(DefaultStandbyIdle + time.Second) // now every run is over StandbyIdle
	// First tick after the threshold: exactly 2 go.
	waitFor(t, func() bool { return p.Stats().StandbysResident == 4 })
	clk.Advance(interval)
	waitFor(t, func() bool { return p.Stats().StandbysResident == 2 })
	clk.Advance(interval)
	waitFor(t, func() bool { return p.Stats().StandbysResident == 0 })
}

// Spec §4.4: WorkspaceIdle is the ONLY thing that ever deletes a workspace on the VM
// path — the harness's own cleanup is an in-guest Exec that cannot reach the host
// directory. Spec §8's "Reclaim, then re-dispatch" is the companion property.
func TestWorkspaceIdleDeletesTheWorkspaceAndTheKeyCanBeReused(t *testing.T) {
	p, lc, clk := testPool(t)
	var dir string
	lc.setBeforeRestore(func(r RestoreRequest) { dir = r.WorkspaceDir })
	primed(t, p, clk, "run-a")
	if err := os.WriteFile(dir+"/converged", []byte("x"), 0o600); err != nil {
		t.Fatalf("write marker: %v", err)
	}

	clk.Advance(DefaultWorkspaceIdle + DefaultStandbyIdle/4 + time.Second)
	waitFor(t, func() bool { _, err := os.Stat(dir); return os.IsNotExist(err) })
	if s := p.Stats(); s.ActiveRuns != 0 || s.ParkedRuns != 0 {
		t.Fatalf("Stats = %+v, want the run gone entirely (RunAbsent)", s)
	}
	// Re-dispatching the same key must work: converge re-derives the tree at the
	// pinned commit and the leaf proceeds (spec §8).
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "re-converge"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec after workspace reclaim: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("workspace not re-created: %v", err)
	}
	if got := p.Stats().ColdAcquires[ColdFirstExec]; got != 2 {
		t.Fatalf("ColdAcquires[first-exec] = %d, want 2 — a reclaimed key is an unseen key again", got)
	}
}

// ageOutAndSweep puts key past WorkspaceIdle and runs ONE sweep pass by hand, returning
// the detached batch and the run's live workspace directory.
//
// It ages the run by rewriting lastExec rather than by advancing the clock, deliberately:
// advancing past WorkspaceIdle also fires the reclaim ticker, which would sweep and hand
// the batch to the reclaim goroutine itself, and the window under test is precisely the
// one between "the sweep decided" and "the removal ran". Driving the two halves by hand
// is the only way to sit inside it deterministically.
func ageOutAndSweep(t *testing.T, p Pool, lc *fakeLauncher, clk *fakeClock, key string) (reclaimBatch, string) {
	t.Helper()
	var dir string
	lc.setBeforeRestore(func(r RestoreRequest) { dir = r.WorkspaceDir })
	if _, err := p.Exec(context.Background(), key, Exec{Command: "converge"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec %s: %v", key, err)
	}
	if dir == "" {
		t.Fatal("the launcher was never handed a workspace directory")
	}

	pp := p.(*pool)
	pp.mu.Lock()
	rp := pp.runs[key]
	if rp == nil {
		pp.mu.Unlock()
		t.Fatalf("no run pool for %s after an Exec", key)
	}
	rp.lastExec = clk.Now().Add(-2 * DefaultWorkspaceIdle)
	for _, tm := range rp.pending {
		tm.Stop()
	}
	rp.pending = nil
	pp.mu.Unlock()

	b := pp.sweepOnce(clk.Now())
	if len(b.dirs) != 1 {
		t.Fatalf("sweepOnce queued %d workspaces for removal, want 1 — nothing was reclaimed, so anything this test then asserts about the removal would be vacuous", len(b.dirs))
	}
	if b.dirs[0] == dir {
		t.Fatalf("the batch carries the LIVE workspace path %s; a queued removal must name a detached tree that no workspace_key can resolve to", dir)
	}
	return b, dir
}

// TestGateReclamationCannotDeleteALiveWorkspace is spec §2.3's isolation property seen
// from the housekeeping side, and the companion to TestGateNoCrossRunBleed: that gate
// interleaves two keys, this one interleaves one key with its own reclamation. It needs no
// KVM — the window is Pool bookkeeping plus real directories, not anything only hardware
// could get wrong.
//
// The sweep decides to reclaim under p.mu but os.RemoveAll runs later on the reclaim
// goroutine, behind up to MaxReclaimsPerScan VM destroys. In that window a new Exec for
// the same key used to pass runLocked, re-create the directory and restore a VM into it —
// and then the removal deleted the tree under a running command, silently on the
// Firecracker arm, because the guest goes on writing to a workspace.img inode its jail
// hardlink keeps alive.
func TestGateReclamationCannotDeleteALiveWorkspace(t *testing.T) {
	// Presence before absence: the removal this gate constrains must actually happen,
	// or "the new run's files survived" would be true of a pool that reclaims nothing.
	t.Run("an_uncontested_reclamation_really_removes_the_tree", func(t *testing.T) {
		p, lc, clk := testPool(t)
		b, dir := ageOutAndSweep(t, p, lc, clk, "run-a")
		root := filepath.Dir(dir)

		p.(*pool).doReclaim(b)

		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatalf("stat(%s) after the reclamation: err = %v, want IsNotExist", dir, err)
		}
		// And the detached tree is gone too, not merely renamed out of sight: a
		// tombstone nobody removes is a disk leak wearing a fix's clothing. The lease
		// state directory is no workspace: New writes its boot marker there.
		entries, err := os.ReadDir(root)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, e := range entries {
			if e.Name() != leaseStateDir {
				names = append(names, e.Name())
			}
		}
		if len(names) != 0 {
			t.Fatalf("WorkspaceRoot holds %v after the reclamation, want nothing but %s", names, leaseStateDir)
		}
	})

	t.Run("a_key_re_created_before_the_removal_keeps_its_own_tree", func(t *testing.T) {
		p, lc, clk := testPool(t)
		b, dir := ageOutAndSweep(t, p, lc, clk, "run-a")

		// The key comes back inside the window: a fresh dispatch for the same run id,
		// which re-derives its worktree and writes to it.
		if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "re-converge"}, &capturingSink{}); err != nil {
			t.Fatalf("Exec after the sweep decided to reclaim: %v", err)
		}
		marker := filepath.Join(dir, "converged")
		if err := os.WriteFile(marker, []byte("pinned commit"), 0o600); err != nil {
			t.Fatalf("write marker: %v", err)
		}

		p.(*pool).doReclaim(b)

		got, err := os.ReadFile(marker)
		if err != nil || string(got) != "pinned commit" {
			t.Fatalf("marker after the queued reclamation ran = %q, err = %v — the removal ate the NEW run's workspace", got, err)
		}
	})
}

// TestReclaimKeepsTheWorkspaceOfARunWithAnExecInFlight pins the same finding in
// Pool.Reclaim, which had the worse shape of the two: it correctly KEPT the map entry
// while work was in flight and then removed the directory anyway.
func TestReclaimKeepsTheWorkspaceOfARunWithAnExecInFlight(t *testing.T) {
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
		t.Fatalf("write marker: %v", err)
	}
	err := p.Reclaim(context.Background(), "run-a")
	if err == nil {
		t.Fatal("Reclaim of a run with an Exec in flight returned nil — it cannot have honoured the request safely")
	}
	if _, statErr := os.Stat(marker); statErr != nil {
		t.Fatalf("stat(%s) after Reclaim: %v — the workspace of a running command must survive; deleting it loses the guest's writes silently on the Firecracker arm", marker, statErr)
	}
	// What Reclaim CAN do, it still does: the standbys are gone.
	if s := p.Stats(); s.StandbysResident != 0 {
		t.Fatalf("StandbysResident = %d after Reclaim, want 0 — the standbys are droppable even when the workspace is not", s.StandbysResident)
	}

	release()
	if err := <-done; err != nil {
		t.Fatalf("the in-flight Exec failed after a Reclaim: %v", err)
	}
}

func TestReclaimDropsStandbysAndTheWorkspace(t *testing.T) {
	p, lc, clk := testPool(t)
	var dir string
	lc.setBeforeRestore(func(r RestoreRequest) { dir = r.WorkspaceDir })
	primed(t, p, clk, "run-a")
	if err := p.Reclaim(context.Background(), "run-a"); err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	if s := p.Stats(); s.StandbysResident != 0 || s.ActiveRuns != 0 {
		t.Fatalf("Stats = %+v, want nothing left for run-a", s)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("workspace %s survived Reclaim: err=%v", dir, err)
	}
	waitFor(t, func() bool { return lc.liveCount() == 0 })
	// Idempotent: reclaiming an unknown key is not an error.
	if err := p.Reclaim(context.Background(), "run-zzz"); err != nil {
		t.Fatalf("Reclaim of an unknown key: %v", err)
	}
}

// Trigger 1: a quiet run is reclaimed by another run's Exec, without waiting for a
// tick. Spec §4.2's "sweeps every key on every Exec".
func TestAnExecSweepsOtherQuietRuns(t *testing.T) {
	p, _, clk := testPool(t)
	primed(t, p, clk, "run-quiet")
	clk.Advance(DefaultStandbyIdle + time.Second)
	// Deliberately do NOT let a tick land: assert on the Exec-driven pass by checking
	// state right after an unrelated Exec returns.
	if _, err := p.Exec(context.Background(), "run-busy", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if got := p.Stats().ParkedRuns; got != 1 {
		t.Fatalf("ParkedRuns = %d after an unrelated Exec, want 1", got)
	}
}

func TestABusyRunIsNeverSwept(t *testing.T) {
	p, lc, clk := testPool(t)
	primed(t, p, clk, "run-a")
	release, entered := hold(lc)
	defer release()
	go func() { _, _ = p.Exec(context.Background(), "run-a", Exec{Command: "sleep"}, &capturingSink{}) }()
	<-entered
	// The idle clock is long past both thresholds, but work is in flight: reclaiming
	// here would destroy the workspace under a running command.
	clk.Advance(DefaultWorkspaceIdle + DefaultStandbyIdle)
	if s := p.Stats(); s.ActiveRuns != 1 || s.InFlight != 1 {
		t.Fatalf("Stats = %+v, want the busy run intact", s)
	}
}
