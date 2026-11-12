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

// leaseMemoryHint is the stderr line a lease Exec gets when it was OOM-killed while the
// lease itself still holds much of the memory its cgroup tree may use (PR #763 second
// review, G3): tmpfs files that earlier Execs left in /tmp or /var stay charged to the
// cgroup root, and with the root capped every later Exec OOMs until they are deleted. The
// host sees only a non-zero exit, so the line is what tells "the lease's files fill its
// memory" apart from "the command used too much". oomKills is the Exec cgroup's
// memory.events oom_kill count; rootCurrent and rootMax are the cgroup root's
// memory.current, after the Exec's cgroup is gone, and memory.max (0 when uncapped or
// unreadable). "" when the Exec was not OOM-killed, or the root holds less than a quarter
// of its limit.
func leaseMemoryHint(oomKills, rootCurrent, rootMax int64) string {
	quarter := rootMax / 4 // rounded up below, so "a quarter or more" is exact
	if rootMax%4 != 0 {
		quarter++
	}
	if oomKills <= 0 || rootMax <= 0 || rootCurrent < quarter {
		return ""
	}
	return fmt.Sprintf("guest-agent: this command was killed for memory; %d MiB is still held in the lease "+
		"(files in /tmp and /var count against its memory until deleted)\n", rootCurrent>>20)
}

// parseMemoryEventsOOMKill returns a cgroup's memory.events oom_kill count.
func parseMemoryEventsOOMKill(events []byte) (int64, error) {
	for line := range bytes.Lines(events) {
		f := bytes.Fields(line)
		if len(f) == 0 || string(f[0]) != "oom_kill" {
			continue
		}
		if len(f) != 2 {
			return 0, fmt.Errorf("memory.events: %q: want oom_kill <n>", bytes.TrimSpace(line))
		}
		n, err := strconv.ParseInt(string(f[1]), 10, 64)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("memory.events: %q: want a count", bytes.TrimSpace(line))
		}
		return n, nil
	}
	return 0, errors.New("memory.events: no oom_kill line")
}

// parseCgroupBytes parses a cgroup byte-count file (memory.current, memory.max). "max",
// no limit, is an error: there is nothing to compare with.
func parseCgroupBytes(b []byte) (int64, error) {
	s := string(bytes.TrimSpace(b))
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("cgroup bytes %q: want a byte count", s)
	}
	return n, nil
}
