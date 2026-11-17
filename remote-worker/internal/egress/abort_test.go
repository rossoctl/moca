//go:build unix

package egress

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"testing"
	"time"
)

// abortedConn returns a proxyConn in the state abort leaves it in between its
// cancel and its close of the guest conn (#825): aborted, context cancelled,
// the guest conn still open. guest is the other end of that conn.
func abortedConn(t *testing.T) (pc *proxyConn, guest net.Conn, sink *recSink) {
	t.Helper()
	sink = &recSink{}
	server, guest := net.Pipe()
	t.Cleanup(func() { _ = server.Close(); _ = guest.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	pc = &proxyConn{
		p:      &Proxy{cfg: Config{Audit: sink}},
		c:      &boundConn{Conn: server, caller: Caller{VMID: "vm-a", SessionID: "sid-a"}},
		caller: Caller{VMID: "vm-a", SessionID: "sid-a"},
		ctx:    ctx,
		cancel: cancel,
	}
	pc.mu.Lock()
	pc.aborted = true
	pc.mu.Unlock()
	cancel()
	return pc, guest, sink
}

// A forwarded request that fails because abort cancelled it reaches refuse;
// the guest must read nothing from it, and no second terminal event is
// written (#825: the guest read a 502 Bad Gateway after Unregister).
func TestRefuseWritesNothingOnAnAbortedConn(t *testing.T) {
	pc, guest, sink := abortedConn(t)
	done := make(chan struct{})
	go func() {
		pc.refuse(Event{Status: http.StatusBadGateway, Decision: DecisionUpstreamUnreachable}, "up.example")
		close(done)
	}()
	_ = guest.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 64)
	n, err := guest.Read(buf)
	if n > 0 {
		t.Fatalf("the guest read %q from an aborted conn, want nothing", buf[:n])
	}
	if !errors.Is(err, os.ErrDeadlineExceeded) && !errors.Is(err, io.EOF) {
		t.Fatalf("guest read: %v, want no bytes (a deadline or EOF)", err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("refuse blocked on an aborted conn")
	}
	if evs := sink.events(); len(evs) != 0 {
		t.Fatalf("refuse emitted %d events on an aborted conn, want 0 (abort's is the terminal one): %+v", len(evs), evs)
	}
}

// The same for the TLS-intercepting path's refusal, which writes over the
// guest TLS session: it must not reach the guest TLS at all.
func TestInterceptRefuseWritesNothingOnAnAbortedConn(t *testing.T) {
	pc, _, sink := abortedConn(t)
	c := &icConn{pc: pc, t: target{host: "up.example"}} // gtls is nil: a write would panic
	done := make(chan bool, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("icConn.refuse touched the guest TLS on an aborted conn: %v", r)
				done <- false
			}
		}()
		done <- c.refuse(Event{Status: http.StatusBadGateway, Decision: DecisionUpstreamUnreachable}, Event{})
	}()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("icConn.refuse reported true, want false")
		}
	case <-time.After(time.Second):
		t.Fatal("icConn.refuse blocked on an aborted conn")
	}
	if evs := sink.events(); len(evs) != 0 {
		t.Fatalf("icConn.refuse emitted %d events on an aborted conn, want 0: %+v", len(evs), evs)
	}
}

// A conn that was not aborted still gets its refusal, as before.
func TestRefuseStillWritesOnALiveConn(t *testing.T) {
	sink := &recSink{}
	server, guest := net.Pipe()
	defer guest.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pc := &proxyConn{p: &Proxy{cfg: Config{Audit: sink}}, c: &boundConn{Conn: server}, ctx: ctx, cancel: cancel}
	go pc.refuse(Event{Status: http.StatusBadGateway, Decision: DecisionUpstreamUnreachable}, "up.example")
	_ = guest.SetReadDeadline(time.Now().Add(2 * time.Second))
	b, _ := io.ReadAll(io.LimitReader(guest, 12))
	if string(b) != "HTTP/1.1 502" {
		t.Fatalf("live conn read %q, want the 502 refusal", b)
	}
	if evs := sink.events(); len(evs) != 1 || evs[0].Decision != DecisionUpstreamUnreachable {
		t.Fatalf("live conn events %+v, want one %s", evs, DecisionUpstreamUnreachable)
	}
}

// icConn.refuse bounds its write to a guest that stops reading by
// drainTimeout. The guest TLS runs over an idleConn, whose every Write
// refreshes the idle clock, so without care that refresh replaces the drain
// deadline with the (much longer) idle one and a guest that never reads holds
// the conn, and its slot, for the whole idle bound. net.Pipe has no buffer, so
// a write the guest does not read blocks until a deadline ends it.
func TestInterceptRefuseWriteBoundedByDrainTimeout(t *testing.T) {
	ca := newTestCA(t, true)
	leafCA, err := NewLeafCA(ca.certPEM, ca.keyPEM, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := leafCA.Leaf("up.example")
	if err != nil {
		t.Fatal(err)
	}
	server, guest := net.Pipe()
	t.Cleanup(func() { _ = server.Close(); _ = guest.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := &recSink{}
	pc := &proxyConn{p: &Proxy{cfg: Config{Audit: sink}}, c: &boundConn{Conn: server}, ctx: ctx, cancel: cancel}
	k := &idleClock{read: []net.Conn{server}, write: []net.Conn{server}, idle: time.Minute}
	gtls := tls.Server(idleConn{Conn: server, k: k}, &tls.Config{
		Certificates: []tls.Certificate{*leaf}, MinVersion: tls.VersionTLS12,
		SessionTicketsDisabled: true, // a ticket write would block the handshake on the unread pipe
	})
	gc := tls.Client(guest, &tls.Config{ServerName: "up.example", RootCAs: ca.pool()})
	hs := make(chan error, 1)
	go func() { hs <- gc.Handshake() }()
	if err := gtls.Handshake(); err != nil {
		t.Fatal(err)
	}
	if err := <-hs; err != nil {
		t.Fatal(err)
	}

	// The guest now reads nothing, so the refusal's write can only end by a deadline.
	c := &icConn{pc: pc, t: target{host: "up.example"}, k: k, gtls: gtls}
	done := make(chan struct{})
	start := time.Now()
	go func() {
		c.refuse(Event{Status: http.StatusBadGateway, Decision: DecisionUpstreamUnreachable}, Event{})
		close(done)
	}()
	// drainTimeout for the write, drainTimeout for the drain, and slack for a loaded machine.
	select {
	case <-done:
	case <-time.After(4*drainTimeout + time.Second):
		t.Fatalf("refuse still blocked after %v: the idle refresh overrode the drain deadline",
			time.Since(start).Round(time.Millisecond))
	}
}
