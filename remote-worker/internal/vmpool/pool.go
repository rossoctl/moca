package vmpool

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Exec is one command as the pool sees it: pb.Exec minus the wire types.
//
// TimeoutS is NOT taken at face value: it arrives from the relay as a plain proto3
// field, so "absent" and "0" are indistinguishable on the wire, and 0 armed no timer
// at all on either side. clampTimeoutS bounds it at this boundary — see its comment
// for why this tier cannot honour "0 means unbounded" the way the container tier can.
type Exec struct {
	ReqID     uint64
	Command   string
	Stdin     []byte
	TimeoutS  uint32
	Streaming bool

	// Lease mode (spec §3, §8.2). The relay sets Mode and ModeEpoch from the sandbox
	// token's claims; the zero values are today's per-Exec path. IdleTimeout is the
	// owner's lease idle timeout: 0 means Config.LeaseIdleDefault, and any value is
	// clamped to [LeaseIdleMin, LeaseIdleCeiling]. Keepalive opts the lease into the
	// keepalive-loss rule (spec §4).
	Mode        Mode
	ModeEpoch   uint64
	IdleTimeout time.Duration
	Keepalive   bool
}

// Bounds on Exec.TimeoutS. Every Exec is bounded; there is no unbounded form.
//
// DefaultExecTimeoutS is deliberately the SAME 30 minutes as
// packages/k8s-sandbox/src/transport.ts's DEFAULT_EXEC_TIMEOUT_S, which every
// transport already applies when a caller names no timeout (#182). So a request that
// reaches this tier without a timeout now gets the budget the harness itself would
// have chosen, not a different one invented here.
//
// MaxExecTimeoutS is the ceiling. It is four times the default rather than close to
// it because a clamp that truncates a legitimate long command is worse than the
// unbounded case it replaces: this number only has to be far below "forever" and
// comfortably above anything the harness or the E10/E11 drivers ask for (the relay's
// own deadline is the 30-minute default; vmpoolctl's -timeout-s default is 30s).
const (
	DefaultExecTimeoutS uint32 = 30 * 60
	MaxExecTimeoutS     uint32 = 4 * DefaultExecTimeoutS
)

// clampTimeoutS bounds one Exec's timeout, returning the value to use and whether it
// differs from what the caller asked for.
//
// WHY A ZERO CANNOT MEAN UNBOUNDED HERE. On the container tier an exec with
// timeout_s == 0 is documented as unbounded (transport.ts), and what it pins is a pod
// slot. On this tier the same request pins a live microVM, its admission-control
// reservation against MaxCommittedBytes, AND — on the Firecracker arm, which
// serializes per run — every subsequent Exec for that workspace_key, until the relay
// stream dies. There is no code path that can free any of that while the guest never
// answers, so "unbounded" is not a mode this tier can offer.
//
// The clamped value is what the host timer arms AND what is sent to the guest as its
// own timeout_s (see ExecPhased), so the two sides cannot hold different budgets: the
// guest is told exactly the bound the host is enforcing.
func clampTimeoutS(timeoutS uint32) (uint32, bool) {
	switch {
	case timeoutS == 0:
		return DefaultExecTimeoutS, true
	case timeoutS > MaxExecTimeoutS:
		return MaxExecTimeoutS, true
	}
	return timeoutS, false
}

// Pool is the package's whole contract (spec §4.1).
//
// Exec is deliberately high-level rather than Acquire/Destroy: the VM handle never
// escapes the package, destroy is a defer, and a caller cannot leak a VM by
// returning early.
type Pool interface {
	// Exec acquires a standby VM bound to key's workspace, runs exactly one
	// command, and destroys the VM before returning. A VM is NEVER reused -- except
	// in lease mode (Exec.Mode, lease.go), where one VM serves one key's Execs until
	// its lease ends, and is then destroyed, never pooled (spec §3).
	Exec(ctx context.Context, key string, e Exec, out Sink) (Result, error)
	// ExecPhased is Exec with the hot path decomposed into Phases, for vmpoolctl
	// and E10's driver (spec §3.1). ph may be nil. There is exactly one
	// implementation: Exec delegates to this with a throwaway Phases.
	ExecPhased(ctx context.Context, key string, e Exec, out Sink, ph *Phases) (Result, error)
	// Reclaim drops a run's standby VMs AND its workspace directory — the full
	// form. Dropping standbys alone is internal to the sweep (spec §4.4).
	Reclaim(ctx context.Context, key string) error
	Stats() Stats
	// Probe restores one VM, runs a trivial command in it and destroys it, without
	// otherwise touching the pool's accounting. Spec §6's last row: a pinned hash is
	// not sufficient — a snapshot can be intact and still unrestorable on this host —
	// so the caller (the worker's startup sequence) must fail at START, not on a
	// user's first request.
	Probe(ctx context.Context) error
	// SetMode records a verified LeaseControl set_mode for key: {m, epoch}, known. It
	// refuses an epoch below a known one (stale-mode), and a lease mode on a worker
	// that cannot serve it (lease-unsupported). Spec §8.2.
	//
	// A downgrade to per-exec ends a live lease (mode_change) before SetMode returns, so
	// it BLOCKS for the Exec in flight: up to LeaseGraceLimit (30 min by default), after
	// which that Exec is cut, plus its unwind. lease+processes -> lease keeps the lease.
	SetMode(key string, m Mode, epoch uint64) error
	// Keepalive records a keepalive for key's live lease: the keepalive-loss rule then
	// applies until the lease ends. It never resets the idle clock, and without a live
	// lease it is a no-op. Spec §4.
	Keepalive(key string) error
	// LeaseStatus reports key's stored mode, whether its epoch is known, the live lease
	// (none, active or expiring, its age and idle timeout, and an expiring lease's
	// deadline) and the unacknowledged lease event. Spec §5, §8.3's LeaseControl status.
	LeaseStatus(key string) LeaseInfo
	// AckLeaseEvent clears key's pending lease event whose At equals at; a newer one
	// stays. Spec §5: the worker keeps the last end event until a client has seen it.
	AckLeaseEvent(key string, at time.Time)
	// EndLease ends key's live lease for reset or sandbox_deleted, and refuses any other
	// reason. It BLOCKS for the Exec in flight: up to LeaseGraceLimit, after which that
	// Exec is cut with lease_ended(<reason>), plus its unwind. Spec §8.3.
	EndLease(key string, reason LeaseEndReason) error
	// Close stops the sweep and destroys everything. Beyond spec §4.1's listing:
	// §6 requires a shutdown that leaves no orphan VMs.
	Close() error
}

type pool struct {
	cfg Config
	lc  Launcher
	clk Clock

	// serialize mirrors lc.SerializesExecsPerRun(), read once at construction: the
	// Launcher (not Config) decides whether a run's ext4 workspace can tolerate two
	// mounted guests at once, so ExecPhased consults this instead of Config.VMM.
	serialize bool

	mu     sync.Mutex
	runs   map[string]*runPool
	closed bool
	seq    uint64

	counters *counters

	// ticker is spec §4.2's second sweep trigger: the per-Exec sweep alone cannot
	// reclaim a run whose last Exec was also its last (Task 6).
	ticker Timer
	// leaseTicker ends leases on time (lease.go, sweepLeasesLocked): idle, keepalive
	// loss, maximum duration, grace limit. Armed only when LeaseEnabled, and apart from
	// ticker, so the per-Exec sweep's timing is the same with lease mode on or off.
	leaseTicker Timer
	reclaimQ    chan reclaimBatch
	reclaimDone sync.WaitGroup
	// reaper is nil unless Config.DeferReapWorkers > 0. When set, destroy hands each VM's
	// reap tail to it after the barrier instead of running it under execGate (#307).
	reaper *reaper

	// inFlightWarms counts background replenishment warms that have been admitted but
	// not yet settled, so Close can wait for them. Not guarded by mu: it is a
	// WaitGroup, and the Add/Wait ordering that makes it safe is the mu hold in
	// replenishOne, not the counter itself. See Close.
	inFlightWarms sync.WaitGroup

	// clampLogged keeps the timeout clamp's log line to one per process. The
	// per-Exec visibility is Stats().TimeoutsClamped — a caller that omits
	// timeout_s on EVERY request would otherwise log once per Exec, at up to the
	// tier's full Exec rate, which is how a real diagnostic becomes noise nobody
	// reads.
	clampLogged sync.Once
}

// New validates cfg and returns a Pool. It starts the reclaim goroutine and arms
// the reclaim ticker (spec §4.2's second sweep trigger) before returning, so a
// caller's very first Exec is already covered by both.
func New(cfg Config, lc Launcher, clk Clock) (Pool, error) {
	if err := cfg.Normalize(); err != nil {
		return nil, err
	}
	if lc == nil {
		return nil, fmt.Errorf("vmpool: a Launcher is required")
	}
	if lc.Kind() != cfg.VMM {
		return nil, fmt.Errorf("vmpool: Launcher is %q but Config.VMM is %q — the A/B is an image "+
			"swap, so a mismatch here would silently measure the wrong arm", lc.Kind(), cfg.VMM)
	}
	// spec §6's "fail the unit at start", same reasoning as Probe's KVM-unavailable
	// check: an operator who puts workspaces, snapshots and the jail/run directory
	// on three individually-reasonable filesystems gets EXDEV on every Exec, with
	// an error that reads like a launcher bug, unless this is caught here instead.
	// This is the one place a Config and a constructed Launcher are always both in
	// scope (see deviceRequirer's doc comment) — every real deployment path
	// (cmd/microvm-worker/main.go) and every gate (poolFor, TestGateLeakFreeTeardown)
	// calls New, so nothing that skips this check exists.
	if dr, ok := lc.(deviceRequirer); ok {
		if err := dr.checkDeviceSharing(cfg); err != nil {
			return nil, err
		}
	}
	if clk == nil {
		clk = RealClock()
	}
	// Computed, never configured: a Config claiming lease support the VMM or the
	// snapshot cannot back would put lease Execs on a guest without plan 1's half.
	cfg.LeaseEnabled = LeaseSupported(cfg)
	// Before anything is served, and before endLeasesOpenAtStart reads the state files.
	if err := markLeaseBoot(cfg.WorkspaceRoot, cfg.LeaseEnabled); err != nil {
		return nil, err
	}
	p := &pool{cfg: cfg, lc: lc, clk: clk, serialize: lc.SerializesExecsPerRun(), runs: map[string]*runPool{}, counters: newCounters()}
	// nil unless DeferReapWorkers > 0, and nil is the whole "off" implementation: destroy
	// below checks it, and reaper's methods are nil-safe.
	p.reaper = newReaper(cfg.DeferReapWorkers)
	// Before anything is served: the previous process's open leases ended with it.
	p.endLeasesOpenAtStart()
	// Sized so a full host's worth of sweeps queues rather than blocking; a full
	// queue falls back to an inline destroy (see sweep).
	p.reclaimQ = make(chan reclaimBatch, 64)
	p.reclaimDone.Add(1)
	go p.reclaimLoop()
	p.mu.Lock()
	p.armTickerLocked()
	if cfg.LeaseEnabled {
		p.armLeaseTickerLocked()
	}
	p.mu.Unlock()
	return p, nil
}

func (p *pool) refuse(r RefusalReason, format string, a ...any) error {
	p.counters.refuse(r)
	return refusal(r, format, a...)
}

// classify maps an error from any timeout-bounded step onto the sentinel the wire
// contract needs, or returns nil if the step's error is not a cancellation at all and
// the caller should classify it on its own terms.
//
// Timeout is tested BEFORE abort, and that order is load-bearing: the timer cancels
// runCtx, so checking the abort case first would report every timeout as an abort and
// the worker would emit a terminal signal frame where the contract requires
// ExecError{"timeout:<n>"}. The outer ctx is what distinguishes a genuine abort from
// the timer's own cancellation, which is why it — and not runCtx — is the argument.
func (p *pool) classify(ctx context.Context, timedOut *atomic.Bool, timeoutS uint32) error {
	switch {
	case timedOut.Load():
		return fmt.Errorf("%w:%d", ErrTimeout, timeoutS)
	case ctx.Err() != nil:
		return ErrAborted
	}
	return nil
}

func (p *pool) Exec(ctx context.Context, key string, e Exec, out Sink) (Result, error) {
	return p.ExecPhased(ctx, key, e, out, nil)
}

// Phases is the hot path decomposed, filled by ExecPhased. E10 rung 2 measures
// "vsock -> run -> response -> teardown" as separate terms, and a single round-trip
// number cannot answer the 15ms question — it hides which term is the cost.
type Phases struct {
	Acquire time.Duration // pop a Ready VM, or warm one (a cold acquire)
	Resume  time.Duration
	Run     time.Duration
	Destroy time.Duration
	Cold    ColdCause // "" when the acquire was warm
	VMID    string    // the VM that ran this Exec; "" when acquire failed

	// Normalise is a lease start's normalise step (lease.go, normaliseLease): the
	// ownership walk the guest runs before the lease's first Exec when root has written
	// the workspace. Zero when the Exec started no lease or its lease needed no walk.
	Normalise time.Duration

	// Resume's three sub-phases, populated only by a launcher implementing
	// resumePhaser (Firecracker does; CHV does not, and reports zeros). They sum to
	// Resume PER EXEC, to ~0.1% -- the remainder is checkNotDestroyed, newFCClient and
	// the pre-mount error checks. Aggregated percentiles do NOT add: each sub-phase's
	// p50 comes from a different Exec, so the ladder's columns leave 0.5% at 8 slots
	// rising to 2.7% at 64 (the note has the figures). Resume is deliberately left
	// meaning the whole phase: several campaign tables compare resume_us across runs,
	// and a silently redefined field reads as a missing phase rather than as an error
	// (#336 kept total_us the same way).
	//
	// Resume was the last opaque phase on the execGate-held critical path -- ~35.5 ms of
	// an ~82 ms Exec at 64 slots (43%) with nothing inside it. Of that, the guest's
	// /workspace mount is 78-81% at every rung from 8 to 64 slots; see
	// docs/notes/2026-09-23-307-resume-decomposition.md for the ladder those come from.
	VMResume  time.Duration // PATCH /vm {state: Resumed} -- Firecracker un-pauses the vcpus
	VsockDial time.Duration // host-initiated vsock dial + "CONNECT <port>" handshake
	Mount     time.Duration // guest round trip running the /workspace mount

	// The VM's CPU over this Exec: its cgroup's cpu.stat read once the VM is acquired and once
	// just before it is destroyed, so a pooled cgroup's earlier tenants are subtracted out. Set
	// only by a VM implementing cpuReporter (diag.go); CPUMeasured false means "not measured",
	// never "used no CPU". It covers resume through run: the standby's restore happened before
	// the acquire and is not this Exec's.
	CPUUser, CPUSys time.Duration
	CPUMeasured     bool
}

// ExecPhased is Exec with instrumentation. Exec delegates to it with a throwaway
// Phases, so there is exactly one implementation and the measured path IS the
// production path (spec §3.1: "E10 must measure the production code path"). ph may
// be nil — every stamp below guards for it — so callers that do not care about the
// decomposition (i.e. Exec itself) pay nothing for it.
func (p *pool) ExecPhased(ctx context.Context, key string, e Exec, out Sink, ph *Phases) (Result, error) {
	// Trigger 1 of spec §4.2's two: a map walk over at most MaxRuns entries,
	// microseconds, not a timer per run. The destroys it schedules happen on the
	// reclaim goroutine, so this adds no munmap to the hot path.
	p.sweep(p.clk.Now())

	if err := checkKey(key); err != nil {
		return Result{}, p.countRefusal(err)
	}
	if e.Mode != ModePerExec && !p.cfg.LeaseEnabled {
		return Result{}, p.refuse(RefuseLeaseUnsupported, "%s Exec for %q: %s", e.Mode, key, leaseUnsupportedDetail)
	}

	// The timeout must bound the WHOLE Exec, including a cold acquire's VM boot —
	// not just vm.Run — or a wedged VMM hangs until the relay stream dies. The
	// container worker times its exec around the entire process spawn for the same
	// reason: the harness cannot tell the two tiers apart, and spec §6 requires a
	// cold-acquire storm to stay "counted, never queued unboundedly."
	//
	// The bound is UNCONDITIONAL. It used to be armed only for TimeoutS > 0, and
	// timeout_s is a plain proto3 field, so an Exec that simply omitted it was
	// bounded by nothing on either side — see clampTimeoutS.
	timeoutS, clamped := clampTimeoutS(e.TimeoutS)
	if clamped {
		p.counters.timeoutClamped()
		p.clampLogged.Do(func() {
			log.Printf("vmpool: Exec timeout_s=%d clamped to %d (default %d, ceiling %d); "+
				"further clamps are counted in Stats().TimeoutsClamped, not logged",
				e.TimeoutS, timeoutS, DefaultExecTimeoutS, MaxExecTimeoutS)
		})
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var timedOut atomic.Bool
	fire := func() {
		timedOut.Store(true)
		cancel()
	}
	deadline := p.clk.Now().Add(time.Duration(timeoutS) * time.Second)
	tm := p.clk.AfterFunc(time.Duration(timeoutS)*time.Second, fire)
	defer func() { tm.Stop() }() // the timer live at return: a lease Exec extends it

	if p.cfg.LeaseEnabled {
		// Lease mode (lease.go). With LeaseEnabled false -- every worker without the
		// lease-v1 snapshot -- none of this runs and the path below is today's.
		mode, endFirst, err := p.routeExec(key, e)
		if err != nil {
			return Result{}, err
		}
		switch {
		case mode != ModePerExec:
			// The host's timer stays at the budget's end through the gate wait, the
			// acquire, Resume and the normalise step. runLease calls extend immediately
			// before Run, which moves it LeaseTimeoutSlack past the budget, so the guest's
			// own timeout fires first and the lease survives it (LeaseTimeoutSlack). extend
			// reports false when the timer has already fired: the Exec is timed out, and
			// runLease does not run it (PR #763 second review, G1).
			extend := func() bool {
				if !tm.Stop() {
					return false
				}
				tm = p.clk.AfterFunc(deadline.Add(LeaseTimeoutSlack).Sub(p.clk.Now()), fire)
				return true
			}
			res, err := p.execLease(ctx, runCtx, key, e, mode, out, ph, &timedOut, timeoutS, deadline, extend)
			if !errors.Is(err, errServePerExec) {
				return res, err
			}
			// A same-epoch downgrade to per-exec landed while the Exec queued (execLease
			// ended the lease, mode_change): it runs per-Exec below. The timer was never
			// extended, so the per-Exec budget has no slack.
		case endFirst:
			// A per-Exec Exec on a key that holds a lease: the lease ends (mode_change)
			// under the gate BEFORE this Exec acquires, so its VM is never restored
			// beside a live lease VM (Review Focus 2).
			if err := p.endLeaseForPerExec(ctx, runCtx, key, &timedOut, timeoutS); err != nil {
				return Result{}, err
			}
		}
	}

	t0 := p.clk.Now()
	vm, rp, cause, err := p.acquire(runCtx, key, false)
	if ph != nil {
		ph.Acquire = p.clk.Now().Sub(t0)
		ph.Cold = cause
	}
	if err != nil {
		if cErr := p.classify(ctx, &timedOut, timeoutS); cErr != nil {
			return Result{}, cErr
		}
		return Result{}, err
	}
	if ph != nil {
		ph.VMID = vmID(vm)
	}
	cpu, cpuOK := vm.(cpuReporter)
	var u0, s0 time.Duration
	if ph != nil && cpuOK {
		u0, s0, cpuOK = cpu.CgroupCPU()
	}
	// One identical teardown for abort, timeout and success (spec §4.1). Named rather
	// than written inline as a defer because the gate below has one path that must run
	// it before any defer of its own is registered.
	destroy := func() {
		if ph != nil && cpuOK {
			if u1, s1, ok := cpu.CgroupCPU(); ok {
				ph.CPUUser, ph.CPUSys, ph.CPUMeasured = u1-u0, s1-s0, true
			}
		}
		t0 := p.clk.Now()
		p.destroy(key, vm)
		if ph != nil {
			ph.Destroy = p.clk.Now().Sub(t0)
		}
	}
	if p.serialize {
		// Firecracker arm only. The workspace's ext4 image is not a shared-disk
		// filesystem: two guests mounting it rw at once would corrupt it, so
		// concurrent Execs for one run queue here — which is exactly the
		// constraint E10 must measure the arm under rather than around
		// (spec §4.3). Registered BEFORE the destroy defer below so that, on
		// unwind, this VM is fully destroyed (and its mount released) before the
		// gate opens for the next command — see rp.execGate's doc comment.
		//
		// The WAIT is selectable on runCtx: a VM is already acquired and charged at
		// this point, and an unselectable wait meant an abort or a timeout could not
		// release either while a wedged guest held the gate.
		select {
		case rp.execGate <- struct{}{}:
			defer func() { <-rp.execGate }()
		case <-runCtx.Done():
			// The gate is NOT held and the destroy defer is not registered yet, so
			// this VM is torn down here — the one path in this function that does its
			// own teardown, and the reason destroy is a named closure.
			destroy()
			if cErr := p.classify(ctx, &timedOut, timeoutS); cErr != nil {
				return Result{}, cErr
			}
			return Result{}, ErrAborted
		}
	}
	// No early return below can leak a VM.
	defer destroy()

	if p.cfg.LeaseEnabled {
		if err := p.perExecUnderGate(rp); err != nil {
			return Result{}, err
		}
	}

	if vm.Key() != key {
		return Result{}, fmt.Errorf("%w: popped %q for %q", ErrKeyMismatch, vm.Key(), key)
	}
	t0 = p.clk.Now()
	resumeErr := vm.Resume(runCtx)
	if ph != nil {
		ph.Resume = p.clk.Now().Sub(t0)
		// Read the sub-phases even on the error path: a Resume that failed IN one of
		// the three steps is exactly when knowing which one matters most.
		if rp, ok := vm.(resumePhaser); ok {
			ph.VMResume, ph.VsockDial, ph.Mount = rp.ResumePhases()
		} else {
			// Zero them rather than leaving whatever the struct held. "A launcher
			// without the seam reports zeros" is resumePhaser's documented contract
			// (diag.go), and writing it here makes it a property of this function
			// instead of one every caller upholds by allocating a fresh Phases.
			ph.VMResume, ph.VsockDial, ph.Mount = 0, 0, 0
		}
	}
	if resumeErr != nil {
		if cErr := p.classify(ctx, &timedOut, timeoutS); cErr != nil {
			return Result{}, cErr
		}
		return Result{}, p.refuse(RefuseSpawn, "resume %q: %v", key, resumeErr)
	}

	t0 = p.clk.Now()
	res, runErr := vm.Run(runCtx, Command{
		Command: e.Command,
		Stdin:   e.Stdin,
		// The CLAMPED value, not e.TimeoutS: the guest arms its own timer from this
		// field, and the one thing worse than an unbounded Exec is a host and a guest
		// enforcing different budgets for the same command.
		TimeoutS:  timeoutS,
		Streaming: e.Streaming,
		CapBytes:  OutputCapBytes,
	}, out)
	if ph != nil {
		ph.Run = p.clk.Now().Sub(t0)
	}

	if cErr := p.classify(ctx, &timedOut, timeoutS); cErr != nil {
		return res, cErr
	}
	return res, runErr
}

// acquire returns a VM bound to key: warm if one is Ready, cold otherwise. The
// returned ColdCause is the cause of the cold acquire ("" for a warm one), so
// ExecPhased can carry it into Phases.Cold; every error path returns an empty
// cause because there is nothing yet to attribute.
//
// The cold path blocks on the warming already in flight rather than starting a
// second one (spec §4.2), then loops. Looping rather than recursing is what keeps
// the acquire counted exactly once — cold-acquire rate is E11's headline diagnostic,
// and double-counting it would read as replenishment falling behind.
//
// With lease true the VM is for a new lease (lease.go, spec §6): the promotion check
// and the cold path's warming charge are priced at LeaseStartBytes (the cold charge
// in rp.warmingLease, not rp.warming), and the VM is returned installed as rp.lease
// -- a vmLease holding only the VM, which execLease completes -- instead of counted
// in rp.inFlight. Installing it in the critical section that ends the warming or the
// pop keeps the VM charged exactly once at every instant, as the per-Exec handoff
// below does for inFlight.
func (p *pool) acquire(ctx context.Context, key string, lease bool) (VM, *runPool, ColdCause, error) {
	price := p.perVMBytes()
	if lease {
		price = p.cfg.LeaseStartBytes
	}
	counted := false
	var cause ColdCause
	for {
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return nil, nil, "", ErrClosed
		}
		rp, fresh, err := p.runLocked(key)
		if err != nil {
			p.mu.Unlock()
			return nil, nil, "", p.countRefusal(err)
		}
		rp.lastExec = p.clk.Now()
		// A run routeExec created (lease.go) is not fresh here, but its first acquire is
		// still a first Exec's.
		fresh = fresh || rp.unacquired
		rp.unacquired = false

		if n := len(rp.ready); n > 0 {
			vm := rp.ready[n-1]
			// The promotion check (#644): popping this standby re-prices it from its
			// dirty-page charge to a full PerVMBytes, and that must still fit the
			// budget. Checked BEFORE the pop mutates anything — the check is pure, and
			// a refusal must leave the standby exactly where it was for a later,
			// colder host to promote. On a host whose slots x PerVMBytes fit the
			// budget this never fires; see admitPromotionLocked.
			if err := p.admitPromotionAtLocked(vm, price); err != nil {
				// RefuseMemoryBudget is fundable: eviction needs only
				// perVM minus this standby's dirty charge of headroom, which other
				// idle runs' standbys can cover — without it, a standby-heavy host
				// (replenishment books the budget to within one warming of full)
				// would fail warm acquires far below the slot ceiling, which is the
				// density regression #644 exists to remove. rp is excluded from the
				// victims, so the pop's slice arithmetic below stays valid.
				// RefuseHostMemory is NOT fundable this way: reclaimLoop destroys
				// asynchronously, so MemAvailable is unchanged at the re-check and
				// the standbys would be burned for a refusal either way.
				if ReasonOf(err) == RefuseMemoryBudget {
					p.evictForPromotionLocked(rp, vm, price)
					err = p.admitPromotionAtLocked(vm, price)
				}
				if err != nil {
					p.mu.Unlock()
					return nil, nil, "", p.countRefusal(err)
				}
			}
			rp.ready = rp.ready[:n-1]
			if lease {
				rp.lease = newVMLease(vm)
			} else {
				rp.inFlight++
			}
			p.mu.Unlock()
			if !counted {
				p.counters.warmAcquire()
			}
			return vm, rp, cause, nil
		}

		if !counted {
			cause = ColdExhausted
			switch {
			case fresh:
				cause = ColdFirstExec
			case rp.parked:
				cause = ColdParked
			}
			p.counters.coldAcquire(cause)
			counted = true
		}
		rp.parked = false

		if rp.warming > 0 {
			settled := rp.settled
			p.mu.Unlock()
			select {
			case <-settled:
				continue
			case <-ctx.Done():
				return nil, nil, "", ErrAborted
			}
		}

		// admitOrEvictLocked, not admitLocked: this refusal reaches a transcript, so a
		// coldest idle standby is shed to make room before one is returned (#452).
		admit := p.admitOrEvictLocked
		if lease {
			admit = p.admitLeaseOrEvictLocked
		}
		if err := admit(false); err != nil {
			p.mu.Unlock()
			return nil, nil, "", p.countRefusal(err)
		}
		// ONE charge for one VM. This used to increment inFlight here as well, and
		// committedLocked sums ready + inFlight + warming — so every in-flight cold
		// acquire was charged twice for exactly the duration of the restore, which is
		// when it matters. At a budget of 8 VMs and 4 concurrent cold acquires,
		// committed read as 8 VMs' worth while 4 existed and the 5th run was refused
		// RefuseMemoryBudget at half the intended concurrency — spec §6's named
		// cold-acquire-storm scenario, and an E11 density ceiling the tier does not
		// actually have. It errs safe (over-refusal, not over-commit), which is why it
		// was a suggestion rather than a must-fix, but a ceiling that reads low is still
		// a measurement of the wrong thing.
		if lease {
			rp.warmingLease++
		} else {
			rp.warming++
		}
		dir, id := rp.dir, p.nextIDLocked()
		p.mu.Unlock()

		vm, err := p.warm(ctx, key, dir, id)

		p.mu.Lock()
		if lease {
			rp.warmingLease--
		} else {
			rp.warming--
		}
		rp.signalSettledLocked()
		if err != nil {
			rp.backoff = nextBackoff(rp.backoff)
			p.mu.Unlock()
			if ctx.Err() != nil {
				// An abort during a cold warm is not a spawn failure. Counting it as
				// one pollutes the by-cause exec-error accounting, which has to tell a
				// real spawn failure apart from an ordinary cancellation, and it would
				// make the worker emit an exec error where the wire contract wants an
				// abort.
				return nil, nil, "", ErrAborted
			}
			return nil, nil, "", p.refuse(RefuseSpawn, "restore for %q: %v", key, err)
		}
		// The charge moves from warming to inFlight inside ONE critical section, so the
		// VM is charged exactly once at every instant a reader of committedLocked could
		// observe, and busy() never reads false in between — a gap there would let a
		// sweep reclaim the workspace of a VM that is about to run in it.
		// The charge moves from warming to inFlight inside ONE critical section, so the
		// VM is charged exactly once at every instant a reader of committedLocked could
		// observe, and busy() never reads false in between — a gap there would let a
		// sweep reclaim the workspace of a VM that is about to run in it.
		if lease {
			rp.lease = newVMLease(vm)
		} else {
			rp.inFlight++
		}
		rp.backoff = 0
		p.mu.Unlock()
		return vm, rp, cause, nil
	}
}

// warm creates the run's workspace if it does not exist and restores one VM into
// it. The mkdir is off the lock: a slow filesystem must not stall every other run's
// Exec, and MkdirAll is idempotent so concurrent warms for one key race harmlessly.
func (p *pool) warm(ctx context.Context, key, dir, id string) (VM, error) {
	if err := ensureWorkspace(dir); err != nil {
		return nil, fmt.Errorf("workspace %s: %w", dir, err)
	}
	return p.lc.Restore(ctx, RestoreRequest{
		ID:            id,
		Key:           key,
		WorkspaceDir:  dir,
		GuestRAMBytes: p.cfg.GuestRAMBytes,
	})
}

// destroy is the single teardown. A destroy failure is counted and logged, never
// returned: it does not change what the command did, and spec §6 makes leaked VMs
// the #1 practical failure — so it must be visible in Stats rather than folded into
// one exec's error.
func (p *pool) destroy(key string, vm VM) {
	p.mu.Lock()
	if rp := p.runs[key]; rp != nil {
		if rp.inFlight > 0 {
			rp.inFlight--
		}
		p.scheduleReplenishLocked(rp)
	}
	p.mu.Unlock()
	// The deferred path (#307). ExecPhased registers this before the gate-release defer, so
	// returning here IS the gate opening -- which is why only the barrier needs to have
	// happened first, and the reap tail can finish on a background worker. Measured: the
	// barrier is 1.41 ms median at c=64 against a 52.88 ms reap, and 96% of that reap runs
	// after the VMM has closed every descriptor, so it cannot touch workspace.img during it.
	//
	// The budget is already released above, BEFORE any teardown, exactly as it was -- so
	// deferring the tail does not widen the accounting window by a byte. It does not widen it
	// physically either: exit_mm completes before kvm_vm_release, so the guest RAM is returned
	// during the expensive part.
	if dr, ok := vm.(deferredReaper); ok && p.reaper != nil {
		if err := dr.KillAndBarrier(); err != nil {
			// THE BARRIER IS THE WHOLE LICENCE. Deferring without it would open the gate on
			// an argument this code cannot check, so an unobservable barrier falls back to the
			// OLD ordering: finish the entire teardown here, synchronously, before returning --
			// and returning is what opens the gate (see ExecPhased's defer order). Slower, and
			// exactly as safe as before the deferral existed.
			p.counters.barrierUnobserved()
			log.Printf("vmpool: barrier for %q: %v; reaping synchronously under the gate", key, err)
			if rErr := dr.Reap(); rErr != nil {
				p.counters.destroyFailed()
				log.Printf("vmpool: destroy VM for %q: %v", key, rErr)
			}
			return
		}
		p.reaper.submit(dr)
		return
	}
	if err := vm.Destroy(); err != nil {
		p.counters.destroyFailed()
		log.Printf("vmpool: destroy VM for %q: %v", key, err)
	}
}

// runLocked returns key's runPool, creating it if unseen. Caller holds p.mu.
func (p *pool) runLocked(key string) (*runPool, bool, error) {
	return p.runAtLocked(key, p.perVMBytes())
}

// runAtLocked is runLocked with a new run's first VM priced at price: PerVMBytes, or
// LeaseStartBytes for a run created by a lease Exec (spec §6). Caller holds p.mu.
func (p *pool) runAtLocked(key string, price int64) (*runPool, bool, error) {
	if rp := p.runs[key]; rp != nil {
		return rp, false, nil
	}
	// admitOrEvictLocked, not admitLocked: a new workspace_key on a full host is #452's
	// own repro ("create more distinct P4 sessions than the budget holds VMs"), and its
	// refusal reaches a transcript, so a coldest idle standby is shed first.
	if err := p.admitOrEvictAtLocked(true, price); err != nil {
		return nil, false, err
	}
	dir, err := p.workspaceDir(key)
	if err != nil {
		return nil, false, err
	}
	rp := &runPool{
		key: key, dir: dir,
		settled: make(chan struct{}),
		// Capacity 1: the gate admits one Exec per run at a time (see execGate).
		execGate: make(chan struct{}, 1),
		lastExec: p.clk.Now(),
	}
	p.runs[key] = rp
	return rp, true, nil
}

// nextIDLocked mints the next VM id. The prefix is vmIDPrefix (cgroup.go), not a literal:
// this id becomes the Firecracker arm's cgroup DIRECTORY name verbatim (jailer --id) and
// the stem of the Cloud Hypervisor arm's scope name, both of which SweepOrphans'
// fail-closed filter must recognise. Sharing the constant is what stops that filter from
// silently narrowing to nothing if the id shape ever changes (final review H1).
// vmID reads a VM's id through an optional accessor rather than widening the VM interface: every
// launcher's VM has one (it names the jail and the cgroup), but only the exec audit line needs it.
func vmID(vm VM) string {
	if v, ok := vm.(interface{ ID() string }); ok {
		return v.ID()
	}
	return ""
}

func (p *pool) nextIDLocked() string {
	p.seq++
	return vmIDPrefix + strconv.FormatUint(p.seq, 10)
}

// Reclaim drops a run's standbys AND its workspace directory. Safe to fire early:
// spec §4.4 establishes the workspace is a per-dispatch derivation — a detached
// worktree at a pinned commit, with continuity living in the Redis session log — so
// reclaiming costs a re-converge, never data.
//
// EXCEPT while an Exec is in flight, which is the one case where it costs exactly that.
// It used to keep the map entry when rp.busy() — correctly — and then remove the
// directory anyway, under the running command; on the Firecracker arm the guest would go
// on writing to a now-unlinked workspace.img inode (its jail hardlink keeps it alive) and
// those writes would vanish silently. There is no safe way to honour the request then, so
// the standbys are dropped, the workspace is KEPT, and the caller is told: the run's own
// idle clock reclaims the tree at WorkspaceIdle, which is late rather than wrong.
//
// The directory is detached under the lock and removed after (detachWorkspace), for the
// same reason the sweep does it: a key re-created between the two steps must not have its
// fresh tree deleted by this removal.
func (p *pool) Reclaim(ctx context.Context, key string) error {
	p.mu.Lock()
	rp := p.runs[key]
	if rp == nil {
		p.mu.Unlock()
		return nil
	}
	victims := rp.ready
	rp.ready = nil
	for _, tm := range rp.pending {
		tm.Stop()
	}
	rp.pending = nil
	busy := rp.busy()
	var tomb string
	var detachErr error
	if !busy {
		if tomb, detachErr = detachWorkspace(rp.dir); detachErr == nil {
			delete(p.runs, key)
			if p.cfg.LeaseEnabled { // as the sweep does: see sweepOnce
				retireLeaseState(p.cfg.WorkspaceRoot, key, p.leaseStateIfAnyLocked(rp))
			}
		}
	}
	p.mu.Unlock()

	for _, vm := range victims {
		if err := vm.Destroy(); err != nil {
			p.counters.destroyFailed()
			log.Printf("vmpool: reclaim %q: destroy: %v", key, err)
		}
	}
	switch {
	case busy:
		return fmt.Errorf("vmpool: reclaimed %q's standbys but KEPT its workspace: an Exec is "+
			"in flight, and removing the tree under a running command loses its writes silently "+
			"on the Firecracker arm; WorkspaceIdle will reclaim it", key)
	case detachErr != nil:
		return detachErr
	}
	return removeWorkspace(tomb)
}

func (p *pool) Stats() Stats {
	var s Stats
	p.mu.Lock()
	now := p.clk.Now()
	half := p.cfg.StandbyIdle / 2
	for _, rp := range p.runs {
		s.ActiveRuns++
		s.InFlight += rp.inFlight
		s.StandbysResident += len(rp.ready)
		if rp.parked {
			s.ParkedRuns++
		}
		if rp.idleFor(now) > half {
			s.IdleStandbyResidency += len(rp.ready)
		}
		if rp.lease != nil {
			s.LeaseVMs++
			if rp.lease.running {
				s.LeaseExecuting++
			}
		}
	}
	s.CommittedBytes = p.committedLocked()
	s.LeaseCommittedBytes = p.leaseCommittedLocked()
	s.StandbyCommittedBytes = p.standbyCommittedLocked()
	p.mu.Unlock()
	p.counters.snapshot(&s)
	// Read off the reaper rather than the counters: it owns the number, and a nil reaper
	// (deferral off) reports 0 without a branch here.
	s.ReapsInline = p.reaper.inlineCount()
	return s
}

// perVMBytes is what one RUNNING VM costs the budget: full guest RAM plus
// overhead, charged to inFlight and warming VMs (and to a standby at the moment
// of its promotion — admitPromotionLocked). A paused standby is charged at
// dirty-page cost instead; see committedLocked and standbyChargeLocked (#644).
//
// Delegates to the package-level PerVMBytes so this figure and the per-VM cgroup
// memory.max Task 17 sets (both arms) are computed from one function, not two
// independently maintained numbers that can drift apart (spec §5.3).
func (p *pool) perVMBytes() int64 { return PerVMBytes(p.cfg) }

func (p *pool) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	if p.ticker != nil {
		p.ticker.Stop()
	}
	if p.leaseTicker != nil {
		p.leaseTicker.Stop()
	}
	// Every lease VM whose gate is free, gate taken; the rest are destroyed by the Exec
	// holding the gate. Their state files keep the open lease (worker_restart, Task 5).
	leases := p.closeLeasesLocked()
	var victims []VM
	for _, rp := range p.runs {
		victims = append(victims, rp.ready...)
		rp.ready = nil
		for _, tm := range rp.pending {
			tm.Stop()
		}
		rp.pending = nil
	}
	p.mu.Unlock()

	// Wait for background replenishment warms already in flight. p.closed is now set,
	// so each one takes replenishOne's post-warm `case p.closed` branch and destroys
	// the VM it just built rather than parking it as a standby — but that branch only
	// runs if its goroutine gets to run at all. Close's caller is usually a process
	// that exits the moment Close returns (every vmpoolctl invocation, so every E10
	// rung), and a warm cut short mid-Restore leaves the jailer it already spawned
	// alive: it is in its own process group with no Pdeathsig, so it outlives its
	// parent, holding that VM id's API socket. The next process to mint the same id
	// dials that socket, finds a listener, and PUTs /snapshot/load into a microVM that
	// is already loaded — Firecracker's "not supported after starting the microVM"
	// (400), which is how E10 rung 4's teardown-bulk failed on its first execution.
	// See TestCloseWaitsForAnInFlightReplenishmentWarm.
	//
	// Outside the lock, necessarily: replenishOne takes p.mu to settle. Before the
	// victim destroys rather than after, so that by the time this returns every VM
	// this pool created has been accounted for exactly once.
	//
	// Still NOT waited on, deliberately and as before: a cold warm in flight inside
	// acquire (see acquire). That VM goes straight to its Exec caller, whose deferred
	// destroy owns it — waiting here would make Close block on an unrelated Exec's
	// whole restore, and it is not a leak.
	p.inFlightWarms.Wait()

	var firstErr error
	for _, vm := range victims {
		if err := vm.Destroy(); err != nil {
			p.counters.destroyFailed()
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	for _, v := range leases {
		if err := p.destroyLeaseVM(v.key, v.vm); err != nil && firstErr == nil {
			firstErr = err
		}
		<-v.gate
	}

	// p.closed is now true, and every sweep checks it under p.mu before sending on
	// reclaimQ (see sweep) — so no sweep can still be attempting a send here, and
	// closing the queue cannot race one. This drains the reclaim goroutine
	// deterministically: Close does not return with a destroy still running on it,
	// even though it does not (and never did — see acquire) wait for an in-flight
	// cold warm.
	close(p.reclaimQ)
	p.reclaimDone.Wait()
	// Deferred reaps last, after the victims above have been destroyed synchronously: this
	// drains every tail still in flight. Without it Close returns with jail directories
	// unlinked by nobody and cgroups never returned to the pool -- #255's accumulation by
	// another route, collectable only by the NEXT process's startup sweep.
	p.reaper.close()
	return firstErr
}
