package vmpool

import (
	"context"
	"errors"
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
