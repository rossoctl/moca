package vmpool

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"sync/atomic"
	"time"
)

// The lease Exec path (spec §3, §4, §6, §8.4). A lease Exec keeps its VM: later Execs
// of the same workspace_key run in it, one at a time, until the lease ends, and the VM
// is then destroyed, never returned to the standbys.
//
// GATE FIRST, THEN ACQUIRE: the ordering of the E15 resident patch, which ran on a
// real rig. A per-Exec Exec acquires and then waits on the run's execGate, because
// every per-Exec Exec has its own VM. A lease Exec takes the gate before it acquires,
// so "at most one VM per key" is structural: whatever ends a lease (this path, the
// lease sweep, reclaim) holds the same gate until the old VM is destroyed, and a
// queued Exec restores a fresh VM only after that. The wait is selectable on runCtx
// and holds no VM and no charge.
//
// A lease VM is NOT counted in rp.inFlight: it is the third accounting class
// (leaseCommittedLocked), and an idle lease VM holds no concurrency slot.

// vmLease is a run's held VM in lease mode. Every field is guarded by pool.mu, but
// only the holder of the run's execGate may detach it (endLeaseLocked).
type vmLease struct {
	vm            VM
	mode          Mode
	started       time.Time     // the lease's first Exec, after Resume
	lastEnd       time.Time     // the last Exec's end: idle is measured from here (spec §4)
	idle          time.Duration // the resolved idle timeout (Config.leaseIdle), from the latest Exec
	keepalive     bool          // the keepalive-loss rule applies (spec §4); never turns off
	lastKeepalive time.Time
	expiring      bool  // past its maximum duration (sweepLeasesLocked)
	charge        int64 // the last LeaseBytes sample
	sampled       bool  // charge holds a sample
	running       bool  // an Exec is inside Run
	cancel        context.CancelFunc
	// cut is set by the lease sweep when it cancels the running Exec (grace_limit): the
	// Exec's own unwind then ends the lease with this reason and returns ErrLeaseEnded.
	cut LeaseEndReason
}

// leaseVictim is a lease VM detached from its run, its key's execGate held by
// whoever detached it. destroyLeaseVictims destroys it, then releases the gate.
type leaseVictim struct {
	key    string
	vm     VM
	gate   chan struct{}
	reason LeaseEndReason
	// rp is set for a victim of the lease sweep, which pins the run until the VM is
	// destroyed (destroySweptLeases): the sweep holds the gate but is no Exec, and an
	// unpinned run with no lease would not be busy, so WorkspaceIdle or Reclaim could
	// remove the tree under the dying VM.
	rp *runPool
}

// routeExec decides how a lease-enabled pool serves e: the effective mode, and for a
// per-Exec Exec whether a lease on the key must end first. When the mode is a lease
// mode, or endFirst is true, the key's run is pinned (busy, so neither the sweep nor
// Reclaim can delete the entry whose gate the Exec is about to wait on) and the callee
// -- execLease or endLeaseForPerExec -- releases the pin. Pinning here, in the critical
// section that resolves the mode, rather than inside execLease is what keeps the run
// that served the mode decision the run the Exec waits on.
//
// An Exec with ModeEpoch 0 is an unversioned per-Exec request (ruling R6): served
// per-Exec, never refused stale-mode, and it skips the state lookup entirely. It still
// ends a lease it finds, as any per-Exec Exec does.
func (p *pool) routeExec(key string, e Exec) (mode Mode, endFirst bool, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return 0, false, ErrClosed
	}
	if e.Mode == ModePerExec && e.ModeEpoch == 0 {
		rp := p.runs[key]
		if rp == nil || (rp.lease == nil && rp.pinned == 0) {
			return ModePerExec, false, nil
		}
		rp.pinned++
		return ModePerExec, true, nil
	}
	price := p.perVMBytes()
	if e.Mode != ModePerExec {
		price = p.cfg.LeaseStartBytes
	}
	rp, fresh, err := p.runAtLocked(key, price)
	if err != nil {
		return 0, false, p.countRefusal(err)
	}
	if fresh {
		rp.unacquired = true // acquire's runLocked will find it, not create it
	}
	if mode, err = p.effectiveModeLocked(rp, e); err != nil {
		return 0, false, err
	}
	if mode != ModePerExec {
		rp.pinned++
		return mode, false, nil
	}
	// rp.pinned > 0 is a lease-path Exec in progress, which may be about to install a
	// lease: waiting for it keeps the lease VM's destroy ahead of this Exec's restore.
	if rp.lease != nil || rp.pinned > 0 {
		rp.pinned++
		return ModePerExec, true, nil
	}
	return ModePerExec, false, nil
}

func (p *pool) unpin(rp *runPool) {
	p.mu.Lock()
	rp.pinned--
	p.mu.Unlock()
}

// endLeaseForPerExec ends key's lease, if it still has one, under the run's gate, then
// releases the gate. The caller (ExecPhased, via routeExec) pinned the run; the pin is
// released here.
func (p *pool) endLeaseForPerExec(ctx, runCtx context.Context, key string, timedOut *atomic.Bool, timeoutS uint32) error {
	p.mu.Lock()
	rp := p.runs[key] // pinned, so still the entry routeExec saw
	p.mu.Unlock()
	defer p.unpin(rp)
	select {
	case rp.execGate <- struct{}{}:
	case <-runCtx.Done():
		return p.cancelled(ctx, timedOut, timeoutS)
	}
	p.mu.Lock()
	v := p.endOrDetachLocked(rp, LeaseEndModeChange)
	p.mu.Unlock()
	if v == nil {
		<-rp.execGate
		return nil
	}
	p.destroyLeaseVictims([]*leaseVictim{v})
	return nil
}

// perExecUnderGate is a per-Exec Exec's lease step on a lease-enabled pool, run once it
// holds its VM and (on a serialising launcher) the run's gate, before Resume.
//
//   - A lease found here is ended (mode_change) and destroyed before this Exec's VM
//     mounts the workspace. routeExec ends a lease it sees BEFORE the acquire; this is
//     the backstop for one installed between routeExec and the gate, without which two
//     guests could hold the workspace mounted. Only under the gate: a launcher that
//     does not serialise has no gate to hold (and lease mode is Firecracker-only).
//   - root_wrote is recorded (spec §4: a per-Exec command runs as root), but only on a
//     key whose state is known, which means a state file exists. A key without one never
//     gains one here: SetMode treats an unknown history as root_wrote (ruling R7). A
//     failed save fails the Exec before its command runs: a lost root_wrote would let
//     the next lease skip normalising a tree root has written.
func (p *pool) perExecUnderGate(rp *runPool) error {
	var v *leaseVictim
	p.mu.Lock()
	if p.serialize {
		v = p.endOrDetachLocked(rp, LeaseEndModeChange)
	}
	err := p.markRootWroteLocked(rp)
	p.mu.Unlock()
	if v != nil {
		p.destroyLeaseVM(v.key, v.vm)
	}
	return err
}

// markRootWroteLocked sets and saves root_wrote on rp's known state. Caller holds p.mu.
func (p *pool) markRootWroteLocked(rp *runPool) error {
	s := p.leaseStateIfAnyLocked(rp)
	if !s.Known || s.RootWrote {
		return nil
	}
	s.RootWrote = true
	if err := saveLeaseState(p.cfg.WorkspaceRoot, rp.key, s); err != nil {
		return fmt.Errorf("vmpool: record root_wrote for %q: %w", rp.key, err)
	}
	rp.state = s
	return nil
}

// leaseStateIfAnyLocked is leaseStateLocked for an unversioned per-Exec Exec (ruling
// R6): a key with no state file is cached as unknown without the missing-file log
// line, so the per-Exec path on a key that never used lease mode costs one stat per
// run, not a log line. Caller holds p.mu.
func (p *pool) leaseStateIfAnyLocked(rp *runPool) leaseState {
	if !rp.stateLoaded {
		if _, err := os.Stat(leaseStatePath(p.cfg.WorkspaceRoot, rp.key)); errors.Is(err, os.ErrNotExist) {
			rp.state, rp.stateLoaded = leaseState{}, true
		}
	}
	return p.leaseStateLocked(rp)
}

// cancelled is the error for an Exec whose runCtx ended before it ran: the timeout or
// the abort, as classify tells them apart.
func (p *pool) cancelled(ctx context.Context, timedOut *atomic.Bool, timeoutS uint32) error {
	if cErr := p.classify(ctx, timedOut, timeoutS); cErr != nil {
		return cErr
	}
	return ErrAborted
}

// execLease is ExecPhased in a lease mode. runCtx carries the Exec's timeout (armed by
// ExecPhased); ctx is the caller's, for classify. The caller (routeExec) pinned key's
// run; execLease releases the pin.
//
// With a live lease it runs in the lease VM. Without one it acquires a VM priced at
// LeaseStartBytes, raises its cgroup to PerVMBytes + LeasePageCacheBytes, resumes it --
// once: the guest's latch refuses the launcher's per-Exec mount command after the
// first lease Exec -- and installs the lease. The Run carries Lease and, on the first
// Exec after root wrote the workspace, NormaliseWorkspace. A TeardownFailed result, a
// Run error or a timeout ends the lease; otherwise its lastEnd moves to now and its
// footprint is sampled, both before the gate is released.
func (p *pool) execLease(ctx, runCtx context.Context, key string, e Exec, mode Mode, out Sink, ph *Phases,
	timedOut *atomic.Bool, timeoutS uint32) (Result, error) {
	p.mu.Lock()
	rp := p.runs[key] // pinned by routeExec, so neither the sweep nor Reclaim removed it
	p.mu.Unlock()
	defer p.unpin(rp)

	select {
	case rp.execGate <- struct{}{}:
	case <-runCtx.Done():
		return Result{}, p.cancelled(ctx, timedOut, timeoutS)
	}
	defer func() { <-rp.execGate }()

	p.mu.Lock()
	l, closed := rp.lease, p.closed
	var v *leaseVictim
	if closed {
		// Close cannot take a gate this Exec holds, so this lease VM is this Exec's to
		// destroy, or it would outlive the pool.
		v = p.detachLeaseLocked(rp)
	} else if l != nil && !p.clk.Now().Before(p.leaseGraceDeadline(l)) {
		// Past the grace limit, and the lease sweep has not run since: this Exec would
		// run only to be cut at the next tick. The lease ends here, and the Exec starts
		// a fresh one.
		v, l = p.endLeaseLocked(rp, LeaseEndGraceLimit), nil
	} else if l != nil {
		// Each Exec carries the owner's current idle timeout, and a keepalive client's
		// Exec turns the keepalive rule on, for good (spec §4).
		l.idle = p.cfg.leaseIdle(e)
		if e.Keepalive {
			l.keepalive, l.lastKeepalive = true, p.clk.Now()
		}
	}
	p.mu.Unlock()
	if v != nil {
		p.destroyLeaseVM(key, v.vm)
	}
	if closed {
		return Result{}, ErrClosed
	}

	var vm VM
	if l != nil {
		vm = l.vm
		if ph != nil {
			// Nothing was acquired or resumed: zero those phases rather than leave
			// whatever a reused Phases held, as ExecPhased does for resumePhaser.
			ph.Acquire, ph.Cold, ph.Resume = 0, "", 0
			ph.VMResume, ph.VsockDial, ph.Mount = 0, 0, 0
			ph.VMID = vmID(vm)
		}
	} else {
		var err error
		if vm, err = p.startLease(ctx, runCtx, key, rp, e, mode, ph, timedOut, timeoutS); err != nil {
			return Result{}, err
		}
	}
	return p.runLease(ctx, runCtx, rp, vm, e, out, ph, timedOut, timeoutS)
}

// startLease acquires, raises the cgroup of, resumes and installs a new lease VM. Caller
// holds rp's gate. On failure the VM is destroyed and no lease is recorded: one that
// never ran an Exec never started.
func (p *pool) startLease(ctx, runCtx context.Context, key string, rp *runPool, e Exec, mode Mode, ph *Phases,
	timedOut *atomic.Bool, timeoutS uint32) (VM, error) {
	t0 := p.clk.Now()
	vm, arp, cause, err := p.acquire(runCtx, key, true)
	if ph != nil {
		ph.Acquire = p.clk.Now().Sub(t0)
		ph.Cold = cause
	}
	if err != nil {
		if cErr := p.classify(ctx, timedOut, timeoutS); cErr != nil {
			return nil, cErr
		}
		return nil, err
	}
	if ph != nil {
		ph.VMID = vmID(vm)
	}
	// acquire installed vm as arp.lease; undo that and destroy it.
	fail := func() {
		p.mu.Lock()
		if arp.lease != nil && arp.lease.vm == vm {
			arp.lease = nil
		}
		p.mu.Unlock()
		p.destroyLeaseVM(key, vm)
	}
	if arp != rp {
		// Unreachable while rp is pinned. Checked anyway: running under another run's
		// gate is the two-mounts bug.
		fail()
		return nil, fmt.Errorf("vmpool: lease: run entry for %q changed under a pinned Exec", key)
	}
	if vm.Key() != key {
		fail()
		return nil, fmt.Errorf("%w: popped %q for %q", ErrKeyMismatch, vm.Key(), key)
	}
	// The VM is live, this Exec holds its gate, and it has not run a lease Exec yet: the
	// one point LeaseCgroup may be called (Task 2's review). A failure leaves the
	// per-Exec bound in place, which still bounds the VM; the cgroup is retired, not
	// pooled, either way (LeaseCgroup marks before it writes).
	if lc, ok := vm.(leaseCgrouper); ok {
		if err := lc.LeaseCgroup(PerVMBytes(p.cfg) + p.cfg.LeasePageCacheBytes); err != nil {
			log.Printf("vmpool: lease cgroup workspace_key=%q vm=%s: %v; the VM keeps the per-Exec memory bound",
				key, vmID(vm), err)
		}
	}
	t0 = p.clk.Now()
	resumeErr := vm.Resume(runCtx)
	if ph != nil {
		ph.Resume = p.clk.Now().Sub(t0)
		if rph, ok := vm.(resumePhaser); ok {
			ph.VMResume, ph.VsockDial, ph.Mount = rph.ResumePhases()
		} else {
			ph.VMResume, ph.VsockDial, ph.Mount = 0, 0, 0
		}
	}
	if resumeErr != nil {
		fail()
		if cErr := p.classify(ctx, timedOut, timeoutS); cErr != nil {
			return nil, cErr
		}
		return nil, p.refuse(RefuseSpawn, "resume %q: %v", key, resumeErr)
	}

	p.mu.Lock()
	now := p.clk.Now()
	l := rp.lease
	l.mode, l.started, l.lastEnd = mode, now, now
	l.idle = p.cfg.leaseIdle(e)
	if e.Keepalive {
		// Not l.keepalive = e.Keepalive: a Keepalive that reached the lease while it was
		// being started has already turned the rule on.
		l.keepalive, l.lastKeepalive = true, now
	}
	s := p.leaseStateLocked(rp)
	s.Open = &openLease{VMID: vmID(vm), Mode: mode, Started: now}
	if err := saveLeaseState(p.cfg.WorkspaceRoot, key, s); err != nil {
		// Not fatal: the open record only lets the next process report this lease's
		// end as worker_restart. Serving without it loses that notice, not safety.
		log.Printf("vmpool: lease start for %q: %v", key, err)
	}
	rp.state = s
	// Standbys left from per-Exec Execs on this key go now: none may sit beside a lease
	// (replenish.go), and a leased run is busy, so the sweep would never take them.
	standbys := rp.ready
	rp.ready = nil
	for _, tm := range rp.pending {
		tm.Stop()
	}
	rp.pending = nil
	if len(standbys) > 0 && !p.closed && len(p.reclaimQ) < cap(p.reclaimQ) {
		// Under p.mu, as every reclaimQ send is: see sweep.
		p.reclaimQ <- reclaimBatch{vms: standbys}
		standbys = nil
	}
	p.mu.Unlock()
	log.Printf("vmpool: lease start workspace_key=%q vm=%s mode=%s", key, vmID(vm), mode)
	for _, sb := range standbys {
		if err := sb.Destroy(); err != nil {
			p.counters.destroyFailed()
			log.Printf("vmpool: destroy standby for leased %q: %v", key, err)
		}
	}
	return vm, nil
}

// runLease runs one command in rp's lease VM. Caller holds rp's gate.
func (p *pool) runLease(ctx, runCtx context.Context, rp *runPool, vm VM, e Exec, out Sink, ph *Phases,
	timedOut *atomic.Bool, timeoutS uint32) (Result, error) {
	// cancel lets the lease sweep cut this Exec at the grace limit (sweepLeasesLocked).
	execCtx, cancel := context.WithCancel(runCtx)
	defer cancel()
	p.mu.Lock()
	l := rp.lease
	l.running, l.cancel = true, cancel
	normalise := rp.state.RootWrote // the state is loaded: a lease mode needs a known one
	rp.lastExec = p.clk.Now()
	p.mu.Unlock()

	t0 := p.clk.Now()
	res, runErr := vm.Run(execCtx, Command{
		Command:            e.Command,
		Stdin:              e.Stdin,
		TimeoutS:           timeoutS,
		Streaming:          e.Streaming,
		CapBytes:           OutputCapBytes,
		Lease:              true,
		NormaliseWorkspace: normalise,
	}, out)
	if ph != nil {
		ph.Run = p.clk.Now().Sub(t0)
	}
	cErr := p.classify(ctx, timedOut, timeoutS)

	var reason LeaseEndReason
	switch {
	case res.TeardownFailed:
		reason = LeaseEndTeardownFailed
	case timedOut.Load(), runErr != nil:
		// The agent may have survived (a lease timeout does not kill it), but a VM
		// whose last Exec ended without an End is not one to run the next Exec in.
		reason = LeaseEndAgentDead
	}

	var v *leaseVictim
	p.mu.Lock()
	now := p.clk.Now()
	rp.lastExec = now
	live := rp.lease == l
	if live {
		l.running, l.cancel = false, nil
	}
	cut := l.cut
	if cut != "" {
		// The sweep cancelled this Run at the grace limit: that, not the Run error the
		// cancellation produced, is why the lease ends.
		reason = cut
	}
	if normalise && runErr == nil {
		// An End arrived, so the guest got past the normalisation it runs first.
		s := rp.state
		s.RootWrote = false
		if err := saveLeaseState(p.cfg.WorkspaceRoot, rp.key, s); err != nil {
			// The disk keeps root_wrote, so a later lease normalises again: safe.
			log.Printf("vmpool: clear root_wrote for %q: %v", rp.key, err)
		}
		rp.state = s
	}
	switch {
	case !live:
	case reason != "":
		v = p.endLeaseLocked(rp, reason)
	case p.closed:
		v = p.detachLeaseLocked(rp)
	default:
		l.lastEnd = now
	}
	p.mu.Unlock()

	if v != nil {
		t1 := p.clk.Now()
		p.destroyLeaseVM(v.key, v.vm)
		if ph != nil {
			ph.Destroy = p.clk.Now().Sub(t1)
		}
	} else if live {
		// Sampled under the gate, off p.mu: a cgroupfs read. Recorded for Task 6's
		// measured charge; leaseCommittedLocked still charges LeaseStartBytes (R2).
		if lf, ok := vm.(leaseFootprinter); ok {
			if b, err := lf.LeaseBytes(); err == nil && b > 0 {
				p.mu.Lock()
				if rp.lease == l {
					l.charge, l.sampled = b, true
				}
				p.mu.Unlock()
			}
		}
	}
	if cut != "" && (runErr != nil || cErr != nil) {
		// Spec §4: "An Exec in flight then fails with a lease_ended(grace_limit) error,
		// not a generic failure." A Run that finished despite the cut keeps its result.
		return res, &LeaseEndedError{Reason: cut}
	}
	if cErr != nil {
		return res, cErr
	}
	return res, runErr
}

// endLeaseLocked ends rp's lease for reason: it detaches the VM, saves Pending = {end,
// reason} and Open = nil to the key's state file, writes the audit line, and returns the
// victim for destruction outside the lock. nil when rp has no lease. The caller holds
// p.mu and rp's gate.
func (p *pool) endLeaseLocked(rp *runPool, reason LeaseEndReason) *leaseVictim {
	l := rp.lease
	v := p.detachLeaseLocked(rp)
	if v == nil {
		return nil
	}
	v.reason = reason
	now := p.clk.Now()
	age := now.Sub(l.started)
	s := p.leaseStateLocked(rp)
	s.Open = nil
	s.Pending = &LeaseEvent{State: "end", Reason: reason, At: now, Mode: l.mode, Age: age}
	if err := saveLeaseState(p.cfg.WorkspaceRoot, rp.key, s); err != nil {
		log.Printf("vmpool: lease end for %q: %v", rp.key, err)
	}
	rp.state = s
	// Idle clocks (StandbyIdle, WorkspaceIdle) run from the lease's end, not its last
	// Exec's start (Review Focus 5).
	rp.lastExec = now
	log.Printf("vmpool: lease end workspace_key=%q vm=%s mode=%s reason=%s age=%s",
		rp.key, vmID(l.vm), l.mode, reason, age.Round(time.Millisecond))
	return v
}

// detachLeaseLocked takes rp's lease VM off the run without recording an end: the
// path for a closed pool, whose state file keeps the open lease so that the next
// process reports its end as worker_restart (spec §8.4, Task 5). nil when rp has no
// lease. The caller holds p.mu and rp's gate.
func (p *pool) detachLeaseLocked(rp *runPool) *leaseVictim {
	l := rp.lease
	if l == nil {
		return nil
	}
	rp.lease = nil
	return &leaseVictim{key: rp.key, vm: l.vm, gate: rp.execGate, reason: LeaseEndWorkerRestart}
}

// endOrDetachLocked is endLeaseLocked, or detachLeaseLocked on a closed pool. Caller
// holds p.mu and rp's gate.
func (p *pool) endOrDetachLocked(rp *runPool, reason LeaseEndReason) *leaseVictim {
	if p.closed {
		return p.detachLeaseLocked(rp)
	}
	return p.endLeaseLocked(rp, reason)
}

// destroyLeaseVictims destroys each victim's VM, then releases its gate: the order that
// keeps a queued Exec from mounting the workspace while the old VM still holds it.
func (p *pool) destroyLeaseVictims(vs []*leaseVictim) {
	for _, v := range vs {
		p.destroyLeaseVM(v.key, v.vm)
		<-v.gate
	}
}

// destroyLeaseVM tears a lease VM down synchronously; the caller holds its gate. Not
// pool.destroy: a lease VM holds no inFlight charge, and its run gets no replenishment.
// The error is counted and logged here; only Close has a use for it.
func (p *pool) destroyLeaseVM(key string, vm VM) error {
	err := vm.Destroy()
	if err != nil {
		p.counters.destroyFailed()
		log.Printf("vmpool: destroy lease VM for %q: %v", key, err)
	}
	return err
}

// destroySweptLeases is destroyLeaseVictims for the lease sweep's victims: it also drops
// the pin the sweep took, once the gate is released.
func (p *pool) destroySweptLeases(vs []*leaseVictim) {
	for _, v := range vs {
		p.destroyLeaseVM(v.key, v.vm)
		<-v.gate
		p.unpin(v.rp)
	}
}

// leaseMaxDuration is how long a lease in mode m runs before it expires (spec §4): level
// 2's tracked processes get the shorter LeaseMaxDurationProcesses.
func (c Config) leaseMaxDuration(m Mode) time.Duration {
	if m == ModeLeaseProcesses {
		return c.LeaseMaxDurationProcesses
	}
	return c.LeaseMaxDuration
}

// leaseGraceDeadline is when l ends even mid-Exec: its maximum duration, then the grace
// limit an expiring lease runs on (spec §4). Caller holds p.mu.
func (p *pool) leaseGraceDeadline(l *vmLease) time.Time {
	return l.started.Add(p.cfg.leaseMaxDuration(l.mode) + p.cfg.LeaseGraceLimit)
}

// sweepLeasesLocked is the lease ticker's walk (spec §4): it marks leases past their
// maximum duration expiring, and ends each lease that is due, returning the victims for
// destroySweptLeases. Caller holds p.mu, on a pool that is not closed.
//
// A lease ends here only after a non-blocking send on its run's gate succeeds, as the
// E15 resident sweep did: a held gate means an Exec is running in the VM or about to,
// so the lease is not idle whatever its clocks say, and the sweep never waits on it.
// The gate stays held, and the run pinned, until the VM is destroyed, so an Exec that
// arrives meanwhile waits and then starts a fresh lease (Review Focus 1).
//
// grace_limit is the one reason that ends a lease whose gate is held: the sweep cancels
// the running Exec (l.cut, l.cancel), and that Exec's own unwind in runLease ends the
// lease and destroys the VM under the gate it already holds.
func (p *pool) sweepLeasesLocked(now time.Time) []*leaseVictim {
	var out []*leaseVictim
	for _, rp := range p.runs {
		l := rp.lease
		if l == nil || l.started.IsZero() {
			// No lease, or one startLease is still installing under its gate.
			continue
		}
		if !now.Before(l.started.Add(p.cfg.leaseMaxDuration(l.mode))) {
			l.expiring = true
		}
		graceOver := !now.Before(p.leaseGraceDeadline(l))
		if l.running {
			if graceOver && l.cut == "" {
				l.cut = LeaseEndGraceLimit
				l.cancel() // a context cancel: it runs no caller code under p.mu
			}
			continue
		}
		reason := p.leaseEndDueLocked(l, now, graceOver)
		if reason == "" {
			continue
		}
		select {
		case rp.execGate <- struct{}{}:
		default:
			continue // an Exec holds the gate: not idle, and never waited on
		}
		v := p.endLeaseLocked(rp, reason)
		rp.pinned++
		v.rp = rp
		out = append(out, v)
	}
	return out
}

// leaseEndDueLocked is the reason l's clocks say it ends at now, or "" (spec §4). Idle is
// measured from the last Exec's end, and a keepalive never resets it; the keepalive-loss
// rule applies only once the lease opted in. An expiring lease ends at its next idle as
// max_duration, and at the grace limit whatever its idle clock says. Caller holds p.mu.
func (p *pool) leaseEndDueLocked(l *vmLease, now time.Time, graceOver bool) LeaseEndReason {
	switch {
	case graceOver:
		return LeaseEndGraceLimit
	case l.keepalive && now.Sub(l.lastKeepalive) >= p.cfg.LeaseKeepaliveLoss:
		return LeaseEndKeepaliveLost
	case now.Sub(l.lastEnd) < l.idle:
		return ""
	case l.expiring:
		return LeaseEndMaxDuration
	}
	return LeaseEndIdle
}

// closeLeasesLocked detaches, for Close, every lease VM whose gate is free, taking the
// gate. No end is recorded: each state file keeps its open lease, so the next process
// reports the end as worker_restart (spec §8.4, Task 5). A lease whose gate is held
// belongs to an Exec, which sees p.closed and destroys the VM itself (execLease,
// runLease). Caller holds p.mu, with p.closed set.
func (p *pool) closeLeasesLocked() []*leaseVictim {
	var out []*leaseVictim
	for _, rp := range p.runs {
		if rp.lease == nil {
			continue
		}
		select {
		case rp.execGate <- struct{}{}:
		default:
			continue
		}
		out = append(out, p.detachLeaseLocked(rp))
	}
	return out
}

// Keepalive records a keepalive for key's live lease (spec §4): it turns the
// keepalive-loss rule on, for the rest of the lease, and restarts its clock. It never
// resets idle: a keepalive proves the harness runs, not that anyone is working. Without
// a live lease it is a no-op.
func (p *pool) Keepalive(key string) error {
	if err := checkKey(key); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return ErrClosed
	}
	if rp := p.runs[key]; rp != nil && rp.lease != nil {
		rp.lease.keepalive, rp.lease.lastKeepalive = true, p.clk.Now()
	}
	return nil
}
