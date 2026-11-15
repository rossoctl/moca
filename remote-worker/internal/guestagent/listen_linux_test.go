//go:build linux

package guestagent

import (
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// requireVsockLoopback skips unless SH_VSOCK=1, following the repo's SH_KVM /
// SH_LIVE_RELAY convention (see requireKVM in
// internal/vmpool/launcher_firecracker_test.go) so `make test` stays green without
// vsock loopback available. This task's own environment cannot exercise vsock at all
// (darwin has no AF_VSOCK, and the sandbox this ran in has no /dev/kvm or
// vsock_loopback either) — TestListenVsockLoopbackRoundTrip below is written against
// the real Listen/Accept contract but can only be run on a Linux rig with the
// vsock_loopback module loaded (CID 1, VMADDR_CID_LOCAL); see the task-13 fix report.
func requireVsockLoopback(t *testing.T) {
	t.Helper()
	if os.Getenv("SH_VSOCK") != "1" {
		t.Skip("needs vsock loopback (modprobe vsock_loopback, CID 1); set SH_VSOCK=1 on the rig")
	}
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM, 0)
	if err != nil {
		t.Fatalf("SH_VSOCK=1 but AF_VSOCK is unusable: %v", err)
	}
	_ = unix.Close(fd)
}

// TestListenVsockLoopbackRoundTrip is the test the shipped defect had none of: it
// binds vsock for real via Listen("vsock:<port>"), connects a second raw AF_VSOCK
// socket to CID 1 (VMADDR_CID_LOCAL, the loopback peer vsock_loopback provides) at
// that port, and round-trips independently-chosen bytes in both directions. Every
// value checked here is either a literal chosen in the test or a value the kernel
// reported (via Accept/getsockname) — nothing is computed by the code under test and
// then compared to itself.
func TestListenVsockLoopbackRoundTrip(t *testing.T) {
	requireVsockLoopback(t)

	const port = 9999
	ln, err := Listen("vsock:9999")
	if err != nil {
		t.Fatalf("Listen(vsock:%d): %v", port, err)
	}
	defer ln.Close()

	type acceptResult struct {
		conn interface {
			io.ReadWriteCloser
		}
		err error
	}
	acceptCh := make(chan acceptResult, 1)
	go func() {
		c, err := ln.Accept()
		acceptCh <- acceptResult{conn: c, err: err}
	}()

	// Dial the loopback peer with a raw socket rather than through Listen/Dial: this
	// keeps the client side independent of the code under test, so a bug that makes
	// both the client and server sides fail to talk to a real vsock peer can't hide
	// behind two matching implementations.
	cfd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM, 0)
	if err != nil {
		t.Fatalf("client socket: %v", err)
	}
	defer func() { _ = unix.Close(cfd) }()
	if err := unix.Connect(cfd, &unix.SockaddrVM{CID: unix.VMADDR_CID_LOCAL, Port: port}); err != nil {
		t.Fatalf("client connect to CID_LOCAL:%d: %v", port, err)
	}

	res := <-acceptCh
	if res.err != nil {
		t.Fatalf("Accept: %v", res.err)
	}
	server := res.conn
	defer server.Close()

	const toServer = "vsock loopback: client to server"
	if err := rawWriteAll(cfd, []byte(toServer)); err != nil {
		t.Fatalf("client write: %v", err)
	}
	gotServer := make([]byte, len(toServer))
	if _, err := io.ReadFull(server, gotServer); err != nil {
		t.Fatalf("server read: %v", err)
	}
	if string(gotServer) != toServer {
		t.Fatalf("server read %q, want %q", gotServer, toServer)
	}

	const toClient = "vsock loopback: server to client"
	if _, err := server.Write([]byte(toClient)); err != nil {
		t.Fatalf("server write: %v", err)
	}
	gotClient := make([]byte, len(toClient))
	if err := rawReadFull(cfd, gotClient); err != nil {
		t.Fatalf("client read: %v", err)
	}
	if string(gotClient) != toClient {
		t.Fatalf("client read %q, want %q", gotClient, toClient)
	}
}

// rawWriteAll and rawReadFull drive the client side of the loopback test over a raw,
// blocking AF_VSOCK fd — no *os.File, no net.Conn, nothing from the package under
// test.
func rawWriteAll(fd int, b []byte) error {
	for len(b) > 0 {
		n, err := unix.Write(fd, b)
		if err != nil {
			return err
		}
		b = b[n:]
	}
	return nil
}

func rawReadFull(fd int, buf []byte) error {
	for len(buf) > 0 {
		n, err := unix.Read(fd, buf)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrUnexpectedEOF
		}
		buf = buf[n:]
	}
	return nil
}

// TestListenVsockBadPort exercises the ParseUint error path in Listen, which only
// exists on the vsock: branch of the linux build — nothing here needs an actual
// socket, so it runs on any Linux build (no SH_VSOCK gate).
func TestListenVsockBadPort(t *testing.T) {
	_, err := Listen("vsock:not-a-port")
	if err == nil {
		t.Fatal("Listen(vsock:not-a-port) = nil error, want a port-parsing error")
	}
	if !strings.Contains(err.Error(), "vsock port") {
		t.Fatalf("error = %q, want it to mention the bad vsock port", err)
	}
}

// TestListenUnknownScheme exercises the linux build's default case in the scheme
// switch (listen_other.go phrases the same situation differently, so this is
// linux-specific by construction, not by an env gate).
func TestListenUnknownScheme(t *testing.T) {
	_, err := Listen("carrier-pigeon:1")
	if err == nil {
		t.Fatal("Listen(carrier-pigeon:1) = nil error, want an unknown-scheme error")
	}
	if !strings.Contains(err.Error(), "unknown listen scheme") {
		t.Fatalf("error = %q, want it to say unknown listen scheme", err)
	}
}

// TestDialVsockLoopbackRoundTrip dials a listenVsock listener from CID 1 (loopback)
// through DialVsock and round-trips bytes, including a CloseWrite half-close.
func TestDialVsockLoopbackRoundTrip(t *testing.T) {
	requireVsockLoopback(t)
	const port = 9998
	ln, err := listenVsock(port)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		b, _ := io.ReadAll(c)
		c.Write(b)
	}()
	c, err := DialVsock(unix.VMADDR_CID_LOCAL, port)
	if err != nil {
		t.Fatalf("DialVsock: %v", err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	if err := c.(interface{ CloseWrite() error }).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(c)
	if err != nil || string(b) != "ping" {
		t.Fatalf("got %q, %v", b, err)
	}
}

// A dialled vsock conn must stay non-blocking. On a blocking fd a pending Read holds it, and
// Close neither wakes the reader nor releases the fd -- so a guest client that resets
// mid-tunnel leaks a goroutine and the host never sees EOF (#582 review). Checked on
// nested-m8i: a variant of DialVsock that leaves the fd blocking hangs here.
func TestDialedVsockCloseUnblocksAPendingRead(t *testing.T) {
	requireVsockLoopback(t)
	const port = 9997
	ln, err := listenVsock(port)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	peerClosed := make(chan struct{})
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = io.Copy(io.Discard, c) // idle upstream: never writes, returns when the dialler closes
		close(peerClosed)
	}()
	c, err := DialVsock(unix.VMADDR_CID_LOCAL, port)
	if err != nil {
		t.Fatalf("DialVsock: %v", err)
	}
	readDone := make(chan error, 1)
	go func() {
		_, err := c.Read(make([]byte, 1))
		readDone <- err
	}()
	time.Sleep(100 * time.Millisecond) // let the Read park
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	select {
	case <-readDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not unblock a pending Read: the dialled fd is in blocking mode")
	}
	select {
	case <-peerClosed:
	case <-time.After(2 * time.Second):
		t.Fatal("the peer never saw EOF: Close did not release the dialled fd")
	}
}

// TestVsockListenerCloseEndsAcceptWithErrClosed: Close unblocks a pending Accept, and it
// and every later Accept report net.ErrClosed -- the one error Agent.Serve returns on
// rather than retrying (Task 11 fix round 1, item 1).
func TestVsockListenerCloseEndsAcceptWithErrClosed(t *testing.T) {
	requireVsockLoopback(t)
	ln, err := Listen("vsock:9997")
	if err != nil {
		t.Fatalf("Listen(vsock:9997): %v", err)
	}
	errc := make(chan error, 1)
	go func() {
		_, err := ln.Accept()
		errc <- err
	}()
	time.Sleep(100 * time.Millisecond) // let Accept park on the poller
	if err := ln.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	select {
	case err := <-errc:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("pending Accept after Close: %v, want net.ErrClosed", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not unblock a pending Accept")
	}
	if _, err := ln.Accept(); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("Accept on a closed listener: %v, want net.ErrClosed", err)
	}
}
