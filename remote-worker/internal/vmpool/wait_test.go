package vmpool

import (
	"testing"
	"time"
)

// testWaitBound bounds a wait for something a real goroutine must do. It is a hang guard,
// not a latency budget: a correct run meets the condition long before it, so the bound only
// decides how long a regression takes to fail.
const testWaitBound = 30 * time.Second

// waitFor polls cond until it holds, for a real goroutine reaching a real blocking point.
// what names the condition in the failure.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	if !pollUntil(testWaitBound, cond) {
		t.Fatalf("%s never held within %s", what, testWaitBound)
	}
}

// waitForValue polls get until it returns want, and reports the last value seen if it
// never does.
func waitForValue[T comparable](t *testing.T, what string, get func() T, want T) {
	t.Helper()
	var got T
	if !pollUntil(testWaitBound, func() bool { got = get(); return got == want }) {
		t.Fatalf("%s never reached %v within %s (last saw %v)", what, want, testWaitBound, got)
	}
}

// pollUntil reports whether cond held before bound passed. cond is always evaluated once
// after the deadline is observed, so a process descheduled across the deadline still sees
// a condition that holds.
func pollUntil(bound time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(bound)
	for {
		expired := !time.Now().Before(deadline)
		if cond() {
			return true
		}
		if expired {
			return false
		}
		time.Sleep(time.Millisecond)
	}
}

func TestPollUntilRechecksAfterTheDeadline(t *testing.T) {
	// The first evaluation outlasts the deadline, as a descheduled process would; the
	// condition holds by the next one, which must still run.
	const bound = 10 * time.Millisecond
	calls := 0
	ok := pollUntil(bound, func() bool {
		calls++
		if calls == 1 {
			time.Sleep(2 * bound)
			return false
		}
		return true
	})
	if !ok {
		t.Fatalf("pollUntil = false after %d evaluations, want true: the condition held at the post-deadline check", calls)
	}
}

func TestPollUntilGivesUpOnAConditionThatNeverHolds(t *testing.T) {
	calls := 0
	if pollUntil(0, func() bool { calls++; return false }) {
		t.Fatal("pollUntil = true for a condition that never held")
	}
	if calls != 1 {
		t.Fatalf("cond evaluated %d times with an expired bound, want 1", calls)
	}
}
