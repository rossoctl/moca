package vmpool

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
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
	// Tracked is the live lease's full tracked table from its mirror, exited entries with
	// their state and code included so a client can read why one died (plan 5, P5-R16),
	// and At is when the status was read: their ages count to it.
	Tracked []TrackedProcess
	At      time.Time
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

// LeaseEvent.State values. processes_stopped (plan 5) is never pending: it rides on the
// response of the Exec before which a downgrade's stop ran, unacknowledged, as expiring
// does (ruling P5-R19).
const (
	leaseEventStart            = "start"
	leaseEventEnd              = "end"
	leaseEventProcessesStopped = "processes_stopped"
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
		info.Tracked, info.At = slices.Clone(l.tracked), now
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
	always := func(*runPool) bool { return true }
	return p.waitLeaseGate(key, reason, starting, always, func(rp *runPool, target *vmLease) {
		p.mu.Lock()
		var v *leaseVictim
		if l := rp.lease; l != nil && (l == target || target == nil) {
			v = p.endOrDetachLocked(rp, reason)
		}
		p.mu.Unlock()
		if v == nil {
			<-rp.execGate
			return
		}
		p.destroyLeaseVictims([]*leaseVictim{v})
	})
}

// stopTrackedWaiting is a set_mode downgrade from lease+processes to lease, after
// setModeLocked stored it: it waits for key's gate as endLeaseWaiting does (starting
// included), and its holder stops the lease's tracked processes (stopTrackedUnderGate)
// unless a lease Exec that got the gate first already has. It returns what the stop
// stopped, for that set_mode's answer only (ruling P5-R19). At LeaseGraceLimit the lease
// is cut with mode_change instead, while the stop is still owed: the processes must not
// outlive the downgrade by more than the grace limit, and an end stops them all. Once
// another gate holder has stopped them (a lease Exec at the new epoch, P5-R21), nothing is
// owed, and the wait returns at the grace point without cutting, (nil, nil): the lease is
// kept and that Exec runs on (review Important 1).
//
// A lease a pinned Exec installed at level 2 after the downgrade was stored (the starting
// case) is re-levelled here first, which marks it to stop.
func (p *pool) stopTrackedWaiting(key string) (stopped []TrackedProcess, err error) {
	// owed: the lease still has its stop to take, or is a lease a starting Exec installed at
	// level 2 after the downgrade was stored (the re-level below would mark it). Under p.mu.
	owed := func(rp *runPool) bool {
		l := rp.lease
		return l != nil && (l.stopTracked || (l.mode == ModeLeaseProcesses && rp.state.Known && rp.state.Mode == ModeLease))
	}
	err = p.waitLeaseGate(key, LeaseEndModeChange, true, owed, func(rp *runPool, _ *vmLease) {
		p.mu.Lock()
		l := rp.lease
		if l != nil && p.closed {
			v := p.detachLeaseLocked(rp) // Close skipped this lease: its gate is held here
			p.mu.Unlock()
			p.destroyLeaseVictims([]*leaseVictim{v})
			return
		}
		if l != nil && l.mode == ModeLeaseProcesses && rp.state.Known && rp.state.Mode == ModeLease {
			p.relevelLeaseForExecLocked(rp, l, ModeLease)
		}
		if l == nil || !l.stopTracked {
			p.mu.Unlock()
			<-rp.execGate
			return
		}
		p.mu.Unlock()
		notice, v := p.stopTrackedUnderGate(rp, l)
		if v != nil {
			p.destroyLeaseVictims([]*leaseVictim{v})
			return
		}
		if notice != nil {
			stopped = notice.Tracked
		}
		<-rp.execGate
	})
	return stopped, err
}

// waitLeaseGate is endLeaseWaiting's wait, for whatever its caller does to key's lease
// under the run's gate: once it holds the gate it calls onGate, which must release it, and
// returns. At LeaseGraceLimit it cuts the lease with cut instead, and returns once the
// lease is gone -- if owed(rp), checked under p.mu, still holds there; if not, the
// caller's work was done under someone else's gate, and it returns without cutting. A
// starting wait whose lease is not installed at the grace point cuts nothing (owed is not
// asked), and the wait is the starting Exec's. target is the lease live at the call, nil
// only when starting.
func (p *pool) waitLeaseGate(key string, cut LeaseEndReason, starting bool, owed func(*runPool) bool,
	onGate func(rp *runPool, target *vmLease)) error {
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
			onGate(rp, target)
			return nil
		case <-gone:
			return nil // ended under someone else's gate: the cut Exec, the sweep, Close
		case <-grace:
			grace = nil
			p.mu.Lock()
			if rp.lease != nil && !owed(rp) {
				p.mu.Unlock()
				return nil
			}
			if target == nil {
				target = rp.lease
			}
			if l := target; l != nil && rp.lease == l && l.cut == "" {
				l.cut = cut
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
		// The processes running when the mirror was last saved (Review Focus 4): the
		// guest died with this worker, so they are gone.
		run := runningTracked(o.Tracked)
		s.Pending = &LeaseEvent{State: leaseEventEnd, Reason: LeaseEndWorkerRestart, At: leaseEventAt(now), Mode: o.Mode, Age: age,
			Processes: displays(run), Tracked: run}
		if err := saveLeaseState(root, key, s); err != nil {
			// The next lease start overwrites the open record: this notice is lost, not
			// safety (the same trade as startLease's failed save).
			log.Printf("vmpool: lease end for %q: %v", key, err)
		}
		p.counters.leaseEnded(LeaseEndWorkerRestart)
		log.Printf("vmpool: lease end workspace_key=%q vm=%s mode=%s reason=%s age=%s%s",
			key, o.VMID, o.Mode, LeaseEndWorkerRestart, age.Round(time.Millisecond), trackedAuditField(o.Tracked))
	}
}
