package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"google.golang.org/grpc"
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
Optional: SBX_TIMEOUT (seconds per command, default 600), SBX_LOG (append one JSON line per call).
` + "`sbx run`" + ` exits with the command's own exit code; 124 means it timed out, 125 that the sandbox failed.
There is no ` + "`sbx push`" + `: this client is for a workspace seeded on the server side.
`

// pull is sbx.py's PULL, byte for byte, so a patch collected either way is the same diff.
const pull = "cd /workspace && git add -A -N . && git diff --binary HEAD"

// config is everything a call needs besides the command; read once from the environment.
type config struct {
	addr, sandboxID, key, token string
	timeoutS                    uint32
	logPath                     string
}

func configFrom(getenv func(string) string, readFile func(string) ([]byte, error)) (config, error) {
	c := config{
		addr:      getenv("SBX_ADDR"),
		sandboxID: getenv("SBX_SANDBOX_ID"),
		key:       getenv("SBX_WORKSPACE_KEY"),
		token:     getenv("SBX_TOKEN"),
		logPath:   getenv("SBX_LOG"),
		timeoutS:  600,
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
	if s := getenv("SBX_TIMEOUT"); s != "" {
		var n uint32
		if _, err := fmt.Sscanf(s, "%d", &n); err != nil || n == 0 {
			return c, fmt.Errorf("SBX_TIMEOUT must be a positive integer, got %q", s)
		}
		c.timeoutS = n
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
}

// execOnce runs one command. An error is the machinery failing (VM boot, worker gone, a timeout,
// a refused token), never the command's own exit status, which comes back in result.
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
		return result{}, rpcErr(err)
	}
	var r result
	for {
		ev, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return result{}, errors.New("exec failed: the stream ended without an End event")
		}
		if err != nil {
			return result{}, rpcErr(err)
		}
		switch {
		case ev.GetChunk() != nil:
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
			return result{}, fmt.Errorf("exec failed: %s", ev.GetError().GetMessage())
		}
	}
}

func rpcErr(err error) error {
	if s, ok := status.FromError(err); ok {
		return fmt.Errorf("exec failed: %s: %s", upperSnake(s.Code().String()), s.Message())
	}
	return fmt.Errorf("exec failed: %v", err)
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

// call runs one command and turns its outcome into the process's exit code, writing output and
// the SBX_LOG line the way sbx.py does: 124 for a timeout, 125 for any other sandbox failure,
// 137 for a command killed by a signal (a negative exit code), else the command's own code.
func callID(ctx context.Context, c pb.SandboxExecClient, cfg config, id uint64, op, command string, stdin []byte, stdout, stderr io.Writer, now func() time.Time) int {
	started := now()
	r, err := execOnce(ctx, c, cfg, id, command, stdin)
	var code int
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "timeout:") {
			code = 124
			fmt.Fprintln(stderr, "sbx: command timed out")
		} else {
			code = 125
			fmt.Fprintf(stderr, "sbx: %s\n", msg)
		}
	} else {
		_, _ = stdout.Write(r.stdout)
		_, _ = stderr.Write(r.stderr)
		if r.truncated {
			fmt.Fprintln(stderr, "sbx: stdout exceeded 8 MiB and was cut")
		}
		code = int(r.exitCode)
		if code < 0 {
			code = 128 + 9
		}
	}
	logCall(cfg.logPath, op, started, now(), code)
	return code
}

// logCall appends sbx.py's SBX_LOG record, {t, op, ms, exit}, with t in epoch seconds at the end.
func logCall(path, op string, started, ended time.Time, code int) {
	if path == "" {
		return
	}
	line, _ := json.Marshal(struct {
		T    float64 `json:"t"`
		Op   string  `json:"op"`
		Ms   int64   `json:"ms"`
		Exit int     `json:"exit"`
	}{float64(ended.UnixNano()) / 1e9, op, ended.Sub(started).Round(time.Millisecond).Milliseconds(), code})
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
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

// dial keeps the Python client's 16 MiB receive limit; the worker cuts stdout at 8 MiB.
func dial(addr string) (*grpc.ClientConn, error) {
	return grpc.NewClient(addr, grpcOpts()...)
}
