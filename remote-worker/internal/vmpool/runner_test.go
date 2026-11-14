package vmpool

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
	"github.com/rossoctl/moca/remote-worker/internal/session"
)

// frameSink is a minimal wexec.Sink recorder.
type frameSink struct {
	mu      sync.Mutex
	stdout  []byte
	stderr  []byte
	dropped map[pb.Stream]int
}

func newFrameSink() *frameSink { return &frameSink{dropped: map[pb.Stream]int{}} }

func (s *frameSink) Chunk(stream pb.Stream, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if stream == pb.Stream_STREAM_STDERR {
		s.stderr = append(s.stderr, data...)
	} else {
		s.stdout = append(s.stdout, data...)
	}
	return nil
}

func (s *frameSink) Dropped(stream pb.Stream, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropped[stream] += n
}

func (s *frameSink) snap() (string, string, map[pb.Stream]int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := map[pb.Stream]int{}
	for k, v := range s.dropped {
		d[k] = v
	}
	return string(s.stdout), string(s.stderr), d
}

// The adapter must satisfy the seam BashRunner fills, or microvm-worker cannot reuse
// internal/session at all (spec §2.1).
var _ wexec.Runner = Runner{}

// And the lease half of it: the session answers LeaseControl and LeaseKeepalive frames
// through this interface (ruling R14 keeps the sink in wexec; the controller is session's,
// and asserting it here costs vmpool no production import).
var _ session.LeaseController = Runner{}

func TestRunnerPassesTheWorkspaceKeyAndStreamsBothStreams(t *testing.T) {
	p, lc, _ := testPool(t)
	var gotKey string
	lc.setBeforeRestore(func(r RestoreRequest) { gotKey = r.Key })
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		out.Stdout([]byte("hi\n"))
		out.Stderr([]byte("oops\n"))
		return Result{ExitCode: 7}, nil
	})

	sink := newFrameSink()
	code, err := Runner{Pool: p}.Run(context.Background(), wexec.Spec{
		ReqID: 1, Command: "echo hi", WorkspaceKey: "leaf-abc123", Streaming: true,
	}, sink)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if code != 7 {
		t.Fatalf("code = %d, want 7 — a worker reports what the command did", code)
	}
	if gotKey != "leaf-abc123" {
		t.Fatalf("RestoreRequest.Key = %q, want the Spec's WorkspaceKey", gotKey)
	}
	stdout, stderr, _ := sink.snap()
	if stdout != "hi\n" || stderr != "oops\n" {
		t.Fatalf("stdout=%q stderr=%q — the two streams must stay tagged separately", stdout, stderr)
	}
}

func TestRunnerReportsDroppedBytesPerStream(t *testing.T) {
	p, lc, _ := testPool(t)
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		return Result{ExitCode: 0, DroppedStdout: 4096, DroppedStderr: 12}, nil
	})
	sink := newFrameSink()
	r := Runner{Pool: p}
	if _, err := r.Run(context.Background(), wexec.Spec{
		ReqID: 1, Command: "yes", WorkspaceKey: "run-a",
	}, sink); err != nil {
		t.Fatalf("Run: %v", err)
	}
	_, _, dropped := sink.snap()
	// Per stream, faithfully: wexec.BufferCap is a per-stream cap and only stdout's
	// overflow is a truncation the seam can express. Collapsing them would mark a
	// whole stdout truncated for a cut stderr.
	if dropped[pb.Stream_STREAM_STDOUT] != 4096 || dropped[pb.Stream_STREAM_STDERR] != 12 {
		t.Fatalf("dropped = %v, want stdout 4096 and stderr 12", dropped)
	}
}

func TestRunnerMapsTimeoutAndAbortToTheWorkerSentinels(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		p, lc, clk := testPool(t)
		started := make(chan struct{})
		lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
			close(started)
			<-c.ctxDone
			return Result{}, context.Canceled
		})
		done := make(chan error, 1)
		go func() {
			_, err := Runner{Pool: p}.Run(context.Background(), wexec.Spec{
				ReqID: 1, Command: "sleep 99", TimeoutS: 30, WorkspaceKey: "run-a",
			}, newFrameSink())
			done <- err
		}()
		<-started
		clk.Advance(30 * time.Second)
		// Must be wexec.ErrTimeout, not vmpool's: session maps that sentinel to
		// ExecError{"timeout:<n>"}, byte-identical to every other transport (spec §4.1).
		if err := <-done; !errors.Is(err, wexec.ErrTimeout) {
			t.Fatalf("err = %v, want wexec.ErrTimeout", err)
		}
	})
	t.Run("abort", func(t *testing.T) {
		p, lc, _ := testPool(t)
		started := make(chan struct{})
		lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
			close(started)
			<-c.ctxDone
			return Result{}, context.Canceled
		})
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			_, err := Runner{Pool: p}.Run(ctx, wexec.Spec{ReqID: 1, Command: "sleep 99", WorkspaceKey: "run-a"}, newFrameSink())
			done <- err
		}()
		<-started
		cancel()
		if err := <-done; !errors.Is(err, wexec.ErrAborted) {
			t.Fatalf("err = %v, want wexec.ErrAborted", err)
		}
	})
}

func TestRunnerSurfacesARefusalAsAnError(t *testing.T) {
	p, _, _ := testPool(t)
	_, err := Runner{Pool: p}.Run(context.Background(), wexec.Spec{ReqID: 1, Command: "true", WorkspaceKey: ""}, newFrameSink())
	if err == nil {
		t.Fatal("Run accepted an empty WorkspaceKey")
	}
	// There is no "busy"/"refused" frame in the wire contract (spec §6), so a refusal
	// can only be an error — which the session turns into ExecError. The reason must
	// survive into the message so an operator can tell the ceilings apart.
	if got := ReasonOf(err); got != RefuseEmptyKey {
		t.Fatalf("ReasonOf = %q, want %q", got, RefuseEmptyKey)
	}
}

// #369 acceptance: the worker's journal must show which session's workspace each Exec used and
// which VM ran it. One line per Exec, always on, and never the command text.
func TestRunnerLogsTheWorkspaceKeyAndVMOfEveryExec(t *testing.T) {
	p, lc, _ := testPool(t)
	var restoredID string
	lc.setBeforeRestore(func(r RestoreRequest) { restoredID = r.ID })
	lc.setRunFn(func(_ *fakeVM, _ Command, _ Sink) (Result, error) { return Result{ExitCode: 3}, nil })

	var lines []string
	prev := execLog
	execLog = func(format string, a ...any) { lines = append(lines, fmt.Sprintf(format, a...)) }
	t.Cleanup(func() { execLog = prev })

	_, _ = Runner{Pool: p}.Run(context.Background(), wexec.Spec{
		ReqID: 9, Command: "echo SECRET-VALUE", WorkspaceKey: "sess-abc",
	}, newFrameSink())

	if len(lines) != 1 {
		t.Fatalf("got %d exec log lines, want exactly 1: %q", len(lines), lines)
	}
	l := lines[0]
	for _, want := range []string{`req=9`, `workspace_key="sess-abc"`, "vm=" + restoredID, "exit=3", "err=<nil>"} {
		if !strings.Contains(l, want) {
			t.Fatalf("exec log %q lacks %q", l, want)
		}
	}
	if restoredID == "" {
		t.Fatal("the fake launcher restored no VM, so vm= proves nothing")
	}
	if strings.Contains(l, "SECRET-VALUE") {
		t.Fatalf("exec log leaked the command text: %q", l)
	}
}

func TestRunnerLogsAFailedExecWithoutAVM(t *testing.T) {
	p, _, _ := testPool(t)
	var lines []string
	prev := execLog
	execLog = func(format string, a ...any) { lines = append(lines, fmt.Sprintf(format, a...)) }
	t.Cleanup(func() { execLog = prev })

	// An empty key is refused before any VM is acquired (checkKey, spec §3.4).
	_, err := Runner{Pool: p}.Run(context.Background(), wexec.Spec{ReqID: 2, Command: "true"}, newFrameSink())
	if err == nil {
		t.Fatal("an empty workspace_key must be refused")
	}
	if len(lines) != 1 || !strings.Contains(lines[0], "vm= ") || strings.Contains(lines[0], "err=<nil>") {
		t.Fatalf("exec log = %q, want one line with an empty vm and the error", lines)
	}
}

// leaseSink is a frameSink that is also a wexec.LeaseSink, as the session's per-Exec sink
// is. notQueued makes Lease answer as the session does once the connection has ended.
type leaseSink struct {
	*frameSink
	mu        sync.Mutex
	events    []*pb.LeaseEvent
	notQueued bool
}

func newLeaseSink() *leaseSink { return &leaseSink{frameSink: newFrameSink()} }

func (s *leaseSink) Lease(ev *pb.LeaseEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.notQueued {
		return errors.New("lease event not queued: the connection has ended")
	}
	s.events = append(s.events, ev)
	return nil
}

func (s *leaseSink) got() []*pb.LeaseEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.events)
}

var _ wexec.LeaseSink = (*leaseSink)(nil)

// spyPool records the Exec Runner hands the pool, then runs it.
type spyPool struct {
	Pool
	mu  sync.Mutex
	got []Exec
}

func (p *spyPool) ExecPhased(ctx context.Context, key string, e Exec, out Sink, ph *Phases) (Result, error) {
	p.mu.Lock()
	p.got = append(p.got, e)
	p.mu.Unlock()
	return p.Pool.ExecPhased(ctx, key, e, out, ph)
}

func leaseSpec(reqID uint64, epoch uint64) wexec.Spec {
	return wexec.Spec{ReqID: reqID, Command: "work", TimeoutS: 30, WorkspaceKey: "k", Mode: "lease", ModeEpoch: epoch}
}

func runLease(t *testing.T, r Runner, s wexec.Spec) []*pb.LeaseEvent {
	t.Helper()
	sink := newLeaseSink()
	if _, err := r.Run(t.Context(), s, sink); err != nil {
		t.Fatalf("Run(req %d): %v", s.ReqID, err)
	}
	return sink.got()
}

func TestRunnerForwardsLeaseFields(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	spy := &spyPool{Pool: p}
	r := Runner{Pool: spy}
	mustSetMode(t, p, "k", ModeLeaseProcesses, 4)

	s := leaseSpec(1, 4)
	s.Mode, s.IdleTimeoutS, s.Keepalive = "lease+processes", 90, true
	runLease(t, r, s)
	// A per-exec Exec with a nonzero epoch (a per-exec token after a downgrade) takes the
	// per-Exec path unchanged: per-exec, its epoch forwarded, no refusal.
	if _, err := r.Run(t.Context(), wexec.Spec{ReqID: 2, Command: "true", TimeoutS: 30, WorkspaceKey: "other", ModeEpoch: 7}, newLeaseSink()); err != nil {
		t.Fatalf("per-exec Exec with epoch 7: %v", err)
	}

	want := []Exec{
		{ReqID: 1, Command: "work", TimeoutS: 30, Mode: ModeLeaseProcesses, ModeEpoch: 4, IdleTimeout: 90 * time.Second, Keepalive: true},
		{ReqID: 2, Command: "true", TimeoutS: 30, Mode: ModePerExec, ModeEpoch: 7},
	}
	spy.mu.Lock()
	got := slices.Clone(spy.got)
	spy.mu.Unlock()
	if len(got) != len(want) {
		t.Fatalf("pool saw %d Execs, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i].ReqID != want[i].ReqID || got[i].Command != want[i].Command || got[i].TimeoutS != want[i].TimeoutS ||
			got[i].Mode != want[i].Mode || got[i].ModeEpoch != want[i].ModeEpoch ||
			got[i].IdleTimeout != want[i].IdleTimeout || got[i].Keepalive != want[i].Keepalive {
			t.Fatalf("Exec %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	if l := liveLease(p, "k"); l == nil || l.mode != ModeLeaseProcesses || l.idle != 90*time.Second || !l.keepalive {
		t.Fatalf("lease = %+v, want a lease+processes lease, idle 90s, keepalive on", l)
	}
	if n := lc.destroyedFor("other"); n != 1 {
		t.Fatalf("per-exec Exec destroyed %d VMs for its key, want 1 (one VM per command)", n)
	}
}

// A mode string vmpool cannot name -- the session's "unknown(<n>)" for an enum this
// worker does not know -- is refused lease_unsupported, never served per-exec.
func TestRunnerRefusesAnUnknownMode(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	s := leaseSpec(1, 1)
	s.Mode = "unknown(9)"
	_, err := Runner{Pool: p}.Run(t.Context(), s, newLeaseSink())
	if err == nil || !strings.HasPrefix(err.Error(), "lease_unsupported: ") {
		t.Fatalf("err = %v, want a lease_unsupported: refusal", err)
	}
	if n := lc.createdCount(); n != 0 {
		t.Fatalf("an unknown-mode Exec restored %d VMs", n)
	}
}

func TestLeaseEventDeliveredAndAcked(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	r := Runner{Pool: p}
	mustSetMode(t, p, "k", ModeLease, 1)

	first := runLease(t, r, leaseSpec(1, 1))
	if len(first) != 1 || first[0].GetState() != "start" || first[0].GetMode() != pb.SandboxMode_SANDBOX_MODE_LEASE {
		t.Fatalf("first Exec's events = %v, want one lease start", first)
	}

	clk.Advance(DefaultLeaseIdle + time.Second)
	leaseEnded(t, p, lc, LeaseEndIdle)
	pending := p.LeaseStatus("k").Pending
	if pending == nil {
		t.Fatal("no pending event after the idle end")
	}

	second := runLease(t, r, leaseSpec(2, 1))
	if len(second) != 1 {
		t.Fatalf("second Exec's events = %v, want exactly one", second)
	}
	ev := second[0]
	if ev.GetState() != "end" || ev.GetReason() != "idle" || ev.GetMode() != pb.SandboxMode_SANDBOX_MODE_LEASE ||
		ev.GetAtUnixMs() != pending.At.UnixMilli() || ev.GetAgeMs() != uint64(pending.Age.Milliseconds()) {
		t.Fatalf("event = %v, want end/idle at %d ms, age %d ms", ev, pending.At.UnixMilli(), pending.Age.Milliseconds())
	}
	if got := p.LeaseStatus("k").Pending; got != nil {
		t.Fatalf("pending after delivery = %+v, want it acknowledged", got)
	}

	if third := runLease(t, r, leaseSpec(3, 1)); len(third) != 0 {
		t.Fatalf("third Exec's events = %v, want none", third)
	}
}

// Review Focus 5: an event pending when the Exec fails still reaches the client, ahead of
// the error, and is acknowledged only once the sink queued it.
func TestLeaseEventRidesBeforeAnError(t *testing.T) {
	setup := func(t *testing.T) (*pool, Runner) {
		p, lc, clk := leasePool(t, nil)
		r := Runner{Pool: p}
		mustSetMode(t, p, "k", ModeLease, 2)
		runLease(t, r, leaseSpec(1, 2))
		clk.Advance(DefaultLeaseIdle + time.Second)
		leaseEnded(t, p, lc, LeaseEndIdle)
		return p, r
	}

	t.Run("stale_mode", func(t *testing.T) {
		p, r := setup(t)
		sink := newLeaseSink()
		_, err := r.Run(t.Context(), leaseSpec(2, 1), sink)
		if err == nil || !strings.HasPrefix(err.Error(), "stale_mode: ") {
			t.Fatalf("err = %v, want stale_mode", err)
		}
		if evs := sink.got(); len(evs) != 1 || evs[0].GetState() != "end" || evs[0].GetReason() != "idle" {
			t.Fatalf("events = %v, want the pending end/idle", evs)
		}
		if got := p.LeaseStatus("k").Pending; got != nil {
			t.Fatalf("pending = %+v, want it acknowledged", got)
		}
	})

	t.Run("not queued", func(t *testing.T) {
		p, r := setup(t)
		sink := newLeaseSink()
		sink.notQueued = true
		if _, err := r.Run(t.Context(), leaseSpec(2, 1), sink); err == nil {
			t.Fatal("a stale-epoch Exec succeeded")
		}
		if got := p.LeaseStatus("k").Pending; got == nil || got.Reason != LeaseEndIdle {
			t.Fatalf("pending = %+v, want end/idle kept: the event never reached a stream", got)
		}
		// The next Exec carries it.
		if evs := runLease(t, r, leaseSpec(3, 2)); len(evs) != 1 || evs[0].GetReason() != "idle" {
			t.Fatalf("next Exec's events = %v, want the end/idle", evs)
		}
	})
}

func TestLeaseEndedWireString(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	r := Runner{Pool: p}
	mustSetMode(t, p, "k", ModeLease, 1)
	e := leaseExec("work", 1)
	mustExec(t, p, "k", e)
	step := 240 * time.Second
	execEvery(t, p, clk, e, step, int(8*time.Hour/step))
	if !leaseExpiring(p) {
		t.Fatal("not expiring at 8 h")
	}

	// An expiring lease is announced on every lease Exec's response.
	if evs := runLease(t, r, leaseSpec(1, 1)); len(evs) == 0 || evs[len(evs)-1].GetState() != "expiring" {
		t.Fatalf("events = %v, want an expiring notice last", evs)
	}

	entered := make(chan struct{})
	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
		close(entered)
		<-c.ctxDone
		return Result{}, ErrAborted
	})
	sink := newLeaseSink()
	errc := make(chan error, 1)
	go func() {
		s := leaseSpec(2, 1)
		s.TimeoutS = MaxExecTimeoutS
		_, err := r.Run(context.Background(), s, sink)
		errc <- err
	}()
	recvWithin(t, entered, "the Exec to reach the guest")
	clk.Advance(p.cfg.LeaseGraceLimit + time.Minute)
	err := recvWithin(t, errc, "the Exec's return at the grace limit")
	if err == nil || err.Error() != "lease_ended(grace_limit)" {
		t.Fatalf("err = %v, want exactly lease_ended(grace_limit)", err)
	}
	if errors.Is(err, wexec.ErrAborted) || errors.Is(err, wexec.ErrTimeout) {
		t.Fatalf("err = %v reads as an abort or timeout", err)
	}
	if evs := sink.got(); len(evs) != 1 || evs[0].GetState() != "end" || evs[0].GetReason() != "grace_limit" {
		t.Fatalf("events = %v, want the end/grace_limit riding before the error", evs)
	}
}

func TestStaleModeWireString(t *testing.T) {
	p, _, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 3)
	_, err := Runner{Pool: p}.Run(t.Context(), leaseSpec(1, 2), newLeaseSink())
	if err == nil || !strings.HasPrefix(err.Error(), "stale_mode: ") || !strings.Contains(err.Error(), "below the stored 3") {
		t.Fatalf("err = %v, want stale_mode: <detail>", err)
	}
}

func TestLeaseUnsupportedWireString(t *testing.T) {
	p, _, _ := testPool(t) // no lease-v1: LeaseEnabled is false
	_, err := Runner{Pool: p}.Run(t.Context(), leaseSpec(1, 1), newLeaseSink())
	if err == nil || !strings.HasPrefix(err.Error(), "lease_unsupported: ") {
		t.Fatalf("err = %v, want lease_unsupported: <detail>", err)
	}
}

func TestRunnerLeaseControlOps(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	r := Runner{Pool: p}
	ctl := func(op pb.LeaseOp, m pb.SandboxMode, epoch uint64) (*pb.LeaseStatus, error) {
		return r.LeaseControl(t.Context(), "k", op, m, epoch)
	}

	st, err := ctl(pb.LeaseOp_LEASE_OP_STATUS, 0, 0)
	if err != nil || st.GetState() != "none" || st.GetEpochKnown() || st.GetMode() != pb.SandboxMode_SANDBOX_MODE_PER_EXEC {
		t.Fatalf("status of a new key = %v, %v; want none, per-exec, epoch unknown", st, err)
	}

	st, err = ctl(pb.LeaseOp_LEASE_OP_SET_MODE, pb.SandboxMode_SANDBOX_MODE_LEASE, 1)
	if err != nil || st.GetMode() != pb.SandboxMode_SANDBOX_MODE_LEASE || !st.GetEpochKnown() || st.GetState() != "none" {
		t.Fatalf("set_mode lease 1 = %v, %v; want lease, epoch known, no lease yet", st, err)
	}
	// A retry at the same epoch is idempotent.
	if _, err := ctl(pb.LeaseOp_LEASE_OP_SET_MODE, pb.SandboxMode_SANDBOX_MODE_LEASE, 1); err != nil {
		t.Fatalf("set_mode retry at the same epoch: %v", err)
	}

	runLease(t, r, leaseSpec(1, 1))
	st, err = ctl(pb.LeaseOp_LEASE_OP_STATUS, 0, 0)
	if err != nil || st.GetState() != "active" || st.GetIdleTimeoutS() != uint32(DefaultLeaseIdle/time.Second) || st.GetPending() != nil {
		t.Fatalf("status of a live lease = %v, %v; want active, idle %v, nothing pending (the start was delivered)",
			st, err, DefaultLeaseIdle)
	}

	r.LeaseKeepalive("k")
	if l := liveLease(p, "k"); l == nil || !l.keepalive {
		t.Fatalf("lease after LeaseKeepalive = %+v, want the keepalive rule on", l)
	}

	st, err = ctl(pb.LeaseOp_LEASE_OP_RESET, 0, 0)
	if err != nil || st.GetState() != "none" || st.GetPending().GetState() != "end" || st.GetPending().GetReason() != "reset" {
		t.Fatalf("reset = %v, %v; want no lease, end/reset pending", st, err)
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("%d VMs live after reset", n)
	}

	runLease(t, r, leaseSpec(2, 1)) // a fresh lease, carrying the end/reset
	st, err = ctl(pb.LeaseOp_LEASE_OP_SET_MODE, pb.SandboxMode_SANDBOX_MODE_PER_EXEC, 2)
	if err != nil || st.GetMode() != pb.SandboxMode_SANDBOX_MODE_PER_EXEC || st.GetState() != "none" ||
		st.GetPending().GetReason() != "mode_change" {
		t.Fatalf("set_mode per-exec 2 = %v, %v; want per-exec, the lease ended mode_change", st, err)
	}

	if _, err := ctl(pb.LeaseOp_LEASE_OP_SET_MODE, pb.SandboxMode_SANDBOX_MODE_LEASE, 1); err == nil ||
		!strings.HasPrefix(err.Error(), "stale_mode: ") {
		t.Fatalf("set_mode below the stored epoch: err = %v, want stale_mode", err)
	}
	if _, err := ctl(pb.LeaseOp_LEASE_OP_SET_MODE, pb.SandboxMode(9), 3); err == nil ||
		!strings.HasPrefix(err.Error(), "lease_unsupported: ") {
		t.Fatalf("set_mode to an unknown mode: err = %v, want lease_unsupported", err)
	}
	if _, err := ctl(pb.LeaseOp_LEASE_OP_UNSPECIFIED, 0, 0); err == nil {
		t.Fatal("an unspecified op was accepted")
	}

	// A worker without lease mode refuses a lease set_mode with the wire string.
	np, _, _ := testPool(t)
	if _, err := (Runner{Pool: np}).LeaseControl(t.Context(), "k", pb.LeaseOp_LEASE_OP_SET_MODE,
		pb.SandboxMode_SANDBOX_MODE_LEASE, 1); err == nil || !strings.HasPrefix(err.Error(), "lease_unsupported: ") {
		t.Fatalf("set_mode lease without lease mode: err = %v, want lease_unsupported", err)
	}
}

// A per-exec Exec never carries lease events, even with one pending: only a lease-mode
// token produces an Exec that does, so a client on old code never sees one.
func TestPerExecExecCarriesNoLeaseEvents(t *testing.T) {
	p, _, _ := leasePool(t, nil)
	r := Runner{Pool: p}
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("work", 1)) // the start stays pending: no Runner saw it
	sink := newLeaseSink()
	if _, err := r.Run(t.Context(), wexec.Spec{ReqID: 1, Command: "true", TimeoutS: 30, WorkspaceKey: "k", ModeEpoch: 1}, sink); err != nil {
		t.Fatalf("per-exec Exec: %v", err)
	}
	if evs := sink.got(); len(evs) != 0 {
		t.Fatalf("per-exec Exec carried %v", evs)
	}
	if got := p.LeaseStatus("k").Pending; got == nil || got.Reason != LeaseEndModeChange {
		t.Fatalf("pending = %+v, want the end/mode_change left for a lease client", got)
	}
}

// The expiring notice names its reason and its deadline (plan 4): at_unix_ms is when the
// lease passed its maximum duration, and ends_by_unix_ms is that plus LeaseGraceLimit, the
// hard end a client counts its "restarts within <N> min" down to.
func TestExpiringEventCarriesDeadline(t *testing.T) {
	p, _, clk := leasePool(t, func(c *Config) {
		c.LeaseMaxDuration = 10 * time.Second
		c.LeaseGraceLimit = 60 * time.Second
	})
	r := Runner{Pool: p}
	mustSetMode(t, p, "k", ModeLease, 1)
	first := runLease(t, r, leaseSpec(1, 1))
	if len(first) != 1 || first[0].GetState() != "start" {
		t.Fatalf("first Exec's events = %v, want one lease start", first)
	}
	started := first[0].GetAtUnixMs()

	clk.Advance(10 * time.Second)
	evs := runLease(t, r, leaseSpec(2, 1))
	if len(evs) != 1 {
		t.Fatalf("events after 10 s = %v, want exactly the expiring notice", evs)
	}
	ev := evs[0]
	if ev.GetState() != "expiring" || ev.GetReason() != "max_duration" {
		t.Fatalf("event = %v, want expiring/max_duration", ev)
	}
	if ev.GetMode() != pb.SandboxMode_SANDBOX_MODE_LEASE {
		t.Errorf("mode = %v, want lease", ev.GetMode())
	}
	if ev.GetAgeMs() < 10_000 {
		t.Errorf("age_ms = %d, want the lease's age (>= 10 000)", ev.GetAgeMs())
	}
	if want := started + 10_000; ev.GetAtUnixMs() != want {
		t.Errorf("at_unix_ms = %d, want %d: when the lease passed its maximum duration", ev.GetAtUnixMs(), want)
	}
	if d := ev.GetEndsByUnixMs() - ev.GetAtUnixMs(); d != 60_000 {
		t.Errorf("ends_by - at = %d ms, want 60 000 (the grace limit)", d)
	}

	// Not acknowledged: the next lease Exec carries the same notice, at the same at_unix_ms,
	// so a client deduping on it shows it once.
	clk.Advance(time.Second)
	again := runLease(t, r, leaseSpec(3, 1))
	if len(again) != 1 || again[0].GetState() != "expiring" || again[0].GetAtUnixMs() != ev.GetAtUnixMs() ||
		again[0].GetEndsByUnixMs() != ev.GetEndsByUnixMs() {
		t.Fatalf("next Exec's events = %v, want the same expiring notice (%v)", again, ev)
	}
}

// sandbox_deleted (plan 4) ends the lease with that reason and needs no epoch.
func TestRunnerLeaseControlSandboxDeleted(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	r := Runner{Pool: p}
	mustSetMode(t, p, "k", ModeLease, 1)
	runLease(t, r, leaseSpec(1, 1))

	st, err := r.LeaseControl(t.Context(), "k", pb.LeaseOp_LEASE_OP_SANDBOX_DELETED, 0, 0)
	if err != nil {
		t.Fatalf("sandbox_deleted: %v", err)
	}
	if st.GetState() != "none" || st.GetPending().GetState() != "end" || st.GetPending().GetReason() != "sandbox_deleted" {
		t.Fatalf("status after sandbox_deleted = %v; want no lease, end/sandbox_deleted pending", st)
	}
	if got := p.LeaseStatus("k").Pending; got == nil || got.Reason != LeaseEndSandboxDeleted {
		t.Fatalf("pending = %+v, want end/sandbox_deleted", got)
	}
	if n := lc.liveCount(); n != 0 {
		t.Fatalf("%d VMs live after sandbox_deleted", n)
	}

	// Without a live lease it is a no-op that still answers the status.
	if st, err := r.LeaseControl(t.Context(), "never", pb.LeaseOp_LEASE_OP_SANDBOX_DELETED, 0, 0); err != nil || st.GetState() != "none" {
		t.Fatalf("sandbox_deleted without a lease = %v, %v; want status none, no error", st, err)
	}
}
