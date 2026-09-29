package vmpool

import (
	"testing"

	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

// Spec §4.1: honour the existing pin, do not declare a new mechanism. From the
// harness's view this path is still GrpcRelayTransport, which declares
// remote-abort, and wexec.BufferCap is already coupled to the TypeScript
// DEFAULT_OUTPUT_CAP by packages/k8s-sandbox/test/output-cap-coupling.test.ts. This
// test extends that chain by one link so the VM path cannot drift from either.
func TestOutputCapMatchesTheWorkerBufferCap(t *testing.T) {
	if OutputCapBytes != wexec.BufferCap {
		t.Fatalf("OutputCapBytes = %d, wexec.BufferCap = %d — the harness cap, the container "+
			"worker's cap and the VM path's cap are one number (spec §4.1)", OutputCapBytes, wexec.BufferCap)
	}
}
