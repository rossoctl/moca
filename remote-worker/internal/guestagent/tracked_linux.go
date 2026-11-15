//go:build linux

package guestagent

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Level 2's process handlers (spec §7): process_start, process_list, process_logs,
// process_stop and the host-only process_stop_all. runLease calls them under the lease
// mutex, so they never interleave with each other or with an Exec.
//
// Each tracked process runs in its own cgroup, CgroupRoot/tracked/p<id>: root-owned, not
// delegated, capped like an Exec's, and outside every Exec's teardown (spec §3.1). It
// runs through the shim under its own uid from the tracked range, in the sbx-ws group,
// with umask 0002 and its own HOME (spec §3.3), in its own session, stdin /dev/null,
// and stdout and stderr together in its ring (tracked.go).
//
// The strict rule is that every process alive in the guest outside an Exec is visible
// in process_list. A process's children stay in its cgroup when it exits; they are what
// process_stop of the exited entry kills, and its uid is not reused until they are gone.
// The entry stays exited meanwhile (ruling P5-R13): its memory_bytes, its cgroup's
// memory.current, is what shows them.
// When the table forgets an entry (eviction, or a new process taking an exited one's
// name), whatever is left in its cgroup is killed.

// trackedHomeParent holds each tracked uid's HOME, <parent>/<uid> (ruling P5-R12; the
// image's passwd lines name /tmp/sbx-proc/<uid>). It is root-owned and 0711, made at
// lease prepare, so no other uid can create, or squat, a tracked HOME. A package
// variable so the tests keep their homes off the test host's /tmp.
var trackedHomeParent = "/tmp/sbx-proc"

// trackedAfterCwdCheck, when set, runs between process_start's cwd check and the
// start: a test seam for a workspace changed in that window, as a running tracked
// process (in the group-writable workspace) could change it. Nil outside tests.
var trackedAfterCwdCheck func()

// trackedStopGrace is how long process_stop waits after the signal before it kills the
// cgroup (global constraints: TERM, then the cgroup is killed after 10 s). A package
// variable so a test need not wait the full 10 s.
var trackedStopGrace = 10 * time.Second

// trackedExitWait bounds the wait, after a stopped process's cgroup has emptied, for the
// reaper to record its exit: the cgroup empties just before the exit is reported.
const trackedExitWait = leaseTeardownBound

func (a *Agent) trackedRoot() string { return filepath.Join(a.opts.Lease.CgroupRoot, "tracked") }

func (a *Agent) trackedCgroup(id string) string { return filepath.Join(a.trackedRoot(), "p"+id) }

// ensureTrackedRoot makes CgroupRoot/tracked and enables pids and memory for its
// children, so each tracked/p<id> can be capped. tracked holds no process of its own.
// Idempotent.
func (a *Agent) ensureTrackedRoot() error {
	dir := a.trackedRoot()
	if err := os.Mkdir(dir, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("guest-agent: process_start: tracked cgroup: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.subtree_control"), []byte("+pids +memory"), 0); err != nil {
		return fmt.Errorf("guest-agent: process_start: enable pids and memory in %s: %w", dir, err)
	}
	return nil
}

// processStart starts a tracked process and answers {"id","name","pid"} on stdout.
func (a *Agent) processStart(req Request, w *frameWriter, r *reaper, shim string) (End, error) {
	var args ProcessArgs
	if req.Process != nil {
		args = *req.Process
	}
	if err := validateProcessName(args.Name); err != nil {
		return End{}, err
	}
	cwd, err := resolveProcessCwd(a.opts.WorkDir, args.Cwd)
	if err != nil {
		return End{}, err
	}
	if trackedAfterCwdCheck != nil {
		trackedAfterCwdCheck()
	}
	// The process changes into this descriptor after its privilege drop (the shim's
	// ShimCwdFD), never into a path: a running tracked process can rewrite the
	// group-writable workspace, and a root chdir would follow whatever it put there.
	cwdDir, err := openCwdBeneath(a.opts.WorkDir, cwd, args.Cwd)
	if err != nil {
		return End{}, err
	}
	defer cwdDir.Close()
	if err := a.ensureTrackedRoot(); err != nil {
		return End{}, err
	}
	maxRunning := req.MaxProcesses
	if maxRunning <= 0 {
		maxRunning = defaultMaxProcesses
	}
	p, err := a.lease.procs.start(args.Name, maxRunning, func(id string, log *ring) (int, int, error) {
		return a.launchTracked(id, log, req.Command, cwdDir, maxRunning, r, shim)
	})
	if err != nil {
		return End{}, err
	}
	// A start that took an exited entry's name dropped that entry; runLease's prune
	// kills whatever it left.
	out, err := json.Marshal(struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		PID  int    `json:"pid"`
	}{p.ID, displayName(p), p.PID})
	if err != nil {
		return End{}, err
	}
	w.stdout(out)
	return End{}, nil
}

// openCwdBeneath opens cwd, which resolveProcessCwd has checked, as an O_PATH directory
// descriptor resolved beneath the workspace: no symlink, no other mount, nothing above
// it. A directory swapped for a symlink since the check is refused here; once open, the
// descriptor names the directory itself, which cannot leave the workspace's mount.
func openCwdBeneath(workDir, cwd, given string) (*os.File, error) {
	fail := func(err error) (*os.File, error) {
		return nil, fmt.Errorf("process_cwd: %s: changed while starting: %v", clip(given), err)
	}
	root, err := filepath.EvalSymlinks(workDir)
	if err != nil {
		return fail(err)
	}
	rel, err := filepath.Rel(root, cwd)
	if err != nil {
		return fail(err)
	}
	rfd, err := unix.Open(root, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return fail(err)
	}
	defer unix.Close(rfd)
	fd, err := unix.Openat2(rfd, rel, &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV,
	})
	if err != nil {
		return fail(err)
	}
	return os.NewFile(uintptr(fd), cwd), nil
}

// launchTracked is trackedTable.start's launch for process id: it takes a uid, makes the
// process's cgroup and HOME, and forks the shim into the cgroup, with cwdDir as the
// directory it changes into after its drop. On an error nothing is left: the uid is
// released and the cgroup removed.
func (a *Agent) launchTracked(id string, log *ring, command string, cwdDir *os.File, maxRunning int, r *reaper, shim string) (int, int, error) {
	l := &a.lease
	lo := a.opts.Lease
	uid, err := l.uids.take(l.cgroups.populated)
	if err != nil {
		// Every uid is held or still populated: the same limit, as the host sees it
		// (ruling P5-R6), naming the leftovers when they hold some.
		return 0, 0, processLimitError(maxRunning, err)
	}
	launched := false
	defer func() {
		if !launched {
			l.uids.release(uid)
		}
	}()

	c, err := newCappedCgroup(a.trackedCgroup(id))
	if err != nil {
		return 0, 0, err
	}
	// Recorded before the fork: from here on, populated(uid) reads this cgroup.
	l.cgroups.assign(uid, c.path)
	fail := func(err error) (int, int, error) {
		_ = c.remove()
		return 0, 0, err
	}
	home, err := prepareTrackedHome(uid, lo.GID)
	if err != nil {
		return fail(err)
	}
	devNull, err := os.Open(os.DevNull)
	if err != nil {
		return fail(err)
	}
	defer devNull.Close()
	logR, logW, err := os.Pipe()
	if err != nil {
		return fail(err)
	}
	barR, barW, err := os.Pipe()
	if err != nil {
		_, _ = logR.Close(), logW.Close()
		return fail(err)
	}
	defer barR.Close()
	l.exits.add(id)

	argv := []string{shim, ShimArg, strconv.Itoa(uid), strconv.Itoa(lo.GID), home, l.uids.user(uid), ShimCwdFromFD, "--", a.opts.Shell, "-c", command}
	// As runLeaseCommand's fork: the agent's environment, CLONE_INTO_CGROUP so there is
	// no moment outside the cgroup, and a session of its own. stdout and stderr share
	// one pipe, so the ring keeps them in the order they were written. The shim's exec
	// barrier is fd 3 and its cwd fd 4. No Dir: the agent's root never changes into
	// the cwd; the shim does, as the tracked uid.
	r.expect()
	pid, err := syscall.ForkExec(shim, argv, &syscall.ProcAttr{
		Env:   os.Environ(),
		Files: []uintptr{devNull.Fd(), logW.Fd(), logW.Fd(), barW.Fd(), cwdDir.Fd()},
		Sys:   &syscall.SysProcAttr{Setsid: true, UseCgroupFD: true, CgroupFD: c.fd()},
	})
	_ = logW.Close()
	_ = barW.Close()
	if err != nil {
		r.cancel()
		_ = logR.Close()
		return fail(fmt.Errorf("guest-agent: process_start: starting the process: %w", err))
	}
	_ = c.dir.Close()
	launched = true
	// Until every writer in the cgroup is gone, children that outlive the process
	// included. ring.Write never fails.
	go func() {
		_, _ = io.Copy(log, logR)
		_ = logR.Close()
	}()
	r.track(pid, a.onTrackedExit(id, uid))
	// Answer only once the command has replaced the shim. The agent ignores TERM, INT
	// and HUP (cmd/guest-agent), so the shim inherits them ignored until its exec: a
	// process_stop that landed earlier would lose its signal and wait out the grace.
	// Bounded: a shim that hangs before its exec is still a started process.
	_ = barR.SetReadDeadline(time.Now().Add(leaseTeardownBound))
	_, _ = io.Copy(io.Discard, barR)
	return pid, uid, nil
}

// onTrackedExit is the reaper's callback for tracked process id, run once it is reaped.
// It runs on whichever goroutine reaps, perhaps a runLease that holds the lease mutex,
// so it must not take that mutex (reaper.track). It takes the table's, the allocator's
// and exitSignals' locks one at a time, never nested.
func (a *Agent) onTrackedExit(id string, uid int) func(syscall.WaitStatus) {
	return func(ws syscall.WaitStatus) {
		code, sig := ws.ExitStatus(), 0
		if ws.Signaled() {
			code, sig = 0, int(ws.Signal())
		}
		final, marked, evicted := a.lease.procs.markExit(id, code, sig)
		// The uid stays unusable while its cgroup holds children (trackedCgroups).
		a.lease.uids.release(uid)
		a.lease.exits.fire(id, final, marked)
		// An evicted entry is no longer visible, so nothing of it may run on: kill what
		// its cgroup holds. The next prune removes the emptied directory.
		for _, e := range evicted {
			_ = killCgroup(a.trackedCgroup(e.ID))
		}
	}
}

// ensureTrackedHomeParent makes trackedHomeParent, root-owned and 0711 (ruling P5-R12):
// other uids may pass through it to their own HOME, but not list it or create in it.
// One that exists must already be a root-owned directory, not a symlink. leasePrepare
// calls it, and so does each process_start, which fails closed if it has changed.
func ensureTrackedHomeParent() error {
	dir := trackedHomeParent
	fail := func(err error) error {
		return fmt.Errorf("guest-agent: lease: tracked homes %s: %w", dir, err)
	}
	if err := unix.Mkdir(dir, 0o711); err != nil && !errors.Is(err, unix.EEXIST) {
		return fail(err)
	}
	fd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fail(err)
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return fail(err)
	}
	if st.Uid != 0 {
		return fail(fmt.Errorf("owned by uid %d, want root", st.Uid))
	}
	if err := unix.Fchmod(fd, 0o711); err != nil {
		return fail(err)
	}
	return nil
}

// prepareTrackedHome makes uid's HOME afresh: trackedHomeParent/<uid>, 0700, owned by
// uid and gid. Whatever an earlier process of the uid left there is removed first. It
// is made by root and then changed through a descriptor opened without following
// symlinks, so the chown cannot be steered to another path.
func prepareTrackedHome(uid, gid int) (string, error) {
	home := filepath.Join(trackedHomeParent, strconv.Itoa(uid))
	fail := func(err error) (string, error) {
		return "", fmt.Errorf("guest-agent: process_start: home %s: %w", home, err)
	}
	if err := ensureTrackedHomeParent(); err != nil {
		return "", err
	}
	if err := os.RemoveAll(home); err != nil {
		return fail(err)
	}
	if err := unix.Mkdir(home, 0o700); err != nil {
		return fail(err)
	}
	fd, err := unix.Open(home, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fail(err)
	}
	defer unix.Close(fd)
	if err := unix.Fchown(fd, uid, gid); err != nil {
		return fail(err)
	}
	if err := unix.Fchmod(fd, 0o700); err != nil {
		return fail(err)
	}
	return home, nil
}

// processList answers the table, oldest first, as a JSON array on stdout.
func (a *Agent) processList(w *frameWriter) (End, error) {
	a.pruneTracked()
	out, err := json.Marshal(a.trackedView())
	if err != nil {
		return End{}, err
	}
	emitChunked(w.stdout, out)
	return End{}, nil
}

// processLogs answers the last lines of the process's ring (default 200) as raw bytes,
// through the capped stdout frames.
func (a *Agent) processLogs(req Request, w *frameWriter) (End, error) {
	var args ProcessArgs
	if req.Process != nil {
		args = *req.Process
	}
	e, err := a.findTracked(args)
	if err != nil {
		return End{}, err
	}
	tail := args.Tail
	if tail <= 0 {
		tail = 200
	}
	// The newest lines win: a tail longer than the stream's cap keeps its end, not its
	// start, and the cut is counted as dropped.
	out, dropped := newestWithin(e.Log.Tail(tail), w.cap)
	w.dropStdout(dropped)
	emitChunked(w.stdout, out)
	return End{}, nil
}

// processStop stops a process: its signal (TERM by default) to everything in its cgroup,
// trackedStopGrace for the cgroup to empty, then cgroup.kill and the teardown bound. An
// exited entry's cgroup is stopped the same way, for what the process left. It answers
// the final state as JSON on stdout; a cgroup that will not empty answers
// End{TeardownFailed}, and the agent is dead, as for an Exec.
func (a *Agent) processStop(req Request, w *frameWriter) (End, error) {
	var args ProcessArgs
	if req.Process != nil {
		args = *req.Process
	}
	e, err := a.findTracked(args)
	if err != nil {
		return End{}, err
	}
	sig, err := parseStopSignal(args.Signal)
	if err != nil {
		return End{}, err
	}
	if err := a.stopCgroups([]string{a.trackedCgroup(e.ID)}, sig); err != nil {
		return a.teardownFailed(End{}, err), nil
	}
	final := a.awaitFinal(e.TrackedProcess)
	out, err := json.Marshal(final)
	if err != nil {
		return End{}, err
	}
	w.stdout(out)
	return End{}, nil
}

// processStopAll stops every tracked cgroup at once, the running processes' and
// whatever exited ones left, as processStop does with TERM. The worker sends it when a
// sandbox leaves level 2 (Task 6). It answers the final states of the processes that
// were running, oldest first, as a JSON array.
func (a *Agent) processStopAll(w *frameWriter) (End, error) {
	var running []TrackedProcess
	for _, p := range a.lease.procs.list() {
		if p.State == TrackedRunning {
			running = append(running, p)
		}
	}
	if err := a.stopCgroups(a.lease.cgroups.paths(), syscall.SIGTERM); err != nil {
		return a.teardownFailed(End{}, err), nil
	}
	stopped := make([]TrackedProcess, 0, len(running))
	for _, p := range running {
		stopped = append(stopped, a.awaitFinal(p))
	}
	out, err := json.Marshal(stopped)
	if err != nil {
		return End{}, err
	}
	emitChunked(w.stdout, out)
	return End{}, nil
}

// awaitFinal waits, bounded, for the reaper to record p's exit once its cgroup is
// empty, and returns its row as shown, with its final state: the table's, or the one the
// reaper recorded when the table has evicted the entry since (finalRow).
func (a *Agent) awaitFinal(p TrackedProcess) TrackedProcess {
	p = finalRow(&a.lease.procs, &a.lease.exits, p, trackedExitWait)
	p.Name = displayName(p)
	p.MemoryBytes = cgroupMemoryCurrent(a.trackedCgroup(p.ID))
	return p
}

var displayIDRE = regexp.MustCompile(`^p[0-9]+$`)

// findTracked finds the entry args names: by id if given, else by name, where an id
// wins over an equal name and an unnamed process is also found by its display name,
// p<id>. Neither found is process_not_found.
func (a *Agent) findTracked(args ProcessArgs) (trackedEntry, error) {
	key := args.ID
	if key == "" {
		key = args.Name
	}
	if e, ok := a.lease.procs.lookup(key); ok {
		return e, nil
	}
	if displayIDRE.MatchString(key) {
		if e, ok := a.lease.procs.lookup(key[1:]); ok && e.ID == key[1:] && e.Name == "" {
			return e, nil
		}
	}
	if key == "" {
		return trackedEntry{}, errors.New("process_not_found: no id or name given")
	}
	return trackedEntry{}, fmt.Errorf("process_not_found: %s", clip(key))
}

// parseStopSignal is process_stop's signal: TERM when empty, else a name with or
// without SIG (any case), or a number.
func parseStopSignal(s string) (syscall.Signal, error) {
	if s == "" {
		return syscall.SIGTERM, nil
	}
	if n, err := strconv.Atoi(s); err == nil {
		if n >= 1 && n <= 64 {
			return syscall.Signal(n), nil
		}
	} else {
		name := strings.ToUpper(s)
		if !strings.HasPrefix(name, "SIG") {
			name = "SIG" + name
		}
		if sig := unix.SignalNum(name); sig != 0 {
			return sig, nil
		}
	}
	return 0, fmt.Errorf("process_signal: unknown signal %s", clip(s))
}

// stopCgroups stops every populated cgroup of paths at once: sig to each process in
// them, up to trackedStopGrace for them to empty, then cgroup.kill and waitCgroupEmpty's
// teardown bound. An error is a cgroup that would not
// empty. A cgroup that is gone or already empty is left alone.
func (a *Agent) stopCgroups(paths []string, sig syscall.Signal) error {
	var live []string
	for _, p := range paths {
		// An unreadable cgroup is stopped too: the safe side.
		if pop, err := cgroupPopulated(p); pop || err != nil {
			live = append(live, p)
		}
	}
	for _, p := range live {
		signalCgroup(p, sig)
	}
	deadline := time.Now().Add(trackedStopGrace)
	for _, p := range live {
		for time.Now().Before(deadline) {
			if pop, err := cgroupPopulated(p); err == nil && !pop {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	// Every one of them, emptied or not: as at an Exec's end, cgroup.kill then the wait
	// are what guarantee nothing is left, a child forked after the signal included.
	for _, p := range live {
		if err := killCgroup(p); err != nil {
			return fmt.Errorf("cgroup %s: cgroup.kill: %w", p, err)
		}
		if err := waitCgroupEmpty(&execCgroup{path: p}, leaseTeardownBound); err != nil {
			return err
		}
	}
	return nil
}

// signalCgroup sends sig to every process in the cgroup at path, as a service manager
// stops a unit: children and double-forked daemons included, not only the process
// group. It re-reads cgroup.procs a few times for children forked meanwhile; the kill
// after the grace covers any it misses.
//
// A pid read from cgroup.procs can exit, be reaped and be reused by another process
// before the kill(2): the same race systemd accepts. A pidfd would close it only for
// the main process, not for the cgroup's other members, so it is not used. Reuse needs
// the guest's pid space (pid_max, 4194304 on 64-bit) to wrap inside that window, and
// the signal is the polite one: the cgroup.kill that follows is race-free.
func signalCgroup(path string, sig syscall.Signal) {
	seen := map[int]bool{}
	for range 10 {
		raw, err := os.ReadFile(filepath.Join(path, "cgroup.procs"))
		if err != nil {
			return
		}
		fresh := false
		for _, f := range strings.Fields(string(raw)) {
			pid, err := strconv.Atoi(f)
			if err != nil || pid <= 0 || seen[pid] {
				continue
			}
			seen[pid], fresh = true, true
			_ = unix.Kill(pid, sig)
		}
		if !fresh {
			return
		}
	}
}

// killCgroup SIGKILLs everything in the cgroup at path (cgroup.kill); a cgroup that is
// gone is not an error.
func killCgroup(path string) error {
	err := os.WriteFile(filepath.Join(path, "cgroup.kill"), []byte("1"), 0)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// cgroupMemoryCurrent is the cgroup's memory.current, or 0 when it cannot be read (an
// exited process's cgroup is removed once empty).
func cgroupMemoryCurrent(path string) int64 {
	raw, err := os.ReadFile(filepath.Join(path, "memory.current"))
	if err != nil {
		return 0
	}
	n, err := parseCgroupBytes(raw)
	if err != nil {
		return 0
	}
	return n
}

// trackedView is the table as the host is shown it, on every lease End and in
// process_list: each row with its display name and its cgroup's memory.current.
func (a *Agent) trackedView() []TrackedProcess {
	ps := a.lease.procs.list()
	for i := range ps {
		ps[i].Name = displayName(ps[i])
		ps[i].MemoryBytes = cgroupMemoryCurrent(a.trackedCgroup(ps[i].ID))
	}
	return ps
}

// pruneTracked tidies the tracked cgroups against the table. A cgroup whose entry the
// table has dropped is killed if it still holds anything (nothing invisible may run),
// and removed once empty; so is the empty cgroup of an exited entry. A running entry's
// cgroup is never touched. The uid -> cgroup records stay (ruling P5-R9): a removed
// cgroup reads as empty.
func (a *Agent) pruneTracked() {
	state := map[string]string{}
	for _, p := range a.lease.procs.list() {
		state[p.ID] = p.State
	}
	for _, path := range a.lease.cgroups.paths() {
		id := strings.TrimPrefix(filepath.Base(path), "p")
		st, inTable := state[id]
		if st == TrackedRunning {
			continue
		}
		pop, err := cgroupPopulated(path)
		if err != nil {
			continue
		}
		if pop {
			if !inTable {
				_ = killCgroup(path)
			}
			continue
		}
		_ = os.Remove(path)
	}
	keep := map[string]bool{}
	for id := range state {
		keep[id] = true
	}
	a.lease.exits.retain(keep)
}
