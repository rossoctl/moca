package session

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// #831 review must-fix. The connection is cancelled (a Send failed) while outbound is full, so
// drainDeferred drops what it holds and returns. The recv goroutine can still refuse one more
// buffered Exec after that: with outbound full it would be deferred into a queue nobody drains or
// drops, and the frame counted into unsent would leave Idle false for the life of the process,
// blocking cmd/worker's token rotation. A closed queue takes nothing instead.
func TestARefusalAfterTheDrainerExitedLeaksNothing(t *testing.T) {
	s := New(Config{MaxConcurrent: 1}, nil)
	outbound := make(chan outFrame, 1)
	outbound <- outFrame{frame: errFrame(1, "busy: queue full"), reserved: true} // full
	s.unsent.Add(1)                                                              // that frame's count

	q := &deferQueue{wake: make(chan struct{}, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.drainDeferred(ctx, q, outbound) // the drainer sees the cancel, drops nothing, and is gone

	var sendingSince atomic.Int64 // the sender is not in a Send: it failed and is draining
	if !s.offerTerminal(q, outbound, &sendingSince, time.Hour, errFrame(2, "busy: queue full")) {
		t.Fatal("offerTerminal reported wedged for a connection that is merely ending")
	}
	if n := s.unsent.Load(); n != 1 {
		t.Fatalf("unsent = %d after the drainer exited, want 1 (only the frame in outbound): a frame "+
			"was counted that nobody will send or drop", n)
	}
	if n := s.deferredNow.Load(); n != 0 || len(q.frames) != 0 || q.pending != 0 {
		t.Fatalf("deferredNow = %d, %d frames, pending %d: want nothing queued on a closed queue",
			n, len(q.frames), q.pending)
	}
	// The frame left in outbound is the sender's to drain, as before; once it does, Idle holds.
	<-outbound
	s.unsent.Add(-1)
	if !s.Idle() {
		t.Error("Idle() = false once outbound drained: the late refusal leaked")
	}
}
