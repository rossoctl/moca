package vmpool

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// A key's lease events and status (spec §5, §8.2, §8.4). Every lease end writes Pending =
// {end, reason} to the key's state file (endLeaseLocked); a lease start writes {start}
// only when no end is pending, so one notice covers both. The event stays until a client
// acknowledges it (AckLeaseEvent), across a worker restart and across the removal of the
// key's workspace (ruling R9). Carrying it to a client is plan 3's.

// LeaseInfo is a key's lease as LeaseStatus reports it: the stored mode (per-exec while
// the epoch is unknown), whether the epoch is known, the live lease's state, age and idle
// timeout, the unacknowledged event, if any, and, while the lease is expiring, its expiry.
type LeaseInfo struct {
	Mode        Mode
	EpochKnown  bool
	State       string // LeaseNone, LeaseActive or LeaseExpiring
	Age         time.Duration
	IdleTimeout time.Duration
	Pending     *LeaseEvent
	Expiry      *LeaseExpiry // set only when State is LeaseExpiring
}

// LeaseExpiry is an expiring lease's notice (spec §5, plan 4): its level, when it passed
// its maximum duration (Since), and when the grace limit ends it even mid-Exec (EndsBy =
// Since + LeaseGraceLimit). Since is computed from the lease's start, not from the sweep
// tick that marked it expiring, so it is the same on every Exec that carries the notice --
// a client dedupes on it -- and EndsBy is the deadline the sweep enforces
// (leaseGraceDeadline), not up to a LeaseScanInterval past it.
type LeaseExpiry struct {
	Mode   Mode
	Since  time.Time
	EndsBy time.Time
}

// LeaseInfo.State values (spec §5's lease state).
const (
	LeaseNone     = "none"
	LeaseActive   = "active"
	LeaseExpiring = "expiring" // past its maximum duration: ends at its next idle
)

// LeaseEvent.State values.
const (
	leaseEventStart = "start"
	leaseEventEnd   = "end"
)

// LeaseStatus reports key's lease. A key the pool has never seen reads its state file,
// if there is one; an invalid key reports no lease, per-exec, epoch unknown. Age and
// IdleTimeout are zero without a live lease.
func (p *pool) LeaseStatus(key string) LeaseInfo {
	info := LeaseInfo{Mode: ModePerExec, State: LeaseNone}
	if checkKey(key) != nil {
		return info
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	rp := p.runs[key]
	s := p.peekLeaseStateLocked(key, rp)
	if s.Known {
		info.Mode, info.EpochKnown = s.Mode, true
	}
	if s.Pending != nil {
		ev := *s.Pending
		info.Pending = &ev
	}
	if rp == nil || rp.lease == nil {
		return info
	}
	info.State = LeaseActive
	if l := rp.lease; !l.started.IsZero() { // zero while startLease installs it
		now := p.clk.Now()
		info.Age, info.IdleTimeout = now.Sub(l.started), l.idle
		// Computed as well as read: the sweep sets expiring only on its next tick. l.expiring
		// implies the maximum duration has passed (the sweep and setLeaseLevelLocked set it
		// from the same comparison), so Since is never in the future.
		since := l.started.Add(p.cfg.leaseMaxDuration(l.mode))
		if l.expiring || !now.Before(since) {
			info.State = LeaseExpiring
			at := leaseEventAt(since)
			info.Expiry = &LeaseExpiry{Mode: l.mode, Since: at, EndsBy: at.Add(p.cfg.LeaseGraceLimit)}
		}
	}
	return info
}

// AckLeaseEvent clears key's pending event if its At equals at: a client has shown it. A
// different At is a newer event the client has not seen, and it stays. A state file left
// holding nothing (the event was all a removed workspace kept, ruling R9) is deleted.
func (p *pool) AckLeaseEvent(key string, at time.Time) {
	if checkKey(key) != nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	rp := p.runs[key]
	s := p.peekLeaseStateLocked(key, rp)
	if s.Pending == nil || !s.Pending.At.Equal(at) {
		return
	}
	s.Pending = nil
	if s == (leaseState{}) {
		removeLeaseState(p.cfg.WorkspaceRoot, key)
	} else if err := saveLeaseState(p.cfg.WorkspaceRoot, key, s); err != nil {
		// The event stays on disk, so a client is told it twice: harmless.
		log.Printf("vmpool: acknowledge lease event for %q: %v", key, err)
	}
	if rp != nil {
		rp.state, rp.stateLoaded = s, true
	}
}

// EndLease ends key's lease for a caller's reason: reset (the reset tool, mocactl sbx
// reset) or sandbox_deleted. It waits for an Exec in flight; at LeaseGraceLimit that Exec
// is cut and fails lease_ended(<reason>), so EndLease returns by LeaseGraceLimit plus the
// cut Exec's unwind (endLeaseWaiting). Without a live lease it is a no-op: a lease that
// starts after the call is not this call's to end.
func (p *pool) EndLease(key string, reason LeaseEndReason) error {
	if err := checkKey(key); err != nil {
		return err
	}
	if reason != LeaseEndReset && reason != LeaseEndSandboxDeleted {
		return fmt.Errorf("vmpool: EndLease for %q: reason %q is not one a caller ends a lease with (%s, %s)",
			key, reason, LeaseEndReset, LeaseEndSandboxDeleted)
	}
	return p.endLeaseWaiting(key, reason, false)
}

// endLeaseWaiting ends key's lease for reason: the lease live when it is called, and only
// that one. It waits for the gate, so for the Exec in flight to return. At LeaseGraceLimit
// it cuts the lease (l.cut): the Exec inside Run is cancelled, and its unwind ends the
// lease with reason; a lease no Exec is running in ends with reason under the next gate
// holder (a queued lease Exec fails lease_ended(<reason>) without running, a per-Exec
// Exec or the sweep ends it with reason, not its own). From then on it returns as soon as
// the lease is gone, whoever ended it, rather than once it holds the gate: an Exec queued
// behind the cut one may start a fresh lease, and neither that lease nor that Exec's
// duration is this call's. It still competes for the gate after the cut, and that is
// what guarantees a cut lease is ended: if no Exec is running and the sweep never takes
// it, this call wins the gate and ends the cut lease itself. So it returns by
// LeaseGraceLimit plus the cut Exec's unwind. The run is pinned meanwhile, as routeExec
// pins it, so the entry whose gate this waits on stays.
//
// starting (SetMode's downgrade) also covers a run with no lease yet but a pin: that pin
// may be a lease Exec inside startLease, which passed its epoch check before the
// downgrade. Its lease, once installed, is the one to end; any lease found under the gate
// is, because every later lease Exec is refused stale-mode (execLease). Until such a
// lease exists there is nothing to cut, and the wait is the starting Exec's.
func (p *pool) endLeaseWaiting(key string, reason LeaseEndReason, starting bool) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return ErrClosed
	}
	rp := p.runs[key]
	if rp == nil || (rp.lease == nil && (!starting || rp.pinned == 0)) {
		p.mu.Unlock()
		return nil
	}
	target := rp.lease // nil only when starting
	rp.pinned++
	p.mu.Unlock()
	defer p.unpin(rp)

	graceOver := make(chan struct{})
	tm := p.clk.AfterFunc(p.cfg.LeaseGraceLimit, func() { close(graceOver) })
	defer tm.Stop()
	grace := (<-chan struct{})(graceOver)
	for {
		var gone <-chan struct{} // nil, so never ready, until there is a target
		if target != nil {
			gone = target.gone
		}
		select {
		case rp.execGate <- struct{}{}:
			p.mu.Lock()
			var v *leaseVictim
			if l := rp.lease; l != nil && (l == target || target == nil) {
				v = p.endOrDetachLocked(rp, reason)
			}
			p.mu.Unlock()
			if v == nil {
				<-rp.execGate
				return nil
			}
			p.destroyLeaseVictims([]*leaseVictim{v})
			return nil
		case <-gone:
			return nil // ended under someone else's gate: the cut Exec, the sweep, Close
		case <-grace:
			grace = nil
			p.mu.Lock()
			if target == nil {
				target = rp.lease
			}
			if l := target; l != nil && rp.lease == l && l.cut == "" {
				l.cut = reason
				if l.running {
					l.cancel() // a context cancel: it runs no caller code under p.mu
				}
			}
			p.mu.Unlock()
		}
	}
}

// peekLeaseStateLocked is key's state without the missing-file log line: rp's cached
// state when there is a run, the file otherwise. A status or acknowledgement call creates
// no run. Caller holds p.mu.
func (p *pool) peekLeaseStateLocked(key string, rp *runPool) leaseState {
	if rp != nil {
		return p.leaseStateIfAnyLocked(rp)
	}
	return loadLeaseStateIfAny(p.cfg.WorkspaceRoot, key)
}

// endLeasesOpenAtStart reports every lease the previous process left open: a lease does
// not survive its worker (spec §8.4). Each state file with Open set gets Pending = {end,
// worker_restart} and Open = nil, and is saved, before New returns, so before the pool
// serves. The age is the lease's at this restart. Done once per file: the rewritten file
// has no open lease, so a later restart reports nothing again.
func (p *pool) endLeasesOpenAtStart() {
	root := p.cfg.WorkspaceRoot
	ents, err := os.ReadDir(filepath.Join(root, leaseStateDir))
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("vmpool: lease state dir: %v; leases open at the last exit are not reported", err)
		}
		return
	}
	now := p.clk.Now()
	for _, ent := range ents {
		// saveLeaseState's temp files start with a dot and do not end in .json; checkKey
		// refuses anything else that is not a key.
		key, ok := strings.CutSuffix(ent.Name(), ".json")
		if !ok || ent.IsDir() || checkKey(key) != nil {
			continue
		}
		s := loadLeaseState(root, key)
		o := s.Open
		if o == nil {
			continue
		}
		age := now.Sub(o.Started)
		s.Open = nil
		s.Pending = &LeaseEvent{State: leaseEventEnd, Reason: LeaseEndWorkerRestart, At: leaseEventAt(now), Mode: o.Mode, Age: age}
		if err := saveLeaseState(root, key, s); err != nil {
			// The next lease start overwrites the open record: this notice is lost, not
			// safety (the same trade as startLease's failed save).
			log.Printf("vmpool: lease end for %q: %v", key, err)
		}
		p.counters.leaseEnded(LeaseEndWorkerRestart)
		log.Printf("vmpool: lease end workspace_key=%q vm=%s mode=%s reason=%s age=%s",
			key, o.VMID, o.Mode, LeaseEndWorkerRestart, age.Round(time.Millisecond))
	}
}
