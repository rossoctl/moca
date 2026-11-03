// Command worker is the SandboxTransport reference worker (spec §7). It dials the
// relay's SandboxWorker.Attach stream and runs each Exec it receives in a local
// `bash -c`, streaming stdout and stderr back as Chunks and terminating every exec
// with End or ExecError.
//
// It holds no LLM key and performs no orchestration — it only executes commands and
// returns bytes, which is the property that makes the "central brain" trust model
// correct. See DESIGN.md for how to run it against a cluster.
package main

import (
	"context"
	"fmt"
	"log"
	"math/rand/v2"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
	"github.com/rossoctl/moca/remote-worker/internal/session"
)

const (
	backoffMin = 500 * time.Millisecond
	backoffMax = 30 * time.Second
)

// probed is the fixed list checked against PATH for Hello.capabilities. The pool
// will eventually match on these (relay.ts:74 defers it), so they must be true.
var probed = []string{"bash", "rg", "base64", "file", "python3", "git", "gh"}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// envInt falls back to def on anything unparseable or non-positive: a zero pool
// would accept execs and never run them.
func envInt(k string, def int) int {
	v, err := strconv.Atoi(os.Getenv(k))
	if err != nil || v <= 0 {
		return def
	}
	return v
}

// envBool parses a boolean env var and, unlike envInt, does NOT fall back on
// garbage. RELAY_TLS decides whether the bearer token crosses the wire in
// cleartext, so silently reading "true", "yes", "TLS" or "1 " as "plaintext" is
// the wrong failure: the caller log.Fatalf's instead.
func envBool(k string, def bool) (bool, error) {
	v := os.Getenv(k)
	if v == "" {
		return def, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("%s=%q is not a boolean (use 1/0 or true/false)", k, v)
	}
	return b, nil
}

func capabilities() []string {
	var out []string
	for _, c := range probed {
		if _, err := exec.LookPath(c); err == nil {
			out = append(out, c)
		}
	}
	return out
}

// workspaceRunner builds the per-key workspace layer over BashRunner (#408).
// SH_WORKSPACE_ROOT must equal the harness's KAGENTI_SANDBOX_CWD: the harness sends
// <that>/<session id> as every absolute path, and this is where the directory is made.
// SH_WORKSPACE_IDLE is the microVM worker's knob with the same meaning and default: the
// only trigger that deletes a session's workspace (#338). Garbage is an error rather than
// a fallback, since a misread idle can delete a waiting session's work.
func workspaceRunner(get func(string) string) (*wexec.WorkspaceRunner, error) {
	w := &wexec.WorkspaceRunner{
		Root: wexec.DefaultWorkspaceRoot,
		Idle: wexec.DefaultWorkspaceIdle,
		// SH_EXEC_TIMING=1: one `exec-timing` log line per Exec (wall time, CPU), for
		// benchmarks that break a turn's time down by tool call. Off unless set to exactly 1.
		Inner: wexec.BashRunner{Timing: get("SH_EXEC_TIMING") == "1"},
	}
	if v := get("SH_WORKSPACE_ROOT"); v != "" {
		if !filepath.IsAbs(v) {
			return nil, fmt.Errorf("SH_WORKSPACE_ROOT=%q must be an absolute path", v)
		}
		w.Root = v
	}
	if v := get("SH_WORKSPACE_IDLE"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return nil, fmt.Errorf("SH_WORKSPACE_IDLE=%q must be a positive Go duration such as 8h or 90m", v)
		}
		w.Idle = d
	}
	return w, nil
}

// sweepInterval checks often enough that a workspace outlives its idle by at most a
// quarter of it, and at least once a minute.
func sweepInterval(idle time.Duration) time.Duration {
	return max(min(idle/4, time.Minute), time.Second)
}

// tokenSource returns how the worker gets its relay bearer token, called before every dial.
//
// With SANDBOX_TOKEN_FILE set, the token is that file's contents (surrounding whitespace trimmed),
// re-read on every dial and reconnect: a workload's attach token is a mounted Secret that the
// kubelet refreshes in place when the provisioner re-mints it (workload sandboxes spec §3.1).
// rotateWhenIdle reconnects with the new one at an idle moment; the relay's close at the old
// token's exp is the backstop.
// Unset, it is SANDBOX_TOKEN (default "dev-token"), read once, exactly as before.
func tokenSource(get func(string) string, readFile func(string) ([]byte, error)) func() (string, error) {
	path := get("SANDBOX_TOKEN_FILE")
	if path == "" {
		token := get("SANDBOX_TOKEN")
		if token == "" {
			token = "dev-token"
		}
		return func() (string, error) { return token, nil }
	}
	return func() (string, error) {
		b, err := readFile(path)
		if err != nil {
			return "", fmt.Errorf("SANDBOX_TOKEN_FILE: %w", err)
		}
		token := strings.TrimSpace(string(b))
		if token == "" {
			return "", fmt.Errorf("SANDBOX_TOKEN_FILE: %s is empty", path)
		}
		return token, nil
	}
}

// retryLine is the log line before a reconnect wait. A token file that cannot be read gets its own
// line: no stream ended, and the fix is the file, not the relay.
func retryLine(tokenErr, streamErr error, wait time.Duration) string {
	w := wait.Round(time.Millisecond)
	if tokenErr != nil {
		return fmt.Sprintf("worker: cannot read %v; retrying in %s", tokenErr, w)
	}
	return fmt.Sprintf("worker: stream ended (%v); reconnecting in %s", streamErr, w)
}

// attachOnce is one pass of the reconnect loop: read the token, attach, and serve until the
// stream ends. It returns the token error and the stream error apart, and how long a session
// lasted (zero when none started). A failed token read never reaches attach or serve.
func attachOnce(
	ctx context.Context,
	token func() (string, error),
	attach func(context.Context) (pb.SandboxWorker_AttachClient, error),
	serve func(context.Context, pb.SandboxWorker_AttachClient) error,
) (tokenErr, err error, lasted time.Duration) {
	// Re-read before every dial, so a rotated token file is picked up on the next reconnect.
	// A read that fails after boot backs off and retries like a failed dial.
	bearer, tokenErr := token()
	if tokenErr != nil {
		return tokenErr, nil, 0
	}
	attachCtx := metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+bearer)
	stream, err := attach(attachCtx)
	if err != nil {
		return nil, err, 0
	}
	log.Printf("worker: attached, serving execs")
	// Serve gets attachCtx — the very context this stream was created from,
	// which is its documented precondition: recvLoop blocks in Recv() and is
	// unblocked only by the stream being torn down. attachCtx derives from
	// the caller's ctx, which main cancels on SIGTERM.
	start := time.Now()
	err = serve(attachCtx, stream)
	return nil, err, time.Since(start)
}

// rotationPoll is how often an attached worker re-reads SANDBOX_TOKEN_FILE for a rotated token.
// The provisioner re-mints with half the token's lifetime left, so this needs no precision.
const rotationPoll = 10 * time.Second

// rotateWhenIdle wraps attach so that, once the token file holds a different token from the one a
// stream attached with, the stream is ended at the first moment no Exec is in flight (workload
// sandboxes spec §3.1). The loop then re-dials with the new token, well before the relay's hard
// close at the old token's exp. A file that cannot be read keeps the stream: the redial would fail
// on it too.
//
// The cancel is on the stream's OWN context, which is what tears a stream down (Serve's
// precondition); attachOnce's ctx is its parent, so SIGTERM still reaches it.
func rotateWhenIdle(
	attach func(context.Context) (pb.SandboxWorker_AttachClient, error),
	token func() (string, error),
	idle func() bool,
	every time.Duration,
) func(context.Context) (pb.SandboxWorker_AttachClient, error) {
	return func(ctx context.Context) (pb.SandboxWorker_AttachClient, error) {
		var bearer string
		if md, ok := metadata.FromOutgoingContext(ctx); ok {
			if v := md.Get("authorization"); len(v) == 1 {
				bearer = strings.TrimPrefix(v[0], "Bearer ")
			}
		}
		streamCtx, cancel := context.WithCancel(ctx)
		st, err := attach(streamCtx)
		if err != nil || st == nil {
			cancel()
			return st, err
		}
		go func() {
			defer cancel()
			t := time.NewTicker(every)
			defer t.Stop()
			rotated := false
			for {
				select {
				case <-st.Context().Done():
					return
				case <-t.C:
				}
				if !rotated {
					next, err := token()
					rotated = err == nil && next != bearer
					if rotated {
						log.Printf("worker: the token file changed; reconnecting at the next idle moment")
					}
				}
				if rotated && idle() {
					log.Printf("worker: idle; reconnecting with the rotated token")
					return
				}
			}
		}()
		return st, nil
	}
}

func nextBackoff(d time.Duration) time.Duration { return min(d*2, backoffMax) }

// jitter spreads reconnects so a relay restart does not get a synchronized herd.
func jitter(d time.Duration) time.Duration {
	return d + time.Duration(rand.Int64N(int64(d/2)+1))
}

func main() {
	relayAddr := env("RELAY_ADDR", "localhost:8443")
	token := tokenSource(os.Getenv, os.ReadFile)
	// A token file that cannot be read at boot is a misconfiguration: fail loudly, as for RELAY_TLS.
	if _, err := token(); err != nil {
		log.Fatalf("%v", err)
	}
	useTLS, tlsErr := envBool("RELAY_TLS", false)
	if tlsErr != nil {
		// Fail loudly rather than guessing: guessing wrong here ships the bearer
		// token in cleartext.
		log.Fatalf("%v", tlsErr)
	}

	cfg := session.Config{
		SandboxID: env("SANDBOX_ID", "sbx-laptop-1"),
		Image:     env("SANDBOX_IMAGE", ""),
		Trust:     env("SANDBOX_TRUST", "untrusted"),
		// The PATH probe, plus the one behaviour the harness keys on: the per-session
		// workspace directory (wexec.WorkspaceCapability).
		Capabilities:  append(capabilities(), wexec.WorkspaceCapability),
		MaxConcurrent: envInt("WORKER_MAX_CONCURRENT", session.DefaultConcurrency),
		Labels:        session.TierLabels(os.LookupEnv, "container"),
	}

	// Plaintext h2c for an in-cluster ClusterIP or an `oc port-forward` tunnel;
	// TLS for a relay exposed on :443 (spec §9 mode A).
	creds, credsErr := session.TransportCredentials(useTLS, env("RELAY_CA_FILE", ""))
	if credsErr != nil {
		log.Fatalf("%v", credsErr)
	}

	// Keepalive is what bounds a half-open connection. recvLoop blocks in
	// st.Recv() with no ctx select, so without HTTP/2 pings a dead-but-unclosed
	// TCP connection wedges the worker permanently: Serve never returns, the
	// reconnect loop below never runs, and once outbound fills behind a Send that
	// will never complete every pool goroutine parks in enqueue — the worker stays
	// alive and registered while answering nothing. These params bound that to
	// ~40s (Time + Timeout) instead of TCP retransmit exhaustion.
	//
	// The params themselves, and the raised receive limit that travels with them, now
	// live in session.DialOptions so the contract tests dial exactly as production
	// does — an unapplied option is indistinguishable from an absent one otherwise
	// (#173 item 2).
	conn, err := grpc.NewClient(relayAddr, session.DialOptions(creds)...)
	if err != nil {
		log.Fatalf("dial %s: %v", relayAddr, err)
	}
	defer conn.Close()
	client := pb.NewSandboxWorkerClient(conn)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sig; log.Println("signal received, shutting down"); cancel() }()

	runner, wsErr := workspaceRunner(os.Getenv)
	if wsErr != nil {
		log.Fatalf("%v", wsErr)
	}
	go runner.SweepEvery(ctx, sweepInterval(runner.Idle))

	// One Session across every connection: its dedup cache must survive reconnects,
	// or a redelivered req_id re-runs the command (spec §5).
	sess := session.New(cfg, runner)
	log.Printf("worker: relay=%s sandbox_id=%s tls=%v capacity=%d caps=%v labels=%v workspace_root=%s workspace_idle=%s",
		relayAddr, cfg.SandboxID, useTLS, cfg.MaxConcurrent, cfg.Capabilities, cfg.Labels,
		runner.Root, runner.Idle)

	attach := func(c context.Context) (pb.SandboxWorker_AttachClient, error) { return client.Attach(c) }
	// Only a token file rotates; SANDBOX_TOKEN is read once.
	if os.Getenv("SANDBOX_TOKEN_FILE") != "" {
		attach = rotateWhenIdle(attach, token, sess.Idle, rotationPoll)
	}

	backoff := backoffMin
	for ctx.Err() == nil {
		tokenErr, err, lasted := attachOnce(ctx, token, attach,
			func(c context.Context, st pb.SandboxWorker_AttachClient) error { return sess.Serve(c, st) })
		// Reset on a session that actually LASTED, not merely on Attach
		// returning a stream. Attach succeeds before the relay has authorized
		// anything: with a wrong SANDBOX_TOKEN the stream opens, Hello goes out,
		// and Recv then fails with Unauthenticated. Resetting on the stream
		// alone pinned backoff at its ~500-750ms floor forever, so a
		// misconfigured worker hammered the relay ~2x/second with no escalating
		// signal. A session that survives 30s was doing real work; anything
		// shorter keeps escalating toward backoffMax.
		if lasted > 30*time.Second {
			backoff = backoffMin
		}
		if ctx.Err() != nil {
			break
		}
		wait := jitter(backoff)
		log.Print(retryLine(tokenErr, err, wait))
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
		backoff = nextBackoff(backoff)
	}
	log.Println("worker: stopped")
}
