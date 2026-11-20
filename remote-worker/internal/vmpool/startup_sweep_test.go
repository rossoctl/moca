package vmpool

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// startupPool builds a pool over the fake launcher on a WorkspaceRoot the test filled
// first, so New's startup sweep sees what a previous process left there.
func startupPool(t *testing.T, root string) (Pool, *fakeClock) {
	t.Helper()
	clk := newFakeClock()
	lc := newFakeLauncher()
	cfg := Config{
		VMM:               lc.Kind(),
		SnapshotDir:       t.TempDir(),
		WorkspaceRoot:     root,
		MaxRuns:           16,
		MaxCommittedBytes: 32 << 30,
	}
	p, err := New(cfg, lc, clk)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p, clk
}

// startupClockNow is newFakeClock's start: the mtimes below are set relative to it.
var startupClockNow = newFakeClock().Now()

// leftWorkspace makes root/key the way a previous process left it: a directory holding a
// workspace.img, both with mtime at.
func leftWorkspace(t *testing.T, root, key string, at time.Time) string {
	t.Helper()
	dir := filepath.Join(root, key)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	img := filepath.Join(dir, "workspace.img")
	if err := os.WriteFile(img, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{img, dir} {
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func requireExists(t *testing.T, path, why string) {
	t.Helper()
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("%s: %s: %v", why, path, err)
	}
}

// waitNoTombstones waits until no .reclaiming-* entry is left under root: the startup
// sweep's deletes run on the reclaim goroutine.
func waitNoTombstones(t *testing.T, root string) {
	t.Helper()
	waitForValue(t, "tombstones removed", func() bool {
		ents, err := os.ReadDir(root)
		if err != nil {
			return false
		}
		for _, e := range ents {
			if strings.HasPrefix(e.Name(), tombstonePrefix) {
				return false
			}
		}
		return true
	}, true)
}

// #338: an unknown workspace a previous process left, idle past WorkspaceIdle (30 min by
// default), is freed at startup; before this, a restarted worker never reached it.
func TestStartupSweepFreesAnOldUnknownWorkspace(t *testing.T) {
	root := t.TempDir()
	dir := leftWorkspace(t, root, "sess-old", startupClockNow.Add(-2*time.Hour))
	startupPool(t, root)
	waitGone(t, dir)
	waitNoTombstones(t, root)
}

// A younger one may belong to a session between turns: kept. Its age is the newer of the
// directory's and its workspace.img's mtime, so an old directory whose image the guest
// wrote recently is young.
func TestStartupSweepKeepsAYoungWorkspace(t *testing.T) {
	root := t.TempDir()
	young := leftWorkspace(t, root, "sess-young", startupClockNow.Add(-5*time.Minute))
	recent := leftWorkspace(t, root, "sess-recent-img", startupClockNow.Add(-2*time.Hour))
	at := startupClockNow.Add(-1 * time.Minute)
	if err := os.Chtimes(filepath.Join(recent, "workspace.img"), at, at); err != nil {
		t.Fatal(err)
	}
	startupPool(t, root)
	time.Sleep(50 * time.Millisecond) // give a wrong removal the chance to happen
	requireExists(t, filepath.Join(young, "workspace.img"), "a young workspace was removed")
	requireExists(t, filepath.Join(recent, "workspace.img"), "a workspace whose image is recent was removed")
}

// A key this process runs is never an unknown directory, however old its mtime.
func TestStartupSweepKeepsAKnownRunsWorkspace(t *testing.T) {
	root := t.TempDir()
	p, _ := startupPool(t, root)
	var out capturingSink
	if _, err := p.Exec(context.Background(), "sess-known", Exec{ReqID: 1, Command: "echo hi", TimeoutS: 5}, &out); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	dir := filepath.Join(root, "sess-known")
	old := startupClockNow.Add(-2 * time.Hour)
	if err := os.Chtimes(dir, old, old); err != nil {
		t.Fatal(err)
	}
	pp := p.(*pool)
	pp.mu.Lock()
	_, live := pp.runs["sess-known"]
	pp.mu.Unlock()
	if !live {
		t.Fatalf("the run for sess-known is gone; the test needs it live")
	}
	if swept, _ := pp.startupSweep(); swept != 0 {
		t.Fatalf("swept %d, want 0: a live run's workspace", swept)
	}
	requireExists(t, dir, "a live run's workspace was detached")
}

// A session directory can be a symlink (e.g. to a checkout outside the root). An old one
// is removed as the link itself: its target, and what it holds, survive.
func TestStartupSweepRemovesAnOldSymlinkNotItsTarget(t *testing.T) {
	root := t.TempDir()
	target := t.TempDir()
	keep := filepath.Join(target, "repo-file")
	if err := os.WriteFile(keep, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "sess-link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	old := startupClockNow.Add(-2 * time.Hour)
	ts := []unix.Timeval{unix.NsecToTimeval(old.UnixNano()), unix.NsecToTimeval(old.UnixNano())}
	if err := unix.Lutimes(link, ts); err != nil {
		t.Fatal(err)
	}
	startupPool(t, root)
	waitGone(t, link)
	waitNoTombstones(t, root)
	b, err := os.ReadFile(keep)
	if err != nil || string(b) != "keep me" {
		t.Fatalf("the link's target lost %s: %q, %v", keep, b, err)
	}
}

// Tombstones are a previous process's unfinished deletes: removed at startup, whatever
// their age. Entries no key can name (.lease-state, _probe) are left alone.
func TestStartupSweepRemovesTombstonesAndKeepsNonKeys(t *testing.T) {
	root := t.TempDir()
	tomb := filepath.Join(root, tombstonePrefix+"sess-x-1-1")
	if err := os.MkdirAll(tomb, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tomb, "workspace.img"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	probe := leftWorkspace(t, root, probeKey, startupClockNow.Add(-2*time.Hour))
	startupPool(t, root)
	waitNoTombstones(t, root)
	requireExists(t, filepath.Join(probe, "workspace.img"), "the probe's directory was removed")
	requireExists(t, filepath.Join(root, leaseStateDir), "the lease state directory was removed")
}
