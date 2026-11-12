// Command sbx is a static client for one sandbox/v1 workspace: the Go twin of
// docs/api/examples/sbx.py, for a coding agent whose shell may run only `sbx run` and `sbx put`.
// It needs nothing in the agent's container (no python, no grpcio), so it can be bind-mounted into
// any image (a benchmark runner, for one, mounts it into each agent's own container). The workspace is
// seeded on the server side, so there is no `push`.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

// grpcOpts are the dial options besides the transport credentials, which dial chooses (plaintext or TLS).
func grpcOpts() []grpc.DialOption {
	return []grpc.DialOption{
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(16 << 20)),
	}
}

func main() { os.Exit(realMain(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }

func realMain(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	op, command, mode, exit, ok := parse(args)
	if !ok {
		w := stdout
		if exit != 0 && len(args) > 0 {
			w = stderr
		}
		fmt.Fprint(w, usage)
		return exit
	}
	cfg, err := configFrom(os.Getenv, os.ReadFile)
	if err != nil {
		fmt.Fprintf(stderr, "sbx: %v\n", err)
		return 2
	}
	var data []byte
	if mode != noStdin {
		b, err := io.ReadAll(stdin)
		if err != nil {
			fmt.Fprintf(stderr, "sbx: reading stdin: %v\n", err)
			return 2
		}
		if mode == stdinIsScript {
			command = string(b)
		} else {
			data = b
		}
	}
	conn, err := dial(cfg)
	if err != nil {
		fmt.Fprintf(stderr, "sbx: %v\n", err)
		return 125
	}
	defer conn.Close()
	client := pb.NewSandboxExecClient(conn)

	// Ctrl-C or a TERM aborts the Exec this call started, as the Python client's KeyboardInterrupt
	// does, so an interrupted agent leaves no command running in the VM.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// cur is the req_id of the Exec in flight: a retry after a refusal at capacity takes a new one (call).
	var cur atomic.Uint64
	id := reqID()
	cur.Store(id)
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	go func() {
		if _, ok := <-sigs; ok {
			actx, acancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer acancel()
			actx = metadata.AppendToOutgoingContext(actx, "authorization", "Bearer "+cfg.token)
			_, _ = client.Abort(actx, &pb.AbortRequest{SandboxId: cfg.sandboxID, ReqId: cur.Load()})
			cancel()
		}
	}()
	defer signal.Stop(sigs)
	return call(ctx, client, cfg, id, op, command, data, stdout, stderr, callEnv{now: time.Now, sleep: sleepCtx, newID: reqID, jitter: jitterOf, cur: &cur})
}
