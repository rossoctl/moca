package vmpool

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// leaseTestPool is a pool over the fake (Firecracker-kind) launcher with the lease-v1
// manifest feature, so New sets LeaseEnabled.
func leaseTestPool(t *testing.T) (*pool, string) {
	t.Helper()
	lc := newFakeLauncher()
	root := t.TempDir()
	cfg := Config{
		VMM:               lc.Kind(),
		SnapshotDir:       t.TempDir(),
		WorkspaceRoot:     root,
		MaxRuns:           16,
		MaxCommittedBytes: 32 << 30,
		ManifestFeatures:  []string{FeatureLeaseV1},
	}
	p, err := New(cfg, lc, newFakeClock())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p.(*pool), root
}

// effectiveMode runs effectiveModeLocked the way an Exec would: under p.mu, on the
// key's run.
func effectiveMode(t *testing.T, p *pool, key string, e Exec) (Mode, error) {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	rp, _, err := p.runLocked(key)
	if err != nil {
		t.Fatalf("runLocked: %v", err)
	}
	return p.effectiveModeLocked(rp, e)
}

func TestLeaseStateRoundTrip(t *testing.T) {
	root := t.TempDir()
	at := time.Date(2026, 11, 12, 10, 30, 0, 0, time.UTC)
	want := leaseState{
		Mode: ModeLeaseProcesses, Epoch: 42, Known: true, RootWrote: true,
		Open:    &openLease{VMID: "vm-7", Mode: ModeLease, Started: at},
		Pending: &LeaseEvent{State: "end", Reason: LeaseEndKeepaliveLost, At: at.Add(time.Minute), Mode: ModeLease, Age: 90 * time.Second},
	}
	if err := saveLeaseState(root, "run-1", want); err != nil {
		t.Fatalf("saveLeaseState: %v", err)
	}
	if got := loadLeaseState(root, "run-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("loadLeaseState = %+v, want %+v", got, want)
	}
	// The file is the documented shape, not Go field names: plan 3 and an operator read it.
	b, err := os.ReadFile(filepath.Join(root, leaseStateDir, "run-1.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"mode":"lease+processes"`, `"epoch":42`, `"known":true`, `"root_wrote":true`,
		`"open":`, `"pending":`, `"state":"end"`, `"reason":"keepalive_lost"`, `"age_ms":90000`} {
		if !strings.Contains(string(b), field) {
			t.Errorf("state file %s lacks %s", b, field)
		}
	}
}

func TestLeaseStateMissingOrCorruptIsUnknown(t *testing.T) {
	root := t.TempDir()
	if got := loadLeaseState(root, "absent"); got.Known {
		t.Fatalf("missing file: Known = true, want false (%+v)", got)
	}
	dir := filepath.Join(root, leaseStateDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"empty":   "",
		"brace":   "{",
		"badmode": `{"mode":"resident","epoch":3,"known":true}`,
	} {
		if err := os.WriteFile(filepath.Join(dir, name+".json"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := loadLeaseState(root, name); got.Known {
			t.Errorf("%s file: Known = true, want false (%+v)", name, got)
		}
	}
}

func TestLeaseStateDirCannotBeAKey(t *testing.T) {
	if ReasonOf(checkKey(leaseStateDir)) != RefuseInvalidKey {
		t.Fatalf("checkKey(%q) = %v, want %s", leaseStateDir, checkKey(leaseStateDir), RefuseInvalidKey)
	}
}

func TestRemoveLeaseState(t *testing.T) {
	root := t.TempDir()
	if err := saveLeaseState(root, "k", leaseState{Mode: ModeLease, Epoch: 1, Known: true}); err != nil {
		t.Fatal(err)
	}
	removeLeaseState(root, "k")
	if _, err := os.Stat(filepath.Join(root, leaseStateDir, "k.json")); !os.IsNotExist(err) {
		t.Fatalf("state file still there after removeLeaseState: %v", err)
	}
	removeLeaseState(root, "k") // a missing file is not an error
}

func TestModeStringAndParse(t *testing.T) {
	for _, m := range []Mode{ModePerExec, ModeLease, ModeLeaseProcesses} {
		got, err := ParseMode(m.String())
		if err != nil || got != m {
			t.Errorf("ParseMode(%q) = %v, %v; want %v", m.String(), got, err, m)
		}
	}
	if s := ModeLeaseProcesses.String(); s != "lease+processes" {
		t.Errorf("ModeLeaseProcesses.String() = %q", s)
	}
	for _, bad := range []string{"", "resident", "LEASE"} {
		if _, err := ParseMode(bad); err == nil {
			t.Errorf("ParseMode(%q) accepted", bad)
		}
	}
}

func TestEffectiveModeStaleEpochRefused(t *testing.T) {
	p, root := leaseTestPool(t)
	if err := saveLeaseState(root, "k", leaseState{Mode: ModeLease, Epoch: 5, Known: true}); err != nil {
		t.Fatal(err)
	}
	_, err := effectiveMode(t, p, "k", Exec{Mode: ModeLease, ModeEpoch: 4})
	if ReasonOf(err) != RefuseStaleMode {
		t.Fatalf("err = %v, want %s", err, RefuseStaleMode)
	}
}

func TestEffectiveModeUnknownStaysPerExec(t *testing.T) {
	p, root := leaseTestPool(t)
	m, err := effectiveMode(t, p, "k", Exec{Mode: ModeLease, ModeEpoch: 9})
	if err != nil || m != ModePerExec {
		t.Fatalf("effectiveMode = %v, %v; want per-exec, nil", m, err)
	}
	if s := loadLeaseState(root, "k"); s.Known || s.Epoch != 0 {
		t.Fatalf("state after an Exec on an unknown epoch = %+v, want still unknown", s)
	}
}

func TestEffectiveModeNewerEpochIsStored(t *testing.T) {
	p, root := leaseTestPool(t)
	if err := saveLeaseState(root, "k", leaseState{Mode: ModeLease, Epoch: 5, Known: true}); err != nil {
		t.Fatal(err)
	}
	m, err := effectiveMode(t, p, "k", Exec{Mode: ModePerExec, ModeEpoch: 6})
	if err != nil || m != ModePerExec {
		t.Fatalf("effectiveMode = %v, %v; want per-exec, nil", m, err)
	}
	if s := loadLeaseState(root, "k"); !s.Known || s.Mode != ModePerExec || s.Epoch != 6 {
		t.Fatalf("state = %+v, want {per-exec, 6, known}", s)
	}
	// And the older lease token is now stale.
	if _, err := effectiveMode(t, p, "k", Exec{Mode: ModeLease, ModeEpoch: 5}); ReasonOf(err) != RefuseStaleMode {
		t.Fatalf("epoch 5 after 6: err = %v, want %s", err, RefuseStaleMode)
	}
}

func TestSetModeRestoresAfterLoss(t *testing.T) {
	p, root := leaseTestPool(t)
	if err := p.SetMode("k", ModeLease, 7); err != nil {
		t.Fatalf("SetMode: %v", err)
	}
	m, err := effectiveMode(t, p, "k", Exec{Mode: ModeLease, ModeEpoch: 7})
	if err != nil || m != ModeLease {
		t.Fatalf("effectiveMode = %v, %v; want lease, nil", m, err)
	}
	if s := loadLeaseState(root, "k"); !s.Known || s.Mode != ModeLease || s.Epoch != 7 {
		t.Fatalf("state = %+v, want {lease, 7, known}", s)
	}
}

func TestSetModeRefusesALowerEpoch(t *testing.T) {
	p, _ := leaseTestPool(t)
	if err := p.SetMode("k", ModeLease, 7); err != nil {
		t.Fatal(err)
	}
	// SetMode on a run that exists already updates what the run serves from.
	if _, err := effectiveMode(t, p, "k", Exec{Mode: ModeLease, ModeEpoch: 7}); err != nil {
		t.Fatal(err)
	}
	if err := p.SetMode("k", ModePerExec, 6); ReasonOf(err) != RefuseStaleMode {
		t.Fatalf("SetMode(epoch 6 after 7) = %v, want %s", err, RefuseStaleMode)
	}
	if err := p.SetMode("k", ModePerExec, 8); err != nil {
		t.Fatalf("SetMode(8): %v", err)
	}
	if _, err := effectiveMode(t, p, "k", Exec{Mode: ModeLease, ModeEpoch: 7}); ReasonOf(err) != RefuseStaleMode {
		t.Fatalf("epoch 7 after SetMode(8) on a live run: err = %v, want %s", err, RefuseStaleMode)
	}
}

func TestLeaseModeUnsupportedRefused(t *testing.T) {
	// testPool's Config carries no manifest features, so LeaseEnabled is false.
	p, lc, _ := testPool(t)
	_, err := p.Exec(t.Context(), "k", Exec{Command: "true", Mode: ModeLease, ModeEpoch: 1}, &capturingSink{})
	if ReasonOf(err) != RefuseLeaseUnsupported {
		t.Fatalf("err = %v, want %s", err, RefuseLeaseUnsupported)
	}
	lc.mu.Lock()
	n := lc.created
	lc.mu.Unlock()
	if n != 0 {
		t.Fatalf("a refused lease Exec restored %d VMs", n)
	}
	if err := p.SetMode("k", ModeLease, 1); ReasonOf(err) != RefuseLeaseUnsupported {
		t.Fatalf("SetMode(lease) without lease-v1 = %v, want %s", err, RefuseLeaseUnsupported)
	}
}

func TestLeaseEnabledNeedsFirecrackerAndLeaseV1(t *testing.T) {
	for _, tc := range []struct {
		vmm      VMMKind
		features []string
		want     bool
	}{
		{Firecracker, []string{FeatureLeaseV1}, true},
		{Firecracker, nil, false},
		{Firecracker, []string{"balloon-fpr-v1"}, false},
		{CloudHypervisor, []string{FeatureLeaseV1}, false},
		{FakeVMM, []string{FeatureLeaseV1}, false},
	} {
		if got := LeaseSupported(Config{VMM: tc.vmm, ManifestFeatures: tc.features}); got != tc.want {
			t.Errorf("LeaseSupported(%s, %v) = %v, want %v", tc.vmm, tc.features, got, tc.want)
		}
	}
	p, _ := leaseTestPool(t)
	if !p.cfg.LeaseEnabled {
		t.Fatal("New did not set LeaseEnabled for Firecracker + lease-v1")
	}
}

func TestIdleTimeoutClamped(t *testing.T) {
	c := good()
	if err := c.Normalize(); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ in, want time.Duration }{
		{0, 300 * time.Second},
		{5 * time.Second, 30 * time.Second},
		{120 * time.Second, 120 * time.Second},
		{9999 * time.Second, 1800 * time.Second},
	} {
		if got := c.leaseIdle(Exec{IdleTimeout: tc.in}); got != tc.want {
			t.Errorf("leaseIdle(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}
