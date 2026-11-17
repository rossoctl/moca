package vmpool

import (
	"context"
	"sync"
	"testing"
	"time"
)

// TestCloseWaitsForAnInFlightReplenishmentWarm pins the leak that made E10 rung 4's
// teardown-bulk fail on its first execution — and it is the LEAK, not the bulk path,
// that was at fault (see the ledger's "teardown-bulk diagnosed" entry).
//
// replenishOne's post-warm `case p.closed` branch already destroys a VM whose warming
// finished after Close, so the bookkeeping is right. What was missing is that Close did
// not WAIT for that branch to run. In a long-lived daemon that is merely untidy; in a
// process that exits when Close returns — every vmpoolctl invocation, so every E10 rung
// — the goroutine is killed mid-Restore and the jailer it already spawned survives it
// (Setpgid with no Pdeathsig, launcher_firecracker_unix.go), leaving a LIVE firecracker
// holding that VM id's API socket. The next process to mint the same id then dials that
// socket, finds a listener, and PUTs /snapshot/load into a microVM that is already
// loaded: Firecracker's "not supported after starting the microVM" (400).
//
// On the rig this fired on 1 run in 8 — a race, which is why it survived every earlier
// run of rungs 2 and 3 and only surfaced once a mode minted enough ids to reach the
// leaked one.
func TestCloseWaitsForAnInFlightReplenishmentWarm(t *testing.T) {
	p, lc, clk := testPool(t)

	// One Exec arms the refill timer; its own VM is destroyed by Exec's defer.
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	// Block the replenishment warm so it is PROVABLY in flight when Close is called.
	// The hook is installed after the Exec, so the next Restore is the refill's, and
	// only one can be in flight at a time (the next slot's timer is not armed until
	// this warm returns) — so sync.Once is belt-and-braces, not load-bearing.
	var once sync.Once
	entered := make(chan struct{})
	release := make(chan struct{})
	lc.setBeforeRestore(func(RestoreRequest) {
		once.Do(func() { close(entered) })
		<-release
	})

	// fakeClock.Advance fires callbacks synchronously, so it must not run on this
	// goroutine: the blocked hook would block Advance itself.
	go clk.Advance(DefaultReplenishDelay)
	<-entered

	closed := make(chan error, 1)
	go func() { closed <- p.Close() }()

	// The property: Close must not return while a warm whose VM it is responsible for
	// destroying is still in flight. Asserted as a happens-before with a generous
	// bound rather than as a latency — the unfixed Close returns in microseconds, five
	// orders of magnitude inside this window, so the margin is not a close call, and a
	// loaded machine can only make this spuriously GREEN, never spuriously red.
	select {
	case err := <-closed:
		t.Fatalf("Close returned (err=%v) while a replenishment warm was still in flight — "+
			"the process can now exit before that warm's VM is destroyed, leaking a live VMM "+
			"that holds this VM id's API socket", err)
	case <-time.After(500 * time.Millisecond):
	}

	close(release)
	if err := <-closed; err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Deterministic post-condition: nothing the launcher created is still live.
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("liveCount = %d after Close returned, want 0 — a VM outlived the pool", n)
	}
}

// TestCloseStillReturnsWhenNoWarmIsInFlight is the converse of the test above, and the
// reason branch discipline #3 exists: a Close that waited on a counter nothing ever
// decremented would satisfy "Close blocks while a warm is in flight" while deadlocking
// every real Close. With warming genuinely back at zero, Close must still return.
func TestCloseStillReturnsWhenNoWarmIsInFlight(t *testing.T) {
	p, lc, clk := testPool(t)
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	// Let the refills complete, so warming is genuinely back to zero.
	clk.Advance(3 * DefaultReplenishDelay)
	if s := p.Stats(); s.StandbysResident != DefaultStandbyDepth {
		t.Fatalf("StandbysResident = %d, want D = %d before closing", s.StandbysResident, DefaultStandbyDepth)
	}

	done := make(chan error, 1)
	go func() { done <- p.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Close: %v", err)
		}
	case <-time.After(testWaitBound):
		t.Fatal("Close did not return with no warm in flight — it is waiting on something that will never settle")
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("liveCount = %d after Close, want 0", n)
	}
}
