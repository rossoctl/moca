package vmpool

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeSnapshot(t *testing.T, dir string, mutate func(*Manifest)) string {
	t.Helper()
	img := filepath.Join(dir, "swebench-py311")
	if err := os.MkdirAll(img, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"vmstate": "state-bytes",
		"memfile": "memory-bytes",
		"kernel":  "vmlinux-bytes",
		"rootfs":  "rootfs-bytes",
		"agent":   "agent-bytes",
	} {
		if err := os.WriteFile(filepath.Join(img, name), []byte(body), 0o444); err != nil {
			t.Fatal(err)
		}
	}
	m := Manifest{Image: "swebench-py311", VMM: string(Firecracker), InstanceType: "c8i.metal-48xl", GuestRAMMB: 256}
	if err := m.Fill(img); err != nil {
		t.Fatalf("Fill: %v", err)
	}
	if mutate != nil {
		mutate(&m)
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	if err := os.WriteFile(filepath.Join(img, "manifest.json"), b, 0o444); err != nil {
		t.Fatal(err)
	}
	return img
}

func TestManifestVerifiesAGoodSnapshot(t *testing.T) {
	img := writeSnapshot(t, t.TempDir(), nil)
	m, err := LoadManifest(img)
	if err != nil {
		t.Fatalf("LoadManifest: %v", err)
	}
	if err := m.Verify(img); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if m.Hash == "" || !strings.HasPrefix(m.Hash, "sha256:") {
		t.Fatalf("Hash = %q", m.Hash)
	}
}

func TestManifestFailsLoudlyOnAStaleRootfs(t *testing.T) {
	dir := t.TempDir()
	img := writeSnapshot(t, dir, nil)
	// Someone rebuilt the rootfs and forgot the snapshot. Spec §5.5: a stale snapshot
	// must fail LOUDLY rather than silently serving an old toolchain — which would show
	// up as a workload failing for reasons nothing in the run record explains.
	//
	// writeSnapshot left this file 0o444 (read-only, as a real locked-down snapshot
	// is), so it must be made writable again before it can be overwritten in place —
	// os.WriteFile's mode argument only applies when it CREATES the file, not when it
	// truncates an existing one, and a 0o444 file has no write bit for anyone.
	if err := os.Chmod(filepath.Join(img, "rootfs"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(img, "rootfs"), []byte("new-toolchain"), 0o444); err != nil {
		t.Fatal(err)
	}
	m, err := LoadManifest(img)
	if err != nil {
		t.Fatalf("LoadManifest: %v", err)
	}
	err = m.Verify(img)
	if err == nil {
		t.Fatal("Verify accepted a snapshot whose rootfs had changed")
	}
	if !strings.Contains(err.Error(), "rootfs") {
		t.Fatalf("err = %v, want it to name which component drifted", err)
	}
}

func TestManifestRejectsATamperedHash(t *testing.T) {
	img := writeSnapshot(t, t.TempDir(), func(m *Manifest) { m.Hash = "sha256:0000" })
	m, err := LoadManifest(img)
	if err != nil {
		t.Fatalf("LoadManifest: %v", err)
	}
	// Only a 64-bit CRC guards the state file and the VMM TRUSTS these files (spec
	// §2.4), so integrity is checked here, outside the VMM.
	if err := m.Verify(img); err == nil {
		t.Fatal("Verify accepted a manifest whose own hash did not match its components")
	}
}

// A manifest written before features existed has no "features" key. It must still
// decode, and it must not claim lease-v1: plan 2's worker refuses lease mode on it.
func TestManifestFeaturesAreOptional(t *testing.T) {
	old := `{"image":"i","vmm":"firecracker","instance_type":"t","kernel_release":"6.1",` +
		`"guest_ram_mb":256,"capabilities":["bash"],"built_at":"2026-10-01T00:00:00Z",` +
		`"kernel_sha256":"sha256:k","rootfs_sha256":"sha256:r","agent_sha256":"sha256:a","hash":"sha256:h"}`
	var m Manifest
	if err := json.Unmarshal([]byte(old), &m); err != nil {
		t.Fatalf("decode an old manifest: %v", err)
	}
	if m.HasFeature(FeatureLeaseV1) {
		t.Fatal("an old manifest with no features claims lease-v1")
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "features") {
		t.Fatalf("an empty Features is encoded: %s", b)
	}
}

func TestManifestHasLeaseFeature(t *testing.T) {
	var m Manifest
	if err := json.Unmarshal([]byte(`{"features":["lease-v1"]}`), &m); err != nil {
		t.Fatal(err)
	}
	if !m.HasFeature(FeatureLeaseV1) {
		t.Fatalf("Features = %v, HasFeature(lease-v1) = false", m.Features)
	}
	if m.HasFeature("lease-v2") {
		t.Fatal("HasFeature matched a feature the manifest does not list")
	}
}

// balloon-fpr-v1 is the name build-snapshot.sh writes when the golden snapshot carries the
// reporting-only balloon; the worker's start-up warning keys on this exact string.
func TestBalloonFeatureConstant(t *testing.T) {
	if FeatureBalloonFPRV1 != "balloon-fpr-v1" {
		t.Fatalf("FeatureBalloonFPRV1 = %q, want balloon-fpr-v1", FeatureBalloonFPRV1)
	}
	var m Manifest
	if err := json.Unmarshal([]byte(`{"features":["lease-v1","balloon-fpr-v1"]}`), &m); err != nil {
		t.Fatal(err)
	}
	if !m.HasFeature(FeatureBalloonFPRV1) {
		t.Fatalf("Features = %v, HasFeature(balloon-fpr-v1) = false", m.Features)
	}
}

// lease-processes-v1 is the name build-snapshot.sh writes, beside lease-v1, on a Firecracker
// snapshot whose image carries the tracked-process identities; the worker refuses a process
// kind without it.
func TestLeaseProcessesFeatureConstant(t *testing.T) {
	if FeatureLeaseProcessesV1 != "lease-processes-v1" {
		t.Fatalf("FeatureLeaseProcessesV1 = %q, want lease-processes-v1", FeatureLeaseProcessesV1)
	}
	var m Manifest
	if err := json.Unmarshal([]byte(`{"features":["lease-v1","lease-processes-v1","balloon-fpr-v1"]}`), &m); err != nil {
		t.Fatal(err)
	}
	if !m.HasFeature(FeatureLeaseProcessesV1) {
		t.Fatalf("Features = %v, HasFeature(lease-processes-v1) = false", m.Features)
	}
}

// Features is outside the hash in both hash versions: a snapshot that predates the
// field still verifies.
func TestManifestHashIgnoresFeatures(t *testing.T) {
	without := writeSnapshot(t, t.TempDir(), nil)
	with := writeSnapshot(t, t.TempDir(), func(m *Manifest) { m.Features = []string{FeatureLeaseV1} })
	a, err := LoadManifest(without)
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadManifest(with)
	if err != nil {
		t.Fatal(err)
	}
	ha, err := a.ComputeHash()
	if err != nil {
		t.Fatal(err)
	}
	hb, err := b.ComputeHash()
	if err != nil {
		t.Fatal(err)
	}
	if a.Hash != b.Hash || ha != hb {
		t.Fatalf("hash changed with Features: %s vs %s", a.Hash, b.Hash)
	}
	if err := b.Verify(with); err != nil {
		t.Fatalf("Verify with Features: %v", err)
	}
}

func TestManifestRequiresTheSnapshotFilesToExist(t *testing.T) {
	img := writeSnapshot(t, t.TempDir(), nil)
	if err := os.Remove(filepath.Join(img, "memfile")); err != nil {
		t.Fatal(err)
	}
	m, _ := LoadManifest(img)
	if err := m.Verify(img); err == nil || !strings.Contains(err.Error(), "memfile") {
		t.Fatalf("err = %v, want it to name the missing memfile", err)
	}
}

func TestProbeRestoresOneVMAndDestroysIt(t *testing.T) {
	p, lc, _ := testPool(t)
	if err := p.Probe(context.Background()); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if lc.createdCount() != 1 || lc.liveCount() != 0 {
		t.Fatalf("created=%d live=%d, want 1 and 0", lc.createdCount(), lc.liveCount())
	}
	// The probe must leave NO trace in the pool: a reserved key that lingered would
	// count against MaxRuns and show up in every Stats scrape as a phantom active run.
	if s := p.Stats(); s.ActiveRuns != 0 || s.StandbysResident != 0 {
		t.Fatalf("Stats = %+v after Probe, want an empty pool", s)
	}
}

func TestProbeFailsWhenNoVMCanBeRestored(t *testing.T) {
	p, lc, _ := testPool(t)
	lc.setRestoreErr(errNoKVM)
	// Spec §6: fail at start, not on a user's first request.
	if err := p.Probe(context.Background()); err == nil {
		t.Fatal("Probe succeeded with a launcher that cannot restore")
	}
}

var errNoKVM = os.ErrPermission

// writeV1Snapshot writes a manifest as build-snapshot.sh did before hash version 2: the
// hash over kernel + rootfs + agent only, no hash_version, vmstate and memfile unhashed.
func writeV1Snapshot(t *testing.T) string {
	t.Helper()
	img := writeSnapshot(t, t.TempDir(), func(m *Manifest) {
		m.HashVersion, m.VMStateSHA256, m.MemfileSHA256 = 0, "", ""
		m.Hash, _ = m.ComputeHash()
	})
	return img
}

func TestManifestV1StillVerifies(t *testing.T) {
	img := writeV1Snapshot(t)
	b, _ := os.ReadFile(filepath.Join(img, "manifest.json"))
	if strings.Contains(string(b), "hash_version") {
		t.Fatalf("a version-1 manifest must not carry hash_version: %s", b)
	}
	m, err := LoadManifest(img)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.VerifyWith(img, VerifyOptions{Memfile: true}); err != nil {
		t.Fatalf("a version-1 snapshot (built before hash version 2) must keep verifying: %v", err)
	}
}

func TestManifestV2HashCoversEveryField(t *testing.T) {
	for _, tc := range []struct {
		field string
		edit  func(*Manifest)
	}{
		{"image", func(m *Manifest) { m.Image = "other" }},
		{"vmm", func(m *Manifest) { m.VMM = "cloud-hypervisor" }},
		{"instance_type", func(m *Manifest) { m.InstanceType = "example.metal" }},
		{"kernel_release", func(m *Manifest) { m.Kernel = "6.1.0" }},
		{"guest_ram_mb", func(m *Manifest) { m.GuestRAMMB = 4096 }},
		{"vcpus", func(m *Manifest) { m.VCPUs = 2 }},
		{"capabilities", func(m *Manifest) { m.Capabilities = append(m.Capabilities, "gh") }},
		{"built_at", func(m *Manifest) { m.BuiltAt = m.BuiltAt.Add(time.Second) }},
		{"vmstate_sha256", func(m *Manifest) { m.VMStateSHA256 = "sha256:00" }},
		{"memfile_sha256", func(m *Manifest) { m.MemfileSHA256 = "sha256:00" }},
		{"ch_config_sha256", func(m *Manifest) { m.CHConfigSHA256 = "sha256:00" }},
		{"egress_ca_sha256", func(m *Manifest) { m.EgressCASHA256 = "sha256:00" }},
		{"source_image_digest", func(m *Manifest) { m.SourceImageDigest = "sha256:00" }},
	} {
		t.Run(tc.field, func(t *testing.T) {
			img := writeSnapshot(t, t.TempDir(), tc.edit) // edited AFTER Fill: the hash is stale
			m, err := LoadManifest(img)
			if err != nil {
				t.Fatal(err)
			}
			// A file digest edited in the manifest is caught by its file check first (or, for a
			// digest of a file that is absent, by opening it); every other field by the hash.
			if err := m.Verify(img); err == nil {
				t.Fatalf("an edited %s was accepted", tc.field)
			}
			if tc.field != "vmstate_sha256" && tc.field != "ch_config_sha256" {
				if err := m.Verify(img); !strings.Contains(err.Error(), "does not match") {
					t.Fatalf("an edited %s: err = %v, want the hash mismatch", tc.field, err)
				}
			}
		})
	}
}

// TestProbeTearsDownItsVMOnEveryFailurePath pins the probe's teardown (#797): a probe that
// fails is followed at once by the worker's exit, so a VM it restored and did not destroy is
// left running beside the next start's sweep. Every way Probe can fail AFTER a VM exists must
// destroy it before returning. (The restore failure itself creates no VM here; the
// Firecracker launcher's own teardown on that path is pinned in
// TestRestoreKillsTheJailerItStartedWhenTheAPISocketNeverAppears.)
func TestProbeTearsDownItsVMOnEveryFailurePath(t *testing.T) {
	for _, tc := range []struct {
		name  string
		stage func(*fakeLauncher)
	}{
		{"resume fails", func(lc *fakeLauncher) {
			lc.setResumeFn(func(*fakeVM, context.Context) error { return errNoKVM })
		}},
		{"guest does not answer", func(lc *fakeLauncher) {
			lc.setRunFn(func(*fakeVM, Command, Sink) (Result, error) { return Result{}, errNoKVM })
		}},
		{"true exits non-zero", func(lc *fakeLauncher) {
			lc.setRunFn(func(*fakeVM, Command, Sink) (Result, error) { return Result{ExitCode: 1}, nil })
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, lc, _ := testPool(t)
			tc.stage(lc)
			if err := p.Probe(context.Background()); err == nil {
				t.Fatal("Probe succeeded despite the staged failure")
			}
			if lc.createdCount() != 1 || lc.liveCount() != 0 {
				t.Fatalf("created=%d live=%d after a failed Probe, want 1 and 0 — the probe left its VM behind",
					lc.createdCount(), lc.liveCount())
			}
		})
	}
}

func TestManifestV2ChecksVMStateAlwaysAndMemfileOnRequest(t *testing.T) {
	img := writeSnapshot(t, t.TempDir(), nil)
	overwrite := func(name, body string) {
		t.Helper()
		_ = os.Chmod(filepath.Join(img, name), 0o644)
		if err := os.WriteFile(filepath.Join(img, name), []byte(body), 0o444); err != nil {
			t.Fatal(err)
		}
	}
	m, _ := LoadManifest(img)
	if m.HashVersion != HashVersionAll || m.VMStateSHA256 == "" || m.MemfileSHA256 == "" {
		t.Fatalf("Fill must write version 2 with both digests: %+v", m)
	}
	overwrite("memfile", "other-memory")
	if err := m.Verify(img); err != nil {
		t.Fatalf("the default check must not read the memfile: %v", err)
	}
	if err := m.VerifyWith(img, VerifyOptions{Memfile: true}); err == nil || !strings.Contains(err.Error(), "memfile") {
		t.Fatalf("err = %v, want the memfile named", err)
	}
	overwrite("vmstate", "other-state")
	if err := m.Verify(img); err == nil || !strings.Contains(err.Error(), "vmstate") {
		t.Fatalf("err = %v, want the vmstate named", err)
	}
}

func TestManifestRefusesAnUnknownHashVersion(t *testing.T) {
	img := writeSnapshot(t, t.TempDir(), func(m *Manifest) { m.HashVersion = 3 })
	m, _ := LoadManifest(img)
	if err := m.Verify(img); err == nil || !strings.Contains(err.Error(), "hash_version 3") {
		t.Fatalf("err = %v, want the unknown version named", err)
	}
}

func TestManifestV2RefusesALineBreakInAField(t *testing.T) {
	m := Manifest{HashVersion: HashVersionAll, Image: "a\nkernel:sha256:forged"}
	if _, err := m.ComputeHash(); err == nil {
		t.Fatal("a field holding a newline was hashed; it could forge a line")
	}
}

// TestManifestV2HashMatchesBuildSnapshot pins the line format build-snapshot.sh prints:
// the shell side's test computes the same digest from the same fields.
func TestManifestV2HashMatchesBuildSnapshot(t *testing.T) {
	built, _ := time.Parse(time.RFC3339, "2026-11-03T00:00:00Z")
	m := Manifest{HashVersion: HashVersionAll, Image: "i", VMM: "firecracker", InstanceType: "t",
		Kernel: "k", GuestRAMMB: 256, VCPUs: 1, Capabilities: []string{"git", "bash"}, BuiltAt: built,
		KernelSHA256: "sha256:k", RootfsSHA256: "sha256:r", AgentSHA256: "sha256:a",
		VMStateSHA256: "sha256:v", MemfileSHA256: "sha256:m", SourceImageDigest: "sha256:s"}
	got, err := m.ComputeHash()
	if err != nil {
		t.Fatal(err)
	}
	const want = "sha256:" + manifestV2Golden
	if got != want {
		t.Fatalf("hash = %s, want %s (the line format changed: change build-snapshot.sh with it)", got, want)
	}
}

// manifestV2Golden: sha256 of the version-2 lines for the fields above.
const manifestV2Golden = "8387ae48e6ec1a40d345607eee9ccf1d2e5bd8ae64ae3bb2ec9d6227f0e59b93"
