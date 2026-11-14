package vmpool

import (
	"testing"
	"time"
)

// BenchmarkSaveLeaseState is one durable state-file write: a temp file, its fsync, the
// rename and the directory's fsync. It runs on the SBX0 disk in plan 4 Task 12, since a
// lease start and end each pay it under p.mu; a laptop's number says little about that disk.
func BenchmarkSaveLeaseState(b *testing.B) {
	root := b.TempDir()
	at := time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)
	s := leaseState{
		Mode: ModeLease, Epoch: 7, Known: true,
		Open: &openLease{VMID: "vm-1", Mode: ModeLease, Started: at},
	}
	for b.Loop() {
		if err := saveLeaseState(root, "k", s); err != nil {
			b.Fatal(err)
		}
	}
}
