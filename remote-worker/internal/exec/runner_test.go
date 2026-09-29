package exec_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"strings"
	"testing"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

// recorder is a Sink that keeps every chunk, tagged by stream.
type recorder struct {
	stdout []byte
	stderr []byte
	calls  int
	failAt int // when >0, return an error on that call number (1-based)
	// dropped counts reported dropped bytes PER STREAM. Keyed rather than summed
	// because the two streams are capped separately and only stdout's overflow is a
	// seam-level truncation — a summing recorder cannot tell the session's filter
	// from a stream-blind one (#189 review).
	dropped map[pb.Stream]int
}

func (r *recorder) droppedOn(s pb.Stream) int { return r.dropped[s] }

func (r *recorder) Chunk(stream pb.Stream, data []byte) error {
	r.calls++
	if r.failAt > 0 && r.calls >= r.failAt {
		return errStreamGone
	}
	switch stream {
	case pb.Stream_STREAM_STDERR:
		r.stderr = append(r.stderr, data...)
	default:
		r.stdout = append(r.stdout, data...)
	}
	return nil
}

func (r *recorder) Dropped(stream pb.Stream, n int) {
	if r.dropped == nil {
		r.dropped = map[pb.Stream]int{}
	}
	r.dropped[stream] += n
}

var errStreamGone = errStr("stream gone")

type errStr string

func (e errStr) Error() string { return string(e) }

func TestSplitsStdoutAndStderr(t *testing.T) {
	var r recorder
	code, err := wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID:     1,
		Command:   "echo hi; echo oops >&2; exit 7",
		Streaming: true,
	}, &r)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if code != 7 {
		t.Errorf("exit code = %d, want 7", code)
	}
	if got := string(r.stdout); got != "hi\n" {
		t.Errorf("stdout = %q, want %q", got, "hi\n")
	}
	if got := string(r.stderr); got != "oops\n" {
		t.Errorf("stderr = %q, want %q", got, "oops\n")
	}
}

func TestExitZero(t *testing.T) {
	var r recorder
	code, err := wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID: 2, Command: "true", Streaming: true,
	}, &r)
	if err != nil || code != 0 {
		t.Fatalf("got code=%d err=%v, want 0/nil", code, err)
	}
}

// A single frame must stay small (spec §8): output larger than ChunkSize
// arrives as several chunks, and every one is at most ChunkSize.
func TestChunkCapSplitsLargeOutput(t *testing.T) {
	var sizes []int
	sink := sinkFunc(func(_ pb.Stream, data []byte) error {
		sizes = append(sizes, len(data))
		return nil
	})
	want := 40 * 1024
	code, err := wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID:     3,
		Command:   "head -c 40960 /dev/zero | tr '\\0' 'a'",
		Streaming: true,
	}, sink)
	if err != nil || code != 0 {
		t.Fatalf("got code=%d err=%v", code, err)
	}
	total := 0
	for _, n := range sizes {
		if n > wexec.ChunkSize {
			t.Errorf("chunk of %d bytes exceeds cap %d", n, wexec.ChunkSize)
		}
		total += n
	}
	if total != want {
		t.Errorf("total bytes = %d, want %d", total, want)
	}
	if len(sizes) < 2 {
		t.Errorf("got %d chunk(s), want >=2 for %d bytes", len(sizes), want)
	}
}

// #189: the non-streaming path drops output past BufferCap. Silently dropping it
// is the whole defect — the harness's own cap is the SAME 8 MiB and trips on
// `bytes > cap`, strictly greater, so a worker that delivers exactly BufferCap
// resolves as {truncated: false, exitCode: <real code>} over cut output. The
// runner must therefore report what it dropped; only then can the session say so
// on the wire.
func TestNonStreamingReportsBytesDroppedAtBufferCap(t *testing.T) {
	const excess = 1000
	var r recorder
	code, err := wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID:     5,
		Command:   fmt.Sprintf("head -c %d /dev/zero", wexec.BufferCap+excess),
		Streaming: false,
	}, &r)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	// The real exit code survives truncation: the runner reports what the command
	// did, and it is the harness that owes `truncated ⇒ exitCode == null` (spec §8).
	if code != 0 {
		t.Errorf("exit code = %d, want 0 — truncation must not fabricate a failure", code)
	}
	// Exactly the cap arrives, which is precisely why the harness cannot notice.
	if len(r.stdout) != wexec.BufferCap {
		t.Errorf("delivered %d bytes, want BufferCap (%d)", len(r.stdout), wexec.BufferCap)
	}
	if got := r.droppedOn(pb.Stream_STREAM_STDOUT); got != excess {
		t.Errorf("reported %d dropped stdout bytes, want %d", got, excess)
	}
}

// The two buffers are capped SEPARATELY, so the report must name the stream it is
// about. Only stdout's overflow is a seam-level truncation — the harness's cap
// excludes stderr from both its buffer and its byte count — so a report that lost
// the stream would make the session mark a whole stdout as truncated (#189 review).
func TestNonStreamingReportsDroppedBytesPerStream(t *testing.T) {
	const excess = 1000
	var r recorder
	code, err := wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID:     7,
		Command:   fmt.Sprintf("echo ok; head -c %d /dev/zero >&2", wexec.BufferCap+excess),
		Streaming: false,
	}, &r)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if code != 0 {
		t.Errorf("exit code = %d, want 0", code)
	}
	if got := r.droppedOn(pb.Stream_STREAM_STDERR); got != excess {
		t.Errorf("reported %d dropped stderr bytes, want %d", got, excess)
	}
	// stdout produced 3 bytes and lost none. A stream-blind report would show the
	// stderr overflow here.
	if got := r.droppedOn(pb.Stream_STREAM_STDOUT); got != 0 {
		t.Errorf("reported %d dropped stdout bytes, want 0 — the stream was lost", got)
	}
}

// Output that fits is not reported as dropped — otherwise every non-streaming
// exec would mark itself truncated and the flag would carry no information.
func TestNonStreamingReportsNoDropUnderTheCap(t *testing.T) {
	var r recorder
	_, err := wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID: 6, Command: "echo hi", Streaming: false,
	}, &r)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := len(r.dropped); got != 0 {
		t.Errorf("reported drops on %d stream(s) for 3 bytes of output, want none: %v", got, r.dropped)
	}
}

// A sink failure means the stream is gone: Run reports it so the session knows
// not to try sending a terminal frame.
func TestSinkErrorPropagates(t *testing.T) {
	r := recorder{failAt: 1}
	_, err := wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID: 4, Command: "echo hi", Streaming: true,
	}, &r)
	if err == nil || !strings.Contains(err.Error(), "stream gone") {
		t.Fatalf("err = %v, want it to carry the sink failure", err)
	}
}

type sinkFunc func(pb.Stream, []byte) error

func (f sinkFunc) Chunk(s pb.Stream, d []byte) error { return f(s, d) }

// Discarded: every sinkFunc test is a streaming one, and the streaming path never
// buffers, so it never drops. A non-streaming test wanting the count uses
// recorder.
func (f sinkFunc) Dropped(pb.Stream, int) {}

// A pipe holder that escapes the process group survives the SIGKILL, so only
// the drain watchdog can unblock Run. Without it, this test hangs.
func TestRunReturnsWhenPipeHolderEscapesGroup(t *testing.T) {
	if _, err := osexec.LookPath("setsid"); err != nil {
		t.Skip("no setsid: cannot detach a pipe holder from the process group")
	}
	start := time.Now()
	var r recorder
	_, err := wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID: 30, Command: "setsid sleep 30 & exit 0", TimeoutS: 1, Streaming: true,
	}, &r)
	if err == nil {
		t.Log("Run returned nil; the point of this test is that it RETURNS")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("Run took %v: the drain was not bounded", elapsed)
	}
}

// The drain watchdog must distinguish WEDGED from merely SLOW (#173 item 6).
// TestRunReturnsWhenPipeHolderEscapesGroup above covers wedged: a holder that
// never writes again, which only a force-close can unblock. This covers the other
// case — a holder still producing output, steadily, just spread out. Forcing that
// one closed drops trailing output the command legitimately produced.
//
// The writer has to escape the process group, or the SIGKILL at timeout ends it
// and there is no "still arriving" to speak of. python3's os.setsid() does that
// portably, where the setsid(1) binary the sibling test needs is absent on macOS.
//
// Timing, with drainGrace at 2s: the deadline fires at 1s, so a wall-clock grace
// force-closes at ~3s while ticks keep coming past 4s. A measured run before the
// fix delivered 7 of 10, truncated at 3.01s. Reads arrive every 400ms, five times
// more often than the grace, so a quiet period never elapses and all ten arrive.
// The margin is the point: nothing here is tuned to the boundary.
//
// The COMPANION bound — that unbroken progress cannot defer the force-close
// forever — is deliberately not asserted here, because it cannot be. This writer
// exits on its own at ~4s and closes the pipe, so both pumps reach EOF and Run
// returns naturally; the watchdog never force-closes on this path whether
// drainCeiling exists or not. An elapsed-time check here would pass identically
// with the ceiling deleted (verified), which is worse than no check: it would
// advertise coverage it does not have. The ceiling's real guard is
// TestWatchDrainClosesAtCeilingDespiteProgress, where the writer never stops.
func TestSlowDrainKeepsTrailingOutput(t *testing.T) {
	py, err := osexec.LookPath("python3")
	if err != nil {
		t.Skip("no python3: cannot detach a trickling pipe holder from the process group")
	}
	const ticks = 10
	script := `
import os, sys, time
os.setsid()
for i in range(10):
    sys.stdout.write("tick%d\n" % i)
    sys.stdout.flush()
    time.sleep(0.4)
`
	var r recorder
	_, _ = wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID:     40,
		Command:   py + " -c '" + script + "' & exit 0",
		TimeoutS:  1,
		Streaming: true,
	}, &r)
	if got := strings.Count(string(r.stdout), "tick"); got != ticks {
		t.Errorf("got %d of %d ticks (%q): the drain was force-closed between reads while it was "+
			"still making progress, dropping trailing output", got, ticks, r.stdout)
	}
}

// streaming:false means no incremental delivery, not "exactly one frame":
// buffered output at exit still has to respect the wire's ChunkSize cap.
func TestNonStreamingChunksAtExit(t *testing.T) {
	var sizes []int
	sink := sinkFunc(func(_ pb.Stream, data []byte) error {
		sizes = append(sizes, len(data))
		return nil
	})
	want := 40 * 1024
	code, err := wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID:     32,
		Command:   "head -c 40960 /dev/zero | tr '\\0' 'a'",
		Streaming: false,
	}, sink)
	if err != nil || code != 0 {
		t.Fatalf("got code=%d err=%v", code, err)
	}
	total := 0
	for _, n := range sizes {
		if n > wexec.ChunkSize {
			t.Errorf("chunk of %d bytes exceeds cap %d", n, wexec.ChunkSize)
		}
		total += n
	}
	if total != want {
		t.Errorf("total bytes = %d, want %d", total, want)
	}
	if len(sizes) < 2 {
		t.Errorf("got %d chunk(s), want >=2 for %d bytes", len(sizes), want)
	}
}

// A small non-streaming exec still yields exactly one Chunk per stream: the
// slicing in emitBuffered must not fragment output that already fits.
func TestNonStreamingSmallOutputIsOneChunkPerStream(t *testing.T) {
	var r recorder
	code, err := wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID:     33,
		Command:   "echo hi; echo oops >&2",
		Streaming: false,
	}, &r)
	if err != nil || code != 0 {
		t.Fatalf("got code=%d err=%v", code, err)
	}
	if got := string(r.stdout); got != "hi\n" {
		t.Errorf("stdout = %q, want %q", got, "hi\n")
	}
	if got := string(r.stderr); got != "oops\n" {
		t.Errorf("stderr = %q, want %q", got, "oops\n")
	}
	if r.calls != 2 {
		t.Errorf("calls = %d, want 2 (one Chunk per stream)", r.calls)
	}
}

// The child exits 0 immediately; the sink is slow enough that the deadline
// fires mid-drain. The exit code must win over the expired context.
func TestSlowSinkDoesNotTurnSuccessIntoTimeout(t *testing.T) {
	slow := sinkFunc(func(pb.Stream, []byte) error {
		time.Sleep(1500 * time.Millisecond)
		return nil
	})
	code, err := wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID: 31, Command: "echo hi", TimeoutS: 1, Streaming: true,
	}, slow)
	if err != nil {
		t.Fatalf("err = %v, want nil: the command exited 0 before the deadline", err)
	}
	if code != 0 {
		t.Errorf("code = %d, want 0", code)
	}
}

// The harness writes files as `base64 -d > 'path'` with the payload on stdin.
// base64 only terminates at EOF, so this is the test that catches a regression
// where stdin is written but never closed.
func TestStdinRoundTripsThroughBase64(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/out.txt"
	content := "hello from stdin\n"
	payload := base64.StdEncoding.EncodeToString([]byte(content))

	// Bound the run. If stdin is ever written-but-not-closed, `base64 -d` never
	// sees EOF — the exact regression this test exists to catch — and without a
	// deadline that hangs the whole test binary until `go test`'s 10-minute
	// timeout instead of failing here in seconds.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var r recorder
	code, err := wexec.BashRunner{}.Run(ctx, wexec.Spec{
		ReqID:     10,
		Command:   "base64 -d > " + path,
		Stdin:     []byte(payload),
		Streaming: true,
	}, &r)
	if errors.Is(err, wexec.ErrTimeout) || errors.Is(err, wexec.ErrAborted) {
		t.Fatalf("run did not finish (%v): stdin was written but never closed, so base64 -d never saw EOF", err)
	}
	if err != nil || code != 0 {
		t.Fatalf("got code=%d err=%v, want 0/nil", code, err)
	}
	got, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("ReadFile: %v", readErr)
	}
	if string(got) != content {
		t.Errorf("file = %q, want %q", got, content)
	}
}

// A command that reads stdin but is given none must still terminate, or every
// such exec hangs until the harness deadline.
func TestNoStdinStillTerminates(t *testing.T) {
	// Two deliberate choices. The context bounds Run so a regression cannot leak
	// this goroutine (or its `cat` child) past the test. And the result comes back
	// over a buffered channel rather than via t.Errorf from inside the goroutine:
	// calling t after the test has completed panics the entire test binary, which
	// destroys every other result in the run.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	type result struct {
		code int32
		err  error
	}
	done := make(chan result, 1) // buffered: the goroutine never blocks on send
	go func() {
		var r recorder
		code, err := wexec.BashRunner{}.Run(ctx, wexec.Spec{
			ReqID: 11, Command: "cat", Streaming: true,
		}, &r)
		done <- result{code: code, err: err}
	}()

	select {
	case got := <-done:
		if errors.Is(got.err, wexec.ErrTimeout) || errors.Is(got.err, wexec.ErrAborted) {
			t.Fatalf("`cat` with no stdin did not terminate on its own (%v): stdin was not closed", got.err)
		}
		if got.err != nil {
			t.Fatalf("Run: %v", got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("`cat` with no stdin did not terminate within 5s: stdin was not closed")
	}
}

// NOTE: the non-streaming coverage originally planned here (small output -> one
// Chunk per stream; 40 KiB -> chunked at ChunkSize) already landed in Task 2's
// fix round as TestNonStreamingChunksAtExit and
// TestNonStreamingSmallOutputIsOneChunkPerStream. Do NOT re-add it here —
// duplicate coverage of the same behavior is a review defect. This task adds the
// stdin tests only.

func TestTimeoutKillsChild(t *testing.T) {
	start := time.Now()
	var r recorder
	code, err := wexec.BashRunner{}.Run(context.Background(), wexec.Spec{
		ReqID: 20, Command: "sleep 30", TimeoutS: 1, Streaming: true,
	}, &r)
	if !errors.Is(err, wexec.ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if code != -1 {
		t.Errorf("code = %d, want -1", code)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("took %v, want ~1s: the child was not killed at timeout_s", elapsed)
	}
}

func TestAbortViaContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var r recorder
	go func() { time.Sleep(200 * time.Millisecond); cancel() }()
	_, err := wexec.BashRunner{}.Run(ctx, wexec.Spec{
		ReqID: 21, Command: "sleep 30", Streaming: true,
	}, &r)
	if !errors.Is(err, wexec.ErrAborted) {
		t.Fatalf("err = %v, want ErrAborted", err)
	}
}

// THE test that fails without Setpgid: the killed command's grandchild must die
// too. A backgrounded subshell appends to a sentinel file; after the kill the
// file must stop growing.
func TestAbortKillsGrandchild(t *testing.T) {
	dir := t.TempDir()
	sentinel := dir + "/ticks"
	ctx, cancel := context.WithCancel(context.Background())
	var r recorder
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = (wexec.BashRunner{}).Run(ctx, wexec.Spec{
			ReqID: 22,
			// The subshell outlives `bash -c` unless the whole group is killed.
			Command:   "( while true; do echo tick >> " + sentinel + "; sleep 0.05; done ) & sleep 30",
			Streaming: true,
		}, &r)
	}()

	// Let it tick, then abort.
	time.Sleep(500 * time.Millisecond)
	cancel()
	// Bounded: if Run ever wedges, fail with a clear message rather than hanging
	// the test binary until go test's global timeout.
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("Run did not return within 15s of the abort: the drain was not bounded")
	}

	// Give any survivor a generous window to keep writing.
	first := lineCount(t, sentinel)
	time.Sleep(1 * time.Second)
	second := lineCount(t, sentinel)
	if second != first {
		t.Fatalf("sentinel grew from %d to %d lines after abort: grandchild survived (Setpgid missing?)", first, second)
	}
	if first == 0 {
		t.Fatal("sentinel never written: the test command did not run")
	}
}

func lineCount(t *testing.T, path string) int {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	return bytes.Count(b, []byte("\n"))
}
