//go:build linux

package guestagent

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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

// ShimExecBarrierFD is the descriptor the shim marks close-on-exec just before it execs
// the command, so a starter that passed a pipe's write end there learns that the exec
// has happened (or that the shim died) from EOF on the read end.
const ShimExecBarrierFD = 3

// ShimCwdFD is the workspace root's directory descriptor, an O_PATH one the starter opened
// (process_start), when the shim's <cwd> argument is ShimCwdFromFD followed by a relative
// path. After its privilege drop the shim resolves that path from this descriptor and
// changes into the result, so every directory on the way is searched as the dropped
// identity, and no root chdir follows a path anyone else could rewrite. The shim closes it.
const ShimCwdFD = 4

// The shim's <cwd> argument: ShimCwdInherited stays in the directory the starter gave the
// shim; ShimCwdFromFD + <rel> changes, after the drop, into <rel> (a local path, "." for the
// root itself) resolved beneath ShimCwdFD.
const (
	ShimCwdInherited = "-"
	ShimCwdFromFD    = "fd:"
)

// ShimMain is the lease shim: it turns the root process it starts as into the
// unprivileged exec identity, then execs the Exec's argv. In lease mode one VM serves
// many Execs, so an Exec must not be able to defeat its own teardown (escape its cgroup,
// trace the agent, regain root through a setuid binary).
//
// args are `<uid> <gid> <home> <user> <cwd> -- <argv...>`; user is the identity's
// passwd name (sbx for an Exec, sbxp<n> for a tracked process), and cwd is
// ShimCwdInherited or ShimCwdFromFD<rel>. It never returns: on a setup failure it
// writes `guest-agent: lease-shim: <step>: <err>` to stderr and exits 127.
//
// The capability bounding set and no_new_privs are per-thread, and so is a seccomp
// filter installed without TSYNC. So every step runs on one locked OS thread, and that
// same thread execs; execve keeps only the calling thread, with its attributes.
func ShimMain(args []string) {
	runtime.LockOSThread()

	sa, err := parseShimArgs(args)
	if err != nil {
		shimFail("args", err)
	}
	// The agent runs at oom_score_adj -1000 once it serves leases, and a fork inherits
	// it. An Exec must stay an OOM candidate, or an OOM in it finds nothing it may kill:
	// put it back to the default while still root, which (with CAP_SYS_RESOURCE) also
	// raises oom_score_adj_min to 0, so the exec uid cannot lower it again.
	if err := os.WriteFile("/proc/self/oom_score_adj", []byte("0"), 0); err != nil {
		shimFail("oom_score_adj", err)
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
	if err := syscall.Setgroups([]int{sa.gid}); err != nil {
		shimFail("setgroups", err)
	}
	if err := syscall.Setresgid(sa.gid, sa.gid, sa.gid); err != nil {
		shimFail("setresgid", err)
	}
	if err := syscall.Setresuid(sa.uid, sa.uid, sa.uid); err != nil {
		shimFail("setresuid", err)
	}
	// After the drop, so the walk is the dropped identity's: the path is resolved from
	// the workspace root's descriptor, and the kernel checks search permission on every
	// directory along it, the parents included, as this uid (PR #814 review: a cwd the
	// root starter opened would have had its parents searched as root). Beneath the
	// root, with no symlink and no other mount on the way, as the starter's own check.
	// A cwd this uid cannot reach fails here, exit 127 (ruling P5-R14).
	if sa.cwdFromFD {
		fd, err := unix.Openat2(ShimCwdFD, sa.cwdRel, &unix.OpenHow{
			Flags:   unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC,
			Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV,
		})
		if err != nil {
			shimFail("cwd", err)
		}
		if err := unix.Fchdir(fd); err != nil {
			shimFail("cwd", err)
		}
		if err := errors.Join(unix.Close(fd), unix.Close(ShimCwdFD)); err != nil {
			shimFail("cwd", err)
		}
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
	path, err := exec.LookPath(sa.argv[0])
	if err != nil {
		shimFail("lookpath", err)
	}
	// An ignored disposition survives fork and execve, so a command started by a
	// parent that ignores a signal would ignore it too, and process_stop's TERM (or an
	// Exec's kill -INT) would do nothing. Go keeps an inherited SIG_IGN for HUP and INT
	// rather than handle them; execve resets only handled signals. Last before the
	// exec: a signal arriving after it takes its default action, as in the command.
	if err := resetIgnoredSignals(); err != nil {
		shimFail("signals", err)
	}
	// fd 3, when the starter passes one, is its exec barrier (process_start): close-on-
	// exec, so the starter's read end sees EOF once the command has replaced the shim,
	// or the shim has exited. Never inherited by the command either way.
	syscall.CloseOnExec(ShimExecBarrierFD)
	shimFail("exec", syscall.Exec(path, sa.argv, shimEnv(os.Environ(), sa.home, sa.user)))
}

// kernelSigaction is the kernel's struct sigaction on amd64 and arm64, both of which
// have sa_restorer (as Go's runtime sigactiont).
type kernelSigaction struct {
	handler, flags, restorer uintptr
	mask                     uint64
}

// resetIgnoredSignals sets every signal this process inherited as ignored (SIG_IGN) to
// its default action (SIG_DFL). Handled signals are left alone: execve resets them.
func resetIgnoredSignals() error {
	const sigIgn = 1
	for sig := uintptr(1); sig <= 64; sig++ {
		if sig == uintptr(unix.SIGKILL) || sig == uintptr(unix.SIGSTOP) {
			continue
		}
		var old kernelSigaction
		if _, _, errno := unix.RawSyscall6(unix.SYS_RT_SIGACTION, sig, 0, uintptr(unsafe.Pointer(&old)), 8, 0, 0); errno != 0 {
			return fmt.Errorf("rt_sigaction %d: %w", sig, errno)
		}
		if old.handler != sigIgn {
			continue
		}
		var dfl kernelSigaction // SIG_DFL is 0
		if _, _, errno := unix.RawSyscall6(unix.SYS_RT_SIGACTION, sig, uintptr(unsafe.Pointer(&dfl)), 0, 8, 0, 0); errno != 0 {
			return fmt.Errorf("rt_sigaction %d: %w", sig, errno)
		}
	}
	return nil
}

func shimFail(step string, err error) {
	fmt.Fprintf(os.Stderr, "guest-agent: lease-shim: %s: %v\n", step, err)
	os.Exit(127)
}

// shimArgs is the identity the shim drops to and the argv it then execs.
type shimArgs struct {
	uid, gid   int
	home, user string
	cwdFromFD  bool
	cwdRel     string // with cwdFromFD: the path to resolve beneath ShimCwdFD
	argv       []string
}

func parseShimArgs(args []string) (shimArgs, error) {
	if len(args) < 7 || args[5] != "--" {
		return shimArgs{}, fmt.Errorf("want <uid> <gid> <home> <user> <cwd> -- <argv...>, got %q", args)
	}
	uid, err := strconv.Atoi(args[0])
	if err != nil || uid <= 0 {
		return shimArgs{}, fmt.Errorf("uid %q: must be a positive integer", args[0])
	}
	gid, err := strconv.Atoi(args[1])
	if err != nil || gid <= 0 {
		return shimArgs{}, fmt.Errorf("gid %q: must be a positive integer", args[1])
	}
	if args[2] == "" {
		return shimArgs{}, errors.New("home is empty")
	}
	if args[3] == "" {
		return shimArgs{}, errors.New("user is empty")
	}
	rel, fromFD := strings.CutPrefix(args[4], ShimCwdFromFD)
	if args[4] != ShimCwdInherited && (!fromFD || !filepath.IsLocal(rel)) {
		return shimArgs{}, fmt.Errorf("cwd %q: want %s or %s<a local path>", args[4], ShimCwdInherited, ShimCwdFromFD)
	}
	if args[6] == "" {
		return shimArgs{}, errors.New("argv[0] is empty")
	}
	return shimArgs{uid: uid, gid: gid, home: args[2], user: args[3], cwdFromFD: fromFD, cwdRel: rel, argv: args[6:]}, nil
}

// shimEnv is env with HOME, USER and LOGNAME replaced by the identity's: home, and
// user for both names.
func shimEnv(env []string, home, user string) []string {
	out := slices.DeleteFunc(slices.Clone(env), func(kv string) bool {
		k, _, _ := strings.Cut(kv, "=")
		return k == "HOME" || k == "USER" || k == "LOGNAME"
	})
	return append(out, "HOME="+home, "USER="+user, "LOGNAME="+user)
}
