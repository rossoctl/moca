package vmpool

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The worker's lease gates (spec §9; plan 2, Task 9). Plan 1's lease gates
// (gates_lease_kvm_test.go) drive one VM through the launcher; these drive the POOL's
// lease path -- SetMode, lease Execs, the lease ticker, EndLease, reclaim, Close -- over
// the real Firecracker launcher, as the worker builds it: ManifestFeatures and guest RAM
// from the snapshot's manifest (cmd/microvm-worker/main.go), and every VM in a pooled
// cgroup, so LeaseCgroup, LeaseBytes and the lease cgroup's removal are the production
// code. The pooled cgroups live under a parent private to each gate
// (leaseGateCgroupParent), never under the worker's own slice: a rig may be serving
// sandboxes from microvm.slice/microvm-vms.slice while these run, and the cgroup pool
// names its directories pool-<n> from zero in every process.
//
// Every gate calls requireKVM, then (through newLeaseGate) requireLeaseSnapshot, so
// without /dev/kvm or without a lease-v1 snapshot it skips as NOT RUN, as plan 1's do.
// MemAvailable is pinned high in every gate (plentyOfHostMemory): reclaim for the host's
// own free memory is unit-tested (lease_reclaim_test.go) and must not end a lease here
// because the rig happens to be busy.

// leaseGate is one lease-enabled pool over the real Firecracker launcher.
type leaseGate struct {
	p   *pool
	lc  Launcher
	cfg Config // as given to New, so a restart builds the next pool from the same one
}

// leaseGateSeq makes each gate's cgroup parent name unique within the process.
var leaseGateSeq atomic.Int64

// newLeaseGate builds a lease-enabled pool. tweak adjusts the Config before New; the lease
// ticker runs every second unless tweak says otherwise, so a due end is seen promptly.
func newLeaseGate(t *testing.T, tweak func(*Config)) *leaseGate {
	t.Helper()
	return newLeaseGateWith(t, tweak, nil)
}

// newLeaseGateWith is newLeaseGate with wrap, when non-nil, turning the Firecracker
// launcher into the one the pool uses (TestGateLeaseOwnership records every Command).
func newLeaseGateWith(t *testing.T, tweak func(*Config), wrap func(*firecrackerLauncher) Launcher) *leaseGate {
	t.Helper()
	snapshotDir, man := requireLeaseSnapshot(t)
	plentyOfHostMemory(t)
	guestRAM := man.GuestRAMMB << 20
	if guestRAM <= 0 {
		guestRAM = DefaultGuestRAMBytes
	}
	cfg := Config{
		VMM:               Firecracker,
		SnapshotDir:       t.TempDir(),
		WorkspaceRoot:     sameDeviceSiblingDir(t, snapshotDir), // see poolFor
		GuestRAMBytes:     guestRAM,
		MaxRuns:           8,
		MaxCommittedBytes: 32 << 30,
		ManifestFeatures:  man.Features,
		LeaseScanInterval: time.Second,
	}
	if tweak != nil {
		tweak(&cfg)
	}
	// The cgroup bound is PerVMBytes of the NORMALIZED Config, as the worker computes it
	// (VMOverheadBytes is filled by Normalize).
	norm := cfg
	if err := norm.Normalize(); err != nil {
		t.Fatalf("Config: %v", err)
	}
	parent := leaseGateCgroupParent(t)
	base := fcLauncherWith(t, func(o *FirecrackerOptions) {
		o.ParentCgroup = parent
		o.CgroupMemoryMaxBytes = PerVMBytes(norm)
	})
	var lc Launcher = base
	if wrap != nil {
		fl, ok := base.(*firecrackerLauncher)
		if !ok {
			t.Fatalf("fcLauncher returned a %T", base)
		}
		lc = wrap(fl)
	}
	g := &leaseGate{lc: lc, cfg: cfg}
	g.p = g.newPool(t)
	if !g.p.cfg.LeaseEnabled {
		t.Fatalf("LeaseEnabled is false with VMM %s and features %v", cfg.VMM, cfg.ManifestFeatures)
	}
	return g
}

func (g *leaseGate) newPool(t *testing.T) *pool {
	t.Helper()
	p, err := New(g.cfg, g.lc, RealClock())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p.(*pool)
}

// restart closes the pool, runs between (when non-nil), and builds the next pool over the
// same Config, launcher and workspace root: a worker restart.
func (g *leaseGate) restart(t *testing.T, between func()) *leaseGate {
	t.Helper()
	if err := g.p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if between != nil {
		between()
	}
	next := *g
	next.p = g.newPool(t)
	return &next
}

// leaseGateCgroupParent creates a cgroup for one gate's pooled VM cgroups, enables the
// memory controller for its children, and removes it (and the pool's idle cgroups under
// it) when the test ends. Slice-relative, as jailer's --parent-cgroup must be. Its base is
// SH_LEASE_GATE_CGROUP_BASE, slice-relative, default the cgroup root: a top-level cgroup
// is outside every systemd slice, so nothing the gates do is charged to the worker's.
func leaseGateCgroupParent(t *testing.T) string {
	t.Helper()
	rel := filepath.Join(os.Getenv("SH_LEASE_GATE_CGROUP_BASE"),
		fmt.Sprintf("moca-lease-gate-%d-%d", os.Getpid(), leaseGateSeq.Add(1)))
	if err := ValidateParentCgroup(rel); err != nil {
		t.Fatalf("SH_LEASE_GATE_CGROUP_BASE: %v", err)
	}
	dir := ParentCgroupPath(rel)
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatalf("create the gate's cgroup parent %s (the gates run as root on a cgroup v2 host; "+
			"SH_LEASE_GATE_CGROUP_BASE picks where): %v", dir, err)
	}
	t.Cleanup(func() { removeLeaseGateCgroup(t, dir) })
	if err := os.WriteFile(filepath.Join(dir, "cgroup.subtree_control"), []byte("+memory"), 0o644); err != nil {
		t.Fatalf("enable the memory controller under %s (is it enabled in the base's "+
			"cgroup.subtree_control?): %v", dir, err)
	}
	return rel
}

// removeLeaseGateCgroup removes the gate's cgroup parent once its pool has closed. A
// process still inside a child is a leaked VM: reported, then killed through the cgroup.
func removeLeaseGateCgroup(t *testing.T, dir string) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Logf("cleanup %s: %v", dir, err)
		return
	}
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		sub := filepath.Join(dir, e.Name())
		if pids, _ := readCgroupProcs(filepath.Join(sub, "cgroup.procs")); len(pids) > 0 {
			t.Errorf("%d process(es) %v still in %s after the pool closed: a VM leaked", len(pids), pids, sub)
			_ = os.WriteFile(filepath.Join(sub, "cgroup.kill"), []byte("1"), 0o644)
			time.Sleep(time.Second)
		}
		if err := removeCgroupDir(sub); err != nil {
			t.Logf("cleanup: %v", err)
		}
	}
	if err := removeCgroupDir(dir); err != nil {
		t.Logf("cleanup: %v", err)
	}
}

// gateLease is a lease Exec at epoch, with a timeout comfortably above any command here.
func gateLease(cmd string, epoch uint64) Exec {
	return Exec{Command: cmd, TimeoutS: 60, Mode: ModeLease, ModeEpoch: epoch}
}

// exec runs e on key and returns its result, stdout and stderr.
func (g *leaseGate) exec(key string, e Exec) (Result, string, string, error) {
	var out capturingSink
	res, err := g.p.Exec(context.Background(), key, e, &out)
	out.mu.Lock()
	stderr := out.stderr.String()
	out.mu.Unlock()
	return res, out.out(), stderr, err
}

// run is exec for an Exec that must succeed: no error, exit 0 and a clean teardown.
func (g *leaseGate) run(t *testing.T, key string, e Exec) string {
	t.Helper()
	res, stdout, stderr, err := g.exec(key, e)
	if err != nil {
		t.Fatalf("Exec %.80q on %s: %v", e.Command, key, err)
	}
	if res.ExitCode != 0 || res.TeardownFailed {
		t.Fatalf("Exec %.80q on %s: exit %d, teardown_failed %v, stdout %q, stderr %q",
			e.Command, key, res.ExitCode, res.TeardownFailed, stdout, stderr)
	}
	return stdout
}

// leaseVM returns key's live lease VM, failing when there is none.
func (g *leaseGate) leaseVM(t *testing.T, key string) *firecrackerVM {
	t.Helper()
	l := liveLease(g.p, key)
	if l == nil {
		t.Fatalf("%s has no live lease", key)
	}
	switch v := l.vm.(type) {
	case *firecrackerVM:
		return v
	case *leaseCmdRecordingVM:
		return v.firecrackerVM
	}
	t.Fatalf("%s's lease VM is a %T, want a Firecracker VM", key, l.vm)
	return nil
}

// waitLeaseGone polls key's status until it reports no lease, failing after within. It
// returns how long that took.
func (g *leaseGate) waitLeaseGone(t *testing.T, key string, within time.Duration) time.Duration {
	t.Helper()
	start := time.Now()
	for g.p.LeaseStatus(key).State != LeaseNone {
		if time.Since(start) > within {
			t.Fatalf("%s's lease still live %s later", key, within)
		}
		time.Sleep(100 * time.Millisecond)
	}
	return time.Since(start)
}

func leaseEndTotal(s Stats) uint64 {
	var n uint64
	for _, v := range s.LeaseEnds {
		n += v
	}
	return n
}

// leaseVMTrace is what a lease VM holds on the host while it lives: what its end must
// remove.
type leaseVMTrace struct {
	id, cgroup, jail, apiSock, vsock string
	pid                              int
	comm                             string
}

// trace records key's live lease VM, and checks each artifact exists now -- the positive
// control, without which "gone later" proves nothing -- and that the cgroup is the lease
// one: memory.max raised to PerVMBytes + LeasePageCacheBytes.
func (g *leaseGate) trace(t *testing.T, key string) leaseVMTrace {
	t.Helper()
	v := g.leaseVM(t, key)
	if v.cgroups == nil || v.cgroupRel == "" || v.cmd == nil || v.cmd.Process == nil {
		t.Fatalf("lease VM %s has no pooled cgroup or no process", v.id)
	}
	tr := leaseVMTrace{
		id: v.id, cgroup: v.cgroups.abs(v.cgroupRel), jail: v.jailRoot,
		apiSock: v.apiSockHost, vsock: v.vsockHostPath, pid: v.cmd.Process.Pid,
	}
	for _, p := range []string{tr.cgroup, tr.jail, tr.apiSock, tr.vsock} {
		if _, err := os.Lstat(p); err != nil {
			t.Fatalf("live lease VM %s: %v", tr.id, err)
		}
	}
	comm, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", tr.pid))
	if err != nil {
		t.Fatalf("live lease VM %s: its VMM pid %d: %v", tr.id, tr.pid, err)
	}
	tr.comm = strings.TrimSpace(string(comm))
	want := PerVMBytes(g.p.cfg) + g.p.cfg.LeasePageCacheBytes
	if b, err := os.ReadFile(filepath.Join(tr.cgroup, "memory.max")); err != nil || strings.TrimSpace(string(b)) != strconv.FormatInt(want, 10) {
		t.Fatalf("lease VM %s: %s memory.max = %q (%v), want the lease bound %d", tr.id, tr.cgroup, b, err, want)
	}
	return tr
}

// leftovers lists what of tr is still on the host.
func (tr leaseVMTrace) leftovers() []string {
	var out []string
	for _, f := range []struct{ what, path string }{
		{"lease cgroup", tr.cgroup}, {"jail", tr.jail}, {"API socket", tr.apiSock}, {"vsock socket", tr.vsock},
	} {
		if _, err := os.Lstat(f.path); err == nil {
			out = append(out, f.what+" "+f.path)
		}
	}
	if comm, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", tr.pid)); err == nil && strings.TrimSpace(string(comm)) == tr.comm {
		out = append(out, fmt.Sprintf("VMM process %d (%s)", tr.pid, tr.comm))
	}
	return out
}

// requireLeaseVMGone fails unless every artifact of tr is gone within the bound.
func requireLeaseVMGone(t *testing.T, tr leaseVMTrace, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		left := tr.leftovers()
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("lease VM %s, %s after its lease ended: still present: %s", tr.id, within, strings.Join(left, "; "))
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// hostNetDevices lists the host's network interfaces: a VM that created a tap leaves one.
func hostNetDevices(t *testing.T) []string {
	t.Helper()
	ents, err := os.ReadDir("/sys/class/net")
	if err != nil {
		t.Fatalf("list host network devices: %v", err)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	slices.Sort(names)
	return names
}

// leaseEndDriver ends a lease for one spec §4.1 reason through its real path.
type leaseEndDriver struct {
	reason LeaseEndReason
	tweak  func(*Config)
	// first is the lease's first Exec; Command, Mode, ModeEpoch (1) and TimeoutS are filled in.
	first Exec
	// end ends key's lease and returns the gate whose pool reports the end: g, or the
	// restarted pool for worker_restart.
	end func(t *testing.T, g *leaseGate, key string) *leaseGate
}

// leaseEndDrivers is every end reason a real VM can be driven to here, fast ones first.
// memory_reclaim is TestGateLeaseReclaim's; teardown_failed needs a guest whose Exec
// teardown fails, which no command can arrange.
func leaseEndDrivers() []leaseEndDriver {
	endLease := func(reason LeaseEndReason) func(*testing.T, *leaseGate, string) *leaseGate {
		return func(t *testing.T, g *leaseGate, key string) *leaseGate {
			t.Helper()
			if err := g.p.EndLease(key, reason); err != nil {
				t.Fatalf("EndLease(%s): %v", reason, err)
			}
			return g
		}
	}
	return []leaseEndDriver{
		{reason: LeaseEndReset, end: endLease(LeaseEndReset)},
		{reason: LeaseEndSandboxDeleted, end: endLease(LeaseEndSandboxDeleted)},
		{reason: LeaseEndModeChange, end: func(t *testing.T, g *leaseGate, key string) *leaseGate {
			t.Helper()
			mustSetMode(t, g.p, key, ModePerExec, 2) // a downgrade ends the lease before it returns
			return g
		}},
		{reason: LeaseEndWorkerRestart, end: func(t *testing.T, g *leaseGate, key string) *leaseGate {
			t.Helper()
			return g.restart(t, nil)
		}},
		{reason: LeaseEndAgentDead, end: func(t *testing.T, g *leaseGate, key string) *leaseGate {
			t.Helper()
			// An aborted Exec ends without an End: the VM is not one to run the next Exec in,
			// whether or not the agent survived. (A timeout no longer does: the guest's own
			// timeout fires first and keeps the lease, TestGateLeaseTimeoutKeepsTheLease.)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if _, err := g.p.Exec(ctx, key, gateLease("sleep 30", 1), &capturingSink{}); !errors.Is(err, ErrAborted) {
				t.Fatalf("an Exec aborted after 2 s: err = %v, want ErrAborted", err)
			}
			return g
		}},
		{reason: LeaseEndKeepaliveLost, first: Exec{Keepalive: true},
			// The shortest loss Normalize accepts: two of the MCP server's 30 s periods.
			tweak: func(c *Config) { c.LeaseKeepaliveLoss = minLeaseKeepaliveLoss },
			end: func(t *testing.T, g *leaseGate, key string) *leaseGate {
				t.Helper()
				g.waitLeaseGone(t, key, g.p.cfg.LeaseKeepaliveLoss+2*g.p.cfg.LeaseScanInterval+10*time.Second)
				return g
			}},
		{reason: LeaseEndGraceLimit,
			tweak: func(c *Config) { c.LeaseMaxDuration, c.LeaseGraceLimit = 2*time.Second, 3*time.Second },
			end: func(t *testing.T, g *leaseGate, key string) *leaseGate {
				t.Helper()
				// Running when the grace limit passes: the sweep cuts it, and it fails
				// lease_ended(grace_limit), not a generic error (spec §4).
				_, _, _, err := g.exec(key, gateLease("sleep 30", 1))
				var ended *LeaseEndedError
				if !errors.As(err, &ended) || ended.Reason != LeaseEndGraceLimit {
					t.Fatalf("an Exec past the grace limit: err = %v, want lease_ended(%s)", err, LeaseEndGraceLimit)
				}
				return g
			}},
		{reason: LeaseEndIdle, first: Exec{IdleTimeout: time.Second},
			end: func(t *testing.T, g *leaseGate, key string) *leaseGate {
				t.Helper()
				floor := g.p.cfg.LeaseIdleMin
				took := g.waitLeaseGone(t, key, floor+2*g.p.cfg.LeaseScanInterval+10*time.Second)
				if took < floor-2*time.Second {
					t.Fatalf("the lease ended %s after its Exec: a 1 s idle timeout must be raised to LeaseIdleMin %s", took, floor)
				}
				return g
			}},
		{reason: LeaseEndMaxDuration, first: Exec{IdleTimeout: time.Second},
			tweak: func(c *Config) { c.LeaseMaxDuration = 2 * time.Second },
			end: func(t *testing.T, g *leaseGate, key string) *leaseGate {
				t.Helper()
				// Expiring after 2 s, it ends at its next idle (LeaseIdleMin) as max_duration.
				g.waitLeaseGone(t, key, g.p.cfg.LeaseIdleMin+2*g.p.cfg.LeaseScanInterval+10*time.Second)
				return g
			}},
	}
}

// startLease sets key's mode to lease (epoch 1) and runs d's first Exec there.
func (d leaseEndDriver) startLease(t *testing.T, g *leaseGate, key string) {
	t.Helper()
	mustSetMode(t, g.p, key, ModeLease, 1)
	e := d.first
	e.Command, e.Mode, e.ModeEpoch, e.TimeoutS = "true", ModeLease, 1, 60
	g.run(t, key, e)
}

// TestGateLeaseOneSandbox: a lease VM serves one key and never becomes a standby, and two
// keys in lease mode get two VMs (spec §3).
func TestGateLeaseOneSandbox(t *testing.T) {
	requireKVM(t)
	g := newLeaseGate(t, nil)
	const a, b = "lease-one-a", "lease-one-b"
	mustSetMode(t, g.p, a, ModeLease, 1)
	mustSetMode(t, g.p, b, ModeLease, 1)

	g.run(t, a, gateLease("echo a > owner", 1))
	if got := g.run(t, b, gateLease("cat owner 2>/dev/null || echo none; echo b > owner", 1)); got != "none\n" {
		t.Fatalf("b's first Exec read %q, want none: it saw a's workspace", got)
	}
	va, vb := g.leaseVM(t, a), g.leaseVM(t, b)
	if va == vb || va.id == vb.id {
		t.Fatalf("a and b share lease VM %s", va.id)
	}
	if va.Key() != a || vb.Key() != b {
		t.Fatalf("lease VMs bound to %q and %q, want %q and %q", va.Key(), vb.Key(), a, b)
	}
	if s := g.p.Stats(); s.LeaseVMs != 2 || s.StandbysResident != 0 {
		t.Fatalf("Stats: LeaseVMs %d, StandbysResident %d; want two lease VMs and no standby", s.LeaseVMs, s.StandbysResident)
	}
	for _, k := range []struct{ key, want string }{{a, "a\n"}, {b, "b\n"}} {
		v := g.leaseVM(t, k.key)
		if got := g.run(t, k.key, gateLease("cat owner", 1)); got != k.want {
			t.Fatalf("%s's second Exec read %q, want %q", k.key, got, k.want)
		}
		if g.leaseVM(t, k.key) != v {
			t.Fatalf("%s's second Exec ran in a different VM", k.key)
		}
	}

	// Ended, a's VM is destroyed, not parked: nothing of it is left, and no run holds it.
	tr := g.trace(t, a)
	if err := g.p.EndLease(a, LeaseEndReset); err != nil {
		t.Fatalf("EndLease: %v", err)
	}
	requireLeaseVMGone(t, tr, 10*time.Second)
	g.p.mu.Lock()
	for key, rp := range g.p.runs {
		for _, sb := range rp.ready {
			if vmID(sb) == va.id {
				t.Errorf("a's ended lease VM %s is a standby of %s", va.id, key)
			}
		}
	}
	g.p.mu.Unlock()

	// The next Exec on a: a fresh VM, the same workspace.
	if got := g.run(t, a, gateLease("cat owner", 1)); got != "a\n" {
		t.Fatalf("a's Exec after the end read %q, want %q", got, "a\n")
	}
	if id := g.leaseVM(t, a).id; id == va.id {
		t.Fatalf("a's next lease runs in VM %s, the one its ended lease held", id)
	}
	if g.leaseVM(t, b) != vb {
		t.Fatal("b's lease changed when a's ended")
	}
}

// TestGateLeaseTeardown: each end reason destroys the VM and leaks no lease cgroup, jail,
// API or vsock socket, VMM process, or tap (spec §9). About 1.5 min: idle and max_duration
// each wait out LeaseIdleMin (30 s).
func TestGateLeaseTeardown(t *testing.T) {
	requireKVM(t)
	requireLeaseSnapshot(t)
	nets := hostNetDevices(t)
	for _, d := range leaseEndDrivers() {
		t.Run(string(d.reason), func(t *testing.T) {
			const key = "lease-teardown"
			g := newLeaseGate(t, d.tweak)
			d.startLease(t, g, key)
			tr := g.trace(t, key)
			after := d.end(t, g, key)
			if st := after.p.LeaseStatus(key).State; st != LeaseNone {
				t.Fatalf("lease state %q after the end, want %q", st, LeaseNone)
			}
			requireLeaseVMGone(t, tr, 10*time.Second)
		})
	}
	if got := hostNetDevices(t); !slices.Equal(got, nets) {
		t.Errorf("host network devices before the leases %v, after %v: a tap leaked", nets, got)
	}
}

// TestGateLeaseNotice is the worker half of spec §5's notice: every end reason leaves
// exactly one pending end event, the status and the state file agree, it is counted once,
// and acknowledging it clears it. About 1.5 min, as TestGateLeaseTeardown.
func TestGateLeaseNotice(t *testing.T) {
	requireKVM(t)
	requireLeaseSnapshot(t)
	for _, d := range leaseEndDrivers() {
		t.Run(string(d.reason), func(t *testing.T) {
			const key = "lease-notice"
			g := newLeaseGate(t, d.tweak)
			d.startLease(t, g, key)
			if ev := g.p.LeaseStatus(key).Pending; ev == nil || ev.State != leaseEventStart {
				t.Fatalf("pending after the lease's first Exec = %+v, want the start", ev)
			}
			after := d.end(t, g, key)

			info := after.p.LeaseStatus(key)
			ev := info.Pending
			if ev == nil || ev.State != leaseEventEnd || ev.Reason != d.reason || ev.Mode != ModeLease {
				t.Fatalf("pending after the end = %+v, want end %s in mode lease", ev, d.reason)
			}
			if s := loadLeaseState(after.cfg.WorkspaceRoot, key); s.Pending == nil || !s.Pending.At.Equal(ev.At) ||
				s.Pending.Reason != d.reason || s.Open != nil {
				t.Fatalf("state file = %+v, want the pending end the status reports and no open lease", s)
			}
			if s := after.p.Stats(); leaseEndTotal(s) != 1 || s.LeaseEnds[d.reason] != 1 {
				t.Fatalf("LeaseEnds = %v, want exactly one, %s", s.LeaseEnds, d.reason)
			}
			after.p.AckLeaseEvent(key, ev.At)
			if got := after.p.LeaseStatus(key).Pending; got != nil {
				t.Fatalf("pending after the acknowledgement = %+v, want none", got)
			}
		})
	}
}

// TestGateLeaseStaleEpoch is the worker half of spec §8.2: an Exec with an older epoch is
// refused and leaves the lease alone; with the state file lost (deleted across a restart)
// a lease Exec runs per-Exec -- as root, in a fresh VM -- until SetMode restores the mode.
func TestGateLeaseStaleEpoch(t *testing.T) {
	requireKVM(t)
	g := newLeaseGate(t, nil)
	const key = "lease-epoch"
	mustSetMode(t, g.p, key, ModeLease, 5)
	if got := g.run(t, key, gateLease("id -u", 5)); got != "7000\n" {
		t.Fatalf("lease Exec at epoch 5 ran as %q, want uid 7000", got)
	}
	v := g.leaseVM(t, key)
	if _, _, _, err := g.exec(key, gateLease("true", 4)); ReasonOf(err) != RefuseStaleMode {
		t.Fatalf("Exec at epoch 4 under a stored 5: err = %v, want %s", err, RefuseStaleMode)
	}
	g.run(t, key, gateLease("true", 5))
	if g.leaseVM(t, key) != v {
		t.Fatal("the refused Exec ended the lease")
	}

	root := g.cfg.WorkspaceRoot
	g = g.restart(t, func() {
		if err := os.Remove(leaseStatePath(root, key)); err != nil {
			t.Fatalf("delete the state file: %v", err)
		}
	})
	if info := g.p.LeaseStatus(key); info.EpochKnown || info.State != LeaseNone {
		t.Fatalf("status with the state file gone = %+v, want epoch unknown and no lease", info)
	}
	if got := g.run(t, key, gateLease("id -u", 5)); got != "0\n" {
		t.Fatalf("lease Exec with the epoch unknown ran as %q, want root (0): it must run per-Exec", got)
	}
	if s := g.p.Stats(); s.LeaseVMs != 0 {
		t.Fatalf("LeaseVMs = %d after a per-Exec run, want 0", s.LeaseVMs)
	}
	if _, err := os.Stat(leaseStatePath(g.cfg.WorkspaceRoot, key)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("an Exec with the epoch unknown stored state (stat: %v): only SetMode may", err)
	}

	mustSetMode(t, g.p, key, ModeLease, 5)
	if got := g.run(t, key, gateLease("id -u", 5)); got != "7000\n" {
		t.Fatalf("lease Exec after SetMode ran as %q, want uid 7000", got)
	}
	if s := g.p.Stats(); s.LeaseVMs != 1 {
		t.Fatalf("LeaseVMs = %d after SetMode and a lease Exec, want 1", s.LeaseVMs)
	}
}

// leaseCmdRecorder is the Firecracker launcher with every Run's lease flags recorded.
// Its VMs embed *firecrackerVM, so every optional interface the pool asks of a VM
// (leaseCgrouper, leaseFootprinter, ID, ...) is the real one; only Run is wrapped.
type leaseCmdRecorder struct {
	*firecrackerLauncher
	mu   sync.Mutex
	runs []leaseRecordedRun
}

type leaseRecordedRun struct {
	vm               string
	cmd              string
	timeoutS         uint32
	lease, normalise bool
}

func (r *leaseCmdRecorder) Restore(ctx context.Context, req RestoreRequest) (VM, error) {
	vm, err := r.firecrackerLauncher.Restore(ctx, req)
	if err != nil {
		return nil, err
	}
	fv, ok := vm.(*firecrackerVM)
	if !ok {
		_ = vm.Destroy()
		return nil, fmt.Errorf("leaseCmdRecorder: Restore returned a %T", vm)
	}
	return &leaseCmdRecordingVM{firecrackerVM: fv, r: r}, nil
}

// runsIn returns the recorded Runs in VM id, in order.
func (r *leaseCmdRecorder) runsIn(id string) []leaseRecordedRun {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []leaseRecordedRun
	for _, run := range r.runs {
		if run.vm == id {
			out = append(out, run)
		}
	}
	return out
}

type leaseCmdRecordingVM struct {
	*firecrackerVM
	r *leaseCmdRecorder
}

func (v *leaseCmdRecordingVM) Run(ctx context.Context, c Command, out Sink) (Result, error) {
	v.r.mu.Lock()
	v.r.runs = append(v.r.runs, leaseRecordedRun{vm: v.id, cmd: c.Command, timeoutS: c.TimeoutS,
		lease: c.Lease, normalise: c.NormaliseWorkspace})
	v.r.mu.Unlock()
	return v.firecrackerVM.Run(ctx, c, out)
}

// TestGateLeaseOwnership: lease, then per-Exec (root writes a file and a directory), then
// lease again: that lease's start normalises the workspace in a step of its own (`true`
// with NormaliseWorkspace and LeaseNormaliseTimeout, PR #763 second review G2), and its
// first Exec can modify both. A lease that follows a lease, with no per-Exec Exec between,
// does not walk it (spec §4).
func TestGateLeaseOwnership(t *testing.T) {
	requireKVM(t)
	var rec *leaseCmdRecorder
	g := newLeaseGateWith(t, nil, func(fl *firecrackerLauncher) Launcher {
		rec = &leaseCmdRecorder{firecrackerLauncher: fl}
		return rec
	})
	const key = "lease-owner"
	mustSetMode(t, g.p, key, ModeLease, 1)
	g.run(t, key, gateLease("true", 1))

	mustSetMode(t, g.p, key, ModePerExec, 2) // ends the lease (mode_change)
	perExec := Exec{Command: "mkdir rootdir && echo r > rootdir/f && echo r > rootfile && stat -c %u rootfile rootdir",
		TimeoutS: 60, Mode: ModePerExec, ModeEpoch: 2}
	if got := g.run(t, key, perExec); got != "0\n0\n" {
		t.Fatalf("per-Exec Exec: owners %q, want root's (0 0)", got)
	}
	if s := loadLeaseState(g.cfg.WorkspaceRoot, key); !s.RootWrote {
		t.Fatalf("state after the per-Exec Exec = %+v, want root_wrote", s)
	}

	mustSetMode(t, g.p, key, ModeLease, 3)
	got := g.run(t, key, gateLease("echo l >> rootfile && echo l > rootdir/g && rm rootdir/f && "+
		"stat -c %u rootfile rootdir && cat rootfile && ls rootdir", 3))
	if want := "7000\n7000\nr\nl\ng\n"; got != want {
		t.Fatalf("first Exec of the lease after root wrote printed %q, want %q", got, want)
	}
	runs := rec.runsIn(g.leaseVM(t, key).id)
	if len(runs) != 2 {
		t.Fatalf("Runs in the lease after root wrote = %+v, want the normalise step, then the Exec", runs)
	}
	if n := runs[0]; n.cmd != "true" || !n.lease || !n.normalise || n.timeoutS != uint32(LeaseNormaliseTimeout/time.Second) {
		t.Fatalf("the lease's first Run = %+v, want the normalise step: `true`, lease, normalise, timeout_s %d",
			n, uint32(LeaseNormaliseTimeout/time.Second))
	}
	if u := runs[1]; !u.lease || u.normalise {
		t.Fatalf("the lease's second Run = %+v, want the Exec: lease, without normalise", u)
	}
	if s := loadLeaseState(g.cfg.WorkspaceRoot, key); s.RootWrote {
		t.Fatalf("state after the normalising Exec = %+v, want root_wrote cleared", s)
	}

	if err := g.p.EndLease(key, LeaseEndReset); err != nil {
		t.Fatalf("EndLease: %v", err)
	}
	g.run(t, key, gateLease("true", 3))
	if runs := rec.runsIn(g.leaseVM(t, key).id); len(runs) != 1 || !runs[0].lease || runs[0].normalise {
		t.Fatalf("Runs in a lease after a lease = %+v, want one lease Run that does not normalise", runs)
	}
}

// TestGateLeaseReclaim: under a budget squeeze, an admission ends the idle-longest idle
// lease (memory_reclaim), and a lease with an Exec in flight is never taken, even when its
// last Exec ended before every other lease's (spec §6).
//
// The squeeze is set from the measured charges: after three leases start, the budget is
// lowered under p.mu to exactly what is committed plus a new lease's start price, less
// 1 MiB, so the fourth lease's admission must free a little and any one idle lease covers
// it. The lease ticker is slowed to 10 min so no re-sample moves the charges meanwhile.
func TestGateLeaseReclaim(t *testing.T) {
	requireKVM(t)
	g := newLeaseGate(t, func(c *Config) {
		// Normalize holds LeaseScanInterval to LeaseIdleMin/4, so the idle bounds rise with it.
		c.LeaseScanInterval = 10 * time.Minute
		c.LeaseIdleMin, c.LeaseIdleDefault, c.LeaseIdleCeiling = 40*time.Minute, 40*time.Minute, 40*time.Minute
	})
	const busy, old, recent, next = "lease-reclaim-busy", "lease-reclaim-old", "lease-reclaim-recent", "lease-reclaim-next"
	// busy's last Exec ends first, so by its clocks it is the idle-longest.
	for _, k := range []string{busy, old, recent} {
		mustSetMode(t, g.p, k, ModeLease, 1)
		g.run(t, k, gateLease("true", 1))
		time.Sleep(200 * time.Millisecond)
	}
	busyVM := g.leaseVM(t, busy)
	oldTrace := g.trace(t, old)

	type result struct {
		res    Result
		stdout string
		err    error
	}
	busyDone := make(chan result, 1)
	go func() {
		res, stdout, _, err := g.exec(busy, gateLease("sleep 15; echo done", 1))
		busyDone <- result{res, stdout, err}
	}()
	deadline := time.Now().Add(30 * time.Second)
	for g.p.Stats().LeaseExecuting != 1 {
		if time.Now().After(deadline) {
			t.Fatal("busy's Exec never started")
		}
		time.Sleep(50 * time.Millisecond)
	}

	g.p.mu.Lock()
	g.p.cfg.MaxCommittedBytes = g.p.committedLocked() + g.p.cfg.MemoryReserveBytes + g.p.cfg.LeaseStartBytes - 1<<20
	g.p.mu.Unlock()
	mustSetMode(t, g.p, next, ModeLease, 1)
	g.run(t, next, gateLease("true", 1))

	if info := g.p.LeaseStatus(old); info.State != LeaseNone || info.Pending == nil || info.Pending.Reason != LeaseEndMemoryReclaim {
		t.Fatalf("old after the squeezed admission: %+v, want ended %s", info, LeaseEndMemoryReclaim)
	}
	for _, k := range []string{busy, recent, next} {
		if st := g.p.LeaseStatus(k).State; st == LeaseNone {
			t.Fatalf("%s's lease was reclaimed; only old, the idle-longest idle lease, may be", k)
		}
	}
	if s := g.p.Stats(); leaseEndTotal(s) != 1 || s.LeaseEnds[LeaseEndMemoryReclaim] != 1 {
		t.Fatalf("LeaseEnds = %v, want exactly one memory_reclaim", s.LeaseEnds)
	}
	requireLeaseVMGone(t, oldTrace, 10*time.Second)

	r := <-busyDone
	if r.err != nil || r.res.ExitCode != 0 || r.stdout != "done\n" {
		t.Fatalf("busy's Exec: %+v, stdout %q, err %v; want it to finish in its lease", r.res, r.stdout, r.err)
	}
	if g.leaseVM(t, busy) != busyVM {
		t.Fatal("busy's lease VM changed under its Exec")
	}
}

// leaseCredentialScanLen is the longest value scanForCredentials looks for among the
// fixed patterns; a chunked scan keeps that many bytes less one across a chunk boundary.
func leaseCredentialScanLen(extra ...string) int {
	n := 0
	for _, p := range append(slices.Clone(credentialPatterns), extra...) {
		n = max(n, len(p))
	}
	return n
}

// scanLeaseGuestMemory reads the guest's RAM from the host -- the VMM's memfile mapping,
// through /proc/<pid>/mem, so the guest's own view of every page including its tmpfs --
// and returns which of credentialPatterns and extra it contains, and how many bytes it read.
func scanLeaseGuestMemory(t *testing.T, v *firecrackerVM, extra ...string) (map[string]bool, int64) {
	t.Helper()
	pid := v.cmd.Process.Pid
	mapsText, err := os.ReadFile(fmt.Sprintf("/proc/%d/maps", pid))
	if err != nil {
		t.Fatalf("read the VMM's maps: %v", err)
	}
	mem, err := os.Open(fmt.Sprintf("/proc/%d/mem", pid))
	if err != nil {
		t.Fatalf("open the VMM's memory: %v", err)
	}
	defer func() { _ = mem.Close() }()
	keep := leaseCredentialScanLen(extra...) - 1
	buf := make([]byte, keep+1<<20)
	found := map[string]bool{}
	var scanned int64
	for _, line := range strings.Split(string(mapsText), "\n") {
		f := strings.Fields(line)
		if len(f) < 6 || !strings.HasSuffix(f[5], "/memfile") {
			continue
		}
		lo, hi, ok := strings.Cut(f[0], "-")
		start, err1 := strconv.ParseUint(lo, 16, 64)
		end, err2 := strconv.ParseUint(hi, 16, 64)
		if !ok || err1 != nil || err2 != nil {
			t.Fatalf("parse the maps line %q", line)
		}
		// buf[:tail] carries the last keep bytes of the previous chunk, so a value that
		// straddles two chunks is still seen whole.
		tail := 0
		for pos := start; pos < end; {
			want := int(min(uint64(len(buf)-tail), end-pos))
			n, err := mem.ReadAt(buf[tail:tail+want], int64(pos))
			if n > 0 {
				window := buf[:tail+n]
				for _, hit := range scanForCredentials(window, extra...) {
					found[hit] = true
				}
				scanned += int64(n)
				pos += uint64(n)
				tail = min(keep, len(window))
				copy(buf, window[len(window)-tail:])
			}
			if err != nil && pos < end {
				t.Fatalf("read guest memory at %#x: %v", pos, err)
			}
		}
	}
	if scanned == 0 {
		t.Fatalf("no memfile mapping in /proc/%d/maps: cannot locate the guest's memory", pid)
	}
	return found, scanned
}

// TestGateLeaseSecrets is the lease variant of TestGateSnapshotHoldsNoSecrets: after lease
// Execs, scanForCredentials finds nothing in the guest's /tmp and /var, its environment,
// or its memory. A canary planted by a lease Exec (sent reversed, so the command text
// never holds it) is the control: the file dump and the memory scan must each find it,
// or their silence on credentials proves nothing.
func TestGateLeaseSecrets(t *testing.T) {
	requireKVM(t)
	g := newLeaseGate(t, nil)
	const key = "lease-secrets"
	mustSetMode(t, g.p, key, ModeLease, 1)

	r := make([]byte, 12)
	if _, err := rand.Read(r); err != nil {
		t.Fatal(err)
	}
	canary := "lease-canary-" + hex.EncodeToString(r)
	g.run(t, key, gateLease(`command -v python3 >/dev/null || { echo MISSING-PYTHON3 >&2; exit 3; }
python3 -c 'import sys; open("/tmp/lease-canary", "w").write(sys.argv[1][::-1])' `+shQuote(reverse(canary)), 1))
	g.run(t, key, gateLease("cd /tmp && echo x > scratch && ls -la / >/dev/null && python3 -c 'print(1)' >/dev/null", 1))

	out := g.run(t, key, gateLease(`command -v find >/dev/null || { echo MISSING-FIND; exit 0; }
echo ==ENV==; env; echo ==FILES==
find /tmp /var -xdev -type f -readable -size -4M -print0 2>/dev/null | xargs -0 -r cat 2>/dev/null; echo; echo ==END==`, 1))
	if strings.Contains(out, "MISSING-FIND") {
		t.Fatalf("the snapshot has no find, so the gate cannot read /tmp and /var")
	}
	live := os.Getenv("SANDBOX_TOKEN")
	if live == "" {
		t.Log("SANDBOX_TOKEN is unset: the live-token half of this gate is NOT CHECKED (the pattern scans still ran)")
	}
	envOut, _, _ := strings.Cut(out, "==FILES==")
	for _, name := range []string{"SANDBOX_TOKEN", "AWS_", "ANTHROPIC_"} {
		if strings.Contains(envOut, name) {
			t.Errorf("the lease Exec's env contains %q", name)
		}
	}
	report := func(where string, found []string) {
		t.Helper()
		if !slices.Contains(found, canary) {
			t.Fatalf("%s: the planted canary was not found, so finding no credential there proves nothing", where)
		}
		for _, f := range found {
			switch f {
			case canary:
			case live:
				t.Errorf("%s holds the live SANDBOX_TOKEN value", where)
			default:
				t.Errorf("%s holds credential pattern %q", where, f)
			}
		}
	}
	report("the guest's /tmp, /var and env", scanForCredentials([]byte(out), live, canary))

	found, scanned := scanLeaseGuestMemory(t, g.leaseVM(t, key), live, canary)
	t.Logf("scanned %d MiB of guest memory (guest RAM %d MiB)", scanned>>20, g.cfg.GuestRAMBytes>>20)
	report("the guest's memory", slices.Collect(maps.Keys(found)))
}

// pinLeaseGateMemfile mlocks the snapshot's memfile for the rest of the test, as the
// worker does at start (main.go): its pages are then charged to this process, not to the
// first VM cgroup that faults them, so a lease VM's memory.current is what the VM itself
// dirtied -- the figure free-page reporting returns, and the one production charges.
func pinLeaseGateMemfile(t *testing.T, snapshotDir string) {
	t.Helper()
	if _, _, err := RaiseMemlockLimit(); err != nil {
		t.Fatalf("RaiseMemlockLimit: %v", err)
	}
	unpin, err := PinMemoryFile(filepath.Join(snapshotDir, "memfile"))
	if err != nil {
		t.Fatalf("PinMemoryFile: %v", err)
	}
	t.Cleanup(func() { _ = unpin() })
}

// leaseTouchScript writes every page of argv[1] bytes, says so, and holds them 3 s.
const leaseTouchScript = `
import sys, time
n = int(sys.argv[1])
b = bytearray(n)
for i in range(0, n, 4096):
    b[i] = 1
print("touched", n, flush=True)
time.sleep(3)
`

// TestGateLeaseFreePageReporting: a lease Exec touches memory and exits; within 30 s the
// VM's LeaseBytes (its cgroup's memory.current) falls below a bound, having been above the
// touched amount while the Exec held it -- so the gate proves memory was returned, not that
// it was never taken (spec §6, §16 item 5). Sized for the guest: 150 MiB touched against a
// 100 MiB bound, or 600 MiB against 300 MiB from 1 GiB of guest RAM. It also checks the
// balloon's driver is bound in the guest.
func TestGateLeaseFreePageReporting(t *testing.T) {
	requireKVM(t)
	snapshotDir, man := requireLeaseSnapshot(t)
	if !man.HasFeature(FeatureBalloonFPRV1) {
		t.Skipf("NOT RUN (no signal, not a pass): snapshot %s does not advertise %q (features %v)",
			snapshotDir, FeatureBalloonFPRV1, man.Features)
	}
	pinLeaseGateMemfile(t, snapshotDir)
	g := newLeaseGate(t, nil)
	touch, bound := int64(150<<20), int64(100<<20)
	if g.cfg.GuestRAMBytes >= 1<<30 {
		touch, bound = 600<<20, 300<<20
	}
	const key = "lease-fpr"
	mustSetMode(t, g.p, key, ModeLease, 1)

	if got := g.run(t, key, gateLease("ls /sys/bus/virtio/drivers/virtio_balloon/ 2>&1", 1)); !regexp.MustCompile(`(?m)^virtio\d+$`).MatchString(got) {
		t.Fatalf("virtio_balloon is bound to no device in the guest: ls printed %q", got)
	}
	v := g.leaseVM(t, key)
	before, err := v.LeaseBytes()
	if err != nil {
		t.Fatalf("LeaseBytes: %v", err)
	}

	type result struct {
		res    Result
		stdout string
		err    error
	}
	done := make(chan result, 1)
	go func() {
		res, stdout, _, err := g.exec(key, gateLease(`command -v python3 >/dev/null || { echo MISSING-PYTHON3; exit 3; }
python3 -c `+shQuote(leaseTouchScript)+" "+strconv.FormatInt(touch, 10), 1))
		done <- result{res, stdout, err}
	}()
	var peak int64
	var r result
poll:
	for {
		select {
		case r = <-done:
			break poll
		case <-time.After(50 * time.Millisecond):
			if b, err := v.LeaseBytes(); err == nil {
				peak = max(peak, b)
			}
		}
	}
	if r.err != nil || r.res.ExitCode != 0 || !strings.Contains(r.stdout, "touched") {
		t.Fatalf("the touching Exec: %+v, stdout %q, err %v", r.res, r.stdout, r.err)
	}
	if peak <= touch {
		t.Fatalf("LeaseBytes peaked at %d MiB while the Exec held %d MiB (%d MiB before): the memory was never "+
			"taken, so a later drop would prove nothing", peak>>20, touch>>20, before>>20)
	}

	start := time.Now()
	var now int64
	for {
		if now, err = v.LeaseBytes(); err != nil {
			t.Fatalf("LeaseBytes: %v", err)
		}
		if now < bound {
			break
		}
		if time.Since(start) > 30*time.Second {
			t.Fatalf("LeaseBytes = %d MiB 30 s after the Exec exited (peak %d MiB, %d MiB before), want < %d MiB: "+
				"free-page reporting did not return the freed memory", now>>20, peak>>20, before>>20, bound>>20)
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Logf("LeaseBytes: %d MiB before, %d MiB peak, %d MiB %s after the Exec (bound %d MiB)",
		before>>20, peak>>20, now>>20, time.Since(start).Round(100*time.Millisecond), bound>>20)
}

// TestGateLeaseTimeoutKeepsTheLease: a lease Exec past its timeout is killed by the guest,
// which answers with its own timeout, and the lease is kept: the next Exec runs in the
// same VM with the agent alive as PID 1 and nothing of the timed-out command left
// (PR #763 review, ruling R8b).
func TestGateLeaseTimeoutKeepsTheLease(t *testing.T) {
	requireKVM(t)
	g := newLeaseGate(t, nil)
	const key = "lease-timeout"
	mustSetMode(t, g.p, key, ModeLease, 1)
	g.run(t, key, gateLease("echo kept > /tmp/marker", 1))
	v := g.leaseVM(t, key)

	e := gateLease("sleep 300 & sleep 300", 1)
	e.TimeoutS = 2
	start := time.Now()
	if _, _, _, err := g.exec(key, e); !errors.Is(err, ErrTimeout) {
		t.Fatalf("an Exec past its 2 s timeout: err = %v, want ErrTimeout", err)
	}
	if took := time.Since(start); took > 2*time.Second+LeaseTimeoutSlack {
		t.Fatalf("the timed-out Exec returned after %s, want before the host's deadline (2 s + %s)", took, LeaseTimeoutSlack)
	}
	if g.leaseVM(t, key) != v {
		t.Fatal("after the timeout: the lease runs in another VM")
	}
	check := `cat /proc/1/comm /tmp/marker
for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = sleep ] && echo sleep-left; done
echo checked`
	if got := g.run(t, key, gateLease(check, 1)); got != "agent\nkept\nchecked\n" {
		t.Fatalf("after the timeout: %q, want the agent as PID 1, /tmp kept and no sleep left", got)
	}
	if s := g.p.Stats(); leaseEndTotal(s) != 0 {
		t.Fatalf("LeaseEnds = %v, want none: a timeout ends the Exec, not the lease", s.LeaseEnds)
	}
}

// TestGateLeaseExecCaps: a fork bomb and an OOM inside a lease Exec each end that Exec
// with a non-zero exit, and the next Exec in the same lease runs with the agent alive as
// PID 1 -- no guest panic, no agent_dead (spec §16; the caps are the guest agent's
// memory.max and pids.max on each lease Exec's cgroup).
//
// Then the tmpfs case (PR #763 review): one Exec leaves ~60% of the guest's memory in
// /tmp and /var, whose pages outlive it and are charged to the cgroup root once its own
// cgroup is gone. The next Exec allocates past what remains. With the root capped as well
// it is OOM-killed inside the cgroup tree (the root's memory.events oom count rises);
// with only the e<seq> capped it would start from zero over the tmpfs charge and run the
// guest into a global OOM, which a guest whose one other process is PID 1 at -1000 does
// not survive. The OOM-killed Exec's stderr carries the guest agent's hint that the lease
// still holds that memory (PR #763 second review, G3).
func TestGateLeaseExecCaps(t *testing.T) {
	requireKVM(t)
	g := newLeaseGate(t, nil)
	const key = "lease-caps"
	mustSetMode(t, g.p, key, ModeLease, 1)
	g.run(t, key, gateLease("true", 1))
	v := g.leaseVM(t, key)

	for _, c := range []struct{ name, cmd string }{
		// Bounded by timeout(1), which signals its whole process group; exec keeps the
		// bomb's parent from needing a fork of its own to wait.
		{"fork bomb", `command -v timeout >/dev/null || { echo MISSING-TIMEOUT; exit 0; }
timeout 10 bash -c ':(){ :|:& };:; exec sleep 30'`},
		{"oom", `command -v python3 >/dev/null || { echo MISSING-PYTHON3; exit 0; }
python3 -c 'b = []
while True: b.append(b"x" * (16 << 20))'`},
	} {
		res, stdout, stderr, err := g.exec(key, gateLease(c.cmd, 1))
		if strings.Contains(stdout, "MISSING-") {
			t.Fatalf("%s: the snapshot lacks a tool the gate needs: %s", c.name, stdout)
		}
		if err != nil {
			t.Fatalf("%s: Exec error %v, want the Exec to end with a non-zero exit", c.name, err)
		}
		if res.ExitCode == 0 || res.TeardownFailed {
			t.Fatalf("%s: exit %d, teardown_failed %v, want a non-zero exit and a clean teardown", c.name, res.ExitCode, res.TeardownFailed)
		}
		t.Logf("%s: exit %d, stderr %.300q", c.name, res.ExitCode, stderr)
		if got := g.run(t, key, gateLease("cat /proc/1/comm", 1)); got != "agent\n" {
			t.Fatalf("after the %s: PID 1 is %q, want the agent", c.name, got)
		}
		if g.leaseVM(t, key) != v {
			t.Fatalf("after the %s: the lease runs in another VM", c.name)
		}
	}

	// The root's cap, and its oom count before the tmpfs case. memory.events is
	// hierarchical, so the OOM case above has already counted there.
	const rootCg = "/sys/fs/cgroup/moca-execs"
	rootOOMs := func(at string) int {
		t.Helper()
		out := g.run(t, key, gateLease(`awk '$1 == "oom" {print $2}' `+rootCg+`/memory.events`, 1))
		n, err := strconv.Atoi(strings.TrimSpace(out))
		if err != nil {
			t.Fatalf("%s: %s/memory.events oom = %q: %v", at, rootCg, out, err)
		}
		return n
	}
	if got := strings.TrimSpace(g.run(t, key, gateLease("cat "+rootCg+"/memory.max", 1))); got == "max" || got == "" {
		t.Fatalf("%s/memory.max = %q, want the Exec cap: the cgroup root is uncapped", rootCg, got)
	}
	before := rootOOMs("before the tmpfs case")
	// /tmp and /var are unsized tmpfs mounts, each limited to half the guest's memory by
	// default, so the ~60% is split 45/15 between them. The /var share goes to /var/tmp:
	// /var is an overlay over the image's root-owned /var (691c1a05), so the Exec user
	// cannot create /var/fill there; /var/tmp is world-writable, and its writes land in the
	// same tmpfs-backed /var.
	fill := `kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
dd if=/dev/zero of=/tmp/fill bs=1M count=$((kb * 45 / 100 / 1024)) 2>/dev/null &&
dd if=/dev/zero of=/var/tmp/fill bs=1M count=$((kb * 15 / 100 / 1024)) 2>/dev/null && echo filled`
	if got := g.run(t, key, gateLease(fill, 1)); got != "filled\n" {
		t.Fatalf("filling /tmp and /var: stdout %q, want filled", got)
	}
	res, _, stderr, err := g.exec(key, gateLease(`python3 -c 'b = []
while True: b.append(b"x" * (16 << 20))'`, 1))
	if err != nil {
		t.Fatalf("tmpfs: Exec error %v, want the allocation OOM-killed inside its cgroup", err)
	}
	if res.ExitCode == 0 || res.TeardownFailed {
		t.Fatalf("tmpfs: exit %d, teardown_failed %v, want a non-zero exit and a clean teardown", res.ExitCode, res.TeardownFailed)
	}
	t.Logf("tmpfs: exit %d, stderr %.300q", res.ExitCode, stderr)
	// PR #763 second review (G3): the guest agent says why, so the user can tell the
	// lease's leftover files from the command's own appetite.
	if !strings.Contains(stderr, "guest-agent: this command was killed for memory; ") ||
		!strings.Contains(stderr, " MiB is still held in the lease (files in /tmp and /var count against its memory until deleted)") {
		t.Fatalf("tmpfs: stderr %q, want the guest agent's hint that the lease's files hold its memory", stderr)
	}
	if got := g.run(t, key, gateLease("cat /proc/1/comm", 1)); got != "agent\n" {
		t.Fatalf("after the tmpfs case: PID 1 is %q, want the agent", got)
	}
	if g.leaseVM(t, key) != v {
		t.Fatal("after the tmpfs case: the lease runs in another VM")
	}
	if after := rootOOMs("after the tmpfs case"); after <= before {
		t.Fatalf("%s/memory.events oom %d -> %d: the allocation was not stopped by the cgroup tree's limit", rootCg, before, after)
	}
	if s := g.p.Stats(); leaseEndTotal(s) != 0 {
		t.Fatalf("LeaseEnds = %v, want none: the caps end the Exec, not the lease", s.LeaseEnds)
	}
}
