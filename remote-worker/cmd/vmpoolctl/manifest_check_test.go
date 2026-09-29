package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rossoctl/moca/remote-worker/internal/vmpool"
)

// writeSnapshotDir builds a snapshot directory whose manifest is CONSISTENT with the files
// in it, so a test can then corrupt exactly one thing and know that is the only difference.
// The contents are not real Firecracker artifacts -- nothing here restores a VM. What is
// under test is the manifest gate, which runs strictly before any launcher is built.
func writeSnapshotDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{
		"vmstate": "vmstate-bytes",
		"memfile": "memfile-bytes",
		"kernel":  "kernel-bytes",
		"rootfs":  "rootfs-bytes",
		"agent":   "agent-bytes",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	var m vmpool.Manifest
	m.Image = "test-image"
	if err := m.Fill(dir); err != nil {
		t.Fatalf("Fill: %v", err)
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), b, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	return dir
}

// TestVmpoolctlRefusesADriftedSnapshot is the E10 half of defect 11. A microVM Exec was
// mutating the golden snapshot in place -- the launcher hardlinks the rootfs into every
// jail and the drive was not read-only, so merely mounting ext4 rw rewrote its superblock.
// microvm-worker's Manifest.Verify caught that and refused to start; THIS binary had no
// such check, so E10's rungs 2-4 went on producing a full set of latency numbers from a
// snapshot that no longer matched its manifest. A rung measured against a corrupted image
// is not a degraded measurement, it is a wrong one that looks fine -- so the two binaries
// now make the same check, and the asymmetry that hid this is gone.
func TestVmpoolctlRefusesADriftedSnapshot(t *testing.T) {
	dir := writeSnapshotDir(t)

	// Drift exactly one component, the way a guest write to a hardlinked rootfs would.
	if err := os.WriteFile(filepath.Join(dir, "rootfs"), []byte("rootfs-bytes-MUTATED"), 0o644); err != nil {
		t.Fatalf("mutate rootfs: %v", err)
	}

	_, err := run(t, "--vmm=firecracker", "--snapshot-dir="+dir, "--workspace-root="+t.TempDir(),
		"--key=run-a", "--mode=replenish", "--iterations=1", "--warmup=0", "--json", "--", "true")
	if err == nil {
		t.Fatal("vmpoolctl accepted a snapshot whose rootfs no longer matches its manifest — a rung measured against it would look fine and be wrong")
	}
	// The message must name the drift, not merely fail: the operator's next action is to
	// rebuild the snapshot, and nothing else in the error surface says that.
	for _, want := range []string{"drifted", "rootfs"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %q, so it does not point at the cause: %v", want, err)
		}
	}
}

// TestVmpoolctlAcceptsAConsistentSnapshot is the reachability half (branch discipline #3):
// a gate that refused everything would satisfy the test above while making the driver
// useless. A consistent manifest must get PAST the check -- this run still fails, but on
// the launcher, which is proof the manifest gate let it through rather than that the
// snapshot was accepted end to end.
func TestVmpoolctlAcceptsAConsistentSnapshot(t *testing.T) {
	dir := writeSnapshotDir(t)

	_, err := run(t, "--vmm=firecracker", "--snapshot-dir="+dir, "--workspace-root="+t.TempDir(),
		"--key=run-a", "--mode=replenish", "--iterations=1", "--warmup=0", "--json", "--", "true")
	if err == nil {
		t.Skip("a fake snapshot restored a VM, which cannot happen — nothing to assert")
	}
	if strings.Contains(err.Error(), "drifted") {
		t.Fatalf("the manifest gate fired on a CONSISTENT snapshot, so it would refuse every real run: %v", err)
	}
}

// TestVmpoolctlSkipsTheManifestCheckForTheFakeLauncher pins the one deliberate exemption:
// --vmm=fake has no snapshot at all, and every Phase A test and every fake-armed rung
// passes a bare t.TempDir() as --snapshot-dir. Gating those on a manifest would break the
// entire fake substrate for no benefit, since nothing there restores anything.
func TestVmpoolctlSkipsTheManifestCheckForTheFakeLauncher(t *testing.T) {
	dir := t.TempDir() // no manifest.json, no components
	out, err := run(t, "--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
		"--key=run-a", "--mode=replenish", "--iterations=1", "--warmup=0", "--json", "--", "true")
	if err != nil {
		t.Fatalf("the fake launcher must not require a snapshot manifest: %v (out=%s)", err, out)
	}
}
