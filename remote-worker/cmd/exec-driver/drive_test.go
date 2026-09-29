package main

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

// msFieldShape pins the times-file ms field to whole.fractional with exactly three decimal
// digits (review on #294/#296: milliseconds are now recorded to three decimal places on both
// the Go and bash paths, so the format is a contract, not an incidental ParseDuration-parsable
// string).
var msFieldShape = regexp.MustCompile(`^[0-9]+\.[0-9]{3}$`)

// fakeExec is a null responder with a recorder. It answers like
// remote-worker/cmd/null-responder -- one End carrying the request's own req_id -- and
// additionally remembers every (reqID, command) it saw, so a test can assert what the client
// actually put on the wire. behave lets one test make it fail in a specific way.
// seenExec is a PLAIN struct, deliberately not pb.Exec: protobuf messages embed a
// protoimpl.MessageState containing a no-copy guard, so recording them by value trips
// go vet's copylocks check and the verification step would fail.
type seenExec struct {
	reqID        uint64
	command      string
	workspaceKey string
	timeoutS     uint32
}

type fakeExec struct {
	pb.UnimplementedSandboxExecServer
	mu     sync.Mutex
	seen   []seenExec
	behave func(reqID uint64) (inStreamErr string, statusErr error)
	// sendEmptyErr, when true, makes every Exec send an ExecEvent.error carrying an EMPTY
	// message instead of the usual End. behave's own convention (an empty inStreamErr means
	// "no error") cannot express this case, and it is exactly the case #294's
	// empty-message-error classification bug needs the fake to be able to produce.
	sendEmptyErr bool
}

func (f *fakeExec) Exec(req *pb.ExecRequest, stream grpc.ServerStreamingServer[pb.ExecEvent]) error {
	e := req.GetExec()
	f.mu.Lock()
	f.seen = append(f.seen, seenExec{reqID: e.GetReqId(), command: e.GetCommand(), workspaceKey: e.GetWorkspaceKey(), timeoutS: e.GetTimeoutS()})
	f.mu.Unlock()

	if f.sendEmptyErr {
		return stream.Send(&pb.ExecEvent{Event: &pb.ExecEvent_Error{Error: &pb.ExecError{ReqId: e.GetReqId(), Message: ""}}})
	}

	if f.behave != nil {
		inStream, statusErr := f.behave(e.GetReqId())
		if statusErr != nil {
			return statusErr
		}
		if inStream != "" {
			return stream.Send(&pb.ExecEvent{Event: &pb.ExecEvent_Error{Error: &pb.ExecError{ReqId: e.GetReqId(), Message: inStream}}})
		}
	}
	return stream.Send(&pb.ExecEvent{Event: &pb.ExecEvent_End{End: &pb.End{ReqId: e.GetReqId(), ExitCode: 0}}})
}

func (f *fakeExec) snapshot() []seenExec {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]seenExec, len(f.seen))
	copy(out, f.seen)
	return out
}

// startFake serves fakeExec on an ephemeral loopback port and returns its target string.
func startFake(t *testing.T, f *fakeExec) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := grpc.NewServer()
	pb.RegisterSandboxExecServer(srv, f)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	return lis.Addr().String()
}

// planFor builds a plan pointing at target with c slots, bases 1000000 apart exactly as
// slot_req_base does.
func planFor(t *testing.T, target string, c, iters, warmup int, mix []string) *plan {
	t.Helper()
	dir := t.TempDir()
	p := &plan{
		Target:        target,
		SandboxID:     "e11-driver-control",
		ItersPerSlot:  iters,
		WarmupPerSlot: warmup,
		ExecTimeoutS:  30,
		CallDeadlineS: 10,
		Mix:           mix,
	}
	for i := 1; i <= c; i++ {
		p.Slots = append(p.Slots, slot{
			ReqBase:   uint64(i) * 1000000,
			TimesFile: filepath.Join(dir, fmt.Sprintf("slot-%d.times", i)),
			ErrFile:   filepath.Join(dir, fmt.Sprintf("slot-%d.err", i)),
		})
	}
	return p
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	fh, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer func() { _ = fh.Close() }()
	var out []string
	sc := bufio.NewScanner(fh)
	for sc.Scan() {
		out = append(out, sc.Text())
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan %s: %v", path, err)
	}
	return out
}

// The times-file contract, which everything downstream of this binary depends on:
// iters+warmup lines per slot, "<ms> <status> <cause>", ok/- on success.
func TestDriveWritesTheFrozenTimesFileFormat(t *testing.T) {
	f := &fakeExec{}
	p := planFor(t, startFake(t, f), 3, 5, 2, []string{"true", "cat /etc/hostname"})
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive: %v", err)
	}
	for i, s := range p.Slots {
		lines := readLines(t, s.TimesFile)
		if len(lines) != 7 {
			t.Fatalf("slot %d wrote %d lines, want iters+warmup = 7", i+1, len(lines))
		}
		for n, l := range lines {
			fields := strings.Fields(l)
			if len(fields) != 3 {
				t.Fatalf("slot %d line %d is %q, want three fields <ms> <status> <cause>", i+1, n+1, l)
			}
			if fields[1] != "ok" || fields[2] != "-" {
				t.Fatalf("slot %d line %d is %q, want status ok and cause - against a null responder", i+1, n+1, l)
			}
			if _, err := time.ParseDuration(fields[0] + "ms"); err != nil {
				t.Fatalf("slot %d line %d has a non-numeric ms field %q", i+1, n+1, fields[0])
			}
			if !msFieldShape.MatchString(fields[0]) {
				t.Fatalf("slot %d line %d has ms field %q, want whole.fractional with exactly three decimal digits", i+1, n+1, fields[0])
			}
		}
	}
}

// The point of this fix (review on #294/#296): against the in-test fake responder every Exec
// completes in well under a millisecond, so before recording microseconds and formatting three
// decimal places, int64 whole-millisecond truncation rounded the recorded value to 0 for
// essentially every call -- collapsing p95/knee/coldAcquireRate on the Go arm to the clock's
// resolution rather than a real signal. The truncation defect is fully caught by two properties
// that do not depend on wall-clock luck: the field has three decimal digits (msFieldShape, shared
// with TestDrive*'s per-line checks above), and it is not truncated to exactly "0.000". Pinning
// the whole-millisecond part to "0" as well -- i.e. requiring every Exec against the fake to run
// under 1ms -- would flake on a loaded CI runner, a GC pause, or a scheduler hiccup without
// exercising anything more of the fix.
func TestDriveRecordsSubMillisecondLatencyRatherThanZero(t *testing.T) {
	f := &fakeExec{}
	p := planFor(t, startFake(t, f), 1, 1, 0, []string{"true"})
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive: %v", err)
	}
	lines := readLines(t, p.Slots[0].TimesFile)
	if len(lines) != 1 {
		t.Fatalf("wrote %d lines, want 1", len(lines))
	}
	fields := strings.Fields(lines[0])
	msField := fields[0]
	if !msFieldShape.MatchString(msField) {
		t.Fatalf("ms field %q does not have three decimal digits: pre-fix, int64 whole-millisecond truncation produced a bare integer with no decimal point at all", msField)
	}
	if msField == "0.000" {
		t.Fatalf("ms field is %q: a sub-millisecond Exec against an in-process fake responder recorded as exactly zero, which is the truncation bug this test exists to catch", msField)
	}
}

// req_id disjointness, observed SERVER-SIDE rather than inferred from the plan: every slot
// must issue reqBase+1 .. reqBase+calls and nothing else, and no two slots may share one.
func TestDriveIssuesDisjointReqIDsStartingOnePastTheBase(t *testing.T) {
	f := &fakeExec{}
	p := planFor(t, startFake(t, f), 4, 3, 1, []string{"true"})
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive: %v", err)
	}
	seen := map[uint64]int{}
	for _, e := range f.snapshot() {
		seen[e.reqID]++
	}
	if len(seen) != 4*4 {
		t.Fatalf("server saw %d distinct req_ids, want 4 slots x 4 calls = 16", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("req_id %d was issued %d times: the relay demultiplexes by req_id, so a repeat is a collision", id, n)
		}
	}
	for _, s := range p.Slots {
		if seen[s.ReqBase] != 0 {
			t.Fatalf("req_id %d (a slot's own reqBase) was issued: the base belongs to converge, Execs start one past it", s.ReqBase)
		}
		for k := uint64(1); k <= 4; k++ {
			if seen[s.ReqBase+k] != 1 {
				t.Fatalf("req_id %d missing: slot with base %d must issue base+1..base+4", s.ReqBase+k, s.ReqBase)
			}
		}
	}
}

// The mix cycles and truncates exactly as bash's `while issued < want; for mi in mix` does.
func TestDriveCyclesTheMixAndTruncatesMidCycle(t *testing.T) {
	f := &fakeExec{}
	mix := []string{"a", "b", "c"}
	p := planFor(t, startFake(t, f), 1, 4, 0, mix)
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive: %v", err)
	}
	var got []string
	for _, e := range f.snapshot() {
		got = append(got, e.command)
	}
	want := []string{"a", "b", "c", "a"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("commands = %v, want %v (cycle then truncate mid-cycle)", got, want)
	}
}

// The workspace_key the plan carries reaches the wire unchanged -- the microvm arm REFUSES an
// empty one, so a client that dropped it would turn every microvm Exec into a refusal.
func TestDriveSendsThePlansWorkspaceKeyAndExecTimeout(t *testing.T) {
	f := &fakeExec{}
	p := planFor(t, startFake(t, f), 1, 1, 0, []string{"true"})
	p.Slots[0].WorkspaceKey = "e11-microvm-d2-ram256-c1-slot1"
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive: %v", err)
	}
	seen := f.snapshot()
	if len(seen) != 1 {
		t.Fatalf("server saw %d Execs, want 1", len(seen))
	}
	if seen[0].workspaceKey != "e11-microvm-d2-ram256-c1-slot1" {
		t.Fatalf("workspace_key = %q, want the plan's value", seen[0].workspaceKey)
	}
	if seen[0].timeoutS != 30 {
		t.Fatalf("timeout_s = %d, want the plan's execTimeoutS of 30", seen[0].timeoutS)
	}
}

// An in-stream ExecError is a FAILED Exec. The relay yields it and then returns a gRPC OK
// status (packages/sandbox-relay/src/relay.ts routeExec), which is why grpcurl exits 0 and
// the bash path records this as ok. The null-responder never sends one, so classifying it
// correctly here cannot affect the driver-control comparison.
func TestDriveClassifiesAnInStreamExecErrorAsFailure(t *testing.T) {
	f := &fakeExec{behave: func(uint64) (string, error) {
		return "vmpool refused: empty workspace_key", nil
	}}
	p := planFor(t, startFake(t, f), 1, 2, 0, []string{"true"})
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive must not fail the rung over per-Exec errors: %v", err)
	}
	for n, l := range readLines(t, p.Slots[0].TimesFile) {
		fields := strings.Fields(l)
		if fields[1] != "err" || fields[2] != "empty-workspace-key" {
			t.Fatalf("line %d is %q, want status err and cause empty-workspace-key", n+1, l)
		}
	}
	errBody, err := os.ReadFile(p.Slots[0].ErrFile)
	if err != nil {
		t.Fatalf("read err file: %v", err)
	}
	if !strings.Contains(string(errBody), "empty workspace_key") {
		t.Fatalf("err file %q does not carry the message an operator would read", errBody)
	}
}

// A bug found and fixed on this branch (#294): an in-stream ExecEvent.error with an EMPTY
// message must still classify as a failed Exec. Classification was gated on inStream == "",
// which cannot distinguish "no error was ever received" from "an error was received with an
// empty message" -- so an empty-message error silently read back as ok.
//
// This also covers the review fix (#296) that gates the err-file write on status == "err"
// rather than errMsg != "": before that fix, this exact case -- a failing Exec whose message
// happens to be empty -- wrote NOTHING to the err file, which is verbatim the state
// plan.validate's errFile refusal warns about (a failing Exec's message lost and
// execErrorsByCause saying unknown with nothing to look at).
func TestDriveClassifiesAnEmptyMessageInStreamErrorAsFailure(t *testing.T) {
	f := &fakeExec{sendEmptyErr: true}
	p := planFor(t, startFake(t, f), 1, 2, 0, []string{"true"})
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive must not fail the rung over per-Exec errors: %v", err)
	}
	timesLines := readLines(t, p.Slots[0].TimesFile)
	for n, l := range timesLines {
		fields := strings.Fields(l)
		if fields[1] != "err" || fields[2] != "unknown" {
			t.Fatalf("line %d is %q, want status err and cause unknown: an empty-message ExecEvent.error must still be recorded as failed, not ok", n+1, l)
		}
	}
	errLines := readLines(t, p.Slots[0].ErrFile)
	if len(errLines) != len(timesLines) {
		t.Fatalf("err file has %d lines, want one per failing Exec (%d): an empty-message error must still get a line in the err file", len(errLines), len(timesLines))
	}
	for n, l := range errLines {
		if !strings.HasPrefix(l, "req ") {
			t.Fatalf("err file line %d is %q, want it to start with the req id even though the message is empty", n+1, l)
		}
	}
}

// A gRPC status error is also recorded rather than fatal, and it is classified from the
// status message.
func TestDriveRecordsAStatusErrorWithoutFailingTheRung(t *testing.T) {
	f := &fakeExec{behave: func(uint64) (string, error) {
		return "", status.Error(codes.ResourceExhausted, "pool refused: max_runs reached")
	}}
	p := planFor(t, startFake(t, f), 2, 2, 0, []string{"true"})
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive must not fail the rung over per-Exec errors: %v", err)
	}
	for _, s := range p.Slots {
		for n, l := range readLines(t, s.TimesFile) {
			if fields := strings.Fields(l); fields[1] != "err" || fields[2] != "max-runs" {
				t.Fatalf("line %d is %q, want status err and cause max-runs", n+1, l)
			}
		}
	}
}

// A rung with a mix of outcomes keeps them in ISSUE ORDER, because the driver trims warmup
// off the FRONT of this file by line position.
func TestDrivePreservesIssueOrder(t *testing.T) {
	f := &fakeExec{behave: func(reqID uint64) (string, error) {
		if reqID%2 == 0 {
			return "vsock read returned 3 bytes", nil
		}
		return "", nil
	}}
	p := planFor(t, startFake(t, f), 1, 4, 0, []string{"true"})
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive: %v", err)
	}
	var statuses []string
	for _, l := range readLines(t, p.Slots[0].TimesFile) {
		statuses = append(statuses, strings.Fields(l)[1])
	}
	// req_ids are 1000001..1000004: odd, even, odd, even -> ok, err, ok, err.
	want := "ok,err,ok,err"
	if strings.Join(statuses, ",") != want {
		t.Fatalf("statuses = %v, want %s", statuses, want)
	}
}

// A setup failure IS fatal: an unreachable target must not produce a times file full of
// plausible error lines that a rung would then aggregate and record.
//
// This proves the PRODUCTION call path, not a test-only bound: drive is called with
// context.Background(), exactly as main.go calls it, with no caller-supplied timeout. The
// bound that stops this from hanging forever must come from drive itself (via the plan's
// CallDeadlineS), not from the test's context. The wall-clock assertion below is load-bearing:
// without it, this test would still pass even if that internal bound were later removed and
// the surrounding test binary's own timeout fired instead, which would prove nothing about
// the production path.
func TestDriveFailsWhenTheTargetIsUnreachable(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	target := lis.Addr().String()
	if err := lis.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	p := planFor(t, target, 1, 1, 0, []string{"true"})
	p.CallDeadlineS = 1
	start := time.Now()
	if err := drive(context.Background(), p); err == nil {
		t.Fatal("drive accepted a target nothing is listening on")
	}
	if elapsed := time.Since(start); elapsed > 30*time.Second {
		t.Fatalf("drive took %s to fail against an unreachable target with no caller-supplied bound: it is hanging instead of using CallDeadlineS to fail fast", elapsed)
	}
}

// An unwritable times file is a setup failure too, for the same reason.
func TestDriveFailsWhenASlotsTimesFileCannotBeCreated(t *testing.T) {
	f := &fakeExec{}
	p := planFor(t, startFake(t, f), 1, 1, 0, []string{"true"})
	p.Slots[0].TimesFile = filepath.Join(p.Slots[0].TimesFile, "no", "such", "dir", "slot-1.times")
	if err := drive(context.Background(), p); err == nil {
		t.Fatal("drive accepted a slot whose times file cannot be created")
	}
}
