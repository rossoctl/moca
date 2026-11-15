package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
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

func (f *fakeClient) LeaseControl(context.Context, *pb.LeaseControlRequest, ...grpc.CallOption) (*pb.LeaseControlResponse, error) {
	return &pb.LeaseControlResponse{}, nil
}

func (f *fakeClient) LeaseKeepalive(context.Context, *pb.LeaseKeepaliveRequest, ...grpc.CallOption) (*pb.LeaseKeepaliveResponse, error) {
	return &pb.LeaseKeepaliveResponse{}, nil
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

var testCfg = config{addr: "x", sandboxID: "moca_microvm_0", key: "ws-k", token: "tok", timeoutS: 600}

// callID is call with the process's sleep, jitter and req_ids and the given clock; under testCfg (busyRetry 0) it never retries.
func callID(ctx context.Context, c pb.SandboxExecClient, cfg config, id uint64, op, command string, stdin []byte, stdout, stderr io.Writer, now func() time.Time) int {
	var cur atomic.Uint64
	return call(ctx, c, cfg, id, op, command, stdin, stdout, stderr, callEnv{now: now, sleep: sleepCtx, newID: reqID, jitter: jitterOf, cur: &cur})
}

func run(t *testing.T, c *fakeClient, cfg config) (int, string, string) {
	t.Helper()
	var out, errw bytes.Buffer
	clock := []time.Time{time.Unix(100, 0), time.Unix(100, 250_000_000)}
	now := func() time.Time {
		t := clock[0]
		if len(clock) > 1 { // the last reading repeats: a lease notice reads the clock too
			clock = clock[1:]
		}
		return t
	}
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

func TestSignalExitIs128PlusN(t *testing.T) {
	for _, tc := range []struct {
		exit int32
		want int
	}{{-9, 137}, {-15, 143}, {-2, 130}} {
		c := &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{end(tc.exit, false)}}}
		if code, _, _ := run(t, c, testCfg); code != tc.want {
			t.Fatalf("exit code %d: got %d, want %d (128 + n, as sbx.py)", tc.exit, code, tc.want)
		}
	}
}

func TestTimeoutKeepsPartialOutput(t *testing.T) {
	c := &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{chunk(pb.Stream_STREAM_STDOUT, "partial"), execErr("timeout:600")}}}
	code, out, errw := run(t, c, testCfg)
	if code != 124 || out != "partial" || !strings.Contains(errw, "sbx: command timed out after 600 s") {
		t.Fatalf("got code=%d out=%q err=%q", code, out, errw)
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
		{"a machinery error that mentions a timeout is not one", &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{execErr("vm boot failed: vsock dial timeout: 30s")}}}, 125, "sbx: exec failed: vm boot failed: vsock dial timeout: 30s"},
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
	if c.req.GetSandboxId() != "moca_microvm_0" || e.GetWorkspaceKey() != "ws-k" || e.GetTimeoutS() != 600 ||
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

// scriptedClient answers each Exec with the next script (an Exec-call error, or a stream), and records every req_id.
type scriptedClient struct {
	scripts  []*fakeClient
	ids      []uint64
	timeouts []uint32
}

func (s *scriptedClient) Exec(ctx context.Context, in *pb.ExecRequest, o ...grpc.CallOption) (grpc.ServerStreamingClient[pb.ExecEvent], error) {
	s.ids = append(s.ids, in.GetExec().GetReqId())
	s.timeouts = append(s.timeouts, in.GetExec().GetTimeoutS())
	next := s.scripts[0]
	if len(s.scripts) > 1 {
		s.scripts = s.scripts[1:]
	}
	if next.execErr != nil {
		return nil, next.execErr
	}
	// a fresh copy, so a script reused for every attempt replays its events each time
	return &fakeStream{events: append([]*pb.ExecEvent(nil), next.stream.events...), final: next.stream.final}, nil
}

func (s *scriptedClient) Abort(context.Context, *pb.AbortRequest, ...grpc.CallOption) (*pb.AbortResponse, error) {
	return &pb.AbortResponse{}, nil
}

func (s *scriptedClient) LeaseControl(context.Context, *pb.LeaseControlRequest, ...grpc.CallOption) (*pb.LeaseControlResponse, error) {
	return &pb.LeaseControlResponse{}, nil
}

func (s *scriptedClient) LeaseKeepalive(context.Context, *pb.LeaseKeepaliveRequest, ...grpc.CallOption) (*pb.LeaseKeepaliveResponse, error) {
	return &pb.LeaseKeepaliveResponse{}, nil
}

const budgetRefusal = "memory-budget: promoting a standby would re-price it from 33554432 to 4328521728 committed bytes"

// retryRun runs one call with a fake clock that the fake sleep advances, so retries take no real time.
func retryRun(t *testing.T, c pb.SandboxExecClient, cfg config, sleep func(context.Context, time.Duration) error) (int, string, []time.Duration) {
	t.Helper()
	clock := time.Unix(100, 0)
	var slept []time.Duration
	if sleep == nil {
		sleep = func(_ context.Context, d time.Duration) error {
			slept = append(slept, d)
			clock = clock.Add(d)
			return nil
		}
	}
	next := uint64(100)
	var cur atomic.Uint64
	env := callEnv{
		now:    func() time.Time { return clock },
		sleep:  sleep,
		newID:  func() uint64 { next++; return next },
		jitter: func(d time.Duration) time.Duration { return d },
		cur:    &cur,
	}
	var out, errw bytes.Buffer
	code := call(context.Background(), c, cfg, 7, "run", "true", nil, &out, &errw, env)
	return code, errw.String(), slept
}

func busyCfg(t *testing.T) config {
	cfg := testCfg
	cfg.busyRetry = defaultBusyRetry
	cfg.logPath = filepath.Join(t.TempDir(), "calls.jsonl")
	return cfg
}

func logRecords(t *testing.T, path string) []map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var recs []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(b), []byte("\n")) {
		var m map[string]any
		if err := json.Unmarshal(line, &m); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		recs = append(recs, m)
	}
	return recs
}

func TestRefusalClasses(t *testing.T) {
	for _, tc := range []struct {
		code  codes.Code
		msg   string
		class string
	}{
		{codes.OK, budgetRefusal, "memory_budget"},
		{codes.Unknown, "max-runs: 64 runs live", "max_runs"},
		{codes.OK, "busy: queue full", "queue_full"},
		{codes.ResourceExhausted, "sandbox busy: 2 Execs already in flight", "relay_busy"},
		{codes.ResourceExhausted, "grpc: received message larger than max", ""},
		{codes.Unknown, "sandbox busy: 2 Execs already in flight", ""},
		{codes.OK, "vm boot failed", ""},
		{codes.PermissionDenied, "key outside prefix", ""},
	} {
		if got := refusalClass(tc.code, tc.msg); got != tc.class {
			t.Errorf("refusalClass(%v, %q) = %q, want %q", tc.code, tc.msg, got, tc.class)
		}
	}
}

func TestRefusedThenOKRetriesWithANewReqID(t *testing.T) {
	c := &scriptedClient{scripts: []*fakeClient{
		{stream: &fakeStream{events: []*pb.ExecEvent{execErr(budgetRefusal)}}},
		{execErr: status.Error(codes.ResourceExhausted, "sandbox busy: 2 Execs already in flight")},
		{stream: &fakeStream{events: []*pb.ExecEvent{chunk(pb.Stream_STREAM_STDOUT, "ok"), end(0, false)}}},
	}}
	cfg := busyCfg(t)
	code, errw, slept := retryRun(t, c, cfg, nil)
	if code != 0 || len(c.ids) != 3 {
		t.Fatalf("code=%d attempts=%d err=%q", code, len(c.ids), errw)
	}
	if c.ids[0] != 7 || c.ids[1] == c.ids[0] || c.ids[2] == c.ids[1] {
		t.Fatalf("every retry must be a new req_id: %v", c.ids)
	}
	if len(slept) != 2 || slept[0] != time.Second || slept[1] != 2*time.Second {
		t.Fatalf("backoff: %v", slept)
	}
	if !strings.Contains(errw, "memory_budget: nothing ran; retrying") || !strings.Contains(errw, "relay_busy: nothing ran; retrying") {
		t.Fatalf("stderr: %q", errw)
	}
	recs := logRecords(t, cfg.logPath)
	if len(recs) != 3 || recs[0]["refused"] != "memory_budget" || recs[1]["refused"] != "relay_busy" {
		t.Fatalf("records: %v", recs)
	}
	if _, ok := recs[0]["busy_wait_ms"]; ok {
		t.Fatalf("a refused attempt's record carries no busy_wait_ms: %v", recs[0])
	}
	if !strings.HasPrefix(recs[0]["reason"].(string), "memory-budget: promoting") || recs[0]["exit"] != float64(75) {
		t.Fatalf("refused record: %v", recs[0])
	}
	last := recs[2]
	if last["exit"] != float64(0) || last["busy_wait_ms"] != float64(3000) || last["attempt"] != float64(3) || last["ms"] != float64(3000) {
		t.Fatalf("final record: %v", last)
	}
}

func TestRefusalsExhaustTheBudgetAndExit75(t *testing.T) {
	c := &scriptedClient{scripts: []*fakeClient{{stream: &fakeStream{events: []*pb.ExecEvent{execErr(budgetRefusal)}}}}}
	cfg := busyCfg(t)
	code, errw, slept := retryRun(t, c, cfg, nil)
	var total time.Duration
	for _, d := range slept {
		total += d
	}
	// 1 + 2 + 4 + 8 + 8 + 7 (cut to what is left of 30 s)
	if code != 75 || total != 30*time.Second || len(c.ids) != len(slept)+1 {
		t.Fatalf("code=%d slept=%v attempts=%d", code, slept, len(c.ids))
	}
	if !strings.Contains(errw, "sbx: memory_budget: nothing ran; gave up after 7 attempts / 30s") {
		t.Fatalf("stderr: %q", errw)
	}
	recs := logRecords(t, cfg.logPath)
	last := recs[len(recs)-1]
	if last["exit"] != float64(75) || last["busy_wait_ms"] != float64(30000) || last["refused"] != "memory_budget" {
		t.Fatalf("final record: %v", last)
	}
}

func TestNoRetryForFailuresThatMayHaveRun(t *testing.T) {
	for _, tc := range []struct {
		name string
		c    *fakeClient
	}{
		{"a refusal after a chunk", &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{chunk(pb.Stream_STREAM_STDOUT, "x"), execErr(budgetRefusal)}}}},
		{"a relay busy status after a chunk", &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{chunk(pb.Stream_STREAM_STDOUT, "x")}, final: status.Error(codes.ResourceExhausted, "sandbox busy: 2")}}},
		{"machinery", &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{execErr("vm boot failed")}}}},
		{"RESOURCE_EXHAUSTED that is not sandbox busy", &fakeClient{execErr: status.Error(codes.ResourceExhausted, "grpc: received message larger than max")}},
		{"a refused token", &fakeClient{execErr: status.Error(codes.PermissionDenied, "key outside prefix")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &scriptedClient{scripts: []*fakeClient{tc.c}}
			code, _, slept := retryRun(t, c, busyCfg(t), nil)
			if code != 125 || len(c.ids) != 1 || len(slept) != 0 {
				t.Fatalf("code=%d attempts=%d slept=%v", code, len(c.ids), slept)
			}
		})
	}
}

func TestBusyRetryZeroIsTheOldBehaviourExit125NoRetry(t *testing.T) {
	c := &scriptedClient{scripts: []*fakeClient{{stream: &fakeStream{events: []*pb.ExecEvent{execErr(budgetRefusal)}}}}}
	cfg := busyCfg(t)
	cfg.busyRetry = 0
	code, errw, slept := retryRun(t, c, cfg, nil)
	if code != 125 || len(c.ids) != 1 || len(slept) != 0 || !strings.Contains(errw, "exec failed: memory-budget:") {
		t.Fatalf("code=%d attempts=%d slept=%v err=%q", code, len(c.ids), slept, errw)
	}
}

func TestCancelledDuringBackoffExits130(t *testing.T) {
	c := &scriptedClient{scripts: []*fakeClient{{stream: &fakeStream{events: []*pb.ExecEvent{execErr("busy: queue full")}}}}}
	cfg := busyCfg(t)
	code, errw, _ := retryRun(t, c, cfg, func(context.Context, time.Duration) error { return context.Canceled })
	if code != 130 || len(c.ids) != 1 || !strings.Contains(errw, "interrupted while waiting to retry") {
		t.Fatalf("code=%d attempts=%d err=%q", code, len(c.ids), errw)
	}
	recs := logRecords(t, cfg.logPath)
	if last := recs[len(recs)-1]; last["exit"] != float64(130) || last["busy_wait_ms"] != float64(0) {
		t.Fatalf("final record: %v", last)
	}
}

func TestSleepCtxReturnsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := sleepCtx(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("sleepCtx on a cancelled context: %v", err)
	}
}

func TestBusyRetryFromEnv(t *testing.T) {
	base := map[string]string{"SBX_ADDR": "a", "SBX_SANDBOX_ID": "s", "SBX_WORKSPACE_KEY": "k", "SBX_TOKEN": "t"}
	get := func(extra map[string]string) func(string) string {
		return func(k string) string {
			if v, ok := extra[k]; ok {
				return v
			}
			return base[k]
		}
	}
	read := func(string) ([]byte, error) { return nil, errors.New("unused") }
	if c, err := configFrom(get(nil), read); err != nil || c.busyRetry != 30*time.Second {
		t.Fatalf("default: %v %v", c.busyRetry, err)
	}
	if c, err := configFrom(get(map[string]string{"SBX_BUSY_RETRY_S": "0"}), read); err != nil || c.busyRetry != 0 {
		t.Fatalf("0: %v %v", c.busyRetry, err)
	}
	if c, err := configFrom(get(map[string]string{"SBX_BUSY_RETRY_S": "90"}), read); err != nil || c.busyRetry != 90*time.Second {
		t.Fatalf("90: %v %v", c.busyRetry, err)
	}
	for _, bad := range []string{"-1", "x", "1.5", "3601"} {
		if _, err := configFrom(get(map[string]string{"SBX_BUSY_RETRY_S": bad}), read); err == nil || !strings.Contains(err.Error(), "SBX_BUSY_RETRY_S") {
			t.Fatalf("%q: want a refusal, got %v", bad, err)
		}
	}
}

func TestSanitizeReason(t *testing.T) {
	if got := sanitizeReason("a\nb\x1bc"); got != "a b c" {
		t.Fatalf("%q", got)
	}
	if got := []rune(sanitizeReason(strings.Repeat("x", 400))); len(got) != 301 {
		t.Fatalf("cut to 300 plus an ellipsis: %d", len(got))
	}
}

func TestTimeoutFromEnv(t *testing.T) {
	env := map[string]string{"SBX_ADDR": "a", "SBX_SANDBOX_ID": "s", "SBX_WORKSPACE_KEY": "k", "SBX_TOKEN": "t"}
	getenv := func(k string) string { return env[k] }
	for _, good := range []struct {
		s    string
		want uint32
	}{{"", 600}, {"1", 1}, {"1800", 1800}, {"4294967295", 1<<32 - 1}} {
		env["SBX_TIMEOUT"] = good.s
		cfg, err := configFrom(getenv, os.ReadFile)
		if err != nil || cfg.timeoutS != good.want {
			t.Errorf("SBX_TIMEOUT=%q: timeoutS=%d err=%v, want %d", good.s, cfg.timeoutS, err, good.want)
		}
	}
	// Each of these once parsed as a number: "1e3" as 1, "10s" as 10, " 5" as 5.
	for _, bad := range []string{"0", "-1", "+5", "1e3", "10s", "1.5", " 5", "5 ", "abc", "4294967296"} {
		env["SBX_TIMEOUT"] = bad
		if _, err := configFrom(getenv, os.ReadFile); err == nil || !strings.Contains(err.Error(), "SBX_TIMEOUT") {
			t.Errorf("SBX_TIMEOUT=%q: err=%v, want a refusal naming SBX_TIMEOUT", bad, err)
		}
	}
}

// jwt builds an unsigned token whose payload holds claims; the client reads it without verifying.
func jwt(claims string) string {
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"none"}`)) + "." + enc([]byte(claims)) + ".sig"
}

// The test clock starts at t=100 (run), so a token with exp 400 has 300 s left: 240 s after the 60 s margin.
func TestTimeoutCappedAtTheTokensLifetime(t *testing.T) {
	for _, tc := range []struct {
		name   string
		token  string
		want   uint32
		capped bool
	}{
		{"300 s left", jwt(`{"iat":100,"exp":400}`), 240, true},
		{"300 s left, no iat", jwt(`{"exp":400}`), 240, true},
		{"a 300 s lifetime, more left by a skewed clock", jwt(`{"iat":1000,"exp":1300}`), 240, true},
		{"60 s or less left", jwt(`{"iat":40,"exp":160}`), 1, true},
		{"already expired", jwt(`{"exp":50}`), 1, true},
		{"room to spare", jwt(`{"iat":100,"exp":1000}`), 600, false},
		{"exactly enough", jwt(`{"exp":760}`), 600, false},
		{"not a JWT", "tok", 600, false},
		{"no exp", jwt(`{"iat":100}`), 600, false},
		{"a payload that is not JSON", "a.bm90IGpzb24.c", 600, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := testCfg
			cfg.token = tc.token
			c := &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{end(0, false)}}}
			code, _, errw := run(t, c, cfg)
			if got := c.req.GetExec().GetTimeoutS(); code != 0 || got != tc.want {
				t.Fatalf("timeout_s sent = %d (exit %d), want %d", got, code, tc.want)
			}
			line := fmt.Sprintf("sbx: timeout capped at %d s, the sandbox token's lifetime minus 60 s\n", tc.want)
			if tc.capped != (errw == line) || (!tc.capped && errw != "") {
				t.Fatalf("stderr %q, capped=%v", errw, tc.capped)
			}
			if strings.Contains(errw, tc.token) {
				t.Fatal("stderr holds the token")
			}
		})
	}
}

func TestCappedTimeoutIsTheOneReported(t *testing.T) {
	cfg := testCfg
	cfg.token = jwt(`{"exp":400}`)
	c := &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{chunk(pb.Stream_STREAM_STDERR, "e\n"), execErr("timeout:240")}}}
	code, _, errw := run(t, c, cfg)
	want := "e\nsbx: timeout capped at 240 s, the sandbox token's lifetime minus 60 s\nsbx: command timed out after 240 s\n"
	if code != 124 || errw != want {
		t.Fatalf("got code=%d err=%q, want %q", code, errw, want)
	}
}

func TestTokenExpiredDuringExec(t *testing.T) {
	for _, tc := range []struct{ msg, want string }{
		{"sandbox token expired during the Exec", "sbx: sandbox token expired during the Exec: the command outlived its token and was cancelled; give it a shorter timeout\n"},
		{"", "sbx: sandbox token expired during the Exec: the command outlived its token and was cancelled; give it a shorter timeout\n"},
		{"worker deadline", "sbx: exec failed: DEADLINE_EXCEEDED: worker deadline\n"},
	} {
		c := &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{chunk(pb.Stream_STREAM_STDOUT, "x")}, final: status.Error(codes.DeadlineExceeded, tc.msg)}}
		if code, out, errw := run(t, c, testCfg); code != 125 || out != "" || errw != tc.want {
			t.Errorf("message %q: got code=%d out=%q err=%q, want %q", tc.msg, code, out, errw, tc.want)
		}
	}
}

// A retry starts later, with less of the token left, so each attempt caps its own timeout: exp 400 leaves 240 s at
// t=100 and, after the first retry's 1 s backoff, 239 s at t=101.
func TestEachAttemptCapsItsTimeout(t *testing.T) {
	c := &scriptedClient{scripts: []*fakeClient{
		{stream: &fakeStream{events: []*pb.ExecEvent{execErr(budgetRefusal)}}},
		{stream: &fakeStream{events: []*pb.ExecEvent{end(0, false)}}},
	}}
	cfg := busyCfg(t)
	cfg.token = jwt(`{"iat":100,"exp":400}`)
	code, errw, _ := retryRun(t, c, cfg, nil)
	if code != 0 || len(c.timeouts) != 2 || c.timeouts[0] != 240 || c.timeouts[1] != 239 {
		t.Fatalf("code=%d timeouts sent=%v", code, c.timeouts)
	}
	if !strings.HasSuffix(errw, "sbx: timeout capped at 239 s, the sandbox token's lifetime minus 60 s\n") {
		t.Fatalf("stderr %q", errw)
	}
}

// leaseEv wraps a LeaseEvent as an Exec stream event.
func leaseEv(ev *pb.LeaseEvent) *pb.ExecEvent {
	return &pb.ExecEvent{Event: &pb.ExecEvent_Lease{Lease: ev}}
}

// pinUTC makes HH:MM in the notices local time in UTC for the test, as TZ=UTC does for the TS tests.
func pinUTC(t *testing.T) {
	t.Helper()
	prev := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = prev })
}

// The lease copy's fixed instant: 2026-11-13 14:02:30 UTC, as the TS tests' AT.
var noticeAt = time.Date(2026, 11, 13, 14, 2, 30, 0, time.UTC)

func TestRunPrintsLeaseEndNotice(t *testing.T) {
	pinUTC(t)
	c := &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{
		leaseEv(&pb.LeaseEvent{State: "end", Reason: "idle", AtUnixMs: noticeAt.UnixMilli()}),
		chunk(pb.Stream_STREAM_STDOUT, "ok"), end(0, false),
	}}}
	code, out, errw := run(t, c, testCfg)
	want := "[sandbox] guest restarted (idle, 14:02): /tmp, installs outside /workspace and background processes are gone\n"
	if code != 0 || out != "ok" || errw != want {
		t.Fatalf("got code=%d out=%q err=%q, want err %q", code, out, errw, want)
	}
}

func TestLeaseNoticeIsPrintedOncePerRun(t *testing.T) {
	pinUTC(t)
	end := leaseEv(&pb.LeaseEvent{State: "end", Reason: "idle", AtUnixMs: noticeAt.UnixMilli()})
	// The first attempt is refused after the end notice; the retry repeats the same event, as lease events may.
	c := &scriptedClient{scripts: []*fakeClient{
		{stream: &fakeStream{events: []*pb.ExecEvent{end, execErr(budgetRefusal)}}},
		{stream: &fakeStream{events: []*pb.ExecEvent{end, chunk(pb.Stream_STREAM_STDOUT, "ok"), end0()}}},
	}}
	code, errw, _ := retryRun(t, c, busyCfg(t), nil)
	want := "[sandbox] guest restarted (idle, 14:02): /tmp, installs outside /workspace and background processes are gone\n"
	// the first attempt's notice comes before the retry's line, and the retry's repeat of it is not printed again
	if code != 0 || len(c.ids) != 2 || errw != want+"sbx: memory_budget: nothing ran; retrying in 1.0s (attempt 2)\n" {
		t.Fatalf("code=%d attempts=%d err=%q", code, len(c.ids), errw)
	}
}

func end0() *pb.ExecEvent { return end(0, false) }

func TestRunStaleModeExits125(t *testing.T) {
	for _, tc := range []struct {
		name string
		c    *fakeClient
		want string
	}{
		{"in-stream", &fakeClient{stream: &fakeStream{events: []*pb.ExecEvent{execErr("stale_mode: token mode is lease, sandbox is per-exec")}}},
			"sbx: exec failed: stale_mode: token mode is lease, sandbox is per-exec\n"},
		{"as a status", &fakeClient{execErr: status.Error(codes.FailedPrecondition, "lease_unsupported: this worker has no lease mode")},
			"sbx: exec failed: FAILED_PRECONDITION: lease_unsupported: this worker has no lease mode\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &scriptedClient{scripts: []*fakeClient{tc.c}}
			code, errw, slept := retryRun(t, c, busyCfg(t), nil)
			// a lease refusal is before the command starts, but it is not a capacity refusal: never retried
			if code != 125 || errw != tc.want || len(c.ids) != 1 || len(slept) != 0 {
				t.Fatalf("code=%d attempts=%d slept=%v err=%q, want 125 and %q", code, len(c.ids), slept, errw, tc.want)
			}
		})
	}
}

func TestNoticeCopyMatchesTS(t *testing.T) {
	pinUTC(t)
	// the cases of packages/sandbox-client/test/lease.test.ts (leaseNotice), with its AT as noticeAt
	at := noticeAt.UnixMilli()
	expiring := func(endsBy int64) *pb.LeaseEvent {
		return &pb.LeaseEvent{State: "expiring", Reason: "max_duration", AtUnixMs: at, EndsByUnixMs: endsBy}
	}
	for _, tc := range []struct {
		name string
		ev   *pb.LeaseEvent
		now  int64
		want string
	}{
		{"end at local HH:MM", &pb.LeaseEvent{State: "end", Reason: "idle", AtUnixMs: at}, at,
			"[sandbox] guest restarted (idle, 14:02): /tmp, installs outside /workspace and background processes are gone"},
		{"end with one process", &pb.LeaseEvent{State: "end", Reason: "memory_reclaim", AtUnixMs: at, Processes: []string{"devserver (pid 412)"}}, at,
			"[sandbox] guest restarted (memory_reclaim, 14:02): /tmp, installs outside /workspace and background processes are gone; stopped: devserver (pid 412)"},
		{"end with two processes", &pb.LeaseEvent{State: "end", Reason: "reset", AtUnixMs: at, Processes: []string{"a (pid 1)", "b (pid 2)"}}, at,
			"[sandbox] guest restarted (reset, 14:02): /tmp, installs outside /workspace and background processes are gone; stopped: a (pid 1); stopped: b (pid 2)"},
		{"expiring 29.5 min rounds up to 30", expiring(at + 29*60_000 + 30_000), at,
			"[sandbox] guest restarts within 30 min (max_duration)"},
		{"expiring 10 s rounds up to 1", expiring(at + 10_000), at,
			"[sandbox] guest restarts within 1 min (max_duration)"},
		{"expiring already past is 1 min", expiring(at - 5_000), at,
			"[sandbox] guest restarts within 1 min (max_duration)"},
		{"expiring exactly 60 s is 1 min", expiring(at + 60_000), at,
			"[sandbox] guest restarts within 1 min (max_duration)"},
		{"expiring 2 min", &pb.LeaseEvent{State: "expiring", Reason: "grace_limit", AtUnixMs: at, EndsByUnixMs: at + 120_000}, at,
			"[sandbox] guest restarts within 2 min (max_duration)"},
		{"expiring with no deadline says soon", expiring(0), at,
			"[sandbox] guest restarts soon (max_duration)"},
		{"expiring with a negative deadline says soon", expiring(-1), at,
			"[sandbox] guest restarts soon (max_duration)"},
		{"start in lease mode", &pb.LeaseEvent{State: "start", Mode: pb.SandboxMode_SANDBOX_MODE_LEASE, AtUnixMs: at}, at,
			"[sandbox] new guest (lease, 14:02)"},
		{"start in lease+processes mode", &pb.LeaseEvent{State: "start", Mode: pb.SandboxMode_SANDBOX_MODE_LEASE_PROCESSES, AtUnixMs: at}, at,
			"[sandbox] new guest (lease+processes, 14:02)"},
		{"start pads the hour and minute", &pb.LeaseEvent{State: "start", Mode: pb.SandboxMode_SANDBOX_MODE_LEASE, AtUnixMs: time.Date(2026, 11, 13, 9, 5, 0, 0, time.UTC).UnixMilli()}, at,
			"[sandbox] new guest (lease, 09:05)"},
		{"start at 23:59", &pb.LeaseEvent{State: "start", Mode: pb.SandboxMode_SANDBOX_MODE_LEASE, AtUnixMs: time.Date(2026, 11, 13, 23, 59, 0, 0, time.UTC).UnixMilli()}, at,
			"[sandbox] new guest (lease, 23:59)"},
		{"processes_stopped with two processes", &pb.LeaseEvent{State: "processes_stopped", Reason: "mode_change", AtUnixMs: at, Processes: []string{"web (pid 412)", "p2 (pid 518)"}}, at,
			"[sandbox] tracked processes stopped (mode_change, 14:02): web (pid 412), p2 (pid 518)"},
		{"processes_stopped with one process", &pb.LeaseEvent{State: "processes_stopped", Reason: "mode_change", AtUnixMs: at, Processes: []string{"web (pid 412)"}}, at,
			"[sandbox] tracked processes stopped (mode_change, 14:02): web (pid 412)"},
		{"processes_stopped with none", &pb.LeaseEvent{State: "processes_stopped", Reason: "mode_change", AtUnixMs: at}, at,
			"[sandbox] tracked processes stopped (mode_change, 14:02)"},
		{"resumed is unknown", &pb.LeaseEvent{State: "resumed", AtUnixMs: at}, at, ""},
		{"an empty state is unknown", &pb.LeaseEvent{AtUnixMs: at}, at, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := leaseNotice(tc.ev, time.UnixMilli(tc.now))
			if !ok && tc.want != "" || ok && got != tc.want {
				t.Fatalf("leaseNotice = %q (ok %v), want %q", got, ok, tc.want)
			}
		})
	}
}

func TestNoticeLines(t *testing.T) {
	pinUTC(t)
	at := noticeAt.UnixMilli()
	end := &pb.LeaseEvent{State: "end", Reason: "idle", AtUnixMs: at}
	start := &pb.LeaseEvent{State: "start", Mode: pb.SandboxMode_SANDBOX_MODE_LEASE, AtUnixMs: at + 1}
	exp1 := &pb.LeaseEvent{State: "expiring", EndsByUnixMs: at + 120_000}
	exp2 := &pb.LeaseEvent{State: "expiring", EndsByUnixMs: at + 60_000}
	now := noticeAt
	endLine := "[sandbox] guest restarted (idle, 14:02): /tmp, installs outside /workspace and background processes are gone"
	startLine := "[sandbox] new guest (lease, 14:02)"
	for _, tc := range []struct {
		name  string
		fresh []*pb.LeaseEvent
		want  []string
	}{
		{"a start is hidden by an end in the same result", []*pb.LeaseEvent{start, end}, []string{endLine}},
		{"a start alone is shown", []*pb.LeaseEvent{start}, []string{startLine}},
		{"only the last expiring event is shown", []*pb.LeaseEvent{exp1, exp2}, []string{"[sandbox] guest restarts within 1 min (max_duration)"}},
		{"nothing", nil, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := noticeLines(tc.fresh, now)
			if strings.Join(got, "\n") != strings.Join(tc.want, "\n") {
				t.Fatalf("noticeLines = %q, want %q", got, tc.want)
			}
		})
	}
}

// The dedupe keys on state and at_unix_ms, as TS NoticeDedupe: an end and the next lease's start in the same
// millisecond are both printed (review #4569829041).
func TestNoticeDedupeKeysOnStateAndAt(t *testing.T) {
	at := noticeAt.UnixMilli()
	end := &pb.LeaseEvent{State: "end", Reason: "idle", AtUnixMs: at}
	start := &pb.LeaseEvent{State: "start", Mode: pb.SandboxMode_SANDBOX_MODE_LEASE, AtUnixMs: at}
	d := noticeDedupe{}
	if got := d.take([]*pb.LeaseEvent{end, start}); len(got) != 2 {
		t.Fatalf("first take = %v, want the end and the start", got)
	}
	if got := d.take([]*pb.LeaseEvent{end, start}); len(got) != 0 {
		t.Fatalf("second take = %v, want nothing", got)
	}
}

// Unlike TS NoticeDedupe, which shows expiring on every MCP result, the static client prints each expiring event
// once per run: its at_unix_ms is constant per lease (P4-R2), so a retried attempt's repeat is the same event
// (review #4569829081).
func TestNoticeDedupeTakesExpiringOncePerRun(t *testing.T) {
	at := noticeAt.UnixMilli()
	exp := &pb.LeaseEvent{State: "expiring", Reason: "max_duration", AtUnixMs: at, EndsByUnixMs: at + 300_000}
	d := noticeDedupe{}
	if got := d.take([]*pb.LeaseEvent{exp, exp}); len(got) != 1 {
		t.Fatalf("first take = %v, want one expiring", got)
	}
	if got := d.take([]*pb.LeaseEvent{exp}); len(got) != 0 {
		t.Fatalf("second take = %v, want nothing", got)
	}
	// An expiring event and an end at the same ms are different events.
	if got := d.take([]*pb.LeaseEvent{{State: "end", Reason: "max_duration", AtUnixMs: at}}); len(got) != 1 {
		t.Fatalf("end take = %v, want the end", got)
	}
}

func TestExpiringNoticeIsPrintedOncePerRun(t *testing.T) {
	pinUTC(t)
	at := noticeAt.UnixMilli()
	exp := leaseEv(&pb.LeaseEvent{State: "expiring", Reason: "max_duration", AtUnixMs: at, EndsByUnixMs: at + 4*60_000 + 30_000})
	// The first attempt is refused as busy after the expiring notice; the retry carries the same event.
	c := &scriptedClient{scripts: []*fakeClient{
		{stream: &fakeStream{events: []*pb.ExecEvent{exp, execErr(budgetRefusal)}}},
		{stream: &fakeStream{events: []*pb.ExecEvent{exp, chunk(pb.Stream_STREAM_STDOUT, "ok"), end0()}}},
	}}
	code, errw, _ := retryRun(t, c, busyCfg(t), nil)
	if code != 0 || len(c.ids) != 2 || strings.Count(errw, "guest restarts within") != 1 {
		t.Fatalf("code=%d attempts=%d err=%q, want one expiring line", code, len(c.ids), errw)
	}
}
