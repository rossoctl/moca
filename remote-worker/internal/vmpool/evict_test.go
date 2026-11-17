package vmpool

import (
	"context"
	"os"
	"testing"
	"time"
)

// #452's mechanism: a memory refusal on a user-visible path sheds the coldest idle
// standby instead of becoming a failed exec.
//
// Every test here sizes the budget in whole VMs via budgetPool and leaves StandbyDepth
// at the default 2, which is the shipped SH_STANDBY_DEPTH the issue was reported
// against.

// evictions reads the counter under test. Named rather than inlined because the
// assertion that matters is almost always a PAIR — evictions against
// Refusals[RefuseMemoryBudget] — and the two must be sampled from one snapshot.
func evictions(p Pool) (evicted uint64, refused uint64) {
	s := p.Stats()
	return s.BudgetEvictions, s.Refusals[RefuseMemoryBudget]
}

// TestABudgetRefusalShedsAStandbyInsteadOfFailing is #452 at its smallest: one host
// whose budget is entirely held by one idle session's standbys, and a second session
// arriving.
//
// Before this, run-b's first Exec came back as
// `memory-budget: committing 301989888 more bytes would reach ...` IN THE MODEL'S
// TRANSCRIPT, because there is no "busy" frame in the wire contract (errors.go) and the
// relay could only forward it as an ExecError. The assertion is therefore on the Exec
// succeeding, not merely on a counter moving.
func TestABudgetRefusalShedsAStandbyInsteadOfFailing(t *testing.T) {
	p, lc, clk := budgetPool(t, 2, 100)
	primed(t, p, clk, "run-a")
	if got, want := p.Stats().CommittedBytes, int64(2*288<<20); got != want {
		t.Fatalf("CommittedBytes = %d after priming one run, want %d — this test's premise is that run-a holds the WHOLE budget", got, want)
	}

	if _, err := p.Exec(context.Background(), "run-b", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("a second session on a budget-full host: %v — this is #452; it must evict rather than refuse", err)
	}

	evicted, refused := evictions(p)
	if evicted != 1 {
		t.Fatalf("BudgetEvictions = %d, want 1 — the Exec must have succeeded BY evicting, not by the ceiling failing to bind", evicted)
	}
	if refused != 0 {
		t.Fatalf("Refusals[%s] = %d, want 0 — nothing reached a transcript", RefuseMemoryBudget, refused)
	}
	// Exactly one standby, not the victim's whole ready list: shedding a coldest run's
	// full standby depth to admit one VM is spec §6's reclaim storm.
	//
	// waitFor, not a bare read: evictForBudgetLocked hands the VM to p.reclaimQ and
	// reclaimLoop calls Destroy off the hot path, so the destroy lands AFTER Exec
	// returns. BudgetEvictions above is incremented under p.mu and is therefore safe to
	// read synchronously; this counter is the launcher's, on the far side of the queue.
	waitForValue(t, `lc.destroyedFor("run-a")`, func() int { return lc.destroyedFor("run-a") }, 2)
	if n := lc.destroyedFor("run-a"); n != 2 {
		t.Fatalf("run-a destroys = %d, want 2 (its own exec VM, plus the ONE evicted standby)", n)
	}
}

// TestEvictionTakesTheLeastRecentlyUsedRun pins the ordering, which is the difference
// between eviction being a cost shifted onto the quietest session and a cost shifted
// onto a random one. LRU is by rp.lastExec — the same clock sweepOnce's idleFor reads,
// so eviction order and sweep order cannot disagree about which run is coldest.
func TestEvictionTakesTheLeastRecentlyUsedRun(t *testing.T) {
	p, lc, clk := budgetPool(t, 4, 100)
	primed(t, p, clk, "run-old")
	clk.Advance(5 * time.Second)
	primed(t, p, clk, "run-new")

	oldBefore, newBefore := lc.destroyedFor("run-old"), lc.destroyedFor("run-new")
	if _, err := p.Exec(context.Background(), "run-c", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec run-c: %v", err)
	}

	// The victim's destroy is asynchronous (see the note in the test above), so wait for
	// it rather than reading straight after Exec. Waiting for the POSITIVE half first is
	// also what makes the negative half below meaningful: once the evicted VM has been
	// destroyed the reclaim queue has drained past this eviction, so a zero for run-new is
	// "run-new was not the victim" rather than "the reclaim loop has not got there yet".
	waitForValue(t, `lc.destroyedFor("run-old") - oldBefore`, func() int { return lc.destroyedFor("run-old") - oldBefore }, 1)
	if got := lc.destroyedFor("run-old") - oldBefore; got != 1 {
		t.Fatalf("run-old lost %d standbys, want 1 — the coldest run is the victim", got)
	}
	if got := lc.destroyedFor("run-new") - newBefore; got != 0 {
		t.Fatalf("run-new lost %d standbys, want 0 — the most recently used run must be left alone", got)
	}
}

// TestEvictionKeepsTheWorkspaceOnDisk is the half of sweepOnce this deliberately does
// NOT fire. A memory signal is about RAM; deleting a live session's tree to make room
// for a DIFFERENT session would turn a recoverable cold start into #338's silent reset.
// Spec §4.4's two thresholds exist for exactly this distinction.
func TestEvictionKeepsTheWorkspaceOnDisk(t *testing.T) {
	p, lc, clk := budgetPool(t, 2, 100)
	var dir string
	lc.setBeforeRestore(func(r RestoreRequest) {
		if r.Key == "run-a" && dir == "" {
			dir = r.WorkspaceDir
		}
	})
	primed(t, p, clk, "run-a")

	// A marker, because "the same tree" has to mean the same bytes and not merely the
	// same path.
	marker := dir + "/converged"
	if err := os.WriteFile(marker, []byte("pinned commit"), 0o600); err != nil {
		t.Fatalf("write marker: %v", err)
	}

	if _, err := p.Exec(context.Background(), "run-b", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("Exec run-b: %v", err)
	}
	if evicted, _ := evictions(p); evicted == 0 {
		t.Fatal("nothing was evicted, so this test is not exercising what it claims")
	}
	// Wait for the reclaim to actually land before stat'ing. The counter above moves under
	// p.mu, but the teardown that COULD have taken the workspace runs on the reclaim loop —
	// so checking the marker while that is still queued would assert "not deleted yet"
	// instead of "never deleted".
	waitForValue(t, `lc.destroyedFor("run-a")`, func() int { return lc.destroyedFor("run-a") }, 2)

	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("stat %s after run-a was evicted: %v — eviction costs the victim a cold acquire, never its workspace", marker, err)
	}
}

// TestEvictionCannotTakeAVMFromABusyRun is the safety bound. rp.busy() staying true is
// what stops a reclaim landing under a running command, and it is also what makes
// self-eviction impossible at both call sites without a special case.
//
// So on a host that is genuinely full of WORK rather than of idle residency, the
// refusal still happens — which is correct. The two counters are what tell those states
// apart, and the assertion covers both: this is the reading
// Stats.BudgetEvictions documents.
func TestEvictionCannotTakeAVMFromABusyRun(t *testing.T) {
	p, lc, _ := budgetPool(t, 2, 100)
	release, entered := hold(lc)
	defer release()

	for _, k := range []string{"run-a", "run-b"} {
		go func(k string) {
			_, _ = p.Exec(context.Background(), k, Exec{Command: "sleep"}, &capturingSink{})
		}(k)
		<-entered
	}

	err := mustFail(t, p, "run-c")
	if got := ReasonOf(err); got != RefuseMemoryBudget {
		t.Fatalf("reason = %q, want %q — a host full of in-flight work must still refuse (err=%v)", got, RefuseMemoryBudget, err)
	}
	evicted, refused := evictions(p)
	if evicted != 0 {
		t.Fatalf("BudgetEvictions = %d, want 0 — there was no idle standby to take", evicted)
	}
	if refused != 1 {
		t.Fatalf("Refusals[%s] = %d, want 1 — a refusal that eviction could not prevent must still be counted", RefuseMemoryBudget, refused)
	}
}

// TestAMaxRunsRefusalDoesNotEvict keeps the two ceilings separate, which spec §6
// requires ("a memory-driven refusal is recorded distinctly from a MaxRuns refusal, or
// the two ceilings get conflated and neither is diagnosable").
//
// Parking a run DOES drop it out of unparkedRunsLocked, so eviction could have been
// wired to relieve MaxRuns too. It must not be: MaxRuns bounds concurrent workspace
// KEYS, and shedding a key's standbys does not shed the key — so this would shed RAM
// nobody asked for and then refuse anyway.
func TestAMaxRunsRefusalDoesNotEvict(t *testing.T) {
	p, lc, clk := budgetPool(t, 100, 1) // memory is abundant; MaxRuns is the binding ceiling
	primed(t, p, clk, "run-a")
	before := lc.destroyedFor("run-a")

	if got := ReasonOf(mustFail(t, p, "run-b")); got != RefuseMaxRuns {
		t.Fatalf("reason = %q, want %q", got, RefuseMaxRuns)
	}
	if evicted, _ := evictions(p); evicted != 0 {
		t.Fatalf("BudgetEvictions = %d, want 0 — only the memory gate evicts", evicted)
	}
	if got := lc.destroyedFor("run-a") - before; got != 0 {
		t.Fatalf("run-a lost %d standbys to a MaxRuns refusal, want 0", got)
	}
}

// TestDistinctSessionsPastTheBudgetNoLongerFail is #452's own repro: "create more
// distinct P4 sessions than the budget holds VMs, all within SH_WORKSPACE_IDLE". On the
// rig that was ~14 committed VMs and then three dead sessions; here the budget is two
// VMs and six sessions arrive.
//
// It also covers the SECOND admission site, which the single-eviction tests above do
// not reach. From the third session onward the host holds a parked, zero-standby run
// whose next turn takes acquire's cold path — so the admission needing relief is
// acquire's warming charge (pool.go), not runLocked's new key. Both go through
// admitOrEvictLocked; a fix applied to only one of them fails here around session 4.
func TestDistinctSessionsPastTheBudgetNoLongerFail(t *testing.T) {
	p, _, clk := budgetPool(t, 2, 100)

	keys := []string{"sess-1", "sess-2", "sess-3", "sess-4", "sess-5", "sess-6"}
	for _, k := range keys {
		if _, err := p.Exec(context.Background(), k, Exec{Command: "true"}, &capturingSink{}); err != nil {
			t.Fatalf("session %s: %v — a host's capacity must not leak away as distinct sessions arrive (#452)", k, err)
		}
		// Let the replenish timers run, so each session leaves resident standbys behind
		// exactly as a real one does. Without this the budget never fills and the test
		// passes vacuously.
		clk.Advance(time.Duration(DefaultStandbyDepth+1) * DefaultReplenishDelay)
	}

	// A SECOND TURN for the first session, which is the part P6.3 affinity guarantees
	// will happen: its sandbox is pinned, so it comes back to this host after its
	// standbys are long gone.
	if _, err := p.Exec(context.Background(), keys[0], Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("second turn for %s: %v", keys[0], err)
	}

	evicted, refused := evictions(p)
	if refused != 0 {
		t.Fatalf("Refusals[%s] = %d, want 0 — every one of those is a failed exec in a transcript", RefuseMemoryBudget, refused)
	}
	if evicted == 0 {
		t.Fatal("BudgetEvictions = 0 — the budget was never actually pressed, so this test proves nothing; check that the replenish advance still fills standbys")
	}
	// The ceiling is still a ceiling: eviction shifts cost, it does not create memory.
	if got, want := p.Stats().CommittedBytes, int64(2*288<<20); got > want {
		t.Fatalf("CommittedBytes = %d, want <= %d — eviction must never admit past the budget", got, want)
	}
}
