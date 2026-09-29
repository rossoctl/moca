package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	"github.com/rossoctl/moca/remote-worker/internal/relaytest"
	"github.com/rossoctl/moca/remote-worker/internal/session"
	"github.com/rossoctl/moca/remote-worker/internal/vmpool"
)

// This is build-step 6 without a cluster: the REAL session frame loop, the REAL
// Attach contract, the REAL vmpool — over the in-process fake relay, with
// vmpool.FakeLauncher standing in for a hypervisor. Phase D swaps the launcher and
// nothing above it changes, which is the property that makes E11's A/B an image
// swap.
func serveOverFakeRelay(t *testing.T, root string) (*relaytest.Conn, vmpool.Pool) {
	t.Helper()
	lc := vmpool.NewFakeLauncher()
	pool, err := vmpool.New(vmpool.Config{
		VMM:               lc.Kind(),
		SnapshotDir:       root,
		WorkspaceRoot:     root,
		MaxRuns:           8,
		MaxCommittedBytes: 8 << 30,
	}, lc, vmpool.RealClock())
	if err != nil {
		t.Fatalf("vmpool.New: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close() })

	relay := relaytest.Start(t)
	sess := session.New(session.Config{
		SandboxID: "sbx-microvm-1", Trust: "untrusted", MaxConcurrent: 2, Heartbeat: time.Second,
	}, vmpool.Runner{Pool: pool})

	conn, err := grpc.NewClient(relay.Addr, session.DialOptions(insecure.NewCredentials())...)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	ctx, cancel := context.WithCancel(metadata.AppendToOutgoingContext(context.Background(), "authorization", "Bearer dev-token"))
	t.Cleanup(cancel)
	stream, err := pb.NewSandboxWorkerClient(conn).Attach(ctx)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	go func() { _ = sess.Serve(ctx, stream) }()
	return relay.WaitAttach(t), pool
}

func TestAnExecOverTheAttachContractRunsInAVM(t *testing.T) {
	root := t.TempDir()
	c, pool := serveOverFakeRelay(t, root)
	c.SendExec(t, &pb.Exec{
		ReqId: 1, Command: "echo hi > note.txt; cat note.txt", TimeoutS: 30,
		Streaming: true, WorkspaceKey: "leaf-abc123",
	})
	stdout, _, terminal := c.Collect(t, 1)
	if string(stdout) != "hi\n" || terminal.GetEnd().GetExitCode() != 0 {
		t.Fatalf("stdout=%q terminal=%v", stdout, terminal)
	}
	// The write landed in the RUN's workspace, host-side — which is what makes the
	// promoted config bundle work for free (spec §5.5) and what §8's write-durability
	// gate checks against a real VMM.
	if b, err := os.ReadFile(filepath.Join(root, "leaf-abc123", "note.txt")); err != nil || string(b) != "hi\n" {
		t.Fatalf("workspace file: %q err=%v", b, err)
	}
	if s := pool.Stats(); s.InFlight != 0 {
		t.Fatalf("InFlight = %d after the exec settled, want 0", s.InFlight)
	}
}

func TestAnExecWithNoWorkspaceKeyIsRefusedOverTheWire(t *testing.T) {
	c, _ := serveOverFakeRelay(t, t.TempDir())
	c.SendExec(t, &pb.Exec{ReqId: 2, Command: "echo pwned", TimeoutS: 30, Streaming: true})
	_, _, terminal := c.Collect(t, 2)
	// Spec §8's gate: a counted ExecError, and nothing ran. Not an End{0} with empty
	// output, which would look like a command that succeeded silently.
	msg := terminal.GetError().GetMessage()
	if msg == "" {
		t.Fatalf("terminal = %v, want an ExecError", terminal)
	}
	if !strings.Contains(msg, string(vmpool.RefuseEmptyKey)) {
		t.Fatalf("ExecError message = %q, want it to name %q", msg, vmpool.RefuseEmptyKey)
	}
}

func TestTwoRunsDoNotSeeEachOthersFiles(t *testing.T) {
	root := t.TempDir()
	c, _ := serveOverFakeRelay(t, root)
	c.SendExec(t, &pb.Exec{ReqId: 3, Command: "echo secret-a > s.txt", TimeoutS: 30, Streaming: true, WorkspaceKey: "run-a"})
	if _, _, term := c.Collect(t, 3); term.GetEnd().GetExitCode() != 0 {
		t.Fatalf("run-a write: %v", term)
	}
	c.SendExec(t, &pb.Exec{ReqId: 4, Command: "cat s.txt 2>/dev/null || echo absent", TimeoutS: 30, Streaming: true, WorkspaceKey: "run-b"})
	stdout, _, _ := c.Collect(t, 4)
	// The property this slice exists for, at the structural level the fake can prove:
	// per-run workspaces. §8's cross-run-bleed gate proves it against a real
	// hypervisor, where the boundary is KVM rather than a directory.
	if string(stdout) != "absent\n" {
		t.Fatalf("run-b saw %q, want %q", stdout, "absent\n")
	}
}
