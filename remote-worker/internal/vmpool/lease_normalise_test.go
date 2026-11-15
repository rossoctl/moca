package vmpool

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

// PR #763 second review (G2): the ownership walk is a lease-start step of its own, as the
// restore and Resume are. A lease that starts with root_wrote set first sends the guest
// `true` with NormaliseWorkspace and LeaseNormaliseTimeout, under the caller's context but
// not the Exec's timer; the Exec's own Command never carries the flag. root_wrote clears
// only when that step ends with exit 0, and a step that fails fails the lease start.

// guestSteps is the launcher's normalise steps and Runs, in order.
func guestSteps(lc *leaseLauncher) []string {
	var out []string
	for _, ev := range lc.eventLog() {
		if strings.HasPrefix(ev, "normalise ") || strings.HasPrefix(ev, "run ") {
			out = append(out, ev)
		}
	}
	return out
}

func TestLeaseStartNormalisesInAStepOfItsOwn(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1) // a key with no file: root_wrote (ruling R7)
	mustExec(t, p, "k", leaseExec("one", 1))
	mustExec(t, p, "k", leaseExec("two", 1))
	if got, want := guestSteps(lc), []string{"normalise vm-1", "run vm-1", "run vm-1"}; !slices.Equal(got, want) {
		t.Fatalf("normalise steps and Runs = %v, want %v", got, want)
	}
	n := lc.normaliseCommands()[0]
	if n.Command != "true" || !n.Lease || !n.NormaliseWorkspace || n.TimeoutS != 600 {
		t.Fatalf("the normalise step's Command = %+v, want `true`, lease, NormaliseWorkspace, timeout_s 600", n)
	}
	for _, c := range lc.commands() {
		if c.NormaliseWorkspace || !c.Lease {
			t.Fatalf("Commands = %+v, want lease Execs without NormaliseWorkspace", lc.commands())
		}
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.RootWrote {
		t.Fatalf("state = %+v, want root_wrote cleared by the step", s)
	}
}

func TestLeaseStartWithoutRootWroteSkipsTheNormaliseStep(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	if err := saveLeaseState(p.cfg.WorkspaceRoot, "k", leaseState{Mode: ModeLease, Epoch: 1, Known: true}); err != nil {
		t.Fatal(err)
	}
	mustExec(t, p, "k", leaseExec("one", 1))
	if got, want := guestSteps(lc), []string{"run vm-1"}; !slices.Equal(got, want) {
		t.Fatalf("normalise steps and Runs = %v, want %v", got, want)
	}
}

// A walk that outlasts the Exec's budget still completes and clears root_wrote; the
// Exec then fails with its timeout without running, and the lease is kept.
func TestLeaseNormaliseIsNotChargedToTheBudget(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	inStep, release := make(chan struct{}, 1), make(chan struct{})
	cancelled := make(chan bool, 1)
	lc.setNormaliseFn(func(c Command) (Result, error) {
		inStep <- struct{}{}
		<-release
		select {
		case <-c.ctxDone:
			cancelled <- true
		default:
			cancelled <- false
		}
		return Result{}, nil
	})
	var ph Phases
	errc := make(chan error, 1)
	go func() {
		e := Exec{Command: "one", TimeoutS: 10, Mode: ModeLease, ModeEpoch: 1}
		_, err := p.ExecPhased(context.Background(), "k", e, &capturingSink{}, &ph)
		errc <- err
	}()
	recvWithin(t, inStep, "the normalise step")
	clk.Advance(15 * time.Second) // past the Exec's 10 s budget
	select {
	case err := <-errc:
		t.Fatalf("the Exec ended while its lease was still normalising: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	err := recvWithin(t, errc, "the Exec")
	if !errors.Is(err, ErrTimeout) || err.Error() != ErrTimeout.Error()+":10" {
		t.Fatalf("err = %v, want %s:10", err, ErrTimeout)
	}
	if recvWithin(t, cancelled, "the step's context") {
		t.Fatal("the normalise step's context was cancelled by the Exec's timer")
	}
	if ph.Normalise != 15*time.Second {
		t.Fatalf("Phases.Normalise = %v, want 15s", ph.Normalise)
	}
	if cmds := lc.commands(); len(cmds) != 0 {
		t.Fatalf("Commands = %+v, want none: the Exec's budget was spent before Run", cmds)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.RootWrote {
		t.Fatalf("state = %+v, want root_wrote cleared by the completed step", s)
	}
	if liveLease(p, "k") == nil {
		t.Fatal("no lease after the timed-out Exec: the lease is kept")
	}
	lc.setNormaliseFn(nil)
	mustExec(t, p, "k", leaseExec("two", 1))
	if got, want := guestSteps(lc), []string{"normalise vm-1", "run vm-1"}; !slices.Equal(got, want) {
		t.Fatalf("normalise steps and Runs = %v, want %v", got, want)
	}
	if s := p.Stats(); leaseEndTotal(s) != 0 {
		t.Fatalf("LeaseEnds = %v, want none", s.LeaseEnds)
	}
}

// A normalise step that fails fails the lease start: the VM is destroyed, no lease is
// recorded, root_wrote stays set, and the next lease Exec takes the step again.
func TestLeaseNormaliseFailureFailsTheLeaseStart(t *testing.T) {
	for _, tc := range []struct {
		name string
		step func(Command) (Result, error)
		wait time.Duration // advanced once the step has started
	}{
		{"non-zero exit", func(Command) (Result, error) { return Result{ExitCode: 1}, nil }, 0},
		{"teardown failed", func(Command) (Result, error) { return Result{ExitCode: -1, TeardownFailed: true}, nil }, 0},
		{"transport error", func(Command) (Result, error) { return Result{}, errors.New("vsock: connection reset") }, 0},
		{"guest error", func(Command) (Result, error) {
			return Result{}, &guestError{msg: "guest-agent: lease: normalise workspace: permission denied"}
		}, 0},
		{"its own timeout", func(c Command) (Result, error) { <-c.ctxDone; return Result{}, ErrAborted },
			10*time.Minute + LeaseTimeoutSlack},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, lc, clk := leasePool(t, nil)
			mustSetMode(t, p, "k", ModeLease, 1)
			lc.setNormaliseFn(tc.step)
			errc := execAsync(p, "k", Exec{Command: "one", TimeoutS: 30, Mode: ModeLease, ModeEpoch: 1})
			waitFor(t, func() bool { return len(lc.normaliseCommands()) == 1 })
			if tc.wait > 0 {
				clk.Advance(tc.wait - time.Millisecond)
				select {
				case err := <-errc:
					t.Fatalf("the Exec ended before the step's own bound: %v", err)
				case <-time.After(50 * time.Millisecond):
				}
				clk.Advance(time.Millisecond)
			}
			err := recvWithin(t, errc, "the Exec")
			if ReasonOf(err) != RefuseSpawn || !strings.Contains(err.Error(), "lease normalise") {
				t.Fatalf("err = %v, want a %s refusal naming the lease normalise", err, RefuseSpawn)
			}
			if liveLease(p, "k") != nil {
				t.Fatal("a lease is live after its normalise step failed")
			}
			if n := lc.count("destroyed vm-1"); n != 1 {
				t.Fatalf("Destroys of vm-1 = %d, want 1", n)
			}
			if len(lc.commands()) != 0 {
				t.Fatalf("Commands = %+v, want none: the Exec never ran", lc.commands())
			}
			s := loadLeaseState(p.cfg.WorkspaceRoot, "k")
			if !s.RootWrote || s.Open != nil || s.Pending != nil {
				t.Fatalf("state = %+v (pending %+v), want root_wrote kept, no open lease, nothing pending", s, s.Pending)
			}
			if st := p.Stats(); leaseEndTotal(st) != 0 {
				t.Fatalf("LeaseEnds = %v, want none: the lease never started", st.LeaseEnds)
			}

			lc.setNormaliseFn(nil)
			mustExec(t, p, "k", leaseExec("two", 1))
			if n := len(lc.normaliseCommands()); n != 2 {
				t.Fatalf("normalise steps = %d, want 2: the next lease Exec retries it", n)
			}
			if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.RootWrote {
				t.Fatalf("state after the retried step = %+v, want root_wrote cleared", s)
			}
			if liveLease(p, "k") == nil {
				t.Fatal("no lease after the retried step")
			}
		})
	}
}

// The caller's abort still applies to the step: the start fails ErrAborted, and
// root_wrote stays set.
func TestLeaseNormaliseAbortFailsTheLeaseStart(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	inStep := make(chan struct{}, 1)
	lc.setNormaliseFn(func(c Command) (Result, error) {
		inStep <- struct{}{}
		<-c.ctxDone
		return Result{}, ErrAborted
	})
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		_, err := p.Exec(ctx, "k", leaseExec("one", 1), &capturingSink{})
		errc <- err
	}()
	recvWithin(t, inStep, "the normalise step")
	cancel()
	if err := recvWithin(t, errc, "the aborted Exec"); !errors.Is(err, ErrAborted) {
		t.Fatalf("err = %v, want ErrAborted", err)
	}
	if liveLease(p, "k") != nil {
		t.Fatal("a lease is live after its normalise step was aborted")
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); !s.RootWrote || s.Pending != nil {
		t.Fatalf("state = %+v, want root_wrote kept and nothing pending", s)
	}
}

// A lease ended while its start is normalising (endLeaseWaiting's grace bound) cancels
// the step, so the caller does not wait out the walk: the start fails and nothing is
// left running.
func TestLeaseEndDuringTheNormaliseStepCancelsIt(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	inStep := make(chan struct{}, 1)
	lc.setNormaliseFn(func(c Command) (Result, error) {
		inStep <- struct{}{}
		<-c.ctxDone
		return Result{}, ErrAborted
	})
	errc := execAsync(p, "k", Exec{Command: "one", TimeoutS: MaxExecTimeoutS, Mode: ModeLease, ModeEpoch: 1})
	recvWithin(t, inStep, "the normalise step")
	setc := make(chan error, 1)
	deadline := clk.Now().Add(p.cfg.LeaseGraceLimit)
	go func() { setc <- setModeErr(p, "k", ModePerExec, 2) }()
	waitFor(t, func() bool { return timerArmed(clk, deadline) })
	clk.Advance(p.cfg.LeaseGraceLimit)
	if err := recvWithin(t, setc, "the SetMode"); err != nil {
		t.Fatalf("SetMode: %v", err)
	}
	if err := recvWithin(t, errc, "the Exec"); err == nil {
		t.Fatal("the Exec succeeded, want its lease start to fail")
	}
	if liveLease(p, "k") != nil {
		t.Fatal("a lease is live after SetMode(per-exec)")
	}
	if len(lc.commands()) != 0 {
		t.Fatalf("Commands = %+v, want none", lc.commands())
	}
}
