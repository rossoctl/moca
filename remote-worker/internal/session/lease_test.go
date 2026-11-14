package session_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"google.golang.org/protobuf/proto"

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
// non-nil, every mutating LeaseControl (reset, set_mode) blocks until it is closed: a
// set_mode downgrade waiting out a lease's grace, which can take minutes. A status blocks
// only with statusRelease non-nil, until it is closed: vmpool's only takes the pool lock,
// but that lock can be contended.
type leaseRunner struct {
	scriptedRunner
	release       chan struct{}
	statusRelease chan struct{}
	status        *pb.LeaseStatus
	err           error

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
	if r.release != nil && op != pb.LeaseOp_LEASE_OP_STATUS {
		<-r.release
	}
	if r.statusRelease != nil && op == pb.LeaseOp_LEASE_OP_STATUS {
		<-r.statusRelease
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
	releaseOnCleanup(t, r)
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

// releaseOnCleanup closes r.release when the test ends, unless the test already did, so an
// early failure leaves no lease goroutine blocked in the controller.
func releaseOnCleanup(t *testing.T, r *leaseRunner) {
	t.Helper()
	t.Cleanup(func() {
		select {
		case <-r.release:
		default:
			close(r.release)
		}
	})
}

// waitLeaseDrained waits until every lease goroutine of s has finished: its controller
// returned and its reply was queued or dropped.
func waitLeaseDrained(t *testing.T, s *session.Session) {
	t.Helper()
	waitFor(t, "every lease call to finish", func() bool {
		return session.LeaseCallsInFlight(s) == 0 && session.LeaseStatusCallsInFlight(s) == 0
	})
}

// fillLeaseSlots sends n mutating calls (reset), two per workspace key -- the per-key cap --
// so that all n fit under the worker-wide cap.
func fillLeaseSlots(st *fakeStream, firstID uint64, n int) {
	for i := 0; i < n; i++ {
		st.leaseControl(&pb.LeaseControlFrame{
			CtlId: firstID + uint64(i), WorkspaceKey: fmt.Sprintf("leaf-%d", i/2), Op: pb.LeaseOp_LEASE_OP_RESET,
		})
	}
}

// At leaseControlCap (16) mutating calls in flight, the next is refused at once, and a
// finished call frees its place.
func TestLeaseControlCap(t *testing.T) {
	const leaseCap = 16
	st := newFakeStream()
	r := &leaseRunner{release: make(chan struct{}), status: &pb.LeaseStatus{State: "active"}}
	releaseOnCleanup(t, r)
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	fillLeaseSlots(st, 1, leaseCap)
	waitFor(t, "16 calls in flight", func() bool { return r.callCount() == leaseCap })

	// A fresh key, so the refusal is the worker-wide cap's, not the per-key one's.
	st.leaseControl(&pb.LeaseControlFrame{CtlId: leaseCap + 1, WorkspaceKey: "leaf-fresh", Op: pb.LeaseOp_LEASE_OP_RESET})
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
	// A slot is freed just AFTER its reply is queued, so seeing all 16 replies does not yet
	// prove the slots are free; this does.
	waitLeaseDrained(t, s)
	st.leaseControl(&pb.LeaseControlFrame{CtlId: 100, WorkspaceKey: "leaf-0", Op: pb.LeaseOp_LEASE_OP_RESET})
	waitFor(t, "a call after the cap drained", func() bool { return leaseResultFor(st.sent(), 100) != nil })
	if got := leaseResultFor(st.sent(), 100); got.GetError() != "" || got.GetStatus().GetState() != "active" {
		t.Errorf("post-drain result = %+v, want the controller's status", got)
	}
}

// I1 (a): a status takes no slot, so a worker whose 16 slots are all held by blocked
// mutating calls still answers every sandbox's status.
func TestLeaseStatusAnsweredWhileSlotsFull(t *testing.T) {
	const leaseCap = 16
	st := newFakeStream()
	r := &leaseRunner{release: make(chan struct{}), status: &pb.LeaseStatus{State: "active"}}
	releaseOnCleanup(t, r)
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	fillLeaseSlots(st, 1, leaseCap)
	waitFor(t, "16 calls in flight", func() bool { return r.callCount() == leaseCap })

	for id := uint64(50); id < 53; id++ {
		st.leaseControl(&pb.LeaseControlFrame{CtlId: id, WorkspaceKey: "leaf-other", Op: pb.LeaseOp_LEASE_OP_STATUS})
	}
	for id := uint64(50); id < 53; id++ {
		waitFor(t, "a status while every slot is held", func() bool { return leaseResultFor(st.sent(), id) != nil })
		if got := leaseResultFor(st.sent(), id); got.GetError() != "" || got.GetStatus().GetState() != "active" {
			t.Errorf("status ctl %d = %+v, want the controller's status and no error", id, got)
		}
	}
	if n := session.LeaseCallsInFlight(s); n != leaseCap {
		t.Errorf("lease calls in flight = %d, want %d: a status must not take a slot", n, leaseCap)
	}
	close(r.release)
	waitLeaseDrained(t, s)
}

// At leaseStatusCap (32) status calls in flight, the next status is refused busy at once,
// without blocking; the mutating calls keep their own caps, and a finished status frees
// its place.
func TestLeaseStatusCap(t *testing.T) {
	const statusCap = 32
	st := newFakeStream()
	r := &leaseRunner{release: make(chan struct{}), statusRelease: make(chan struct{}), status: &pb.LeaseStatus{State: "active"}}
	releaseOnCleanup(t, r)
	t.Cleanup(func() {
		select {
		case <-r.statusRelease:
		default:
			close(r.statusRelease)
		}
	})
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	for i := uint64(1); i <= statusCap; i++ {
		st.leaseControl(&pb.LeaseControlFrame{CtlId: i, WorkspaceKey: fmt.Sprintf("leaf-%d", i), Op: pb.LeaseOp_LEASE_OP_STATUS})
	}
	waitFor(t, "32 status calls in flight", func() bool {
		return session.LeaseStatusCallsInFlight(s) == statusCap && r.callCount() == statusCap
	})

	st.leaseControl(&pb.LeaseControlFrame{CtlId: statusCap + 1, WorkspaceKey: "leaf-fresh", Op: pb.LeaseOp_LEASE_OP_STATUS})
	waitFor(t, "the 33rd status's refusal", func() bool { return leaseResultFor(st.sent(), statusCap+1) != nil })
	if got := leaseResultFor(st.sent(), statusCap+1).GetError(); got != "busy: too many lease calls in flight" {
		t.Errorf("33rd status error = %q, want the busy refusal", got)
	}
	if r.callCount() != statusCap {
		t.Errorf("controller saw %d calls, want %d: the refused status must not reach it", r.callCount(), statusCap)
	}

	// The mutating calls do not share the status cap: a reset is still admitted.
	st.leaseControl(&pb.LeaseControlFrame{CtlId: 100, WorkspaceKey: "leaf-fresh", Op: pb.LeaseOp_LEASE_OP_RESET})
	waitFor(t, "the reset to reach the controller", func() bool { return session.LeaseCallsInFlight(s) == 1 && r.callCount() == statusCap+1 })

	close(r.statusRelease)
	for id := uint64(1); id <= statusCap; id++ {
		waitFor(t, "each held status's result", func() bool { return leaseResultFor(st.sent(), id) != nil })
		if got := leaseResultFor(st.sent(), id); got.GetError() != "" || got.GetStatus().GetState() != "active" {
			t.Errorf("status ctl %d = %+v, want the controller's status", id, got)
		}
	}
	waitFor(t, "the status slots to drain", func() bool { return session.LeaseStatusCallsInFlight(s) == 0 })
	st.leaseControl(&pb.LeaseControlFrame{CtlId: 200, WorkspaceKey: "leaf-1", Op: pb.LeaseOp_LEASE_OP_STATUS})
	waitFor(t, "a status after the cap drained", func() bool { return leaseResultFor(st.sent(), 200) != nil })
	if got := leaseResultFor(st.sent(), 200); got.GetError() != "" {
		t.Errorf("post-drain status error = %q, want none", got.GetError())
	}
	close(r.release)
	waitLeaseDrained(t, s)
}

// I1 (b): at most 2 mutating calls per workspace key; a 3rd on the same key is refused at
// once without reaching the controller, while another key still gets a slot.
func TestLeaseControlPerKeyCap(t *testing.T) {
	st := newFakeStream()
	r := &leaseRunner{release: make(chan struct{}), status: &pb.LeaseStatus{State: "none"}}
	releaseOnCleanup(t, r)
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.leaseControl(&pb.LeaseControlFrame{CtlId: 1, WorkspaceKey: "leaf-a", Op: pb.LeaseOp_LEASE_OP_RESET})
	st.leaseControl(&pb.LeaseControlFrame{CtlId: 2, WorkspaceKey: "leaf-a", Op: pb.LeaseOp_LEASE_OP_SET_MODE, ModeEpoch: 3})
	waitFor(t, "two calls on leaf-a in flight", func() bool { return r.callCount() == 2 })

	st.leaseControl(&pb.LeaseControlFrame{CtlId: 3, WorkspaceKey: "leaf-a", Op: pb.LeaseOp_LEASE_OP_SET_MODE, ModeEpoch: 4})
	waitFor(t, "the 3rd leaf-a call's refusal", func() bool { return leaseResultFor(st.sent(), 3) != nil })
	if got := leaseResultFor(st.sent(), 3).GetError(); got != "busy: too many lease calls in flight" {
		t.Errorf("3rd leaf-a result error = %q, want the busy refusal", got)
	}

	st.leaseControl(&pb.LeaseControlFrame{CtlId: 4, WorkspaceKey: "leaf-b", Op: pb.LeaseOp_LEASE_OP_RESET})
	waitFor(t, "the leaf-b call to reach the controller", func() bool { return r.callCount() == 3 })
	if n := session.LeaseCallsInFlight(s); n != 3 {
		t.Errorf("lease calls in flight = %d, want 3 (2 on leaf-a, 1 on leaf-b)", n)
	}
	r.lmu.Lock()
	for _, c := range r.calls {
		if c.key == "leaf-a" && c.epoch == 4 {
			t.Errorf("the refused leaf-a call reached the controller: %+v", c)
		}
	}
	r.lmu.Unlock()

	// Once leaf-a's calls finish, its places are free again.
	close(r.release)
	waitLeaseDrained(t, s)
	st.leaseControl(&pb.LeaseControlFrame{CtlId: 5, WorkspaceKey: "leaf-a", Op: pb.LeaseOp_LEASE_OP_RESET})
	waitFor(t, "a leaf-a call after its calls drained", func() bool { return leaseResultFor(st.sent(), 5) != nil })
	if got := leaseResultFor(st.sent(), 5).GetError(); got != "" {
		t.Errorf("post-drain leaf-a result error = %q, want none", got)
	}
}

// The cap belongs to the Session, not the connection: a call still blocked in the controller
// after its connection died holds its place, so a reconnect cannot run a second 16.
func TestLeaseControlCapSurvivesReconnect(t *testing.T) {
	r := &leaseRunner{release: make(chan struct{})}
	releaseOnCleanup(t, r)
	s := session.New(testConfig(), r)

	first := newFakeStream()
	sv := serve(t, s, first)
	fillLeaseSlots(first, 1, 16)
	waitFor(t, "16 calls in flight", func() bool { return r.callCount() == 16 })
	first.close()
	_ = sv.wait(t, "after the first stream closed with lease calls still blocked")

	second := newFakeStream()
	serve(t, s, second)
	second.leaseControl(&pb.LeaseControlFrame{CtlId: 17, WorkspaceKey: "leaf-fresh", Op: pb.LeaseOp_LEASE_OP_RESET})
	waitFor(t, "the refusal on the new connection", func() bool { return leaseResultFor(second.sent(), 17) != nil })
	if got := leaseResultFor(second.sent(), 17).GetError(); got != "busy: too many lease calls in flight" {
		t.Errorf("result on reconnect = %q, want the busy refusal", got)
	}

	// Let the 16 finish inside the test, so their "dropping its result" log lines (their
	// connection is gone) do not land after it returns.
	close(r.release)
	waitLeaseDrained(t, s)
	for _, f := range first.sent() {
		if f.GetLeaseResult() != nil {
			t.Errorf("a reply reached the closed first connection: %+v", f)
		}
	}
}

// A controller that outlives its connection must neither hold Serve's teardown (a set_mode
// can block for up to LeaseGraceLimit) nor write to the dead connection's outbound queue
// once it is closed.
func TestLateLeaseReplyAfterDisconnectIsDropped(t *testing.T) {
	r := &leaseRunner{release: make(chan struct{}), status: &pb.LeaseStatus{State: "none"}}
	releaseOnCleanup(t, r)
	s := session.New(testConfig(), r)
	st := newFakeStream()
	sv := serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.leaseControl(&pb.LeaseControlFrame{CtlId: 1, Op: pb.LeaseOp_LEASE_OP_SET_MODE})
	waitFor(t, "the controller to be called", func() bool { return r.callCount() == 1 })
	st.close()
	_ = sv.wait(t, "while a lease call is still blocked in the controller")
	// Serve returned with the call still running: the case under test, not a vacuous one.
	if n := session.LeaseCallsInFlight(s); n != 1 {
		t.Fatalf("lease calls in flight after Serve returned = %d, want 1 (still blocked)", n)
	}

	close(r.release)
	// The goroutine's slot is freed only after it tried to reply, so a drained count proves the
	// reply was attempted -- and a send on the closed outbound channel would have panicked.
	waitLeaseDrained(t, s)
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

// abortedLeaseRunner is a lease Exec that runs until its context ends -- an Abort, or the
// connection's end -- and only then reports a lease event, as vmpool.Runner's
// deliverLeaseEvents does after an aborted Exec. leaseErr is the sink's answer.
type abortedLeaseRunner struct {
	started  chan struct{}
	mu       sync.Mutex
	called   bool
	leaseErr error
}

func (r *abortedLeaseRunner) Run(ctx context.Context, _ wexec.Spec, sink wexec.Sink) (int32, error) {
	close(r.started)
	<-ctx.Done()
	err := sink.(wexec.LeaseSink).Lease(&pb.LeaseEvent{State: "ended", Reason: "idle", AtUnixMs: 1700000000456})
	r.mu.Lock()
	r.called, r.leaseErr = true, err
	r.mu.Unlock()
	return -1, wexec.ErrAborted
}

func (r *abortedLeaseRunner) result() (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.called, r.leaseErr
}

// Review #4559538346: a lease event reported after the connection has ended must be refused
// (errLeaseNotQueued), so the runner leaves it pending for the next lease Exec (spec §5). The
// outbound buffer has room, so a sink that only asked the enqueue would be told "queued" and
// the pool would acknowledge an event nobody will ever send.
func TestLeaseEventAfterDisconnectIsNotQueued(t *testing.T) {
	st := newFakeStream()
	r := &abortedLeaseRunner{started: make(chan struct{})}
	s := session.New(testConfig(), r)
	sv := serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 41, Command: "sleep 60", Mode: pb.SandboxMode_SANDBOX_MODE_LEASE, ModeEpoch: 1})
	<-r.started
	st.close() // the connection ends while the lease Exec runs
	_ = sv.wait(t, "after the stream closed")

	called, err := r.result()
	if !called {
		t.Fatal("the runner never reported its lease event")
	}
	if !errors.Is(err, session.ErrLeaseNotQueued) {
		t.Errorf("Lease after the connection ended = %v, want ErrLeaseNotQueued so the event stays pending", err)
	}
}

// The other side of the same rule: an Abort ends the Exec, not the connection, so the event
// it reports still goes out (ahead of the Exec's terminal frame) and may be acknowledged.
func TestLeaseEventAfterAbortIsQueued(t *testing.T) {
	st := newFakeStream()
	r := &abortedLeaseRunner{started: make(chan struct{})}
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 42, Command: "sleep 60", Mode: pb.SandboxMode_SANDBOX_MODE_LEASE, ModeEpoch: 1})
	<-r.started
	st.abort(42)
	waitFor(t, "terminal frame", func() bool { return terminalFor(st.sent(), 42) != nil })

	if called, err := r.result(); !called || err != nil {
		t.Fatalf("Lease after an Abort: called %v, error %v; want the event queued", called, err)
	}
	found := false
	for _, f := range st.sent() {
		if ev := f.GetLease(); ev != nil && ev.GetReqId() == 42 {
			found = true
		}
	}
	if !found {
		t.Error("no lease frame for req_id 42 after the Abort")
	}
}

// Review #4559538351: mode, epoch and workspace are part of what an Exec means, so a req_id
// reused across modes, epochs or workspaces runs fresh instead of being answered from the other
// Exec's cached terminal frame (which would skip its stale_mode check and its lease-event
// delivery, or hand one sandbox another's result).
func TestReqIDReusedAcrossLeaseFieldsRunsFresh(t *testing.T) {
	lease := pb.SandboxMode_SANDBOX_MODE_LEASE
	for _, tc := range []struct {
		name   string
		first  *pb.Exec
		second *pb.Exec
	}{
		{"mode", &pb.Exec{Mode: pb.SandboxMode_SANDBOX_MODE_PER_EXEC}, &pb.Exec{Mode: lease}},
		{"mode_epoch", &pb.Exec{Mode: lease, ModeEpoch: 1}, &pb.Exec{Mode: lease, ModeEpoch: 2}},
		{"workspace_key", &pb.Exec{Mode: lease, ModeEpoch: 1}, &pb.Exec{Mode: lease, ModeEpoch: 1, WorkspaceKey: "leaf-b"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStream()
			r := &scriptedRunner{code: 0}
			s := session.New(testConfig(), r)
			serve(t, s, st)
			waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

			exec := func(overlay *pb.Exec) *pb.Exec {
				e := &pb.Exec{ReqId: 61, Command: "true", TimeoutS: 10, WorkspaceKey: "leaf-a"}
				proto.Merge(e, overlay)
				return e
			}
			st.exec(exec(tc.first))
			waitFor(t, "first terminal", func() bool { return terminalFor(st.sent(), 61) != nil })
			settle() // the reused id must reach the cache, not the in-flight slot

			st.exec(exec(tc.second))
			waitFor(t, "a second run or a cached replay", func() bool {
				n := 0
				for _, f := range st.sent() {
					if f.GetEnd() != nil && f.GetEnd().GetReqId() == 61 {
						n++
					}
				}
				return n >= 2
			})
			if r.count() != 2 {
				t.Errorf("runner calls = %d, want 2: an Exec differing only in %s was answered from the cache",
					r.count(), tc.name)
			}
		})
	}
}

// The other side of the fingerprint's scope: a retry that differs only in idle_timeout_s or
// keepalive -- as one sent under a re-minted token can, after a lowered idle ceiling -- is the
// same Exec, answered from the cache rather than run a second time.
func TestRetryDifferingInIdleOrKeepaliveIsAnsweredFromCache(t *testing.T) {
	lease := pb.SandboxMode_SANDBOX_MODE_LEASE
	for _, tc := range []struct {
		name   string
		second *pb.Exec
	}{
		{"idle_timeout_s", &pb.Exec{IdleTimeoutS: 600}},
		{"keepalive", &pb.Exec{IdleTimeoutS: 1800, Keepalive: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStream()
			r := &scriptedRunner{code: 0}
			s := session.New(testConfig(), r)
			serve(t, s, st)
			waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

			exec := func(overlay *pb.Exec) *pb.Exec {
				e := &pb.Exec{ReqId: 62, Command: "echo x >> log", TimeoutS: 10, WorkspaceKey: "leaf-a", Mode: lease, ModeEpoch: 1}
				proto.Merge(e, overlay)
				return e
			}
			st.exec(exec(&pb.Exec{IdleTimeoutS: 1800}))
			waitFor(t, "first terminal", func() bool { return terminalFor(st.sent(), 62) != nil })
			settle() // the retry must reach the cache, not the in-flight slot

			st.exec(exec(tc.second))
			waitFor(t, "the cached replay", func() bool {
				n := 0
				for _, f := range st.sent() {
					if f.GetEnd() != nil && f.GetEnd().GetReqId() == 62 {
						n++
					}
				}
				return n >= 2
			})
			if r.count() != 1 {
				t.Errorf("runner calls = %d, want 1: a retry differing only in %s re-ran the command",
					r.count(), tc.name)
			}
		})
	}
}
