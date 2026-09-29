package vmpool

import (
	"context"
	"errors"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

// Runner adapts a Pool to internal/session's wexec.Runner seam — the same seam
// BashRunner fills. That is the structural form of spec §2.1's claim: replacing the
// `bash -c` body with "acquire standby VM -> push command over vsock -> collect ->
// destroy" needs no new SandboxTransport and owes no new entry in the shared
// conformance battery. Everything session owns — Hello, heartbeats, the dispatch
// pool, req_id dedup, frame emission, the Abort wiring — is reused untouched.
type Runner struct{ Pool Pool }

func (r Runner) Run(ctx context.Context, s wexec.Spec, sink wexec.Sink) (int32, error) {
	// ExecPhased, not Exec: Exec delegates to it with a throwaway Phases, so this costs
	// nothing extra and makes the relayed path report the same decomposition vmpoolctl
	// already gets. Without it the worker's hot path was unmeasurable (see diag.go).
	var ph Phases
	res, err := r.Pool.ExecPhased(ctx, s.WorkspaceKey, Exec{
		ReqID:     s.ReqID,
		Command:   s.Command,
		Stdin:     s.Stdin,
		TimeoutS:  s.TimeoutS,
		Streaming: s.Streaming,
	}, &sinkAdapter{sink: sink}, &ph)
	logPhases(&ph)

	// Report dropped bytes even on a failure path: an aborted exec still delivered
	// whatever the guest had already sent, and declaring that untruncated is a false
	// answer to the one question the harness cannot work out for itself.
	if res.DroppedStdout > 0 {
		sink.Dropped(pb.Stream_STREAM_STDOUT, int(res.DroppedStdout))
	}
	if res.DroppedStderr > 0 {
		sink.Dropped(pb.Stream_STREAM_STDERR, int(res.DroppedStderr))
	}

	switch {
	case err == nil:
		return res.ExitCode, nil
	case errors.Is(err, ErrTimeout):
		// The session formats "timeout:<n>" from the Exec's own TimeoutS, so only the
		// sentinel has to survive the boundary.
		return 0, wexec.ErrTimeout
	case errors.Is(err, ErrAborted):
		return 0, wexec.ErrAborted
	default:
		// Refusals, key mismatches and spawn failures all become ExecError. They stay
		// distinguishable in the message and are already counted in Stats, which is
		// what spec §7.3's "ExecErrors by cause" row reads.
		return 0, err
	}
}

// sinkAdapter bridges vmpool.Sink to wexec.Sink.
//
// Chunk's error is deliberately discarded. The session's frameSink returns one only
// when its outbound channel is already gone — the exec is lost either way — and
// vmpool.Sink has no channel to report it on. Plumbing it back would let a dead relay
// stream tear down a VM halfway through a command and leave the workspace
// half-written, which is worse than losing frames nobody can receive.
type sinkAdapter struct{ sink wexec.Sink }

func (a *sinkAdapter) Stdout(b []byte) { _ = a.sink.Chunk(pb.Stream_STREAM_STDOUT, b) }

func (a *sinkAdapter) Stderr(b []byte) { _ = a.sink.Chunk(pb.Stream_STREAM_STDERR, b) }
