//go:build !linux

package exec

// procCwds is a no-op off Linux: there is no /proc to read, so Sweep cannot tell that a
// background child is still in an empty workspace, and relies on EmptyIdle alone.
func procCwds() (map[string]struct{}, error) { return nil, nil }
