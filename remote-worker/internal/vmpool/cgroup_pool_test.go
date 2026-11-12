package vmpool

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const testPerVM = (256 + 32) << 20

// newTestPool builds a pool rooted in a temp dir, so the whole thing is testable without root
// and without touching the host's cgroupfs.
func newTestPool(t *testing.T) (*cgroupPool, string) {
	t.Helper()
	root := t.TempDir()
	parent := "microvm.slice/microvm-vms.slice"
	if err := os.MkdirAll(filepath.Join(root, parent), 0o755); err != nil {
		t.Fatal(err)
	}
	return newCgroupPool(parent, testPerVM, root), root
}

// #258. The point of the whole change: a cgroup is REUSED rather than created and destroyed per
// VM. Measured cost of the per-VM churn was 195.52 ms of a 253 ms Destroy at 64 slots, growing
// 91x across a 16x concurrency range because cgroup removal is kernel-serialised.
func TestCgroupPoolReusesRatherThanMinting(t *testing.T) {
	p, root := newTestPool(t)

	first, err := p.acquire()
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if p.mintedCount() != 1 || p.idle() != 0 {
		t.Fatalf("after one acquire: minted=%d idle=%d, want 1 and 0", p.mintedCount(), p.idle())
	}
	// Non-vacuousness: the directory must really exist, or "reuse" proves nothing.
	if _, err := os.Stat(filepath.Join(root, first)); err != nil {
		t.Fatalf("acquired cgroup does not exist: %v", err)
	}

	p.release(first)
	if p.idle() != 1 {
		t.Fatalf("release did not return it: idle=%d", p.idle())
	}
	again, err := p.acquire()
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if again != first {
		t.Fatalf("acquire minted %q instead of reusing %q", again, first)
	}
	if p.mintedCount() != 1 {
		t.Fatalf("minted %d cgroups; reuse must not mint a second", p.mintedCount())
	}

	// Concurrent demand DOES mint: the high-water mark is the peak concurrent VM count, which
	// is the property that makes a free list correct without predicting a pool size.
	second, err := p.acquire()
	if err != nil {
		t.Fatalf("concurrent acquire: %v", err)
	}
	if second == again {
		t.Fatal("two live VMs were handed the same cgroup")
	}
	if p.mintedCount() != 2 {
		t.Fatalf("minted=%d, want 2 for two simultaneously held cgroups", p.mintedCount())
	}
}

// D1 preserved: the bound is PerVMBytes, and it moves from jailer's --cgroup to the pool, because
// --cgroup is what would CREATE a per-VM cgroup. §4 of the design note establishes by measurement
// that reuse is compatible with keeping this limit -- a live VM cgroup charges ~1 MiB against it.
func TestCgroupPoolWritesTheMemoryBound(t *testing.T) {
	p, root := newTestPool(t)
	rel, err := p.acquire()
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(root, rel, "memory.max"))
	if err != nil {
		t.Fatalf("memory.max not written: %v", err)
	}
	if got := strings.TrimSpace(string(b)); got != strconv.FormatInt(testPerVM, 10) {
		t.Fatalf("memory.max = %q, want PerVMBytes %d", got, testPerVM)
	}
	// And it survives reuse: a recycled cgroup must still be bounded.
	p.release(rel)
	if _, err := p.acquire(); err != nil {
		t.Fatalf("re-acquire: %v", err)
	}
	if b2, err := os.ReadFile(filepath.Join(root, rel, "memory.max")); err != nil ||
		strings.TrimSpace(string(b2)) != strconv.FormatInt(testPerVM, 10) {
		t.Fatalf("memory.max did not survive reuse: %q err=%v", b2, err)
	}
}

// Raised in review of #318. kill + cmd.Wait reaps the jailer, but a stray child that escaped the
// process group would otherwise be handed to the NEXT tenant -- inside its memory bound, and
// inside a cgroup a later SweepOrphans would attribute to whoever holds it then. Leaking one
// cgroup is the old behaviour; handing over a live stranger's process is not.
func TestCgroupPoolLeaksRatherThanReusingANonEmptyCgroup(t *testing.T) {
	p, root := newTestPool(t)
	rel, err := p.acquire()
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	// A survivor listed in cgroup.procs. Pid 1 is used only as a value that parses -- release
	// must not signal anything, only refuse to reuse.
	procs := filepath.Join(root, rel, "cgroup.procs")
	if err := os.WriteFile(procs, []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	p.release(rel)

	if p.idle() != 0 {
		t.Fatalf("a cgroup with a live member was returned for reuse (idle=%d)", p.idle())
	}
	if p.leaks() != 1 {
		t.Fatalf("leaks=%d, want 1 -- a leak must be counted, not silent", p.leaks())
	}
	// Left in place, not removed: something is still running in it.
	if _, err := os.Stat(filepath.Join(root, rel)); err != nil {
		t.Fatalf("leaked cgroup was removed while a member was live: %v", err)
	}
	// And the next acquire mints a fresh one rather than the leaked one.
	next, err := p.acquire()
	if err != nil {
		t.Fatalf("acquire after leak: %v", err)
	}
	if next == rel {
		t.Fatalf("handed out the leaked cgroup %q", rel)
	}
}

// An empty cgroup.procs is the normal case and must reuse. Guards against the guard being
// inverted, which would turn every release into a leak and silently restore the old churn.
func TestCgroupPoolReusesWhenCgroupProcsIsEmpty(t *testing.T) {
	p, root := newTestPool(t)
	rel, _ := p.acquire()
	if err := os.WriteFile(filepath.Join(root, rel, "cgroup.procs"), []byte("\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	p.release(rel)
	if p.idle() != 1 || p.leaks() != 0 {
		t.Fatalf("an empty cgroup must be reused: idle=%d leaks=%d", p.idle(), p.leaks())
	}
}

// jailer refuses an absolute --parent-cgroup ("Path should not be absolute or contain a dot
// component"), so what the pool hands out must be slice-relative and under the configured parent.
func TestCgroupPoolHandsOutASliceRelativePathUnderTheParent(t *testing.T) {
	p, _ := newTestPool(t)
	rel, err := p.acquire()
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if filepath.IsAbs(rel) {
		t.Fatalf("acquire returned an absolute path %q; jailer refuses those", rel)
	}
	if err := ValidateParentCgroup(rel); err != nil {
		t.Fatalf("acquire returned a path jailer would refuse: %v", err)
	}
	if !strings.HasPrefix(rel, "microvm.slice/microvm-vms.slice/") {
		t.Fatalf("acquired %q is not under the configured parent", rel)
	}
}

// SweepOrphans must SEE pooled cgroups, or a crashed worker's dead VMM keeps running inside one.
// isPoolVMCgroupDirName is documented as the single authority on the name, and this is a third
// recognised form alongside vm-<n> and the CHV scope.
func TestPooledCgroupNamesAreRecognisedBySweepOrphans(t *testing.T) {
	for _, name := range []string{"pool-0", "pool-7", "pool-1234"} {
		if !isPoolVMCgroupDirName(name) {
			t.Errorf("%q not recognised; SweepOrphans would ignore a dead VMM inside it", name)
		}
	}
	// And the negatives still hold -- the sweep kills what it matches, so over-matching is worse
	// than under-matching.
	for _, name := range []string{"pool", "pool-", "pool-x", "poolish-1", "microvm-worker.service", "vm-"} {
		if isPoolVMCgroupDirName(name) {
			t.Errorf("%q must NOT be recognised: the sweep kills members of what it matches", name)
		}
	}
}

// readCgroupProcs reports a MISSING path as (nil, nil), which is indistinguishable from "empty" --
// so a cgroup that vanished underneath us would otherwise go back on the free list, and a later
// acquire would hand jailer a --parent-cgroup that does not exist, failing every restore that drew
// it. Reachable in practice: clearing the slice by hand is step 3a of the metal runbook, and
// SweepOrphans now recognises these names too.
func TestCgroupPoolDropsAVanishedCgroupInsteadOfReusingIt(t *testing.T) {
	p, root := newTestPool(t)
	rel, err := p.acquire()
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	// Someone removed it under us.
	if err := os.RemoveAll(filepath.Join(root, rel)); err != nil {
		t.Fatal(err)
	}

	p.release(rel)

	if p.idle() != 0 {
		t.Fatalf("a vanished cgroup was returned for reuse (idle=%d); acquire would hand jailer a "+
			"--parent-cgroup that does not exist", p.idle())
	}
	// Not a leak: there is nothing left to leak.
	if p.leaks() != 0 {
		t.Fatalf("leaks=%d; a directory that is already gone has not leaked", p.leaks())
	}
	// And the next acquire produces something that really exists.
	next, err := p.acquire()
	if err != nil {
		t.Fatalf("acquire after a drop: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, next)); err != nil {
		t.Fatalf("acquire handed out a non-existent cgroup %q: %v", next, err)
	}
}

// #319 review, must-fix. acquire used to roll `minted` back when mkdir failed, which is correct
// single-threaded and hands the same pool-<n> to two live VMs concurrently:
//
//	A: seq=5, minted -> 6
//	B: seq=6, minted -> 7, mkdir pool-6 OK      <- B holds pool-6
//	A: mkdir pool-5 FAILS -> minted-- -> 6
//	C: seq=6 -> mkdirAllCgroup(pool-6) returns NIL (it exists, and is a dir) -> C holds pool-6 too
//
// That is D1 inverted: admission control charged 2 x PerVMBytes while the kernel enforces one
// bound over both VMMs, so a ballooning command in one can OOM the other's VMM. The fallout is
// mis-recorded too -- whichever destroys first spins in waitForCgroupEmpty on the other's pid and
// counts a leak, then the second pushes the SAME rel back onto free, so it ends up both
// leak-counted and reusable.
//
// The collision itself needs concurrency to stage. What is deterministic, and what prevents it, is
// that a name is never reclaimed after a failure -- so that is what this pins.
func TestCgroupPoolNeverReclaimsANameAfterAFailedMint(t *testing.T) {
	p, root := newTestPool(t)
	// A FILE where pool-0's directory would go, so MkdirAll on it fails.
	if err := os.WriteFile(filepath.Join(root, "microvm.slice/microvm-vms.slice", "pool-0"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := p.acquire(); err == nil {
		t.Fatal("acquire succeeded despite a file blocking the cgroup directory")
	}
	// With the rollback this returns pool-0 again and fails identically; without it, pool-1.
	rel, err := p.acquire()
	if err != nil {
		t.Fatalf("second acquire must mint a FRESH name, got error: %v -- the failed name was reclaimed", err)
	}
	if got := filepath.Base(rel); got != "pool-1" {
		t.Fatalf("second acquire returned %q, want pool-1: a name used by a failed mint must never "+
			"be handed out again, or a concurrent failure can alias a live holder", got)
	}
}

// #319 review. release is careful that the directory must still be there; acquire was not, so a
// cgroup that vanished while idle on the free list would be handed out and fail the restore that
// drew it. Idle entries are the MOST exposed: an idle pooled cgroup is empty so rmdir succeeds,
// while a live VM's is EBUSY and survives -- so an operator clearing the slice by hand (metal
// runbook step 3a) removes precisely what is in `free`. cgroup.go also claims acquire "re-creates
// on miss", which was not true before this.
func TestCgroupPoolRecreatesAPoppedCgroupThatVanished(t *testing.T) {
	p, root := newTestPool(t)
	rel, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	p.release(rel)
	if p.idle() != 1 {
		t.Fatalf("fixture: expected one idle entry, got %d", p.idle())
	}
	// Vanishes while idle, which is exactly what clearing the slice does.
	if err := os.RemoveAll(filepath.Join(root, rel)); err != nil {
		t.Fatal(err)
	}

	again, err := p.acquire()
	if err != nil {
		t.Fatalf("acquire after the idle entry vanished: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, again)); err != nil {
		t.Fatalf("acquire handed out %q which does not exist: %v", again, err)
	}
	// And it is bounded again -- a recreated cgroup with no memory.max would be unbounded.
	if b, err := os.ReadFile(filepath.Join(root, again, "memory.max")); err != nil ||
		strings.TrimSpace(string(b)) != strconv.FormatInt(testPerVM, 10) {
		t.Fatalf("recreated cgroup is not bounded: %q err=%v", b, err)
	}
}

// #319 review. If mkdir succeeds and writeMemoryMax fails, the directory exists, is UNBOUNDED,
// never reaches the free list and is never removed. That is the silent accumulation this whole
// change exists to remove, reappearing on the error path -- and it sat oddly beside release, which
// is meticulous that "a leak is counted so it cannot be silent".
func TestCgroupPoolCountsALeakWhenTheBoundCannotBeWritten(t *testing.T) {
	p, root := newTestPool(t)
	// memory.max as a DIRECTORY: MkdirAll for the cgroup succeeds, the write into it cannot.
	dir := filepath.Join(root, "microvm.slice/microvm-vms.slice", "pool-0")
	if err := os.MkdirAll(filepath.Join(dir, "memory.max"), 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := p.acquire(); err == nil {
		t.Fatal("acquire succeeded without writing the bound")
	}
	if p.leaks() != 1 {
		t.Fatalf("leaks=%d, want 1: an unbounded cgroup nobody will reuse must be counted, since "+
			"it is exactly the accumulation this change removes", p.leaks())
	}
	if p.idle() != 0 {
		t.Fatalf("an unbounded cgroup must not reach the free list (idle=%d)", p.idle())
	}
}

// Lease mode (spec §6, "Not from the cgroup pool"): a lease VM's cgroup has had its memory.max
// raised past the pool's bound, so it must never be handed to a per-Exec VM. retire removes it
// and never puts it on the free list; the name allocator is monotonic, so the next acquire
// mints a new name rather than recreating the retired one.
func TestRetireRemovesAndNeverReissues(t *testing.T) {
	p, root := newTestPool(t)
	a, err := p.acquire()
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	p.retire(a)

	if _, err := os.Stat(filepath.Join(root, a)); !os.IsNotExist(err) {
		t.Fatalf("retired cgroup %q still exists (stat err=%v)", a, err)
	}
	if p.idle() != 0 {
		t.Fatalf("idle=%d after retire, want 0 -- a retired cgroup must never reach the free list", p.idle())
	}
	next, err := p.acquire()
	if err != nil {
		t.Fatalf("acquire after retire: %v", err)
	}
	if next == a {
		t.Fatalf("acquire after retire reissued the retired name %q", a)
	}
	if p.idle() != 0 {
		t.Fatalf("idle=%d, want 0", p.idle())
	}
	if p.leaks() != 0 {
		t.Fatalf("leaks=%d, want 0 -- a clean retire is not a leak", p.leaks())
	}
}

// The same guard as release: a cgroup with a live member is not removed (something is running
// in it), and the refusal is counted rather than silent.
func TestRetireWithProcsLeaks(t *testing.T) {
	p, root := newTestPool(t)
	a, err := p.acquire()
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	// Pid 1 only as a value that parses -- retire must not signal anything.
	if err := os.WriteFile(filepath.Join(root, a, "cgroup.procs"), []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	p.retire(a)

	if _, err := os.Stat(filepath.Join(root, a)); err != nil {
		t.Fatalf("retire removed a cgroup with a live member: %v", err)
	}
	if p.leaks() != 1 {
		t.Fatalf("leaks=%d, want 1", p.leaks())
	}
	if p.idle() != 0 {
		t.Fatalf("idle=%d, want 0 -- a leaked lease cgroup must not reach the free list", p.idle())
	}
}
