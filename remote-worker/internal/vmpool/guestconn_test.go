package vmpool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"slices"
	"strings"
	"sync"
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
	case <-time.After(testWaitBound):
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

// PR #763 review (F2): the agent's report that a command's own timeout fired is a guest
// error like any other on the wire, and guestTimedOut tells it apart; the error text is
// unchanged.
func TestRunOverConnMarksTheGuestsOwnTimeout(t *testing.T) {
	for _, tc := range []struct {
		payload string
		timeout bool
	}{
		{ga.TimeoutMessage(7), true},
		{"guest-agent: this agent is dead", false},
	} {
		conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
			_ = ga.WriteFrame(rw, ga.KindError, []byte(tc.payload))
		})
		_, err := runOverConn(context.Background(), conn, Command{Command: "true", CapBytes: OutputCapBytes}, &capturingSink{}, time.Now())
		if !errors.Is(err, ErrGuest) || err.Error() != "vmpool: guest error: "+tc.payload {
			t.Fatalf("%q: err = %v, want ErrGuest with the message unchanged", tc.payload, err)
		}
		if got := guestTimedOut(err); got != tc.timeout {
			t.Errorf("%q: guestTimedOut = %v, want %v", tc.payload, got, tc.timeout)
		}
	}
	if guestTimedOut(ErrAborted) || guestTimedOut(nil) {
		t.Error("guestTimedOut is true for an error the guest did not send")
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
	case <-time.After(testWaitBound):
		// A read that only unblocks when the guest answers would leave Abort unable to
		// stop anything, and Abort is GrpcRelayTransport's DECLARED truncation
		// mechanism (transport.ts:57-73).
		t.Fatal("runOverConn did not unblock on cancel")
	}
}

// The whole command is one request frame, bounded by ga.MaxFrame. A larger
// one used to be refused by WriteFrame on the write goroutine while the read loop waited
// for an answer the guest could never send, so the Exec hung to the caller's deadline.
// It is refused at once now, before anything reaches the guest.
func TestRunOverConnRefusesACommandLargerThanOneFrameAtOnce(t *testing.T) {
	got := make(chan struct{}, 1)
	host, guest := net.Pipe()
	go func() {
		defer guest.Close()
		if _, _, err := ga.ReadFrame(guest); err == nil {
			got <- struct{}{}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), testWaitBound)
	defer cancel()
	_, err := runOverConn(ctx, host, Command{Command: strings.Repeat("x", ga.MaxFrame), CapBytes: OutputCapBytes}, &capturingSink{}, time.Now())
	if !errors.Is(err, ErrCommandTooLarge) {
		t.Fatalf("err = %v, want ErrCommandTooLarge", err)
	}
	if !strings.Contains(err.Error(), "stdin") {
		t.Fatalf("err = %v, want it to name stdin as the way to send large content", err)
	}
	if ctx.Err() != nil {
		t.Fatal("refused only at the caller's deadline, want at once")
	}
	select {
	case <-got:
		t.Fatal("the guest received a frame for a command it cannot take")
	case <-time.After(100 * time.Millisecond):
	}
}

// closeRecorder is an io.ReadWriteCloser that records Close, wrapping one side of a pipe.
type closeRecorder struct {
	io.ReadWriteCloser
	closed chan struct{}
	once   sync.Once
}

func (c *closeRecorder) Close() error {
	c.once.Do(func() { close(c.closed) })
	return c.ReadWriteCloser.Close()
}

// runOverConn owns the connection it is given, so a command it refuses as too large
// still closes it: left open, each refusal kept a vsock descriptor on the worker and
// left the guest agent blocked reading a request that never came.
func TestRunOverConnClosesTheConnOnACommandTooLarge(t *testing.T) {
	host, guest := net.Pipe()
	guestDone := make(chan error, 1)
	go func() {
		defer guest.Close()
		_, _, err := ga.ReadFrame(guest)
		guestDone <- err
	}()
	rw := &closeRecorder{ReadWriteCloser: host, closed: make(chan struct{})}
	_, err := runOverConn(context.Background(), rw, Command{Command: strings.Repeat("x", ga.MaxFrame), CapBytes: OutputCapBytes}, &capturingSink{}, time.Now())
	if !errors.Is(err, ErrCommandTooLarge) {
		t.Fatalf("err = %v, want ErrCommandTooLarge", err)
	}
	select {
	case <-rw.closed:
	default:
		t.Fatal("runOverConn returned ErrCommandTooLarge without closing the connection")
	}
	select {
	case err := <-guestDone:
		if err == nil {
			t.Fatal("the guest read a frame for a command it cannot take")
		}
	case <-time.After(testWaitBound):
		t.Fatal("the guest's read is still blocked after the refusal")
	}
}

// The same bound against the REAL guest agent, and its way around: a command just
// under one frame runs, and content far larger than a frame goes through stdin.
func TestRunOverConnAgainstTheAgentTakesLargeStdinButNotALargeCommand(t *testing.T) {
	run := func(c Command) (string, error) {
		a, err := ga.NewAgent(ga.AgentOptions{WorkDir: t.TempDir()})
		if err != nil {
			t.Fatalf("NewAgent: %v", err)
		}
		defer a.Close()
		host, guest := net.Pipe()
		go func() { _ = a.ServeConn(guest) }()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		var out capturingSink
		c.TimeoutS, c.CapBytes = 5, OutputCapBytes
		_, err = runOverConn(ctx, host, c, &out, time.Now())
		return out.out(), err
	}
	// Just under the frame once encoded: the JSON envelope is well under 1 KiB.
	if out, err := run(Command{Command: ": " + strings.Repeat("x", ga.MaxFrame-1024) + "; echo ok"}); err != nil || out != "ok\n" {
		t.Fatalf("command under one frame: out=%q err=%v", out, err)
	}
	if _, err := run(Command{Command: ": " + strings.Repeat("x", 40*1024)}); !errors.Is(err, ErrCommandTooLarge) {
		t.Fatalf("40 KiB command: err = %v, want ErrCommandTooLarge", err)
	}
	big := strings.Repeat("y", 175*1024)
	if out, err := run(Command{Command: "wc -c", Stdin: []byte(big)}); err != nil || strings.TrimSpace(out) != "179200" {
		t.Fatalf("175 KiB stdin: out=%q err=%v", out, err)
	}
}

func TestRunOverConnSurfacesTeardownFailed(t *testing.T) {
	conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
		_ = ga.WriteJSON(rw, ga.KindEnd, ga.End{ExitCode: 0, TeardownFailed: true})
	})
	res, err := runOverConn(context.Background(), conn, Command{Command: "true", CapBytes: OutputCapBytes}, &capturingSink{}, time.Now())
	if err != nil {
		t.Fatalf("runOverConn: %v", err)
	}
	if !res.TeardownFailed {
		t.Fatalf("res = %+v, want TeardownFailed", res)
	}
}

func TestSendRequestCarriesTheLeaseFlags(t *testing.T) {
	var buf bytes.Buffer
	enc, err := json.Marshal(guestRequest(Command{Command: "true", Lease: true, NormaliseWorkspace: true}, OutputCapBytes, time.Now()))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := sendRequest(&buf, enc, nil); err != nil {
		t.Fatalf("sendRequest: %v", err)
	}
	_, p, err := ga.ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	var req ga.Request
	if err := ga.DecodeJSON(p, &req); err != nil {
		t.Fatalf("DecodeJSON: %v", err)
	}
	if !req.Lease || !req.NormaliseWorkspace {
		t.Fatalf("req = %+v, want both lease flags forwarded", req)
	}
}

// TestLeaseRunCarriesHostClock pins spec §8.4's clock correction for lease mode (ruling R5):
// a lease VM idles for minutes between Execs, so every lease request frame must carry the
// host clock, not only the first after Resume. The stamp is added here, in runOverConn,
// which every Run of a real launcher goes through; the fake VM cannot observe it.
func TestLeaseRunCarriesHostClock(t *testing.T) {
	now := time.Unix(1762940000, 0)
	for i, c := range []Command{
		{Command: "first", Lease: true, NormaliseWorkspace: true, CapBytes: OutputCapBytes},
		{Command: "later", Lease: true, CapBytes: OutputCapBytes},
	} {
		var gotReq ga.Request
		conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
			gotReq = req
			_ = ga.WriteJSON(rw, ga.KindEnd, ga.End{})
		})
		if _, err := runOverConn(context.Background(), conn, c, &capturingSink{}, now); err != nil {
			t.Fatalf("Exec %d: runOverConn: %v", i, err)
		}
		if !gotReq.Lease || gotReq.NormaliseWorkspace != c.NormaliseWorkspace {
			t.Fatalf("Exec %d: request flags = lease %v, normalise %v; want %v, %v",
				i, gotReq.Lease, gotReq.NormaliseWorkspace, true, c.NormaliseWorkspace)
		}
		if gotReq.HostUnixNanos <= 0 || gotReq.HostUnixNanos != now.UnixNano() {
			t.Fatalf("Exec %d: HostUnixNanos = %d, want the host clock %d", i, gotReq.HostUnixNanos, now.UnixNano())
		}
	}
}

// A process kind reaches the guest's Request with its arguments and the host's process cap;
// a command's request carries no kind, process or max_processes key, byte-identical to an
// older host's.
func TestGuestRequestCarriesTheProcessKind(t *testing.T) {
	req := guestRequest(Command{
		Command: "npm run dev", Lease: true, Kind: ExecKindProcessStart,
		Process: ProcessArgs{Name: "web", Cwd: "app", Tail: 5, Signal: "INT", ID: "7"}, MaxProcesses: 4,
	}, OutputCapBytes, time.Now())
	want := ga.ProcessArgs{Name: "web", Cwd: "app", Tail: 5, Signal: "INT", ID: "7"}
	if req.Kind != ga.RequestKindProcessStart || req.Process == nil || *req.Process != want || req.MaxProcesses != 4 {
		t.Fatalf("req = %+v (process %+v), want process_start with its args and max 4", req, req.Process)
	}
	b, err := json.Marshal(guestRequest(Command{Command: "true", Lease: true}, OutputCapBytes, time.Now()))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	for _, k := range []string{`"kind"`, `"process"`, `"max_processes"`} {
		if bytes.Contains(b, []byte(k)) {
			t.Fatalf("a command's request %s carries %s", b, k)
		}
	}
}

// End.Tracked becomes Result.Tracked, started_unix_ms as a time.
func TestRunOverConnReturnsTheTrackedTable(t *testing.T) {
	conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
		_ = ga.WriteJSON(rw, ga.KindEnd, ga.End{Tracked: []ga.TrackedProcess{
			{ID: "1", Name: "web", PID: 412, State: ga.TrackedRunning, StartedUnixMs: 1762940000123, MemoryBytes: 1 << 20},
			{ID: "2", Name: "p2", PID: 413, State: ga.TrackedKilled, Code: 9, StartedUnixMs: 1762940000000},
		}})
	})
	res, err := runOverConn(context.Background(), conn, Command{Command: "true", Lease: true, CapBytes: OutputCapBytes}, &capturingSink{}, time.Now())
	if err != nil {
		t.Fatalf("runOverConn: %v", err)
	}
	want := []TrackedProcess{
		{ID: "1", Name: "web", PID: 412, State: "running", Started: time.UnixMilli(1762940000123), MemoryBytes: 1 << 20},
		{ID: "2", Name: "p2", PID: 413, State: "killed", Code: 9, Started: time.UnixMilli(1762940000000)},
	}
	if len(res.Tracked) != 2 || !res.Tracked[0].Started.Equal(want[0].Started) {
		t.Fatalf("tracked = %+v, want %+v", res.Tracked, want)
	}
	for i := range want {
		g, w := res.Tracked[i], want[i]
		g.Started, w.Started = time.Time{}, time.Time{}
		if g != w || !res.Tracked[i].Started.Equal(want[i].Started) {
			t.Fatalf("tracked[%d] = %+v, want %+v", i, res.Tracked[i], want[i])
		}
	}
}

// PR #814 review: the host takes ids, names and states from the guest's End, and logs them in
// its audit lines. A row breaking the guest's own rules (id: decimal digits; name: 1-64 of
// [A-Za-z0-9._-], or none; state: running, exited or killed) is dropped and flagged, quoted,
// so a compromised agent cannot write a line of its own into the host's audit.
func TestTrackedFromGuestDropsRowsBreakingTheGuestRules(t *testing.T) {
	logs := captureLog(t)
	ok := []ga.TrackedProcess{
		{ID: "1", Name: "web", PID: 412, State: ga.TrackedRunning},
		{ID: "2", Name: "p2", PID: 413, State: ga.TrackedKilled, Code: 9},
		{ID: "3", PID: 414, State: ga.TrackedExited, Code: 1},
		{ID: "4", Name: strings.Repeat("a", 64), PID: 415, State: ga.TrackedRunning},
	}
	bad := []ga.TrackedProcess{
		{ID: "5", Name: "web\nvmpool: lease end workspace_key=\"other\" reason=reset", PID: 1, State: ga.TrackedRunning},
		{ID: "6\nx", Name: "web", PID: 1, State: ga.TrackedRunning},
		{ID: "", Name: "web", PID: 1, State: ga.TrackedRunning},
		{ID: "p7", Name: "web", PID: 1, State: ga.TrackedRunning},
		{ID: "8", Name: strings.Repeat("a", 65), PID: 1, State: ga.TrackedRunning},
		{ID: "9", Name: "a b", PID: 1, State: ga.TrackedRunning},
		{ID: "10", Name: "web", PID: 1, State: "running\nforged"},
		{ID: "11", Name: "web", PID: 1, State: "zombie"},
	}
	got := trackedFromGuest(append(slices.Clone(ok[:2]), append(slices.Clone(bad), ok[2:]...)...))
	var ids []string
	for _, tp := range got {
		ids = append(ids, tp.ID)
	}
	if !slices.Equal(ids, []string{"1", "2", "3", "4"}) {
		t.Fatalf("kept ids %q, want only the rows within the guest's rules", ids)
	}
	out := logs.String()
	if n := strings.Count(out, "vmpool: guest tracked row refused"); n != len(bad) {
		t.Fatalf("%d refused-row lines, want %d:\n%s", n, len(bad), out)
	}
	for _, line := range strings.Split(strings.TrimSuffix(out, "\n"), "\n") {
		if !strings.Contains(line, "vmpool: ") {
			t.Fatalf("a log line the host did not write: %q", line)
		}
	}
}

// End to end: a row with a newline in its name, from the guest's End, never reaches the
// lease_process audit or a lease end's processes field; the ids those lines carry are quoted.
func TestGuestTrackedRowWithANewlineNeverReachesAnAuditLine(t *testing.T) {
	logs := captureLog(t)
	conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
		_ = ga.WriteJSON(rw, ga.KindEnd, ga.End{Tracked: []ga.TrackedProcess{
			{ID: "1", Name: "web", PID: 412, State: ga.TrackedRunning},
			{ID: "2", Name: "x\nvmpool: lease end forged", PID: 413, State: ga.TrackedRunning},
		}})
	})
	res, err := runOverConn(context.Background(), conn, Command{Command: "true", Lease: true, CapBytes: OutputCapBytes}, &capturingSink{}, time.Now())
	if err != nil {
		t.Fatalf("runOverConn: %v", err)
	}
	auditTracked("k", ModeLeaseProcesses, nil, nil, res.Tracked)
	log.Printf("vmpool: lease end test%s", trackedAuditField(res.Tracked))
	out := logs.String()
	if strings.Contains(out, "\nvmpool: lease end forged") || strings.Contains(out, "\nforged") {
		t.Fatalf("the forged line reached the log:\n%s", out)
	}
	if !strings.Contains(out, `event=start workspace_key="k" mode=lease+processes id="1" name="web"`) {
		t.Fatalf("want web's start record with its id quoted:\n%s", out)
	}
}

// drainToStdinEOF reads the frames the host sends after the request, up to the stdin EOF.
func drainToStdinEOF(rw io.Reader) bool {
	for {
		k, _, err := ga.ReadFrame(rw)
		if err != nil {
			return false
		}
		if k == ga.KindStdinEOF {
			return true
		}
	}
}

// F3 of the E17b report: a lease command's Abort sends KindAbort, after the request and
// its stdin EOF, and the guest's End{Aborted} comes back as Result.Aborted with no error,
// so the lease can tell a torn-down command from a guest that did not answer.
func TestRunOverConnSendsAbortAndReturnsTheAbortedEnd(t *testing.T) {
	gotAbort := make(chan struct{})
	conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
		if !drainToStdinEOF(rw) {
			return
		}
		if k, _, err := ga.ReadFrame(rw); err != nil || k != ga.KindAbort {
			return // no End: the host reports a short response
		}
		close(gotAbort)
		_ = ga.WriteJSON(rw, ga.KindEnd, ga.End{ExitCode: -1, Aborted: true})
	})
	abort := make(chan struct{})
	close(abort)
	res, err := runOverConn(context.Background(), conn, Command{
		Command: "sleep 99", CapBytes: OutputCapBytes, Lease: true, Abort: abort,
	}, &capturingSink{}, time.Now())
	if err != nil {
		t.Fatalf("runOverConn: %v", err)
	}
	select {
	case <-gotAbort:
	default:
		t.Fatal("the guest never read a KindAbort frame")
	}
	if !res.Aborted || res.ExitCode != -1 {
		t.Fatalf("result %+v, want Aborted with exit -1", res)
	}
}

// A guest built before KindAbort reads any byte after the stdin EOF as the host closing,
// tears the command down and answers KindError: the host sees a guest error, which ends
// the lease as an abort always did.
func TestRunOverConnAbortAgainstAnOlderGuestIsAGuestError(t *testing.T) {
	conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
		if !drainToStdinEOF(rw) {
			return
		}
		var b [1]byte
		_, _ = rw.Read(b[:])
		_ = ga.WriteFrame(rw, ga.KindError, []byte("guest-agent: the connection closed; the Exec was aborted"))
	})
	abort := make(chan struct{})
	close(abort)
	res, err := runOverConn(context.Background(), conn, Command{
		Command: "sleep 99", CapBytes: OutputCapBytes, Lease: true, Abort: abort,
	}, &capturingSink{}, time.Now())
	if !errors.Is(err, ErrGuest) || res.Aborted {
		t.Fatalf("result %+v, err %v; want ErrGuest and no Aborted", res, err)
	}
}

// Abort asks; it does not wait forever. A guest that reads the abort frame and never
// answers is still cut off by ctx, as before (the lease's bound cancels it).
func TestRunOverConnAbortThenCancelStillCloses(t *testing.T) {
	read := make(chan struct{})
	conn := fakeGuest(t, func(rw io.ReadWriteCloser, req ga.Request) {
		if !drainToStdinEOF(rw) {
			return
		}
		_, _, _ = ga.ReadFrame(rw)
		close(read)
		time.Sleep(10 * time.Second) // never answers
	})
	ctx, cancel := context.WithCancel(context.Background())
	abort := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := runOverConn(ctx, conn, Command{
			Command: "sleep 99", CapBytes: OutputCapBytes, Lease: true, Abort: abort,
		}, &capturingSink{}, time.Now())
		done <- err
	}()
	close(abort)
	select {
	case <-read:
	case <-time.After(testWaitBound):
		t.Fatal("the guest never read the abort frame")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, ErrAborted) {
			t.Fatalf("err = %v, want ErrAborted", err)
		}
	case <-time.After(testWaitBound):
		t.Fatal("runOverConn did not unblock on cancel after an abort frame")
	}
}

// F1: the idle page-cache drop's delay reaches the guest's request, and a Command without
// one sends no key, so a request to an older agent is byte-identical.
func TestGuestRequestCarriesTheCacheDrop(t *testing.T) {
	if got := guestRequest(Command{Command: "true", Lease: true, CacheDropAfterS: 30}, OutputCapBytes, time.Now()); got.CacheDropAfterS != 30 {
		t.Fatalf("CacheDropAfterS = %d, want 30", got.CacheDropAfterS)
	}
	enc, err := json.Marshal(guestRequest(Command{Command: "true", Lease: true}, OutputCapBytes, time.Now()))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(enc, []byte("cache_drop_after_s")) {
		t.Fatalf("a request without a delay carries the key: %s", enc)
	}
}
