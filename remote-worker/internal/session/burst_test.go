package session_test

import (
	"errors"
	"testing"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	"github.com/rossoctl/moca/remote-worker/internal/session"
)

// pushExecs feeds Execs from first to last into the fake stream from a goroutine, stopping
// early if the stream closes. A goroutine because a session that ends stops reading Recv, and
// the fake's channel would then block the test itself; gap paces the pushes when non-zero.
func pushExecs(st *fakeStream, first, last uint64, gap time.Duration) {
	go func() {
		for i := first; i <= last; i++ {
			select {
			case st.in <- &pb.ServerFrame{Msg: &pb.ServerFrame_Exec{Exec: &pb.Exec{
				ReqId: i, Command: "sleep 30", Streaming: true,
			}}}:
			case <-st.done:
				return
			}
			if gap > 0 {
				time.Sleep(gap)
			}
		}
	}()
}

// busyRefusalIDs lists the req_ids of the "busy: queue full" refusals on the wire, in order.
func busyRefusalIDs(frames []*pb.WorkerFrame) []uint64 {
	var ids []uint64
	for _, f := range frames {
		if e := f.GetError(); e != nil && e.GetMessage() == "busy: queue full" {
			ids = append(ids, e.GetReqId())
		}
	}
	return ids
}

// #705. A burst of refusals larger than the outbound buffer arrives while the sender is
// behind: many sessions ending at once, past the connection's admission limit
// (MaxConcurrent running + QueueCap queued). Before, the refusal that found the
// TerminalReserve slots full ended the connection with ErrEgressWedged, and every unrelated
// Exec running on it failed. Now the overflow is deferred, every refusal reaches the wire in
// arrival order once the sender drains, and the running Exec completes normally.
//
// The gate makes it deterministic: the sender is parked on its first Send after Hello, so
// nothing drains while the whole burst is accepted.
func TestRefusalBurstBeyondTheReserveKeepsTheConnection(t *testing.T) {
	st := newFakeStream()
	r := &scriptedRunner{code: 0, block: make(chan struct{})}
	cfg := testConfig()
	cfg.MaxConcurrent = 1
	cfg.Heartbeat = time.Hour // heartbeats must not compete for the buffer
	s := session.New(cfg, r)
	sv := serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.gateSendAfter(0)
	t.Cleanup(st.releaseGate)
	unblocked := false
	t.Cleanup(func() {
		if !unblocked {
			close(r.block)
		}
	})

	// One running (req 1) and QueueCap queued (2..QueueCap+1): the admission limit.
	st.exec(&pb.Exec{ReqId: 1, Command: "sleep 30", Streaming: true})
	waitFor(t, "the running exec to start", func() bool { return r.count() == 1 })
	queuedLast := uint64(session.QueueCap + 1)
	// Then a burst of refusals: twice the whole outbound buffer, so it overflows the reserve
	// many times over whatever the buffer holds.
	burst := 2 * (session.QueueCap + session.TerminalReserve)
	last := queuedLast + uint64(burst)
	pushExecs(st, 2, last, 0)
	pushed := int(last)

	// Every Exec accepted, the connection still up: recvLoop has re-entered Recv after the
	// last one. Before #705 it returned ErrEgressWedged at the first refusal that found the
	// buffer full, and this times out.
	waitFor(t, "every Exec of the burst to be accepted without ending the connection", func() bool {
		return st.recvEntries() >= pushed+1
	})
	select {
	case <-sv.done:
		t.Fatalf("Serve returned %v during the burst, want it still serving", sv.err)
	default:
	}
	stats := s.Stats()
	if stats.QueueFullRefusals != uint64(burst) {
		t.Errorf("Stats.QueueFullRefusals = %d, want %d", stats.QueueFullRefusals, burst)
	}
	if stats.DeferredNow == 0 || stats.DeferredFrames == 0 {
		t.Errorf("Stats = %+v, want refusals deferred behind the full buffer", stats)
	}
	if stats.WedgedConnections != 0 {
		t.Errorf("Stats.WedgedConnections = %d, want 0", stats.WedgedConnections)
	}

	// Let the wire drain: every refusal is delivered, in arrival order.
	st.releaseGate()
	waitFor(t, "every refusal of the burst on the wire", func() bool {
		return len(busyRefusalIDs(st.sent())) == burst
	})
	ids := busyRefusalIDs(st.sent())
	for i, id := range ids {
		if want := queuedLast + 1 + uint64(i); id != want {
			t.Fatalf("refusal %d is for req_id %d, want %d: deferred refusals were reordered", i, id, want)
		}
	}

	// The unrelated running Exec, and the queued ones, finish normally on the same connection.
	close(r.block)
	unblocked = true
	waitFor(t, "the running and queued Execs to end normally", func() bool {
		frames := st.sent()
		for id := uint64(1); id <= queuedLast; id++ {
			if terminalFor(frames, id) == nil {
				return false
			}
		}
		return true
	})
	frames := st.sent()
	for id := uint64(1); id <= queuedLast; id++ {
		if end := terminalFor(frames, id).GetEnd(); end == nil || end.GetExitCode() != 0 {
			t.Fatalf("req_id %d ended with %v, want End{exit 0}: the burst cut an unrelated Exec short",
				id, terminalFor(frames, id))
		}
	}
	waitFor(t, "the deferred queue to empty", func() bool { return s.Stats().DeferredNow == 0 })
	if !s.Idle() {
		t.Error("Idle() = false after every frame was delivered: the unsent accounting leaked")
	}
}

// The backstop: DeferredCap frames waiting at once means the sender is not keeping up at all,
// and the connection is given up as wedged, even before WedgeAfter.
func TestDeferredCapEndsTheSession(t *testing.T) {
	st := newFakeStream()
	r := &scriptedRunner{block: make(chan struct{})}
	cfg := testConfig()
	cfg.MaxConcurrent = 1
	cfg.Heartbeat = time.Hour
	cfg.WedgeAfter = time.Hour // only the cap can end it
	s := session.New(cfg, r)
	sv := serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.gateSendAfter(0)
	t.Cleanup(st.releaseGate)
	defer close(r.block)

	st.exec(&pb.Exec{ReqId: 1, Command: "sleep 30", Streaming: true})
	waitFor(t, "the running exec to start", func() bool { return r.count() == 1 })
	// Admission limit, the whole buffer and its in-hand frame, the cap, and some to spare.
	last := uint64(1 + session.QueueCap + session.QueueCap + session.TerminalReserve + 1 + session.DeferredCap + 8)
	pushExecs(st, 2, last, 0)

	waitFor(t, "the session to give up at the deferred cap", func() bool {
		return s.Stats().WedgedConnections == 1
	})
	st.releaseGate() // let teardown join the parked sender
	if err := sv.wait(t, "of the deferred cap being reached"); !errors.Is(err, session.ErrEgressWedged) {
		t.Errorf("Serve returned %v, want ErrEgressWedged", err)
	}
	waitFor(t, "the deferred frames to be dropped with the connection", func() bool {
		return s.Stats().DeferredNow == 0
	})
	if !s.Idle() {
		t.Error("Idle() = false after the connection ended: the unsent accounting leaked")
	}
}
