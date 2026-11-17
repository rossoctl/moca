package vmpool

import (
	"context"
	"errors"
	"testing"
	"time"
)

// blockUntilCancelled makes every Run park until its run context ends, and reports the
// Command each Run was handed — so a test can assert both WHEN the bound fired and what
// timeout_s the guest was told to enforce.
func blockUntilCancelled(lc *fakeLauncher) <-chan Command {
	seen := make(chan Command, 8)
	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
		seen <- c
		<-c.ctxDone
		return Result{}, context.Canceled
	})
	return seen
}

// mustReturn waits for a bound that is supposed to have fired already. Every caller
// below is asserting that SOMETHING bounds the call, so a plain `<-done` would hang the
// whole package on the very regression these tests exist to catch, and the failure would
// arrive as a 90-second panic naming a goroutine rather than as this message.
func mustReturn(t *testing.T, done <-chan error, what string) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(testWaitBound):
		t.Fatalf("%s: still running %s after its bound should have fired — nothing is bounding it", what, testWaitBound)
		return nil
	}
}

// notYet asserts an Exec still has not returned. A bounded wait rather than a bare
// sleep, matching the convention in serialize_test.go: the point is that the bound has
// NOT fired yet, and a test that cannot tell "not yet" from "never" would pass whether
// or not the clamp used the value it claims to.
func notYet(t *testing.T, done <-chan error, what string) {
	t.Helper()
	select {
	case err := <-done:
		t.Fatalf("%s: Exec returned %v already — the bound fired earlier than the value under test", what, err)
	case <-time.After(100 * time.Millisecond):
	}
}

// TestAnExecThatNamesNoTimeoutIsStillBounded is finding 1's core. timeout_s is a plain
// proto3 field, so "absent" arrives as 0, and the host timer used to be armed only for
// TimeoutS > 0 — an Exec{command:"cat"} with no timeout pinned a live VM, its
// admission-control reservation and (on the serializing arm) every later Exec for the
// run, until the relay stream died.
//
// The assertion is in two halves on purpose: first that nothing fires just short of
// DefaultExecTimeoutS (so this cannot pass because of some other, smaller bound), then
// that the default itself fires and tears the VM down like any other timeout.
func TestAnExecThatNamesNoTimeoutIsStillBounded(t *testing.T) {
	p, lc, clk := testPool(t)
	seen := blockUntilCancelled(lc)

	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "run-a", Exec{Command: "cat"}, &capturingSink{})
		done <- err
	}()
	<-seen

	clk.Advance(time.Duration(DefaultExecTimeoutS)*time.Second - time.Second)
	notYet(t, done, "one second short of DefaultExecTimeoutS")

	// Advance EXACTLY to the deadline, not past it: fakeClock.Advance fires every
	// timer due at-or-before its target, including ones armed by callbacks while it
	// loops. The timer fires mid-Advance with the virtual clock AT the deadline, and
	// the unwinding Exec's destroy arms a replenish timer ReplenishDelay out — an
	// overshoot of a second or more lets Advance fire that refill (and its chained
	// second slot) mid-loop, minting standbys the liveCount assertion below reads as
	// a leak ("2 VMs live, want 0" is exactly StandbyDepth phantoms; seen on CI,
	// 2026-09-22). Advancing exactly to the deadline leaves that timer strictly in
	// the future. Same convention as pool_test.go's timeout tests.
	clk.Advance(time.Second)
	if err := mustReturn(t, done, "an Exec with no timeout_s"); !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout at DefaultExecTimeoutS", err)
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("%d VMs live after the default bound fired, want 0", n)
	}
	if got := p.Stats().TimeoutsClamped; got != 1 {
		t.Fatalf("Stats().TimeoutsClamped = %d, want 1 — a clamped timeout must be visible, not silent", got)
	}
}

// TestTheGuestIsToldTheClampedTimeout is the other half of the same finding: the guest
// arms its own timer from the timeout_s in the Request frame, and it gates that timer on
// `> 0` exactly as the host used to. Sending the caller's raw 0 while the host enforced
// 30 minutes would leave the two sides holding different budgets for one command.
func TestTheGuestIsToldTheClampedTimeout(t *testing.T) {
	p, lc, clk := testPool(t)
	seen := blockUntilCancelled(lc)

	go func() { _, _ = p.Exec(context.Background(), "run-a", Exec{Command: "cat"}, &capturingSink{}) }()
	c := <-seen
	if c.TimeoutS != DefaultExecTimeoutS {
		t.Fatalf("guest was told timeout_s=%d, want the clamped %d — the two sides must not be able to disagree", c.TimeoutS, DefaultExecTimeoutS)
	}
	clk.Advance(time.Duration(DefaultExecTimeoutS) * time.Second)
}

// TestATimeoutAboveTheCeilingIsClampedToIt covers the other unbounded-in-practice case:
// timeout_s is a uint32, so a caller can ask for 136 years.
func TestATimeoutAboveTheCeilingIsClampedToIt(t *testing.T) {
	p, lc, clk := testPool(t)
	seen := blockUntilCancelled(lc)

	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "run-a", Exec{Command: "cat", TimeoutS: MaxExecTimeoutS + 3600}, &capturingSink{})
		done <- err
	}()
	c := <-seen
	if c.TimeoutS != MaxExecTimeoutS {
		t.Fatalf("guest was told timeout_s=%d, want the ceiling %d", c.TimeoutS, MaxExecTimeoutS)
	}

	clk.Advance(time.Duration(MaxExecTimeoutS)*time.Second - time.Second)
	notYet(t, done, "one second short of MaxExecTimeoutS")

	// Exactly to the deadline — see TestAnExecThatNamesNoTimeoutIsStillBounded for
	// why an overshoot lets Advance fire the destroyed Exec's replenish refill.
	clk.Advance(time.Second)
	if err := mustReturn(t, done, "an Exec above MaxExecTimeoutS"); !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout at MaxExecTimeoutS", err)
	}
	if got := p.Stats().TimeoutsClamped; got != 1 {
		t.Fatalf("Stats().TimeoutsClamped = %d, want 1", got)
	}
}

// TestALegitimateTimeoutIsNeverClamped is the guard on the guard. A clamp that
// truncated a legitimate long command would be worse than the unbounded case it
// replaces, so pin both ends of the accepted range and the counter that must stay at
// zero across them.
func TestALegitimateTimeoutIsNeverClamped(t *testing.T) {
	for _, timeoutS := range []uint32{1, 45, DefaultExecTimeoutS, MaxExecTimeoutS} {
		p, lc, _ := testPool(t)
		var got uint32
		lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
			got = c.TimeoutS
			return Result{ExitCode: 0}, nil
		})
		if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true", TimeoutS: timeoutS}, &capturingSink{}); err != nil {
			t.Fatalf("timeout_s=%d: Exec: %v", timeoutS, err)
		}
		if got != timeoutS {
			t.Fatalf("timeout_s=%d reached the guest as %d — a legitimate value must pass through untouched", timeoutS, got)
		}
		if n := p.Stats().TimeoutsClamped; n != 0 {
			t.Fatalf("timeout_s=%d: TimeoutsClamped = %d, want 0", timeoutS, n)
		}
	}
}

// TestProbeIsBoundedWhenTheGuestNeverAnswers pins the same finding's second half.
// Probe exists to fail the unit at START; its caller passes context.Background(), and
// the timeout_s in its Command only arms the GUEST's timer. A guest that accepts the
// vsock connection and never answers used to hang worker startup indefinitely — the
// opposite of what Probe is for.
func TestProbeIsBoundedWhenTheGuestNeverAnswers(t *testing.T) {
	p, lc, clk := testPool(t)
	seen := blockUntilCancelled(lc)

	done := make(chan error, 1)
	go func() { done <- p.Probe(context.Background()) }()
	<-seen

	clk.Advance(probeTimeout - time.Second)
	select {
	case err := <-done:
		t.Fatalf("Probe returned %v before its deadline — the bound must be probeTimeout, not something shorter", err)
	case <-time.After(100 * time.Millisecond):
	}

	clk.Advance(2 * time.Second)
	if err := mustReturn(t, done, "Probe against a guest that never answers"); err == nil {
		t.Fatal("Probe returned nil against a guest that never answered — startup must fail, not hang")
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("%d VMs live after a bounded Probe, want 0", n)
	}
}
