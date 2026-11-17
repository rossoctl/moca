package vmpool

import (
	"context"
	"testing"
	"time"
)

// budgetPool builds a pool whose memory budget admits exactly `vms` VMs, so a test
// can walk right up to the ceiling without arithmetic in the assertions.
func budgetPool(t *testing.T, vms int, maxRuns int) (Pool, *fakeLauncher, *fakeClock) {
	t.Helper()
	lc := newFakeLauncher()
	clk := newFakeClock()
	const guest, overhead = 256 << 20, 32 << 20
	cfg := Config{
		VMM:               lc.Kind(),
		SnapshotDir:       t.TempDir(),
		WorkspaceRoot:     t.TempDir(),
		MaxRuns:           maxRuns,
		GuestRAMBytes:     guest,
		VMOverheadBytes:   overhead,
		MaxCommittedBytes: int64(vms) * (guest + overhead),
	}
	p, err := New(cfg, lc, clk)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p, lc, clk
}

// hold makes every Run block until the returned release func is called, so a test
// can pin N VMs in flight and observe the ceiling.
func hold(lc *fakeLauncher) (release func(), entered <-chan struct{}) {
	gate := make(chan struct{})
	in := make(chan struct{}, 64)
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		in <- struct{}{}
		<-gate
		return Result{ExitCode: 0}, nil
	})
	return func() { close(gate) }, in
}

func TestMaxRunsRefusesOnlyNewRuns(t *testing.T) {
	p, lc, _ := budgetPool(t, 100, 2)
	for _, k := range []string{"run-a", "run-b"} {
		if _, err := p.Exec(context.Background(), k, Exec{Command: "true"}, &capturingSink{}); err != nil {
			t.Fatalf("Exec %s: %v", k, err)
		}
	}
	_, err := p.Exec(context.Background(), "run-c", Exec{Command: "true"}, &capturingSink{})
	if got := ReasonOf(err); got != RefuseMaxRuns {
		t.Fatalf("third run: reason = %q, want %q (err=%v)", got, RefuseMaxRuns, err)
	}
	// An EXISTING run must keep working: MaxRuns bounds concurrent workspace_keys,
	// not execs, and refusing here would refuse work the harness's lease already
	// granted (spec §6's consistency requirement).
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("existing run refused after MaxRuns: %v", err)
	}
	if n := lc.createdCount(); n != 3 {
		t.Fatalf("created %d VMs, want 3 — the refused run must create none", n)
	}
}

// TestMaxRunsDoesNotCountParkedRuns is the documented sufficient condition
// (MaxRuns >= cap x records) actually holding. A parked run holds zero VMs — sweepOnce
// only parks a run whose standbys have all gone — so counting parked entries meant a
// worker at SH_MAX_RUNS=64 refused the 65th legitimate lease for ~29 minutes while
// nothing at all was resident.
//
// The refusal is asserted FIRST, with both runs still holding standbys: an assertion
// that a third run is admitted proves nothing unless the ceiling it is escaping can be
// shown to bite.
func TestMaxRunsDoesNotCountParkedRuns(t *testing.T) {
	p, _, clk := budgetPool(t, 100, 2)
	primed(t, p, clk, "run-a")
	primed(t, p, clk, "run-b")
	if got := ReasonOf(mustFail(t, p, "run-c")); got != RefuseMaxRuns {
		t.Fatalf("a third run while two hold standbys: reason = %q, want %q", got, RefuseMaxRuns)
	}

	// Past StandbyIdle both runs are RunParked: workspace on disk, zero VMs, zero bytes
	// committed. The ceiling is a VM/RAM backstop, so it must not bind on these.
	clk.Advance(DefaultStandbyIdle + DefaultStandbyIdle/4 + time.Second)
	waitFor(t, "both runs parked with no standby resident", func() bool {
		s := p.Stats()
		return s.ParkedRuns == 2 && s.StandbysResident == 0
	})
	if got := p.Stats().CommittedBytes; got != 0 {
		t.Fatalf("CommittedBytes = %d with both runs parked, want 0 — the premise of this test is that nothing is resident", got)
	}

	if _, err := p.Exec(context.Background(), "run-c", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec for a third key while the other two are parked: %v — a zero-VM parked run must not consume the MaxRuns backstop", err)
	}
}

func TestMemoryBudgetRefusesPastTheCeiling(t *testing.T) {
	p, lc, _ := budgetPool(t, 2, 100)
	release, entered := hold(lc)
	defer release()

	for i := 0; i < 2; i++ {
		go func(i int) {
			_, _ = p.Exec(context.Background(), "run-"+string(rune('a'+i)), Exec{Command: "sleep"}, &capturingSink{})
		}(i)
		<-entered
	}
	// Two VMs in flight is the whole budget; the third must be refused by the
	// memory gate rather than by the OOM killer (spec §6: "the OOM killer must never
	// arbitrate").
	_, err := p.Exec(context.Background(), "run-c", Exec{Command: "true"}, &capturingSink{})
	if got := ReasonOf(err); got != RefuseMemoryBudget {
		t.Fatalf("reason = %q, want %q (err=%v)", got, RefuseMemoryBudget, err)
	}
}

func TestMemoryReserveIsNeverCommitted(t *testing.T) {
	lc := newFakeLauncher()
	const guest, overhead = 256 << 20, 32 << 20
	cfg := Config{
		VMM: lc.Kind(), SnapshotDir: t.TempDir(), WorkspaceRoot: t.TempDir(), MaxRuns: 100,
		GuestRAMBytes: guest, VMOverheadBytes: overhead,
		// Room for two VMs, but one VM's worth is reserved as host headroom, so only
		// one may ever be admitted.
		MaxCommittedBytes:  2 * (guest + overhead),
		MemoryReserveBytes: guest + overhead,
	}
	p, err := New(cfg, lc, newFakeClock())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = p.Close() }()

	release, entered := hold(lc)
	defer release()
	go func() { _, _ = p.Exec(context.Background(), "run-a", Exec{Command: "sleep"}, &capturingSink{}) }()
	<-entered

	_, err = p.Exec(context.Background(), "run-b", Exec{Command: "true"}, &capturingSink{})
	if got := ReasonOf(err); got != RefuseMemoryBudget {
		t.Fatalf("reason = %q, want %q — MemoryReserveBytes must be unreachable", got, RefuseMemoryBudget)
	}
}

func TestTheTwoCeilingsAreCountedSeparately(t *testing.T) {
	p, lc, _ := budgetPool(t, 1, 1)
	release, entered := hold(lc)
	defer release()
	go func() { _, _ = p.Exec(context.Background(), "run-a", Exec{Command: "sleep"}, &capturingSink{}) }()
	<-entered

	// run-b trips MaxRuns first (it is checked before a VM is committed), so drive
	// the memory ceiling through the SAME run to get one of each.
	if got := ReasonOf(mustFail(t, p, "run-b")); got != RefuseMaxRuns {
		t.Fatalf("run-b: reason = %q, want %q", got, RefuseMaxRuns)
	}
	if got := ReasonOf(mustFail(t, p, "run-a")); got != RefuseMemoryBudget {
		t.Fatalf("run-a second exec: reason = %q, want %q", got, RefuseMemoryBudget)
	}
	s := p.Stats()
	if s.Refusals[RefuseMaxRuns] != 1 || s.Refusals[RefuseMemoryBudget] != 1 {
		t.Fatalf("Refusals = %v, want one of each — spec §6 requires them distinguishable", s.Refusals)
	}
}

func mustFail(t *testing.T, p Pool, key string) error {
	t.Helper()
	_, err := p.Exec(context.Background(), key, Exec{Command: "true"}, &capturingSink{})
	if err == nil {
		t.Fatalf("Exec %s succeeded, want a refusal", key)
	}
	return err
}

// TestAColdAcquireIsChargedOnceNotTwice pins the accounting during the restore itself.
// committedLocked sums ready + inFlight + warming, and the cold path used to increment
// both warming AND inFlight for one VM, so every in-flight cold acquire was charged twice
// for exactly the duration of the restore. The existing tests only sampled CommittedBytes
// after a warm had completed, which is why nothing caught it.
//
// The equality — one VM's worth, not zero and not two — is the assertion: a "fix" that
// dropped the charge instead of de-duplicating it would over-commit the host, which is
// the dangerous direction rather than the pessimistic one.
func TestAColdAcquireIsChargedOnceNotTwice(t *testing.T) {
	const perVM = int64(288 << 20) // guest 256 MiB + overhead 32 MiB, as budgetPool sets them
	p, lc, _ := budgetPool(t, 2, 100)

	restoring := make(chan string, 4)
	release := make(chan struct{})
	lc.setBeforeRestore(func(r RestoreRequest) {
		restoring <- r.Key
		<-release
	})
	defer close(release)

	go func() { _, _ = p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}) }()
	<-restoring
	if got := p.Stats().CommittedBytes; got != perVM {
		t.Fatalf("CommittedBytes = %d during one cold acquire, want %d (exactly one VM)", got, perVM)
	}

	// The behavioural consequence, which is what shows up in E11: with a two-VM budget,
	// a second run's cold acquire must be admitted while the first is still restoring.
	// Double-charged, the first acquire filled the budget by itself and this was refused
	// RefuseMemoryBudget at half the intended concurrency.
	second := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "run-b", Exec{Command: "true"}, &capturingSink{})
		second <- err
	}()
	select {
	case <-restoring:
	case err := <-second:
		t.Fatalf("the second cold acquire never reached Restore: %v — a two-VM budget must admit two concurrent cold acquires", err)
	case <-time.After(testWaitBound):
		t.Fatal("the second cold acquire neither reached Restore nor returned")
	}
	if got := p.Stats().CommittedBytes; got != 2*perVM {
		t.Fatalf("CommittedBytes = %d with two cold acquires in flight, want %d", got, 2*perVM)
	}

	// And the ceiling still binds: a third run against a two-VM budget is refused.
	if got := ReasonOf(mustFail(t, p, "run-c")); got != RefuseMemoryBudget {
		t.Fatalf("third cold acquire: reason = %q, want %q — de-duplicating the charge must not remove the ceiling", got, RefuseMemoryBudget)
	}
}

func TestStatsCommittedBytesTracksVMsInFlight(t *testing.T) {
	p, lc, _ := budgetPool(t, 10, 10)
	if got := p.Stats().CommittedBytes; got != 0 {
		t.Fatalf("CommittedBytes = %d on an empty pool, want 0", got)
	}
	release, entered := hold(lc)
	defer release()
	go func() { _, _ = p.Exec(context.Background(), "run-a", Exec{Command: "sleep"}, &capturingSink{}) }()
	<-entered
	if got, want := p.Stats().CommittedBytes, int64(288<<20); got != want {
		t.Fatalf("CommittedBytes = %d, want %d (one VM: guest + overhead)", got, want)
	}
}
