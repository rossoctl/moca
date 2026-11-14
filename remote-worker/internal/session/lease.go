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

// leaseControlCap bounds the mutating LeaseControl calls (reset, set_mode) running at once,
// across the whole Session rather than per connection: SetMode and EndLease can block for up
// to the pool's LeaseGraceLimit (30 min), and a call still blocked after its connection died
// keeps its place, so a reconnect cannot start a second batch beside it. The relay caps each
// sandbox at 4 in flight, but frees its place when the client cancels while the worker's call
// runs on; this is the worker's own bound over every sandbox it serves.
//
// leaseKeyCap bounds them per workspace key, under leaseControlCap, so one sandbox cannot
// fill the worker's slots and deny every other sandbox's reset, set_mode and
// sandbox_deleted.
//
// leaseStatusCap bounds the status calls running at once, across the Session, apart from
// the two above: a status takes none of the mutating calls' slots, so a worker whose
// mutating slots are all held by blocked calls still answers status. A status only reads
// the pool under its lock, but each runs on a goroutine of its own: without a bound, a
// flood of them behind a contended pool lock would pile up goroutines without limit. Past
// it a status is refused busy at once, never queued.
const (
	leaseControlCap = 16
	leaseKeyCap     = 2
	leaseStatusCap  = 32
)

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
// block (a set_mode downgrade waits for the lease to end). ctx is the connection's context:
// it ends when the connection does, after which the result has nowhere to go. A controller
// may ignore it, and vmpool's does (the Pool's lease calls take no context): the op then runs
// to completion, holding its slots (a status holds none), and its result is dropped if the
// connection has ended by the time it returns.
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
//
// It refuses once the connection has ended (errLeaseNotQueued), and checks that FIRST:
// enqueue tries its non-blocking sends before it looks at the connection, so after
// cancelConn it still reports "queued" whenever the buffer has room, and the frame is then
// discarded. That is the common lease-disconnect path -- the connection's end aborts the
// lease Exec, and the runner reports its event after -- and the runner acknowledges whatever
// this queues, so the event would be lost instead of staying pending (spec §5). The chunk
// path keeps enqueue's behaviour: a chunk has no acknowledgement to get wrong.
//
// A race remains: the connection can end between the check and the send. It is accepted,
// not closed, because it is no different from the connection ending just after a frame was
// queued, or after Send handed it to gRPC: no worker-side check can see whether the relay
// received a frame, and spec §5 calls the event best-effort for exactly that reason ("if the
// stream breaks between the two, the event is lost"; LeaseControl status still shows the
// lease's state). The check closes the window that is not a race: an Exec that only returns
// because the connection already ended.
func (f *frameSink) Lease(ev *pb.LeaseEvent) error {
	select {
	case <-f.connDone:
		return errLeaseNotQueued
	default:
	}
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
// (no lease mode, or a cap reached) is answered at once through trySend, like accept's
// refusals; an admitted call runs on its own goroutine and answers through c.sendLate when
// the controller returns, however long that takes. A status runs on its own goroutine too,
// so the receive loop never waits on the pool's lock, and takes a leaseStatusCap slot
// rather than a mutating one. Like accept, its only error is ErrEgressWedged.
//
// The goroutine is not one of Serve's producers: Serve does not wait for it, because a
// set_mode can block far longer than a re-dial should. If the connection has ended by the
// time it answers, the answer is dropped -- the relay has already failed the call -- while its
// slots are held until the controller returns.
func (s *Session) leaseControl(ctx context.Context, c *conn, f *pb.LeaseControlFrame) error {
	ctlID := f.GetCtlId()
	lc, ok := s.runner.(LeaseController)
	if !ok {
		if !c.trySend(leaseResultFrame(ctlID, nil, leaseUnsupportedMsg)) {
			return ErrEgressWedged
		}
		return nil
	}
	key := f.GetWorkspaceKey()
	var (
		release  func()
		admitted bool
	)
	if f.GetOp() == pb.LeaseOp_LEASE_OP_STATUS {
		release, admitted = s.takeLeaseStatusSlot()
	} else {
		release, admitted = s.takeLeaseSlot(key)
	}
	if !admitted {
		if !c.trySend(leaseResultFrame(ctlID, nil, leaseBusyMsg)) {
			return ErrEgressWedged
		}
		return nil
	}
	go func() {
		defer release()
		status, err := lc.LeaseControl(ctx, key, f.GetOp(), f.GetMode(), f.GetModeEpoch())
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

// takeLeaseSlot admits one mutating call on key, without blocking: a place under
// leaseKeyCap for key and one under leaseControlCap, or neither. release gives both back;
// key's place first, so a drained leaseSlots means every key's count is back to zero.
func (s *Session) takeLeaseSlot(key string) (release func(), admitted bool) {
	s.leaseMu.Lock()
	defer s.leaseMu.Unlock()
	if s.leaseByKey[key] >= leaseKeyCap {
		return nil, false
	}
	select {
	case s.leaseSlots <- struct{}{}:
	default:
		return nil, false
	}
	s.leaseByKey[key]++
	return func() {
		s.leaseMu.Lock()
		if s.leaseByKey[key]--; s.leaseByKey[key] == 0 {
			delete(s.leaseByKey, key)
		}
		s.leaseMu.Unlock()
		<-s.leaseSlots
	}, true
}

// takeLeaseStatusSlot admits one status call, without blocking: a place under
// leaseStatusCap, or none. release gives it back.
func (s *Session) takeLeaseStatusSlot() (release func(), admitted bool) {
	select {
	case s.leaseStatusSlots <- struct{}{}:
		return func() { <-s.leaseStatusSlots }, true
	default:
		return nil, false
	}
}

// leaseKeepalive forwards a Keepalive frame inline; it has no reply. Without a
// LeaseController it is ignored.
func (s *Session) leaseKeepalive(f *pb.LeaseKeepaliveFrame) {
	if lc, ok := s.runner.(LeaseController); ok {
		lc.LeaseKeepalive(f.GetWorkspaceKey())
	}
}
