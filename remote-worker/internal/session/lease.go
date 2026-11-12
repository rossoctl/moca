package session

import (
	"context"
	"errors"
	"fmt"
	"log"

	"google.golang.org/protobuf/proto"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

// leaseControlCap bounds the LeaseControl calls running at once, across the whole Session
// rather than per connection: SetMode and EndLease can block for up to the pool's
// LeaseGraceLimit (30 min), and a call still blocked after its connection died keeps its
// place, so a reconnect cannot start a second batch beside it. The relay caps each sandbox
// at 4 in flight; this is the worker's own bound over every sandbox it serves.
const leaseControlCap = 16

// The LeaseControlResult.error strings this file answers with on its own (spec §8.2).
const (
	leaseUnsupportedMsg = "lease_unsupported: this worker has no lease mode"
	leaseBusyMsg        = "busy: too many lease calls in flight"
)

// LeaseController is what a lease-mode runner adds to wexec.Runner: the answers to the
// relay's LeaseControl and LeaseKeepalive frames. The session type-asserts its runner for
// it; a runner without it (the container tier's) answers every LeaseControl with
// lease_unsupported and ignores keepalives. vmpool.Runner implements it.
//
// LeaseControl runs on its own goroutine, off the receive loop and the Exec slots, so it may
// block (a set_mode downgrade waits for the lease to end). ctx is the connection's: it ends
// when the connection does, after which the result has nowhere to go.
//
// LeaseKeepalive is called ON the receive loop and must not block: an Abort queued behind it
// could not be read. vmpool's Keepalive only takes the pool lock.
type LeaseController interface {
	LeaseControl(ctx context.Context, workspaceKey string, op pb.LeaseOp, mode pb.SandboxMode, epoch uint64) (*pb.LeaseStatus, error)
	LeaseKeepalive(workspaceKey string)
}

// errLeaseNotQueued is frameSink.Lease's answer when the connection ended before the event
// could be queued. The runner then leaves the event unacknowledged, so the next Exec on the
// workspace carries it instead.
var errLeaseNotQueued = errors.New("lease event not queued: the connection has ended")

// specMode maps the wire's SandboxMode to wexec.Spec.Mode. The strings are vmpool's
// Mode.String(); session does not import vmpool, so they are spelled out here. A value this
// worker does not know maps to "unknown(<n>)", which vmpool's ParseMode refuses
// (lease_unsupported): reading it as per-exec would serve a mode nobody asked for.
func specMode(m pb.SandboxMode) string {
	switch m {
	case pb.SandboxMode_SANDBOX_MODE_UNSPECIFIED, pb.SandboxMode_SANDBOX_MODE_PER_EXEC:
		return ""
	case pb.SandboxMode_SANDBOX_MODE_LEASE:
		return "lease"
	case pb.SandboxMode_SANDBOX_MODE_LEASE_PROCESSES:
		return "lease+processes"
	}
	return fmt.Sprintf("unknown(%d)", int32(m))
}

// Lease makes frameSink a wexec.LeaseSink: the event goes out as WorkerFrame{lease} under
// this Exec's req_id, through the same blocking enqueue as its chunks, so it rides ahead of
// the terminal frame runOne sends after Run returns. The event is cloned before the req_id
// is stamped, so the runner's value is left as it was.
func (f *frameSink) Lease(ev *pb.LeaseEvent) error {
	out := proto.Clone(ev).(*pb.LeaseEvent)
	out.ReqId = f.reqID
	if !f.send(&pb.WorkerFrame{Msg: &pb.WorkerFrame_Lease{Lease: out}}) {
		return errLeaseNotQueued
	}
	return nil
}

var _ wexec.LeaseSink = (*frameSink)(nil)

func leaseResultFrame(ctlID uint64, status *pb.LeaseStatus, errMsg string) *pb.WorkerFrame {
	return &pb.WorkerFrame{Msg: &pb.WorkerFrame_LeaseResult{LeaseResult: &pb.LeaseControlResult{
		CtlId: ctlID, Status: status, Error: errMsg,
	}}}
}

// leaseControl answers one LeaseControl frame without blocking the receive loop. A refusal
// (no lease mode, or the cap reached) is answered at once through trySend, like accept's
// refusals; an admitted call runs on its own goroutine and answers through c.sendLate when
// the controller returns, however long that takes. Like accept, its only error is
// ErrEgressWedged.
//
// The goroutine is not one of Serve's producers: Serve does not wait for it, because a
// set_mode can block far longer than a re-dial should. If the connection has ended by the
// time it answers, the answer is dropped — the relay has already failed the call — while its
// cap slot is held until the controller returns.
func (s *Session) leaseControl(ctx context.Context, c *conn, f *pb.LeaseControlFrame) error {
	ctlID := f.GetCtlId()
	lc, ok := s.runner.(LeaseController)
	if !ok {
		if !c.trySend(leaseResultFrame(ctlID, nil, leaseUnsupportedMsg)) {
			return ErrEgressWedged
		}
		return nil
	}
	select {
	case s.leaseSlots <- struct{}{}:
	default:
		if !c.trySend(leaseResultFrame(ctlID, nil, leaseBusyMsg)) {
			return ErrEgressWedged
		}
		return nil
	}
	go func() {
		defer func() { <-s.leaseSlots }()
		status, err := lc.LeaseControl(ctx, f.GetWorkspaceKey(), f.GetOp(), f.GetMode(), f.GetModeEpoch())
		errMsg := ""
		if err != nil {
			errMsg = err.Error()
		}
		if !c.sendLate(leaseResultFrame(ctlID, status, errMsg)) {
			log.Printf("session: lease_control ctl_id %d (op %s) finished after its connection "+
				"ended; dropping its result", ctlID, f.GetOp())
		}
	}()
	return nil
}

// leaseKeepalive forwards a Keepalive frame inline; it has no reply. Without a
// LeaseController it is ignored.
func (s *Session) leaseKeepalive(f *pb.LeaseKeepaliveFrame) {
	if lc, ok := s.runner.(LeaseController); ok {
		lc.LeaseKeepalive(f.GetWorkspaceKey())
	}
}
