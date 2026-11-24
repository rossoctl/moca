package vmpool

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"slices"
	"sort"
	"sync"
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
// (leaseCommittedLocked, leaseChargeLocked), and an idle lease VM holds no concurrency slot.

// LeaseTimeoutSlack is how much later than the Exec's budget the host gives up on a
// lease Exec (PR #763 review, ruling R8b). The guest's own timeout, armed from what is left
// of the budget when Run starts (leaseGuestTimeoutS), fires first: the guest kills the
// Exec's cgroup and answers, and the lease is kept. Only a guest that has not answered
// within the slack too is taken for dead. 8 s (ruling R21): the guest's timeout is rounded
// up by up to 1 s, and its teardown may take up to its 5 s bound before it answers. Per-Exec
// Execs get no slack.
const LeaseTimeoutSlack = 8 * time.Second

// LeaseAbortGrace is how long the host waits for the guest's answer to its abort of a
// lease command (runLease, Command.Abort; F3 of the E17b report) before it cancels the Run
// and ends the lease agent_dead. The guest's teardown may take up to its 5 s bound before it
// answers, which is the slack's reasoning without the timeout's rounding: the same 8 s.
const LeaseAbortGrace = LeaseTimeoutSlack

// LeaseNormaliseTimeout bounds a lease start's normalise step (normaliseLease), the guest's
// ownership walk of the workspace: the step's own timeout_s, with the host giving up
// LeaseTimeoutSlack later. It is not charged to the Exec's budget (PR #763 second review,
// G2): a walk over a big tree may take far longer than a short command's timeout.
const LeaseNormaliseTimeout = 10 * time.Minute

// leaseCacheDropS is d as the guest's cache_drop_after_s: whole seconds, rounded up, and
// 0 (never) for a negative d, the drop turned off.
func leaseCacheDropS(d time.Duration) uint32 {
	if d <= 0 {
		return 0
	}
	return uint32((d + time.Second - 1) / time.Second)
}

// leaseGuestTimeoutS is the timeout_s a lease Exec's guest gets when Run starts at now:
// what is left of the budget until deadline, rounded up to whole seconds, and at least 1 s.
// The gate wait, a cold restore and Resume have spent the rest.
func leaseGuestTimeoutS(deadline, now time.Time) uint32 {
	left := deadline.Sub(now)
	if left <= time.Second {
		return 1
	}
	return uint32((left + time.Second - 1) / time.Second)
}

// errServePerExec is execLease's answer when, under the gate, the Exec's served mode is
// per-exec: a same-epoch SetMode(per-exec) landed while it queued. The lease, if any, has
// ended (mode_change) and the gate is released; ExecPhased runs the Exec per-Exec.
var errServePerExec = errors.New("vmpool: serve per-Exec")

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
	// cut is set by the lease sweep when it cancels the running Exec (grace_limit), or
	// by endLeaseWaiting at its grace bound: the Exec's own unwind then ends the lease
	// with this reason and returns ErrLeaseEnded. Set on a lease no Exec is running in,
	// it is sticky: whoever takes the gate next ends the lease with this reason
	// (endLeaseLocked prefers it), and a lease Exec that finds it set before Run fails
	// lease_ended(<reason>) without ever calling Run (execLease, runLease).
	cut LeaseEndReason
	// gone is closed when the lease leaves its run (detachLeaseLocked, or startLease's
	// failure path): what endLeaseWaiting waits on once it has cut the lease.
	gone chan struct{}
	// tracked mirrors the guest's tracked-process table (plan 5): replaced from every
	// lease End's Tracked (refreshTrackedLocked), never edited in place, so a copy of the
	// slice header is a snapshot. Lease ends and LeaseStatus list it.
	tracked []TrackedProcess
	// stopTracked is set when the lease leaves level 2 (setLeaseLevelLocked): the guest's
	// tracked processes are stopped by the next holder of the run's gate -- the set_mode
	// downgrade's wait (stopTrackedWaiting) or a lease Exec (execLease), whichever gets it
	// first -- before anything else runs in the lease (stopTrackedUnderGate).
	stopTracked bool
}

func newVMLease(vm VM) *vmLease { return &vmLease{vm: vm, gone: make(chan struct{})} }

// leaseVictim is a lease VM detached from its run, its key's execGate held by
// whoever detached it. destroyLeaseVictims destroys it, then releases the gate.
type leaseVictim struct {
	key    string
	vm     VM
	gate   chan struct{}
	reason LeaseEndReason
	// sync is set when the guest's page cache may hold workspace writes no Exec has synced:
	// a level-2 lease, or one with tracked processes, whose guest may still be alive. The
	// VM is then synced before it is destroyed (destroyLeaseVictim).
	sync bool
	// rp is set for a victim of the lease sweep, which pins the run until the VM is
	// destroyed (destroySweptLeases): the sweep holds the gate but is no Exec, and an
	// unpinned run with no lease would not be busy, so WorkspaceIdle or Reclaim could
	// remove the tree under the dying VM.
	rp *runPool
	// mode and tracked are the lease's level and its tracked mirror when it was detached,
	// and endAt the At of the end event endLeaseLocked saved (zero for a detach, whose open
	// record stays). The sync step's table is diffed against tracked, and refreshes that
	// end, or that open record (ruling P5-R38: refreshEndedTracked).
	mode    Mode
	tracked []TrackedProcess
	endAt   time.Time
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

// unpinKey releases the pin routeExec took on key's run, which a pin keeps in p.runs.
func (p *pool) unpinKey(key string) {
	p.mu.Lock()
	p.runs[key].pinned--
	p.mu.Unlock()
}

// checkProcessKind is the up-front rule for an Exec of a kind other than a command (plan
// 5): an unknown kind, or a process kind on a snapshot without lease-processes-v1, is
// lease_unsupported -- never run as a command -- and a process kind at a mode below
// lease+processes is processes_not_enabled. The served mode, which a same-epoch downgrade
// may lower, is checked again under the gate (execLease).
func (p *pool) checkProcessKind(key string, e Exec) error {
	switch {
	case !e.Kind.isProcess():
		return p.refuse(RefuseLeaseUnsupported, "Exec for %q: unknown kind %q", key, string(e.Kind))
	case !LeaseProcessesSupported(p.cfg):
		return p.refuse(RefuseLeaseUnsupported, "%s for %q: %s", e.Kind, key, leaseProcessesUnsupportedDetail)
	case e.Mode != ModeLeaseProcesses:
		return p.processesNotEnabled(key, e.Kind, e.Mode)
	}
	return nil
}

// processesNotEnabled is the refusal of a process kind served at mode m (spec §7).
func (p *pool) processesNotEnabled(key string, k ExecKind, m Mode) error {
	return p.refuse(RefuseProcessesNotEnabled, "%s for %q: this sandbox's mode is %s", k, key, m)
}

const leaseProcessesUnsupportedDetail = "process kinds need the Firecracker arm and a snapshot with the " +
	FeatureLeaseProcessesV1 + " feature"

// answerWithoutLease answers process_list, process_logs and process_stop on a key with no
// live lease, as the guest would with an empty table: an empty list, or process_not_found.
// No lease starts for them; only process_start (or a command) has a reason to start one.
func answerWithoutLease(e Exec, out Sink) (Result, error) {
	if e.Kind == ExecKindProcessList {
		out.Stdout([]byte("[]"))
		return Result{}, nil
	}
	name := e.Process.ID
	if name == "" {
		name = e.Process.Name
	}
	if name == "" {
		return Result{}, &ProcessError{Msg: "process_not_found: no id or name given"}
	}
	return Result{}, &ProcessError{Msg: "process_not_found: " + name}
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
		p.destroyLeaseVictim(v)
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
// ExecPhased, at the budget's end until runLease calls extend); ctx is the caller's, for
// classify. The caller (routeExec) pinned key's run; execLease releases the pin.
//
// With a live lease it runs in the lease VM. Without one it acquires a VM priced at
// LeaseStartBytes, raises its cgroup to PerVMBytes + LeasePageCacheBytes, resumes it --
// once: the guest's latch refuses the launcher's per-Exec mount command after the
// first lease Exec -- takes the normalise step when root wrote the workspace
// (normaliseLease), and installs the lease. The Run carries Lease. A TeardownFailed
// result, a Run error, the host's deadline or an abort the guest did not answer cleanly
// ends the lease; otherwise, the guest's own timeout, a command's clean abort and
// ErrCommandTooLarge included (runLease), its lastEnd moves to
// now and its footprint is sampled, both before the gate is released. deadline is when the Exec's budget ends.
//
// A process kind (plan 5) is refused processes_not_enabled unless lease+processes is
// served, and process_list, process_logs and process_stop with no live lease are answered
// here without starting one (answerWithoutLease). A lease that has left level 2 -- by this
// Exec's epoch (ruling R18), or by a set_mode whose own wait this Exec beat to the gate --
// has its tracked processes stopped first (stopTrackedUnderGate), a refused process kind's
// Exec included. The Exec then carries the processes_stopped notice in its Result, and
// when the stop ends the lease (teardown_failed), it starts a fresh one, as after a
// grace-limit end.
func (p *pool) execLease(ctx, runCtx context.Context, key string, e Exec, mode Mode, out Sink, ph *Phases,
	timedOut *atomic.Bool, timeoutS uint32, deadline time.Time, extend func(time.Time) bool) (Result, error) {
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
	if s := rp.state; !closed && s.Known && e.ModeEpoch < s.Epoch {
		// A downgrade (SetMode) stored a newer epoch while this Exec waited on the gate:
		// its mode is no longer the sandbox's, so it neither starts nor reuses a lease.
		p.mu.Unlock()
		return Result{}, p.refuse(RefuseStaleMode, "workspace_key %q: Exec mode_epoch %d is below the stored %d",
			key, e.ModeEpoch, s.Epoch)
	}
	// The served mode, recomputed under the gate (review M1): a same-epoch SetMode that
	// landed while this Exec queued lowers it, as effectiveModeLocked would have, so the
	// Exec neither re-levels the lease back up nor runs in a lease after a downgrade to
	// per-exec.
	served := mode
	if s := rp.state; s.Known && e.ModeEpoch == s.Epoch {
		served = min(e.Mode, s.Mode)
	}
	// A process kind needs lease+processes served (spec §7). Refused after a level change
	// its epoch carries, and after a same-epoch downgrade to per-exec ends the lease, as for
	// a command; never served per-Exec.
	processRefused := e.Kind.isProcess() && served != ModeLeaseProcesses
	var v *leaseVictim
	var cut LeaseEndReason
	perExec := false
	if closed {
		// Close cannot take a gate this Exec holds, so this lease VM is this Exec's to
		// destroy, or it would outlive the pool.
		v = p.detachLeaseLocked(rp)
	} else if l != nil && l.cut != "" {
		// A caller ended this lease while this Exec queued (endLeaseWaiting's grace
		// bound, with no Exec running to cancel): the lease ends here with that reason,
		// and this Exec, in flight at the end, fails lease_ended(<reason>). It runs
		// nothing: not in the cut VM, whose guest the end is there to retire (reset,
		// spec §11), and not in a fresh one.
		cut = l.cut
		v = p.endLeaseLocked(rp, cut)
	} else if served == ModePerExec {
		// Downgraded to per-exec at this Exec's epoch while it queued: the lease ends
		// (mode_change) under this gate, before the Exec runs per-Exec (ExecPhased).
		perExec = true
		v = p.endLeaseLocked(rp, LeaseEndModeChange) // nil without a lease
	} else if l != nil {
		// A level change carried by this Exec's epoch applies first, under the gate and
		// before Run, so the grace check below and the sweep from now on use the new
		// level's maximum duration (ruling R18).
		p.relevelLeaseForExecLocked(rp, l, served)
		if processRefused {
			// Refused below; the lease is untouched.
		} else if !p.clk.Now().Before(p.leaseGraceDeadline(l)) {
			// Past the grace limit, and the lease sweep has not run since: this Exec would
			// run only to be cut at the next tick. The lease ends here, and the Exec starts
			// a fresh one.
			v, l = p.endLeaseLocked(rp, LeaseEndGraceLimit), nil
		} else {
			// Each Exec carries the owner's current idle timeout, and a keepalive client's
			// Exec turns the keepalive rule on, for good (spec §4).
			l.idle = p.cfg.leaseIdle(e)
			if e.Keepalive {
				l.keepalive, l.lastKeepalive = true, p.clk.Now()
			}
		}
	}
	stop := l != nil && rp.lease == l && l.stopTracked // not a lease ended above (per-exec served)
	p.mu.Unlock()
	if v != nil {
		p.destroyLeaseVictim(v)
	}
	if closed {
		return Result{}, ErrClosed
	}
	if cut != "" {
		return Result{}, &LeaseEndedError{Reason: cut}
	}
	var notice *LeaseEvent
	if stop {
		var sv *leaseVictim
		notice, sv = p.stopTrackedUnderGate(rp, l)
		if sv != nil {
			p.destroyLeaseVictim(sv)
			p.mu.Lock()
			closed, cut = p.closed, l.cut
			p.mu.Unlock()
			switch {
			case closed:
				return Result{}, ErrClosed
			case cut != "":
				return Result{}, &LeaseEndedError{Reason: cut}
			}
			l = nil // ended by the stop: this Exec starts a fresh lease
		}
	}
	if processRefused {
		return Result{ProcessesStopped: notice}, p.processesNotEnabled(key, e.Kind, served)
	}
	if perExec {
		return Result{}, errServePerExec // the deferred receive releases the gate
	}
	if l == nil && e.Kind.isProcess() && e.Kind != ExecKindProcessStart {
		return answerWithoutLease(e, out)
	}

	var vm VM
	if l != nil {
		vm = l.vm
		if ph != nil {
			// Nothing was acquired or resumed: zero those phases rather than leave
			// whatever a reused Phases held, as ExecPhased does for resumePhaser.
			ph.Acquire, ph.Cold, ph.Resume, ph.Normalise = 0, "", 0, 0
			ph.VMResume, ph.VsockDial, ph.Mount = 0, 0, 0
			ph.VMID = vmID(vm)
		}
	} else {
		var err error
		if vm, err = p.startLease(ctx, runCtx, key, rp, e, served, ph, timedOut, timeoutS); err != nil {
			return Result{}, err
		}
	}
	res, err := p.runLease(ctx, runCtx, rp, vm, e, out, ph, timedOut, timeoutS, deadline, extend)
	res.ProcessesStopped = notice
	return res, err
}

// startLease acquires, raises the cgroup of, resumes, normalises (when root_wrote is set)
// and installs a new lease VM. Caller holds rp's gate. On failure the VM is destroyed and
// no lease is recorded: one that never ran an Exec never started.
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
		if l := arp.lease; l != nil && l.vm == vm {
			arp.lease = nil
			close(l.gone)
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
	normalise := rp.state.RootWrote // the state is loaded: a lease mode needs a known one
	p.mu.Unlock()
	if ph != nil {
		ph.Normalise = 0
	}
	if normalise {
		if err := p.normaliseLease(ctx, rp, vm, ph); err != nil {
			fail()
			return nil, err
		}
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
	if normalise {
		// The step ended with exit 0. Saved with the start: a lost save keeps root_wrote
		// on disk, so a later lease normalises again, which is safe.
		s.RootWrote = false
	}
	if s.Pending == nil || s.Pending.State != leaseEventEnd {
		// The start is the notice only when no end is pending: "guest restarted" already
		// tells the client the next Exec runs in a fresh guest (spec §5).
		s.Pending = &LeaseEvent{State: leaseEventStart, At: leaseEventAt(now), Mode: mode}
	}
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

// normaliseLease is a lease start's normalise step (spec §3.3; PR #763 second review, G2):
// the guest walks the workspace's ownership over to the exec uid before the lease's first
// Exec, in a request of its own, `true` with NormaliseWorkspace. The first lease request
// also takes the guest's one-time hardening steps, so they run here too. Like the restore
// and Resume, the step is not charged to the Exec's budget: it runs under the caller's ctx,
// so an abort still applies, but not under the Exec's timer, with LeaseNormaliseTimeout
// of its own (the host gives up LeaseTimeoutSlack later). A cut (endLeaseWaiting's grace
// bound) cancels it, as it would a running Exec. Caller holds rp's gate, with the VM
// resumed and installed as rp.lease but not yet started.
//
// Anything but a clean exit 0 -- a non-zero exit, teardown_failed, a transport or guest
// error, its own timeout -- fails the lease start: the caller destroys the VM and records
// no lease, and root_wrote stays set, so the next lease Exec takes the step again. An
// abort returns ErrAborted, anything else a RefuseSpawn naming the step.
func (p *pool) normaliseLease(ctx context.Context, rp *runPool, vm VM, ph *Phases) error {
	stepCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	tm := p.clk.AfterFunc(LeaseNormaliseTimeout+LeaseTimeoutSlack, cancel)
	defer tm.Stop()
	p.mu.Lock()
	l := rp.lease
	l.running, l.cancel = true, cancel
	p.mu.Unlock()

	t0 := p.clk.Now()
	res, err := vm.Run(stepCtx, Command{
		Command:            "true",
		TimeoutS:           uint32(LeaseNormaliseTimeout / time.Second),
		CapBytes:           OutputCapBytes,
		Lease:              true,
		NormaliseWorkspace: true,
	}, discardingSink{})
	if ph != nil {
		ph.Normalise = p.clk.Now().Sub(t0)
	}
	p.mu.Lock()
	if rp.lease == l {
		l.running, l.cancel = false, nil
	}
	p.mu.Unlock()

	var why string
	switch {
	case err != nil:
		why = err.Error()
	case res.TeardownFailed:
		why = "teardown failed"
	case res.ExitCode != 0:
		why = fmt.Sprintf("exit %d", res.ExitCode)
	default:
		return nil
	}
	if ctx.Err() != nil {
		return ErrAborted
	}
	log.Printf("vmpool: lease normalise workspace_key=%q vm=%s: %s; the lease start fails, root_wrote stays set",
		rp.key, vmID(vm), why)
	return p.refuse(RefuseSpawn, "lease normalise: workspace_key %q vm=%s: %s", rp.key, vmID(vm), why)
}

// runLease runs one command in rp's lease VM. Caller holds rp's gate. deadline is when
// the Exec's budget ends, and the host's timer (runCtx) fires there until extend, called
// just before Run, moves it to the run's deadline plus LeaseTimeoutSlack. The run's
// deadline is the budget's end, except for a process kind, which gets at least
// ProcessKindMinTimeoutS from Run (PR #814 review): the guest work the floor covers
// (process_stop's TERM grace, cgroup.kill, the teardown bound) starts only at Run, after
// whatever the gate wait spent.
//
// The guest's report that its own timeout fired (guestTimedOut) keeps the lease (ruling
// R8b): the guest killed the Exec's cgroup and emptied it before answering, as after an
// exit, so the Exec fails with the timeout and the next one runs in the same VM. So does
// the caller's abort of a command (F3 of the E17b report): it reaches the guest as
// Command.Abort rather than as a cancelled Run, the guest tears the command down the same
// way and answers End with Aborted, and the Exec fails ErrAborted. An abort the guest does
// not answer within LeaseAbortGrace, or answers with an error (an agent that predates the
// abort frame), still ends the lease agent_dead. So does
// ErrCommandTooLarge: the command was refused before anything reached the guest. So does
// the guest's refusal of a process kind (guestKeepsLease), which fails the Exec with the
// guest's wire string (ProcessError). Every lease End refreshes the tracked mirror
// (refreshTrackedLocked) before the lease is kept or ended. What
// ends the lease is a guest that did not answer by the host's deadline, a transport
// error, teardown_failed, or an abort the guest did not answer cleanly.
func (p *pool) runLease(ctx, runCtx context.Context, rp *runPool, vm VM, e Exec, out Sink, ph *Phases,
	timedOut *atomic.Bool, timeoutS uint32, deadline time.Time, extend func(time.Time) bool) (Result, error) {
	p.mu.Lock()
	l := rp.lease
	if cut := l.cut; cut != "" {
		// Cut after execLease's check, or while startLease installed this lease
		// (endLeaseWaiting): Run is never called, because a request written on a
		// cancelled context can still reach the guest before the connection closes. The
		// lease ends here with the cut's reason.
		v := p.endLeaseLocked(rp, cut)
		p.mu.Unlock()
		t1 := p.clk.Now()
		p.destroyLeaseVictim(v)
		if ph != nil {
			ph.Destroy = p.clk.Now().Sub(t1)
		}
		return Result{}, &LeaseEndedError{Reason: cut}
	}
	// The budget, checked under the gate immediately before Run (PR #763 second review,
	// G1): the gate wait, a cold start's restore, Resume and normalise step may have spent
	// it. A spent budget, or a timer that fired before extend could move it, fails the
	// Exec with the usual timeout; an abort before Run fails it ErrAborted. Nothing reaches
	// the guest, so the lease is kept. Only here does the host's timer move to the budget
	// plus LeaseTimeoutSlack.
	atGate := p.clk.Now()
	runDeadline := deadline
	if floor := atGate.Add(time.Duration(ProcessKindMinTimeoutS) * time.Second); e.Kind.isProcess() && floor.After(runDeadline) {
		runDeadline = floor
	}
	var notRun error
	switch {
	case !atGate.Before(deadline), !extend(runDeadline):
		notRun = fmt.Errorf("%w:%d", ErrTimeout, timeoutS)
	case runCtx.Err() != nil:
		notRun = p.cancelled(ctx, timedOut, timeoutS)
	}
	if notRun != nil {
		var v *leaseVictim
		if p.closed {
			v = p.detachLeaseLocked(rp) // Close skipped this lease: its gate is held here
		}
		p.mu.Unlock()
		if v != nil {
			p.destroyLeaseVictim(v)
		}
		return Result{}, notRun
	}
	// cancel lets the lease sweep, or endLeaseWaiting, cut this Exec once it is inside
	// Run (sweepLeasesLocked). A cut that lands after the unlock below but before vm.Run
	// starts is the in-flight case, not R12's: running is already true, so the cutter
	// cancels execCtx, and Run starts on a cancelled context. The request may still
	// reach the guest before the connection closes, which is what spec §4 allows for an
	// Exec in flight when its lease is cut; the unwind below then ends the lease with the
	// cut's reason. Only a cut set before this point is kept off Run (the check above).
	// A command's Run is not cancelled by the caller's abort, which is asked of the guest
	// instead (abort, Command.Abort), with LeaseAbortGrace as the bound on its answer. The
	// host's own deadline still cancels it at once: the timer sets timedOut before it
	// cancels runCtx. So does a cut, which cancels execCtx directly. A process kind is
	// cancelled by either, as before.
	runParent := runCtx
	var abort chan struct{}
	if e.Kind == ExecKindCommand {
		detached, cancelDetached := context.WithCancel(context.WithoutCancel(runCtx))
		defer cancelDetached()
		abort = make(chan struct{})
		stopAbort := context.AfterFunc(runCtx, func() {
			if timedOut.Load() {
				cancelDetached()
				return
			}
			// Armed before abort is closed, so the bound is in place whenever the guest
			// is asked. A firing after the Run returned cancels a context already done.
			p.clk.AfterFunc(LeaseAbortGrace, cancelDetached)
			close(abort)
		})
		defer stopAbort()
		runParent = detached
	}
	execCtx, cancel := context.WithCancel(runParent)
	defer cancel()
	l.running, l.cancel = true, cancel
	rp.lastExec = p.clk.Now()
	p.mu.Unlock()

	t0 := p.clk.Now()
	c := Command{
		Command:   e.Command,
		Stdin:     e.Stdin,
		TimeoutS:  leaseGuestTimeoutS(runDeadline, t0),
		Streaming: e.Streaming,
		CapBytes:  OutputCapBytes,
		Lease:     true, // never NormaliseWorkspace: the lease's start took that step
		Kind:      e.Kind,
		Process:   e.Process,
		Abort:     abort, // nil for a process kind
		// Every lease request restarts the guest's idle page-cache drop (F1).
		CacheDropAfterS: leaseCacheDropS(p.cfg.LeaseCacheDropAfter),
	}
	if e.Kind == ExecKindProcessStart {
		c.MaxProcesses = p.cfg.LeaseMaxProcesses
	}
	res, runErr := vm.Run(execCtx, c, out)
	if ph != nil {
		ph.Run = p.clk.Now().Sub(t0)
	}
	if runErr == nil && res.Aborted {
		// An aborted End answers the host's KindAbort and nothing else: one the host did
		// not ask for is a guest off the protocol, failed as a guest error, never a success
		// with exit -1 (#970 review). abort is closed once and only by the caller's abort.
		select {
		case <-abort:
		default:
			runErr = &guestError{msg: "an aborted End for an Exec the host did not abort"}
		}
	}
	cErr := p.classify(ctx, timedOut, timeoutS)
	// The guest answered with its own timeout: the command is dead, its cgroup empty.
	guestTimeout := guestTimedOut(runErr)
	// The command was refused as larger than the guest's one request frame: nothing was
	// sent, so the guest ran nothing and its VM is as fit for the next Exec as before.
	tooLarge := errors.Is(runErr, ErrCommandTooLarge)
	// The guest refused a process kind before running anything (guestKeepsLease). A
	// command's guest error never keeps the lease, whatever its prefix.
	var refusedMsg string
	var refused bool
	if e.Kind.isProcess() {
		refusedMsg, refused = guestKeepsLease(runErr)
	}

	var reason LeaseEndReason
	switch {
	case res.TeardownFailed:
		reason = LeaseEndTeardownFailed
	case timedOut.Load(), runErr != nil && !guestTimeout && !tooLarge && !refused:
		// The host's deadline (the guest did not answer within the budget and the slack),
		// a transport error, an abort the guest did not answer with End, or a guest error:
		// the agent may have survived, but a VM whose last Exec ended without its answer is
		// not one to run the next in. A clean aborted End is an answer: it keeps the lease
		// because runErr is nil, and an aborted End the host did not ask for was made a
		// guest error above.
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
	if live && runErr == nil {
		// Before any end below, so the end lists the table this End reported.
		p.refreshTrackedLocked(rp, l, e, res.Tracked)
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
		p.destroyLeaseVictim(v)
		if ph != nil {
			ph.Destroy = p.clk.Now().Sub(t1)
		}
	} else if live {
		// Sampled under the gate, off p.mu: a cgroupfs read. The lease's charge from here
		// on (leaseChargeLocked), until the next Exec or lease tick re-samples it.
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
	if guestTimeout {
		// The error a host-side timeout gives, as every lease timeout returned before the
		// guest's own was kept apart: the caller's contract is unchanged.
		return res, fmt.Errorf("%w:%d", ErrTimeout, timeoutS)
	}
	if refused {
		return res, &ProcessError{Msg: refusedMsg} // the guest's wire string, unprefixed
	}
	return res, runErr
}

// endLeaseLocked ends rp's lease for reason: it detaches the VM, saves Pending = {end,
// reason} and Open = nil to the key's state file, writes the audit line, and returns the
// victim for destruction outside the lock. nil when rp has no lease. The caller holds
// p.mu and rp's gate.
//
// A lease carrying a cut ends with the cut's reason whoever holds the gate: a per-Exec
// Exec's mode_change (endLeaseForPerExec, perExecUnderGate) does not overwrite the
// reset that EndLease cut it for.
func (p *pool) endLeaseLocked(rp *runPool, reason LeaseEndReason) *leaseVictim {
	l := rp.lease
	if l != nil && l.cut != "" {
		reason = l.cut
	}
	v := p.detachLeaseLocked(rp)
	if v == nil {
		return nil
	}
	v.reason = reason
	switch reason {
	case LeaseEndTeardownFailed:
		v.sync = false // the guest is not fit to answer; the end does not wait on it
	case LeaseEndSandboxDeleted:
		// The workspace is going away (ruling P5-R39): there are no writes to keep, and the
		// end does not wait on the guest for them. Its stopped list stays the mirror's.
		v.sync = false
	}
	// agent_dead still syncs (ruling P5-R36): it also covers the host's own deadline and an
	// abort, where the guest usually lives on with a tracked process's unsynced writes, and an
	// agent that is really gone refuses the sync at once. memory_reclaim syncs too: losing a
	// tracked process's writes is worse than a reclaim that waits on a wedged guest, up to
	// the ~40 s bound (10 s vsock connect + LeaseEndSyncTimeout).
	now := p.clk.Now()
	age := now.Sub(l.started)
	s := p.leaseStateLocked(rp)
	s.Open = nil
	run := runningTracked(l.tracked)
	v.endAt = leaseEventAt(now)
	s.Pending = &LeaseEvent{State: leaseEventEnd, Reason: reason, At: v.endAt, Mode: l.mode, Age: age,
		Processes: displays(run), Tracked: run}
	if s.Known && leaseStateFileGone(p.cfg.WorkspaceRoot, rp.key) {
		// The janitor removed the file of a deleted sandbox while this lease was live (a
		// janitor wait shorter than retireLeaseState's timing argument allows): as there,
		// it is not written back, and the cache follows the disk, so no later save of
		// this run recreates it either.
		log.Printf("vmpool: lease end for %q: its state file is gone (removed by the host janitor); not written back", rp.key)
		s = leaseState{}
	} else if err := saveLeaseState(p.cfg.WorkspaceRoot, rp.key, s); err != nil {
		log.Printf("vmpool: lease end for %q: %v", rp.key, err)
	}
	rp.state = s
	p.counters.leaseEnded(reason)
	// Idle clocks (StandbyIdle, WorkspaceIdle) run from the lease's end, not its last
	// Exec's start (Review Focus 5).
	rp.lastExec = now
	log.Printf("vmpool: lease end workspace_key=%q vm=%s mode=%s reason=%s age=%s%s",
		rp.key, vmID(l.vm), l.mode, reason, age.Round(time.Millisecond), trackedAuditField(l.tracked))
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
	close(l.gone)
	return &leaseVictim{key: rp.key, vm: l.vm, gate: rp.execGate, reason: LeaseEndWorkerRestart,
		sync: l.mode == ModeLeaseProcesses || len(l.tracked) > 0, mode: l.mode, tracked: slices.Clone(l.tracked)}
}

// endOrDetachLocked is endLeaseLocked, or detachLeaseLocked on a closed pool. Caller
// holds p.mu and rp's gate.
func (p *pool) endOrDetachLocked(rp *runPool, reason LeaseEndReason) *leaseVictim {
	if p.closed {
		return p.detachLeaseLocked(rp)
	}
	return p.endLeaseLocked(rp, reason)
}

// leaseEndSyncCommand is the command a level-2 lease's end runs before its VM is destroyed,
// bounded by LeaseEndSyncTimeout.
//
// Why (Task 11 fix round 1): every command Exec's wrapper syncs at its end
// (wrapCommand), which is what made a level-1 lease durable -- nothing outlives an Exec.
// A tracked process does, and writes to the workspace between Execs, and the process
// kinds are sent unwrapped (ruling P5-R34), so without this its writes since the last
// Exec would die with the guest's page cache.
const leaseEndSyncCommand = "sync"

// LeaseEndSyncTimeout bounds a lease end's sync step. Past it the VM is destroyed anyway:
// an end must not hang on a guest that cannot answer.
const LeaseEndSyncTimeout = 30 * time.Second

// LeaseCloseSyncTimeout is Close's one bound on syncing every lease it detaches, together
// (PR #814 review). The worker units stop with TimeoutStopSec=30 and KillMode=control-group
// (microvm-worker.service, sbx-worker@.service), so Close must sync and destroy within
// that: it syncs its victims concurrently, waits at most this long for all of them, then
// destroys them all. A guest that has not answered by then loses its unsynced writes,
// rather than every lease after it in a loop losing theirs to systemd's SIGKILL.
// The bound also covers the sweep batches already queued when Close starts: their syncs run
// under the pool's syncCtx, which Close cancels when the bound passes, so none of them adds
// a further LeaseEndSyncTimeout after it.
const LeaseCloseSyncTimeout = 20 * time.Second

// destroyLeaseVictim is destroyLeaseVM for an ended (or detached) lease: a victim marked
// sync has its guest synced first (syncLeaseVictim). The destroy goes ahead whatever the
// sync did.
func (p *pool) destroyLeaseVictim(v *leaseVictim) error {
	p.syncLeaseVictim(p.syncCtx, v)
	return p.destroyLeaseVM(v.key, v.vm)
}

// syncLeaseVictim runs a victim's sync step when it is marked sync, bounded by
// LeaseEndSyncTimeout and ctx. A failed sync is logged. A sync that succeeded answers with
// the guest's whole tracked table, like every lease End, and that refreshes the end before
// the end is reported (refreshEndedTracked).
func (p *pool) syncLeaseVictim(ctx context.Context, v *leaseVictim) {
	if !v.sync {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, LeaseEndSyncTimeout)
	res, err := v.vm.Run(ctx, Command{Command: leaseEndSyncCommand, Lease: true,
		TimeoutS: uint32(LeaseEndSyncTimeout / time.Second), CapBytes: OutputCapBytes}, discardingSink{})
	cancel()
	if err != nil || res.ExitCode != 0 || res.TeardownFailed {
		log.Printf("vmpool: lease end sync workspace_key=%q vm=%s: exit %d, teardown_failed=%t, %v; destroying it anyway",
			v.key, vmID(v.vm), res.ExitCode, res.TeardownFailed, err)
		return
	}
	p.refreshEndedTracked(v, res.Tracked)
}

// syncLeaseVictimsWithin syncs vs concurrently and waits for them, at most bound in all
// (Close's LeaseCloseSyncTimeout): past it each sync's context is cancelled, and the
// returned wait is for the caller to call once it has destroyed the VMs, so that a sync
// stuck where it cannot see the cancel (a vsock connect) ends with its VM before the
// caller returns.
func (p *pool) syncLeaseVictimsWithin(vs []*leaseVictim, bound time.Duration) (wait func()) {
	ctx, cancel := context.WithTimeout(p.syncCtx, bound)
	var wg sync.WaitGroup
	for _, v := range vs {
		if !v.sync {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.syncLeaseVictim(ctx, v)
		}()
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
	cancel()
	return func() { <-done }
}

// refreshEndedTracked applies the table an ended lease's sync step reported (ruling
// P5-R38). The mirror only learns of an exit from a lease End, so a tracked process that
// died since the last one still shows running in v.tracked: here it gets its lease_process
// exit record (auditTracked, at the lease's level), and leaves the end's stopped list. The
// list lives in the end event endLeaseLocked saved, matched by its At, or, for a detach,
// in the open record a worker_restart end is built from, matched by its VM. Only a record
// still there is rewritten: an end a client acknowledged meanwhile is not brought back, and
// none is added. Called with rp's gate held and not p.mu.
func (p *pool) refreshEndedTracked(v *leaseVictim, next []TrackedProcess) {
	if !auditTracked(v.key, v.mode, nil, v.tracked, next) {
		return
	}
	run := runningTracked(next)
	p.mu.Lock()
	defer p.mu.Unlock()
	rp := p.runs[v.key]
	s := p.peekLeaseStateLocked(v.key, rp)
	switch {
	case !v.endAt.IsZero() && s.Pending != nil && s.Pending.State == leaseEventEnd && s.Pending.At.Equal(v.endAt):
		ev := *s.Pending // copied, not written through: the cached state may share it
		ev.Processes, ev.Tracked = displays(run), run
		s.Pending = &ev
	case v.endAt.IsZero() && s.Open != nil && s.Open.VMID == vmID(v.vm):
		o := *s.Open
		o.Tracked = next
		s.Open = &o
	default:
		return
	}
	if leaseStateFileGone(p.cfg.WorkspaceRoot, v.key) {
		return // removed by the host janitor: not written back (endLeaseLocked's rule)
	}
	if err := saveLeaseState(p.cfg.WorkspaceRoot, v.key, s); err != nil {
		// The end on disk keeps the mirror's list: a process listed as stopped that had
		// exited by itself, which its exit record above corrects.
		log.Printf("vmpool: lease end tracked processes for %q: %v", v.key, err)
	}
	if rp != nil {
		rp.state, rp.stateLoaded = s, true
	}
}

// destroyLeaseVictims destroys each victim's VM, then releases its gate: the order that
// keeps a queued Exec from mounting the workspace while the old VM still holds it. The
// victims go in parallel, each with its own sync bound, and each gate is released as soon
// as its own VM is gone: one wedged guest holds only its own key (PR #814 review). It
// returns once every victim is done.
func (p *pool) destroyLeaseVictims(vs []*leaseVictim) {
	p.destroyLeaseVictimsThen(vs, nil)
}

// destroyLeaseVictimsThen is destroyLeaseVictims, calling after (when set) for each victim
// once its gate is released.
func (p *pool) destroyLeaseVictimsThen(vs []*leaseVictim, after func(*leaseVictim)) {
	var wg sync.WaitGroup
	for _, v := range vs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.destroyLeaseVictim(v)
			<-v.gate
			if after != nil {
				after(v)
			}
		}()
	}
	wg.Wait()
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

// destroySweptLeases is destroyLeaseVictims for the lease sweep's victims (idle,
// max_duration, keepalive_lost, memory_reclaim): it also drops the pin the sweep took, once
// the gate is released. A batch's victims sync in parallel, so a wedged guest delays only
// its own key's next Exec. endLeaseLocked has already removed each victim's charge: with
// the syncs in parallel, admission counts a victim's still-running VM as free for at most
// one sync bound per batch, not one per victim in turn (PR #814 review; keeping the charge
// until the destroy was declined).
func (p *pool) destroySweptLeases(vs []*leaseVictim) {
	p.destroyLeaseVictimsThen(vs, func(v *leaseVictim) { p.unpin(v.rp) })
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
//
// It ends at most MaxReclaimsPerScan leases per tick (PR #763 review): each end fsyncs
// the key's state file under p.mu, and a burst of due leases -- a fleet idling out
// together -- would otherwise hold the lock for all of them. The rest are still due at
// the next tick, LeaseScanInterval later.
func (p *pool) sweepLeasesLocked(now time.Time) []*leaseVictim {
	var out []*leaseVictim
	for _, rp := range p.runs {
		l := rp.lease
		if l == nil || l.started.IsZero() {
			// No lease, or one startLease is still installing under its gate.
			continue
		}
		// Marking expiring and cutting a running Exec go on past the cap: neither writes
		// the state file here.
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
		reason := l.cut // a caller's end, cut while no Exec ran (endLeaseWaiting)
		if reason == "" {
			reason = p.leaseEndDueLocked(l, now, graceOver)
		}
		if reason == "" || len(out) >= p.cfg.MaxReclaimsPerScan {
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

// reclaimLeasesLocked ends idle leases for memory (spec §6), idle-longest first, with
// reason memory_reclaim, and returns the victims for destroySweptLeases. need is the
// budget the caller must free: an admission's shortfall (evictForAdmissionLocked), or the
// lease ticker's overshoot once measured charges have grown past the budget (sweepLeases),
// in both cases what idle standbys could not cover. Caller holds p.mu, on a pool that is
// not closed.
//
// It takes victims while either deficit remains, and stops once need is covered and
// MemAvailable is back above LeaseReclaimFreeBytes, or once it has taken
// MaxReclaimsPerScan victims. MemAvailable is read once, through the ~100ms cache
// (cachedMemAvailable), and a victim's charge counts towards it as soon as it is taken:
// its destroy is asynchronous, so no read inside this call could see it. The next tick
// reads again, which is how the reclaim repeats until the target is met. An unreadable
// MemAvailable drives no reclaim: ending a user's lease on "cannot tell" is the wrong
// way to fail, and the host floor (hostFloorLocked) fails closed for that case instead.
//
// The cap is per call, not per sweep: a lease tick ends up to MaxReclaimsPerScan leases
// sweepLeasesLocked finds due, and this call then ends up to MaxReclaimsPerScan more;
// each admission's call (evictForAdmissionLocked) may end up to MaxReclaimsPerScan again.
// need is what is left of the overshoot once idle standbys have been shed for it (the
// lease tick, as an admission does).
//
// A LEASE WITH AN EXEC IN FLIGHT IS NEVER RECLAIMED FOR MEMORY. A lease is taken only
// after a non-blocking send on its run's gate succeeds, as the lease sweep does: a held
// gate (an Exec in Run, or queued past the gate, or a lease being started or ended) is
// skipped, never waited on. The gate stays held, and the run pinned, until the VM is
// destroyed. A lease carrying a cut may be taken: endLeaseLocked records the cut's reason.
func (p *pool) reclaimLeasesLocked(now time.Time, need int64) ([]*leaseVictim, int64) {
	cands := p.idleLeaseRunsLocked(now)
	if len(cands) == 0 {
		return nil, 0 // no MemAvailable read on a pool with no idle lease
	}
	want := max(need, p.leaseMemDeficitLocked())
	var (
		out   []*leaseVictim
		freed int64
	)
	for _, rp := range cands {
		if freed >= want || len(out) >= p.cfg.MaxReclaimsPerScan {
			break
		}
		select {
		case rp.execGate <- struct{}{}:
		default:
			continue // an Exec holds the gate: never reclaimed, never waited on
		}
		charge := p.leaseChargeLocked(rp.lease)
		v := p.endLeaseLocked(rp, LeaseEndMemoryReclaim)
		rp.pinned++
		v.rp = rp
		out = append(out, v)
		freed += charge
	}
	return out, freed
}

// reclaimableLeasesLocked is what reclaimLeasesLocked could free right now for an
// admission, as bytes: the charges of the first MaxReclaimsPerScan idle leases whose gate
// is free, idle-longest first. evictForAdmissionLocked's futility check adds it to the
// standbys'. idle counts every idle lease and held those whose gate an Exec (or a start or
// an end) holds, for the log line of a refusal (#1005). Caller holds p.mu.
//
// The gate is probed (a non-blocking send, then the receive) rather than kept, so a
// waiting Exec may take it between this count and the take; the take then skips that
// lease, and the admission's re-check refuses on the real numbers.
func (p *pool) reclaimableLeasesLocked() (idle, held int, bytes int64) {
	var n int
	runs := p.idleLeaseRunsLocked(p.clk.Now())
	for _, rp := range runs {
		select {
		case rp.execGate <- struct{}{}:
			<-rp.execGate
		default:
			held++
			continue
		}
		if n >= p.cfg.MaxReclaimsPerScan {
			continue // counted for held only; the take would stop here too
		}
		n++
		bytes += p.leaseChargeLocked(rp.lease)
	}
	return len(runs), held, bytes
}

// idleLeaseRunsLocked is every run whose lease has started and runs no Exec, idle-longest
// first (the longest since its last Exec's end). Caller holds p.mu.
func (p *pool) idleLeaseRunsLocked(now time.Time) []*runPool {
	var out []*runPool
	for _, rp := range p.runs {
		if l := rp.lease; l != nil && !l.started.IsZero() && !l.running {
			out = append(out, rp)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return now.Sub(out[i].lease.lastEnd) > now.Sub(out[j].lease.lastEnd)
	})
	return out
}

// leaseMemDeficitLocked is how far MemAvailable is below LeaseReclaimFreeBytes, or 0: at
// or above the target, or unreadable. Caller holds p.mu.
func (p *pool) leaseMemDeficitLocked() int64 {
	avail, err := cachedMemAvailable()
	if err != nil {
		return 0
	}
	return max(p.cfg.LeaseReclaimFreeBytes-avail, 0)
}

// refreshLeaseChargesLocked re-samples every idle lease VM's footprint for its charge
// (leaseChargeLocked): an idle lease's memory.current falls as free-page reporting returns
// the pages its guest freed (spec §6), and without a fresh sample it would stay charged at
// its last Exec's peak until the next Exec. A running lease is sampled by runLease when its
// Exec ends. Under p.mu: LeaseBytes is a cgroupfs counter read, no disk I/O, once per idle
// lease per LeaseScanInterval. A failed or empty read keeps the last sample.
func (p *pool) refreshLeaseChargesLocked() {
	for _, rp := range p.runs {
		l := rp.lease
		if l == nil || l.started.IsZero() || l.running {
			continue
		}
		if lf, ok := l.vm.(leaseFootprinter); ok {
			if b, err := lf.LeaseBytes(); err == nil && b > 0 {
				l.charge, l.sampled = b, true
			}
		}
	}
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
