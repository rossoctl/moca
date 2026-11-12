package session_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
	"github.com/rossoctl/moca/remote-worker/internal/session"
)

// leaseCall is one LeaseControl call as the controller saw it.
type leaseCall struct {
	key   string
	op    pb.LeaseOp
	mode  pb.SandboxMode
	epoch uint64
}

// leaseRunner is a scriptedRunner that is also a session.LeaseController. With release
// non-nil, every LeaseControl blocks until it is closed: a set_mode downgrade waiting out a
// lease's grace, which can take minutes.
type leaseRunner struct {
	scriptedRunner
	release chan struct{}
	status  *pb.LeaseStatus
	err     error

	lmu        sync.Mutex
	calls      []leaseCall
	keepalives []string
}

var _ session.LeaseController = (*leaseRunner)(nil)

func (r *leaseRunner) LeaseControl(
	_ context.Context, key string, op pb.LeaseOp, mode pb.SandboxMode, epoch uint64,
) (*pb.LeaseStatus, error) {
	r.lmu.Lock()
	r.calls = append(r.calls, leaseCall{key: key, op: op, mode: mode, epoch: epoch})
	r.lmu.Unlock()
	if r.release != nil {
		<-r.release
	}
	return r.status, r.err
}

func (r *leaseRunner) LeaseKeepalive(key string) {
	r.lmu.Lock()
	defer r.lmu.Unlock()
	r.keepalives = append(r.keepalives, key)
}

func (r *leaseRunner) callCount() int {
	r.lmu.Lock()
	defer r.lmu.Unlock()
	return len(r.calls)
}

func (r *leaseRunner) keepaliveKeys() []string {
	r.lmu.Lock()
	defer r.lmu.Unlock()
	return append([]string(nil), r.keepalives...)
}

func (f *fakeStream) leaseControl(lc *pb.LeaseControlFrame) {
	f.in <- &pb.ServerFrame{Msg: &pb.ServerFrame_LeaseControl{LeaseControl: lc}}
}

func (f *fakeStream) keepalive(key string) {
	f.in <- &pb.ServerFrame{Msg: &pb.ServerFrame_Keepalive{Keepalive: &pb.LeaseKeepaliveFrame{WorkspaceKey: key}}}
}

// leaseResultFor finds the LeaseControlResult for ctlID among what was sent.
func leaseResultFor(frames []*pb.WorkerFrame, ctlID uint64) *pb.LeaseControlResult {
	for _, f := range frames {
		if r := f.GetLeaseResult(); r != nil && r.GetCtlId() == ctlID {
			return r
		}
	}
	return nil
}

func heartbeatCount(frames []*pb.WorkerFrame) int {
	n := 0
	for _, f := range frames {
		if f.GetHeartbeat() != nil {
			n++
		}
	}
	return n
}

// Review Focus 3: a set_mode downgrade that blocks for minutes must not stall the session.
// Execs keep running, heartbeats keep going, and the control's reply arrives once the
// controller returns.
func TestLeaseControlDoesNotBlockExecs(t *testing.T) {
	st := newFakeStream()
	r := &leaseRunner{
		release: make(chan struct{}),
		status:  &pb.LeaseStatus{Mode: pb.SandboxMode_SANDBOX_MODE_PER_EXEC, EpochKnown: true, State: "none"},
	}
	t.Cleanup(func() {
		select {
		case <-r.release:
		default:
			close(r.release)
		}
	})
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.leaseControl(&pb.LeaseControlFrame{
		CtlId: 9, WorkspaceKey: "leaf-a", Op: pb.LeaseOp_LEASE_OP_SET_MODE,
		Mode: pb.SandboxMode_SANDBOX_MODE_PER_EXEC, ModeEpoch: 4,
	})
	waitFor(t, "the controller to be called", func() bool { return r.callCount() == 1 })
	beats := heartbeatCount(st.sent())

	for id := uint64(1); id <= 3; id++ {
		st.exec(&pb.Exec{ReqId: id, Command: "true", WorkspaceKey: "leaf-b"})
	}
	for id := uint64(1); id <= 3; id++ {
		waitFor(t, "an exec's terminal frame while the control blocks", func() bool {
			return terminalFor(st.sent(), id) != nil
		})
	}
	waitFor(t, "heartbeats while the control blocks", func() bool {
		return heartbeatCount(st.sent()) >= beats+2
	})
	if res := leaseResultFor(st.sent(), 9); res != nil {
		t.Fatalf("lease result before the controller returned: %+v", res)
	}

	close(r.release)
	waitFor(t, "the lease result", func() bool { return leaseResultFor(st.sent(), 9) != nil })
	res := leaseResultFor(st.sent(), 9)
	if res.GetError() != "" || res.GetStatus().GetState() != "none" || !res.GetStatus().GetEpochKnown() {
		t.Errorf("lease result = %+v, want the controller's status and no error", res)
	}
	want := leaseCall{key: "leaf-a", op: pb.LeaseOp_LEASE_OP_SET_MODE, mode: pb.SandboxMode_SANDBOX_MODE_PER_EXEC, epoch: 4}
	r.lmu.Lock()
	got := r.calls[0]
	r.lmu.Unlock()
	if got != want {
		t.Errorf("controller call = %+v, want %+v", got, want)
	}
}

func TestLeaseControlErrorIsCarried(t *testing.T) {
	st := newFakeStream()
	r := &leaseRunner{err: errors.New("stale_mode: epoch 3 < 5")}
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.leaseControl(&pb.LeaseControlFrame{CtlId: 2, WorkspaceKey: "leaf-a", Op: pb.LeaseOp_LEASE_OP_SET_MODE, ModeEpoch: 3})
	waitFor(t, "the lease result", func() bool { return leaseResultFor(st.sent(), 2) != nil })
	if got := leaseResultFor(st.sent(), 2).GetError(); got != "stale_mode: epoch 3 < 5" {
		t.Errorf("lease result error = %q, want the controller's error", got)
	}
}

// Review Focus 4, the worker half: a runner without lease mode (the container tier) answers
// explicitly instead of leaving the relay to time out.
func TestLeaseControlUnsupportedRunner(t *testing.T) {
	st := newFakeStream()
	s := session.New(testConfig(), &scriptedRunner{})
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.leaseControl(&pb.LeaseControlFrame{CtlId: 5, WorkspaceKey: "leaf-a", Op: pb.LeaseOp_LEASE_OP_STATUS})
	waitFor(t, "the lease result", func() bool { return leaseResultFor(st.sent(), 5) != nil })
	res := leaseResultFor(st.sent(), 5)
	if res.GetError() != "lease_unsupported: this worker has no lease mode" || res.GetStatus() != nil {
		t.Errorf("lease result = %+v, want lease_unsupported with no status", res)
	}
}

// At leaseControlCap (16) calls in flight, the next is refused at once, and a finished call
// frees its place.
func TestLeaseControlCap(t *testing.T) {
	const leaseCap = 16
	st := newFakeStream()
	r := &leaseRunner{release: make(chan struct{}), status: &pb.LeaseStatus{State: "active"}}
	t.Cleanup(func() {
		select {
		case <-r.release:
		default:
			close(r.release)
		}
	})
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	for id := uint64(1); id <= leaseCap; id++ {
		st.leaseControl(&pb.LeaseControlFrame{CtlId: id, WorkspaceKey: "leaf-a", Op: pb.LeaseOp_LEASE_OP_STATUS})
	}
	waitFor(t, "16 calls in flight", func() bool { return r.callCount() == leaseCap })

	st.leaseControl(&pb.LeaseControlFrame{CtlId: leaseCap + 1, WorkspaceKey: "leaf-a", Op: pb.LeaseOp_LEASE_OP_STATUS})
	waitFor(t, "the 17th call's refusal", func() bool { return leaseResultFor(st.sent(), leaseCap+1) != nil })
	if got := leaseResultFor(st.sent(), leaseCap+1).GetError(); got != "busy: too many lease calls in flight" {
		t.Errorf("17th result error = %q, want the busy refusal", got)
	}
	if r.callCount() != leaseCap {
		t.Errorf("controller saw %d calls, want %d: the refused call must not reach it", r.callCount(), leaseCap)
	}

	close(r.release)
	for id := uint64(1); id <= leaseCap; id++ {
		waitFor(t, "each held call's result", func() bool { return leaseResultFor(st.sent(), id) != nil })
		if got := leaseResultFor(st.sent(), id); got.GetError() != "" {
			t.Errorf("ctl %d result = %+v, want no error", id, got)
		}
	}
	st.leaseControl(&pb.LeaseControlFrame{CtlId: 100, WorkspaceKey: "leaf-a", Op: pb.LeaseOp_LEASE_OP_STATUS})
	waitFor(t, "a call after the cap drained", func() bool { return leaseResultFor(st.sent(), 100) != nil })
	if got := leaseResultFor(st.sent(), 100); got.GetError() != "" || got.GetStatus().GetState() != "active" {
		t.Errorf("post-drain result = %+v, want the controller's status", got)
	}
}

// The cap belongs to the Session, not the connection: a call still blocked in the controller
// after its connection died holds its place, so a reconnect cannot run a second 16.
func TestLeaseControlCapSurvivesReconnect(t *testing.T) {
	r := &leaseRunner{release: make(chan struct{})}
	t.Cleanup(func() {
		select {
		case <-r.release:
		default:
			close(r.release)
		}
	})
	s := session.New(testConfig(), r)

	first := newFakeStream()
	sv := serve(t, s, first)
	for id := uint64(1); id <= 16; id++ {
		first.leaseControl(&pb.LeaseControlFrame{CtlId: id, Op: pb.LeaseOp_LEASE_OP_STATUS})
	}
	waitFor(t, "16 calls in flight", func() bool { return r.callCount() == 16 })
	first.close()
	_ = sv.wait(t, "after the first stream closed with lease calls still blocked")

	second := newFakeStream()
	serve(t, s, second)
	second.leaseControl(&pb.LeaseControlFrame{CtlId: 17, Op: pb.LeaseOp_LEASE_OP_STATUS})
	waitFor(t, "the refusal on the new connection", func() bool { return leaseResultFor(second.sent(), 17) != nil })
	if got := leaseResultFor(second.sent(), 17).GetError(); got != "busy: too many lease calls in flight" {
		t.Errorf("result on reconnect = %q, want the busy refusal", got)
	}
}

// A controller that outlives its connection must neither hold Serve's teardown (a set_mode
// can block for up to LeaseGraceLimit) nor write to the dead connection's outbound queue
// once it is closed.
func TestLateLeaseReplyAfterDisconnectIsDropped(t *testing.T) {
	r := &leaseRunner{release: make(chan struct{}), status: &pb.LeaseStatus{State: "none"}}
	s := session.New(testConfig(), r)
	st := newFakeStream()
	sv := serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.leaseControl(&pb.LeaseControlFrame{CtlId: 1, Op: pb.LeaseOp_LEASE_OP_SET_MODE})
	waitFor(t, "the controller to be called", func() bool { return r.callCount() == 1 })
	st.close()
	_ = sv.wait(t, "while a lease call is still blocked in the controller")

	close(r.release)
	// Give the reply goroutine time to run; a send on the closed outbound channel would
	// panic the test binary here.
	time.Sleep(100 * time.Millisecond)
	if res := leaseResultFor(st.sent(), 1); res != nil {
		t.Errorf("a reply reached a stream whose connection had ended: %+v", res)
	}
}

func TestKeepaliveCallsController(t *testing.T) {
	st := newFakeStream()
	r := &leaseRunner{}
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.keepalive("leaf-a")
	st.keepalive("leaf-b")
	waitFor(t, "two keepalives", func() bool { return len(r.keepaliveKeys()) == 2 })
	if got := r.keepaliveKeys(); got[0] != "leaf-a" || got[1] != "leaf-b" {
		t.Errorf("keepalive keys = %v, want [leaf-a leaf-b]", got)
	}
	for _, f := range st.sent() {
		if f.GetLeaseResult() != nil {
			t.Errorf("keepalive was answered: %+v (it has no reply)", f)
		}
	}
}

// Without the interface a keepalive is ignored: no frame, and the session keeps serving.
func TestKeepaliveIgnoredWithoutController(t *testing.T) {
	st := newFakeStream()
	s := session.New(testConfig(), &scriptedRunner{})
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.keepalive("leaf-a")
	st.exec(&pb.Exec{ReqId: 1, Command: "true"})
	waitFor(t, "the exec after a keepalive", func() bool { return terminalFor(st.sent(), 1) != nil })
	for _, f := range st.sent() {
		if f.GetLeaseResult() != nil || f.GetLease() != nil {
			t.Errorf("unexpected lease frame for a keepalive: %+v", f)
		}
	}
}

func TestSpecCarriesLeaseFields(t *testing.T) {
	cases := []struct {
		name string
		mode pb.SandboxMode
		want string
	}{
		{"unspecified is per-exec", pb.SandboxMode_SANDBOX_MODE_UNSPECIFIED, ""},
		{"per-exec", pb.SandboxMode_SANDBOX_MODE_PER_EXEC, ""},
		{"lease", pb.SandboxMode_SANDBOX_MODE_LEASE, "lease"},
		{"lease+processes", pb.SandboxMode_SANDBOX_MODE_LEASE_PROCESSES, "lease+processes"},
		// An enum value this worker does not know must not read as per-exec: the runner
		// refuses it (lease_unsupported) instead of serving a mode nobody asked for.
		{"unknown", pb.SandboxMode(42), "unknown(42)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStream()
			r := &scriptedRunner{}
			s := session.New(testConfig(), r)
			serve(t, s, st)
			waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

			st.exec(&pb.Exec{
				ReqId: 1, Command: "true", WorkspaceKey: "leaf-a",
				Mode: tc.mode, ModeEpoch: 7, IdleTimeoutS: 120, Keepalive: true,
			})
			waitFor(t, "terminal frame", func() bool { return terminalFor(st.sent(), 1) != nil })
			if r.count() != 1 {
				t.Fatalf("runner ran %d times, want 1", r.count())
			}
			got := r.specs[0]
			if got.Mode != tc.want || got.ModeEpoch != 7 || got.IdleTimeoutS != 120 || !got.Keepalive {
				t.Errorf("Spec lease fields = {Mode:%q ModeEpoch:%d IdleTimeoutS:%d Keepalive:%v}, "+
					"want {Mode:%q ModeEpoch:7 IdleTimeoutS:120 Keepalive:true}",
					got.Mode, got.ModeEpoch, got.IdleTimeoutS, got.Keepalive, tc.want)
			}
		})
	}
}

// leaseEventRunner emits one lease event through the sink's optional LeaseSink, then ends.
type leaseEventRunner struct {
	mu  sync.Mutex
	err error
	ok  bool
}

func (r *leaseEventRunner) Run(_ context.Context, _ wexec.Spec, sink wexec.Sink) (int32, error) {
	ls, ok := sink.(wexec.LeaseSink)
	err := error(nil)
	if ok {
		err = ls.Lease(&pb.LeaseEvent{State: "ended", Reason: "idle", AtUnixMs: 1700000000123})
	}
	r.mu.Lock()
	r.ok, r.err = ok, err
	r.mu.Unlock()
	return 0, nil
}

// The session's per-Exec sink is a LeaseSink: an event goes out as WorkerFrame{lease} under
// the Exec's req_id, ahead of the Exec's terminal frame.
func TestLeaseSinkSendsEventBeforeTerminal(t *testing.T) {
	st := newFakeStream()
	r := &leaseEventRunner{}
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 33, Command: "true", Mode: pb.SandboxMode_SANDBOX_MODE_LEASE, ModeEpoch: 2})
	waitFor(t, "terminal frame", func() bool { return terminalFor(st.sent(), 33) != nil })

	r.mu.Lock()
	ok, err := r.ok, r.err
	r.mu.Unlock()
	if !ok || err != nil {
		t.Fatalf("sink LeaseSink = %v, Lease error = %v; want a LeaseSink that queued the event", ok, err)
	}
	var leaseAt, endAt = -1, -1
	for i, f := range st.sent() {
		if ev := f.GetLease(); ev != nil {
			leaseAt = i
			if ev.GetReqId() != 33 || ev.GetState() != "ended" || ev.GetReason() != "idle" || ev.GetAtUnixMs() != 1700000000123 {
				t.Errorf("lease event = %+v, want req_id 33 and the runner's fields", ev)
			}
		}
		if f.GetEnd().GetReqId() == 33 && f.GetEnd() != nil {
			endAt = i
		}
	}
	if leaseAt < 0 || endAt < 0 || leaseAt > endAt {
		t.Errorf("lease frame at %d, End at %d: want the event before the terminal frame", leaseAt, endAt)
	}
}
