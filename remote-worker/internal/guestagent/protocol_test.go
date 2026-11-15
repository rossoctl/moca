package guestagent

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, KindStdout, []byte("hello")); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}
	if err := WriteFrame(&buf, KindEnd, nil); err != nil {
		t.Fatalf("WriteFrame(empty): %v", err)
	}
	k, p, err := ReadFrame(&buf)
	if err != nil || k != KindStdout || string(p) != "hello" {
		t.Fatalf("first frame: kind=%#x payload=%q err=%v", k, p, err)
	}
	k, p, err = ReadFrame(&buf)
	if err != nil || k != KindEnd || len(p) != 0 {
		t.Fatalf("second frame: kind=%#x payload=%q err=%v", k, p, err)
	}
	if _, _, err := ReadFrame(&buf); !errors.Is(err, io.EOF) {
		t.Fatalf("third read: err = %v, want io.EOF", err)
	}
}

func TestReadFrameRejectsAnOversizedLength(t *testing.T) {
	var buf bytes.Buffer
	buf.WriteByte(byte(KindStdout))
	_ = binary.Write(&buf, binary.BigEndian, uint32(MaxFrame+1))
	// A hostile or corrupt length prefix must not make either side allocate
	// arbitrarily — the guest is running attacker-influenced code by construction.
	if _, _, err := ReadFrame(&buf); err == nil || !strings.Contains(err.Error(), "frame too large") {
		t.Fatalf("err = %v, want a frame-too-large refusal", err)
	}
}

func TestReadFrameRejectsATruncatedPayload(t *testing.T) {
	var buf bytes.Buffer
	buf.WriteByte(byte(KindStdout))
	_ = binary.Write(&buf, binary.BigEndian, uint32(10))
	buf.WriteString("abc") // 3 of the promised 10
	// Spec §5.4: a SHORT response is an error, never coerced into a success.
	if _, _, err := ReadFrame(&buf); err == nil {
		t.Fatal("ReadFrame accepted a truncated payload")
	}
}

func TestWriteJSONRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteJSON(&buf, KindRequest, Request{
		Command: "cat f", TimeoutS: 30, CapBytes: 1 << 20, HasStdin: true, HostUnixNanos: 1757500000000000000,
	}); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	k, p, err := ReadFrame(&buf)
	if err != nil || k != KindRequest {
		t.Fatalf("kind=%#x err=%v", k, err)
	}
	var req Request
	if err := DecodeJSON(p, &req); err != nil {
		t.Fatalf("DecodeJSON: %v", err)
	}
	if req.Command != "cat f" || !req.HasStdin || req.HostUnixNanos == 0 {
		t.Fatalf("req = %+v", req)
	}
}

func TestRequestWithoutLeaseFieldsIsByteIdenticalToToday(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteJSON(&buf, KindRequest, Request{Command: "true", TimeoutS: 5, CapBytes: 1}); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	_, p, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	// omitempty keeps a non-lease request on the wire exactly as it was before the
	// lease fields existed, so an old guest and a new host stay compatible.
	for _, key := range []string{`"lease"`, `"normalise_workspace"`} {
		if strings.Contains(string(p), key) {
			t.Fatalf("request JSON %s carries %s", p, key)
		}
	}
}

func TestRequestLeaseFieldsRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteJSON(&buf, KindRequest, Request{Command: "true", Lease: true, NormaliseWorkspace: true}); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	_, p, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	var req Request
	if err := DecodeJSON(p, &req); err != nil {
		t.Fatalf("DecodeJSON: %v", err)
	}
	if !req.Lease || !req.NormaliseWorkspace {
		t.Fatalf("req = %+v, want both lease flags set", req)
	}
}

func TestEndTeardownFailedRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteJSON(&buf, KindEnd, End{ExitCode: 0, TeardownFailed: true}); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	_, p, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	var e End
	if err := DecodeJSON(p, &e); err != nil {
		t.Fatalf("DecodeJSON: %v", err)
	}
	if !e.TeardownFailed {
		t.Fatalf("end = %+v, want TeardownFailed", e)
	}
}

// PR #763 review (F2): the host keeps a lease when the guest reports its own timeout, so
// the message has one format, and nothing else the agent sends parses as it.
func TestTimeoutMessage(t *testing.T) {
	if got := TimeoutMessage(42); got != "timeout:42" {
		t.Fatalf("TimeoutMessage(42) = %q, want timeout:42", got)
	}
	if !IsTimeoutMessage(TimeoutMessage(7)) {
		t.Fatal("IsTimeoutMessage(TimeoutMessage(7)) = false")
	}
	for _, msg := range []string{"", "timeout:", "timeout:x", "timeout:-1", "timeout:5 ", "guest-agent: timeout:5",
		"guest-agent: the connection closed; the Exec was aborted"} {
		if IsTimeoutMessage(msg) {
			t.Errorf("IsTimeoutMessage(%q) = true, want false", msg)
		}
	}
}

// An old host sends no kind, process or max_processes. Its request must encode exactly
// as before those fields existed, and a request without a kind decodes as a command.
func TestProtocolRequestWithoutKindIsByteIdenticalToToday(t *testing.T) {
	b, err := json.Marshal(Request{Command: "true", TimeoutS: 5, CapBytes: 1, Lease: true})
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"command":"true","timeout_s":5,"streaming":false,"cap_bytes":1,"has_stdin":false,"host_unix_nanos":0,"lease":true}`
	if string(b) != want {
		t.Fatalf("request JSON\n got %s\nwant %s", b, want)
	}
	var req Request
	if err := DecodeJSON([]byte(want), &req); err != nil {
		t.Fatal(err)
	}
	if req.Kind != "" || req.Process != nil || req.MaxProcesses != 0 {
		t.Fatalf("req = %+v, want no kind, process or max", req)
	}
}

func TestProtocolProcessRequestRoundTrip(t *testing.T) {
	in := Request{
		Command: "npm run dev", Lease: true, Kind: RequestKindProcessStart, MaxProcesses: 4,
		Process: &ProcessArgs{Name: "web", ID: "3", Cwd: "/workspace/app", Tail: 50, Signal: "INT"},
	}
	var buf bytes.Buffer
	if err := WriteJSON(&buf, KindRequest, in); err != nil {
		t.Fatal(err)
	}
	_, p, err := ReadFrame(&buf)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"kind":"process_start"`, `"max_processes":4`, `"process":{`, `"name":"web"`, `"id":"3"`, `"cwd":"/workspace/app"`, `"tail":50`, `"signal":"INT"`} {
		if !strings.Contains(string(p), key) {
			t.Errorf("request JSON %s lacks %s", p, key)
		}
	}
	var out Request
	if err := DecodeJSON(p, &out); err != nil {
		t.Fatal(err)
	}
	if out.Kind != in.Kind || out.MaxProcesses != 4 || out.Process == nil || *out.Process != *in.Process {
		t.Fatalf("round trip = %+v (process %+v)", out, out.Process)
	}
}

func TestProtocolRequestKinds(t *testing.T) {
	got := []string{RequestKindCommand, RequestKindProcessStart, RequestKindProcessList, RequestKindProcessLogs, RequestKindProcessStop, RequestKindProcessStopAll}
	want := []string{"command", "process_start", "process_list", "process_logs", "process_stop", "process_stop_all"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("kinds = %v, want %v", got, want)
	}
	if TrackedRunning != "running" || TrackedExited != "exited" || TrackedKilled != "killed" {
		t.Fatalf("states = %q %q %q", TrackedRunning, TrackedExited, TrackedKilled)
	}
}

func TestProtocolEndTrackedRoundTrip(t *testing.T) {
	b, err := json.Marshal(End{ExitCode: 0})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "tracked") {
		t.Fatalf("an End with no table carries a tracked key: %s", b)
	}
	in := End{Tracked: []TrackedProcess{
		{ID: "1", Name: "web", PID: 42, State: TrackedRunning, StartedUnixMs: 1763000000000, MemoryBytes: 1 << 20},
		{ID: "2", PID: 43, State: TrackedKilled, Code: 9, StartedUnixMs: 1763000000001},
	}}
	if b, err = json.Marshal(in); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"tracked":[`, `"id":"1"`, `"name":"web"`, `"pid":42`, `"state":"running"`, `"code":9`, `"started_unix_ms":1763000000000`, `"memory_bytes":1048576`} {
		if !strings.Contains(string(b), key) {
			t.Errorf("End JSON %s lacks %s", b, key)
		}
	}
	var out End
	if err := DecodeJSON(b, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Tracked) != 2 || out.Tracked[0] != in.Tracked[0] || out.Tracked[1] != in.Tracked[1] {
		t.Fatalf("round trip = %+v", out.Tracked)
	}
}
