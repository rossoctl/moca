package vmpool

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// startupSweep frees what a previous worker process left under WorkspaceRoot (#338): a
// restarted worker starts with an empty runs map, so its idle sweep never reaches a
// directory it does not know about, and on a host with no janitor (deploy/microvm) those
// workspaces stayed on disk for good. New calls it once, before anything is served.
//
// The rule is the host janitor's for an UNKNOWN directory (deploy/sbx/janitor.sh): an
// entry named as a workspace key, owned by no run here, whose newest mtime -- the
// directory's own or its workspace.img's -- is older than WorkspaceIdle. No live session
// can be that stale: this pool's own idle reclaim would have freed it by now. Anything
// checkKey refuses (.lease-state, _probe, a stray file name) is left alone, and so is a
// younger directory: it may belong to a session that is between turns, and its next Exec
// re-adopts it as before.
//
// Tombstones (.reclaiming-*) are removed whatever their age: at startup none is this
// process's, so each one is a previous process's detachment it never finished deleting.
//
// The decision and the rename happen under p.mu; the recursive delete runs on the reclaim
// goroutine (doReclaim), so a host full of old 2 GiB images does not delay the first
// Exec. A symlink named as a key is detached and removed as the link itself: the rename
// moves the link, and RemoveAll unlinks it without following it, so its target survives
// (the same path Release and the idle sweep take). Its age is the link's own, never the
// target's.
//
// It returns how many directories it detached and how many tombstones it queued, which
// New logs.
func (p *pool) startupSweep() (swept, tombs int) {
	root := filepath.Clean(p.cfg.WorkspaceRoot)
	ents, err := os.ReadDir(root)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("vmpool: startup sweep: read %s: %v", root, err)
		}
		return 0, 0
	}
	now := p.clk.Now()
	var b reclaimBatch
	p.mu.Lock()
	for _, e := range ents {
		name := e.Name()
		path := filepath.Join(root, name)
		if strings.HasPrefix(name, tombstonePrefix) {
			b.dirs = append(b.dirs, path)
			tombs++
			continue
		}
		if checkKey(name) != nil {
			continue
		}
		if _, live := p.runs[name]; live {
			continue
		}
		newest, ok := newestWorkspaceMtime(path)
		if !ok || now.Sub(newest) < p.cfg.WorkspaceIdle {
			continue
		}
		tomb, err := detachWorkspace(path)
		if err != nil {
			log.Printf("vmpool: startup sweep: detach %s: %v; kept", path, err)
			continue
		}
		if tomb == "" {
			continue
		}
		b.dirs = append(b.dirs, tomb)
		swept++
		// As the idle sweep does: the key's mode and epoch outlive its workspace.
		retireLeaseState(p.cfg.WorkspaceRoot, name, loadLeaseStateIfAny(p.cfg.WorkspaceRoot, name))
	}
	left := p.enqueueReclaimLocked(b)
	p.mu.Unlock()
	p.doReclaim(left)
	return swept, tombs
}

// newestWorkspaceMtime is the age the startup sweep judges a workspace by: the later of
// the directory's mtime and its workspace.img's (the guest's writes land in the image, so
// the directory's own mtime alone would make a busy session look idle). A symlink is
// judged by the link's own mtime, never by anything it points at. ok is false when the
// entry cannot be read, which keeps it.
func newestWorkspaceMtime(path string) (time.Time, bool) {
	fi, err := os.Lstat(path)
	if err != nil {
		return time.Time{}, false
	}
	newest := fi.ModTime()
	if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return newest, true
	}
	if img, err := os.Lstat(filepath.Join(path, "workspace.img")); err == nil && img.ModTime().After(newest) {
		newest = img.ModTime()
	}
	return newest, true
}
