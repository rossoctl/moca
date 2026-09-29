package main

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/vmpool"
)

// countingHooks records the HIGH WATER MARK of concurrent RestoreOne calls. That is the
// quantity under test: --concurrency is a promise about overlap, and a driver that
// accepts the flag and restores serially anyway reports a c=N rung that ran at c=1.
// #307 published a "flat across c=8/c=16" finding from exactly that defect on the exec
// path (one shared execGate); this is the same defect on the replenish path, where it is
// the loop rather than a gate.
type countingHooks struct {
	mu       sync.Mutex
	inFlight int
	maxSeen  int
	restores atomic.Int64

	// want is the concurrency the driver was asked for, and gate is a REAL BARRIER: it stays
	// closed until that many restores are simultaneously in flight, so every arrival holds its
	// peers until the peak has actually been reached.
	//
	// The previous version fed an unbuffered channel one token at a time, which did NOT deliver
	// the property its comment claimed. A worker could increment inFlight, take its token and
	// decrement again before any peer had incremented, so maxSeen was whatever the scheduler
	// produced -- 2 or 3 against a requested 4. That passed 30/30 without -race and failed 16/30
	// under it, which is the CI configuration ("Build and test remote-worker" runs go test -race).
	//
	// gateOnce is load-bearing. inFlight reaches want once per BATCH, not once per run: the
	// semaphore admits `want` goroutines, they release together, and the next batch can reach it
	// again. An unguarded close() therefore panics with "close of closed channel" -- reproduced
	// at iterations=400, concurrency=4 under -race. Rarer than the flake it replaces and strictly
	// worse, since a panic fails the whole package.
	want     int
	gate     chan struct{}
	gateOnce sync.Once
}

func (h *countingHooks) RestoreOne(_ context.Context, key string) (vmpool.VM, error) {
	h.mu.Lock()
	h.inFlight++
	if h.inFlight > h.maxSeen {
		h.maxSeen = h.inFlight
	}
	reached := h.inFlight >= h.want
	h.mu.Unlock()
	h.restores.Add(1)
	if reached {
		h.gateOnce.Do(func() { close(h.gate) })
	}
	// Bounded rather than a bare receive. A serial implementation can never reach want, so the
	// gate never opens and the honest outcome is a failure -- but hanging to the package timeout
	// reports it as "panic: test timed out" with no mention of concurrency. Waiting a bounded
	// time lets the assertion below name the actual defect, and it costs a failing run only.
	select {
	case <-h.gate:
	case <-time.After(5 * time.Second):
	}
	h.mu.Lock()
	h.inFlight--
	h.mu.Unlock()
	return &countingVM{key: key}, nil
}

// peak reports the high-water mark under the lock. wg.Wait() inside runReplenishMode already
// happens-before this read -- the detector reports no race on it across 30 runs -- but taking the
// lock keeps the invariant local to this type instead of resting on the caller's internals.
func (h *countingHooks) peak() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.maxSeen
}

func (h *countingHooks) FillStandbys(context.Context, string, int) error { return nil }
func (h *countingHooks) DestroyAllStandbys(context.Context) (int, error) { return 0, nil }

type countingVM struct{ key string }

func (v *countingVM) Key() string                  { return v.key }
func (v *countingVM) Resume(context.Context) error { return nil }
func (v *countingVM) Destroy() error               { return nil }
func (v *countingVM) Run(context.Context, vmpool.Command, vmpool.Sink) (vmpool.Result, error) {
	return vmpool.Result{}, nil
}

// The probe #307's deferred-reap question needs: an aggregate restore RATE at a fixed
// concurrency, with no Execs in the way. runReplenishMode was a serial for loop, so
// --concurrency=64 --mode=replenish measured c=1 and its wall-clock rate was a
// per-restore latency reciprocal rather than a supply ceiling.
func TestModeReplenishOverlapsRestoresAtTheRequestedConcurrency(t *testing.T) {
	const iterations, concurrency = 12, 4
	h := &countingHooks{want: concurrency, gate: make(chan struct{})}

	var res runResult
	samples, err := runReplenishMode(h, "run-a", iterations, 0, concurrency, &res)
	if err != nil {
		t.Fatalf("runReplenishMode: %v", err)
	}
	if got := len(samples); got != iterations {
		t.Fatalf("len(samples) = %d, want %d", got, iterations)
	}
	if got := h.restores.Load(); got != int64(iterations) {
		t.Fatalf("RestoreOne called %d times, want %d", got, iterations)
	}
	// Equality is sound BECAUSE the gate is a barrier: it cannot open until `concurrency`
	// restores are in flight, so a correct driver reaches exactly that peak and a serial one
	// cannot reach it at all. Asserting it against whatever the scheduler happened to produce is
	// what made this flaky; asserting >= 2 instead would pass a driver that overlaps two restores
	// when asked for sixty-four.
	if got := h.peak(); got != concurrency {
		t.Fatalf("peak concurrent RestoreOne = %d, want %d: --concurrency is being accepted and "+
			"ignored, so a c=%d rung measures c=%d", got, concurrency, concurrency, got)
	}
}

// A mode that ignores --concurrency must REFUSE it rather than silently run at c=1.
// This is the file's established posture for two lists that must agree (see the mode
// dispatcher's default case): make the disagreement loud instead of silent. The cost of
// the silent version is a published number that is wrong by the swept variable.
func TestConcurrencyIsRefusedByModesThatIgnoreIt(t *testing.T) {
	dir := t.TempDir()
	for _, mode := range []string{"teardown-inflight", "teardown-standby", "teardown-bulk"} {
		out, err := run(t, "--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
			"--key=run-a", "--mode="+mode, "--iterations=3", "--concurrency=4", "--", "true")
		if err == nil {
			t.Fatalf("--mode=%s --concurrency=4 was accepted; it runs serially, so the "+
				"rung would be labelled c=4 and measured at c=1 (out=%s)", mode, out)
		}
		if !strings.Contains(err.Error(), "concurrency") {
			t.Fatalf("--mode=%s: error %q does not mention concurrency", mode, err)
		}
	}
}

// ...and the modes that DO honour it must keep accepting it, or the refusal above has
// silently disabled the instrument it exists to protect.
func TestConcurrencyIsAcceptedByModesThatHonourIt(t *testing.T) {
	dir := t.TempDir()
	for _, mode := range []string{"exec", "replenish"} {
		if _, err := run(t, "--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
			"--key=run-a", "--mode="+mode, "--iterations=4", "--concurrency=2", "--", "true"); err != nil {
			t.Fatalf("--mode=%s --concurrency=2: %v", mode, err)
		}
	}
}

// "Record the configuration next to the number" is the campaign's most expensive lesson:
// #259's two-worker result and E11's c=8 knee were both reproducible, correctly reported, and
// meant something other than what they said, because MaxConcurrent=4 was not in the frame. The
// deferred reap (#307) is an A/B on one binary, so which arm a record came from has to be IN
// the record -- otherwise the two arms are distinguishable only by which shell loop wrote them.
func TestTheRecordCarriesWhetherTheReapWasDeferred(t *testing.T) {
	dir := t.TempDir()
	for _, workers := range []int{0, 8} {
		out, err := run(t, "--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
			"--key=run-a", "--iterations=2", "--warmup=0", "--json",
			"--defer-reap-workers="+strconv.Itoa(workers), "--", "true")
		if err != nil {
			t.Fatalf("workers=%d: %v (out=%s)", workers, err, out)
		}
		var rec runResult
		if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &rec); err != nil {
			t.Fatalf("not JSON: %v\n%s", err, out)
		}
		if rec.DeferReapWorkers != workers {
			t.Fatalf("DeferReapWorkers=%d, want %d: the arm is not in the record",
				rec.DeferReapWorkers, workers)
		}
		// A saturated reaper means the arm was only partly applied -- reaps that ran inline paid
		// the synchronous cost anyway -- and it is the first thing to check when a deferral arm
		// measures flat. It has to be readable from the record, not inferred.
		if !strings.Contains(out, `"reaps_inline"`) {
			t.Fatalf("record has no reaps_inline: a saturated reaper would be invisible\n%s", out)
		}
	}
}

// ReplenishDelay defaults to 200 ms, and at 64 slots a slot consumes a VM every ~102 ms -- so
// refilling cannot start until the slot has already been empty for ~100 ms, and a cold acquire
// is structural rather than a symptom of load. #307's deferred reap made the consumer 1.7x
// faster and pushed coldAcquireRateTrue from 0.161 to 0.741, which makes this the knob to sweep
// next. It was not reachable from the driver at all, so no rung had ever varied it.
func TestReplenishDelayIsSettableAndRecorded(t *testing.T) {
	dir := t.TempDir()
	for _, ms := range []int{200, 20} {
		out, err := run(t, "--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
			"--key=run-a", "--iterations=2", "--warmup=0", "--json",
			"--replenish-delay-ms="+strconv.Itoa(ms), "--", "true")
		if err != nil {
			t.Fatalf("ms=%d: %v (out=%s)", ms, err, out)
		}
		var rec runResult
		if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &rec); err != nil {
			t.Fatalf("not JSON: %v\n%s", err, out)
		}
		if rec.ReplenishDelayMs != ms {
			t.Fatalf("ReplenishDelayMs=%d, want %d: the knob is not in the record, so two "+
				"rungs that differ only by it are indistinguishable", rec.ReplenishDelayMs, ms)
		}
	}
}
