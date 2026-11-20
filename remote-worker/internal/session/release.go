package session

import (
	"context"
	"log"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

// releaseCap bounds the Release calls running at once, across the Session. A release takes
// the runner's lock and may remove a workspace tree off it, so each runs on a goroutine of
// its own, off the receive loop; without a bound, a flood of them would pile up goroutines.
// Past it a release is refused busy at once, never queued.
const releaseCap = 32

// The ReleaseResult.error strings this file answers with on its own.
const (
	releaseUnsupportedMsg = "release_unsupported: this worker cannot release a workspace"
	releaseBusyMsg        = "busy: too many release calls in flight"
)

// Releaser is what a runner adds to wexec.Runner to serve the relay's Release frame
// (#338): free workspaceKey's workspace because its session or sandbox has ended, and
// refuse Execs for it after. It never cuts a running Exec (kept_busy). Both tiers implement
// it: vmpool.Runner and wexec.WorkspaceRunner. The session type-asserts its runner for it;
// a runner without it answers every Release with release_unsupported.
type Releaser interface {
	Release(ctx context.Context, workspaceKey string) (pb.ReleaseOutcome, error)
}

func releaseResultFrame(ctlID uint64, outcome pb.ReleaseOutcome, errMsg string) *pb.WorkerFrame {
	return &pb.WorkerFrame{Msg: &pb.WorkerFrame_ReleaseResult{ReleaseResult: &pb.ReleaseResult{
		CtlId: ctlID, Outcome: outcome, Error: errMsg,
	}}}
}

// release answers one Release frame without blocking the receive loop, as leaseControl
// does: a refusal (no Releaser, or releaseCap reached) through trySend at once, an
// admitted call on its own goroutine through c.sendLate. Like accept, its only error is
// ErrEgressWedged.
func (s *Session) release(ctx context.Context, c *conn, f *pb.ReleaseFrame) error {
	ctlID := f.GetCtlId()
	r, ok := s.runner.(Releaser)
	if !ok {
		if !c.trySend(releaseResultFrame(ctlID, pb.ReleaseOutcome_RELEASE_OUTCOME_UNSPECIFIED, releaseUnsupportedMsg)) {
			return ErrEgressWedged
		}
		return nil
	}
	select {
	case s.releaseSlots <- struct{}{}:
	default:
		if !c.trySend(releaseResultFrame(ctlID, pb.ReleaseOutcome_RELEASE_OUTCOME_UNSPECIFIED, releaseBusyMsg)) {
			return ErrEgressWedged
		}
		return nil
	}
	key := f.GetWorkspaceKey()
	go func() {
		defer func() { <-s.releaseSlots }()
		outcome, err := r.Release(ctx, key)
		errMsg := ""
		if err != nil {
			errMsg = err.Error()
			outcome = pb.ReleaseOutcome_RELEASE_OUTCOME_UNSPECIFIED
		}
		log.Printf("session: release workspace_key=%q ctl_id %d: %s%s", key, ctlID, outcome, suffix(errMsg))
		if !c.sendLate(releaseResultFrame(ctlID, outcome, errMsg)) {
			log.Printf("session: release ctl_id %d finished after its connection ended; dropping its result", ctlID)
		}
	}()
	return nil
}

func suffix(errMsg string) string {
	if errMsg == "" {
		return ""
	}
	return " (" + errMsg + ")"
}
