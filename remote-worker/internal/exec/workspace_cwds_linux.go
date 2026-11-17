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
//     unless it is outside the worker's own cgroup subtree: every session command, and
//     every descendant of one, starts in the worker's cgroup (a process cannot leave it
//     without write access to the cgroup tree), so a process elsewhere (a host daemon
//     beside a worker run on the host, as on a CI runner) cannot be a session's and is
//     skipped. One in the worker's cgroup or below, or whose cgroup cannot be read, is
//     reported as an error, which keeps every empty workspace for that sweep rather
//     than rmdir one under it. Start time is no test: a process older than this worker
//     may be a child of a previous worker in the same container that outlived it, and
//     a new Exec for its workspace_key makes this worker sweep that key.
//
// The cost of that choice: while a process of the worker's uid inside its cgroup subtree
// hides its cwd, no empty workspace is reclaimed early, and each waits for the full Idle
// as before #551. That is the safe failure; the sweep logs it. When the worker's cgroup
// is "/", the root of its cgroup namespace (a container with a private cgroup namespace,
// the usual case, or a host run without one), every process it can see is in its
// subtree, so this applies to every such process; the error says so.
//
// An unreadable /proc itself is an error too, with the same effect.
func procCwds() (map[string]struct{}, error) {
	return scanCwds("/proc", os.Readlink, os.ReadFile, os.Getuid())
}

// scanCwds is procCwds over an injectable /proc, so the error split is testable without
// a real non-dumpable process. readFile reads <proc>/<pid>/status and <proc>/<pid>/cgroup,
// and <proc>/self/cgroup for the worker's own, read only when needed.
func scanCwds(proc string, readlink func(string) (string, error),
	readFile func(string) ([]byte, error), uid int) (map[string]struct{}, error) {
	entries, err := os.ReadDir(proc)
	if err != nil {
		return nil, err
	}
	cwds := make(map[string]struct{})
	var (
		selfCgroup    string
		selfCgroupErr error
		selfRead      bool
	)
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
		case !same:
			continue // another user's process: no session command
		}
		if !selfRead {
			selfCgroup, selfCgroupErr = cgroupPath(readFile, filepath.Join(proc, "self", "cgroup"))
			selfRead = true
		}
		if selfCgroupErr != nil {
			return nil, fmt.Errorf("process %s of this worker's uid %d has an unreadable cwd (%v); "+
				"the worker's own cgroup is unknown: %v", e.Name(), uid, err, selfCgroupErr)
		}
		cg, cerr := cgroupPath(readFile, filepath.Join(proc, e.Name(), "cgroup"))
		switch {
		case cerr != nil && exited(cerr):
			continue
		case cerr != nil:
			return nil, fmt.Errorf("process %s of this worker's uid %d has an unreadable cwd (%v) "+
				"and cgroup (%v)", e.Name(), uid, err, cerr)
		case !inCgroupSubtree(cg, selfCgroup):
			continue // outside the worker's cgroup subtree: no session command
		}
		if selfCgroup == "/" {
			return nil, &hiddenCwdError{pid: e.Name(), msg: fmt.Sprintf(
				"process %s of this worker's uid %d has an unreadable cwd (%v); "+
					"the worker's cgroup is the root of its cgroup namespace, so every process counts "+
					"as in its subtree", e.Name(), uid, err)}
		}
		return nil, &hiddenCwdError{pid: e.Name(), msg: fmt.Sprintf(
			"process %s of this worker's uid %d, in its cgroup subtree %s, has an unreadable cwd (%v)",
			e.Name(), uid, selfCgroup, err)}
	}
	return cwds, nil
}

// hiddenCwdError is the scan failing on purpose: a process that could be a session's
// (the worker's uid, in its cgroup subtree) hides its cwd. A type of its own so the
// real-/proc tests can tell an environment that has such a process from a broken scan.
type hiddenCwdError struct {
	pid string
	msg string
}

func (e *hiddenCwdError) Error() string { return e.msg }

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

// cgroupPath reads a /proc/<pid>/cgroup file's path: the cgroup v2 (unified) "0::<path>"
// line, which a v1 host in hybrid mode also has, or else, on a pure v1 host, the
// name=systemd hierarchy's line, the one every process is placed in.
func cgroupPath(readFile func(string) ([]byte, error), file string) (string, error) {
	b, err := readFile(file)
	if err != nil {
		return "", err
	}
	systemd := ""
	for _, line := range strings.Split(string(b), "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 || !strings.HasPrefix(parts[2], "/") {
			continue
		}
		if parts[0] == "0" && parts[1] == "" {
			return parts[2], nil
		}
		if parts[1] == "name=systemd" && systemd == "" {
			systemd = parts[2]
		}
	}
	if systemd != "" {
		return systemd, nil
	}
	return "", fmt.Errorf("%s: no cgroup v2 or name=systemd line", file)
}

// inCgroupSubtree reports whether cgroup path p is self or below it. Inside a cgroup
// namespace a process outside it shows a path starting "/..", which is outside every
// subtree, the namespace root's included.
func inCgroupSubtree(p, self string) bool {
	if p == "/.." || strings.HasPrefix(p, "/../") {
		return false
	}
	if self == "/" {
		return true
	}
	self = strings.TrimSuffix(self, "/")
	return p == self || strings.HasPrefix(p, self+"/")
}
