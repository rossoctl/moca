package vmpool

import (
	"context"
	"errors"
	"fmt"
	"os"
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
	err := v.fakeVM.Destroy()
	v.l.record("destroyed " + v.id)
	return err
}

// leasePool is a lease-enabled pool (Firecracker kind + lease-v1) over a leaseLauncher.
func leasePool(t *testing.T, tweak func(*Config)) (*pool, *leaseLauncher, *fakeClock) {
	t.Helper()
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
		clk.Advance(6 * time.Second)
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
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Open == nil || s.Pending != nil {
		t.Fatalf("state = %+v, want the open lease kept for the next process and nothing pending", s)
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
