package vmpool

import (
	"fmt"
	"log"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// This file implements spec §6's #1 practical failure mitigation: "Worker crash leaks
// VMs — Per-VM cgroup under a systemd slice the unit owns; systemd kills the control
// group. On start, sweep the slice for orphans from a previous incarnation."
//
// ARM-AGNOSTIC BY DESIGN (hardware-corrections D3): the cgroup-CREATION mechanism is
// per-arm — on the Firecracker arm cgroupPool creates the cgroup and jailer is merely
// relocated into it by --parent-cgroup (see cgroup_pool.go, and firecrackerCgroupArgs in
// launcher_firecracker.go; jailer's own --cgroup created one per VM until #319); Cloud
// Hypervisor has no jailer equivalent, so its launcher places the VMM in a `systemd-run
// --scope` instead (see launcher_chv.go). But SweepOrphans and vmCgroupPath below only ever
// walk directories and read/write the two files (cgroup.procs, memory.max) that both
// mechanisms produce under the SAME parent slice (spec §5.3). Neither function contains one
// line that knows which VMM made a given subdirectory — that is the whole point: one sweep,
// at worker start, covers whatever either arm left behind, including a mix of both across
// restarts where SH_VMM was changed.
//
// D8 (comm-truncation trap): this sweep kills by reading pids out of cgroup.procs, never
// by matching a process name. That is not just simpler — it is the only form of this that
// works for both arms at all, since cloud-hypervisor's 16-character name is truncated to
// 15 by the kernel's TASK_COMM_LEN, so `pgrep/pkill -x cloud-hypervisor` never matches
// (firecracker's 11-character name is unaffected, which is exactly why this trap survives
// review — it silently breaks one arm while the other keeps working). Reading
// cgroup.procs sidesteps the name entirely.
//
// H1 (final whole-branch review): "walk directories" is NOT "walk every directory".
// deploy/microvm/microvm-worker.service sets Slice=microvm-vms.slice, and systemd nests
// a unit assigned to a slice beneath that slice in the cgroup tree (systemd.slice(5) —
// the same shape as system.slice/sshd.service), so the slice's immediate children are:
//
//	/sys/fs/cgroup/microvm-vms.slice/
//	├── microvm-worker.service/   <-- cgroup.procs holds the SWEEPING PROCESS's own pid
//	├── pool-9/                   <-- Firecracker: cgroupPool's, jailer relocated in
//	├── vm-9/                     <-- Firecracker pre-#319: jailer --id + its own --cgroup
//	└── vm-vm-9.scope/            <-- Cloud Hypervisor: systemd-run --scope --slice=
//
// The original sweep's only filter was entry.IsDir(), so it read its own pid out of
// microvm-worker.service/cgroup.procs and SIGKILLed itself, every RestartSec=5s,
// forever. Three independent guards now stand between this function and that outcome,
// deliberately overlapping — a directory filter alone is exactly what was wrong before,
// so it is not made the only thing that has to be right:
//
//  1. isPoolVMCgroupDirName is an ALLOWLIST of the names THIS POOL creates, derived from
//     nextIDLocked and chvScopeUnitName rather than retyped. Anything else is skipped and
//     REPORTED (SweepResult.Skipped), never swept hopefully. Fail-closed beats
//     sweep-anything: a sweep that kills the wrong cgroup is worse than one that leaves
//     debris a human can see named in a log line.
//  2. sliceHoldsCallersOwnCgroup / callersOwnCgroupDir refuses any directory that IS the
//     caller's own cgroup or an ancestor of it, derived from /proc/self/cgroup — the
//     kernel's own answer — rather than by assuming the unit is called
//     "microvm-worker.service". That assumption is precisely the class of premise that
//     produced H1.
//  3. unsafeToSignal refuses, at the pid layer, the caller's own pid, its
//     process-group leader, and kill(2)'s wildcards 0 and -1. Both launchers Setpgid
//     their VMM into its own process group (fcIsolateProcessGroup,
//     chvIsolateAndDropPrivileges), and an orphan from a PREVIOUS incarnation cannot be
//     in this process's group at all, so nothing this sweep legitimately targets is ever
//     refused by that rule.
//
// The complementary risk — a filter so strict the sweep silently becomes a no-op, which
// reintroduces the orphan leak §6 lists first — is covered by
// TestSweepOrphansSparesTheWorkersOwnCgroupAndStillKillsAVMOrphan asserting BOTH halves
// (the worker's pid survives AND a real VM-shaped orphan's pid dies) in one test, and by
// TestSweepOrphansRecognisesBothArmsCgroupNames pinning the allowlist against the pool's
// own id generator instead of against literals.
//
// D9 (tmpfs-vs-persistent asymmetry): this sweep relies on cgroup.procs, which is a live
// kernel view with no staleness window at all — cgroupfs is not backed by disk and holds
// no state across a reboot for the sweep to misread, unlike a self-maintained PID file
// under /run that Task 16's RunDir reasoning depends on being reboot-cleared. Given that,
// this sweep intentionally does NOT also walk the Firecracker jail directories under
// SH_CHROOT_BASE (default /srv/jail, NOT reboot-cleared per D9) — a leftover jail
// directory is expected debris from a normal Destroy that failed partway, not evidence of
// a live process, and removing it blind on every worker start risks deleting a jail that
// a *different*, still-running worker incarnation legitimately owns during a rolling
// restart. Cleaning stale jail directories is a candidate for a separate, explicitly
// time-based reaper, not this crash-recovery sweep.

// The four names below are the single authority on what a VM's cgroup DIRECTORY is
// called under the parent slice. They live together, in the file that has to recognise
// them, because H1 was a false premise about exactly this — and they are consumed rather
// than duplicated: pool.nextIDLocked builds every VM id from vmIDPrefix,
// launcher_chv.go's Restore names its systemd scope with chvScopeUnitName, and
// cgroupPool allocates from pooledCgroupPrefix. Spec §5.3's
// "two numbers that can drift is the bug" applies to a name just as much as to a byte
// count, and the drift here is silent in the worst direction: the sweep would keep
// returning 0 swept while VMs leaked.
const (
	// vmIDPrefix prefixes every pool-generated VM id ("vm-" + a decimal sequence
	// number). That id is jailer's --id, so it names the VM's JAIL directory.
	//
	// It named the Firecracker arm's CGROUP directory too, until #319: jailer, given
	// --cgroup, "will create a new cgroup named <id> for the microvm in the
	// <cgroup_base>/<parent_cgroup> subfolder" (firecracker docs/jailer.md), which made the
	// VM cgroup an immediate child of the slice. That flag is gone, so a live VM now sits in
	// a pooledCgroupPrefix directory (below) and a vm-<n> cgroup can only be an orphan left
	// by an incarnation that predates #319. The name stays in this list for exactly that
	// reason — the sweep must still recognise one.
	vmIDPrefix = "vm-"

	// chvScopeUnitPrefix prefixes the Cloud Hypervisor arm's `systemd-run --scope
	// --unit=` name, which systemd materialises as "<unit>" + chvScopeDirSuffix under
	// --slice.
	chvScopeUnitPrefix = "vm-"

	// chvScopeDirSuffix is the suffix systemd gives a scope unit's cgroup directory.
	chvScopeDirSuffix = ".scope"

	// pooledCgroupPrefix names cgroupPool's REUSABLE cgroups (#258), which are directories
	// under this same parent slice and therefore belong in this list.
	//
	// It is deliberately NOT vmIDPrefix, and the reason belongs here rather than beside the
	// pool: jailer's --id must stay monotonic, because a live VMM holding a jail id is what
	// the collision guard refuses on. A pooled cgroup is reused, so if it were named vm-<n>
	// the directory vm-3 would stop corresponding to VM vm-3 and the two namespaces would
	// drift silently — which is exactly the failure mode this block exists to prevent, in a
	// form that would read as correct.
	//
	// Note this INVERTS the invariant the other names carry: a vm-<n> cgroup present at
	// startup is an orphan to be swept, whereas a pool-<n> one is normal. What must not
	// survive a restart is a PROCESS inside one, not the directory.
	pooledCgroupPrefix = "pool-"

	// Cgroup2Root is where the unified hierarchy is mounted. SH_PARENT_CGROUP is
	// SLICE-RELATIVE (see DefaultParentCgroup), so this is what turns it into a
	// filesystem path for the sweep.
	Cgroup2Root = "/sys/fs/cgroup"

	// DefaultParentCgroup is the ONE default both consumers share, so they cannot
	// drift apart again. It is deliberately slice-RELATIVE and deliberately spells the
	// full systemd hierarchy, because both of those were wrong before and each was
	// wrong in a way that looked right:
	//
	// Verified on hardware (m8i.xlarge, jailer v1.17.0, cgroup v2), three ways:
	//
	//	--parent-cgroup /sys/fs/cgroup/microvm.slice/microvm-vms.slice
	//	    REFUSED: "Parent cgroup path is invalid. Path should not be absolute or
	//	    contain '..' or '.'" / CgroupInvalidParentPath. No cgroup created. So an
	//	    absolute value can never work for the Firecracker arm, however correct the
	//	    path is — which is why ValidateParentCgroup refuses one at start.
	//	--parent-cgroup microvm-vms.slice
	//	    Created /sys/fs/cgroup/microvm-vms.slice/vm-N — a NEW TOP-LEVEL cgroup
	//	    OUTSIDE systemd's slice. memory.max was set on it, so it looked correct,
	//	    while the slice's own accounting and limits covered none of it and a sweep
	//	    pointed at the systemd slice could never see it.
	//	--parent-cgroup microvm.slice/microvm-vms.slice
	//	    Created /sys/fs/cgroup/microvm.slice/microvm-vms.slice/vm-N, inside the
	//	    slice, memory.max correct. This one.
	//
	// The two-segment form is not redundancy: systemd expands a DASHED slice name into
	// a hierarchy, so the unit "microvm-vms.slice" lives at
	// microvm.slice/microvm-vms.slice. `systemctl show microvm-vms.slice -p
	// ControlGroup` reports /microvm.slice/microvm-vms.slice, and
	// /sys/fs/cgroup/microvm-vms.slice does not exist at all.
	DefaultParentCgroup = "microvm.slice/microvm-vms.slice"
)

// ValidateParentCgroup rejects a SH_PARENT_CGROUP that jailer itself would reject, at
// start rather than at the first Restore. The rule is jailer's own, quoted from its
// error text: not absolute, no "." or ".." component. Spec §6's posture is to fail at
// start for a misconfiguration that makes the tier unusable, and an absolute value
// makes every Firecracker restore fail.
func ValidateParentCgroup(rel string) error {
	if rel == "" {
		return fmt.Errorf("vmpool: SH_PARENT_CGROUP is empty (want a slice-relative path such as %q)", DefaultParentCgroup)
	}
	if filepath.IsAbs(rel) {
		return fmt.Errorf("vmpool: SH_PARENT_CGROUP=%q is absolute, and jailer refuses an absolute "+
			"--parent-cgroup (jailer: Path should not be absolute or contain a dot component), so every Firecracker "+
			"restore would fail. Give it slice-relative, e.g. %q — %s is prepended for the orphan sweep",
			rel, DefaultParentCgroup, Cgroup2Root)
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == "." || seg == ".." {
			return fmt.Errorf("vmpool: SH_PARENT_CGROUP=%q contains a %q component, which jailer refuses", rel, seg)
		}
	}
	return nil
}

// ParentCgroupPath turns the slice-relative SH_PARENT_CGROUP into the cgroupfs path the
// orphan sweep walks. The launcher passes the relative form to jailer verbatim; only the
// sweep needs it absolute, and deriving it here is what stops the two from disagreeing.
func ParentCgroupPath(rel string) string { return filepath.Join(Cgroup2Root, rel) }

// chvScopeUnitName is the systemd-run --scope unit name the Cloud Hypervisor arm gives
// one VM. Called by that launcher's Restore, and reversed by isPoolVMCgroupDirName below
// — one function, so the sweep and the launcher cannot disagree about the name.
func chvScopeUnitName(vmID string) string { return chvScopeUnitPrefix + vmID }

// isPoolVMID reports whether s is a VM id nextIDLocked could have produced: vmIDPrefix
// followed by a non-empty run of decimal digits. Deliberately narrow — an id shape this
// pool does not generate is not a VM, and treating it as one is how H1 happened.
func isPoolVMID(s string) bool {
	rest, ok := strings.CutPrefix(s, vmIDPrefix)
	if !ok || rest == "" {
		return false
	}
	for _, r := range rest {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// isPoolVMCgroupDirName reports whether name is an immediate-child directory name that
// THIS POOL created under the parent slice, for either arm (hardware-corrections D3: one
// sweep covers both, including a mix of the two across restarts where SH_VMM changed).
// Everything else — the worker's own unit cgroup above all, but equally init.scope, a
// nested slice, or any unit an operator later places in the same slice — is not swept.
// isPooledCgroupDirName reports whether name is one of cgroupPool's directories. Beside the
// other two recognisers on purpose: the name and the code that recognises it are the pair H1
// got wrong, so splitting them across files is what this block exists to prevent.
func isPooledCgroupDirName(name string) bool {
	rest, ok := strings.CutPrefix(name, pooledCgroupPrefix)
	if !ok || rest == "" {
		return false
	}
	for _, r := range rest {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func isPoolVMCgroupDirName(name string) bool {
	if isPoolVMID(name) {
		return true // Firecracker: the jailer's --id, verbatim
	}
	if isPooledCgroupDirName(name) {
		// A reusable cgroup from cgroupPool (#258). Recognised so SweepOrphans still kills a
		// dead VMM left inside one by a crashed worker. Note this INVERTS the invariant for
		// the vm-<n> form: a vm-<n> cgroup present at startup is an orphan, whereas a
		// pool-<n> one is normal -- what must not survive is a process inside it, and the
		// sweep removing the directory too is harmless because acquire re-creates on miss.
		return true
	}
	if unit, ok := strings.CutSuffix(name, chvScopeDirSuffix); ok {
		// Cloud Hypervisor: chvScopeUnitName(id) + ".scope".
		if id, ok := strings.CutPrefix(unit, chvScopeUnitPrefix); ok {
			return isPoolVMID(id)
		}
	}
	return false
}

// callersOwnCgroupDir returns the calling process's own cgroup as /proc/self/cgroup
// reports it: a path relative to the cgroup2 mount, e.g.
// "/microvm-vms.slice/microvm-worker.service". Empty when that cannot be determined —
// there is no /proc/self/cgroup on darwin or windows, and a cgroup-v1-only host has no
// "0::" unified line — in which case guard 2 is simply inert and guards 1 and 3 stand.
//
// Reading the kernel's own answer is the point: the alternative is to hardcode the unit
// name, and a filter that assumes what the caller's cgroup is called is the same species
// of premise that produced H1 in the first place.
func callersOwnCgroupDir() string {
	b, err := os.ReadFile(selfCgroupProcPath)
	if err != nil {
		return ""
	}
	return parseSelfCgroupV2(string(b))
}

// selfCgroupProcPath is the file callersOwnCgroupDir reads. A constant, not a variable, so
// nothing can repoint it at runtime; the PARSING is what gets tested, via
// parseSelfCgroupV2 below.
const selfCgroupProcPath = "/proc/self/cgroup"

// parseSelfCgroupV2 extracts the cgroup v2 (unified) path from /proc/self/cgroup's
// content. Split out from the file read for one reason: the read only ever succeeds on
// Linux, and a parse that can only be exercised on the deployment platform is a parse
// nothing checks — which is precisely the shape of final-review H2 (a Linux-only code path
// that was wrong on every Linux host and invisible on darwin). This function is driven
// against real /proc/self/cgroup content, including the systemd-shaped line this worker
// actually runs under, by TestParseSelfCgroupV2 on darwin.
//
// Returns "" for anything with no usable v2 path, the root cgroup included: there is no
// meaningful directory to exclude when the caller is at the root.
func parseSelfCgroupV2(content string) string {
	for _, line := range strings.Split(content, "\n") {
		// cgroup v2 unified: "0::<path>". v1 lines carry a non-zero hierarchy id and a
		// controller list, and are not what any of this deals with (D2: both the dev
		// host and the production box are cgroup2 unified).
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "0::"); ok {
			if rest == "" || rest == "/" {
				return ""
			}
			return rest
		}
	}
	return ""
}

// isCallersOwnCgroup reports whether dir is the caller's own cgroup, or an ancestor of
// it, given selfRel from callersOwnCgroupDir.
//
// The comparison is a suffix match because the two paths are anchored differently and
// deliberately are not reconciled: selfRel is relative to the cgroup2 mount
// ("/microvm-vms.slice/microvm-worker.service") while dir is a filesystem path
// ("/sys/fs/cgroup/microvm-vms.slice/microvm-worker.service", or a t.TempDir() in this
// package's own tests). Discovering the mount point to make them comparable would add a
// second thing that can be wrong; a suffix match cannot produce a FALSE NEGATIVE for the
// case that matters, and its only failure direction — refusing to sweep a directory that
// merely looks like an ancestor of ours — is the safe one.
func isCallersOwnCgroup(dir, selfRel string) bool {
	if selfRel == "" {
		return false
	}
	d := filepath.ToSlash(filepath.Clean(dir))
	for cur := selfRel; cur != "/" && cur != "." && cur != ""; cur = path.Dir(cur) {
		if strings.HasSuffix(d, cur) {
			return true
		}
	}
	return false
}

// unsafeToSignal is the innermost guard: pids SweepOrphans must never pass to
// killPidIgnoringAbsent, whatever a cgroup.procs file claims. It returns the reason as
// well as the verdict so a refusal is legible in the log rather than an unexplained
// skip.
func unsafeToSignal(pid int) (reason string, unsafe bool) {
	switch {
	case pid <= 0:
		// kill(2): pid 0 signals EVERY process in the CALLER's own process group and
		// pid -1 every process the caller may signal. readCgroupProcs parses whatever
		// digits it finds, so this is not hypothetical — one such line would turn the
		// sweep into a self-kill (or worse) with no directory filter involved at all.
		return "kill(2) treats a pid <= 0 as the caller's own process group (0) or every process (-1), not as one process", true
	case pid == os.Getpid():
		return "it is the calling process itself", true
	case pidSharesCallersProcessGroup(pid):
		// Both launchers put their VMM in its OWN process group
		// (fcIsolateProcessGroup, chvIsolateAndDropPrivileges), and an orphan from a
		// previous worker incarnation cannot share this process's group, so nothing
		// this sweep legitimately targets is refused here.
		return "it is in the calling process's own process group", true
	}
	return "", false
}

// mkdirAllCgroup creates a cgroup directory. Separated so cgroupPool reads as intent rather than
// as a bare MkdirAll: on real cgroupfs the kernel materialises the control files, and creating a
// nested path is how a child cgroup comes into being at all.
func mkdirAllCgroup(dir string) error { return os.MkdirAll(dir, 0o755) }

// writeMemoryMax bounds one VM's cgroup to bytes. Spec §6's third mitigation: a
// ballooning command is killed inside its OWN cgroup — one failed Exec, attributable —
// instead of a host-level OOM lottery whose size-ranked favourites include
// microvm-worker itself. cgroup v2's memory.max accepts a bare byte count (no unit
// suffix), which is what gets written here.
func writeMemoryMax(dir string, bytes int64) error {
	if bytes <= 0 {
		return fmt.Errorf("vmpool: writeMemoryMax: bytes must be > 0, got %d", bytes)
	}
	path := filepath.Join(dir, "memory.max")
	if err := os.WriteFile(path, []byte(strconv.FormatInt(bytes, 10)), 0o644); err != nil {
		return fmt.Errorf("vmpool: writeMemoryMax %s: %w", path, err)
	}
	return nil
}

// readMemoryCurrent reads a cgroup's memory.current — the bytes it is holding
// right now, anonymous and charged file cache both. This is what
// standbyChargeLocked prices a paused standby at (#644): on a host whose golden
// memfile is mlocked and faulted by the WORKER at startup, a standby's cgroup sees
// only the pages that VM dirtied itself (E11: 0.9 MiB mean / 2 MiB max against a
// 288 MiB memory.max), because the shared snapshot pages are charged to the cgroup
// that first faulted them in — the worker's. memory.current is bounded by the
// memory.max writeMemoryMax above set from the same PerVMBytes, so an honest read
// can never exceed what the budget already prices a fully-dirtied VM at.
func readMemoryCurrent(dir string) (int64, error) {
	path := filepath.Join(dir, "memory.current")
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("vmpool: reading %s: %w", path, err)
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("vmpool: parsing %s %q: %w", path, string(b), err)
	}
	return n, nil
}

// SweepResult reports what one sweep did AND what it deliberately refused to touch.
//
// Skipped is not decoration. A fail-closed filter and a broken filter look identical
// from the outside — both sweep nothing — so the names it declined have to be visible,
// or the next silent no-op sweep is undetectable in production exactly as the last
// silent self-kill was (H1's journald showed a SIGKILL and no log line at all).
type SweepResult struct {
	// Swept counts pool-named VM cgroup DIRECTORIES swept — not processes killed. See
	// the note below on why that distinction is load-bearing.
	Swept int

	// Skipped names the immediate subdirectories the guards refused, in readdir order.
	// In the shipped systemd configuration this is normally exactly
	// ["microvm-worker.service"] — the worker's own cgroup — and an operator seeing
	// anything else in it is seeing something new placed in the slice.
	Skipped []string

	// Stuck names pool-named VM cgroups whose processes were SIGKILLed and had still not
	// exited sweepExitWait later (#797). Not counted in Swept and not removed: a VMM
	// that is still tearing down can still hold its VM id's API socket, and the pool's
	// cgroup names are reused from pool-0 on every start, so the next VM would be
	// placed in a cgroup that still holds the old one. The caller decides what that
	// means for its start; microvm-worker refuses to start.
	Stuck []string
}

// SweepOrphans walks slicePath's immediate subdirectories, and for each one that THIS
// POOL named (isPoolVMCgroupDirName; everything else is skipped and reported — see the
// H1 block at the top of this file): reads cgroup.procs, SIGKILLs every
// pid listed (ignoring ESRCH: a pid that has already exited is a swept orphan, not an
// error), waits up to sweepExitWait for those processes to exit, then rmdirs the directory
// (D5: rmdir, never rm -rf — cgroup directories are kernel-backed pseudo-files and rm -rf
// fails on them; rmdir on an emptied cgroup is the supported removal). A directory whose
// processes are still running when that wait ends is reported in SweepResult.Stuck and
// left in place, not counted (#797). SweepResult.Swept
// counts VM cgroup DIRECTORIES swept — not the number of processes actually killed by
// this call. A cgroup whose sole occupant already exited (nothing left to signal) counts
// exactly the same as one whose occupant this call actually SIGKILLed, by design (the
// brief's own framing: "pids that no longer exist still count as swept") — so that
// counter cannot be used to infer whether any live process was found or killed.
// An absent slice (first boot on a fresh host) returns a zero result and no error — spec
// §6's posture is "fail at start" for things that make the tier unusable, and an empty
// slice is not one of them.
//
// Fix round 1 (coordinator review of 36dbcb9), item 2: the parameter name was
// previously `killed`, which reads as "count of processes killed" — misleading enough
// that a coordinator mutation test (replacing the kill call with a no-op) still passed
// the existing directory-removal-based test undetected. Renamed to `swept` to match
// what it actually counts; TestSweepOrphansActuallyKillsALiveProcess (cgroup_test.go)
// now separately covers the kill itself with a real, long-lived child process, since
// this counter cannot.
//
// Platform-specific pid signalling (SIGKILL, ESRCH detection) lives in
// cgroup_unix.go/cgroup_windows.go (unix vs. windows — see cgroup_windows.go for why),
// and RLIMIT_MEMLOCK-raising lives in cgroup_linux.go/cgroup_other.go (linux vs.
// everything else, since that call has no meaningful non-linux behaviour at all) —
// this file's directory-walking logic is itself platform-independent and runs
// identically (and is unit-tested) on darwin.
func SweepOrphans(slicePath string) (SweepResult, error) {
	var res SweepResult
	entries, err := os.ReadDir(slicePath)
	if err != nil {
		if os.IsNotExist(err) {
			return res, nil
		}
		return res, fmt.Errorf("vmpool: SweepOrphans: reading %s: %w", slicePath, err)
	}

	selfCgroup := callersOwnCgroupDir()
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		dir := filepath.Join(slicePath, name)

		// Guard 1: only what this pool named. Guard 2: never the caller's own cgroup
		// (or an ancestor of it), whatever it is called.
		if !isPoolVMCgroupDirName(name) || isCallersOwnCgroup(dir, selfCgroup) {
			res.Skipped = append(res.Skipped, name)
			continue
		}
		outcome, err := sweepOneCgroup(dir)
		if err != nil {
			return res, fmt.Errorf("vmpool: SweepOrphans: %s: %w", dir, err)
		}
		switch outcome {
		case cgroupRefused:
			// Guard 3 fired from inside: this cgroup holds a pid nothing may signal
			// (the caller itself, or its process group). Refuse the whole directory
			// rather than kill its other members and rmdir around the survivor.
			res.Skipped = append(res.Skipped, name)
		case cgroupStuck:
			res.Stuck = append(res.Stuck, name)
		default:
			res.Swept++
		}
	}
	return res, nil
}

// sweepOutcome is what sweepOneCgroup did with one directory.
type sweepOutcome int

const (
	// cgroupSwept: every pid was signalled, none was still running by the end of the
	// wait, and the directory was removed.
	cgroupSwept sweepOutcome = iota
	// cgroupRefused: guard 3 declined the directory before any signal was sent.
	cgroupRefused
	// cgroupStuck: every pid was signalled, and at least one was still running when
	// sweepExitWait ran out. The directory is left in place.
	cgroupStuck
)

// defaultSweepExitWait bounds how long sweepOneCgroup waits for the processes it has just
// SIGKILLed to exit (#797). SIGKILL is not instant for a VMM: the kernel unmaps the guest's
// memory and closes its descriptors, the API socket among them, before the process leaves
// the cgroup, and that teardown grows with guest RAM. The 200 ms waitForCgroupEmpty allows
// Destroy (whose VMM is already reaped) was observed to be too short here: the cgroup was
// counted as swept while its VMM still answered on its API socket, and the startup probe
// collided with it. A few seconds covers the teardown with margin, and a start that has
// just killed a VM can afford them.
const defaultSweepExitWait = 5 * time.Second

// sweepExitWait is defaultSweepExitWait, a variable so a test can shorten the bound it
// would otherwise sit out in full.
var sweepExitWait = defaultSweepExitWait

// sweepKill is how sweepOneCgroup signals a pid: killPidIgnoringAbsent, a variable so a test
// can stage a process that outlives its SIGKILL, which no real process can be made to do.
var sweepKill = killPidIgnoringAbsent

// sweepOneCgroup kills every pid in dir/cgroup.procs and removes dir once they have exited.
// It reports cgroupRefused, with no error, when the cgroup holds a pid unsafeToSignal
// refuses — that is not a failure, it is the third guard declining a directory the first
// two let through, and the caller records it as skipped. It reports cgroupStuck, also with
// no error, when a signalled pid is still running sweepExitWait later: the directory is
// logged and left, never counted as swept (#797).
func sweepOneCgroup(dir string) (sweepOutcome, error) {
	pids, err := readCgroupProcs(filepath.Join(dir, "cgroup.procs"))
	if err != nil {
		return cgroupRefused, err
	}
	// Checked as a whole BEFORE any signal is sent: a cgroup containing one pid that
	// must not be signalled is not a cgroup to half-sweep.
	for _, pid := range pids {
		if reason, unsafe := unsafeToSignal(pid); unsafe {
			log.Printf("vmpool: SweepOrphans: refusing %s: cgroup.procs lists pid %d and %s", dir, pid, reason)
			return cgroupRefused, nil
		}
	}
	for _, pid := range pids {
		if err := sweepKill(pid); err != nil {
			return cgroupRefused, fmt.Errorf("kill pid %d: %w", pid, err)
		}
	}
	if running := waitForSweptPidsToExit(dir, sweepExitWait); len(running) > 0 {
		log.Printf("vmpool: SweepOrphans: not swept %s: pid(s) %v still running %s after SIGKILL; "+
			"left in place", dir, running, sweepExitWait)
		return cgroupStuck, nil
	}
	return cgroupSwept, removeCgroupDir(dir)
}

// removeCgroupDir rmdirs dir (D5: rmdir, never rm -rf). On REAL cgroupfs this is the
// whole story: cgroup.procs/memory.max etc. are kernel pseudo-files that do not block
// rmdir once the cgroup has no member processes, so the first os.Remove below succeeds
// and the fallback is never reached. It exists for the synthetic cgroup-v2-shaped tree
// this package's own tests build under t.TempDir() (fakeSlice in cgroup_test.go), where
// cgroup.procs is an ordinary regular file on a real filesystem and a bare rmdir
// legitimately fails with ENOTEMPTY. The fallback clears only plain files directly in
// dir — no recursion into subdirectories, so this is not rm -rf in spirit or effect,
// and a real VM cgroup is a leaf with no subdirectories for it to ever touch.
func removeCgroupDir(dir string) error {
	if err := os.Remove(dir); err == nil || os.IsNotExist(err) {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("rmdir %s: reading to retry: %w", dir, err)
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		_ = os.Remove(filepath.Join(dir, e.Name()))
	}
	if err := os.Remove(dir); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("rmdir %s: %w", dir, err)
	}
	return nil
}

// readCgroupProcs parses a cgroup.procs file into pids. An absent or empty file (a
// cgroup whose sole occupant has already exited) yields an empty, non-error result.
func readCgroupProcs(path string) ([]int, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	var pids []int
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		pid, err := strconv.Atoi(line)
		if err != nil {
			return nil, fmt.Errorf("parsing pid %q in %s: %w", line, path, err)
		}
		pids = append(pids, pid)
	}
	return pids, nil
}

// killPidIgnoringAbsent sends SIGKILL to pid. Its implementation is behind a build-tag
// split, cgroup_unix.go ("//go:build unix", covering both linux and darwin — the
// platform this package's own tests run on) and cgroup_windows.go ("//go:build
// windows", a stub that returns an error).
//
// Fix round 1 (coordinator review of 36dbcb9), item 3: this used to live here with no
// build tag at all, calling syscall.Kill/syscall.SIGKILL/syscall.ESRCH directly. Those
// three names happen to exist under both linux and darwin's syscall package, which is
// why the previous claim ("needs no build-tag split") was true for the two platforms
// this package is actually tested and deployed on — but it meant GOOS=windows failed
// to even COMPILE this file, silently, with no build tag marking that as a deliberate
// choice. This package elsewhere maintains an explicit split for exactly this kind of
// platform difference (cgroup_linux.go/cgroup_other.go for RaiseMemlockLimit), so the
// process-killing half of the sweep now gets the same treatment: a real
// implementation on unix, and an explicit stub on windows that compiles cleanly and
// fails loudly (a clear error, not a missing symbol) if ever reached. Windows is not a
// deployment target for this project — nothing here is claiming otherwise — but a
// package that fails to compile on an unlisted platform is a worse, more surprising
// failure mode than one that compiles everywhere and only refuses to *run* where it
// cannot.

// waitForCgroupEmpty polls dir's cgroup.procs briefly so the kernel has a chance to
// finish tearing down a just-killed process before rmdir is attempted — rmdir on a
// cgroup that still has a member (even a zombie draining) fails. This is best-effort:
// SweepOrphans' own rmdir error, if any, is what ultimately surfaces a stuck cgroup, not
// this helper.
func waitForCgroupEmpty(dir string) {
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		pids, err := readCgroupProcs(filepath.Join(dir, "cgroup.procs"))
		if err != nil || len(pids) == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitForSweptPidsToExit polls dir's cgroup.procs until no pid it lists is still running, or
// until timeout, and returns the pids still running at that point (none: the cgroup has
// emptied). It is the sweep's wait, separate from waitForCgroupEmpty because the two waits
// differ in what they may assume: Destroy has already reaped its VMM, while the sweep has
// only signalled a stranger's, and must say so when it is still there.
//
// A listed pid counts only while it is still running (pidStillRunning). On cgroupfs that
// changes nothing — the kernel removes an exiting process from cgroup.procs, and a zombie is
// not listed there — but it is what lets the synthetic tree this package's tests build,
// where cgroup.procs is an ordinary file that never changes, reach "emptied" at all.
//
// A cgroup.procs that cannot be read ends the wait with nothing reported: removeCgroupDir's
// rmdir is then what surfaces a cgroup that did not empty, as it did before #797.
func waitForSweptPidsToExit(dir string, timeout time.Duration) []int {
	deadline := time.Now().Add(timeout)
	for {
		pids, err := readCgroupProcs(filepath.Join(dir, "cgroup.procs"))
		if err != nil {
			return nil
		}
		var running []int
		for _, pid := range pids {
			if pidStillRunning(pid) {
				running = append(running, pid)
			}
		}
		if len(running) == 0 || !time.Now().Before(deadline) {
			return running
		}
		time.Sleep(10 * time.Millisecond)
	}
}
