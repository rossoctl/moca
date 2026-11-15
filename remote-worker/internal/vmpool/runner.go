package vmpool

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

// Runner adapts a Pool to internal/session's wexec.Runner seam — the same seam
// BashRunner fills. That is the structural form of spec §2.1's claim: replacing the
// `bash -c` body with "acquire standby VM -> push command over vsock -> collect ->
// destroy" needs no new SandboxTransport and owes no new entry in the shared
// conformance battery. Everything session owns — Hello, heartbeats, the dispatch
// pool, req_id dedup, frame emission, the Abort wiring — is reused untouched.
type Runner struct {
	Pool Pool
	// Timing logs one `exec-timing` line per Exec (diag.go logExecTiming): the container
	// worker's per-Exec line, plus the VM phases and the VM's CPU. cmd/microvm-worker sets it
	// from SH_EXEC_TIMING=1; off by default.
	Timing bool
}

// execLog is the per-Exec audit line: which workspace (the session id), which kind and which VM. Always on --
// it is the evidence that a session's commands ran in microVMs (#369) -- and deliberately without
// the command, which can carry secrets. A variable so tests can capture it.
var execLog = log.Printf

func (r Runner) Run(ctx context.Context, s wexec.Spec, sink wexec.Sink) (int32, error) {
	var (
		ph  Phases
		res Result
	)
	start := time.Now()
	mode, err := specMode(s)
	kind, kerr := specKind(s)
	if err == nil {
		err = kerr
	}
	e := Exec{
		ReqID:       s.ReqID,
		Command:     s.Command,
		Stdin:       s.Stdin,
		TimeoutS:    s.TimeoutS,
		Streaming:   s.Streaming,
		Mode:        mode,
		ModeEpoch:   s.ModeEpoch,
		IdleTimeout: time.Duration(s.IdleTimeoutS) * time.Second,
		Keepalive:   s.Keepalive,
		Kind:        kind,
		Process: ProcessArgs{
			Name: s.Process.Name, ID: s.Process.ID, Cwd: s.Process.Cwd,
			Tail: int(s.Process.Tail), Signal: s.Process.Signal,
		},
	}
	if err == nil {
		// ExecPhased, not Exec: Exec delegates to it with a throwaway Phases, so this costs
		// nothing extra and makes the relayed path report the same decomposition vmpoolctl
		// already gets. Without it the worker's hot path was unmeasurable (see diag.go).
		res, err = r.Pool.ExecPhased(ctx, s.WorkspaceKey, e, &sinkAdapter{sink: sink}, &ph)
	}
	logPhases(&ph)
	if r.Timing {
		logExecTiming(s.ReqID, s.WorkspaceKey, start, time.Since(start), &ph, res.ExitCode, err)
	}
	logKind := e.Kind.String()
	if kerr != nil {
		logKind = s.Kind // an unknown kind is logged as the session spelled it, never as a command
	}
	execLog("vmpool: exec req=%d workspace_key=%q kind=%s vm=%s cold=%q exit=%d err=%v",
		s.ReqID, s.WorkspaceKey, logKind, ph.VMID, string(ph.Cold), res.ExitCode, err)

	// Report dropped bytes even on a failure path: an aborted exec still delivered
	// whatever the guest had already sent, and declaring that untruncated is a false
	// answer to the one question the harness cannot work out for itself.
	if res.DroppedStdout > 0 {
		sink.Dropped(pb.Stream_STREAM_STDOUT, int(res.DroppedStdout))
	}
	if res.DroppedStderr > 0 {
		sink.Dropped(pb.Stream_STREAM_STDERR, int(res.DroppedStderr))
	}

	// Lease events ride before the result, and before an error too (stale_mode,
	// lease_ended, a timeout): the client learns the lease ended even when this Exec failed.
	// Not for an unknown kind: its refusal is answered before any lease work, so a pending
	// event stays pending for the next Exec.
	if mode != ModePerExec && kerr == nil {
		r.deliverLeaseEvents(s.WorkspaceKey, sink, res.ProcessesStopped)
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
		// distinguishable in the message. The pool's refusals are already counted in
		// Stats, which is what spec §7.3's "ExecErrors by cause" row reads; the two
		// refusals built here, specMode's and specKind's lease_unsupported for a mode or a
		// kind this worker does not know, never reached the pool and are not. The lease
		// errors take their wire strings (wireError).
		return 0, wireError(err)
	}
}

// specMode is the Spec's mode as the pool's: "" is per-exec, and a string vmpool cannot
// name -- the session's "unknown(<n>)" for an enum this worker does not know -- is refused
// lease_unsupported, never read as per-exec.
func specMode(s wexec.Spec) (Mode, error) {
	if s.Mode == "" {
		return ModePerExec, nil
	}
	m, err := ParseMode(s.Mode)
	if err != nil {
		return ModePerExec, refusal(RefuseLeaseUnsupported, "Exec for %q: %v", s.WorkspaceKey, err)
	}
	return m, nil
}

// specKind is the Spec's kind as the pool's (ruling P5-R22). Only the command and the four
// process kinds map: the session's "unknown(<n>)" and any other name -- the host-only
// process_stop_all above all, which no Exec may carry -- are refused lease_unsupported
// before any VM or lease work, never run as a command.
func specKind(s wexec.Spec) (ExecKind, error) {
	switch s.Kind {
	case wexec.KindCommand:
		return ExecKindCommand, nil
	case wexec.KindProcessStart:
		return ExecKindProcessStart, nil
	case wexec.KindProcessList:
		return ExecKindProcessList, nil
	case wexec.KindProcessLogs:
		return ExecKindProcessLogs, nil
	case wexec.KindProcessStop:
		return ExecKindProcessStop, nil
	}
	detail, ok := wexec.UnknownKind(s.Kind)
	if !ok {
		detail = fmt.Sprintf("exec kind %q not supported by this runner", s.Kind)
	}
	return ExecKindCommand, refusal(RefuseLeaseUnsupported, "%s", detail)
}

// deliverLeaseEvents reports key's lease on the Exec's response, through the session's
// wexec.LeaseSink: the pending event, acknowledged only once the sink has queued it (an
// event not queued stays pending, so the next Exec carries it), and an "expiring" notice
// while the lease is past its maximum duration: reason max_duration, at_unix_ms when it
// passed it, ends_by_unix_ms that plus the grace limit (LeaseExpiry). Between the two goes
// stopped, the Exec's own processes_stopped notice, if any (Result.ProcessesStopped):
// never acknowledged nor stored, it displaces no pending event (ruling P5-R19). Called for
// an Exec whose mode is not per-exec only: a client that never asked for a lease never
// sees an event.
func (r Runner) deliverLeaseEvents(key string, sink wexec.Sink, stopped *LeaseEvent) {
	ls, ok := sink.(wexec.LeaseSink)
	if !ok {
		return
	}
	info := r.Pool.LeaseStatus(key)
	if ev := info.Pending; ev != nil {
		if err := ls.Lease(leaseEventProto(ev)); err == nil {
			r.Pool.AckLeaseEvent(key, ev.At)
		}
	}
	if stopped != nil {
		_ = ls.Lease(leaseEventProto(stopped))
	}
	if x := info.Expiry; x != nil {
		// Never acknowledged: it rides on every lease Exec while the lease is expiring.
		_ = ls.Lease(&pb.LeaseEvent{
			State:        LeaseExpiring,
			Reason:       string(LeaseEndMaxDuration),
			AtUnixMs:     x.Since.UnixMilli(),
			Mode:         x.Mode.Proto(),
			AgeMs:        uint64(max(info.Age.Milliseconds(), 0)),
			EndsByUnixMs: x.EndsBy.UnixMilli(),
		})
	}
}

// wireError gives the lease errors their wire strings (spec §4, §7, §8.2), which a client
// matches on: lease_ended(<reason>), stale_mode: <detail>, lease_unsupported: <detail> and
// processes_not_enabled: <detail>. Every other error is returned unchanged, a
// ProcessError included: its text is already the wire string.
func wireError(err error) error {
	var le *LeaseEndedError
	if errors.As(err, &le) {
		return fmt.Errorf("lease_ended(%s)", le.Reason)
	}
	var re *RefusalError
	if errors.As(err, &re) {
		switch re.Reason {
		case RefuseStaleMode:
			return fmt.Errorf("stale_mode: %s", re.Detail)
		case RefuseLeaseUnsupported:
			return fmt.Errorf("lease_unsupported: %s", re.Detail)
		case RefuseProcessesNotEnabled:
			return fmt.Errorf("processes_not_enabled: %s", re.Detail)
		}
	}
	return err
}

// LeaseControl answers the relay's LeaseControl frame (session.LeaseController): status
// reads the lease, reset and sandbox_deleted end it with that reason (neither takes a mode
// or an epoch), set_mode applies a verified mode change; each returns the status after the
// op. Reset, sandbox_deleted and a set_mode downgrade BLOCK until the lease has ended, or
// for lease+processes -> lease until its tracked processes have stopped (up to
// LeaseGraceLimit); the session runs this off its receive loop. A set_mode's status lists
// what its downgrade stopped in stopped, in that answer only (ruling P5-R19). ctx is
// ignored: the Pool's lease calls take none, so an op runs to completion once started.
func (r Runner) LeaseControl(_ context.Context, key string, op pb.LeaseOp, mode pb.SandboxMode, epoch uint64) (*pb.LeaseStatus, error) {
	var stopped []TrackedProcess
	switch op {
	case pb.LeaseOp_LEASE_OP_STATUS:
	case pb.LeaseOp_LEASE_OP_RESET:
		if err := r.Pool.EndLease(key, LeaseEndReset); err != nil {
			return nil, wireError(err)
		}
	case pb.LeaseOp_LEASE_OP_SANDBOX_DELETED:
		if err := r.Pool.EndLease(key, LeaseEndSandboxDeleted); err != nil {
			return nil, wireError(err)
		}
	case pb.LeaseOp_LEASE_OP_SET_MODE:
		m, err := ModeFromProto(mode)
		if err != nil {
			return nil, wireError(refusal(RefuseLeaseUnsupported, "SetMode for %q: %v", key, err))
		}
		if stopped, err = r.Pool.SetMode(key, m, epoch); err != nil {
			return nil, wireError(err)
		}
	default:
		return nil, fmt.Errorf("vmpool: unknown lease op %s", op)
	}
	info := r.Pool.LeaseStatus(key)
	st := leaseStatusProto(info)
	st.Stopped = trackedProto(stopped, info.At)
	return st, nil
}

// LeaseKeepalive records a keepalive for key's live lease (session.LeaseController). It
// only takes the pool lock, so it is safe on the session's receive loop. Its only errors
// are an invalid key and a closed pool, neither of which a keepalive can act on.
func (r Runner) LeaseKeepalive(key string) { _ = r.Pool.Keepalive(key) }

// leaseEventProto is ev on the wire. The tracked processes' ages are at the event (ev.At):
// what they had run for when the lease ended.
func leaseEventProto(ev *LeaseEvent) *pb.LeaseEvent {
	return &pb.LeaseEvent{
		State:     ev.State,
		Reason:    string(ev.Reason),
		AtUnixMs:  ev.At.UnixMilli(),
		Mode:      ev.Mode.Proto(),
		AgeMs:     uint64(max(ev.Age.Milliseconds(), 0)),
		Processes: ev.Processes,
		Tracked:   trackedProto(ev.Tracked, ev.At),
	}
}

// leaseStatusProto is info on the wire: processes is the live lease's full tracked table,
// exited entries included, aged at info.At. stopped stays empty here: LeaseControl fills
// it for a set_mode whose downgrade stopped processes.
func leaseStatusProto(info LeaseInfo) *pb.LeaseStatus {
	st := &pb.LeaseStatus{
		Mode:         info.Mode.Proto(),
		EpochKnown:   info.EpochKnown,
		State:        info.State,
		AgeMs:        uint64(max(info.Age.Milliseconds(), 0)),
		IdleTimeoutS: uint32(info.IdleTimeout / time.Second),
		Processes:    trackedProto(info.Tracked, info.At),
	}
	if info.Pending != nil {
		st.Pending = leaseEventProto(info.Pending)
	}
	return st
}

// trackedProto is ps on the wire, each process aged at at (0 for a start after it, as the
// guest's clock may run a little ahead of the host's). nil for none.
func trackedProto(ps []TrackedProcess, at time.Time) []*pb.TrackedProcess {
	if len(ps) == 0 {
		return nil
	}
	out := make([]*pb.TrackedProcess, len(ps))
	for i, tp := range ps {
		out[i] = &pb.TrackedProcess{
			Id:          tp.ID,
			Name:        tp.DisplayName(),
			Pid:         uint32(max(tp.PID, 0)),
			State:       tp.State,
			Code:        int32(tp.Code),
			AgeMs:       uint64(max(at.Sub(tp.Started).Milliseconds(), 0)),
			MemoryBytes: uint64(max(tp.MemoryBytes, 0)),
		}
	}
	return out
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
