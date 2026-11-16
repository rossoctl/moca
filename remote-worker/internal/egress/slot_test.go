//go:build unix

package egress

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"
)

// gateSink records events, and parks the emitter of the first event with the
// gated decision until the test opens the gate. While it is parked, whatever
// the conn's handler does after emitting has not happened yet, so a test can
// act at the exact moment a guest could first act on the event.
type gateSink struct {
	recSink
	decision string
	once     sync.Once
	reached  chan struct{}
	gate     chan struct{}
}

func newGateSink(decision string) *gateSink {
	return &gateSink{decision: decision, reached: make(chan struct{}), gate: make(chan struct{})}
}

func (s *gateSink) Emit(e Event) {
	s.recSink.Emit(e)
	if e.Decision != s.decision {
		return
	}
	first := false
	s.once.Do(func() { first = true })
	if !first {
		return
	}
	close(s.reached)
	select {
	case <-s.gate:
	case <-time.After(10 * time.Second): // never wedge the suite
	}
}

// TestTunnelSlotIsFreeOnceItsEventAndCloseArrive is #783. With a cap of one,
// a tunnel that ends (here by the idle bound, as in the conformance case
// connect_tunnel_idle_deadline) must have given its slot back by the time its
// tunnel event is emitted and its guest conn is seen closed: a guest that
// reconnects at that moment must be admitted. The slot used to be freed in a
// deferred step after both, so a second CONNECT racing that step met conn_cap.
// The sink parks the first conn's handler inside its tunnel event, which holds
// the old ordering's window open and makes it fail every time.
func TestTunnelSlotIsFreeOnceItsEventAndCloseArrive(t *testing.T) {
	up := newTCPUpstream(t, func(c net.Conn) { defer c.Close(); _, _ = io.ReadAll(c) })
	target := fmt.Sprintf("up.test:%d", up.port)
	sink := newGateSink(DecisionTunnel)
	h := newHarness(t, target, func(c *Config) {
		c.MaxConnsPerVM = 1
		c.IdleTimeout = 200 * time.Millisecond
		c.Audit = sink
	})
	var openGate sync.Once
	t.Cleanup(func() { openGate.Do(func() { close(sink.gate) }) }) // runs before the harness's p.Close
	h.res.set("up.test", "127.0.0.1")
	path := h.register("vm-1", "run-a")

	c1 := dial(t, path)
	connect(t, c1, target)
	select {
	case <-sink.reached:
	case <-time.After(5 * time.Second):
		t.Fatal("no tunnel event after the idle bound")
	}
	// The event is out; so is the close.
	_ = c1.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := c1.Read(make([]byte, 1)); err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("first guest conn not closed when its tunnel event was emitted: %v", err)
	}

	c2 := dial(t, path)
	fmt.Fprintf(c2, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
	resp, err := http.ReadResponse(bufio.NewReader(c2), nil)
	if err != nil {
		t.Fatalf("second CONNECT: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("second CONNECT: status %d %q, want 200 (the ended tunnel still held its slot)", resp.StatusCode, body)
	}
	openGate.Do(func() { close(sink.gate) })
}
