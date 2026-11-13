package session

// LeaseCallsInFlight reports how many LeaseControl calls hold a leaseControlCap slot. A slot
// is freed only after its call's reply was queued or dropped, so zero proves every lease
// goroutine has finished: the synchronisation point the lease tests wait on instead of
// sleeping.
func LeaseCallsInFlight(s *Session) int { return len(s.leaseSlots) }

// ErrLeaseNotQueued is frameSink.Lease's answer once the connection has ended.
var ErrLeaseNotQueued = errLeaseNotQueued
