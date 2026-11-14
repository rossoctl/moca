//go:build darwin

package vmpool

import (
	"os"
	"syscall"
)

// statIdentity reads a file's identity for the verify cache (verifycache.go). Darwin names
// the timestamp Mtimespec.
func statIdentity(fi os.FileInfo) (fileIdentity, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fileIdentity{}, false
	}
	return fileIdentity{
		Dev:     uint64(uint32(st.Dev)), // int32 on darwin
		Ino:     st.Ino,
		Size:    fi.Size(),
		MtimeNs: st.Mtimespec.Nano(),
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
