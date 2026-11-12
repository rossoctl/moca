package vmpool

import "time"

// runPool is one workspace_key's state — spec §4.2's second state machine:
//
//	RunAbsent --first Exec--> RunWarming --> RunActive --idle > StandbyIdle--> RunParked
//	RunParked --Exec (cold acquire)--> RunWarming
//	RunParked --idle > WorkspaceIdle--> RunReclaiming --> RunAbsent
//
// RunParked is the state a run on a human gate or awaiting user input sits in:
// workspace on disk, ZERO standby VMs, costing disk rather than RAM (spec §4.4).
//
// Every field is guarded by pool.mu. Nothing here takes a lock of its own — one
// lock, held briefly, is what keeps the per-Exec sweep a microsecond map walk.
type runPool struct {
	key string
	dir string

	ready    []VM // paused standbys, ready to acquire
	inFlight int  // VMs currently running a command for this key
	warming  int  // replenishments in flight

	// settled is closed whenever a warming completes, then replaced. A cold
	// acquire waits on it rather than starting a second warming (spec §4.2).
	settled chan struct{}

	lastExec time.Time
	parked   bool

	// backoff is the per-run replenishment backoff after a spawn failure
	// (spec §6: "exponential backoff per run pool. Never a hang").
	backoff time.Duration

	// pending holds scheduled replenish timers so Close and Reclaim can cancel
	// them; a timer that fires into a reclaimed run would resurrect it.
	pending []Timer

	// execGate is the ONE field here that is NOT guarded by pool.mu and synchronizes
	// on its own — deliberately, because what it protects (a VM's Resume and Run,
	// which dial vsock and block on a guest) must never happen while pool.mu is
	// held. ExecPhased holds it from a successful acquire until this VM is
	// destroyed, but only when the Launcher reports SerializesExecsPerRun():
	// Firecracker's ext4 workspace is not a shared-disk filesystem, so a second
	// guest mounting it rw while the first still holds it would corrupt it
	// (spec §4.3).
	//
	// A ONE-SLOT CHANNEL, NOT A MUTEX, because a mutex acquisition is not selectable
	// on a context. A waiter parked on sync.Mutex.Lock held an acquired VM with the
	// budget charged and no destroy defer registered yet, and cancelling its context
	// did not release any of it — so one wedged guest blocked every subsequent Exec
	// for that run indefinitely, each waiter's VM charged against
	// MaxCommittedBytes and each keeping rp.busy() true so the sweep could not
	// reclaim the workspace either. A send that can lose the race to runCtx.Done()
	// lets an aborted or timed-out waiter unwind instead of queueing behind a guest
	// that is never going to answer. Created in runLocked: unlike a zero Mutex, a
	// nil channel would block forever.
	execGate chan struct{}

	// state is the key's mode, epoch and lease bookkeeping (lease_state.go), read from
	// its file on first use (stateLoaded) and written through on every change. See
	// leaseStateLocked.
	state       leaseState
	stateLoaded bool

	// lease is the key's live VM lease (lease.go), nil when none. A lease VM is counted
	// apart from ready, inFlight and warming (spec §6), and replenishment keeps no
	// standbys beside it. warmingLease counts cold restores for a lease, charged at
	// LeaseStartBytes as warming is charged at PerVMBytes. pinned counts Execs between
	// their arrival on the lease path and their return, so the sweep cannot delete the
	// entry whose gate they wait on.
	lease        *vmLease
	warmingLease int
	pinned       int
}

func (rp *runPool) signalSettledLocked() {
	close(rp.settled)
	rp.settled = make(chan struct{})
}

func (rp *runPool) idleFor(now time.Time) time.Duration { return now.Sub(rp.lastExec) }

// busy reports whether anything about this run is in motion. A run with work in
// flight or a warming pending is never swept, whatever its idle clock says. Nor is a
// run with a live lease, whose VM holds the workspace mounted between Execs, or one
// pinned by a lease-path Exec (spec §8.4: a lease must never outlive its workspace).
func (rp *runPool) busy() bool {
	return rp.inFlight > 0 || rp.warming > 0 || rp.warmingLease > 0 || rp.pinned > 0 || rp.lease != nil
}

// forgetPending drops a fired timer so pending does not grow across a long run.
// Caller holds pool.mu.
func (rp *runPool) forgetPending(tm Timer) {
	for i, t := range rp.pending {
		if t == tm {
			rp.pending = append(rp.pending[:i], rp.pending[i+1:]...)
			return
		}
	}
}
