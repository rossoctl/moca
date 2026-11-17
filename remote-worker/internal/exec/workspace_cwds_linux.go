//go:build linux

package exec

import (
	"os"
	"path/filepath"
	"strconv"
)

// procCwds lists the cwd of every process this worker can see, from /proc/<pid>/cwd.
// The sandbox container's processes share the worker's Unix user, so every link it needs
// is readable; one it cannot read (another user's process, or one that exited mid-scan)
// is skipped, since no command of a session can be that process. Only an unreadable
// /proc itself is an error, which keeps every empty workspace for that sweep.
func procCwds() (map[string]struct{}, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	cwds := make(map[string]struct{})
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		cwd, err := os.Readlink(filepath.Join("/proc", e.Name(), "cwd"))
		if err != nil {
			continue
		}
		cwds[cwd] = struct{}{}
	}
	return cwds, nil
}
