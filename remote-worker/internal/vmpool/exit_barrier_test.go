package vmpool

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// restoreExitProbes swaps both procfs readers for the duration of a test. darwin has no
// procfs, and the point of these tests is the LATCHING and the reporting, not the read --
// same reason fcProcComm is a package var (jail_exec_boundary.go).
func restoreExitProbes(t *testing.T, fds, threads func(int) (int, bool)) {
	t.Helper()
	oldFD, oldThreads := fcProcFDCount, fcProcThreadCount
	t.Cleanup(func() { fcProcFDCount, fcProcThreadCount = oldFD, oldThreads })
	fcProcFDCount, fcProcThreadCount = fds, threads
}

// The question this instrument exists to answer (#307): execGate is held until cmd.Wait
// returns, and cmd.Wait is 19-52 ms of KVM grace period. If the VMM provably stops being
// able to write to workspace.img well before that, the gate can open early. "Holds no file
// descriptor" IS that property, directly rather than by inference.
func TestExitObserverLatchesTheFirstDrainOfFDsAndThreads(t *testing.T) {
	fdCalls, threadCalls := 0, 0
	restoreExitProbes(t,
		func(int) (int, bool) { fdCalls++; return map[bool]int{true: 3, false: 0}[fdCalls < 3], true },
		func(int) (int, bool) { threadCalls++; return map[bool]int{true: 5, false: 1}[threadCalls < 5], true },
	)

	o := newFCExitObserver(1234, time.Now())
	for i := 0; i < 20 && !o.done(); i++ {
		o.poll()
	}

	fd, threads, fdSeen, threadsSeen := o.results()
	if !fdSeen || !threadsSeen {
		t.Fatalf("fdSeen=%v threadsSeen=%v, want both observed", fdSeen, threadsSeen)
	}
	if fd <= 0 || threads <= 0 {
		t.Fatalf("fd=%v threads=%v, want both positive", fd, threads)
	}
	// FDs drained on poll 3 and threads on poll 5, so the fd barrier must be the earlier
	// one. That ORDER is the finding the instrument reports, so assert it rather than
	// just asserting both are set.
	if fd > threads {
		t.Fatalf("fd barrier %v later than threads barrier %v, but fds drained first", fd, threads)
	}
	// Latched: further polls must not move an answer already taken. A comm that flips twice
	// moved fcExecBoundary's answer before it latched; same hazard here.
	before := fd
	for i := 0; i < 5; i++ {
		o.poll()
	}
	if got, _, _, _ := o.results(); got != before {
		t.Fatalf("fd barrier moved from %v to %v after latching", before, got)
	}
}

// A barrier that was never observed must report UNOBSERVED, never zero. logRestorePhases
// already makes this point: a 0 aggregates as "it took no time", which is the strongest
// possible version of the wrong conclusion -- here it would read as "the VMM had already
// released everything before we even looked", i.e. as licence to remove the gate entirely.
func TestExitObserverReportsUnobservedRatherThanZero(t *testing.T) {
	restoreExitProbes(t,
		func(int) (int, bool) { return 0, false },
		func(int) (int, bool) { return 0, false },
	)

	o := newFCExitObserver(1234, time.Now())
	for i := 0; i < 5; i++ {
		o.poll()
	}
	if o.done() {
		t.Fatal("done() is true with neither barrier observable")
	}
	_, _, fdSeen, threadsSeen := o.results()
	if fdSeen || threadsSeen {
		t.Fatalf("fdSeen=%v threadsSeen=%v, want both unobserved", fdSeen, threadsSeen)
	}
}

// Nil-safe for the production path, which constructs no observer at all -- the same
// contract fcExecBoundary.elapsed has, for the same reason: this must never cost a Destroy
// that is not measuring.
func TestExitObserverIsNilSafe(t *testing.T) {
	var o *fcExitObserver
	o.poll()
	if o.done() {
		t.Fatal("a nil observer reports done()")
	}
	if _, _, fdSeen, threadsSeen := o.results(); fdSeen || threadsSeen {
		t.Fatal("a nil observer reports an observation")
	}
}

// Destroy must report both barriers alongside wait_us, because the whole point is the
// COMPARISON: a barrier is only useful if it lands measurably before the wait it would let
// the gate skip. Reported as -1 when unobserved -- here there is no process at all, which is
// the strongest case for the convention: a 0 would read as "the VMM had released everything
// before we looked", i.e. as licence to drop the gate outright.
func TestDestroyReportsBothExitBarriersAgainstTheWait(t *testing.T) {
	var lines []string
	restore := phaseLog
	phaseLog = func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }
	t.Cleanup(func() { phaseLog = restore })

	jailRoot := t.TempDir()
	vm := &firecrackerVM{id: "vm-91", key: "run-1", jailRoot: jailRoot}
	if err := vm.Destroy(); err != nil {
		t.Fatalf("Destroy: %v", err)
	}

	var got string
	for _, l := range lines {
		if strings.Contains(l, "destroy phases") {
			got = l
		}
	}
	if got == "" {
		t.Fatalf("no destroy phase line emitted; lines=%v", lines)
	}
	for _, want := range []string{"fdgone_us=-1", "threadsgone_us=-1"} {
		if !strings.Contains(got, want) {
			t.Errorf("destroy phase line missing %q: %s", want, got)
		}
	}
}

// fcWaitFDsGone is the production barrier: it runs INSIDE execGate, so unlike the diagnostic
// observer it must be bounded. Measured at 1.41 ms median and 8.85 ms worst case at c=64.
func TestWaitFDsGoneReturnsAsSoonAsTheDescriptorsAreClosed(t *testing.T) {
	calls := 0
	restoreExitProbes(t,
		func(int) (int, bool) { calls++; return map[bool]int{true: 2, false: 0}[calls < 3], true },
		func(int) (int, bool) { return 1, true },
	)
	d, ok := fcWaitFDsGone(1234, time.Second)
	if !ok {
		t.Fatal("ok=false with the descriptors reported closed")
	}
	if d <= 0 {
		t.Fatalf("d=%v, want positive", d)
	}
}

// A barrier that never arrives must TIME OUT and report it, never block the gate forever and
// never claim an observation it does not have. pool.destroy turns !ok into the old synchronous
// ordering, which is the only safe fallback.
func TestWaitFDsGoneGivesUpRatherThanHoldingTheGateForever(t *testing.T) {
	probes := 0
	restoreExitProbes(t,
		func(int) (int, bool) { probes++; return 3, true }, // never drains
		func(int) (int, bool) { return 1, true },
	)
	const budget = 60 * time.Millisecond
	okc := make(chan bool, 1)
	go func() { _, ok := fcWaitFDsGone(1234, budget); okc <- ok }()
	if recvWithin(t, okc, "a barrier wait with a 60ms budget") {
		t.Fatal("ok=true for a barrier that never arrived")
	}
	// Each probe is followed by at least one poll interval of sleep, so a wait that honours
	// its budget makes at most this many however loaded the host is.
	if most := int(budget/fcExitBarrierPoll) + 2; probes > most {
		t.Fatalf("%d probes before giving up on a %v budget, want at most %d", probes, budget, most)
	}
}

// "Cannot tell" is not "drained". An unreadable /proc/<pid>/fd must not satisfy the barrier --
// that is the reading that would let the gate open on a process still holding the image.
func TestWaitFDsGoneRefusesAnUnreadableCount(t *testing.T) {
	restoreExitProbes(t,
		func(int) (int, bool) { return 0, false },
		func(int) (int, bool) { return 1, true },
	)
	if _, ok := fcWaitFDsGone(1234, 60*time.Millisecond); ok {
		t.Fatal("ok=true from an unreadable count: 'cannot tell' was treated as 'drained'")
	}
}
