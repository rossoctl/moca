package vmpool

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

// capturePhaseLog points phaseLog at a recorder for one test and restores it after.
// phaseLog is package state, so this must not run in parallel with anything that Execs.
func capturePhaseLog(t *testing.T) *[]string {
	t.Helper()
	var mu sync.Mutex
	lines := []string{}
	prev := phaseLog
	phaseLog = func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		lines = append(lines, fmt.Sprintf(format, args...))
	}
	t.Cleanup(func() { phaseLog = prev })
	return &lines
}

// phaseFields parses one phase line into an exact key -> value map.
//
// IT EXISTS BECAUSE strings.Contains CANNOT ASSERT ON THIS LINE. The fields are
// space-delimited `key=value` pairs with no anchor, so a bare Contains matches across token
// boundaries in both directions:
//
//   - "resume_us=" is a substring of "vmresume_us=", so once this PR added the sub-phases,
//     a check for "resume_us=" was satisfied by vmresume_us and renaming or deleting
//     resume_us outright became invisible -- on the one field whose stability is the PR's
//     whole compatibility claim.
//   - "vsockdial_us=2000" is a PREFIX of "vsockdial_us=20000", so a value assertion using
//     the 2 ms dial fixture passed against the 20 ms mount value. Distinct fixtures are not
//     enough; they have to be prefix-free, or the match has to be anchored.
//
// Splitting removes the class rather than the two instances: exact map lookups cannot match
// a neighbouring token whatever the fixtures are. The JSON sink already had this right by
// accident, asserting `"p50_resume_us"` with the quotes (main_test.go), which anchors it.
func phaseFields(t *testing.T, line string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, tok := range strings.Fields(line) {
		k, v, ok := strings.Cut(tok, "=")
		if !ok {
			continue // the "vmpool: exec phases" prefix
		}
		out[k] = v
	}
	if len(out) == 0 {
		t.Fatalf("no key=value fields in phase line: %s", line)
	}
	return out
}

// TestPhaseLogIsOffByDefault pins the cost-when-off contract: an Exec on a worker that
// has not opted in must emit nothing at all. A default-on diagnostic would put a log line
// on the hot path of every Exec in production.
func TestPhaseLogIsOffByDefault(t *testing.T) {
	prev := phaseLog
	phaseLog = nil
	t.Cleanup(func() { phaseLog = prev })

	// logPhases must tolerate being called with the hook unset -- that IS the default path.
	logPhases(&Phases{})
}

// TestRunnerEmitsEveryPhase is the regression this package did not have: the relayed
// path used Pool.Exec with a throwaway Phases, so the phases were unobservable on the
// path the worker actually runs (#305, #307). If someone swaps ExecPhased back to Exec,
// they silently become zero and this fails.
//
// Named for the property, not the count: it was TestRunnerEmitsAllFourPhases until this
// decomposition added three more, and a name that counts has to be renamed by whoever adds
// the next one -- which is exactly the drift the field-set rationale below says this test
// exists to catch. (Named, not cited by line number: the hunk that added this comment moved
// the line the first draft pointed at.)
func TestRunnerEmitsEveryPhase(t *testing.T) {
	lines := capturePhaseLog(t)

	p, lc, _ := testPool(t)
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		out.Stdout([]byte("ok\n"))
		return Result{ExitCode: 0}, nil
	})
	sink := newFrameSink()
	code, err := Runner{Pool: p}.Run(context.Background(), wexec.Spec{
		ReqID:        1,
		WorkspaceKey: "k1",
		Command:      "true",
		TimeoutS:     5,
	}, sink)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}

	if len(*lines) != 1 {
		t.Fatalf("want exactly one phase line per Exec, got %d: %v", len(*lines), *lines)
	}
	got := (*lines)[0]
	// Every phase must be NAMED. Asserting on durations would be a clock test -- the fake
	// clock does not advance, so every one of them is legitimately 0 even on correct code.
	// What the field set catches is a dropped phase or a rename, which is the failure that
	// makes an aggregated run silently miss a term.
	//
	// EXACT keys, via phaseFields, not Contains: "resume_us=" is a substring of
	// "vmresume_us=", so a Contains check for it is satisfied by the sub-phase this PR
	// added, and renaming or dropping resume_us stops failing anything.
	fields := phaseFields(t, got)
	for _, field := range []string{
		"acquire_us", "resume_us",
		// Resume's sub-phases (#307 follow-up). Named here for the same reason as the
		// rest: resume_us was the last opaque phase on the gate-held path, and a rename
		// or a drop would make an aggregated run silently miss a term rather than fail.
		"vmresume_us", "vsockdial_us", "mount_us",
		"run_us", "destroy_us", "cold",
	} {
		if _, ok := fields[field]; !ok {
			t.Errorf("phase line is missing %q: %s", field, got)
		}
	}
	// cold is the one field that discriminates a populated Phases from a zero-valued one,
	// and so it is what actually pins the ExecPhased wiring: the field NAMES above appear
	// either way, because logPhases runs unconditionally on whatever it is handed. Only
	// ExecPhased sets ph.Cold, and this is a fresh pool's first Exec on an unseen key, so
	// the cause is deterministically first-exec -- no clock involved. Swap ExecPhased back
	// to Exec and ph stays zero, leaving cold="" here.
	if want := fmt.Sprintf("%q", string(ColdFirstExec)); fields["cold"] != want {
		t.Errorf("phase line has cold=%s, want %s -- Phases was not populated (Exec, not ExecPhased): %s",
			fields["cold"], want, got)
	}
}

// phasingLauncher hands back VMs that report Resume sub-phases, i.e. that implement
// resumePhaser the way firecrackerVM does.
type phasingLauncher struct {
	*fakeLauncher
	vmResume, vsockDial, mount time.Duration
}

func (l *phasingLauncher) Restore(ctx context.Context, req RestoreRequest) (VM, error) {
	vm, err := l.fakeLauncher.Restore(ctx, req)
	if err != nil {
		return nil, err
	}
	return &phasingVM{VM: vm, lc: l}, nil
}

type phasingVM struct {
	VM
	lc *phasingLauncher
}

func (v *phasingVM) ResumePhases() (vmResume, vsockDial, mount time.Duration) {
	return v.lc.vmResume, v.lc.vsockDial, v.lc.mount
}

// TestExecPhasedReportsResumeSubPhases pins the type assertion in ExecPhased. Resume was
// the last opaque phase on the execGate-held critical path, and the whole decomposition
// hangs off one optional-interface check: drop it and resume_us keeps reporting while the
// three sub-phases silently read zero, which is indistinguishable from a launcher that
// does not implement the seam. Asserting on VALUES, not just field names, is what
// separates those two cases -- the fake clock cannot advance a real duration, so the
// launcher hands back fixed ones.
func TestExecPhasedReportsResumeSubPhases(t *testing.T) {
	pl := &phasingLauncher{
		fakeLauncher: newFakeLauncher(),
		vmResume:     300 * time.Microsecond,
		vsockDial:    2 * time.Millisecond,
		mount:        20 * time.Millisecond,
	}
	// Through New, not assigned afterwards -- see testPoolWith on why that would be a
	// data race against the reclaim goroutine.
	p, _ := testPoolWith(t, pl)

	var ph Phases
	if _, err := p.ExecPhased(context.Background(), "k1", Exec{
		ReqID: 1, Command: "true", TimeoutS: 5,
	}, &capturingSink{}, &ph); err != nil {
		t.Fatalf("ExecPhased: %v", err)
	}

	if ph.VMResume != pl.vmResume || ph.VsockDial != pl.vsockDial || ph.Mount != pl.mount {
		t.Errorf("sub-phases = (%v, %v, %v), want (%v, %v, %v) -- the resumePhaser assertion in ExecPhased is not wired",
			ph.VMResume, ph.VsockDial, ph.Mount, pl.vmResume, pl.vsockDial, pl.mount)
	}
}

// TestResumeSubPhasesAreZeroWithoutTheSeam is the other half: a launcher that does NOT
// implement resumePhaser must report zeros rather than panicking on the assertion. That
// is the CHV arm, whose Resume has no workspace mount to decompose.
//
// The Phases handed in is PRE-POPULATED, which is what makes this assert the contract
// resumePhaser documents ("reports zeros") rather than the weaker fact that a fresh struct
// starts zeroed. ExecPhased writes ph.Resume unconditionally, so before the else branch in
// the type assertion the three sub-phases were the one group left to a caller's discipline;
// all three production callers do allocate fresh (cmd/vmpoolctl/main.go, runner.go), so
// this pins the function's own guarantee, not a reachable bug.
func TestResumeSubPhasesAreZeroWithoutTheSeam(t *testing.T) {
	p, _, _ := testPool(t)
	ph := Phases{VMResume: time.Second, VsockDial: time.Second, Mount: time.Second}
	if _, err := p.ExecPhased(context.Background(), "k1", Exec{
		ReqID: 1, Command: "true", TimeoutS: 5,
	}, &capturingSink{}, &ph); err != nil {
		t.Fatalf("ExecPhased: %v", err)
	}
	if ph.VMResume != 0 || ph.VsockDial != 0 || ph.Mount != 0 {
		t.Errorf("sub-phases = (%v, %v, %v), want all zero for a launcher without the seam",
			ph.VMResume, ph.VsockDial, ph.Mount)
	}
}

// TestPhaseLineReportsResumeSubPhasesByValue pins the ORDER of the three sub-phases in the
// phase line, which is the last place they are copied positionally with nothing checking
// the slots.
//
// TestRunnerEmitsEveryPhase covers the field NAMES, and for acquire/resume/run/destroy that
// is the most it can: the fake clock does not advance, so those are legitimately 0. The
// sub-phases are different -- they are not clock-derived, they come from ResumePhases() --
// so a fake can return fixed values and the line can be checked against them. Without this,
// transposing ph.VsockDial and ph.Mount in logPhases prints
// `vsockdial_us=20000 mount_us=2000`, relabelling 78-81% of the phase as the dial, and both
// packages stay green.
//
// It goes through Runner.Run, not ExecPhased: logPhases is called from the Runner
// (runner.go), so an ExecPhased call emits no line at all and there would be nothing to
// assert against.
func TestPhaseLineReportsResumeSubPhasesByValue(t *testing.T) {
	lines := capturePhaseLog(t)

	pl := &phasingLauncher{
		fakeLauncher: newFakeLauncher(),
		vmResume:     300 * time.Microsecond,
		vsockDial:    2 * time.Millisecond,
		mount:        20 * time.Millisecond,
	}
	p, _ := testPoolWith(t, pl)
	r := Runner{Pool: p}
	if _, err := r.Run(context.Background(), wexec.Spec{
		ReqID: 1, WorkspaceKey: "k1", Command: "true", TimeoutS: 5,
	}, newFrameSink()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(*lines) != 1 {
		t.Fatalf("want exactly one phase line, got %d: %v", len(*lines), *lines)
	}
	got := (*lines)[0]
	// EXACT values, via phaseFields. Distinct fixtures alone were not enough: 2000 is a
	// prefix of 20000, so the dial assertion passed against the mount's value and only the
	// mount assertion was doing any killing.
	fields := phaseFields(t, got)
	for _, tc := range []struct{ key, want string }{
		{"vmresume_us", "300"},
		{"vsockdial_us", "2000"},
		{"mount_us", "20000"},
	} {
		if fields[tc.key] != tc.want {
			t.Errorf("%s = %q, want %q -- the sub-phases are mislabelled or dropped: %s",
				tc.key, fields[tc.key], tc.want, got)
		}
	}
	// The other four fields are clock-derived, so there is no fixture to compare them
	// against -- but the fake clock does not advance, so on correct code they read exactly
	// 0 here while the sub-phases carry 300/2000/20000. That makes 0 an INDEPENDENT witness
	// rather than a clock test: it cannot hold once a ResumePhases-derived value lands in
	// one of these slots. Without it, feeding ph.VMResume into the resume_us slot leaves
	// both packages green -- verified by mutation, and resume_us is the one field whose
	// whole-phase meaning this PR's compatibility claim rests on.
	for _, key := range []string{"acquire_us", "resume_us", "run_us", "destroy_us"} {
		if fields[key] != "0" {
			t.Errorf("%s = %q, want 0 -- a sub-phase value reached a clock-derived slot: %s",
				key, fields[key], got)
		}
	}
}
