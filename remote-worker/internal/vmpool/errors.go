package vmpool

import (
	"errors"
	"fmt"
)

// ErrTimeout means the command outlived Exec.TimeoutS and its VM was killed.
// runner.go maps it to wexec.ErrTimeout, which the session turns into
// ExecError{"timeout:<n>"} — byte-identical to what every other harness transport
// rejects with (spec §4.1).
var ErrTimeout = errors.New("vmpool: timeout")

// ErrAborted means the caller's context was cancelled: the relay's Abort, or the
// Attach stream dying. Same teardown as success — that is the point of §4.1's
// single destroy path.
var ErrAborted = errors.New("vmpool: aborted")

// ErrKeyMismatch is spec §6's "catastrophic bug" row: a popped VM whose Key() is
// not the requested one. A programming error, never retried.
var ErrKeyMismatch = errors.New("vmpool: popped VM is bound to a different workspace_key")

// ErrClosed means the pool is shutting down.
var ErrClosed = errors.New("vmpool: closed")

// ErrShortResponse means the guest closed, or the connection cut, before an explicit
// End frame arrived. Spec §5.4: "A missing or short response is an ExecError, counted
// — never coerced into a zero exit with truncated output." Firecracker documents vsock
// packet loss as expected for resumed guests, so this is a routine condition to
// report, not an impossible one to assert away.
var ErrShortResponse = errors.New("vmpool: guest closed before End")

// ErrGuest wraps a KindError the agent sent — a fork failure, an unreadable command
// file. The guest's own message is preserved, because "exec failed" without it is
// undiagnosable at 200 VMs a second.
var ErrGuest = errors.New("vmpool: guest error")

// ErrCommandTooLarge means the command, once wrapped and encoded, is larger than the
// guest's one request frame (guestagent.MaxFrame). Refused before anything is sent;
// large content goes in stdin, which is split across frames.
var ErrCommandTooLarge = errors.New("vmpool: command too large")

// ErrLeaseEnded means the Exec's lease ended under it: the lease sweep cut it at the
// grace limit (spec §4: "An Exec in flight then fails with a lease_ended(grace_limit)
// error, not a generic failure"). The error returned is a *LeaseEndedError carrying the
// reason; errors.Is matches it against this sentinel.
var ErrLeaseEnded = errors.New("vmpool: lease ended")

// LeaseEndedError is ErrLeaseEnded with the reason the lease ended.
type LeaseEndedError struct {
	Reason LeaseEndReason
}

func (e *LeaseEndedError) Error() string { return fmt.Sprintf("vmpool: lease_ended(%s)", e.Reason) }

func (e *LeaseEndedError) Unwrap() error { return ErrLeaseEnded }

// ProcessError is a tracked-process request answered with a refusal in its wire string
// (process_not_found: <id or name>, process_limit: ..., lease_unsupported: unknown kind
// ...): the guest's own, passed through from its error frame with the lease kept
// (runLease), or the host's, for a process kind with no lease to ask (answerWithoutLease).
// Error is the wire string itself, so it reaches the client unchanged.
type ProcessError struct{ Msg string }

func (e *ProcessError) Error() string { return e.Msg }

// RefusalReason names why the pool declined. Spec §6 requires a memory-driven
// refusal to be recorded DISTINCTLY from a MaxRuns refusal — "or the two ceilings
// get conflated and neither is diagnosable" — and §7.3 reports ExecErrors by cause.
type RefusalReason string

const (
	RefuseEmptyKey     RefusalReason = "empty-workspace-key"
	RefuseInvalidKey   RefusalReason = "invalid-workspace-key"
	RefuseMemoryBudget RefusalReason = "memory-budget"
	// RefuseHostMemory is #644's host backstop: the host's own MemAvailable fell
	// below the operator's floor. Kept DISTINCT from RefuseMemoryBudget for the
	// same spec §6 reason MaxRuns is: a budget refusal means SH_MAX_COMMITTED_MB
	// is sized wrong, a host-floor refusal means the host is genuinely out —
	// different knobs, and a density ladder needs to tell them apart at its
	// stopping rung.
	RefuseHostMemory    RefusalReason = "host-memory"
	RefuseMaxRuns       RefusalReason = "max-runs"
	RefuseSpawn         RefusalReason = "spawn-failure"
	RefuseShortResponse RefusalReason = "vsock-short-response"
	// RefuseStaleMode is spec §8.2's stale_mode: an Exec (or SetMode) whose mode_epoch
	// is below the one stored for the key, so a token minted before a downgrade cannot
	// keep its higher mode.
	RefuseStaleMode RefusalReason = "stale-mode"
	// RefuseLeaseUnsupported is a lease-mode request on a worker that cannot serve
	// one: not the Firecracker arm, or a snapshot without lease-v1.
	RefuseLeaseUnsupported RefusalReason = "lease-unsupported"
	// RefuseProcessesNotEnabled is a tracked-process kind at a served mode below
	// lease+processes (spec §7): processes_not_enabled on the wire.
	RefuseProcessesNotEnabled RefusalReason = "processes-not-enabled"
)

// RefusalError carries a reason to microvm-worker, which counts it and returns an
// ExecError. There is no "busy" frame in the wire contract (spec §6), so a refusal
// can only be an error — which is exactly why the lease cap one tier up is primary
// admission control and MaxRuns is a backstop.
type RefusalError struct {
	Reason RefusalReason
	Detail string
}

func (e *RefusalError) Error() string { return fmt.Sprintf("%s: %s", e.Reason, e.Detail) }

// Unwrap lets errors.Is see ErrShortResponse through the RefusalError wrapper, so
// callers can match on the sentinel while operators still get the counted reason via
// ReasonOf.
func (e *RefusalError) Unwrap() error {
	if e.Reason == RefuseShortResponse {
		return ErrShortResponse
	}
	return nil
}

func refusal(r RefusalReason, format string, a ...any) *RefusalError {
	return &RefusalError{Reason: r, Detail: fmt.Sprintf(format, a...)}
}

// ReasonOf returns the RefusalReason in err, or "" if err is not a refusal.
func ReasonOf(err error) RefusalReason {
	var re *RefusalError
	if errors.As(err, &re) {
		return re.Reason
	}
	return ""
}

// ColdCause attributes a cold acquire. Spec §4.4: cold acquires must be attributed
// by cause, "otherwise a gate-heavy or checkpoint-heavy workload reads as
// replenishment falling behind when nothing is behind."
type ColdCause string

const (
	ColdFirstExec ColdCause = "first-exec" // an unseen workspace_key
	ColdParked    ColdCause = "parked"     // StandbyIdle had dropped this run's standbys
	ColdExhausted ColdCause = "exhausted"  // replenishment behind the Exec rate — the real signal
)
