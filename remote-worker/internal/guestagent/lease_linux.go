//go:build linux

package guestagent

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// leaseExecUser is the exec identity's passwd name, the USER and LOGNAME of every lease
// Exec. A tracked process runs as sbxp<n> instead (uidAllocator.user).
const leaseExecUser = "sbx"

// leaseTeardownBound is how long the cgroup has to empty after cgroup.kill. Past it,
// End carries teardown_failed and the agent is dead (spec §3.1).
const leaseTeardownBound = 5 * time.Second

// leaseRuntime is the Agent's lease-mode state. mu is held for the whole of runLease,
// so two lease Execs never interleave: the host serialises Execs per VM anyway, and
// the per-Exec cgroup and the reaper's registration window both assume one at a time.
// r is an atomic rather than under mu so that Close can stop the reaper while an Exec
// is still running, instead of blocking until it ends.
//
// procs, uids, cgroups and exits are level 2's: the tracked processes, which outlive
// the Exec that started them, the uids they run as, the cgroup of every uid ever handed
// out, and their exit notifications (tracked.go, tracked_linux.go).
type leaseRuntime struct {
	mu      sync.Mutex
	once    sync.Once
	r       atomic.Pointer[reaper]
	seq     uint64
	procs   trackedTable
	uids    *uidAllocator
	cgroups trackedCgroups
	exits   exitSignals
}

// leasePrepare readies the guest for lease mode. NewAgent calls it when CgroupRoot is
// set, which happens before the snapshot: none of this is per-Exec or secret.
func (a *Agent) leasePrepare() error {
	lo := a.opts.Lease
	if lo.UID <= 0 || lo.GID <= 0 || lo.Home == "" {
		return fmt.Errorf("guest-agent: lease: uid %d, gid %d, home %q: want a non-root uid and gid and a home", lo.UID, lo.GID, lo.Home)
	}
	// A tracked process under the exec uid could be traced by any later Exec (spec §3.3).
	// NewAgent has already turned a zero base or count into the default, so 0 never
	// reaches here: the range cannot be turned off.
	if lo.TrackedUIDBase <= 0 || lo.MaxTrackedUIDs < 0 ||
		(lo.UID >= lo.TrackedUIDBase && lo.UID < lo.TrackedUIDBase+lo.MaxTrackedUIDs) {
		return fmt.Errorf("guest-agent: lease: tracked uids %d from %d: want a non-root range without the exec uid %d", lo.MaxTrackedUIDs, lo.TrackedUIDBase, lo.UID)
	}
	a.lease.uids = newUIDAllocator(lo.TrackedUIDBase, lo.MaxTrackedUIDs)
	if err := ensureTrackedHomeParent(); err != nil {
		return err
	}
	if err := os.Mkdir(lo.CgroupRoot, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("guest-agent: lease: cgroup root: %w", err)
	}
	if err := os.MkdirAll(lo.Home, 0o700); err != nil {
		return fmt.Errorf("guest-agent: lease: home: %w", err)
	}
	if err := os.Chown(lo.Home, lo.UID, lo.GID); err != nil {
		return fmt.Errorf("guest-agent: lease: home: %w", err)
	}
	if err := os.Chmod(lo.Home, 0o700); err != nil {
		return fmt.Errorf("guest-agent: lease: home: %w", err)
	}
	// Not dumpable: /proc/<agent>/ becomes root-owned and unreadable to the exec uid,
	// so an Exec cannot read the agent's memory, environ or fds.
	if err := unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0); err != nil {
		return fmt.Errorf("guest-agent: lease: dumpable: %w", err)
	}
	return nil
}

// userNamespacesSysctl is the knob leaseHarden turns off. A package variable so the
// lease tests can point it at a scratch file: the real one is the test host's, and only
// TestLeaseFirstRequestDisablesUserNamespaces touches it (and restores it).
var userNamespacesSysctl = "/proc/sys/user/max_user_namespaces"

// leaseHarden runs the one-time root steps of the first lease request (spec §3.3, "no
// route back to root"). Not in leasePrepare: that runs before the snapshot, when the
// workspace is not yet mounted (Resume mounts it), and per-Exec VMs restored from the
// same snapshot keep user namespaces. Both steps are idempotent, so a retry after a
// partial failure is safe.
//   - The workspace is remounted nodev,nosuid: the Exec uid owns it, and a device node
//     or setuid file that root left there (or that a per-Exec run made) must not work.
//   - User namespaces are disabled for the rest of the VM's life: one gives an
//     unprivileged process a full capability set inside it.
func (a *Agent) leaseHarden() error {
	if err := remountNoDevNoSuid(a.opts.WorkDir); err != nil {
		return fmt.Errorf("guest-agent: lease: remount workspace nodev,nosuid: %s: %w", a.opts.WorkDir, err)
	}
	if err := os.WriteFile(userNamespacesSysctl, []byte("0"), 0); err != nil {
		return fmt.Errorf("guest-agent: lease: disable user namespaces: %w", err)
	}
	return nil
}

// enableExecControllers enables the pids and memory controllers for the cgroup root's
// children, the e<seq> cgroups, so each can be capped (lease_caps.go). The root's parent
// must enable them first; in the guest that parent is the cgroup2 root, which the
// no-internal-processes rule exempts, and the cgroup root holds no process of its own.
// It then caps the root itself with an Exec's memory.max and pids.max (lease_caps.go):
// tmpfs pages an Exec leaves behind are charged to the root once its cgroup is gone, and
// the root's limit is what keeps the next Exec's OOM inside its own cgroup. MemTotal is
// read once here; a balloon that changes it later moves each e<seq>'s cap, not the
// root's. One of the first lease request's one-time steps, not leasePrepare's: a
// per-Exec VM restored from the same snapshot keeps its cgroup tree as it was.
// Idempotent.
func enableExecControllers(root string) error {
	for _, dir := range []string{filepath.Dir(root), root} {
		if err := os.WriteFile(filepath.Join(dir, "cgroup.subtree_control"), []byte("+pids +memory"), 0); err != nil {
			return fmt.Errorf("guest-agent: lease: enable pids and memory in %s: %w", dir, err)
		}
	}
	memMax, err := execMemoryMax()
	if err != nil {
		return err
	}
	for _, w := range execCgroupCapFiles(memMax) {
		if err := os.WriteFile(filepath.Join(root, w.file), []byte(w.val), 0); err != nil {
			return fmt.Errorf("guest-agent: lease: cgroup caps on %s: %w", root, err)
		}
	}
	return nil
}

// agentOomScoreAdjPath and memInfoPath are package variables so the lease tests can
// point them at scratch files, as userNamespacesSysctl is: the real ones are the test
// host's.
var (
	agentOomScoreAdjPath = "/proc/self/oom_score_adj"
	memInfoPath          = "/proc/meminfo"
)

// protectAgentFromOOM sets the agent's oom_score_adj to -1000. It is defence in depth,
// not what keeps the agent alive: in a lease guest the agent is PID 1, and the kernel
// never OOM-kills global init (is_global_init) whatever its score. The value's real
// effect is through inheritance: every process the agent forks starts at -1000, and so
// would never be picked either. That is why the shim puts each Exec's back to 0
// (ShimMain) while it still holds CAP_SYS_RESOURCE; without that reset an OOM would
// find nothing it may kill. Do not drop the shim's reset on the strength of this
// value: the reset is load-bearing, this is not. Best effort: a failure is logged and
// the lease goes on, since memory.max still confines an Exec's own OOM to its cgroup.
func protectAgentFromOOM() {
	if err := os.WriteFile(agentOomScoreAdjPath, []byte("-1000"), 0); err != nil {
		log.Printf("guest-agent: lease: oom_score_adj -1000: %v; the agent stays an OOM candidate", err)
	}
}

// mountFlagsKept maps the statfs flags of a mount to the mount(2) flags that keep them
// across a bind remount, which otherwise resets every per-mount flag it is not given
// (rw,noatime from Resume's mount would become rw,relatime). Only RELATIME's value
// differs between the two sets.
var mountFlagsKept = []struct{ st, ms uintptr }{
	{unix.ST_RDONLY, unix.MS_RDONLY},
	{unix.ST_NOEXEC, unix.MS_NOEXEC},
	{unix.ST_SYNCHRONOUS, unix.MS_SYNCHRONOUS},
	{unix.ST_MANDLOCK, unix.MS_MANDLOCK},
	{unix.ST_NOATIME, unix.MS_NOATIME},
	{unix.ST_NODIRATIME, unix.MS_NODIRATIME},
	{unix.ST_RELATIME, unix.MS_RELATIME},
}

// remountNoDevNoSuid adds nodev and nosuid to the mount at dir, keeping its other
// per-mount flags. dir must be a mount point (EINVAL otherwise).
func remountNoDevNoSuid(dir string) error {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return err
	}
	flags := uintptr(unix.MS_REMOUNT | unix.MS_BIND | unix.MS_NODEV | unix.MS_NOSUID)
	for _, f := range mountFlagsKept {
		if uintptr(st.Flags)&f.st != 0 {
			flags |= f.ms
		}
	}
	return unix.Mount("", dir, "", flags, "")
}

// stopLease stops the reaper, if a lease request ever started it. It does not take
// lease.mu, which a running Exec holds: Close must not wait for that Exec to end.
func (a *Agent) stopLease() {
	if r := a.lease.r.Load(); r != nil {
		r.stop()
	}
}

// runLease serves one lease request: under the lease mutex, it takes the lease's
// one-time steps and the workspace normalisation if asked, then runs the request's kind:
// a command (runLeaseCommand) or a tracked-process kind (tracked_linux.go). Every End it
// returns carries the tracked-process table, so the host's mirror of it is never stale.
func (a *Agent) runLease(req Request, stdin []byte, w *frameWriter, conn io.Reader) (End, error) {
	lo := a.opts.Lease
	if lo.CgroupRoot == "" {
		return End{}, errors.New("guest-agent: lease mode is not available in this guest")
	}
	shim := lo.ShimPath
	if shim == "" {
		shim = "/proc/self/exe"
	}

	l := &a.lease
	l.mu.Lock()
	defer l.mu.Unlock()
	// Under mu, so no lease Exec runs during these steps; before the latch, so a failure
	// leaves the agent as it was and the next lease request retries them. leaseOn is
	// only ever set under mu, so reading it here is exact.
	if !a.leaseOn.Load() {
		if err := a.leaseHarden(); err != nil {
			return End{}, err
		}
		// Refuse lease service rather than run an Exec uncapped (#706).
		if err := enableExecControllers(lo.CgroupRoot); err != nil {
			return End{}, err
		}
		protectAgentFromOOM()
	}
	// The host sets the flag when root has written to the workspace since the last
	// lease Exec (spec §3.3).
	if req.NormaliseWorkspace {
		n, err := normaliseWorkspace(a.opts.WorkDir, lo.UID, lo.GID)
		if err != nil {
			return End{}, err
		}
		if n > 0 {
			log.Printf("guest-agent: lease: normalise workspace removed %d device node(s) from %s", n, a.opts.WorkDir)
		}
	}
	a.leaseOn.Store(true)
	l.once.Do(func() { l.r.Store(startReaper()) })
	r := l.r.Load()

	var end End
	var err error
	switch req.Kind {
	case "", RequestKindCommand:
		end, err = a.runLeaseCommand(req, stdin, w, conn, r, shim)
	case RequestKindProcessStart:
		end, err = a.processStart(req, w, r, shim)
	case RequestKindProcessList:
		end, err = a.processList(w)
	case RequestKindProcessLogs:
		end, err = a.processLogs(req, w)
	case RequestKindProcessStop:
		end, err = a.processStop(req, w)
	case RequestKindProcessStopAll:
		end, err = a.processStopAll(w)
	default:
		// ServeConn refuses an unknown kind first; this is the same rule, kept here so
		// no path can run one as a command (ruling P5-R6).
		return End{}, fmt.Errorf("lease_unsupported: unknown kind %s", clip(req.Kind))
	}
	if err != nil {
		return End{}, err
	}
	a.pruneTracked()
	end.Tracked = a.trackedView()
	return end, nil
}

// runLeaseCommand runs one lease Exec. Unlike the per-Exec paths, nothing survives it: the
// command runs as the exec user in a cgroup of its own, and that cgroup is killed and
// emptied BEFORE End goes out, so a background job cannot outlive its Exec into the
// next one, and End does not wait on a background job that holds stdout open.
//
// Each Exec is a fresh `bash -c` through the shim, never the parked shell: one VM now
// serves many Execs, so a shell's variables, cwd, aliases and functions would leak
// from one to the next.
//
// conn is the request's connection, already drained of stdin. The host sends nothing
// more on it, so a read that returns at all means the host closed it: that is how the
// host aborts an Exec (vmpool's closeConn on ctx.Done), and the Exec is torn down as
// on a timeout (spec §3.1: killed when it "exits, times out or is aborted").
//
// The kill is of this Exec's e<seq> only: a tracked process lives in tracked/p<id>,
// which no Exec's teardown touches (spec §3.1). runLease holds the lease mutex.
func (a *Agent) runLeaseCommand(req Request, stdin []byte, w *frameWriter, conn io.Reader, r *reaper, shim string) (End, error) {
	lo := a.opts.Lease
	l := &a.lease
	l.seq++

	c, err := newExecCgroup(lo.CgroupRoot, l.seq)
	if err != nil {
		return End{}, err
	}
	var pipes [6]*os.File // stdinR, stdinW, stdoutR, stdoutW, stderrR, stderrW
	closeAll := func() {
		for _, f := range pipes {
			if f != nil {
				_ = f.Close()
			}
		}
	}
	for i := 0; i < 6; i += 2 {
		if pipes[i], pipes[i+1], err = os.Pipe(); err != nil {
			closeAll()
			_ = c.remove()
			return End{}, err
		}
	}
	stdinR, stdinW, stdoutR, stdoutW, stderrR, stderrW := pipes[0], pipes[1], pipes[2], pipes[3], pipes[4], pipes[5]

	// The cwd is the workspace's mount point, ForkExec's Dir: a path no Exec can rewrite.
	argv := []string{shim, ShimArg, strconv.Itoa(lo.UID), strconv.Itoa(lo.GID), lo.Home, leaseExecUser, ShimCwdInherited, "--", a.opts.Shell, "-c", req.Command}
	// Inherits the agent's environment on purpose; see forkShell for why R6's filter is
	// absent here. CgroupFD places the child in its cgroup at clone time
	// (CLONE_INTO_CGROUP), so there is no window in which it runs outside it.
	r.expect()
	pid, err := syscall.ForkExec(shim, argv, &syscall.ProcAttr{
		Dir:   a.opts.WorkDir,
		Env:   os.Environ(),
		Files: []uintptr{stdinR.Fd(), stdoutW.Fd(), stderrW.Fd()},
		Sys:   &syscall.SysProcAttr{Setsid: true, UseCgroupFD: true, CgroupFD: c.fd()},
	})
	if err != nil {
		r.cancel()
		closeAll()
		_ = c.remove()
		return End{}, fmt.Errorf("guest-agent: lease: starting the command: %w", err)
	}
	exited := r.await(pid)
	// The child holds its own copies now; the agent keeping these would stop the drains
	// from ever seeing EOF.
	_ = stdinR.Close()
	_ = stdoutW.Close()
	_ = stderrW.Close()

	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		_, _ = stdinW.Write(stdin)
		_ = stdinW.Close() // the EOF `base64 -d > file` waits for
	}()
	go func() { defer wg.Done(); drainPipe(stdoutR, w.stdout) }()
	go func() { defer wg.Done(); drainPipe(stderrR, w.stderr) }()

	var timeout <-chan time.Time
	if req.TimeoutS > 0 {
		tm := time.NewTimer(time.Duration(req.TimeoutS) * time.Second)
		defer tm.Stop()
		timeout = tm.C
	}
	gone := make(chan struct{})
	go func() {
		// Returns, at the latest, when ServeConn closes the connection after this Exec.
		var b [1]byte
		_, _ = conn.Read(b[:])
		close(gone)
	}()

	var end End
	timedOut, aborted := false, false
	select {
	case ws := <-exited:
		end.ExitCode = exitCode(ws)
	case <-timeout:
		timedOut = true
	case <-gone:
		aborted = true
	}

	// Kill whatever the command left behind, then wait for the cgroup to empty. This
	// comes before End by design: the host may send the next Exec the moment End
	// arrives.
	terr := c.kill()
	if terr == nil {
		terr = waitCgroupEmpty(c, leaseTeardownBound)
	}
	r.sweep()
	r.cancel()
	if terr != nil {
		// Something in the cgroup may still hold the pipes' write ends, so force the
		// drains and the stdin feeder off them rather than join a read that never ends.
		// The cgroup directory is left in place: rmdir of a populated cgroup fails anyway.
		_ = stdoutR.Close()
		_ = stderrR.Close()
		_ = stdinW.Close()
		wg.Wait()
		_ = c.dir.Close()
		// A timed-out or aborted command has no exit code of its own: -1.
		if timedOut || aborted {
			end.ExitCode = -1
		}
		return a.teardownFailed(end, terr), nil
	}
	// Every writer is dead, so both drains reach EOF.
	wg.Wait()
	_ = stdoutR.Close()
	_ = stderrR.Close()
	// Read before the cgroup goes: its memory.events goes with it.
	oomKills := c.oomKills()
	// The cgroup is empty, so rmdir succeeds; if it somehow does not, the leftover is
	// an empty, unused directory and the next Exec gets a fresh e<seq> regardless.
	_ = c.remove()
	if aborted {
		// The host is gone; ServeConn's write of this fails harmlessly.
		return End{}, errors.New("guest-agent: the connection closed; the Exec was aborted")
	}
	if oomKills > 0 {
		// After the removal, so the root's memory.current is what the lease holds without
		// this Exec: its tmpfs files reparented to the root, its own pages freed.
		if hint := leaseMemoryHintFor(lo.CgroupRoot, oomKills); hint != "" {
			w.notice(hint)
		}
	}
	if timedOut {
		// Not dead, unlike the parked shell's timeout: there is no long-lived shell
		// whose state the timeout could corrupt, and the cgroup is gone.
		return End{}, errors.New(TimeoutMessage(req.TimeoutS))
	}
	return end, nil
}

// teardownFailed marks the agent dead after a cgroup that would not empty, and returns
// end with TeardownFailed set. Always an End, never a KindError, so the host can tell
// teardown_failed apart from any other guest error (spec §3.1): the guest is no longer
// known to be clean.
func (a *Agent) teardownFailed(end End, err error) End {
	msg := "guest-agent: lease teardown failed: " + err.Error() + "; this agent is dead"
	a.deadMsg.Store(&msg)
	a.dead.Store(true)
	end.TeardownFailed = true
	return end
}

// waitCgroupEmpty polls cgroup.events until it reports `populated 0`, or fails after
// d. A package variable so a test can make teardown fail on demand, as setWallClock is.
var waitCgroupEmpty = func(c *execCgroup, d time.Duration) error {
	deadline := time.Now().Add(d)
	for {
		ev, err := os.ReadFile(filepath.Join(c.path, "cgroup.events"))
		if err != nil {
			return err
		}
		if bytes.Contains(ev, []byte("populated 0\n")) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("cgroup %s still populated %s after cgroup.kill", c.path, d)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// exitCode is the shell's convention, 128+signal for a signalled command, which is
// also what the parked shell's `$?` reports.
func exitCode(ws syscall.WaitStatus) int32 {
	switch {
	case ws.Exited():
		return int32(ws.ExitStatus())
	case ws.Signaled():
		return 128 + int32(ws.Signal())
	}
	return -1
}

func drainPipe(f *os.File, emit func([]byte)) {
	buf := make([]byte, MaxFrame)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			emit(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// execCgroup is one Exec's cgroup, CgroupRoot/e<seq>, or a tracked process's,
// CgroupRoot/tracked/p<id> (tracked_linux.go). The tree is never delegated: it
// is root-owned, so the exec uid can neither move itself out nor create cgroups. Its
// memory.max and pids.max (lease_caps.go) are written before anything runs in it; an
// Exec whose caps cannot be written is refused, never run uncapped.
type execCgroup struct {
	path string
	dir  *os.File // O_PATH|O_DIRECTORY, for CLONE_INTO_CGROUP
}

func newExecCgroup(root string, seq uint64) (*execCgroup, error) {
	return newCappedCgroup(filepath.Join(root, "e"+strconv.FormatUint(seq, 10)))
}

// newCappedCgroup creates the cgroup at path with an Exec's caps, written before
// anything runs in it, and opens it for CLONE_INTO_CGROUP. A tracked process's
// tracked/p<id> is made the same way.
func newCappedCgroup(path string) (*execCgroup, error) {
	memMax, err := execMemoryMax()
	if err != nil {
		return nil, err
	}
	if err := os.Mkdir(path, 0o755); err != nil {
		return nil, fmt.Errorf("guest-agent: lease: cgroup: %w", err)
	}
	for _, w := range execCgroupCapFiles(memMax) {
		if err := os.WriteFile(filepath.Join(path, w.file), []byte(w.val), 0); err != nil {
			_ = os.Remove(path)
			return nil, fmt.Errorf("guest-agent: lease: cgroup caps: %w", err)
		}
	}
	fd, err := unix.Open(path, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		_ = os.Remove(path)
		return nil, fmt.Errorf("guest-agent: lease: cgroup: %w", err)
	}
	return &execCgroup{path: path, dir: os.NewFile(uintptr(fd), path)}, nil
}

// execMemoryMax reads MemTotal on every Exec rather than once: a virtio balloon can
// change it during the VM's life.
func execMemoryMax() (int64, error) {
	raw, err := os.ReadFile(memInfoPath)
	if err != nil {
		return 0, fmt.Errorf("guest-agent: lease: cgroup caps: %w", err)
	}
	total, err := parseMemTotal(raw)
	if err != nil {
		return 0, fmt.Errorf("guest-agent: lease: cgroup caps: %w", err)
	}
	m := execCgroupMemoryMax(total)
	if m <= 0 {
		return 0, fmt.Errorf("guest-agent: lease: cgroup caps: MemTotal %d bytes leaves an Exec nothing", total)
	}
	return m, nil
}

func (c *execCgroup) fd() int { return int(c.dir.Fd()) }

// kill SIGKILLs every process in the cgroup, including ones that setsid'd, double
// forked or reparented: cgroup membership, unlike the process tree, cannot be escaped.
func (c *execCgroup) kill() error {
	return os.WriteFile(filepath.Join(c.path, "cgroup.kill"), []byte("1"), 0)
}

// oomKills is the cgroup's memory.events oom_kill count: how many of its processes the
// OOM killer took, whichever cgroup's limit was hit (the event is charged to the victim's
// cgroup). 0 when it cannot be read: the count only feeds a hint (leaseMemoryHintFor).
func (c *execCgroup) oomKills() int64 {
	raw, err := os.ReadFile(filepath.Join(c.path, "memory.events"))
	if err != nil {
		return 0
	}
	n, err := parseMemoryEventsOOMKill(raw)
	if err != nil {
		return 0
	}
	return n
}

// leaseMemoryHintFor is leaseMemoryHint (lease_caps.go) over the cgroup root's
// memory.current and memory.max, for an Exec whose cgroup counted oomKills and has been
// removed. "" when either file cannot be read, or the root is uncapped.
func leaseMemoryHintFor(root string, oomKills int64) string {
	if oomKills <= 0 {
		return ""
	}
	var v [2]int64
	for i, f := range []string{"memory.current", "memory.max"} {
		raw, err := os.ReadFile(filepath.Join(root, f))
		if err != nil {
			return ""
		}
		if v[i], err = parseCgroupBytes(raw); err != nil {
			return ""
		}
	}
	return leaseMemoryHint(oomKills, v[0], v[1])
}

func (c *execCgroup) remove() error {
	_ = c.dir.Close()
	return os.Remove(c.path)
}

// reaper reaps every child of the agent. In a lease guest the agent is PID 1, so every
// orphan an Exec leaves (a double fork, a setsid'd job) is reparented to it, and
// without a wait4(-1) each would stay a zombie for the VM's life.
//
// The lease Exec's own child is reaped here too, never by a pid-specific wait, which
// would race this wait4(-1) for the same status: runLease registers its pid and the
// status is handed over. A child can exit before it is registered, so a status reaped
// in that window (between expect and await) is held in early.
//
// A tracked process (level 2) outlives the Exec that started it, so its registration
// is in tracked, which neither expect nor cancel clears: runLease cancels after every
// Exec. Its own children reparent to the agent and are reaped here as orphans.
type reaper struct {
	mu      sync.Mutex
	waiting map[int]chan syscall.WaitStatus
	tracked map[int]func(syscall.WaitStatus)
	early   map[int]syscall.WaitStatus
	order   []int // early's pids, oldest first, for the cap
	pending bool  // between expect and await/cancel

	sig      chan os.Signal
	quit     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
}

const reaperEarlyCap = 1024

// newReaper is a reaper with nothing running: startReaper starts its loop, and the
// tests drive deliver by hand.
func newReaper() *reaper {
	return &reaper{
		waiting: map[int]chan syscall.WaitStatus{},
		tracked: map[int]func(syscall.WaitStatus){},
		early:   map[int]syscall.WaitStatus{},
		sig:     make(chan os.Signal, 1),
		quit:    make(chan struct{}),
		done:    make(chan struct{}),
	}
}

func startReaper() *reaper {
	r := newReaper()
	signal.Notify(r.sig, syscall.SIGCHLD)
	go func() {
		defer close(r.done)
		r.sweep() // whatever exited before Notify sent no signal we will see
		for {
			select {
			case <-r.sig:
				r.sweep()
			case <-r.quit:
				return
			}
		}
	}()
	return r
}

// stop is idempotent: Close may run more than once.
func (r *reaper) stop() {
	r.stopOnce.Do(func() {
		signal.Stop(r.sig)
		close(r.quit)
		<-r.done
	})
}

// sweep reaps every exited child. SIGCHLD coalesces, so one signal can stand for many
// exits: loop until wait4 reports none left.
func (r *reaper) sweep() {
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, syscall.WNOHANG, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil || pid <= 0 {
			return
		}
		r.deliver(pid, ws)
	}
}

func (r *reaper) deliver(pid int, ws syscall.WaitStatus) {
	r.mu.Lock()
	if onExit, ok := r.tracked[pid]; ok {
		delete(r.tracked, pid)
		r.mu.Unlock()
		onExit(ws)
		return
	}
	defer r.mu.Unlock()
	if ch, ok := r.waiting[pid]; ok {
		delete(r.waiting, pid)
		ch <- ws // buffered 1
		return
	}
	if !r.pending {
		return // an orphan: reaping it was the point
	}
	if len(r.order) >= reaperEarlyCap {
		delete(r.early, r.order[0])
		r.order = r.order[1:]
	}
	r.early[pid] = ws
	r.order = append(r.order, pid)
}

// expect opens the registration window, immediately before a fork. early is cleared
// here: nothing reaped before the fork can be the child it is about to start.
func (r *reaper) expect() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pending = true
	r.early, r.order = map[int]syscall.WaitStatus{}, nil
}

// await returns the channel pid's status arrives on: at once if it was reaped before
// this call, otherwise when the reaper reaps it. It closes the registration window.
func (r *reaper) await(pid int) <-chan syscall.WaitStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	ch := make(chan syscall.WaitStatus, 1)
	if ws, ok := r.early[pid]; ok {
		ch <- ws
	} else {
		r.waiting[pid] = ch
	}
	r.pending = false
	r.early, r.order = map[int]syscall.WaitStatus{}, nil
	return ch
}

// track registers a tracked process: onExit gets its status once, whenever the reaper
// reaps it, and at once if it was reaped before this call. The caller must call expect
// before the fork, as for await: a child that exits outside an expect window, before
// track, is reaped as an orphan and its status dropped. Unlike await's, the
// registration survives expect and cancel. It closes the registration window, as await
// does. onExit runs without the reaper's lock, on whichever goroutine reaps: the
// reaper's own, this one, or a runLease that holds lease.mu while it sweeps. So it must
// not take lease.mu or block on anything that waits for the reaper.
func (r *reaper) track(pid int, onExit func(syscall.WaitStatus)) {
	r.mu.Lock()
	ws, early := r.early[pid]
	if !early {
		r.tracked[pid] = onExit
	}
	r.pending = false
	r.early, r.order = map[int]syscall.WaitStatus{}, nil
	r.mu.Unlock()
	if early {
		onExit(ws)
	}
}

// cancel closes the registration window and forgets every pid still registered by
// await, once the caller no longer wants its status (a failed fork, or after teardown).
// Tracked registrations stay.
func (r *reaper) cancel() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pending = false
	r.early, r.order = map[int]syscall.WaitStatus{}, nil
	clear(r.waiting)
}
