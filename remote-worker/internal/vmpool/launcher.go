package vmpool

import (
	"context"
	"os"
)

// EgressBinder hands a VM's guest-egress listening socket to moca-egress (MI1 §8.3).
// sessionID is RestoreRequest.Key; grant is nil in P4.1. Register must dup ln (the
// caller keeps ownership of its descriptor).
type EgressBinder interface {
	Register(ctx context.Context, vmID, sessionID string, grant []byte, ln *os.File) error
	Unregister(ctx context.Context, vmID string) error
}

// OutputCapBytes bounds stdout and stderr independently, and is PINNED to
// wexec.BufferCap and hence to the harness's DEFAULT_OUTPUT_CAP. Spec §4.1 is
// explicit that this path declares no new truncation mechanism: from the harness's
// view it is still GrpcRelayTransport/remote-abort. outputcap_test.go enforces the
// pin.
const OutputCapBytes = 8 << 20

// RestoreRequest is one VM's creation parameters, filled during REPLENISHMENT and
// therefore off the hot path — which spec §4.3 calls the entire trick. Because the
// workspace is bound before any Exec asks for it, a VM is bound to one workspace
// and pools are per-run rather than global.
type RestoreRequest struct {
	ID            string // per-VM id; names the jail directory and the cgroup
	Key           string // workspace_key this VM is bound to; VM.Key() returns it
	WorkspaceDir  string // host directory bound at the guest's fixed /workspace
	GuestRAMBytes int64
}

// Command is one command to run in one VM.
type Command struct {
	Command   string
	Stdin     []byte
	TimeoutS  uint32
	Streaming bool
	// CapBytes bounds each stream. Applied in the GUEST, so 8 MiB is never moved
	// across vsock and then discarded (spec §4.1).
	CapBytes int64
	// Lease and NormaliseWorkspace are forwarded to the guest's Request flags.
	Lease              bool
	NormaliseWorkspace bool
	// Kind, Process and MaxProcesses are forwarded to the guest's Request (plan 5).
	// MaxProcesses is Config.LeaseMaxProcesses, set on process_start only.
	Kind         ExecKind
	Process      ProcessArgs
	MaxProcesses int

	// ctxDone is TEST-ONLY plumbing: the fake launcher fills it so a run hook can
	// block until the run context ends, which is how the timeout and abort tests
	// observe cancellation without a sleep. Production launchers ignore it and use
	// the ctx they are handed.
	ctxDone <-chan struct{}
}

// wrapForGuest is c as a launcher sends it to the guest: a command's Command in wrap, the
// launcher's per-Exec template (wrapCommand, chvWrapCommand), and every other kind's
// exactly as given (ruling P5-R34). The guest runs process_start's command as `bash -c CMD`
// after the shim's fchdir into the requested cwd (spec §7: the process is the command); a
// wrapper around it would make the reported pid the wrapper's, an OOM kill of the command
// read exited(137) instead of killed(9), and the wrapper's `cd /workspace` override the
// cwd. The list, logs, stop and stop-all kinds carry no command at all.
func wrapForGuest(c Command, wrap func(string) string) Command {
	if c.Kind == ExecKindCommand {
		c.Command = wrap(c.Command)
	}
	return c
}

// Sink receives output as it is produced (spec §4.1). Never called concurrently,
// and never after Run returns.
type Sink interface {
	Stdout([]byte)
	Stderr([]byte)
}

// Result is one command's outcome.
//
// The dropped counts are BYTES the guest threw away at CapBytes, per stream, and the
// stream matters rather than being decoration: wexec.BufferCap is a PER-STREAM cap,
// and only stdout's overflow is a truncation the harness seam can express. A Sink
// that ignored the stream would mark a whole stdout truncated for a cut stderr —
// exactly the bug runner.go's Sink documentation warns about.
type Result struct {
	ExitCode      int32
	DroppedStdout int64
	DroppedStderr int64
	// TeardownFailed is the guest's End.TeardownFailed, passed through unchanged.
	TeardownFailed bool
	// Tracked is the guest's End.Tracked: its whole tracked-process table, on every lease
	// End (plan 5). The lease's mirror is refreshed from it (runLease).
	Tracked []TrackedProcess
	// ProcessesStopped is the pool's, never a launcher's: the processes_stopped notice of
	// a lease Exec before which a downgrade's stop ran (execLease). Runner sends it on
	// that Exec's response, and nothing acknowledges or stores it (ruling P5-R19).
	ProcessesStopped *LeaseEvent
}

// TruncatedStdout is what maps to End.truncated (spec §4.1, and the proto's own note
// that the field is stdout-only, deliberately).
func (r Result) TruncatedStdout() bool { return r.DroppedStdout > 0 }

// VM is one restored, paused microVM. The handle NEVER escapes this package
// (spec §4.1) — that is the one bug class which would silently destroy the density
// number, because a caller returning early could leak a VM.
type VM interface {
	// Key is the workspace_key this VM was restored for.
	Key() string
	// Resume unpauses the VM, corrects its wall clock, and on the Firecracker arm
	// mounts the workspace (mount-at-acquire, spec §4.3). Hot path.
	Resume(ctx context.Context) error
	// Run sends exactly one command over vsock and collects its output. A VM serves
	// one Exec in its life; calling Run twice is a bug.
	Run(ctx context.Context, c Command, out Sink) (Result, error)
	// Destroy SIGKILLs the VMM, reaps it and removes the jail. Idempotent.
	Destroy() error
}

// Launcher creates VMs. It is the seam E10 prices (spec §4.3, §7.2), which is why
// both arms live behind one interface rather than behind a build tag.
type Launcher interface {
	Kind() VMMKind
	// Restore brings up one VM from the golden snapshot into its own jail and
	// leaves it PAUSED. Paused, not running: a paused VM takes zero CPU, so
	// thousands of standbys do not burn cores on timer ticks — and spec §7.4's
	// prediction 1 (memory binds before CPU) cannot be falsified for that wrong
	// reason (spec §3.2).
	Restore(ctx context.Context, req RestoreRequest) (VM, error)

	// SerializesExecsPerRun reports that only ONE VM belonging to a given run may
	// run a command at a time. True for the Firecracker arm: the workspace is an
	// ext4 image, not a shared-disk filesystem, and only one guest may hold the rw
	// mount at once (spec §4.3) — two concurrent Execs for the same run would mount
	// it twice and corrupt it. False for Cloud Hypervisor, where the host
	// filesystem (not a guest-owned block device) arbitrates concurrent access.
	SerializesExecsPerRun() bool
}
