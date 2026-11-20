package vmpool

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The Release gates (#338): Pool.Release over real Firecracker VMs, on the lease-pool
// gate's launcher (pooled VM cgroups under a gate-private parent whose cleanup reports a
// leaked VM). Per-Exec Execs, StandbyDepth at its default (2). Each checks what a Release
// must free on the host -- every standby's jail, sockets, cgroup and VMM process, the
// workspace directory and its workspace.img -- against positive controls taken first.

// releaseGateLauncher is the Firecracker launcher with Restores counted and each Run's
// entry signalled, so a gate knows a command is running and how many VMs were restored.
type releaseGateLauncher struct {
	*firecrackerLauncher
	restores atomic.Int64
	mu       sync.Mutex
	entered  chan string // each Run's command, sent on entry when non-nil
}

func (l *releaseGateLauncher) Restore(ctx context.Context, req RestoreRequest) (VM, error) {
	vm, err := l.firecrackerLauncher.Restore(ctx, req)
	if err != nil {
		return nil, err
	}
	l.restores.Add(1)
	fv, ok := vm.(*firecrackerVM)
	if !ok {
		_ = vm.Destroy()
		return nil, fmt.Errorf("releaseGateLauncher: Restore returned a %T", vm)
	}
	return &releaseGateVM{firecrackerVM: fv, l: l}, nil
}

func (l *releaseGateLauncher) onEntry(ch chan string) {
	l.mu.Lock()
	l.entered = ch
	l.mu.Unlock()
}

type releaseGateVM struct {
	*firecrackerVM
	l *releaseGateLauncher
}

func (v *releaseGateVM) Run(ctx context.Context, c Command, out Sink) (Result, error) {
	v.l.mu.Lock()
	ch := v.l.entered
	v.l.mu.Unlock()
	if ch != nil {
		select {
		case ch <- c.Command:
		default:
		}
	}
	return v.firecrackerVM.Run(ctx, c, out)
}

// newReleaseGate is a lease-pool gate whose sweeps and idle timers are long, so only a
// Release (or an Exec's unwind after one) can free anything during a gate.
func newReleaseGate(t *testing.T) (*leaseGate, *releaseGateLauncher) {
	t.Helper()
	var rec *releaseGateLauncher
	g := newLeaseGateWith(t, func(c *Config) {
		c.StandbyIdle = time.Hour
		c.WorkspaceIdle = 2 * time.Hour
		c.ReclaimScanInterval = 30 * time.Minute
	}, func(fl *firecrackerLauncher) Launcher {
		rec = &releaseGateLauncher{firecrackerLauncher: fl}
		return rec
	})
	return g, rec
}

// asFirecracker unwraps a pool VM to the real one.
func asFirecracker(t *testing.T, vm VM) *firecrackerVM {
	t.Helper()
	switch v := vm.(type) {
	case *firecrackerVM:
		return v
	case *releaseGateVM:
		return v.firecrackerVM
	case *leaseCmdRecordingVM:
		return v.firecrackerVM
	}
	t.Fatalf("a %T, want a Firecracker VM", vm)
	return nil
}

// vmTrace records v's host artifacts and checks each exists now (the positive control):
// g.trace's first half, without its lease memory.max check.
func vmTrace(t *testing.T, v *firecrackerVM) leaseVMTrace {
	t.Helper()
	if v.cgroups == nil || v.cgroupRel == "" || v.cmd == nil || v.cmd.Process == nil {
		t.Fatalf("VM %s has no pooled cgroup or no process", v.id)
	}
	tr := leaseVMTrace{
		id: v.id, cgroup: v.cgroups.abs(v.cgroupRel), jail: v.jailRoot,
		apiSock: v.apiSockHost, vsock: v.vsockHostPath, pid: v.cmd.Process.Pid,
	}
	for _, p := range []string{tr.cgroup, tr.jail, tr.apiSock, tr.vsock} {
		if _, err := os.Lstat(p); err != nil {
			t.Fatalf("live VM %s: %v", tr.id, err)
		}
	}
	comm, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", tr.pid))
	if err != nil {
		t.Fatalf("live VM %s: its VMM pid %d: %v", tr.id, tr.pid, err)
	}
	tr.comm = strings.TrimSpace(string(comm))
	return tr
}

// standbyTraces traces key's Ready standbys, read under the pool lock.
func standbyTraces(t *testing.T, g *leaseGate, key string) []leaseVMTrace {
	t.Helper()
	g.p.mu.Lock()
	var vms []VM
	if rp := g.p.runs[key]; rp != nil {
		vms = append(vms, rp.ready...)
	}
	g.p.mu.Unlock()
	out := make([]leaseVMTrace, 0, len(vms))
	for _, vm := range vms {
		out = append(out, vmTrace(t, asFirecracker(t, vm)))
	}
	return out
}

// workspaceOf is key's workspace directory and its image, both required to exist now.
func workspaceOf(t *testing.T, g *leaseGate, key string) (dir, img string) {
	t.Helper()
	dir = filepath.Join(g.p.cfg.WorkspaceRoot, key)
	img = filepath.Join(dir, "workspace.img")
	for _, p := range []string{dir, img} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("workspace of %s: %v", key, err)
		}
	}
	return dir, img
}

// requireWorkspaceGone fails unless key's directory and every detached copy of it
// (.reclaiming-<key>-*) are gone within the bound.
func requireWorkspaceGone(t *testing.T, g *leaseGate, key string, within time.Duration) {
	t.Helper()
	dir := filepath.Join(g.p.cfg.WorkspaceRoot, key)
	deadline := time.Now().Add(within)
	for {
		left := []string{}
		if _, err := os.Lstat(dir); err == nil {
			left = append(left, dir)
		}
		tombs, _ := filepath.Glob(filepath.Join(g.p.cfg.WorkspaceRoot, tombstonePrefix+key+"-*"))
		left = append(left, tombs...)
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s after the release, the workspace of %s is still present: %s", within, key, strings.Join(left, "; "))
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// requireNoVMPids fails unless no process is left in any VM cgroup under parent within
// the bound.
func requireNoVMPids(t *testing.T, parent string, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		n, err := countCgroupPids(parent)
		if err == nil && n == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d process(es) still under %s %s after the release (%v)", n, parent, within, err)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func waitStandbys(t *testing.T, g *leaseGate, want int) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for g.p.Stats().StandbysResident < want {
		if time.Now().After(deadline) {
			t.Fatalf("StandbysResident = %d after 30s, want %d", g.p.Stats().StandbysResident, want)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// TestGateReleaseOfAnIdleRunFreesItsVMsAndWorkspace: an idle run's Release frees both
// standbys (jail, sockets, cgroup, VMM) and the workspace on the host within 10 s.
func TestGateReleaseOfAnIdleRunFreesItsVMsAndWorkspace(t *testing.T) {
	requireKVM(t)
	g, _ := newReleaseGate(t)
	const key = "release-idle"
	g.run(t, key, Exec{Command: "echo x > /workspace/f", TimeoutS: 60})
	waitStandbys(t, g, DefaultStandbyDepth)
	trs := standbyTraces(t, g, key)
	if len(trs) != DefaultStandbyDepth {
		t.Fatalf("traced %d standbys, want %d", len(trs), DefaultStandbyDepth)
	}
	parent := filepath.Dir(trs[0].cgroup)
	workspaceOf(t, g, key)

	o, err := g.p.Release(context.Background(), key)
	if err != nil || o != ReleaseReleased {
		t.Fatalf("Release = %q, %v; want %q", o, err, ReleaseReleased)
	}
	for _, tr := range trs {
		requireLeaseVMGone(t, tr, 10*time.Second)
	}
	requireWorkspaceGone(t, g, key, 10*time.Second)
	requireNoVMPids(t, parent, 10*time.Second)
	s := g.p.Stats()
	if s.ActiveRuns != 0 || s.StandbysResident != 0 || s.Releases[ReleaseReleased] != 1 {
		t.Fatalf("Stats: ActiveRuns %d, StandbysResident %d, Releases %v; want 0, 0, released 1",
			s.ActiveRuns, s.StandbysResident, s.Releases)
	}
}

// TestGateReleaseDuringAnExecIsKeptBusyThenFreed: with a command running, a Release is
// kept_busy: the standbys go at once, the workspace and the running VM stay, the command
// finishes normally, and then its unwind frees the VM and the workspace (the sweep can't:
// its timers are an hour away).
func TestGateReleaseDuringAnExecIsKeptBusyThenFreed(t *testing.T) {
	requireKVM(t)
	g, rec := newReleaseGate(t)
	const key = "release-busy"
	g.run(t, key, Exec{Command: "true", TimeoutS: 60})
	waitStandbys(t, g, DefaultStandbyDepth)
	entered := make(chan string, 4)
	rec.onEntry(entered)
	type result struct {
		res    Result
		stdout string
		err    error
	}
	done := make(chan result, 1)
	go func() {
		res, stdout, _, err := g.exec(key, Exec{Command: "sleep 8; echo done", TimeoutS: 60})
		done <- result{res, stdout, err}
	}()
	<-entered
	rec.onEntry(nil)

	g.p.mu.Lock()
	inFlight := g.p.runs[key].inFlight
	g.p.mu.Unlock()
	if inFlight != 1 {
		t.Fatalf("inFlight = %d with the command running, want 1", inFlight)
	}
	trs := standbyTraces(t, g, key)
	if len(trs) == 0 {
		t.Fatal("no standby to trace beside the running Exec")
	}
	parent := filepath.Dir(trs[0].cgroup)
	dir, img := workspaceOf(t, g, key)

	o, err := g.p.Release(context.Background(), key)
	if err != nil || o != ReleaseKeptBusy {
		t.Fatalf("Release during an Exec = %q, %v; want %q", o, err, ReleaseKeptBusy)
	}
	for _, tr := range trs {
		requireLeaseVMGone(t, tr, 10*time.Second)
	}
	for _, p := range []string{dir, img} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("the running command's workspace after a kept_busy release: %v", err)
		}
	}
	if n, _ := countCgroupPids(parent); n == 0 {
		t.Fatal("no VMM process under the gate's parent: the running Exec's VM is gone")
	}

	r := <-done
	if r.err != nil || r.res.ExitCode != 0 || r.res.TeardownFailed || strings.TrimSpace(r.stdout) != "done" {
		t.Fatalf("the running Exec after a kept_busy release: err %v, exit %d, teardown_failed %v, stdout %q",
			r.err, r.res.ExitCode, r.res.TeardownFailed, r.stdout)
	}
	requireWorkspaceGone(t, g, key, 10*time.Second)
	requireNoVMPids(t, parent, 10*time.Second)
	if s := g.p.Stats(); s.ActiveRuns != 0 || s.StandbysResident != 0 {
		t.Fatalf("Stats after the Exec: ActiveRuns %d, StandbysResident %d; want 0, 0", s.ActiveRuns, s.StandbysResident)
	}
}

// TestGateExecAfterReleaseIsRefused: after a Release, an Exec for the key is refused
// released, restores no VM and does not re-create the workspace; an unknown key released
// first is refused the same way.
func TestGateExecAfterReleaseIsRefused(t *testing.T) {
	requireKVM(t)
	g, rec := newReleaseGate(t)
	const key = "release-refused"
	g.run(t, key, Exec{Command: "true", TimeoutS: 60})
	waitStandbys(t, g, DefaultStandbyDepth)
	if o, err := g.p.Release(context.Background(), key); err != nil || o != ReleaseReleased {
		t.Fatalf("Release = %q, %v; want %q", o, err, ReleaseReleased)
	}
	requireWorkspaceGone(t, g, key, 10*time.Second)
	if o, err := g.p.Release(context.Background(), "release-unknown"); err != nil || o != ReleaseUnknownKey {
		t.Fatalf("Release of an unknown key = %q, %v; want %q", o, err, ReleaseUnknownKey)
	}

	before := rec.restores.Load()
	for _, k := range []string{key, "release-unknown"} {
		_, _, _, err := g.exec(k, Exec{Command: "echo no", TimeoutS: 60})
		if ReasonOf(err) != RefuseReleased {
			t.Fatalf("Exec on %s after its release: err = %v, want %s", k, err, RefuseReleased)
		}
		if _, err := os.Lstat(filepath.Join(g.p.cfg.WorkspaceRoot, k)); !os.IsNotExist(err) {
			t.Fatalf("the refused Exec on %s re-created its workspace (%v)", k, err)
		}
	}
	if got := rec.restores.Load(); got != before {
		t.Fatalf("restored %d VM(s) for refused Execs, want 0", got-before)
	}
	if n := g.p.Stats().Refusals[RefuseReleased]; n != 2 {
		t.Fatalf("Refusals[%s] = %d, want 2", RefuseReleased, n)
	}
}

// TestGateKeptBusyReleaseRestoresNoStandby (review M1 on real VMs): Exec A running and
// Exec B queued on the run's gate (Firecracker serializes a run's Execs); a Release is
// kept_busy. From then on no standby is restored: StandbysResident stays 0, and the
// Restore count grows by at most B's own acquire, through 5 × ReplenishDelay after A ends
// and until B ends. Then everything is freed.
func TestGateKeptBusyReleaseRestoresNoStandby(t *testing.T) {
	requireKVM(t)
	g, rec := newReleaseGate(t)
	const key = "release-replenish"
	g.run(t, key, Exec{Command: "true", TimeoutS: 60})
	waitStandbys(t, g, DefaultStandbyDepth)
	parent := filepath.Dir(standbyTraces(t, g, key)[0].cgroup)

	entered := make(chan string, 4)
	rec.onEntry(entered)
	doneA, doneB := make(chan error, 1), make(chan error, 1)
	go func() {
		_, _, _, err := g.exec(key, Exec{Command: "sleep 6", TimeoutS: 60})
		doneA <- err
	}()
	if c := <-entered; c != "sleep 6" {
		t.Fatalf("first command to start = %q, want A's", c)
	}
	go func() {
		_, _, _, err := g.exec(key, Exec{Command: "sleep 2", TimeoutS: 60})
		doneB <- err
	}()
	time.Sleep(500 * time.Millisecond) // B reaches the run's gate behind A

	o, err := g.p.Release(context.Background(), key)
	if err != nil || o != ReleaseKeptBusy {
		t.Fatalf("Release = %q, %v; want %q", o, err, ReleaseKeptBusy)
	}
	base := rec.restores.Load()

	sample := func(until <-chan struct{}) {
		for {
			if s := g.p.Stats(); s.StandbysResident != 0 {
				t.Errorf("StandbysResident = %d after a kept_busy release, want 0", s.StandbysResident)
				return
			}
			if extra := rec.restores.Load() - base; extra > 1 {
				t.Errorf("%d VMs restored after a kept_busy release, want at most B's own acquire", extra)
				return
			}
			select {
			case <-until:
				return
			case <-time.After(100 * time.Millisecond):
			}
		}
	}
	aDone := make(chan struct{})
	go func() {
		if err := <-doneA; err != nil {
			t.Errorf("Exec A: %v", err)
		}
		close(aDone)
	}()
	sample(aDone)
	window := time.After(5 * DefaultReplenishDelay)
	bDone := make(chan struct{})
	go func() {
		if err := <-doneB; err != nil {
			t.Errorf("Exec B: %v", err)
		}
		<-window
		close(bDone)
	}()
	sample(bDone)
	rec.onEntry(nil)

	requireWorkspaceGone(t, g, key, 10*time.Second)
	requireNoVMPids(t, parent, 10*time.Second)
	if s := g.p.Stats(); s.ActiveRuns != 0 || s.StandbysResident != 0 {
		t.Fatalf("Stats after both Execs: ActiveRuns %d, StandbysResident %d; want 0, 0", s.ActiveRuns, s.StandbysResident)
	}
}
