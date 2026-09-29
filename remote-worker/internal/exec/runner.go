// Package exec runs one sandbox command per call: a `bash -c` child whose
// stdout and stderr stream back as capped Chunk payloads. It holds no
// credentials, makes no network calls, and knows nothing about the relay — the
// property that makes the "central brain" trust model correct (spec §7).
package exec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

// ChunkSize caps one Chunk frame's payload. It is also the pipe read size, so
// backpressure costs no extra buffering layer (spec §8).
const ChunkSize = 32 * 1024

// BufferCap bounds buffered output for non-streaming execs, matching the
// harness's DEFAULT_OUTPUT_CAP (transport.ts). It applies to stdout and stderr
// SEPARATELY — see the memory budget below. Output past it is dropped, and every
// dropped byte is reported to the Sink, tagged with its stream, so the session can
// set End.truncated for the stream the seam actually returns (stdout; the caller
// decides, not this package). The harness CANNOT infer it: its cap is this same 8 MiB and
// trips on `bytes > cap`, strictly greater, so a worker that delivers exactly
// BufferCap resolves as {truncated: false, exitCode: <real code>} over cut
// output. This comment previously claimed "the harness applies its own cap and
// truncation marker anyway"; the equality of the two caps is precisely what
// made that false (#189).
//
// MEMORY BUDGET — this is a PER-STREAM cap, so it sets the worker's worst-case
// resident size:
//
//	2 streams (stdout+stderr) × session.MaxConcurrent × BufferCap
//	= 2 × 4 × 8 MiB = 64 MiB at the default concurrency
//
// plus ~1.5-2x transiently while each bytes.Buffer doubles. Nothing the worker
// controls gates it: Exec.streaming is relay-supplied and false is the proto3
// default, so a buggy or hostile relay reaches this with no privilege at all.
// worker-deployment.yaml's memory limit MUST cover the product above — change
// either side and change the other.
const BufferCap = 8 * 1024 * 1024

// drainGrace is how long the drain watchdog waits for the pumps to go QUIET,
// after runCtx ends, before force-closing the pipe readers itself. Wait only
// closes those readers from inside itself once every *Pipe() read has finished,
// so a grandchild that escapes the process group (setsid) or outlives it
// (TimeoutS == 0) would otherwise wedge the pumps — and Run — forever
// (go.dev/issue/23019: the os/exec Cancel/WaitDelay mitigation explicitly
// excludes *Pipe() users).
//
// It is a QUIET period, not a wall clock: a drain still producing bytes is left
// alone. A wall-clock grace cannot tell a wedged drain from a slow one, so it
// force-closed a pump that was still delivering legitimate trailing output
// (#173 item 6).
//
// TEARDOWN LATENCY, precisely: progress is SAMPLED when this timer expires, not
// observed as each read happens, so the timer is re-armed at expiry if any bytes
// arrived during the window that just ended. The force-close therefore lands
// between 1x and 2x drainGrace after the last byte — up to ~4s, not 2s. Sampling
// is deliberate (it costs one atomic load per window rather than a wakeup per
// read) and only the bound matters, but read the bound as 2x.
const drainGrace = 2 * time.Second

// drainCeiling caps the total force-close delay however much progress the pumps
// keep making. Without it, a holder trickling one byte every second past
// drainGrace resets the grace forever and pins both a pool slot (1 of
// session.MaxConcurrent) and up to BufferCap of buffer — a slower version of
// exactly the wedge the watchdog exists to prevent. 15× the grace is far longer
// than any legitimate trailing flush and negligible beside the harness's own
// 30-minute exec ceiling, by which point the run is long out of budget anyway.
const drainCeiling = 30 * time.Second

// ErrTimeout means the child outlived Spec.TimeoutS and its process group was
// SIGKILLed. The session maps it to ExecError{"timeout:<n>"} — byte-identical to
// what every other harness transport rejects with (spec §4 D2).
var ErrTimeout = errors.New("timeout")

// ErrAborted means the caller's context was cancelled: an Abort frame, or the
// stream dying. The session maps it to End{exit_code:-1} (signal/none).
var ErrAborted = errors.New("aborted")

// Spec is one command to run. It mirrors pb.Exec minus the wire types, so the
// runner has no dependency on frame plumbing.
type Spec struct {
	ReqID     uint64
	Command   string
	Stdin     []byte
	TimeoutS  uint32
	Streaming bool
	// WorkspaceKey is Exec.workspace_key: the lease's run id. BashRunner IGNORES it —
	// on the container path an empty key means today's single shared workspace, which
	// is what makes the proto field additive (spec §3.4). vmpool.Runner keys a per-run
	// host-side workspace on it and refuses an empty one.
	WorkspaceKey string
}

// Sink receives output as it is produced. data is owned by the callee. Chunk is
// never called concurrently: Run drains stdout and stderr on separate
// goroutines but serializes all calls to the caller's Sink through a single
// lock, so implementations need not synchronize internally.
//
// Chunk must also never be called AFTER Run has returned. Implementations are
// entitled to tear their destination down when Run ends — the session's
// frameSink writes to a channel Serve closes, so a late Chunk would panic the
// process rather than return an error. BashRunner honors this: both pumps have
// finished (wg.Wait) and the non-streaming emission has completed before any
// return path.
//
// Dropped reports bytes the runner threw away at BufferCap, before any of them
// reached Chunk. stream is significant, not decoration: the two buffers are capped
// independently, and only stdout's overflow is a truncation the harness seam can
// express, so a Sink that ignores the stream will mark a whole stdout as truncated
// for a cut stderr. Report faithfully here and let the Sink decide.
//
// It is REQUIRED rather than an optional extension for the same
// reason `truncated` is required on the harness seam (transport.ts): an optional
// report lets a Sink omit it and read as "nothing dropped", which is the exact
// silence #189 is about, one layer down. Required, a Sink that forgets it is a
// compile error.
//
// It returns nothing: the count is a report about output already lost, not a
// delivery that can fail, and a Sink has no way to un-drop it. Called under the
// same serialization as Chunk, so implementations need not synchronize; both
// pumps can drop concurrently.
type Sink interface {
	Chunk(stream pb.Stream, data []byte) error
	Dropped(stream pb.Stream, n int)
}

// lockedSink serializes Chunk calls. Run drains stdout and stderr in two
// goroutines, and the runner owns the concurrency it creates rather than
// pushing a thread-safety requirement onto every Sink implementation.
type lockedSink struct {
	mu    sync.Mutex
	inner Sink
}

func (l *lockedSink) Chunk(stream pb.Stream, data []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.inner.Chunk(stream, data)
}

func (l *lockedSink) Dropped(stream pb.Stream, n int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.inner.Dropped(stream, n)
}

// Runner runs one command. ctx cancellation means Abort: kill the process group.
type Runner interface {
	Run(ctx context.Context, s Spec, sink Sink) (int32, error)
}

// BashRunner is the real Runner: `bash -c <command>` per exec, no persistent
// shell. Every command the harness sends is self-contained (`cd 'cwd' && …`), and
// decisively, `base64 -d > f` only terminates on stdin EOF — which a shared
// long-lived shell cannot deliver per-exec (spec §4 D1).
type BashRunner struct{}

func (BashRunner) Run(ctx context.Context, s Spec, sink Sink) (int32, error) {
	// Refuse before spawning anything on a platform that cannot isolate the child
	// in its own process group: abort and timeout would then leave grandchildren
	// running, which is not a degraded mode worth offering (#173 item 8). Always
	// nil on unix.
	if err := platformSupported(); err != nil {
		return -1, err
	}
	// One lock serializes every call to the caller's Sink: the two pump
	// goroutines below (and the non-streaming emission at exit) must not race
	// on it.
	sink = &lockedSink{inner: sink}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if s.TimeoutS > 0 {
		var stop context.CancelFunc
		runCtx, stop = context.WithTimeout(runCtx, time.Duration(s.TimeoutS)*time.Second)
		defer stop()
	}

	cmd := exec.CommandContext(runCtx, "bash", "-c", s.Command)
	// Setpgid + killing -pid takes out the whole group. CommandContext's default
	// signals only the direct bash, but real commands are pipelines with
	// grandchildren (`cd 'x' && rg --files … | head -n 200`), which would
	// otherwise survive an abort or timeout. Both halves live in
	// runner_unix.go, behind a build constraint (#173 item 8).
	isolateProcessGroup(cmd)
	// Best-effort: send the kill, but always report os.ErrProcessDone. Per
	// exec.Cmd.Cancel's doc, if the child happens to have already exited with a
	// success status by the time Cancel runs — exactly the race this fixes,
	// since the drain (and thus our call to cmd.Wait) can run well after the
	// child's own exit when a sink is slow — any other return value makes Wait
	// report a synthetic ctx/Cancel error instead of the real (successful) exit
	// status. A child actually still alive exits with a non-success (signalled)
	// status when the kill lands, and that path is untouched by Cancel's return
	// value, so reporting ErrProcessDone unconditionally is safe either way.
	cmd.Cancel = func() error {
		_ = killProcessGroup(cmd.Process.Pid)
		return os.ErrProcessDone
	}
	// WaitDelay bounds only Wait's own internal I/O cleanup after the process
	// exits or is killed; it does NOT bound reads from the *Pipe() readers
	// below, since those are closed by Wait itself only after all reads from
	// them finish (go.dev/issue/23019 — the *Pipe() case is explicitly excluded
	// from this mitigation). The drain watchdog started below is what actually
	// bounds the pumps.
	cmd.WaitDelay = 2 * time.Second

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return -1, fmt.Errorf("stdin pipe: %w", err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return -1, fmt.Errorf("stdout pipe: %w", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return -1, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return -1, fmt.Errorf("start bash: %w", err)
	}

	// stdin ALWAYS closes. `base64 -d > f` waits for EOF, and a command given no
	// stdin must still see EOF or anything reading it blocks forever.
	go func() {
		if len(s.Stdin) > 0 {
			_, _ = stdinPipe.Write(s.Stdin)
		}
		_ = stdinPipe.Close()
	}()

	var (
		mu      sync.Mutex
		sinkErr error
		outBuf  bytes.Buffer
		errBuf  bytes.Buffer
		wg      sync.WaitGroup
		// reads counts reads that returned bytes, across both pumps. It is the
		// watchdog's only evidence that a drain is progressing rather than wedged.
		reads atomic.Uint64
	)
	pump := func(r io.Reader, which pb.Stream, buf *bytes.Buffer) {
		defer wg.Done()
		if err := drain(r, which, s, sink, buf, &reads); err != nil {
			mu.Lock()
			if sinkErr == nil {
				sinkErr = err
			}
			mu.Unlock()
			cancel() // the stream is gone; stop the child rather than keep reading
		}
	}
	wg.Add(2)
	go pump(stdoutPipe, pb.Stream_STREAM_STDOUT, &outBuf)
	go pump(stderrPipe, pb.Stream_STREAM_STDERR, &errBuf)

	// Drain watchdog: once runCtx ends (Abort or timeout), force-close the pipe
	// readers ourselves if the pumps go quiet, so a pump wedged on a Read from a
	// pipe holder that escaped or outlived the process group returns instead of
	// blocking forever. A forced close surfaces as a read error, which drain
	// already swallows, so it is indistinguishable from EOF here. watchdogDone is
	// closed on every return path so a healthy exec never waits for nothing.
	watchdogDone := make(chan struct{})
	defer close(watchdogDone)
	go watchDrain(runCtx, watchdogDone, &reads, drainGrace, drainCeiling, stdoutPipe, stderrPipe)

	// StdoutPipe's contract: Wait closes the pipes, so all reads must finish first.
	wg.Wait()
	waitErr := cmd.Wait()

	if sinkErr != nil {
		return -1, sinkErr
	}
	// Non-streaming means no incremental delivery — nothing leaves before the
	// process exits — not "exactly one frame": the buffered output still has
	// to respect ChunkSize, the wire's per-frame cap (spec §8), so it goes out
	// in slices at exit rather than as one BufferCap-sized Chunk.
	if !s.Streaming {
		if err := emitBuffered(sink, pb.Stream_STREAM_STDOUT, &outBuf); err != nil {
			return -1, err
		}
		if err := emitBuffered(sink, pb.Stream_STREAM_STDERR, &errBuf); err != nil {
			return -1, err
		}
	}

	// A clean exit, or any *exec.ExitError with a non-negative code, proves the
	// child was not SIGKILLed — even if runCtx ended while the pumps were still
	// delivering to a slow sink. That must outrank ctx state, or a command that
	// finished successfully just before the deadline could be misreported as a
	// timeout. ctx state only decides the outcome when the exit was a signal
	// (ExitCode() == -1) or waitErr isn't an ExitError at all.
	var exitErr *exec.ExitError
	hasExitErr := errors.As(waitErr, &exitErr)
	switch {
	case waitErr == nil:
		return 0, nil
	case hasExitErr && exitErr.ExitCode() >= 0:
		return int32(exitErr.ExitCode()), nil
	case errors.Is(runCtx.Err(), context.DeadlineExceeded):
		return -1, ErrTimeout
	case runCtx.Err() != nil:
		return -1, ErrAborted
	case hasExitErr:
		// ExitCode() is -1 when signalled, which is exactly End's "signal/none".
		return int32(exitErr.ExitCode()), nil
	}
	return -1, fmt.Errorf("wait: %w", waitErr)
}

// emitBuffered sends buf's contents as one or more ChunkSize-capped Chunks.
// Called only from the non-streaming exit path, after the process has
// already finished, so slicing buf.Bytes() directly (no copy) is safe: buf is
// never written to again.
func emitBuffered(sink Sink, which pb.Stream, buf *bytes.Buffer) error {
	data := buf.Bytes()
	for len(data) > 0 {
		n := min(len(data), ChunkSize)
		if err := sink.Chunk(which, data[:n]); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

// watchDrain force-closes closers once runCtx has ended AND the pumps have been
// quiet for grace — or unconditionally once ceiling has passed, whichever comes
// first. It returns as soon as done is closed, so a healthy exec pays nothing.
//
// reads is the liveness signal: any change means a pump got bytes since the last
// check, so the drain is slow rather than wedged and force-closing it now would
// throw away output the command really produced (#173 item 6). The ceiling is
// what stops that reasoning from running forever — see drainCeiling.
//
// It is a package-level function rather than a closure inside Run so the two
// behaviours can be tested directly, at millisecond timings, without a child
// process: the end-to-end case needs a pipe holder outside the process group,
// which is awkward on some platforms and slow on all of them.
func watchDrain(
	runCtx context.Context,
	done <-chan struct{},
	reads *atomic.Uint64,
	grace, ceiling time.Duration,
	closers ...io.Closer,
) {
	select {
	case <-runCtx.Done():
	case <-done:
		return // the exec finished on its own; nothing to bound
	}

	hard := time.NewTimer(ceiling)
	defer hard.Stop()
	quiet := time.NewTimer(grace)
	defer quiet.Stop()
	// Snapshot AFTER runCtx ended: only reads from here on count as progress.
	last := reads.Load()
	for {
		select {
		case <-done:
			return
		case <-hard.C:
			// Progress or not, this has held a pool slot long enough.
		case <-quiet.C:
			if cur := reads.Load(); cur != last {
				last = cur
				quiet.Reset(grace)
				continue
			}
		}
		for _, c := range closers {
			_ = c.Close()
		}
		return
	}
}

// drain reads one pipe to exhaustion. Only SINK errors are returned: once the
// process group is killed the pipes close, and surfacing that read error would
// mask ErrTimeout and suppress the terminal frame the session owes the harness.
//
// reads is bumped on every read that yields bytes, which is what lets watchDrain
// tell a slow drain from a wedged one. It is bumped BEFORE delivery, so the
// record is of when the pipe produced the bytes rather than when the sink
// finished accepting them.
func drain(r io.Reader, which pb.Stream, s Spec, sink Sink, buf *bytes.Buffer, reads *atomic.Uint64) error {
	b := make([]byte, ChunkSize)
	for {
		n, err := r.Read(b)
		if n > 0 {
			reads.Add(1)
			if s.Streaming {
				// Copy: the payload becomes a proto field the sink may retain.
				if err := sink.Chunk(which, append([]byte(nil), b[:n]...)); err != nil {
					return err
				}
			} else {
				// Buffer what fits and REPORT the rest. max() guards the already-full
				// case, where room is negative-or-zero and every byte of this read is
				// lost. Reporting is what makes the loss visible to the harness at all
				// (#189) — see BufferCap on why it cannot infer it.
				kept := min(n, max(BufferCap-buf.Len(), 0))
				if kept > 0 {
					buf.Write(b[:kept])
				}
				if kept < n {
					sink.Dropped(which, n-kept)
				}
			}
		}
		if err != nil {
			return nil // EOF, or pipes closed by the kill: nothing more to read
		}
	}
}
