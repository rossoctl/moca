package guestagent

import "testing"

// On every platform: off Linux runLease is the refusing stub, on Linux an agent
// without a cgroup root refuses the same way.
func TestLeaseUnavailableWithoutACgroupRoot(t *testing.T) {
	a := newTestAgent(t)
	_, _, _, errMsg := drive(t, a, Request{Command: "true", Lease: true, CapBytes: 1 << 20}, nil)
	if want := "guest-agent: lease mode is not available in this guest"; errMsg != want {
		t.Fatalf("error %q, want %q", errMsg, want)
	}
	if a.leaseOn.Load() {
		t.Error("a refused lease request set the lease latch")
	}
}
