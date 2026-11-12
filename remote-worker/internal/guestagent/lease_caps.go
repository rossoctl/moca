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
// the guest has, which leaves the agent and the kernel room. Platform-neutral so the
// arithmetic is tested everywhere; lease_linux.go writes the values.
const (
	execCgroupPidsMax    = 4096
	execCgroupReserveMin = 64 << 20 // the least of the guest's memory an Exec leaves
)

// execCgroupMemoryMax is a lease Exec's memory.max: MemTotal less max(64 MiB,
// MemTotal/8). Zero or less for a guest too small to give an Exec anything.
func execCgroupMemoryMax(memTotal int64) int64 {
	return memTotal - max(execCgroupReserveMin, memTotal/8)
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
