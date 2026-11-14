package vmpool

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// The verify cache: VerifyWith hashes kernel, rootfs, agent and vmstate in full at
// every worker start, several GiB re-read just to re-hash files the build already hashed.
// With VerifyOptions.Cache set, a file is hashed in full once on this host, and its hash is
// then trusted for as long as the file's identity is unchanged:
//
//   - The trust point is a full check on this host: an entry is written only after a full
//     hash matched the manifest's wanted digest. A mismatch is never recorded.
//   - Identity is (dev, ino, size, mtime_ns). Any write moves mtime, and a file replaced at
//     the same path has a new inode. ctime is deliberately not in it: every VM restore
//     hardlinks the snapshot's files into its jail and chowns the links, and the teardown
//     removes them; link, chown and unlink each move the shared inode's ctime, so a ctime
//     check would miss on every start after the first restore. The cost: a writer who
//     changes a file without changing its size and then sets its mtime back (utimes,
//     touch -d) is trusted. Snapshot files are written only by the snapshot's owner (root
//     on a worker host), who can rewrite this cache file just as well.
//   - A cached entry is used only if its identity matches the file AND its sha256 equals
//     the manifest's wanted digest, so a forged or stale entry cannot make a drifted
//     manifest pass: the comparison against the manifest is still made, every start.
//   - The device number can change across reboots (and across remounts); that only means
//     a re-hash.
//   - The cache is an optimisation, never a reason to fail: a missing, unreadable,
//     unparsable, wrong-schema or wrong-permission cache file (not a regular 0600 file
//     owned by this uid) is treated as empty, and a failed write is logged and ignored.
//
// Two processes writing one cache file race only to the extent that the last rename wins
// and the loser's new entries are lost (re-hashed next time); a reader never sees a torn
// file because writes are a temp file + fsync + rename in the cache's own directory.

// verifyCacheSchema is the cache file's "schema"; any other value reads as an empty cache.
// Schema 1 also keyed on ctime; a schema 1 file therefore means one full check.
const verifyCacheSchema = 2

// fileIdentity is what must be unchanged for a recorded hash to be trusted.
type fileIdentity struct {
	Dev     uint64 `json:"dev"`
	Ino     uint64 `json:"ino"`
	Size    int64  `json:"size"`
	MtimeNs int64  `json:"mtime_ns"`
}

type verifyCacheEntry struct {
	fileIdentity
	SHA256 string `json:"sha256"`
}

type verifyCacheFile struct {
	Schema  int                         `json:"schema"`
	Entries map[string]verifyCacheEntry `json:"entries"`
}

// verifyHashFile is the hasher VerifyWith uses; a package variable so tests can count
// (and interfere with) the full hashes.
var verifyHashFile = fileSHA256

// verifyCacheRacyWindow: a file whose mtime is this close to now is not recorded. File
// timestamps come from a coarse clock (a kernel tick), so a write landing in the same tick
// as the hash could leave the identity unchanged; git's "racy index" problem, avoided the
// same way. Tests set it to 0.
var verifyCacheRacyWindow = 2 * time.Second

type verifyCache struct {
	path    string
	entries map[string]verifyCacheEntry
	dirty   bool
	settle  bool
	logf    func(string, ...any)
}

// openVerifyCache loads path, or returns an empty cache (logging why) if it cannot be used.
func openVerifyCache(path string, logf func(string, ...any)) *verifyCache {
	c := &verifyCache{path: path, entries: map[string]verifyCacheEntry{}, logf: logf}
	entries, err := readVerifyCache(path)
	switch {
	case err == nil:
		c.entries = entries
	case errors.Is(err, os.ErrNotExist):
		// First start on this host (or after the cache was removed): nothing to say.
	default:
		logf("vmpool: verify cache %s ignored, every file is hashed in full: %v", path, err)
	}
	return c
}

func readVerifyCache(path string) (map[string]verifyCacheEntry, error) {
	li, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !li.Mode().IsRegular() {
		return nil, fmt.Errorf("not a regular file (%s)", li.Mode().Type())
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(li, fi) {
		return nil, fmt.Errorf("replaced while being opened")
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		return nil, fmt.Errorf("mode %04o, want 0600", perm)
	}
	uid, ok := fileOwner(fi)
	if !ok {
		return nil, fmt.Errorf("owner unknown on this platform")
	}
	if want := os.Getuid(); want < 0 || uid != uint32(want) {
		return nil, fmt.Errorf("owned by uid %d, want %d", uid, want)
	}
	var cf verifyCacheFile
	dec := json.NewDecoder(f)
	if err := dec.Decode(&cf); err != nil {
		return nil, fmt.Errorf("unparsable: %w", err)
	}
	if cf.Schema != verifyCacheSchema {
		return nil, fmt.Errorf("schema %d, want %d", cf.Schema, verifyCacheSchema)
	}
	if cf.Entries == nil {
		cf.Entries = map[string]verifyCacheEntry{}
	}
	return cf.Entries, nil
}

// identityOf stats path (following symlinks, as the hash does).
func identityOf(path string) (fileIdentity, bool) {
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return fileIdentity{}, false
	}
	return statIdentity(fi)
}

// check is VerifyWith's per-file step with a cache: the digest of path, from the cache when
// its entry is trusted (see the file comment), else from a full hash.
func (c *verifyCache) check(path, want string) (got string, cached bool, err error) {
	before, ok := identityOf(path)
	if ok {
		if e, hit := c.entries[path]; hit && e.fileIdentity == before && e.SHA256 == want {
			return want, true, nil
		}
		if c.settle {
			if wait := verifyCacheRacyWindow - time.Since(time.Unix(0, before.MtimeNs)); wait > 0 {
				time.Sleep(wait + 10*time.Millisecond)
				before, ok = identityOf(path)
			}
		}
	}
	got, err = verifyHashFile(path)
	if err != nil {
		c.forget(path)
		return "", false, err
	}
	after, okAfter := identityOf(path)
	switch {
	case got != want:
		c.forget(path) // never record a mismatch, nor keep an entry for a drifted file
	case !ok || !okAfter || before != after:
		c.forget(path) // changed (or unstat-able) across the hash: hashed, but not recorded
	case time.Since(time.Unix(0, after.MtimeNs)) < verifyCacheRacyWindow:
		c.forget(path) // too recent to tell a later same-tick write apart
	default:
		if e, hit := c.entries[path]; !hit || e.fileIdentity != after || e.SHA256 != got {
			c.entries[path] = verifyCacheEntry{fileIdentity: after, SHA256: got}
			c.dirty = true
		}
	}
	return got, false, nil
}

func (c *verifyCache) forget(path string) {
	if _, hit := c.entries[path]; hit {
		delete(c.entries, path)
		c.dirty = true
	}
}

// save writes the cache if anything changed, dropping entries for files that no longer
// exist. A failure is logged, never returned: the verify itself already succeeded.
func (c *verifyCache) save() {
	if !c.dirty {
		return
	}
	for p := range c.entries {
		if _, err := os.Stat(p); err != nil {
			delete(c.entries, p)
		}
	}
	if err := writeVerifyCache(c.path, c.entries); err != nil {
		c.logf("vmpool: verify cache %s not written (the next start hashes in full): %v", c.path, err)
	}
}

func writeVerifyCache(path string, entries map[string]verifyCacheEntry) (err error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(verifyCacheFile{Schema: verifyCacheSchema, Entries: entries}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = os.Remove(tmp.Name())
		}
	}()
	if err = tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err = tmp.Write(append(b, '\n')); err != nil {
		_ = tmp.Close()
		return err
	}
	if err = tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	if d, e := os.Open(dir); e == nil {
		_ = d.Sync() // best effort: the rename's durability, not its atomicity
		_ = d.Close()
	}
	return nil
}
