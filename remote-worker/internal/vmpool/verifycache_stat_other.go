//go:build !linux && !darwin

package vmpool

import "os"

// statIdentity: no identity on this platform, so the verify cache is never used and
// every verify hashes in full.
func statIdentity(os.FileInfo) (fileIdentity, bool) { return fileIdentity{}, false }

func fileOwner(os.FileInfo) (uint32, bool) { return 0, false }
