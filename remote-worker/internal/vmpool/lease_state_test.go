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

// PR #763 review (F10): at an equal epoch, an Exec whose mode differs from the stored one
// runs at the lower of the two (per-exec < lease < lease+processes). Defence in depth for
// a downgrade: a token minted at the epoch of a later same-epoch SetMode cannot keep the
// higher mode. Nothing is stored.
func TestEffectiveModeEqualEpochServesTheLowerMode(t *testing.T) {
	for _, tc := range []struct {
		stored, exec, want Mode
	}{
		{ModeLease, ModeLeaseProcesses, ModeLease},
		{ModePerExec, ModeLease, ModePerExec},
		{ModePerExec, ModeLeaseProcesses, ModePerExec},
		{ModeLeaseProcesses, ModeLease, ModeLease},
		{ModeLease, ModePerExec, ModePerExec},
		{ModeLease, ModeLease, ModeLease},
	} {
		p, root := leaseTestPool(t)
		if err := saveLeaseState(root, "k", leaseState{Mode: tc.stored, Epoch: 3, Known: true}); err != nil {
			t.Fatal(err)
		}
		m, err := effectiveMode(t, p, "k", Exec{Mode: tc.exec, ModeEpoch: 3})
		if err != nil || m != tc.want {
			t.Errorf("stored %s, Exec %s at the same epoch: effectiveMode = %v, %v; want %s", tc.stored, tc.exec, m, err, tc.want)
		}
		if s := loadLeaseState(root, "k"); s.Mode != tc.stored || s.Epoch != 3 {
			t.Errorf("stored %s, Exec %s: state = %+v, want it unchanged", tc.stored, tc.exec, s)
		}
	}
}

func TestSetModeRestoresAfterLoss(t *testing.T) {
	p, root := leaseTestPool(t)
	if err := setModeErr(p, "k", ModeLease, 7); err != nil {
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
	if err := setModeErr(p, "k", ModeLease, 7); err != nil {
		t.Fatal(err)
	}
	// SetMode on a run that exists already updates what the run serves from.
	if _, err := effectiveMode(t, p, "k", Exec{Mode: ModeLease, ModeEpoch: 7}); err != nil {
		t.Fatal(err)
	}
	if err := setModeErr(p, "k", ModePerExec, 6); ReasonOf(err) != RefuseStaleMode {
		t.Fatalf("SetMode(epoch 6 after 7) = %v, want %s", err, RefuseStaleMode)
	}
	if err := setModeErr(p, "k", ModePerExec, 8); err != nil {
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
	if _, err := p.SetMode("k", ModeLease, 1); ReasonOf(err) != RefuseLeaseUnsupported {
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

// Plan 4 Task 3: the janitor removes a deleted sandbox's state file. Retiring a cached
// state afterwards must not write it back, neither directly nor through the pool's
// Reclaim on a run that still caches a known state.
func TestRetireDoesNotRecreateARemovedStateFile(t *testing.T) {
	root := t.TempDir()
	s := leaseState{Mode: ModeLease, Epoch: 4, Known: true}
	if err := saveLeaseState(root, "k", s); err != nil {
		t.Fatal(err)
	}
	removeLeaseState(root, "k") // the janitor
	retireLeaseState(root, "k", s)
	if _, err := os.Stat(leaseStatePath(root, "k")); !os.IsNotExist(err) {
		t.Fatalf("retireLeaseState recreated a removed state file: %v", err)
	}

	p, _, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModePerExec, 1)
	mustExec(t, p, "k", Exec{Command: "one", TimeoutS: 30, Mode: ModePerExec, ModeEpoch: 1})
	path := leaseStatePath(p.cfg.WorkspaceRoot, "k")
	if err := os.Remove(path); err != nil { // the janitor, while the run caches the known state
		t.Fatal(err)
	}
	if err := p.Reclaim(t.Context(), "k"); err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("Reclaim recreated a state file the janitor removed: %v", err)
	}
}

// Review #4569829097: a lease live past the janitor's reclaim (a large idle ceiling) ends
// after the janitor removed the deleted sandbox's state file. The end must not write it back:
// no sandbox owns it, and once the record is purged nothing would remove it again.
func TestLeaseEndDoesNotRecreateARemovedStateFile(t *testing.T) {
	for _, end := range []struct {
		name string
		do   func(t *testing.T, p *pool, clk *fakeClock)
	}{
		{"reset", func(t *testing.T, p *pool, _ *fakeClock) {
			if err := p.EndLease("k", LeaseEndReset); err != nil {
				t.Fatalf("EndLease: %v", err)
			}
		}},
		{"idle", func(t *testing.T, p *pool, clk *fakeClock) {
			clk.Advance(31 * time.Second)
			waitFor(t, func() bool { return liveLease(p, "k") == nil })
		}},
	} {
		t.Run(end.name, func(t *testing.T) {
			p, _, clk := leasePool(t, nil)
			mustSetMode(t, p, "k", ModeLease, 1)
			mustExec(t, p, "k", leaseExecIdle(secretCommand, 30*time.Second))
			leaseAlive(t, p, "before the janitor")
			path := leaseStatePath(p.cfg.WorkspaceRoot, "k")
			if err := os.Remove(path); err != nil { // the janitor, under the live lease
				t.Fatal(err)
			}
			end.do(t, p, clk)
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("the lease end recreated a state file the janitor removed: %v", err)
			}
			// The cache follows the disk: nothing known, nothing pending.
			if info := p.LeaseStatus("k"); info.EpochKnown || info.Pending != nil {
				t.Fatalf("LeaseStatus = %+v, want no known epoch and nothing pending", info)
			}
		})
	}
}

// bootLeasePool is New over root, with lease support on or off (the lease-v1 manifest
// feature), closed before it returns: only what New did at boot is left to look at.
func bootLeasePool(t *testing.T, root string, lease bool) {
	t.Helper()
	lc := newFakeLauncher()
	cfg := Config{
		VMM:               lc.Kind(),
		SnapshotDir:       t.TempDir(),
		WorkspaceRoot:     root,
		MaxRuns:           16,
		MaxCommittedBytes: 32 << 30,
	}
	if lease {
		cfg.ManifestFeatures = []string{FeatureLeaseV1}
	}
	p, err := New(cfg, lc, newFakeClock())
	if err != nil {
		t.Fatalf("New (lease %v): %v", lease, err)
	}
	if got := p.(*pool).cfg.LeaseEnabled; got != lease {
		t.Fatalf("LeaseEnabled = %v, want %v", got, lease)
	}
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func bootMarker(t *testing.T, root string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, leaseStateDir, ".boot"))
	if err != nil {
		t.Fatalf("boot marker: %v", err)
	}
	return strings.TrimSpace(string(b))
}

// A per-Exec Exec on a lease-off worker records no root_wrote, so a lease-on boot after
// one cannot trust a known state's root_wrote = false: every known state gets it.
func TestLeaseOffBootMarksRootWrote(t *testing.T) {
	t.Run("off, then on", func(t *testing.T) {
		root := t.TempDir()
		bootLeasePool(t, root, true)
		if m := bootMarker(t, root); m != "lease=on" {
			t.Fatalf("marker after a lease-on boot = %q, want lease=on", m)
		}
		if err := saveLeaseState(root, "k", leaseState{Mode: ModeLease, Epoch: 3, Known: true}); err != nil {
			t.Fatal(err)
		}
		bootLeasePool(t, root, false)
		if m := bootMarker(t, root); m != "lease=off" {
			t.Fatalf("marker after a lease-off boot = %q, want lease=off", m)
		}
		if s := loadLeaseState(root, "k"); s.RootWrote {
			t.Fatalf("a lease-off boot changed the state: %+v", s)
		}
		bootLeasePool(t, root, true)
		if s := loadLeaseState(root, "k"); !s.Known || !s.RootWrote || s.Mode != ModeLease || s.Epoch != 3 {
			t.Fatalf("state after off, then on = %+v, want lease at epoch 3, known, root_wrote", s)
		}
		if m := bootMarker(t, root); m != "lease=on" {
			t.Fatalf("marker = %q, want lease=on", m)
		}
	})
	t.Run("no marker, state files", func(t *testing.T) {
		root := t.TempDir()
		at := time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)
		pending := &LeaseEvent{State: "end", Reason: LeaseEndIdle, At: at, Mode: ModeLease}
		for key, s := range map[string]leaseState{
			"known":   {Mode: ModeLease, Epoch: 3, Known: true},
			"pending": {Pending: pending},
		} {
			if err := saveLeaseState(root, key, s); err != nil {
				t.Fatal(err)
			}
		}
		bootLeasePool(t, root, true)
		if s := loadLeaseState(root, "known"); !s.Known || !s.RootWrote || s.Mode != ModeLease || s.Epoch != 3 {
			t.Fatalf("known state after a boot with no marker = %+v, want root_wrote set, the rest kept", s)
		}
		// Not known: nothing to mark. Its first lease needs SetMode, which sets root_wrote (R7).
		if s := loadLeaseState(root, "pending"); s.Known || s.RootWrote || s.Pending == nil {
			t.Fatalf("pending-only state after a boot with no marker = %+v, want it unchanged", s)
		}
	})
}

func TestLeaseOnBootKeepsState(t *testing.T) {
	root := t.TempDir()
	bootLeasePool(t, root, true)
	want := leaseState{Mode: ModeLeaseProcesses, Epoch: 9, Known: true}
	if err := saveLeaseState(root, "k", want); err != nil {
		t.Fatal(err)
	}
	bootLeasePool(t, root, true)
	if s := loadLeaseState(root, "k"); !reflect.DeepEqual(s, want) {
		t.Fatalf("state after on, then on = %+v, want %+v unchanged", s, want)
	}
	if m := bootMarker(t, root); m != "lease=on" {
		t.Fatalf("marker = %q, want lease=on", m)
	}
}
