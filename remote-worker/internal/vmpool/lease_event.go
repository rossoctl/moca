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
// timeout, and the unacknowledged event, if any.
type LeaseInfo struct {
	Mode        Mode
	EpochKnown  bool
	State       string // LeaseNone, LeaseActive or LeaseExpiring
	Age         time.Duration
	IdleTimeout time.Duration
	Pending     *LeaseEvent
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
		// Computed as well as read: the sweep sets expiring only on its next tick.
		if l.expiring || !now.Before(l.started.Add(p.cfg.leaseMaxDuration(l.mode))) {
			info.State = LeaseExpiring
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
// reset) or sandbox_deleted. It waits for an Exec in flight, up to LeaseGraceLimit
// (endLeaseWaiting). Without a lease it is a no-op.
func (p *pool) EndLease(key string, reason LeaseEndReason) error {
	if err := checkKey(key); err != nil {
		return err
	}
	if reason != LeaseEndReset && reason != LeaseEndSandboxDeleted {
		return fmt.Errorf("vmpool: EndLease for %q: reason %q is not one a caller ends a lease with (%s, %s)",
			key, reason, LeaseEndReset, LeaseEndSandboxDeleted)
	}
	return p.endLeaseWaiting(key, reason)
}

// endLeaseWaiting ends key's lease for reason under its run's gate: after the Exec in
// flight, if any, returns. At LeaseGraceLimit that Exec is cut, as the grace limit cuts
// one (l.cut): its unwind ends the lease with reason and it returns lease_ended(reason).
// A gate held by an Exec that is not inside Run (a cold start) is waited out. The run is
// pinned meanwhile, as routeExec pins it, so the entry whose gate this waits on stays.
//
// A run with no lease but a pin is waited on too: the pin may be a lease Exec about to
// install one.
func (p *pool) endLeaseWaiting(key string, reason LeaseEndReason) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return ErrClosed
	}
	rp := p.runs[key]
	if rp == nil || (rp.lease == nil && rp.pinned == 0) {
		p.mu.Unlock()
		return nil
	}
	rp.pinned++
	p.mu.Unlock()
	defer p.unpin(rp)

	graceOver := make(chan struct{})
	tm := p.clk.AfterFunc(p.cfg.LeaseGraceLimit, func() { close(graceOver) })
	defer tm.Stop()
	select {
	case rp.execGate <- struct{}{}:
	case <-graceOver:
		p.mu.Lock()
		if l := rp.lease; l != nil && l.running && l.cut == "" {
			l.cut = reason
			l.cancel() // a context cancel: it runs no caller code under p.mu
		}
		p.mu.Unlock()
		rp.execGate <- struct{}{}
	}
	p.mu.Lock()
	v := p.endOrDetachLocked(rp, reason)
	p.mu.Unlock()
	if v == nil {
		<-rp.execGate
		return nil
	}
	p.destroyLeaseVictims([]*leaseVictim{v})
	return nil
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
		s.Pending = &LeaseEvent{State: leaseEventEnd, Reason: LeaseEndWorkerRestart, At: now, Mode: o.Mode, Age: age}
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
