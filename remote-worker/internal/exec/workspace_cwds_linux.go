//go:build linux

package exec

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// procCwds lists the cwd of every process this worker can see, from /proc/<pid>/cwd.
//
// Reading a cwd link is a ptrace-mode access check, so a link can be unreadable for two
// different reasons, and only one of them is safe to skip:
//
//   - The process exited mid-scan (ENOENT, ESRCH): it is in no directory any more.
//   - Access was refused (EACCES, EPERM, anything else). For another user's process that
//     is expected and harmless: a session's commands run as the worker's own user, so no
//     command of a session can be that process. But a process of the worker's OWN user is
//     refused too when it is non-dumpable and the worker lacks CAP_SYS_PTRACE: one that
//     called prctl(PR_SET_DUMPABLE, 0), as ssh-agent and gpg-agent style daemons do, or
//     one started from a setgid or file-capability binary or an unreadable executable.
//     Such a process may be a session's background child sitting in an empty workspace,
//     so it is reported as an error, which keeps every empty workspace for that sweep
//     rather than rmdir one under it.
//
// The cost of that choice: while such a process lives, anywhere in the container, no
// empty workspace is reclaimed early, and each waits for the full Idle as before #551.
// That is the safe failure; the sweep logs it.
//
// An unreadable /proc itself is an error too, with the same effect.
func procCwds() (map[string]struct{}, error) {
	return scanCwds("/proc", os.Readlink, os.ReadFile, os.Getuid())
}

// scanCwds is procCwds over an injectable /proc, so the error split is testable without
// a real non-dumpable process.
func scanCwds(proc string, readlink func(string) (string, error),
	readFile func(string) ([]byte, error), uid int) (map[string]struct{}, error) {
	entries, err := os.ReadDir(proc)
	if err != nil {
		return nil, err
	}
	cwds := make(map[string]struct{})
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		cwd, err := readlink(filepath.Join(proc, e.Name(), "cwd"))
		if err == nil {
			cwds[cwd] = struct{}{}
			continue
		}
		if exited(err) {
			continue
		}
		same, serr := sameUID(readFile, filepath.Join(proc, e.Name(), "status"), uid)
		switch {
		case serr != nil && exited(serr):
			continue // exited between the two reads
		case serr != nil:
			return nil, fmt.Errorf("process %s: cwd: %v; owner unknown: %v", e.Name(), err, serr)
		case same:
			return nil, fmt.Errorf("process %s of this worker's uid %d has an unreadable cwd (%v)",
				e.Name(), uid, err)
		}
		// Another user's process: no session command, skipped.
	}
	return cwds, nil
}

func exited(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ESRCH)
}

// sameUID reports whether any of the real, effective, saved or filesystem uids on the
// status file's Uid line is uid. Any of them, not only the real one: a process that
// shares any uid with the worker could be a session's, and erring that way only keeps
// directories.
func sameUID(readFile func(string) ([]byte, error), status string, uid int) (bool, error) {
	b, err := readFile(status)
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(string(b), "\n") {
		rest, ok := strings.CutPrefix(line, "Uid:")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			break
		}
		for _, f := range fields {
			if n, err := strconv.Atoi(f); err == nil && n == uid {
				return true, nil
			}
		}
		return false, nil
	}
	return false, fmt.Errorf("%s: no Uid line", status)
}
