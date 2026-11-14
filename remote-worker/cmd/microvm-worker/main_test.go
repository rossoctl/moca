package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/session"
	"github.com/rossoctl/moca/remote-worker/internal/vmpool"
)

func envFrom(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestPoolConfigFromEnvironment(t *testing.T) {
	cfg, err := poolConfig(envFrom(map[string]string{
		"SH_VMM":               "firecracker",
		"SH_SNAPSHOT_DIR":      "/srv/snapshots",
		"SH_WORKSPACE_ROOT":    "/srv/workspaces",
		"SH_STANDBY_DEPTH":     "3",
		"SH_GUEST_RAM_MB":      "512",
		"SH_MAX_RUNS":          "48",
		"SH_MAX_COMMITTED_MB":  "20480",
		"SH_MEMORY_RESERVE_MB": "2048",
	}))
	if err != nil {
		t.Fatalf("poolConfig: %v", err)
	}
	if cfg.VMM != vmpool.Firecracker || cfg.StandbyDepth != 3 || cfg.GuestRAMBytes != 512<<20 {
		t.Fatalf("cfg = %+v", cfg)
	}
	if cfg.MaxRuns != 48 || cfg.MaxCommittedBytes != 20480<<20 || cfg.MemoryReserveBytes != 2048<<20 {
		t.Fatalf("cfg = %+v", cfg)
	}
}

// TestPoolConfigReadsThe644Knobs: SH_STANDBY_HEADROOM accepts "full" (the pre-#644
// full-RAM charge, +Inf) or a number >= 1, and SH_HOST_MEM_FLOOR_MB an optional
// byte floor from MiB. Both are #644's operator surface, and both must refuse a
// value they cannot honour rather than silently running at a default — the same
// posture as WORKER_MAX_CONCURRENT.
func TestPoolConfigReadsThe644Knobs(t *testing.T) {
	base := map[string]string{
		"SH_VMM":              "firecracker",
		"SH_SNAPSHOT_DIR":     "/srv/snapshots",
		"SH_WORKSPACE_ROOT":   "/srv/workspaces",
		"SH_MAX_COMMITTED_MB": "20480",
	}
	for _, tc := range []struct {
		name     string
		env      map[string]string
		headroom float64
		floor    int64
	}{
		{"unset leaves both to the defaults", base, 0, 0},
		{"full restores the legacy charge", with(base, "SH_STANDBY_HEADROOM", "full"), math.Inf(1), 0},
		{"numeric headroom", with(base, "SH_STANDBY_HEADROOM", "2.5"), 2.5, 0},
		{"mem floor", with(base, "SH_HOST_MEM_FLOOR_MB", "4096"), 0, 4096 << 20},
		{"both", with(with(base, "SH_STANDBY_HEADROOM", "8"), "SH_HOST_MEM_FLOOR_MB", "512"), 8, 512 << 20},
	} {
		cfg, err := poolConfig(envFrom(tc.env))
		if err != nil {
			t.Fatalf("%s: poolConfig: %v", tc.name, err)
		}
		if cfg.StandbyHeadroom != tc.headroom {
			t.Errorf("%s: StandbyHeadroom = %v, want %v", tc.name, cfg.StandbyHeadroom, tc.headroom)
		}
		if cfg.HostMemFloorBytes != tc.floor {
			t.Errorf("%s: HostMemFloorBytes = %d, want %d", tc.name, cfg.HostMemFloorBytes, tc.floor)
		}
	}
	// An empty value is "unset" by this file's env() convention, so it is not in the
	// refusal list — everything here is a value the operator clearly meant to set.
	for _, bad := range []string{"0.5", "-1", "abc"} {
		if _, err := poolConfig(envFrom(with(base, "SH_STANDBY_HEADROOM", bad))); err == nil {
			t.Fatalf("SH_STANDBY_HEADROOM=%q was accepted; it must refuse", bad)
		}
	}
	if _, err := poolConfig(envFrom(with(base, "SH_HOST_MEM_FLOOR_MB", "0"))); err == nil {
		t.Fatal("SH_HOST_MEM_FLOOR_MB=0 was accepted; envInt64 refuses non-positive values")
	}
}

// with returns a copy of m carrying k=v, so the table above stays declarative.
func with(m map[string]string, k, v string) map[string]string {
	out := make(map[string]string, len(m)+1)
	for key, val := range m {
		out[key] = val
	}
	out[k] = v
	return out
}

// Spec §6: "KVM unavailable at startup ... Fail the unit at start with an explicit
// message; never fall back to running commands on the host." The strongest form of
// that is having no code path that could: --vmm=fake exists in vmpoolctl and must
// not be reachable here.
func TestThereIsNoHostFallbackLauncher(t *testing.T) {
	get := envFrom(map[string]string{})
	if _, err := launcherFor(vmpool.VMMKind("fake"), get, t.TempDir(), testPerVMBytes); err == nil {
		t.Fatal("launcherFor accepted the host-bash fake — §3.5's privilege argument rests on " +
			"nothing agent-influenced ever executing outside a VM")
	}
	for _, k := range []vmpool.VMMKind{"", "qemu", "gvisor"} {
		if _, err := launcherFor(k, get, t.TempDir(), testPerVMBytes); err == nil {
			t.Fatalf("launcherFor(%q) accepted an unknown VMM", k)
		}
	}
}

// testPerVMBytes stands in for vmpool.PerVMBytes(cfg) in tests that call launcherFor
// directly without going through poolConfig/main — any positive value works for these
// tests, since none of them assert the SPECIFIC memory.max/MemoryMax value reaches the
// launcher (that agreement is asserted at the vmpool package level: see
// TestFirecrackerJailerCgroupMemoryMaxAgreesWithPerVMBytes and
// TestCloudHypervisorSystemdRunScopeAgreesWithPerVMBytes in internal/vmpool). What
// matters here is only that it is > 0, so CHVOptions.validate()/FirecrackerOptions.
// validate() do not refuse the ParentCgroup default launcherFor always sets
// (hardware-corrections D1).
const testPerVMBytes = int64(256 << 20)

// Fix round 3: launcherFor must actually route vmpool.CloudHypervisor to
// NewCloudHypervisorLauncher. Before this, the switch case was a hardcoded "not
// implemented" error, so SH_VMM=cloud-hypervisor failed at worker startup and the
// CH arm — fully implemented and tested inside the vmpool package — was called
// from nothing but its own tests. This call passes no SH_VIRTIOFSD_UID/GID
// override, so a non-nil error here also covers a virtiofsd UID/GID default that
// regressed to 0 (CHVOptions.validate refuses VirtiofsdUID/GID == 0) — in
// particular a regression to copying the Firecracker case's os.Getuid()/
// os.Getgid(), which is 0 on the privileged worker this process actually runs as.
func TestLauncherForWiresCloudHypervisor(t *testing.T) {
	get := envFrom(map[string]string{})
	lc, err := launcherFor(vmpool.CloudHypervisor, get, t.TempDir(), testPerVMBytes)
	if err != nil {
		t.Fatalf("launcherFor(CloudHypervisor): %v", err)
	}
	if lc.Kind() != vmpool.CloudHypervisor {
		t.Fatalf("Kind() = %v, want %v", lc.Kind(), vmpool.CloudHypervisor)
	}
	if lc.SerializesExecsPerRun() {
		t.Fatal("the Cloud Hypervisor arm must not serialize execs per run (spec §4.3): " +
			"virtio-fs makes the host filesystem, not a guest-owned block device, the " +
			"concurrency authority — see TestCloudHypervisorDoesNotSerializeExecsPerRun in " +
			"the vmpool package for the same invariant enforced at the source")
	}
}

// TestLauncherForRefusesAnExplicitZeroVirtiofsdUID guards the SH_VIRTIOFSD_UID
// override path itself, distinct from the built-in-default path covered by
// TestLauncherForWiresCloudHypervisor above: it must reach validation, not be
// silently dropped by some fallback (e.g. a stray os.Getuid()) that would mask an
// explicit 0 override too.
func TestLauncherForRefusesAnExplicitZeroVirtiofsdUID(t *testing.T) {
	get := envFrom(map[string]string{"SH_VIRTIOFSD_UID": "0"})
	if _, err := launcherFor(vmpool.CloudHypervisor, get, t.TempDir(), testPerVMBytes); err == nil {
		t.Fatal("launcherFor(CloudHypervisor) accepted SH_VIRTIOFSD_UID=0 — virtiofsd is " +
			"spec §3.5's confinement boundary and must never run as root")
	}
}

func TestPoolConfigRefusesAMissingSnapshotDir(t *testing.T) {
	_, err := poolConfig(envFrom(map[string]string{
		"SH_VMM":              "firecracker",
		"SH_WORKSPACE_ROOT":   "/srv/workspaces",
		"SH_MAX_COMMITTED_MB": "1024",
	}))
	if err == nil || !strings.Contains(err.Error(), "SH_SNAPSHOT_DIR") {
		t.Fatalf("err = %v, want it to name SH_SNAPSHOT_DIR", err)
	}
}

func TestPoolConfigRefusesAMissingMemoryBudget(t *testing.T) {
	_, err := poolConfig(envFrom(map[string]string{
		"SH_VMM":            "firecracker",
		"SH_SNAPSHOT_DIR":   "/srv/snapshots",
		"SH_WORKSPACE_ROOT": "/srv/workspaces",
	}))
	// Spec §6 makes the memory gate mandatory: without it pressure goes straight to
	// the OOM killer, whose size-ranked favourites include microvm-worker itself.
	if err == nil || !strings.Contains(err.Error(), "SH_MAX_COMMITTED_MB") {
		t.Fatalf("err = %v, want it to name SH_MAX_COMMITTED_MB", err)
	}
}

// Fix-round item 5: the manifest's InstanceType must be verified against the
// running host, additively alongside the existing verify+pin+probe block.

func fixedHost(t string) func(context.Context) string {
	return func(context.Context) string { return t }
}

func TestVerifyInstanceTypeAcceptsAMatch(t *testing.T) {
	get := envFrom(map[string]string{})
	if err := verifyInstanceType(get, "c6i.large", fixedHost("c6i.large")); err != nil {
		t.Fatalf("matching instance types should not be refused: %v", err)
	}
}

func TestVerifyInstanceTypeRefusesAMismatchNamingBothValues(t *testing.T) {
	get := envFrom(map[string]string{})
	err := verifyInstanceType(get, "c6i.large", fixedHost("m5.xlarge"))
	if err == nil {
		t.Fatal("a mismatched instance type must be refused")
	}
	if !strings.Contains(err.Error(), "c6i.large") || !strings.Contains(err.Error(), "m5.xlarge") {
		t.Fatalf("err = %v, want it to name both the manifest and host instance types", err)
	}
}

func TestVerifyInstanceTypeOverrideEnvBypassesAMismatch(t *testing.T) {
	get := envFrom(map[string]string{"SH_ALLOW_INSTANCE_TYPE_MISMATCH": "true"})
	if err := verifyInstanceType(get, "c6i.large", fixedHost("m5.xlarge")); err != nil {
		t.Fatalf("the override env var should bypass a mismatch: %v", err)
	}
}

func TestVerifyInstanceTypeSkipsWhenManifestHasNoRecordedType(t *testing.T) {
	get := envFrom(map[string]string{})
	// An older manifest with no InstanceType recorded: nothing to compare, so this
	// must fail open, not closed.
	if err := verifyInstanceType(get, "", fixedHost("m5.xlarge")); err != nil {
		t.Fatalf("an empty manifest InstanceType must not be refused: %v", err)
	}
}

func TestVerifyInstanceTypeSkipsWhenHostIsUndetectable(t *testing.T) {
	get := envFrom(map[string]string{})
	// No metadata service and no stable host identity available: fail open rather
	// than block every worker's startup on an environment this check cannot reach.
	if err := verifyInstanceType(get, "c6i.large", fixedHost("")); err != nil {
		t.Fatalf("an undetectable host must not be refused: %v", err)
	}
}

// stableHostIdentity itself is exercised only for "never returns empty" -- the
// metadata-service probes need real network access this test suite must not
// depend on, and are covered by design (fail-open on every non-2xx/timeout/error)
// rather than by hitting real cloud endpoints from a unit test.
func TestStableHostIdentityNeverReturnsEmpty(t *testing.T) {
	if got := stableHostIdentity(); got == "" {
		t.Fatal("stableHostIdentity must always return a non-empty fallback")
	}
}

// #306. e11-density.sh's coldAcquireRate is a LATENCY-CLASSIFICATION PROXY: it counts
// Execs whose end-to-end latency exceeded SH_E11_COLD_LATENCY_MS. Measured against
// vmpool.Phases.Cold on the same runs it was wrong by 13x at c=8 (0.76 reported vs 0.056
// true) and by ~250x at c=16. It cannot be repaired by tuning the threshold, because
// Acquire is 0.3% of an Exec -- no threshold on end-to-end latency separates warm from
// cold.
//
// vmpool already maintains the real counters (Stats.WarmAcquires / .ColdAcquires), but
// nothing outside vmpoolctl could ever read them: the worker never exposed Stats at all.
// This is that transport, chosen over parsing SH_DIAG_PHASES log lines because the
// counters are already authoritative and a log format is not a contract.
func TestDiagStatsMuxServesTheRealWarmAndColdCounters(t *testing.T) {
	statsFn := func() vmpool.Stats {
		return vmpool.Stats{
			InFlight:         3,
			StandbysResident: 5,
			WarmAcquires:     4096,
			ColdAcquires: map[vmpool.ColdCause]uint64{
				vmpool.ColdFirstExec: 8,
				vmpool.ColdExhausted: 16,
			},
		}
	}
	srv := httptest.NewServer(diagStatsMux(statsFn, 16))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/stats")
	if err != nil {
		t.Fatalf("GET /stats: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET /stats status = %d, want 200", res.StatusCode)
	}

	var got struct {
		InFlight      int               `json:"inFlight"`
		WarmAcquires  uint64            `json:"warmAcquires"`
		ColdAcquires  map[string]uint64 `json:"coldAcquires"`
		MaxConcurrent int               `json:"maxConcurrent"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.WarmAcquires != 4096 {
		t.Errorf("warmAcquires = %d, want 4096", got.WarmAcquires)
	}
	// Keyed by cause, not just a total: "exhausted" is the one that means replenishment
	// is behind the Exec rate, and it is the only cold cause a density knee can be
	// attributed to. first-exec is a session's unavoidable first restore.
	if got.ColdAcquires["exhausted"] != 16 {
		t.Errorf("coldAcquires[exhausted] = %d, want 16", got.ColdAcquires["exhausted"])
	}
	if got.ColdAcquires["first-exec"] != 8 {
		t.Errorf("coldAcquires[first-exec] = %d, want 8", got.ColdAcquires["first-exec"])
	}
	if got.InFlight != 3 {
		t.Errorf("inFlight = %d, want 3", got.InFlight)
	}
	// #306 step 4. Reported by the WORKER, not recorded by the driver from what it
	// believes it set. Every E11 microVM rung ever recorded swept c to 64 against a
	// 4-slot cap the driver never set and never wrote down, and at every point measured
	// it was MaxConcurrent -- not the pool -- that set throughput. A rung record must
	// not be readable without its slot count, and the only figure that cannot disagree
	// with reality is the one the worker itself is using.
	if got.MaxConcurrent != 16 {
		t.Errorf("maxConcurrent = %d, want 16", got.MaxConcurrent)
	}
}

// The stats listener must NOT be http.DefaultServeMux. This package imports
// _ "net/http/pprof", which registers its handlers on the default mux at import time, so
// serving stats there would mean that enabling counters ALSO served goroutine dumps, heap
// contents and command lines to anyone who can reach the address. #308's reviewer note
// already flagged that exposure for SH_DIAG_PPROF, which is opt-in and documented for it;
// the counters must not smuggle it in behind a different variable.
func TestDiagStatsMuxDoesNotAlsoExposePprof(t *testing.T) {
	srv := httptest.NewServer(diagStatsMux(func() vmpool.Stats { return vmpool.Stats{} }, 4))
	defer srv.Close()

	for _, path := range []string{"/debug/pprof/heap", "/debug/pprof/goroutine", "/debug/pprof/cmdline"} {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s status = %d, want 404 - the stats mux is exposing pprof", path, res.StatusCode)
		}
	}
}

// Issue #305, Task 1.2. session.DefaultConcurrency is 4, and it sizes a FIXED pool of
// goroutines -- one per concurrency slot -- so a worker left at it serves 4 Execs at once
// however many are dispatched. 4 is defensible for the container worker, whose
// worker-deployment.yaml limit is 256Mi and whose per-slot cost is 2 x 8 MiB of stream
// buffer (internal/exec/runner.go's MEMORY BUDGET note: raising slots to 16 would put the
// worst case AT that limit, reinstating an OOMKill a relay can trigger at will). It is
// wrong for this tier: the microVM worker has no pod limit, its memory is gated by the
// MANDATORY SH_MAX_COMMITTED_MB over 256 MiB guests, and 16 slots measured 172.88 Exec/s
// against 62.99 at 4 on the same host -- 2.74x.
//
// So the default belongs per tier, not in the shared library constant.
func TestWorkerMaxConcurrentDefaultsToTheMicrovmTierNotTheLibrary(t *testing.T) {
	got, err := workerMaxConcurrent(envFrom(map[string]string{}))
	if err != nil {
		t.Fatalf("workerMaxConcurrent: %v", err)
	}
	if got != microvmDefaultConcurrency {
		t.Fatalf("default slots = %d, want the microVM tier default %d", got, microvmDefaultConcurrency)
	}
	// The point of the change is that this tier does not inherit the container tier's value.
	// Asserted as the container constant's own value, NOT as `got != session.DefaultConcurrency`:
	// `got` is already pinned to microvmDefaultConcurrency above and that to 16 below, so an
	// inequality check could only ever fire when the CONTAINER constant changes -- and it would
	// then report "the tier default is not in force", which would be false. A future PR raising
	// session.DefaultConcurrency to 16 (this PR's body sketches the precondition: raising
	// worker-deployment.yaml's memory limit) would make the two numerically equal while the
	// per-tier default is still perfectly in force.
	if session.DefaultConcurrency != 4 {
		t.Fatalf("session.DefaultConcurrency = %d, want 4: the container tier's default moved, so this "+
			"test's premise (the two tiers differ, and 256Mi funds only 4 slots' stream buffers) needs re-deriving",
			session.DefaultConcurrency)
	}
	// 16 is the largest slot count actually MEASURED (172.88 Exec/s). Anything above it is
	// an extrapolation, and finding where slots stop paying is its own sweep (Task 1.3), so
	// the default must not wander past the evidence.
	if microvmDefaultConcurrency != 16 {
		t.Fatalf("microvmDefaultConcurrency = %d; 16 is the largest measured slot count, so a change needs its own measurement", microvmDefaultConcurrency)
	}
}

func TestWorkerMaxConcurrentHonoursTheEnvironment(t *testing.T) {
	got, err := workerMaxConcurrent(envFrom(map[string]string{"WORKER_MAX_CONCURRENT": "32"}))
	if err != nil {
		t.Fatalf("workerMaxConcurrent: %v", err)
	}
	if got != 32 {
		t.Fatalf("slots = %d, want 32", got)
	}
}

// The pre-existing inline form was `if v, e := envInt64(...); e == nil { maxConcurrent = int(v) }`,
// which DISCARDED the error: WORKER_MAX_CONCURRENT=abc silently ran at 4 slots. That is the
// same silent fallback e11-density.sh now refuses, and it is worse here, because the whole
// campaign turns on knowing a run's slot count. A malformed value must refuse.
func TestWorkerMaxConcurrentRefusesAMalformedValueInsteadOfSilentlyUsingTheDefault(t *testing.T) {
	for _, bad := range []string{"abc", "0", "-1", "4.5", "16 32", " "} {
		got, err := workerMaxConcurrent(envFrom(map[string]string{"WORKER_MAX_CONCURRENT": bad}))
		if err == nil {
			t.Fatalf("WORKER_MAX_CONCURRENT=%q was accepted as %d slots; it must refuse", bad, got)
		}
		if !strings.Contains(err.Error(), "WORKER_MAX_CONCURRENT") {
			t.Fatalf("WORKER_MAX_CONCURRENT=%q: error %q does not name the variable", bad, err)
		}
	}
}

// #313 review, updated by #644. The slot count's arithmetic is now the RUNNING
// component of the admission charge — N slots x PerVMBytes — because paused
// standbys are charged at dirty-page cost and evict rather than fail. Since #644
// the pool re-prices a standby at full cost when it is popped (admitPromotionLocked),
// so a host whose slots x PerVMBytes outrun the budget refuses warm acquires —
// failed execs — as the slot count fills, and an operator who sized
// SH_MAX_COMMITTED_MB for fewer slots must be told at startup, not discover it as
// exec errors under load.
func TestSlotBudgetWarningFiresOnlyWhenTheSlotCountOutrunsTheBudget(t *testing.T) {
	// 256 MiB guest + 32 MiB overhead = 288 MiB per VM.
	base := vmpool.Config{
		VMM: vmpool.Firecracker, SnapshotDir: "/srv/snapshots", WorkspaceRoot: "/srv/workspaces",
		GuestRAMBytes: 256 << 20, StandbyDepth: 2, MaxRuns: 64,
	}

	// The shipped unit's 24576 MiB funds 85 running VMs; 16 slots need 16. Silent.
	fits := base
	fits.MaxCommittedBytes = 24576 << 20
	if w := slotBudgetWarning(fits, 16); w != "" {
		t.Fatalf("16 slots inside the shipped budget must not warn, got: %s", w)
	}

	// An operator-sized dev box: 2048 MiB funds 7 running VMs, and 16 slots want 16.
	tight := base
	tight.MaxCommittedBytes = 2048 << 20
	w := slotBudgetWarning(tight, 16)
	if w == "" {
		t.Fatal("16 slots against a 2048 MiB budget must warn: the overflow arrives as failed Execs")
	}
	// The numbers an operator needs to act are the point of the message, not the wording.
	for _, want := range []string{"16 concurrency slots", "4608 MiB", "2048 MiB", "WORKER_MAX_CONCURRENT"} {
		if !strings.Contains(w, want) {
			t.Errorf("warning omits %q, so it cannot be acted on: %s", want, w)
		}
	}

	// Non-vacuousness for the budget arithmetic: the SAME tight budget is fine at 4 slots
	// (1152 MiB)... still over 2048, so use a budget that funds 4 but not 16.
	mid := base
	mid.MaxCommittedBytes = 4096 << 20 // 14 running VMs: covers 4 slots, not 16
	if w := slotBudgetWarning(mid, 4); w != "" {
		t.Fatalf("4 slots inside a 4096 MiB budget must not warn, got: %s", w)
	}
	if slotBudgetWarning(mid, 16) == "" {
		t.Fatal("16 slots against the same 4096 MiB budget must warn -- that IS the default change")
	}

	// MemoryReserveBytes is part of the budget, not beside it.
	reserved := fits
	reserved.MemoryReserveBytes = 24000 << 20
	if slotBudgetWarning(reserved, 16) == "" {
		t.Fatal("the reserve must be subtracted from the budget before comparing")
	}
}

// TestStandbyHeadroomLabel: the banner spells +Inf as "full" and resolves the
// unset 0 to the default, because a rung record is not readable without knowing
// which charge model priced its standbys (#644).
func TestStandbyHeadroomLabel(t *testing.T) {
	if got := standbyHeadroomLabel(vmpool.Config{}); got != "4" {
		t.Fatalf("label for unset headroom = %q, want the resolved default \"4\"", got)
	}
	if got := standbyHeadroomLabel(vmpool.Config{StandbyHeadroom: 2.5}); got != "2.5" {
		t.Fatalf("label for 2.5 = %q, want \"2.5\"", got)
	}
	if got := standbyHeadroomLabel(vmpool.Config{StandbyHeadroom: math.Inf(1)}); got != "full" {
		t.Fatalf("label for +Inf = %q, want \"full\"", got)
	}
}

func baseEnv(extra map[string]string) func(string) string {
	m := map[string]string{
		"SH_VMM":              "firecracker",
		"SH_SNAPSHOT_DIR":     "/srv/snapshots",
		"SH_WORKSPACE_ROOT":   "/srv/workspaces",
		"SH_MAX_COMMITTED_MB": "20480",
	}
	for k, v := range extra {
		m[k] = v
	}
	return envFrom(m)
}

// #338: the 30-minute default reclaims an idle human-in-the-loop session's workspace. The
// knob lets a deployment choose a longer lifetime; unset must keep today's behaviour.
func TestPoolConfigReadsWorkspaceIdle(t *testing.T) {
	cfg, err := poolConfig(baseEnv(map[string]string{"SH_WORKSPACE_IDLE": "8h"}))
	if err != nil {
		t.Fatalf("poolConfig: %v", err)
	}
	if cfg.WorkspaceIdle != 8*time.Hour {
		t.Fatalf("WorkspaceIdle = %v, want 8h", cfg.WorkspaceIdle)
	}
}

func TestPoolConfigLeavesWorkspaceIdleToTheDefaultWhenUnset(t *testing.T) {
	cfg, err := poolConfig(baseEnv(nil))
	if err != nil {
		t.Fatalf("poolConfig: %v", err)
	}
	if err := cfg.Normalize(); err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if cfg.WorkspaceIdle != vmpool.DefaultWorkspaceIdle {
		t.Fatalf("WorkspaceIdle = %v, want the default %v", cfg.WorkspaceIdle, vmpool.DefaultWorkspaceIdle)
	}
}

func TestPoolConfigRefusesABadWorkspaceIdle(t *testing.T) {
	for _, v := range []string{"8", "soon", "0s", "-1h"} {
		_, err := poolConfig(baseEnv(map[string]string{"SH_WORKSPACE_IDLE": v}))
		if err == nil || !strings.Contains(err.Error(), "SH_WORKSPACE_IDLE") {
			t.Fatalf("SH_WORKSPACE_IDLE=%q: err = %v, want a refusal naming the variable", v, err)
		}
	}
}

// A workspace lifetime shorter than the standby lifetime inverts spec §4.4's "RAM is urgent and
// disk is not". poolConfig accepts the value; Normalize must refuse it.
func TestAWorkspaceIdleBelowStandbyIdleIsRefusedAtNormalize(t *testing.T) {
	cfg, err := poolConfig(baseEnv(map[string]string{"SH_WORKSPACE_IDLE": "60s"}))
	if err != nil {
		t.Fatalf("poolConfig: %v", err)
	}
	if err := cfg.Normalize(); err == nil || !strings.Contains(err.Error(), "WorkspaceIdle") {
		t.Fatalf("Normalize err = %v, want the StandbyIdle < WorkspaceIdle refusal", err)
	}
}

// TestPoolConfigLeaseEnv: every SH_LEASE_* knob is read into its Config field, unset leaves
// the field zero for Normalize to default, and a malformed value refuses to start rather
// than running at the default -- the WORKER_MAX_CONCURRENT posture.
func TestPoolConfigLeaseEnv(t *testing.T) {
	cfg, err := poolConfig(baseEnv(map[string]string{
		"SH_LEASE_IDLE_DEFAULT_S":    "600",
		"SH_LEASE_IDLE_CEILING_S":    "3600",
		"SH_LEASE_MAX_DURATION_S":    "7200",
		"SH_LEASE_MAX_DURATION_L2_S": "3600",
		"SH_LEASE_GRACE_S":           "900",
		"SH_LEASE_KEEPALIVE_LOSS_S":  "90",
		"SH_LEASE_START_MB":          "128",
		"SH_LEASE_HEADROOM":          "1.5",
		"SH_LEASE_PAGECACHE_MB":      "512",
		"SH_LEASE_RECLAIM_FREE_MB":   "4096",
	}))
	if err != nil {
		t.Fatalf("poolConfig: %v", err)
	}
	for _, tc := range []struct {
		name      string
		got, want time.Duration
	}{
		{"LeaseIdleDefault", cfg.LeaseIdleDefault, 600 * time.Second},
		{"LeaseIdleCeiling", cfg.LeaseIdleCeiling, 3600 * time.Second},
		{"LeaseMaxDuration", cfg.LeaseMaxDuration, 2 * time.Hour},
		{"LeaseMaxDurationProcesses", cfg.LeaseMaxDurationProcesses, time.Hour},
		{"LeaseGraceLimit", cfg.LeaseGraceLimit, 15 * time.Minute},
		{"LeaseKeepaliveLoss", cfg.LeaseKeepaliveLoss, 90 * time.Second},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %v, want %v", tc.name, tc.got, tc.want)
		}
	}
	if cfg.LeaseStartBytes != 128<<20 || cfg.LeasePageCacheBytes != 512<<20 || cfg.LeaseReclaimFreeBytes != 4096<<20 {
		t.Errorf("byte knobs = start %d, pagecache %d, reclaim %d", cfg.LeaseStartBytes, cfg.LeasePageCacheBytes, cfg.LeaseReclaimFreeBytes)
	}
	if cfg.LeaseHeadroom != 1.5 {
		t.Errorf("LeaseHeadroom = %v, want 1.5", cfg.LeaseHeadroom)
	}

	unset, err := poolConfig(baseEnv(nil))
	if err != nil {
		t.Fatalf("poolConfig: %v", err)
	}
	if unset.LeaseIdleDefault != 0 || unset.LeaseHeadroom != 0 || unset.LeaseReclaimFreeBytes != 0 {
		t.Errorf("unset SH_LEASE_* must leave the fields to Normalize: %+v", unset)
	}

	for k, bad := range map[string]string{
		"SH_LEASE_IDLE_DEFAULT_S":    "5m",
		"SH_LEASE_IDLE_CEILING_S":    "0",
		"SH_LEASE_MAX_DURATION_S":    "-1",
		"SH_LEASE_MAX_DURATION_L2_S": "abc",
		"SH_LEASE_GRACE_S":           "1.5",
		"SH_LEASE_KEEPALIVE_LOSS_S":  " ",
		"SH_LEASE_START_MB":          "0",
		"SH_LEASE_HEADROOM":          "0.9",
		"SH_LEASE_PAGECACHE_MB":      "lots",
		"SH_LEASE_RECLAIM_FREE_MB":   "-5",
	} {
		_, err := poolConfig(baseEnv(map[string]string{k: bad}))
		if err == nil {
			t.Errorf("%s=%q was accepted; it must refuse", k, bad)
			continue
		}
		if !strings.Contains(err.Error(), k) {
			t.Errorf("%s=%q: error %q does not name the variable", k, bad, err)
		}
	}
	if _, err := poolConfig(baseEnv(map[string]string{"SH_LEASE_HEADROOM": "NaN"})); err == nil {
		t.Error("SH_LEASE_HEADROOM=NaN was accepted")
	}
}

// M6 (plan 4): the relay gives reset and set_mode 31 min, the default grace plus 60 s,
// and a downgrade or reset waits up to the grace limit. A grace above 1800 s would let the
// relay fail a call the worker is still running, so it is refused at boot, naming why.
func TestGraceAboveRelayTimeoutRefused(t *testing.T) {
	for _, v := range []string{"1801", "3600"} {
		_, err := poolConfig(baseEnv(map[string]string{"SH_LEASE_GRACE_S": v}))
		if err == nil {
			t.Errorf("SH_LEASE_GRACE_S=%s was accepted; it must refuse", v)
			continue
		}
		for _, want := range []string{"SH_LEASE_GRACE_S", "1800", "31 min"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("SH_LEASE_GRACE_S=%s: error %q lacks %q", v, err, want)
			}
		}
	}
	cfg, err := poolConfig(baseEnv(map[string]string{"SH_LEASE_GRACE_S": "1800"}))
	if err != nil || cfg.LeaseGraceLimit != 30*time.Minute {
		t.Fatalf("SH_LEASE_GRACE_S=1800: LeaseGraceLimit %v, err %v; want 30m accepted", cfg.LeaseGraceLimit, err)
	}
}

// PR #763 review (F5): a value that would overflow its conversion is refused, never
// wrapped: SH_LEASE_GRACE_S=10000000000 once wrapped to a negative Duration that
// Normalize then silently replaced with the default. The largest values that convert
// exactly are accepted, except SH_LEASE_GRACE_S, which M6 bounds far lower
// (TestGraceAboveRelayTimeoutRefused).
func TestPoolConfigLeaseEnvRefusesOverflow(t *testing.T) {
	maxS := math.MaxInt64 / int64(time.Second)
	maxMB := int64(math.MaxInt64 >> 20)
	seconds := []string{"SH_LEASE_IDLE_DEFAULT_S", "SH_LEASE_IDLE_CEILING_S", "SH_LEASE_MAX_DURATION_S",
		"SH_LEASE_MAX_DURATION_L2_S", "SH_LEASE_GRACE_S", "SH_LEASE_KEEPALIVE_LOSS_S"}
	mib := []string{"SH_LEASE_START_MB", "SH_LEASE_PAGECACHE_MB", "SH_LEASE_RECLAIM_FREE_MB"}
	for _, tc := range []struct {
		keys []string
		over string
	}{
		{seconds, strconv.FormatInt(maxS+1, 10)},
		{seconds, "10000000000"},
		{mib, strconv.FormatInt(maxMB+1, 10)},
	} {
		for _, k := range tc.keys {
			_, err := poolConfig(baseEnv(map[string]string{k: tc.over}))
			if err == nil || !strings.Contains(err.Error(), k) {
				t.Errorf("%s=%s: err = %v, want a refusal naming the variable", k, tc.over, err)
			}
		}
	}
	env := map[string]string{}
	for _, k := range seconds {
		if k != "SH_LEASE_GRACE_S" {
			env[k] = strconv.FormatInt(maxS, 10)
		}
	}
	for _, k := range mib {
		env[k] = strconv.FormatInt(maxMB, 10)
	}
	var cfg vmpool.Config
	if err := leaseConfig(baseEnv(env), &cfg); err != nil {
		t.Fatalf("the largest exact values: leaseConfig = %v, want accepted", err)
	}
	if want := time.Duration(maxS) * time.Second; cfg.LeaseMaxDuration != want || cfg.LeaseKeepaliveLoss != want {
		t.Errorf("LeaseMaxDuration %v, LeaseKeepaliveLoss %v, want %v", cfg.LeaseMaxDuration, cfg.LeaseKeepaliveLoss, want)
	}
	if want := maxMB << 20; cfg.LeaseStartBytes != want || cfg.LeaseReclaimFreeBytes != want {
		t.Errorf("LeaseStartBytes %d, LeaseReclaimFreeBytes %d, want %d", cfg.LeaseStartBytes, cfg.LeaseReclaimFreeBytes, want)
	}
}

func TestLeaseBannerReportsResolvedValues(t *testing.T) {
	cfg, err := poolConfig(baseEnv(nil))
	if err != nil {
		t.Fatal(err)
	}
	off := leaseBanner(cfg)
	if !strings.Contains(off, "lease=off") {
		t.Errorf("banner without lease-v1 = %q, want lease=off", off)
	}
	cfg.ManifestFeatures = []string{vmpool.FeatureLeaseV1}
	on := leaseBanner(cfg)
	for _, want := range []string{"lease=on", "lease_idle=5m0s/30m0s", "lease_max=8h0m0s/4h0m0s", "lease_start=192MiB", "lease_reclaim_free=2624MiB"} {
		if !strings.Contains(on, want) {
			t.Errorf("banner %q lacks %q", on, want)
		}
	}
}

// A lease-v1 snapshot without the reporting balloon still serves leases, but the guest
// never returns freed pages, so measured charge follows peaks (spec §6): warn, never refuse.
func TestBalloonWarningOnlyForALeaseImageWithoutTheBalloon(t *testing.T) {
	for _, tc := range []struct {
		name     string
		features []string
		warn     bool
	}{
		{"no features", nil, false},
		{"lease-v1 and balloon-fpr-v1", []string{vmpool.FeatureLeaseV1, vmpool.FeatureBalloonFPRV1}, false},
		{"balloon-fpr-v1 alone", []string{vmpool.FeatureBalloonFPRV1}, false},
		{"lease-v1 alone", []string{vmpool.FeatureLeaseV1}, true},
	} {
		w := balloonWarning(tc.features)
		if (w != "") != tc.warn {
			t.Errorf("%s: balloonWarning = %q, want warning=%v", tc.name, w, tc.warn)
			continue
		}
		if tc.warn {
			for _, want := range []string{"WARNING", "lease-v1", "balloon-fpr-v1", "peak"} {
				if !strings.Contains(w, want) {
					t.Errorf("%s: warning %q lacks %q", tc.name, w, want)
				}
			}
		}
	}
}

// The lease fields are omitempty: a worker that never served a lease (every per-Exec
// worker) serves /stats with exactly the keys it served before lease mode existed, and a
// lease worker reports its lease VMs, their commitment and its ends by reason.
func TestDiagStatsLeaseFieldsOnlyWhenLeasesExist(t *testing.T) {
	leaseKeys := []string{"leaseVMs", "leaseExecuting", "leaseCommittedBytes", "leaseEnds"}
	b, err := json.Marshal(toDiagStats(vmpool.Stats{LeaseEnds: map[vmpool.LeaseEndReason]uint64{}}, 4))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, k := range leaseKeys {
		if strings.Contains(string(b), `"`+k+`"`) {
			t.Errorf("per-Exec /stats carries %q: %s", k, b)
		}
	}

	b, err = json.Marshal(toDiagStats(vmpool.Stats{
		LeaseVMs: 2, LeaseExecuting: 1, LeaseCommittedBytes: 384 << 20,
		LeaseEnds: map[vmpool.LeaseEndReason]uint64{vmpool.LeaseEndIdle: 3},
	}, 4))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got struct {
		LeaseVMs            int               `json:"leaseVMs"`
		LeaseExecuting      int               `json:"leaseExecuting"`
		LeaseCommittedBytes int64             `json:"leaseCommittedBytes"`
		LeaseEnds           map[string]uint64 `json:"leaseEnds"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.LeaseVMs != 2 || got.LeaseExecuting != 1 || got.LeaseCommittedBytes != 384<<20 || got.LeaseEnds["idle"] != 3 {
		t.Fatalf("lease /stats = %+v, want 2, 1, %d, idle 3", got, 384<<20)
	}
}

// TestSettleSweepWaitsForHeldJailsBeforeTheProbe pins #797's wait between the orphan sweep and
// Probe: after a sweep that removed anything, the worker asks whether any jail's API socket is
// still held, with sweptJailWait as the bound, and goes on only when none is.
func TestSettleSweepWaitsForHeldJailsBeforeTheProbe(t *testing.T) {
	var asked []time.Duration
	free := func(d time.Duration) []string { asked = append(asked, d); return nil }
	if err := settleSweep(vmpool.SweepResult{Swept: 1}, free); err != nil {
		t.Fatalf("settleSweep: %v", err)
	}
	if len(asked) != 1 || asked[0] != sweptJailWait {
		t.Fatalf("held jails asked with %v, want once with sweptJailWait (%s)", asked, sweptJailWait)
	}

	// A sweep that removed nothing killed nothing, so there is nothing to wait for.
	asked = nil
	if err := settleSweep(vmpool.SweepResult{Skipped: []string{"microvm-worker.service"}}, free); err != nil {
		t.Fatalf("settleSweep after an empty sweep: %v", err)
	}
	if len(asked) != 0 {
		t.Fatalf("held jails asked %d time(s) after a sweep that removed nothing", len(asked))
	}
}

// TestSettleSweepFailsTheStartNamingWhatIsStillHeld: a VMM still answering when the wait ends,
// or a cgroup whose process outlived the sweep's SIGKILL, fails the start with a line naming it,
// rather than letting Probe collide with it.
func TestSettleSweepFailsTheStartNamingWhatIsStillHeld(t *testing.T) {
	held := func(time.Duration) []string { return []string{"vm-1"} }
	err := settleSweep(vmpool.SweepResult{Swept: 1}, held)
	if err == nil || !strings.Contains(err.Error(), "vm-1") {
		t.Fatalf("settleSweep with vm-1 still held = %v, want an error naming vm-1", err)
	}

	asked := false
	err = settleSweep(vmpool.SweepResult{Swept: 1, Stuck: []string{"pool-0"}},
		func(time.Duration) []string { asked = true; return nil })
	if err == nil || !strings.Contains(err.Error(), "pool-0") {
		t.Fatalf("settleSweep with pool-0 stuck = %v, want an error naming pool-0", err)
	}
	if asked {
		t.Fatal("settleSweep waited on jails after a stuck cgroup, which already fails the start")
	}
}
