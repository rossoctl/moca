package vmpool

import (
	"context"
	"errors"
	"fmt"
	"math"
	"testing"
	"time"
)

// This file pins #644: paused standbys are charged at dirty-page cost (their
// measured footprint x StandbyHeadroom, floored at VMOverheadBytes, capped at
// PerVMBytes) while running and warming VMs keep the full price, a warm acquire is
// re-priced at pop time, eviction sheds as much dirty charge as an admission needs,
// and the opt-in MemAvailable floor refuses distinctly from the budget gate.
//
// Every pool here opts in via setStandbyFn; pools that do not (the rest of the
// suite) keep the pre-#644 full-RAM charge through standbyChargeLocked's
// error fallback, which TestAnUnreadableFootprintIsChargedFull pins explicitly.

// standbyPool is budgetPool (budget_test.go) with #644's knobs exposed: every
// standby this pool holds reports `dirty` bytes of footprint, priced at `headroom`.
// maxRuns is generous by default because what these tests squeeze is the memory
// budget, not the key ceiling.
func standbyPool(t *testing.T, budget int64, headroom float64, dirty int64) (Pool, *fakeLauncher, *fakeClock) {
	t.Helper()
	lc := newFakeLauncher()
	lc.setStandbyFn(func(_ *fakeVM) (int64, error) { return dirty, nil })
	clk := newFakeClock()
	cfg := Config{
		VMM:               lc.Kind(),
		SnapshotDir:       t.TempDir(),
		WorkspaceRoot:     t.TempDir(),
		MaxRuns:           100,
		GuestRAMBytes:     256 << 20,
		VMOverheadBytes:   32 << 20,
		MaxCommittedBytes: budget,
		StandbyHeadroom:   headroom,
	}
	p, err := New(cfg, lc, clk)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p, lc, clk
}

// perVM and floorCharge are the constants standbyPool's Config fixes: 256 MiB
// guest + 32 MiB overhead per VM, and the dirty-charge floor that overhead sets.
const (
	perVM       = int64(288 << 20)
	floorCharge = int64(32 << 20)
)

// TestStandbysAreChargedAtDirtyPageCost is the headline: a host whose budget
// funds only 2 VMs at full price holds 4 runs' standbys — 8 VMs — because each
// books 32 MiB (the floor) rather than 288 MiB. Under the pre-#644 charge the
// third standby's replenishment was already refused, which is AM6's 16-22
// sandbox ceiling with 150-178 GiB of 188 free.
func TestStandbysAreChargedAtDirtyPageCost(t *testing.T) {
	// dirty=1 MiB x headroom 4 = 4 MiB < the 32 MiB floor, so each standby books
	// the floor: the E11 shape (0.9 MiB mean against a 288 MiB limit).
	p, _, clk := standbyPool(t, 2*perVM, 4, 1<<20)
	for _, k := range []string{"run-a", "run-b", "run-c", "run-d"} {
		primed(t, p, clk, k)
	}
	s := p.Stats()
	if s.StandbysResident != 4*DefaultStandbyDepth {
		t.Fatalf("StandbysResident = %d, want %d — the budget funds 2 VMs at full price; "+
			"dirty-page charging is what lets 8 standbys be resident", s.StandbysResident, 4*DefaultStandbyDepth)
	}
	if want := int64(4*DefaultStandbyDepth) * floorCharge; s.StandbyCommittedBytes != want {
		t.Fatalf("StandbyCommittedBytes = %d, want %d (8 standbys at the %d MiB floor)",
			s.StandbyCommittedBytes, want, floorCharge>>20)
	}
	if s.CommittedBytes != s.StandbyCommittedBytes {
		t.Fatalf("CommittedBytes = %d with nothing running, want the standby component %d",
			s.CommittedBytes, s.StandbyCommittedBytes)
	}
}

// TestStandbyChargeFloorAndCeiling pins the clamp: a footprint below
// floor/headroom books the floor (VMOverheadBytes — a live VMM is always
// resident, so a smaller read is not free), and one that scales past PerVMBytes
// books exactly PerVMBytes (the same figure the per-VM cgroup memory.max
// enforces physically).
func TestStandbyChargeFloorAndCeiling(t *testing.T) {
	p, _, clk := standbyPool(t, 100*perVM, 4, 1) // 1 byte x 4: the floor binds
	primed(t, p, clk, "run-a")
	if got := p.Stats().StandbyCommittedBytes; got != int64(DefaultStandbyDepth)*floorCharge {
		t.Fatalf("StandbyCommittedBytes = %d, want %d — a 1-byte footprint must book the floor",
			got, int64(DefaultStandbyDepth)*floorCharge)
	}

	p2, _, clk2 := standbyPool(t, 100*perVM, 2, 200<<20) // 200 MiB x 2 > perVM: the cap binds
	primed(t, p2, clk2, "run-a")
	if got := p2.Stats().StandbyCommittedBytes; got != int64(DefaultStandbyDepth)*perVM {
		t.Fatalf("StandbyCommittedBytes = %d, want %d — a footprint scaled past PerVMBytes must cap at it",
			got, int64(DefaultStandbyDepth)*perVM)
	}
}

// TestAnUnreadableFootprintIsChargedFull pins the fallback separately from the
// suite that relies on it implicitly: a VM that cannot report a footprint books
// its FULL PerVMBytes. "Cannot tell" is not "cheap" — the same posture
// cgroupPool.release takes — and it is what keeps the pre-#644 accounting
// reachable (SH_STANDBY_HEADROOM=full, pinned next).
func TestAnUnreadableFootprintIsChargedFull(t *testing.T) {
	p, _, clk := budgetPool(t, 100, 100) // no setStandbyFn: every read errors
	primed(t, p, clk, "run-a")
	if got := p.Stats().StandbyCommittedBytes; got != int64(DefaultStandbyDepth)*perVM {
		t.Fatalf("StandbyCommittedBytes = %d, want %d — an unreadable footprint must charge full price",
			got, int64(DefaultStandbyDepth)*perVM)
	}
}

// TestHeadroomFullRestoresThePre644Charge: +Inf pins every standby at its full
// PerVMBytes through the clamp's ceiling, which is exactly the legacy number —
// the escape hatch for a suspicion of dirty-page mis-accounting, on the same
// binary.
func TestHeadroomFullRestoresThePre644Charge(t *testing.T) {
	p, _, clk := standbyPool(t, 100*perVM, math.Inf(1), 1<<20)
	primed(t, p, clk, "run-a")
	if got := p.Stats().StandbyCommittedBytes; got != int64(DefaultStandbyDepth)*perVM {
		t.Fatalf("StandbyCommittedBytes = %d, want %d — headroom=full must charge full PerVMBytes",
			got, int64(DefaultStandbyDepth)*perVM)
	}
}

// TestAWarmAcquireIsRepricedAtPopTime is the invariant that makes dirty-page
// charging safe: promoting a standby to running re-prices it from its dirty
// charge to a full PerVMBytes, and that must still fit the budget. Here one
// running VM plus one 32 MiB standby is within the budget, but promoting that
// standby (288 MiB) is not — and no eviction can fund it: the only idle standbys
// belong to the promoting run itself (excluded from the victim set), and the
// running VM's run is busy. So the warm acquire is refused, the eviction attempt
// detaches nothing, and the standby is LEFT IN PLACE for a later, colder host to
// promote.
func TestAWarmAcquireIsRepricedAtPopTime(t *testing.T) {
	p, lc, clk := standbyPool(t, 2*perVM, 4, 1<<20)
	primed(t, p, clk, "run-a") // 2 standbys, 64 MiB committed

	release, entered := hold(lc)
	// NOT deferred: release is called exactly once below, after the refused
	// promotion — hold's release closes a channel, so a deferred second close
	// would panic after the explicit one.
	go func() { _, _ = p.Exec(context.Background(), "run-b", Exec{Command: "sleep"}, &capturingSink{}) }()
	<-entered
	// 288 MiB running + 64 MiB standbys = 352 MiB against a 576 MiB budget.
	if s := p.Stats(); s.CommittedBytes != perVM+2*floorCharge {
		t.Fatalf("CommittedBytes = %d, want %d (one full-price VM + two floor-charged standbys)",
			s.CommittedBytes, perVM+2*floorCharge)
	}

	// Promoting run-a's standby would reach 352 - 32 + 288 = 608 MiB > 576: refused,
	// and unfundable — run-a's other standby is the only idle victim candidate and
	// the promoting run is excluded from the victim set.
	before := p.Stats().BudgetEvictions
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); ReasonOf(err) != RefuseMemoryBudget {
		t.Fatalf("warm acquire under a full running set: err = %v, want a %s refusal — promotion must be re-priced at pop time",
			err, RefuseMemoryBudget)
	}
	if s := p.Stats(); s.StandbysResident != DefaultStandbyDepth {
		t.Fatalf("StandbysResident = %d after a refused promotion, want %d — the check is pure and must leave the standby in place",
			s.StandbysResident, DefaultStandbyDepth)
	}
	if evicted := p.Stats().BudgetEvictions - before; evicted != 0 {
		t.Fatalf("BudgetEvictions delta = %d, want 0 — an unfundable promotion must not shed the promoting run's own standbys",
			evicted)
	}

	// Once the running VM finishes, the same warm acquire fits and succeeds.
	release()
	waitForValue(t, `p.Stats().InFlight`, func() int { return p.Stats().InFlight }, 0)
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("warm acquire after the running VM drained: %v", err)
	}
}

// TestEvictionShedsAsMuchDirtyChargeAsAdmissionNeeds pins the #644 loop. With
// one full-price VM held running beside 8 floor-charged standbys, a new run's
// admission is short 8 x 32 MiB of dirty charge — one eviction (the pre-#644
// amount) leaves it short, and only shedding all 8 lets the exec through. The
// old single-eviction code refused here.
func TestEvictionShedsAsMuchDirtyChargeAsAdmissionNeeds(t *testing.T) {
	// Budget 576 MiB: 8 standbys (256 MiB) + one running VM (288 MiB) = 544 MiB
	// committed, and admitting one more VM needs 288 MiB of headroom — only
	// reachable by evicting all 8 standbys (288 - 256 = ... 544-256+288 = 576 <= 576).
	p, lc, clk := standbyPool(t, 2*perVM, 4, 1<<20)
	for _, k := range []string{"run-a", "run-b", "run-c", "run-d"} {
		primed(t, p, clk, k)
	}
	release, entered := hold(lc)
	// NOT deferred, same as above: released once below, after the assertions that
	// need run-e held running.
	go func() { _, _ = p.Exec(context.Background(), "run-e", Exec{Command: "sleep"}, &capturingSink{}) }()
	<-entered

	before := p.Stats().BudgetEvictions
	// In a goroutine: the exec's Run blocks on hold's gate, so a synchronous call
	// here would deadlock waiting for a release the assertions below precede.
	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "run-z", Exec{Command: "sleep-2"}, &capturingSink{})
		done <- err
	}()
	select {
	case <-entered: // run-z's own Run started: the admission went through
	case err := <-done:
		t.Fatalf("new run against a standby-heavy host: %v — eviction must shed enough dirty charge to fund it", err)
	case <-time.After(testWaitBound):
		t.Fatal("run-z neither reached Run nor returned — admission stuck")
	}
	if evicted := p.Stats().BudgetEvictions - before; evicted != 8 {
		t.Fatalf("BudgetEvictions delta = %d, want 8 — funding one full-price admission from floor-charged standbys takes all of them",
			evicted)
	}
	release()
}

// primeFillerRuns primes n filler runs AFTER the named runs, in clock order, so
// the named runs keep their relative lastExec ordering: whatever was primed
// earlier is colder. Returns nothing; primed itself asserts each run reached D.
func primeFillerRuns(t *testing.T, p Pool, clk *fakeClock, first int, n int) {
	t.Helper()
	for i := first; i < first+n; i++ {
		primed(t, p, clk, fmt.Sprintf("fill-%02d", i))
	}
}

// TestSequentialWarmAcquiresOnOneRunShedIdleStandbys is the review's must-fix
// scenario for #644: replenishment books the budget to within one warming of
// full with OTHER runs' cheap standbys, so a promotion check that cannot be
// funded by eviction fails the SECOND warm acquire on a run while only one VM
// of a ten-VM budget is running — far below the slot ceiling, which is exactly
// the density regression #644 exists to remove. Funding the promotion from
// other runs' standbys keeps warm acquires succeeding as the slots fill.
func TestSequentialWarmAcquiresOnOneRunShedIdleStandbys(t *testing.T) {
	// Budget 10 VMs (2880 MiB). 40 runs x D=2 standbys at the 32 MiB floor book
	// 2560 MiB: replenishment stops there because the next warming charge, at
	// full price, would not fit. run-z primed LAST so it is the warmest run and
	// its own standbys are the last thing LRU eviction would want anyway.
	p, lc, clk := standbyPool(t, 10*perVM, 4, 1<<20)
	primeFillerRuns(t, p, clk, 0, 39)
	primed(t, p, clk, "run-z") // run 40 of 40: 80 standbys, 2560 MiB committed

	release, entered := hold(lc)
	// NOT deferred: released once below; hold's release closes a channel.
	go func() { _, _ = p.Exec(context.Background(), "run-z", Exec{Command: "sleep"}, &capturingSink{}) }()
	<-entered
	// Warm acquire 1 fits without eviction: 2560 - 32 + 288 = 2816 <= 2880.
	if s := p.Stats(); s.CommittedBytes != 10*perVM-2*floorCharge {
		t.Fatalf("CommittedBytes = %d, want %d (one full-price VM + 79 floor-charged standbys)",
			s.CommittedBytes, 10*perVM-2*floorCharge)
	}

	before := p.Stats().BudgetEvictions
	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "run-z", Exec{Command: "sleep-2"}, &capturingSink{})
		done <- err
	}()
	select {
	case <-entered: // the second warm acquire reached Run: the promotion was funded
	case err := <-done:
		t.Fatalf("second warm acquire on run-z: %v — the promotion must be funded from other runs' standbys", err)
	case <-time.After(testWaitBound):
		t.Fatal("second warm acquire neither reached Run nor returned — promotion stuck")
	}
	// 2816 - 32 + 288 = 3072 > 2880, short 192 MiB = six floor-charged standbys.
	if evicted := p.Stats().BudgetEvictions - before; evicted != 6 {
		t.Fatalf("BudgetEvictions delta = %d, want 6 — funding this promotion takes exactly 192 MiB of dirty charge",
			evicted)
	}
	if s := p.Stats(); s.InFlight != 2 || s.StandbysResident != 80-6-2 {
		t.Fatalf("InFlight = %d, StandbysResident = %d, want 2 and %d — two warm acquires running, six standbys shed, two popped",
			s.InFlight, s.StandbysResident, 80-6-2)
	}
	if s := p.Stats(); s.DestroyFailures != 0 {
		t.Fatalf("DestroyFailures = %d, want 0 — no VM may be destroyed out from under a running exec", s.DestroyFailures)
	}
	release()
}

// TestPromotionEvictionSparesThePromotingRun pins the exclude in
// evictForPromotionLocked from the one side where it is load-bearing: a
// promotion whose shortfall exceeds what every OTHER idle run can shed.
// acquire bumps the promoting run's lastExec to now before the check, so the
// run is the WARMST candidate and the coldest-first victim loop reaches it
// LAST — exactly after draining everyone else — and would there hand the very
// standby being promoted to reclaimQ, then pop it into inFlight: a VM destroyed
// while its Exec runs. With the exclusion that promotion is simply unfundable:
// refused, nothing shed, the standby left in place for a colder host.
func TestPromotionEvictionSparesThePromotingRun(t *testing.T) {
	// Budget 576 MiB (2 VMs at full price). run-y plus three filler runs hold
	// 8 floor-charged standbys (256 MiB); a VM held running on run-h adds 288,
	// for 544 committed. Promoting run-y's standby would reach
	// 544 - 32 + 288 = 800 > 576, short 224 MiB — more than the fillers' 192,
	// so only the promoting run's own standbys could close the gap.
	p, lc, clk := standbyPool(t, 2*perVM, 4, 1<<20)
	primed(t, p, clk, "run-y")
	primeFillerRuns(t, p, clk, 0, 3)

	release, entered := hold(lc)
	// Deferred rather than explicit: this test's last act, and a t.Fatal above
	// (the mutation path) must still open hold's gate or the pool's cleanup
	// would wait on a VM that never finishes. Deferring keeps release a
	// single close.
	defer release()
	go func() { _, _ = p.Exec(context.Background(), "run-h", Exec{Command: "sleep"}, &capturingSink{}) }()
	<-entered
	if s := p.Stats(); s.CommittedBytes != 8*floorCharge+perVM {
		t.Fatalf("CommittedBytes = %d, want %d (eight floor-charged standbys + one running VM)",
			s.CommittedBytes, 8*floorCharge+perVM)
	}

	before := p.Stats().BudgetEvictions
	runYDestroyed := lc.destroyedFor("run-y") // its priming Exec's destroy, +0 expected
	// In a goroutine with a timeout, not a synchronous call: under the exclusion
	// this Exec is refused before Run and returns immediately, but a regression
	// that admitted it would park it in hold's gate until release — a hang, and
	// the timeout is what turns that into a failure with a name.
	done := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "run-y", Exec{Command: "true"}, &capturingSink{})
		done <- err
	}()
	select {
	case err := <-done:
		if ReasonOf(err) != RefuseMemoryBudget {
			t.Fatalf("warm acquire fundable only by the promoting run's own standbys: err = %v, want a %s refusal — those standbys are excluded from the victim set",
				err, RefuseMemoryBudget)
		}
	case <-time.After(testWaitBound):
		t.Fatal("run-y's warm acquire was admitted instead of refused — it is now parked in hold's gate, which is exactly what spending the promoting run's own standbys would buy")
	}
	if evicted := p.Stats().BudgetEvictions - before; evicted != 0 {
		t.Fatalf("BudgetEvictions delta = %d, want 0 — an unfundable promotion must shed nothing", evicted)
	}
	if got := lc.destroyedFor("run-y") - runYDestroyed; got != 0 {
		t.Fatalf("run-y lost %d VMs to reclamation, want 0 — the standby being promoted must never reach reclaimQ", got)
	}
	if s := p.Stats(); s.StandbysResident != 8 {
		t.Fatalf("StandbysResident = %d, want 8 — the refused promotion leaves every standby in place", s.StandbysResident)
	}
}

// TestHostMemFloorRefusesDistinctlyFromTheBudget pins the opt-in MemAvailable
// backstop: below the floor, admission refuses with RefuseHostMemory (a cause
// apart from RefuseMemoryBudget, so a density ladder can tell "budget sized
// wrong" from "host genuinely out"), and it clears when the host recovers. An
// unreadable /proc/meminfo fails closed.
func TestHostMemFloorRefusesDistinctlyFromTheBudget(t *testing.T) {
	p, _, _ := standbyPool(t, 100*perVM, 4, 1<<20)
	pp := p.(*pool)
	pp.cfg.HostMemFloorBytes = 1 << 30 // 1 GiB floor

	old := memAvailable
	defer func() { memAvailable = old }()

	memAvailable = func() (int64, error) { return 512 << 20, nil }
	invalidateMemAvailableCache()
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); ReasonOf(err) != RefuseHostMemory {
		t.Fatalf("err = %v, want a %s refusal — MemAvailable is below the floor", err, RefuseHostMemory)
	}
	if s := p.Stats(); s.Refusals[RefuseMemoryBudget] != 0 {
		t.Fatalf("Refusals[%s] = %d, want 0 — a host-floor refusal must not be counted as a budget refusal",
			RefuseMemoryBudget, s.Refusals[RefuseMemoryBudget])
	}

	memAvailable = func() (int64, error) { return 8 << 30, nil }
	invalidateMemAvailableCache()
	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); err != nil {
		t.Fatalf("exec with MemAvailable recovered: %v", err)
	}

	memAvailable = func() (int64, error) { return 0, errors.New("no /proc/meminfo on this darwin") }
	invalidateMemAvailableCache()
	if _, err := p.Exec(context.Background(), "run-b", Exec{Command: "true"}, &capturingSink{}); ReasonOf(err) != RefuseHostMemory {
		t.Fatalf("err = %v, want a %s refusal — an unreadable MemAvailable must fail closed", err, RefuseHostMemory)
	}
}

// TestHostMemFloorAppliesToPromotionToo: the floor guards the host, not just the
// budget arithmetic, so a warm acquire under a low floor is refused exactly like
// a cold one — promoting a standby un-pauses a VMM either way.
func TestHostMemFloorAppliesToPromotionToo(t *testing.T) {
	p, _, clk := standbyPool(t, 100*perVM, 4, 1<<20)
	primed(t, p, clk, "run-a")
	pp := p.(*pool)
	pp.cfg.HostMemFloorBytes = 1 << 30

	old := memAvailable
	defer func() { memAvailable = old }()
	memAvailable = func() (int64, error) { return 512 << 20, nil }
	invalidateMemAvailableCache()

	if _, err := p.Exec(context.Background(), "run-a", Exec{Command: "true"}, &capturingSink{}); ReasonOf(err) != RefuseHostMemory {
		t.Fatalf("warm acquire under a low floor: err = %v, want a %s refusal", err, RefuseHostMemory)
	}
}

// TestStandbyHeadroomValidation pins Normalize's band: 0 fills the default, +Inf
// is "full", and anything in (0, 1) — or NaN — is refused because it would charge
// a standby less than the memory it has already dirtied.
func TestStandbyHeadroomValidation(t *testing.T) {
	base := func() Config {
		return Config{
			VMM: Firecracker, SnapshotDir: "/srv/snapshots", WorkspaceRoot: "/srv/workspaces",
			GuestRAMBytes: 256 << 20, MaxRuns: 64, MaxCommittedBytes: 1 << 30,
		}
	}
	c := base()
	if err := c.Normalize(); err != nil {
		t.Fatalf("defaults: %v", err)
	}
	if c.StandbyHeadroom != DefaultStandbyHeadroom {
		t.Fatalf("StandbyHeadroom = %v, want the default %v", c.StandbyHeadroom, DefaultStandbyHeadroom)
	}
	c = base()
	c.StandbyHeadroom = math.Inf(1)
	if err := c.Normalize(); err != nil {
		t.Fatalf("headroom=full: %v", err)
	}
	for _, bad := range []float64{0.5, -1, math.NaN()} {
		c := base()
		c.StandbyHeadroom = bad
		if err := c.Normalize(); err == nil {
			t.Fatalf("StandbyHeadroom=%v was accepted; it undercharges or is not a number", bad)
		}
	}
}
