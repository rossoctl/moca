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
	return attachPool(t, pool), pool
}

// attachPool serves pool's Runner over a fresh in-process relay and returns the parked
// worker stream.
func attachPool(t *testing.T, pool vmpool.Pool) *relaytest.Conn {
	t.Helper()

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
	return relay.WaitAttach(t)
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

// leaseLauncher is a Firecracker-kind fake whose VMs serve any number of Execs, so a pool
// over it with a lease-v1 manifest is lease-capable (vmpool.LeaseSupported). Its VMs run
// nothing: each Exec answers "ran", and a lease start's normalise step succeeds.
type leaseLauncher struct{}

func (l *leaseLauncher) Kind() vmpool.VMMKind        { return vmpool.Firecracker }
func (l *leaseLauncher) SerializesExecsPerRun() bool { return true }
func (l *leaseLauncher) Restore(_ context.Context, req vmpool.RestoreRequest) (vmpool.VM, error) {
	return &leaseVM{key: req.Key}, nil
}

type leaseVM struct{ key string }

func (v *leaseVM) Key() string                  { return v.key }
func (v *leaseVM) Resume(context.Context) error { return nil }
func (v *leaseVM) Destroy() error               { return nil }
func (v *leaseVM) Run(_ context.Context, c vmpool.Command, out vmpool.Sink) (vmpool.Result, error) {
	if !c.NormaliseWorkspace {
		out.Stdout([]byte("ran\n"))
	}
	return vmpool.Result{}, nil
}

// The lease round-trip over the Attach contract: the real session, vmpool.Runner and pool,
// with only the hypervisor faked. A lease Exec starts a lease and carries its start event;
// LeaseControl status reads it active; set_mode per-exec ends it (mode_change); and the
// next lease Exec carries that end ahead of its terminal frame.
func TestALeaseRoundTripOverTheAttachContract(t *testing.T) {
	root := t.TempDir()
	pool, err := vmpool.New(vmpool.Config{
		VMM:               vmpool.Firecracker,
		SnapshotDir:       root,
		WorkspaceRoot:     root,
		MaxRuns:           8,
		MaxCommittedBytes: 32 << 30,
		ManifestFeatures:  []string{vmpool.FeatureLeaseV1},
		// No memory reclaim from this host's own MemAvailable mid-test.
		LeaseReclaimFreeBytes: 1,
	}, &leaseLauncher{}, vmpool.RealClock())
	if err != nil {
		t.Fatalf("vmpool.New: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close() })
	c := attachPool(t, pool)
	const key = "sess-lease"
	lease := func(reqID, epoch uint64) *pb.Exec {
		return &pb.Exec{ReqId: reqID, Command: "work", TimeoutS: 30, Streaming: true, WorkspaceKey: key,
			Mode: pb.SandboxMode_SANDBOX_MODE_LEASE, ModeEpoch: epoch}
	}
	control := func(ctlID uint64, op pb.LeaseOp, m pb.SandboxMode, epoch uint64) *pb.LeaseStatus {
		t.Helper()
		c.SendLeaseControl(t, &pb.LeaseControlFrame{CtlId: ctlID, WorkspaceKey: key, Op: op, Mode: m, ModeEpoch: epoch})
		r := c.LeaseResult(t, ctlID)
		if r.GetError() != "" {
			t.Fatalf("lease_control %d (%s): error %q", ctlID, op, r.GetError())
		}
		return r.GetStatus()
	}
	// leaseEvents splits an Exec's frames into its lease events and its terminal frame,
	// requiring every event to arrive before the terminal one (ExecFrames returns it last).
	leaseEvents := func(frames []*pb.WorkerFrame) (evs []*pb.LeaseEvent, terminal *pb.WorkerFrame) {
		for _, f := range frames[:len(frames)-1] {
			if ev := f.GetLease(); ev != nil {
				evs = append(evs, ev)
			}
		}
		return evs, frames[len(frames)-1]
	}

	// A key with no state reaches lease mode only through set_mode (spec §8.2).
	if st := control(1, pb.LeaseOp_LEASE_OP_SET_MODE, pb.SandboxMode_SANDBOX_MODE_LEASE, 1); !st.GetEpochKnown() {
		t.Fatalf("set_mode lease 1: status %v, want the epoch known", st)
	}

	c.SendExec(t, lease(10, 1))
	evs, term := leaseEvents(c.ExecFrames(t, 10))
	if term.GetEnd() == nil || term.GetEnd().GetExitCode() != 0 {
		t.Fatalf("lease Exec terminal = %v, want End{0}", term)
	}
	if len(evs) != 1 || evs[0].GetState() != "start" || evs[0].GetMode() != pb.SandboxMode_SANDBOX_MODE_LEASE {
		t.Fatalf("lease Exec events = %v, want one lease start", evs)
	}

	if st := control(2, pb.LeaseOp_LEASE_OP_STATUS, 0, 0); st.GetState() != "active" ||
		st.GetMode() != pb.SandboxMode_SANDBOX_MODE_LEASE || st.GetPending() != nil {
		t.Fatalf("status = %v, want an active lease with nothing pending", st)
	}

	st := control(3, pb.LeaseOp_LEASE_OP_SET_MODE, pb.SandboxMode_SANDBOX_MODE_PER_EXEC, 2)
	if st.GetState() != "none" || st.GetPending().GetReason() != "mode_change" {
		t.Fatalf("set_mode per-exec 2: status %v, want the lease ended mode_change", st)
	}
	at := st.GetPending().GetAtUnixMs()

	// A client still holding the epoch-1 lease token: refused stale_mode, with the end
	// event riding ahead of the error.
	c.SendExec(t, lease(11, 1))
	evs, term = leaseEvents(c.ExecFrames(t, 11))
	if msg := term.GetError().GetMessage(); !strings.HasPrefix(msg, "stale_mode: ") {
		t.Fatalf("stale Exec terminal = %v, want ExecError stale_mode", term)
	}
	if len(evs) != 1 || evs[0].GetState() != "end" || evs[0].GetReason() != "mode_change" ||
		evs[0].GetAtUnixMs() != at || evs[0].GetReqId() != 11 {
		t.Fatalf("stale Exec events = %v, want the end/mode_change at %d ms under req_id 11", evs, at)
	}
	if st := control(4, pb.LeaseOp_LEASE_OP_STATUS, 0, 0); st.GetPending() != nil {
		t.Fatalf("status after delivery = %v, want the event acknowledged", st)
	}
}
