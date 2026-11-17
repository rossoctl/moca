//go:build linux

package exec

import (
	"errors"
	"testing"
)

// SkipIfAProcessHidesItsCwd skips a test that needs the real /proc scan to succeed when
// the environment itself makes it fail on purpose: a process of this uid, in this test's
// cgroup subtree, that hides its cwd (a CI runner's non-dumpable agent shares the job's
// cgroup). Called before the test starts any process, so the pid is the environment's.
// Any other scan error fails the test.
func SkipIfAProcessHidesItsCwd(t *testing.T) {
	t.Helper()
	_, err := procCwds()
	var hidden *hiddenCwdError
	switch {
	case err == nil:
	case errors.As(err, &hidden):
		t.Skipf("this environment hides a cwd the scan must respect (pid %s): %v", hidden.pid, err)
	default:
		t.Fatalf("procCwds: %v", err)
	}
}
