package vmpool

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

// #1005: a memory-budget refusal logs why the admission's eviction took no idle lease,
// so a refusal while an idle lease exists can be told apart: futile (the numbers), every
// idle lease's gate held, or the reclaim queue full.

// refusalLine is the one "memory-budget refusal" log line for key, failing if there is
// not exactly one.
func refusalLine(t *testing.T, logs *lockedBuffer, key string) string {
	t.Helper()
	var found []string
	for _, l := range strings.Split(logs.String(), "\n") {
		if strings.Contains(l, "vmpool: memory-budget refusal") && strings.Contains(l, `workspace_key="`+key+`"`) {
			found = append(found, l)
		}
	}
	if len(found) != 1 {
		t.Fatalf("memory-budget refusal lines for %q = %q, want exactly one", key, found)
	}
	return found[0]
}

func wantFields(t *testing.T, line string, fields ...string) {
	t.Helper()
	for _, f := range fields {
		if !strings.Contains(" "+line+" ", " "+f+" ") {
			t.Errorf("refusal line %q: missing %q", line, f)
		}
	}
}

func refuseLease(t *testing.T, p *pool, key string) {
	t.Helper()
	mustSetMode(t, p, key, ModeLease, 1)
	if _, err := p.Exec(t.Context(), key, secretLeaseExec(), &capturingSink{}); ReasonOf(err) != RefuseMemoryBudget {
		t.Fatalf("%s: err = %v, want %s", key, err, RefuseMemoryBudget)
	}
}

func TestRefusalLogsNoIdleLease(t *testing.T) {
	p, lc, clk := leasePool(t, func(c *Config) { c.MaxCommittedBytes = DefaultLeaseStartBytes })
	leasesOn(t, p, clk, "a")
	entered, release := blockRuns(lc)
	errc := execAsync(p, "a", secretLeaseExec())
	recvWithin(t, entered, "a's Exec")
	logs := captureLog(t)

	refuseLease(t, p, "b")
	wantFields(t, refusalLine(t, logs, "b"), "why=futile", "idle_leases=0", "gate_held=0", "lease_bytes=0",
		"short_by=201326592", "standby_bytes=0")
	close(release)
	if err := recvWithin(t, errc, "a's Exec"); err != nil {
		t.Fatalf("a's Exec: %v", err)
	}
}

func TestRefusalLogsGateHeld(t *testing.T) {
	p, _, clk := leasePool(t, func(c *Config) { c.MaxCommittedBytes = DefaultLeaseStartBytes })
	leasesOn(t, p, clk, "a")
	p.mu.Lock()
	gate := p.runs["a"].execGate
	p.mu.Unlock()
	gate <- struct{}{} // idle by its lease, but a holder (queued, starting or ending) has the gate
	defer func() { <-gate }()
	logs := captureLog(t)

	refuseLease(t, p, "b")
	wantFields(t, refusalLine(t, logs, "b"), "why=futile", "idle_leases=1", "gate_held=1", "lease_bytes=0")
	if !keyLeased(p, "a") {
		t.Fatal("a's lease, its gate held, was reclaimed")
	}
}

func TestRefusalLogsFutileWithTheIdleCharges(t *testing.T) {
	// a is idle at its measured charge (64 MiB x 1.25 = 80 MiB); c runs, unsampled at
	// LeaseStartBytes. b's start charge is then short by more than a could free: futile,
	// and a is kept.
	budget := int64(300 << 20)
	p, lc, clk := leasePool(t, func(c *Config) { c.MaxCommittedBytes = budget })
	lc.setLeaseBytes(64 << 20)
	leasesOn(t, p, clk, "a")
	waitFor(t, "a sampled", func() bool { return leaseCommitted(p) == 80<<20 })
	mustSetMode(t, p, "c", ModeLease, 1)
	entered, release := blockRuns(lc)
	errc := execAsync(p, "c", secretLeaseExec())
	recvWithin(t, entered, "c's Exec")
	logs := captureLog(t)

	refuseLease(t, p, "b")
	short := 80<<20 + 2*DefaultLeaseStartBytes - budget
	wantFields(t, refusalLine(t, logs, "b"), "why=futile", "idle_leases=1", "gate_held=0",
		"lease_bytes=83886080", "short_by="+strconv.FormatInt(short, 10))
	if !keyLeased(p, "a") {
		t.Fatal("a futile reclaim ended a's lease")
	}
	close(release)
	if err := recvWithin(t, errc, "c's Exec"); err != nil {
		t.Fatalf("c's Exec: %v", err)
	}
}

func TestRefusalLogsReclaimQueueFull(t *testing.T) {
	p, lc, clk := leasePool(t, func(c *Config) { c.MaxCommittedBytes = DefaultLeaseStartBytes })
	leasesOn(t, p, clk, "a")
	clk.Advance(time.Second)
	// reclaimLoop is held in a destroy, so the queue it drains stays full once filled.
	held, unhold := make(chan struct{}), make(chan struct{})
	lc.setDestroyHook(func(string) {
		select {
		case held <- struct{}{}:
			<-unhold
		default:
		}
	})
	vm, err := lc.Restore(t.Context(), RestoreRequest{ID: "stuck"})
	if err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	p.reclaimQ <- reclaimBatch{vms: []VM{vm}}
	p.mu.Unlock()
	recvWithin(t, held, "the held destroy")
	defer close(unhold)

	p.mu.Lock()
	for len(p.reclaimQ) < cap(p.reclaimQ) {
		p.reclaimQ <- reclaimBatch{}
	}
	logs := captureLog(t)
	err = p.admitLeaseOrEvictLocked("b", true)
	p.mu.Unlock()
	if ReasonOf(err) != RefuseMemoryBudget {
		t.Fatalf("err = %v, want %s", err, RefuseMemoryBudget)
	}
	wantFields(t, refusalLine(t, logs, "b"), "why=reclaim-queue-full", "idle_leases=1",
		"reclaim_queue=64/64")
	if !keyLeased(p, "a") {
		t.Fatal("a's lease was reclaimed with the queue full")
	}
}

// An admission the eviction funds logs nothing: the line is for refusals only.
func TestAFundedAdmissionLogsNoRefusal(t *testing.T) {
	p, _, clk := leasePool(t, func(c *Config) { c.MaxCommittedBytes = DefaultLeaseStartBytes })
	leasesOn(t, p, clk, "a")
	logs := captureLog(t)
	leaseOn(t, p, "b")
	if strings.Contains(logs.String(), "memory-budget refusal") {
		t.Fatalf("a funded admission logged a refusal: %q", logs.String())
	}
}
