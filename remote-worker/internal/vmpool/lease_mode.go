package vmpool

import (
	"encoding/json"
	"fmt"
	"log"
	"slices"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

// Mode is how a sandbox's Execs use VMs (spec §3). The zero value is per-Exec, so an
// Exec that names no mode -- every vmpool.Runner send until plan 3 -- takes today's path.
type Mode uint8

const (
	ModePerExec        Mode = iota // one VM per command, destroyed after it (the default)
	ModeLease                      // level 1: one VM held across Execs, no process outlives its Exec
	ModeLeaseProcesses             // level 2: a lease whose tracked processes may outlive an Exec
)

// String is the wire and state-file spelling (spec §8.1's SandboxRecord.mode values).
func (m Mode) String() string {
	switch m {
	case ModePerExec:
		return "per-exec"
	case ModeLease:
		return "lease"
	case ModeLeaseProcesses:
		return "lease+processes"
	}
	return fmt.Sprintf("mode(%d)", uint8(m))
}

// ParseMode is String's inverse. Anything else is refused, never mapped to a default:
// a mode the worker cannot name is one it cannot honour.
func ParseMode(s string) (Mode, error) {
	for _, m := range []Mode{ModePerExec, ModeLease, ModeLeaseProcesses} {
		if s == m.String() {
			return m, nil
		}
	}
	return 0, fmt.Errorf("vmpool: mode %q is not one of per-exec, lease, lease+processes", s)
}

// Proto is m as the wire's SandboxMode. An out-of-range Mode has no wire spelling and
// maps to UNSPECIFIED; the pool never stores one (SetMode and MarshalText refuse it).
func (m Mode) Proto() pb.SandboxMode {
	switch m {
	case ModePerExec:
		return pb.SandboxMode_SANDBOX_MODE_PER_EXEC
	case ModeLease:
		return pb.SandboxMode_SANDBOX_MODE_LEASE
	case ModeLeaseProcesses:
		return pb.SandboxMode_SANDBOX_MODE_LEASE_PROCESSES
	}
	return pb.SandboxMode_SANDBOX_MODE_UNSPECIFIED
}

// ModeFromProto is Proto's inverse, with UNSPECIFIED read as per-exec (the proto's own
// rule). A value this worker does not know is refused, never mapped to a default.
func ModeFromProto(m pb.SandboxMode) (Mode, error) {
	switch m {
	case pb.SandboxMode_SANDBOX_MODE_UNSPECIFIED, pb.SandboxMode_SANDBOX_MODE_PER_EXEC:
		return ModePerExec, nil
	case pb.SandboxMode_SANDBOX_MODE_LEASE:
		return ModeLease, nil
	case pb.SandboxMode_SANDBOX_MODE_LEASE_PROCESSES:
		return ModeLeaseProcesses, nil
	}
	return 0, fmt.Errorf("vmpool: SandboxMode %d is not one this worker knows", int32(m))
}

// MarshalText and UnmarshalText make the state file carry the spelling rather than a
// number, so a reordering of the constants can never reinterpret a file on disk.
func (m Mode) MarshalText() ([]byte, error) {
	if m > ModeLeaseProcesses {
		return nil, fmt.Errorf("vmpool: cannot encode %s", m)
	}
	return []byte(m.String()), nil
}

func (m *Mode) UnmarshalText(b []byte) error {
	v, err := ParseMode(string(b))
	if err != nil {
		return err
	}
	*m = v
	return nil
}

// LeaseEndReason is why a lease ended, in the exact strings of spec §4.1.
type LeaseEndReason string

const (
	LeaseEndIdle           LeaseEndReason = "idle"
	LeaseEndMaxDuration    LeaseEndReason = "max_duration"
	LeaseEndGraceLimit     LeaseEndReason = "grace_limit"
	LeaseEndKeepaliveLost  LeaseEndReason = "keepalive_lost"
	LeaseEndReset          LeaseEndReason = "reset"
	LeaseEndModeChange     LeaseEndReason = "mode_change"
	LeaseEndMemoryReclaim  LeaseEndReason = "memory_reclaim"
	LeaseEndWorkerRestart  LeaseEndReason = "worker_restart"
	LeaseEndTeardownFailed LeaseEndReason = "teardown_failed"
	LeaseEndAgentDead      LeaseEndReason = "agent_dead"
	LeaseEndSandboxDeleted LeaseEndReason = "sandbox_deleted"
)

// LeaseEvent is one lease start or end, as the worker reports it until acknowledged
// (spec §5). State is "start" or "end"; Reason is set only for an end. An Exec's
// processes_stopped notice (plan 5, Result.ProcessesStopped) has this shape too, with
// Reason mode_change, and is never acknowledged.
//
// Processes and Tracked are set on a level-2 end (plan 5): the tracked processes running
// when the lease ended, from its mirror, as display strings ("<name> (pid <n>)") and in
// their structured form.
type LeaseEvent struct {
	State     string
	Reason    LeaseEndReason
	At        time.Time
	Mode      Mode
	Age       time.Duration
	Processes []string
	Tracked   []TrackedProcess
}

// leaseEventAt is the At of an event minted at now: now to the millisecond (PR #763
// review). A client acknowledges an event by its At (AckLeaseEvent), and a JS client's
// Date holds milliseconds, so a finer At could never be acknowledged from one.
func leaseEventAt(now time.Time) time.Time { return now.Truncate(time.Millisecond) }

// leaseEventJSON is LeaseEvent's on-disk shape: Age in whole milliseconds as age_ms.
type leaseEventJSON struct {
	State     string           `json:"state"`
	Reason    LeaseEndReason   `json:"reason,omitempty"`
	At        time.Time        `json:"at"`
	Mode      Mode             `json:"mode"`
	AgeMS     int64            `json:"age_ms"`
	Processes []string         `json:"processes,omitempty"`
	Tracked   []TrackedProcess `json:"tracked,omitempty"`
}

func (e LeaseEvent) MarshalJSON() ([]byte, error) {
	return json.Marshal(leaseEventJSON{State: e.State, Reason: e.Reason, At: e.At, Mode: e.Mode, AgeMS: e.Age.Milliseconds(),
		Processes: e.Processes, Tracked: e.Tracked})
}

func (e *LeaseEvent) UnmarshalJSON(b []byte) error {
	var j leaseEventJSON
	if err := json.Unmarshal(b, &j); err != nil {
		return err
	}
	*e = LeaseEvent{State: j.State, Reason: j.Reason, At: j.At, Mode: j.Mode, Age: time.Duration(j.AgeMS) * time.Millisecond,
		Processes: j.Processes, Tracked: j.Tracked}
	return nil
}

// LeaseSupported is the one rule for whether this worker may serve lease mode: the
// Firecracker arm with a snapshot advertising lease-v1 (plan 1's guest half). New sets
// Config.LeaseEnabled from it; the worker banner prints it from the same function.
func LeaseSupported(cfg Config) bool {
	return cfg.VMM == Firecracker && slices.Contains(cfg.ManifestFeatures, FeatureLeaseV1)
}

// LeaseProcessesSupported is the same rule for lease level 2's process kinds: lease mode,
// and a snapshot advertising lease-processes-v1 (plan 5). An agent without it would run a
// process kind as a plain command, so the pool refuses one before anything reaches it.
func LeaseProcessesSupported(cfg Config) bool {
	return LeaseSupported(cfg) && slices.Contains(cfg.ManifestFeatures, FeatureLeaseProcessesV1)
}

// CapabilityLeaseProcessesV1 is the reserved Hello capability of a worker that serves
// lease level 2's process kinds (ruling P5-R37). The relay refuses a process kind with
// lease_unsupported, before forwarding anything, to a worker that does not advertise it:
// a worker from before plan 5 decodes Exec.kind as an unknown field and would run a
// process_start's command as a plain Exec. The relay matches this exact string
// (packages/sandbox-relay, LEASE_PROCESSES_CAPABILITY).
const CapabilityLeaseProcessesV1 = "sbx:lease-processes-v1"

// HelloCapabilities is what a microVM worker advertises in Hello: the snapshot manifest's
// probed capabilities, in order, with CapabilityLeaseProcessesV1 added when, and only
// when, LeaseProcessesSupported(cfg). The manifest's own copy of the reserved name, if it
// has one, is never passed on: only this rule advertises it.
func HelloCapabilities(cfg Config, manifest []string) []string {
	out := make([]string, 0, len(manifest)+1)
	for _, c := range manifest {
		if c != CapabilityLeaseProcessesV1 {
			out = append(out, c)
		}
	}
	if LeaseProcessesSupported(cfg) {
		out = append(out, CapabilityLeaseProcessesV1)
	}
	return out
}

// leaseIdle resolves an Exec's idle timeout: 0 takes LeaseIdleDefault, and an owner's
// value is clamped to [LeaseIdleMin, LeaseIdleCeiling] (spec §4). Called on a
// normalized Config.
func (c Config) leaseIdle(e Exec) time.Duration {
	d := e.IdleTimeout
	if d == 0 {
		d = c.LeaseIdleDefault
	}
	return min(max(d, c.LeaseIdleMin), c.LeaseIdleCeiling)
}

// effectiveModeLocked decides the mode an Exec runs in from its relay-set mode and
// epoch and the key's stored state (spec §8.2). Caller holds p.mu.
//
//   - an epoch below a known one is refused (stale-mode): a token minted before a
//     downgrade must not keep its higher mode;
//   - an unknown epoch (file missing or unreadable) runs per-Exec and stores nothing:
//     with the file lost, a pre-downgrade token would otherwise count as newer, so only
//     SetMode restores the mode;
//   - at an equal epoch, the lower of the Exec's mode and the stored one (per-exec <
//     lease < lease+processes; PR #763 review): defence in depth for a downgrade, so a
//     token minted before a same-epoch SetMode cannot keep the higher mode;
//   - otherwise the Exec's mode, and a newer epoch is stored.
func (p *pool) effectiveModeLocked(rp *runPool, e Exec) (Mode, error) {
	s := p.leaseStateLocked(rp)
	switch {
	case !s.Known:
		return ModePerExec, nil
	case e.ModeEpoch < s.Epoch:
		return 0, p.refuse(RefuseStaleMode, "workspace_key %q: Exec mode_epoch %d is below the stored %d",
			rp.key, e.ModeEpoch, s.Epoch)
	case e.ModeEpoch > s.Epoch:
		next := s
		next.Mode, next.Epoch = e.Mode, e.ModeEpoch
		if err := saveLeaseState(p.cfg.WorkspaceRoot, rp.key, next); err != nil {
			// Not stored, not served: running on an epoch the disk does not hold would let
			// a restart reinstate the older mode this Exec just superseded.
			return 0, fmt.Errorf("vmpool: store mode epoch for %q: %w", rp.key, err)
		}
		rp.state = next
	case e.Mode != s.Mode:
		return min(e.Mode, s.Mode), nil
	}
	return e.Mode, nil
}

// leaseStateLocked returns rp's state, reading the file on the run's first use. A run
// lives exactly as long as its workspace, and the file is retired with the workspace
// (retireLeaseState), so the cache can never outlive what it caches. Caller holds p.mu.
func (p *pool) leaseStateLocked(rp *runPool) leaseState {
	if !rp.stateLoaded {
		rp.state = loadLeaseState(p.cfg.WorkspaceRoot, rp.key)
		rp.stateLoaded = true
	}
	return rp.state
}

// SetMode applies a verified LeaseControl set_mode (plan 3 checks the signature): it
// stores {m, epoch} as known, which is the only way to restore a mode after the state
// file was lost (spec §8.2). An epoch below a known one is refused. Equal is accepted,
// because mocactl re-sends the current epoch when the worker reports it unknown.
//
// A downgrade takes effect at once (spec §8.2). To per-exec, a live lease ends
// (mode_change) after the Exec in flight, bounded by LeaseGraceLimit (endLeaseWaiting).
// The new mode and epoch are stored first, so a lease Exec queued on the gate does not
// keep the old mode (execLease): below the new epoch it is refused stale-mode, and at the
// same epoch it is served at the lower of its mode and the new one -- per-Exec after a
// downgrade to per-exec, which ends the lease if that Exec gets the gate first. From
// lease+processes to lease the lease is kept, at level 1 from now on, and its tracked
// processes stop under the gate, after the Exec in flight and bounded by LeaseGraceLimit
// as above (stopTrackedWaiting): SetMode returns what the stop stopped, or nil when a
// lease Exec got the gate first and stopped them (its response carries the notice). A
// snapshot without lease-processes-v1 has no tracked processes, and SetMode does not wait.
// An upgrade applies from the next Exec that carries the new epoch.
func (p *pool) SetMode(key string, m Mode, epoch uint64) ([]TrackedProcess, error) {
	// Refusals here are returned, not counted: Stats' refusal counts are Exec errors by
	// cause, and a LeaseControl call is not an Exec.
	if err := checkKey(key); err != nil {
		return nil, err
	}
	if m > ModeLeaseProcesses {
		return nil, fmt.Errorf("vmpool: SetMode: unknown mode %s", m)
	}
	if m != ModePerExec && !p.cfg.LeaseEnabled {
		return nil, refusal(RefuseLeaseUnsupported, "SetMode %s for %q: %s", m, key, leaseUnsupportedDetail)
	}
	p.mu.Lock()
	endLease, stopTracked, err := p.setModeLocked(key, m, epoch)
	p.mu.Unlock()
	switch {
	case err != nil:
		return nil, err
	case endLease:
		return nil, p.endLeaseWaiting(key, LeaseEndModeChange, true)
	case stopTracked:
		return p.stopTrackedWaiting(key)
	}
	return nil, nil
}

// setModeLocked is SetMode under p.mu: it stores the mode and reports whether a lease
// must end (mode_change) because of it, or have its tracked processes stopped. Caller
// holds p.mu.
func (p *pool) setModeLocked(key string, m Mode, epoch uint64) (endLease, stopTracked bool, err error) {
	if p.closed {
		return false, false, ErrClosed
	}
	rp := p.runs[key]
	var s leaseState
	if rp != nil {
		s = p.leaseStateLocked(rp)
	} else {
		// No run, so no cache: the file is the state, and the run that is created
		// later reads it back.
		s = loadLeaseState(p.cfg.WorkspaceRoot, key)
	}
	if s.Known && epoch < s.Epoch {
		return false, false, refusal(RefuseStaleMode, "SetMode for %q: epoch %d is below the stored %d", key, epoch, s.Epoch)
	}
	wasLevel2 := s.Known && s.Mode == ModeLeaseProcesses
	if !s.Known {
		// No readable state means an unknown history (ruling R7): unversioned per-Exec
		// Execs record nothing, so any of them may have written the workspace as root.
		// The first lease must normalise it.
		s.RootWrote = true
	}
	s.Mode, s.Epoch, s.Known = m, epoch, true
	var l *vmLease
	if rp != nil {
		l = rp.lease
	}
	toLevel1 := l != nil && m == ModeLease && l.mode == ModeLeaseProcesses
	if toLevel1 {
		s = withOpenMode(s, m)
	}
	if err := saveLeaseState(p.cfg.WorkspaceRoot, key, s); err != nil {
		return false, false, fmt.Errorf("vmpool: SetMode for %q: %w", key, err)
	}
	if rp == nil {
		return false, false, nil
	}
	rp.state = s
	if toLevel1 {
		p.setLeaseLevelLocked(rp, l, m) // level 1's maximum duration from now on; marks l.stopTracked
	}
	switch m {
	case ModePerExec:
		// A pin without a lease may be a lease Exec about to install one.
		return l != nil || rp.pinned > 0, false, nil
	case ModeLease:
		// The same holds for a lease at level 2, when the mode was level 2 until now.
		starting := wasLevel2 && rp.pinned > 0 && (l == nil || l.started.IsZero())
		return false, (l != nil && l.stopTracked) || (starting && LeaseProcessesSupported(p.cfg)), nil
	}
	return false, false, nil
}

// relevelLeaseForExecLocked applies a lease level change that reached the worker on the
// Exec about to run in l, rather than through SetMode (spec §8.2, ruling R18): an upgrade
// lease -> lease+processes "takes effect from the next Exec that carries the new epoch",
// and a downgrade whose LeaseControl was lost "lands at the next Exec". m is the mode
// execLease serves, recomputed under the gate: the Exec's own when its epoch was newer
// (routeExec stored it), and the lower of the Exec's and the stored one at an equal epoch,
// so an Exec never re-levels a lease above a same-epoch downgrade, including one that
// landed while it queued. execLease's stale-mode check has passed. A no-op when l already
// runs at m. m is never per-exec: a newer epoch at per-exec goes down the per-Exec path
// in routeExec, and a per-exec served under the gate ends the lease (mode_change) in
// execLease instead. Caller holds p.mu and rp's gate, with l live and started.
//
// stopTrackedWaiting calls it too, for a lease a pinned Exec installed at level 2 after a
// set_mode downgrade to lease was stored.
func (p *pool) relevelLeaseForExecLocked(rp *runPool, l *vmLease, m Mode) {
	if l.mode == m {
		return
	}
	if s := rp.state; s.Open != nil {
		s = withOpenMode(s, m)
		if err := saveLeaseState(p.cfg.WorkspaceRoot, rp.key, s); err != nil {
			// The open record only names the level a worker_restart end reports: losing
			// it loses that detail, not safety (startLease's trade).
			log.Printf("vmpool: lease level for %q: %v", rp.key, err)
		}
		rp.state = s
	}
	p.setLeaseLevelLocked(rp, l, m)
}

// setLeaseLevelLocked moves the live lease l to lease level m. Its maximum duration is
// m's from now on, counted from the lease's original start (ruling R11): a lease already
// past it is expiring at once, and one that is not is no longer expiring. A lease leaving
// level 2 is marked to have its tracked processes stopped by the next holder of the gate
// (l.stopTracked), on a snapshot with lease-processes-v1 only: without it there are none,
// and its agent knows no process_stop_all. Caller holds p.mu.
func (p *pool) setLeaseLevelLocked(rp *runPool, l *vmLease, m Mode) {
	was := l.mode
	l.mode = m
	if was == ModeLeaseProcesses && m != ModeLeaseProcesses && LeaseProcessesSupported(p.cfg) {
		l.stopTracked = true
	}
	l.expiring = !p.clk.Now().Before(l.started.Add(p.cfg.leaseMaxDuration(m)))
	log.Printf("vmpool: lease level workspace_key=%q vm=%s mode=%s was=%s expiring=%t",
		rp.key, vmID(l.vm), m, was, l.expiring)
}

// withOpenMode is s with its open lease, if any, recorded at mode m, so that a
// worker_restart end reports the level the lease ran at last. The record is copied, not
// written through: s may share it with the cached state.
func withOpenMode(s leaseState, m Mode) leaseState {
	if s.Open != nil {
		o := *s.Open
		o.Mode = m
		s.Open = &o
	}
	return s
}

const leaseUnsupportedDetail = "lease mode needs the Firecracker arm and a snapshot with the lease-v1 feature"
