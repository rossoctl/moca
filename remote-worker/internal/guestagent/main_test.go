package guestagent

import (
	"os"
	"testing"
)

// TestMain lets the test binary double as the lease shim: a test that needs the shim
// re-runs os.Args[0] with ShimArg first, and that child never reaches m.Run.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == ShimArg {
		ShimMain(os.Args[2:])
	}
	os.Exit(m.Run())
}
