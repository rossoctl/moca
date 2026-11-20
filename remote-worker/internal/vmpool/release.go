package vmpool

import (
	"context"
	"log"
	"time"
)

// ReleaseOutcome is what a Release did (#338), the worker's ack on the wire
// (ReleaseResult.outcome).
type ReleaseOutcome string

const (
	// ReleaseReleased: the run's standbys and workspace are freed (the tree detached, its
	// removal queued on the reclaim goroutine).
	ReleaseReleased ReleaseOutcome = "released"
	// ReleaseKeptBusy: the run was busy (an Exec in flight, a warming, a live lease). Its
	// standbys are freed now and its workspace as soon as it is not busy.
	ReleaseKeptBusy ReleaseOutcome = "kept_busy"
	// ReleaseUnknownKey: the pool holds no run for the key (never used here, or already
	// reclaimed).
	ReleaseUnknownKey ReleaseOutcome = "unknown_key"
)

// Release frees key's standbys and workspace because its owner (a session or a sandbox)
// has ended, and marks key released, so an Exec for it is refused for WorkspaceIdle. Its
// steps are Reclaim's, under one hold of the lock, with two differences: a busy run is
// marked releaseOnIdle instead of left to its idle clock, and the key is marked released
// in the same critical section. An Exec racing it is therefore either already using the
// run (the release is kept_busy and waits for it) or refused: at ExecPhased's early check,
// or, if it passed that check before this hold, when it would create the run again
// (runAtLocked). A run marked releaseOnIdle gets no new standby (scheduleReplenishLocked,
// replenishOne).
//
// Idempotent: a second Release for a key already freed is ReleaseUnknownKey, and re-marks
// it (which moves its expiry). ctx is unused: nothing here blocks on a guest. An invalid
// key is refused like an Exec's, but not counted as a refusal: it is a call's error, and
// only Execs feed Refusals.
func (p *pool) Release(_ context.Context, key string) (ReleaseOutcome, error) {
	if err := checkKey(key); err != nil {
		return "", err
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return "", ErrClosed
	}
	p.released[key] = p.clk.Now()
	rp := p.runs[key]
	if rp == nil {
		p.mu.Unlock()
		p.counters.released(ReleaseUnknownKey)
		return ReleaseUnknownKey, nil
	}
	b := reclaimBatch{vms: rp.ready}
	rp.ready = nil
	for _, tm := range rp.pending {
		tm.Stop()
	}
	rp.pending = nil
	if rp.busy() {
		if !rp.releaseOnIdle {
			rp.releaseOnIdle = true
			p.pendingReleases.Add(1)
		}
		left := p.enqueueReclaimLocked(b)
		p.mu.Unlock()
		p.doReclaim(left)
		p.counters.released(ReleaseKeptBusy)
		return ReleaseKeptBusy, nil
	}
	tomb, err := p.detachRunLocked(key, rp)
	if err == nil && tomb != "" {
		b.dirs = append(b.dirs, tomb)
	}
	left := p.enqueueReclaimLocked(b)
	p.mu.Unlock()
	p.doReclaim(left)
	if err != nil {
		return "", err
	}
	p.counters.released(ReleaseReleased)
	return ReleaseReleased, nil
}

// detachRunLocked detaches rp's workspace and drops the run, retiring its lease state as
// the sweep does. On a detach error the run is kept (the sweep retries), and the error is
// returned. Caller holds p.mu.
func (p *pool) detachRunLocked(key string, rp *runPool) (string, error) {
	tomb, err := detachWorkspace(rp.dir)
	if err != nil {
		return "", err
	}
	p.dropRunLocked(key, rp)
	if p.cfg.LeaseEnabled { // as the sweep does: see sweepOnce
		retireLeaseState(p.cfg.WorkspaceRoot, key, p.leaseStateIfAnyLocked(rp))
	}
	return tomb, nil
}

// dropRunLocked removes key's run from the map, and from pendingReleases if a Release
// had marked it. Every path that drops a run whose workspace it detached goes through
// here. Caller holds p.mu.
func (p *pool) dropRunLocked(key string, rp *runPool) {
	delete(p.runs, key)
	if rp.releaseOnIdle {
		rp.releaseOnIdle = false
		p.pendingReleases.Add(-1)
	}
}

// enqueueReclaimLocked hands b to the reclaim goroutine, as sweep does, so a release's
// destroys and its tree removal run on neither the relay's call nor an Exec's unwind. It
// returns what it could not queue (the queue full, or the pool closed): the caller runs
// that with doReclaim after releasing p.mu, inline, as sweep does -- a dropped batch is a
// leak, and destroying under p.mu would stall every Exec. Caller holds p.mu.
func (p *pool) enqueueReclaimLocked(b reclaimBatch) reclaimBatch {
	if len(b.vms) == 0 && len(b.dirs) == 0 {
		return reclaimBatch{}
	}
	if !p.closed {
		select {
		case p.reclaimQ <- b:
			return reclaimBatch{}
		default:
		}
	}
	return b
}

// releaseIfPending frees key's workspace if a Release met its run busy and it no longer
// is. ExecPhased defers it, so it runs after the Exec's VM is destroyed and its gate is
// open; a run still busy (another Exec, a live lease) is left for the next one, or for the
// sweep. The common case, no release pending anywhere, takes no lock.
func (p *pool) releaseIfPending(key string) {
	if p.pendingReleases.Load() == 0 {
		return
	}
	p.mu.Lock()
	rp := p.runs[key]
	if rp == nil || !rp.releaseOnIdle || rp.busy() {
		p.mu.Unlock()
		return
	}
	b := reclaimBatch{vms: rp.ready}
	rp.ready = nil
	for _, tm := range rp.pending {
		tm.Stop()
	}
	rp.pending = nil
	tomb, err := p.detachRunLocked(key, rp)
	if err != nil {
		log.Printf("vmpool: release %q after its Exec: detach: %v; the sweep retries", key, err)
	} else if tomb != "" {
		b.dirs = append(b.dirs, tomb)
	}
	left := p.enqueueReclaimLocked(b)
	p.mu.Unlock()
	p.doReclaim(left)
}

// afterReleaseCheck is a test seam: when set, ExecPhased calls it right after its early
// refuseReleased check, so a test can land a Release between that check and the acquire
// deterministically. Always nil outside tests. A package variable, unguarded: tests that
// set it must not use t.Parallel.
var afterReleaseCheck func()

// releasedAtLocked reports whether key was released within WorkspaceIdle, and when; an
// expired entry is dropped. Caller holds p.mu.
func (p *pool) releasedAtLocked(key string) (time.Time, bool) {
	at, ok := p.released[key]
	if ok && p.clk.Now().Sub(at) >= p.cfg.WorkspaceIdle {
		delete(p.released, key)
		return time.Time{}, false
	}
	return at, ok
}

func releasedRefusal(key string, at time.Time) *RefusalError {
	return refusal(RefuseReleased, "workspace_key %q was released at %s (its session or sandbox has ended)",
		key, at.UTC().Format(time.RFC3339))
}

// refuseReleased is ExecPhased's fast-path refusal of an Exec for a released key, before
// the sweep, the lease guard and the acquire; runAtLocked repeats the check where a run
// would be created.
func (p *pool) refuseReleased(key string) error {
	p.mu.Lock()
	at, ok := p.releasedAtLocked(key)
	p.mu.Unlock()
	if !ok {
		return nil
	}
	return p.countRefusal(releasedRefusal(key, at))
}

// pruneReleasedLocked drops released keys older than WorkspaceIdle, so the set is bounded
// by the release rate times WorkspaceIdle. Caller holds p.mu.
func (p *pool) pruneReleasedLocked(now time.Time) {
	for k, at := range p.released {
		if now.Sub(at) >= p.cfg.WorkspaceIdle {
			delete(p.released, k)
		}
	}
}
