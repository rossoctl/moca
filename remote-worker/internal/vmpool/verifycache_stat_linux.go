//go:build linux

package vmpool

import (
	"os"
	"syscall"
)

// statIdentity reads a file's identity for the verify cache (verifycache.go). Linux names
// the timestamp Mtim.
func statIdentity(fi os.FileInfo) (fileIdentity, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fileIdentity{}, false
	}
	return fileIdentity{
		Dev:     uint64(st.Dev), // uint32 on some arches
		Ino:     uint64(st.Ino), // uint32 on some arches
		Size:    fi.Size(),
		MtimeNs: st.Mtim.Nano(),
	}, true
}

// fileOwner is the file's owning uid, for the cache file's own permission check.
func fileOwner(fi os.FileInfo) (uint32, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return st.Uid, true
}
