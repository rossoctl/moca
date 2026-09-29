package vmpool

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	ga "github.com/rossoctl/moca/remote-worker/internal/guestagent"
)

// runOverConn drives exactly one command over an established guest connection.
//
// The connection is opened AFTER resume and never reused across one: Firecracker
// documents that listening vsock sockets survive restore (with the CID updated) while
// ESTABLISHED connections are closed on resume (spec §2.4), so a connection carried
// across a snapshot boundary is a connection to nowhere.
//
// now is passed in rather than read here so the caller controls the clock the guest
// is told about — the same reason everything else in this package takes a Clock.
func runOverConn(ctx context.Context, rw io.ReadWriteCloser, c Command, out Sink, now time.Time) (Result, error) {
	cap := c.CapBytes
	if cap <= 0 {
		cap = OutputCapBytes
	}

	// Close the connection on cancellation so the blocking read below returns. There
	// is no read deadline on a vsock stream we can rely on across VMMs, and Abort is
	// GrpcRelayTransport's DECLARED truncation mechanism (transport.ts:57-73) — a read
	// that only unblocks when the guest answers would leave Abort unable to stop
	// anything. The watcher goroutine below cannot outlive this call: `stop` is
	// closed on every return path (the deferred close), and Close itself is
	// idempotent via sync.Once so the watcher and the normal-return path can race
	// harmlessly to close the same connection.
	var once sync.Once
	closeConn := func() { once.Do(func() { _ = rw.Close() }) }
	defer closeConn()
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			closeConn()
		case <-stop:
		}
	}()

	// Write the request, the stdin frames, and the stdin-EOF frame on their own
	// goroutine, concurrently with the read loop below.
	//
	// A real vsock/TCP socket has kernel send buffering, so these few small writes
	// return immediately whether or not the guest is reading yet. This package's
	// tests drive the wire with net.Pipe, which has none — a guest that answers
	// before draining every stdin frame would otherwise deadlock the host on its own
	// write, which is exactly backwards for a transport whose whole point is that the
	// two sides cannot assume a well-behaved peer (spec §2.4's expected packet loss).
	// writeErr is buffered so this goroutine never blocks delivering its outcome, and
	// it is guaranteed to unblock — via the deferred Close above, at the latest — no
	// later than this call returns.
	writeErr := make(chan error, 1)
	go func() { writeErr <- sendRequest(rw, c, cap, now) }()

	for {
		kind, payload, err := ga.ReadFrame(rw)
		if err != nil {
			if ctx.Err() != nil {
				return Result{}, ErrAborted
			}
			// EOF and a cut payload are the same fact here: no End arrived. If the
			// write side already failed, fold its error in — it is usually the more
			// diagnosable cause of a connection that never produced a response.
			if werr := nonBlockingRecv(writeErr); werr != nil {
				return Result{}, refusal(RefuseShortResponse, "%v: write failed: %v", ErrShortResponse, werr)
			}
			return Result{}, refusal(RefuseShortResponse, "%v: %v", ErrShortResponse, err)
		}
		switch kind {
		case ga.KindStdout:
			out.Stdout(payload)
		case ga.KindStderr:
			out.Stderr(payload)
		case ga.KindEnd:
			var e ga.End
			if err := ga.DecodeJSON(payload, &e); err != nil {
				return Result{}, refusal(RefuseShortResponse, "%v: undecodable End: %v", ErrShortResponse, err)
			}
			return Result{ExitCode: e.ExitCode, DroppedStdout: e.DroppedStdout, DroppedStderr: e.DroppedStderr}, nil
		case ga.KindError:
			return Result{}, fmt.Errorf("%w: %s", ErrGuest, payload)
		default:
			// An unknown kind is not something to skip past: it means the two sides
			// disagree about the protocol, and continuing would report a plausible
			// wrong answer.
			return Result{}, refusal(RefuseShortResponse, "unknown guest frame kind %#x", byte(kind))
		}
	}
}

// sendRequest writes the Request frame, then the stdin frames if any, then ALWAYS
// the stdin-EOF frame — the guest reads until it sees KindStdinEOF whether or not
// HasStdin was set, so the host must always send it or a command that only
// terminates at end-of-input (`base64 -d > file`) hangs forever.
func sendRequest(w io.Writer, c Command, capBytes int64, now time.Time) error {
	if err := ga.WriteJSON(w, ga.KindRequest, ga.Request{
		Command:       c.Command,
		TimeoutS:      c.TimeoutS,
		Streaming:     c.Streaming,
		CapBytes:      capBytes,
		HasStdin:      len(c.Stdin) > 0,
		HostUnixNanos: now.UnixNano(),
	}); err != nil {
		return fmt.Errorf("write request: %w", err)
	}
	for off := 0; off < len(c.Stdin); off += ga.MaxFrame {
		end := min(off+ga.MaxFrame, len(c.Stdin))
		if err := ga.WriteFrame(w, ga.KindStdin, c.Stdin[off:end]); err != nil {
			return fmt.Errorf("write stdin: %w", err)
		}
	}
	if err := ga.WriteFrame(w, ga.KindStdinEOF, nil); err != nil {
		return fmt.Errorf("write stdin EOF: %w", err)
	}
	return nil
}

// nonBlockingRecv returns the value already sent on ch, or nil if none is ready yet.
func nonBlockingRecv(ch <-chan error) error {
	select {
	case err := <-ch:
		return err
	default:
		return nil
	}
}
