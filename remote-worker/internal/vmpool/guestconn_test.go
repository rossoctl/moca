package vmpool

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	ga "github.com/rossoctl/moca/remote-worker/internal/guestagent"
)

// fakeGuest speaks the protocol on one side of a net.Pipe, driven by a script, so the
// host side is tested against the wire rather than against the agent.
func fakeGuest(t *testing.T, script func(rw io.ReadWriteCloser, req ga.Request)) io.ReadWriteCloser {
	t.Helper()
	host, guest := net.Pipe()
	go func() {
		defer guest.Close()
		k, p, err := ga.ReadFrame(guest)
		if err != nil || k != ga.KindRequest {
			return
		}
		var req ga.Request
		if err := ga.DecodeJSON(p, &req); err != nil {
			return
		}
		script(guest, req)
	}()
	return host
}

func TestRunOverConnStreamsBothStreamsAndReturnsTheExitCode(t *testing.T) {
	var gotReq ga.Request
	conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
		gotReq = req
		_ = ga.WriteFrame(rw, ga.KindStdout, []byte("hi\n"))
		_ = ga.WriteFrame(rw, ga.KindStderr, []byte("oops\n"))
		_ = ga.WriteJSON(rw, ga.KindEnd, ga.End{ExitCode: 7})
	})
	var out capturingSink
	now := time.Unix(1757500000, 0)
	res, err := runOverConn(context.Background(), conn, Command{
		Command: "echo hi", TimeoutS: 30, CapBytes: OutputCapBytes,
	}, &out, now)
	if err != nil {
		t.Fatalf("runOverConn: %v", err)
	}
	if res.ExitCode != 7 {
		t.Fatalf("exit = %d, want 7", res.ExitCode)
	}
	if out.out() != "hi\n" {
		t.Fatalf("stdout = %q", out.out())
	}
	// The host clock must be on the request, or every VM serves a stale wall clock
	// (spec §2.4, §5.3).
	if gotReq.HostUnixNanos != now.UnixNano() {
		t.Fatalf("HostUnixNanos = %d, want %d", gotReq.HostUnixNanos, now.UnixNano())
	}
	if gotReq.CapBytes != OutputCapBytes {
		t.Fatalf("CapBytes = %d, want the pinned cap %d", gotReq.CapBytes, OutputCapBytes)
	}
}

func TestRunOverConnFeedsStdinAndClosesIt(t *testing.T) {
	got := make(chan []byte, 1)
	conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
		if !req.HasStdin {
			_ = ga.WriteFrame(rw, ga.KindError, []byte("expected stdin"))
			return
		}
		var buf []byte
		for {
			k, p, err := ga.ReadFrame(rw)
			if err != nil {
				return
			}
			if k == ga.KindStdinEOF {
				break
			}
			buf = append(buf, p...)
		}
		got <- buf
		_ = ga.WriteJSON(rw, ga.KindEnd, ga.End{ExitCode: 0})
	})
	// Larger than one frame, so the chunking is exercised: a write is base64 in
	// Exec.stdin and is routinely multi-MB (transport.ts's base64EncodedLength note).
	payload := make([]byte, ga.MaxFrame*2+17)
	for i := range payload {
		payload[i] = byte('a' + i%26)
	}
	if _, err := runOverConn(context.Background(), conn, Command{
		Command: "base64 -d > f", Stdin: payload, CapBytes: OutputCapBytes,
	}, &capturingSink{}, time.Now()); err != nil {
		t.Fatalf("runOverConn: %v", err)
	}
	select {
	case b := <-got:
		if len(b) != len(payload) || string(b) != string(payload) {
			t.Fatalf("guest got %d bytes, want %d identical", len(b), len(payload))
		}
	case <-time.After(2 * time.Second):
		// The EOF is the point: `base64 -d > file` only terminates at EOF
		// (remote-worker/DESIGN.md step 4), so a protocol that never closes stdin
		// hangs every write.
		t.Fatal("guest never saw KindStdinEOF")
	}
}

func TestRunOverConnTreatsAMissingEndAsAShortResponse(t *testing.T) {
	conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
		_ = ga.WriteFrame(rw, ga.KindStdout, []byte("partial"))
		// ...and then the connection closes with no End. Spec §5.4: counted, never a
		// zero exit over truncated output.
	})
	var out capturingSink
	_, err := runOverConn(context.Background(), conn, Command{Command: "cat big", CapBytes: OutputCapBytes}, &out, time.Now())
	if !errors.Is(err, ErrShortResponse) {
		t.Fatalf("err = %v, want ErrShortResponse", err)
	}
	if got := ReasonOf(err); got != RefuseShortResponse {
		t.Fatalf("ReasonOf = %q, want %q so §7.3 can attribute it", got, RefuseShortResponse)
	}
}

func TestRunOverConnSurfacesAGuestError(t *testing.T) {
	conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
		_ = ga.WriteFrame(rw, ga.KindError, []byte("fork: cannot allocate memory"))
	})
	_, err := runOverConn(context.Background(), conn, Command{Command: "true", CapBytes: OutputCapBytes}, &capturingSink{}, time.Now())
	if err == nil || !errors.Is(err, ErrGuest) {
		t.Fatalf("err = %v, want ErrGuest", err)
	}
	if !strings.Contains(err.Error(), "cannot allocate memory") {
		t.Fatalf("err = %v, want the guest's message preserved", err)
	}
}

func TestRunOverConnReportsDroppedBytes(t *testing.T) {
	conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
		_ = ga.WriteJSON(rw, ga.KindEnd, ga.End{ExitCode: 0, DroppedStdout: 4096, DroppedStderr: 12})
	})
	res, err := runOverConn(context.Background(), conn, Command{Command: "yes", CapBytes: 16}, &capturingSink{}, time.Now())
	if err != nil {
		t.Fatalf("runOverConn: %v", err)
	}
	if res.DroppedStdout != 4096 || res.DroppedStderr != 12 || !res.TruncatedStdout() {
		t.Fatalf("res = %+v", res)
	}
}

func TestRunOverConnUnblocksOnContextCancel(t *testing.T) {
	conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
		time.Sleep(10 * time.Second) // never answers
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := runOverConn(ctx, conn, Command{Command: "sleep 99", CapBytes: OutputCapBytes}, &capturingSink{}, time.Now())
		done <- err
	}()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, ErrAborted) {
			t.Fatalf("err = %v, want ErrAborted", err)
		}
	case <-time.After(2 * time.Second):
		// A read that only unblocks when the guest answers would leave Abort unable to
		// stop anything, and Abort is GrpcRelayTransport's DECLARED truncation
		// mechanism (transport.ts:57-73).
		t.Fatal("runOverConn did not unblock on cancel")
	}
}
