//go:build !linux

package guestagent

import (
	"errors"
	"io"
)

// leaseRuntime is empty off Linux: lease mode needs cgroup v2, CLONE_INTO_CGROUP and
// the Linux-only shim, so there is no state to hold.
type leaseRuntime struct{}

func (a *Agent) leasePrepare() error { return errors.New("guest-agent: lease mode needs linux") }

func (a *Agent) stopLease() {}

// runLease refuses off Linux, with the same text a Linux guest without a cgroup root
// gives, so the host sees one reason for "no lease mode here".
func (a *Agent) runLease(Request, []byte, *frameWriter, io.Reader) (End, error) {
	return End{}, errors.New("guest-agent: lease mode is not available in this guest")
}
