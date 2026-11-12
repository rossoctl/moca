package vmpool

import "sync"

// Stats is spec §7.1's vocabulary, kept apart on purpose. The dishonest number
// available here is "we ran 5,000 microVMs on one host": standbys are paused and
// CoW-shared, so that count inflates almost arbitrarily. StandbysResident is a
// memory-and-process statement, NOT a throughput claim; only InFlight is the
// resource-consuming quantity a knee applies to.
type Stats struct {
	InFlight             int   // VMs actually running a command
	ActiveRuns           int   // distinct workspace_keys with a live pool
	ParkedRuns           int   // RunParked keys: a workspace with zero standbys
	StandbysResident     int   // total paused VMs
	IdleStandbyResidency int   // standbys of runs idle > StandbyIdle/2 (spec §7.1)
	CommittedBytes       int64 // what the memory gate is holding against MaxCommittedBytes
	// StandbyCommittedBytes is the PAUSED component of CommittedBytes (#644): the
	// dirty-page charge of every ready standby. Reported beside CommittedBytes —
	// and never instead of it — because only the pair answers the question a
	// density ladder stops on: was the ceiling the running VMs (a real memory
	// bound) or the standby booking (bookkeeping)? Running VMs make up the
	// difference, CommittedBytes - StandbyCommittedBytes, each at full PerVMBytes.
	StandbyCommittedBytes int64

	WarmAcquires      uint64
	ColdAcquires      map[ColdCause]uint64
	Refusals          map[RefusalReason]uint64
	Replenishments    uint64
	ReplenishFailures uint64
	DestroyFailures   uint64
	// ReapsInline counts deferred reaps that ran on the caller's goroutine because the
	// reaper's queue was full -- i.e. teardowns that paid today's synchronous cost anyway.
	// Nonzero means the reaper is saturated, which is the first thing to check when a
	// deferral arm measures flat: the arm was partly not applied.
	ReapsInline uint64
	// BarrierUnobserved counts teardowns whose descriptor barrier could not be read, each of
	// which fell back to reaping synchronously under execGate. A SEPARATE reason from
	// ReapsInline, and separate from DestroyFailures: the destroy succeeded, it just did not
	// get to be deferred. Folding it into DestroyFailures made one VM contribute twice when
	// its barrier was unreadable AND its reap then failed, which over-reports against the VM
	// count -- the ratio you would use to decide whether the fallback is firing.
	BarrierUnobserved uint64
	// TimeoutsClamped counts Execs whose timeout_s this package had to bound
	// (clampTimeoutS): absent/zero, or above MaxExecTimeoutS. A nonzero and growing
	// figure is a caller-side fact, not a pool fault — most likely a relay that omits
	// the field — and it is the only visibility on it after the first log line.
	TimeoutsClamped uint64
	// BudgetEvictions counts standbys shed by evictForBudgetLocked: user-visible memory
	// refusals (#452) that were turned into somebody else's cold acquire instead.
	//
	// READ IT AGAINST Refusals[RefuseMemoryBudget], because only the pair distinguishes
	// the two states. Evictions rising while that stays flat is the mechanism absorbing
	// the pressure. BOTH rising together means eviction has run out of idle standbys to
	// take, and MICROVM_MAX_COMMITTED_MB is genuinely too small for the number of
	// distinct sessions this host sees — the sizing question #452 is about, which no
	// amount of eviction answers.
	//
	// It is also the cost line for the trade, stated honestly: each eviction is a cold
	// acquire a quiet session pays on its next turn. Large here against a small
	// ColdAcquires[ColdParked] means this is churning standbys rather than relieving
	// anything.
	BudgetEvictions uint64

	// Lease mode (lease.go), all zero on a worker that never served a lease. LeaseVMs
	// counts live lease VMs, idle or not; LeaseExecuting those inside an Exec's Run
	// (InFlight counts per-Exec VMs only). LeaseCommittedBytes is the lease component
	// of CommittedBytes (spec §6's third accounting class). LeaseEnds counts ended
	// leases by spec §4.1 reason, worker_restart included (counted by the process that
	// reports it).
	LeaseVMs            int
	LeaseExecuting      int
	LeaseCommittedBytes int64
	LeaseEnds           map[LeaseEndReason]uint64
}

// counters is the mutable half. A mutex over two small maps rather than atomics
// per key: this is read once per scrape and written once per Exec.
type counters struct {
	mu                sync.Mutex
	warm              uint64
	cold              map[ColdCause]uint64
	refusals          map[RefusalReason]uint64
	replenishments    uint64
	replenishFailures uint64
	destroyFailures   uint64
	barrierUnobs      uint64
	timeoutsClamped   uint64
	budgetEvictions   uint64
	leaseEnds         map[LeaseEndReason]uint64
}

func newCounters() *counters {
	return &counters{cold: map[ColdCause]uint64{}, refusals: map[RefusalReason]uint64{}, leaseEnds: map[LeaseEndReason]uint64{}}
}

func (c *counters) warmAcquire() { c.mu.Lock(); c.warm++; c.mu.Unlock() }

func (c *counters) coldAcquire(cause ColdCause) { c.mu.Lock(); c.cold[cause]++; c.mu.Unlock() }

func (c *counters) refuse(r RefusalReason) { c.mu.Lock(); c.refusals[r]++; c.mu.Unlock() }

func (c *counters) replenished() { c.mu.Lock(); c.replenishments++; c.mu.Unlock() }

func (c *counters) replenishFailed() { c.mu.Lock(); c.replenishFailures++; c.mu.Unlock() }

func (c *counters) destroyFailed() { c.mu.Lock(); c.destroyFailures++; c.mu.Unlock() }

func (c *counters) barrierUnobserved() { c.mu.Lock(); c.barrierUnobs++; c.mu.Unlock() }

func (c *counters) timeoutClamped() { c.mu.Lock(); c.timeoutsClamped++; c.mu.Unlock() }

// leaseEnded is called with pool.mu held (endLeaseLocked), safe for evicted's reason.
func (c *counters) leaseEnded(r LeaseEndReason) { c.mu.Lock(); c.leaseEnds[r]++; c.mu.Unlock() }

// evicted is called with pool.mu HELD (evictForBudgetLocked). Safe, and the only
// counter that is: counters has its own mutex and never reaches back into the pool, so
// the two locks are always taken in this order and never the other.
func (c *counters) evicted() { c.mu.Lock(); c.budgetEvictions++; c.mu.Unlock() }

func (c *counters) snapshot(into *Stats) {
	c.mu.Lock()
	defer c.mu.Unlock()
	into.WarmAcquires = c.warm
	into.Replenishments = c.replenishments
	into.ReplenishFailures = c.replenishFailures
	into.DestroyFailures = c.destroyFailures
	into.BarrierUnobserved = c.barrierUnobs
	into.TimeoutsClamped = c.timeoutsClamped
	into.BudgetEvictions = c.budgetEvictions
	into.ColdAcquires = make(map[ColdCause]uint64, len(c.cold))
	for k, v := range c.cold {
		into.ColdAcquires[k] = v
	}
	into.Refusals = make(map[RefusalReason]uint64, len(c.refusals))
	for k, v := range c.refusals {
		into.Refusals[k] = v
	}
	into.LeaseEnds = make(map[LeaseEndReason]uint64, len(c.leaseEnds))
	for k, v := range c.leaseEnds {
		into.LeaseEnds[k] = v
	}
}
