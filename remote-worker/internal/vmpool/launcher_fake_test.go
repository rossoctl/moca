package vmpool

import (
	"context"
	"fmt"
	"os"
	"sync"
)

// osStat is an indirection so pool_test.go can stat a workspace without importing
// os in a file that is otherwise about the pool.
func osStat(p string) (os.FileInfo, error) { return os.Stat(p) }

// fakeLauncher is the whole Phase A test substrate: in-process VMs, no KVM. It
// ENFORCES the invariants the pool must not violate — Resume before Run, exactly
// one Run per VM, no use after Destroy — so a pool bug fails loudly here rather
// than surfacing in Phase D as a density number nobody can explain.
type fakeLauncher struct {
	mu        sync.Mutex
	seq       int
	created   int
	destroyed map[string]int
	live      map[string]*fakeVM

	restoreErr    error
	beforeRestore func(RestoreRequest)
	runFn         func(*fakeVM, Command, Sink) (Result, error)
	resumeFn      func(*fakeVM, context.Context) error
	destroyErr    error
	keyOverride   string                       // hand back a VM bound to this key instead of the requested one
	serialize     bool                         // SerializesExecsPerRun's return value; false unless a test sets it
	standbyFn     func(*fakeVM) (int64, error) // fakeVM.StandbyBytes' answer; nil = "unreadable"
}

func newFakeLauncher() *fakeLauncher {
	return &fakeLauncher{destroyed: map[string]int{}, live: map[string]*fakeVM{}}
}

// Kind is Firecracker because Config.VMM must match and the arm is irrelevant to
// every Phase A test; Task 16's tests set it to CloudHypervisor explicitly.
func (l *fakeLauncher) Kind() VMMKind { return Firecracker }

// SerializesExecsPerRun returns whatever setSerialize last set (false by default),
// so most tests get the simpler unserialized behavior and only the tests that
// exist to exercise the per-run gate opt in.
func (l *fakeLauncher) SerializesExecsPerRun() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.serialize
}

func (l *fakeLauncher) setSerialize(v bool) { l.mu.Lock(); l.serialize = v; l.mu.Unlock() }

func (l *fakeLauncher) Restore(ctx context.Context, req RestoreRequest) (VM, error) {
	l.mu.Lock()
	hook, rErr, override := l.beforeRestore, l.restoreErr, l.keyOverride
	l.mu.Unlock()
	if hook != nil {
		hook(req)
	}
	if rErr != nil {
		return nil, rErr
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := req.Key
	if override != "" {
		key = override
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seq++
	l.created++
	vm := &fakeVM{lc: l, id: req.ID, key: key, dir: req.WorkspaceDir}
	l.live[req.ID] = vm
	return vm, nil
}

func (l *fakeLauncher) setRestoreErr(err error) { l.mu.Lock(); l.restoreErr = err; l.mu.Unlock() }

func (l *fakeLauncher) setBeforeRestore(f func(RestoreRequest)) {
	l.mu.Lock()
	l.beforeRestore = f
	l.mu.Unlock()
}

func (l *fakeLauncher) setRunFn(f func(*fakeVM, Command, Sink) (Result, error)) {
	l.mu.Lock()
	l.runFn = f
	l.mu.Unlock()
}

// setResumeFn installs a hook run inside fakeVM.Resume, AFTER the double-resume and
// resume-after-destroy checks and outside the fakeVM lock — same placement as runFn
// relative to Run — so a test can block a Resume in flight (e.g. to exercise a
// TimeoutS expiry or an abort landing mid-Resume) without touching the fake's
// existing strictness about resume state.
func (l *fakeLauncher) setResumeFn(f func(*fakeVM, context.Context) error) {
	l.mu.Lock()
	l.resumeFn = f
	l.mu.Unlock()
}

func (l *fakeLauncher) setKeyOverride(k string) { l.mu.Lock(); l.keyOverride = k; l.mu.Unlock() }

// setStandbyFn installs the paused-footprint answer every fakeVM reports through
// StandbyBytes — the seam standbyChargeLocked prices a standby from (#644). nil
// (the default) makes every fake VM report an error, which standbyChargeLocked
// prices at FULL PerVMBytes: tests that do not opt in keep the pre-#644
// accounting and the numbers the rest of this suite already asserts.
func (l *fakeLauncher) setStandbyFn(f func(*fakeVM) (int64, error)) {
	l.mu.Lock()
	l.standbyFn = f
	l.mu.Unlock()
}

func (l *fakeLauncher) getStandbyFn() func(*fakeVM) (int64, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.standbyFn
}

func (l *fakeLauncher) createdCount() int { l.mu.Lock(); defer l.mu.Unlock(); return l.created }

func (l *fakeLauncher) liveCount() int { l.mu.Lock(); defer l.mu.Unlock(); return len(l.live) }

func (l *fakeLauncher) destroyedFor(key string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.destroyed[key]
}

func (l *fakeLauncher) getRunFn() func(*fakeVM, Command, Sink) (Result, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.runFn
}

func (l *fakeLauncher) getResumeFn() func(*fakeVM, context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.resumeFn
}

type fakeVM struct {
	lc           *fakeLauncher
	id, key, dir string

	mu        sync.Mutex
	resumed   bool
	runs      int
	destroyed bool
	cpuReads  int // CgroupCPU's step counter (exec_timing_test.go)
}

func (v *fakeVM) Key() string { return v.key }
func (v *fakeVM) ID() string  { return v.id }

// StandbyBytes implements standbyFootprinter (budget.go) for tests that opt in
// via setStandbyFn. With no fn installed it errors, and standbyChargeLocked's
// fallback charges full PerVMBytes — deliberately, so the default fake keeps the
// pre-#644 full-RAM charge and the existing suite's arithmetic holds unchanged.
func (v *fakeVM) StandbyBytes() (int64, error) {
	fn := v.lc.getStandbyFn()
	if fn == nil {
		return 0, fmt.Errorf("fakeVM %s: no standby footprint configured", v.id)
	}
	return fn(v)
}

func (v *fakeVM) Resume(ctx context.Context) error {
	v.mu.Lock()
	if v.destroyed {
		v.mu.Unlock()
		return fmt.Errorf("fakeVM %s: Resume after Destroy", v.id)
	}
	if v.resumed {
		v.mu.Unlock()
		return fmt.Errorf("fakeVM %s: Resume twice", v.id)
	}
	v.resumed = true
	v.mu.Unlock()
	if fn := v.lc.getResumeFn(); fn != nil {
		return fn(v, ctx)
	}
	return nil
}

func (v *fakeVM) Run(ctx context.Context, c Command, out Sink) (Result, error) {
	v.mu.Lock()
	switch {
	case !v.resumed:
		v.mu.Unlock()
		return Result{}, fmt.Errorf("fakeVM %s: Run before Resume", v.id)
	case v.destroyed:
		v.mu.Unlock()
		return Result{}, fmt.Errorf("fakeVM %s: Run after Destroy", v.id)
	}
	v.runs++
	n := v.runs
	v.mu.Unlock()
	if n > 1 {
		// The property the whole slice exists for.
		return Result{}, fmt.Errorf("fakeVM %s: Run called %d times — a VM must serve exactly one Exec", v.id, n)
	}
	if fn := v.lc.getRunFn(); fn != nil {
		c.ctxDone = ctx.Done()
		return fn(v, c, out)
	}
	// Default: echo the command on stdout with exit 0, so a test can assert which
	// VM ran what without installing a hook.
	out.Stdout([]byte(c.Command))
	return Result{ExitCode: 0}, nil
}

func (v *fakeVM) Destroy() error {
	v.mu.Lock()
	if v.destroyed {
		v.mu.Unlock()
		return nil // idempotent: abort-after-teardown must not error (spec §6)
	}
	v.destroyed = true
	v.mu.Unlock()
	v.lc.mu.Lock()
	defer v.lc.mu.Unlock()
	delete(v.lc.live, v.id)
	v.lc.destroyed[v.key]++
	return v.lc.destroyErr
}
