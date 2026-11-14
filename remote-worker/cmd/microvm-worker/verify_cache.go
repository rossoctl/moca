package main

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log"
	"path/filepath"
	"strings"

	"github.com/rossoctl/moca/remote-worker/internal/vmpool"
)

// defaultVerifyCacheDir holds the worker's verify caches (vmpool/verifycache.go), one
// file per snapshot directory. The worker has no state directory of its own otherwise; this
// follows the host's /var/lib/moca-control-plane, root-owned like the snapshots it describes,
// and deliberately NOT inside SH_SNAPSHOT_DIR: snapshot directories are sealed read-only by
// build-snapshot.sh and replaced whole by its publish rename.
const defaultVerifyCacheDir = "/var/lib/moca-microvm-worker/verify-cache"

// verifyCachePath is the cache VerifyWith uses for snapDir, or "" for none.
//
//	SH_VERIFY_CACHE=0       no cache: every file hashed in full at every start (the old way)
//	SH_VERIFY_CACHE=1 / ""  the cache, at SH_VERIFY_CACHE_PATH if set, else
//	                        <dir>/<image>-<16 hex of sha256(canonical snapDir)>.json, where <dir> is
//	                        SH_VERIFY_CACHE_DIR if set (SBX0: under its own /srv/sbx), else
//	                        defaultVerifyCacheDir
//
// The default name depends only on the snapshot directory, so build-snapshot.sh's seed
// (microvm-worker -verify-snapshot DIR) and the worker that later serves DIR find the same
// file without sharing any setting. One file per snapshot also keeps workers that start
// together from overwriting each other's caches.
func verifyCachePath(get func(string) string, snapDir string) (string, error) {
	switch v := get("SH_VERIFY_CACHE"); v {
	case "0":
		return "", nil
	case "", "1":
	default:
		return "", fmt.Errorf("SH_VERIFY_CACHE=%q: want 0 (off) or 1 (on, the default)", v)
	}
	if p := get("SH_VERIFY_CACHE_PATH"); p != "" {
		if !filepath.IsAbs(p) {
			return "", fmt.Errorf("SH_VERIFY_CACHE_PATH=%q must be an absolute path", p)
		}
		return filepath.Clean(p), nil
	}
	dir := defaultVerifyCacheDir
	if d := get("SH_VERIFY_CACHE_DIR"); d != "" {
		if !filepath.IsAbs(d) {
			return "", fmt.Errorf("SH_VERIFY_CACHE_DIR=%q must be an absolute path", d)
		}
		dir = filepath.Clean(d)
	}
	canon := snapDir
	if real, err := filepath.EvalSymlinks(snapDir); err == nil {
		canon = real
	}
	if abs, err := filepath.Abs(canon); err == nil {
		canon = abs
	}
	sum := sha256.Sum256([]byte(canon))
	name := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			return r
		}
		return '_'
	}, filepath.Base(canon))
	return filepath.Join(dir, name+"-"+hex.EncodeToString(sum[:8])+".json"), nil
}

// runCLI is microvm-worker invoked with arguments; with none, main runs the worker. Today
// its one mode is -verify-snapshot DIR: the full start-time verify of DIR (memfile included),
// recording what matched in the cache the worker for DIR will read. build-snapshot.sh runs
// it after publishing a snapshot, while the files are still in the page cache, so the
// first cold start skips the re-hash too (Settle waits out the cache's ~2 s
// racy window for files the build touched last). Exit 0 verified, 1 not, 2 usage.
func runCLI(args []string, get func(string) string, stderr io.Writer) int {
	fs := flag.NewFlagSet("microvm-worker", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dir := fs.String("verify-snapshot", "", "verify the snapshot in `DIR` against its manifest.json, "+
		"memfile included, and record the matches in the worker's verify cache (SH_VERIFY_CACHE, SH_VERIFY_CACHE_PATH); then exit")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *dir == "" || fs.NArg() != 0 {
		fmt.Fprintln(stderr, "usage: microvm-worker            (the worker, configured by its environment)")
		fmt.Fprintln(stderr, "       microvm-worker -verify-snapshot DIR")
		return 2
	}
	logger := log.New(stderr, "", log.LstdFlags)
	cache, err := verifyCachePath(get, *dir)
	if err != nil {
		logger.Printf("microvm-worker: -verify-snapshot: %v", err)
		return 2
	}
	man, err := vmpool.LoadManifest(*dir)
	if err != nil {
		logger.Printf("microvm-worker: -verify-snapshot: %v", err)
		return 1
	}
	if err := man.VerifyWith(*dir, vmpool.VerifyOptions{Memfile: true, Cache: cache, Settle: true, Logf: logger.Printf}); err != nil {
		logger.Printf("microvm-worker: -verify-snapshot: %v", err)
		return 1
	}
	where := "no verify cache (SH_VERIFY_CACHE=0)"
	if cache != "" {
		where = "verify cache " + cache
	}
	logger.Printf("microvm-worker: -verify-snapshot %s: verified (manifest %s), %s", *dir, man.Hash, where)
	return 0
}
