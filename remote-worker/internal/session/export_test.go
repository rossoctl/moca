package session

// LeaseCallsInFlight reports how many mutating LeaseControl calls hold a leaseControlCap
// slot, and LeaseStatusCallsInFlight how many status calls hold a leaseStatusCap one. A slot
// is freed only after its call's reply was queued or dropped, so both at zero proves every
// lease goroutine has finished: the synchronisation point the lease tests wait on instead of
// sleeping.
func LeaseCallsInFlight(s *Session) int { return len(s.leaseSlots) }

func LeaseStatusCallsInFlight(s *Session) int { return len(s.leaseStatusSlots) }

// ErrLeaseNotQueued is frameSink.Lease's answer once the connection has ended.
var ErrLeaseNotQueued = errLeaseNotQueued
