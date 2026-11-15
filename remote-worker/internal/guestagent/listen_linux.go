//go:build linux

package guestagent

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync/atomic"

	"golang.org/x/sys/unix"
)

// Listen parses addr as "vsock:<port>" or "unix:<path>" and returns a bound listener.
// unix: is kept alongside vsock: so the same binary can be driven over a local socket
// during development without needing a VM (spec §5.1's transport is vsock only once
// inside a real guest).
func Listen(addr string) (net.Listener, error) {
	scheme, rest, ok := strings.Cut(addr, ":")
	if !ok {
		return nil, fmt.Errorf("guestagent: listen address %q must be scheme:value", addr)
	}
	switch scheme {
	case "vsock":
		port, err := strconv.ParseUint(rest, 10, 32)
		if err != nil {
			return nil, fmt.Errorf("guestagent: vsock port %q: %w", rest, err)
		}
		return listenVsock(uint32(port))
	case "unix":
		return net.Listen("unix", rest)
	default:
		return nil, fmt.Errorf("guestagent: unknown listen scheme %q", scheme)
	}
}

// listenVsock binds AF_VSOCK on VMADDR_CID_ANY: inside the guest there is exactly one
// vsock device, and the host's CID can vary (it changes across a restore per spec
// §2.4), so the guest side has no fixed peer CID to bind to — only a port.
//
// net.FileListener/net.FileConn cannot be used here: both validate the socket's
// address family against AF_INET/AF_INET6/AF_UNIX and return EPROTONOSUPPORT for
// AF_VSOCK ("protocol not supported" — this is exactly what crashed guest-agent as
// PID 1 on a real Firecracker VM; see the task-13 fix report). So this hand-rolls a
// net.Listener/net.Conn over the raw vsock fd instead of going through either.
//
// Hand-rolling rather than adding a vsock dependency: this binary runs as PID 1
// inside the guest, the file already talks to golang.org/x/sys/unix directly for the
// bind/listen dance, and the amount of new surface needed (Accept via the runtime
// poller, a net.Addr, a Conn adapter) is small enough that a new module dependency
// buys little for code that only ever runs inside one throwaway VM per command.
func listenVsock(port uint32) (net.Listener, error) {
	fd, err := listenSocket(unix.AF_VSOCK)
	if err != nil {
		return nil, fmt.Errorf("guestagent: vsock socket: %w", err)
	}
	sa := &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}
	if err := unix.Bind(fd, sa); err != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("guestagent: vsock bind port %d: %w", port, err)
	}
	if err := unix.Listen(fd, 128); err != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("guestagent: vsock listen port %d: %w", port, err)
	}
	// Non-blocking so os.NewFile registers fd with the runtime poller (it fstats the
	// fd, sees AF_VSOCK is a socket, and treats it as pollable) instead of leaving
	// Accept/Read/Write to block an OS thread each.
	if err := unix.SetNonblock(fd, true); err != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("guestagent: vsock set nonblocking port %d: %w", port, err)
	}
	// Unlike net.FileListener — which dups the fd for its own use, so the original
	// f.Close() the old code deferred was safe — nothing here dups fd. This *os.File
	// is fd's ONLY owner from this point on: closing it (via vsockListener.Close)
	// closes fd exactly once, and nothing else may close fd directly.
	f := os.NewFile(uintptr(fd), fmt.Sprintf("vsock:%d", port))
	return &vsockListener{f: f, addr: vsockAddr{cid: unix.VMADDR_CID_ANY, port: port}}, nil
}

// listenSocket creates the listening socket for listenVsock. SOCK_CLOEXEC, like every
// fd the agent opens: a lease Exec is forked from the agent, and an inherited port-1024
// listener would let uid 7000 accept the host's next connection in the agent's place.
// The domain is a parameter so a test can check the flags on an AF_UNIX socket where
// there is no vsock.
func listenSocket(domain int) (int, error) {
	return unix.Socket(domain, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
}

// vsockAddr implements net.Addr for an AF_VSOCK endpoint.
type vsockAddr struct {
	cid, port uint32
}

func (a vsockAddr) Network() string { return "vsock" }
func (a vsockAddr) String() string  { return fmt.Sprintf("vsock:%d:%d", a.cid, a.port) }

// vsockListener is a net.Listener over a raw, non-blocking AF_VSOCK socket. f is the
// sole owner of the underlying fd (see listenVsock). closed is set by Close, so an Accept
// on (or blocked in) a closed listener reports net.ErrClosed, as net's listeners do:
// Agent.Serve ends on that alone and retries every other error.
type vsockListener struct {
	f      *os.File
	addr   vsockAddr
	closed atomic.Bool
}

// Accept blocks until a peer connects, using f's SyscallConn to wait for readability
// on the runtime poller (the same mechanism net's own listeners use) rather than
// blocking an OS thread in the accept(2) syscall.
func (l *vsockListener) Accept() (net.Conn, error) {
	if l.closed.Load() {
		return nil, fmt.Errorf("guestagent: vsock accept: %w", net.ErrClosed)
	}
	rc, err := l.f.SyscallConn()
	if err != nil {
		return nil, fmt.Errorf("guestagent: vsock accept: %w", err)
	}
	var (
		nfd       int
		peer      unix.Sockaddr
		acceptErr error
	)
	if err := rc.Read(func(fd uintptr) bool {
		for {
			nfd, peer, acceptErr = unix.Accept4(int(fd), unix.SOCK_CLOEXEC)
			// An interrupted or aborted accept is retried at once (acceptRetryable): the
			// poller is edge-triggered, so waiting for readability could miss a
			// connection already queued.
			if !acceptRetryable(acceptErr) {
				break
			}
		}
		// Returning false tells RawConn.Read to wait for readability and retry;
		// any outcome other than EAGAIN (success or a real error) is final.
		return acceptErr != unix.EAGAIN
	}); err != nil {
		if l.closed.Load() {
			return nil, fmt.Errorf("guestagent: vsock accept: %w", net.ErrClosed)
		}
		return nil, fmt.Errorf("guestagent: vsock accept: %w", err)
	}
	if acceptErr != nil {
		return nil, fmt.Errorf("guestagent: vsock accept: %w", acceptErr)
	}
	if err := unix.SetNonblock(nfd, true); err != nil {
		_ = unix.Close(nfd)
		return nil, fmt.Errorf("guestagent: vsock accepted conn nonblocking: %w", err)
	}

	remote := vsockAddr{port: l.addr.port}
	if svm, ok := peer.(*unix.SockaddrVM); ok {
		remote = vsockAddr{cid: svm.CID, port: svm.Port}
	}
	local := l.addr
	if svm, ok := localSockaddrVM(nfd); ok {
		local = vsockAddr{cid: svm.CID, port: svm.Port}
	}

	// As in listenVsock: nfd is not dup'd anywhere, so this *os.File is its only
	// owner and Close() on the returned conn closes nfd exactly once.
	cf := os.NewFile(uintptr(nfd), fmt.Sprintf("vsock-conn:%d", remote.port))
	return &vsockConn{File: cf, local: local, remote: remote}, nil
}

func (l *vsockListener) Close() error {
	l.closed.Store(true)
	return l.f.Close()
}

func (l *vsockListener) Addr() net.Addr { return l.addr }

// localSockaddrVM reports fd's local vsock address, if the kernel can give one.
func localSockaddrVM(fd int) (*unix.SockaddrVM, bool) {
	sa, err := unix.Getsockname(fd)
	if err != nil {
		return nil, false
	}
	svm, ok := sa.(*unix.SockaddrVM)
	return svm, ok
}

// vsockConn is a net.Conn over an accepted AF_VSOCK fd. *os.File already supplies
// Read/Write/Close and, because the fd is a pollable socket (see listenVsock),
// working SetDeadline/SetReadDeadline/SetWriteDeadline — so only the net.Addr side of
// the interface needs a thin adapter here.
type vsockConn struct {
	*os.File
	local, remote vsockAddr
}

func (c *vsockConn) LocalAddr() net.Addr  { return c.local }
func (c *vsockConn) RemoteAddr() net.Addr { return c.remote }

// CloseWrite half-closes the connection (shutdown(SHUT_WR)) so the peer reads EOF
// while this side can still read; the egress forwarder relies on it.
func (c *vsockConn) CloseWrite() error {
	rc, err := c.File.SyscallConn()
	if err != nil {
		return err
	}
	var serr error
	if err := rc.Control(func(fd uintptr) { serr = unix.Shutdown(int(fd), unix.SHUT_WR) }); err != nil {
		return err
	}
	return serr
}
