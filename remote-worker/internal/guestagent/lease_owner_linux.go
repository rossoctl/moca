//go:build linux

package guestagent

import (
	"fmt"
	"io/fs"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// normaliseWorkspace hands the workspace at root to the exec identity: every entry on
// root's filesystem becomes uid:gid, regular files gain g+w, and directories gain g+ws
// so that what the Exec creates later stays in the group. Lease Execs run as uid, so a
// workspace root wrote to (a per-Exec run, a seed) must be normalised before the first.
//
// It runs as root on a tree the Exec user may have shaped, so it must not be steered
// outside the workspace:
//   - filepath.WalkDir never follows a symlink, and the symlink itself is chowned with
//     AT_SYMLINK_NOFOLLOW;
//   - a directory on another filesystem (a mount inside the workspace) is skipped with
//     everything under it, and the mount point itself is left as it is;
//   - only regular files and directories are chmodded, decided from an lstat of the
//     entry; sockets, FIFOs and symlinks are only chowned;
//   - character and block devices are removed (unlinkat does not follow the entry), not
//     handed over: a device node the Exec uid owned would be a route back to root. The
//     workspace is also mounted nodev (leaseHarden); removing them does not rest the
//     rule on that one flag. It returns how many it removed.
//
// It runs with no Exec in the VM (runLease holds the lease mutex), so nothing changes
// the tree between the lstat and the chown or chmod of an entry.
//
// The first error aborts the walk, as `normalise workspace: <path>: <err>`.
func normaliseWorkspace(root string, uid, gid int) (removed int, err error) {
	var rootDev uint64
	first := true
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		fail := func(err error) error { return fmt.Errorf("normalise workspace: %s: %w", path, err) }
		if err != nil {
			return fail(err)
		}
		var st unix.Stat_t
		if err := unix.Lstat(path, &st); err != nil {
			return fail(err)
		}
		if first {
			rootDev, first = uint64(st.Dev), false
		}
		if uint64(st.Dev) != rootDev {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if t := st.Mode & unix.S_IFMT; t == unix.S_IFCHR || t == unix.S_IFBLK {
			if err := unix.Unlinkat(unix.AT_FDCWD, path, 0); err != nil {
				return fail(err)
			}
			removed++
			return nil
		}
		if err := unix.Fchownat(unix.AT_FDCWD, path, uid, gid, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return fail(err)
		}
		var mode uint32
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFDIR:
			mode = st.Mode&0o7777 | 0o2020
		case unix.S_IFREG:
			// chown has just cleared setuid and setgid on the file; keep them cleared
			// rather than re-arm them under the new owner.
			mode = st.Mode&0o7777&^(unix.S_ISUID|unix.S_ISGID) | 0o020
		default:
			return nil
		}
		if err := unix.Fchmodat(unix.AT_FDCWD, path, mode, 0); err != nil {
			return fail(err)
		}
		return nil
	})
	return removed, err
}
