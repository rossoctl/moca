package exec

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

// WorkspaceCapability is the Hello.capabilities entry that tells the harness this worker
// honours Exec.workspace_key with a per-key directory under its workspace root. The
// harness points a session's podCwd at <root>/<session id> ONLY when it sees it, because
// every path it sends is absolute (`cd '/workspace' && …`): changing the directory the
// child starts in, alone, would leave every session writing to the shared tree (#408).
// A worker without it keeps today's single shared workspace on both sides.
const WorkspaceCapability = "workspace-subdir"

// DefaultWorkspaceRoot matches the harness's KAGENTI_SANDBOX_CWD default and the
// Dockerfile's WORKDIR. The two sides are configured separately, so a deployment that
// moves one must move the other.
const DefaultWorkspaceRoot = "/workspace"

// DefaultWorkspaceIdle mirrors vmpool.DefaultWorkspaceIdle: an idle key's directory is
// the only thing a sweep deletes, and it is deleted only after this long with no Exec.
const DefaultWorkspaceIdle = 30 * time.Minute

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
// key's directory once no Exec is running in it and none has started for Idle. Only keys
// this process has run are swept: a restarted worker does not adopt directories it finds
// under Root, because Root is also the shared workspace and its contents (an empty-key
// session's `git clone foo`) are indistinguishable from a key's directory by name.
type WorkspaceRunner struct {
	Root  string
	Idle  time.Duration
	Inner Runner
	// Now is the clock; nil means time.Now. Injectable so Sweep is testable without waiting.
	Now func() time.Time

	mu   sync.Mutex
	runs map[string]*workspaceRun
}

type workspaceRun struct {
	inflight int
	last     time.Time
}

func (w *WorkspaceRunner) now() time.Time {
	if w.Now != nil {
		return w.Now()
	}
	return time.Now()
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
		w.mu.Unlock()
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
// last Idle, and returns the keys it reclaimed. A key whose rename fails stays tracked
// and is retried on the next sweep.
//
// The decision and the rename happen under the lock; the recursive delete does not. The
// rename is what makes that safe: once a directory is a tombstone, no key names it, so
// an Exec that arrives for the same key mid-delete gets a fresh, empty directory rather
// than one being deleted under it (vmpool/workspace.go, detachWorkspace).
func (w *WorkspaceRunner) Sweep() []string {
	now := w.now()
	var (
		reclaimed []string
		tombs     []string
	)
	w.mu.Lock()
	for key, run := range w.runs {
		if run.inflight > 0 || now.Sub(run.last) < w.Idle {
			continue
		}
		dir, err := w.dirFor(key)
		if err != nil {
			delete(w.runs, key) // unreachable: Run validated it before recording it
			continue
		}
		tomb := filepath.Join(filepath.Dir(dir), fmt.Sprintf("%s%s-%d-%d",
			workspaceTombstonePrefix, key, now.UnixNano(), workspaceTombstoneSeq.Add(1)))
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
		reclaimed = append(reclaimed, key)
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
			for _, key := range w.Sweep() {
				log.Printf("worker: workspace_key=%q idle for %s; workspace reclaimed", key, w.Idle)
			}
		}
	}
}
