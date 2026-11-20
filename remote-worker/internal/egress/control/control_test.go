//go:build linux || darwin

package control

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	egressv1 "github.com/rossoctl/moca/gen/go/egress/v1"
	"github.com/rossoctl/moca/remote-worker/internal/shortdir"
	"google.golang.org/protobuf/proto"
)

type regCall struct {
	vmID, sid string
	grant     []byte
	ln        net.Listener
}

// recorder is a Handler that records calls. closeOnUnregister makes Unregister close the
// listener it was given, which is what a real moca-egress does.
type recorder struct {
	mu                sync.Mutex
	regs              chan regCall
	unregs            chan string
	listeners         map[string]net.Listener
	closeOnUnregister bool
}

func newRecorder() *recorder {
	return &recorder{regs: make(chan regCall, 16), unregs: make(chan string, 16), listeners: map[string]net.Listener{}}
}

func (r *recorder) Register(vmID, sid string, grant []byte, ln net.Listener) error {
	r.mu.Lock()
	r.listeners[vmID] = ln
	r.mu.Unlock()
	r.regs <- regCall{vmID, sid, grant, ln}
	return nil
}

func (r *recorder) Unregister(vmID string) error {
	r.mu.Lock()
	ln := r.listeners[vmID]
	delete(r.listeners, vmID)
	r.mu.Unlock()
	if ln != nil && r.closeOnUnregister {
		_ = ln.Close()
	}
	r.unregs <- vmID
	return nil
}

func shortDir(t *testing.T) string {
	t.Helper()
	d := shortdir.New(t, "ectl", len("/vm-doomed.sock"))
	return d
}

func startServer(t *testing.T, path string, uids []int, h Handler) *Server {
	t.Helper()
	s, err := NewServer(path, uids, h)
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.Serve() }()
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// vmListener creates a listening unix socket and returns its path and an *os.File for it.
func vmListener(t *testing.T, dir, name string) (string, *net.UnixListener, *os.File) {
	t.Helper()
	p := filepath.Join(dir, name)
	ul, err := net.ListenUnix("unix", &net.UnixAddr{Name: p, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	f, err := ul.File()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close(); _ = ul.Close() })
	return p, ul, f
}

func ctx(t *testing.T) context.Context {
	t.Helper()
	c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return c
}

func recv[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for handler call")
		panic("unreachable")
	}
}

func TestRegisterPassesAWorkingListener(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	c := NewClient(filepath.Join(dir, "c.sock"))
	defer c.Close()

	vmPath, _, f := vmListener(t, dir, "vm.sock")
	if err := c.Register(ctx(t), "vm-1", "run-a", nil, f); err != nil {
		t.Fatal(err)
	}
	call := recv(t, h.regs)
	if call.vmID != "vm-1" || call.sid != "run-a" {
		t.Fatalf("got %q %q", call.vmID, call.sid)
	}
	accepted := make(chan error, 1)
	go func() {
		conn, err := call.ln.Accept()
		if err == nil {
			conn.Close()
		}
		accepted <- err
	}()
	conn, err := net.Dial("unix", vmPath)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := recv(t, accepted); err != nil {
		t.Fatalf("handler accept: %v", err)
	}
}

func TestRegisterWithoutAnFdIsRefused(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	conn, err := net.Dial("unix", filepath.Join(dir, "c.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	uc := conn.(*net.UnixConn)
	req := &egressv1.ControlRequest{Msg: &egressv1.ControlRequest_Register{
		Register: &egressv1.Register{VmId: "vm-1", Sid: "s"}}}
	err = roundTrip(uc, req, -1)
	var re *RefusalError
	if !errors.As(err, &re) || re.Code != "bad_request" {
		t.Fatalf("want bad_request, got %v", err)
	}
	select {
	case v := <-h.regs:
		t.Fatalf("handler saw %v", v)
	default:
	}
}

func TestRegisterWithANonListeningSocketIsRefused(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	c := NewClient(filepath.Join(dir, "c.sock"))
	defer c.Close()
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	err = c.Register(ctx(t), "vm-1", "s", nil, f)
	var re *RefusalError
	if !errors.As(err, &re) || re.Code != "bad_request" {
		t.Fatalf("want bad_request, got %v", err)
	}
}

// The refusal must be the peer-UID check itself: the server closes a disallowed peer's
// connection without reading a frame or sending a reply, so the client reads EOF. A dial
// failure or any other error would not be this, and fails the test. (#582 review)
func TestServerRefusesAPeerOutsideAllowedUIDs(t *testing.T) {
	for _, tc := range []struct {
		name    string
		allowed []int
		refused bool
	}{
		{"disallowed uid", []int{os.Getuid() + 1}, true},
		{"allowed uid (control)", []int{os.Getuid()}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := shortDir(t)
			path := filepath.Join(dir, "c.sock")
			h := newRecorder()
			startServer(t, path, tc.allowed, h)
			conn, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
			if err != nil {
				t.Fatalf("dial: %v", err) // a dial failure is not the UID check
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
			req := &egressv1.ControlRequest{Msg: &egressv1.ControlRequest_Unregister{
				Unregister: &egressv1.Unregister{VmId: "vm-x"}}}
			// A refused peer may already be closed, so a failed write is expected there.
			werr := writeFrame(conn, req, -1)
			body, _, rerr := readFrame(conn)
			if !tc.refused {
				if werr != nil || rerr != nil {
					t.Fatalf("allowed peer: write %v, read %v", werr, rerr)
				}
				var reply egressv1.ControlReply
				if err := proto.Unmarshal(body, &reply); err != nil || !reply.GetOk() {
					t.Fatalf("allowed peer got reply %v (%v)", &reply, err)
				}
				return
			}
			if rerr == nil {
				t.Fatalf("disallowed peer got a reply frame (%d bytes)", len(body))
			}
			if !errors.Is(rerr, io.EOF) && !errors.Is(rerr, io.ErrUnexpectedEOF) && !errors.Is(rerr, syscall.ECONNRESET) {
				t.Fatalf("disallowed peer: want the server to close without a reply (EOF), got %v", rerr)
			}
			select {
			case v := <-h.regs:
				t.Fatalf("handler saw %v", v)
			case v := <-h.unregs:
				t.Fatalf("handler saw Unregister(%s) from a disallowed peer", v)
			default:
			}
		})
	}
}

func TestControlDisconnectUnregistersItsBindings(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	c := NewClient(filepath.Join(dir, "c.sock"))
	_, _, f1 := vmListener(t, dir, "vm1.sock")
	_, _, f2 := vmListener(t, dir, "vm2.sock")
	for id, f := range map[string]*os.File{"vm-1": f1, "vm-2": f2} {
		if err := c.Register(ctx(t), id, "s", nil, f); err != nil {
			t.Fatal(err)
		}
		recv(t, h.regs)
	}
	c.Close()
	got := map[string]bool{recv(t, h.unregs): true, recv(t, h.unregs): true}
	if !got["vm-1"] || !got["vm-2"] {
		t.Fatalf("unregistered %v", got)
	}
}

// restartWithGap registers vm-1, drops the caller's copy of its listener, stops the server
// and dials vm-1's socket while nobody serves it. It returns the gap connection.
func restartWithGap(t *testing.T, dir, ctlPath string, c *Client, s1 *Server, h1 *recorder) net.Conn {
	t.Helper()
	vmPath, ul, f := vmListener(t, dir, "vm.sock")
	if err := c.Register(ctx(t), "vm-1", "run-a", nil, f); err != nil {
		t.Fatal(err)
	}
	recv(t, h1.regs)

	// The caller drops its own copy; only the client's dup remains.
	f.Close()
	ul.SetUnlinkOnClose(false)
	ul.Close()

	s1.Close()
	if got := recv(t, h1.unregs); got != "vm-1" {
		t.Fatalf("old server unregistered %q", got)
	}

	// Nobody is accepting, but the backlog still takes the connection.
	gap, err := net.Dial("unix", vmPath)
	if err != nil {
		t.Fatalf("dial during gap: %v", err)
	}
	t.Cleanup(func() { gap.Close() })
	return gap
}

// acceptOne accepts on ln within the test's patience.
func acceptOne(t *testing.T, ln net.Listener) {
	t.Helper()
	type res struct {
		conn net.Conn
		err  error
	}
	ch := make(chan res, 1)
	go func() { cn, err := ln.Accept(); ch <- res{cn, err} }()
	r := recv(t, ch)
	if r.err != nil {
		t.Fatalf("accept: %v", r.err)
	}
	r.conn.Close()
}

// recvWithin is recv with an explicit bound.
func recvWithin[T any](t *testing.T, ch <-chan T, d time.Duration, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(d):
		t.Fatalf("timed out after %s waiting for %s", d, what)
		panic("unreachable")
	}
}

// A restart (systemctl restart moca-egress) is healed by the client on its own: vmpool may be
// idle for minutes, and a guest dialling in meanwhile must not hang in the backlog.
func TestClientReplaysWithoutFurtherCallsAfterServerRestart(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	h1 := newRecorder()
	h1.closeOnUnregister = true // proves the client's dup keeps the socket alive
	s1 := startServer(t, ctlPath, []int{os.Getuid()}, h1)
	c := NewClient(ctlPath)
	defer c.Close()
	restartWithGap(t, dir, ctlPath, c, s1, h1)

	// The new server comes up only after the client has already failed a few redials.
	time.Sleep(300 * time.Millisecond)
	h2 := newRecorder()
	startServer(t, ctlPath, []int{os.Getuid()}, h2)
	// No client call from here on.
	call := recvWithin(t, h2.regs, 2500*time.Millisecond, "the automatic replay")
	if call.vmID != "vm-1" || call.sid != "run-a" {
		t.Fatalf("replayed %q %q", call.vmID, call.sid)
	}
	acceptOne(t, call.ln) // the gap connection
}

// A call made after a restart still works and does not double-register what the heal loop
// may already have replayed.
func TestClientReplaysRegistrationsAfterServerRestart(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	h1 := newRecorder()
	h1.closeOnUnregister = true
	s1 := startServer(t, ctlPath, []int{os.Getuid()}, h1)
	c := NewClient(ctlPath)
	defer c.Close()
	restartWithGap(t, dir, ctlPath, c, s1, h1)

	h2 := newRecorder()
	startServer(t, ctlPath, []int{os.Getuid()}, h2)
	if err := c.Unregister(ctx(t), "vm-other"); err != nil {
		t.Fatal(err)
	}
	call := recv(t, h2.regs)
	if call.vmID != "vm-1" || call.sid != "run-a" {
		t.Fatalf("replayed %q %q", call.vmID, call.sid)
	}
	select {
	case v := <-h2.regs:
		t.Fatalf("vm-1 replayed twice (second: %q)", v.vmID)
	case <-time.After(300 * time.Millisecond):
	}
	acceptOne(t, call.ln)
}

// I1: a call whose ctx is already done when it is made is refused before it touches the shared
// connection, so it costs the other VMs on the host nothing -- vm-1 is never unbound at all.
// (Cancellation DURING a call, which does drop the connection and relies on the heal loop, is
// TestCallTimingOutMidFlightHealsTheConnection.)
func TestAlreadyCancelledCallNeverTouchesTheConnection(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	h := newRecorder()
	startServer(t, ctlPath, []int{os.Getuid()}, h)
	c := NewClient(ctlPath)
	defer c.Close()

	vmPath, _, f1 := vmListener(t, dir, "vm1.sock")
	if err := c.Register(ctx(t), "vm-1", "s", nil, f1); err != nil {
		t.Fatal(err)
	}
	recv(t, h.regs)

	_, _, f2 := vmListener(t, dir, "vm2.sock")
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.Register(cancelled, "vm-2", "s", nil, f2); !errors.Is(err, context.Canceled) {
		t.Fatalf("Register with a cancelled ctx = %v, want context.Canceled", err)
	}

	// Nothing at all reaches the server: no unbind of vm-1, no bind of vm-2.
	select {
	case vm := <-h.unregs:
		t.Fatalf("a call cancelled before it was made unbound %q", vm)
	case r := <-h.regs:
		t.Fatalf("a call cancelled before it was made bound %q", r.vmID)
	case <-time.After(500 * time.Millisecond):
	}
	h.mu.Lock()
	ln := h.listeners["vm-1"]
	h.mu.Unlock()
	conn, err := net.Dial("unix", vmPath)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	acceptOne(t, ln)
}

// A call whose ctx expires with the reply still pending keeps the connection: the reply is
// owed, the reader discards it, and the stream comes back into step. The point is what does
// NOT happen -- vm-1 is never unbound, so in the real proxy its in-flight tunnels keep
// flowing. (Dropping the connection instead would unbind every VM it owned, which is #587.)
func TestCallTimingOutMidFlightKeepsTheConnection(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	h := newGatedRecorder(t)
	h.closeOnUnregister = true // so an unbind of vm-1 would also kill its listener
	h.gateReg("vm-2")
	startServer(t, ctlPath, []int{os.Getuid()}, h)
	c := NewClient(ctlPath)
	defer c.Close()

	vm1Path, _, f1 := vmListener(t, dir, "vm1.sock")
	if err := c.Register(ctx(t), "vm-1", "s", nil, f1); err != nil {
		t.Fatal(err)
	}
	reg1 := recv(t, h.regs)

	c.mu.Lock()
	before := c.conn
	c.mu.Unlock()

	_, _, f2 := vmListener(t, dir, "vm2.sock")
	short, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	wantAbandoned(t, c.Register(short, "vm-2", "s", nil, f2))

	// vm-1 is not collateral damage. This is the whole issue: the drop this replaces unbound
	// it, and an unbind is what aborts a VM's live connections in the real proxy.
	select {
	case vm := <-h.unregs:
		t.Fatalf("an abandoned call unbound %q", vm)
	case <-time.After(500 * time.Millisecond):
	}
	c.mu.Lock()
	same, healing := c.conn == before, c.healing
	c.mu.Unlock()
	if !same {
		t.Fatal("the connection was replaced: an abandoned call dropped it")
	}
	if healing {
		t.Fatal("the heal loop started: an abandoned call dropped the connection")
	}

	// Release the handler and let the reader discard the owed reply. Nothing else moves owed
	// back to 0, so reaching 0 IS the discard.
	h.release()
	recv(t, h.regs) // the server finished vm-2 even though nobody was waiting
	waitOwedDrained(t, before)

	// The stream is in step again: a follow-up call gets its own reply, on the same connection.
	if err := c.Unregister(ctx(t), "vm-other"); err != nil {
		t.Fatalf("follow-up call on the kept connection: %v", err)
	}
	c.mu.Lock()
	same = c.conn == before
	c.mu.Unlock()
	if !same {
		t.Fatal("the follow-up call redialled")
	}
	// vm-1's listener still serves, so it was never closed -- and with closeOnUnregister set,
	// closing it is exactly what an unbind would have done.
	vmConn, err := net.Dial("unix", vm1Path)
	if err != nil {
		t.Fatalf("dial vm-1's socket: %v", err)
	}
	defer vmConn.Close()
	acceptOne(t, reg1.ln)
}

// An owed reply must be discarded, not left in the channel for the next caller to read as its
// own. A refusal makes that unmistakable: if the owed one leaks through, the Register below
// returns a verdict passed on another VM.
func TestAnOwedReplyIsNotDeliveredToTheNextCall(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	h := newGatedRecorder(t)
	h.refuse = map[string]bool{"vm-doomed": true}
	h.gateReg("vm-doomed")
	startServer(t, ctlPath, []int{os.Getuid()}, h)
	c := NewClient(ctlPath)
	defer c.Close()

	_, _, f1 := vmListener(t, dir, "vm-doomed.sock")
	short, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	wantAbandoned(t, c.Register(short, "vm-doomed", "s", nil, f1))
	c.mu.Lock()
	cc := c.conn
	c.mu.Unlock()
	if cc == nil {
		t.Fatal("the connection was dropped")
	}
	h.release()
	waitOwedDrained(t, cc)

	_, _, f2 := vmListener(t, dir, "vm-ok.sock")
	if err := c.Register(ctx(t), "vm-ok", "s", nil, f2); err != nil {
		t.Fatalf("Register of vm-ok = %v, want nil: it was handed the owed refusal", err)
	}
}

// The cleanup the kept connection no longer gets for free: the server binds a VM before it
// calls the handler, so an abandoned Register can complete server-side although the client
// never recorded it. The reaper Unregisters it, with no further call from vmpool.
func TestAnAbandonedRegisterIsReapedFromTheServer(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	h := newGatedRecorder(t)
	h.gateReg("vm-2")
	startServer(t, ctlPath, []int{os.Getuid()}, h)
	c := NewClient(ctlPath)
	defer c.Close()

	_, _, f1 := vmListener(t, dir, "vm1.sock")
	if err := c.Register(ctx(t), "vm-1", "s", nil, f1); err != nil {
		t.Fatal(err)
	}
	recv(t, h.regs)

	_, _, f2 := vmListener(t, dir, "vm2.sock")
	short, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	wantAbandoned(t, c.Register(short, "vm-2", "s", nil, f2))
	h.release()
	// vm-2 really is bound server-side first -- without that there would be nothing to reap.
	recv(t, h.regs)

	// Judge by the handler's binding table, not by replaying regs/unregs: those are two
	// channels, so a select can take them out of order (see recorder.held).
	deadline := time.Now().Add(3 * time.Second)
	var held []string
	for {
		held = h.held()
		if len(held) == 1 && held[0] == "vm-1" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server holds %v, want exactly [vm-1]: vm-2 was never reaped", held)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// And the reaper stops there rather than going on to unbind vm-1 as well.
	time.Sleep(300 * time.Millisecond)
	if held = h.held(); len(held) != 1 || held[0] != "vm-1" {
		t.Fatalf("after settling the server holds %v, want exactly [vm-1]", held)
	}
}

// A reply that lands in the window between call's select giving up and abandon taking the
// lock is not owed: abandon drains it. Left owed, it would be counted twice -- the stale reply
// sits in the channel AND the reader discards the next call's own reply, so that call reads
// someone else's verdict.
//
// This drives clientConn directly, with no server. The window is a few instructions wide and a
// gated handler cannot be steered into it, so -count=20 against a real server does not reach
// this case (it survives that run); the invariant it protects is deterministic, and this is
// where it gets pinned.
func TestAReplyThatLandsAsTheCallGivesUpIsNotOwed(t *testing.T) {
	cc := &clientConn{replies: make(chan []byte, 1), dead: make(chan struct{})}

	if !cc.take([]byte("first")) { // it landed while the call was still selecting
		t.Fatal("take of a reply nobody has given up on yet was refused")
	}
	cc.abandon() // and only then did the call give up

	cc.mu.Lock()
	owed := cc.owed
	cc.mu.Unlock()
	if owed != 0 {
		t.Fatalf("owed = %d after abandoning a call whose reply had already landed, want 0", owed)
	}
	select {
	case body := <-cc.replies:
		t.Fatalf("replies still holds %q: the abandoned call's reply was not drained", body)
	default:
	}

	// So the next call gets its own reply, not the abandoned one's.
	if !cc.take([]byte("second")) {
		t.Fatal("take of the next call's reply was refused")
	}
	select {
	case body := <-cc.replies:
		if string(body) != "second" {
			t.Fatalf("the next call read %q, want %q", body, "second")
		}
	default:
		t.Fatal("the next call's reply was discarded as owed")
	}
}

// The ordinary abandonment: the reply has not landed, so exactly one is owed and the reader
// discards exactly that one, leaving the call after it to read its own.
func TestAnOwedReplyIsDiscardedExactlyOnce(t *testing.T) {
	cc := &clientConn{replies: make(chan []byte, 1), dead: make(chan struct{})}

	cc.abandon()
	cc.mu.Lock()
	owed := cc.owed
	cc.mu.Unlock()
	if owed != 1 {
		t.Fatalf("owed = %d after abandoning a call with its reply pending, want 1", owed)
	}

	if !cc.take([]byte("owed")) {
		t.Fatal("the owed reply was treated as unsolicited")
	}
	select {
	case body := <-cc.replies:
		t.Fatalf("replies holds %q: the owed reply was delivered instead of discarded", body)
	default:
	}

	if !cc.take([]byte("next")) {
		t.Fatal("take of the following call's reply was refused")
	}
	select {
	case body := <-cc.replies:
		if string(body) != "next" {
			t.Fatalf("the following call read %q, want %q", body, "next")
		}
	default:
		t.Fatal("the following call's reply was discarded: more than one was owed")
	}
}

// wantAbandoned asserts that a call gave up with its reply pending. Which deadline fires
// first is a race the test must not depend on: call selects on ctx.Done() and on a timer
// built from the same deadline, so the error wraps either context.DeadlineExceeded or
// os.ErrDeadlineExceeded. Both are abandonments, and that is what matters here.
func wantAbandoned(t *testing.T, err error) {
	t.Helper()
	var ae *abandonedError
	if !errors.As(err, &ae) {
		t.Fatalf("call = %v, want an abandonedError", err)
	}
	if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("call = %v, want it to wrap a deadline error for callers that test for one", err)
	}
}

// waitOwedDrained waits until the reader has discarded every owed reply.
func waitOwedDrained(t *testing.T, cc *clientConn) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		cc.mu.Lock()
		owed := cc.owed
		cc.mu.Unlock()
		if owed == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("owed is still %d: the reader never discarded the abandoned call's reply", owed)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// gatedRecorder parks Register for the named VMs until the test releases it, which holds a
// call mid-flight deterministically rather than racing a sleep against a timeout. refuse
// names VMs whose Register fails once the gate opens.
type gatedRecorder struct {
	*recorder
	refuse map[string]bool

	gmu   sync.Mutex
	gated map[string]bool
	gate  chan struct{}
	once  sync.Once
}

// newGatedRecorder releases the gate on cleanup whether or not the test got that far: a
// parked handler holds Server.wg, so a test that fails before releasing would otherwise
// wedge the server's Close until the package timeout.
func newGatedRecorder(t *testing.T) *gatedRecorder {
	t.Helper()
	g := &gatedRecorder{
		recorder: newRecorder(), gated: map[string]bool{}, gate: make(chan struct{}),
	}
	t.Cleanup(g.release)
	return g
}

func (g *gatedRecorder) gateReg(vmID string) {
	g.gmu.Lock()
	defer g.gmu.Unlock()
	g.gated[vmID] = true
}

func (g *gatedRecorder) release() { g.once.Do(func() { close(g.gate) }) }

func (g *gatedRecorder) Register(vmID, sid string, grant []byte, ln net.Listener) error {
	g.gmu.Lock()
	gated := g.gated[vmID]
	g.gmu.Unlock()
	if gated {
		<-g.gate
	}
	if g.refuse[vmID] {
		return errors.New("no")
	}
	return g.recorder.Register(vmID, sid, grant, ln)
}

// held is the set of VMs the handler currently has bound, sorted.
func (r *recorder) held() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.listeners))
	for vm := range r.listeners {
		out = append(out, vm)
	}
	sort.Strings(out)
	return out
}

// Close stops a heal loop that is retrying against a server that never comes back.
func TestCloseStopsTheHealLoop(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	h := newRecorder()
	s := startServer(t, ctlPath, []int{os.Getuid()}, h)
	c := NewClient(ctlPath)
	_, _, f := vmListener(t, dir, "vm.sock")
	if err := c.Register(ctx(t), "vm-1", "s", nil, f); err != nil {
		t.Fatal(err)
	}
	recv(t, h.regs)
	s.Close()
	recv(t, h.unregs)
	time.Sleep(250 * time.Millisecond) // let the loop make an attempt or two
	done := make(chan struct{})
	go func() { _ = c.Close(); close(done) }()
	recvWithin(t, done, 3*time.Second, "Close to stop the heal loop")
	c.mu.Lock()
	healing := c.healing
	c.mu.Unlock()
	if healing {
		t.Fatal("heal loop still marked running after Close")
	}
}

func TestOversizeFrameIsRefused(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	conn, err := net.Dial("unix", filepath.Join(dir, "c.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], maxFrame+1)
	if _, err := conn.Write(hdr[:]); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected the server to close the connection")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("server did not close the connection")
	}
	select {
	case v := <-h.regs:
		t.Fatalf("handler saw %v", v)
	default:
	}
}

// refuser refuses the listed VMs and otherwise records like recorder.
type refuser struct {
	*recorder
	refuse map[string]bool
}

func (r *refuser) Register(vmID, sid string, grant []byte, ln net.Listener) error {
	if r.refuse[vmID] {
		return errors.New("no")
	}
	return r.recorder.Register(vmID, sid, grant, ln)
}

func TestClientEvictsARefusedReplayAndKeepsServing(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	h1 := newRecorder()
	s1 := startServer(t, ctlPath, []int{os.Getuid()}, h1)
	c := NewClient(ctlPath)
	defer c.Close()
	for _, id := range []string{"vm-1", "vm-2", "vm-3"} {
		_, _, f := vmListener(t, dir, id+".sock")
		if id == "vm-3" {
			s1.Close()
			h2 := &refuser{newRecorder(), map[string]bool{"vm-1": true}}
			startServer(t, ctlPath, []int{os.Getuid()}, h2)
			if err := c.Register(ctx(t), id, "s", nil, f); err != nil {
				t.Fatalf("register after restart: %v", err)
			}
			got := map[string]bool{recv(t, h2.regs).vmID: true, recv(t, h2.regs).vmID: true}
			if !got["vm-2"] || !got["vm-3"] || got["vm-1"] {
				t.Fatalf("new handler holds %v", got)
			}
			c.mu.Lock()
			_, stale := c.live["vm-1"]
			conn := c.conn
			c.mu.Unlock()
			if stale {
				t.Fatal("vm-1 not evicted")
			}
			if err := c.Unregister(ctx(t), "vm-other"); err != nil {
				t.Fatalf("follow-up call: %v", err)
			}
			c.mu.Lock()
			same := c.conn == conn
			c.mu.Unlock()
			if !same {
				t.Fatal("follow-up call redialled")
			}
			return
		}
		if err := c.Register(ctx(t), id, "s", nil, f); err != nil {
			t.Fatal(err)
		}
		recv(t, h1.regs)
	}
}

func TestFdOnAnUnregisterFrameIsClosed(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	conn, err := net.Dial("unix", filepath.Join(dir, "c.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	vmPath, ul, f := vmListener(t, dir, "vm.sock")
	req := &egressv1.ControlRequest{Msg: &egressv1.ControlRequest_Unregister{
		Unregister: &egressv1.Unregister{VmId: "vm-1"}}}
	if err := roundTrip(conn.(*net.UnixConn), req, int(f.Fd())); err != nil {
		t.Fatal(err)
	}
	// Once every other copy is gone, the socket survives only if the server leaked its fd.
	f.Close()
	ul.Close()
	assertSocketGone(t, vmPath)
}

func TestClientClosesItsDupAfterUnregister(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	h.closeOnUnregister = true
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	c := NewClient(filepath.Join(dir, "c.sock"))
	defer c.Close()
	vmPath, ul, f := vmListener(t, dir, "vm.sock")
	if err := c.Register(ctx(t), "vm-1", "s", nil, f); err != nil {
		t.Fatal(err)
	}
	recv(t, h.regs)
	c.mu.Lock()
	dup := c.live["vm-1"].fd
	c.mu.Unlock()
	if err := c.Unregister(ctx(t), "vm-1"); err != nil {
		t.Fatal(err)
	}
	recv(t, h.unregs)
	if _, err := unix.FcntlInt(uintptr(dup), unix.F_GETFD, 0); err == nil {
		t.Fatal("dup still open after Unregister")
	}
	f.Close()
	ul.Close()
	assertSocketGone(t, vmPath)
}

// assertSocketGone checks that no process holds the listening socket at path any more:
// the file may remain, but connecting must be refused.
func assertSocketGone(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		conn, err := net.Dial("unix", path)
		if err != nil {
			return
		}
		conn.Close()
		if time.Now().After(deadline) {
			t.Fatal("listening socket still alive: an fd leaked")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
