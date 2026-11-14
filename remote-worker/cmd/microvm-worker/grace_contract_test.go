package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
)

// The relay's LeaseControl timeout for a mutate op must outlast the longest grace a worker boots with plus the
// 60 s margin for the cut Exec's unwind (review #4569829088). This reads the relay's literal, so raising
// maxLeaseGraceS alone, or lowering the relay's timeout alone, fails here; the relay's
// test/lease-grace-contract.test.ts reads this side's.
func TestMaxLeaseGraceFitsTheRelayMutateTimeout(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "sandbox-relay", "src", "sandbox-caller.ts"))
	if err != nil {
		t.Fatalf("read the relay's sandbox-caller.ts: %v", err)
	}
	m := regexp.MustCompile(`export const LEASE_MUTATE_TIMEOUT_MS = (\d+) \* 60_000;`).FindSubmatch(src)
	if m == nil {
		t.Fatal("LEASE_MUTATE_TIMEOUT_MS = <n> * 60_000 not found in sandbox-caller.ts: update this test with it")
	}
	minutes, _ := strconv.Atoi(string(m[1]))
	if relayS := minutes * 60; maxLeaseGraceS+60 > relayS {
		t.Fatalf("maxLeaseGraceS %d + 60 s exceeds the relay's LEASE_MUTATE_TIMEOUT_MS %d s", maxLeaseGraceS, relayS)
	}
}
