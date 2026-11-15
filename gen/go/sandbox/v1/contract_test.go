package sandboxv1

import (
	"testing"

	"google.golang.org/protobuf/proto"
)

func TestHelloRoundTrip(t *testing.T) {
	h := &Hello{
		SandboxId:   "sbx-1",
		Labels:      map[string]string{"team": "alpha"},
		CapacityMax: 4,
		Trust:       "trusted",
	}
	b, err := proto.Marshal(h)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back Hello
	if err := proto.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.GetSandboxId() != "sbx-1" || back.GetCapacityMax() != 4 {
		t.Fatalf("round-trip mismatch: %+v", &back)
	}
	if back.GetLabels()["team"] != "alpha" {
		t.Fatalf("labels lost: %+v", back.GetLabels())
	}
}

func TestExecNegativeExitCode(t *testing.T) {
	b, err := proto.Marshal(&End{ReqId: 7, ExitCode: -9})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back End
	if err := proto.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.GetReqId() != 7 || back.GetExitCode() != -9 {
		t.Fatalf("got req_id=%d exit=%d", back.GetReqId(), back.GetExitCode())
	}
}

// roundTrip marshals m and unmarshals the bytes into back.
func roundTrip(t *testing.T, m, back proto.Message) {
	t.Helper()
	b, err := proto.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := proto.Unmarshal(b, back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !proto.Equal(m, back) {
		t.Fatalf("round-trip mismatch:\n sent %v\n  got %v", m, back)
	}
}

// The lease fields are additive (SBX0.3 plan 3): an Exec written by an encoder that
// predates them carries none of fields 7-10, and must decode as per-exec, epoch 0,
// the worker's default idle timeout and no keepalive.
func TestExecLeaseFieldsDefaultWhenAbsent(t *testing.T) {
	// The bytes the pre-change stubs (HEAD 3299cc98) write for
	// Exec{ReqId: 2, Command: "true", Streaming: true, WorkspaceKey: "leaf-1"}.
	b := []byte{
		0x08, 0x02, // req_id = 2
		0x12, 0x04, 't', 'r', 'u', 'e', // command = "true"
		0x28, 0x01, // streaming = true
		0x32, 0x06, 'l', 'e', 'a', 'f', '-', '1', // workspace_key = "leaf-1"
	}
	var back Exec
	if err := proto.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.GetMode() != SandboxMode_SANDBOX_MODE_UNSPECIFIED || back.GetModeEpoch() != 0 ||
		back.GetIdleTimeoutS() != 0 || back.GetKeepalive() {
		t.Fatalf("lease fields not zero on an old Exec: %+v", &back)
	}
	if back.GetReqId() != 2 || back.GetCommand() != "true" || !back.GetStreaming() || back.GetWorkspaceKey() != "leaf-1" {
		t.Fatalf("old fields lost: %+v", &back)
	}
}

func TestExecLeaseFieldsRoundTrip(t *testing.T) {
	roundTrip(t, &Exec{
		ReqId: 1, Command: "true", WorkspaceKey: "leaf-1",
		Mode: SandboxMode_SANDBOX_MODE_LEASE, ModeEpoch: 3, IdleTimeoutS: 600, Keepalive: true,
	}, &Exec{})
}

func TestSandboxModeValues(t *testing.T) {
	for want, m := range map[int32]SandboxMode{
		0: SandboxMode_SANDBOX_MODE_UNSPECIFIED,
		1: SandboxMode_SANDBOX_MODE_PER_EXEC,
		2: SandboxMode_SANDBOX_MODE_LEASE,
		3: SandboxMode_SANDBOX_MODE_LEASE_PROCESSES,
	} {
		if int32(m) != want {
			t.Fatalf("%v = %d, want %d", m, int32(m), want)
		}
	}
	for want, op := range map[int32]LeaseOp{
		0: LeaseOp_LEASE_OP_UNSPECIFIED,
		1: LeaseOp_LEASE_OP_STATUS,
		2: LeaseOp_LEASE_OP_RESET,
		3: LeaseOp_LEASE_OP_SET_MODE,
		4: LeaseOp_LEASE_OP_SANDBOX_DELETED,
	} {
		if int32(op) != want {
			t.Fatalf("%v = %d, want %d", op, int32(op), want)
		}
	}
}

// ends_by_unix_ms is field 8 (int64) on LeaseEvent: the hard end of an expiring lease.
// Pinned on the wire, so a renumbering cannot pass by renaming the Go field.
func TestLeaseEventEndsByUnixMsIsField8(t *testing.T) {
	// Only field 8 is set, so the encoding is exactly its tag (8<<3)|0 = 0x40 and the varint.
	b, err := proto.Marshal(&LeaseEvent{EndsByUnixMs: 1_731_400_600_000})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(b) == 0 || b[0] != 0x40 {
		t.Fatalf("ends_by_unix_ms not encoded as field 8 varint: % x", b)
	}
	var back LeaseEvent
	if err := proto.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.GetEndsByUnixMs() != 1_731_400_600_000 {
		t.Fatalf("round-trip mismatch: %+v", &back)
	}
}

func leaseEvent() *LeaseEvent {
	return &LeaseEvent{
		ReqId: 9, State: "end", Reason: "idle", AtUnixMs: 1_731_400_000_123,
		Mode: SandboxMode_SANDBOX_MODE_LEASE_PROCESSES, AgeMs: 42_000, Processes: []string{"p1", "p2"},
	}
}

func leaseStatus() *LeaseStatus {
	return &LeaseStatus{
		Mode: SandboxMode_SANDBOX_MODE_LEASE, EpochKnown: true, State: "active",
		AgeMs: 1500, IdleTimeoutS: 300, Pending: leaseEvent(),
	}
}

func TestLeaseMessagesRoundTrip(t *testing.T) {
	roundTrip(t, leaseEvent(), &LeaseEvent{})
	roundTrip(t, leaseStatus(), &LeaseStatus{})
	roundTrip(t, &LeaseControlFrame{
		CtlId: 5, WorkspaceKey: "leaf-1", Op: LeaseOp_LEASE_OP_SET_MODE,
		Mode: SandboxMode_SANDBOX_MODE_PER_EXEC, ModeEpoch: 4,
	}, &LeaseControlFrame{})
	roundTrip(t, &LeaseKeepaliveFrame{WorkspaceKey: "leaf-1"}, &LeaseKeepaliveFrame{})
	roundTrip(t, &LeaseControlResult{CtlId: 5, Status: leaseStatus(), Error: "stale_mode: epoch 3 < 4"},
		&LeaseControlResult{})
	roundTrip(t, &LeaseControlRequest{SandboxId: "sbx-1", Op: LeaseOp_LEASE_OP_RESET, SetModeToken: "tok"},
		&LeaseControlRequest{})
	roundTrip(t, &LeaseControlResponse{Status: leaseStatus()}, &LeaseControlResponse{})
	roundTrip(t, &LeaseKeepaliveRequest{SandboxId: "sbx-1"}, &LeaseKeepaliveRequest{})
	roundTrip(t, &LeaseKeepaliveResponse{}, &LeaseKeepaliveResponse{})
}

func TestLeaseOneofMembersRoundTrip(t *testing.T) {
	roundTrip(t, &ExecEvent{Event: &ExecEvent_Lease{Lease: leaseEvent()}}, &ExecEvent{})
	roundTrip(t, &WorkerFrame{Msg: &WorkerFrame_Lease{Lease: leaseEvent()}}, &WorkerFrame{})
	roundTrip(t, &WorkerFrame{Msg: &WorkerFrame_LeaseResult{LeaseResult: &LeaseControlResult{CtlId: 1}}},
		&WorkerFrame{})
	roundTrip(t, &ServerFrame{Msg: &ServerFrame_LeaseControl{LeaseControl: &LeaseControlFrame{CtlId: 1}}},
		&ServerFrame{})
	roundTrip(t, &ServerFrame{Msg: &ServerFrame_Keepalive{Keepalive: &LeaseKeepaliveFrame{WorkspaceKey: "k"}}},
		&ServerFrame{})
}

// Level-2 process kinds (SBX0.3 plan 5), additive. An Exec from a client that predates
// them carries no field 11 or 12 and must decode as a plain command.
func TestExecKindValues(t *testing.T) {
	for want, k := range map[int32]ExecKind{
		0: ExecKind_EXEC_KIND_COMMAND,
		1: ExecKind_EXEC_KIND_PROCESS_START,
		2: ExecKind_EXEC_KIND_PROCESS_LIST,
		3: ExecKind_EXEC_KIND_PROCESS_LOGS,
		4: ExecKind_EXEC_KIND_PROCESS_STOP,
	} {
		if int32(k) != want {
			t.Fatalf("%v = %d, want %d", k, int32(k), want)
		}
	}
}

// Exec.kind is field 11 (varint, tag 0x58) and Exec.process is field 12 (bytes, tag 0x62).
func TestExecKindAndProcessFieldNumbers(t *testing.T) {
	b, err := proto.Marshal(&Exec{Kind: ExecKind_EXEC_KIND_PROCESS_STOP})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(b) != 2 || b[0] != 0x58 || b[1] != 4 {
		t.Fatalf("kind not encoded as field 11 varint: % x", b)
	}
	b, err = proto.Marshal(&Exec{Process: &ProcessArgs{Name: "x"}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(b) == 0 || b[0] != 0x62 {
		t.Fatalf("process not encoded as field 12 bytes: % x", b)
	}
}

// An Exec from a client that predates the process kinds decodes as a command.
func TestExecKindDefaultsWhenAbsent(t *testing.T) {
	b := []byte{
		0x08, 0x02, // req_id = 2
		0x12, 0x04, 't', 'r', 'u', 'e', // command = "true"
	}
	var back Exec
	if err := proto.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.GetKind() != ExecKind_EXEC_KIND_COMMAND || back.GetProcess() != nil {
		t.Fatalf("old Exec not a plain command: %+v", &back)
	}
}

func TestProcessArgsAndTrackedProcessRoundTrip(t *testing.T) {
	roundTrip(t, &Exec{
		ReqId: 3, Command: "sleep 100", Kind: ExecKind_EXEC_KIND_PROCESS_START,
		Process: &ProcessArgs{Name: "srv", Id: "p1", Cwd: "/workspace", Tail: 200, Signal: "TERM"},
	}, &Exec{})
	roundTrip(t, &TrackedProcess{
		Id: "p1", Name: "srv", Pid: 4242, State: "killed", Code: 15,
		AgeMs: 9000, MemoryBytes: 1 << 20,
	}, &TrackedProcess{})
}

// tracked is LeaseEvent field 9 (repeated message, tag 0x4a); processes stays field 7.
func TestLeaseEventTrackedIsField9(t *testing.T) {
	b, err := proto.Marshal(&LeaseEvent{Tracked: []*TrackedProcess{{Id: "p1"}}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(b) == 0 || b[0] != 0x4a {
		t.Fatalf("tracked not encoded as field 9: % x", b)
	}
	roundTrip(t, &LeaseEvent{
		ReqId: 9, State: "processes_stopped", Reason: "mode_change",
		Processes: []string{"srv (pid 4242)"},
		Tracked:   []*TrackedProcess{{Id: "p1", Name: "srv", Pid: 4242, State: "running"}},
	}, &LeaseEvent{})
}

// LeaseStatus.processes is field 7 and LeaseStatus.stopped is field 8 (both repeated messages).
func TestLeaseStatusProcessFieldNumbers(t *testing.T) {
	b, err := proto.Marshal(&LeaseStatus{Processes: []*TrackedProcess{{Id: "p1"}}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(b) == 0 || b[0] != 0x3a {
		t.Fatalf("processes not encoded as field 7: % x", b)
	}
	b, err = proto.Marshal(&LeaseStatus{Stopped: []*TrackedProcess{{Id: "p1"}}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(b) == 0 || b[0] != 0x42 {
		t.Fatalf("stopped not encoded as field 8: % x", b)
	}
	roundTrip(t, &LeaseStatus{
		Mode: SandboxMode_SANDBOX_MODE_LEASE_PROCESSES, State: "active",
		Processes: []*TrackedProcess{{Id: "p1", Name: "srv", Pid: 7, State: "running", MemoryBytes: 5}},
		Stopped:   []*TrackedProcess{{Id: "p2", Name: "old", Pid: 8, State: "exited", Code: 0}},
	}, &LeaseStatus{})
}
