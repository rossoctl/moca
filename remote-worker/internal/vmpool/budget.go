package vmpool

import (
	"math"
	"sort"
)

// standbyFootprinter is implemented by a launcher's VM when it can report its own
// paused dirty-page cost: its per-VM cgroup's memory.current, the bytes that standby
// is actually holding on the host right now (the guest RAM pages it dirtied itself,
// plus the VMM's and any sidecar's anonymous memory). Both real arms implement it —
// firecrackerVM reads its pooled cgroup, chvVM its systemd scope. A launcher that
// cannot — the fake launcher, or a VM placed with no ParentCgroup — is charged its
// FULL PerVMBytes by standbyChargeLocked, which is the pre-#644 posture.
//
// Called only while the VM is paused (a ready standby) and with pool.mu held, but
// implementations take their own locks and CACHE the read (see firecrackerVM.
// StandbyBytes), so the cgroupfs hit happens once per standby, not once per
// admission check.
type standbyFootprinter interface {
	StandbyBytes() (int64, error)
}

// leaseCgrouper is implemented by a launcher's VM when its cgroup can be taken out of the
// cgroup pool for a lease (spec §6, "Not from the cgroup pool"): LeaseCgroup rewrites the
// VM's cgroup memory.max to maxBytes and marks the cgroup to be retired, not released, when
// the VM is reaped. Firecracker only -- lease mode is Firecracker-only.
type leaseCgrouper interface {
	LeaseCgroup(maxBytes int64) error
}

// leaseFootprinter is implemented by a launcher's VM when it can report a running lease VM's
// host footprint: its cgroup's memory.current, read fresh on EVERY call. Unlike
// standbyFootprinter's paused standby, a lease VM runs between reads, so a cached value would
// be stale by construction.
type leaseFootprinter interface {
	LeaseBytes() (int64, error)
}

// admitOrEvictLocked is admitLocked for the two call sites whose refusal is
// USER-VISIBLE: acquire's warming charge and runLocked's new key. Caller holds p.mu.
//
// #452: a memory refusal reaching one of these is a failed exec in somebody's
// transcript, so try to make room before returning it.
//
// WHAT THIS ACTUALLY RELIEVES. One command leaves 1+StandbyDepth VMs resident, and the
// sweep only takes them back once the key has been idle for StandbyIdle (90s) — after
// which the run is parked holding zero VMs (see admitLocked's "PARKED RUNS DO NOT
// COUNT"). So committed memory tracks the sessions active in roughly the last
// StandbyIdle + ReclaimScanInterval, and it grows with the number of DISTINCT such
// sessions rather than with concurrency: on the shipped P4-on-P6 unit a handful of
// sessions each taking one turn inside that window can hold the whole budget in
// standbys while nothing is running. Without eviction those turns fail; the host then
// recovers by itself on the next sweep, so what is lost is a turn rather than the host.
//
// That bound is also why this is a burst fix and not a leak fix. It buys back the
// standbys of the coldest session inside the idle window — it does not and need not
// address anything beyond it, since past StandbyIdle there is nothing left to take. If a
// host is ever seen holding VMs for keys idle longer than that, this eviction would MASK
// it rather than fix it: that is a sweep bug and belongs in its own issue.
//
// Evicting is close to free — see evictForBudgetLocked for the cost argument.
//
// replenishOne deliberately does NOT come through here. Its refusal is already benign
// ("a refused refill is nobody's error"), and evicting a standby to manufacture
// another standby is pure churn: it moves RAM between runs without admitting any work
// that was not already admitted.
//
// ONLY THE MEMORY GATE EVICTS. Parking a run drops it out of unparkedRunsLocked, so
// this could be made to relieve the MaxRuns branch too — deliberately not done.
// MaxRuns bounds concurrent workspace KEYS and shedding a key's standbys does not
// shed the key, so using one mechanism to escape the other ceiling would re-conflate
// the two things spec §6 requires recorded distinctly. MaxRuns is also evaluated
// first inside admitLocked and a MaxRuns refusal returns here untouched, so a victim
// parked on the memory path can never retroactively widen the MaxRuns ceiling for the
// caller that caused the eviction.
func (p *pool) admitOrEvictLocked(newRun bool) error {
	return p.admitOrEvictAtLocked(newRun, p.perVMBytes())
}

// admitLeaseOrEvictLocked is admitOrEvictLocked for a new lease VM, priced at
// LeaseStartBytes (spec §6, "Order when a lease Exec needs a VM"): admit (item 1), else
// shed standbys and then idle leases, idle-longest first (item 2, evictForAdmissionLocked),
// else refuse memory-budget (item 3). Caller holds p.mu.
func (p *pool) admitLeaseOrEvictLocked(newRun bool) error {
	return p.admitOrEvictAtLocked(newRun, p.cfg.LeaseStartBytes)
}

// admitOrEvictAtLocked is admitOrEvictLocked for one VM priced at price. Caller holds p.mu.
func (p *pool) admitOrEvictAtLocked(newRun bool, price int64) error {
	err := p.admitAtLocked(newRun, price)
	if ReasonOf(err) != RefuseMemoryBudget {
		// Deliberately NOT RefuseHostMemory too. Eviction funds an admission's
		// BOOKING, which the re-admit below re-measures synchronously — but a
		// standby's pages only return to MemAvailable once reclaimLoop has
		// destroyed it, which is asynchronous, so a host-floor refusal is
		// identical before and after the attempt: the caller is refused either
		// way and the standbys are burned for nothing. Relieving host pressure
		// is not the admission path's job; a persistent RefuseHostMemory is an
		// operator signal (the refusal says which knob), not something to shed
		// standbys at.
		return err
	}
	p.evictForBudgetLocked(price)
	// Re-admitted, not assumed: eviction is best-effort (nothing idle to take, or the
	// reclaim queue already saturated), and a refusal must describe the host as it is
	// AFTER the attempt or its numbers send an operator to the wrong knob.
	return p.admitAtLocked(newRun, price)
}

// evictForBudgetLocked funds one admission (a warming charge or a new key's first
// VM, priced at price) by reclaiming standbys from idle runs. Caller holds p.mu.
// Best-effort and silent: admitOrEvictLocked re-measures rather than trusting a result.
func (p *pool) evictForBudgetLocked(price int64) {
	p.evictForAdmissionLocked(price, nil)
}

// evictForPromotionLocked funds one warm acquire: popping vm re-prices it from its
// dirty-page charge to a full PerVMBytes, so the headroom needed is only that
// DIFFERENCE — which other runs' standbys can cover, one dirty charge at a time.
// rp is the promoting run and is EXCLUDED from the victims: it is not busy yet
// (acquire marks inFlight only after the pop), so nothing else would keep the loop
// from handing the very standby being promoted to reclaimQ out from under the
// caller. Caller holds p.mu.
func (p *pool) evictForPromotionLocked(rp *runPool, vm VM, price int64) {
	p.evictForAdmissionLocked(price-p.standbyChargeLocked(vm), rp)
}

// evictForAdmissionLocked makes `need` bytes of budget headroom by reclaiming
// standbys from the least-recently-used IDLE runs, `exclude` never a victim.
// Caller holds p.mu. Best-effort and silent: every caller re-measures rather than
// trusting a result.
//
// AS MUCH AS THE ADMISSION NEEDS, NOT ONE VM (#644). Under the pre-#644 full-RAM
// charge one standby WAS one VM's worth of budget, so a single eviction always
// covered a refusal's shortfall (committed <= budget means the shortfall is at most
// one PerVMBytes). Under dirty-page charging a standby frees only its dirty-page
// charge, so funding one full-price admission can take several: on SBX0 (perVM
// ~4128 MiB against a 32 MiB floor) as many as ~129. Victims are gathered
// coldest-run-first until their combined charge covers the shortfall, then handed
// to reclaimLoop as ONE batch — one reclaimQ slot per call regardless of how many
// VMs it sheds, so a large funding can no longer fill the queue (cap 64) halfway
// and leave the sweep destroying inline on the hot path. The gather degenerates to
// the old single eviction under SH_STANDBY_HEADROOM=full, where one standby's
// charge is again one whole VM.
//
// FUTILITY IS CHECKED BEFORE ANYTHING IS DETACHED. If every evictable standby's
// charge summed cannot cover the shortfall, the re-admit that follows will refuse
// identically — evicting anyway would burn the coldest runs' warm state for a
// refusal the caller suffers regardless, which is the reclaim-storm shape spec §6
// names, reached from the hot path. Refuse instead; the standbys stay for a
// running VM's release to matter.
//
// This is sweepOnce's RunActive -> RunParked transition fired by memory pressure
// instead of by the clock: drop standbys, STOP the replenish timers that would
// refill them, KEEP the workspace. Not firing the WorkspaceIdle half matters — a
// memory signal is about RAM, and deleting a live session's tree to make room for
// a different session would turn a recoverable cold start into #338's silent reset.
//
// WHY THIS IS CHEAP AND A REFUSAL IS NOT. An eviction costs the victim one cold
// acquire — the exact outcome StandbyIdle (90s) already produces for any run that
// goes quiet, with the workspace still on disk, so spec §4.4's "RAM is urgent and
// disk is not" is honoured rather than bypassed. A refusal costs the requesting
// session its turn.
//
// LRU BY lastExec, the same clock sweepOnce's idleFor reads, so eviction order and
// sweep order cannot disagree about which run is coldest.
//
// IDLE LEASES ARE THE SECOND SOURCE (spec §6, Task 6). When the standbys cannot cover
// the shortfall, reclaimLeasesLocked ends idle leases, idle-longest first, memory_reclaim,
// skipping any whose gate is held. Their destroys ride the same batch. On a pool with no
// lease this adds nothing: no lease bytes to count, no lease to take.
//
// A BUSY RUN IS NEVER A CANDIDATE, for sweepOnce's reason: rp.busy() staying true is
// what stops a reclaim landing under a running command. Together with `exclude`
// that makes self-eviction impossible at all three call sites — runLocked's key has
// no runPool yet, and acquire's two paths pass either a busy run (its second warm
// acquire) or the excluded promoting run (its first).
func (p *pool) evictForAdmissionLocked(need int64, exclude *runPool) {
	// The send below happens UNDER p.mu and must not block, which this check is what
	// guarantees. Every sender (here and sweep) holds p.mu, so they are totally ordered
	// against each other, and reclaimLoop only ever drains — so capacity observed here
	// cannot be taken by anyone else before the send. A full queue means reclamation is
	// already behind, which is precisely the state where detaching more VMs would not
	// free memory any sooner: refuse instead. Checked BEFORE anything leaves a ready
	// list, so a full queue costs nothing rather than losing a batch.
	if p.closed || len(p.reclaimQ) >= cap(p.reclaimQ) {
		return
	}
	budget := p.cfg.MaxCommittedBytes - p.cfg.MemoryReserveBytes
	shortfall := budget - p.committedLocked() - need
	if shortfall >= 0 {
		// The admission fits already; nothing to fund. (Reachable on the promotion
		// path, where need is perVM minus the standby's own charge.)
		return
	}

	// Order the donor runs coldest-first and total what they could shed. The same
	// pass serves the futility check: if evictable < shortfall there is no point
	// detaching anything.
	var (
		order     []*runPool
		evictable int64
	)
	for _, rp := range p.runs {
		if rp == exclude || rp.busy() || len(rp.ready) == 0 {
			continue
		}
		order = append(order, rp)
		for _, vm := range rp.ready {
			evictable += p.standbyChargeLocked(vm)
		}
	}
	// Idle leases are the second source (spec §6), so the futility check counts what
	// reclaimLeasesLocked could take too. Zero on a pool with no lease.
	if evictable+p.reclaimableLeaseBytesLocked() < -shortfall {
		return
	}
	sort.Slice(order, func(i, j int) bool { return order[i].lastExec.Before(order[j].lastExec) })

	var (
		batch []VM
		freed int64
	)
gather:
	for _, rp := range order {
		for len(rp.ready) > 0 {
			// Top of the ready list first, the same end acquire pops from.
			n := len(rp.ready) - 1
			vm := rp.ready[n]
			batch = append(batch, vm)
			freed += p.standbyChargeLocked(vm)
			rp.ready = rp.ready[:n]
			if len(rp.ready) == 0 {
				// Stopping these is load-bearing, not tidiness: a pending replenishment would
				// restore exactly the standby just evicted and re-consume the budget this call
				// exists to free, turning one admission into a refill race.
				for _, tm := range rp.pending {
					tm.Stop()
				}
				rp.pending = nil
				rp.parked = true
			}
			if freed >= -shortfall {
				break gather
			}
		}
	}
	// Standbys first, then idle leases (spec §6): a standby costs its run a cold acquire,
	// a lease costs its sandbox its processes and a lease_start notice. Reached only when
	// idle leases exist, since the standbys alone would otherwise have covered the
	// shortfall or the futility check returned.
	var leases []*leaseVictim
	if freed < -shortfall {
		leases = p.reclaimLeasesLocked(p.clk.Now(), -shortfall-freed)
	}
	if len(batch) == 0 && len(leases) == 0 {
		return // every idle lease's gate was taken since it was counted
	}
	for range batch {
		p.counters.evicted()
	}
	// One slot for both: doReclaim destroys the leases first, each under its gate.
	p.reclaimQ <- reclaimBatch{vms: batch, leases: leases}
}

// admitLocked decides whether one more VM may be committed. Caller holds p.mu.
//
// TWO CEILINGS, RECORDED DISTINCTLY. Spec §6: "A memory-driven refusal is recorded
// distinctly from a MaxRuns refusal, or the two ceilings get conflated and neither
// is diagnosable." E11 reports ExecErrors by cause for exactly this reason (§7.3).
//
// MaxRuns IS A BACKSTOP, not primary admission control. There is no "busy" frame in
// the wire contract, so a MaxRuns refusal reaches the harness as a failed exec
// rather than as back-pressure — while the harness already has the right mechanism
// one tier up: SandboxPoolSaturatedError at lease time under KAGENTI_SANDBOX_CAP.
// The consistency requirement is therefore
//
//	MaxRuns >= cap x (records this worker advertises)
//
// and violating it refuses work the harness believed it had capacity for, which is
// P6 §3.9's spurious-429s-truncate-the-rungs failure one tier down.
//
// PARKED RUNS DO NOT COUNT, and that is what makes the condition above true rather
// than aspirational. It used to count len(p.runs), which includes the parked entries
// the sweep deliberately keeps for WorkspaceIdle (30 minutes by default) — and a
// parked run holds ZERO VMs by construction, since sweepOnce only sets parked once
// len(rp.ready) has reached zero on a run that is not busy. With the shipped
// SH_MAX_RUNS=64, 64 short-lived sandboxes finishing inside a minute left 64
// zero-VM parked entries, and the 65th lease the harness legitimately granted was
// refused RefuseMaxRuns for the next ~29 minutes while nothing was resident. During
// E11 that would read as back-pressure from the tier rather than as the bug it is.
// Pool.Reclaim is the only thing that releases a key early and it has no production
// caller, so nothing else was going to shorten that window.
//
// What still bounds the parked set is WorkspaceIdle, and what it costs is disk rather
// than RAM (spec §4.4's whole reason for two thresholds). What bounds VMs is the
// memory gate below, which counts every VM a parked run does not have.
//
// The memory gate exists so spec §7.4's prediction 1 ("replenishment binds on
// process/memory count before CPU") is observable AS BACK-PRESSURE. Without it the
// prediction would be "confirmed" by the host falling over, which is not a
// measurement.
func (p *pool) admitLocked(newRun bool) error {
	return p.admitAtLocked(newRun, p.perVMBytes())
}

// admitLeaseLocked is admitLocked for a new lease VM: the same two ceilings, with the VM
// priced at LeaseStartBytes rather than PerVMBytes (spec §6: a lease VM is charged its
// starting estimate until it is measured). Caller holds p.mu.
func (p *pool) admitLeaseLocked(newRun bool) error {
	return p.admitAtLocked(newRun, p.cfg.LeaseStartBytes)
}

// admitAtLocked is admitLocked for one VM priced at price. Caller holds p.mu.
func (p *pool) admitAtLocked(newRun bool, price int64) error {
	if unparked := p.unparkedRunsLocked(); newRun && unparked >= p.cfg.MaxRuns {
		return refusal(RefuseMaxRuns,
			"MaxRuns=%d reached with %d unparked runs (%d entries incl. parked); the lease cap "+
				"one tier up is primary admission control and this is its backstop (spec §6)",
			p.cfg.MaxRuns, unparked, len(p.runs))
	}
	if err := p.hostFloorLocked(); err != nil {
		return err
	}
	committed := p.committedLocked()
	budget := p.cfg.MaxCommittedBytes - p.cfg.MemoryReserveBytes
	if next := committed + price; next > budget {
		return refusal(RefuseMemoryBudget,
			"committing %d more bytes would reach %d against a budget of %d "+
				"(MaxCommittedBytes %d less MemoryReserveBytes %d)",
			price, next, budget, p.cfg.MaxCommittedBytes, p.cfg.MemoryReserveBytes)
	}
	return nil
}

// admitPromotionLocked re-prices one ready standby at its full PerVMBytes and
// refuses if that would exceed the budget — the invariant that makes dirty-page
// charging safe (#644): a host that books standbys at their measured cost must not
// be able to promote more of them to running than it could have admitted cold.
// Called from acquire's warm path, BEFORE the pop.
//
// THE CHECK ITSELF IS PURE, DELIBERATELY. It mutates nothing, so a refusal leaves
// the standby exactly where it was — and the pop's slice arithmetic, captured
// before the check, stays valid whatever the call site does next. Funding is the
// CALL SITE's job (see acquire): on RefuseMemoryBudget it evicts other runs'
// standbys via evictForPromotionLocked — which needs only perVM minus this
// standby's dirty charge of headroom, an amount other runs' dirty charges can
// cover — and re-checks. Keeping the eviction out of this function is what keeps
// the promoting run's own standbys out of the victim set: the run is not busy yet
// at first promotion (inFlight is incremented only after the pop), so an evicting
// variant could hand the very standby being promoted to reclaimQ out from under
// the caller.
//
// A promotion is REFUSED, not evicted-forever, when eviction cannot fund it: no
// idle standbys elsewhere, or a running set already so close to the budget that
// even shedding every standby would not close the gap. On a host sized so that
// slots x PerVMBytes fits the budget — the arithmetic slotBudgetWarning warns
// about at startup — neither ever fires: admissions alone cannot take the running
// component to the budget, so no promotion can either. They fire only on a
// mis-sized or standby-saturated host, where a failed exec is the correct
// alternative to the OOM killer arbitrating (spec §6).
func (p *pool) admitPromotionLocked(vm VM) error {
	return p.admitPromotionAtLocked(vm, p.perVMBytes())
}

// admitPromotionAtLocked is admitPromotionLocked re-pricing the standby at price: a
// per-Exec VM's PerVMBytes, or a new lease VM's LeaseStartBytes (spec §6). Caller holds p.mu.
func (p *pool) admitPromotionAtLocked(vm VM, price int64) error {
	if err := p.hostFloorLocked(); err != nil {
		return err
	}
	budget := p.cfg.MaxCommittedBytes - p.cfg.MemoryReserveBytes
	// committedLocked already books vm at its dirty-page charge; replace that with
	// the full price it is one Resume away from costing.
	standby := p.standbyChargeLocked(vm)
	if next := p.committedLocked() - standby + price; next > budget {
		return refusal(RefuseMemoryBudget,
			"promoting a standby would re-price it from %d to %d committed bytes, reaching %d "+
				"against a budget of %d (MaxCommittedBytes %d less MemoryReserveBytes %d): the "+
				"running set is at the memory ceiling. WORKER_MAX_CONCURRENT x PerVMBytes must fit "+
				"the budget, or warm acquires fail as the slot count fills",
			standby, price, next, budget, p.cfg.MaxCommittedBytes, p.cfg.MemoryReserveBytes)
	}
	return nil
}

// hostFloorLocked is #644's host backstop: an opt-in floor on the host's own
// MemAvailable, checked beside the budget arithmetic so that dirty-page accounting
// is never the only protection between the pool and the OOM killer. Off unless
// Config.HostMemFloorBytes is set.
//
// Reads the ~100ms cache (hostmem.go), not the file: this runs under p.mu on every
// admission and warm acquire, and MemAvailable does not move fast enough for the
// staleness to matter to a backstop.
//
// FAILS CLOSED on an unreadable /proc/meminfo: "cannot tell" is not "plenty" (the
// same posture cgroupPool.release takes), and a backstop that silently disables
// itself on the one host where its input is broken is not a backstop. On a host
// with no /proc/meminfo at all the operator has no business configuring a
// MemAvailable floor, which is why this is opt-in rather than defaulted.
//
// Refuses with RefuseHostMemory, DISTINCT from RefuseMemoryBudget (spec §6's
// requirement that refusal causes stay separable): a budget refusal means the
// operator sized SH_MAX_COMMITTED_MB wrong, a host-floor refusal means the host is
// genuinely running out — different knobs, different diagnoses, and AM6's ladder
// needs to tell them apart at the stopping rung.
func (p *pool) hostFloorLocked() error {
	if p.cfg.HostMemFloorBytes <= 0 {
		return nil
	}
	avail, err := cachedMemAvailable()
	if err != nil {
		return refusal(RefuseHostMemory,
			"host memory floor is %d MiB but MemAvailable is unreadable: %v — refusing rather "+
				"than admitting blind (set HostMemFloorBytes to 0 to disable the backstop)",
			p.cfg.HostMemFloorBytes>>20, err)
	}
	if avail < p.cfg.HostMemFloorBytes {
		return refusal(RefuseHostMemory,
			"host MemAvailable is %d MiB, below the %d MiB floor (HostMemFloorBytes): the host "+
				"is running out of memory regardless of the pool's budget arithmetic",
			avail>>20, p.cfg.HostMemFloorBytes>>20)
	}
	return nil
}

// unparkedRunsLocked counts the runs MaxRuns is about: those not sitting in RunParked
// with zero VMs. Caller holds p.mu.
//
// Deliberately NOT the same quantity as Stats().ActiveRuns, which counts every map entry
// and reports the parked subset separately — Stats describes what the host is holding
// (including workspaces on disk), while this describes what the ceiling is for. The
// relationship is ActiveRuns - ParkedRuns == this.
func (p *pool) unparkedRunsLocked() int {
	n := 0
	for _, rp := range p.runs {
		if !rp.parked {
			n++
		}
	}
	return n
}

// committedLocked is every VM this host is holding, in bytes, SPLIT BY STATE (#644).
//
// RUNNING AND WARMING VMs are charged their full PerVMBytes: a VM that is
// executing, or restoring in order to execute, is one Resume away from its whole
// guest RAM and is priced accordingly. Their total is bounded twice over — by this
// gate and by admitPromotionLocked — so the running component can never exceed the
// budget, which is what makes the paused component's cheaper charge safe.
//
// PAUSED STANDBYS are charged at DIRTY-PAGE COST (standbyChargeLocked): their
// measured per-VM cgroup memory.current times StandbyHeadroom. Until #644 they
// were charged their FULL guest RAM — the position the comment here used to defend
// ("a standby is one Resume away from consuming all of it") — and that full-RAM
// booking was the density ceiling on the SBX0 shape (4 GiB guests, D=2, 172 GiB
// budget: ~14-22 concurrent sandboxes on a host that was nearly idle). E11 sampled
// 306 per-VM cgroups at 0.9 MiB mean / 2 MiB max against a 288 MiB limit — 144x
// below the charge — because every VM COW-shares one page-cache-resident memfile;
// AM6 stopped every microVM ladder rung on RefuseMemoryBudget with 150-178 GiB of
// 188 still free. The full-RAM charge double-counted a hazard the slot count
// already bounds: only WORKER_MAX_CONCURRENT VMs can run at any moment, and the
// one-Resume-away hazard is now paid at the right moment — admitPromotionLocked
// re-prices a standby at PerVMBytes at pop time. What dirty-page charging buys is
// that the ~99% of a standby's booking that is CoW-shared page cache stops
// consuming budget no running VM will ever claim; a standby over budget is now
// something eviction can shed (evictForBudgetLocked) rather than a refusal.
//
// WARMING IS CHARGED FULL, STANDBY-DESTINED OR NOT, deliberately diverging from
// #644's sketch (which lumps warming into the dirty component). A warming VM has
// no footprint to read at the moment admitLocked prices it — its cgroup exists
// and is empty — and rp.warming does not distinguish a replenishment that will
// park from a cold acquire that will run. Charging both at full price is
// pessimistic only for the 10-25 ms of the restore, and self-limiting in the
// right direction: a host too full to promote a standby is too full to be
// building one. It also keeps the warming -> inFlight handoff in acquire
// charge-neutral, exactly as before.
//
// LEASE VMs ARE THE THIRD CLASS (spec §6): neither standby nor in-flight, charged their
// measured footprint (leaseChargeLocked) whether an Exec is running in them or not.
func (p *pool) committedLocked() int64 {
	return p.runningCommittedLocked() + p.standbyCommittedLocked() + p.leaseCommittedLocked()
}

// leaseCommittedLocked is the lease component of committedLocked: every live lease VM at
// leaseChargeLocked, and every cold restore for one at LeaseStartBytes. Caller holds p.mu.
//
// Zero on a pool with no lease, which is what keeps the per-Exec arithmetic unchanged.
func (p *pool) leaseCommittedLocked() int64 {
	var n int64
	for _, rp := range p.runs {
		n += int64(rp.warmingLease) * p.cfg.LeaseStartBytes
		if rp.lease != nil {
			n += p.leaseChargeLocked(rp.lease)
		}
	}
	return n
}

// leaseChargeLocked is what one lease VM costs the budget (spec §6): LeaseStartBytes until
// its first sample, then its measured memory.current times LeaseHeadroom, floored at
// VMOverheadBytes, idle or busy. Caller holds p.mu.
//
// NEVER RE-PRICED TO PerVMBytes, also while an Exec runs in it: a lease VM's growth
// during a long Exec is caught by the next sample (runLease after each Exec, the lease
// ticker for an idle lease) and by reclaim, not by a reservation. No cap either, unlike
// standbyChargeLocked: a lease VM's memory.max is PerVMBytes + LeasePageCacheBytes, so its
// charge can legitimately pass PerVMBytes (the spec's charge bound), and
// LeaseReclaimFreeBytes is sized against that bound. THE FLOOR has standbyChargeLocked's
// reason: a live VMM is always resident, so a smaller read is not a cheaper VM.
func (p *pool) leaseChargeLocked(l *vmLease) int64 {
	if !l.sampled {
		return p.cfg.LeaseStartBytes
	}
	// Scaled in float64 and clamped before the conversion, as standbyChargeLocked does.
	scaled := float64(l.charge) * p.cfg.LeaseHeadroom
	if scaled >= math.MaxInt64 {
		return math.MaxInt64
	}
	return max(int64(scaled), p.cfg.VMOverheadBytes)
}

// runningCommittedLocked is the full-price component of committedLocked: every VM
// that is executing or restoring, at PerVMBytes each. Caller holds p.mu.
func (p *pool) runningCommittedLocked() int64 {
	var vms int64
	for _, rp := range p.runs {
		vms += int64(rp.inFlight + rp.warming)
	}
	return vms * p.perVMBytes()
}

// standbyCommittedLocked is the paused component of committedLocked: every ready
// standby at its dirty-page charge. Caller holds p.mu.
func (p *pool) standbyCommittedLocked() int64 {
	var total int64
	for _, rp := range p.runs {
		for _, vm := range rp.ready {
			total += p.standbyChargeLocked(vm)
		}
	}
	return total
}

// standbyChargeLocked is what one paused standby costs the budget: its measured
// dirty-page footprint times StandbyHeadroom, floored at VMOverheadBytes and
// capped at PerVMBytes. Caller holds p.mu.
//
// THE FLOOR is VMOverheadBytes because a live VMM and its sidecar are always
// resident somewhere in the cgroup's charge, so an honest read cannot be smaller —
// and treating a smaller read as free is the one direction this arithmetic must
// not err in. THE CAP mirrors the per-VM cgroup memory.max both launchers set from
// this same PerVMBytes (spec §5.3's one-number rule), so the charge can never
// exceed what the kernel would let the VM physically take anyway.
//
// A VM that cannot report a footprint — the fake launcher, no ParentCgroup, an
// unreadable cgroup — is charged its FULL PerVMBytes: "cannot tell" is not
// "cheap", the same posture cgroupPool.release takes. This is also the escape
// hatch: SH_STANDBY_HEADROOM=full pins every standby at the pre-#644 price.
func (p *pool) standbyChargeLocked(vm VM) int64 {
	perVM := p.perVMBytes()
	if math.IsInf(p.cfg.StandbyHeadroom, 1) {
		return perVM
	}
	sf, ok := vm.(standbyFootprinter)
	if !ok {
		return perVM
	}
	dirty, err := sf.StandbyBytes()
	if err != nil || dirty <= 0 {
		return perVM
	}
	// Scaled and clamped in float64 BEFORE the conversion, so a large-but-finite
	// headroom cannot overflow int64 arithmetic on its way to the cap.
	scaled := float64(dirty) * p.cfg.StandbyHeadroom
	if scaled >= float64(perVM) {
		return perVM
	}
	if charge := int64(scaled); charge > p.cfg.VMOverheadBytes {
		return charge
	}
	return p.cfg.VMOverheadBytes
}

// countRefusal records an already-built refusal and returns it unchanged, so the
// construction site keeps the detailed message and the counting stays in one place.
func (p *pool) countRefusal(err error) error {
	if r := ReasonOf(err); r != "" {
		p.counters.refuse(r)
	}
	return err
}
