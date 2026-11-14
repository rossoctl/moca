package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	mrand "math/rand/v2"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

const usage = `sbx: a command-line client for one sandbox/v1 workspace (the Go twin of docs/api/examples/sbx.py).

Meant for a coding agent whose shell tool is restricted to ` + "`sbx ...`" + `: every command runs in a fresh
microVM over the workspace, and nothing runs on the local machine. See docs/api/sandbox-v1-direct-client.md.

    sbx run [COMMAND...]      run COMMAND (or, with no arguments, the script on stdin) in /workspace
    sbx put PATH              write stdin to PATH in the workspace (parent directories created)
    sbx pull                  print every change since the baseline commit as a git patch

Environment: SBX_ADDR, SBX_SANDBOX_ID, SBX_WORKSPACE_KEY, and SBX_TOKEN or SBX_TOKEN_FILE.
Optional: SBX_TIMEOUT (seconds per command, default 600; as in sbx.py, cut to what a JWT token has left before its
exp, less 60 s, so the command times out before the relay cancels it at exp), SBX_LOG (append one JSON line per call),
SBX_DIAL_ADDR (ip:port to connect to instead of looking up SBX_ADDR's host: the caller resolved it once; TLS still
verifies, and requests still name, SBX_ADDR's host),
SBX_TLS=1 (dial the exec endpoint over TLS, as SBX0's exec Route), SBX_CA_FILE (with SBX_TLS: an extra CA, PEM,
added to the system roots, e.g. a sandbox token grant's execCa),
SBX_BUSY_RETRY_S (seconds, default 30: how long in all to wait and retry a command refused before it started,
because the worker or the relay was at capacity; 0 never retries).
` + "`sbx run`" + ` prints the sandbox's lease notices (a guest restart, a new guest, a lease about to end) to stderr,
one line each. It exits with the command's own exit code; 124 means it timed out, 125 that the sandbox failed
(or that the command outlived its token, or that it refused a lease command: stale_mode, lease_unsupported), 75 that the sandbox refused the command at capacity until
SBX_BUSY_RETRY_S ran out (nothing ran), 128 + n that signal n killed it.
Unlike sbx.py, this client dials plaintext unless SBX_TLS=1, and reads no SBX_TOKEN_CMD (so the exports of
` + "`mocactl sbx env`" + ` are not enough: give SBX_TOKEN or SBX_TOKEN_FILE).
There is no ` + "`sbx push`" + `: this client is for a workspace seeded on the server side.
`

// pull is sbx.py's PULL, byte for byte, so a patch collected either way is the same diff.
const pull = "cd /workspace && git add -A -N . && git diff --binary HEAD"

// config is everything a call needs besides the command; read once from the environment.
type config struct {
	addr, sandboxID, key, token string
	timeoutS                    uint32
	logPath                     string
	// tls dials the exec endpoint over TLS (SBX_TLS=1), as SBX0's exec Route is; caPEM is an EXTRA root
	// (SBX_CA_FILE: the token grant's execCa, when the Route's certificate is self-issued), added to the
	// system roots, never replacing them -- as sandbox-client's caBundle does.
	tls   bool
	caPEM []byte
	// dialAddr (SBX_DIAL_ADDR), when set, is an ip:port the caller resolved SBX_ADDR's host to once, so a run of
	// many calls does not look the name up per call (behind a slow resolver, a lookup per call cost about 20 s)
	dialAddr string
	// busyRetry (SBX_BUSY_RETRY_S) is the most a call sleeps, in all, between retries of a command refused before it
	// started (refusalClass); 0 never retries, as before.
	busyRetry time.Duration
}

// defaultBusyRetry is SBX_BUSY_RETRY_S's default: long enough for a template worker's running VM to finish a
// command and give its memory back, short enough that an agent's tool call is not held for minutes.
const defaultBusyRetry = 30 * time.Second

func configFrom(getenv func(string) string, readFile func(string) ([]byte, error)) (config, error) {
	c := config{
		addr:      getenv("SBX_ADDR"),
		sandboxID: getenv("SBX_SANDBOX_ID"),
		key:       getenv("SBX_WORKSPACE_KEY"),
		token:     getenv("SBX_TOKEN"),
		logPath:   getenv("SBX_LOG"),
		timeoutS:  600,
		busyRetry: defaultBusyRetry,
	}
	for name, v := range map[string]string{"SBX_ADDR": c.addr, "SBX_SANDBOX_ID": c.sandboxID, "SBX_WORKSPACE_KEY": c.key} {
		if v == "" {
			return c, fmt.Errorf("%s is not set", name)
		}
	}
	if c.token == "" {
		path := getenv("SBX_TOKEN_FILE")
		if path == "" {
			return c, errors.New("neither SBX_TOKEN nor SBX_TOKEN_FILE is set")
		}
		b, err := readFile(path)
		if err != nil {
			return c, fmt.Errorf("reading SBX_TOKEN_FILE: %w", err)
		}
		c.token = strings.TrimSpace(string(b))
	}
	switch v := getenv("SBX_TLS"); v {
	case "", "0":
	case "1":
		c.tls = true
	default:
		return c, fmt.Errorf("SBX_TLS must be 1 or 0, got %q", v)
	}
	if path := getenv("SBX_CA_FILE"); path != "" {
		if !c.tls {
			return c, errors.New("SBX_CA_FILE is set but SBX_TLS is not 1")
		}
		b, err := readFile(path)
		if err != nil {
			return c, fmt.Errorf("reading SBX_CA_FILE: %w", err)
		}
		if !x509.NewCertPool().AppendCertsFromPEM(b) {
			return c, errors.New("SBX_CA_FILE holds no PEM certificate")
		}
		c.caPEM = b
	}
	if a := getenv("SBX_DIAL_ADDR"); a != "" {
		host, port, err := net.SplitHostPort(a)
		if err != nil || net.ParseIP(host) == nil || port == "" {
			return c, fmt.Errorf("SBX_DIAL_ADDR must be ip:port, got %q", a)
		}
		c.dialAddr = a
	}
	if s := getenv("SBX_TIMEOUT"); s != "" {
		// ParseUint takes the whole string: Sscanf's %d would read "1e3" as 1 and "10s" as 10.
		n, err := strconv.ParseUint(s, 10, 32)
		if err != nil || n == 0 {
			return c, fmt.Errorf("SBX_TIMEOUT must be a whole number of seconds from 1 to %d, got %q", uint32(1<<32-1), s)
		}
		c.timeoutS = uint32(n)
	}
	if s := getenv("SBX_BUSY_RETRY_S"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 || n > 3600 {
			return c, fmt.Errorf("SBX_BUSY_RETRY_S must be a whole number of seconds from 0 to 3600, got %q", s)
		}
		c.busyRetry = time.Duration(n) * time.Second
	}
	return c, nil
}

// reqID is random and below 2^53: the proto says uint64, but the relay decodes it as a
// JavaScript number and refuses anything larger (sandbox_v1_client.py, EXPERIMENTS §6.2).
func reqID() uint64 {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return binary.LittleEndian.Uint64(b[:]) & (1<<53 - 1)
}

// result is one finished Exec, buffered like the Python client's: nothing is written until End.
type result struct {
	stdout, stderr []byte
	exitCode       int32
	truncated      bool
	timedOut       bool             // the command ran out of SBX_TIMEOUT: the worker's in-stream ExecError "timeout:<n>"
	leases         []*pb.LeaseEvent // the lease events of the stream, in order, printed by call (notice.go)
}

// timeoutMessage is the worker's whole ExecError text for a command that ran out of its timeout,
// as sbx.py's TIMEOUT_MESSAGE.fullmatch checks it; any other ExecError is a sandbox failure.
var timeoutMessage = regexp.MustCompile(`^timeout:\d+$`)

// execFailure is execOnce's error: the machinery failing, never the command's own exit status.
// refused is the refusal's class (refusalClass) when the sandbox declined the command at capacity
// before anything of it ran -- no Chunk or End had arrived -- and "" otherwise.
type execFailure struct {
	msg     string
	refused string
	reason  string // the refusal's own text, as the worker or the relay sent it
}

func (e *execFailure) Error() string { return e.msg }

// refusalClass names a capacity refusal that comes BEFORE the command starts, mirroring sandbox-client's TEMPLATE_BUSY
// and its relay "sandbox busy" rule (packages/sandbox-client/src/exec-conn.ts): the worker's vmpool refusals,
// sent as an ExecError or as the status's message, and the relay's per-sandbox in-flight cap. Every other failure,
// and any failure after a Chunk or End, is "": it may have run part of the command, so it is never retried.
func refusalClass(code codes.Code, msg string) string {
	switch {
	case strings.HasPrefix(msg, "memory-budget:"):
		return "memory_budget"
	case strings.HasPrefix(msg, "max-runs:"):
		return "max_runs"
	case strings.HasPrefix(msg, "busy: queue full"):
		return "queue_full"
	case code == codes.ResourceExhausted && strings.HasPrefix(msg, "sandbox busy"):
		// Only the relay's "sandbox busy": grpc's own message-size limits are RESOURCE_EXHAUSTED too.
		return "relay_busy"
	}
	return ""
}

// execOnce runs one command. An error (an *execFailure) is the machinery failing (VM boot, worker gone, a timeout,
// a refused token, a refusal at capacity), never the command's own exit status, which comes back in result. The
// lease events seen before an error come back with it, so call can print them.
func execOnce(ctx context.Context, c pb.SandboxExecClient, cfg config, id uint64, command string, stdin []byte) (result, error) {
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+cfg.token)
	stream, err := c.Exec(ctx, &pb.ExecRequest{
		SandboxId: cfg.sandboxID,
		Exec: &pb.Exec{
			ReqId:        id,
			Command:      command,
			Stdin:        stdin,
			TimeoutS:     cfg.timeoutS,
			Streaming:    true,
			WorkspaceKey: cfg.key,
		},
	})
	if err != nil {
		return result{}, rpcErr(err, false)
	}
	var r result
	// started: a Chunk has arrived, so some of the command may have run; a refusal after it is never retryable.
	started := false
	for {
		ev, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return r, &execFailure{msg: "exec failed: the stream ended without an End event"}
		}
		if err != nil {
			return r, rpcErr(err, started)
		}
		switch {
		case ev.GetLease() != nil:
			r.leases = append(r.leases, ev.GetLease())
		case ev.GetChunk() != nil:
			started = true
			ch := ev.GetChunk()
			if ch.GetStream() == pb.Stream_STREAM_STDERR {
				r.stderr = append(r.stderr, ch.GetData()...)
			} else {
				r.stdout = append(r.stdout, ch.GetData()...)
			}
		case ev.GetEnd() != nil:
			r.exitCode, r.truncated = ev.GetEnd().GetExitCode(), ev.GetEnd().GetTruncated()
			return r, nil
		case ev.GetError() != nil:
			m := ev.GetError().GetMessage()
			if timeoutMessage.MatchString(m) {
				r.timedOut = true // the output so far is kept and written, as sbx.py does
				return r, nil
			}
			f := &execFailure{msg: fmt.Sprintf("exec failed: %s", m)}
			if !started {
				if f.refused = refusalClass(codes.OK, m); f.refused != "" {
					f.reason = m
				}
			}
			return r, f
		}
	}
}

// rpcErr turns a non-OK status into an *execFailure; started says a Chunk had arrived first.
func rpcErr(err error, started bool) error {
	if s, ok := status.FromError(err); ok {
		if s.Code() == codes.DeadlineExceeded && tokenExpiry(s.Message()) {
			// The relay cancels an Exec at its token's exp: name that case, in sbx.py's words.
			msg := s.Message()
			if msg == "" {
				msg = "sandbox token expired during the Exec"
			}
			return &execFailure{msg: msg + ": the command outlived its token and was cancelled; give it a shorter timeout"}
		}
		f := &execFailure{msg: fmt.Sprintf("exec failed: %s: %s", upperSnake(s.Code().String()), s.Message())}
		if !started {
			if f.refused = refusalClass(s.Code(), s.Message()); f.refused != "" {
				f.reason = s.Message()
			}
		}
		return f
	}
	return &execFailure{msg: fmt.Sprintf("exec failed: %v", err)}
}

// tokenExpiry says a DEADLINE_EXCEEDED is the relay cancelling the Exec at its token's exp ("sandbox token expired
// during the Exec"); the client sets no deadline of its own, so an empty message is taken as that case too, as sbx.py does.
func tokenExpiry(msg string) bool {
	m := strings.ToLower(msg)
	return m == "" || (strings.Contains(m, "token") && strings.Contains(m, "expir"))
}

// marginS is sbx.py's MARGIN_S: an Exec's timeout leaves this much of the token's life spare, so the worker's
// own timeout fires before the relay cancels the Exec at the token's exp.
const marginS = 60

// tokenTimes is the token's (iat, exp), read without verifying, as sandbox_v1_client.py's _times_of: the relay
// verifies, the client only schedules. (0, 0) when the token is not a JWT or has no exp.
func tokenTimes(token string) (iat, exp int64) {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return 0, 0
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return 0, 0
	}
	var claims struct {
		Iat *float64 `json:"iat"`
		Exp *float64 `json:"exp"`
	}
	if json.Unmarshal(b, &claims) != nil || claims.Exp == nil {
		return 0, 0
	}
	if claims.Iat != nil {
		iat = int64(*claims.Iat)
	}
	return iat, int64(*claims.Exp)
}

// capTimeout is sbx.py's rule for a static token (Sandbox._prepare): the requested timeout is cut to the token's
// lifetime (exp - iat) less 60 s, and then to what it has left at now (exp - now, rounded up) less 60 s, never
// below 1 s; capped says it was cut. A token whose exp cannot be read is not capped.
func capTimeout(token string, requested uint32, now time.Time) (timeout uint32, capped bool) {
	iat, exp := tokenTimes(token)
	t := int64(requested)
	if iat > 0 && exp > iat {
		if limit := max(1, exp-iat-marginS); t > limit {
			t, capped = limit, true
		}
	}
	if exp != 0 {
		left := float64(exp) - float64(now.UnixNano())/1e9
		if float64(t+marginS) > left {
			// ceil: a token minted this instant keeps its full cap
			if cut := max(1, int64(math.Ceil(left))-marginS); cut < t {
				t, capped = cut, true
			}
		}
	}
	return uint32(t), capped
}

// upperSnake spells a gRPC code the way grpcio's Python enum names it (PermissionDenied ->
// PERMISSION_DENIED), so the two clients' failure messages read the same.
func upperSnake(name string) string {
	var b strings.Builder
	for i, r := range name {
		if i > 0 && r >= 'A' && r <= 'Z' {
			b.WriteByte('_')
		}
		b.WriteRune(r)
	}
	return strings.ToUpper(b.String())
}

// callEnv is what a call takes from its process besides the request: the clock, the sleep between retries, a new
// req_id per retry, and cur, which always holds the req_id of the Exec now in flight, for main's Abort on a signal.
type callEnv struct {
	now    func() time.Time
	sleep  func(context.Context, time.Duration) error
	newID  func() uint64
	jitter func(time.Duration) time.Duration
	cur    *atomic.Uint64
}

// sleepCtx waits d, or returns the context's error if it is cancelled first.
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// jitterOf spreads a delay over [0.75d, 1.25d), so two reps refused together do not retry together.
func jitterOf(d time.Duration) time.Duration {
	return time.Duration(float64(d) * (0.75 + 0.5*mrand.Float64()))
}

// busyBackoff is the delay before retry n (1-based) of a refused command: about 1, 2, 4, 8, then 8 s.
func busyBackoff(n int) time.Duration {
	if n > 4 {
		n = 4
	}
	return time.Second << (n - 1)
}

// Exit codes besides the command's own: 124 timed out, 125 the sandbox failed, 75 (EX_TEMPFAIL) refused at
// capacity until SBX_BUSY_RETRY_S ran out, so nothing ran, 130 interrupted while waiting to retry.
const (
	exitTimedOut    = 124
	exitFailed      = 125
	exitRefused     = 75
	exitInterrupted = 130
)

// call runs one command and turns its outcome into the process's exit code, writing output and the SBX_LOG
// records the way sbx.py does: the command's own code, 128 + n for a command killed by signal n (outcome), 124 for
// a timeout, 125 for any other sandbox failure, 75 for a command refused at capacity until SBX_BUSY_RETRY_S ran out
// (nothing ran), and 130 when interrupted while waiting to retry. Each attempt's timeout is capped to the token
// (capTimeout). A command the sandbox refused at capacity before anything of it ran
// (refusalClass) is retried, with backoff, until SBX_BUSY_RETRY_S of waiting is spent (a template worker at its
// memory budget refuses a warm acquire while two reps' VMs run). Nothing else is ever retried: a command that may
// have started is never run twice.
//
// Each retry is a NEW req_id. The refused one never ran, so there is nothing a fresh id could run twice; and the
// worker dedups Execs by req_id (remote-worker/internal/session/cache.go), so reusing it would let a cached entry,
// should a refusal ever be cached, answer every retry with the same refusal rather than admit it again. A fresh id
// also keeps each attempt a distinct Exec in the relay's and the worker's records. cur follows it, so a signal aborts
// the Exec in flight.
func call(ctx context.Context, c pb.SandboxExecClient, cfg config, id uint64, op, command string, stdin []byte, stdout, stderr io.Writer, env callEnv) int {
	started := env.now()
	var waited time.Duration
	attempt := 1
	attemptStart := started   // each attempt's own start, for its refused record; the clock is read once per event
	notices := noticeDedupe{} // each lease event is printed once in this run, even when a retry repeats it
	env.cur.Store(id)
	for {
		// Each attempt caps its own timeout to what the token has left at its start (capTimeout): a retry after a
		// wait has less of the token left than the first attempt had.
		acfg := cfg
		var capped bool
		acfg.timeoutS, capped = capTimeout(cfg.token, cfg.timeoutS, attemptStart)
		r, err := execOnce(ctx, c, acfg, id, command, stdin)
		if len(r.leases) > 0 {
			printNotices(stderr, notices, r.leases, env.now())
		}
		var f *execFailure
		if err != nil && errors.As(err, &f) && f.refused != "" && cfg.busyRetry > 0 && ctx.Err() == nil {
			next := env.jitter(busyBackoff(attempt))
			if left := cfg.busyRetry - waited; next > left {
				next = left
			}
			if next < 100*time.Millisecond {
				fmt.Fprintf(stderr, "sbx: %s: nothing ran; gave up after %d attempts / %ds\n", f.refused, attempt, int(waited.Round(time.Second)/time.Second))
				logCall(cfg.logPath, op, started, env.now(), exitRefused, logExtra{attempt: attempt, refused: f.refused, reason: f.reason, busyWait: &waited})
				return exitRefused
			}
			logCall(cfg.logPath, op, attemptStart, env.now(), exitRefused, logExtra{attempt: attempt, refused: f.refused, reason: f.reason})
			fmt.Fprintf(stderr, "sbx: %s: nothing ran; retrying in %.1fs (attempt %d)\n", f.refused, next.Seconds(), attempt+1)
			if err := env.sleep(ctx, next); err != nil {
				fmt.Fprintln(stderr, "sbx: interrupted while waiting to retry; nothing ran")
				logCall(cfg.logPath, op, started, env.now(), exitInterrupted, logExtra{attempt: attempt, busyWait: &waited})
				return exitInterrupted
			}
			waited += next
			attemptStart = env.now()
			attempt++
			id = env.newID()
			env.cur.Store(id)
			continue
		}
		code := outcome(r, err, acfg.timeoutS, capped, stdout, stderr)
		logCall(cfg.logPath, op, started, env.now(), code, logExtra{attempt: attempt, busyWait: &waited})
		return code
	}
}

// outcome writes a finished (or failed) Exec's output and returns its exit code: 125 (exitFailed) for a failure,
// whose message goes to stderr; else the output, then the timeout-capped line when capped, and 124 (exitTimedOut)
// for a command that ran out of timeoutS (the output so far is written), 128 + n for one killed by signal n (an
// exit code of -n), or the command's own code.
func outcome(r result, err error, timeoutS uint32, capped bool, stdout, stderr io.Writer) int {
	if err != nil {
		fmt.Fprintf(stderr, "sbx: %s\n", err.Error())
		return exitFailed
	}
	_, _ = stdout.Write(r.stdout)
	_, _ = stderr.Write(r.stderr)
	if capped {
		fmt.Fprintf(stderr, "sbx: timeout capped at %d s, the sandbox token's lifetime minus 60 s\n", timeoutS)
	}
	if r.truncated {
		fmt.Fprintln(stderr, "sbx: stdout exceeded 8 MiB and was cut")
	}
	switch {
	case r.timedOut:
		fmt.Fprintf(stderr, "sbx: command timed out after %d s\n", timeoutS)
		return exitTimedOut
	case r.exitCode < 0:
		return 128 - int(r.exitCode) // killed by signal n: 128 + n, as sbx.py
	}
	return int(r.exitCode)
}

// logExtra is what a record carries besides sbx.py's {t, op, ms, exit}. Added for the busy retry, with these keys:
//   - "attempt": the Exec's attempt number, from 1 (every record);
//   - "refused", "reason": a capacity refusal's class (refusalClass) and its text, sanitized and cut to 300
//     characters (a refused attempt's record; also the final one when the retries ran out);
//   - "busy_wait_ms": the total slept between retries, 0 when none (the FINAL record of a call only, so a reader
//     tells a call's one final record from its refused attempts' records by this key).
//
// A refused attempt's record has ms for that attempt alone and exit 75; the final record's ms spans the whole call,
// the waits included.
type logExtra struct {
	attempt         int
	refused, reason string
	busyWait        *time.Duration
}

// logCall appends sbx.py's SBX_LOG record, {t, op, ms, exit} plus logExtra's keys, with t in epoch seconds at the end.
func logCall(path, op string, started, ended time.Time, code int, x logExtra) {
	if path == "" {
		return
	}
	rec := struct {
		T          float64 `json:"t"`
		Op         string  `json:"op"`
		Ms         int64   `json:"ms"`
		Exit       int     `json:"exit"`
		Attempt    int     `json:"attempt,omitempty"`
		Refused    string  `json:"refused,omitempty"`
		Reason     string  `json:"reason,omitempty"`
		BusyWaitMs *int64  `json:"busy_wait_ms,omitempty"`
	}{T: float64(ended.UnixNano()) / 1e9, Op: op, Ms: ended.Sub(started).Round(time.Millisecond).Milliseconds(), Exit: code,
		Attempt: x.attempt, Refused: x.refused, Reason: sanitizeReason(x.reason)}
	if x.busyWait != nil {
		ms := x.busyWait.Round(time.Millisecond).Milliseconds()
		rec.BusyWaitMs = &ms
	}
	line, _ := json.Marshal(rec)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
}

// sanitizeReason keeps a refusal's text printable and short for the log: control characters become spaces, and it
// is cut to 300 characters.
func sanitizeReason(s string) string {
	out := []rune(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s))
	if len(out) > 300 {
		out = append(out[:300], '…')
	}
	return string(out)
}

// quote is sbx.py's single-quote shell quoting.
func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// stdin modes: `sbx run` with no arguments runs stdin as the script; `sbx put` sends stdin as the
// file's bytes; everything else reads no stdin.
const (
	noStdin = iota
	stdinIsScript
	stdinIsData
)

// parse maps argv to (op, command, stdin mode), or an exit code when there is nothing to run:
// the help text exits 0 for -h and 2 without arguments, as sbx.py's does.
func parse(args []string) (op, command string, mode int, exit int, ok bool) {
	if len(args) == 0 {
		return "", "", noStdin, 2, false
	}
	switch cmd, rest := args[0], args[1:]; {
	case cmd == "-h" || cmd == "--help":
		return "", "", noStdin, 0, false
	case cmd == "run" && len(rest) == 0:
		return "run", "", stdinIsScript, 0, true
	case cmd == "run":
		return "run", strings.Join(rest, " "), noStdin, 0, true
	case cmd == "put" && len(rest) == 1:
		q := quote(rest[0])
		return "put", fmt.Sprintf(`mkdir -p "$(dirname -- %s)" && cat > %s`, q, q), stdinIsData, 0, true
	case cmd == "pull" && len(rest) == 0:
		return "pull", pull, noStdin, 0, true
	}
	return "", "", noStdin, 2, false
}

// dial keeps the Python client's 16 MiB receive limit; the worker cuts stdout at 8 MiB. Plaintext unless the
// config asks for TLS (SBX0's exec Route); with TLS, the server is verified against the system roots plus the
// config's extra CA, and its name against the address's host. With a dial address the connection goes to that
// ip:port with no lookup, while the TLS server name and the :authority stay SBX_ADDR's.
func dial(c config) (*grpc.ClientConn, error) {
	creds, err := transportCreds(c)
	if err != nil {
		return nil, err
	}
	opts := append(grpcOpts(), grpc.WithTransportCredentials(creds))
	if c.dialAddr == "" {
		return grpc.NewClient(c.addr, opts...)
	}
	// grpc-go refuses an authority that differs from the TLS server name, which is the host without its port
	return grpc.NewClient("passthrough:///"+c.dialAddr, append(opts, grpc.WithAuthority(serverName(c.addr)))...)
}

// serverName is the address's host, the name a TLS server certificate is verified against.
func serverName(addr string) string {
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
}

func transportCreds(c config) (credentials.TransportCredentials, error) {
	if !c.tls {
		return insecure.NewCredentials(), nil
	}
	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		roots = x509.NewCertPool() // no system pool on this platform: the extra CA alone, still verified
	}
	if len(c.caPEM) > 0 && !roots.AppendCertsFromPEM(c.caPEM) {
		return nil, errors.New("SBX_CA_FILE holds no PEM certificate")
	}
	return credentials.NewTLS(&tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12, ServerName: serverName(c.addr)}), nil
}
