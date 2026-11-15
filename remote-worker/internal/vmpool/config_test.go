package vmpool

import (
	"math"
	"strings"
	"testing"
	"time"
)

// good returns the minimum viable Config: the four fields that have no sane
// default because guessing them wrong is a security or capacity bug.
func good() Config {
	return Config{
		VMM:               Firecracker,
		SnapshotDir:       "/srv/snapshots",
		WorkspaceRoot:     "/srv/workspaces",
		MaxRuns:           64,
		MaxCommittedBytes: 32 << 30,
	}
}

func TestNormalizeAppliesSpecDefaults(t *testing.T) {
	c := good()
	if err := c.Normalize(); err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if c.StandbyDepth != DefaultStandbyDepth {
		t.Errorf("StandbyDepth = %d, want %d", c.StandbyDepth, DefaultStandbyDepth)
	}
	if c.GuestRAMBytes != DefaultGuestRAMBytes {
		t.Errorf("GuestRAMBytes = %d, want %d", c.GuestRAMBytes, DefaultGuestRAMBytes)
	}
	if c.StandbyIdle != DefaultStandbyIdle {
		t.Errorf("StandbyIdle = %v, want %v", c.StandbyIdle, DefaultStandbyIdle)
	}
	if c.WorkspaceIdle != DefaultWorkspaceIdle {
		t.Errorf("WorkspaceIdle = %v, want %v", c.WorkspaceIdle, DefaultWorkspaceIdle)
	}
	if c.ReplenishDelay != DefaultReplenishDelay {
		t.Errorf("ReplenishDelay = %v, want %v", c.ReplenishDelay, DefaultReplenishDelay)
	}
	if c.MaxReclaimsPerScan != DefaultMaxReclaimsPerScan {
		t.Errorf("MaxReclaimsPerScan = %d, want %d", c.MaxReclaimsPerScan, DefaultMaxReclaimsPerScan)
	}
	// Spec §4.1: "default StandbyIdle/4" — derived, not a separate constant, so the
	// two cannot drift when StandbyIdle is tuned.
	if want := c.StandbyIdle / 4; c.ReclaimScanInterval != want {
		t.Errorf("ReclaimScanInterval = %v, want StandbyIdle/4 = %v", c.ReclaimScanInterval, want)
	}
}

func TestNormalizeAcceptsFakeVMM(t *testing.T) {
	// FakeVMM is a distinct sentinel, not an alias for a real arm — vmpoolctl is
	// the only caller allowed to select it, but Normalize itself must accept it
	// so that caller can build a valid Config.
	c := good()
	c.VMM = FakeVMM
	if err := c.Normalize(); err != nil {
		t.Fatalf("Normalize rejected FakeVMM: %v", err)
	}
	if c.VMM != FakeVMM {
		t.Fatalf("VMM = %q, want %q", c.VMM, FakeVMM)
	}
}

func TestNormalizeRejects(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*Config)
		want string
	}{
		{"no snapshot dir", func(c *Config) { c.SnapshotDir = "" }, "SnapshotDir"},
		{"no workspace root", func(c *Config) { c.WorkspaceRoot = "" }, "WorkspaceRoot"},
		{"unknown vmm", func(c *Config) { c.VMM = "qemu" }, "VMM"},
		{"no memory budget", func(c *Config) { c.MaxCommittedBytes = 0 }, "MaxCommittedBytes"},
		{"reserve swallows budget", func(c *Config) { c.MemoryReserveBytes = c.MaxCommittedBytes }, "MemoryReserveBytes"},
		{"no run cap", func(c *Config) { c.MaxRuns = 0 }, "MaxRuns"},
		{"RAM outlives disk", func(c *Config) { c.StandbyIdle = time.Hour; c.WorkspaceIdle = time.Minute }, "StandbyIdle"},
		{"scan cannot converge", func(c *Config) { c.ReclaimScanInterval = 10 * time.Minute }, "ReclaimScanInterval"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := good()
			tc.mut(&c)
			err := c.Normalize()
			if err == nil {
				t.Fatalf("Normalize accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not name %q", err, tc.want)
			}
		})
	}
}

// TestLeaseDefaults pins every lease default in plan 2's Global Constraints (spec §4, §6).
func TestLeaseDefaults(t *testing.T) {
	c := good()
	if err := c.Normalize(); err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	for _, tc := range []struct {
		name      string
		got, want time.Duration
	}{
		{"LeaseIdleDefault", c.LeaseIdleDefault, 300 * time.Second},
		{"LeaseIdleCeiling", c.LeaseIdleCeiling, 1800 * time.Second},
		{"LeaseIdleMin", c.LeaseIdleMin, 30 * time.Second},
		{"LeaseMaxDuration", c.LeaseMaxDuration, 8 * time.Hour},
		{"LeaseMaxDurationProcesses", c.LeaseMaxDurationProcesses, 4 * time.Hour},
		{"LeaseGraceLimit", c.LeaseGraceLimit, 30 * time.Minute},
		{"LeaseKeepaliveLoss", c.LeaseKeepaliveLoss, 120 * time.Second},
		{"LeaseScanInterval", c.LeaseScanInterval, 5 * time.Second},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %v, want %v", tc.name, tc.got, tc.want)
		}
	}
	if c.LeaseStartBytes != 192<<20 {
		t.Errorf("LeaseStartBytes = %d, want 192 MiB", c.LeaseStartBytes)
	}
	if c.LeaseHeadroom != 1.25 {
		t.Errorf("LeaseHeadroom = %v, want 1.25", c.LeaseHeadroom)
	}
	if c.LeasePageCacheBytes != 256<<20 {
		t.Errorf("LeasePageCacheBytes = %d, want 256 MiB", c.LeasePageCacheBytes)
	}
	if c.LeaseMaxProcesses != 4 {
		t.Errorf("LeaseMaxProcesses = %d, want 4", c.LeaseMaxProcesses)
	}
	if c.LeaseEnabled {
		t.Error("Normalize set LeaseEnabled: only New may, from VMM and the manifest")
	}

	// The derived reclaim target: 2 x PerVMBytes + max(2 GiB, 2 x (bound - start)),
	// bound = 1.25 x (PerVMBytes + page cache). The 32 MiB overhead is the default.
	for _, tc := range []struct{ guestMiB, wantMiB int64 }{
		{1024, 5008}, // 2x1056 + 2x(1640-192)
		{256, 2624},  // 2x288 + 2048 (the 2 GiB floor binds)
	} {
		c := good()
		c.GuestRAMBytes = tc.guestMiB << 20
		if err := c.Normalize(); err != nil {
			t.Fatal(err)
		}
		if c.LeaseReclaimFreeBytes != tc.wantMiB<<20 {
			t.Errorf("guest %d MiB: LeaseReclaimFreeBytes = %d MiB, want %d MiB",
				tc.guestMiB, c.LeaseReclaimFreeBytes>>20, tc.wantMiB)
		}
	}
	// An explicit value is kept, not re-derived.
	c = good()
	c.LeaseReclaimFreeBytes = 7 << 30
	if err := c.Normalize(); err != nil || c.LeaseReclaimFreeBytes != 7<<30 {
		t.Errorf("explicit LeaseReclaimFreeBytes: %d, %v", c.LeaseReclaimFreeBytes, err)
	}
}

func TestLeaseConfigRefusesWhatItCannotHonour(t *testing.T) {
	for name, mut := range map[string]func(*Config){
		"headroom below 1":      func(c *Config) { c.LeaseHeadroom = 0.5 },
		"headroom NaN":          func(c *Config) { c.LeaseHeadroom = math.NaN() },
		"default above ceiling": func(c *Config) { c.LeaseIdleDefault = 2 * time.Hour },
		"default below floor":   func(c *Config) { c.LeaseIdleDefault = 10 * time.Second },
	} {
		c := good()
		mut(&c)
		if err := c.Normalize(); err == nil || !strings.Contains(err.Error(), "Lease") {
			t.Errorf("%s: Normalize = %v, want a Lease* refusal", name, err)
		}
	}
}

// PR #763 review (F6): two lease timings that cannot work are refused. A keepalive loss
// under two MCP keepalive periods (2 x 30 s, spec §8.3) ends every opted-in lease between
// two keepalives; a lease ticker slower than a quarter of LeaseIdleMin ends idle leases
// late. The bounds themselves are accepted.
func TestLeaseTimingCrossChecks(t *testing.T) {
	for name, mut := range map[string]func(*Config){
		"keepalive loss under two keepalive periods": func(c *Config) { c.LeaseKeepaliveLoss = 59 * time.Second },
		"scan interval above a quarter of idle min":  func(c *Config) { c.LeaseScanInterval = 7*time.Second + 500*time.Millisecond + 1 },
		"scan interval above idle min": func(c *Config) {
			c.LeaseScanInterval = time.Minute
		},
	} {
		c := good()
		mut(&c)
		if err := c.Normalize(); err == nil || !strings.Contains(err.Error(), "Lease") {
			t.Errorf("%s: Normalize = %v, want a Lease* refusal", name, err)
		}
	}
	c := good()
	c.LeaseKeepaliveLoss = 60 * time.Second
	c.LeaseScanInterval = 7*time.Second + 500*time.Millisecond // LeaseIdleMin 30 s / 4
	if err := c.Normalize(); err != nil {
		t.Errorf("keepalive loss 60 s, scan interval 7.5 s: Normalize = %v, want accepted", err)
	}
	// The scan bound follows a configured LeaseIdleMin.
	c = good()
	c.LeaseIdleMin, c.LeaseIdleDefault, c.LeaseIdleCeiling = 4*time.Hour, 4*time.Hour, 4*time.Hour
	c.LeaseScanInterval = time.Hour
	if err := c.Normalize(); err != nil {
		t.Errorf("scan interval 1 h with LeaseIdleMin 4 h: Normalize = %v, want accepted", err)
	}
}

// SH_LEASE_MAX_PROCESSES is bounded by the tracked uids the image has (Task 4's sbxp0..3):
// a higher cap could only fail later, at the guest's uid allocator.
func TestLeaseMaxProcessesBounds(t *testing.T) {
	for _, n := range []int{-1, 5} {
		c := good()
		c.LeaseMaxProcesses = n
		if err := c.Normalize(); err == nil || !strings.Contains(err.Error(), "LeaseMaxProcesses") {
			t.Errorf("LeaseMaxProcesses %d: err = %v, want a refusal naming it", n, err)
		}
	}
	c := good()
	c.LeaseMaxProcesses = 2
	if err := c.Normalize(); err != nil || c.LeaseMaxProcesses != 2 {
		t.Errorf("LeaseMaxProcesses 2: %d, %v", c.LeaseMaxProcesses, err)
	}
}
