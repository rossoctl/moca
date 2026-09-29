package main

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

// startResponder serves the real responder on an ephemeral loopback port and returns a
// client for it. Nothing here needs /dev/kvm, a relay, Redis or a worker -- which is the
// point of the control arm.
func startResponder(t *testing.T) pb.SandboxExecClient {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := newServer()
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)

	cc, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = cc.Close() })
	return pb.NewSandboxExecClient(cc)
}

// The whole contract of the control arm's server: one End, carrying the request's own
// req_id, exit 0, then the stream ends. e11-density.sh gives every slot a disjoint req_id
// space because the relay demultiplexes by it; a control arm that always answered 0 would not
// exercise the same client path the real arms do.
func TestExecSendsOneEndCarryingTheRequestsReqID(t *testing.T) {
	client := startResponder(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stream, err := client.Exec(ctx, &pb.ExecRequest{
		SandboxId: "e11-driver-control",
		Exec:      &pb.Exec{ReqId: 3000001, Command: "true", TimeoutS: 30},
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	ev, err := stream.Recv()
	if err != nil {
		t.Fatalf("first Recv: %v", err)
	}
	end := ev.GetEnd()
	if end == nil {
		t.Fatalf("first event was %T, want an End", ev.GetEvent())
	}
	if end.GetReqId() != 3000001 {
		t.Errorf("End.req_id = %d, want the request's own 3000001", end.GetReqId())
	}
	if end.GetExitCode() != 0 {
		t.Errorf("End.exit_code = %d, want 0", end.GetExitCode())
	}

	if _, err := stream.Recv(); !errors.Is(err, io.EOF) {
		t.Errorf("second Recv = %v, want io.EOF (exactly one event, then done)", err)
	}
}

// A missing Exec sub-message must not panic the server: the driver builds the payload by
// string interpolation, so a malformed one is reachable.
func TestExecWithNoExecSubMessageStillEnds(t *testing.T) {
	client := startResponder(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stream, err := client.Exec(ctx, &pb.ExecRequest{SandboxId: "e11-driver-control"})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	ev, err := stream.Recv()
	if err != nil {
		t.Fatalf("Recv: %v", err)
	}
	if end := ev.GetEnd(); end == nil || end.GetReqId() != 0 {
		t.Errorf("got %v, want an End with req_id 0", ev.GetEvent())
	}
}

func TestAbortReturnsAnEmptyResponse(t *testing.T) {
	client := startResponder(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, err := client.Abort(ctx, &pb.AbortRequest{SandboxId: "e11-driver-control", ReqId: 1}); err != nil {
		t.Fatalf("Abort: %v", err)
	}
}

// Loopback is ENFORCED, not merely documented. This server answers every Exec with success
// and no execution, so anything that reached it over a network and believed it would be told
// its commands ran when nothing did.
func TestRequireLoopback(t *testing.T) {
	for _, ok := range []string{"127.0.0.1:8445", "localhost:8445", "[::1]:8445", "127.0.0.2:0", "[::ffff:127.0.0.1]:8445"} {
		if err := requireLoopback(ok); err != nil {
			t.Errorf("requireLoopback(%q) = %v, want nil", ok, err)
		}
	}
	for _, bad := range []string{":8445", "0.0.0.0:8445", "10.0.0.5:8445", "example.com:8445", "8445", "[::]:8445", "[2001:db8::1]:8445"} {
		err := requireLoopback(bad)
		if err == nil {
			t.Errorf("requireLoopback(%q) = nil, want a refusal", bad)
			continue
		}
		// The refusal must name the address, or an operator cannot see what was wrong.
		if !strings.Contains(err.Error(), bad) {
			t.Errorf("requireLoopback(%q) refusal %q does not name the address", bad, err)
		}
	}
}
