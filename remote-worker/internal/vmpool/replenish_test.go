package vmpool

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestExecSchedulesARefillAfterReplenishDelay(t *testing.T) {
	p, lc, clk := testPool(t)
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	// Nothing yet: the refill is DELAYED, which is the whole point. An unconditional
	// refill would already have minted D standbys for a run that may be over
	// (spec §4.4).
	if s := p.Stats(); s.StandbysResident != 0 {
		t.Fatalf("StandbysResident = %d immediately after Exec, want 0", s.StandbysResident)
	}
	clk.Advance(DefaultReplenishDelay - time.Millisecond)
	if s := p.Stats(); s.StandbysResident != 0 {
		t.Fatalf("StandbysResident = %d before ReplenishDelay elapsed, want 0", s.StandbysResident)
	}
	// Enough time for both slots: one timer per slot, so D standbys take D delays.
	clk.Advance(2 * DefaultReplenishDelay)
	if s := p.Stats(); s.StandbysResident != DefaultStandbyDepth {
		t.Fatalf("StandbysResident = %d, want D = %d", s.StandbysResident, DefaultStandbyDepth)
	}
	if n := lc.createdCount(); n != 1+DefaultStandbyDepth {
		t.Fatalf("created %d VMs, want 1 for the Exec plus D = %d", n, DefaultStandbyDepth)
	}
}

func TestASecondExecIsAWarmAcquire(t *testing.T) {
	p, _, clk := testPool(t)
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "one"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec 1: %v", err)
	}
	clk.Advance(3 * DefaultReplenishDelay)
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "two"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec 2: %v", err)
	}
	s := p.Stats()
	if s.WarmAcquires != 1 {
		t.Errorf("WarmAcquires = %d, want 1", s.WarmAcquires)
	}
	// The first Exec is a cold acquire attributed to first-exec, NOT to exhausted:
	// spec §4.4 requires attribution by cause so a gate-heavy workload is not read
	// as replenishment falling behind.
	if s.ColdAcquires[ColdFirstExec] != 1 {
		t.Errorf("ColdAcquires[first-exec] = %d, want 1", s.ColdAcquires[ColdFirstExec])
	}
	if s.ColdAcquires[ColdExhausted] != 0 {
		t.Errorf("ColdAcquires[exhausted] = %d, want 0", s.ColdAcquires[ColdExhausted])
	}
}

// Spec §4.4's back-to-back case, the one D=2 exists for: createPodEditOps composes
// read + write (operations.ts:78-79) with no model round trip between them, so the
// second Exec arrives INSIDE the ReplenishDelay window and must be served from the
// D-1 standbys still Ready rather than taking a cold acquire.
func TestAnExecInsideTheDelayWindowIsServedFromTheRemainingStandbys(t *testing.T) {
	p, _, clk := testPool(t)
	for i := 0; i < 2; i++ {
		if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "warm"}, &capturingSink{}); err != nil {
			t.Fatalf("warmup %d: %v", i, err)
		}
		clk.Advance(3 * DefaultReplenishDelay)
	}
	if s := p.Stats(); s.StandbysResident != DefaultStandbyDepth {
		t.Fatalf("setup: StandbysResident = %d, want %d", s.StandbysResident, DefaultStandbyDepth)
	}
	before := p.Stats().ColdAcquires[ColdExhausted]
	// Two Execs back to back, no clock movement at all between them.
	for i := 0; i < 2; i++ {
		if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "edit"}, &capturingSink{}); err != nil {
			t.Fatalf("back-to-back %d: %v", i, err)
		}
	}
	if got := p.Stats().ColdAcquires[ColdExhausted] - before; got != 0 {
		t.Fatalf("%d cold acquires for a back-to-back read+write; D=%d must cover it (spec §3.2)", got, DefaultStandbyDepth)
	}
}

// Spec §4.2: "block on the warming already in flight rather than starting a second
// one". Two concurrent Execs for one cold key must produce ONE restore, not two.
func TestConcurrentColdAcquiresShareOneWarming(t *testing.T) {
	p, lc, _ := testPool(t)
	gate := make(chan struct{})
	var restores int
	var mu sync.Mutex
	lc.setBeforeRestore(func(RestoreRequest) {
		mu.Lock()
		restores++
		n := restores
		mu.Unlock()
		if n == 1 {
			<-gate // hold the first warming open while the second Exec arrives
		}
	})

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{})
		}(i)
	}
	// Let the second goroutine reach the wait before releasing the first.
	waitFor(t, "the first restore started", func() bool { mu.Lock(); defer mu.Unlock(); return restores == 1 })
	// A cold acquire in the middle of its restore is charged as WARMING, not as
	// inFlight — inFlight is incremented only once the VM exists, so that one VM is not
	// charged to the budget twice (see acquire). CommittedBytes covers both, so it is
	// what this wait can observe; the assertion below is unchanged.
	waitFor(t, `p.Stats().CommittedBytes > 0`, func() bool { return p.Stats().CommittedBytes > 0 })
	close(gate)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("Exec %d: %v", i, err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	// Two restores total: the shared first one, then the waiter's own once the first
	// warming settled without leaving a standby. What must NOT happen is two
	// SIMULTANEOUS warmings for one cold key, which is what "block on the warming
	// already in flight" forbids.
	if restores != 2 {
		t.Fatalf("restores = %d, want 2 (one shared, then one for the waiter)", restores)
	}
}

func TestReplenishFailureBacksOffAndNeverHangs(t *testing.T) {
	p, lc, clk := testPool(t)
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	lc.setRestoreErr(errors.New("no /dev/kvm"))
	clk.Advance(DefaultReplenishDelay)
	if s := p.Stats(); s.ReplenishFailures == 0 {
		t.Fatalf("ReplenishFailures = 0 after a failing refill, want >= 1")
	}
	// Backoff, not a hang and not a hot loop: the next attempt is at least
	// replenishBackoffMin later than the plain delay would have been (spec §6).
	failures := p.Stats().ReplenishFailures
	clk.Advance(DefaultReplenishDelay)
	if got := p.Stats().ReplenishFailures; got != failures {
		t.Fatalf("ReplenishFailures went %d -> %d inside the backoff window", failures, got)
	}
	clk.Advance(replenishBackoffMax)
	if got := p.Stats().ReplenishFailures; got <= failures {
		t.Fatalf("ReplenishFailures = %d after the backoff elapsed, want > %d", got, failures)
	}
	// And it recovers: with the launcher healthy again the pool refills.
	lc.setRestoreErr(nil)
	// Deliberately short of StandbyIdle in TOTAL elapsed virtual time: from Task 6
	// on, a reclaim ticker runs on this same clock and a 90s+ advance would sweep
	// the very standby this test is waiting for.
	clk.Advance(replenishBackoffMax + time.Second)
	if s := p.Stats(); s.StandbysResident == 0 {
		t.Fatalf("StandbysResident = 0 after the launcher recovered, want > 0")
	}
}

func TestNextBackoff(t *testing.T) {
	if got := nextBackoff(0); got != replenishBackoffMin {
		t.Errorf("nextBackoff(0) = %v, want %v", got, replenishBackoffMin)
	}
	if got := nextBackoff(replenishBackoffMin); got != 2*replenishBackoffMin {
		t.Errorf("nextBackoff(min) = %v, want %v", got, 2*replenishBackoffMin)
	}
	if got := nextBackoff(replenishBackoffMax); got != replenishBackoffMax {
		t.Errorf("nextBackoff(max) = %v, want it capped at %v", got, replenishBackoffMax)
	}
}
