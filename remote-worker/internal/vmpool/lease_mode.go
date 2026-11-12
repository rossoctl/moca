package vmpool

import (
	"encoding/json"
	"fmt"
	"slices"
	"time"
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
// (spec §5). State is "start" or "end"; Reason is set only for an end.
type LeaseEvent struct {
	State  string
	Reason LeaseEndReason
	At     time.Time
	Mode   Mode
	Age    time.Duration
}

// leaseEventJSON is LeaseEvent's on-disk shape: Age in whole milliseconds as age_ms.
type leaseEventJSON struct {
	State  string         `json:"state"`
	Reason LeaseEndReason `json:"reason,omitempty"`
	At     time.Time      `json:"at"`
	Mode   Mode           `json:"mode"`
	AgeMS  int64          `json:"age_ms"`
}

func (e LeaseEvent) MarshalJSON() ([]byte, error) {
	return json.Marshal(leaseEventJSON{State: e.State, Reason: e.Reason, At: e.At, Mode: e.Mode, AgeMS: e.Age.Milliseconds()})
}

func (e *LeaseEvent) UnmarshalJSON(b []byte) error {
	var j leaseEventJSON
	if err := json.Unmarshal(b, &j); err != nil {
		return err
	}
	*e = LeaseEvent{State: j.State, Reason: j.Reason, At: j.At, Mode: j.Mode, Age: time.Duration(j.AgeMS) * time.Millisecond}
	return nil
}

// LeaseSupported is the one rule for whether this worker may serve lease mode: the
// Firecracker arm with a snapshot advertising lease-v1 (plan 1's guest half). New sets
// Config.LeaseEnabled from it; the worker banner prints it from the same function.
func LeaseSupported(cfg Config) bool {
	return cfg.VMM == Firecracker && slices.Contains(cfg.ManifestFeatures, FeatureLeaseV1)
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
	}
	return e.Mode, nil
}

// leaseStateLocked returns rp's state, reading the file on the run's first use. A run
// lives exactly as long as its workspace, and the file is removed with the workspace,
// so the cache can never outlive what it caches. Caller holds p.mu.
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
// This records the change only; ending or downgrading a live lease is Task 5's.
func (p *pool) SetMode(key string, m Mode, epoch uint64) error {
	// Refusals here are returned, not counted: Stats' refusal counts are Exec errors by
	// cause, and a LeaseControl call is not an Exec.
	if err := checkKey(key); err != nil {
		return err
	}
	if m > ModeLeaseProcesses {
		return fmt.Errorf("vmpool: SetMode: unknown mode %s", m)
	}
	if m != ModePerExec && !p.cfg.LeaseEnabled {
		return refusal(RefuseLeaseUnsupported, "SetMode %s for %q: %s", m, key, leaseUnsupportedDetail)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return ErrClosed
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
		return refusal(RefuseStaleMode, "SetMode for %q: epoch %d is below the stored %d", key, epoch, s.Epoch)
	}
	s.Mode, s.Epoch, s.Known = m, epoch, true
	if err := saveLeaseState(p.cfg.WorkspaceRoot, key, s); err != nil {
		return fmt.Errorf("vmpool: SetMode for %q: %w", key, err)
	}
	if rp != nil {
		rp.state = s
	}
	return nil
}

const leaseUnsupportedDetail = "lease mode needs the Firecracker arm and a snapshot with the lease-v1 feature"
