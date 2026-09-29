package vmpool

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

// frameSink is a minimal wexec.Sink recorder.
type frameSink struct {
	mu      sync.Mutex
	stdout  []byte
	stderr  []byte
	dropped map[pb.Stream]int
}

func newFrameSink() *frameSink { return &frameSink{dropped: map[pb.Stream]int{}} }

func (s *frameSink) Chunk(stream pb.Stream, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if stream == pb.Stream_STREAM_STDERR {
		s.stderr = append(s.stderr, data...)
	} else {
		s.stdout = append(s.stdout, data...)
	}
	return nil
}

func (s *frameSink) Dropped(stream pb.Stream, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropped[stream] += n
}

func (s *frameSink) snap() (string, string, map[pb.Stream]int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := map[pb.Stream]int{}
	for k, v := range s.dropped {
		d[k] = v
	}
	return string(s.stdout), string(s.stderr), d
}

// The adapter must satisfy the seam BashRunner fills, or microvm-worker cannot reuse
// internal/session at all (spec §2.1).
var _ wexec.Runner = Runner{}

func TestRunnerPassesTheWorkspaceKeyAndStreamsBothStreams(t *testing.T) {
	p, lc, _ := testPool(t)
	var gotKey string
	lc.setBeforeRestore(func(r RestoreRequest) { gotKey = r.Key })
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		out.Stdout([]byte("hi\n"))
		out.Stderr([]byte("oops\n"))
		return Result{ExitCode: 7}, nil
	})

	sink := newFrameSink()
	code, err := Runner{Pool: p}.Run(context.Background(), wexec.Spec{
		ReqID: 1, Command: "echo hi", WorkspaceKey: "leaf-abc123", Streaming: true,
	}, sink)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if code != 7 {
		t.Fatalf("code = %d, want 7 — a worker reports what the command did", code)
	}
	if gotKey != "leaf-abc123" {
		t.Fatalf("RestoreRequest.Key = %q, want the Spec's WorkspaceKey", gotKey)
	}
	stdout, stderr, _ := sink.snap()
	if stdout != "hi\n" || stderr != "oops\n" {
		t.Fatalf("stdout=%q stderr=%q — the two streams must stay tagged separately", stdout, stderr)
	}
}

func TestRunnerReportsDroppedBytesPerStream(t *testing.T) {
	p, lc, _ := testPool(t)
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		return Result{ExitCode: 0, DroppedStdout: 4096, DroppedStderr: 12}, nil
	})
	sink := newFrameSink()
	r := Runner{Pool: p}
	if _, err := r.Run(context.Background(), wexec.Spec{
		ReqID: 1, Command: "yes", WorkspaceKey: "run-a",
	}, sink); err != nil {
		t.Fatalf("Run: %v", err)
	}
	_, _, dropped := sink.snap()
	// Per stream, faithfully: wexec.BufferCap is a per-stream cap and only stdout's
	// overflow is a truncation the seam can express. Collapsing them would mark a
	// whole stdout truncated for a cut stderr.
	if dropped[pb.Stream_STREAM_STDOUT] != 4096 || dropped[pb.Stream_STREAM_STDERR] != 12 {
		t.Fatalf("dropped = %v, want stdout 4096 and stderr 12", dropped)
	}
}

func TestRunnerMapsTimeoutAndAbortToTheWorkerSentinels(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		p, lc, clk := testPool(t)
		started := make(chan struct{})
		lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
			close(started)
			<-c.ctxDone
			return Result{}, context.Canceled
		})
		done := make(chan error, 1)
		go func() {
			_, err := Runner{Pool: p}.Run(context.Background(), wexec.Spec{
				ReqID: 1, Command: "sleep 99", TimeoutS: 30, WorkspaceKey: "run-a",
			}, newFrameSink())
			done <- err
		}()
		<-started
		clk.Advance(30 * time.Second)
		// Must be wexec.ErrTimeout, not vmpool's: session maps that sentinel to
		// ExecError{"timeout:<n>"}, byte-identical to every other transport (spec §4.1).
		if err := <-done; !errors.Is(err, wexec.ErrTimeout) {
			t.Fatalf("err = %v, want wexec.ErrTimeout", err)
		}
	})
	t.Run("abort", func(t *testing.T) {
		p, lc, _ := testPool(t)
		started := make(chan struct{})
		lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
			close(started)
			<-c.ctxDone
			return Result{}, context.Canceled
		})
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			_, err := Runner{Pool: p}.Run(ctx, wexec.Spec{ReqID: 1, Command: "sleep 99", WorkspaceKey: "run-a"}, newFrameSink())
			done <- err
		}()
		<-started
		cancel()
		if err := <-done; !errors.Is(err, wexec.ErrAborted) {
			t.Fatalf("err = %v, want wexec.ErrAborted", err)
		}
	})
}

func TestRunnerSurfacesARefusalAsAnError(t *testing.T) {
	p, _, _ := testPool(t)
	_, err := Runner{Pool: p}.Run(context.Background(), wexec.Spec{ReqID: 1, Command: "true", WorkspaceKey: ""}, newFrameSink())
	if err == nil {
		t.Fatal("Run accepted an empty WorkspaceKey")
	}
	// There is no "busy"/"refused" frame in the wire contract (spec §6), so a refusal
	// can only be an error — which the session turns into ExecError. The reason must
	// survive into the message so an operator can tell the ceilings apart.
	if got := ReasonOf(err); got != RefuseEmptyKey {
		t.Fatalf("ReasonOf = %q, want %q", got, RefuseEmptyKey)
	}
}
