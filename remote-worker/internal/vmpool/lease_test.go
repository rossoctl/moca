package vmpool

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// leaseLauncher wraps the fake launcher so its VMs also implement leaseCgrouper and
// leaseFootprinter, and records the order of every Restore, LeaseCgroup, Resume, Run and
// completed Destroy, plus every Command. The wrapping lives here rather than in
// launcher_fake_test.go so the shared fake stays the one every other suite uses.
type leaseLauncher struct {
	*fakeLauncher

	rec        sync.Mutex
	events     []string
	cmds       []Command
	cgroupMax  []int64
	leaseBytes int64 // LeaseBytes' answer; 0 = an error
	// destroyHook, when set, runs at the start of every Destroy with the VM's id.
	destroyHook func(id string)
}

func newLeaseLauncher() *leaseLauncher {
	lc := newFakeLauncher()
	lc.setSerialize(true) // the Firecracker arm's answer; lease mode is Firecracker-only
	return &leaseLauncher{fakeLauncher: lc}
}

func (l *leaseLauncher) record(ev string) {
	l.rec.Lock()
	l.events = append(l.events, ev)
	l.rec.Unlock()
}

func (l *leaseLauncher) eventLog() []string {
	l.rec.Lock()
	defer l.rec.Unlock()
	return slices.Clone(l.events)
}

func (l *leaseLauncher) commands() []Command {
	l.rec.Lock()
	defer l.rec.Unlock()
	return slices.Clone(l.cmds)
}

func (l *leaseLauncher) count(prefix string) int {
	n := 0
	for _, ev := range l.eventLog() {
		if strings.HasPrefix(ev, prefix) {
			n++
		}
	}
	return n
}

func (l *leaseLauncher) Restore(ctx context.Context, req RestoreRequest) (VM, error) {
	l.record("restore " + req.ID)
	vm, err := l.fakeLauncher.Restore(ctx, req)
	if err != nil {
		return nil, err
	}
	return &leaseFakeVM{fakeVM: vm.(*fakeVM), l: l}, nil
}

type leaseFakeVM struct {
	*fakeVM
	l *leaseLauncher
}

func (v *leaseFakeVM) LeaseCgroup(maxBytes int64) error {
	v.l.rec.Lock()
	v.l.cgroupMax = append(v.l.cgroupMax, maxBytes)
	v.l.rec.Unlock()
	v.l.record("lease-cgroup " + v.id)
	return nil
}

func (v *leaseFakeVM) LeaseBytes() (int64, error) {
	v.l.rec.Lock()
	defer v.l.rec.Unlock()
	if v.l.leaseBytes == 0 {
		return 0, fmt.Errorf("leaseFakeVM %s: no lease footprint configured", v.id)
	}
	return v.l.leaseBytes, nil
}

func (v *leaseFakeVM) Resume(ctx context.Context) error {
	v.l.record("resume " + v.id)
	return v.fakeVM.Resume(ctx)
}

func (v *leaseFakeVM) Run(ctx context.Context, c Command, out Sink) (Result, error) {
	v.l.rec.Lock()
	v.l.cmds = append(v.l.cmds, c)
	v.l.rec.Unlock()
	v.l.record("run " + v.id)
	return v.fakeVM.Run(ctx, c, out)
}

func (v *leaseFakeVM) Destroy() error {
	v.l.rec.Lock()
	hook := v.l.destroyHook
	v.l.rec.Unlock()
	if hook != nil {
		hook(v.id)
	}
	err := v.fakeVM.Destroy()
	v.l.record("destroyed " + v.id)
	return err
}

// leasePool is a lease-enabled pool (Firecracker kind + lease-v1) over a leaseLauncher.
func leasePool(t *testing.T, tweak func(*Config)) (*pool, *leaseLauncher, *fakeClock) {
	t.Helper()
	plentyOfHostMemory(t) // no memory reclaim on the host's own MemAvailable (lease_reclaim_test.go)
	lc := newLeaseLauncher()
	clk := newFakeClock()
	cfg := Config{
		VMM:               lc.Kind(),
		SnapshotDir:       t.TempDir(),
		WorkspaceRoot:     t.TempDir(),
		MaxRuns:           16,
		MaxCommittedBytes: 32 << 30,
		ManifestFeatures:  []string{FeatureLeaseV1},
	}
	if tweak != nil {
		tweak(&cfg)
	}
	p, err := New(cfg, lc, clk)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p.(*pool), lc, clk
}

func leaseExec(cmd string, epoch uint64) Exec {
	return Exec{Command: cmd, TimeoutS: 30, Mode: ModeLease, ModeEpoch: epoch}
}

func mustExec(t *testing.T, p *pool, key string, e Exec) Result {
	t.Helper()
	res, err := p.Exec(t.Context(), key, e, &capturingSink{})
	if err != nil {
		t.Fatalf("Exec(%q, %s): %v", e.Command, e.Mode, err)
	}
	return res
}

func mustSetMode(t *testing.T, p *pool, key string, m Mode, epoch uint64) {
	t.Helper()
	if err := p.SetMode(key, m, epoch); err != nil {
		t.Fatalf("SetMode(%s, %d): %v", m, epoch, err)
	}
}

func liveLease(p *pool, key string) *vmLease {
	p.mu.Lock()
	defer p.mu.Unlock()
	if rp := p.runs[key]; rp != nil {
		return rp.lease
	}
	return nil
}

func TestLeaseSecondExecReusesTheVM(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)

	mustExec(t, p, "k", leaseExec("one", 1))
	st := p.Stats()
	if st.InFlight != 0 {
		t.Fatalf("InFlight between lease Execs = %d, want 0 (a lease VM is not an in-flight VM)", st.InFlight)
	}
	if st.CommittedBytes != p.cfg.LeaseStartBytes {
		t.Fatalf("CommittedBytes with one idle lease = %d, want LeaseStartBytes %d", st.CommittedBytes, p.cfg.LeaseStartBytes)
	}
	mustExec(t, p, "k", leaseExec("two", 1))

	if n := lc.count("restore "); n != 1 {
		t.Errorf("Restore calls = %d, want 1", n)
	}
	if n := lc.count("resume "); n != 1 {
		t.Errorf("Resume calls = %d, want 1", n)
	}
	cmds := lc.commands()
	if len(cmds) != 2 {
		t.Fatalf("Runs = %d, want 2", len(cmds))
	}
	for i, c := range cmds {
		if !c.Lease {
			t.Errorf("Run %d: Command.Lease = false, want true", i)
		}
	}
	if lc.liveCount() != 1 {
		t.Errorf("live VMs = %d, want the one lease VM", lc.liveCount())
	}
}

func TestLeaseCgroupRaisedOnceBeforeResume(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	lc.leaseBytes = 300 << 20
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("one", 1))
	mustExec(t, p, "k", leaseExec("two", 1))

	want := PerVMBytes(p.cfg) + p.cfg.LeasePageCacheBytes
	if !slices.Equal(lc.cgroupMax, []int64{want}) {
		t.Fatalf("LeaseCgroup calls = %v, want exactly [%d] (PerVMBytes + LeasePageCacheBytes)", lc.cgroupMax, want)
	}
	ev := lc.eventLog()
	if i, j := slices.Index(ev, "lease-cgroup vm-1"), slices.Index(ev, "resume vm-1"); i < 0 || j < 0 || i > j {
		t.Fatalf("events = %v: LeaseCgroup must precede the VM's Resume", ev)
	}
	l := liveLease(p, "k")
	if l == nil || !l.sampled || l.charge != 300<<20 {
		t.Fatalf("lease after an Exec = %+v, want charge sampled from LeaseBytes (300 MiB)", l)
	}
}

func TestLeaseFirstExecNormalisesAfterRootWrote(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	root := p.cfg.WorkspaceRoot
	// A key whose state is known and clean, so only the per-Exec Exec below can set root_wrote.
	if err := saveLeaseState(root, "k", leaseState{Mode: ModeLease, Epoch: 1, Known: true}); err != nil {
		t.Fatal(err)
	}
	mustExec(t, p, "k", Exec{Command: "as-root", TimeoutS: 30}) // unversioned per-Exec (epoch 0)
	if s := loadLeaseState(root, "k"); !s.RootWrote {
		t.Fatalf("after a per-Exec Exec: state = %+v, want root_wrote", s)
	}

	mustExec(t, p, "k", leaseExec("one", 1))
	mustExec(t, p, "k", leaseExec("two", 1))
	var lease []Command
	for _, c := range lc.commands() {
		if c.Lease {
			lease = append(lease, c)
		}
	}
	if len(lease) != 2 || !lease[0].NormaliseWorkspace || lease[1].NormaliseWorkspace {
		t.Fatalf("lease Commands = %+v, want NormaliseWorkspace true then false", lease)
	}
	if s := loadLeaseState(root, "k"); s.RootWrote {
		t.Fatalf("after the first lease Exec: state = %+v, want root_wrote false", s)
	}
}

// R7: a key with no state file has an unknown history, so its first lease normalises.
func TestLeaseOnAKeyWithNoPriorStateNormalises(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1) // the only way a key with no file reaches lease mode
	mustExec(t, p, "k", leaseExec("one", 1))
	mustExec(t, p, "k", leaseExec("two", 1))
	cmds := lc.commands()
	if len(cmds) != 2 || !cmds[0].NormaliseWorkspace || cmds[1].NormaliseWorkspace {
		t.Fatalf("Commands = %+v, want NormaliseWorkspace true then false", cmds)
	}
}

// R6: an unversioned per-Exec Exec on a key that never used lease mode creates no state.
func TestUnversionedPerExecCreatesNoStateFile(t *testing.T) {
	p, _, _ := leasePool(t, nil)
	mustExec(t, p, "k", Exec{Command: "true", TimeoutS: 30})
	if _, err := os.Stat(leaseStatePath(p.cfg.WorkspaceRoot, "k")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("state file after an epoch-0 per-Exec Exec: stat err = %v, want not-exist", err)
	}
}

func TestLeaseNeverResumesAfterTheFirstExec(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	for i := range 3 {
		mustExec(t, p, "k", leaseExec(fmt.Sprintf("c%d", i), 1))
	}
	if n := lc.count("resume "); n != 1 {
		t.Fatalf("Resume calls over three lease Execs = %d, want 1", n)
	}
	if n := lc.count("run "); n != 3 {
		t.Fatalf("Runs = %d, want 3", n)
	}
}

func TestLeaseExecsSerialise(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	var active, overlaps atomic.Int32
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
		if active.Add(1) > 1 {
			overlaps.Add(1)
		}
		entered <- struct{}{}
		<-release
		active.Add(-1)
		return Result{}, nil
	})
	errs := make(chan error, 2)
	run := func(cmd string) {
		_, err := p.Exec(context.Background(), "k", leaseExec(cmd, 1), &capturingSink{})
		errs <- err
	}
	go run("a")
	<-entered
	go run("b")
	// b must be parked on the gate, not in Run, while a runs.
	time.Sleep(50 * time.Millisecond)
	if n := lc.count("run "); n != 1 {
		t.Fatalf("Runs while the first holds the gate = %d, want 1", n)
	}
	close(release)
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatalf("Exec: %v", err)
		}
	}
	if overlaps.Load() != 0 {
		t.Fatalf("two lease Execs overlapped inside Run")
	}
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls = %d, want 1 (one VM per key)", n)
	}
}

// Review Focus 2.
func TestPerExecOnALeaseKeyEndsTheLeaseFirst(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	root := p.cfg.WorkspaceRoot
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("lease", 1))
	if s := loadLeaseState(root, "k"); s.RootWrote || s.Open == nil {
		t.Fatalf("state with a live lease = %+v, want open and root_wrote false", s)
	}

	// A downgrade whose SetMode never arrived: the per-Exec Exec carries the newer epoch.
	mustExec(t, p, "k", Exec{Command: "per-exec", TimeoutS: 30, Mode: ModePerExec, ModeEpoch: 2})

	ev := lc.eventLog()
	gone, next := slices.Index(ev, "destroyed vm-1"), slices.Index(ev, "restore vm-2")
	if gone < 0 || next < 0 || gone > next {
		t.Fatalf("events = %v: the lease VM must be destroyed before the per-Exec VM's Restore", ev)
	}
	s := loadLeaseState(root, "k")
	if s.Pending == nil || s.Pending.State != "end" || s.Pending.Reason != LeaseEndModeChange {
		t.Fatalf("pending = %+v, want end mode_change", s.Pending)
	}
	if s.Open != nil || !s.RootWrote || s.Mode != ModePerExec || s.Epoch != 2 {
		t.Fatalf("state = %+v, want open nil, root_wrote, per-exec at epoch 2", s)
	}
	if liveLease(p, "k") != nil {
		t.Fatal("the lease is still installed")
	}
	if lc.liveCount() != 0 {
		t.Fatalf("live VMs = %d, want 0 (the per-Exec VM is destroyed after its command)", lc.liveCount())
	}
}

// An unversioned per-Exec Exec on a leased key ends the lease too: two VMs must never hold
// the workspace.
func TestUnversionedPerExecOnALeaseKeyEndsTheLease(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("lease", 1))
	mustExec(t, p, "k", Exec{Command: "per-exec", TimeoutS: 30})
	ev := lc.eventLog()
	if gone, next := slices.Index(ev, "destroyed vm-1"), slices.Index(ev, "restore vm-2"); gone < 0 || next < 0 || gone > next {
		t.Fatalf("events = %v: the lease VM must be destroyed before the per-Exec VM's Restore", ev)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending == nil || s.Pending.Reason != LeaseEndModeChange || !s.RootWrote {
		t.Fatalf("state = %+v, want pending mode_change and root_wrote", s)
	}
}

func TestLeaseVMNeverReturnsToStandbys(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reason LeaseEndReason
		runFn  func(*fakeVM, Command, Sink) (Result, error)
	}{
		{"teardown_failed", LeaseEndTeardownFailed, func(*fakeVM, Command, Sink) (Result, error) {
			return Result{TeardownFailed: true}, nil
		}},
		{"agent_dead", LeaseEndAgentDead, func(*fakeVM, Command, Sink) (Result, error) {
			return Result{}, fmt.Errorf("%w: this agent is dead", ErrGuest)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, lc, clk := leasePool(t, nil)
			// A per-Exec Exec first, so the run has standbys when the lease starts.
			mustExec(t, p, "k", Exec{Command: "warm", TimeoutS: 30})
			clk.Advance(time.Second)
			if st := p.Stats(); st.StandbysResident == 0 {
				t.Fatalf("setup: no standbys after a per-Exec Exec (%+v)", st)
			}
			mustSetMode(t, p, "k", ModeLease, 1)
			mustExec(t, p, "k", leaseExec("lease", 1))
			clk.Advance(time.Second)
			if st := p.Stats(); st.StandbysResident != 0 {
				t.Fatalf("standbys with a live lease = %d, want 0", st.StandbysResident)
			}
			l := liveLease(p, "k")
			if l == nil {
				t.Fatal("no lease after a lease Exec")
			}
			leaseVM := vmID(l.vm)

			lc.setRunFn(tc.runFn)
			_, _ = p.Exec(t.Context(), "k", leaseExec("ends it", 1), &capturingSink{})
			clk.Advance(time.Second)
			if !slices.Contains(lc.eventLog(), "destroyed "+leaseVM) {
				t.Fatalf("lease VM %s not destroyed: %v", leaseVM, lc.eventLog())
			}
			p.mu.Lock()
			ready := len(p.runs["k"].ready)
			p.mu.Unlock()
			if ready != 0 || lc.liveCount() != 0 {
				t.Fatalf("after a lease end: ready = %d, live = %d; want 0, 0", ready, lc.liveCount())
			}
			if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending == nil || s.Pending.Reason != tc.reason {
				t.Fatalf("pending = %+v, want %s", s.Pending, tc.reason)
			}
		})
	}
}

func TestLeaseAdmittedAtStartPrice(t *testing.T) {
	p, _, _ := leasePool(t, func(c *Config) {
		c.MaxCommittedBytes = DefaultLeaseStartBytes + 64<<20 // fits a lease start, not a PerVMBytes VM
	})
	if p.perVMBytes() <= p.cfg.MaxCommittedBytes {
		t.Fatalf("setup: PerVMBytes %d fits the %d budget", p.perVMBytes(), p.cfg.MaxCommittedBytes)
	}
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("lease", 1))
	mustExec(t, p, "k", leaseExec("again", 1))

	_, err := p.Exec(t.Context(), "other", Exec{Command: "true", TimeoutS: 30}, &capturingSink{})
	if ReasonOf(err) != RefuseMemoryBudget {
		t.Fatalf("per-Exec Exec on the same budget: err = %v, want %s", err, RefuseMemoryBudget)
	}
}

func TestLeaseUnsupportedRefused(t *testing.T) {
	p, lc, _ := testPool(t) // no lease-v1 in the manifest: LeaseEnabled is false
	for _, m := range []Mode{ModeLease, ModeLeaseProcesses} {
		_, err := p.Exec(t.Context(), "k", Exec{Command: "true", Mode: m, ModeEpoch: 1}, &capturingSink{})
		if ReasonOf(err) != RefuseLeaseUnsupported {
			t.Fatalf("%s Exec: err = %v, want %s", m, err, RefuseLeaseUnsupported)
		}
	}
	if n := lc.createdCount(); n != 0 {
		t.Fatalf("refused lease Execs restored %d VMs", n)
	}
}

func TestTeardownFailedEndsTheLease(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	lc.setRunFn(func(*fakeVM, Command, Sink) (Result, error) { return Result{TeardownFailed: true}, nil })
	res := mustExec(t, p, "k", leaseExec("one", 1))
	if !res.TeardownFailed {
		t.Fatalf("Result = %+v, want TeardownFailed passed through", res)
	}
	if liveLease(p, "k") != nil {
		t.Fatal("the lease survived teardown_failed")
	}
	s := loadLeaseState(p.cfg.WorkspaceRoot, "k")
	if s.Pending == nil || s.Pending.Reason != LeaseEndTeardownFailed || s.Open != nil {
		t.Fatalf("state = %+v, want pending teardown_failed and open nil", s)
	}

	lc.setRunFn(nil)
	mustExec(t, p, "k", leaseExec("two", 1))
	if n := lc.count("restore "); n != 2 {
		t.Fatalf("Restore calls = %d, want 2 (the next Exec gets a fresh VM)", n)
	}
	if n := lc.count("resume "); n != 2 {
		t.Fatalf("Resume calls = %d, want 2 (one per lease VM)", n)
	}
}

func TestRunErrorEndsTheLeaseAgentDead(t *testing.T) {
	t.Run("run error", func(t *testing.T) {
		p, lc, _ := leasePool(t, nil)
		mustSetMode(t, p, "k", ModeLease, 1)
		mustExec(t, p, "k", leaseExec("one", 1))
		lc.setRunFn(func(*fakeVM, Command, Sink) (Result, error) {
			return Result{}, fmt.Errorf("%w: this agent is dead", ErrGuest)
		})
		if _, err := p.Exec(t.Context(), "k", leaseExec("two", 1), &capturingSink{}); !errors.Is(err, ErrGuest) {
			t.Fatalf("err = %v, want the guest error", err)
		}
		assertEnded(t, p, lc, LeaseEndAgentDead)
	})
	t.Run("timeout", func(t *testing.T) {
		p, lc, clk := leasePool(t, nil)
		mustSetMode(t, p, "k", ModeLease, 1)
		entered := make(chan struct{})
		lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
			close(entered)
			<-c.ctxDone
			return Result{}, ErrAborted
		})
		errc := make(chan error, 1)
		go func() {
			_, err := p.Exec(context.Background(), "k", Exec{Command: "sleep", TimeoutS: 5, Mode: ModeLease, ModeEpoch: 1}, &capturingSink{})
			errc <- err
		}()
		<-entered
		// The host's deadline in lease mode: the budget plus LeaseTimeoutSlack, past which
		// a guest that has not answered is taken for dead (lease_timeout_test.go).
		clk.Advance(5*time.Second + LeaseTimeoutSlack)
		if err := <-errc; !errors.Is(err, ErrTimeout) {
			t.Fatalf("err = %v, want ErrTimeout", err)
		}
		assertEnded(t, p, lc, LeaseEndAgentDead)
	})
}

func assertEnded(t *testing.T, p *pool, lc *leaseLauncher, reason LeaseEndReason) {
	t.Helper()
	if liveLease(p, "k") != nil {
		t.Fatalf("the lease survived %s", reason)
	}
	if lc.liveCount() != 0 {
		t.Fatalf("live VMs = %d, want 0", lc.liveCount())
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending == nil || s.Pending.Reason != reason || s.Open != nil {
		t.Fatalf("state = %+v, want pending %s and open nil", s, reason)
	}
}

// An Exec holding the gate when Close runs destroys its own lease VM, and leaves the file's
// open lease for the next process to report (worker_restart, Task 5).
func TestLeaseExecDestroysItsVMWhenThePoolClosed(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	entered := make(chan struct{})
	release := make(chan struct{})
	lc.setRunFn(func(*fakeVM, Command, Sink) (Result, error) {
		close(entered)
		<-release
		return Result{}, nil
	})
	errc := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "k", leaseExec("one", 1), &capturingSink{})
		errc <- err
	}()
	<-entered
	_ = p.Close()
	close(release)
	<-errc
	if lc.liveCount() != 0 {
		t.Fatalf("live VMs after Close and the Exec's return = %d, want 0", lc.liveCount())
	}
	// The lease start is pending (Task 5); no end is recorded in-process.
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Open == nil || s.Pending == nil || s.Pending.State != "start" {
		t.Fatalf("state = %+v, want the open lease kept for the next process and no end pending", s)
	}
}

func TestLeaseExecStaleEpochRefused(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 3)
	_, err := p.Exec(t.Context(), "k", leaseExec("old token", 2), &capturingSink{})
	if ReasonOf(err) != RefuseStaleMode {
		t.Fatalf("err = %v, want %s", err, RefuseStaleMode)
	}
	if n := lc.createdCount(); n != 0 {
		t.Fatalf("a stale-mode Exec restored %d VMs", n)
	}
}

// A run created by routeExec still counts its first cold acquire as first-exec, for a lease
// Exec and for a versioned per-Exec Exec alike; an unversioned per-Exec Exec is unchanged.
func TestFirstExecOnANewKeyCountsFirstExec(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(*pool)
		e     Exec
	}{
		{"lease", func(p *pool) { _ = p.SetMode("k", ModeLease, 1) }, leaseExec("one", 1)},
		{"per-exec with epoch", nil, Exec{Command: "one", TimeoutS: 30, Mode: ModePerExec, ModeEpoch: 1}},
		{"per-exec epoch 0", nil, Exec{Command: "one", TimeoutS: 30}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, _, _ := leasePool(t, nil)
			if tc.setup != nil {
				tc.setup(p)
			}
			mustExec(t, p, "k", tc.e)
			cold := p.Stats().ColdAcquires
			if cold[ColdFirstExec] != 1 || cold[ColdExhausted] != 0 {
				t.Fatalf("ColdAcquires = %v, want first-exec 1 and exhausted 0", cold)
			}
		})
	}
}

// --- The lease ticker (Task 4): idle, keepalive, maximum duration, grace limit. ---

func (l *leaseLauncher) setDestroyHook(f func(id string)) {
	l.rec.Lock()
	l.destroyHook = f
	l.rec.Unlock()
}

// recvWithin receives from c, failing the test after 5 s rather than hanging it.
func recvWithin[T any](t *testing.T, c <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-c:
		return v
	case <-time.After(5 * time.Second):
		t.Fatalf("%s: not within 5s", what)
	}
	var zero T
	return zero
}

// leaseExecIdle is leaseExec with an owner idle timeout.
func leaseExecIdle(cmd string, idle time.Duration) Exec {
	e := leaseExec(cmd, 1)
	e.IdleTimeout = idle
	return e
}

// leaseEnded waits for key's lease to be gone and its VM destroyed, then checks the
// recorded end reason.
func leaseEnded(t *testing.T, p *pool, lc *leaseLauncher, reason LeaseEndReason) {
	t.Helper()
	waitFor(t, func() bool { return liveLease(p, "k") == nil && lc.liveCount() == 0 })
	assertEnded(t, p, lc, reason)
}

func leaseAlive(t *testing.T, p *pool, at string) *vmLease {
	t.Helper()
	l := liveLease(p, "k")
	if l == nil {
		t.Fatalf("%s: the lease ended, want it alive (state %+v)", at, loadLeaseState(p.cfg.WorkspaceRoot, "k"))
	}
	return l
}

func leaseExpiring(p *pool) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	rp := p.runs["k"]
	return rp != nil && rp.lease != nil && rp.lease.expiring
}

// execEvery advances the clock by step and runs e, n times: Execs close enough together
// that the lease never idles out.
func execEvery(t *testing.T, p *pool, clk *fakeClock, e Exec, step time.Duration, n int) {
	t.Helper()
	for range n {
		clk.Advance(step)
		mustExec(t, p, "k", e)
	}
}

func TestLeaseEndsAtIdle(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExecIdle("one", 30*time.Second))
	clk.Advance(29 * time.Second)
	leaseAlive(t, p, "+29s")
	clk.Advance(2 * time.Second)
	leaseEnded(t, p, lc, LeaseEndIdle)
}

// A later lease Exec carries the owner's current idle timeout, clamped as at start.
func TestLaterLeaseExecAppliesItsIdleTimeout(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExecIdle("one", 600*time.Second))
	mustExec(t, p, "k", leaseExecIdle("two", 5*time.Second)) // raised to LeaseIdleMin, 30 s
	if l := leaseAlive(t, p, "after the second Exec"); l.idle != p.cfg.LeaseIdleMin {
		t.Fatalf("idle = %v, want the second Exec's value clamped to %v", l.idle, p.cfg.LeaseIdleMin)
	}
	clk.Advance(29 * time.Second)
	leaseAlive(t, p, "+29s")
	clk.Advance(2 * time.Second)
	leaseEnded(t, p, lc, LeaseEndIdle)
}

func TestKeepaliveDoesNotResetIdle(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	e := leaseExecIdle("one", 30*time.Second)
	e.Keepalive = true
	mustExec(t, p, "k", e)
	for range 2 {
		clk.Advance(10 * time.Second)
		if err := p.Keepalive("k"); err != nil {
			t.Fatalf("Keepalive: %v", err)
		}
	}
	clk.Advance(9 * time.Second)
	leaseAlive(t, p, "+29s")
	if err := p.Keepalive("k"); err != nil {
		t.Fatalf("Keepalive: %v", err)
	}
	clk.Advance(2 * time.Second)
	leaseEnded(t, p, lc, LeaseEndIdle)
}

// Keepalive on a key without a live lease is a no-op: no error, no run, no lease.
func TestKeepaliveWithoutALeaseIsANoOp(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	if err := p.Keepalive("k"); err != nil {
		t.Fatalf("Keepalive: %v", err)
	}
	p.mu.Lock()
	n := len(p.runs)
	p.mu.Unlock()
	if n != 0 || lc.createdCount() != 0 {
		t.Fatalf("Keepalive with no lease created %d runs and %d VMs", n, lc.createdCount())
	}
	if ReasonOf(p.Keepalive("")) != RefuseEmptyKey {
		t.Fatalf("Keepalive(\"\") did not refuse the empty key")
	}
}

func TestKeepaliveLossEnds(t *testing.T) {
	idle := 300 * time.Second
	for _, tc := range []struct {
		name string
		run  func(t *testing.T, p *pool, clk *fakeClock)
	}{
		{"opted in at start", func(t *testing.T, p *pool, clk *fakeClock) {
			e := leaseExecIdle("one", idle)
			e.Keepalive = true
			mustExec(t, p, "k", e)
		}},
		{"opted in by a later Exec", func(t *testing.T, p *pool, clk *fakeClock) {
			mustExec(t, p, "k", leaseExecIdle("one", idle))
			clk.Advance(100 * time.Second) // past the loss limit, but the rule is off
			e := leaseExecIdle("two", idle)
			e.Keepalive = true
			mustExec(t, p, "k", e)
		}},
		{"opted in by a keepalive", func(t *testing.T, p *pool, clk *fakeClock) {
			mustExec(t, p, "k", leaseExecIdle("one", idle))
			clk.Advance(100 * time.Second)
			if err := p.Keepalive("k"); err != nil {
				t.Fatalf("Keepalive: %v", err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, lc, clk := leasePool(t, nil)
			mustSetMode(t, p, "k", ModeLease, 1)
			tc.run(t, p, clk)
			clk.Advance(119 * time.Second)
			if !leaseAlive(t, p, "119 s without a keepalive").keepalive {
				t.Fatalf("the keepalive rule is off")
			}
			clk.Advance(2 * time.Second)
			leaseEnded(t, p, lc, LeaseEndKeepaliveLost)
		})
	}
}

func TestNoKeepaliveRuleWithoutOptIn(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExecIdle("one", 300*time.Second))
	clk.Advance(299 * time.Second) // far past LeaseKeepaliveLoss
	if leaseAlive(t, p, "+299s").keepalive {
		t.Fatalf("the keepalive rule is on without an opt-in")
	}
	clk.Advance(2 * time.Second)
	leaseEnded(t, p, lc, LeaseEndIdle)
}

// Execs every 4 min keep the default 300 s idle from ending the lease; at 8 h it
// expires, and it ends max_duration at its next idle.
func TestMaxDurationExpiresThenEndsAtIdle(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	e := leaseExec("work", 1)
	mustExec(t, p, "k", e)
	step := 240 * time.Second
	execEvery(t, p, clk, e, step, int(8*time.Hour/step)-1) // +7h56m
	if leaseExpiring(p) {
		t.Fatalf("expiring at 7h56m, before LeaseMaxDuration")
	}
	execEvery(t, p, clk, e, step, 1) // +8h
	leaseAlive(t, p, "+8h")
	if !leaseExpiring(p) {
		t.Fatalf("not expiring at LeaseMaxDuration")
	}
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls = %d, want the one lease VM throughout", n)
	}
	clk.Advance(299 * time.Second)
	leaseAlive(t, p, "an expiring lease before its idle")
	clk.Advance(2 * time.Second)
	leaseEnded(t, p, lc, LeaseEndMaxDuration)
}

func TestLeaseProcessesUsesItsMaxDuration(t *testing.T) {
	p, _, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	e := Exec{Command: "work", TimeoutS: 30, Mode: ModeLeaseProcesses, ModeEpoch: 1}
	mustExec(t, p, "k", e)
	step := 240 * time.Second
	execEvery(t, p, clk, e, step, int(4*time.Hour/step)-1)
	if leaseExpiring(p) {
		t.Fatalf("expiring before LeaseMaxDurationProcesses")
	}
	execEvery(t, p, clk, e, step, 1)
	leaseAlive(t, p, "+4h")
	if !leaseExpiring(p) {
		t.Fatalf("a lease+processes lease not expiring at LeaseMaxDurationProcesses (4 h)")
	}
}

func TestGraceLimitEndsMidExec(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	e := leaseExec("work", 1)
	mustExec(t, p, "k", e)
	step := 240 * time.Second
	execEvery(t, p, clk, e, step, int(8*time.Hour/step))
	if !leaseExpiring(p) {
		t.Fatalf("not expiring at 8 h")
	}
	entered := make(chan struct{})
	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
		close(entered)
		<-c.ctxDone
		return Result{}, ErrAborted
	})
	errc := make(chan error, 1)
	go func() {
		_, err := p.Exec(context.Background(), "k",
			Exec{Command: "long", TimeoutS: MaxExecTimeoutS, Mode: ModeLease, ModeEpoch: 1}, &capturingSink{})
		errc <- err
	}()
	<-entered
	clk.Advance(29 * time.Minute)
	select {
	case err := <-errc:
		t.Fatalf("the Exec ended before the grace limit: %v", err)
	default:
	}
	leaseAlive(t, p, "before the grace limit")
	clk.Advance(2 * time.Minute)
	err := recvWithin(t, errc, "the Exec's return at the grace limit")
	var le *LeaseEndedError
	if !errors.Is(err, ErrLeaseEnded) || !errors.As(err, &le) || le.Reason != LeaseEndGraceLimit {
		t.Fatalf("err = %v, want ErrLeaseEnded(grace_limit)", err)
	}
	if errors.Is(err, ErrAborted) {
		t.Fatalf("err = %v also matches ErrAborted", err)
	}
	leaseEnded(t, p, lc, LeaseEndGraceLimit)
}

// An Exec that arrives past the grace limit, before the lease sweep has run, ends the
// lease (grace_limit) and runs in a fresh VM rather than in one the next tick would cut.
func TestExecPastTheGraceLimitStartsAFreshLease(t *testing.T) {
	// A slow ticker, so that only the Exec can see the grace limit pass; Normalize holds
	// LeaseScanInterval to LeaseIdleMin/4, so the idle bounds rise with it.
	p, lc, clk := leasePool(t, func(c *Config) {
		c.LeaseScanInterval = time.Hour
		c.LeaseIdleMin, c.LeaseIdleDefault, c.LeaseIdleCeiling = 4*time.Hour, 4*time.Hour, 4*time.Hour
	})
	mustSetMode(t, p, "k", ModeLease, 1)
	e := leaseExec("work", 1)
	mustExec(t, p, "k", e)
	old := vmID(leaseAlive(t, p, "after the first Exec").vm)
	step := 240 * time.Second
	// +8h32m: past started + 8 h + 30 min, and the last tick was at +8 h.
	execEvery(t, p, clk, e, step, int((8*time.Hour+32*time.Minute)/step)-1)
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls before the grace limit = %d, want 1", n)
	}
	clk.Advance(step)
	var ph Phases
	if _, err := p.ExecPhased(t.Context(), "k", e, &capturingSink{}, &ph); err != nil {
		t.Fatalf("Exec past the grace limit: %v", err)
	}
	if ph.VMID == old || ph.Cold == "" {
		t.Fatalf("the Exec ran in %s (cold %q), want a fresh VM, not %s", ph.VMID, ph.Cold, old)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending == nil || s.Pending.Reason != LeaseEndGraceLimit {
		t.Fatalf("state = %+v, want the old lease's end pending as grace_limit", s)
	}
	if l := leaseAlive(t, p, "after the Exec"); l.expiring || lc.liveCount() != 1 {
		t.Fatalf("expiring = %v, live VMs = %d: want one fresh, non-expiring lease", l.expiring, lc.liveCount())
	}
}

// Review Focus 5: a run with a live lease is busy, so WorkspaceIdle never reclaims its
// tree; after the lease ends, the idle clocks run from the end.
func TestWorkspaceIdleNeverReclaimsALeasedRun(t *testing.T) {
	p, lc, clk := leasePool(t, func(c *Config) {
		c.StandbyIdle = 60 * time.Second
		c.WorkspaceIdle = 120 * time.Second
	})
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExecIdle("one", 600*time.Second))
	p.mu.Lock()
	dir := p.runs["k"].dir
	p.mu.Unlock()

	clk.Advance(590 * time.Second) // nearly 5 x WorkspaceIdle
	leaseAlive(t, p, "+590s")
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("workspace reclaimed under a live lease: %v", err)
	}
	clk.Advance(15 * time.Second)
	leaseEnded(t, p, lc, LeaseEndIdle)
	clk.Advance(100 * time.Second)
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("workspace reclaimed %v after the lease end, before WorkspaceIdle: %v", 100*time.Second, err)
	}
	clk.Advance(60 * time.Second)
	waitFor(t, func() bool {
		_, err := os.Stat(dir)
		return errors.Is(err, os.ErrNotExist)
	})
	// Ruling R9: the unacknowledged idle end outlives the tree, and so do the mode and
	// epoch (PR #763 review, F3); the open lease does not, and root_wrote is set.
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); !s.Known || s.Mode != ModeLease || !s.RootWrote || s.Open != nil ||
		s.Pending == nil || s.Pending.Reason != LeaseEndIdle {
		t.Fatalf("state file after the workspace reclaim = %+v, want the mode, root_wrote and the pending idle end", s)
	}
}

// Review Focus 1: the sweep holds the gate while it destroys an idle lease's VM. An Exec
// arriving then waits, restores a fresh VM only after the old one's Destroy returned, and
// runs in it.
func TestLeaseExecDuringIdleEndGetsAFreshVM(t *testing.T) {
	p, lc, clk := leasePool(t, nil)
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExecIdle("one", 30*time.Second))
	old := vmID(leaseAlive(t, p, "after the first Exec").vm)

	inDestroy := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	lc.setDestroyHook(func(id string) {
		if id == old {
			once.Do(func() { close(inDestroy) })
			<-release
		}
	})
	clk.Advance(31 * time.Second)
	recvWithin(t, inDestroy, "the idle end's Destroy")

	type out struct {
		ph  Phases
		err error
	}
	done := make(chan out, 1)
	go func() {
		var ph Phases
		_, err := p.ExecPhased(context.Background(), "k", leaseExec("two", 1), &capturingSink{}, &ph)
		done <- out{ph, err}
	}()
	time.Sleep(50 * time.Millisecond) // the Exec must be parked on the gate
	if n := lc.count("restore "); n != 1 {
		t.Fatalf("Restore calls while the old lease VM is being destroyed = %d, want 1", n)
	}
	close(release)
	o := recvWithin(t, done, "the second Exec")
	if o.err != nil {
		t.Fatalf("Exec: %v", o.err)
	}
	if o.ph.VMID == old || o.ph.Cold == "" {
		t.Fatalf("the Exec ran in %s (cold %q), want a fresh, cold VM, not %s", o.ph.VMID, o.ph.Cold, old)
	}
	ev := lc.eventLog()
	destroyed := slices.Index(ev, "destroyed "+old)
	restored := slices.Index(ev, "restore "+o.ph.VMID)
	if destroyed < 0 || restored < 0 || destroyed > restored {
		t.Fatalf("events = %v, want %s destroyed before %s is restored", ev, old, o.ph.VMID)
	}
	if l := leaseAlive(t, p, "after the second Exec"); vmID(l.vm) != o.ph.VMID {
		t.Fatalf("live lease VM = %s, want %s", vmID(l.vm), o.ph.VMID)
	}
	if lc.liveCount() != 1 {
		t.Fatalf("live VMs = %d, want the new lease VM only", lc.liveCount())
	}
}

// PR #763 review (F3): removing a workspace retires its state file. The mode and epoch are
// the control plane's, not the tree's, so they stay; root_wrote is set, because the next
// tree's history is unknown (ruling R7). A file with nothing worth keeping -- no known
// epoch and no pending event -- is deleted.
func TestWorkspaceReclaimRetiresTheStateFile(t *testing.T) {
	perExec := Exec{Command: "one", TimeoutS: 30, Mode: ModePerExec, ModeEpoch: 1}
	removals := []struct {
		name   string
		remove func(t *testing.T, p *pool, clk *fakeClock)
	}{
		{"workspace idle", func(t *testing.T, p *pool, clk *fakeClock) {
			clk.Advance(5 * time.Minute)
			waitFor(t, func() bool {
				p.mu.Lock()
				defer p.mu.Unlock()
				return p.runs["k"] == nil
			})
		}},
		{"Reclaim", func(t *testing.T, p *pool, clk *fakeClock) {
			if err := p.Reclaim(t.Context(), "k"); err != nil {
				t.Fatalf("Reclaim: %v", err)
			}
		}},
	}
	idlePool := func(t *testing.T) (*pool, *fakeClock) {
		p, _, clk := leasePool(t, func(c *Config) {
			c.StandbyIdle = 60 * time.Second
			c.WorkspaceIdle = 120 * time.Second
		})
		return p, clk
	}
	for _, rm := range removals {
		t.Run(rm.name+": the mode and epoch stay", func(t *testing.T) {
			p, clk := idlePool(t)
			mustSetMode(t, p, "k", ModePerExec, 1)
			mustExec(t, p, "k", perExec)
			rm.remove(t, p, clk)
			s := loadLeaseState(p.cfg.WorkspaceRoot, "k")
			if !s.Known || s.Mode != ModePerExec || s.Epoch != 1 || !s.RootWrote || s.Open != nil || s.Pending != nil {
				t.Fatalf("state after the removal = %+v, want per-exec at epoch 1, known, root_wrote", s)
			}
		})
		t.Run(rm.name+": nothing to keep", func(t *testing.T) {
			p, clk := idlePool(t)
			mustExec(t, p, "k", Exec{Command: "one", TimeoutS: 30}) // the run, with no state of its own
			path := leaseStatePath(p.cfg.WorkspaceRoot, "k")
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(`{"root_wrote":true}`), 0o600); err != nil {
				t.Fatal(err)
			}
			rm.remove(t, p, clk)
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("an unknown state with nothing pending after the removal: %v, want the file gone", err)
			}
		})
	}
}

// Close destroys every lease VM. It records no end in-process: each file keeps its open
// lease, so the next process reports worker_restart (Task 5).
func TestCloseEndsEveryLease(t *testing.T) {
	p, lc, _ := leasePool(t, nil)
	keys := []string{"a", "b", "c"}
	for _, k := range keys {
		mustSetMode(t, p, k, ModeLease, 1)
		mustExec(t, p, k, leaseExec("one", 1))
	}
	if lc.liveCount() != len(keys) {
		t.Fatalf("live VMs = %d, want %d leases", lc.liveCount(), len(keys))
	}
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if lc.liveCount() != 0 {
		t.Fatalf("live VMs after Close = %d, want 0", lc.liveCount())
	}
	for _, k := range keys {
		s := loadLeaseState(p.cfg.WorkspaceRoot, k)
		if s.Open == nil || s.Pending == nil || s.Pending.State != "start" {
			t.Fatalf("%s: state = %+v, want the open lease kept and no end pending (the start is)", k, s)
		}
	}
}

// The lease ticker is armed only on a lease-enabled pool: per-Exec timing is unchanged.
func TestLeaseTickerArmedOnlyWhenLeaseEnabled(t *testing.T) {
	p, _, _ := leasePool(t, nil)
	if p.leaseTicker == nil {
		t.Fatalf("no lease ticker on a lease-enabled pool")
	}
	q, _, _ := leasePool(t, func(c *Config) { c.ManifestFeatures = nil })
	if q.cfg.LeaseEnabled || q.leaseTicker != nil {
		t.Fatalf("lease ticker armed on a pool without lease-v1")
	}
}

// PR #763 review (F7): a per-Exec-only worker (LeaseEnabled false) does no lease-state
// I/O when it removes a workspace. A state file planted for the key -- one the retire
// would delete, and one it would rewrite -- is left exactly as it was.
func TestPerExecOnlyWorkerLeavesTheStateFileAlone(t *testing.T) {
	for _, rm := range []struct {
		name   string
		remove func(t *testing.T, p *pool, clk *fakeClock)
	}{
		{"workspace idle", func(t *testing.T, p *pool, clk *fakeClock) {
			clk.Advance(5 * time.Minute)
			waitFor(t, func() bool {
				p.mu.Lock()
				defer p.mu.Unlock()
				return p.runs["k"] == nil
			})
		}},
		{"Reclaim", func(t *testing.T, p *pool, clk *fakeClock) {
			if err := p.Reclaim(t.Context(), "k"); err != nil {
				t.Fatalf("Reclaim: %v", err)
			}
		}},
	} {
		for _, body := range []string{`{"root_wrote":true}`, `{"mode":"lease","epoch":3,"known":true}`} {
			t.Run(rm.name+" "+body, func(t *testing.T) {
				p, _, clk := leasePool(t, func(c *Config) {
					c.ManifestFeatures = nil // no lease-v1: LeaseEnabled false
					c.StandbyIdle = 60 * time.Second
					c.WorkspaceIdle = 120 * time.Second
				})
				if p.cfg.LeaseEnabled {
					t.Fatal("LeaseEnabled with no lease-v1 feature")
				}
				mustExec(t, p, "k", Exec{Command: "one", TimeoutS: 30})
				path := leaseStatePath(p.cfg.WorkspaceRoot, "k")
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
					t.Fatal(err)
				}
				rm.remove(t, p, clk)
				got, err := os.ReadFile(path)
				if err != nil || string(got) != body {
					t.Fatalf("the state file after the removal: %q, %v; want %q untouched", got, err, body)
				}
			})
		}
	}
}
