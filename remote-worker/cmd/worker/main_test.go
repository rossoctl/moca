package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc/metadata"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

func TestEnvIntFallsBackOnGarbage(t *testing.T) {
	t.Setenv("WORKER_MAX_CONCURRENT", "not-a-number")
	if got := envInt("WORKER_MAX_CONCURRENT", 4); got != 4 {
		t.Errorf("envInt = %d, want the default 4 for unparseable input", got)
	}
	t.Setenv("WORKER_MAX_CONCURRENT", "8")
	if got := envInt("WORKER_MAX_CONCURRENT", 4); got != 8 {
		t.Errorf("envInt = %d, want 8", got)
	}
	// A zero or negative pool would wedge the dispatch loop; fall back instead.
	t.Setenv("WORKER_MAX_CONCURRENT", "0")
	if got := envInt("WORKER_MAX_CONCURRENT", 4); got != 4 {
		t.Errorf("envInt = %d, want the default for 0", got)
	}
}

// Hello must advertise what is actually installed, not a hardcoded list.
func TestCapabilitiesProbesRealBinaries(t *testing.T) {
	caps := capabilities()
	found := false
	for _, c := range caps {
		if c == "bash" {
			found = true
		}
	}
	if !found {
		t.Error("capabilities did not include bash, which the runner requires")
	}
	// And nothing outside the probed list may appear: capabilities is a PATH probe,
	// not a hardcoded advertisement. (The check this replaces looked for a literal
	// that was never in probed, so no code path could have produced it.)
	inProbed := func(c string) bool {
		for _, p := range probed {
			if p == c {
				return true
			}
		}
		return false
	}
	for _, c := range caps {
		if !inProbed(c) {
			t.Errorf("capabilities included %q, which is not in the probed list %v", c, probed)
		}
	}
}

// RELAY_TLS decides whether the bearer token crosses the wire in cleartext, so an
// unparseable value must be an error the caller can fail on — never a silent
// fallback to plaintext.
func TestEnvBoolRejectsGarbageRatherThanFailingOpen(t *testing.T) {
	for _, v := range []string{"yes", "TLS", "1 ", "on"} {
		t.Setenv("RELAY_TLS", v)
		if got, err := envBool("RELAY_TLS", false); err == nil {
			t.Errorf("envBool(%q) = %v, nil; want an error rather than a silent plaintext default", v, got)
		}
	}
	for v, want := range map[string]bool{"1": true, "true": true, "TRUE": true, "0": false, "false": false} {
		t.Setenv("RELAY_TLS", v)
		got, err := envBool("RELAY_TLS", false)
		if err != nil || got != want {
			t.Errorf("envBool(%q) = %v, %v; want %v, nil", v, got, err, want)
		}
	}
	os.Unsetenv("RELAY_TLS")
	if got, err := envBool("RELAY_TLS", true); err != nil || !got {
		t.Errorf("envBool(unset) = %v, %v; want the default true, nil", got, err)
	}
}

func TestNextBackoffDoublesAndCaps(t *testing.T) {
	got := nextBackoff(backoffMin)
	if got != 2*backoffMin {
		t.Errorf("nextBackoff(%v) = %v, want %v", backoffMin, got, 2*backoffMin)
	}
	if got := nextBackoff(20 * time.Second); got != backoffMax {
		t.Errorf("nextBackoff(20s) = %v, want the cap %v", got, backoffMax)
	}
	if got := nextBackoff(backoffMax); got != backoffMax {
		t.Errorf("nextBackoff(cap) = %v, want it to stay at %v", got, backoffMax)
	}
}

func TestJitterStaysWithinHalfTheInterval(t *testing.T) {
	d := 2 * time.Second
	for i := 0; i < 100; i++ {
		got := jitter(d)
		if got < d || got > d+d/2 {
			t.Fatalf("jitter(%v) = %v, want within [%v, %v]", d, got, d, d+d/2)
		}
	}
}

// SH_WORKSPACE_IDLE is the only trigger that deletes a session's workspace, so a value
// that does not parse must stop the worker, not quietly become the default.
func TestWorkspaceRunnerConfig(t *testing.T) {
	get := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

	w, err := workspaceRunner(get(nil))
	if err != nil || w.Root != wexec.DefaultWorkspaceRoot || w.Idle != wexec.DefaultWorkspaceIdle {
		t.Fatalf("defaults: root=%q idle=%s err=%v", w.Root, w.Idle, err)
	}
	w, err = workspaceRunner(get(map[string]string{"SH_WORKSPACE_ROOT": "/srv/ws", "SH_WORKSPACE_IDLE": "8h"}))
	if err != nil || w.Root != "/srv/ws" || w.Idle != 8*time.Hour {
		t.Fatalf("overrides: root=%q idle=%s err=%v", w.Root, w.Idle, err)
	}
	for _, bad := range []map[string]string{
		{"SH_WORKSPACE_IDLE": "8"},
		{"SH_WORKSPACE_IDLE": "-1h"},
		{"SH_WORKSPACE_ROOT": "workspace"},
	} {
		if _, err := workspaceRunner(get(bad)); err == nil {
			t.Errorf("%v accepted; want an error", bad)
		}
	}
}

// SH_EXEC_TIMING turns the per-Exec timing line on only for exactly "1", like the
// microVM worker's SH_DIAG_PHASES: a benchmark knob, never on by accident.
func TestWorkspaceRunnerExecTiming(t *testing.T) {
	for v, want := range map[string]bool{"": false, "0": false, "true": false, "1": true} {
		w, err := workspaceRunner(func(k string) string {
			if k == "SH_EXEC_TIMING" {
				return v
			}
			return ""
		})
		if err != nil {
			t.Fatalf("SH_EXEC_TIMING=%q: %v", v, err)
		}
		if got := w.Inner.(wexec.BashRunner).Timing; got != want {
			t.Errorf("SH_EXEC_TIMING=%q: Timing=%v, want %v", v, got, want)
		}
	}
}

func TestSweepIntervalIsBounded(t *testing.T) {
	for idle, want := range map[time.Duration]time.Duration{
		30 * time.Minute: time.Minute,
		2 * time.Minute:  30 * time.Second,
		time.Second:      time.Second,
	} {
		if got := sweepInterval(idle); got != want {
			t.Errorf("sweepInterval(%s) = %s, want %s", idle, got, want)
		}
	}
}

func TestTokenSourceFallsBackToEnvWhenNoFile(t *testing.T) {
	vars := map[string]string{}
	get := func(k string) string { return vars[k] }
	noFile := func(string) ([]byte, error) { t.Fatal("read a file with SANDBOX_TOKEN_FILE unset"); return nil, nil }

	if got, err := tokenSource(get, noFile)(); err != nil || got != "dev-token" {
		t.Errorf("unset: got %q, %v; want the dev-token default", got, err)
	}
	vars["SANDBOX_TOKEN"] = "shared"
	if got, err := tokenSource(get, noFile)(); err != nil || got != "shared" {
		t.Errorf("SANDBOX_TOKEN: got %q, %v; want shared", got, err)
	}
}

func TestTokenSourceRereadsTheFileOnEveryCall(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	vars := map[string]string{"SANDBOX_TOKEN_FILE": path, "SANDBOX_TOKEN": "ignored-when-a-file-is-named"}
	next := tokenSource(func(k string) string { return vars[k] }, os.ReadFile)

	if err := os.WriteFile(path, []byte("first\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := next(); err != nil || got != "first" {
		t.Fatalf("got %q, %v; want first (trailing newline trimmed)", got, err)
	}
	// The kubelet's in-place Secret refresh: the next dial must present the new token.
	if err := os.WriteFile(path, []byte("second"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := next(); err != nil || got != "second" {
		t.Fatalf("after rotation got %q, %v; want second", got, err)
	}
	// A missing or empty file is an error, never a silent fallback to SANDBOX_TOKEN.
	if err := os.WriteFile(path, []byte("  \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := next(); err == nil {
		t.Error("an empty token file must be an error")
	}
	os.Remove(path)
	if _, err := next(); err == nil {
		t.Error("a missing token file must be an error")
	}
}

func TestRetryLineNamesATokenFileFailure(t *testing.T) {
	get := func(k string) string {
		return map[string]string{"SANDBOX_TOKEN_FILE": filepath.Join(t.TempDir(), "absent")}[k]
	}
	_, tokenErr := tokenSource(get, os.ReadFile)()
	if tokenErr == nil {
		t.Fatal("a missing token file must be an error")
	}
	got := retryLine(tokenErr, nil, 1500*time.Millisecond)
	if !strings.HasPrefix(got, "worker: cannot read SANDBOX_TOKEN_FILE: ") || !strings.HasSuffix(got, "; retrying in 1.5s") {
		t.Errorf("token failure: got %q", got)
	}
	if strings.Contains(got, "stream ended") {
		t.Errorf("a token read failure is not a stream end: %q", got)
	}
	got = retryLine(nil, errors.New("EOF"), time.Second)
	if got != "worker: stream ended (EOF); reconnecting in 1s" {
		t.Errorf("stream end: got %q", got)
	}
}

// An unreadable token file after boot must back off, never reach attach or serve: serving a nil
// context and stream panics in Serve (#560 review).
func TestAttachOnceStopsAtATokenFileFailure(t *testing.T) {
	get := func(k string) string {
		return map[string]string{"SANDBOX_TOKEN_FILE": filepath.Join(t.TempDir(), "absent")}[k]
	}
	attached, served := false, false
	tokenErr, err, lasted := attachOnce(context.Background(), tokenSource(get, os.ReadFile),
		func(context.Context) (pb.SandboxWorker_AttachClient, error) { attached = true; return nil, nil },
		func(context.Context, pb.SandboxWorker_AttachClient) error { served = true; return nil })
	if tokenErr == nil || err != nil || lasted != 0 {
		t.Fatalf("got tokenErr=%v err=%v lasted=%v, want only a token error", tokenErr, err, lasted)
	}
	if attached || served {
		t.Errorf("a failed token read reached attach=%v serve=%v", attached, served)
	}
}

func TestAttachOnceStopsAtAFailedAttach(t *testing.T) {
	served := false
	tokenErr, err, _ := attachOnce(context.Background(), func() (string, error) { return "t", nil },
		func(context.Context) (pb.SandboxWorker_AttachClient, error) { return nil, errors.New("dial") },
		func(context.Context, pb.SandboxWorker_AttachClient) error { served = true; return nil })
	if tokenErr != nil || err == nil || served {
		t.Errorf("got tokenErr=%v err=%v served=%v, want the attach error and no serve", tokenErr, err, served)
	}
}

func TestAttachOnceServesWithTheBearer(t *testing.T) {
	var auth []string
	_, err, _ := attachOnce(context.Background(), func() (string, error) { return "tok", nil },
		func(c context.Context) (pb.SandboxWorker_AttachClient, error) {
			md, _ := metadata.FromOutgoingContext(c)
			auth = md.Get("authorization")
			return nil, nil
		},
		func(context.Context, pb.SandboxWorker_AttachClient) error { return errors.New("EOF") })
	if err == nil || err.Error() != "EOF" {
		t.Errorf("serve error not returned: %v", err)
	}
	if len(auth) != 1 || auth[0] != "Bearer tok" {
		t.Errorf("authorization = %v", auth)
	}
}

// fakeStream is an attach stream whose only behaviour is its context, as gRPC's is: cancelling the
// context it was created from ends it.
type fakeStream struct {
	pb.SandboxWorker_AttachClient
	ctx context.Context
}

func (f fakeStream) Context() context.Context { return f.ctx }

func attachWith(bearer string) context.Context {
	return metadata.AppendToOutgoingContext(context.Background(), "authorization", "Bearer "+bearer)
}

func fakeAttach(c context.Context) (pb.SandboxWorker_AttachClient, error) {
	return fakeStream{ctx: c}, nil
}

// A rotated token file ends the stream only once no Exec is in flight (spec §3.1).
func TestRotateWhenIdleWaitsForIdleThenEndsTheStream(t *testing.T) {
	var mu sync.Mutex
	current, idle := "old", false
	token := func() (string, error) { mu.Lock(); defer mu.Unlock(); return current, nil }
	isIdle := func() bool { mu.Lock(); defer mu.Unlock(); return idle }
	st, err := rotateWhenIdle(fakeAttach, token, isIdle, 5*time.Millisecond)(attachWith("old"))
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if st.Context().Err() != nil {
		t.Fatal("the stream ended while the token was unchanged")
	}
	mu.Lock()
	current = "new"
	mu.Unlock()
	time.Sleep(30 * time.Millisecond)
	if st.Context().Err() != nil {
		t.Fatal("the stream ended with an Exec in flight")
	}
	mu.Lock()
	idle = true
	mu.Unlock()
	select {
	case <-st.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("a rotated token at an idle moment did not end the stream")
	}
}

// An unreadable file keeps the stream: the redial would fail on it too.
func TestRotateWhenIdleKeepsTheStreamOnAnUnreadableFile(t *testing.T) {
	token := func() (string, error) { return "", errors.New("gone") }
	st, _ := rotateWhenIdle(fakeAttach, token, func() bool { return true }, 5*time.Millisecond)(attachWith("old"))
	time.Sleep(30 * time.Millisecond)
	if st.Context().Err() != nil {
		t.Error("an unreadable token file ended the stream")
	}
}

// The parent's cancel (SIGTERM) still reaches the stream.
func TestRotateWhenIdleStreamFollowsItsParent(t *testing.T) {
	parent, cancel := context.WithCancel(attachWith("old"))
	st, _ := rotateWhenIdle(fakeAttach, func() (string, error) { return "old", nil },
		func() bool { return true }, time.Hour)(parent)
	cancel()
	select {
	case <-st.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("cancelling the parent did not end the stream")
	}
}
