package main

// gatherLimits READS (never raises — vmpool.RaiseMemlockLimit owns raising, at pool
// construction on the production path) the kernel ceilings spec §7.5 lists as the ones
// that "fail at 500 VMs after working at 20, indistinguishably from a real ceiling"
// unless recorded per run. Every platform reports every key, as "unavailable" where
// it does not apply: spec §7.5 reads an absent key as "not checked".
//
// Split two ways, each with its own reason:
//   - rlimitMemlock/rlimitNofile: unix (limits_unix.go, via golang.org/x/sys/unix — see
//     that file's doc comment for why the standard syscall package cannot be used here
//     on ANY platform) vs. windows (limits_windows.go, "unavailable" — POSIX rlimits
//     have no Windows equivalent).
//   - procLimits: linux (limits_linux.go, real /proc and cgroup v2 reads) vs. every
//     other OS (limits_notlinux.go, "unavailable" — /proc/sys and cgroup v2 pids.max
//     have no equivalent off Linux).
func gatherLimits() map[string]string {
	m := map[string]string{
		"RLIMIT_MEMLOCK": rlimitMemlock(),
		"RLIMIT_NOFILE":  rlimitNofile(),
	}
	for k, v := range procLimits() {
		m[k] = v
	}
	return m
}
