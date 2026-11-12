package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

// fakeStream replays scripted events, then a final error (io.EOF when nil).
type fakeStream struct {
	grpc.ClientStream
	events []*pb.ExecEvent
	final  error
}

func (s *fakeStream) Recv() (*pb.ExecEvent, error) {
	if len(s.events) == 0 {
		if s.final != nil {
			return nil, s.final
		}
		return nil, io.EOF
	}
	ev := s.events[0]
	s.events = s.events[1:]
	return ev, nil
}

// fakeClient records the request and its metadata, and answers with a scripted stream.
type fakeClient struct {
	stream  *fakeStream
	execErr error
	req     *pb.ExecRequest
	md      metadata.MD
}

func (f *fakeClient) Exec(ctx context.Context, in *pb.ExecRequest, _ ...grpc.CallOption) (grpc.ServerStreamingClient[pb.ExecEvent], error) {
	f.req = in
	f.md, _ = metadata.FromOutgoingContext(ctx)
	if f.execErr != nil {
		return nil, f.execErr
	}
	return f.stream, nil
}

func (f *fakeClient) Abort(context.Context, *pb.AbortRequest, ...grpc.CallOption) (*pb.AbortResponse, error) {
	return &pb.AbortResponse{}, nil
}

func chunk(s pb.Stream, data string) *pb.ExecEvent {
	return &pb.ExecEvent{Event: &pb.ExecEvent_Chunk{Chunk: &pb.Chunk{Data: []byte(data), Stream: s}}}
}

func end(code int32, truncated bool) *pb.ExecEvent {
	return &pb.ExecEvent{Event: &pb.ExecEvent_End{End: &pb.End{ExitCode: code, Truncated: truncated}}}
}

func execErr(msg string) *pb.ExecEvent {
	return &pb.ExecEvent{Event: &pb.ExecEvent_Error{Error: &pb.ExecError{Message: msg}}}
}

var testCfg = config{addr: "x", sandboxID: "moca_microvm_0", key: "am4-k", token: "tok", timeoutS: 600}

func run(t *testing.T, c *fakeClient, cfg config) (int, string, string) {
	t.Helper()
	var out, errw bytes.Buffer
	clock := []time.Time{time.Unix(100, 0), time.Unix(100, 250_000_000)}
	now := func() time.Time { t := clock[0]; clock = clock[1:]; return t }
	code := callID(context.Background(), c, cfg, 7, "run", "true", nil, &out, &errw, now)
	return code, out.String(), errw.String()
}

func TestExitCodeAndStreams(t *testing.T) {
	c := &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{
		chunk(pb.Stream_STREAM_STDOUT, "out1 "), chunk(pb.Stream_STREAM_STDERR, "err1"), chunk(pb.Stream_STREAM_STDOUT, "out2"), end(3, false),
	}}}
	code, out, errw := run(t, c, testCfg)
	if code != 3 || out != "out1 out2" || errw != "err1" {
		t.Fatalf("got code=%d out=%q err=%q", code, out, errw)
	}
}

func TestSignalExitIs137(t *testing.T) {
	c := &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{end(-9, false)}}}
	if code, _, _ := run(t, c, testCfg); code != 137 {
		t.Fatalf("negative exit code: got %d, want 137", code)
	}
}

func TestTruncatedIsReported(t *testing.T) {
	c := &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{chunk(pb.Stream_STREAM_STDOUT, "x"), end(0, true)}}}
	code, _, errw := run(t, c, testCfg)
	if code != 0 || !strings.Contains(errw, "stdout exceeded 8 MiB and was cut") {
		t.Fatalf("got code=%d err=%q", code, errw)
	}
}

func TestFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		c    *fakeClient
		code int
		want string
	}{
		{"in-stream timeout", &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{execErr("timeout:600")}}}, 124, "sbx: command timed out"},
		{"in-stream error", &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{execErr("vm boot failed")}}}, 125, "sbx: exec failed: vm boot failed"},
		{"refused token", &fakeClient{execErr: status.Error(codes.PermissionDenied, "key outside prefix")}, 125, "exec failed: PERMISSION_DENIED: key outside prefix"},
		{"rpc error mid-stream", &fakeClient{stream: &fakeStream{final: status.Error(codes.Unavailable, "gone")}}, 125, "exec failed: UNAVAILABLE: gone"},
		{"no End event", &fakeClient{stream: &fakeStream{}}, 125, "without an End event"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, out, errw := run(t, tc.c, testCfg)
			if code != tc.code || out != "" || !strings.Contains(errw, tc.want) {
				t.Fatalf("got code=%d out=%q err=%q, want code=%d err containing %q", code, out, errw, tc.code, tc.want)
			}
		})
	}
}

func TestRequestShape(t *testing.T) {
	c := &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{end(0, false)}}}
	run(t, c, testCfg)
	e := c.req.GetExec()
	if c.req.GetSandboxId() != "moca_microvm_0" || e.GetWorkspaceKey() != "am4-k" || e.GetTimeoutS() != 600 ||
		!e.GetStreaming() || e.GetCommand() != "true" || e.GetReqId() != 7 {
		t.Fatalf("request: %v", c.req)
	}
	if got := c.md.Get("authorization"); len(got) != 1 || got[0] != "Bearer tok" {
		t.Fatalf("authorization metadata: %v", got)
	}
}

func TestReqIDBelow2to53(t *testing.T) {
	for i := 0; i < 1000; i++ {
		if id := reqID(); id >= 1<<53 {
			t.Fatalf("reqID %d is not below 2^53", id)
		}
	}
}

func TestLogLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "calls.jsonl")
	cfg := testCfg
	cfg.logPath = path
	c := &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{end(4, false)}}}
	run(t, c, cfg)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var rec struct {
		T    float64 `json:"t"`
		Op   string  `json:"op"`
		Ms   int64   `json:"ms"`
		Exit int     `json:"exit"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(b), &rec); err != nil {
		t.Fatalf("log line %q: %v", b, err)
	}
	if rec.Op != "run" || rec.Ms != 250 || rec.Exit != 4 || rec.T != 100.25 {
		t.Fatalf("log record: %+v", rec)
	}
}

func TestParse(t *testing.T) {
	for _, tc := range []struct {
		args    []string
		op, cmd string
		mode    int
		exit    int
		ok      bool
	}{
		{nil, "", "", noStdin, 2, false},
		{[]string{"-h"}, "", "", noStdin, 0, false},
		{[]string{"push"}, "", "", noStdin, 2, false},
		{[]string{"run"}, "run", "", stdinIsScript, 0, true},
		{[]string{"run", "ls", "-la"}, "run", "ls -la", noStdin, 0, true},
		{[]string{"put", "a b/it's.py"}, "put", `mkdir -p "$(dirname -- 'a b/it'\''s.py')" && cat > 'a b/it'\''s.py'`, stdinIsData, 0, true},
		{[]string{"put"}, "", "", noStdin, 2, false},
		{[]string{"pull"}, "pull", pull, noStdin, 0, true},
	} {
		op, cmd, mode, exit, ok := parse(tc.args)
		if op != tc.op || cmd != tc.cmd || mode != tc.mode || exit != tc.exit || ok != tc.ok {
			t.Errorf("parse(%q) = %q %q %d %d %v", tc.args, op, cmd, mode, exit, ok)
		}
	}
}

func TestConfig(t *testing.T) {
	env := map[string]string{"SBX_ADDR": "a", "SBX_SANDBOX_ID": "s", "SBX_WORKSPACE_KEY": "k", "SBX_TOKEN_FILE": "/t", "SBX_TIMEOUT": "1800"}
	read := func(string) ([]byte, error) { return []byte(" secret\n"), nil }
	cfg, err := configFrom(func(k string) string { return env[k] }, read)
	if err != nil || cfg.token != "secret" || cfg.timeoutS != 1800 {
		t.Fatalf("cfg=%+v err=%v", cfg, err)
	}
	delete(env, "SBX_WORKSPACE_KEY")
	if _, err := configFrom(func(k string) string { return env[k] }, read); err == nil || !strings.Contains(err.Error(), "SBX_WORKSPACE_KEY") {
		t.Fatalf("missing key: err=%v", err)
	}
	env["SBX_WORKSPACE_KEY"] = "k"
	delete(env, "SBX_TOKEN_FILE")
	if _, err := configFrom(func(k string) string { return env[k] }, read); err == nil {
		t.Fatal("no token: want an error")
	}
	env["SBX_TOKEN_FILE"] = "/missing"
	if _, err := configFrom(func(k string) string { return env[k] }, func(string) ([]byte, error) { return nil, errors.New("nope") }); err == nil {
		t.Fatal("unreadable token file: want an error")
	}
}
