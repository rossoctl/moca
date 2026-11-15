package guestagent

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// AgentOptions configures the in-guest agent.
type AgentOptions struct {
	Shell      string // default "bash"
	WorkDir    string // the mounted workspace; every command's cwd
	ScratchDir string // guest tmpfs, for staged command files. Discarded with the VM
	Lease      LeaseOptions
}

// LeaseOptions configures lease mode, in which one VM serves many Execs and each
// Exec runs in its own cgroup as an unprivileged user (lease_linux.go). An empty
// CgroupRoot means lease mode is unavailable: a lease request is refused.
type LeaseOptions struct {
	CgroupRoot string // each Exec gets CgroupRoot/e<seq>
	UID, GID   int    // the exec identity the shim drops to
	Home       string // the exec identity's HOME
	ShimPath   string // the binary that acts as the lease shim; default /proc/self/exe
	// Tracked processes (level 2) each run under their own uid, from TrackedUIDBase up to
	// TrackedUIDBase+MaxTrackedUIDs-1 (spec §3.3). Zero means the default, so the range
	// cannot be turned off here: level 2 is gated on the host, not by an empty range.
	TrackedUIDBase int // default DefaultTrackedUIDBase
	MaxTrackedUIDs int // default DefaultMaxTrackedUIDs
}

// The tracked uid range's defaults (global constraints): uids 20000 to 20003, the
// image's sbxp0 to sbxp3.
const (
	DefaultTrackedUIDBase = 20000
	DefaultMaxTrackedUIDs = 4
)

// Agent serves one command per connection out of a bash that was forked BEFORE the
// snapshot was taken and has been blocked on a pipe ever since.
//
// This is persistent-exec.ts's framing discipline reimplemented inside the guest —
// the fast channel P6 §3.1a records the gRPC path as lacking. It is safe here in a
// way it is not in a shared container: the VM serves exactly one command in its life
// and is then destroyed, so the parked shell has no cross-command state to leak
// (spec §5.4).
type Agent struct {
	opts AgentOptions

	mu     sync.Mutex // one command at a time: one VM, one Exec
	shell  *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	stderr *bufio.Reader
	seq    uint64

	// There used to be a clockOK atomic.Bool latch here, set once the clock had been
	// corrected so later commands would not pay a needless settimeofday. Deleted: see
	// the comment on the clock-correction block in ServeConn for why any "already
	// done" flag on this struct is unsound. shouldSetClock's threshold alone gives the
	// same idempotence without being unsound across a restore.

	// dead is set once a parked-shell command times out and the shell is killed to
	// stop its orphaned drain goroutines (see runOnParkedShell). A dead Agent refuses
	// every subsequent command: a host-side timeout destroys the VM anyway, so this
	// is the Agent being honest about a fact rather than a limitation it imposes.
	dead atomic.Bool
	// deadMsg, when set, replaces the parked-shell timeout text in the dead-agent
	// refusal: a lease teardown failure kills the agent for a different reason.
	deadMsg atomic.Pointer[string]

	// leaseOn is the lease latch: set by the first lease request, after which a
	// per-Exec request is refused (lease_linux.go). A per-Exec request never touches it.
	leaseOn atomic.Bool
	lease   leaseRuntime
}

func NewAgent(opts AgentOptions) (*Agent, error) {
	if opts.Shell == "" {
		opts.Shell = "bash"
	}
	if opts.ScratchDir == "" {
		opts.ScratchDir = os.TempDir()
	}
	if opts.Lease.TrackedUIDBase == 0 {
		opts.Lease.TrackedUIDBase = DefaultTrackedUIDBase
	}
	if opts.Lease.MaxTrackedUIDs == 0 {
		opts.Lease.MaxTrackedUIDs = DefaultMaxTrackedUIDs
	}
	a := &Agent{opts: opts}
	if opts.Lease.CgroupRoot != "" {
		if err := a.leasePrepare(); err != nil {
			return nil, err
		}
	}
	if err := a.forkShell(); err != nil {
		return nil, err
	}
	return a, nil
}

func (a *Agent) WorkDir() string { return a.opts.WorkDir }

// ShellPID is the parked shell's pid, so a test can prove it was not replaced.
func (a *Agent) ShellPID() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.shell == nil || a.shell.Process == nil {
		return 0
	}
	return a.shell.Process.Pid
}

// forkShell starts the shell that the snapshot captures blocked on its stdin pipe.
// The three pipes are created here rather than per command, because creating them per
// command is the fork this whole design removes.
func (a *Agent) forkShell() error {
	// No explicit cmd.Env, unlike internal/exec's runner (MI1 §5 R6), and deliberately so: the
	// guest agent is the VM's own init-time process and Request carries no environment across
	// the vsock (protocol.go). The inherited env is init's: since P4.1 it carries the proxy
	// settings (HTTPS_PROXY etc., pointing at the in-guest egress listener) and the inert
	// placeholder GH_TOKEN/GITHUB_TOKEN=moca-placeholder, never a secret (D7); nothing swaps
	// it until MI1 S2, when moca-egress will inject real credentials on the host. The guard is absent because there
	// is nothing to strip, not because it lives elsewhere. If Request or the agent's own
	// environment ever gains a secret, commands here need R6's filter.
	cmd := exec.Command(a.opts.Shell)
	cmd.Dir = a.opts.WorkDir
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	outR, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	errR, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	a.mu.Lock()
	a.shell, a.stdin = cmd, in
	a.stdout, a.stderr = bufio.NewReaderSize(outR, MaxFrame), bufio.NewReaderSize(errR, MaxFrame)
	a.mu.Unlock()
	return nil
}

func (a *Agent) Close() error {
	// Before shell.Wait below: the lease reaper's wait4(-1) could otherwise reap the
	// parked shell first and leave Wait with ECHILD.
	a.stopLease()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.stdin != nil {
		_ = a.stdin.Close()
	}
	if a.shell != nil && a.shell.Process != nil {
		_ = a.shell.Process.Kill()
		_ = a.shell.Wait()
	}
	return nil
}

// killShell kills and reaps the parked shell and marks the Agent dead. It exists for
// exactly one caller: a parked-shell command that timed out. Without this, the two
// drainUntilNonce goroutines reading a.stdout/a.stderr are simply abandoned — they
// never see EOF, the shell is never reaped, and (since this Agent is reused
// sequentially in tests, and would be reused across commands in any long-lived
// process) they race a later command's drain goroutines on the very same
// *bufio.Reader. Killing the shell forces EOF on both pipes, so the orphaned
// goroutines return on their own, and Wait reaps the child.
//
// Marking the Agent dead is deliberate, not incidental: it cannot serve another
// command after this, which matches reality, because the host destroys the VM on a
// timeout. ServeConn checks this flag up front so a later command on a dead Agent
// gets a clear KindError frame instead of hanging or panicking against a shell that
// is no longer there.
func (a *Agent) killShell() {
	a.dead.Store(true)
	a.mu.Lock()
	shell := a.shell
	a.mu.Unlock()
	if shell != nil && shell.Process != nil {
		_ = shell.Process.Kill()
		_ = shell.Wait()
	}
}

// Serve accepts connections forever. At snapshot time the agent is blocked HERE:
// Firecracker documents that listening vsock sockets survive restore with the CID
// updated, so the parked accept() is documented behaviour rather than a trick
// (spec §2.4, §5.1).
//
// Only a closed listener ends Serve (net.ErrClosed). The agent is PID 1, and main exits
// when Serve returns, which panics the guest kernel ("Attempted to kill init!"); so any
// other accept error -- EMFILE from a command exhausting fds, or an accept interrupted
// by a signal (Task 11's rig run: the SIGCHLD of a tracked process's exit) -- is logged
// and retried with a backoff, as net/http.Server and EgressForwarder.Serve do.
func (a *Agent) Serve(ln net.Listener) error {
	var delay time.Duration
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return err
			}
			if delay == 0 {
				delay = 5 * time.Millisecond
			} else if delay *= 2; delay > time.Second {
				delay = time.Second
			}
			log.Printf("guest-agent: accept: %v; retrying in %v", err, delay)
			time.Sleep(delay)
			continue
		}
		delay = 0
		go func() { _ = a.ServeConn(c) }()
	}
}

// acceptRetryable reports whether an accept(2) error is one to retry at once: the call
// was interrupted by a signal (EINTR), or the connection it would have returned was
// aborted before it was accepted (ECONNABORTED, which net's own accept loop retries). An
// EAGAIN is not: nothing is pending, so the caller waits for readability instead.
func acceptRetryable(err error) bool {
	return errors.Is(err, syscall.EINTR) || errors.Is(err, syscall.ECONNABORTED)
}

// ServeConn handles exactly one request on rw.
func (a *Agent) ServeConn(rw io.ReadWriteCloser) error {
	defer rw.Close()
	kind, payload, err := ReadFrame(rw)
	if err != nil {
		return err
	}
	if kind != KindRequest {
		return WriteFrame(rw, KindError, []byte(fmt.Sprintf("expected a request frame, got %#x", byte(kind))))
	}
	var req Request
	if err := DecodeJSON(payload, &req); err != nil {
		return WriteFrame(rw, KindError, []byte("undecodable request: "+err.Error()))
	}

	// Correct the wall clock before running anything: the guest resumed from the
	// snapshot moment, so `date`, file mtimes and git commit timestamps are all wrong
	// until this happens (spec §2.4, §5.3).
	//
	// Deliberately NOT gated by a "have I already done this" latch on the Agent. An
	// earlier version had one (a clockOK atomic.Bool, set true after the first
	// correction) and it was wrong: deploy/microvm/build-snapshot.sh sends TWO
	// requests carrying HostUnixNanos to the agent BEFORE the snapshot is taken
	// (probe_capabilities, then quiesce_guest), so the latch flipped true and the
	// clock got corrected during the BUILD, and then `true` was what got baked into
	// the golden snapshot's memory image. Every VM restored from that snapshot
	// inherited clockOK==true and silently skipped the correction forever — the
	// guest's clock stayed frozen at snapshot time on every single Exec, which is
	// exactly what TestGateClock caught. A one-shot "already done" flag is correct
	// reasoning for a long-lived process and exactly wrong for a process whose memory
	// image is snapshotted and restored many times: the flag's truth value does not
	// survive the restore that resets everything it was tracking. This is spec
	// §5.2's "nothing secret or unique may exist in the golden snapshot", but for
	// control state rather than secrets.
	//
	// shouldSetClock's threshold is what actually provides the idempotence the latch
	// was reaching for, and it does so restore-safely: it compares the guest's
	// CURRENT clock against the host's, not a remembered past decision. After the
	// first correction in a given VM's life the guest clock is within a second of
	// the host, so shouldSetClock returns false on its own and no needless
	// settimeofday happens on later commands in that same VM — without ever trusting
	// a flag that a restore can silently falsify.
	if req.HostUnixNanos > 0 {
		host := time.Unix(0, req.HostUnixNanos)
		if shouldSetClock(host, time.Now()) {
			if err := setWallClock(host); err != nil {
				// Not fatal: a wrong clock is a correctness problem for timestamps, not
				// a reason to fail the command. Reported on stderr so it is visible in
				// the run's own output rather than only in a host log.
				_ = WriteFrame(rw, KindStderr, []byte("guest-agent: clock: "+err.Error()+"\n"))
			}
		}
	}

	// The host ALWAYS sends KindStdinEOF, whether or not HasStdin is set — draining
	// only conditionally would desynchronise the stream on every no-stdin command.
	// This must happen BEFORE the dead-agent check below, not after: the host has
	// already committed to writing its stdin frames by the time this runs, so
	// replying early without draining them risks a write that never finds a reader
	// on the other end (a real hang, seen against the net.Pipe()-based test harness
	// and a risk under socket backpressure too), not just an ill-timed response.
	stdin, err := a.readStdin(rw)
	if err != nil {
		return WriteFrame(rw, KindError, []byte("reading stdin: "+err.Error()))
	}

	// A previous command's timeout killed the parked shell (see killShell): the
	// Agent is deliberately single-use after that, the same way the VM behind it is
	// about to be destroyed by the host. Fail explicitly, now that stdin has been
	// drained, rather than dispatching into a shell that is no longer there.
	if a.dead.Load() {
		msg := "guest-agent: a previous command timed out; the parked shell was killed and this agent is dead"
		if m := a.deadMsg.Load(); m != nil {
			msg = *m
		}
		return WriteFrame(rw, KindError, []byte(msg))
	}

	// Before any dispatch: a kind this agent does not serve must never run as a command
	// (ruling P5-R6).
	if err := checkRequestKind(req); err != nil {
		return WriteFrame(rw, KindError, []byte(err.Error()))
	}

	capBytes := req.CapBytes
	if capBytes <= 0 {
		capBytes = MaxFrame
	}
	w := &frameWriter{rw: rw, cap: capBytes}

	var end End
	if req.Lease {
		// Every lease kind, the process kinds included (lease_linux.go).
		end, err = a.runLease(req, stdin, w, rw)
	} else if a.leaseOn.Load() {
		// The latch. A per-Exec request runs as root on the parked shell, which a lease
		// VM must not offer once an Exec has run in it as the exec user. The latch alone
		// does not exclude a per-Exec request already in flight when the first lease
		// request arrives: that relies on the host serialising Execs per VM, and on a
		// VM's mode being fixed for its life.
		err = errors.New("guest-agent: this agent serves lease requests only")
	} else if req.HasStdin {
		// Spec §5.4's one thing the parked shell cannot do: `base64 -d > file` only
		// terminates at EOF, and you cannot close a long-lived shell's stdin without
		// killing it. So a stdin command gets a freshly forked child.
		end, err = a.runFreshChild(req, stdin, w)
	} else {
		end, err = a.runOnParkedShell(req, w)
	}
	// Both terminal frames go out through w, never straight to rw. From the moment the
	// first drain goroutine starts, w's mutex is the ONLY thing serialising writes to
	// this connection, and a frame is two Writes (header, then payload — see
	// WriteFrame): a terminal frame written directly to rw could interleave with a
	// drain's frame and hand the host a spliced header, which it reports as a hard
	// worker failure for a command that exited 0. Both of these paths can reach here
	// with a drain still live, by construction rather than by bad luck: the 1s
	// fallthrough in runOnParkedShell exists precisely for a chatty background job
	// still holding the stderr pipe, and killShell does not join the drains before the
	// timeout error goes out.
	//
	// seal is what makes this airtight rather than merely narrower. JOINING the drains
	// is not available on the fallthrough path — the whole reason that path exists is
	// that the stderr drain may never return — so the writer is permanently disabled
	// instead, under the same mutex, and any bytes an orphaned drain produces after
	// that are counted, not written. The drop counts are read under that mutex too;
	// reading them here without it was a plain data race against the drains.
	if err != nil {
		return w.sealAndWriteFrame(KindError, []byte(err.Error()))
	}
	return w.sealAndWriteEnd(end)
}

// readStdin drains stdin frames until KindStdinEOF, regardless of whether the request
// claimed HasStdin. The host always sends the EOF frame; an agent that skipped this
// read for a no-stdin command would leave that frame sitting in the connection and
// desynchronise everything after it.
func (a *Agent) readStdin(rw io.ReadWriteCloser) ([]byte, error) {
	var buf []byte
	for {
		kind, payload, err := ReadFrame(rw)
		if err != nil {
			return nil, err
		}
		switch kind {
		case KindStdin:
			buf = append(buf, payload...)
		case KindStdinEOF:
			return buf, nil
		default:
			return nil, fmt.Errorf("unexpected frame %#x while reading stdin", byte(kind))
		}
	}
}

// runOnParkedShell stages the command as a file and sources it, then reads until a
// per-command nonce appears on BOTH streams.
//
// Staged as a file rather than written line-by-line into the shell's stdin because a
// heredoc, a multi-line command or an unbalanced quote would otherwise wedge the
// parked shell — and agent-authored bash is exactly where those arrive. The file lives
// in guest tmpfs and dies with the VM.
//
// The nonce goes to stderr too. stdout's nonce says when the command finished, but
// stderr has no such delimiter, so a drain that stopped at stdout's nonce would race
// with trailing stderr and drop it.
func (a *Agent) runOnParkedShell(req Request, w *frameWriter) (End, error) {
	a.mu.Lock()
	a.seq++
	seq := a.seq
	stdin, stdout, stderr := a.stdin, a.stdout, a.stderr
	a.mu.Unlock()

	nonce, err := newNonce()
	if err != nil {
		return End{}, err
	}
	path := filepath.Join(a.opts.ScratchDir, fmt.Sprintf("ga-cmd-%d", seq))
	if err := os.WriteFile(path, []byte(req.Command), 0o600); err != nil {
		return End{}, fmt.Errorf("staging command: %w", err)
	}
	defer os.Remove(path)

	// The sourced file runs inside a subshell "( ... )" rather than bare ". path":
	// bash's `exit` inside a plain source terminates the CURRENT shell, which would
	// kill the parked shell on the very first `exit` a command issues. A subshell
	// only forks the already-resident bash image (no exec, no re-parsing of a shell
	// binary) — it is not the fork this design removes, which is starting bash from
	// scratch. "$?" after the subshell closes is the sourced script's exit status.
	//
	// No leading newline before the nonce: the printf write and the nonce line are
	// read as separate lines by drainUntilNonce, so a leading "\n" here would surface
	// as a spurious blank line of "output" ahead of the sentinel on every command.
	line := parkedShellLine(path, nonce)
	if _, err := io.WriteString(stdin, line); err != nil {
		return End{}, fmt.Errorf("writing to the parked shell: %w", err)
	}

	type drainResult struct {
		code int32
		err  error
	}
	outDone := make(chan drainResult, 1)
	errDone := make(chan error, 1)
	go func() {
		code, err := drainUntilNonce(stdout, nonce, w.stdout, true)
		outDone <- drainResult{code, err}
	}()
	go func() {
		_, err := drainUntilNonce(stderr, nonce, w.stderr, false)
		errDone <- err
	}()

	var timeout <-chan time.Time
	if req.TimeoutS > 0 {
		tm := time.NewTimer(time.Duration(req.TimeoutS) * time.Second)
		defer tm.Stop()
		timeout = tm.C
	}
	var res drainResult
	select {
	case res = <-outDone:
	case <-timeout:
		// The host's destroy is the real enforcement — teardown is the same path as
		// success (spec §4.1). This exists so a longer host timeout still yields an
		// explicit frame rather than silence.
		//
		// Killing the shell here (rather than just returning) is what stops the two
		// drainUntilNonce goroutines above from being orphaned against a.stdout and
		// a.stderr: killing forces EOF on both pipes, so they return on their own
		// instead of sitting there to race a later command's goroutines on the same
		// readers. See killShell's comment for why that deliberately makes the Agent
		// single-use from here on.
		a.killShell()
		return End{}, fmt.Errorf("timeout:%d", req.TimeoutS)
	}
	if res.err != nil {
		return End{}, res.err
	}
	select {
	case <-errDone:
	case <-time.After(time.Second):
		// stderr's nonce did not arrive within a second of stdout's. Report what we
		// have rather than hanging: the VM is about to be destroyed anyway.
	}
	return End{ExitCode: res.code}, nil
}

// parkedShellStdinRedirect is what closes stdin for a command that was given none.
// Kept as a named constant because the test that proves the hazard is real builds its
// "without this" case by removing exactly this string from parkedShellLine's output —
// see TestParkedShellSubshellCannotReadTheAgentsControlPipe.
const parkedShellStdinRedirect = " < /dev/null"

// parkedShellLine is the one line written into the parked shell's stdin to run a
// staged command: source it in a subshell, then print the sentinel on both streams.
//
// The subshell's stdin is redirected from /dev/null, which is internal/exec/runner.go's
// stated invariant for the container arm — "stdin ALWAYS closes. `base64 -d > f` waits
// for EOF, and a command given no stdin must still see EOF or anything reading it
// blocks forever" — restated here, because in the guest the consequence is worse than a
// hang. Without the redirect the subshell inherits the PARKED SHELL's stdin, and that
// pipe is this agent's own control channel: `cat`, `read`, `sort`, `wc` or `xargs` with
// no file argument would swallow the "__ga_rc=$?" / "printf '<nonce> %d\n'" bytes
// written immediately after them, echo the agent's own protocol back as the command's
// output, and destroy the exit status the sentinel carries — or, having consumed
// everything buffered, block until TimeoutS, which is frequently unset (see pool.go's
// comment on dispatch without a timeout) and therefore forever. Either way it is a tier
// divergence the harness cannot detect, so the redirect is not an optimisation.
//
// The HasStdin path does not come through here at all: runFreshChild forks a child and
// closes its stdin explicitly, which is the only way to give a command a *finite* stdin
// without killing the long-lived parked shell (spec §5.4).
func parkedShellLine(path, nonce string) string {
	return fmt.Sprintf("( . %q )%s\n__ga_rc=$?\nprintf '%s %%d\\n' \"$__ga_rc\"\nprintf '%s\\n' >&2\n",
		path, parkedShellStdinRedirect, nonce, nonce)
}

// runFreshChild is the stdin path: a real bash -c child whose stdin is fed and closed.
func (a *Agent) runFreshChild(req Request, stdin []byte, w *frameWriter) (End, error) {
	// Inherits the agent's environment on purpose; see forkShell for why R6's filter is absent here.
	cmd := exec.Command(a.opts.Shell, "-c", req.Command)
	cmd.Dir = a.opts.WorkDir
	cmd.Stdout = w.stdoutWriter()
	cmd.Stderr = w.stderrWriter()
	in, err := cmd.StdinPipe()
	if err != nil {
		return End{}, err
	}
	if err := cmd.Start(); err != nil {
		return End{}, err
	}
	go func() {
		_, _ = in.Write(stdin)
		_ = in.Close() // the EOF `base64 -d > file` waits for
	}()

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var timeout <-chan time.Time
	if req.TimeoutS > 0 {
		tm := time.NewTimer(time.Duration(req.TimeoutS) * time.Second)
		defer tm.Stop()
		timeout = tm.C
	}
	select {
	case err := <-done:
		if ee, ok := err.(*exec.ExitError); ok {
			return End{ExitCode: int32(ee.ExitCode())}, nil
		}
		if err != nil {
			return End{}, err
		}
		return End{ExitCode: 0}, nil
	case <-timeout:
		_ = cmd.Process.Kill()
		return End{}, fmt.Errorf("timeout:%d", req.TimeoutS)
	}
}

// setWallClock is osSetWallClock, indirected so a test can verify a SECOND request
// still attempts the clock correction when the guest clock is still wrong — the
// restore-safety property this file relies on now that there is no clockOK latch —
// without needing the real CAP_SYS_TIME syscall a non-root/non-Linux test runner has
// neither. Same pattern as chvChown in internal/vmpool/launcher_chv.go.
var setWallClock = osSetWallClock

func newNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "__GA_" + hex.EncodeToString(b[:]), nil
}

// shouldSetClock decides whether the guest's wall clock is far enough out to correct.
// One second, because the trap is not drift: the guest resumes from the SNAPSHOT
// moment, so the error is however long the golden snapshot has been in service —
// hours, not milliseconds (spec §2.4). A tight threshold would call settimeofday on
// every Exec for no benefit.
func shouldSetClock(host, guest time.Time) bool {
	d := host.Sub(guest)
	if d < 0 {
		d = -d
	}
	return d > time.Second
}

// frameWriter forwards output as frames, capping EACH stream independently and
// counting what it threw away.
//
// Capping here rather than with `head -c` in the guest pipeline is deliberate: `head`
// in a pipeline changes the command's exit status via SIGPIPE, and the exit code is
// the one thing a worker must report faithfully. Same byte saving, no perturbation.
// Every write to rw after the first drain goroutine starts goes through this one
// mutex, terminal frames included (see ServeConn's comment on seal): it is the only
// serialisation the connection has, and a frame is two Writes, so a second writer
// splices a header into another frame's payload rather than merely reordering frames.
type frameWriter struct {
	rw            io.Writer
	cap           int64
	mu            sync.Mutex
	sentStdout    int64
	sentStderr    int64
	droppedStdout int64
	droppedStderr int64
	// sealed is set by the two sealAndWrite* methods below, immediately before the
	// terminal frame is written, and never cleared: one connection carries one
	// command, so there is nothing to un-seal for. It is what lets a drain goroutine
	// that this ServeConn could not join (the 1s fallthrough, or a timeout's orphan)
	// keep running harmlessly instead of writing after the terminal frame.
	sealed bool
}

func (w *frameWriter) stdout(b []byte) { w.emit(KindStdout, b, &w.sentStdout, &w.droppedStdout) }

func (w *frameWriter) stderr(b []byte) { w.emit(KindStderr, b, &w.sentStderr, &w.droppedStderr) }

func (w *frameWriter) emit(k Kind, b []byte, sent, dropped *int64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.sealed {
		// The terminal frame has already gone out. Counting rather than writing is the
		// point: these bytes belong to a drain this command could not join, and the
		// host has been told the command is over.
		*dropped += int64(len(b))
		return
	}
	room := w.cap - *sent
	if room <= 0 {
		*dropped += int64(len(b))
		return
	}
	if int64(len(b)) > room {
		*dropped += int64(len(b)) - room
		b = b[:room]
	}
	*sent += int64(len(b))
	_ = WriteFrame(w.rw, k, b)
}

// sealAndWriteFrame disables every further stream frame and writes one terminal frame,
// both under the mutex the drain goroutines emit under. After it returns, no other
// goroutine can write to the connection.
func (w *frameWriter) sealAndWriteFrame(k Kind, payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.sealed = true
	return WriteFrame(w.rw, k, payload)
}

// sealAndWriteEnd is sealAndWriteFrame for the success frame, filling in the per-stream
// drop counts from inside the lock — the drains mutate those fields under it, so
// reading them anywhere else is a data race, and reading them BEFORE sealing would
// report a count the host cannot reconcile with the frames it received.
func (w *frameWriter) sealAndWriteEnd(end End) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.sealed = true
	end.DroppedStdout, end.DroppedStderr = w.droppedStdout, w.droppedStderr
	return WriteJSON(w.rw, KindEnd, end)
}

// notice writes one stderr frame from the agent itself, as ServeConn's clock message is
// written: the line goes out in full past the stream's cap, which a command may already
// have filled, and is not counted against it. Nothing is written once the terminal frame
// has gone out.
func (w *frameWriter) notice(msg string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.sealed {
		return
	}
	_ = WriteFrame(w.rw, KindStderr, []byte(msg))
}

// dropStdout counts n stdout bytes the agent cut before emitting, as dropped.
func (w *frameWriter) dropStdout(n int64) {
	if n <= 0 {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.droppedStdout += n
}

func (w *frameWriter) stdoutWriter() io.Writer { return writerFunc(w.stdout) }
func (w *frameWriter) stderrWriter() io.Writer { return writerFunc(w.stderr) }

type writerFunc func([]byte)

func (f writerFunc) Write(p []byte) (int, error) { f(p); return len(p), nil }

// drainUntilNonce forwards bytes to emit until it sees the nonce, returning the exit
// code carried after it on stdout (wantCode) or nothing (stderr).
//
// It reads in bounded MaxFrame slices via the reader's Read, not ReadBytes('\n'): a
// command that emits one huge line with no newline at all (e.g. `yes | tr -d '\n'`)
// must not be able to make the guest buffer without bound just because CapBytes is
// enforced downstream in frameWriter — that would defeat the entire point of capping
// in the guest. Only a small, fixed carry-over of one nonce's length minus one byte
// is kept across reads, which is exactly enough to catch a nonce split across a read
// boundary; everything else is emitted immediately, so peak extra memory here is
// O(MaxFrame + len(nonce)), never O(command output).
func drainUntilNonce(r *bufio.Reader, nonce string, emit func([]byte), wantCode bool) (int32, error) {
	var carry []byte
	buf := make([]byte, MaxFrame)
	for {
		n, rerr := r.Read(buf)
		if n > 0 {
			combined := make([]byte, len(carry)+n)
			copy(combined, carry)
			copy(combined[len(carry):], buf[:n])

			if idx := indexNonce(combined, nonce); idx >= 0 {
				if idx > 0 {
					emitChunked(emit, combined[:idx])
				}
				return finishSentinelLine(r, combined[idx:], nonce, wantCode)
			}

			// No nonce in what we have. Emit all of it except a nonce-length-sized
			// tail, in case the nonce straddles this read and the next one.
			keep := len(nonce) - 1
			if keep > len(combined) {
				keep = len(combined)
			}
			emitChunked(emit, combined[:len(combined)-keep])
			carry = append([]byte(nil), combined[len(combined)-keep:]...)
		}
		if rerr != nil {
			// The shell died before the nonce: report it rather than inventing a code.
			return 0, fmt.Errorf("parked shell ended before its sentinel: %w", rerr)
		}
	}
}

// finishSentinelLine reads, a byte at a time, through the newline that ends the
// sentinel line runOnParkedShell writes ("<nonce> <code>\n" on stdout, "<nonce>\n"
// on stderr) and then parses the code if wantCode. tail already starts with the
// nonce and may already contain the rest of the line. This is bounded regardless of
// command output size: the sentinel line itself is only ever a few dozen bytes.
//
// Consuming through the newline (rather than stopping the moment the nonce is found)
// matters even when !wantCode: leaving it unread would surface as a stray leading
// byte on the very next command's drain of the same *bufio.Reader.
func finishSentinelLine(r *bufio.Reader, tail []byte, nonce string, wantCode bool) (int32, error) {
	for bytes.IndexByte(tail, '\n') < 0 {
		b, err := r.ReadByte()
		if err != nil {
			return 0, fmt.Errorf("parked shell ended before its sentinel: %w", err)
		}
		tail = append(tail, b)
	}
	if !wantCode {
		return 0, nil
	}
	return parseNonceCode(tail, nonce)
}

// indexNonce returns the byte offset of nonce within line, or -1 if absent.
func indexNonce(line []byte, nonce string) int {
	return bytes.Index(line, []byte(nonce))
}

// parseNonceCode parses the "<nonce> <code>\n" suffix that runOnParkedShell writes
// after the nonce on stdout. It returns an error rather than a zero exit code when it
// cannot parse: inventing a zero would report success for a command whose actual
// status is unknown.
func parseNonceCode(tail []byte, nonce string) (int32, error) {
	s := strings.TrimRight(string(tail), "\n")
	s = strings.TrimPrefix(s, nonce)
	s = strings.TrimSpace(s)
	n, err := strconv.ParseInt(s, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("parsing exit code from sentinel line %q: %w", tail, err)
	}
	return int32(n), nil
}

// emitChunked slices b into MaxFrame pieces before calling emit, so one long line
// (e.g. from a command with no newlines at all) still streams instead of arriving as
// one oversized write that frameWriter would have to further slice itself.
func emitChunked(emit func([]byte), b []byte) {
	for off := 0; off < len(b); off += MaxFrame {
		end := off + MaxFrame
		if end > len(b) {
			end = len(b)
		}
		emit(b[off:end])
	}
}
