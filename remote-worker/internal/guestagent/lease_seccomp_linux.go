//go:build linux

package guestagent

import (
	"fmt"

	"golang.org/x/sys/unix"
)

// seccompFilter builds the lease Exec's seccomp program for goarch (spec §3.3). It
// denies ptrace, process_vm_readv, process_vm_writev and pidfd_getfd with EPERM, so an
// Exec cannot trace, read into or copy an fd out of another process of its uid, and
// allows everything else. A syscall
// made under a foreign audit arch, or an amd64 x32 syscall number, kills the process:
// those are other syscall tables, where the numbers below would mean something else.
func seccompFilter(goarch string) ([]unix.SockFilter, error) {
	var auditArch uint32
	var denied []uint32
	x32 := false
	switch goarch {
	case "amd64":
		auditArch, x32 = unix.AUDIT_ARCH_X86_64, true
		denied = []uint32{101, 310, 311, 438} // ptrace, process_vm_readv, process_vm_writev, pidfd_getfd
	case "arm64":
		auditArch = unix.AUDIT_ARCH_AARCH64
		denied = []uint32{117, 270, 271, 438} // ptrace, process_vm_readv, process_vm_writev, pidfd_getfd
	default:
		return nil, fmt.Errorf("no lease seccomp filter for GOARCH %q", goarch)
	}

	const (
		offNr   = 0 // seccomp_data.nr
		offArch = 4 // seccomp_data.arch
		x32Bit  = 0x40000000
	)
	ld := func(off uint32) unix.SockFilter {
		return unix.SockFilter{Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, K: off}
	}
	ret := func(v uint32) unix.SockFilter {
		return unix.SockFilter{Code: unix.BPF_RET | unix.BPF_K, K: v}
	}
	// jmp compares the accumulator with k: on true it skips jt instructions, else jf.
	jmp := func(op uint16, k uint32, jt, jf uint8) unix.SockFilter {
		return unix.SockFilter{Code: unix.BPF_JMP | op | unix.BPF_K, K: k, Jt: jt, Jf: jf}
	}
	kill := ret(unix.SECCOMP_RET_KILL_PROCESS)

	prog := []unix.SockFilter{
		ld(offArch),
		jmp(unix.BPF_JEQ, auditArch, 1, 0),
		kill,
		ld(offNr),
	}
	if x32 {
		prog = append(prog, jmp(unix.BPF_JGE, x32Bit, 0, 1), kill)
	}
	// Each denied number jumps forward to the shared ERRNO return at the end: past the
	// remaining comparisons and the ALLOW.
	for i, nr := range denied {
		prog = append(prog, jmp(unix.BPF_JEQ, nr, uint8(len(denied)-i), 0))
	}
	prog = append(prog,
		ret(unix.SECCOMP_RET_ALLOW),
		ret(unix.SECCOMP_RET_ERRNO|uint32(unix.EPERM)),
	)
	return prog, nil
}
