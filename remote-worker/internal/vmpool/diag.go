package vmpool

import (
	"bufio"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Opt-in phase logging. #305 and #307 were both found by decomposing an Exec into
// Acquire/Resume/Run/Destroy and a restore into its own phases — but that decomposition
// existed only on the vmpoolctl path, so nothing the RELAYED path did was visible. The
// numbers that mattered (Destroy at 55% of an Exec; 90% of a restore spent asleep in
// waitForUnixSocket) could not be obtained without rebuilding the worker by hand.
//
// phaseLog is nil unless SH_DIAG_PHASES=1, so the cost when off is one nil check per Exec.
// It is a variable rather than a bool so tests can capture the lines instead of asserting
// against a logger's side effects.
var phaseLog func(format string, args ...any)

func init() {
	if os.Getenv("SH_DIAG_PHASES") == "1" {
		phaseLog = log.Printf
	}
}

// logPhases emits one line per Exec. Kept here rather than inline in Runner.Run so the
// field names are in one place: they are parsed by whatever is aggregating a run, and a
// silently renamed field reads as a missing phase rather than as an error.
//
// WHAT THE TESTS PIN. Every field NAME here is asserted exactly, by key, in
// TestRunnerEmitsEveryPhase (via phaseFields -- a Contains would match across token
// boundaries, since "resume_us=" is a substring of "vmresume_us="). The three sub-phase
// VALUES are asserted too, because they come from ResumePhases() and a fake can return
// fixed ones.
//
// The other four -- acquire_us / resume_us / run_us / destroy_us -- are clock-derived, so
// there is no fixture to compare them against. They are pinned anyway, and the fake clock
// is what makes that possible rather than what forbids it: it does not advance, so all four
// read exactly 0 in TestPhaseLineReportsResumeSubPhasesByValue while the sub-phases carry
// 300/2000/20000. Zero there is an independent witness, not a restatement of this function
// and not a clock test, and it is what catches the wrong Phases field reaching one of those
// four slots -- resume_us carrying VMResume, say, which otherwise leaves both packages
// green (confirmed by mutation). It matters most on resume_us, whose unchanged whole-phase
// meaning is this decomposition's compatibility claim.
func logPhases(ph *Phases) {
	if phaseLog == nil {
		return
	}
	phaseLog("vmpool: exec phases acquire_us=%d resume_us=%d vmresume_us=%d vsockdial_us=%d mount_us=%d run_us=%d destroy_us=%d cold=%q",
		ph.Acquire.Microseconds(), ph.Resume.Microseconds(),
		ph.VMResume.Microseconds(), ph.VsockDial.Microseconds(), ph.Mount.Microseconds(),
		ph.Run.Microseconds(), ph.Destroy.Microseconds(), string(ph.Cold))
}

// resumePhaser is the seam a VM implements to report Resume's internal decomposition.
// Optional on purpose: Resume's signature returns only an error, and widening the VM
// interface would force the CHV launcher (whose Resume is a different shape entirely --
// virtio-fs, no workspace mount) to answer a question that does not apply to it. A
// launcher that does not implement this reports zeros, which read as "not decomposed"
// rather than as "measured zero" because resume_us stays populated beside them.
//
// ONE EXCEPTION to reading zeros that way, and it is on the failure path ExecPhased
// deliberately reads (pool.go): a Resume that fails part-way stashes zeros for the steps
// it never entered, so e.g. a failed fc.Resume reports a populated vmresume_us with
// vsockdial_us and mount_us at zero -- the same shape as a launcher that decomposes only
// the first step. The zeros are truthful (those steps did not happen), and the two cases
// are told apart by the Exec having errored at all, not by the phase line. No ladder row
// is produced from a failed Exec, so this misleads nothing that aggregates a run.
//
// The three values are the LAST Resume's, stashed by it rather than returned, and are
// read on the same goroutine immediately after Resume returns. A failed Resume therefore
// overwrites the previous successful one's values, which is intended: they describe an
// attempt, not a VM.
type resumePhaser interface {
	ResumePhases() (vmResume, vsockDial, mount time.Duration)
}

// cpuReporter is the seam a VM implements to report its cgroup's cumulative CPU, read by
// ExecPhased at acquire and before destroy (Phases.CPUUser/CPUSys). Optional, like resumePhaser:
// a VM without a known cgroup (no ParentCgroup, a fake, CHV's scope) simply does not measure.
type cpuReporter interface {
	CgroupCPU() (user, sys time.Duration, ok bool)
}

// readCgroupCPU reads user_usec and system_usec from <dir>/cpu.stat (cgroup v2).
func readCgroupCPU(dir string) (user, sys time.Duration, ok bool) {
	f, err := os.Open(filepath.Join(dir, "cpu.stat"))
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	var gotU, gotS bool
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, found := strings.Cut(sc.Text(), " ")
		if !found {
			continue
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			continue
		}
		switch k {
		case "user_usec":
			user, gotU = time.Duration(n)*time.Microsecond, true
		case "system_usec":
			sys, gotS = time.Duration(n)*time.Microsecond, true
		}
	}
	return user, sys, gotU && gotS
}

// timingLog is nil unless the Runner was built with Timing (cmd/microvm-worker sets it from
// SH_EXEC_TIMING=1); a variable so tests capture the lines.
var timingLog = log.Printf

// logExecTiming emits the `exec-timing` line, the SAME format the container sandbox worker
// writes (internal/exec/runner.go logExecTiming, webchang 096a6df2), so a benchmark parses both
// tiers with one reader and compares them field by field. user_ms/sys_ms are the VM's CPU over
// the Exec (Phases.CPUUser/CPUSys) when measured, else -1. The microVM fields follow `err=`,
// so a reader of the container format still matches: tier, the phases, cold, and the VM.
func logExecTiming(reqID uint64, key string, start time.Time, dur time.Duration, ph *Phases, code int32, err error) {
	userMs, sysMs := -1.0, -1.0
	if ph.CPUMeasured {
		userMs = float64(ph.CPUUser.Microseconds()) / 1000
		sysMs = float64(ph.CPUSys.Microseconds()) / 1000
	}
	errText := ""
	if err != nil {
		errText = err.Error()
	}
	timingLog("exec-timing req=%d workspace_key=%q start_ms=%d dur_ms=%.1f user_ms=%.1f sys_ms=%.1f exit=%d err=%q "+
		"tier=%q acquire_us=%d resume_us=%d mount_us=%d run_us=%d destroy_us=%d cold=%q vm=%s",
		reqID, key, start.UnixMilli(), float64(dur.Microseconds())/1000, userMs, sysMs, code, errText,
		"microvm", ph.Acquire.Microseconds(), ph.Resume.Microseconds(), ph.Mount.Microseconds(),
		ph.Run.Microseconds(), ph.Destroy.Microseconds(), string(ph.Cold), ph.VMID)
}
