package vmpool

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// memAvailable is the seam over readHostMemAvailable: a package-level var so a
// test can pin the host's answer (there is no /proc/meminfo on darwin, and even on
// linux a test cannot arrange a specific MemAvailable). Same indirection pattern
// as chvChown/chvChmod in launcher_chv.go.
var memAvailable = readHostMemAvailable

// The admission-path cache over memAvailable (#644 review): hostFloorLocked runs
// under the pool's global mutex on EVERY admission and warm acquire, and an
// uncached read would put file I/O on that lock. A ~100ms stale MemAvailable
// weakens nothing — it moves on the scale of seconds, and the floor is a backstop
// beside the budget arithmetic, not a meter — while collapsing the reads to ~10/s
// however hot admission is. Errors are cached too: a broken /proc/meminfo fails
// closed either way, and retrying it under the lock is the same I/O problem.
const memAvailableTTL = 100 * time.Millisecond

var (
	memCacheMu  sync.Mutex
	memCacheVal int64
	memCacheErr error
	memCacheAt  time.Time
)

// cachedMemAvailable is what the admission path reads.
func cachedMemAvailable() (int64, error) {
	memCacheMu.Lock()
	defer memCacheMu.Unlock()
	if !memCacheAt.IsZero() && time.Since(memCacheAt) < memAvailableTTL {
		return memCacheVal, memCacheErr
	}
	memCacheVal, memCacheErr = memAvailable()
	memCacheAt = time.Now()
	return memCacheVal, memCacheErr
}

// invalidateMemAvailableCache drops the cached MemAvailable so the next
// cachedMemAvailable re-reads the seam. Test-only: production has no reason to
// force a read that is at most memAvailableTTL away anyway.
func invalidateMemAvailableCache() {
	memCacheMu.Lock()
	defer memCacheMu.Unlock()
	memCacheAt = time.Time{}
}

// readHostMemAvailable reads MemAvailable out of /proc/meminfo, in bytes.
//
// MemAvailable rather than MemFree is the whole choice: MemFree excludes page
// cache the kernel would reclaim under pressure, so a floor on MemFree fires long
// before the host is actually short — back-pressure from a number the kernel
// itself does not consider a shortage (#644).
//
// /proc/meminfo reports kB columns (kernel KBYTES, i.e. 1024-byte units) with no
// suffix on the value itself, e.g. "MemAvailable:  1503232 kB".
func readHostMemAvailable() (int64, error) { return readMemAvailableFrom("/proc/meminfo") }

// readMemAvailableFrom is readHostMemAvailable against a meminfo file at path.
func readMemAvailableFrom(path string) (int64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("vmpool: reading %s: %w", path, err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		rest, ok := strings.CutPrefix(line, "MemAvailable:")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 2 || fields[1] != "kB" {
			return 0, fmt.Errorf("vmpool: parsing MemAvailable from %q: want \"<n> kB\"", strings.TrimSpace(rest))
		}
		kb, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("vmpool: parsing MemAvailable %q: %w", fields[0], err)
		}
		return kb * 1024, nil
	}
	return 0, fmt.Errorf("vmpool: no MemAvailable line in %s", path)
}
