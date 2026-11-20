package exec

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

// WorkspaceCapability is the Hello.capabilities entry that tells the harness this worker
// honours Exec.workspace_key with a per-key directory under its workspace root. The
// harness points a session's podCwd at <root>/<session id> ONLY when it sees it, because
// every path it sends is absolute (`cd '/workspace' && …`): changing the directory the
// child starts in, alone, would leave every session writing to the shared tree (#408).
// A worker without it keeps today's single shared workspace on both sides.
const WorkspaceCapability = "workspace-subdir"

// ReleaseCapability is the Hello.capabilities entry of a worker that serves the relay's
// Release frame (#338): it frees a workspace_key's workspace when its session or sandbox
// ends, and refuses Execs for the key after. A relay sends Release only to a worker that
// advertises it; one that predates it never sees the frame.
const ReleaseCapability = "sbx:release-v1"

// releasedPrefix starts the ExecError of an Exec for a released key, on both tiers
// (vmpool's RefuseReleased reads the same).
const releasedPrefix = "released"

// DefaultWorkspaceRoot matches the harness's KAGENTI_SANDBOX_CWD default and the
// Dockerfile's WORKDIR. The two sides are configured separately, so a deployment that
// moves one must move the other.
const DefaultWorkspaceRoot = "/workspace"

// DefaultWorkspaceIdle mirrors vmpool.DefaultWorkspaceIdle: an idle key's directory is
// the only thing a sweep deletes, and it is deleted only after this long with no Exec.
const DefaultWorkspaceIdle = 30 * time.Minute

// DefaultWorkspaceEmptyIdle is how long an EMPTY key directory is kept with no Exec
// before a sweep removes it (#551). What it ends is the pod carrying one empty directory
// per recent session until Idle, as a read-only workload run that wrote no scratch does.
//
// Removing one loses no file, and Run re-creates it before the session's next Exec. It
// is not invisible to a process still running there, though: background children outlive
// their Exec on this tier (the group is killed only on abort or timeout), and Linux lets
// rmdir remove another process's cwd. A server started with `nohup … &` in the empty
// directory would then serve a deleted directory while the session's later files land in
// a new one at the same path, and a delayed `( sleep 90; echo x > out ) &` would fail. So
// Sweep skips a directory that is any live process's cwd (procCwds, Linux only), and the
// grace is long enough to cover a normal pause between a session's commands, a model turn
// included. What is left is a child that is not in the directory yet (one that cd's into
// it later) and, off Linux, every child: both lose the directory after this long instead
// of after Idle.
const DefaultWorkspaceEmptyIdle = 15 * time.Minute

// validWorkspaceKey is vmpool's rule, byte for byte, so a key one tier accepts the other
// does too. The key arrives over the wire, so it is refused, never escaped: one path
// segment, no leading dot (which also keeps it out of the tombstone name space below).
var validWorkspaceKey = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// invalidWorkspaceKey prefixes the refusal so the ExecError reads the same as the
// microVM tier's (`invalid-workspace-key: …`).
const invalidWorkspaceKey = "invalid-workspace-key"

// workspaceTombstonePrefix names a directory detached from its key and queued for
// removal. validWorkspaceKey requires an alphanumeric first character, so no key can
// resolve to one — the same trick, for the same reason, as vmpool's detachWorkspace.
const workspaceTombstonePrefix = ".reclaiming-"

var workspaceTombstoneSeq atomic.Uint64

// WorkspaceRunner gives each non-empty Exec.workspace_key its own directory,
// <Root>/<key>, created on first use, and runs the command there. An empty key passes
// straight through to Inner — today's shared workspace — which is what keeps the proto
// field additive (spec §3.4).
//
// NOT A SECURITY BOUNDARY. Same Unix user, same process list, same container: a command
// can `cd ..`. This removes the collision of two sessions cloning into one path and the
// optics of one user's agent seeing another's files. Isolation is MI1 S5 owner binding.
//
// Removal is idle-only (#338: never delete a workspace mid-session). Sweep deletes a
// key's directory once no Exec is running in it and none has started for Idle. An EMPTY
// directory goes sooner, after EmptyIdle (#551), unless a live process has it as its cwd:
// it holds no file to lose, and the rmdir that removes it refuses a directory with
// anything in it, so a session that has written even one file keeps it until Idle (see
// DefaultWorkspaceEmptyIdle for what that does not cover). Only keys
// this process has run are swept: a restarted worker does not adopt directories it finds
// under Root, because Root is also the shared workspace and its contents (an empty-key
// session's `git clone foo`) are indistinguishable from a key's directory by name.
type WorkspaceRunner struct {
	Root string
	Idle time.Duration
	// EmptyIdle is how long an empty key directory outlives its last Exec; zero means
	// DefaultWorkspaceEmptyIdle. It only ever shortens Idle, never lengthens it: the
	// effective bound is the smaller of the two.
	EmptyIdle time.Duration
	Inner     Runner
	// Now is the clock; nil means time.Now. Injectable so Sweep is testable without waiting.
	Now func() time.Time
	// Cwds lists the working directories of live processes, as absolute paths with
	// symlinks resolved; nil means procCwds. Injectable so the "a background child is
	// still in it" rule is testable off Linux.
	Cwds func() (map[string]struct{}, error)

	mu   sync.Mutex
	runs map[string]*workspaceRun
	// released holds each key a Release named, with when, so an Exec for it is refused.
	// An entry expires after Idle: by then a sweep would have removed the directory
	// anyway, and a later Exec is in the same position as one after an idle sweep.
	released map[string]time.Time
	// cwdsErr is the last process-scan error, so a scan that fails every sweep is logged once.
	cwdsErr string
}

type workspaceRun struct {
	inflight int
	last     time.Time
	// releaseOnIdle marks a key a Release met with an Exec running: its directory is
	// removed when the last such Exec returns (Run's unwind), not at Idle.
	releaseOnIdle bool
	// rmdirErr is the last unexpected error removing this key's empty directory, kept so
	// a refusal that repeats every sweep (EBUSY on a mount point, EACCES) is logged once.
	rmdirErr string
}

// Reclaimed is one key a Sweep removed, and why.
type Reclaimed struct {
	Key string
	// Empty is true for an empty directory removed after EmptyIdle, false for a
	// directory removed after Idle.
	Empty bool
}

func (w *WorkspaceRunner) now() time.Time {
	if w.Now != nil {
		return w.Now()
	}
	return time.Now()
}

// emptyIdle is the effective EmptyIdle: the default when unset, never more than Idle.
func (w *WorkspaceRunner) emptyIdle() time.Duration {
	d := w.EmptyIdle
	if d <= 0 {
		d = DefaultWorkspaceEmptyIdle
	}
	return min(d, w.Idle)
}

func (w *WorkspaceRunner) cwds() (map[string]struct{}, error) {
	if w.Cwds != nil {
		return w.Cwds()
	}
	return procCwds()
}

// inUse reports whether dir, symlinks resolved as the kernel reports a cwd, is in cwds.
// A dir that does not resolve (already gone) is in use by nothing.
func inUse(cwds map[string]struct{}, dir string) bool {
	if len(cwds) == 0 {
		return false
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return false
	}
	_, ok := cwds[real]
	return ok
}

func (w *WorkspaceRunner) Run(ctx context.Context, s Spec, sink Sink) (int32, error) {
	// BashRunner refuses a non-command kind too; refusing here first means a refused Exec
	// does not create its workspace either.
	if err := refuseKind(s); err != nil {
		return -1, err
	}
	if s.WorkspaceKey == "" {
		return w.Inner.Run(ctx, s, sink)
	}
	dir, err := w.dirFor(s.WorkspaceKey)
	if err != nil {
		return -1, err
	}

	// The mkdir happens under the same lock the sweep detaches under, and inflight is
	// raised before it is released, so a sweep can never rename a directory out from
	// under a command that is about to start in it.
	w.mu.Lock()
	if err := w.refuseReleasedLocked(s.WorkspaceKey); err != nil {
		w.mu.Unlock()
		return -1, err
	}
	if w.runs == nil {
		w.runs = map[string]*workspaceRun{}
	}
	run := w.runs[s.WorkspaceKey]
	if run == nil {
		run = &workspaceRun{}
		w.runs[s.WorkspaceKey] = run
	}
	// 0o775 is /workspace's own mode (remote-worker/Dockerfile): any gid-0 uid under
	// OpenShift's arbitrary-uid policy can write it. Tighter would protect nothing here.
	if err := os.MkdirAll(dir, 0o775); err != nil {
		if run.inflight == 0 {
			delete(w.runs, s.WorkspaceKey)
		}
		w.mu.Unlock()
		return -1, fmt.Errorf("workspace %s: %w", dir, err)
	}
	run.inflight++
	run.last = w.now()
	w.mu.Unlock()

	defer func() {
		w.mu.Lock()
		run.inflight--
		run.last = w.now()
		var tomb string
		if run.releaseOnIdle && run.inflight == 0 && w.runs[s.WorkspaceKey] == run {
			// A Release met this key busy: its session has ended, so the directory goes
			// now that the last command in it has returned.
			var err error
			if tomb, err = w.detachLocked(s.WorkspaceKey, dir); err != nil {
				log.Printf("worker: workspace release %q after its Exec: %v; the sweep retries", s.WorkspaceKey, err)
			}
		}
		w.mu.Unlock()
		if tomb != "" {
			// Off the Exec's goroutine: the session sends this Exec's End after Run
			// returns, and a large tree's removal must not delay it.
			go removeTomb(tomb)
		}
	}()

	s.Dir = dir
	return w.Inner.Run(ctx, s, sink)
}

// dirFor resolves Root/<key>. The regex already rules out anything that could escape;
// the containment check keeps it belt-and-braces rather than one regex standing between
// a wire string and the filesystem.
func (w *WorkspaceRunner) dirFor(key string) (string, error) {
	if !validWorkspaceKey.MatchString(key) {
		return "", fmt.Errorf("%s: workspace_key %q must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}",
			invalidWorkspaceKey, key)
	}
	root := filepath.Clean(w.Root)
	dir := filepath.Clean(filepath.Join(root, key))
	if filepath.Dir(dir) != root || dir == root {
		return "", fmt.Errorf("%s: workspace_key %q does not resolve directly inside %s",
			invalidWorkspaceKey, key, root)
	}
	return dir, nil
}

// Sweep removes the directory of every key with no running Exec and none started in the
// last Idle, and of every such key whose directory is empty and no live process's cwd
// after EmptyIdle, and returns the keys it reclaimed. A key whose rename fails stays
// tracked and is retried on the next sweep.
//
// The decision and the rename happen under the lock; the recursive delete does not. The
// rename is what makes that safe: once a directory is a tombstone, no key names it, so
// an Exec that arrives for the same key mid-delete gets a fresh, empty directory rather
// than one being deleted under it (vmpool/workspace.go, detachWorkspace).
func (w *WorkspaceRunner) Sweep() []Reclaimed {
	now := w.now()
	emptyIdle := w.emptyIdle()
	var (
		reclaimed []Reclaimed
		tombs     []string
		// The process scan runs at most once per sweep, and only when an empty-directory
		// candidate turns up. Under the lock, so no Exec can start in between; it reads
		// a few /proc links per process, which a sandbox container has few of.
		cwds    map[string]struct{}
		cwdsErr error
		scanned bool
	)
	w.mu.Lock()
	w.pruneReleasedLocked(now)
	for key, run := range w.runs {
		idle := now.Sub(run.last)
		if run.inflight > 0 || idle < emptyIdle {
			continue
		}
		dir, err := w.dirFor(key)
		if err != nil {
			delete(w.runs, key) // unreachable: Run validated it before recording it
			continue
		}
		if idle < w.Idle {
			// Past EmptyIdle only. First, a directory that is a live process's cwd stays:
			// removing it would strand that process (DefaultWorkspaceEmptyIdle). A scan
			// that fails keeps every empty directory this sweep, rather than guess.
			if !scanned {
				cwds, cwdsErr = w.cwds()
				scanned = true
				// Logged when the error changes, not every sweep: a long-lived process
				// with an unreadable cwd (procCwds) fails every scan for as long as it runs.
				msg := ""
				if cwdsErr != nil {
					msg = cwdsErr.Error()
				}
				if msg != w.cwdsErr {
					w.cwdsErr = msg
					if cwdsErr != nil {
						log.Printf("worker: workspace sweep: list process cwds: %v; keeping empty workspaces until Idle", cwdsErr)
					}
				}
			}
			if cwdsErr != nil || inUse(cwds, dir) {
				continue
			}
			// syscall.Rmdir, not os.Remove: os.Remove unlinks first, so it would delete a
			// regular file that took the directory's place. rmdir is atomic and fails on
			// any entry, so there is no check-then-delete window: a directory with a file
			// in it, even one written this instant, is left as it is (ENOTEMPTY, or EEXIST
			// on some systems), and so is anything that is not a directory (ENOTDIR). It
			// is done under the lock, like the rename below, so a Run for this key either
			// finishes its mkdir first (inflight > 0 above, or a fresh entry) or runs
			// after and re-creates the directory.
			switch err := syscall.Rmdir(dir); {
			case err == nil, errors.Is(err, fs.ErrNotExist):
				delete(w.runs, key)
				reclaimed = append(reclaimed, Reclaimed{Key: key, Empty: true})
			case errors.Is(err, syscall.ENOTEMPTY), errors.Is(err, syscall.EEXIST),
				errors.Is(err, syscall.ENOTDIR):
				run.rmdirErr = "" // the common case: the session has files there
			default:
				// EBUSY, EACCES and the like: kept, and retried next sweep. Logged when
				// the error changes, not every sweep.
				if msg := err.Error(); msg != run.rmdirErr {
					run.rmdirErr = msg
					log.Printf("worker: workspace sweep: remove empty %s: %v; kept", dir, err)
				}
			}
			continue
		}
		tomb := tombstonePath(dir, key, now)
		switch err := os.Rename(dir, tomb); {
		case err == nil:
			tombs = append(tombs, tomb)
		case os.IsNotExist(err):
			// Removed by hand, or by the session itself. Nothing to delete.
		default:
			log.Printf("worker: workspace sweep: detach %s: %v", dir, err)
			continue
		}
		delete(w.runs, key)
		reclaimed = append(reclaimed, Reclaimed{Key: key})
	}
	w.mu.Unlock()

	for _, tomb := range tombs {
		if err := os.RemoveAll(tomb); err != nil {
			log.Printf("worker: workspace sweep: remove %s: %v", tomb, err)
		}
	}
	return reclaimed
}

// SweepEvery runs Sweep every interval until ctx ends.
func (w *WorkspaceRunner) SweepEvery(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, r := range w.Sweep() {
				if r.Empty {
					log.Printf("worker: workspace_key=%q empty and unused for %s; workspace reclaimed",
						r.Key, w.emptyIdle())
				} else {
					log.Printf("worker: workspace_key=%q idle for %s; workspace reclaimed", r.Key, w.Idle)
				}
			}
		}
	}
}

// Release frees key's directory because its session or sandbox has ended (#338), and
// refuses Execs for key from then on, for Idle. It never cuts a running command: with one
// in flight the directory is kept and removed when the last one returns (kept_busy). A key
// this process has not run is unknown_key, and its directory, if any, is left alone, for
// the reason Sweep does not adopt directories (Root is also the shared workspace).
// Idempotent: a second Release is unknown_key, and re-marks the key.
//
// It removes a tree with files in it, and skips the sweep's live-cwd check (#872, which
// keeps an EMPTY directory that a background process still has as its cwd): that check
// protects a session that is still going, and a Release says its owner has ended. A
// process the session left running there keeps a deleted cwd, as after an idle sweep.
func (w *WorkspaceRunner) Release(_ context.Context, key string) (pb.ReleaseOutcome, error) {
	dir, err := w.dirFor(key)
	if err != nil {
		return pb.ReleaseOutcome_RELEASE_OUTCOME_UNSPECIFIED, err
	}
	w.mu.Lock()
	if w.released == nil {
		w.released = map[string]time.Time{}
	}
	now := w.now()
	w.pruneReleasedLocked(now)
	w.released[key] = now
	run := w.runs[key]
	switch {
	case run == nil:
		w.mu.Unlock()
		return pb.ReleaseOutcome_RELEASE_OUTCOME_UNKNOWN_KEY, nil
	case run.inflight > 0:
		run.releaseOnIdle = true
		w.mu.Unlock()
		return pb.ReleaseOutcome_RELEASE_OUTCOME_KEPT_BUSY, nil
	}
	tomb, err := w.detachLocked(key, dir)
	w.mu.Unlock()
	if err != nil {
		// Not RELEASED: the directory is still there. The key is refused all the same
		// (released, above), and the sweep finishes the job; the sender may retry. As
		// vmpool's Release answers the same failure.
		return pb.ReleaseOutcome_RELEASE_OUTCOME_UNSPECIFIED, err
	}
	removeTomb(tomb)
	return pb.ReleaseOutcome_RELEASE_OUTCOME_RELEASED, nil
}

// detachLocked renames key's directory to a tombstone and stops tracking key, returning
// the tombstone to remove off the lock ("" if there was no directory). A rename that
// fails for another reason is logged, errWorkspaceDetach is returned, and the key stays
// tracked, so the sweep retries it.
// Caller holds w.mu.
func (w *WorkspaceRunner) detachLocked(key, dir string) (string, error) {
	tomb := tombstonePath(dir, key, w.now())
	switch err := os.Rename(dir, tomb); {
	case err == nil:
	case os.IsNotExist(err):
		tomb = ""
	default:
		// The detail stays in this log: the error goes back over the wire (the relay's answer
		// and audit), so it names no host path or OS error text.
		log.Printf("worker: workspace release: detach %s: %v; the sweep retries", dir, err)
		return "", errWorkspaceDetach
	}
	delete(w.runs, key)
	return tomb, nil
}

// errWorkspaceDetach is what a failed detach returns: fixed and path-free, since it travels
// to the client and the relay's audit. It does not start with release_unsupported:, busy: or
// invalid-, so the relay answers it as a retryable failure.
var errWorkspaceDetach = errors.New("workspace removal failed; the sweep retries")

// tombstonePath names the detached copy of key's dir: beside it, under
// workspaceTombstonePrefix, unique per detachment. Sweep and Release share it.
func tombstonePath(dir, key string, now time.Time) string {
	return filepath.Join(filepath.Dir(dir), fmt.Sprintf("%s%s-%d-%d",
		workspaceTombstonePrefix, key, now.UnixNano(), workspaceTombstoneSeq.Add(1)))
}

func removeTomb(tomb string) {
	if tomb == "" {
		return
	}
	if err := os.RemoveAll(tomb); err != nil {
		log.Printf("worker: workspace release: remove %s: %v", tomb, err)
	}
}

// refuseReleasedLocked refuses an Exec for a key released within Idle. Caller holds w.mu.
func (w *WorkspaceRunner) refuseReleasedLocked(key string) error {
	at, ok := w.released[key]
	if !ok {
		return nil
	}
	if w.now().Sub(at) >= w.Idle {
		delete(w.released, key)
		return nil
	}
	return fmt.Errorf("%s: workspace_key %q was released at %s (its session or sandbox has ended)",
		releasedPrefix, key, at.UTC().Format(time.RFC3339))
}

// pruneReleasedLocked drops released keys older than Idle, so the set is bounded by the
// release rate times Idle. Caller holds w.mu.
func (w *WorkspaceRunner) pruneReleasedLocked(now time.Time) {
	for k, at := range w.released {
		if now.Sub(at) >= w.Idle {
			delete(w.released, k)
		}
	}
}
