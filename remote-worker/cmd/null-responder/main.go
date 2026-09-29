// Command null-responder is E11's DRIVER-OVERHEAD CONTROL (issue #291 section 4).
//
// It serves sandbox.v1.SandboxExec and does nothing: Exec sends one
// End{req_id, exit_code: 0} and returns, Abort returns an empty response. There is no relay,
// no Redis, no worker, no VMM and no command execution -- start_null_stack in
// deploy/microvm/e11-density.sh is just this binary.
//
// e11-density.sh drives the IDENTICAL run_density_rung against it as a third arm
// ("driver-control", on by default), so subtracting that arm at each c gives the driver's
// own contribution to observed latency. That number decides whether item 3 of the issue -- a
// persistent-connection Go client replacing grpcurl -- is needed before an authoritative
// metal run: grpcurl still re-parses the proto and opens a fresh connection per call, and if
// that residue dominates at high c, a fixed-but-still-grpcurl driver would show a knee that
// is STILL an artifact. Committing to item 3 before measuring it would be a guess.
//
// Built against the existing gen/go/sandbox/v1 stubs. No new codegen.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"

	"google.golang.org/grpc"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

type responder struct {
	pb.UnimplementedSandboxExecServer
}

// Exec answers with one End and returns. The request's own req_id is ECHOED rather than
// zeroed: the relay demultiplexes responses by req_id, which is why e11-density.sh gives
// every slot a disjoint req_id space (two concurrent Execs sharing one collided on the
// validation rig and hung for 33 minutes). A control arm that always answered 0 would not
// exercise the same client-side path the real arms do.
func (responder) Exec(req *pb.ExecRequest, stream grpc.ServerStreamingServer[pb.ExecEvent]) error {
	var reqID uint64
	if e := req.GetExec(); e != nil {
		reqID = e.GetReqId()
	}
	return stream.Send(&pb.ExecEvent{
		Event: &pb.ExecEvent_End{End: &pb.End{ReqId: reqID, ExitCode: 0}},
	})
}

func (responder) Abort(context.Context, *pb.AbortRequest) (*pb.AbortResponse, error) {
	return &pb.AbortResponse{}, nil
}

func newServer() *grpc.Server {
	srv := grpc.NewServer()
	pb.RegisterSandboxExecServer(srv, responder{})
	return srv
}

// requireLoopback refuses any listen address that is not on this host. This is a refusal
// rather than a comment because the server answers EVERY Exec with success and no
// execution: anything that reached it over a network and believed it would be told its
// commands ran when nothing did.
func requireLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("listen address %q is not host:port: %w", addr, err)
	}
	if host == "" {
		return fmt.Errorf("listen address %q has no host part, which binds every interface - the null-responder answers every Exec with success and no execution, so it must never be reachable off this host (issue #291 section 4)", addr)
	}
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return nil
	}
	return fmt.Errorf("listen address %q is not loopback - the null-responder answers every Exec with success and no execution, so it must never be reachable off this host (issue #291 section 4)", addr)
}

func main() {
	addr := flag.String("listen", "127.0.0.1:8445", "loopback host:port to serve sandbox.v1.SandboxExec on")
	flag.Parse()

	if err := requireLoopback(*addr); err != nil {
		log.Fatalf("null-responder: %v", err)
	}
	lis, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("null-responder: listen %s: %v", *addr, err)
	}
	// requireLoopback checked the requested string, which does not resolve "localhost" and
	// so could pass despite the actual bind landing on a non-loopback interface. Check the
	// socket lis actually bound, not the flag string, before serving a single request.
	if tcpAddr, ok := lis.Addr().(*net.TCPAddr); !ok || !tcpAddr.IP.IsLoopback() {
		log.Fatalf("null-responder: bound address %s is not loopback - the null-responder answers every Exec with success and no execution, so it must never be reachable off this host (issue #291 section 4)", lis.Addr())
	}
	log.Printf("null-responder: serving sandbox.v1.SandboxExec on %s (E11 driver-control arm, issue #291)", lis.Addr())
	if err := newServer().Serve(lis); err != nil {
		log.Fatalf("null-responder: serve: %v", err)
	}
}
