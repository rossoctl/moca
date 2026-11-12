package guestagent

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"strconv"
)

// The caps on a lease Exec's cgroup (plan 1 review, #706). In a lease guest the agent
// is PID 1 and one VM serves many Execs, so an OOM or a fork bomb in one Exec must cost
// that Exec, not panic the guest and end the lease. Each e<seq> is capped below what
// the guest has, which leaves the agent and the kernel room. The cgroup root above them
// gets the same caps (PR #763 review): tmpfs pages an Exec writes to /tmp or /var outlive
// it, and once its cgroup is removed their charge moves to the root. Without a cap there
// the next e<seq> would start from zero on top of them, and the guest would OOM globally,
// where only PID 1 (unkillable) is left between Execs. The limit is hierarchical and
// counts that reparented charge, so a later Exec is OOM-killed inside its cgroup instead.
// Platform-neutral so the arithmetic is tested everywhere; lease_linux.go writes the
// values.
const (
	execCgroupPidsMax    = 4096
	execCgroupReserveMin = 64 << 20 // the least of the guest's memory an Exec leaves
)

// execCgroupMemoryMax is a lease Exec's memory.max: MemTotal less max(64 MiB,
// MemTotal/8). Zero or less for a guest too small to give an Exec anything.
func execCgroupMemoryMax(memTotal int64) int64 {
	return memTotal - max(execCgroupReserveMin, memTotal/8)
}

// cgroupCap is one cgroup interface file and the value written to it.
type cgroupCap struct{ file, val string }

// execCgroupCapFiles is what lease_linux.go writes to each e<seq>, and to the cgroup
// root, for an Exec memory.max of memMax.
func execCgroupCapFiles(memMax int64) []cgroupCap {
	return []cgroupCap{
		{"memory.max", strconv.FormatInt(memMax, 10)},
		{"pids.max", strconv.Itoa(execCgroupPidsMax)},
	}
}

// parseMemTotal returns /proc/meminfo's MemTotal in bytes.
func parseMemTotal(meminfo []byte) (int64, error) {
	for line := range bytes.Lines(meminfo) {
		f := bytes.Fields(line)
		if len(f) == 0 || string(f[0]) != "MemTotal:" {
			continue
		}
		if len(f) != 3 || string(f[2]) != "kB" {
			return 0, fmt.Errorf("meminfo: %q: want MemTotal: <n> kB", bytes.TrimSpace(line))
		}
		kb, err := strconv.ParseInt(string(f[1]), 10, 64)
		if err != nil || kb <= 0 || kb > math.MaxInt64>>10 {
			return 0, fmt.Errorf("meminfo: %q: want a positive kB count", bytes.TrimSpace(line))
		}
		return kb << 10, nil
	}
	return 0, errors.New("meminfo: no MemTotal line")
}
