package vmpool

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// Lease end events, status, acknowledgement, downgrade and restart (Task 5).

// secretCommand is the command text every Exec here runs: no audit line may carry it.
const secretCommand = "echo hunter2-command-text"

// lockedBuffer is a log sink safe for the pool's goroutines.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func captureLog(t *testing.T) *lockedBuffer {
	t.Helper()
	var b lockedBuffer
	prev := log.Writer()
	log.SetOutput(&b)
	t.Cleanup(func() { log.SetOutput(prev) })
	return &b
}

// leasePoolOn is leasePool over a given WorkspaceRoot and clock: a second process
// over the same host disk.
func leasePoolOn(t *testing.T, root string, clk *fakeClock) (*pool, *leaseLauncher) {
	t.Helper()
	plentyOfHostMemory(t) // no memory reclaim on the host's own MemAvailable (lease_reclaim_test.go)
	lc := newLeaseLauncher()
	p, err := New(Config{
		VMM:               lc.Kind(),
		SnapshotDir:       t.TempDir(),
		WorkspaceRoot:     root,
		MaxRuns:           16,
		MaxCommittedBytes: 32 << 30,
		ManifestFeatures:  []string{FeatureLeaseV1},
	}, lc, clk)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p.(*pool), lc
}

// blockRuns makes every Run block until release is closed (a clean End) or its context
// ends; entered receives one value per Run that started.
func blockRuns(lc *leaseLauncher) (entered chan struct{}, release chan struct{}) {
	entered, release = make(chan struct{}, 8), make(chan struct{})
	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
		entered <- struct{}{}
		select {
		case <-release:
			return Result{}, nil
		case <-c.ctxDone:
			return Result{}, ErrAborted
		}
	})
	return entered, release
}

// execAsync runs e on key in the background.
func execAsync(p *pool, key string, e Exec) <-chan error {
	errc := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), key, e, &capturingSink{})
		errc <- err
	}()
	return errc
}

// timerArmed reports whether clk has a live timer due exactly at at.
func timerArmed(clk *fakeClock, at time.Time) bool {
	clk.mu.Lock()
	defer clk.mu.Unlock()
	for _, tm := range clk.timers {
		if !tm.stopped && tm.at.Equal(at) {
			return true
		}
	}
	return false
}

func pinnedCount(p *pool, key string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if rp := p.runs[key]; rp != nil {
		return rp.pinned
	}
	return 0
}

func secretLeaseExec() Exec { return leaseExec(secretCommand, 1) }

// Ten of spec §4.1's eleven reasons, each through its real path (ruling R3:
// memory_reclaim's path is Task 6, which asserts its pending event there). Each leaves
// exactly one pending end event with that reason, LeaseStatus and the file agree, it is
// counted once, and the audit line has no command text.
func TestEveryEndReasonLeavesOnePendingEvent(t *testing.T) {
	type env struct {
		p   *pool
		lc  *leaseLauncher
		clk *fakeClock
	}
	cases := []struct {
		reason LeaseEndReason
		tweak  func(*Config)
		first  Exec
		// end drives the lease's end and returns the pool to inspect.
		end func(t *testing.T, e env) (*pool, *leaseLauncher)
	}{
		{reason: LeaseEndIdle, first: leaseExecIdle(secretCommand, 30*time.Second),
			end: func(t *testing.T, e env) (*pool, *leaseLauncher) {
				e.clk.Advance(31 * time.Second)
				return e.p, e.lc
			}},
		{reason: LeaseEndMaxDuration, tweak: func(c *Config) { c.LeaseMaxDuration = time.Minute },
			first: leaseExecIdle(secretCommand, 30*time.Second),
			end: func(t *testing.T, e env) (*pool, *leaseLauncher) {
				execEvery(t, e.p, e.clk, leaseExecIdle(secretCommand, 30*time.Second), 20*time.Second, 4)
				if !leaseExpiring(e.p) {
					t.Fatal("not expiring past LeaseMaxDuration")
				}
				e.clk.Advance(31 * time.Second)
				return e.p, e.lc
			}},
		{reason: LeaseEndGraceLimit, tweak: func(c *Config) {
			c.LeaseMaxDuration, c.LeaseGraceLimit = time.Minute, time.Minute
		}, first: secretLeaseExec(),
			end: func(t *testing.T, e env) (*pool, *leaseLauncher) {
				entered, _ := blockRuns(e.lc)
				errc := execAsync(e.p, "k", Exec{Command: secretCommand, TimeoutS: MaxExecTimeoutS, Mode: ModeLease, ModeEpoch: 1})
				recvWithin(t, entered, "the long Exec's Run")
				e.clk.Advance(2*time.Minute + 5*time.Second)
				if err := recvWithin(t, errc, "the cut Exec"); !errors.Is(err, ErrLeaseEnded) {
					t.Fatalf("err = %v, want ErrLeaseEnded", err)
				}
				return e.p, e.lc
			}},
		{reason: LeaseEndKeepaliveLost,
			first: Exec{Command: secretCommand, TimeoutS: 30, Mode: ModeLease, ModeEpoch: 1, Keepalive: true},
			end: func(t *testing.T, e env) (*pool, *leaseLauncher) {
				e.clk.Advance(121 * time.Second)
				return e.p, e.lc
			}},
		{reason: LeaseEndReset, first: secretLeaseExec(),
			end: func(t *testing.T, e env) (*pool, *leaseLauncher) {
				if err := e.p.EndLease("k", LeaseEndReset); err != nil {
					t.Fatalf("EndLease(reset): %v", err)
				}
				return e.p, e.lc
			}},
		{reason: LeaseEndModeChange, first: secretLeaseExec(),
			end: func(t *testing.T, e env) (*pool, *leaseLauncher) {
				mustSetMode(t, e.p, "k", ModePerExec, 2)
				return e.p, e.lc
			}},
		{reason: LeaseEndWorkerRestart, first: secretLeaseExec(),
			end: func(t *testing.T, e env) (*pool, *leaseLauncher) {
				if err := e.p.Close(); err != nil {
					t.Fatalf("Close: %v", err)
				}
				return leasePoolOn(t, e.p.cfg.WorkspaceRoot, e.clk)
			}},
		{reason: LeaseEndTeardownFailed, first: secretLeaseExec(),
			end: func(t *testing.T, e env) (*pool, *leaseLauncher) {
				e.lc.setRunFn(func(*fakeVM, Command, Sink) (Result, error) { return Result{TeardownFailed: true}, nil })
				mustExec(t, e.p, "k", secretLeaseExec())
				return e.p, e.lc
			}},
		{reason: LeaseEndAgentDead, first: secretLeaseExec(),
			end: func(t *testing.T, e env) (*pool, *leaseLauncher) {
				e.lc.setRunFn(func(*fakeVM, Command, Sink) (Result, error) {
					return Result{}, fmt.Errorf("%w: agent gone", ErrGuest)
				})
				if _, err := e.p.Exec(t.Context(), "k", secretLeaseExec(), &capturingSink{}); !errors.Is(err, ErrGuest) {
					t.Fatalf("err = %v, want the guest error", err)
				}
				return e.p, e.lc
			}},
		{reason: LeaseEndSandboxDeleted, first: secretLeaseExec(),
			end: func(t *testing.T, e env) (*pool, *leaseLauncher) {
				if err := e.p.EndLease("k", LeaseEndSandboxDeleted); err != nil {
					t.Fatalf("EndLease(sandbox_deleted): %v", err)
				}
				return e.p, e.lc
			}},
	}
	if len(cases) != 10 {
		t.Fatalf("%d reasons in the table, want ten (all but memory_reclaim)", len(cases))
	}
	for _, tc := range cases {
		t.Run(string(tc.reason), func(t *testing.T) {
			logs := captureLog(t)
			p, lc, clk := leasePool(t, tc.tweak)
			mustSetMode(t, p, "k", ModeLease, 1)
			mustExec(t, p, "k", tc.first)
			if info := p.LeaseStatus("k"); info.Pending == nil || info.Pending.State != "start" {
				t.Fatalf("after the first Exec, pending = %+v, want the lease start", info.Pending)
			}
			q, qlc := tc.end(t, env{p, lc, clk})
			leaseEnded(t, q, qlc, tc.reason)

			info := q.LeaseStatus("k")
			if info.Pending == nil || info.Pending.State != "end" || info.Pending.Reason != tc.reason {
				t.Fatalf("LeaseStatus pending = %+v, want end %s", info.Pending, tc.reason)
			}
			if info.State != LeaseNone {
				t.Fatalf("LeaseStatus state = %q, want %q", info.State, LeaseNone)
			}
			s := loadLeaseState(q.cfg.WorkspaceRoot, "k")
			if s.Pending == nil || !s.Pending.At.Equal(info.Pending.At) || s.Pending.Reason != tc.reason || s.Open != nil {
				t.Fatalf("file = %+v (pending %+v), want the same event as LeaseStatus and no open lease", s, s.Pending)
			}
			if n := q.Stats().LeaseEnds[tc.reason]; n != 1 {
				t.Fatalf("Stats().LeaseEnds[%s] = %d, want 1", tc.reason, n)
			}
			out := logs.String()
			if strings.Count(out, "vmpool: lease end ") != 1 || !strings.Contains(out, "reason="+string(tc.reason)) {
				t.Fatalf("want exactly one lease end audit line with reason=%s; log:\n%s", tc.reason, out)
			}
			if strings.Contains(out, secretCommand) {
				t.Fatalf("the log carries command text:\n%s", out)
			}
		})
	}
}

// End, start, end again: acknowledging the first end's At leaves the second.
func TestAckClearsOnlyThatEvent(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	e := leaseExecIdle("one", 30*time.Second)
	mustExec(t, p, "k", e)
	clk.Advance(31 * time.Second)
	leaseEnded(t, p, lc, LeaseEndIdle)
	first := p.LeaseStatus("k").Pending

	clk.Advance(time.Second)
	mustExec(t, p, "k", e) // a start while an end is pending: the end stays the notice
	if got := p.LeaseStatus("k").Pending; got == nil || !got.At.Equal(first.At) {
		t.Fatalf("pending after the restart = %+v, want the first end kept", got)
	}
	if err := p.EndLease("k", LeaseEndReset); err != nil {
		t.Fatalf("EndLease: %v", err)
	}
	second := p.LeaseStatus("k").Pending
	if second == nil || second.Reason != LeaseEndReset || second.At.Equal(first.At) {
		t.Fatalf("pending = %+v, want the second end (reset) at a later time", second)
	}

	p.AckLeaseEvent("k", first.At)
	if got := p.LeaseStatus("k").Pending; got == nil || got.Reason != LeaseEndReset || !got.At.Equal(second.At) {
		t.Fatalf("pending after acking the first = %+v, want the second kept", got)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending == nil || s.Pending.Reason != LeaseEndReset {
		t.Fatalf("file after acking the first = %+v, want the second kept", s)
	}

	p.AckLeaseEvent("k", second.At)
	if got := p.LeaseStatus("k").Pending; got != nil {
		t.Fatalf("pending after acking the second = %+v, want none", got)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending != nil || !s.Known || s.Mode != ModeLease {
		t.Fatalf("file after acking the second = %+v, want nothing pending and the mode kept", s)
	}

	// With nothing pending, the next start is the notice, and acknowledging it clears it.
	clk.Advance(time.Second)
	mustExec(t, p, "k", e)
	start := p.LeaseStatus("k").Pending
	if start == nil || start.State != "start" || start.Mode != ModeLease {
		t.Fatalf("pending after a start with nothing pending = %+v, want the start", start)
	}
	p.AckLeaseEvent("k", start.At)
	if got := p.LeaseStatus("k").Pending; got != nil {
		t.Fatalf("pending after acking the start = %+v, want none", got)
	}
}

// Review Focus 3: a worker restart with a lease open. The next process reports one pending
// worker_restart end, a third process does not report it again, and the first Exec after
// the restart starts a fresh lease.
func TestRestartEndsAnOpenLeaseOnce(t *testing.T) {
	logs := captureLog(t)
	root := t.TempDir()
	clk := newFakeClock()
	p1, _ := leasePoolOn(t, root, clk)
	mustSetMode(t, p1, "k", ModeLease, 1)
	mustExec(t, p1, "k", leaseExec("one", 1))
	clk.Advance(90 * time.Second)
	if err := p1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	clk.Advance(10 * time.Second)
	p2, _ := leasePoolOn(t, root, clk)
	info := p2.LeaseStatus("k")
	ev := info.Pending
	if ev == nil || ev.State != "end" || ev.Reason != LeaseEndWorkerRestart || ev.Mode != ModeLease {
		t.Fatalf("pending after the restart = %+v, want end worker_restart in mode lease", ev)
	}
	if ev.Age != 100*time.Second {
		t.Fatalf("worker_restart age = %v, want the open lease's age at the restart, 100s", ev.Age)
	}
	if info.State != LeaseNone || info.Mode != ModeLease || !info.EpochKnown {
		t.Fatalf("status = %+v, want no lease, the stored mode lease and a known epoch", info)
	}
	if s := loadLeaseState(root, "k"); s.Open != nil {
		t.Fatalf("file after the restart = %+v, want no open lease", s)
	}
	if n := p2.Stats().LeaseEnds[LeaseEndWorkerRestart]; n != 1 {
		t.Fatalf("LeaseEnds[worker_restart] = %d, want 1", n)
	}
	if err := p2.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	clk.Advance(10 * time.Second)
	p3, lc3 := leasePoolOn(t, root, clk)
	if got := p3.LeaseStatus("k").Pending; got == nil || !got.At.Equal(ev.At) {
		t.Fatalf("pending after a second restart = %+v, want the same event (at %v), not a second end", got, ev.At)
	}
	if n := p3.Stats().LeaseEnds[LeaseEndWorkerRestart]; n != 0 {
		t.Fatalf("a second restart counted %d worker_restart ends, want 0", n)
	}
	if n := strings.Count(logs.String(), "reason=worker_restart"); n != 1 {
		t.Fatalf("worker_restart audit lines = %d, want 1", n)
	}

	var ph Phases
	if _, err := p3.ExecPhased(t.Context(), "k", leaseExec("two", 1), &capturingSink{}, &ph); err != nil {
		t.Fatalf("Exec after the restart: %v", err)
	}
	if ph.Cold == "" || lc3.count("restore ") != 1 {
		t.Fatalf("cold = %q, restores = %d: want a fresh, cold lease VM", ph.Cold, lc3.count("restore "))
	}
	leaseAlive(t, p3, "after the first Exec on the restarted worker")
	if got := p3.LeaseStatus("k").Pending; got == nil || got.Reason != LeaseEndWorkerRestart {
		t.Fatalf("pending after the fresh start = %+v, want the unacknowledged worker_restart end kept", got)
	}
}

// A downgrade to per-exec ends the lease (mode_change) only after the in-flight Exec
// returns, and that Exec's result is its own.
func TestDowngradeToPerExecWaitsForTheInFlightExec(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	entered, release := blockRuns(lc)
	errc := execAsync(p, "k", leaseExec("work", 1))
	recvWithin(t, entered, "the Exec's Run")

	setc := make(chan error, 1)
	go func() { setc <- setModeErr(p, "k", ModePerExec, 2) }()
	time.Sleep(50 * time.Millisecond) // SetMode must be waiting for the Exec
	select {
	case err := <-setc:
		t.Fatalf("SetMode returned (%v) while the Exec was in flight", err)
	default:
	}
	leaseAlive(t, p, "during the in-flight Exec")
	close(release)
	if err := recvWithin(t, errc, "the in-flight Exec"); err != nil {
		t.Fatalf("the in-flight Exec: %v, want its own clean result", err)
	}
	if err := recvWithin(t, setc, "SetMode"); err != nil {
		t.Fatalf("SetMode: %v", err)
	}
	leaseEnded(t, p, lc, LeaseEndModeChange)
	if info := p.LeaseStatus("k"); info.Mode != ModePerExec || !info.EpochKnown || info.State != LeaseNone {
		t.Fatalf("status = %+v, want per-exec, known, no lease", info)
	}
}

// EndLease and a downgrade wait for the in-flight Exec for at most LeaseGraceLimit; then
// the Exec is cut with lease_ended(<reason>) and the lease ends with that reason.
func TestEndingALeaseIsBoundedByTheGraceLimit(t *testing.T) {
	for _, tc := range []struct {
		reason LeaseEndReason
		end    func(p *pool) error
	}{
		{LeaseEndReset, func(p *pool) error { return p.EndLease("k", LeaseEndReset) }},
		{LeaseEndModeChange, func(p *pool) error { return setModeErr(p, "k", ModePerExec, 2) }},
	} {
		t.Run(string(tc.reason), func(t *testing.T) {
			p, lc, clk := leasePool(t, nil)
			mustSetMode(t, p, "k", ModeLease, 1)
			entered, _ := blockRuns(lc)
			errc := execAsync(p, "k", Exec{Command: "long", TimeoutS: MaxExecTimeoutS, Mode: ModeLease, ModeEpoch: 1})
			recvWithin(t, entered, "the Exec's Run")
			endc := make(chan error, 1)
			deadline := clk.Now().Add(p.cfg.LeaseGraceLimit)
			go func() { endc <- tc.end(p) }()
			waitFor(t, func() bool { return timerArmed(clk, deadline) })

			clk.Advance(p.cfg.LeaseGraceLimit - time.Second)
			select {
			case err := <-errc:
				t.Fatalf("the Exec ended before the grace limit: %v", err)
			default:
			}
			clk.Advance(time.Second)
			err := recvWithin(t, errc, "the cut Exec")
			var le *LeaseEndedError
			if !errors.As(err, &le) || le.Reason != tc.reason {
				t.Fatalf("err = %v, want lease_ended(%s)", err, tc.reason)
			}
			if err := recvWithin(t, endc, "the end call"); err != nil {
				t.Fatalf("end call: %v", err)
			}
			leaseEnded(t, p, lc, tc.reason)
		})
	}
}

// Review I1: after the grace cut, EndLease ends the lease it was called for and only that
// one. A lease Exec queued behind the cut Exec starts a fresh lease, which EndLease leaves
// alone, and EndLease returns at the grace limit rather than after that Exec.
func TestEndLeaseAfterTheCutEndsOnlyThatLease(t *testing.T) {
	logs := captureLog(t)
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	entered, release := blockRuns(lc)
	long := Exec{Command: "long", TimeoutS: MaxExecTimeoutS, Mode: ModeLease, ModeEpoch: 1}
	errA := execAsync(p, "k", long)
	recvWithin(t, entered, "Exec a's Run")
	first := vmID(leaseAlive(t, p, "during Exec a").vm)
	errB := execAsync(p, "k", long)
	waitFor(t, func() bool { return pinnedCount(p, "k") == 2 }) // b waits on the gate

	endc := make(chan error, 1)
	deadline := clk.Now().Add(p.cfg.LeaseGraceLimit)
	go func() { endc <- p.EndLease("k", LeaseEndReset) }()
	waitFor(t, func() bool { return timerArmed(clk, deadline) })
	clk.Advance(p.cfg.LeaseGraceLimit)

	var le *LeaseEndedError
	if err := recvWithin(t, errA, "the cut Exec a"); !errors.As(err, &le) || le.Reason != LeaseEndReset {
		t.Fatalf("Exec a: %v, want lease_ended(reset)", err)
	}
	if err := recvWithin(t, endc, "EndLease at the grace limit"); err != nil {
		t.Fatalf("EndLease: %v", err)
	}
	recvWithin(t, entered, "Exec b's Run, in a fresh lease")
	second := leaseAlive(t, p, "while Exec b runs")
	if vmID(second.vm) == first || !second.running {
		t.Fatalf("live lease = %s (running %v), want b's fresh lease, not %s", vmID(second.vm), second.running, first)
	}
	if n := p.Stats().LeaseEnds[LeaseEndReset]; n != 1 {
		t.Fatalf("LeaseEnds[reset] = %d, want 1", n)
	}
	if n := strings.Count(logs.String(), "reason=reset"); n != 1 {
		t.Fatalf("reset audit lines = %d, want 1", n)
	}

	close(release)
	if err := recvWithin(t, errB, "Exec b"); err != nil {
		t.Fatalf("Exec b: %v", err)
	}
	if l := leaseAlive(t, p, "after Exec b"); l != second {
		t.Fatal("Exec b's lease did not survive EndLease")
	}
	if n := p.Stats().LeaseEnds[LeaseEndReset]; n != 1 {
		t.Fatalf("LeaseEnds[reset] after Exec b = %d, want 1", n)
	}
}

// A lease Exec that passed its epoch check before a downgrade, then waited on the gate, is
// refused stale-mode once it holds the gate: it never starts or reuses a lease under the
// lower mode.
func TestDowngradeRefusesALeaseExecQueuedBehindIt(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	entered, release := blockRuns(lc)
	errA := execAsync(p, "k", leaseExec("a", 1))
	recvWithin(t, entered, "Exec a's Run")
	errB := execAsync(p, "k", leaseExec("b", 1))
	waitFor(t, func() bool { return pinnedCount(p, "k") == 2 }) // b is past routeExec

	setc := make(chan error, 1)
	go func() { setc <- setModeErr(p, "k", ModePerExec, 2) }()
	waitFor(t, func() bool { return pinnedCount(p, "k") == 3 }) // SetMode waits on the gate
	close(release)

	if err := recvWithin(t, errA, "Exec a"); err != nil {
		t.Fatalf("Exec a: %v", err)
	}
	if err := recvWithin(t, errB, "Exec b"); ReasonOf(err) != RefuseStaleMode {
		t.Fatalf("Exec b: %v, want %s", err, RefuseStaleMode)
	}
	if err := recvWithin(t, setc, "SetMode"); err != nil {
		t.Fatalf("SetMode: %v", err)
	}
	leaseEnded(t, p, lc, LeaseEndModeChange)
	if n := lc.count("run "); n != 1 {
		t.Fatalf("Runs = %d, want only Exec a's", n)
	}
}

// lease+processes -> lease keeps the lease (plan 5 stops the tracked processes) and runs
// it at level 1 from then on (ruling R11).
func TestDowngradeToLeaseKeepsTheLease(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	mustExec(t, p, "k", Exec{Command: "one", TimeoutS: 30, Mode: ModeLeaseProcesses, ModeEpoch: 1})
	vm := vmID(leaseAlive(t, p, "after the first Exec").vm)
	mustSetMode(t, p, "k", ModeLease, 2)
	mustExec(t, p, "k", leaseExec("two", 2))
	if got := vmID(leaseAlive(t, p, "after the downgrade").vm); got != vm || lc.count("restore ") != 1 {
		t.Fatalf("lease VM = %s (restores %d), want %s kept", got, lc.count("restore "), vm)
	}
	if ev := p.LeaseStatus("k").Pending; ev == nil || ev.State != "start" {
		t.Fatalf("pending = %+v, want the start, no end", ev)
	}
	// Ruling R11: the lease now runs at level 1, on disk too, and level 1's maximum
	// duration applies, counted from the original start.
	if l := leaseAlive(t, p, "after the downgrade"); l.mode != ModeLease {
		t.Fatalf("lease mode = %s, want lease", l.mode)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Open == nil || s.Open.Mode != ModeLease {
		t.Fatalf("file = %+v, want the open lease recorded at mode lease", s)
	}
	step := 240 * time.Second
	e := leaseExec("work", 2)
	execEvery(t, p, clk, e, step, int(4*time.Hour/step)+1)
	if leaseExpiring(p) {
		t.Fatal("expiring at level 2's 4 h after a downgrade to lease")
	}
	execEvery(t, p, clk, e, step, int(4*time.Hour/step))
	if !leaseExpiring(p) {
		t.Fatal("not expiring at level 1's 8 h")
	}
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls = %d, want the one lease throughout", n)
	}
}

// An upgrade lease -> lease+processes that reaches the worker only on an Exec's newer
// epoch (no SetMode) takes effect from that Exec (spec §8.2, ruling R18): the lease is
// kept, at level 2, on disk too, with level 2's 4 h maximum counted from its start.
func TestExecEpochUpgradeRaisesTheLiveLease(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("one", 1))
	vm := vmID(leaseAlive(t, p, "after the first Exec").vm)
	e := Exec{Command: "two", TimeoutS: 30, Mode: ModeLeaseProcesses, ModeEpoch: 2}
	mustExec(t, p, "k", e)
	l := leaseAlive(t, p, "after the upgrade")
	if got := vmID(l.vm); got != vm || lc.count("restore ") != 1 {
		t.Fatalf("lease VM = %s (restores %d), want %s kept", got, lc.count("restore "), vm)
	}
	if l.mode != ModeLeaseProcesses {
		t.Fatalf("lease mode = %s, want lease+processes", l.mode)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Open == nil || s.Open.Mode != ModeLeaseProcesses {
		t.Fatalf("file = %+v, want the open lease recorded at mode lease+processes", s)
	}
	step := 240 * time.Second
	execEvery(t, p, clk, e, step, int(4*time.Hour/step)-1) // +3h56m
	if leaseExpiring(p) {
		t.Fatal("expiring before level 2's 4 h")
	}
	execEvery(t, p, clk, e, step, 1) // +4h
	leaseAlive(t, p, "+4h")
	if !leaseExpiring(p) {
		t.Fatal("not expiring at level 2's 4 h after an upgrade by Exec epoch")
	}
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls = %d, want the one lease throughout", n)
	}
}

// An upgrade by Exec epoch on a lease already past level 2's 4 h (but not its grace
// deadline) makes it expiring at once: it ends at its next idle, max_duration.
func TestExecEpochUpgradePastLevel2MaxExpiresAtOnce(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("one", 1))
	step := 240 * time.Second
	execEvery(t, p, clk, leaseExec("work", 1), step, int(4*time.Hour/step)+3) // +4h12m, level 1
	if leaseExpiring(p) {
		t.Fatal("a level-1 lease expiring at 4h12m")
	}
	mustExec(t, p, "k", Exec{Command: "up", TimeoutS: 30, Mode: ModeLeaseProcesses, ModeEpoch: 2})
	if l := leaseAlive(t, p, "after the upgrade"); l.mode != ModeLeaseProcesses || !l.expiring {
		t.Fatalf("lease mode = %s, expiring = %v; want lease+processes, expiring at once", l.mode, l.expiring)
	}
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls = %d, want the one lease", n)
	}
	clk.Advance(299 * time.Second)
	leaseAlive(t, p, "an expiring lease before its idle")
	clk.Advance(2 * time.Second)
	leaseEnded(t, p, lc, LeaseEndMaxDuration)
}

// A downgrade lease+processes -> lease that reaches the worker only on an Exec's newer
// epoch (LeaseControl lost) lands at that Exec (spec §8.2, ruling R18), as SetMode's does
// (ruling R11): the lease is kept, at level 1, with level 1's 8 h from its start.
func TestExecEpochDowngradeLowersTheLiveLease(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	mustExec(t, p, "k", Exec{Command: "one", TimeoutS: 30, Mode: ModeLeaseProcesses, ModeEpoch: 1})
	vm := vmID(leaseAlive(t, p, "after the first Exec").vm)
	e := leaseExec("two", 2)
	mustExec(t, p, "k", e)
	l := leaseAlive(t, p, "after the downgrade")
	if got := vmID(l.vm); got != vm || lc.count("restore ") != 1 {
		t.Fatalf("lease VM = %s (restores %d), want %s kept", got, lc.count("restore "), vm)
	}
	if l.mode != ModeLease {
		t.Fatalf("lease mode = %s, want lease", l.mode)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Open == nil || s.Open.Mode != ModeLease {
		t.Fatalf("file = %+v, want the open lease recorded at mode lease", s)
	}
	step := 240 * time.Second
	execEvery(t, p, clk, e, step, int(4*time.Hour/step)+1) // +4h4m
	if leaseExpiring(p) {
		t.Fatal("expiring at level 2's 4 h after a downgrade by Exec epoch")
	}
	execEvery(t, p, clk, e, step, int(4*time.Hour/step)) // +8h4m
	if !leaseExpiring(p) {
		t.Fatal("not expiring at level 1's 8 h")
	}
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls = %d, want the one lease throughout", n)
	}
}

func TestEndLeaseRefusesOtherReasons(t *testing.T) {
	p, _, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("one", 1))
	for _, r := range []LeaseEndReason{
		LeaseEndIdle, LeaseEndMaxDuration, LeaseEndGraceLimit, LeaseEndKeepaliveLost, LeaseEndModeChange,
		LeaseEndMemoryReclaim, LeaseEndWorkerRestart, LeaseEndTeardownFailed, LeaseEndAgentDead, "", "bogus",
	} {
		if err := p.EndLease("k", r); err == nil {
			t.Fatalf("EndLease(%q) = nil, want an error", r)
		}
	}
	leaseAlive(t, p, "after the refused EndLease calls")
	if err := p.EndLease("", LeaseEndReset); ReasonOf(err) != RefuseEmptyKey {
		t.Fatalf("EndLease on the empty key: %v, want %s", err, RefuseEmptyKey)
	}
	// No lease: nothing to end, and no state file appears.
	if err := p.EndLease("other", LeaseEndReset); err != nil {
		t.Fatalf("EndLease with no lease: %v", err)
	}
	if _, err := os.Stat(leaseStatePath(p.cfg.WorkspaceRoot, "other")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("state file for a key with no lease: %v, want none", err)
	}
}

func TestStatsCountLeases(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	if st := p.Stats(); st.LeaseVMs != 0 || st.LeaseExecuting != 0 || st.LeaseCommittedBytes != 0 || len(st.LeaseEnds) != 0 {
		t.Fatalf("fresh pool: %+v, want no lease figures", st)
	}
	for _, k := range []string{"a", "b"} {
		mustSetMode(t, p, k, ModeLease, 1)
		mustExec(t, p, k, leaseExec("one", 1))
	}
	st := p.Stats()
	if st.LeaseVMs != 2 || st.LeaseExecuting != 0 || st.LeaseCommittedBytes != 2*p.cfg.LeaseStartBytes {
		t.Fatalf("two idle leases: VMs %d, executing %d, committed %d; want 2, 0, %d",
			st.LeaseVMs, st.LeaseExecuting, st.LeaseCommittedBytes, 2*p.cfg.LeaseStartBytes)
	}
	entered, release := blockRuns(lc)
	errc := execAsync(p, "a", leaseExec("two", 1))
	recvWithin(t, entered, "the Exec's Run")
	if st := p.Stats(); st.LeaseVMs != 2 || st.LeaseExecuting != 1 {
		t.Fatalf("one lease running: VMs %d, executing %d; want 2, 1", st.LeaseVMs, st.LeaseExecuting)
	}
	close(release)
	if err := recvWithin(t, errc, "the Exec"); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if err := p.EndLease("b", LeaseEndReset); err != nil {
		t.Fatalf("EndLease: %v", err)
	}
	st = p.Stats()
	if st.LeaseVMs != 1 || st.LeaseExecuting != 0 || st.LeaseCommittedBytes != p.cfg.LeaseStartBytes {
		t.Fatalf("after one end: VMs %d, executing %d, committed %d; want 1, 0, %d",
			st.LeaseVMs, st.LeaseExecuting, st.LeaseCommittedBytes, p.cfg.LeaseStartBytes)
	}
	if len(st.LeaseEnds) != 1 || st.LeaseEnds[LeaseEndReset] != 1 {
		t.Fatalf("LeaseEnds = %v, want reset 1 only", st.LeaseEnds)
	}
}

// LeaseStatus reports the live lease: active with its age and idle timeout, then
// expiring past its maximum duration.
func TestLeaseStatusReportsActiveThenExpiring(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	if info := p.LeaseStatus("k"); info.State != LeaseNone || info.Mode != ModePerExec || info.EpochKnown || info.Pending != nil {
		t.Fatalf("unknown key: %+v, want none, per-exec, epoch unknown, nothing pending", info)
	}
	mustSetMode(t, p, "k", ModeLease, 1)
	e := leaseExecIdle("one", 20*time.Minute)
	mustExec(t, p, "k", e)
	clk.Advance(10 * time.Minute)
	info := p.LeaseStatus("k")
	if info.State != LeaseActive || info.Age != 10*time.Minute || info.IdleTimeout != 20*time.Minute || info.Mode != ModeLease {
		t.Fatalf("status = %+v, want active, age 10m, idle 20m, mode lease", info)
	}
	mustExec(t, p, "k", e)
	execEvery(t, p, clk, e, 15*time.Minute, int((8*time.Hour-10*time.Minute)/(15*time.Minute))+1)
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls = %d, want the one lease throughout", n)
	}
	if info := p.LeaseStatus("k"); info.State != LeaseExpiring {
		t.Fatalf("status past the maximum duration = %+v, want expiring", info)
	}
}

// Ruling R9: a pending end event survives the removal of its workspace. The state file
// keeps only the event: the mode is per-exec and the epoch unknown until SetMode.
func TestPendingEndSurvivesWorkspaceRemoval(t *testing.T) {
	for _, tc := range []struct {
		name   string
		remove func(t *testing.T, p *pool, clk *fakeClock)
	}{
		{"workspace idle", func(t *testing.T, p *pool, clk *fakeClock) {
			clk.Advance(200 * time.Second)
		}},
		{"Reclaim", func(t *testing.T, p *pool, clk *fakeClock) {
			if err := p.Reclaim(t.Context(), "k"); err != nil {
				t.Fatalf("Reclaim: %v", err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, lc, clk := leasePool(t, func(c *Config) {
				c.StandbyIdle = 60 * time.Second
				c.WorkspaceIdle = 120 * time.Second
			})
			mustSetMode(t, p, "k", ModeLease, 1)
			mustExec(t, p, "k", leaseExecIdle("one", 30*time.Second))
			clk.Advance(31 * time.Second)
			leaseEnded(t, p, lc, LeaseEndIdle)
			ended := p.LeaseStatus("k").Pending
			waitFor(t, func() bool { return pinnedCount(p, "k") == 0 }) // the sweep's destroy is done

			tc.remove(t, p, clk)
			waitFor(t, func() bool {
				p.mu.Lock()
				defer p.mu.Unlock()
				return p.runs["k"] == nil
			})
			info := p.LeaseStatus("k")
			if info.Pending == nil || info.Pending.Reason != LeaseEndIdle || !info.Pending.At.Equal(ended.At) {
				t.Fatalf("pending after the workspace removal = %+v, want the idle end %+v", info.Pending, ended)
			}
			// The mode and epoch are the control plane's, not the tree's: they stay (F3).
			if info.Mode != ModeLease || !info.EpochKnown || info.State != LeaseNone {
				t.Fatalf("status = %+v, want lease, epoch known, no lease running", info)
			}
			s := loadLeaseState(p.cfg.WorkspaceRoot, "k")
			if !s.Known || s.Epoch != 1 || s.Mode != ModeLease || s.Open != nil || !s.RootWrote || s.Pending == nil {
				t.Fatalf("file = %+v, want lease at epoch 1, root_wrote, the pending event", s)
			}

			// Acknowledged, the event goes and the mode stays.
			p.AckLeaseEvent("k", ended.At)
			if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending != nil || !s.Known || s.Mode != ModeLease || s.Epoch != 1 {
				t.Fatalf("file after acknowledging its event = %+v, want the mode and epoch, nothing pending", s)
			}
		})
	}
}

// PR #763 review (F3): a lease sandbox whose workspace was reclaimed while idle (over
// lunch) is still a lease sandbox. Its next Exec at the same epoch starts a lease, and
// normalises the new tree; an older epoch is still refused stale-mode.
func TestLeaseModeSurvivesAnIdleWorkspaceReclaim(t *testing.T) {
	for _, tc := range []struct {
		name   string
		remove func(t *testing.T, p *pool, clk *fakeClock)
	}{
		{"workspace idle", func(t *testing.T, p *pool, clk *fakeClock) { clk.Advance(200 * time.Second) }},
		{"Reclaim", func(t *testing.T, p *pool, clk *fakeClock) {
			if err := p.Reclaim(t.Context(), "k"); err != nil {
				t.Fatalf("Reclaim: %v", err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, lc, clk := leasePool(t, func(c *Config) {
				c.StandbyIdle = 60 * time.Second
				c.WorkspaceIdle = 120 * time.Second
			})
			mustSetMode(t, p, "k", ModeLease, 2)
			e := leaseExecIdle("one", 30*time.Second)
			e.ModeEpoch = 2
			mustExec(t, p, "k", e)
			clk.Advance(31 * time.Second)
			leaseEnded(t, p, lc, LeaseEndIdle)
			waitFor(t, func() bool { return pinnedCount(p, "k") == 0 })
			tc.remove(t, p, clk)
			waitFor(t, func() bool {
				p.mu.Lock()
				defer p.mu.Unlock()
				return p.runs["k"] == nil
			})

			if _, err := p.Exec(t.Context(), "k", leaseExec("stale", 1), &capturingSink{}); ReasonOf(err) != RefuseStaleMode {
				t.Fatalf("Exec at epoch 1 after the reclaim: err = %v, want %s", err, RefuseStaleMode)
			}
			mustExec(t, p, "k", leaseExec("two", 2))
			if liveLease(p, "k") == nil {
				t.Fatalf("Exec at epoch 2 after the reclaim started no lease (state %+v)", loadLeaseState(p.cfg.WorkspaceRoot, "k"))
			}
			// Two lease starts, each normalising: the first lease's (R7) and the new tree's.
			if n := len(lc.normaliseCommands()); n != 2 {
				t.Fatalf("normalise steps = %d, want 2: the new tree's lease normalises it", n)
			}
			if steps := guestSteps(lc); len(steps) < 2 || !strings.HasPrefix(steps[len(steps)-2], "normalise ") {
				t.Fatalf("normalise steps and Runs = %v, want the new tree's normalise step just before its first Run", steps)
			}
		})
	}
}

// holdGateWithCut takes key's gate as a holder that runs nothing and cuts the idle lease
// with reason: the state endLeaseWaiting's grace bound leaves when no Exec is inside Run.
// The returned func releases the gate.
func holdGateWithCut(t *testing.T, p *pool, key string, reason LeaseEndReason) func() {
	t.Helper()
	p.mu.Lock()
	rp := p.runs[key]
	p.mu.Unlock()
	rp.execGate <- struct{}{}
	p.mu.Lock()
	rp.lease.cut = reason
	p.mu.Unlock()
	return func() { <-rp.execGate }
}

// Ruling R12: a lease Exec that takes the gate of a cut lease never calls Run on its VM.
// The lease ends with the cut's reason, and the Exec fails lease_ended(<reason>).
func TestQueuedExecOnACutLeaseNeverRuns(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("one", 1))
	release := holdGateWithCut(t, p, "k", LeaseEndReset)
	errc := execAsync(p, "k", leaseExec("two", 1))
	waitFor(t, func() bool { return pinnedCount(p, "k") == 1 }) // queued on the gate
	release()

	var le *LeaseEndedError
	if err := recvWithin(t, errc, "the queued Exec"); !errors.As(err, &le) || le.Reason != LeaseEndReset {
		t.Fatalf("queued Exec: %v, want lease_ended(reset)", err)
	}
	if n := lc.count("run "); n != 1 {
		t.Fatalf("Runs = %d, want 1: the queued Exec ran nothing", n)
	}
	leaseEnded(t, p, lc, LeaseEndReset)
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls = %d, want 1: no fresh lease for the failed Exec", n)
	}
	if ends := p.Stats().LeaseEnds; len(ends) != 1 || ends[LeaseEndReset] != 1 {
		t.Fatalf("LeaseEnds = %v, want reset 1 only", ends)
	}
}

// Ruling R12: a per-Exec Exec that takes the gate of a cut lease ends it with the cut's
// reason, not mode_change, and then runs as usual.
func TestPerExecOnACutLeaseEndsItWithTheCutsReason(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("one", 1))
	release := holdGateWithCut(t, p, "k", LeaseEndReset)
	errc := execAsync(p, "k", Exec{Command: "per-exec", TimeoutS: 30})
	waitFor(t, func() bool { return pinnedCount(p, "k") == 1 }) // endFirst waits on the gate
	release()
	if err := recvWithin(t, errc, "the per-Exec Exec"); err != nil {
		t.Fatalf("per-Exec Exec: %v", err)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending == nil || s.Pending.Reason != LeaseEndReset {
		t.Fatalf("state = %+v, want the lease ended reset", s)
	}
	if ends := p.Stats().LeaseEnds; len(ends) != 1 || ends[LeaseEndReset] != 1 {
		t.Fatalf("LeaseEnds = %v, want reset 1 only", ends)
	}
	if lc.liveCount() != 0 || liveLease(p, "k") != nil {
		t.Fatalf("live VMs = %d, want 0 and no lease", lc.liveCount())
	}
}

// Ruling R12, through real paths: a downgrade whose grace bound passes while the first
// lease is still being started (Resume blocked) cuts that lease before any Exec is inside
// Run. The starting Exec then never calls Run; it fails lease_ended(mode_change).
func TestCutDuringLeaseStartNeverRuns(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	inResume := make(chan struct{}, 1)
	resume := make(chan struct{})
	lc.setResumeFn(func(*fakeVM, context.Context) error {
		inResume <- struct{}{}
		<-resume
		return nil
	})
	errc := execAsync(p, "k", Exec{Command: "first", TimeoutS: MaxExecTimeoutS, Mode: ModeLease, ModeEpoch: 1})
	recvWithin(t, inResume, "the lease start's Resume")

	setc := make(chan error, 1)
	deadline := clk.Now().Add(p.cfg.LeaseGraceLimit)
	go func() { setc <- setModeErr(p, "k", ModePerExec, 2) }()
	waitFor(t, func() bool { return timerArmed(clk, deadline) })
	clk.Advance(p.cfg.LeaseGraceLimit)
	waitFor(t, func() bool { l := liveLease(p, "k"); return l != nil && leaseCut(p, l) == LeaseEndModeChange })
	close(resume)

	var le *LeaseEndedError
	if err := recvWithin(t, errc, "the starting Exec"); !errors.As(err, &le) || le.Reason != LeaseEndModeChange {
		t.Fatalf("starting Exec: %v, want lease_ended(mode_change)", err)
	}
	if err := recvWithin(t, setc, "SetMode"); err != nil {
		t.Fatalf("SetMode: %v", err)
	}
	if n := lc.count("run "); n != 0 {
		t.Fatalf("Runs = %d, want 0: the cut lease ran nothing", n)
	}
	leaseEnded(t, p, lc, LeaseEndModeChange)
}

func leaseCut(p *pool, l *vmLease) LeaseEndReason {
	p.mu.Lock()
	defer p.mu.Unlock()
	return l.cut
}

// PR #763 review (F9): a client acknowledges an event by its At, and a JS client's Date
// holds milliseconds. Every event is minted at millisecond precision -- the start, an end,
// and the worker_restart end the next process records -- so an acknowledgement carrying
// that millisecond clears it.
func TestAckWithAMillisecondTimeClearsTheEvent(t *testing.T) {
	jsDate := func(at time.Time) time.Time { return time.UnixMilli(at.UnixMilli()).UTC() }
	ackClears := func(t *testing.T, p *pool, what string) {
		t.Helper()
		ev := p.LeaseStatus("k").Pending
		if ev == nil {
			t.Fatalf("%s: no pending event", what)
		}
		if ev.At.Nanosecond()%int(time.Millisecond) != 0 {
			t.Errorf("%s: At = %s, want whole milliseconds", what, ev.At.Format(time.RFC3339Nano))
		}
		p.AckLeaseEvent("k", jsDate(ev.At))
		if got := p.LeaseStatus("k").Pending; got != nil {
			t.Fatalf("%s: pending after a millisecond ack = %+v, want none", what, got)
		}
	}
	root := t.TempDir()
	clk := newFakeClock()
	clk.Advance(1234567 * time.Nanosecond) // a clock between two milliseconds
	p, _ := leasePoolOn(t, root, clk)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("one", 1))
	ackClears(t, p, "the start")

	clk.Advance(time.Second + 7*time.Microsecond)
	if err := p.EndLease("k", LeaseEndReset); err != nil {
		t.Fatalf("EndLease: %v", err)
	}
	ackClears(t, p, "the reset end")

	clk.Advance(3 * time.Microsecond)
	mustExec(t, p, "k", leaseExec("two", 1))
	p.AckLeaseEvent("k", p.LeaseStatus("k").Pending.At) // the start, acknowledged
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	clk.Advance(time.Second + 11*time.Microsecond)
	p, _ = leasePoolOn(t, root, clk)
	ackClears(t, p, "the worker_restart end")
}

// PR #763 review (F10, with ruling R19's same-epoch case): a same-epoch SetMode down to
// lease keeps a lease+processes lease at level 1, and an Exec still carrying
// lease+processes at that epoch neither raises it back (R18's re-level uses the served
// mode) nor starts at level 2.
func TestSameEpochDowngradeIsNotUndoneByAnExec(t *testing.T) {
	p, _, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 3)
	l2 := Exec{Command: "one", TimeoutS: 30, Mode: ModeLeaseProcesses, ModeEpoch: 3}
	mustExec(t, p, "k", l2)
	if l := leaseAlive(t, p, "after the level-2 Exec"); l.mode != ModeLeaseProcesses {
		t.Fatalf("lease mode = %s, want %s", l.mode, ModeLeaseProcesses)
	}
	mustSetMode(t, p, "k", ModeLease, 3)
	mustExec(t, p, "k", l2)
	if l := leaseAlive(t, p, "after a level-2 Exec at the downgrade's epoch"); l.mode != ModeLease {
		t.Fatalf("lease mode = %s, want %s: the Exec undid a same-epoch downgrade", l.mode, ModeLease)
	}
	if err := p.EndLease("k", LeaseEndReset); err != nil {
		t.Fatalf("EndLease: %v", err)
	}
	mustExec(t, p, "k", l2)
	if l := leaseAlive(t, p, "a fresh lease"); l.mode != ModeLease {
		t.Fatalf("fresh lease mode = %s, want %s", l.mode, ModeLease)
	}
}

// Review M1 (F10's race): a same-epoch SetMode that lands while a lease Exec is queued on
// the gate is not undone by that Exec. Its served mode is recomputed under the gate as
// the lower of its own and the stored one, and that mode drives the re-level and the
// per-Exec/lease decision.
func TestSameEpochDowngradeWhileQueued(t *testing.T) {
	t.Run("to lease: no re-level up", func(t *testing.T) {
		p, lc, _ := leasePool(t, nil)
		mustSetMode(t, p, "k", ModeLeaseProcesses, 3)
		l2 := Exec{Command: "l2", TimeoutS: 30, Mode: ModeLeaseProcesses, ModeEpoch: 3}
		entered, release := blockRuns(lc)
		first := execAsync(p, "k", l2)
		recvWithin(t, entered, "the first Exec's Run")
		queued := execAsync(p, "k", l2)
		waitFor(t, func() bool { return pinnedCount(p, "k") == 2 }) // routed at lease+processes, on the gate
		mustSetMode(t, p, "k", ModeLease, 3)
		if l := leaseAlive(t, p, "after the downgrade"); l.mode != ModeLease {
			t.Fatalf("lease mode after SetMode(lease) = %s, want %s", l.mode, ModeLease)
		}
		close(release)
		for _, errc := range []<-chan error{first, queued} {
			if err := recvWithin(t, errc, "an Exec"); err != nil {
				t.Fatalf("Exec: %v", err)
			}
		}
		if l := leaseAlive(t, p, "after the queued Exec"); l.mode != ModeLease {
			t.Fatalf("lease mode after the queued Exec = %s, want %s: it undid the downgrade", l.mode, ModeLease)
		}
		if n := lc.count("run vm-1"); n != 2 {
			t.Fatalf("Runs in vm-1 = %d, want 2: the queued Exec runs in the same lease", n)
		}
	})
	t.Run("to per-exec: the lease ends and the Exec runs per-Exec", func(t *testing.T) {
		p, lc, _ := leasePool(t, nil)
		mustSetMode(t, p, "k", ModeLease, 3)
		e := Exec{Command: "lease", TimeoutS: 30, Mode: ModeLease, ModeEpoch: 3}
		entered, release := blockRuns(lc)
		first := execAsync(p, "k", e)
		recvWithin(t, entered, "the first Exec's Run")
		queued := execAsync(p, "k", e)
		waitFor(t, func() bool { return pinnedCount(p, "k") == 2 })
		setMode := make(chan error, 1)
		go func() { setMode <- setModeErr(p, "k", ModePerExec, 3) }() // waits for the gate
		waitFor(t, func() bool { return pinnedCount(p, "k") == 3 })
		close(release)
		for _, errc := range []<-chan error{first, queued, setMode} {
			if err := recvWithin(t, errc, "an Exec or the SetMode"); err != nil {
				t.Fatalf("%v", err)
			}
		}
		cmds := lc.commands()
		if len(cmds) != 2 || !cmds[0].Lease || cmds[1].Lease {
			t.Fatalf("Commands = %+v, want the first as a lease Exec and the queued one per-Exec", cmds)
		}
		if liveLease(p, "k") != nil {
			t.Fatal("a lease is live after a downgrade to per-exec")
		}
		if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending == nil || s.Pending.Reason != LeaseEndModeChange {
			t.Fatalf("state = %+v, want the lease's end pending as mode_change", s)
		}
		if st := p.Stats(); st.LeaseEnds[LeaseEndModeChange] != 1 || leaseEndTotal(st) != 1 {
			t.Fatalf("LeaseEnds = %v, want exactly one mode_change", st.LeaseEnds)
		}
		waitFor(t, func() bool { return lc.liveCount() == 0 })
	})
}
