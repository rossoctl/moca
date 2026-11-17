package egress

import (
	"io"
	"net"
	"sync/atomic"
	"time"
)

// This file holds the one idle bound shared by both data paths. Everything an
// established connection does — tunnel copies, the forwarded request, its
// response — goes through one of these wrappers, so a connection is closed
// only after `idle` with no byte moving on it, never because a long transfer
// ran out of absolute time.
//
// The bound refreshes rather than arming once. That distinction is the whole
// point: an absolute deadline would kill a slow but healthy `git clone`, and a
// refreshed one cannot, because every byte pushes it out.
//
// A zero or negative duration is a no-op, so a Config built by hand in a test
// keeps the old unbounded behaviour. NewProxy never leaves the bound zero.

// idleClock is one kind of activity and the deadlines it keeps alive. A socket
// deadline is per direction of one socket, so refreshing only the deadline of
// the socket a wrapper happens to touch does not express a bound on the
// established *connection* — and it kills a long one-way transfer mid-flight.
// During a `git clone` the guest sends nothing for as long as the pack takes to
// stream down, so a guest-only read deadline expires on a perfectly healthy
// tunnel; a forwarded upload fails mirrored, because http.Transport's readLoop
// blocks reading the upstream conn from dial time while only the request body
// is moving. One byte must therefore push out every deadline that byte proves
// is still live.
//
// Which deadlines a given activity proves live is not "all of them", which is
// why this is a set of targets per kind of activity rather than one clock per
// connection. Delivering a response to a guest shows the guest is *reading*;
// it says nothing about the request body it promised and never sent, so it
// must not excuse that. The call sites name the distinction.
//
// No watchdog goroutine is needed: a deadline applies to calls already blocked
// in Read or Write, not just later ones, so writing the clock through to the
// sockets *is* the enforcement. That also keeps every expiry a timeout error,
// which serve's loop and splice's copy-error arm already classify correctly,
// rather than the ErrClosed a watchdog's Close would produce — and it adds no
// per-connection goroutine to a process shared by every VM on the host.
type idleClock struct {
	read  []net.Conn
	write []net.Conn
	idle  time.Duration
	// stopped ends the refreshing for good; see stop.
	stopped atomic.Bool
}

// stop makes every later touch a no-op, so a deadline set by hand after it
// stands. A refusal needs this: its write and drain are bounded by
// drainTimeout, but they go through the same wrappers as everything else, and
// the first byte would push the deadline back out to idle — leaving a guest
// that never reads holding the conn for the whole idle bound instead of a
// second. Once a conn is being refused nothing on it is live any more, so
// there is nothing left for the clock to keep alive.
func (k *idleClock) stop() {
	if k != nil {
		k.stopped.Store(true)
	}
}

// touch pushes every deadline in the clock out by idle. Concurrent callers are
// safe: a net.Conn may be used from several goroutines, and two touches racing
// differ only by the microseconds between their time.Now calls, so whichever
// lands last sets the same deadline either way.
func (k *idleClock) touch() {
	if k == nil || k.idle <= 0 || k.stopped.Load() {
		return
	}
	t := time.Now().Add(k.idle)
	for _, c := range k.read {
		_ = c.SetReadDeadline(t)
	}
	for _, c := range k.write {
		_ = c.SetWriteDeadline(t)
	}
}

// bothWays is the clock for a connection whose two conns are interchangeable:
// any byte in any direction proves the whole thing is live. The tunnel path
// uses it, because an opaque splice cannot tell a request from a response.
func bothWays(guest, up net.Conn, idle time.Duration) *idleClock {
	return &idleClock{read: []net.Conn{guest, up}, write: []net.Conn{guest, up}, idle: idle}
}

// idleReader refreshes the clock before every read through it. The reader and
// the conns are separate because the two are not always the same object: the
// guest side of a tunnel is read through a bufio.Reader that already holds
// whatever came in behind the CONNECT, while the deadlines belong on the conns
// underneath.
type idleReader struct {
	r io.Reader
	k *idleClock
}

func (r idleReader) Read(b []byte) (int, error) {
	r.k.touch()
	return r.r.Read(b)
}

// idleWriter refreshes the clock before every write to c.
type idleWriter struct {
	c net.Conn
	k *idleClock
}

func (w idleWriter) Write(b []byte) (int, error) {
	w.k.touch()
	return w.c.Write(b)
}

// idleConn applies the bound to a conn handed to something that reads and
// writes it on its own schedule — the forward path's Transport, which writes
// the request, reads the response headers and then streams the body without
// the proxy in between. Wrapping the conn covers all three; wrapping the
// response body alone would leave the request write unbounded.
//
// The embedded Conn's own SetDeadline methods stay reachable, and the
// deadlines set here are plain socket deadlines, so they do not collide with
// the Transport's separate ResponseHeaderTimeout timer.
type idleConn struct {
	net.Conn
	k *idleClock
}

func (c idleConn) Read(b []byte) (int, error) {
	c.k.touch()
	return c.Conn.Read(b)
}

func (c idleConn) Write(b []byte) (int, error) {
	c.k.touch()
	return c.Conn.Write(b)
}
