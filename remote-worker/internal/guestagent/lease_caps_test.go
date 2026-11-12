package guestagent

import (
	"strings"
	"testing"
)

// Plan 1 review (#706): each lease Exec's cgroup gets memory.max = MemTotal less
// max(64 MiB, MemTotal/8), and pids.max = 4096.
func TestExecCgroupCaps(t *testing.T) {
	for _, tc := range []struct {
		memTotal, want int64
	}{
		{1024 << 20, 939524096}, // 1024 MiB - 128 MiB = 896 MiB
		{256 << 20, 201326592},  // 256 MiB - 64 MiB (the floor; /8 is 32 MiB) = 192 MiB
	} {
		if got := execCgroupMemoryMax(tc.memTotal); got != tc.want {
			t.Errorf("execCgroupMemoryMax(%d) = %d, want %d", tc.memTotal, got, tc.want)
		}
	}
	if execCgroupPidsMax != 4096 {
		t.Errorf("execCgroupPidsMax = %d, want 4096", execCgroupPidsMax)
	}
}

func TestParseMemTotal(t *testing.T) {
	meminfo := "MemTotal:        1048576 kB\nMemFree:          900000 kB\nMemAvailable:     950000 kB\n"
	got, err := parseMemTotal([]byte(meminfo))
	if err != nil || got != 1024<<20 {
		t.Fatalf("parseMemTotal = %d, %v; want %d", got, err, int64(1024<<20))
	}
	for name, bad := range map[string]string{
		"missing":   "MemFree: 900000 kB\n",
		"not kB":    "MemTotal: 1048576 MB\n",
		"no unit":   "MemTotal: 1048576\n",
		"not a num": "MemTotal: lots kB\n",
		"zero":      "MemTotal: 0 kB\n",
		"negative":  "MemTotal: -4 kB\n",
		"overflow":  "MemTotal: 9223372036854775807 kB\n",
	} {
		if got, err := parseMemTotal([]byte(bad)); err == nil || !strings.HasPrefix(err.Error(), "meminfo: ") {
			t.Errorf("%s: parseMemTotal(%q) = %d, %v; want a meminfo: error", name, bad, got, err)
		}
	}
}

// PR #763 review (F1): the same two caps go on every e<seq> and on the cgroup root above
// them, the root's so that tmpfs pages an earlier Exec left (charged to the root once
// their cgroup is gone) count against the next Exec's limit.
func TestExecCgroupCapFiles(t *testing.T) {
	got := execCgroupCapFiles(939524096)
	want := []cgroupCap{{"memory.max", "939524096"}, {"pids.max", "4096"}}
	if len(got) != len(want) {
		t.Fatalf("execCgroupCapFiles = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("execCgroupCapFiles = %v, want %v", got, want)
		}
	}
}

// PR #763 second review (G3): an Exec OOM-killed while the lease still holds a quarter or
// more of the cgroup root's memory.max -- files left in /tmp or /var -- gets a stderr hint
// that tells "your /tmp is full" apart from "your command used too much memory".
func TestLeaseMemoryHint(t *testing.T) {
	const mib = 1 << 20
	want300 := "guest-agent: this command was killed for memory; 300 MiB is still held in the lease " +
		"(files in /tmp and /var count against its memory until deleted)\n"
	for _, tc := range []struct {
		name                       string
		oomKills, current, rootMax int64
		want                       string
	}{
		{"no OOM kill", 0, 300 * mib, 400 * mib, ""},
		{"three quarters held", 1, 300 * mib, 400 * mib, want300},
		{"exactly a quarter", 2, 100 * mib, 400 * mib, strings.Replace(want300, "300 MiB", "100 MiB", 1)},
		{"just under a quarter", 1, 100*mib - 1, 400 * mib, ""},
		{"root uncapped or unreadable", 1, 300 * mib, 0, ""},
	} {
		if got := leaseMemoryHint(tc.oomKills, tc.current, tc.rootMax); got != tc.want {
			t.Errorf("%s: leaseMemoryHint(%d, %d, %d) = %q, want %q", tc.name, tc.oomKills, tc.current, tc.rootMax, got, tc.want)
		}
	}
}

func TestParseMemoryEventsOOMKill(t *testing.T) {
	events := "low 0\nhigh 0\nmax 12\noom 1\noom_kill 2\noom_group_kill 0\n"
	if n, err := parseMemoryEventsOOMKill([]byte(events)); err != nil || n != 2 {
		t.Fatalf("parseMemoryEventsOOMKill = %d, %v; want 2 (oom_kill, not oom or oom_group_kill)", n, err)
	}
	for _, bad := range []string{"", "oom 1\n", "oom_kill x\n", "oom_kill -1\n", "oom_kill\n"} {
		if n, err := parseMemoryEventsOOMKill([]byte(bad)); err == nil {
			t.Errorf("parseMemoryEventsOOMKill(%q) = %d, nil; want an error", bad, n)
		}
	}
}

func TestParseCgroupBytes(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int64
		ok   bool
	}{
		{"419430400\n", 419430400, true},
		{"0\n", 0, true},
		{"max\n", 0, false}, // no limit: nothing to compare with
		{"", 0, false},
		{"-5\n", 0, false},
		{"12 MiB\n", 0, false},
	} {
		got, err := parseCgroupBytes([]byte(tc.in))
		if (err == nil) != tc.ok || got != tc.want {
			t.Errorf("parseCgroupBytes(%q) = %d, %v; want %d, ok %v", tc.in, got, err, tc.want, tc.ok)
		}
	}
}
