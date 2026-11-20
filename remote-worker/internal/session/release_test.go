package session_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	"github.com/rossoctl/moca/remote-worker/internal/session"
)

// releaseRunner is a scriptedRunner that is also a session.Releaser.
type releaseRunner struct {
	scriptedRunner
	outcome pb.ReleaseOutcome
	err     error

	rmu  sync.Mutex
	keys []string
}

var _ session.Releaser = (*releaseRunner)(nil)

func (r *releaseRunner) Release(_ context.Context, key string) (pb.ReleaseOutcome, error) {
	r.rmu.Lock()
	r.keys = append(r.keys, key)
	r.rmu.Unlock()
	return r.outcome, r.err
}

func (f *fakeStream) release(rf *pb.ReleaseFrame) {
	f.in <- &pb.ServerFrame{Msg: &pb.ServerFrame_Release{Release: rf}}
}

func releaseResultFor(frames []*pb.WorkerFrame, ctlID uint64) *pb.ReleaseResult {
	for _, f := range frames {
		if r := f.GetReleaseResult(); r != nil && r.GetCtlId() == ctlID {
			return r
		}
	}
	return nil
}

// #338: a Release frame reaches the runner's Releaser with its workspace key, and the
// outcome comes back as release_result under the frame's ctl_id.
func TestReleaseReachesTheRunnerAndIsAcked(t *testing.T) {
	st := newFakeStream()
	r := &releaseRunner{outcome: pb.ReleaseOutcome_RELEASE_OUTCOME_KEPT_BUSY}
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.release(&pb.ReleaseFrame{CtlId: 7, WorkspaceKey: "leaf-a"})
	waitFor(t, "the release result", func() bool { return releaseResultFor(st.sent(), 7) != nil })
	res := releaseResultFor(st.sent(), 7)
	if res.GetOutcome() != pb.ReleaseOutcome_RELEASE_OUTCOME_KEPT_BUSY || res.GetError() != "" {
		t.Errorf("release result = %+v, want KEPT_BUSY and no error", res)
	}
	r.rmu.Lock()
	defer r.rmu.Unlock()
	if len(r.keys) != 1 || r.keys[0] != "leaf-a" {
		t.Errorf("Releaser saw %v, want [leaf-a]", r.keys)
	}
}

// A Releaser's error goes back as the result's error, with outcome UNSPECIFIED.
func TestReleaseErrorIsAcked(t *testing.T) {
	st := newFakeStream()
	r := &releaseRunner{outcome: pb.ReleaseOutcome_RELEASE_OUTCOME_RELEASED, err: errors.New("invalid-workspace-key: nope")}
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.release(&pb.ReleaseFrame{CtlId: 8, WorkspaceKey: "../x"})
	waitFor(t, "the release result", func() bool { return releaseResultFor(st.sent(), 8) != nil })
	res := releaseResultFor(st.sent(), 8)
	if res.GetOutcome() != pb.ReleaseOutcome_RELEASE_OUTCOME_UNSPECIFIED || res.GetError() != "invalid-workspace-key: nope" {
		t.Errorf("release result = %+v, want UNSPECIFIED and the runner's error", res)
	}
}

// A runner without Release answers explicitly, so a relay is not left to time out.
func TestReleaseUnsupportedRunner(t *testing.T) {
	st := newFakeStream()
	s := session.New(testConfig(), &scriptedRunner{})
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.release(&pb.ReleaseFrame{CtlId: 9, WorkspaceKey: "leaf-a"})
	waitFor(t, "the release result", func() bool { return releaseResultFor(st.sent(), 9) != nil })
	if got := releaseResultFor(st.sent(), 9).GetError(); got != "release_unsupported: this worker cannot release a workspace" {
		t.Errorf("release result error = %q, want release_unsupported", got)
	}
}
