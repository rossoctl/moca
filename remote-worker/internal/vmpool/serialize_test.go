package vmpool

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// testSerializingPool is testPool's helper, but with SerializesExecsPerRun set to
// true BEFORE New is called. Pool.serialize is read once at construction (see
// pool.go's New), matching the real launchers — a real Firecracker launcher's
// answer never changes at runtime — so a test cannot flip it on an
// already-constructed pool the way testPool(t) builds one.
func testSerializingPool(t *testing.T) (Pool, *fakeLauncher, *fakeClock) {
	t.Helper()
	lc := newFakeLauncher()
	lc.setSerialize(true)
	p, clk := testPoolWith(t, lc)
	return p, lc, clk
}

// TestExecSerializesRunsPerKeyWhenLauncherRequiresIt is Step 8's required test:
// with a launcher reporting SerializesExecsPerRun() == true, two concurrent Execs
// for the SAME key must never have Run in flight at the same time — the ext4
// workspace image is not a shared-disk filesystem, so two guests mounting it at
// once would corrupt it (spec §4.3). See runPool.execGate's doc comment.
func TestExecSerializesRunsPerKeyWhenLauncherRequiresIt(t *testing.T) {
	p, lc, _ := testSerializingPool(t)

	var inFlight atomic.Int32
	entered := make(chan int32, 4)
	release := make(chan struct{})
	lc.setRunFn(func(v *fakeVM, c Command, out Sink) (Result, error) {
		n := inFlight.Add(1)
		entered <- n
		<-release
		inFlight.Add(-1)
		return Result{ExitCode: 0}, nil
	})

	done := make(chan struct{}, 2)
	go func() {
		_, _ = p.Exec(context.Background(), "run-a", Exec{ReqID: 1, Command: "one", TimeoutS: 5}, discardingSink{})
		done <- struct{}{}
	}()

	// Wait for the first Exec to actually enter Run before starting the second —
	// otherwise a race in launch order could make this test pass for the wrong
	// reason.
	select {
	case n := <-entered:
		if n != 1 {
			t.Fatalf("first entrant saw inFlight=%d, want 1", n)
		}
	case <-time.After(testWaitBound):
		t.Fatal("first Exec never entered Run")
	}

	go func() {
		_, _ = p.Exec(context.Background(), "run-a", Exec{ReqID: 2, Command: "two", TimeoutS: 5}, discardingSink{})
		done <- struct{}{}
	}()

	// The second Exec targets the SAME key, so it must block on execGate rather
	// than entering Run while the first still holds it. A bounded wait, not a
	// bare sleep, matches the convention in guestconn_test.go for this kind of
	// negative assertion.
	select {
	case n := <-entered:
		t.Fatalf("second Exec for the same key entered Run (inFlight=%d) while the first was still running", n)
	case <-time.After(200 * time.Millisecond):
		// Expected: the gate is held.
	}

	// Release the first; the second must now proceed through Run alone (never
	// overlapping the first, which has already fully exited by the time it is
	// released here).
	release <- struct{}{}
	<-done
	select {
	case n := <-entered:
		if n != 1 {
			t.Fatalf("second entrant saw inFlight=%d, want 1 — it overlapped another Run for the same key", n)
		}
	case <-time.After(testWaitBound):
		t.Fatal("second Exec for the same key never entered Run after the first was released")
	}
	release <- struct{}{}
	<-done
}

// TestAnExecWaitingOnTheRunGateCanStillBeCancelled pins the wait itself. A waiter that
// has reached the gate already holds an acquired VM with the budget charged and no
// destroy defer registered yet, so an unselectable sync.Mutex.Lock meant that neither
// the VM, its MaxCommittedBytes reservation, nor the run's workspace could be released
// while a wedged guest held the gate: one hung Exec blocked every subsequent Exec for
// that run indefinitely.
//
// That the gate really does hold a waiter is asserted by
// TestExecSerializesRunsPerKeyWhenLauncherRequiresIt above — this test would pass
// trivially against a pool that never serialized anything, so the two belong together.
// Both unwind paths are covered, because they classify differently: an abort must report
// ErrAborted and a TimeoutS expiry must report ErrTimeout, from the same select.
func TestAnExecWaitingOnTheRunGateCanStillBeCancelled(t *testing.T) {
	// holdFirstExec starts an Exec that occupies the gate and stays inside Run, and
	// returns a release for it. Every subtest needs the same setup: a wedged guest is
	// the only situation in which the gate is held long enough to matter.
	holdFirstExec := func(t *testing.T, p Pool, lc *fakeLauncher) (release func()) {
		t.Helper()
		// Buffered and sent to, not closed: if the gate ever lets the second Exec
		// through — which is exactly what a regression here would do once the first is
		// released — a second entrant must report that, not panic on a closed channel.
		entered := make(chan struct{}, 4)
		gate := make(chan struct{})
		lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
			entered <- struct{}{}
			<-gate
			return Result{ExitCode: 0}, nil
		})
		go func() {
			_, _ = p.Exec(context.Background(), "run-a", Exec{ReqID: 1, Command: "wedged", TimeoutS: 300}, discardingSink{})
		}()
		select {
		case <-entered:
		case <-time.After(testWaitBound):
			t.Fatal("the first Exec never entered Run")
		}
		return func() { close(gate) }
	}

	// waitingOnTheGate asserts the second Exec is parked on the gate rather than in Run,
	// the same bounded negative check the serialization test uses.
	waitingOnTheGate := func(t *testing.T, done <-chan error) {
		t.Helper()
		select {
		case err := <-done:
			t.Fatalf("the second Exec returned %v instead of waiting on the gate", err)
		case <-time.After(200 * time.Millisecond):
		}
	}

	t.Run("abort", func(t *testing.T) {
		p, lc, _ := testSerializingPool(t)
		release := holdFirstExec(t, p, lc)
		defer release()

		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			_, err := p.Exec(ctx, "run-a", Exec{ReqID: 2, Command: "queued", TimeoutS: 300}, discardingSink{})
			done <- err
		}()
		waitingOnTheGate(t, done)

		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, ErrAborted) {
				t.Fatalf("err = %v, want ErrAborted", err)
			}
		case <-time.After(testWaitBound):
			t.Fatal("a cancelled Exec never unwound from the gate — it is still queued behind a guest that will not answer")
		}
		// Its VM and its budget charge are released, not held until the wedged guest
		// finishes: the first Exec's VM is the only one that may still be alive.
		waitForValue(t, `lc.liveCount()`, func() int { return lc.liveCount() }, 1)
		waitForValue(t, `p.Stats().InFlight`, func() int { return p.Stats().InFlight }, 1)
	})

	t.Run("timeout", func(t *testing.T) {
		p, lc, clk := testSerializingPool(t)
		release := holdFirstExec(t, p, lc)
		defer release()

		done := make(chan error, 1)
		go func() {
			_, err := p.Exec(context.Background(), "run-a", Exec{ReqID: 2, Command: "queued", TimeoutS: 5}, discardingSink{})
			done <- err
		}()
		waitingOnTheGate(t, done)

		// Advance EXACTLY to the deadline, not past it: fakeClock.Advance fires every
		// timer due at-or-before its target, including ones armed by callbacks while
		// it loops. The timed-out Exec's destroy arms a replenish timer ReplenishDelay
		// out, and an overshoot of a second or more lets Advance fire that refill (and
		// its chained second slot) mid-loop — minting standbys the liveCount assertion
		// below then reads as a leak. Same convention as pool_test.go's timeout tests.
		clk.Advance(5 * time.Second)
		select {
		case err := <-done:
			// Not ErrAborted: the timer cancels runCtx, so classify must report the
			// timeout it is, or the worker emits a terminal signal frame where the wire
			// contract wants ExecError{"timeout:<n>"}.
			if !errors.Is(err, ErrTimeout) {
				t.Fatalf("err = %v, want ErrTimeout", err)
			}
		case <-time.After(testWaitBound):
			t.Fatal("a timed-out Exec never unwound from the gate")
		}
		waitForValue(t, `lc.liveCount()`, func() int { return lc.liveCount() }, 1)
		waitForValue(t, `p.Stats().InFlight`, func() int { return p.Stats().InFlight }, 1)
	})
}

// TestExecDoesNotSerializeAcrossDifferentKeys proves the gate above is scoped to
// one run (runPool.execGate), not the whole pool: two different keys must be able
// to run concurrently even though the launcher requires per-run serialization.
func TestExecDoesNotSerializeAcrossDifferentKeys(t *testing.T) {
	p, lc, _ := testSerializingPool(t)

	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	lc.setRunFn(func(v *fakeVM, c Command, out Sink) (Result, error) {
		entered <- struct{}{}
		<-release
		return Result{ExitCode: 0}, nil
	})

	done := make(chan struct{}, 2)
	go func() {
		_, _ = p.Exec(context.Background(), "run-a", Exec{ReqID: 1, Command: "one", TimeoutS: 5}, discardingSink{})
		done <- struct{}{}
	}()
	go func() {
		_, _ = p.Exec(context.Background(), "run-b", Exec{ReqID: 2, Command: "two", TimeoutS: 5}, discardingSink{})
		done <- struct{}{}
	}()

	// Both must enter Run without either being released first — if the gate were
	// global rather than per-run, the second would block here until the first's
	// release, and this loop would time out.
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(testWaitBound):
			t.Fatalf("only %d of 2 different-key Execs entered Run concurrently", i)
		}
	}

	close(release)
	<-done
	<-done
}
