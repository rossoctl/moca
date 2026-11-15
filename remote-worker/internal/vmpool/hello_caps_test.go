package vmpool

import (
	"slices"
	"testing"
)

// Ruling P5-R37: a microVM worker advertises CapabilityLeaseProcessesV1 in Hello when,
// and only when, it can serve the process kinds (LeaseProcessesSupported), so the relay
// refuses a process kind before it reaches a worker that would run it as a command.
func TestHelloCapabilitiesAdvertiseLeaseProcessesOnlyWhenSupported(t *testing.T) {
	probed := []string{"bash", "git", "python3"}
	cases := []struct {
		name     string
		vmm      VMMKind
		features []string
		want     bool
	}{
		{"firecracker with lease-v1 and lease-processes-v1", Firecracker, []string{FeatureLeaseV1, FeatureLeaseProcessesV1}, true},
		{"firecracker with lease-v1 only", Firecracker, []string{FeatureLeaseV1}, false},
		{"firecracker with lease-processes-v1 but no lease-v1", Firecracker, []string{FeatureLeaseProcessesV1}, false},
		{"firecracker with no features", Firecracker, nil, false},
		{"cloud hypervisor with both features", CloudHypervisor, []string{FeatureLeaseV1, FeatureLeaseProcessesV1}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := HelloCapabilities(Config{VMM: c.vmm, ManifestFeatures: c.features}, probed)
			if has := slices.Contains(got, CapabilityLeaseProcessesV1); has != c.want {
				t.Fatalf("HelloCapabilities = %v: has %s = %v, want %v", got, CapabilityLeaseProcessesV1, has, c.want)
			}
			// The probed capabilities pass through unchanged and in order.
			if !slices.Equal(got[:len(probed)], probed) {
				t.Fatalf("HelloCapabilities = %v, want it to start with the probed %v", got, probed)
			}
		})
	}
	if CapabilityLeaseProcessesV1 != "sbx:lease-processes-v1" {
		t.Fatalf("CapabilityLeaseProcessesV1 = %q: the relay matches the exact string sbx:lease-processes-v1", CapabilityLeaseProcessesV1)
	}
}

// A manifest that itself lists the reserved name (a build script's mistake, or a probe of
// a tool by that name) never passes it on: only the worker's own rule advertises it.
func TestHelloCapabilitiesNeverPassOnAReservedNameFromTheManifest(t *testing.T) {
	got := HelloCapabilities(Config{VMM: Firecracker, ManifestFeatures: []string{FeatureLeaseV1}},
		[]string{"bash", CapabilityLeaseProcessesV1})
	if slices.Contains(got, CapabilityLeaseProcessesV1) {
		t.Fatalf("HelloCapabilities = %v: passed on the manifest's reserved %s without lease-processes-v1", got, CapabilityLeaseProcessesV1)
	}
	if !slices.Equal(got, []string{"bash"}) {
		t.Fatalf("HelloCapabilities = %v, want [bash]", got)
	}
	got = HelloCapabilities(Config{VMM: Firecracker, ManifestFeatures: []string{FeatureLeaseV1, FeatureLeaseProcessesV1}},
		[]string{CapabilityLeaseProcessesV1, "bash"})
	if n := countOf(got, CapabilityLeaseProcessesV1); n != 1 {
		t.Fatalf("HelloCapabilities = %v: %s %d times, want once", got, CapabilityLeaseProcessesV1, n)
	}
}

func countOf(xs []string, x string) int {
	n := 0
	for _, v := range xs {
		if v == x {
			n++
		}
	}
	return n
}
