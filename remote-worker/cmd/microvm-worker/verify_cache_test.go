package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rossoctl/moca/remote-worker/internal/vmpool"
)

func writeCLISnapshot(t *testing.T) string {
	t.Helper()
	img := filepath.Join(t.TempDir(), "snapshots", "sbx_py312")
	if err := os.MkdirAll(img, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"vmstate", "memfile", "kernel", "rootfs", "agent"} {
		if err := os.WriteFile(filepath.Join(img, f), []byte(f+"-bytes"), 0o444); err != nil {
			t.Fatal(err)
		}
	}
	m := vmpool.Manifest{Image: "sbx_py312", VMM: string(vmpool.Firecracker), InstanceType: "example.metal", GuestRAMMB: 4096}
	if err := m.Fill(img); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(img, "manifest.json"), b, 0o444); err != nil {
		t.Fatal(err)
	}
	return img
}

func envOf(kv map[string]string) func(string) string { return func(k string) string { return kv[k] } }

func TestVerifyCachePath(t *testing.T) {
	dir := t.TempDir()
	snap := filepath.Join(dir, "sbx_py312")
	if err := os.Mkdir(snap, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "alias")
	if err := os.Symlink(snap, link); err != nil {
		t.Fatal(err)
	}
	def, err := verifyCachePath(envOf(nil), snap)
	if err != nil || filepath.Dir(def) != defaultVerifyCacheDir || !strings.HasPrefix(filepath.Base(def), "sbx_py312-") || !strings.HasSuffix(def, ".json") {
		t.Fatalf("default = %q, %v", def, err)
	}
	if viaLink, _ := verifyCachePath(envOf(nil), link); viaLink != def {
		t.Errorf("a symlinked spelling of the same directory gets %q, want %q", viaLink, def)
	}
	if other, _ := verifyCachePath(envOf(nil), filepath.Join(dir, "elsewhere", "sbx_py312")); other == def {
		t.Errorf("two snapshot directories share one cache file")
	}
	if on, _ := verifyCachePath(envOf(map[string]string{"SH_VERIFY_CACHE": "1"}), snap); on != def {
		t.Errorf("SH_VERIFY_CACHE=1 = %q", on)
	}
	if off, err := verifyCachePath(envOf(map[string]string{"SH_VERIFY_CACHE": "0", "SH_VERIFY_CACHE_PATH": "/x/y.json"}), snap); off != "" || err != nil {
		t.Errorf("SH_VERIFY_CACHE=0 = %q, %v", off, err)
	}
	if p, err := verifyCachePath(envOf(map[string]string{"SH_VERIFY_CACHE_PATH": "/state/c.json"}), snap); p != "/state/c.json" || err != nil {
		t.Errorf("SH_VERIFY_CACHE_PATH = %q, %v", p, err)
	}
	if d, err := verifyCachePath(envOf(map[string]string{"SH_VERIFY_CACHE_DIR": "/srv/sbx/verify-cache/"}), snap); filepath.Dir(d) != "/srv/sbx/verify-cache" || filepath.Base(d) != filepath.Base(def) || err != nil {
		t.Errorf("SH_VERIFY_CACHE_DIR = %q, %v (want the default's name under it)", d, err)
	}
	if p, _ := verifyCachePath(envOf(map[string]string{"SH_VERIFY_CACHE_DIR": "/srv/sbx/verify-cache", "SH_VERIFY_CACHE_PATH": "/state/c.json"}), snap); p != "/state/c.json" {
		t.Errorf("SH_VERIFY_CACHE_PATH beside _DIR = %q, want the path to win", p)
	}
	for _, bad := range []map[string]string{{"SH_VERIFY_CACHE": "yes"}, {"SH_VERIFY_CACHE_PATH": "rel/c.json"}, {"SH_VERIFY_CACHE_DIR": "rel/dir"}} {
		if _, err := verifyCachePath(envOf(bad), snap); err == nil {
			t.Errorf("%v accepted", bad)
		}
	}
}

func TestVerifySnapshotSeedsTheCacheTheWorkerReads(t *testing.T) {
	img := writeCLISnapshot(t)
	cache := filepath.Join(t.TempDir(), "state", "c.json")
	get := envOf(map[string]string{"SH_VERIFY_CACHE_PATH": cache})
	var out bytes.Buffer
	if rc := runCLI([]string{"-verify-snapshot", img}, get, &out); rc != 0 {
		t.Fatalf("rc = %d: %s", rc, out.String())
	}
	if !strings.Contains(out.String(), "verified (manifest sha256:") {
		t.Errorf("output: %s", out.String())
	}
	b, err := os.ReadFile(cache)
	if err != nil {
		t.Fatalf("no cache written: %v", err)
	}
	var cf struct {
		Entries map[string]json.RawMessage `json:"entries"`
	}
	if err := json.Unmarshal(b, &cf); err != nil || len(cf.Entries) != 5 {
		t.Fatalf("%d entries (want 5: kernel, rootfs, agent, vmstate, memfile), %v", len(cf.Entries), err)
	}
	// The worker's own start-time verify (main.go's options) then hashes nothing.
	man, err := vmpool.LoadManifest(img)
	if err != nil {
		t.Fatal(err)
	}
	var logs []string
	if err := man.VerifyWith(img, vmpool.VerifyOptions{Cache: cache, Logf: func(f string, a ...any) {
		logs = append(logs, fmt.Sprintf(f, a...))
	}}); err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 || !strings.Contains(logs[0], "4 of 4 snapshot files unchanged since a full check on this host, 0 hashed in full") {
		t.Errorf("worker verify after the seed: %q", logs)
	}
}

func TestVerifySnapshotFailsOnADriftedSnapshotAndUsage(t *testing.T) {
	img := writeCLISnapshot(t)
	if err := os.Chmod(filepath.Join(img, "rootfs"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(img, "rootfs"), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(t.TempDir(), "c.json")
	var out bytes.Buffer
	if rc := runCLI([]string{"-verify-snapshot", img}, envOf(map[string]string{"SH_VERIFY_CACHE_PATH": cache}), &out); rc != 1 {
		t.Errorf("drifted: rc = %d, want 1: %s", rc, out.String())
	}
	if !strings.Contains(out.String(), "rootfs drifted") {
		t.Errorf("output: %s", out.String())
	}
	for _, args := range [][]string{{"-verify-snapshot"}, {"-nope"}, {"-verify-snapshot", img, "extra"}, {"positional"}} {
		if rc := runCLI(args, envOf(nil), &bytes.Buffer{}); rc != 2 {
			t.Errorf("%q: rc = %d, want 2", args, rc)
		}
	}
	if rc := runCLI([]string{"-verify-snapshot", img}, envOf(map[string]string{"SH_VERIFY_CACHE": "maybe"}), &bytes.Buffer{}); rc != 2 {
		t.Errorf("a bad SH_VERIFY_CACHE: rc = %d, want 2", rc)
	}
}
