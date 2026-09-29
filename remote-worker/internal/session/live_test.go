package session_test

import (
	"context"
	"encoding/base64"
	"io"
	"os"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
	"github.com/rossoctl/moca/remote-worker/internal/session"
)

// TestLiveRelayInterop runs a subset of the battery against the REAL TypeScript
// relay, which the hermetic tier cannot vouch for: the fake relay encodes this
// worker author's reading of the contract, not the relay's behavior (spec §10).
//
// Skipped unless SH_LIVE_RELAY=1, following the repo's M3_LIVE_SMOKE convention.
// Start the relay first:
//
//	docker run --rm -p 6379:6379 redis:7
//	SH_RELAY_TOKEN=dev-token SH_RELAY_PORT=8443 REDIS_URL=redis://127.0.0.1:6379 \
//	  pnpm --filter @moca/sandbox-relay start
//	SH_LIVE_RELAY=1 go test ./internal/session/ -run TestLiveRelay -v
func TestLiveRelayInterop(t *testing.T) {
	if os.Getenv("SH_LIVE_RELAY") != "1" {
		t.Skip("SH_LIVE_RELAY!=1: skipping real-relay interop")
	}
	addr := envOr("RELAY_ADDR", "localhost:8443")
	sandboxID := envOr("SANDBOX_ID", "sbx-dev-1")
	token := envOr("SANDBOX_TOKEN", "dev-token")

	// 1. Attach this worker to the real relay.
	cc, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = cc.Close() })

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	attachCtx := metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token)
	stream, err := pb.NewSandboxWorkerClient(cc).Attach(attachCtx)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	sess := session.New(session.Config{
		SandboxID:     sandboxID,
		Image:         "live:test",
		Trust:         "untrusted",
		Capabilities:  []string{"bash"},
		MaxConcurrent: 2,
	}, wexec.BashRunner{})
	served := make(chan struct{})
	go func() {
		defer close(served)
		_ = sess.Serve(ctx, stream)
	}()
	// Join it, so a teardown deadlock fails this gate instead of leaking a goroutine
	// while it reports PASS (#173 item 5). It cancels first rather than relying on
	// the t.Cleanup(cancel) above: cleanups run LIFO, so that one runs AFTER this
	// and the wait below would deadlock waiting for a stream nothing had torn down.
	t.Cleanup(func() {
		cancel()
		select {
		case <-served:
		case <-time.After(serveJoinGrace):
			t.Errorf("Serve did not return within %v of the attach context being cancelled", serveJoinGrace)
		}
	})
	time.Sleep(500 * time.Millisecond) // let the relay park the stream

	// 2. Drive execs from the harness-facing side.
	execClient := pb.NewSandboxExecClient(cc)
	dir := t.TempDir()

	t.Run("read", func(t *testing.T) {
		path := dir + "/live.txt"
		if err := os.WriteFile(path, []byte("live bytes\n"), 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		stdout, _, code := liveExec(t, execClient, sandboxID, &pb.Exec{
			ReqId: 101, Command: "cat " + path, TimeoutS: 10, Streaming: true,
		})
		if string(stdout) != "live bytes\n" || code != 0 {
			t.Errorf("stdout=%q code=%d, want %q/0", stdout, code, "live bytes\n")
		}
	})

	t.Run("write", func(t *testing.T) {
		path := dir + "/live-out.txt"
		_, _, code := liveExec(t, execClient, sandboxID, &pb.Exec{
			ReqId:     102,
			Command:   "base64 -d > " + path,
			Stdin:     []byte(base64.StdEncoding.EncodeToString([]byte("through the relay\n"))),
			TimeoutS:  10,
			Streaming: true,
		})
		if code != 0 {
			t.Fatalf("exit code = %d, want 0", code)
		}
		got, err := os.ReadFile(path)
		if err != nil || string(got) != "through the relay\n" {
			t.Errorf("file = %q err=%v", got, err)
		}
	})

	t.Run("bash_splits_streams", func(t *testing.T) {
		stdout, stderr, code := liveExec(t, execClient, sandboxID, &pb.Exec{
			ReqId: 103, Command: "echo hi; echo oops >&2; exit 7", TimeoutS: 10, Streaming: true,
		})
		if string(stdout) != "hi\n" || string(stderr) != "oops\n" || code != 7 {
			t.Errorf("stdout=%q stderr=%q code=%d, want \"hi\\n\"/\"oops\\n\"/7", stdout, stderr, code)
		}
	})
}

// liveExec drives one exec through SandboxExec.Exec and returns the split output.
func liveExec(t *testing.T, c pb.SandboxExecClient, sandboxID string, e *pb.Exec) ([]byte, []byte, int32) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	call, err := c.Exec(ctx, &pb.ExecRequest{SandboxId: sandboxID, Exec: e})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	var stdout, stderr []byte
	for {
		ev, err := call.Recv()
		if err == io.EOF {
			return stdout, stderr, -1
		}
		if err != nil {
			t.Fatalf("recv: %v", err)
		}
		if ch := ev.GetChunk(); ch != nil {
			if ch.GetStream() == pb.Stream_STREAM_STDERR {
				stderr = append(stderr, ch.GetData()...)
			} else {
				stdout = append(stdout, ch.GetData()...)
			}
			continue
		}
		if end := ev.GetEnd(); end != nil {
			return stdout, stderr, end.GetExitCode()
		}
		if e := ev.GetError(); e != nil {
			t.Fatalf("ExecError: %s", e.GetMessage())
		}
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
