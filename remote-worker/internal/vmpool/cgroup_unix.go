//go:build unix

package vmpool

import "syscall"

// killPidIgnoringAbsent sends SIGKILL to pid. A pid that has already exited (ESRCH) is
// treated as already-swept, not an error — the brief's own framing: "pids that no
// longer exist still count as swept."
//
// The "unix" build constraint (Go 1.19+) covers both linux, the deployment target, and
// darwin, the platform this package's own tests run on day to day — syscall.Kill,
// syscall.SIGKILL and syscall.ESRCH are all defined identically (by name) on both, so
// one implementation serves both without a further linux/darwin split. See
// cgroup_windows.go for why this got its own build-tagged file at all (fix round 1,
// coordinator review of 36dbcb9, item 3): windows is not a target for this project, but
// leaving killPidIgnoringAbsent in cgroup.go with no build tag meant GOOS=windows
// failed to compile the whole package on a missing-symbol error rather than an
// intentional, documented stub.
func killPidIgnoringAbsent(pid int) error {
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
		return err
	}
	return nil
}

// pidSharesCallersProcessGroup reports whether pid is in the same process group as the
// calling process — the third of SweepOrphans' three guards (see cgroup.go's H1 block).
//
// A pid whose group cannot be read (it exited between readdir and here) is reported as
// NOT sharing: the subsequent SIGKILL then ESRCHes harmlessly, which is the existing
// already-swept path, rather than the guard widening to refuse every orphan.
//
// Correct BECAUSE both launchers Setpgid their VMM into its own process group
// (fcIsolateProcessGroup in launcher_firecracker_unix.go,
// chvIsolateAndDropPrivilegesPlatform in launcher_chv_unix.go), and an orphan left by a
// PREVIOUS worker incarnation cannot be in this process's group at all — so this refuses
// the sweeping process and its group leader without ever refusing a real target.
func pidSharesCallersProcessGroup(pid int) bool {
	pgid, err := syscall.Getpgid(pid)
	if err != nil {
		return false
	}
	return pgid == syscall.Getpgrp()
}

// pidStillRunning reports whether pid names a process that has not yet exited — the
// question sweepOneCgroup's wait asks of every pid still listed after its SIGKILLs.
// kill(2) with signal 0 delivers nothing and only checks: ESRCH means the process is
// gone, and EPERM means it exists but belongs to someone this process may not signal,
// which is still running.
func pidStillRunning(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
