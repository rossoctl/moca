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
