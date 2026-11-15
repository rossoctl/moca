// Package guestagent is the framed protocol spoken over vsock between the host
// (vmpool) and the in-guest agent, plus the agent that serves it.
//
// LENGTH-PREFIXED REQUEST, EXPLICIT RESPONSE CARRYING THE EXIT CODE. Firecracker
// documents that "some vsock packet loss should be anticipated" for resumed guests
// (spec §2.4), so the protocol cannot infer success from a closed connection: a
// missing or short response is an error, counted, never coerced into a zero exit over
// truncated output (spec §5.4).
//
// Frame layout, both directions:
//
//	byte 0     kind
//	bytes 1-4  payload length, big-endian uint32, <= MaxFrame
//	bytes 5..  payload
package guestagent

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// MaxFrame bounds one frame's payload. It equals wexec.ChunkSize (32 KiB), so one
// guest chunk maps to exactly one Chunk frame on the relay wire with no re-framing —
// and so a corrupt or hostile length prefix cannot make either side allocate
// arbitrarily. The guest runs attacker-influenced code by construction, so the HOST
// side of this bound is load-bearing.
const MaxFrame = 32 * 1024

// Kind tags a frame. Host-to-guest kinds are 0x0*, guest-to-host 0x1*, so a
// misdirected frame is obvious in a log rather than silently plausible.
type Kind uint8

const (
	KindRequest  Kind = 0x01 // payload: JSON Request
	KindStdin    Kind = 0x02 // payload: raw stdin bytes; may be split across frames
	KindStdinEOF Kind = 0x03 // payload: empty. `base64 -d > f` only terminates at EOF

	KindStdout Kind = 0x11
	KindStderr Kind = 0x12
	KindEnd    Kind = 0x13 // payload: JSON End. The ONLY success signal
	KindError  Kind = 0x14 // payload: UTF-8 message
)

// Request is one command to run in this VM. There is exactly one per connection,
// because there is exactly one per VM.
type Request struct {
	Command   string `json:"command"`
	TimeoutS  uint32 `json:"timeout_s"`
	Streaming bool   `json:"streaming"`
	// CapBytes bounds EACH stream. Applied here, in the guest, rather than on the
	// host: spec §4.1 prefers capping at source over moving 8 MiB across vsock and
	// discarding it.
	CapBytes int64 `json:"cap_bytes"`
	HasStdin bool  `json:"has_stdin"`
	// HostUnixNanos is the host's wall clock at dispatch. The guest's clock resumes
	// from the SNAPSHOT moment (spec §2.4), so without this every VM serves a stale
	// wall clock and `date`, file mtimes and git commit timestamps are wrong in every
	// VM. Spec §5.3 asks for this via a VMM config field; no such field exists in
	// Firecracker's API, and the guest is the only place that can call clock_settime —
	// see Spec Deviation 5.
	HostUnixNanos int64 `json:"host_unix_nanos"`
	// Lease marks a request that keeps the VM for a later command rather than
	// ending it. omitempty: a request without it stays byte-identical to today's.
	Lease bool `json:"lease,omitempty"`
	// NormaliseWorkspace asks the guest to normalise the workspace before the
	// command runs. omitempty for the same compatibility reason as Lease.
	NormaliseWorkspace bool `json:"normalise_workspace,omitempty"`
	// Kind is what the request asks for: a command (empty or RequestKindCommand) or
	// one of the tracked-process kinds. omitempty, so an old host's request is
	// byte-identical. An old agent ignores the field and would run Command, so the
	// host sends a process kind only to a snapshot that advertises lease-processes-v1.
	Kind string `json:"kind,omitempty"`
	// Process carries a process kind's arguments. For process_start the command stays
	// in Command.
	Process *ProcessArgs `json:"process,omitempty"`
	// MaxProcesses is the host's SH_LEASE_MAX_PROCESSES, sent on process_start: the
	// cap on running tracked processes.
	MaxProcesses int `json:"max_processes,omitempty"`
}

// Request kinds. RequestKindProcessStopAll is host-only: the worker sends it on a
// downgrade, and no tool maps to it.
const (
	RequestKindCommand        = "command"
	RequestKindProcessStart   = "process_start"
	RequestKindProcessList    = "process_list"
	RequestKindProcessLogs    = "process_logs"
	RequestKindProcessStop    = "process_stop"
	RequestKindProcessStopAll = "process_stop_all"
)

// ProcessArgs are a process kind's arguments (spec §7). Which apply depends on the
// kind: Name and Cwd for process_start, ID or Name for logs and stop, Tail for logs,
// Signal for stop.
type ProcessArgs struct {
	Name   string `json:"name,omitempty"`
	ID     string `json:"id,omitempty"`
	Cwd    string `json:"cwd,omitempty"`
	Tail   int    `json:"tail,omitempty"`
	Signal string `json:"signal,omitempty"`
}

// TrackedProcess is one entry of the agent's tracked-process table, as End carries
// it. Code is the exit code when State is TrackedExited and the signal number when it
// is TrackedKilled.
type TrackedProcess struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	PID           int    `json:"pid"`
	State         string `json:"state"`
	Code          int    `json:"code"`
	StartedUnixMs int64  `json:"started_unix_ms"`
	MemoryBytes   int64  `json:"memory_bytes"`
}

// Tracked-process states: running, exited(code) or killed(signal) (spec §7).
const (
	TrackedRunning = "running"
	TrackedExited  = "exited"
	TrackedKilled  = "killed"
)

// End is the terminal success frame. Dropped counts are bytes the guest threw away at
// CapBytes, PER STREAM — the two caps are independent and only stdout's overflow is a
// truncation the harness seam can express.
type End struct {
	ExitCode      int32 `json:"exit_code"`
	DroppedStdout int64 `json:"dropped_stdout"`
	DroppedStderr int64 `json:"dropped_stderr"`
	// TeardownFailed reports that the guest could not tear down the command's state
	// after it exited. omitempty: a clean teardown adds no key.
	TeardownFailed bool `json:"teardown_failed,omitempty"`
	// Tracked is the agent's whole tracked-process table, on every lease End, so the
	// host's mirror of it is never stale. omitempty: an empty table adds no key.
	Tracked []TrackedProcess `json:"tracked,omitempty"`
}

func WriteFrame(w io.Writer, k Kind, payload []byte) error {
	if len(payload) > MaxFrame {
		return fmt.Errorf("guestagent: frame too large: %d > %d", len(payload), MaxFrame)
	}
	var hdr [5]byte
	hdr[0] = byte(k)
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	_, err := w.Write(payload)
	return err
}

// ReadFrame reads one frame. io.EOF is returned only for a clean boundary — a header
// that arrives and is then cut short is io.ErrUnexpectedEOF, which the caller must
// treat as a short response rather than as a normal end of stream.
func ReadFrame(r io.Reader) (Kind, []byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > MaxFrame {
		return 0, nil, fmt.Errorf("guestagent: frame too large: %d > %d", n, MaxFrame)
	}
	if n == 0 {
		return Kind(hdr[0]), nil, nil
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(r, p); err != nil {
		return 0, nil, fmt.Errorf("guestagent: short payload (%d promised): %w", n, err)
	}
	return Kind(hdr[0]), p, nil
}

func WriteJSON(w io.Writer, k Kind, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return WriteFrame(w, k, b)
}

func DecodeJSON(p []byte, v any) error { return json.Unmarshal(p, v) }

// TimeoutMessage is the KindError payload the agent sends when a command's own timeout
// fired, the command having been killed first. On a lease Exec the host keeps the lease
// when this arrives (vmpool's runLease), so it has this one format.
func TimeoutMessage(timeoutS uint32) string {
	return "timeout:" + strconv.FormatUint(uint64(timeoutS), 10)
}

// IsTimeoutMessage reports whether a KindError payload is a TimeoutMessage.
func IsTimeoutMessage(msg string) bool {
	n, ok := strings.CutPrefix(msg, "timeout:")
	if !ok || n == "" {
		return false
	}
	_, err := strconv.ParseUint(n, 10, 32)
	return err == nil
}
