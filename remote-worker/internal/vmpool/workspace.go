package vmpool

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync/atomic"
	"time"
)

// validKey bounds what may become a directory name under WorkspaceRoot. The key
// arrives over the wire, so an unvalidated one is a path-traversal primitive into
// the host — spec §2.3's cross-tenant leak reached through the new door. It is
// deliberately narrower than "run ids we happen to emit": lease run ids are
// session-derived slugs, and anything else is refused rather than escaped.
var validKey = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func checkKey(key string) error {
	if key == "" {
		return refusal(RefuseEmptyKey,
			"the microVM path requires a non-empty workspace_key: there is no correct "+
				"workspace to choose and nothing to fall back to (spec §3.4)")
	}
	if !validKey.MatchString(key) {
		return refusal(RefuseInvalidKey,
			"workspace_key %q must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}", key)
	}
	return nil
}

// workspaceDir resolves WorkspaceRoot/<key>. checkKey has already rejected
// anything that could escape; the containment check here makes that belt-and-braces
// rather than one regex standing between a wire string and the host filesystem.
func (p *pool) workspaceDir(key string) (string, error) {
	root := filepath.Clean(p.cfg.WorkspaceRoot)
	dir := filepath.Clean(filepath.Join(root, key))
	if filepath.Dir(dir) != root || dir == root {
		return "", refusal(RefuseInvalidKey, "workspace_key %q does not resolve directly inside %s", key, root)
	}
	return dir, nil
}

// ensureWorkspace creates the run's directory. 0o700 because the tree is
// bind-mounted into a guest but must not be readable by other host users; spec
// §2.3's cross-tenant path is this file-mode question one layer down.
func ensureWorkspace(dir string) error { return os.MkdirAll(dir, 0o700) }

func removeWorkspace(dir string) error { return os.RemoveAll(dir) }

// tombstonePrefix names a workspace that has been detached from its key and is queued
// for removal. It starts with a dot, and validKey requires an alphanumeric first
// character, so NO workspace_key can ever resolve to a tombstone — which is the whole
// point: a detached tree is outside the name space a new run can reach.
const tombstonePrefix = ".reclaiming-"

// tombstoneSeq keeps two detachments of the same key in one process from colliding. The
// timestamp alone is not enough at nanosecond resolution on a coarse clock, and a
// collision would surface as an ENOTEMPTY rename failure rather than as data mixing —
// but a failed detachment keeps a run alive that should be gone, so avoid it.
var tombstoneSeq atomic.Uint64

// detachWorkspace renames dir out of its key's name space and returns the new path, or
// "" if there was nothing there to detach.
//
// THIS IS WHAT MAKES REMOVAL SAFE OFF THE LOCK. The sweep decides to reclaim under p.mu
// but os.RemoveAll runs later, on the reclaim goroutine, after up to
// MaxReclaimsPerScan destroys (SIGKILL + Wait + jail teardown each) — a window long
// enough for a new Exec for the same key to pass runLocked, re-create the directory and
// restore a VM into it. The removal would then delete the tree out from under a running
// command, and on the Firecracker arm the guest would keep writing to a now-unlinked
// workspace.img inode (the jail hardlink keeps it alive), so the writes would vanish
// SILENTLY rather than failing. That is spec §2.3's isolation property — the one this
// tier exists to provide — broken by the housekeeping.
//
// Renaming instead of re-checking removes the window rather than shrinking it: after the
// rename the queued path is one no key can name, and a re-created run gets a fresh
// directory at the original path, a different inode from the one being removed. A
// re-check under the lock at removal time would still leave the gap between the check
// and RemoveAll, and holding p.mu across a recursive delete would put an rm -rf of a
// 2 GiB image in front of every other run's Exec.
//
// A tombstone left behind by a crashed worker is no worse than the workspace it replaced:
// the next process's startupSweep removes both, a tombstone at once and an unknown
// workspace once it is older than WorkspaceIdle (#338).
func detachWorkspace(dir string) (string, error) {
	tomb := filepath.Join(filepath.Dir(dir), fmt.Sprintf("%s%s-%d-%d",
		tombstonePrefix, filepath.Base(dir), time.Now().UnixNano(), tombstoneSeq.Add(1)))
	switch err := os.Rename(dir, tomb); {
	case err == nil:
		return tomb, nil
	case os.IsNotExist(err):
		// Nothing was ever created here — a run whose only warm failed before
		// ensureWorkspace, for instance. There is nothing to remove and nothing to race.
		return "", nil
	default:
		return "", err
	}
}
