//go:build linux || darwin

package vmpool

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// countingHasher swaps verifyHashFile for one that counts full hashes per file name (and
// may run a hook after hashing, to change the file mid-verify).
type countingHasher struct {
	mu     sync.Mutex
	counts map[string]int
	after  func(path string)
}

func installCountingHasher(t *testing.T) *countingHasher {
	t.Helper()
	h := &countingHasher{counts: map[string]int{}}
	prevHash, prevWindow := verifyHashFile, verifyCacheRacyWindow
	verifyHashFile = func(path string) (string, error) {
		got, err := fileSHA256(path)
		h.mu.Lock()
		h.counts[filepath.Base(path)]++
		after := h.after
		h.mu.Unlock()
		if after != nil {
			after(path)
		}
		return got, err
	}
	verifyCacheRacyWindow = 0
	t.Cleanup(func() { verifyHashFile, verifyCacheRacyWindow = prevHash, prevWindow })
	return h
}

func (h *countingHasher) take() map[string]int {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.counts
	h.counts = map[string]int{}
	return c
}

// cachedSnapshot is a version-2 snapshot and a cache path beside it, with the logger
// collecting what VerifyWith reports.
type cachedSnapshot struct {
	img, cache string
	m          Manifest
	logs       []string
}

func newCachedSnapshot(t *testing.T) *cachedSnapshot {
	t.Helper()
	dir := t.TempDir()
	img := writeSnapshot(t, dir, nil)
	m, err := LoadManifest(img)
	if err != nil {
		t.Fatal(err)
	}
	return &cachedSnapshot{img: img, cache: filepath.Join(dir, "state", "verify-cache.json"), m: m}
}

func (s *cachedSnapshot) verify() error {
	return s.m.VerifyWith(s.img, VerifyOptions{Cache: s.cache, Logf: func(f string, a ...any) {
		s.logs = append(s.logs, fmt.Sprintf(f, a...))
	}})
}

func (s *cachedSnapshot) entries(t *testing.T) map[string]verifyCacheEntry {
	t.Helper()
	e, err := readVerifyCache(s.cache)
	if err != nil {
		t.Fatalf("readVerifyCache: %v", err)
	}
	return e
}

func (s *cachedSnapshot) entryFor(t *testing.T, name string) (verifyCacheEntry, bool) {
	t.Helper()
	real, err := filepath.EvalSymlinks(s.img)
	if err != nil {
		t.Fatal(err)
	}
	e, ok := s.entries(t)[filepath.Join(real, name)]
	return e, ok
}

// rewrite replaces the content of an existing file in place (same inode), after a pause
// long enough for the filesystem's coarse timestamp clock to move on.
func rewrite(t *testing.T, path, body string) {
	t.Helper()
	time.Sleep(20 * time.Millisecond)
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(body); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func inode(t *testing.T, path string) uint64 {
	t.Helper()
	id, ok := identityOf(path)
	if !ok {
		t.Fatalf("no identity for %s", path)
	}
	return id.Ino
}

func TestVerifyCacheFirstVerifyHashesAndRecords(t *testing.T) {
	h := installCountingHasher(t)
	s := newCachedSnapshot(t)
	if err := s.verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
	got := h.take()
	for _, f := range []string{"kernel", "rootfs", "agent", "vmstate"} {
		if got[f] != 1 {
			t.Errorf("%s hashed %d times on the first verify, want 1", f, got[f])
		}
		e, ok := s.entryFor(t, f)
		if !ok || e.SHA256 == "" || e.Ino == 0 || e.Size == 0 || e.MtimeNs == 0 {
			t.Errorf("%s: entry %+v (present %v)", f, e, ok)
		}
	}
	if got["memfile"] != 0 {
		t.Errorf("memfile hashed without Memfile")
	}
	fi, err := os.Stat(s.cache)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("cache mode %04o, want 0600", fi.Mode().Perm())
	}
	if leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(s.cache), ".*tmp*")); len(leftovers) != 0 {
		t.Errorf("temp files left behind: %v", leftovers)
	}
}

func TestVerifyCacheSecondVerifySkipsUnchangedFiles(t *testing.T) {
	h := installCountingHasher(t)
	s := newCachedSnapshot(t)
	if err := s.verify(); err != nil {
		t.Fatal(err)
	}
	h.take()
	s.logs = nil
	if err := s.verify(); err != nil {
		t.Fatalf("second verify: %v", err)
	}
	if got := h.take(); len(got) != 0 {
		t.Errorf("second verify hashed %v, want nothing", got)
	}
	if len(s.logs) != 1 || !strings.Contains(s.logs[0], "4 of 4 snapshot files unchanged") {
		t.Errorf("logs = %q", s.logs)
	}
}

func TestVerifyCacheReplacedFileIsRehashed(t *testing.T) {
	h := installCountingHasher(t)
	s := newCachedSnapshot(t)
	if err := s.verify(); err != nil {
		t.Fatal(err)
	}
	h.take()
	p := filepath.Join(s.img, "rootfs")
	old := inode(t, p)
	// Same content, same path, new inode (a re-copy): still hashed again.
	tmp := p + ".new"
	if err := os.WriteFile(tmp, []byte("rootfs-bytes"), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, p); err != nil {
		t.Fatal(err)
	}
	if inode(t, p) == old {
		t.Skip("the filesystem reused the inode")
	}
	if err := s.verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got := h.take(); got["rootfs"] != 1 || len(got) != 1 {
		t.Errorf("hashed %v, want rootfs once", got)
	}
	if e, ok := s.entryFor(t, "rootfs"); !ok || e.Ino != inode(t, p) {
		t.Errorf("entry not updated to the new inode: %+v", e)
	}
}

func TestVerifyCacheSameInodeRewrittenIsRehashed(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		wantErr    bool
	}{
		{"new size", "rootfs-bytes-longer", true},
		{"same size, new content", "ROOTFS-BYTES", true},
		{"same content", "rootfs-bytes", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := installCountingHasher(t)
			s := newCachedSnapshot(t)
			if err := s.verify(); err != nil {
				t.Fatal(err)
			}
			h.take()
			p := filepath.Join(s.img, "rootfs")
			before, _ := identityOf(p)
			rewrite(t, p, tc.body)
			after, _ := identityOf(p)
			if after.Ino != before.Ino || after.MtimeNs == before.MtimeNs {
				t.Fatalf("setup: ino %d→%d mtime %d→%d", before.Ino, after.Ino, before.MtimeNs, after.MtimeNs)
			}
			err := s.verify()
			if tc.wantErr != (err != nil) {
				t.Fatalf("verify err = %v, want error %v", err, tc.wantErr)
			}
			if tc.wantErr && !strings.Contains(err.Error(), "rootfs drifted") {
				t.Errorf("err = %v", err)
			}
			if got := h.take(); got["rootfs"] != 1 {
				t.Errorf("rootfs hashed %d times, want 1", got["rootfs"])
			}
			e, ok := s.entryFor(t, "rootfs")
			if tc.wantErr && ok {
				t.Errorf("a mismatched file was recorded: %+v", e)
			}
			if !tc.wantErr && (!ok || e.fileIdentity != after) {
				t.Errorf("the re-hashed match was not recorded with its new identity: %+v", e)
			}
		})
	}
}

// A VM restore hardlinks each snapshot file into the VM's jail and chowns the link, and
// the teardown removes it: none of that changes the file's content, and the next start
// must still find every file unchanged.
func TestVerifyCacheJailLinkChownAndUnlinkKeepEntries(t *testing.T) {
	h := installCountingHasher(t)
	s := newCachedSnapshot(t)
	if err := s.verify(); err != nil {
		t.Fatal(err)
	}
	jail := t.TempDir()
	for _, f := range []string{"kernel", "rootfs", "agent", "vmstate", "memfile"} {
		dst := filepath.Join(jail, f)
		if err := os.Link(filepath.Join(s.img, f), dst); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(dst, os.Getuid(), os.Getgid()); err != nil {
			t.Fatal(err)
		}
	}
	h.take()
	s.logs = nil
	if err := s.verify(); err != nil {
		t.Fatalf("verify with the jail links in place: %v", err)
	}
	for _, f := range []string{"kernel", "rootfs", "agent", "vmstate", "memfile"} {
		if err := os.Remove(filepath.Join(jail, f)); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.verify(); err != nil {
		t.Fatalf("verify after the teardown: %v", err)
	}
	if got := h.take(); len(got) != 0 {
		t.Errorf("hashed %v across a restore and its teardown, want nothing", got)
	}
	for _, l := range s.logs {
		if !strings.Contains(l, "4 of 4 snapshot files unchanged") {
			t.Errorf("log %q, want 4 of 4 unchanged", l)
		}
	}
}

// The identity's stated limit (verifycache.go): a same-size rewrite whose mtime is then set
// back is trusted. Pinned here so that a change to it is a decision, not an accident.
func TestVerifyCacheSameSizeRewriteWithMtimeSetBackIsTrusted(t *testing.T) {
	h := installCountingHasher(t)
	s := newCachedSnapshot(t)
	if err := s.verify(); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(s.img, "rootfs")
	before, _ := identityOf(p)
	rewrite(t, p, "ROOTFS-BYTES")
	old := time.Unix(0, before.MtimeNs)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatal(err)
	}
	if after, _ := identityOf(p); after != before {
		t.Fatalf("setup: identity %+v, want %+v", after, before)
	}
	h.take()
	if err := s.verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got := h.take(); got["rootfs"] != 0 {
		t.Errorf("rootfs hashed %d times; the limit changed, update verifycache.go's comment", got["rootfs"])
	}
}

func TestVerifyCacheForgedEntryIsNotTrusted(t *testing.T) {
	h := installCountingHasher(t)
	s := newCachedSnapshot(t)
	p := filepath.Join(s.img, "rootfs")
	rewrite(t, p, "tampered-rootfs") // drifted from the manifest
	real, _ := filepath.EvalSymlinks(s.img)
	id, _ := identityOf(p)
	// A cache claiming the drifted file has the manifest's digest is still only a claim:
	// to be trusted it must ALSO match the manifest, and here a forger writing the
	// manifest's digest is exactly the case to refuse. Two forgeries: the wanted digest
	// on a stale identity (fails the identity match), and a wrong digest on the right
	// identity (fails the manifest comparison).
	for _, forged := range []verifyCacheEntry{
		{fileIdentity: fileIdentity{Dev: id.Dev, Ino: id.Ino, Size: id.Size, MtimeNs: id.MtimeNs - 1}, SHA256: s.m.RootfsSHA256},
		{fileIdentity: id, SHA256: "sha256:0000"},
	} {
		if err := writeVerifyCache(s.cache, map[string]verifyCacheEntry{filepath.Join(real, "rootfs"): forged}); err != nil {
			t.Fatal(err)
		}
		h.take()
		err := s.verify()
		if err == nil || !strings.Contains(err.Error(), "rootfs drifted") {
			t.Fatalf("verify with forged %+v: %v", forged, err)
		}
		if got := h.take(); got["rootfs"] != 1 {
			t.Errorf("rootfs hashed %d times, want 1", got["rootfs"])
		}
		if e, ok := s.entryFor(t, "rootfs"); ok {
			t.Errorf("the forged entry survived a failed verify: %+v", e)
		}
	}
}

func TestVerifyCacheWrongDigestEntryOnGoodFileIsRehashed(t *testing.T) {
	h := installCountingHasher(t)
	s := newCachedSnapshot(t)
	p := filepath.Join(s.img, "rootfs")
	real, _ := filepath.EvalSymlinks(s.img)
	id, _ := identityOf(p)
	if err := writeVerifyCache(s.cache, map[string]verifyCacheEntry{filepath.Join(real, "rootfs"): {fileIdentity: id, SHA256: "sha256:0000"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got := h.take(); got["rootfs"] != 1 {
		t.Errorf("rootfs hashed %d times, want 1", got["rootfs"])
	}
	if e, _ := s.entryFor(t, "rootfs"); e.SHA256 != s.m.RootfsSHA256 {
		t.Errorf("entry = %+v, want the true digest", e)
	}
}

func TestVerifyCacheUnusableCacheMeansFullCheck(t *testing.T) {
	for _, tc := range []struct {
		name    string
		breakIt func(t *testing.T, path string)
		log     string
	}{
		{"corrupt", func(t *testing.T, p string) { mustWrite(t, p, "{not json", 0o600) }, "unparsable"},
		{"wrong schema", func(t *testing.T, p string) {
			b, _ := os.ReadFile(p)
			mustWrite(t, p, strings.Replace(string(b), `"schema": 2`, `"schema": 3`, 1), 0o600)
		}, "schema 3"},
		{"mode 0644", func(t *testing.T, p string) {
			if err := os.Chmod(p, 0o644); err != nil {
				t.Fatal(err)
			}
		}, "mode 0644"},
		{"a symlink", func(t *testing.T, p string) {
			real := p + ".real"
			if err := os.Rename(p, real); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(real, p); err != nil {
				t.Fatal(err)
			}
		}, "not a regular file"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := installCountingHasher(t)
			s := newCachedSnapshot(t)
			if err := s.verify(); err != nil {
				t.Fatal(err)
			}
			tc.breakIt(t, s.cache)
			h.take()
			s.logs = nil
			if err := s.verify(); err != nil {
				t.Fatalf("verify with a %s cache failed the start: %v", tc.name, err)
			}
			got := h.take()
			for _, f := range []string{"kernel", "rootfs", "agent", "vmstate"} {
				if got[f] != 1 {
					t.Errorf("%s hashed %d times, want 1 (full check)", f, got[f])
				}
			}
			if len(s.logs) == 0 || !strings.Contains(s.logs[0], "ignored") || !strings.Contains(s.logs[0], tc.log) {
				t.Errorf("logs = %q, want an 'ignored ... %s' line first", s.logs, tc.log)
			}
			// The rewrite replaced it with a good one.
			if fi, err := os.Lstat(s.cache); err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm() != 0o600 {
				t.Errorf("cache not rewritten as a 0600 file: %v %v", fi, err)
			}
		})
	}
}

func TestVerifyCacheMissingCacheIsSilentAndUnwritableIsHarmless(t *testing.T) {
	installCountingHasher(t)
	s := newCachedSnapshot(t)
	if err := s.verify(); err != nil {
		t.Fatal(err)
	}
	for _, l := range s.logs {
		if strings.Contains(l, "ignored") {
			t.Errorf("a missing cache was reported: %q", l)
		}
	}
	// A cache path whose parent is a regular file cannot be created: verify still passes.
	blocker := filepath.Join(t.TempDir(), "file")
	mustWrite(t, blocker, "x", 0o600)
	s.cache = filepath.Join(blocker, "verify-cache.json")
	s.logs = nil
	if err := s.verify(); err != nil {
		t.Fatalf("an unwritable cache failed verify: %v", err)
	}
	if !strings.Contains(strings.Join(s.logs, "\n"), "not written") {
		t.Errorf("logs = %q", s.logs)
	}
}

func TestVerifyCacheMismatchIsNeverRecorded(t *testing.T) {
	installCountingHasher(t)
	s := newCachedSnapshot(t)
	rewrite(t, filepath.Join(s.img, "agent"), "other-agent")
	if err := s.verify(); err == nil || !strings.Contains(err.Error(), "agent drifted") {
		t.Fatalf("verify: %v", err)
	}
	if _, ok := s.entryFor(t, "agent"); ok {
		t.Errorf("the drifted agent was recorded")
	}
	// kernel and rootfs (checked before agent) matched and may be recorded; nothing
	// recorded may carry a digest other than the manifest's.
	want := map[string]string{"kernel": s.m.KernelSHA256, "rootfs": s.m.RootfsSHA256}
	for p, e := range s.entries(t) {
		if w, ok := want[filepath.Base(p)]; !ok || e.SHA256 != w {
			t.Errorf("unexpected entry %s %+v", p, e)
		}
	}
}

func TestVerifyCacheIdentityChangingDuringHashIsNotRecorded(t *testing.T) {
	h := installCountingHasher(t)
	s := newCachedSnapshot(t)
	p := filepath.Join(s.img, "rootfs")
	h.after = func(path string) {
		if path == p || filepath.Base(path) == "rootfs" {
			// Same content written again: the digest still matches, the identity moved.
			rewrite(t, path, "rootfs-bytes")
		}
	}
	if err := s.verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if _, ok := s.entryFor(t, "rootfs"); ok {
		t.Errorf("rootfs recorded although it changed during its hash")
	}
	if _, ok := s.entryFor(t, "kernel"); !ok {
		t.Errorf("kernel (unchanged) not recorded")
	}
	h.after = nil
	h.take()
	if err := s.verify(); err != nil {
		t.Fatal(err)
	}
	if got := h.take(); got["rootfs"] != 1 || got["kernel"] != 0 {
		t.Errorf("hashed %v, want rootfs once and kernel from the cache", got)
	}
}

func TestVerifyCacheRacyWindowDefersRecording(t *testing.T) {
	installCountingHasher(t)
	verifyCacheRacyWindow = time.Hour
	s := newCachedSnapshot(t)
	if err := s.verify(); err != nil {
		t.Fatal(err)
	}
	if e, err := readVerifyCache(s.cache); err == nil && len(e) != 0 {
		t.Errorf("files changed within the racy window were recorded: %v", e)
	}
}

func TestVerifyCacheMemfileOnlyWhenAsked(t *testing.T) {
	h := installCountingHasher(t)
	s := newCachedSnapshot(t)
	if err := s.m.VerifyWith(s.img, VerifyOptions{Cache: s.cache, Memfile: true, Logf: func(string, ...any) {}}); err != nil {
		t.Fatal(err)
	}
	if h.take()["memfile"] != 1 {
		t.Fatal("memfile not hashed with Memfile")
	}
	if _, ok := s.entryFor(t, "memfile"); !ok {
		t.Fatal("memfile not recorded")
	}
	// A later start without Memfile keeps the memfile entry for the next start with it.
	if err := s.verify(); err != nil {
		t.Fatal(err)
	}
	if err := s.m.VerifyWith(s.img, VerifyOptions{Cache: s.cache, Memfile: true, Logf: func(string, ...any) {}}); err != nil {
		t.Fatal(err)
	}
	if got := h.take(); len(got) != 0 {
		t.Errorf("hashed %v, want nothing", got)
	}
}

func TestVerifyCacheFileFormat(t *testing.T) {
	installCountingHasher(t)
	s := newCachedSnapshot(t)
	if err := s.verify(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(s.cache)
	if err != nil {
		t.Fatal(err)
	}
	var raw struct {
		Schema  int                       `json:"schema"`
		Entries map[string]map[string]any `json:"entries"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	if raw.Schema != 2 || len(raw.Entries) != 4 {
		t.Fatalf("schema %d, %d entries", raw.Schema, len(raw.Entries))
	}
	for p, e := range raw.Entries {
		if !filepath.IsAbs(p) {
			t.Errorf("key %q is not absolute", p)
		}
		for _, k := range []string{"dev", "ino", "size", "mtime_ns", "sha256"} {
			if _, ok := e[k]; !ok {
				t.Errorf("%s: no %s", p, k)
			}
		}
	}
}

func mustWrite(t *testing.T, path, body string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyCacheSettleWaitsOutTheRacyWindow(t *testing.T) {
	h := installCountingHasher(t)
	verifyCacheRacyWindow = 300 * time.Millisecond
	s := newCachedSnapshot(t)
	start := time.Now()
	if err := s.m.VerifyWith(s.img, VerifyOptions{Cache: s.cache, Settle: true, Logf: func(string, ...any) {}}); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) < 100*time.Millisecond {
		t.Errorf("Settle did not wait for files changed just now")
	}
	if n := len(s.entries(t)); n != 4 {
		t.Errorf("%d entries after a settled verify, want 4", n)
	}
	h.take()
	if err := s.verify(); err != nil {
		t.Fatal(err)
	}
	if got := h.take(); len(got) != 0 {
		t.Errorf("hashed %v after a settled seed, want nothing", got)
	}
}

func TestVerifyCacheOwnedByAnotherUIDIsIgnored(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("needs root to chown the cache file to another uid")
	}
	h := installCountingHasher(t)
	s := newCachedSnapshot(t)
	if err := s.verify(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(s.cache, 65534, -1); err != nil {
		t.Fatal(err)
	}
	h.take()
	s.logs = nil
	if err := s.verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got := h.take(); got["rootfs"] != 1 || got["kernel"] != 1 {
		t.Errorf("hashed %v, want a full check", got)
	}
	if len(s.logs) == 0 || !strings.Contains(s.logs[0], "owned by uid 65534") {
		t.Errorf("logs = %q", s.logs)
	}
}
