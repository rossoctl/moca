// Package vmpool owns microVM lifecycle for the per-Exec sandbox tier: a golden
// snapshot restored into a paused standby, acquired for exactly ONE command, and
// destroyed afterwards. A VM is never reused.
//
// See docs/specs/2026-09-09-p4-microvm-sandbox-design.md §4. The load-bearing
// decision is §3.2's: replenishment costs 10-25ms and cannot sit inside a request
// with a 15ms budget, so it happens in the gap the model's own latency provides.
package vmpool

import (
	"fmt"
	"math"
	"time"

	ga "github.com/rossoctl/moca/remote-worker/internal/guestagent"
)

// VMMKind selects the hypervisor. It is a seam rather than a build choice because
// spec §7.2 requires E10 to price both arms with the same code above them.
type VMMKind string

const (
	CloudHypervisor VMMKind = "cloud-hypervisor"
	Firecracker     VMMKind = "firecracker"

	// FakeVMM is a sentinel selected only by the vmpoolctl benchmark CLI, which
	// runs commands with host bash rather than in a VM. The production worker
	// binary has no code path that can select it: spec §3.5's privilege argument
	// rests on nothing agent-influenced ever executing outside a VM. FakeVMM is
	// deliberately a DISTINCT value rather than an alias for a real arm, so that
	// a Config naming a real hypervisor can never be served by the fake launcher.
	FakeVMM VMMKind = "fake"
)

// Defaults, from spec §4.1. E11 holds StandbyIdle, WorkspaceIdle, ReplenishDelay
// and ReclaimScanInterval at these values and RECORDS them rather than sweeping
// them (spec §7.3), so changing one changes what a published rung means.
const (
	DefaultStandbyDepth       = 2
	DefaultGuestRAMBytes      = 256 << 20
	DefaultStandbyIdle        = 90 * time.Second
	DefaultWorkspaceIdle      = 30 * time.Minute
	DefaultReplenishDelay     = 200 * time.Millisecond
	DefaultMaxReclaimsPerScan = 8
	// DefaultVMOverheadBytes is the per-VM cost OUTSIDE guest RAM: the VMM's own
	// anonymous memory, plus virtiofsd's where it runs. Charged to the budget so
	// MaxCommittedBytes bounds what the host actually commits — spec §7.3's
	// "VMs x VMM/virtiofsd overhead" term, which its sketch puts at ~2 GiB of 21.
	DefaultVMOverheadBytes = 32 << 20
	// DefaultStandbyHeadroom is the multiplier applied to a paused standby's
	// MEASURED dirty-page footprint before it is charged to the admission budget
	// (#644). It prices the footprint's growth between the read and the standby's
	// eventual promotion (where it is re-priced at full PerVMBytes anyway), plus the
	// kernel-accounting drift a paused cgroup can still show (slab, per-cgroup
	// bookkeeping). E11 measured standbys at 0.9 MiB mean / 2 MiB max against a
	// 288 MiB limit, so against the floor (VMOverheadBytes, 32 MiB) the factor
	// barely binds on today's shapes — 4 is the conservative end of #644's proposed
	// 2-4x range, and AM6's re-run of the density ladder is what should pin it.
	DefaultStandbyHeadroom = 4.0
)

// Lease defaults, from spec §4 and §6. LeaseReclaimFreeBytes has no constant: it is
// derived from PerVMBytes (see Normalize), so it tracks a tuned guest size.
const (
	DefaultLeaseIdle                 = 300 * time.Second
	DefaultLeaseIdleCeiling          = 1800 * time.Second
	DefaultLeaseIdleMin              = 30 * time.Second // the floor an owner's value is raised to
	DefaultLeaseMaxDuration          = 8 * time.Hour
	DefaultLeaseMaxDurationProcesses = 4 * time.Hour
	DefaultLeaseGraceLimit           = 30 * time.Minute
	DefaultLeaseKeepaliveLoss        = 120 * time.Second
	DefaultLeaseStartBytes           = 192 << 20
	DefaultLeaseHeadroom             = 1.25
	DefaultLeasePageCacheBytes       = 256 << 20
	DefaultLeaseScanInterval         = 5 * time.Second
	// DefaultLeaseMaxProcesses is SH_LEASE_MAX_PROCESSES' default (spec §7): the running
	// tracked processes one lease may hold.
	DefaultLeaseMaxProcesses = 4
	// MaxLeaseProcesses is the highest LeaseMaxProcesses: the tracked uids a level-2 image
	// has (the guest agent's default range, Task 4's sbxp0..3 passwd lines). A higher cap
	// could only fail later, at the guest's uid allocator.
	MaxLeaseProcesses = ga.DefaultMaxTrackedUIDs
	// mcpKeepalivePeriod is how often the MCP server sends a lease keepalive (spec §8.3).
	// LeaseKeepaliveLoss may not be shorter than two of them (minLeaseKeepaliveLoss).
	mcpKeepalivePeriod    = 30 * time.Second
	minLeaseKeepaliveLoss = 2 * mcpKeepalivePeriod
	// leaseReclaimFloorBytes is the 2 GiB term in LeaseReclaimFreeBytes' derivation.
	leaseReclaimFloorBytes = 2 << 30
)

// Config is the pool's whole configuration surface (spec §4.1).
type Config struct {
	VMM           VMMKind // the seam E10 prices
	SnapshotDir   string  // golden snapshots; vmtouch -dl'd at start
	WorkspaceRoot string  // per-run workspaces

	StandbyDepth int // D
	// DeferReapWorkers > 0 moves the reap tail (cmd.Wait, jail unlink, cgroup release) off
	// the execGate-held path onto that many background workers, releasing the gate at the
	// observable barrier instead -- see deferredReaper. 0 keeps teardown fully synchronous.
	// A knob rather than a build-time choice so an arm is an A/B on ONE binary.
	DeferReapWorkers int
	GuestRAMBytes    int64 // the dominant density term (spec §7.3)
	MaxRuns          int   // concurrent workspace_keys; BACKSTOP only, see below

	// MaxCommittedBytes and MemoryReserveBytes gate admission on a computable
	// budget. MaxRuns alone cannot: CoW growth is workload-dependent (spec §6).
	MaxCommittedBytes  int64
	MemoryReserveBytes int64
	VMOverheadBytes    int64

	// StandbyHeadroom multiplies a paused standby's MEASURED dirty-page footprint
	// (its per-VM cgroup's memory.current) before charging it to the admission
	// budget (#644). 0 is filled with DefaultStandbyHeadroom by Normalize.
	// +Inf — spelled SH_STANDBY_HEADROOM=full at the worker — restores the
	// pre-#644 behaviour of charging every standby its full PerVMBytes, running
	// or paused: the floor/cap clamp pins the charge at the PerVMBytes ceiling for
	// any dirty footprint, which is exactly the legacy number. Kept as a knob so a
	// suspicion of dirty-page mis-accounting is one env var away from the old
	// posture, on the same binary.
	StandbyHeadroom float64

	// HostMemFloorBytes is an opt-in host backstop beside the budget arithmetic
	// (#644): when > 0, admission also refuses whenever the host's own
	// MemAvailable (/proc/meminfo) is below it. The budget bounds what VMs may
	// commit; this bounds what the kernel says is left, so dirty-page accounting
	// is never the only protection between the pool and the OOM killer. 0 = off.
	HostMemFloorBytes int64

	StandbyIdle         time.Duration // no Exec for this long -> drop standbys, KEEP workspace
	WorkspaceIdle       time.Duration // no Exec for this long -> delete the workspace too
	ReplenishDelay      time.Duration // grace before refilling a popped slot
	ReclaimScanInterval time.Duration // idle-host sweep tick
	// MaxReclaimsPerScan rate-limits munmap. It caps the standbys one per-Exec sweep
	// destroys, and, separately, the leases a lease tick ends for their own clocks (idle,
	// max_duration, grace_limit, ...; the rest end at the next tick), and the leases one
	// reclaimLeasesLocked call ends for memory (per lease tick, and per admission). A lease
	// tick may so end up to twice this many.
	MaxReclaimsPerScan int

	// ManifestFeatures is the loaded snapshot manifest's Features, passed by the
	// caller. LeaseEnabled is NOT a setting: New computes it (LeaseSupported) from VMM
	// and ManifestFeatures, overwriting whatever the caller put there.
	ManifestFeatures []string
	LeaseEnabled     bool

	// Lease mode (spec §4, §6; the SH_LEASE_* knobs). Zero fills the default.
	LeaseIdleDefault          time.Duration // an Exec's IdleTimeout of 0 means this
	LeaseIdleCeiling          time.Duration // an owner's idle timeout is clamped to this...
	LeaseIdleMin              time.Duration // ...and raised to this
	LeaseMaxDuration          time.Duration // a lease expires after this (level 1)
	LeaseMaxDurationProcesses time.Duration // the same for lease+processes (level 2)
	LeaseGraceLimit           time.Duration // how long an expiring lease's Exec may run on
	LeaseKeepaliveLoss        time.Duration // no keepalive for this long ends an opted-in lease
	LeaseStartBytes           int64         // a new lease VM's admission charge, before it is measured
	LeaseHeadroom             float64       // multiplier on a lease VM's measured memory.current
	LeasePageCacheBytes       int64         // lease cgroup memory.max = PerVMBytes + this
	// LeaseReclaimFreeBytes is the MemAvailable reclaim keeps free. 0 derives
	// 2 x PerVMBytes + max(2 GiB, 2 x (bound - LeaseStartBytes)), where bound =
	// LeaseHeadroom x (PerVMBytes + LeasePageCacheBytes) is a lease VM's highest charge.
	LeaseReclaimFreeBytes int64
	LeaseScanInterval     time.Duration // the lease ticker's period
	// LeaseMaxProcesses caps a level-2 lease's running tracked processes
	// (SH_LEASE_MAX_PROCESSES), sent to the guest on every process_start.
	LeaseMaxProcesses int
}

// Normalize fills defaults and then validates, returning the first violation.
//
// It validates rather than clamping because every rule below is a case where a
// wrong value fails silently in production: a zero MaxCommittedBytes turns spec
// §7.4's prediction 1 into "confirmed by the host falling over", which is not a
// measurement, and an inverted idle pair pins RAM while deleting the cheap thing.
func (c *Config) Normalize() error {
	if c.StandbyDepth <= 0 {
		c.StandbyDepth = DefaultStandbyDepth
	}
	if c.GuestRAMBytes <= 0 {
		c.GuestRAMBytes = DefaultGuestRAMBytes
	}
	if c.VMOverheadBytes <= 0 {
		c.VMOverheadBytes = DefaultVMOverheadBytes
	}
	if c.StandbyIdle <= 0 {
		c.StandbyIdle = DefaultStandbyIdle
	}
	if c.WorkspaceIdle <= 0 {
		c.WorkspaceIdle = DefaultWorkspaceIdle
	}
	if c.ReplenishDelay <= 0 {
		c.ReplenishDelay = DefaultReplenishDelay
	}
	if c.MaxReclaimsPerScan <= 0 {
		c.MaxReclaimsPerScan = DefaultMaxReclaimsPerScan
	}
	// Derived, not a constant of its own: spec §4.1 says StandbyIdle/4, and a
	// separate default would silently stop tracking a tuned StandbyIdle.
	if c.ReclaimScanInterval <= 0 {
		c.ReclaimScanInterval = c.StandbyIdle / 4
	}

	// StandbyHeadroom: 0 means unset (default); +Inf means "full" (legacy charge);
	// anything in [1, +Inf) is a multiplier on the measured dirty pages. The
	// refusal band is (0, 1) exclusive and NaN: a headroom below 1 would charge a
	// standby LESS than the pages it has already dirtied, which is the one
	// direction admission control must not err in (spec §6's OOM posture), and NaN
	// compares false against every bound below so it needs its own rejection.
	switch {
	case c.StandbyHeadroom == 0:
		c.StandbyHeadroom = DefaultStandbyHeadroom
	case math.IsInf(c.StandbyHeadroom, 1):
	case c.StandbyHeadroom >= 1:
	default:
		return fmt.Errorf("vmpool: StandbyHeadroom (%v) must be >= 1, or +Inf for the pre-#644 full-RAM "+
			"charge: a smaller factor would charge a standby less than the memory it has already "+
			"dirtied", c.StandbyHeadroom)
	}
	if err := c.normalizeLease(); err != nil {
		return err
	}
	if c.HostMemFloorBytes < 0 {
		return fmt.Errorf("vmpool: HostMemFloorBytes (%d) must be >= 0 (0 disables the MemAvailable backstop)",
			c.HostMemFloorBytes)
	}

	switch c.VMM {
	case CloudHypervisor, Firecracker, FakeVMM:
	default:
		return fmt.Errorf("vmpool: VMM %q is not one of %q, %q, %q", c.VMM, CloudHypervisor, Firecracker, FakeVMM)
	}
	if c.SnapshotDir == "" {
		return fmt.Errorf("vmpool: SnapshotDir is required (the golden snapshot has no default location)")
	}
	if c.WorkspaceRoot == "" {
		return fmt.Errorf("vmpool: WorkspaceRoot is required (per-run workspaces have no default location)")
	}
	if c.MaxRuns <= 0 {
		return fmt.Errorf("vmpool: MaxRuns must be > 0 (spec §6: the backstop behind the lease cap)")
	}
	if c.MaxCommittedBytes <= 0 {
		return fmt.Errorf("vmpool: MaxCommittedBytes must be > 0 — without the memory gate, " +
			"pressure goes straight to the OOM killer and spec §7.4's prediction 1 is " +
			"'confirmed' by the host falling over (spec §6)")
	}
	if c.MemoryReserveBytes >= c.MaxCommittedBytes {
		return fmt.Errorf("vmpool: MemoryReserveBytes (%d) >= MaxCommittedBytes (%d): nothing could ever be admitted",
			c.MemoryReserveBytes, c.MaxCommittedBytes)
	}
	if c.StandbyIdle >= c.WorkspaceIdle {
		return fmt.Errorf("vmpool: StandbyIdle (%v) must be < WorkspaceIdle (%v): RAM is urgent and disk is not (spec §4.4)",
			c.StandbyIdle, c.WorkspaceIdle)
	}
	if c.ReclaimScanInterval > c.StandbyIdle {
		return fmt.Errorf("vmpool: ReclaimScanInterval (%v) > StandbyIdle (%v): the sweep could not converge "+
			"within spec §8's StandbyIdle+ReclaimScanInterval leak bound", c.ReclaimScanInterval, c.StandbyIdle)
	}
	return nil
}

// normalizeLease fills the lease defaults and refuses what lease mode cannot honour.
// It runs on every Config, lease-capable or not: the values are inert until a lease
// Exec arrives, and validating them unconditionally means a bad SH_LEASE_* fails the
// unit at start rather than when the snapshot is upgraded to lease-v1.
func (c *Config) normalizeLease() error {
	fill := func(d *time.Duration, def time.Duration) {
		if *d <= 0 {
			*d = def
		}
	}
	fill(&c.LeaseIdleDefault, DefaultLeaseIdle)
	fill(&c.LeaseIdleCeiling, DefaultLeaseIdleCeiling)
	fill(&c.LeaseIdleMin, DefaultLeaseIdleMin)
	fill(&c.LeaseMaxDuration, DefaultLeaseMaxDuration)
	fill(&c.LeaseMaxDurationProcesses, DefaultLeaseMaxDurationProcesses)
	fill(&c.LeaseGraceLimit, DefaultLeaseGraceLimit)
	fill(&c.LeaseKeepaliveLoss, DefaultLeaseKeepaliveLoss)
	fill(&c.LeaseScanInterval, DefaultLeaseScanInterval)
	if c.LeaseStartBytes <= 0 {
		c.LeaseStartBytes = DefaultLeaseStartBytes
	}
	if c.LeasePageCacheBytes <= 0 {
		c.LeasePageCacheBytes = DefaultLeasePageCacheBytes
	}
	switch {
	case c.LeaseMaxProcesses == 0:
		c.LeaseMaxProcesses = DefaultLeaseMaxProcesses
	case c.LeaseMaxProcesses < 0 || c.LeaseMaxProcesses > MaxLeaseProcesses:
		return fmt.Errorf("vmpool: LeaseMaxProcesses (%d) must lie within [1, %d], the tracked uids a level-2 image has",
			c.LeaseMaxProcesses, MaxLeaseProcesses)
	}
	switch {
	case c.LeaseHeadroom == 0:
		c.LeaseHeadroom = DefaultLeaseHeadroom
	case c.LeaseHeadroom >= 1 && !math.IsInf(c.LeaseHeadroom, 1):
	default:
		// The same direction StandbyHeadroom refuses: below 1 charges a lease VM less
		// than the memory it is measured to hold, and NaN fails every comparison.
		return fmt.Errorf("vmpool: LeaseHeadroom (%v) must be a finite number >= 1", c.LeaseHeadroom)
	}
	if c.LeaseIdleMin > c.LeaseIdleCeiling ||
		c.LeaseIdleDefault < c.LeaseIdleMin || c.LeaseIdleDefault > c.LeaseIdleCeiling {
		return fmt.Errorf("vmpool: LeaseIdleDefault (%v) must lie within [LeaseIdleMin (%v), LeaseIdleCeiling (%v)]",
			c.LeaseIdleDefault, c.LeaseIdleMin, c.LeaseIdleCeiling)
	}
	if c.LeaseKeepaliveLoss < minLeaseKeepaliveLoss {
		// Spec §8.3: with less than two keepalive periods, every opted-in lease would end
		// keepalive_lost between two keepalives the harness sent on time.
		return fmt.Errorf("vmpool: LeaseKeepaliveLoss (%v) must be >= %v, two of the MCP server's %v keepalive periods",
			c.LeaseKeepaliveLoss, minLeaseKeepaliveLoss, mcpKeepalivePeriod)
	}
	if c.LeaseScanInterval > c.LeaseIdleMin/4 {
		// The lease ticker is what ends an idle lease: slower than this, the shortest idle
		// timeout an owner can set would be overrun by most of itself.
		return fmt.Errorf("vmpool: LeaseScanInterval (%v) must be <= LeaseIdleMin/4 (%v)",
			c.LeaseScanInterval, c.LeaseIdleMin/4)
	}
	if c.LeaseReclaimFreeBytes <= 0 {
		perVM := PerVMBytes(*c)
		bound := int64(math.Ceil(c.LeaseHeadroom * float64(perVM+c.LeasePageCacheBytes)))
		c.LeaseReclaimFreeBytes = 2*perVM + max(leaseReclaimFloorBytes, 2*(bound-c.LeaseStartBytes))
	}
	return nil
}

// PerVMBytes is what one VM costs the admission-control budget: guest RAM plus the
// launcher-and-sidecar overhead outside it (DefaultVMOverheadBytes' doc comment). This
// is the single source of truth for that figure — pool.go's perVMBytes delegates to it,
// and Task 17's per-VM cgroup memory.max (both arms: firecrackerCgroupArgs for
// Firecracker, the systemd-run --scope memory bound for Cloud Hypervisor) is also
// computed from this function, never from a second, independently maintained constant.
// Spec §5.3 names exactly this trap: "jailer's own --cgroup args must be configured
// consistently with the systemd slice §6 relies on, or the two mechanisms fight" — two
// numbers that can drift is the bug that trap describes, and giving both call sites the
// same function instead of the same intent is what keeps them from drifting.
func PerVMBytes(cfg Config) int64 {
	return cfg.GuestRAMBytes + cfg.VMOverheadBytes
}

// ReclaimScanIntervalForTest exposes the derived interval. Normalize runs inside
// New, so a test that wants to advance exactly one tick cannot compute it from the
// Config it passed in.
func (c Config) ReclaimScanIntervalForTest() time.Duration {
	if c.ReclaimScanInterval > 0 {
		return c.ReclaimScanInterval
	}
	if c.StandbyIdle > 0 {
		return c.StandbyIdle / 4
	}
	return DefaultStandbyIdle / 4
}
