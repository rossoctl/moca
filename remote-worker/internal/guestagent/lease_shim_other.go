//go:build !linux

package guestagent

import (
	"fmt"
	"os"
)

// ShimArg is the argv[1] that makes the guest-agent binary act as the lease shim.
const ShimArg = "lease-shim"

// ShimMain refuses off Linux: the lease shim's privilege drop, capability bounding and
// seccomp filter are Linux primitives, and lease mode has no fallback without them.
func ShimMain(args []string) {
	fmt.Fprintln(os.Stderr, "guest-agent: lease-shim: lease mode needs linux")
	os.Exit(127)
}
