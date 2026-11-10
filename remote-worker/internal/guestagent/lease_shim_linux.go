//go:build linux

package guestagent

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// ShimArg is the argv[1] that makes the guest-agent binary act as the lease shim.
const ShimArg = "lease-shim"

// ShimMain is the lease shim: it turns the root process it starts as into the
// unprivileged exec identity, then execs the Exec's argv. In lease mode one VM serves
// many Execs, so an Exec must not be able to defeat its own teardown (escape its cgroup,
// trace the agent, regain root through a setuid binary).
//
// args are `<uid> <gid> <home> -- <argv...>`. It never returns: on a setup failure it
// writes `guest-agent: lease-shim: <step>: <err>` to stderr and exits 127.
//
// The capability bounding set and no_new_privs are per-thread, and so is a seccomp
// filter installed without TSYNC. So every step runs on one locked OS thread, and that
// same thread execs; execve keeps only the calling thread, with its attributes.
func ShimMain(args []string) {
	runtime.LockOSThread()

	uid, gid, home, argv, err := parseShimArgs(args)
	if err != nil {
		shimFail("args", err)
	}
	for c := 0; c <= unix.CAP_LAST_CAP; c++ {
		if err := unix.Prctl(unix.PR_CAPBSET_DROP, uintptr(c), 0, 0, 0); err != nil {
			// EINVAL: a kernel older than x/sys does not know this cap, so nothing can
			// hold it. Any other error leaves a cap in the bounding set.
			if errors.Is(err, unix.EINVAL) {
				break
			}
			shimFail("capbset drop "+strconv.Itoa(c), err)
		}
	}
	// Empty the inheritable set while still root. setresuid clears permitted, effective
	// and ambient, but the inheritable set survives it and execve, so without this it is
	// empty only if whoever started the shim made it so. capset is per-thread: this
	// thread is the one that execs, and it must keep permitted and effective for now,
	// because setgroups/setres[ug]id run on EVERY thread (glibc's setxid broadcast under
	// cgo) and abort the process if this one has lost CAP_SETGID/CAP_SETUID. Version 3
	// carries two data words, for caps 0-31 and 32-63.
	hdr := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	var caps [2]unix.CapUserData
	if err := unix.Capget(&hdr, &caps[0]); err != nil {
		shimFail("capset inheritable", err)
	}
	caps[0].Inheritable, caps[1].Inheritable = 0, 0
	if err := unix.Capset(&hdr, &caps[0]); err != nil {
		shimFail("capset inheritable", err)
	}
	// Go applies these three to every thread of the process (AllThreadsSyscall).
	if err := syscall.Setgroups([]int{gid}); err != nil {
		shimFail("setgroups", err)
	}
	if err := syscall.Setresgid(gid, gid, gid); err != nil {
		shimFail("setresgid", err)
	}
	if err := syscall.Setresuid(uid, uid, uid); err != nil {
		shimFail("setresuid", err)
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		shimFail("no_new_privs", err)
	}
	filter, err := seccompFilter(runtime.GOARCH)
	if err != nil {
		shimFail("seccomp", err)
	}
	prog := unix.SockFprog{Len: uint16(len(filter)), Filter: &filter[0]}
	if _, _, errno := unix.Syscall(unix.SYS_SECCOMP, unix.SECCOMP_SET_MODE_FILTER, 0, uintptr(unsafe.Pointer(&prog))); errno != 0 {
		shimFail("seccomp", errno)
	}
	runtime.KeepAlive(filter)

	// Spec §3.3: every Exec starts with umask 0002, so what it creates in the setgid,
	// group-writable workspace stays writable by the sbx-ws group (a later Exec, a
	// tracked process). The agent's own umask is left as it is.
	syscall.Umask(0o002)

	// After the uid drop, so the lookup sees what the exec identity may run. Only
	// HOME, USER and LOGNAME change, so PATH is this process's.
	path, err := exec.LookPath(argv[0])
	if err != nil {
		shimFail("lookpath", err)
	}
	shimFail("exec", syscall.Exec(path, argv, shimEnv(os.Environ(), home)))
}

func shimFail(step string, err error) {
	fmt.Fprintf(os.Stderr, "guest-agent: lease-shim: %s: %v\n", step, err)
	os.Exit(127)
}

func parseShimArgs(args []string) (uid, gid int, home string, argv []string, err error) {
	if len(args) < 5 || args[3] != "--" {
		return 0, 0, "", nil, fmt.Errorf("want <uid> <gid> <home> -- <argv...>, got %q", args)
	}
	if uid, err = strconv.Atoi(args[0]); err != nil || uid <= 0 {
		return 0, 0, "", nil, fmt.Errorf("uid %q: must be a positive integer", args[0])
	}
	if gid, err = strconv.Atoi(args[1]); err != nil || gid <= 0 {
		return 0, 0, "", nil, fmt.Errorf("gid %q: must be a positive integer", args[1])
	}
	if args[2] == "" {
		return 0, 0, "", nil, errors.New("home is empty")
	}
	if args[4] == "" {
		return 0, 0, "", nil, errors.New("argv[0] is empty")
	}
	return uid, gid, args[2], args[4:], nil
}

// shimEnv is env with HOME, USER and LOGNAME replaced by the exec identity's.
func shimEnv(env []string, home string) []string {
	out := slices.DeleteFunc(slices.Clone(env), func(kv string) bool {
		k, _, _ := strings.Cut(kv, "=")
		return k == "HOME" || k == "USER" || k == "LOGNAME"
	})
	return append(out, "HOME="+home, "USER=sbx", "LOGNAME=sbx")
}
