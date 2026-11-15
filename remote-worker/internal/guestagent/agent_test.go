package guestagent

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// drive runs one request against a real Agent over a net.Pipe and collects the reply.
func drive(t *testing.T, a *Agent, req Request, stdin []byte) (stdout, stderr string, end End, gotErr string) {
	t.Helper()
	host, guest := net.Pipe()
	go func() { _ = a.ServeConn(guest) }()
	defer host.Close()

	if err := WriteJSON(host, KindRequest, req); err != nil {
		t.Fatalf("write request: %v", err)
	}
	for off := 0; off < len(stdin); off += MaxFrame {
		e := off + MaxFrame
		if e > len(stdin) {
			e = len(stdin)
		}
		if err := WriteFrame(host, KindStdin, stdin[off:e]); err != nil {
			t.Fatalf("write stdin: %v", err)
		}
	}
	if err := WriteFrame(host, KindStdinEOF, nil); err != nil {
		t.Fatalf("write stdin EOF: %v", err)
	}
	var sb, eb strings.Builder
	for {
		k, p, err := ReadFrame(host)
		if err == io.EOF {
			t.Fatal("agent closed without End or Error")
		}
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		switch k {
		case KindStdout:
			sb.Write(p)
		case KindStderr:
			eb.Write(p)
		case KindEnd:
			if err := DecodeJSON(p, &end); err != nil {
				t.Fatalf("decode End: %v", err)
			}
			return sb.String(), eb.String(), end, ""
		case KindError:
			return sb.String(), eb.String(), End{}, string(p)
		}
	}
}

func newTestAgent(t *testing.T) *Agent {
	t.Helper()
	work := t.TempDir()
	a, err := NewAgent(AgentOptions{WorkDir: work, ScratchDir: t.TempDir()})
	if err != nil {
		t.Fatalf("NewAgent: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return a
}

func TestAgentRunsOnTheParkedShellWithoutForking(t *testing.T) {
	a := newTestAgent(t)
	pid := a.ShellPID()
	if pid <= 0 {
		t.Fatal("ShellPID = 0: the shell must be forked at construction, which is what the snapshot captures")
	}
	stdout, stderr, end, errMsg := drive(t, a, Request{
		Command: "echo hi; echo oops >&2; exit 7", CapBytes: 1 << 20, HostUnixNanos: time.Now().UnixNano(),
	}, nil)
	if errMsg != "" {
		t.Fatalf("agent error: %s", errMsg)
	}
	if stdout != "hi\n" || stderr != "oops\n" || end.ExitCode != 7 {
		t.Fatalf("stdout=%q stderr=%q end=%+v", stdout, stderr, end)
	}
	// The whole point of §5.4: no fork. Same shell across commands, so the dominant
	// hot-path term — starting bash — is not paid per Exec.
	if _, _, end2, _ := drive(t, a, Request{Command: "echo again", CapBytes: 1 << 20}, nil); end2.ExitCode != 0 {
		t.Fatalf("second command: end=%+v", end2)
	}
	if a.ShellPID() != pid {
		t.Fatalf("ShellPID changed %d -> %d: the parked shell was replaced", pid, a.ShellPID())
	}
}

func TestAgentHandlesMultilineAndQuotedCommands(t *testing.T) {
	a := newTestAgent(t)
	// A command written line-by-line into a shell's stdin would break on either of
	// these. The agent stages it as a file and sources it instead.
	stdout, _, end, errMsg := drive(t, a, Request{
		Command:  "cat <<'EOF'\nline one\nline 'two'\nEOF",
		CapBytes: 1 << 20,
	}, nil)
	if errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("end=%+v err=%s", end, errMsg)
	}
	if stdout != "line one\nline 'two'\n" {
		t.Fatalf("stdout = %q", stdout)
	}
}

// Spec §5.4's documented limitation: a command that consumes stdin needs a freshly
// forked child, because you cannot close a long-lived parked shell's stdin without
// killing it.
func TestAgentServesAWriteWithStdinOnAFreshChild(t *testing.T) {
	a := newTestAgent(t)
	pid := a.ShellPID()
	content := "hello from the harness\n"
	stdin := []byte(base64.StdEncoding.EncodeToString([]byte(content)))
	_, stderr, end, errMsg := drive(t, a, Request{
		Command: "base64 -d > written.txt", HasStdin: true, CapBytes: 1 << 20,
	}, stdin)
	if errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("end=%+v stderr=%q err=%s", end, stderr, errMsg)
	}
	b, err := os.ReadFile(filepath.Join(a.WorkDir(), "written.txt"))
	if err != nil || string(b) != content {
		t.Fatalf("written.txt = %q err=%v", b, err)
	}
	// The parked shell survived: the stdin command went to a child, not to it.
	if a.ShellPID() != pid {
		t.Fatalf("ShellPID changed %d -> %d — feeding stdin must not kill the parked shell", pid, a.ShellPID())
	}
}

// TestParkedShellSubshellCannotReadTheAgentsControlPipe is the reachability half of
// the pair below: before asserting that a command CANNOT read the control pipe, prove
// that it could.
//
// The hazard is not hypothetical and it is not about hanging. The parked shell reads
// its commands from a pipe the agent writes, so a subshell that inherits that stdin
// reads the agent's own protocol. This test drives a real bash the same way forkShell
// does, with the SAME line the agent writes (parkedShellLine), for a staged command of
// `cat` — once with the redirect the fix added and once with exactly that redirect
// removed, which is the pre-fix line byte for byte.
//
// Discriminator: bash's control tail is `__ga_rc=$?` followed by two printfs. If `cat`
// inherits the shell's stdin it consumes and ECHOES that text, so the literal,
// unexpanded source lands on stdout ("__ga_rc=$?", "%d", "$__ga_rc"); if stdin is /dev/null,
// bash executes the tail instead and stdout carries the *evaluated* sentinel
// ("<nonce> 0"). One string tells the two apart with no timing involved.
//
// Stdin is closed after the line is written only so the leaking case terminates for the
// test; production never closes it, which is precisely why the pre-fix leak's other
// outcome is an unbounded block rather than a wrong answer.
func TestParkedShellSubshellCannotReadTheAgentsControlPipe(t *testing.T) {
	nonce, err := newNonce()
	if err != nil {
		t.Fatalf("newNonce: %v", err)
	}
	staged := filepath.Join(t.TempDir(), "cmd")
	if err := os.WriteFile(staged, []byte("cat\n"), 0o600); err != nil {
		t.Fatalf("stage command: %v", err)
	}

	runLine := func(t *testing.T, line string) string {
		t.Helper()
		cmd := exec.Command("bash")
		in, err := cmd.StdinPipe()
		if err != nil {
			t.Fatalf("StdinPipe: %v", err)
		}
		var out bytes.Buffer
		cmd.Stdout = &out
		if err := cmd.Start(); err != nil {
			t.Fatalf("start bash: %v", err)
		}
		if _, err := io.WriteString(in, line); err != nil {
			t.Fatalf("write line: %v", err)
		}
		_ = in.Close()
		if err := cmd.Wait(); err != nil {
			t.Fatalf("bash: %v (stdout %q)", err, out.String())
		}
		return out.String()
	}

	// PRESENCE: the pre-fix line, derived from the real one by removing exactly the
	// redirect, so this case cannot silently stop being the pre-fix line.
	leaky := strings.Replace(parkedShellLine(staged, nonce), parkedShellStdinRedirect, "", 1)
	if leaky == parkedShellLine(staged, nonce) {
		t.Fatalf("parkedShellLine no longer contains %q, so this test is not exercising the hazard it claims to",
			parkedShellStdinRedirect)
	}
	if got := runLine(t, leaky); !strings.Contains(got, "__ga_rc=$?") {
		t.Fatalf("without the redirect, `cat` did not echo the agent's control bytes; stdout = %q — "+
			"the hazard this test's other half guards against must be reachable, or that half proves nothing", got)
	}

	// ABSENCE: the real line. `cat` sees EOF at once, so the control tail reaches bash
	// and the sentinel arrives evaluated.
	got := runLine(t, parkedShellLine(staged, nonce))
	if strings.Contains(got, "__ga_rc=$?") {
		t.Fatalf("the staged command read the agent's own control pipe; stdout = %q", got)
	}
	if want := nonce + " 0\n"; !strings.Contains(got, want) {
		t.Fatalf("stdout = %q, want it to contain the evaluated sentinel %q", got, want)
	}
}

// TestAgentGivesACommandWithNoStdinAnEOF is the same invariant through the real
// ServeConn path: internal/exec/runner.go's container arm closes stdin unconditionally
// ("a command given no stdin must still see EOF"), and the two tiers must not diverge
// on it.
//
// `cat` with no stdin is the whole test. Pre-fix it either blocked until TimeoutS or
// echoed the agent's protocol back and lost the exit code; the second command proves
// the control stream is still in sync afterwards, which a leak would have broken for
// every subsequent command on this VM as well as this one.
func TestAgentGivesACommandWithNoStdinAnEOF(t *testing.T) {
	a := newTestAgent(t)
	start := time.Now()
	stdout, _, end, errMsg := drive(t, a, Request{
		Command: "cat; echo rc=$?", TimeoutS: 20, CapBytes: 1 << 20,
	}, nil)
	if errMsg != "" {
		t.Fatalf("agent error: %s (a command reading stdin must see EOF, not the control pipe)", errMsg)
	}
	if stdout != "rc=0\n" {
		t.Fatalf("stdout = %q, want %q: `cat` with no stdin must read EOF and nothing else", stdout, "rc=0\n")
	}
	if end.ExitCode != 0 {
		t.Fatalf("end = %+v, want exit 0", end)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("took %s: `cat` blocked on stdin instead of seeing EOF", elapsed)
	}
	if _, _, end2, errMsg2 := drive(t, a, Request{Command: "echo after", CapBytes: 1 << 20}, nil); errMsg2 != "" || end2.ExitCode != 0 {
		t.Fatalf("second command: end=%+v err=%s — the first command consumed the agent's control stream", end2, errMsg2)
	}
}

func TestAgentCapsEachStreamAtSourceAndReportsDropped(t *testing.T) {
	a := newTestAgent(t)
	stdout, stderr, end, errMsg := drive(t, a, Request{
		// 4096 bytes on each stream against a 100-byte cap.
		Command:  "head -c 4096 /dev/zero | tr '\\0' 'a'; head -c 4096 /dev/zero | tr '\\0' 'b' >&2",
		CapBytes: 100,
	}, nil)
	if errMsg != "" {
		t.Fatalf("agent error: %s", errMsg)
	}
	if len(stdout) != 100 || len(stderr) != 100 {
		t.Fatalf("forwarded %d stdout and %d stderr bytes, want 100 each — spec §4.1 prefers "+
			"capping at source over moving 8 MiB across vsock and discarding it", len(stdout), len(stderr))
	}
	if end.DroppedStdout != 4096-100 || end.DroppedStderr != 4096-100 {
		t.Fatalf("end = %+v, want ~3996 dropped on each stream, counted separately", end)
	}
	// And the exit code is the COMMAND's, not a truncation artifact: capping in the
	// agent rather than with `head -c` in the pipeline is what preserves it.
	if end.ExitCode != 0 {
		t.Fatalf("ExitCode = %d, want 0", end.ExitCode)
	}
}

// serialisingConn is a ReadWriteCloser that hands ServeConn a canned request and then
// watches HOW the replies are written rather than what they say. It exists because the
// bug it pins is not visible in the frames' content: two goroutines writing the same
// connection produce a correct-looking sequence right up to the moment a header lands
// inside another frame's payload.
//
// It records two things, both properties of the production code rather than of this
// test's timing: whether two Writes were ever in flight at once, and whether any
// stdout/stderr frame was written after the terminal frame. Frames are identified by
// their 5-byte header's kind byte (WriteFrame writes header then payload), which is
// unambiguous here because this test's payloads are runs of 'x' and "ok\n".
//
// Every Write sleeps, which is what makes the window wide enough to observe instead of
// something that shows up once in a thousand runs on a loaded machine.
type serialisingConn struct {
	r     io.Reader
	delay time.Duration

	mu                         sync.Mutex
	inflight                   int
	maxInflight                int
	terminalKind               Kind
	streamFramesBeforeTerminal int
	streamFramesAfterTerminal  int
}

func (c *serialisingConn) Read(p []byte) (int, error) { return c.r.Read(p) }

func (c *serialisingConn) Close() error { return nil }

func (c *serialisingConn) Write(p []byte) (int, error) {
	header := len(p) == 5
	streamHeader := header && (p[0] == byte(KindStdout) || p[0] == byte(KindStderr))
	terminalHeader := header && (p[0] == byte(KindEnd) || p[0] == byte(KindError))

	c.mu.Lock()
	c.inflight++
	if c.inflight > c.maxInflight {
		c.maxInflight = c.inflight
	}
	if streamHeader {
		if c.terminalKind == 0 {
			c.streamFramesBeforeTerminal++
		} else {
			c.streamFramesAfterTerminal++
		}
	}
	if terminalHeader {
		c.terminalKind = Kind(p[0])
	}
	c.mu.Unlock()

	time.Sleep(c.delay)

	c.mu.Lock()
	c.inflight--
	c.mu.Unlock()
	return len(p), nil
}

// TestServeConnSerialisesTheTerminalFrameAgainstALiveWriter pins the terminal frame
// against a writer that is still running when it goes out — the review's finding that
// KindEnd/KindError were written straight to the connection, past frameWriter's mutex,
// while drain goroutines were still emitting through it.
//
// The arrangement is STRUCTURAL, not a timing coincidence, which matters: an earlier
// version of this test flooded stderr and relied on runOnParkedShell's 1s fallthrough
// firing while the stderr drain was behind. It passed in 1.07s — the fallthrough had
// never fired at all. A pipe holds at most its capacity, so the parked shell's stderr
// sentinel can only ever lag the flood by ~64 KiB and always arrives within a few drain
// cycles; that path cannot be made deterministic from the outside. The fix covers it
// (the seal is on the shared exit, and emit's own check is what makes an unjoinable
// drain harmless), but this test earns its keep on a path that is reproducible every
// run.
//
// That path is the timeout, which reaches the SAME site (ServeConn's `if err != nil`).
// A stdin command runs on a fresh child, so its output flows through os/exec's copy
// goroutine into the same frameWriter. On timeout runFreshChild kills the child only —
// not its process group — so a backgrounded grandchild keeps the stdout pipe open, the
// copy goroutine never sees EOF, cmd.Wait never returns (no WaitDelay is set) and the
// pipes are never closed. The writer is therefore guaranteed live, for seconds, while
// the terminal frame is written.
//
// Liveness is asserted, not assumed: the grandchild also appends to a file, so the test
// can prove the writer was still producing output during the window in which no frames
// were written. Without that, "zero frames after the terminal frame" would be
// indistinguishable from "the writer had already finished".
func TestServeConnSerialisesTheTerminalFrameAgainstALiveWriter(t *testing.T) {
	a := newTestAgent(t)
	liveFile := filepath.Join(a.WorkDir(), "live.txt")

	var in bytes.Buffer
	if err := WriteJSON(&in, KindRequest, Request{
		// 200 iterations x 50ms bounds the grandchild at ~10s so the test leaks nothing
		// long-lived; `sleep 30` in the foreground is what the 1s timeout interrupts.
		Command:  "{ for i in $(seq 1 200); do printf 'spam-%s\\n' \"$i\"; printf 'x' >> live.txt; sleep 0.05; done; } & sleep 30",
		HasStdin: true,
		TimeoutS: 1,
		CapBytes: 16 << 20,
	}); err != nil {
		t.Fatalf("encode request: %v", err)
	}
	if err := WriteFrame(&in, KindStdin, []byte("unused\n")); err != nil {
		t.Fatalf("encode stdin: %v", err)
	}
	if err := WriteFrame(&in, KindStdinEOF, nil); err != nil {
		t.Fatalf("encode stdin EOF: %v", err)
	}

	conn := &serialisingConn{r: bytes.NewReader(in.Bytes()), delay: 20 * time.Millisecond}
	done := make(chan error, 1)
	go func() { done <- a.ServeConn(conn) }()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		t.Fatal("ServeConn did not return within 60s")
	}

	sizeAtTerminal := fileSize(liveFile)
	// Long enough for ~20 more grandchild iterations. Without the seal, each one is a
	// frame written onto a connection whose terminal frame has already gone out.
	time.Sleep(time.Second)
	sizeAfter := fileSize(liveFile)

	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.terminalKind != KindError {
		t.Fatalf("terminal frame kind = %#x, want KindError (%#x) from the timeout path",
			byte(conn.terminalKind), byte(KindError))
	}
	if conn.streamFramesBeforeTerminal == 0 {
		t.Fatal("no stdout frames before the terminal frame: the grandchild never produced output, " +
			"so this test is not exercising a concurrent writer at all")
	}
	if sizeAfter <= sizeAtTerminal {
		t.Fatalf("live.txt did not grow after the terminal frame (%d -> %d bytes): the writer had already "+
			"stopped, so a zero count below would prove nothing", sizeAtTerminal, sizeAfter)
	}
	if conn.streamFramesAfterTerminal != 0 {
		t.Fatalf("%d stdout/stderr frames were written AFTER the terminal frame: the host reads that as a "+
			"spliced or trailing frame and reports a hard worker failure", conn.streamFramesAfterTerminal)
	}
	if conn.maxInflight != 1 {
		t.Fatalf("%d writes were in flight at once: every write to the connection must hold frameWriter's "+
			"one mutex, or a header lands inside another frame's payload", conn.maxInflight)
	}
}

func fileSize(path string) int64 {
	fi, err := os.Stat(path)
	if err != nil {
		return -1
	}
	return fi.Size()
}

// TestFrameWriterSealsBothTerminalKinds locks the seal itself, for the End frame as well
// as the Error frame: after either terminal write, a stream frame is COUNTED as dropped
// and not written. The test above can only reach the Error path deterministically (see
// its comment), and the success path is the common one in production.
func TestFrameWriterSealsBothTerminalKinds(t *testing.T) {
	for _, tc := range []struct {
		name string
		seal func(*frameWriter) error
	}{
		{"End", func(w *frameWriter) error { return w.sealAndWriteEnd(End{ExitCode: 3}) }},
		{"Error", func(w *frameWriter) error { return w.sealAndWriteFrame(KindError, []byte("boom")) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			w := &frameWriter{rw: &buf, cap: 1 << 20}
			w.stdout([]byte("before"))
			if err := tc.seal(w); err != nil {
				t.Fatalf("seal: %v", err)
			}
			sealedAt := buf.Len()
			w.stdout([]byte("after"))
			w.stderr([]byte("also after"))
			if buf.Len() != sealedAt {
				t.Fatalf("%d bytes were written after the terminal frame", buf.Len()-sealedAt)
			}
			if w.droppedStdout != int64(len("after")) || w.droppedStderr != int64(len("also after")) {
				t.Fatalf("dropped counts = %d/%d, want %d/%d: post-seal bytes must be counted, not silently lost",
					w.droppedStdout, w.droppedStderr, len("after"), len("also after"))
			}
		})
	}
}

func TestAgentReportsATimeoutRatherThanHanging(t *testing.T) {
	a := newTestAgent(t)
	_, _, _, errMsg := drive(t, a, Request{Command: "sleep 30", TimeoutS: 1, CapBytes: 1 << 20}, nil)
	// The host's destroy is the real enforcement (spec §4.1: teardown is the same path
	// as success). This is belt-and-braces so a longer host timeout still gets an
	// explicit frame instead of silence.
	if !strings.HasPrefix(errMsg, "timeout:") {
		t.Fatalf("agent error = %q, want a timeout: prefix", errMsg)
	}
}

// TestAgentCapsEachStreamAtSourceAndReportsDropped above drives 4096 bytes against
// the 32 KiB MaxFrame read buffer, so the whole unterminated line fits in a single
// drainUntilNonce Read() call and the carry-over path added in fix round 1 is never
// taken — that test would pass identically against the pre-rewrite ReadBytes('\n')
// implementation, which is exactly the regression this test guards against.
//
// 160 KiB is five times MaxFrame, forcing drainUntilNonce through several Read()
// cycles on one line with no newline at all, carrying a small remainder across each
// boundary. The exact byte counts (not just "capped, roughly") are what would catch
// an off-by-one in that carry-over, which is the one way the rewrite could go subtly
// wrong.
// TestAgentBoundsDrainAcrossMultipleReadCycles above forces several Read() cycles,
// but its sentinel is written as a separate small printf, so the sentinel always
// lands wholly inside one 32 KiB read: the boundary-spanning case the carry-over
// exists for is never produced. A revert to ReadBytes('\n') would also pass it,
// since buffering the whole line and then capping yields identical observable
// output and dropped counts -- only memory use differs, which a test cannot easily
// see. (Both found by mutation-testing fix round 2: setting the carry-over to 0
// left that test, and the cap test, green.)
//
// This test drives drainUntilNonce directly instead of through a real subprocess
// pipe, because a subprocess pipe gives no way to guarantee which byte lands in
// which Read() call -- the whole point here is putting the split *inside* the
// nonce, not just forcing "a few" reads somewhere. An io.Pipe gives that guarantee:
// bufio.Reader forwards a Read() whose buffer is exactly the bufio's own buffer
// size (MaxFrame, matching how Agent builds a.stdout/a.stderr) straight through to
// the underlying reader without going through its internal buffer, and io.Pipe
// delivers one Write to exactly the Read call(s) that drain it. So writing exactly
// MaxFrame bytes in a single Write reliably produces exactly one MaxFrame-sized
// Read(), letting the test choose precisely where inside those bytes the nonce
// begins. The pipe is deliberately never closed: the real parked shell does not
// close its stdout either, so a carry-over that misses the nonce here must hang
// waiting for more data, the same failure mode production would see -- not return
// an error, which is why the assertion that matters most is a completion bound.
func TestDrainUntilNonceHandlesANonceSplitAcrossAReadBoundary(t *testing.T) {
	nonce, err := newNonce()
	if err != nil {
		t.Fatalf("newNonce: %v", err)
	}
	const exitCode = 7

	// Split partway through the nonce itself, computed from len(nonce) and MaxFrame
	// rather than a hard-coded offset: `before` bytes of the nonce land in the read
	// ending exactly at the MaxFrame boundary, and the remaining len(nonce)-before
	// land in the next one. If the nonce format ever changes length, this still
	// splits inside it instead of silently degrading into a same-read match.
	before := len(nonce) / 2
	prefixLen := MaxFrame - before
	prefix := strings.Repeat("a", prefixLen)
	sentinelTail := fmt.Sprintf("%s %d\n", nonce, exitCode)

	pr, pw := io.Pipe()
	r := bufio.NewReaderSize(pr, MaxFrame)
	t.Cleanup(func() { pw.Close() })

	go func() {
		// This first Write is exactly MaxFrame bytes (prefixLen + before), so
		// drainUntilNonce's first Read() returns exactly this much and no more --
		// see the function comment above for why that is guaranteed here.
		_, _ = pw.Write([]byte(prefix + sentinelTail[:before]))
		_, _ = pw.Write([]byte(sentinelTail[before:]))
		// Deliberately not closed here (see t.Cleanup above): a live, never-EOF
		// stream is what makes a missed nonce hang instead of erroring out.
	}()

	type result struct {
		code int32
		err  error
	}
	done := make(chan result, 1)
	var got []byte
	go func() {
		code, err := drainUntilNonce(r, nonce, func(b []byte) { got = append(got, b...) }, true)
		done <- result{code, err}
	}()

	select {
	case res := <-done:
		if res.err != nil {
			t.Fatalf("drainUntilNonce error: %v", res.err)
		}
		if res.code != exitCode {
			t.Fatalf("exit code = %d, want %d: the sentinel was not parsed correctly across the split", res.code, exitCode)
		}
		if string(got) != prefix {
			t.Fatalf("forwarded %d bytes, want exactly the %d-byte prefix (no sentinel fragment leaked)", len(got), len(prefix))
		}
	case <-time.After(5 * time.Second):
		// The assertion that matters most: a broken carry-over does not return a
		// wrong answer here, it hangs forever waiting for a nonce that already flew
		// past it.
		t.Fatal("drainUntilNonce did not return within 5s: a broken carry-over hangs waiting for a nonce split across the read boundary")
	}
}

func TestAgentBoundsDrainAcrossMultipleReadCycles(t *testing.T) {
	const total = 160 * 1024 // 5x MaxFrame (32 KiB): forces multiple Read() cycles.
	const cap = 1000

	a := newTestAgent(t)
	start := time.Now()
	stdout, _, end, errMsg := drive(t, a, Request{
		Command:  fmt.Sprintf("head -c %d /dev/zero | tr '\\0' 'a'", total),
		CapBytes: cap,
	}, nil)
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("drive took %s: a bounded drain must not buffer the whole line before capping", elapsed)
	}
	if errMsg != "" {
		t.Fatalf("agent error: %s", errMsg)
	}
	if len(stdout) != cap {
		t.Fatalf("forwarded %d stdout bytes, want exactly %d", len(stdout), cap)
	}
	if end.DroppedStdout != int64(total-cap) {
		t.Fatalf("DroppedStdout = %d, want exactly %d", end.DroppedStdout, total-cap)
	}
}

// TestAgentReportsATimeoutRatherThanHanging above only checks the FIRST command's
// error. Nothing drives a second command afterwards, so neither killShell actually
// running nor ServeConn's dead-check actually gating dispatch is pinned by it —
// either could be deleted and that test would still pass.
//
// This test drives a second, unrelated command on the SAME Agent after a timeout and
// asserts it fails fast with an explicit error mentioning the dead agent, rather than
// hanging (the orphaned drain goroutines racing a new command's, per fix round 1's
// Finding 3) or succeeding against a shell that no longer exists.
func TestAgentRejectsCommandsOnADeadAgentAfterATimeout(t *testing.T) {
	a := newTestAgent(t)
	_, _, _, errMsg := drive(t, a, Request{Command: "sleep 30", TimeoutS: 1, CapBytes: 1 << 20}, nil)
	if !strings.HasPrefix(errMsg, "timeout:") {
		t.Fatalf("first command's error = %q, want a timeout: prefix", errMsg)
	}

	start := time.Now()
	_, _, _, errMsg2 := drive(t, a, Request{Command: "echo hi", CapBytes: 1 << 20}, nil)
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("second command took %s: a dead Agent must fail fast, not hang", elapsed)
	}
	if errMsg2 == "" {
		t.Fatal("second command on a dead agent succeeded; want an error")
	}
	if !strings.Contains(errMsg2, "dead") {
		t.Fatalf("second command's error = %q, want it to mention the agent is dead", errMsg2)
	}
}

// A review found that bash does not recompute $ or $PPID inside the "( ... )"
// subshell runOnParkedShell sources commands in — only $BASHPID differs there — so
// $PPID inside it is the parked shell's PARENT, which is the process running the
// Agent (cmd/guest-agent's main in production; this test binary here). A command
// using the common defensive idiom `trap 'kill $PPID' EXIT` therefore signals that
// process, not the parked shell. main.go installs signal.Ignore for exactly this
// reason; this test installs the same guard on itself (since here it is the test
// binary, not a guest-agent process, that sits where $PPID points) and then proves
// the parked shell AND the agent both survive the trap, with the command's own exit
// code still reported.
func TestAgentSurvivesTrapKillPPIDOnExit(t *testing.T) {
	signal.Ignore(syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	t.Cleanup(func() { signal.Reset(syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP) })

	a := newTestAgent(t)
	pid := a.ShellPID()
	_, _, end, errMsg := drive(t, a, Request{
		Command: "trap 'kill $PPID' EXIT; echo hi; exit 3", CapBytes: 1 << 20,
	}, nil)
	if errMsg != "" {
		t.Fatalf("agent error: %s", errMsg)
	}
	if end.ExitCode != 3 {
		t.Fatalf("end.ExitCode = %d, want 3 (the command's own exit code, not a symptom of the agent dying)", end.ExitCode)
	}
	if a.ShellPID() != pid {
		t.Fatalf("ShellPID changed %d -> %d: the parked shell did not survive the trap", pid, a.ShellPID())
	}
	// Not just the shell — the agent itself must still be alive. Prove it with a
	// second, unrelated command over the same Agent.
	if _, _, end2, errMsg2 := drive(t, a, Request{Command: "echo still alive", CapBytes: 1 << 20}, nil); errMsg2 != "" || end2.ExitCode != 0 {
		t.Fatalf("second command after the trap: end=%+v err=%s", end2, errMsg2)
	}
}

func TestShouldSetClock(t *testing.T) {
	base := time.Unix(1757500000, 0)
	if shouldSetClock(base, base.Add(200*time.Millisecond)) {
		t.Error("a sub-second skew must not trigger a settimeofday on every Exec")
	}
	// The trap this exists for: the guest resumes from the SNAPSHOT moment, so the
	// skew is however long the golden snapshot has been in use — hours, not
	// milliseconds (spec §2.4).
	if !shouldSetClock(base, base.Add(-3*time.Hour)) {
		t.Error("a three-hour stale guest clock must be corrected")
	}
	if !shouldSetClock(base, base.Add(90*time.Second)) {
		t.Error("a 90s skew must be corrected")
	}
}

// TestAgentCorrectsClockOnEveryRequestWhileStillWrong is the restore regression test.
//
// A prior version of ServeConn gated the clock correction with a clockOK atomic.Bool
// latch: correct once, then never again for the life of the Agent. That is exactly
// wrong for THIS Agent, because it is not "the life of the Agent" that matters — it is
// the life of the PROCESS MEMORY IMAGE deploy/microvm/build-snapshot.sh snapshots.
// That script sends two requests carrying HostUnixNanos to the agent (probe_capabilities,
// then quiesce_guest) BEFORE ever taking the snapshot, so the very first one flips the
// latch true and corrects the clock during the BUILD — and `clockOK == true` is then
// baked into the golden snapshot's memory image. Every VM restored from it inherits
// clockOK==true and silently skips the correction forever, so its clock stays frozen at
// snapshot time on every real Exec. TestGateClock (internal/vmpool/gates_kvm_test.go)
// caught exactly this against a real Firecracker guest.
//
// This test reproduces the same shape without a hypervisor: a *restored* VM, from the
// agent's own point of view, is indistinguishable from "a second request arrives and
// the guest clock is STILL far from the host's" — nothing in-guest tells the process it
// was just resumed from a snapshot, so the correction has to be driven by comparing
// clocks on every request rather than by remembering a past decision. It drives the
// SAME Agent through two requests, both carrying a HostUnixNanos far from wall-clock
// time (a stale guest clock that a stub setWallClock deliberately never actually
// fixes, so the skew persists exactly as it would across a restore-and-Exec), and
// asserts setWallClock is invoked on BOTH — a latch would call it on only the first.
func TestAgentCorrectsClockOnEveryRequestWhileStillWrong(t *testing.T) {
	var calls int32
	orig := setWallClock
	setWallClock = func(time.Time) error {
		atomic.AddInt32(&calls, 1)
		// Deliberately a no-op: this stub does NOT change the guest's real clock, so
		// the skew below stays "far from host" on the next request too, exactly as it
		// would after an actual restore where the correction from a prior boot of the
		// snapshot is not present in the resumed image's clock at all.
		return nil
	}
	t.Cleanup(func() { setWallClock = orig })

	a := newTestAgent(t)
	staleHost := time.Now().Add(-55 * time.Minute).UnixNano() // the reported real-rig skew

	if _, _, end, errMsg := drive(t, a, Request{
		Command: "echo one", CapBytes: 1 << 20, HostUnixNanos: staleHost,
	}, nil); errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("first request: end=%+v err=%s", end, errMsg)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("setWallClock called %d times after the first request, want 1", got)
	}

	// Second request on the SAME Agent, same stale HostUnixNanos: this is what a
	// restored VM's first post-restore command looks like to the agent. A clockOK
	// latch would suppress this call; shouldSetClock alone must not.
	if _, _, end, errMsg := drive(t, a, Request{
		Command: "echo two", CapBytes: 1 << 20, HostUnixNanos: staleHost,
	}, nil); errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("second request: end=%+v err=%s", end, errMsg)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("setWallClock called %d times after the second request, want 2 — "+
			"a latch would have suppressed the second, restore-shaped correction", got)
	}
}

// The agent's own stderr notice (the lease OOM hint, G3) is one stderr frame written past
// the stream's cap, and never after the terminal frame.
func TestFrameWriterNoticeIsNotCappedAndNotAfterTheSeal(t *testing.T) {
	var buf bytes.Buffer
	w := &frameWriter{rw: &buf, cap: 4}
	w.stderr([]byte("123456"))
	w.notice("hint\n")
	if err := w.sealAndWriteEnd(End{}); err != nil {
		t.Fatalf("seal: %v", err)
	}
	sealedAt := buf.Len()
	w.notice("late\n")
	if buf.Len() != sealedAt {
		t.Fatalf("%d bytes were written after the terminal frame", buf.Len()-sealedAt)
	}
	var got []string
	for buf.Len() > 0 {
		k, p, err := ReadFrame(&buf)
		if err != nil {
			t.Fatalf("ReadFrame: %v", err)
		}
		got = append(got, fmt.Sprintf("%#x:%s", byte(k), p))
	}
	if len(got) != 3 || got[0] != fmt.Sprintf("%#x:1234", byte(KindStderr)) || got[1] != fmt.Sprintf("%#x:hint\n", byte(KindStderr)) {
		t.Fatalf("frames = %q, want the capped stderr, the notice in full, then End", got)
	}
	if w.droppedStderr != 2 {
		t.Fatalf("droppedStderr = %d, want 2: the notice is not counted against the cap", w.droppedStderr)
	}
}

// Ruling P5-R6: a kind this agent does not know, or a process kind outside a lease, is
// refused and never runs as a command, here on the parked shell.
func TestAgentRefusesAnUnknownKindWithoutRunningIt(t *testing.T) {
	a := newTestAgent(t)
	marker := filepath.Join(t.TempDir(), "ran")
	for _, tc := range []struct{ kind, want string }{
		{"bogus", "lease_unsupported: unknown kind bogus"},
		{RequestKindProcessStart, "lease_unsupported: process_start needs a lease request"},
	} {
		_, _, _, errMsg := drive(t, a, Request{Command: "touch " + marker, Kind: tc.kind, CapBytes: 1 << 20}, nil)
		if errMsg != tc.want {
			t.Errorf("kind %s: error %q, want %q", tc.kind, errMsg, tc.want)
		}
		if _, err := os.Stat(marker); err == nil {
			t.Fatalf("kind %s ran as a command", tc.kind)
		}
	}
	if out, _, end, errMsg := drive(t, a, Request{Command: "echo ok", Kind: RequestKindCommand, CapBytes: 1 << 20}, nil); errMsg != "" || end.ExitCode != 0 || out != "ok\n" {
		t.Fatalf("kind command: stdout %q, end %+v, err %q", out, end, errMsg)
	}
}
