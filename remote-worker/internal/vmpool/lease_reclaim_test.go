package vmpool

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Measured lease charge and idle-longest reclaim (Task 6, spec §6).

// pinMemAvailable makes the hostmem.go seam answer f for the rest of the test, and drops
// the cached read on both sides so neither this test nor the next sees a stale value.
func pinMemAvailable(t *testing.T, f func() (int64, error)) {
	t.Helper()
	old := memAvailable
	memAvailable = f
	invalidateMemAvailableCache()
	t.Cleanup(func() {
		memAvailable = old
		invalidateMemAvailableCache()
	})
}

// plentyOfHostMemory pins MemAvailable far above any LeaseReclaimFreeBytes, so a lease
// test's ticks never reclaim for memory whatever the host running it has free. Every
// lease pool helper calls it.
func plentyOfHostMemory(t *testing.T) {
	t.Helper()
	pinMemAvailable(t, func() (int64, error) { return 1 << 50, nil })
}

func (l *leaseLauncher) setLeaseBytes(b int64) {
	l.rec.Lock()
	l.leaseBytes = b
	l.rec.Unlock()
}

// leaseOn sets key's mode to lease and runs one lease Exec there: a live, idle lease.
func leaseOn(t *testing.T, p *pool, key string) {
	t.Helper()
	mustSetMode(t, p, key, ModeLease, 1)
	mustExec(t, p, key, secretLeaseExec())
}

// tickLeases advances the fake clock by one LeaseScanInterval after dropping the cached
// MemAvailable, so the lease tick that fires reads the seam's current answer.
func tickLeases(p *pool, clk *fakeClock) {
	invalidateMemAvailableCache()
	clk.Advance(p.cfg.LeaseScanInterval)
}

func leaseCommitted(p *pool) int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.leaseCommittedLocked()
}

func TestLeaseChargedMeasuredTimesHeadroom(t *testing.T) {
	t.Run("measured times headroom, also while an Exec runs", func(t *testing.T) {
		p, lc, clk := leasePool(t, nil)
		lc.setLeaseBytes(400 << 20)
		leaseOn(t, p, "k")
		want := int64(500 << 20) // 400 MiB x LeaseHeadroom 1.25
		if s := p.Stats(); s.CommittedBytes != want || s.LeaseCommittedBytes != want {
			t.Fatalf("idle lease: CommittedBytes %d, LeaseCommittedBytes %d; want both %d", s.CommittedBytes, s.LeaseCommittedBytes, want)
		}

		entered, release := blockRuns(lc)
		errc := execAsync(p, "k", secretLeaseExec())
		recvWithin(t, entered, "the second Exec's Run")
		if s := p.Stats(); s.CommittedBytes != want || s.LeaseExecuting != 1 {
			t.Fatalf("while an Exec runs: CommittedBytes %d (executing %d), want %d: a lease VM is never re-priced to PerVMBytes (%d)",
				s.CommittedBytes, s.LeaseExecuting, want, p.perVMBytes())
		}
		close(release)
		if err := recvWithin(t, errc, "the second Exec"); err != nil {
			t.Fatalf("second Exec: %v", err)
		}

		// An idle lease's footprint falls as free-page reporting returns memory: the next
		// lease tick re-samples it (ruling R2).
		lc.setLeaseBytes(200 << 20)
		tickLeases(p, clk)
		if got, want := leaseCommitted(p), int64(250<<20); got != want {
			t.Fatalf("after a tick on an idle lease whose footprint fell to 200 MiB: charge %d, want %d", got, want)
		}
	})
	t.Run("floored at VMOverheadBytes", func(t *testing.T) {
		p, lc, _ := leasePool(t, nil)
		lc.setLeaseBytes(8 << 20)
		leaseOn(t, p, "k")
		if got := leaseCommitted(p); got != p.cfg.VMOverheadBytes {
			t.Fatalf("charge for an 8 MiB footprint = %d, want the VMOverheadBytes floor %d", got, p.cfg.VMOverheadBytes)
		}
	})
}

func TestLeaseChargedStartBeforeFirstSample(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	lc.setLeaseBytes(400 << 20) // read only once the first Exec ends

	entered, release := blockRuns(lc)
	errc := execAsync(p, "k", secretLeaseExec())
	recvWithin(t, entered, "the first Exec's Run")
	if got := leaseCommitted(p); got != p.cfg.LeaseStartBytes {
		t.Fatalf("during the first Exec, before any sample: charge %d, want LeaseStartBytes %d", got, p.cfg.LeaseStartBytes)
	}
	close(release)
	if err := recvWithin(t, errc, "the first Exec"); err != nil {
		t.Fatalf("first Exec: %v", err)
	}
	if got, want := leaseCommitted(p), int64(500<<20); got != want {
		t.Fatalf("after the first sample: charge %d, want %d", got, want)
	}

	// No footprint to read (LeaseBytes errors): the start price stays.
	q, qlc, _ := leasePool(t, nil)
	qlc.setLeaseBytes(0)
	leaseOn(t, q, "k")
	if got := leaseCommitted(q); got != q.cfg.LeaseStartBytes {
		t.Fatalf("with no readable footprint: charge %d, want LeaseStartBytes %d", got, q.cfg.LeaseStartBytes)
	}
}

// lowMemPool is a lease pool with a 4 GiB reclaim target and a MemAvailable the test
// sets through avail.
func lowMemPool(t *testing.T, tweak func(*Config)) (*pool, *leaseLauncher, *fakeClock, *atomic.Int64) {
	t.Helper()
	p, lc, clk := leasePool(t, func(c *Config) {
		c.LeaseReclaimFreeBytes = 4 << 30
		if tweak != nil {
			tweak(c)
		}
	})
	var avail atomic.Int64
	avail.Store(8 << 30)
	pinMemAvailable(t, func() (int64, error) { return avail.Load(), nil })
	return p, lc, clk, &avail
}

// leasesOn starts an idle lease on each key in turn, one second apart, so the first key
// is the idle-longest.
func leasesOn(t *testing.T, p *pool, clk *fakeClock, keys ...string) {
	t.Helper()
	for _, k := range keys {
		leaseOn(t, p, k)
		clk.Advance(time.Second)
	}
}

func keyLeased(p *pool, key string) bool { return liveLease(p, key) != nil }

func TestReclaimOnLowMemAvailable(t *testing.T) {
	logs := captureLog(t)
	p, lc, clk, avail := lowMemPool(t, nil)
	leasesOn(t, p, clk, "a", "b", "c")

	// One byte below the target: the idle-longest lease goes, and one is enough.
	avail.Store(p.cfg.LeaseReclaimFreeBytes - 1)
	tickLeases(p, clk)
	waitFor(t, func() bool { return !keyLeased(p, "a") && lc.liveCount() == 2 })
	if !keyLeased(p, "b") || !keyLeased(p, "c") {
		t.Fatalf("after the first reclaim: b leased %v, c leased %v; want both", keyLeased(p, "b"), keyLeased(p, "c"))
	}

	info := p.LeaseStatus("a")
	if info.Pending == nil || info.Pending.State != leaseEventEnd || info.Pending.Reason != LeaseEndMemoryReclaim {
		t.Fatalf("a's pending event = %+v, want end %s", info.Pending, LeaseEndMemoryReclaim)
	}
	if info.State != LeaseNone {
		t.Fatalf("a's state = %q, want %q", info.State, LeaseNone)
	}
	s := loadLeaseState(p.cfg.WorkspaceRoot, "a")
	if s.Pending == nil || !s.Pending.At.Equal(info.Pending.At) || s.Pending.Reason != LeaseEndMemoryReclaim || s.Open != nil {
		t.Fatalf("a's file = %+v (pending %+v), want the same event as LeaseStatus and no open lease", s, s.Pending)
	}

	// Still below: the reclaim repeats on the next tick, again idle-longest first.
	tickLeases(p, clk)
	waitFor(t, func() bool { return !keyLeased(p, "b") && lc.liveCount() == 1 })

	// Back at the target: nothing more is reclaimed.
	avail.Store(p.cfg.LeaseReclaimFreeBytes)
	tickLeases(p, clk)
	tickLeases(p, clk)
	if !keyLeased(p, "c") || lc.liveCount() != 1 {
		t.Fatalf("at the target: c leased %v, live VMs %d; want c kept", keyLeased(p, "c"), lc.liveCount())
	}
	if n := p.Stats().LeaseEnds[LeaseEndMemoryReclaim]; n != 2 {
		t.Fatalf("LeaseEnds[memory_reclaim] = %d, want 2", n)
	}
	out := logs.String()
	if n := strings.Count(out, "vmpool: lease end "); n != 2 || strings.Count(out, "reason=memory_reclaim") != 2 {
		t.Fatalf("want two lease end audit lines, both reason=memory_reclaim; log:\n%s", out)
	}
	if strings.Contains(out, secretCommand) {
		t.Fatalf("the log carries command text:\n%s", out)
	}
}

func TestReclaimTakesAtMostMaxReclaimsPerScan(t *testing.T) {
	p, lc, clk, avail := lowMemPool(t, func(c *Config) { c.MaxReclaimsPerScan = 2 })
	leasesOn(t, p, clk, "a", "b", "c")
	avail.Store(0) // far below: every lease would be needed
	tickLeases(p, clk)
	waitFor(t, func() bool { return lc.liveCount() == 1 })
	if keyLeased(p, "a") || keyLeased(p, "b") || !keyLeased(p, "c") {
		t.Fatalf("after one tick: a %v, b %v, c %v; want the two idle-longest taken, c kept",
			keyLeased(p, "a"), keyLeased(p, "b"), keyLeased(p, "c"))
	}
	tickLeases(p, clk)
	waitFor(t, func() bool { return lc.liveCount() == 0 && !keyLeased(p, "c") })
}

// Review Focus 4: reclaim picks the idle-longest lease, but takes it only if its gate is
// free at that moment. A lease whose gate is held is skipped, never waited on.
func TestReclaimSkipsALeaseWhoseGateIsHeld(t *testing.T) {
	t.Run("an Exec in flight", func(t *testing.T) {
		p, lc, clk, avail := lowMemPool(t, nil)
		leasesOn(t, p, clk, "a", "b")
		entered, release := blockRuns(lc)
		errc := execAsync(p, "a", secretLeaseExec())
		recvWithin(t, entered, "a's Exec")

		avail.Store(0)
		tickLeases(p, clk)
		waitFor(t, func() bool { return !keyLeased(p, "b") && lc.liveCount() == 1 })
		if l := liveLease(p, "a"); l == nil {
			t.Fatal("a's lease, with an Exec in flight, was reclaimed")
		}
		close(release)
		if err := recvWithin(t, errc, "a's Exec"); err != nil {
			t.Fatalf("a's Exec: %v, want it to finish in its lease", err)
		}
		if !keyLeased(p, "a") {
			t.Fatal("a's lease ended with its Exec")
		}
	})
	t.Run("the gate held with no Exec in Run", func(t *testing.T) {
		p, lc, clk, avail := lowMemPool(t, nil)
		leasesOn(t, p, clk, "a", "b")
		p.mu.Lock()
		gate := p.runs["a"].execGate
		p.mu.Unlock()
		gate <- struct{}{} // a holder that runs nothing: queued, starting or ending

		avail.Store(p.cfg.LeaseReclaimFreeBytes - 1)
		tickLeases(p, clk) // must not block on a's gate
		waitFor(t, func() bool { return !keyLeased(p, "b") && lc.liveCount() == 1 })
		if !keyLeased(p, "a") {
			t.Fatal("a's lease, its gate held, was reclaimed")
		}

		<-gate
		tickLeases(p, clk) // still below the target, and a's gate is free now
		waitFor(t, func() bool { return !keyLeased(p, "a") && lc.liveCount() == 0 })
		if s := loadLeaseState(p.cfg.WorkspaceRoot, "a"); s.Pending == nil || s.Pending.Reason != LeaseEndMemoryReclaim {
			t.Fatalf("a's state = %+v, want pending %s", s, LeaseEndMemoryReclaim)
		}
	})
}

// Spec §6, "Order when a lease Exec needs a VM": admit at LeaseStartBytes (1); if that
// does not fit, end idle leases idle-longest first until it does (2); with nothing idle
// left, refuse memory-budget (3).
func TestAdmissionReclaimsIdleLeasesThenRefuses(t *testing.T) {
	p, lc, clk := leasePool(t, func(c *Config) { c.MaxCommittedBytes = 3 * DefaultLeaseStartBytes })
	leasesOn(t, p, clk, "a", "b", "c") // unsampled: LeaseStartBytes each, the whole budget
	mustExec(t, p, "a", secretLeaseExec())
	clk.Advance(time.Second) // b is now the idle-longest, a the most recent

	leaseOn(t, p, "d")
	if keyLeased(p, "b") || !keyLeased(p, "a") || !keyLeased(p, "c") || !keyLeased(p, "d") {
		t.Fatalf("after d: a %v, b %v, c %v, d %v; want only b, the idle-longest, ended",
			keyLeased(p, "a"), keyLeased(p, "b"), keyLeased(p, "c"), keyLeased(p, "d"))
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "b"); s.Pending == nil || s.Pending.Reason != LeaseEndMemoryReclaim {
		t.Fatalf("b's state = %+v, want pending %s", s, LeaseEndMemoryReclaim)
	}
	waitFor(t, func() bool { return lc.liveCount() == 3 })

	// a and c run, so d is the one idle lease, and the next new lease takes it.
	entered, release := blockRuns(lc)
	errs := []<-chan error{execAsync(p, "a", secretLeaseExec()), execAsync(p, "c", secretLeaseExec())}
	recvWithin(t, entered, "a's Exec")
	recvWithin(t, entered, "c's Exec")
	mustSetMode(t, p, "e", ModeLease, 1)
	errs = append(errs, execAsync(p, "e", secretLeaseExec()))
	recvWithin(t, entered, "e's Exec")
	if keyLeased(p, "d") {
		t.Fatal("d, the one idle lease, survived e's admission")
	}

	// Nothing idle left: refused, and no running lease is touched.
	mustSetMode(t, p, "f", ModeLease, 1)
	if _, err := p.Exec(t.Context(), "f", secretLeaseExec(), &capturingSink{}); ReasonOf(err) != RefuseMemoryBudget {
		t.Fatalf("f with every lease running: err = %v, want %s", err, RefuseMemoryBudget)
	}
	for _, k := range []string{"a", "c", "e"} {
		if !keyLeased(p, k) {
			t.Fatalf("%s's running lease was reclaimed", k)
		}
	}
	close(release)
	for _, errc := range errs {
		if err := recvWithin(t, errc, "a running Exec"); err != nil {
			t.Fatalf("running Exec: %v", err)
		}
	}
	if n := p.Stats().LeaseEnds[LeaseEndMemoryReclaim]; n != 2 {
		t.Fatalf("LeaseEnds[memory_reclaim] = %d, want 2 (b, then d)", n)
	}
}

// With both available, a cold standby is shed before an idle lease (spec §6: standbys
// first, #452/#644's eviction, then leases).
func TestStandbysEvictedBeforeLeases(t *testing.T) {
	// One idle lease (LeaseStartBytes) and one per-Exec run's two standbys (PerVMBytes
	// each: the fake reports no standby footprint) fill the budget exactly.
	budget := DefaultLeaseStartBytes + 2*perVM
	p, lc, clk := leasePool(t, func(c *Config) { c.MaxCommittedBytes = budget })
	leaseOn(t, p, "lease")
	clk.Advance(time.Second)
	primed(t, p, clk, "standby") // epoch-0 per-Exec, then its standbys replenish
	if s := p.Stats(); s.CommittedBytes != budget {
		t.Fatalf("CommittedBytes = %d, want the whole budget %d", s.CommittedBytes, budget)
	}
	// The lease is now the idle-longest run, so only the order of the sources can spare it.
	leaseOn(t, p, "new")
	if !keyLeased(p, "lease") {
		t.Fatal("the idle lease was reclaimed while a standby could fund the admission")
	}
	if s := p.Stats(); s.BudgetEvictions != 1 || s.LeaseEnds[LeaseEndMemoryReclaim] != 0 {
		t.Fatalf("BudgetEvictions %d, LeaseEnds[memory_reclaim] %d; want one standby and no lease",
			s.BudgetEvictions, s.LeaseEnds[LeaseEndMemoryReclaim])
	}
	waitFor(t, func() bool { return lc.destroyedFor("standby") == 2 }) // its Exec VM, and one standby
}
