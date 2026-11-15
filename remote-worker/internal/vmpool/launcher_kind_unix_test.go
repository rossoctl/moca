//go:build unix

package vmpool

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"path/filepath"
	"strings"
	"testing"

	ga "github.com/rossoctl/moca/remote-worker/internal/guestagent"
	"github.com/rossoctl/moca/remote-worker/internal/shortdir"
)

// fakeVsockGuest is a hybrid-vsock socket that answers one CONNECT, records the request
// frame the host sends, and ends the command at once. It returns the socket path and the
// recorded request.
func fakeVsockGuest(t *testing.T) (string, <-chan ga.Request) {
	t.Helper()
	path := filepath.Join(shortdir.New(t, "sh-vk-", len("/v.sock")), "v.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	got := make(chan ga.Request, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		br := bufio.NewReader(c)
		if line, err := br.ReadString('\n'); err != nil || !strings.HasPrefix(line, "CONNECT ") {
			return
		}
		if _, err := fmt.Fprint(c, "OK 1073741824\n"); err != nil {
			return
		}
		kind, payload, err := ga.ReadFrame(br)
		if err != nil || kind != ga.KindRequest {
			return
		}
		var req ga.Request
		if err := json.Unmarshal(payload, &req); err != nil {
			return
		}
		for {
			k, _, err := ga.ReadFrame(br)
			if err != nil {
				return
			}
			if k == ga.KindStdinEOF {
				break
			}
		}
		got <- req
		end, _ := json.Marshal(ga.End{})
		_ = ga.WriteFrame(c, ga.KindEnd, end)
	}()
	return path, got
}

// TestProcessKindsAreSentUnwrapped is ruling P5-R34 (Task 11 fix round 1, item 2): each
// launcher sends a process kind's command to the guest exactly as given -- the guest runs
// process_start's command as `bash -c CMD` after the shim's fchdir, so a wrapper would make
// the reported pid a wrapper's, an OOM read exited(137), and its `cd /workspace` override
// the requested cwd -- while a command kind keeps its launcher's wrapper exactly as before.
func TestProcessKindsAreSentUnwrapped(t *testing.T) {
	type arm struct {
		name string
		wrap func(string) string
		run  func(path string, c Command) (Result, error)
	}
	arms := []arm{
		{"firecracker", wrapCommand, func(path string, c Command) (Result, error) {
			v := &firecrackerVM{id: "vm-kind", vsockHostPath: path, vsockPort: 1024}
			return v.Run(context.Background(), c, discardingSink{})
		}},
		{"cloud-hypervisor", chvWrapCommand, func(path string, c Command) (Result, error) {
			v := &chvVM{id: "vm-kind", vsockSock: path, vsockPort: 1024}
			return v.Run(context.Background(), c, discardingSink{})
		}},
	}
	for _, a := range arms {
		for _, tc := range []struct {
			kind    ExecKind
			command string
			want    func(string) string
		}{
			{ExecKindCommand, "echo hi", a.wrap},
			{ExecKindProcessStart, "exec sleep 600", func(s string) string { return s }},
			{ExecKindProcessList, "", func(s string) string { return s }},
			{ExecKindProcessLogs, "", func(s string) string { return s }},
			{ExecKindProcessStop, "", func(s string) string { return s }},
			{execKindProcessStopAll, "", func(s string) string { return s }},
		} {
			t.Run(a.name+"/"+tc.kind.String(), func(t *testing.T) {
				path, got := fakeVsockGuest(t)
				c := Command{Command: tc.command, Lease: true, TimeoutS: 30, CapBytes: OutputCapBytes, Kind: tc.kind}
				if tc.kind == ExecKindProcessStart {
					c.Process, c.MaxProcesses = ProcessArgs{Name: "web", Cwd: "sub"}, 4
				}
				if _, err := a.run(path, c); err != nil {
					t.Fatalf("Run: %v", err)
				}
				req := <-got
				if want := tc.want(tc.command); req.Command != want {
					t.Fatalf("the guest was sent command %q, want %q", req.Command, want)
				}
				if tc.kind != ExecKindCommand && req.Kind != string(tc.kind) {
					t.Fatalf("the guest was sent kind %q, want %q", req.Kind, tc.kind)
				}
				if tc.kind == ExecKindProcessStart && (req.Process == nil || req.Process.Cwd != "sub" || req.Process.Name != "web") {
					t.Fatalf("process_start's arguments reached the guest as %+v, want name web, cwd sub", req.Process)
				}
			})
		}
	}
}
