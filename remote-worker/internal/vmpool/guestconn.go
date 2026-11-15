package vmpool

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"regexp"
	"strings"
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

	// The whole command travels in ONE request frame, which the guest bounds at
	// ga.MaxFrame. Refused here, before anything is sent: writing nothing and then
	// waiting for the guest's answer hung the Exec until the caller's own deadline.
	// Stdin has no such bound; it is split across frames below. This comes after the
	// deferred close: this function owns rw, so a refused command still closes it
	// (the guest's read then ends, and the worker keeps no descriptor for it).
	req, err := json.Marshal(guestRequest(c, cap, now))
	if err != nil {
		return Result{}, fmt.Errorf("encode request: %w", err)
	}
	if len(req) > ga.MaxFrame {
		return Result{}, fmt.Errorf("%w: %d bytes, the guest takes at most %d in one request; send large content as stdin", ErrCommandTooLarge, len(req), ga.MaxFrame)
	}

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
	go func() {
		err := sendRequest(rw, req, c.Stdin)
		writeErr <- err
		// A failed write means the guest never got a whole request and will never
		// answer: close, so the read below returns instead of waiting for it.
		if err != nil {
			closeConn()
		}
	}()

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
			return Result{
				ExitCode:       e.ExitCode,
				DroppedStdout:  e.DroppedStdout,
				DroppedStderr:  e.DroppedStderr,
				TeardownFailed: e.TeardownFailed,
				Tracked:        trackedFromGuest(e.Tracked),
			}, nil
		case ga.KindError:
			return Result{}, &guestError{msg: string(payload)}
		default:
			// An unknown kind is not something to skip past: it means the two sides
			// disagree about the protocol, and continuing would report a plausible
			// wrong answer.
			return Result{}, refusal(RefuseShortResponse, "unknown guest frame kind %#x", byte(kind))
		}
	}
}

// guestError is ErrGuest with the agent's KindError message, kept as a field so that
// guestTimedOut can read it; its text is the "%w: %s" it always was.
type guestError struct{ msg string }

func (e *guestError) Error() string { return ErrGuest.Error() + ": " + e.msg }

func (e *guestError) Unwrap() error { return ErrGuest }

// guestTimedOut reports whether err is the agent's report that the command's own timeout
// fired (ga.TimeoutMessage): the guest killed the command, emptied its cgroup and
// answered, so its VM is as fit for the next lease Exec as after an exit (runLease).
func guestTimedOut(err error) bool {
	var ge *guestError
	return errors.As(err, &ge) && ga.IsTimeoutMessage(ge.msg)
}

// guestRequest is the request frame's content for c. A command sets no kind, process or
// max_processes key (all omitempty), so its request is byte-identical to an older host's.
func guestRequest(c Command, capBytes int64, now time.Time) ga.Request {
	req := ga.Request{
		Command:            c.Command,
		TimeoutS:           c.TimeoutS,
		Streaming:          c.Streaming,
		CapBytes:           capBytes,
		HasStdin:           len(c.Stdin) > 0,
		HostUnixNanos:      now.UnixNano(),
		Lease:              c.Lease,
		NormaliseWorkspace: c.NormaliseWorkspace,
	}
	if c.Kind != ExecKindCommand {
		a := c.Process
		req.Kind = string(c.Kind)
		req.Process = &ga.ProcessArgs{Name: a.Name, ID: a.ID, Cwd: a.Cwd, Tail: a.Tail, Signal: a.Signal}
		req.MaxProcesses = c.MaxProcesses
	}
	return req
}

// The guest's own rules for a tracked row (guestagent: ids 1, 2, 3, … as decimal strings;
// ruling P5-R8's name rule, an unnamed process reported as p<id>; the three states).
var (
	guestTrackedIDRE   = regexp.MustCompile(`^[0-9]{1,20}$`)
	guestTrackedNameRE = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
)

// guestTrackedRowProblem says how a guest's tracked row breaks the guest's own rules, or ""
// when it keeps them.
func guestTrackedRowProblem(p ga.TrackedProcess) string {
	switch {
	case !guestTrackedIDRE.MatchString(p.ID):
		return "id"
	case p.Name != "" && !guestTrackedNameRE.MatchString(p.Name):
		return "name"
	case p.State != ga.TrackedRunning && p.State != ga.TrackedExited && p.State != ga.TrackedKilled:
		return "state"
	}
	return ""
}

// trackedFromGuest is an End's tracked table as the pool keeps it, nil for none. The rows
// come from the guest, which the host does not trust (PR #814 review): their ids, names
// and states reach the host's audit lines, so a row breaking the guest's own rules is
// dropped and flagged, quoted, never kept.
func trackedFromGuest(ps []ga.TrackedProcess) []TrackedProcess {
	var out []TrackedProcess
	for _, p := range ps {
		if why := guestTrackedRowProblem(p); why != "" {
			log.Printf("vmpool: guest tracked row refused: bad %s: id=%q name=%q state=%q pid=%d",
				why, clipForLog(p.ID), clipForLog(p.Name), clipForLog(p.State), p.PID)
			continue
		}
		out = append(out, TrackedProcess{ID: p.ID, Name: p.Name, PID: p.PID, State: p.State, Code: p.Code,
			Started: time.UnixMilli(p.StartedUnixMs), MemoryBytes: p.MemoryBytes})
	}
	return out
}

// clipForLog bounds a guest-supplied string a log line quotes.
func clipForLog(s string) string {
	const n = 80
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// guestKeepsLease reports whether err is a guest refusal that leaves the VM as fit for
// the next lease Exec as before (Task 3's carry): a process kind the guest refused before
// running anything -- process_*: (not found, limit, name taken or invalid, cwd, signal),
// processes_not_enabled:, or lease_unsupported: for a kind it does not serve. Its message
// is the wire string the client matches on. It applies to a process kind only (runLease):
// a command's guest error is a genuine failure whatever its text.
func guestKeepsLease(err error) (msg string, ok bool) {
	var ge *guestError
	if !errors.As(err, &ge) {
		return "", false
	}
	for _, prefix := range []string{"process_", "processes_not_enabled:", "lease_unsupported:"} {
		if strings.HasPrefix(ge.msg, prefix) {
			return ge.msg, true
		}
	}
	return "", false
}

// sendRequest writes the encoded Request frame, then the stdin frames if any, then
// ALWAYS the stdin-EOF frame — the guest reads until it sees KindStdinEOF whether or
// not HasStdin was set, so the host must always send it or a command that only
// terminates at end-of-input (`base64 -d > file`) hangs forever.
func sendRequest(w io.Writer, req, stdin []byte) error {
	if err := ga.WriteFrame(w, ga.KindRequest, req); err != nil {
		return fmt.Errorf("write request: %w", err)
	}
	for off := 0; off < len(stdin); off += ga.MaxFrame {
		end := min(off+ga.MaxFrame, len(stdin))
		if err := ga.WriteFrame(w, ga.KindStdin, stdin[off:end]); err != nil {
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
