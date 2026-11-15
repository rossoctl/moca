package vmpool

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	ga "github.com/rossoctl/moca/remote-worker/internal/guestagent"
)

// A lease Exec's timeout (PR #763 review, ruling R8b). The guest gets what is left of the
// Exec's budget when Run starts, and in lease mode the host's deadline is LeaseTimeoutSlack
// later, so the guest's own timeout fires first: it kills the Exec's cgroup and answers,
// and the lease is kept. Only a guest that has not answered by the host's deadline, a
// transport error, teardown_failed or an abort ends the lease.

// guestTimeout is what runOverConn returns when the agent reports its own timeout.
func guestTimeout(timeoutS uint32) error { return &guestError{msg: ga.TimeoutMessage(timeoutS)} }

func TestLeaseGuestTimeoutKeepsTheLease(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("one", 1))
	before := liveLease(p, "k")

	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) { return Result{}, guestTimeout(c.TimeoutS) })
	_, err := p.Exec(t.Context(), "k", Exec{Command: "sleep", TimeoutS: 5, Mode: ModeLease, ModeEpoch: 1}, &capturingSink{})
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if got := err.Error(); got != (ErrTimeout.Error() + ":5") {
		t.Fatalf("err = %q, want %q: the caller's timeout error is the one a host timeout gives", got, ErrTimeout.Error()+":5")
	}
	if l := liveLease(p, "k"); l == nil || l != before {
		t.Fatalf("the lease after the guest's own timeout = %p, want the same lease %p", l, before)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending != nil && s.Pending.State == leaseEventEnd {
		t.Fatalf("state = %+v (pending %+v), want no end recorded", s, s.Pending)
	}

	lc.setRunFn(nil)
	mustExec(t, p, "k", leaseExec("two", 1))
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls = %d, want 1: the next Exec runs in the same VM", n)
	}
	if n := lc.count("run vm-1"); n != 3 {
		t.Fatalf("Runs in vm-1 = %d, want 3", n)
	}
	if n := p.Stats().LeaseEnds[LeaseEndAgentDead]; n != 0 {
		t.Fatalf("LeaseEnds[agent_dead] = %d, want 0", n)
	}
}

// A command larger than the guest's one request frame is refused before anything is sent
// (runOverConn): the caller gets ErrCommandTooLarge and the lease, and its VM, are kept.
func TestLeaseCommandTooLargeKeepsTheLease(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("one", 1))
	before := liveLease(p, "k")

	lc.setRunFn(func(*fakeVM, Command, Sink) (Result, error) {
		return Result{}, fmt.Errorf("%w: %d bytes", ErrCommandTooLarge, ga.MaxFrame+1)
	})
	_, err := p.Exec(t.Context(), "k", Exec{Command: "big", TimeoutS: 5, Mode: ModeLease, ModeEpoch: 1}, &capturingSink{})
	if !errors.Is(err, ErrCommandTooLarge) {
		t.Fatalf("err = %v, want ErrCommandTooLarge", err)
	}
	if l := liveLease(p, "k"); l == nil || l != before {
		t.Fatalf("the lease after an oversized command = %p, want the same lease %p", l, before)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending != nil && s.Pending.State == leaseEventEnd {
		t.Fatalf("state = %+v (pending %+v), want no end recorded", s, s.Pending)
	}

	lc.setRunFn(nil)
	mustExec(t, p, "k", leaseExec("two", 1))
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls = %d, want 1: the next Exec runs in the same VM", n)
	}
	if n := p.Stats().LeaseEnds[LeaseEndAgentDead]; n != 0 {
		t.Fatalf("LeaseEnds[agent_dead] = %d, want 0", n)
	}
}

// A guest that has not answered by budget + slack is the host's deadline: agent_dead.
func TestLeaseHostDeadlineIsBudgetPlusSlack(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	entered := make(chan Command, 1)
	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
		entered <- c
		<-c.ctxDone
		return Result{}, ErrAborted
	})
	errc := execAsync(p, "k", Exec{Command: "sleep", TimeoutS: 5, Mode: ModeLease, ModeEpoch: 1})
	c := recvWithin(t, entered, "the lease Exec's Run")
	if c.TimeoutS != 5 {
		t.Fatalf("guest timeout_s = %d, want 5 (nothing of the budget was spent before Run)", c.TimeoutS)
	}
	clk.Advance(5*time.Second + LeaseTimeoutSlack - time.Millisecond)
	select {
	case err := <-errc:
		t.Fatalf("the Exec ended before budget + slack: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if liveLease(p, "k") == nil {
		t.Fatal("the lease ended before budget + slack")
	}
	clk.Advance(time.Millisecond)
	if err := recvWithin(t, errc, "the timed-out Exec"); !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	assertEnded(t, p, lc, LeaseEndAgentDead)
}

// The guest gets the budget that is left when Run starts: 60 s less the 50 s spent
// queued behind another Exec.
func TestLeaseGuestGetsTheRemainingBudget(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	entered, release := blockRuns(lc)
	first := execAsync(p, "k", Exec{Command: "long", TimeoutS: 600, Mode: ModeLease, ModeEpoch: 1})
	recvWithin(t, entered, "the first Exec's Run")
	second := execAsync(p, "k", Exec{Command: "queued", TimeoutS: 60, Mode: ModeLease, ModeEpoch: 1})
	waitFor(t, func() bool { return pinnedCount(p, "k") == 2 }) // queued on the gate, its timer armed
	clk.Advance(50 * time.Second)
	close(release)
	for _, errc := range []<-chan error{first, second} {
		if err := recvWithin(t, errc, "an Exec"); err != nil {
			t.Fatalf("Exec: %v", err)
		}
	}
	cmds := lc.commands()
	if len(cmds) != 2 || cmds[1].Command != "queued" {
		t.Fatalf("Commands = %+v, want long then queued", cmds)
	}
	if got := cmds[1].TimeoutS; got < 1 || got > 10 {
		t.Fatalf("the queued Exec's guest timeout_s = %d, want <= 10 (60 s less 50 s at the gate)", got)
	}
	if cmds[0].TimeoutS != 600 {
		t.Fatalf("the first Exec's guest timeout_s = %d, want 600", cmds[0].TimeoutS)
	}
}

// A budget spent before Run still gives the guest a timeout of its own: at least 1 s.
func TestLeaseGuestTimeoutFloorIsOneSecond(t *testing.T) {
	for _, tc := range []struct {
		left time.Duration
		want uint32
	}{
		{0, 1}, {-3 * time.Second, 1}, {time.Millisecond, 1}, {time.Second, 1},
		{time.Second + time.Millisecond, 2}, {10 * time.Second, 10},
	} {
		now := time.Unix(1000, 0)
		if got := leaseGuestTimeoutS(now.Add(tc.left), now); got != tc.want {
			t.Errorf("%v left: guest timeout_s = %d, want %d", tc.left, got, tc.want)
		}
	}
}

// An abort (the caller cancels) still ends the lease agent_dead in v1.
func TestLeaseAbortEndsTheLeaseAgentDead(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	entered, _ := blockRuns(lc)
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		_, err := p.Exec(ctx, "k", leaseExec("sleep", 1), &capturingSink{})
		errc <- err
	}()
	recvWithin(t, entered, "the lease Exec's Run")
	cancel()
	if err := recvWithin(t, errc, "the aborted Exec"); !errors.Is(err, ErrAborted) {
		t.Fatalf("err = %v, want ErrAborted", err)
	}
	assertEnded(t, p, lc, LeaseEndAgentDead)
}

// Per-Exec timeouts on a lease-enabled pool are as they were: the guest gets the whole
// budget, and the host's deadline has no slack.
func TestPerExecTimeoutUnchangedOnALeasePool(t *testing.T) {
	for _, tc := range []struct {
		name string
		e    Exec
	}{
		{"unversioned", Exec{Command: "sleep", TimeoutS: 5}},
		{"epoch 1", Exec{Command: "sleep", TimeoutS: 5, Mode: ModePerExec, ModeEpoch: 1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, lc, clk := leasePool(t, nil)
			mustSetMode(t, p, "k", ModePerExec, 1)
			entered := make(chan Command, 1)
			lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
				entered <- c
				<-c.ctxDone
				return Result{}, ErrAborted
			})
			errc := execAsync(p, "k", tc.e)
			c := recvWithin(t, entered, "the per-Exec Exec's Run")
			if c.TimeoutS != 5 || c.Lease {
				t.Fatalf("Command = %+v, want timeout_s 5 and no lease", c)
			}
			clk.Advance(5 * time.Second)
			if err := recvWithin(t, errc, "the timed-out Exec"); err == nil || err.Error() != ErrTimeout.Error()+":5" {
				t.Fatalf("err = %v, want %s:5 at exactly the budget", err, ErrTimeout)
			}
		})
	}
}

// downgradedWhileQueued sets up review M1's fallback: a lease Exec with a 10 s budget is
// queued behind a running one, and a same-epoch SetMode(per-exec) is waiting on the gate,
// so the queued Exec is served per-Exec once it gets the gate (execLease's
// errServePerExec). Lease Runs block until release; the per-Exec Run blocks until the
// host's timer cancels it. It returns the first Exec's, the queued Exec's and the
// SetMode's results.
func downgradedWhileQueued(t *testing.T) (lc *leaseLauncher, clk *fakeClock, release chan struct{}, first, queued, setMode <-chan error) {
	t.Helper()
	p, lc, clk := leasePool(t, func(c *Config) { c.LeaseGraceLimit, c.LeaseMaxDuration = time.Hour, 2*time.Hour })
	mustSetMode(t, p, "k", ModeLease, 3)
	entered := make(chan struct{}, 8)
	release = make(chan struct{})
	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
		entered <- struct{}{}
		if c.Lease {
			select {
			case <-release:
				return Result{}, nil
			case <-c.ctxDone:
				return Result{}, ErrAborted
			}
		}
		<-c.ctxDone
		return Result{}, ErrAborted
	})
	e := Exec{Command: "x", TimeoutS: 10, Mode: ModeLease, ModeEpoch: 3}
	first = execAsync(p, "k", e)
	recvWithin(t, entered, "the first Exec's Run")
	queued = execAsync(p, "k", e)
	waitFor(t, func() bool { return pinnedCount(p, "k") == 2 })
	sm := make(chan error, 1)
	go func() { sm <- setModeErr(p, "k", ModePerExec, 3) }()
	waitFor(t, func() bool { return pinnedCount(p, "k") == 3 })
	return lc, clk, release, first, queued, sm
}

// A lease Exec served per-Exec after a same-epoch downgrade whose budget was spent at the
// gate times out at once: the per-Exec budget has no slack to run on, so it never runs.
func TestPerExecFallbackWithItsBudgetSpentTimesOutAtOnce(t *testing.T) {
	lc, clk, release, first, queued, setMode := downgradedWhileQueued(t)
	clk.Advance(11 * time.Second) // past the 10 s budget, inside budget + slack
	close(release)
	if err := recvWithin(t, first, "the first Exec"); err != nil && !errors.Is(err, ErrTimeout) {
		t.Fatalf("the first Exec: %v", err)
	}
	if err := recvWithin(t, queued, "the queued Exec"); !errors.Is(err, ErrTimeout) {
		t.Fatalf("the queued Exec: err = %v, want ErrTimeout", err)
	}
	if err := recvWithin(t, setMode, "the SetMode"); err != nil {
		t.Fatalf("SetMode: %v", err)
	}
	for _, c := range lc.commands()[1:] {
		if !c.Lease {
			t.Fatalf("Commands = %+v: the queued Exec ran per-Exec on a spent budget", lc.commands())
		}
	}
}

// A lease Exec served per-Exec after a same-epoch downgrade runs on the rest of its
// per-Exec budget: with 6 s of 10 s left when it falls back, it is killed at 10 s, not at
// budget + slack (18 s).
func TestPerExecFallbackTimesOutAtTheBudgetNotTheSlack(t *testing.T) {
	lc, clk, release, first, queued, setMode := downgradedWhileQueued(t)
	clk.Advance(4 * time.Second)
	close(release)
	if err := recvWithin(t, first, "the first Exec"); err != nil {
		t.Fatalf("the first Exec: %v", err)
	}
	waitFor(t, func() bool { return len(lc.commands()) == 2 }) // the queued Exec is in its per-Exec Run
	if c := lc.commands()[1]; c.Lease || c.TimeoutS != 10 {
		t.Fatalf("the queued Exec's Command = %+v, want per-Exec with timeout_s 10", c)
	}
	clk.Advance(6*time.Second - time.Millisecond)
	select {
	case err := <-queued:
		t.Fatalf("the queued Exec ended before its budget: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	clk.Advance(time.Millisecond) // the budget's end, 10 s after the Exec arrived
	if err := recvWithin(t, queued, "the queued Exec"); !errors.Is(err, ErrTimeout) {
		t.Fatalf("the queued Exec: err = %v, want ErrTimeout at the budget", err)
	}
	if err := recvWithin(t, setMode, "the SetMode"); err != nil {
		t.Fatalf("SetMode: %v", err)
	}
}

// PR #763 second review (G1): in lease mode the host's timer stays at the budget's end
// until Run is about to start, so a lease Exec whose budget ran out while it queued never
// reaches the guest. It fails with the usual timeout and the lease is kept.
func TestLeaseExecSpentWhileQueuedNeverRuns(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	entered, release := blockRuns(lc)
	first := execAsync(p, "k", Exec{Command: "long", TimeoutS: 600, Mode: ModeLease, ModeEpoch: 1})
	recvWithin(t, entered, "the first Exec's Run")
	before := liveLease(p, "k")
	queued := execAsync(p, "k", Exec{Command: "queued", TimeoutS: 10, Mode: ModeLease, ModeEpoch: 1})
	waitFor(t, func() bool { return pinnedCount(p, "k") == 2 }) // queued on the gate, its timer armed
	clk.Advance(12 * time.Second)
	close(release)
	if err := recvWithin(t, first, "the first Exec"); err != nil {
		t.Fatalf("the first Exec: %v", err)
	}
	err := recvWithin(t, queued, "the queued Exec")
	if !errors.Is(err, ErrTimeout) || err.Error() != ErrTimeout.Error()+":10" {
		t.Fatalf("the queued Exec: err = %v, want %s:10", err, ErrTimeout)
	}
	for _, c := range lc.commands() {
		if c.Command == "queued" {
			t.Fatalf("Commands = %+v: the queued Exec ran on a spent budget", lc.commands())
		}
	}
	if l := liveLease(p, "k"); l == nil || l != before {
		t.Fatalf("the lease after the queued Exec's timeout = %p, want the same lease %p", l, before)
	}
	lc.setRunFn(nil)
	mustExec(t, p, "k", leaseExec("next", 1))
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls = %d, want 1: the next Exec runs in the same VM", n)
	}
	if s := p.Stats(); leaseEndTotal(s) != 0 {
		t.Fatalf("LeaseEnds = %v, want none", s.LeaseEnds)
	}
}

// A lease Exec with 3 s of its budget left at the gate: the guest gets 3 s, and the host
// gives up 3 s + LeaseTimeoutSlack after Run starts if the guest never answers.
func TestLeaseGuestGetsWhatIsLeftAndTheHostWaitsTheSlack(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	entered := make(chan Command, 2)
	release := make(chan struct{})
	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
		entered <- c
		if c.Command == "long" {
			<-release
			return Result{}, nil
		}
		<-c.ctxDone // the guest never answers
		return Result{}, ErrAborted
	})
	first := execAsync(p, "k", Exec{Command: "long", TimeoutS: 600, Mode: ModeLease, ModeEpoch: 1})
	recvWithin(t, entered, "the first Exec's Run")
	queued := execAsync(p, "k", Exec{Command: "queued", TimeoutS: 10, Mode: ModeLease, ModeEpoch: 1})
	waitFor(t, func() bool { return pinnedCount(p, "k") == 2 })
	clk.Advance(7 * time.Second)
	close(release)
	if err := recvWithin(t, first, "the first Exec"); err != nil {
		t.Fatalf("the first Exec: %v", err)
	}
	if c := recvWithin(t, entered, "the queued Exec's Run"); c.TimeoutS != 3 {
		t.Fatalf("the queued Exec's guest timeout_s = %d, want 3 (10 s less 7 s at the gate)", c.TimeoutS)
	}
	clk.Advance(3*time.Second + LeaseTimeoutSlack - time.Millisecond)
	select {
	case err := <-queued:
		t.Fatalf("the queued Exec ended before 3 s + slack: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	clk.Advance(time.Millisecond)
	if err := recvWithin(t, queued, "the queued Exec"); !errors.Is(err, ErrTimeout) {
		t.Fatalf("the queued Exec: err = %v, want ErrTimeout", err)
	}
	assertEnded(t, p, lc, LeaseEndAgentDead)
}

// A cold lease start whose Resume outlasts the budget but succeeds: the lease is started
// and kept, and the Exec fails with the timeout without its command reaching the guest.
func TestLeaseExecSpentDuringAColdStartNeverRuns(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	inResume, resume := make(chan struct{}, 1), make(chan struct{})
	lc.setResumeFn(func(*fakeVM, context.Context) error {
		inResume <- struct{}{}
		<-resume
		return nil
	})
	errc := execAsync(p, "k", Exec{Command: "slow-start", TimeoutS: 10, Mode: ModeLease, ModeEpoch: 1})
	recvWithin(t, inResume, "the lease start's Resume")
	clk.Advance(12 * time.Second)
	close(resume)
	err := recvWithin(t, errc, "the Exec")
	if !errors.Is(err, ErrTimeout) || err.Error() != ErrTimeout.Error()+":10" {
		t.Fatalf("err = %v, want %s:10", err, ErrTimeout)
	}
	for _, c := range lc.commands() {
		if c.Command == "slow-start" {
			t.Fatalf("Commands = %+v: the Exec ran on a spent budget", lc.commands())
		}
	}
	if liveLease(p, "k") == nil {
		t.Fatal("no lease after the timed-out start: a started lease is kept")
	}
	lc.setResumeFn(nil)
	mustExec(t, p, "k", leaseExec("next", 1))
	if n := lc.count("resume "); n != 1 {
		t.Fatalf("Resume calls = %d, want 1: the next Exec runs in the started lease", n)
	}
	if s := p.Stats(); leaseEndTotal(s) != 0 {
		t.Fatalf("LeaseEnds = %v, want none", s.LeaseEnds)
	}
}
