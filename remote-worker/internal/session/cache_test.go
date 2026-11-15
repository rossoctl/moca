package session_test

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"testing"

	"google.golang.org/protobuf/proto"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	"github.com/rossoctl/moca/remote-worker/internal/session"
)

// fp fingerprints a per-exec Exec from the four fields the cache keyed on before lease mode.
func fp(command string, stdin []byte, timeoutS uint32, streaming bool) [32]byte {
	return session.Fingerprint(&pb.Exec{Command: command, Stdin: stdin, TimeoutS: timeoutS, Streaming: streaming})
}

func endFrame(reqID uint64, code int32) *pb.WorkerFrame {
	return &pb.WorkerFrame{Msg: &pb.WorkerFrame_End{End: &pb.End{ReqId: reqID, ExitCode: code}}}
}

func TestCacheMissOnUnknownReqID(t *testing.T) {
	c := session.NewCache(4)
	_, hit, collision := c.Lookup(1, fp("cat f", nil, 10, false))
	if hit || collision {
		t.Fatalf("hit=%v collision=%v, want false/false for an unseen req_id", hit, collision)
	}
}

// A genuine redelivery is byte-identical, so it re-emits the cached frame.
func TestCacheHitOnMatchingFingerprint(t *testing.T) {
	c := session.NewCache(4)
	want := fp("cat f", []byte("payload"), 10, false)
	c.Put(7, want, endFrame(7, 0))

	frame, hit, collision := c.Lookup(7, want)
	if !hit || collision {
		t.Fatalf("hit=%v collision=%v, want true/false", hit, collision)
	}
	if frame.GetEnd().GetExitCode() != 0 || frame.GetEnd().GetReqId() != 7 {
		t.Errorf("cached frame = %+v, want End{7,0}", frame)
	}
}

// req_id is only probabilistically unique per worker: the harness salts its ids per
// process, so two replicas sharing a sandbox collide only when they draw the same
// 21-bit salt (≈4.8e-6 across five replicas, spec §3.1). Unlikely is not never, so a
// reused id with a different command must run fresh, never return the other
// command's output.
func TestCacheCollisionOnDifferentFingerprint(t *testing.T) {
	c := session.NewCache(4)
	c.Put(1, fp("rm -rf /b", nil, 10, false), endFrame(1, 0))

	frame, hit, collision := c.Lookup(1, fp("cat /a", nil, 10, false))
	if hit {
		t.Fatal("hit=true: a colliding req_id must not return the other command's result")
	}
	if !collision {
		t.Error("collision=false, want true so the session can warn")
	}
	if frame != nil {
		t.Errorf("frame = %+v, want nil on collision", frame)
	}
}

// Same stdin, different command — and the reverse — must not collide. Guards
// against a naive concatenation where ("a","b") and ("ab","") hash alike.
func TestFingerprintSeparatesCommandFromStdin(t *testing.T) {
	if fp("a", []byte("b"), 10, false) == fp("ab", nil, 10, false) {
		t.Error("fingerprint does not separate command from stdin")
	}
	if fp("cat f", []byte("x"), 10, false) == fp("cat f", []byte("y"), 10, false) {
		t.Error("fingerprint ignores stdin")
	}
	// A bare separator byte is not injective once the command itself can contain
	// that byte: with only a NUL between the fields, ("a\x00b", nil) and
	// ("a", "b\x00") hash alike. Length prefixes are what make the encoding
	// unambiguous for ANY input, not just the inputs bash would accept.
	if fp("a\x00b", nil, 10, false) == fp("a", []byte("b\x00"), 10, false) {
		t.Error("fingerprint collides on a NUL-bearing command: the encoding is not injective")
	}
}

// timeout_s is in scope: a redelivery of the same command with a larger budget
// must not be answered from a different budget's cache entry (see the contract-level
// TestContractReconnectDedupHonorsLargerTimeout for the behavioral consequence).
func TestFingerprintSeparatesTimeoutS(t *testing.T) {
	if fp("sleep 3", nil, 1, false) == fp("sleep 3", nil, 30, false) {
		t.Error("fingerprint ignores timeout_s")
	}
}

// streaming is in scope for the same reason: a redelivery with a different
// delivery mode is not the same exec and must not hit the other mode's entry.
func TestFingerprintSeparatesStreaming(t *testing.T) {
	if fp("echo hello", nil, 10, false) == fp("echo hello", nil, 10, true) {
		t.Error("fingerprint ignores streaming")
	}
}

// mode and mode_epoch are in scope too (review #4559538351): two Execs identical except for
// either are different Execs. Each is fixed-width, so a value cannot slide into its
// neighbour: mode 1 at epoch 0 is not mode 0 at epoch 1.
func TestFingerprintSeparatesModeAndEpoch(t *testing.T) {
	lease := pb.SandboxMode_SANDBOX_MODE_LEASE
	ref := &pb.Exec{Command: "true", TimeoutS: 10, Mode: lease, ModeEpoch: 3}
	for name, other := range map[string]*pb.Exec{
		"mode":       {Command: "true", TimeoutS: 10, Mode: pb.SandboxMode_SANDBOX_MODE_LEASE_PROCESSES, ModeEpoch: 3},
		"mode_epoch": {Command: "true", TimeoutS: 10, Mode: lease, ModeEpoch: 4},
	} {
		if session.Fingerprint(ref) == session.Fingerprint(other) {
			t.Errorf("fingerprint ignores %s", name)
		}
	}
	a := &pb.Exec{Command: "true", Mode: pb.SandboxMode_SANDBOX_MODE_PER_EXEC}
	b := &pb.Exec{Command: "true", ModeEpoch: 1}
	if session.Fingerprint(a) == session.Fingerprint(b) {
		t.Error("fingerprint aliases mode and mode_epoch: the encoding is not fixed-width")
	}
	if session.Fingerprint(ref) != session.Fingerprint(proto.Clone(ref).(*pb.Exec)) {
		t.Error("a genuine redelivery's fingerprint differs")
	}
}

// idle_timeout_s and keepalive are NOT in scope: neither changes what an Exec does, and both
// can differ between a genuine retry and its original when the token was re-minted in between
// (a lowered idle ceiling clamps the claim). Hashing them would rerun a non-idempotent command.
func TestFingerprintIgnoresIdleTimeoutAndKeepalive(t *testing.T) {
	lease := pb.SandboxMode_SANDBOX_MODE_LEASE
	ref := &pb.Exec{Command: "echo x >> log", TimeoutS: 10, Mode: lease, ModeEpoch: 3, IdleTimeoutS: 1800}
	for name, retry := range map[string]*pb.Exec{
		"idle_timeout_s": {Command: "echo x >> log", TimeoutS: 10, Mode: lease, ModeEpoch: 3, IdleTimeoutS: 600},
		"keepalive":      {Command: "echo x >> log", TimeoutS: 10, Mode: lease, ModeEpoch: 3, IdleTimeoutS: 1800, Keepalive: true},
	} {
		if session.Fingerprint(ref) != session.Fingerprint(retry) {
			t.Errorf("fingerprint depends on %s: a retry after a re-mint would rerun the command", name)
		}
	}
}

// workspace_key is in scope: one worker serves many sandboxes, so a req_id reused across two
// workspaces with an otherwise identical Exec must not be answered from the other sandbox's
// cache entry -- that would hand one sandbox another's result.
func TestFingerprintSeparatesWorkspaceKey(t *testing.T) {
	a := &pb.Exec{Command: "cat secret", TimeoutS: 10, WorkspaceKey: "sbx-a"}
	b := &pb.Exec{Command: "cat secret", TimeoutS: 10, WorkspaceKey: "sbx-b"}
	if session.Fingerprint(a) == session.Fingerprint(b) {
		t.Error("fingerprint ignores workspace_key")
	}
	// Bytes moved between stdin and the key give a different fingerprint. This pins the
	// prefixes of the fields BEFORE the key (stdin's), not the key's own: every field after the
	// key is fixed-width, so the encoding would stay injective without it, and no input can
	// tell. The key is length-prefixed anyway, so it stays injective when a variable-width
	// field is added after it.
	c := &pb.Exec{Command: "cat", Stdin: []byte("ab"), WorkspaceKey: "c"}
	d := &pb.Exec{Command: "cat", Stdin: []byte("a"), WorkspaceKey: "bc"}
	if session.Fingerprint(c) == session.Fingerprint(d) {
		t.Error("fingerprint aliases stdin and workspace_key: the encoding is not injective")
	}
}

// preKindFingerprint is the fingerprint as it was before plan 5 added the Exec kind, encoded
// by hand from the fields it covered: command, stdin and workspace_key length-prefixed,
// timeout_s, mode and mode_epoch as 8 bytes, streaming as one.
func preKindFingerprint(e *pb.Exec) [32]byte {
	h := sha256.New()
	u64 := func(v uint64) { h.Write(binary.BigEndian.AppendUint64(nil, v)) }
	u64(uint64(len(e.GetCommand())))
	h.Write([]byte(e.GetCommand()))
	u64(uint64(len(e.GetStdin())))
	h.Write(e.GetStdin())
	u64(uint64(e.GetTimeoutS()))
	if e.GetStreaming() {
		h.Write([]byte{1})
	} else {
		h.Write([]byte{0})
	}
	u64(uint64(len(e.GetWorkspaceKey())))
	h.Write([]byte(e.GetWorkspaceKey()))
	u64(uint64(uint32(e.GetMode())))
	u64(e.GetModeEpoch())
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// The kind and the process args are in scope (plan 5): a process_list and a process_stop on
// one req_id are different Execs, and so are two stops of different processes. A command
// Exec's fingerprint is byte-identical to the one before the kind existed, so a redelivery
// across a worker upgrade still matches its cached entry; the process args are hashed only
// for a process kind.
func TestFingerprintSeparatesKind(t *testing.T) {
	lp := pb.SandboxMode_SANDBOX_MODE_LEASE_PROCESSES
	cmd := &pb.Exec{
		Command: "echo hi", Stdin: []byte("in"), TimeoutS: 30, Streaming: true,
		WorkspaceKey: "leaf-a", Mode: lp, ModeEpoch: 7,
	}
	// Computed by the code before the kind existed (HEAD e186d433) for this Exec.
	const golden = "438197fad88fb2cbda0665281a967f9bbb9e9232b32d160dc52465213d251375"
	if got := session.Fingerprint(cmd); hex.EncodeToString(got[:]) != golden || got != preKindFingerprint(cmd) {
		t.Fatalf("command fingerprint = %x, want the pre-kind %s", got, golden)
	}
	withArgs := proto.Clone(cmd).(*pb.Exec)
	withArgs.Kind = pb.ExecKind_EXEC_KIND_COMMAND
	withArgs.Process = &pb.ProcessArgs{Name: "web", Tail: 5}
	if session.Fingerprint(withArgs) != session.Fingerprint(cmd) {
		t.Error("a command's fingerprint depends on process args it never uses")
	}

	proc := func(kind pb.ExecKind, args *pb.ProcessArgs) *pb.Exec {
		return &pb.Exec{TimeoutS: 30, WorkspaceKey: "leaf-a", Mode: lp, ModeEpoch: 7, Kind: kind, Process: args}
	}
	seen := map[[32]byte]string{session.Fingerprint(proc(pb.ExecKind_EXEC_KIND_COMMAND, nil)): "command"}
	for name, e := range map[string]*pb.Exec{
		"process_start":    proc(pb.ExecKind_EXEC_KIND_PROCESS_START, nil),
		"process_list":     proc(pb.ExecKind_EXEC_KIND_PROCESS_LIST, nil),
		"process_logs":     proc(pb.ExecKind_EXEC_KIND_PROCESS_LOGS, nil),
		"process_stop":     proc(pb.ExecKind_EXEC_KIND_PROCESS_STOP, nil),
		"unknown kind":     proc(pb.ExecKind(9), nil),
		"stop name":        proc(pb.ExecKind_EXEC_KIND_PROCESS_STOP, &pb.ProcessArgs{Name: "web"}),
		"stop id":          proc(pb.ExecKind_EXEC_KIND_PROCESS_STOP, &pb.ProcessArgs{Id: "web"}),
		"stop signal":      proc(pb.ExecKind_EXEC_KIND_PROCESS_STOP, &pb.ProcessArgs{Name: "web", Signal: "KILL"}),
		"start cwd":        proc(pb.ExecKind_EXEC_KIND_PROCESS_START, &pb.ProcessArgs{Cwd: "/workspace/app"}),
		"logs tail":        proc(pb.ExecKind_EXEC_KIND_PROCESS_LOGS, &pb.ProcessArgs{Tail: 50}),
		"name/cwd split a": proc(pb.ExecKind_EXEC_KIND_PROCESS_START, &pb.ProcessArgs{Name: "web/", Cwd: "a"}),
		"name/cwd split b": proc(pb.ExecKind_EXEC_KIND_PROCESS_START, &pb.ProcessArgs{Name: "web", Cwd: "/a"}),
	} {
		f := session.Fingerprint(e)
		if prev, dup := seen[f]; dup {
			t.Errorf("fingerprint of %s equals %s's", name, prev)
		}
		seen[f] = name
	}
	stop := proc(pb.ExecKind_EXEC_KIND_PROCESS_STOP, &pb.ProcessArgs{Name: "web", Signal: "TERM"})
	if session.Fingerprint(stop) != session.Fingerprint(proto.Clone(stop).(*pb.Exec)) {
		t.Error("a genuine redelivery's fingerprint differs")
	}
}

func TestCacheEvictsOldestBeyondMax(t *testing.T) {
	c := session.NewCache(3)
	for i := uint64(1); i <= 4; i++ {
		c.Put(i, fp(fmt.Sprintf("cmd%d", i), nil, 10, false), endFrame(i, 0))
	}
	if _, hit, _ := c.Lookup(1, fp("cmd1", nil, 10, false)); hit {
		t.Error("req_id 1 still cached: nothing was evicted at max=3")
	}
	for i := uint64(2); i <= 4; i++ {
		if _, hit, _ := c.Lookup(i, fp(fmt.Sprintf("cmd%d", i), nil, 10, false)); !hit {
			t.Errorf("req_id %d missing: wrong entry evicted", i)
		}
	}
}

// A hit refreshes recency, so the touched entry outlives an older neighbour.
func TestCacheLookupRefreshesRecency(t *testing.T) {
	c := session.NewCache(2)
	fp1, fp2, fp3 := fp("c1", nil, 10, false), fp("c2", nil, 10, false), fp("c3", nil, 10, false)
	c.Put(1, fp1, endFrame(1, 0))
	c.Put(2, fp2, endFrame(2, 0))
	if _, hit, _ := c.Lookup(1, fp1); !hit { // touch 1 so 2 becomes oldest
		t.Fatal("setup: req_id 1 should be cached")
	}
	c.Put(3, fp3, endFrame(3, 0))

	if _, hit, _ := c.Lookup(1, fp1); !hit {
		t.Error("req_id 1 evicted despite being touched most recently")
	}
	if _, hit, _ := c.Lookup(2, fp2); hit {
		t.Error("req_id 2 survived: it was the least recently used")
	}
}
