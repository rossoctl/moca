// Package relaytest is an in-process stand-in for the TypeScript relay
// (packages/sandbox-relay/src/relay.ts), used only by tests.
//
// It exists because the real relay is a pure bridge that CANNOT redeliver a
// req_id — it fails in-flight execs on stream close (relay.ts:89-93) and the
// harness never retries one. So the dedup half of the acceptance battery can only
// be driven by a relay that misbehaves on purpose (spec §4 D6). The gated
// SH_LIVE_RELAY tier covers fidelity against the real thing.
package relaytest

import (
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

// Relay accepts Attach streams and hands each one to the test as a *Conn.
type Relay struct {
	pb.UnimplementedSandboxWorkerServer
	Addr  string // host:port for the worker to dial
	srv   *grpc.Server
	conns chan *Conn
}

// Start listens on an ephemeral loopback port and stops with the test.
func Start(t *testing.T) *Relay {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	r := &Relay{Addr: lis.Addr().String(), srv: grpc.NewServer(), conns: make(chan *Conn, 4)}
	pb.RegisterSandboxWorkerServer(r.srv, r)
	go func() { _ = r.srv.Serve(lis) }()
	t.Cleanup(r.srv.Stop)
	return r
}

// Attach parks the worker's stream, as the real relay does: registration IS the
// live stream.
func (r *Relay) Attach(stream grpc.BidiStreamingServer[pb.WorkerFrame, pb.ServerFrame]) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	hello := first.GetHello()
	if hello == nil {
		return errors.New("first frame was not Hello")
	}

	var token string
	if md, ok := metadata.FromIncomingContext(stream.Context()); ok {
		if v := md.Get("authorization"); len(v) > 0 {
			token = v[0]
		}
	}

	c := &Conn{
		hello:  hello,
		token:  token,
		stream: stream,
		frames: make(chan *pb.WorkerFrame, 256),
		done:   make(chan struct{}),
	}
	r.conns <- c

	gone := make(chan struct{})
	go func() {
		defer close(gone)
		for {
			f, err := stream.Recv()
			if err != nil {
				return
			}
			select {
			case c.frames <- f:
			case <-c.done:
				return
			}
		}
	}()

	// Returning ends the stream, which is how Drop() forces a worker reconnect.
	select {
	case <-c.done:
	case <-gone:
	}
	return nil
}

// Conn is one parked worker stream.
type Conn struct {
	hello     *pb.Hello
	token     string
	stream    grpc.BidiStreamingServer[pb.WorkerFrame, pb.ServerFrame]
	frames    chan *pb.WorkerFrame
	done      chan struct{}
	closeOnce sync.Once
}

// WaitAttach blocks until a worker attaches.
func (r *Relay) WaitAttach(t *testing.T) *Conn {
	t.Helper()
	select {
	case c := <-r.conns:
		t.Cleanup(c.Drop)
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("no worker attached within 5s")
		return nil
	}
}

func (c *Conn) Hello() *pb.Hello { return c.hello }

// Token is the authorization metadata as the relay received it.
//
// Read this narrowly: the bearer header is attached by the TEST's dial code, not
// by the session — the worker package does not implement auth at all (the real
// entrypoint attaches the token). So this proves grpc-go propagated the header and
// that this test double extracts it; it is NOT coverage of anything that ships, and
// it says nothing about the production relay's own (TypeScript) extraction. Its
// value is catching a broken test harness locally instead of as a confusing
// live-test failure.
func (c *Conn) Token() string { return c.token }

func (c *Conn) SendExec(t *testing.T, e *pb.Exec) {
	t.Helper()
	if err := c.stream.Send(&pb.ServerFrame{Msg: &pb.ServerFrame_Exec{Exec: e}}); err != nil {
		t.Fatalf("send exec: %v", err)
	}
}

func (c *Conn) SendAbort(t *testing.T, reqID uint64) {
	t.Helper()
	if err := c.stream.Send(&pb.ServerFrame{Msg: &pb.ServerFrame_Abort{Abort: &pb.Abort{ReqId: reqID}}}); err != nil {
		t.Fatalf("send abort: %v", err)
	}
}

// Next returns the next frame, skipping heartbeats.
func (c *Conn) Next(t *testing.T) *pb.WorkerFrame {
	t.Helper()
	for {
		select {
		case f, ok := <-c.frames:
			if !ok {
				t.Fatal("worker stream closed while waiting for a frame")
				return nil
			}
			if f.GetHeartbeat() != nil {
				continue
			}
			return f
		case <-time.After(15 * time.Second):
			t.Fatal("timed out waiting for a worker frame")
			return nil
		}
	}
}

// Collect drains frames until the terminal one for reqID, splitting output by
// stream exactly as GrpcRelayTransport does (grpc-relay-transport.ts:84-107).
func (c *Conn) Collect(t *testing.T, reqID uint64) (stdout, stderr []byte, terminal *pb.WorkerFrame) {
	t.Helper()
	for {
		f := c.Next(t)
		if ch := f.GetChunk(); ch != nil && ch.GetReqId() == reqID {
			if ch.GetStream() == pb.Stream_STREAM_STDERR {
				stderr = append(stderr, ch.GetData()...)
			} else {
				stdout = append(stdout, ch.GetData()...)
			}
			continue
		}
		if e := f.GetEnd(); e != nil && e.GetReqId() == reqID {
			return stdout, stderr, f
		}
		if e := f.GetError(); e != nil && e.GetReqId() == reqID {
			return stdout, stderr, f
		}
	}
}

// Drop closes the parked stream, forcing the worker to reconnect. Idempotent.
func (c *Conn) Drop() { c.closeOnce.Do(func() { close(c.done) }) }
