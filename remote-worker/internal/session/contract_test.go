package session_test

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
	"github.com/rossoctl/moca/remote-worker/internal/relaytest"
	"github.com/rossoctl/moca/remote-worker/internal/session"
)

const testToken = "dev-token"

// harness is one Session (so its dedup cache persists) plus a fake relay. attach()
// can be called more than once to model a reconnect.
type harness struct {
	relay *relaytest.Relay
	sess  *session.Session
	cfg   session.Config
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	cfg := session.Config{
		SandboxID:     "sbx-contract-1",
		Image:         "contract:test",
		Trust:         "untrusted",
		Capabilities:  []string{"bash"},
		MaxConcurrent: 2,
		Heartbeat:     time.Second,
	}
	return &harness{
		relay: relaytest.Start(t),
		sess:  session.New(cfg, wexec.BashRunner{}),
		cfg:   cfg,
	}
}

// attach dials the relay, opens Attach, and serves the SAME session over it.
func (h *harness) attach(t *testing.T) *relaytest.Conn {
	t.Helper()
	conn, _, _ := h.attachCancellable(t)
	return conn
}

// attachCancellable is attach plus the two handles a shutdown test needs: the
// cancel for the context the Attach stream was created from, and a channel
// carrying Serve's return. Serve is handed exactly that context, which is its
// documented precondition — recvLoop blocks in Recv() and unblocks only when the
// stream's own context is cancelled.
func (h *harness) attachCancellable(t *testing.T) (*relaytest.Conn, context.CancelFunc, <-chan error) {
	t.Helper()
	// session.DialOptions, not a hand-rolled option list: these tests are the only
	// place the worker's dial configuration is exercised, so building their own would
	// leave "does main.go actually apply it?" unanswered — and an unapplied option is
	// indistinguishable from an absent one (#173 item 2).
	cc, err := grpc.NewClient(h.relay.Addr, session.DialOptions(insecure.NewCredentials())...)
	if err != nil {
		t.Fatalf("dial %s: %v", h.relay.Addr, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+testToken)
	stream, err := pb.NewSandboxWorkerClient(cc).Attach(ctx)
	if err != nil {
		cancel()
		t.Fatalf("attach: %v", err)
	}
	served := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		served <- h.sess.Serve(ctx, stream)
	}()
	t.Cleanup(func() {
		cancel()
		_ = cc.Close()
		// JOIN Serve, do not just cancel it (#173 item 5). Cancelling the stream's
		// context is what unblocks recvLoop, but nothing here proved Serve then
		// reached its return: a teardown deadlock left a goroutine wedged forever
		// while the test still reported PASS. served is buffered, so a test that
		// already read from it does not make this wait forever — done is closed
		// unconditionally by the goroutine itself.
		select {
		case <-done:
		case <-time.After(serveJoinGrace):
			t.Errorf("Serve did not return within %v of the attach context being cancelled: "+
				"teardown is wedged and its goroutine has leaked", serveJoinGrace)
		}
	})
	return h.relay.WaitAttach(t), cancel, served
}

// grepCmd prefers rg (what the harness's find ops use) and falls back to grep,
// which is all CI runners are guaranteed to have.
func grepCmd(pattern, path string) string {
	if _, err := exec.LookPath("rg"); err == nil {
		return "rg " + pattern + " " + path
	}
	return "grep " + pattern + " " + path
}

func TestContractHelloCarriesTokenAndIdentity(t *testing.T) {
	h := newHarness(t)
	conn := h.attach(t)

	if got := conn.Token(); got != "Bearer "+testToken {
		t.Errorf("authorization = %q, want %q", got, "Bearer "+testToken)
	}
	hello := conn.Hello()
	if hello.GetSandboxId() != "sbx-contract-1" {
		t.Errorf("sandbox_id = %q, want sbx-contract-1", hello.GetSandboxId())
	}
	if hello.GetCapacityMax() != 2 {
		t.Errorf("capacity_max = %d, want 2", hello.GetCapacityMax())
	}
	if hello.GetArch() == "" {
		t.Error("arch is empty, want the worker's GOARCH")
	}
}

// read: `cat <file>` — the shape createPodReadOps issues (operations.ts:22).
func TestContractRead(t *testing.T) {
	h := newHarness(t)
	conn := h.attach(t)

	dir := t.TempDir()
	path := dir + "/README.md"
	if err := os.WriteFile(path, []byte("hello contract\n"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	conn.SendExec(t, &pb.Exec{ReqId: 1, Command: "cat " + path, TimeoutS: 10, Streaming: true})
	stdout, _, terminal := conn.Collect(t, 1)

	if got := string(stdout); got != "hello contract\n" {
		t.Errorf("stdout = %q, want %q", got, "hello contract\n")
	}
	if e := terminal.GetError(); e != nil {
		t.Fatalf("ExecError: %s", e.GetMessage())
	}
	if terminal.GetEnd().GetExitCode() != 0 {
		t.Errorf("terminal = %+v, want End{0}", terminal)
	}
}

// write: `base64 -d > <file>` with the payload on stdin (operations.ts:40).
func TestContractWrite(t *testing.T) {
	h := newHarness(t)
	conn := h.attach(t)

	dir := t.TempDir()
	path := dir + "/out.txt"
	content := "written through the wire\n"

	conn.SendExec(t, &pb.Exec{
		ReqId:     2,
		Command:   "base64 -d > " + path,
		Stdin:     []byte(base64.StdEncoding.EncodeToString([]byte(content))),
		TimeoutS:  10,
		Streaming: true,
	})
	_, _, terminal := conn.Collect(t, 2)

	if e := terminal.GetError(); e != nil {
		t.Fatalf("ExecError: %s", e.GetMessage())
	}
	if terminal.GetEnd().GetExitCode() != 0 {
		t.Fatalf("terminal = %+v, want End{0}", terminal)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != content {
		t.Errorf("file = %q, want %q", got, content)
	}
}

// bash: stdout and stderr must arrive on distinct streams, with the real exit code.
func TestContractBash(t *testing.T) {
	h := newHarness(t)
	conn := h.attach(t)

	conn.SendExec(t, &pb.Exec{
		ReqId:     3,
		Command:   "echo hi; echo oops >&2; exit 7",
		TimeoutS:  10,
		Streaming: true,
	})
	stdout, stderr, terminal := conn.Collect(t, 3)

	if got := string(stdout); got != "hi\n" {
		t.Errorf("stdout = %q, want %q", got, "hi\n")
	}
	if got := string(stderr); got != "oops\n" {
		t.Errorf("stderr = %q, want %q", got, "oops\n")
	}
	if e := terminal.GetError(); e != nil {
		t.Fatalf("ExecError: %s", e.GetMessage())
	}
	if terminal.GetEnd().GetExitCode() != 7 {
		t.Errorf("terminal = %+v, want End{7}", terminal)
	}
}

// grep: a streaming op whose output exceeds one chunk, so it must arrive as several.
func TestContractGrepStreamsMultipleChunks(t *testing.T) {
	h := newHarness(t)
	conn := h.attach(t)

	dir := t.TempDir()
	path := dir + "/haystack.txt"
	var b strings.Builder
	for i := 0; i < 3000; i++ { // ~149 KiB of matching lines, well over 4x the 32 KiB cap
		b.WriteString("needle in line with padding to make it wide enough\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	conn.SendExec(t, &pb.Exec{
		ReqId:     4,
		Command:   grepCmd("needle", path),
		TimeoutS:  30,
		Streaming: true,
	})

	// Count chunks explicitly rather than using Collect, since the point is the split.
	var chunks int
	var total int
	for {
		f := conn.Next(t)
		if ch := f.GetChunk(); ch != nil && ch.GetReqId() == 4 {
			chunks++
			total += len(ch.GetData())
			if len(ch.GetData()) > wexec.ChunkSize {
				t.Errorf("chunk of %d bytes exceeds cap %d", len(ch.GetData()), wexec.ChunkSize)
			}
			continue
		}
		if e := f.GetEnd(); e != nil && e.GetReqId() == 4 {
			if e.GetExitCode() != 0 {
				t.Errorf("exit code = %d, want 0", e.GetExitCode())
			}
			break
		}
		if e := f.GetError(); e != nil && e.GetReqId() == 4 {
			t.Fatalf("ExecError: %s", e.GetMessage())
		}
	}
	if chunks < 2 {
		t.Errorf("chunks = %d, want >=2 for ~149 KiB of output", chunks)
	}
	if total < 100*1024 {
		t.Errorf("total output = %d bytes, want >=100 KiB", total)
	}
}

// abort mid-stream: kill an emitter after its first chunk and get a signalled End.
func TestContractAbortMidStream(t *testing.T) {
	h := newHarness(t)
	conn := h.attach(t)

	dir := t.TempDir()
	sentinel := dir + "/ticks"
	conn.SendExec(t, &pb.Exec{
		ReqId: 5,
		// Emits forever on stdout AND records ticks on disk, so the test can prove
		// the process group actually died rather than merely stopped being read.
		Command:   "while true; do echo streaming; echo tick >> " + sentinel + "; sleep 0.05; done",
		TimeoutS:  60,
		Streaming: true,
	})

	// Wait for real output before aborting, so this is genuinely mid-stream.
	first := conn.Next(t)
	if ch := first.GetChunk(); ch == nil || ch.GetReqId() != 5 {
		t.Fatalf("first frame = %+v, want a Chunk for req_id 5", first)
	}

	conn.SendAbort(t, 5)
	_, _, terminal := conn.Collect(t, 5)
	if got := terminal.GetEnd(); got == nil || got.GetExitCode() != -1 {
		t.Fatalf("terminal = %+v, want End{exit_code:-1}", terminal)
	}

	// The whole group must be gone: the sentinel stops growing.
	before := countLines(t, sentinel)
	time.Sleep(time.Second)
	if after := countLines(t, sentinel); after != before {
		t.Errorf("sentinel grew %d → %d after abort: the process group survived", before, after)
	}
}

// timeout: the worker kills its own child at timeout_s and reports the exact
// string every other harness transport rejects with (spec §4 D2).
func TestContractTimeout(t *testing.T) {
	h := newHarness(t)
	conn := h.attach(t)

	start := time.Now()
	conn.SendExec(t, &pb.Exec{ReqId: 6, Command: "sleep 30", TimeoutS: 1, Streaming: true})
	_, _, terminal := conn.Collect(t, 6)

	got := terminal.GetError()
	if got == nil {
		t.Fatalf("terminal = %+v, want ExecError", terminal)
	}
	if got.GetMessage() != "timeout:1" {
		t.Errorf("message = %q, want %q", got.GetMessage(), "timeout:1")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("took %v: the child was not killed at timeout_s", elapsed)
	}
}

// reconnect → dedup: a redelivered req_id re-emits the cached End, and the marker
// file proves the command did not run twice (spec §8).
func TestContractReconnectDedup(t *testing.T) {
	h := newHarness(t)
	first := h.attach(t)

	dir := t.TempDir()
	marker := dir + "/log"
	cmd := "echo x >> " + marker

	first.SendExec(t, &pb.Exec{ReqId: 7, Command: cmd, TimeoutS: 10, Streaming: true})
	_, _, terminal := first.Collect(t, 7)
	if e := terminal.GetError(); e != nil {
		t.Fatalf("first terminal was ExecError: %s", e.GetMessage())
	}
	if terminal.GetEnd().GetExitCode() != 0 {
		t.Fatalf("first terminal = %+v, want End{0}", terminal)
	}
	if n := countLines(t, marker); n != 1 {
		t.Fatalf("marker has %d lines after one exec, want 1", n)
	}

	// Drop the parked stream; the same Session (and cache) reattaches.
	first.Drop()
	second := h.attach(t)

	second.SendExec(t, &pb.Exec{ReqId: 7, Command: cmd, TimeoutS: 10, Streaming: true})
	_, _, redelivered := second.Collect(t, 7)
	if got := redelivered.GetEnd(); got == nil || got.GetExitCode() != 0 {
		t.Errorf("redelivered terminal = %+v, want the cached End{0}", redelivered)
	}
	// The assertion that matters: same frame is not enough, it must not have re-run.
	if n := countLines(t, marker); n != 1 {
		t.Errorf("marker has %d lines, want 1: the redelivered req_id re-ran the command", n)
	}
}

func countLines(t *testing.T, path string) int {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	return strings.Count(string(b), "\n")
}

// reconnect → dedup must not survive a LARGER timeout_s: req_id is only
// probabilistically unique per worker (spec §3.1), so a redelivery of the same id
// and command with more budget is exactly the cross-replica shape the fingerprint
// guard exists for. If
// timeout_s is not part of the fingerprint, delivery 2 below hits delivery 1's
// cache entry and is failed off it with the STALE "timeout:1" ExecError in well
// under a millisecond — never running, despite having ten times the budget it
// needed. The fingerprint must treat the two deliveries as different execs so the
// second one runs fresh.
func TestContractReconnectDedupHonorsLargerTimeout(t *testing.T) {
	h := newHarness(t)
	first := h.attach(t)

	first.SendExec(t, &pb.Exec{ReqId: 8, Command: "sleep 3", TimeoutS: 1, Streaming: true})
	_, _, terminal := first.Collect(t, 8)
	if got := terminal.GetError(); got == nil || got.GetMessage() != "timeout:1" {
		t.Fatalf("first terminal = %+v, want ExecError{\"timeout:1\"}", terminal)
	}

	// Drop the parked stream; the same Session (and cache) reattaches.
	first.Drop()
	second := h.attach(t)

	start := time.Now()
	second.SendExec(t, &pb.Exec{ReqId: 8, Command: "sleep 3", TimeoutS: 10, Streaming: true})
	_, _, redelivered := second.Collect(t, 8)
	elapsed := time.Since(start)

	if e := redelivered.GetError(); e != nil {
		t.Fatalf("redelivered terminal = ExecError{%q}, want it to run fresh and succeed: "+
			"timeout_s must be part of the fingerprint", e.GetMessage())
	}
	if got := redelivered.GetEnd(); got == nil || got.GetExitCode() != 0 {
		t.Errorf("redelivered terminal = %+v, want End{0}", redelivered)
	}
	// The assertion that matters: it must have actually RUN the 3s sleep, not
	// been answered from delivery 1's cache entry in microseconds.
	if elapsed < 2*time.Second {
		t.Errorf("redelivery answered in %v, want ~3s: it was served from the stale "+
			"timeout_s=1 cache entry instead of running fresh with its own timeout_s=10", elapsed)
	}
}

// streaming: false end to end. This is the PROTO3 DEFAULT, so any relay that
// omits the field takes this path: the worker buffers everything (up to
// exec.BufferCap per stream — the memory budget noted on that constant) and emits
// it only at child exit, still split into ChunkSize-capped Chunk frames because
// the wire cap applies regardless (spec §8). Nothing else in this file drives
// emitBuffered over a real stream.
//
// Chunk count, per-frame cap, byte-exact completeness, and the terminal frame
// (asserted below) all hold just as well for incremental streaming — none of them
// pin what actually distinguishes non-streaming: nothing leaves before the child
// exits. So the command produces its full output immediately and then sleeps
// before exiting, and the timing assertion at the bottom checks that the first
// Chunk does not arrive until close to the end of that sleep. A worker that
// ignored streaming:false and streamed incrementally would emit cat's output
// within milliseconds — long before the sleep is up — and that assertion is what
// would catch it; the margin is kept well short of the sleep so this stays robust
// on a loaded CI box without being a tight timing window.
func TestContractNonStreamingBuffersThenChunksAtExit(t *testing.T) {
	h := newHarness(t)
	conn := h.attach(t)

	dir := t.TempDir()
	path := dir + "/buffered.txt"
	var b strings.Builder
	for i := 0; i < 3000; i++ { // ~150 KiB: several chunks past the 32 KiB cap
		b.WriteString("buffered line with padding to make it wide enough\n")
	}
	want := b.String()
	if err := os.WriteFile(path, []byte(want), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// The output is written well before the process exits, so if the worker were
	// (wrongly) streaming incrementally the first Chunk would arrive almost
	// immediately after SendExec instead of after the sleep below.
	const sleepFor = 1 * time.Second

	// Streaming is deliberately left unset — the zero value is the point.
	start := time.Now()
	conn.SendExec(t, &pb.Exec{ReqId: 10, Command: "cat " + path + "; sleep 1", TimeoutS: 30})

	var chunks int
	var stdout []byte
	var firstChunkAt time.Time
	for {
		f := conn.Next(t)
		if ch := f.GetChunk(); ch != nil && ch.GetReqId() == 10 {
			if chunks == 0 {
				firstChunkAt = time.Now()
			}
			chunks++
			if n := len(ch.GetData()); n > wexec.ChunkSize {
				t.Errorf("chunk of %d bytes exceeds the per-frame cap %d", n, wexec.ChunkSize)
			}
			stdout = append(stdout, ch.GetData()...)
			continue
		}
		if e := f.GetError(); e != nil && e.GetReqId() == 10 {
			t.Fatalf("ExecError: %s", e.GetMessage())
		}
		if e := f.GetEnd(); e != nil && e.GetReqId() == 10 {
			if e.GetExitCode() != 0 {
				t.Errorf("exit code = %d, want 0", e.GetExitCode())
			}
			break
		}
	}
	if chunks < 2 {
		t.Errorf("chunks = %d, want >=2: %d KiB of buffered output was not split at the cap",
			chunks, len(want)/1024)
	}
	// Buffering must not lose or reorder anything: the bytes are the whole file.
	if len(stdout) != len(want) || string(stdout) != want {
		t.Errorf("stdout = %d bytes, want the complete %d", len(stdout), len(want))
	}
	// The assertion that actually pins non-streaming: nothing left before the
	// child exited. cat's output was ready almost immediately; the command then
	// spent sleepFor still running before its exit. If the worker held everything
	// until exit as it must, the first Chunk cannot arrive much before sleepFor
	// elapses. The margin below sleepFor is generous for a loaded CI box; it is
	// still tight enough that "streamed as produced" (near-zero latency) cannot
	// pass it.
	if elapsed := firstChunkAt.Sub(start); elapsed < sleepFor-300*time.Millisecond {
		t.Errorf("first chunk arrived after %v, want it withheld until close to the %v sleep: "+
			"streaming:false is not actually buffering until child exit", elapsed, sleepFor)
	}
}

// #173 item 2. A write travels as base64 in Exec.stdin, which inflates the payload by
// 4/3 — so an 8 MiB file (readable, since DEFAULT_OUTPUT_CAP is 8 MiB) becomes an
// ~10.7 MiB Exec, far past gRPC's 4 MiB default receive limit. The harness's read path
// can therefore fetch files this path cannot write back.
//
// THE ORDER OF THE TWO FIXES MATTERS, which is what this test guards. Raising only the
// relay's ingress limit would let the oversized ExecRequest through and move the
// rejection one hop later, onto the worker's Attach stream — and THAT kills the whole
// connection, taking every concurrent and queued exec with it. It is the failure item 2
// originally described, so fixing the relay alone would have created the bug the item
// wrongly claimed already existed. The worker's receive limit must be at least the
// relay's, and this test fails if the worker is left at the 4 MiB default.
func TestContractAcceptsAnOversizedWritePayload(t *testing.T) {
	h := newHarness(t)
	conn := h.attach(t)

	// Just past the 4 MiB default once base64-encoded, exactly as writeFile encodes it
	// (operations.ts) — the real shape of the payload, not a synthetic blob.
	content := make([]byte, 4*1024*1024)
	for i := range content {
		content[i] = byte('a' + i%26)
	}
	b64 := base64.StdEncoding.EncodeToString(content)
	if len(b64) <= 4*1024*1024 {
		t.Fatalf("payload is %d bytes, which does not cross the 4 MiB default it exists to cross", len(b64))
	}

	const reqID = 900
	conn.SendExec(t, &pb.Exec{
		ReqId:     reqID,
		Command:   "base64 -d | wc -c",
		Stdin:     []byte(b64),
		Streaming: false,
	})

	stdout, _, terminal := conn.Collect(t, reqID)
	if terminal.GetEnd() == nil || terminal.GetEnd().GetExitCode() != 0 {
		t.Fatalf("terminal = %+v, want End{exit_code:0}: the oversized Exec did not survive the stream", terminal)
	}
	// The command decodes what it received and counts the bytes, so this proves the
	// payload arrived WHOLE rather than merely that the stream stayed up.
	if got := strings.TrimSpace(string(stdout)); got != strconv.Itoa(len(content)) {
		t.Errorf("worker decoded %s bytes, want %d: the payload was truncated in transit", got, len(content))
	}
}

// Serve must RETURN when the context that created the Attach stream is cancelled:
// the shutdown path main.go depends on, where SIGTERM cancels attachCtx. Note what
// actually does the work — recvLoop has no select on ctx, so cancellation reaches
// it only by tearing the stream down. That identity between "Serve's ctx" and "the
// stream's ctx" is the precondition documented on Serve, and it is what this test
// pins: create the stream from a context nothing cancels and this hangs for its
// full 5s, which is precisely how the production shutdown hang would present.
func TestContractServeReturnsOnContextCancel(t *testing.T) {
	h := newHarness(t)
	_, cancel, served := h.attachCancellable(t)

	cancel()
	select {
	case <-served:
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return within 5s of cancelling the stream's context: shutdown hangs")
	}
}

// Spec §8's second regression pin: `workspace_key` empty ⇒ today's behaviour ON THE
// CONTAINER ARM. The new proto field is additive, so a new harness against
// remote-worker and an old harness against remote-worker must behave identically.
//
// Deliberately NOT extended to microvm-worker: "as now" there would mean one shared
// workspace for every run (spec §3.4), which is the leak this slice closes. The
// complement — an empty key REFUSED on the VM path — is pinned in vmpool.
func TestWorkspaceKeyIsIgnoredByTheContainerWorker(t *testing.T) {
	for _, tc := range []struct {
		name string
		key  string
	}{
		{"old harness: field never set", ""},
		{"new harness: field populated", "leaf-abc123"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			conn := h.attach(t)
			conn.SendExec(t, &pb.Exec{
				ReqId:        1,
				Command:      "echo hi; echo oops >&2; exit 7",
				TimeoutS:     10,
				Streaming:    true,
				WorkspaceKey: tc.key,
			})
			stdout, stderr, terminal := conn.Collect(t, 1)
			if string(stdout) != "hi\n" || string(stderr) != "oops\n" || terminal.GetEnd().GetExitCode() != 7 {
				t.Fatalf("stdout=%q stderr=%q terminal=%v — the container arm must not change behaviour with the field set",
					stdout, stderr, terminal)
			}
		})
	}
}
