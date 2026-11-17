package vmpool

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// reapingLauncher is fakeLauncher with VMs that split their teardown the way
// firecrackerVM does: a barrier that ends when the VMM can no longer touch the workspace,
// then a reap tail. blockReap gates the tail so a test can hold it open and observe what the
// pool does MEANWHILE -- which is the entire point of the change.
type reapingLauncher struct {
	*fakeLauncher
	blockReap  chan struct{}
	barrierErr error

	mu        sync.Mutex
	barriers  []string // vm ids whose barrier completed, in order
	reaps     []string // vm ids whose reap completed, in order
	reapCount map[string]int
}

func newReapingLauncher() *reapingLauncher {
	l := &reapingLauncher{fakeLauncher: newFakeLauncher(), reapCount: map[string]int{}}
	l.setSerialize(true)
	return l
}

func (l *reapingLauncher) Restore(ctx context.Context, req RestoreRequest) (VM, error) {
	vm, err := l.fakeLauncher.Restore(ctx, req)
	if err != nil {
		return nil, err
	}
	return &reapingVM{VM: vm, lc: l, id: req.ID}, nil
}

type reapingVM struct {
	VM
	lc *reapingLauncher
	id string
}

func (v *reapingVM) KillAndBarrier() error {
	if v.lc.barrierErr != nil {
		return v.lc.barrierErr
	}
	v.lc.mu.Lock()
	v.lc.barriers = append(v.lc.barriers, v.id)
	v.lc.mu.Unlock()
	return nil
}

func (v *reapingVM) Reap() error {
	if v.lc.blockReap != nil {
		// BOUNDED, not an indefinite park. The inline fallback runs the tail on the CALLER's
		// goroutine -- which is correct, it is exactly today's synchronous teardown -- so a reap
		// that never returns wedges the Exec that triggered the fallback, and the test hangs
		// rather than failing. Holding it for a bounded window still keeps every worker busy
		// long enough to fill the queue and force the fallback.
		select {
		case <-v.lc.blockReap:
		case <-time.After(250 * time.Millisecond):
		}
	}
	v.lc.mu.Lock()
	v.lc.reaps = append(v.lc.reaps, v.id)
	v.lc.reapCount[v.id]++
	v.lc.mu.Unlock()
	return v.VM.Destroy()
}

func (l *reapingLauncher) counts() (barriers, reaps int, perVM map[string]int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := map[string]int{}
	for k, v := range l.reapCount {
		out[k] = v
	}
	return len(l.barriers), len(l.reaps), out
}

func testReapingPool(t *testing.T, workers int) (Pool, *reapingLauncher) {
	t.Helper()
	lc := newReapingLauncher()
	cfg := Config{
		VMM:               lc.Kind(),
		SnapshotDir:       t.TempDir(),
		WorkspaceRoot:     t.TempDir(),
		MaxRuns:           16,
		MaxCommittedBytes: 32 << 30,
		DeferReapWorkers:  workers,
	}
	p, err := New(cfg, lc, newFakeClock())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return p, lc
}

// THE THROUGHPUT CLAIM, as a test. execGate is held "until this VM is fully destroyed (and
// its mount released)", and cmd.Wait inside that is 52.88 ms at c=64 -- half of a 104 ms
// per-Exec. Measured, 96% of it happens AFTER the VMM has closed every descriptor
// (fdgone median 1.41 ms), so the gate's stated purpose is met at the barrier. This asserts
// the gate actually opens there: a second Exec for the SAME key must reach Run while the
// first VM's reap is still blocked.
func TestDeferredReapOpensTheGateAtTheBarrierNotAfterTheReap(t *testing.T) {
	p, lc := testReapingPool(t, 4)
	lc.blockReap = make(chan struct{})
	defer func() { close(lc.blockReap); _ = p.Close() }()

	entered := make(chan struct{}, 2)
	lc.setRunFn(func(v *fakeVM, c Command, out Sink) (Result, error) {
		entered <- struct{}{}
		return Result{ExitCode: 0}, nil
	})

	if _, err := p.Exec(context.Background(), "run-a", Exec{ReqID: 1, Command: "one", TimeoutS: 5}, discardingSink{}); err != nil {
		t.Fatalf("first Exec: %v", err)
	}
	<-entered

	// The first VM's reap is parked in Reap() right now. If the gate were still held for it,
	// this Exec would block until the deferred close above -- i.e. forever within this test.
	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "run-a", Exec{ReqID: 2, Command: "two", TimeoutS: 5}, discardingSink{})
		done <- err
	}()
	// done READY DOES NOT MEAN Run was skipped. The fake Run sends on entered (buffered) and
	// returns at once, so the second Exec can finish and fill done before this goroutine reaches
	// the select; with both cases ready Go picks one at random (#805). Run's send happens before
	// Exec returns, so a done with nothing on entered is the only real "returned without
	// entering Run" -- check entered without blocking before calling it that.
	var secondErr error
	secondDone := false
	select {
	case <-entered:
	case err := <-done:
		select {
		case <-entered:
			secondErr, secondDone = err, true
		default:
			t.Fatalf("second Exec returned without entering Run: %v", err)
		}
	case <-time.After(3 * time.Second):
		barriers, reaps, _ := lc.counts()
		t.Fatalf("second Exec never reached Run while a reap was outstanding: the gate is "+
			"still held across the reap (barriers=%d reaps=%d)", barriers, reaps)
	}
	// NOT VACUOUS: the first VM's tail must still be unfinished at this point, or the second
	// Exec simply followed a reap that had already completed and this test would pass with the
	// gate held across the reap exactly as before.
	if barriers, reaps, _ := lc.counts(); reaps != 0 || barriers == 0 {
		t.Fatalf("barriers=%d reaps=%d when the second Exec reached Run: wanted the barrier "+
			"passed and the reap still outstanding, so this asserts the gate opened AT the barrier",
			barriers, reaps)
	}
	if !secondDone {
		secondErr = <-done
	}
	if secondErr != nil {
		t.Fatalf("second Exec: %v", secondErr)
	}
}

// A deferred reap that never runs is #255 by another route: a leaked jail directory and a
// cgroup never returned to the pool, collectable only by the next process's startup sweep.
// Close already waits for in-flight warms and the reclaim goroutine for this exact reason;
// the reaper must be drained beside them.
func TestCloseDrainsEveryDeferredReapExactlyOnce(t *testing.T) {
	p, lc := testReapingPool(t, 4)

	const n = 12
	for i := 0; i < n; i++ {
		if _, err := p.Exec(context.Background(), "run-a", Exec{ReqID: uint64(i + 1), Command: "c", TimeoutS: 5}, discardingSink{}); err != nil {
			t.Fatalf("Exec %d: %v", i, err)
		}
	}
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	barriers, reaps, perVM := lc.counts()
	if barriers != n {
		t.Fatalf("barriers=%d, want %d", barriers, n)
	}
	if reaps != n {
		t.Fatalf("reaps=%d after Close, want %d: Close returned with teardown outstanding, "+
			"which leaks a jail directory and a cgroup per VM", reaps, n)
	}
	for id, c := range perVM {
		if c != 1 {
			t.Errorf("vm %s reaped %d times, want exactly 1", id, c)
		}
	}
}

// An unbounded backlog of exiting VMMs is a new failure mode, and spec §6 requires a storm to
// stay "counted, never queued unboundedly". A full queue must reap INLINE -- never drop the
// reap, never grow without bound. Reaping inline is exactly today's behaviour, which is the
// right floor for the degenerate case.
func TestAFullReapQueueFallsBackToReapingInline(t *testing.T) {
	p, lc := testReapingPool(t, 1)
	lc.blockReap = make(chan struct{})

	// One worker, all of it parked in the first reap, so everything after fills the queue and
	// then has to go inline.
	const n = 8
	for i := 0; i < n; i++ {
		if _, err := p.Exec(context.Background(), "run-a", Exec{ReqID: uint64(i + 1), Command: "c", TimeoutS: 5}, discardingSink{}); err != nil {
			t.Fatalf("Exec %d: %v", i, err)
		}
	}
	// Every Exec returned, so nothing was dropped and nothing deadlocked. Some reaps ran
	// inline; the counter says how many, and it must be non-zero or this test is vacuous.
	if got := p.Stats().ReapsInline; got == 0 {
		t.Fatalf("ReapsInline=0 with a blocked single worker and %d Execs: either the queue is "+
			"unbounded or the fallback never fired", n)
	}
	close(lc.blockReap)
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, reaps, _ := lc.counts(); reaps != n {
		t.Fatalf("reaps=%d, want %d: a queued reap was dropped", reaps, n)
	}
}

// The deferral is behind a config knob so the arm is an A/B on ONE binary (the campaign's
// "vary one thing" lesson). With it off, teardown must be exactly as it was: synchronous,
// inside the gate, through VM.Destroy -- not through the split at all.
func TestWithoutDeferReapWorkersTeardownStaysSynchronous(t *testing.T) {
	p, lc := testReapingPool(t, 0)
	defer func() { _ = p.Close() }()

	if _, err := p.Exec(context.Background(), "run-a", Exec{ReqID: 1, Command: "c", TimeoutS: 5}, discardingSink{}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	barriers, _, _ := lc.counts()
	if barriers != 0 {
		t.Fatalf("barriers=%d with DeferReapWorkers=0, want 0: the split ran anyway", barriers)
	}
	var destroyed int
	lc.fakeLauncher.mu.Lock()
	for _, c := range lc.fakeLauncher.destroyed {
		destroyed += c
	}
	lc.fakeLauncher.mu.Unlock()
	if destroyed != 1 {
		t.Fatalf("destroyed=%d, want 1 synchronous Destroy", destroyed)
	}
}

var _ = atomic.Int32{}

// An unobservable barrier must NOT defer. The barrier is the entire licence for opening the
// gate early -- #307's measurement is what makes "the VMM can no longer touch workspace.img"
// a checkable fact rather than an argument -- so when it cannot be checked, the old ordering
// is what is left: reap fully, synchronously, before the gate opens.
func TestAnUnobservableBarrierReapsSynchronouslyInsteadOfDeferring(t *testing.T) {
	p, lc := testReapingPool(t, 4)
	defer func() { _ = p.Close() }()
	lc.barrierErr = errors.New("cannot read /proc/1234/fd")

	if _, err := p.Exec(context.Background(), "run-a", Exec{ReqID: 1, Command: "c", TimeoutS: 5}, discardingSink{}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	// Exec has returned, so the gate is open. The reap must ALREADY have happened -- if it had
	// been handed to the reaper instead, it would still be pending here.
	if _, reaps, _ := lc.counts(); reaps != 1 {
		t.Fatalf("reaps=%d immediately after Exec returned, want 1: a VM whose barrier could "+
			"not be observed was deferred anyway, which opens the gate on an unchecked claim", reaps)
	}
	// Counted as its OWN reason, not as a destroy failure. The destroy succeeded -- it just did
	// not get to be deferred -- and DestroyFailures is exported in microvm-worker's diagnostics
	// where the natural reading is "failures per VM, at most one". Folding the barrier into it
	// double-counted a VM whose barrier was unreadable AND whose reap then failed, so a
	// falling-back arm would over-report against the VM count, which is the exact ratio you would
	// use to decide whether the fallback is firing.
	st := p.Stats()
	if st.BarrierUnobserved != 1 {
		t.Fatalf("BarrierUnobserved=%d, want 1", st.BarrierUnobserved)
	}
	if st.DestroyFailures != 0 {
		t.Fatalf("DestroyFailures=%d, want 0: the reap succeeded, only the barrier was "+
			"unobservable, and conflating the two double-counts", st.DestroyFailures)
	}
}

// The Firecracker arm is the only one with a gate to open, so it is the only VM that needs the
// split. A compile-time assertion because pool.destroy's type switch silently falls back to the
// synchronous path if it is ever lost -- which would read as "the deferral does nothing" in a
// throughput table rather than as a build error.
var _ deferredReaper = (*firecrackerVM)(nil)

// KillAndBarrier then Reap must do exactly what Destroy does, once, and leave the VM in the
// same state -- including refusing a later Destroy. Two entry points to one teardown is the
// hazard here (the jail unlinked twice, the cgroup released twice and handed to two tenants).
func TestKillAndBarrierThenReapIsExactlyOneTeardown(t *testing.T) {
	root := t.TempDir()
	const parent = "microvm.slice/microvm-vms.slice"
	if err := os.MkdirAll(filepath.Join(root, parent), 0o755); err != nil {
		t.Fatal(err)
	}
	cgp := newCgroupPool(parent, (256+32)<<20, root)
	rel, err := cgp.acquire()
	if err != nil {
		t.Fatal(err)
	}
	jailRoot := filepath.Join(t.TempDir(), "jail", "vm-42", "root")
	if err := os.MkdirAll(jailRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	vm := &firecrackerVM{id: "vm-42", key: "run-1", jailRoot: jailRoot, cgroups: cgp, cgroupRel: rel}

	// No process, so the barrier is trivially satisfied: there is nothing that could write.
	if err := vm.KillAndBarrier(); err != nil {
		t.Fatalf("KillAndBarrier: %v", err)
	}
	if err := vm.Reap(); err != nil {
		t.Fatalf("Reap: %v", err)
	}
	if _, err := os.Stat(jailRoot); !os.IsNotExist(err) {
		t.Fatalf("jail still present after Reap: %v", err)
	}
	if got := cgp.idle(); got != 1 {
		t.Fatalf("cgroupPool idle=%d after Reap, want 1 released", got)
	}
	// Idempotent across the two entry points, not just within one.
	if err := vm.Destroy(); err != nil {
		t.Fatalf("Destroy after Reap: %v", err)
	}
	if err := vm.Reap(); err != nil {
		t.Fatalf("second Reap: %v", err)
	}
	if got := cgp.idle(); got != 1 {
		t.Fatalf("cgroupPool idle=%d after a repeated teardown, want 1: the cgroup was "+
			"released twice and could be handed to two tenants", got)
	}
}
