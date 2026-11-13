//go:build windows

package vmpool

import "errors"

// killPidIgnoringAbsent has no Windows implementation: syscall.Kill, syscall.SIGKILL
// and syscall.ESRCH are unix-only names with no Windows equivalent in Go's standard
// syscall package. Windows is not a deployment target for this project (the worker
// runs on Linux; the "unix" build in cgroup_unix.go additionally covers darwin only
// because that is where this package's own tests run day to day) — this stub exists so
// that fact is a deliberate, documented choice rather than an accidental compile
// failure on a platform nobody was checking. SweepOrphans itself is otherwise
// platform-independent (directory walking, cgroup.procs parsing), so without this file
// GOOS=windows would fail on a single missing symbol deep in an unrelated call chain,
// which is a worse failure mode than a clear error at the one call site that would
// ever reach it.
func killPidIgnoringAbsent(pid int) error {
	return errors.New("vmpool: killing an orphaned VM process is not supported on windows")
}

// pidSharesCallersProcessGroup has no Windows implementation for the same reason
// killPidIgnoringAbsent does not: syscall.Getpgid/Getpgrp are unix-only names. Returning
// false is safe here and is not a weakened guard, because the only thing it gates is
// killPidIgnoringAbsent, which refuses outright on this platform — nothing can be
// signalled for the check to have failed to protect.
func pidSharesCallersProcessGroup(pid int) bool { return false }

// pidStillRunning has no Windows implementation for the same reason killPidIgnoringAbsent
// does not. Returning false is safe: the sweep that asks it has already failed on this
// platform at killPidIgnoringAbsent before it reaches the wait.
func pidStillRunning(pid int) bool { return false }
