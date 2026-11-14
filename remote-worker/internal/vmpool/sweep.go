package vmpool

import (
	"log"
	"time"
)

// reclaimBatch is what a sweep detached: VMs to destroy and workspaces to remove.
//
// dirs holds DETACHED paths, not live workspace directories — see detachWorkspace. A
// live path in this slice would be removable out from under a run that has since
// re-claimed the key, which is exactly the bug the tombstone exists to prevent.
type reclaimBatch struct {
	vms  []VM
	dirs []string
	// leases are lease VMs the lease sweep ended, each with its run's execGate held and
	// the run pinned; doReclaim releases both only after the VM is destroyed.
	leases []*leaseVictim
}

// sweepOnce walks every run and detaches what has aged out, under the lock,
// returning the work to be done outside it.
//
// Detaching synchronously and destroying asynchronously is deliberate. Stats
// reflects the reclamation the moment it is decided — so a run's
// idle-standby-residency reading is not lagging behind a munmap queue — while spec
// §6's reclaim storm ("bulk munmap of many paused standbys contends with the hot
// path") happens off both the lock and the request path.
//
// MaxReclaimsPerScan bounds the batch, so convergence is a slope rather than a
// stall. It counts VMs only, not workspaces: it exists to rate-limit munmap, and an
// rmdir is not that.
func (p *pool) sweepOnce(now time.Time) reclaimBatch {
	p.mu.Lock()
	defer p.mu.Unlock()

	var b reclaimBatch
	budget := p.cfg.MaxReclaimsPerScan
	for key, rp := range p.runs {
		if budget <= 0 {
			break
		}
		// A run with work in flight or a warming pending is never swept, whatever its
		// idle clock says: reclaiming here would pull the workspace out from under a
		// running command.
		if rp.busy() {
			continue
		}
		idle := rp.idleFor(now)
		// "no Exec for this long" (Config.StandbyIdle's doc comment) means the
		// threshold itself qualifies: idle >= StandbyIdle, not idle > StandbyIdle. A
		// tick can land exactly on the boundary (idle == StandbyIdle to the
		// millisecond), and a strict ">" would silently defer that run to the next
		// tick — TestASweepDestroysAtMostMaxReclaimsPerScan pins this.
		if idle < p.cfg.StandbyIdle {
			continue
		}

		take := min(budget, len(rp.ready))
		b.vms = append(b.vms, rp.ready[:take]...)
		rp.ready = rp.ready[take:]
		budget -= take
		if len(rp.ready) > 0 {
			// Partially reclaimed; the next tick takes the rest. Leave the run Active
			// so its state does not claim to be parked while it still holds RAM.
			continue
		}
		for _, tm := range rp.pending {
			tm.Stop()
		}
		rp.pending = nil

		if idle >= p.cfg.WorkspaceIdle {
			// RunParked -> RunReclaiming -> RunAbsent. Safe to fire, and spec §4.4 is
			// what makes it safe: the workspace is a per-dispatch derivation — a
			// detached worktree at a pinned commit, with continuity living in the Redis
			// session log — so early reclamation costs a re-converge, never data.
			//
			// The tree is detached HERE, under the lock, in the same critical section
			// that drops the map entry — so the key and its directory become
			// unreachable together and the queued removal cannot touch whatever a
			// re-created run puts at the original path (detachWorkspace).
			tomb, err := detachWorkspace(rp.dir)
			if err != nil {
				// Keep the run rather than dropping an entry whose directory is still
				// live: the next tick retries, and a run that outlives its own
				// reclamation is recoverable where a leaked-but-forgotten tree is not.
				log.Printf("vmpool: sweep detach %s: %v", rp.dir, err)
				continue
			}
			if tomb != "" {
				b.dirs = append(b.dirs, tomb)
			}
			delete(p.runs, key)
			// The key's lease state is retired with its workspace, in the same critical
			// section: the mode and epoch stay, root_wrote is set for the new tree, and an
			// unacknowledged event stays (retireLeaseState). Only on a lease-enabled pool: a
			// per-Exec-only worker touches no key's state file (its only lease-state I/O is
			// the boot marker New writes, markLeaseBoot), so its paths are unchanged.
			if p.cfg.LeaseEnabled {
				retireLeaseState(p.cfg.WorkspaceRoot, key, p.leaseStateIfAnyLocked(rp))
			}
			continue
		}
		// RunActive -> RunParked: drop the standbys, KEEP the workspace. RAM is
		// urgent and disk is not, which is why there are two thresholds and not one.
		rp.parked = true
	}
	return b
}

// sweep detaches and then hands the batch to the reclaim goroutine. If the queue is
// full it destroys inline: back-pressure on the sweeper is bad, but a dropped batch
// is a leak, and spec §6 makes leaked VMs the #1 practical failure.
//
// The enqueue decision is made under p.mu, and so is Close's close(p.reclaimQ)
// (see Close): both are critical sections on the same lock, so they are totally
// ordered against each other. A sweep that observes p.closed == false here is
// therefore guaranteed to finish sending (if it sends at all) before Close's
// close() call can run — Close writes p.closed = true, under this same lock,
// strictly before it ever closes the queue, and a sweep that reads closed == false
// cannot be ordered after that write. Without this, a sweep racing a real-clock
// ticker firing near shutdown could send on a channel Close had already closed.
func (p *pool) sweep(now time.Time) {
	b := p.sweepOnce(now)
	if len(b.vms) == 0 && len(b.dirs) == 0 {
		return
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		p.doReclaim(b)
		return
	}
	select {
	case p.reclaimQ <- b:
		p.mu.Unlock()
	default:
		p.mu.Unlock()
		p.doReclaim(b)
	}
}

func (p *pool) doReclaim(b reclaimBatch) {
	// Leases first: an Exec may be waiting on each one's gate.
	p.destroySweptLeases(b.leases)
	for _, vm := range b.vms {
		if err := vm.Destroy(); err != nil {
			p.counters.destroyFailed()
			log.Printf("vmpool: sweep destroy: %v", err)
		}
	}
	for _, dir := range b.dirs {
		if err := removeWorkspace(dir); err != nil {
			log.Printf("vmpool: sweep remove %s: %v", dir, err)
		}
	}
}

func (p *pool) reclaimLoop() {
	defer p.reclaimDone.Done()
	for b := range p.reclaimQ {
		p.doReclaim(b)
	}
}

// armTickerLocked schedules the next sweep and re-arms from inside its own callback.
// Caller holds p.mu.
//
// This is spec §4.2's second trigger, and it is not redundant with the per-Exec one:
// "a host whose last run went quiet receives no further Exec to hang a sweep off."
// The tier above gets this for free because every lease acquirer touches one shared
// ZSET, so a dead member is guaranteed to meet the next arrival
// (sandbox-lease.ts:15-17). Here the state is a per-run map, so nothing guarantees
// an arrival that would look at the quiet run.
//
// Re-arming from inside the callback is only safe because p.cfg.ReclaimScanInterval
// is guaranteed strictly positive — Config.Normalize either accepts a positive
// value or derives StandbyIdle/4 from a StandbyIdle that Normalize has already
// forced positive. That guarantee is LOAD-BEARING: fakeClock's Advance fires a
// timer whose deadline is at-or-before its target, so a self-re-arming timer with
// a zero (or negative) duration would re-arm at a deadline equal to — never past —
// the current virtual time and spin forever inside a single Advance call. Never
// arm this ticker with a duration that could be <= 0.
func (p *pool) armTickerLocked() {
	if p.closed {
		return
	}
	p.ticker = p.clk.AfterFunc(p.cfg.ReclaimScanInterval, func() {
		p.sweep(p.clk.Now())
		p.mu.Lock()
		p.armTickerLocked()
		p.mu.Unlock()
	})
}

// sweepLeases is the lease ticker's body. It re-samples the idle leases' charges, then
// sweepLeasesLocked ends the leases that are due. Measured charges grown past the budget
// are then funded in the order an admission uses (evictForAdmissionLocked): idle
// standbys first, then idle leases, idle-longest first (reclaimLeasesLocked), which also
// ends idle leases while MemAvailable is below LeaseReclaimFreeBytes -- that deficit goes
// to the leases directly (spec §6). The VMs are destroyed on the reclaim goroutine -- or
// inline when its queue is full, as sweep does -- each lease VM under its run's gate. A
// closed pool ends no lease: Close has detached the idle ones and kept their open records
// for worker_restart.
func (p *pool) sweepLeases(now time.Time) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.refreshLeaseChargesLocked()
	vs := p.sweepLeasesLocked(now)
	// After the sweep, so that a lease due to end for its own clocks ends with that reason,
	// and its charge has already left committedLocked.
	over := p.committedLocked() - (p.cfg.MaxCommittedBytes - p.cfg.MemoryReserveBytes)
	var standbys []VM
	if over > 0 {
		// A standby costs its run one cold acquire, a lease its sandbox's processes, /tmp
		// and a notice: standbys go first (PR #763 review).
		order, _ := p.standbyDonorsLocked(nil)
		var freed int64
		standbys, freed = p.shedStandbysLocked(order, over)
		over -= freed
	}
	vs = append(vs, p.reclaimLeasesLocked(now, over)...)
	if len(vs) == 0 && len(standbys) == 0 {
		p.mu.Unlock()
		return
	}
	b := reclaimBatch{vms: standbys, leases: vs}
	select {
	case p.reclaimQ <- b: // under p.mu, with p.closed false: see sweep
		p.mu.Unlock()
	default:
		p.mu.Unlock()
		p.doReclaim(b)
	}
}

// armLeaseTickerLocked schedules the next lease sweep and re-arms from inside its own
// callback, as armTickerLocked does, on its own period: LeaseScanInterval, which
// normalizeLease forces positive (the same load-bearing guarantee armTickerLocked's
// comment explains). It is a second ticker rather than a shorter ReclaimScanInterval so
// that the per-Exec sweep runs on exactly the schedule it has without lease mode. New
// arms it only when LeaseEnabled. Caller holds p.mu.
func (p *pool) armLeaseTickerLocked() {
	if p.closed {
		return
	}
	p.leaseTicker = p.clk.AfterFunc(p.cfg.LeaseScanInterval, func() {
		p.sweepLeases(p.clk.Now())
		p.mu.Lock()
		p.armLeaseTickerLocked()
		p.mu.Unlock()
	})
}
