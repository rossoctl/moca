package vmpool

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
)

// cgroupPool hands out reusable per-VM cgroups instead of creating and destroying one per VM.
//
// WHY. Task 3.1 decomposed Destroy and found the per-VM cgroup rmdir at 2.15 ms / 15.53 ms /
// 195.52 ms for 4 / 16 / 64 concurrency slots -- 91x growth, and 77% of Destroy at the top,
// because cgroup removal is kernel-serialised. Two cheaper fixes were measured and rejected:
// deferring the rmdir conserves the time into Acquire and makes 64 slots worse, and reclaiming
// charges before rmdir hangs worker startup. The churn also parks 12,400+ dying cgroups, which
// degraded the rig ~24% at 64 slots over one session. Not creating them addresses both.
//
// HOW IT IS POSSIBLE. jailer's --cgroup memory.max= is what CREATES the per-VM cgroup;
// --parent-cgroup alone only relocates the jailed process into a cgroup that already exists. So
// the pool creates the cgroup and writes the bound, and jailer is given only --parent-cgroup.
//
// A FREE LIST, NOT A SIZED POOL. There is no slot concept in this package to size one from --
// nextIDLocked mints ids from a monotonic counter and concurrency is bounded by admitLocked -- so
// acquire pops or mints and release pushes back, which makes the high-water mark exactly the peak
// concurrent VM count (~68 at 64 slots, against ~26,000 create/destroy cycles per rung) without
// anything having to predict it.
//
// THE MEMORY BOUND IS KEPT (design note §4, option D). A live VM cgroup charges ~1 MiB against a
// 288 MiB memory.max -- measured, 0 of 306 samples anywhere near the limit -- because the golden
// snapshot's memfile is mlocked by the WORKER at startup and hardlinked so it stays one shared
// page-cache object. A reused cgroup therefore inherits ~1 MiB, not ~400 MiB, and D1's bound
// survives reuse unchanged.
type cgroupPool struct {
	// root is the cgroupfs mount point, overridable so the whole pool is testable without root.
	// Empty means Cgroup2Root, which is every production path.
	root   string
	parent string // slice-relative, e.g. "microvm.slice/microvm-vms.slice"
	memMax int64

	mu   sync.Mutex
	free []string // slice-relative paths of idle cgroups
	// issued is a NAME ALLOCATOR, not a count of live cgroups, and it never goes backwards.
	// It used to be rolled back when mkdir failed, which is correct single-threaded and hands the
	// same pool-<n> to two live VMs concurrently: A takes seq=5, B takes 6 and creates pool-6, A's
	// mkdir fails and rolls back to 6, C then takes 6 and mkdirAllCgroup returns NIL because the
	// directory already exists. Two VMMs would share one memory.max -- D1 inverted, since admission
	// control charged twice for one enforced bound. An int is free; a name is not. Making the
	// rollback safe would mean holding mu across the mkdir, serialising the syscall this change
	// exists to keep off the critical path.
	issued int
	leaked atomic.Int64
}

func newCgroupPool(parent string, memMax int64, root string) *cgroupPool {
	return &cgroupPool{root: root, parent: parent, memMax: memMax}
}

func (p *cgroupPool) fsRoot() string {
	if p.root != "" {
		return p.root
	}
	return Cgroup2Root
}

// abs turns a slice-relative cgroup path into a filesystem path.
func (p *cgroupPool) abs(rel string) string { return filepath.Join(p.fsRoot(), rel) }

// acquire returns a slice-RELATIVE cgroup path for jailer's --parent-cgroup, reusing an idle one
// when there is one. Relative because jailer refuses an absolute --parent-cgroup outright.
func (p *cgroupPool) acquire() (string, error) {
	p.mu.Lock()
	var rel string
	if n := len(p.free); n > 0 {
		rel = p.free[n-1]
		p.free = p.free[:n-1]
		p.mu.Unlock()
		// An idle entry can have vanished while it sat here, and idle entries are the MOST
		// exposed to it: an idle pooled cgroup is empty so rmdir succeeds, while a live VM's is
		// EBUSY and survives -- so an operator clearing the slice by hand (metal runbook step
		// 3a) removes precisely what is in `free`. Handing the stale rel out costs one failed
		// restore per entry, and at 64 slots `free` can hold ~100. A stat is microseconds
		// against a 60 ms Destroy, and it is what makes isPoolVMCgroupDirName's claim that
		// acquire "re-creates on miss" actually true.
		if _, err := os.Stat(p.abs(rel)); err == nil {
			return rel, nil
		}
		// Fall through and rebuild it under the SAME name: nothing else can hold it, because it
		// was on the free list.
		return p.create(rel)
	}
	seq := p.issued
	p.issued++
	p.mu.Unlock()
	return p.create(filepath.Join(p.parent, pooledCgroupPrefix+strconv.Itoa(seq)))
}

// create materialises rel and writes its bound. Shared by the mint path and the
// vanished-while-idle path so both produce a cgroup that is bounded, never one that is merely
// present.
func (p *cgroupPool) create(rel string) (string, error) {
	dir := p.abs(rel)
	if err := mkdirAllCgroup(dir); err != nil {
		// The name is NOT reclaimed -- see issued.
		return "", fmt.Errorf("vmpool: cgroup pool: create %s: %w", dir, err)
	}
	// The bound jailer's --cgroup used to write. Kept here so D1's figure still applies to every
	// VM (design note §4): the same PerVMBytes admission control charges.
	if err := writeMemoryMax(dir, p.memMax); err != nil {
		// The directory exists and is UNBOUNDED, and nothing will reuse it -- it never reaches
		// the free list. Counted and logged rather than left silent, matching release's posture:
		// an unbounded stray is exactly the accumulation this pool exists to remove, and this is
		// the one path that can produce one.
		p.leaked.Add(1)
		log.Printf("vmpool: cgroup pool: leaking %s, created but could not write memory.max: %v", rel, err)
		return "", err
	}
	return rel, nil
}

// release returns rel for reuse -- unless something is still inside it.
//
// THE GUARD IS LOAD-BEARING. Destroy's kill + cmd.Wait reaps the jailer, but a stray child that
// escaped the process group would otherwise be handed to the NEXT tenant: running inside that
// tenant's memory bound, and inside a cgroup a later SweepOrphans would attribute to whoever holds
// it then. Leaking one cgroup is the behaviour this change replaces; handing over a live
// stranger's process is not. A leak is counted so it cannot be silent, and the directory is left
// alone precisely because something is running in it.
func (p *cgroupPool) release(rel string) {
	// The directory must still BE there. readCgroupProcs reports a missing path as (nil, nil) --
	// indistinguishable from "empty" -- so without this check a cgroup that vanished underneath us
	// would go back on the free list and acquire would later hand out a path jailer cannot
	// relocate into ("--parent-cgroup ... if that path already exists"), failing every restore that
	// drew it. Reachable in practice: an operator clearing the slice by hand is step 3a of the
	// metal runbook, and SweepOrphans now recognises these names too. Dropping the entry is
	// correct and is NOT a leak -- there is nothing left to leak -- so acquire simply mints anew.
	if _, statErr := os.Stat(p.abs(rel)); statErr != nil {
		log.Printf("vmpool: cgroup pool: dropping %s, its directory is gone (%v); a fresh one will "+
			"be created on the next acquire", rel, statErr)
		return
	}
	pids, err := readCgroupProcs(filepath.Join(p.abs(rel), "cgroup.procs"))
	switch {
	case err != nil:
		// Cannot tell, so do not reuse. Same posture as the PSS sampler's refusal: "cannot tell"
		// is not "empty".
		p.leaked.Add(1)
		log.Printf("vmpool: cgroup pool: leaking %s, cannot read cgroup.procs: %v", rel, err)
		return
	case len(pids) > 0:
		p.leaked.Add(1)
		log.Printf("vmpool: cgroup pool: leaking %s, %d process(es) still inside after Destroy "+
			"(a child escaped the process group); it will not be reused", rel, len(pids))
		return
	}
	p.mu.Lock()
	p.free = append(p.free, rel)
	p.mu.Unlock()
}

// retire removes rel instead of returning it for reuse: the lease path (spec §6, "Not from the
// cgroup pool"). A lease VM starts as a pooled standby, and at promotion LeaseCgroup raises its
// memory.max past this pool's bound -- so handing the cgroup to the next per-Exec VM would give
// that VM the lease bound, which admission control does not charge it for. The name is never
// reissued: issued is monotonic, so the next acquire mints a new one.
//
// The guard is release's, for release's reason: a stray process still inside is left alone and
// counted, never removed out from under. A failed rmdir is counted the same way. A directory
// that is already gone is not a leak -- there is nothing left.
func (p *cgroupPool) retire(rel string) {
	if _, statErr := os.Stat(p.abs(rel)); statErr != nil {
		log.Printf("vmpool: cgroup pool: retiring %s, its directory is already gone (%v)", rel, statErr)
		return
	}
	pids, err := readCgroupProcs(filepath.Join(p.abs(rel), "cgroup.procs"))
	switch {
	case err != nil:
		p.leaked.Add(1)
		log.Printf("vmpool: cgroup pool: leaking lease cgroup %s, cannot read cgroup.procs: %v", rel, err)
		return
	case len(pids) > 0:
		p.leaked.Add(1)
		log.Printf("vmpool: cgroup pool: leaking lease cgroup %s, %d process(es) still inside after "+
			"Destroy (a child escaped the process group)", rel, len(pids))
		return
	}
	if err := removeCgroupDir(p.abs(rel)); err != nil {
		p.leaked.Add(1)
		log.Printf("vmpool: cgroup pool: leaking lease cgroup %s, could not remove it: %v", rel, err)
	}
}

func (p *cgroupPool) idle() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.free)
}

// mintedCount reports how many NAMES have been allocated, which after a failed mint exceeds the
// number of cgroups that exist. That is deliberate: see issued.
func (p *cgroupPool) mintedCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.issued
}

func (p *cgroupPool) leaks() int64 { return p.leaked.Load() }
