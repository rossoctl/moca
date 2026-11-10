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

// leaseTeardownBound is how long the cgroup has to empty after cgroup.kill. Past it,
// End carries teardown_failed and the agent is dead (spec §3.1).
const leaseTeardownBound = 5 * time.Second

// leaseRuntime is the Agent's lease-mode state. mu is held for the whole of runLease,
// so two lease Execs never interleave: the host serialises Execs per VM anyway, and
// the per-Exec cgroup and the reaper's registration window both assume one at a time.
// r is an atomic rather than under mu so that Close can stop the reaper while an Exec
// is still running, instead of blocking until it ends.
type leaseRuntime struct {
	mu   sync.Mutex
	once sync.Once
	r    atomic.Pointer[reaper]
	seq  uint64
}

// leasePrepare readies the guest for lease mode. NewAgent calls it when CgroupRoot is
// set, which happens before the snapshot: none of this is per-Exec or secret.
func (a *Agent) leasePrepare() error {
	lo := a.opts.Lease
	if lo.UID <= 0 || lo.GID <= 0 || lo.Home == "" {
		return fmt.Errorf("guest-agent: lease: uid %d, gid %d, home %q: want a non-root uid and gid and a home", lo.UID, lo.GID, lo.Home)
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

// runLease runs one lease Exec. Unlike the per-Exec paths, nothing survives it: the
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

	argv := []string{shim, ShimArg, strconv.Itoa(lo.UID), strconv.Itoa(lo.GID), lo.Home, "--", a.opts.Shell, "-c", req.Command}
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
		msg := "guest-agent: lease teardown failed: " + terr.Error() + "; this agent is dead"
		a.deadMsg.Store(&msg)
		a.dead.Store(true)
		// Always an End, never a KindError, so the host can tell teardown_failed apart
		// from any other guest error (spec §3.1). A timed-out or aborted command has no
		// exit code of its own: -1.
		if timedOut || aborted {
			end.ExitCode = -1
		}
		end.TeardownFailed = true
		return end, nil
	}
	// Every writer is dead, so both drains reach EOF.
	wg.Wait()
	_ = stdoutR.Close()
	_ = stderrR.Close()
	// The cgroup is empty, so rmdir succeeds; if it somehow does not, the leftover is
	// an empty, unused directory and the next Exec gets a fresh e<seq> regardless.
	_ = c.remove()
	if aborted {
		// The host is gone; ServeConn's write of this fails harmlessly.
		return End{}, errors.New("guest-agent: the connection closed; the Exec was aborted")
	}
	if timedOut {
		// Not dead, unlike the parked shell's timeout: there is no long-lived shell
		// whose state the timeout could corrupt, and the cgroup is gone.
		return End{}, fmt.Errorf("timeout:%d", req.TimeoutS)
	}
	return end, nil
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

// execCgroup is one Exec's cgroup, CgroupRoot/e<seq>. The tree is never delegated: it
// is root-owned, so the exec uid can neither move itself out nor create cgroups.
type execCgroup struct {
	path string
	dir  *os.File // O_PATH|O_DIRECTORY, for CLONE_INTO_CGROUP
}

func newExecCgroup(root string, seq uint64) (*execCgroup, error) {
	path := filepath.Join(root, "e"+strconv.FormatUint(seq, 10))
	if err := os.Mkdir(path, 0o755); err != nil {
		return nil, fmt.Errorf("guest-agent: lease: cgroup: %w", err)
	}
	fd, err := unix.Open(path, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		_ = os.Remove(path)
		return nil, fmt.Errorf("guest-agent: lease: cgroup: %w", err)
	}
	return &execCgroup{path: path, dir: os.NewFile(uintptr(fd), path)}, nil
}

func (c *execCgroup) fd() int { return int(c.dir.Fd()) }

// kill SIGKILLs every process in the cgroup, including ones that setsid'd, double
// forked or reparented: cgroup membership, unlike the process tree, cannot be escaped.
func (c *execCgroup) kill() error {
	return os.WriteFile(filepath.Join(c.path, "cgroup.kill"), []byte("1"), 0)
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
type reaper struct {
	mu      sync.Mutex
	waiting map[int]chan syscall.WaitStatus
	early   map[int]syscall.WaitStatus
	order   []int // early's pids, oldest first, for the cap
	pending bool  // between expect and await/cancel

	sig      chan os.Signal
	quit     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
}

const reaperEarlyCap = 1024

func startReaper() *reaper {
	r := &reaper{
		waiting: map[int]chan syscall.WaitStatus{},
		early:   map[int]syscall.WaitStatus{},
		sig:     make(chan os.Signal, 1),
		quit:    make(chan struct{}),
		done:    make(chan struct{}),
	}
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

// cancel closes the registration window and forgets every pid still registered, once
// the caller no longer wants its status (a failed fork, or after teardown).
func (r *reaper) cancel() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pending = false
	r.early, r.order = map[int]syscall.WaitStatus{}, nil
	clear(r.waiting)
}
