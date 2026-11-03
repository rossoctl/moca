package vmpool

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

// CgroupCPU makes every fakeVM a cpuReporter whose counters advance by a fixed step per read, so
// ExecPhased's acquire-to-destroy difference is a known value: one step, 10 ms user and 4 ms sys.
func (v *fakeVM) CgroupCPU() (user, sys time.Duration, ok bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.cpuReads++
	return time.Duration(v.cpuReads) * 10 * time.Millisecond, time.Duration(v.cpuReads) * 4 * time.Millisecond, true
}

// The same line format as the container worker's (internal/exec/runner.go), so one reader parses
// both tiers; the microVM fields follow err=.
var timingRe = regexp.MustCompile(`^exec-timing req=(\d+) workspace_key="([^"]*)" start_ms=(\d+) dur_ms=([\d.]+) ` +
	`user_ms=(-?[\d.]+) sys_ms=(-?[\d.]+) exit=(-?\d+) err="([^"]*)" tier="microvm" acquire_us=\d+ resume_us=\d+ ` +
	`mount_us=\d+ run_us=\d+ destroy_us=\d+ cold="[^"]*" vm=\S*$`)

func captureTiming(t *testing.T) *[]string {
	t.Helper()
	var lines []string
	prev := timingLog
	timingLog = func(format string, a ...any) { lines = append(lines, fmt.Sprintf(format, a...)) }
	t.Cleanup(func() { timingLog = prev })
	return &lines
}

func TestRunnerTimingLogsOneLinePerExecWithTheVMsCPU(t *testing.T) {
	p, lc, _ := testPool(t)
	lc.setRunFn(func(_ *fakeVM, _ Command, _ Sink) (Result, error) { return Result{ExitCode: 3}, nil })
	lines := captureTiming(t)

	_, _ = Runner{Pool: p, Timing: true}.Run(context.Background(), wexec.Spec{
		ReqID: 42, Command: "echo SECRET-VALUE", WorkspaceKey: "sess-1",
	}, newFrameSink())

	if len(*lines) != 1 {
		t.Fatalf("got %d exec-timing lines, want 1: %q", len(*lines), *lines)
	}
	l := (*lines)[0]
	m := timingRe.FindStringSubmatch(l)
	if m == nil {
		t.Fatalf("exec-timing line does not match the shared format: %q", l)
	}
	if m[1] != "42" || m[2] != "sess-1" || m[7] != "3" || m[8] != "" {
		t.Fatalf("req/key/exit/err = %s/%s/%s/%q in %q", m[1], m[2], m[7], m[8], l)
	}
	// One fakeVM step between the acquire read and the destroy read.
	if m[5] != "10.0" || m[6] != "4.0" {
		t.Fatalf("user_ms/sys_ms = %s/%s, want 10.0/4.0 (the VM's CPU between acquire and destroy)", m[5], m[6])
	}
	if strings.Contains(l, "SECRET-VALUE") {
		t.Fatalf("the timing line leaked the command text: %q", l)
	}
}

func TestRunnerTimingIsOffByDefault(t *testing.T) {
	p, lc, _ := testPool(t)
	lc.setRunFn(func(_ *fakeVM, _ Command, _ Sink) (Result, error) { return Result{}, nil })
	lines := captureTiming(t)
	_, _ = Runner{Pool: p}.Run(context.Background(), wexec.Spec{ReqID: 1, Command: "true", WorkspaceKey: "k"}, newFrameSink())
	if len(*lines) != 0 {
		t.Fatalf("Timing unset logged %q", *lines)
	}
}

func TestRunnerTimingMarksUnmeasuredCPUAsMinusOne(t *testing.T) {
	lines := captureTiming(t)
	// No VM was acquired (an empty key is refused first), so no CPU was measured.
	logExecTiming(7, "", time.UnixMilli(1000), 5*time.Millisecond, &Phases{}, 0, fmt.Errorf("refused"))
	m := timingRe.FindStringSubmatch((*lines)[0])
	if m == nil || m[5] != "-1.0" || m[6] != "-1.0" || m[8] != "refused" {
		t.Fatalf("an unmeasured Exec must read user_ms=-1 sys_ms=-1, got %q", (*lines)[0])
	}
}

func TestReadCgroupCPUParsesCPUStat(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "cpu.stat"),
		[]byte("usage_usec 15000\nuser_usec 12000\nsystem_usec 3000\nnr_periods 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	u, s, ok := readCgroupCPU(dir)
	if !ok || u != 12*time.Millisecond || s != 3*time.Millisecond {
		t.Fatalf("readCgroupCPU = %v %v %v, want 12ms 3ms true", u, s, ok)
	}
	if _, _, ok := readCgroupCPU(t.TempDir()); ok {
		t.Fatal("a cgroup without cpu.stat must read as not measured")
	}
}
