package vmpool

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	ga "github.com/rossoctl/moca/remote-worker/internal/guestagent"
)

// Level 2 in the pool (plan 5, Task 5): process-kind routing, the tracked mirror, process
// lists on lease events and status, and the lease_process audit records.

// processFeatures is a level-2 snapshot's manifest features.
var processFeatures = []string{FeatureLeaseV1, FeatureLeaseProcessesV1}

// processPool is leasePool on a snapshot advertising lease-processes-v1.
func processPool(t *testing.T) (*pool, *leaseLauncher, *fakeClock) {
	t.Helper()
	return leasePool(t, func(c *Config) { c.ManifestFeatures = processFeatures })
}

// processPoolOn is leasePoolOn on a level-2 snapshot: a second process over the same disk.
func processPoolOn(t *testing.T, root string, clk *fakeClock) (*pool, *leaseLauncher) {
	t.Helper()
	plentyOfHostMemory(t)
	lc := newLeaseLauncher()
	p, err := New(Config{
		VMM:               lc.Kind(),
		SnapshotDir:       t.TempDir(),
		WorkspaceRoot:     root,
		MaxRuns:           16,
		MaxCommittedBytes: 32 << 30,
		ManifestFeatures:  processFeatures,
	}, lc, clk)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p.(*pool), lc
}

func level2Exec(cmd string, epoch uint64) Exec {
	return Exec{Command: cmd, TimeoutS: 30, Mode: ModeLeaseProcesses, ModeEpoch: epoch}
}

func processExec(kind ExecKind, args ProcessArgs, epoch uint64) Exec {
	e := level2Exec("", epoch)
	e.Kind, e.Process = kind, args
	return e
}

// fakeTable is a guest's tracked table as the fake VM reports it on every lease End.
type fakeTable struct {
	mu   sync.Mutex
	rows []TrackedProcess
}

func (f *fakeTable) set(rows ...TrackedProcess) {
	f.mu.Lock()
	f.rows = slices.Clone(rows)
	f.mu.Unlock()
}

func (f *fakeTable) get() []TrackedProcess {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.rows)
}

// reportTable makes every lease Run answer End with tab's rows.
func reportTable(lc *leaseLauncher, tab *fakeTable) {
	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
		return Result{Tracked: tab.get()}, nil
	})
}

func running(id, name string, pid int, started time.Time) TrackedProcess {
	return TrackedProcess{ID: id, Name: name, PID: pid, State: "running", Started: started, MemoryBytes: 4 << 20}
}

// wire is err as the client sees it.
func wire(err error) string {
	if err == nil {
		return ""
	}
	return wireError(err).Error()
}

// Review Focus 5: a process kind on a snapshot without lease-processes-v1 is refused
// lease_unsupported before anything reaches the guest -- an old agent would run it as a
// command. Nothing is restored, nothing runs, no epoch is stored.
func TestProcessKindRefusedWithoutFeature(t *testing.T) {
	p, lc, _ := leasePool(t, nil) // lease-v1 only
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	for _, k := range []ExecKind{ExecKindProcessStart, ExecKindProcessList, ExecKindProcessLogs, ExecKindProcessStop} {
		e := processExec(k, ProcessArgs{Name: "web"}, 1)
		e.Command = "python -m http.server"
		_, err := p.Exec(t.Context(), "k", e, &capturingSink{})
		if got := wire(err); !strings.HasPrefix(got, "lease_unsupported: ") || !strings.Contains(got, FeatureLeaseProcessesV1) {
			t.Fatalf("%s on a lease-v1 snapshot: err = %q, want lease_unsupported naming %s", k, got, FeatureLeaseProcessesV1)
		}
		if ReasonOf(err) != RefuseLeaseUnsupported {
			t.Fatalf("%s: ReasonOf = %q, want %q", k, ReasonOf(err), RefuseLeaseUnsupported)
		}
	}
	if n := lc.count("restore "); n != 0 {
		t.Fatalf("restores = %d, want none", n)
	}
	if n := lc.count("run "); n != 0 {
		t.Fatalf("runs = %d, want none", n)
	}
	if liveLease(p, "k") != nil {
		t.Fatal("a refused process kind started a lease")
	}

	// An unknown kind is refused the same way on any snapshot, never run as a command.
	q, lq, _ := processPool(t)
	mustSetMode(t, q, "k", ModeLeaseProcesses, 1)
	_, err := q.Exec(t.Context(), "k", processExec("process_frobnicate", ProcessArgs{}, 1), &capturingSink{})
	if got := wire(err); !strings.HasPrefix(got, "lease_unsupported: ") {
		t.Fatalf("unknown kind: err = %q, want lease_unsupported", got)
	}
	if n := lq.count("run "); n != 0 {
		t.Fatalf("unknown kind: runs = %d, want none", n)
	}
}

// A process kind below lease+processes is refused processes_not_enabled: at the Exec's own
// mode, at a served mode lowered by a same-epoch downgrade (under the gate, the lease kept),
// and with an unknown epoch (served per-exec). It never reaches the guest.
func TestProcessKindRefusedBelowLevel2(t *testing.T) {
	p, lc, _ := processPool(t)

	// No stored state: the Exec would be served per-exec.
	_, err := p.Exec(t.Context(), "k", processExec(ExecKindProcessList, ProcessArgs{}, 1), &capturingSink{})
	if got := wire(err); !strings.HasPrefix(got, "processes_not_enabled: ") {
		t.Fatalf("unknown epoch: err = %q, want processes_not_enabled", got)
	}
	if n := pinnedCount(p, "k"); n != 0 {
		t.Fatalf("pins after the refusal = %d, want 0", n)
	}

	// The Exec's own mode is lease.
	mustSetMode(t, p, "k", ModeLease, 1)
	mustExec(t, p, "k", leaseExec("one", 1))
	vm := vmID(leaseAlive(t, p, "after the level-1 Exec").vm)
	e := processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1)
	e.Mode = ModeLease
	_, err = p.Exec(t.Context(), "k", e, &capturingSink{})
	if got := wire(err); !strings.HasPrefix(got, "processes_not_enabled: ") {
		t.Fatalf("mode lease: err = %q, want processes_not_enabled", got)
	}
	if ReasonOf(err) != RefuseProcessesNotEnabled {
		t.Fatalf("ReasonOf = %q, want %q", ReasonOf(err), RefuseProcessesNotEnabled)
	}

	// A lease+processes token at the epoch the sandbox holds at lease: served at lease,
	// checked under the gate, and the lease is kept.
	_, err = p.Exec(t.Context(), "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1), &capturingSink{})
	if got := wire(err); !strings.HasPrefix(got, "processes_not_enabled: ") {
		t.Fatalf("served at lease: err = %q, want processes_not_enabled", got)
	}
	if got := vmID(leaseAlive(t, p, "after the refusals").vm); got != vm {
		t.Fatalf("lease VM = %s, want %s kept", got, vm)
	}
	for _, c := range lc.commands() {
		if c.Kind != ExecKindCommand {
			t.Fatalf("a %s reached the guest", c.Kind)
		}
	}
	if n := lc.count("run "); n != 1 {
		t.Fatalf("runs = %d, want only the level-1 command", n)
	}
	if n := pinnedCount(p, "k"); n != 0 {
		t.Fatalf("pins after the refusals = %d, want 0", n)
	}
}

// No lease without a reason: process_list, process_logs and process_stop with no live lease
// answer an empty list or process_not_found without restoring a VM. process_start starts
// one, as a command does, and carries its arguments and SH_LEASE_MAX_PROCESSES.
func TestProcessListWithoutLeaseStartsNone(t *testing.T) {
	p, lc, _ := processPool(t)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)

	var out capturingSink
	res, err := p.Exec(t.Context(), "k", processExec(ExecKindProcessList, ProcessArgs{}, 1), &out)
	if err != nil || res.ExitCode != 0 || out.out() != "[]" {
		t.Fatalf("process_list: res %+v, out %q, err %v; want exit 0 and []", res, out.out(), err)
	}
	for _, tc := range []struct {
		kind ExecKind
		args ProcessArgs
		want string
	}{
		{ExecKindProcessLogs, ProcessArgs{Name: "web"}, "process_not_found: web"},
		{ExecKindProcessStop, ProcessArgs{ID: "3", Name: "web"}, "process_not_found: 3"},
		{ExecKindProcessStop, ProcessArgs{}, "process_not_found: no id or name given"},
	} {
		_, err := p.Exec(t.Context(), "k", processExec(tc.kind, tc.args, 1), &capturingSink{})
		if got := wire(err); got != tc.want {
			t.Fatalf("%s %+v: err = %q, want %q", tc.kind, tc.args, got, tc.want)
		}
	}
	if n := lc.count("restore "); n != 0 {
		t.Fatalf("restores = %d, want none", n)
	}
	if liveLease(p, "k") != nil || p.LeaseStatus("k").Pending != nil {
		t.Fatal("a process kind with no lease started one")
	}

	e := processExec(ExecKindProcessStart, ProcessArgs{Name: "web", Cwd: "app"}, 1)
	e.Command = "npm run dev"
	mustExec(t, p, "k", e)
	leaseAlive(t, p, "after process_start")
	cmds := lc.commands()
	if len(cmds) != 1 {
		t.Fatalf("Runs = %d, want 1", len(cmds))
	}
	c := cmds[0]
	if c.Kind != ExecKindProcessStart || c.Process != (ProcessArgs{Name: "web", Cwd: "app"}) ||
		c.Command != "npm run dev" || !c.Lease || c.MaxProcesses != DefaultLeaseMaxProcesses {
		t.Fatalf("process_start Command = %+v", c)
	}
}

// The mirror is refreshed from every lease End, the plain command's included, and kept in
// the state file's open lease; an End with an empty table empties it.
func TestMirrorRefreshedFromEnd(t *testing.T) {
	p, lc, clk := processPool(t)
	tab := &fakeTable{}
	reportTable(lc, tab)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)

	web := running("1", "web", 412, clk.Now())
	tab.set(web)
	mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
	if got := leaseAlive(t, p, "after the start").tracked; !slices.Equal(got, []TrackedProcess{web}) {
		t.Fatalf("mirror = %+v, want [web]", got)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Open == nil || !trackedIDsEqual(s.Open.Tracked, "1") {
		t.Fatalf("state file open lease = %+v, want the mirror persisted", s.Open)
	}

	exited := web
	exited.State, exited.Code = "exited", 1
	job := running("2", "p2", 413, clk.Now())
	tab.set(exited, job)
	mustExec(t, p, "k", level2Exec("ls", 1)) // a plain command's End carries the table too
	if got := leaseAlive(t, p, "after the command").tracked; !slices.Equal(got, []TrackedProcess{exited, job}) {
		t.Fatalf("mirror = %+v, want [web exited, p2]", got)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Open == nil || len(s.Open.Tracked) != 2 || s.Open.Tracked[0].State != "exited" {
		t.Fatalf("state file open lease = %+v, want the refreshed mirror", s.Open)
	}

	tab.set()
	mustExec(t, p, "k", level2Exec("ls", 1))
	if got := leaseAlive(t, p, "after the empty End").tracked; len(got) != 0 {
		t.Fatalf("mirror = %+v, want empty", got)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Open == nil || len(s.Open.Tracked) != 0 {
		t.Fatalf("state file open lease = %+v, want an empty mirror", s.Open)
	}
}

func trackedIDsEqual(ps []TrackedProcess, ids ...string) bool {
	if len(ps) != len(ids) {
		return false
	}
	for i := range ps {
		if ps[i].ID != ids[i] {
			return false
		}
	}
	return true
}

// A lease end lists the processes running at the end, `<name> (pid <n>)` (an unnamed one
// as p<id>, ruling P5-R6) with their structured form, and the proto carries both.
func TestLeaseEndListsTrackedProcesses(t *testing.T) {
	logs := captureLog(t)
	p, lc, clk := processPool(t)
	tab := &fakeTable{}
	reportTable(lc, tab)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	started := clk.Now()
	web := running("1", "web", 412, started)
	anon := running("2", "", 413, started) // the guest names it p2; the host does too
	done := TrackedProcess{ID: "3", Name: "build", PID: 414, State: "exited", Code: 0, Started: started}
	tab.set(web, anon, done)
	mustExec(t, p, "k", level2Exec(secretCommand, 1))
	clk.Advance(90 * time.Second)

	if err := p.EndLease("k", LeaseEndReset); err != nil {
		t.Fatalf("EndLease: %v", err)
	}
	ev := p.LeaseStatus("k").Pending
	if ev == nil || ev.Reason != LeaseEndReset {
		t.Fatalf("pending = %+v, want the reset end", ev)
	}
	if want := []string{"web (pid 412)", "p2 (pid 413)"}; !slices.Equal(ev.Processes, want) {
		t.Fatalf("processes = %q, want %q", ev.Processes, want)
	}
	if !trackedIDsEqual(ev.Tracked, "1", "2") {
		t.Fatalf("tracked = %+v, want the two running processes", ev.Tracked)
	}
	// The pending event survives on disk with its lists.
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending == nil || !slices.Equal(s.Pending.Processes, ev.Processes) ||
		!trackedIDsEqual(s.Pending.Tracked, "1", "2") {
		t.Fatalf("state file pending = %+v, want the lists persisted", s.Pending)
	}

	pe := leaseEventProto(ev)
	if !slices.Equal(pe.Processes, ev.Processes) || len(pe.Tracked) != 2 {
		t.Fatalf("proto = %+v, want both lists", pe)
	}
	if tp := pe.Tracked[0]; tp.Id != "1" || tp.Name != "web" || tp.Pid != 412 || tp.State != "running" ||
		tp.AgeMs != 90_000 || tp.MemoryBytes != 4<<20 {
		t.Fatalf("proto tracked[0] = %+v, want web, pid 412, running, age 90 s at the end, 4 MiB", tp)
	}
	if tp := pe.Tracked[1]; tp.Name != "p2" {
		t.Fatalf("proto tracked[1].name = %q, want p2", tp.Name)
	}

	// Spec §4.1: the end's audit record lists the tracked processes, never the command.
	line := ""
	for _, l := range strings.Split(logs.String(), "\n") {
		if strings.Contains(l, "lease end ") {
			line = l
		}
	}
	for _, want := range []string{"reason=reset", "processes=", "1:web:running", "2:p2:running", "3:build:exited(0)"} {
		if !strings.Contains(line, want) {
			t.Fatalf("lease end audit %q lacks %q", line, want)
		}
	}
	if strings.Contains(logs.String(), "hunter2") {
		t.Fatal("an audit line carries the command text")
	}
}

// Review Focus 4: a worker restart while processes run. The worker_restart end lists them,
// from the mirror persisted with the open lease.
func TestWorkerRestartEndListsTrackedProcesses(t *testing.T) {
	root := t.TempDir()
	clk := newFakeClock()
	p1, lc1 := processPoolOn(t, root, clk)
	tab := &fakeTable{}
	reportTable(lc1, tab)
	mustSetMode(t, p1, "k", ModeLeaseProcesses, 1)
	started := clk.Now()
	tab.set(running("1", "web", 412, started), TrackedProcess{ID: "2", Name: "build", PID: 414, State: "exited", Started: started})
	mustExec(t, p1, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
	clk.Advance(30 * time.Second)
	if err := p1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	clk.Advance(30 * time.Second)
	p2, _ := processPoolOn(t, root, clk)
	ev := p2.LeaseStatus("k").Pending
	if ev == nil || ev.Reason != LeaseEndWorkerRestart {
		t.Fatalf("pending after the restart = %+v, want the worker_restart end", ev)
	}
	if want := []string{"web (pid 412)"}; !slices.Equal(ev.Processes, want) {
		t.Fatalf("processes = %q, want %q", ev.Processes, want)
	}
	if !trackedIDsEqual(ev.Tracked, "1") {
		t.Fatalf("tracked = %+v, want web", ev.Tracked)
	}
	if got := leaseEventProto(ev).Tracked[0].AgeMs; got != 60_000 {
		t.Fatalf("age_ms = %d, want 60 s at the restart", got)
	}
}

// LeaseStatus carries the live lease's full tracked table, exited entries with their state
// and code included (P5-R16), and the proto maps it to LeaseStatus.processes with their
// age; a status call's stopped is empty (only a set_mode's downgrade fills it).
func TestLeaseStatusCarriesTracked(t *testing.T) {
	p, lc, clk := processPool(t)
	tab := &fakeTable{}
	reportTable(lc, tab)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	if got := p.LeaseStatus("k").Tracked; got != nil {
		t.Fatalf("tracked without a lease = %+v, want none", got)
	}
	started := clk.Now()
	tab.set(running("1", "web", 412, started), TrackedProcess{ID: "2", Name: "build", PID: 414, State: "exited", Code: 2, Started: started})
	mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
	clk.Advance(5 * time.Second)

	info := p.LeaseStatus("k")
	if !trackedIDsEqual(info.Tracked, "1", "2") {
		t.Fatalf("status tracked = %+v, want the full table: web and the exited build", info.Tracked)
	}
	st, err := Runner{Pool: p}.LeaseControl(context.Background(), "k", pb.LeaseOp_LEASE_OP_STATUS, 0, 0)
	if err != nil {
		t.Fatalf("LeaseControl status: %v", err)
	}
	if len(st.Processes) != 2 {
		t.Fatalf("LeaseStatus.processes = %+v, want web and build", st.Processes)
	}
	if web := st.Processes[0]; web.Name != "web" || web.Pid != 412 || web.State != "running" || web.AgeMs != 5000 {
		t.Fatalf("LeaseStatus.processes[0] = %+v, want web, pid 412, running, 5 s old", web)
	}
	if build := st.Processes[1]; build.Name != "build" || build.State != "exited" || build.Code != 2 {
		t.Fatalf("LeaseStatus.processes[1] = %+v, want build, exited, code 2", build)
	}
	if len(st.Stopped) != 0 {
		t.Fatalf("LeaseStatus.stopped = %+v, want empty", st.Stopped)
	}
}

// Spec §7's audit: one lease_process record each for start, stop and exit, with id, name,
// mode and workspace key, never the command text. An exit is found by diffing the mirror.
func TestProcessExitAudited(t *testing.T) {
	logs := captureLog(t)
	p, lc, clk := processPool(t)
	tab := &fakeTable{}
	reportTable(lc, tab)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	started := clk.Now()
	web := running("1", "web", 412, started)
	api := running("2", "api", 413, started)

	tab.set(web)
	e := processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1)
	e.Command = secretCommand
	mustExec(t, p, "k", e)
	tab.set(web, api)
	e.Process.Name = "api"
	mustExec(t, p, "k", e)

	webDied := web
	webDied.State, webDied.Code = "exited", 3
	tab.set(webDied, api)
	mustExec(t, p, "k", level2Exec(secretCommand, 1)) // web exits on its own: found by the diff

	apiStopped := api
	apiStopped.State, apiStopped.Code = "killed", 15
	tab.set(webDied, apiStopped)
	mustExec(t, p, "k", processExec(ExecKindProcessStop, ProcessArgs{Name: "api"}, 1))
	mustExec(t, p, "k", level2Exec("true", 1)) // nothing changes: no record

	var recs []string
	for _, l := range strings.Split(logs.String(), "\n") {
		if strings.Contains(l, "lease_process ") {
			recs = append(recs, l)
		}
	}
	want := [][]string{
		{"event=start", `workspace_key="k"`, "mode=lease+processes", `id="1"`, `name="web"`, "pid=412"},
		{"event=start", `id="2"`, `name="api"`},
		{"event=exit", `id="1"`, `name="web"`, "state=exited", "code=3"},
		{"event=stop", `id="2"`, `name="api"`, "state=killed", "code=15"},
	}
	if len(recs) != len(want) {
		t.Fatalf("lease_process records = %d, want %d:\n%s", len(recs), len(want), strings.Join(recs, "\n"))
	}
	for i, ws := range want {
		for _, w := range ws {
			if !strings.Contains(recs[i], w) {
				t.Fatalf("record %d %q lacks %q", i, recs[i], w)
			}
		}
	}
	if strings.Contains(logs.String(), "hunter2") {
		t.Fatal("an audit line carries the command text")
	}
}

// Task 3's carry: a guest's process refusal arrives as an error frame, and the lease is
// kept, as for the guest's own timeout. The client gets the bare wire string.
func TestGuestProcessRefusalKeepsTheLease(t *testing.T) {
	p, lc, _ := processPool(t)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	mustExec(t, p, "k", level2Exec("one", 1))
	vm := vmID(leaseAlive(t, p, "after the first Exec").vm)
	for _, msg := range []string{
		"process_not_found: web",
		"process_limit: 4 running (SH_LEASE_MAX_PROCESSES)",
		"process_name_taken: web",
		"process_cwd: /etc: outside the workspace",
		"process_signal: unknown signal FOO",
		"processes_not_enabled: no",
		"lease_unsupported: unknown kind x",
	} {
		lc.setRunFn(func(_ *fakeVM, _ Command, _ Sink) (Result, error) { return Result{}, &guestError{msg: msg} })
		_, err := p.Exec(t.Context(), "k", processExec(ExecKindProcessStop, ProcessArgs{Name: "web"}, 1), &capturingSink{})
		if got := wire(err); got != msg {
			t.Fatalf("err = %q, want the bare %q", got, msg)
		}
		if got := vmID(leaseAlive(t, p, msg).vm); got != vm {
			t.Fatalf("%s: lease VM = %s, want %s kept", msg, got, vm)
		}
	}
	// Any other guest error still ends it.
	lc.setRunFn(func(_ *fakeVM, _ Command, _ Sink) (Result, error) { return Result{}, &guestError{msg: "fork failed"} })
	if _, err := p.Exec(t.Context(), "k", level2Exec("two", 1), &capturingSink{}); !errors.Is(err, ErrGuest) {
		t.Fatalf("err = %v, want the guest error", err)
	}
	if ev := p.LeaseStatus("k").Pending; ev == nil || ev.Reason != LeaseEndAgentDead {
		t.Fatalf("pending = %+v, want agent_dead", ev)
	}
}

// Review minor 1: only a process kind's guest refusal keeps the lease. A command whose
// guest error happens to start with a refusal prefix is a genuine failure: the lease ends
// agent_dead, as for any other guest error.
func TestCommandGuestErrorWithARefusalPrefixEndsTheLease(t *testing.T) {
	p, lc, _ := processPool(t)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	mustExec(t, p, "k", level2Exec("one", 1))
	leaseAlive(t, p, "after the first Exec")
	lc.setRunFn(func(_ *fakeVM, _ Command, _ Sink) (Result, error) {
		return Result{}, &guestError{msg: "process_not_found: web"}
	})
	if _, err := p.Exec(t.Context(), "k", level2Exec("two", 1), &capturingSink{}); !errors.Is(err, ErrGuest) {
		t.Fatalf("err = %v, want the guest error", err)
	}
	if l := liveLease(p, "k"); l != nil {
		t.Fatal("the lease survived a command's guest error")
	}
	if ev := p.LeaseStatus("k").Pending; ev == nil || ev.Reason != LeaseEndAgentDead {
		t.Fatalf("pending = %+v, want agent_dead", ev)
	}
}

// Review minor 2: a process kind served per-exec by a same-epoch downgrade while a lease
// is live (routeExec's endFirst case, which pins the run). The refusal releases that pin
// and ends nothing: the lease stays until the downgrade's own SetMode ends it
// (mode_change) after the Exec in flight.
func TestProcessKindRefusedOnASameEpochDowngradeWithALiveLease(t *testing.T) {
	p, lc, _ := processPool(t)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	entered, release := blockRuns(lc)
	first := execAsync(p, "k", level2Exec("one", 1))
	recvWithin(t, entered, "the first Exec's Run")
	vm := vmID(leaseAlive(t, p, "during the first Exec").vm)
	setMode := make(chan error, 1)
	go func() { setMode <- setModeErr(p, "k", ModePerExec, 1) }() // stored at once, then waits for the gate
	waitForValue(t, `pinnedCount(p, "k")`, func() int { return pinnedCount(p, "k") }, 2)

	_, err := p.Exec(t.Context(), "k", processExec(ExecKindProcessList, ProcessArgs{}, 1), &capturingSink{})
	if got := wire(err); !strings.HasPrefix(got, "processes_not_enabled: ") || !strings.Contains(got, "per-exec") {
		t.Fatalf("err = %q, want processes_not_enabled at per-exec", got)
	}
	if n := pinnedCount(p, "k"); n != 2 {
		t.Fatalf("pins after the refusal = %d, want 2: its own pin released", n)
	}
	if got := vmID(leaseAlive(t, p, "after the refusal").vm); got != vm {
		t.Fatalf("lease VM = %s, want %s: the refusal ended nothing", got, vm)
	}
	if ev := p.LeaseStatus("k").Pending; ev != nil && ev.State == leaseEventEnd {
		t.Fatalf("pending = %+v: the refusal ended the lease", ev)
	}

	close(release)
	for _, errc := range []<-chan error{first, setMode} {
		if err := recvWithin(t, errc, "the first Exec or the SetMode"); err != nil {
			t.Fatalf("%v", err)
		}
	}
	if n := pinnedCount(p, "k"); n != 0 {
		t.Fatalf("pins at the end = %d, want 0", n)
	}
	if ev := p.LeaseStatus("k").Pending; ev == nil || ev.Reason != LeaseEndModeChange {
		t.Fatalf("pending = %+v, want the downgrade's mode_change", ev)
	}
	for _, c := range lc.commands() {
		if c.Kind != ExecKindCommand {
			t.Fatalf("a %s reached the guest", c.Kind)
		}
	}
	if n := lc.count("run "); n != 1 {
		t.Fatalf("runs = %d, want only the first command", n)
	}
}

// process_stop may take ~20 s in the guest (TERM, 10 s, cgroup.kill, the teardown bound),
// so a process kind's host budget is at least ProcessKindMinTimeoutS whatever it asked for.
func TestProcessKindTimeoutFloor(t *testing.T) {
	p, lc, clk := processPool(t)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	mustExec(t, p, "k", level2Exec("one", 1))
	entered, release := blockRuns(lc)
	e := processExec(ExecKindProcessStop, ProcessArgs{Name: "web"}, 1)
	e.TimeoutS = 1
	errc := execAsync(p, "k", e)
	<-entered
	clk.Advance(20 * time.Second)
	select {
	case err := <-errc:
		t.Fatalf("process_stop with timeout_s=1 ended at 20 s: %v", err)
	default:
	}
	close(release)
	if err := <-errc; err != nil {
		t.Fatalf("process_stop: %v", err)
	}
	if c := lc.commands(); c[len(c)-1].TimeoutS < ProcessKindMinTimeoutS {
		t.Fatalf("guest timeout_s = %d, want at least %d", c[len(c)-1].TimeoutS, ProcessKindMinTimeoutS)
	}
}

// PR #814 review: the floor protects the guest's work, which starts only at Run. A
// process_stop that queued 25 s behind another Exec still gets ProcessKindMinTimeoutS from
// its Run: the guest is told the floor, and the host waits the floor plus the slack from
// Run, so a guest taking ~20 s (TERM grace, cgroup.kill) does not end the lease agent_dead.
func TestProcessKindFloorCountsFromRun(t *testing.T) {
	p, lc, clk := processPool(t)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	mustExec(t, p, "k", level2Exec("one", 1))
	entered := make(chan Command, 2)
	release := make(chan struct{})
	stopDone := make(chan struct{})
	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
		entered <- c
		var wait <-chan struct{} = release
		if c.Kind == ExecKindProcessStop {
			wait = stopDone
		}
		select {
		case <-wait:
			return Result{}, nil
		case <-c.ctxDone:
			return Result{}, ErrAborted
		}
	})
	long := execAsync(p, "k", Exec{Command: "long", TimeoutS: 600, Mode: ModeLeaseProcesses, ModeEpoch: 1})
	recvWithin(t, entered, "the long Exec's Run")
	stop := execAsync(p, "k", processExec(ExecKindProcessStop, ProcessArgs{Name: "web"}, 1))
	waitForValue(t, `pinnedCount(p, "k")`, func() int { return pinnedCount(p, "k") }, 2)
	clk.Advance(25 * time.Second) // the stop's 30 s budget is nearly spent at the gate
	close(release)
	if err := recvWithin(t, long, "the long Exec"); err != nil {
		t.Fatalf("the long Exec: %v", err)
	}
	if c := recvWithin(t, entered, "the stop's Run"); c.TimeoutS < ProcessKindMinTimeoutS {
		t.Fatalf("the stop's guest timeout_s = %d after 25 s at the gate, want at least %d from Run", c.TimeoutS, ProcessKindMinTimeoutS)
	}
	// The guest takes ~20 s (TERM, the 10 s grace, cgroup.kill, the teardown bound): past the
	// budget's end plus the slack (13 s from Run), well inside the floor.
	clk.Advance(20 * time.Second)
	select {
	case err := <-stop:
		t.Fatalf("the stop ended 20 s into its Run: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(stopDone)
	if err := recvWithin(t, stop, "the stop"); err != nil {
		t.Fatalf("the stop: %v", err)
	}
	leaseAlive(t, p, "after a stop that ran past its arrival budget")
	// The host still gives up at the floor plus the slack from Run.
	entered2, _ := blockRuns(lc)
	late := execAsync(p, "k", processExec(ExecKindProcessStop, ProcessArgs{Name: "web"}, 1))
	<-entered2
	clk.Advance(time.Duration(ProcessKindMinTimeoutS)*time.Second + LeaseTimeoutSlack)
	if err := recvWithin(t, late, "a stop whose guest never answers"); !errors.Is(err, ErrTimeout) {
		t.Fatalf("a stop whose guest never answers: %v, want ErrTimeout", err)
	}
}

// Task 6: a downgrade from lease+processes stops the tracked processes.

// stopAllGuest makes the fake VM play a level-2 guest: every lease End reports tab, and
// process_stop_all answers as answerStopAll.
func stopAllGuest(lc *leaseLauncher, tab *fakeTable) {
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		if c.Kind == execKindProcessStopAll {
			answerStopAll(tab, out)
		}
		return Result{Tracked: tab.get()}, nil
	})
}

// answerStopAll is the guest's process_stop_all: each running row of tab is killed by TERM
// (signal 15), and their final rows go out on stdout as a JSON array, as the guest answers.
func answerStopAll(tab *fakeTable, out Sink) {
	rows := tab.get()
	stopped := make([]ga.TrackedProcess, 0, len(rows))
	for i := range rows {
		if rows[i].running() {
			rows[i].State, rows[i].Code = "killed", 15
			r := rows[i]
			stopped = append(stopped, ga.TrackedProcess{ID: r.ID, Name: r.DisplayName(), PID: r.PID, State: r.State,
				Code: r.Code, StartedUnixMs: r.Started.UnixMilli(), MemoryBytes: r.MemoryBytes})
		}
	}
	tab.set(rows...)
	b, _ := json.Marshal(stopped)
	out.Stdout(b)
}

func commandKinds(lc *leaseLauncher) []ExecKind {
	var out []ExecKind
	for _, c := range lc.commands() {
		out = append(out, c.Kind)
	}
	return out
}

func auditRecords(logs *lockedBuffer, event string) []string {
	var out []string
	for _, l := range strings.Split(logs.String(), "\n") {
		if strings.Contains(l, "lease_process event="+event+" ") {
			out = append(out, l)
		}
	}
	return out
}

// A set_mode downgrade lease+processes -> lease sends process_stop_all to the guest under
// the gate and keeps the lease, now at level 1. The set_mode's status lists what was
// stopped in LeaseStatus.stopped, in that answer only (P5-R19); each stopped process gets
// a lease_process stop record. With nothing running the stop-all is still sent, for what
// exited processes left, and stopped is empty.
func TestDowngradeStopsTrackedKeepsLease(t *testing.T) {
	logs := captureLog(t)
	p, lc, clk := processPool(t)
	tab := &fakeTable{}
	stopAllGuest(lc, tab)
	r := Runner{Pool: p}
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	started := clk.Now()
	tab.set(running("1", "web", 412, started), running("2", "", 413, started),
		TrackedProcess{ID: "3", Name: "build", PID: 414, State: "exited", Started: started})
	mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
	vm := vmID(leaseAlive(t, p, "after the start").vm)
	clk.Advance(time.Minute)

	st, err := r.LeaseControl(t.Context(), "k", pb.LeaseOp_LEASE_OP_SET_MODE, pb.SandboxMode_SANDBOX_MODE_LEASE, 2)
	if err != nil {
		t.Fatalf("LeaseControl set_mode lease: %v", err)
	}
	if got, want := commandKinds(lc), []ExecKind{ExecKindProcessStart, execKindProcessStopAll}; !slices.Equal(got, want) {
		t.Fatalf("guest requests = %q, want %q", got, want)
	}
	if c := lc.commands()[1]; !c.Lease || c.TimeoutS < ProcessKindMinTimeoutS {
		t.Fatalf("stop-all command = %+v, want a lease request with timeout_s >= %d", c, ProcessKindMinTimeoutS)
	}
	if len(st.Stopped) != 2 {
		t.Fatalf("LeaseStatus.stopped = %+v, want web and p2", st.Stopped)
	}
	if web := st.Stopped[0]; web.Id != "1" || web.Name != "web" || web.Pid != 412 || web.State != "killed" ||
		web.Code != 15 || web.AgeMs != 60_000 {
		t.Fatalf("stopped[0] = %+v, want web, pid 412, killed(15), 60 s old", web)
	}
	if anon := st.Stopped[1]; anon.Name != "p2" || anon.State != "killed" {
		t.Fatalf("stopped[1] = %+v, want p2 killed", anon)
	}
	if st.Mode != pb.SandboxMode_SANDBOX_MODE_LEASE || st.State != LeaseActive || len(st.Processes) != 3 {
		t.Fatalf("status = %+v, want lease, active, the full table of 3", st)
	}

	l := leaseAlive(t, p, "after the downgrade")
	if got := vmID(l.vm); got != vm || lc.count("restore ") != 1 {
		t.Fatalf("lease VM = %s (restores %d), want %s kept", got, lc.count("restore "), vm)
	}
	if l.mode != ModeLease {
		t.Fatalf("lease mode = %s, want lease", l.mode)
	}
	if run := runningTracked(leaseAlive(t, p, "the mirror").tracked); run != nil {
		t.Fatalf("mirror running = %+v, want none: refreshed from the stop-all's End", run)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Open == nil || s.Open.Mode != ModeLease ||
		len(runningTracked(s.Open.Tracked)) != 0 {
		t.Fatalf("state file open lease = %+v, want level 1 with nothing running", s.Open)
	}
	if ev := p.LeaseStatus("k").Pending; ev == nil || ev.State != leaseEventStart {
		t.Fatalf("pending = %+v, want the start, no end", ev)
	}
	again, err := r.LeaseControl(t.Context(), "k", pb.LeaseOp_LEASE_OP_STATUS, 0, 0)
	if err != nil {
		t.Fatalf("LeaseControl status: %v", err)
	}
	if len(again.Stopped) != 0 {
		t.Fatalf("a later status's stopped = %+v, want empty: the list is the set_mode answer's only", again.Stopped)
	}

	stops := auditRecords(logs, "stop")
	if len(stops) != 2 {
		t.Fatalf("stop records = %q, want one each for web and p2", stops)
	}
	for i, ws := range [][]string{
		{`id="1"`, `name="web"`, "pid=412", "state=killed", "code=15", "mode=lease+processes", `workspace_key="k"`},
		{`id="2"`, `name="p2"`, "state=killed"},
	} {
		for _, w := range ws {
			if !strings.Contains(stops[i], w) {
				t.Fatalf("stop record %q lacks %q", stops[i], w)
			}
		}
	}

	// Back to level 2 (an upgrade, by the next Exec's epoch), nothing running, down again:
	// the stop-all is still sent, and nothing is listed.
	mustSetMode(t, p, "k", ModeLeaseProcesses, 3)
	mustExec(t, p, "k", level2Exec("ls", 3))
	stopped, err := p.SetMode("k", ModeLease, 4)
	if err != nil {
		t.Fatalf("SetMode lease: %v", err)
	}
	if len(stopped) != 0 {
		t.Fatalf("stopped = %+v, want none: nothing was running", stopped)
	}
	if n := slices.Index(commandKinds(lc)[2:], execKindProcessStopAll); n < 0 {
		t.Fatalf("guest requests = %q, want a second process_stop_all", commandKinds(lc))
	}
	if got := vmID(leaseAlive(t, p, "after the second downgrade").vm); got != vm {
		t.Fatalf("lease VM = %s, want %s kept", got, vm)
	}
}

// A stop-all whose guest teardown failed, or whose guest call failed outright, ends the
// lease teardown_failed (P5-R19). The end lists the processes the mirror shows running,
// and set_mode's status carries no stopped list.
func TestDowngradeStopAllTeardownFailedEndsLease(t *testing.T) {
	for _, tc := range []struct {
		name   string
		answer func(tab *fakeTable) (Result, error)
	}{
		{"teardown failed", func(tab *fakeTable) (Result, error) { return Result{TeardownFailed: true, Tracked: tab.get()}, nil }},
		{"guest call failed", func(*fakeTable) (Result, error) { return Result{}, errors.New("vsock: connection reset by peer") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, lc, clk := processPool(t)
			tab := &fakeTable{}
			lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
				if c.Kind == execKindProcessStopAll {
					return tc.answer(tab)
				}
				return Result{Tracked: tab.get()}, nil
			})
			mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
			started := clk.Now()
			tab.set(running("1", "web", 412, started), TrackedProcess{ID: "2", Name: "build", PID: 414, State: "exited", Started: started})
			mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))

			st, err := Runner{Pool: p}.LeaseControl(t.Context(), "k", pb.LeaseOp_LEASE_OP_SET_MODE, pb.SandboxMode_SANDBOX_MODE_LEASE, 2)
			if err != nil {
				t.Fatalf("LeaseControl set_mode lease: %v", err)
			}
			if got := commandKinds(lc); len(got) != 2 || got[1] != execKindProcessStopAll {
				t.Fatalf("guest requests = %q, want the start, then process_stop_all", got)
			}
			leaseEnded(t, p, lc, LeaseEndTeardownFailed)
			if len(st.Stopped) != 0 {
				t.Fatalf("LeaseStatus.stopped = %+v, want none", st.Stopped)
			}
			ev := st.Pending
			if ev == nil || ev.State != leaseEventEnd || ev.Reason != string(LeaseEndTeardownFailed) {
				t.Fatalf("status pending = %+v, want the teardown_failed end", ev)
			}
			if want := []string{"web (pid 412)"}; !slices.Equal(ev.Processes, want) || len(ev.Tracked) != 1 || ev.Tracked[0].Id != "1" {
				t.Fatalf("end processes = %q, tracked %+v; want %q from the mirror", ev.Processes, ev.Tracked, want)
			}
			if st.Mode != pb.SandboxMode_SANDBOX_MODE_LEASE || st.State != LeaseNone {
				t.Fatalf("status = %+v, want mode lease, no lease", st)
			}
		})
	}
}

// A downgrade whose LeaseControl was lost lands on the next Exec carrying the new epoch
// (ruling R18): that Exec sends process_stop_all before its own Run, the lease is kept,
// and its response carries a processes_stopped event listing what was stopped. Like
// expiring, that event is never acknowledged nor stored as the pending one (P5-R19): the
// pending start rides beside it and is acknowledged as before, and the next Exec carries
// no processes_stopped and sends no second stop-all.
//
// Subtests (review minors 2-3): a stop-all that fails on the Exec path ends the lease
// teardown_failed, and the Exec runs in a fresh lease, its response carrying that end and
// no processes_stopped; with nothing running, the stop-all is still sent and the response
// carries no processes_stopped.
func TestExecRelevelStopsTrackedAndNotifies(t *testing.T) {
	t.Run("stops and notifies", testExecRelevelStopsAndNotifies)
	t.Run("a failing stop-all ends the lease and the Exec runs in a fresh one", testExecRelevelStopAllFails)
	t.Run("nothing running: no notice", testExecRelevelNothingRunning)
}

func testExecRelevelStopAllFails(t *testing.T) {
	p, lc, clk := processPool(t)
	tab := &fakeTable{}
	lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
		if c.Kind == execKindProcessStopAll {
			res := Result{TeardownFailed: true, Tracked: tab.get()} // web still running
			tab.set()                                               // the next guest is a fresh one
			return res, nil
		}
		return Result{Tracked: tab.get()}, nil
	})
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	tab.set(running("1", "web", 412, clk.Now()))
	mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
	vm := vmID(leaseAlive(t, p, "after the start").vm)

	sink := newLeaseSink()
	if _, err := (Runner{Pool: p}).Run(t.Context(), leaseSpec(1, 2), sink); err != nil {
		t.Fatalf("Run: %v, want the Exec to run in a fresh lease", err)
	}
	if got, want := commandKinds(lc), []ExecKind{ExecKindProcessStart, execKindProcessStopAll, ExecKindCommand}; !slices.Equal(got, want) {
		t.Fatalf("guest requests = %q, want %q", got, want)
	}
	l := leaseAlive(t, p, "after the Exec")
	if got := vmID(l.vm); got == vm || lc.count("restore ") != 2 || l.mode != ModeLease {
		t.Fatalf("lease = %s at %s (restores %d), want a fresh lease at lease, not %s", got, l.mode, lc.count("restore "), vm)
	}
	evs := sink.got()
	if len(evs) != 1 || evs[0].GetState() != leaseEventEnd || evs[0].GetReason() != string(LeaseEndTeardownFailed) {
		t.Fatalf("events = %v, want only the teardown_failed end", evs)
	}
	if want := []string{"web (pid 412)"}; !slices.Equal(evs[0].GetProcesses(), want) {
		t.Fatalf("end processes = %q, want %q", evs[0].GetProcesses(), want)
	}
	if st := p.Stats(); st.LeaseEnds[LeaseEndTeardownFailed] != 1 || leaseEndTotal(st) != 1 {
		t.Fatalf("LeaseEnds = %v, want exactly one teardown_failed", st.LeaseEnds)
	}
}

func testExecRelevelNothingRunning(t *testing.T) {
	p, lc, clk := processPool(t)
	tab := &fakeTable{}
	stopAllGuest(lc, tab)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	tab.set(TrackedProcess{ID: "1", Name: "build", PID: 414, State: "exited", Started: clk.Now()})
	mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "build"}, 1))
	vm := vmID(leaseAlive(t, p, "after the start").vm)

	sink := newLeaseSink()
	if _, err := (Runner{Pool: p}).Run(t.Context(), leaseSpec(1, 2), sink); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got, want := commandKinds(lc), []ExecKind{ExecKindProcessStart, execKindProcessStopAll, ExecKindCommand}; !slices.Equal(got, want) {
		t.Fatalf("guest requests = %q, want %q: the stop-all is sent with nothing running", got, want)
	}
	for _, ev := range sink.got() {
		if ev.GetState() == leaseEventProcessesStopped {
			t.Fatalf("events carry %+v, want no processes_stopped: nothing was stopped", ev)
		}
	}
	if got := vmID(leaseAlive(t, p, "after the relevel").vm); got != vm {
		t.Fatalf("lease VM = %s, want %s kept", got, vm)
	}
}

func testExecRelevelStopsAndNotifies(t *testing.T) {
	logs := captureLog(t)
	p, lc, clk := processPool(t)
	tab := &fakeTable{}
	stopAllGuest(lc, tab)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	tab.set(running("1", "web", 412, clk.Now()))
	mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1)) // the start stays pending
	vm := vmID(leaseAlive(t, p, "after the start").vm)
	clk.Advance(2 * time.Minute)

	r := Runner{Pool: p}
	sink := newLeaseSink()
	if _, err := r.Run(t.Context(), leaseSpec(1, 2), sink); err != nil { // lease, at the downgrade's epoch 2
		t.Fatalf("Run: %v", err)
	}
	if got, want := commandKinds(lc), []ExecKind{ExecKindProcessStart, execKindProcessStopAll, ExecKindCommand}; !slices.Equal(got, want) {
		t.Fatalf("guest requests = %q, want %q: the stop-all before the Exec's own Run", got, want)
	}
	evs := sink.got()
	if len(evs) != 2 || evs[0].GetState() != leaseEventStart {
		t.Fatalf("events = %v, want the pending start, then processes_stopped", evs)
	}
	ev := evs[1]
	if ev.GetState() != "processes_stopped" || ev.GetReason() != string(LeaseEndModeChange) ||
		ev.GetMode() != pb.SandboxMode_SANDBOX_MODE_LEASE || ev.GetAtUnixMs() != clk.Now().UnixMilli() ||
		ev.GetAgeMs() != 120_000 {
		t.Fatalf("event = %+v, want processes_stopped, mode_change, mode lease, now, 2 min old", ev)
	}
	if want := []string{"web (pid 412)"}; !slices.Equal(ev.GetProcesses(), want) {
		t.Fatalf("processes = %q, want %q", ev.GetProcesses(), want)
	}
	if tr := ev.GetTracked(); len(tr) != 1 || tr[0].GetId() != "1" || tr[0].GetState() != "killed" || tr[0].GetCode() != 15 {
		t.Fatalf("tracked = %+v, want web killed(15)", tr)
	}
	if got := p.LeaseStatus("k").Pending; got != nil {
		t.Fatalf("pending = %+v, want none: the start was acknowledged and processes_stopped is never stored", got)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending != nil {
		t.Fatalf("state file pending = %+v, want none", s.Pending)
	}
	l := leaseAlive(t, p, "after the relevel")
	if got := vmID(l.vm); got != vm || l.mode != ModeLease {
		t.Fatalf("lease = %s at %s, want %s kept at lease", got, l.mode, vm)
	}
	if stops := auditRecords(logs, "stop"); len(stops) != 1 || !strings.Contains(stops[0], `id="1"`) {
		t.Fatalf("stop records = %q, want one for web", stops)
	}

	for _, ev := range runLease(t, r, leaseSpec(2, 2)) {
		if ev.GetState() == "processes_stopped" {
			t.Fatalf("the next Exec carried %+v: the event is the relevel's Exec's only", ev)
		}
	}
	if n := slices.Index(commandKinds(lc)[2:], execKindProcessStopAll); n >= 0 {
		t.Fatalf("guest requests = %q, want one process_stop_all only", commandKinds(lc))
	}
}

// The set_mode downgrade waits for the Exec in flight, as a downgrade to per-exec does: it
// takes the run's gate, pinned meanwhile, and sends process_stop_all only once that Exec
// has returned, so the stop also covers the process the in-flight Exec started.
func TestDowngradeWaitsForInFlightExec(t *testing.T) {
	p, lc, clk := processPool(t)
	tab := &fakeTable{}
	entered, release := make(chan struct{}, 8), make(chan struct{})
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		switch {
		case c.Kind == execKindProcessStopAll:
			answerStopAll(tab, out)
		case c.Command == "long":
			entered <- struct{}{}
			select {
			case <-release:
			case <-c.ctxDone:
				return Result{}, ErrAborted
			}
			tab.set(append(tab.get(), running("2", "api", 413, clk.Now()))...)
		}
		return Result{Tracked: tab.get()}, nil
	})
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	tab.set(running("1", "web", 412, clk.Now()))
	mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
	inFlight := processExec(ExecKindProcessStart, ProcessArgs{Name: "api"}, 1)
	inFlight.Command = "long"
	errc := execAsync(p, "k", inFlight)
	recvWithin(t, entered, "the in-flight Exec's Run")

	type setResult struct {
		stopped []TrackedProcess
		err     error
	}
	setc := make(chan setResult, 1)
	go func() {
		stopped, err := p.SetMode("k", ModeLease, 2)
		setc <- setResult{stopped, err}
	}()
	waitForValue(t, `pinnedCount(p, "k")`, func() int { return pinnedCount(p, "k") }, 2) // the Exec's pin and the downgrade's
	time.Sleep(50 * time.Millisecond)
	select {
	case r := <-setc:
		t.Fatalf("SetMode returned (%+v) while the Exec was in flight", r)
	default:
	}
	if slices.Contains(commandKinds(lc), execKindProcessStopAll) {
		t.Fatal("process_stop_all reached the guest while the Exec was in flight")
	}

	close(release)
	if err := recvWithin(t, errc, "the in-flight Exec"); err != nil {
		t.Fatalf("the in-flight Exec: %v, want its own clean result", err)
	}
	res := recvWithin(t, setc, "SetMode")
	if res.err != nil {
		t.Fatalf("SetMode: %v", res.err)
	}
	if !trackedIDsEqual(res.stopped, "1", "2") {
		t.Fatalf("stopped = %+v, want web and the api the in-flight Exec started", res.stopped)
	}
	if got, want := commandKinds(lc), []ExecKind{ExecKindProcessStart, ExecKindProcessStart, execKindProcessStopAll}; !slices.Equal(got, want) {
		t.Fatalf("guest requests = %q, want %q", got, want)
	}
	leaseAlive(t, p, "after the downgrade")
	if n := pinnedCount(p, "k"); n != 0 {
		t.Fatalf("pins at the end = %d, want 0", n)
	}
}

// The starting case, as for a downgrade to per-exec (endLeaseWaiting): a lease Exec that
// passed its checks at lease+processes is still starting its lease (Resume blocked) when
// the downgrade to lease is stored. Its lease starts at level 2 and its process_start
// runs, then the downgrade's wait gets the gate, re-levels the lease and stops what the
// Exec started.
func TestDowngradeStopsALeaseStartedAtLevel2WhileItWaited(t *testing.T) {
	p, lc, clk := processPool(t)
	tab := &fakeTable{}
	stopAllGuest(lc, tab)
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	inResume, resume := make(chan struct{}, 1), make(chan struct{})
	lc.setResumeFn(func(*fakeVM, context.Context) error {
		inResume <- struct{}{}
		<-resume
		return nil
	})
	tab.set(running("1", "web", 412, clk.Now()))
	errc := execAsync(p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
	recvWithin(t, inResume, "the lease start's Resume")

	type setResult struct {
		stopped []TrackedProcess
		err     error
	}
	setc := make(chan setResult, 1)
	go func() {
		stopped, err := p.SetMode("k", ModeLease, 2)
		setc <- setResult{stopped, err}
	}()
	waitForValue(t, `pinnedCount(p, "k")`, func() int { return pinnedCount(p, "k") }, 2)
	close(resume)
	if err := recvWithin(t, errc, "the starting Exec"); err != nil {
		t.Fatalf("the starting Exec: %v", err)
	}
	res := recvWithin(t, setc, "SetMode")
	if res.err != nil || !trackedIDsEqual(res.stopped, "1") {
		t.Fatalf("SetMode = %+v, %v; want web stopped", res.stopped, res.err)
	}
	if got, want := commandKinds(lc), []ExecKind{ExecKindProcessStart, execKindProcessStopAll}; !slices.Equal(got, want) {
		t.Fatalf("guest requests = %q, want %q", got, want)
	}
	if l := leaseAlive(t, p, "after the downgrade"); l.mode != ModeLease {
		t.Fatalf("lease mode = %s, want lease", l.mode)
	}
	if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Open == nil || s.Open.Mode != ModeLease {
		t.Fatalf("state file open lease = %+v, want it recorded at lease", s.Open)
	}
}

// Review Important 1: the set_mode wait cuts the lease at the grace limit only while the
// stop is still owed. Here a lease Exec at the downgrade's epoch, queued before the
// set_mode, gets the gate first and does the stop (P5-R21), then runs past the grace
// limit: the wait returns at the grace point without cutting, the Exec's result is its
// own, and the lease is kept.
func TestDowngradeGraceDoesNotCutAfterAnExecStopped(t *testing.T) {
	p, lc, clk := processPool(t)
	tab := &fakeTable{}
	enteredA, releaseA := make(chan struct{}, 1), make(chan struct{})
	enteredB, releaseB := make(chan struct{}, 1), make(chan struct{})
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		var entered, release chan struct{}
		switch {
		case c.Kind == execKindProcessStopAll:
			answerStopAll(tab, out)
		case c.Command == "a":
			entered, release = enteredA, releaseA
		case c.Command == "b":
			entered, release = enteredB, releaseB
		}
		if entered != nil {
			entered <- struct{}{}
			select {
			case <-release:
			case <-c.ctxDone:
				return Result{}, ErrAborted
			}
		}
		return Result{Tracked: tab.get()}, nil
	})
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	tab.set(running("1", "web", 412, clk.Now()))
	mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
	vm := vmID(leaseAlive(t, p, "after the start").vm)

	errA := execAsync(p, "k", Exec{Command: "a", TimeoutS: MaxExecTimeoutS, Mode: ModeLeaseProcesses, ModeEpoch: 1})
	recvWithin(t, enteredA, "A's Run")
	parked := parkedIn("(*pool).execLease") // any that another test left parked
	errB := execAsync(p, "k", Exec{Command: "b", TimeoutS: MaxExecTimeoutS, Mode: ModeLease, ModeEpoch: 2})
	waitForValue(t, `parkedIn("(*pool).execLease")`, func() int { return parkedIn("(*pool).execLease") }, parked+1) // B queued on the gate
	type setResult struct {
		stopped []TrackedProcess
		err     error
	}
	setc := make(chan setResult, 1)
	deadline := clk.Now().Add(p.cfg.LeaseGraceLimit)
	go func() {
		stopped, err := p.SetMode("k", ModeLease, 2)
		setc <- setResult{stopped, err}
	}()
	waitFor(t, `pinnedCount(p, "k") == 3 && timerArmed(clk, deadline)`, func() bool { return pinnedCount(p, "k") == 3 && timerArmed(clk, deadline) })

	close(releaseA)
	if err := recvWithin(t, errA, "A"); err != nil {
		t.Fatalf("A: %v", err)
	}
	recvWithin(t, enteredB, "B's Run")
	if got, want := commandKinds(lc), []ExecKind{ExecKindProcessStart, ExecKindCommand, execKindProcessStopAll, ExecKindCommand}; !slices.Equal(got, want) {
		t.Fatalf("guest requests = %q, want %q: B did the stop", got, want)
	}

	clk.Advance(p.cfg.LeaseGraceLimit)
	res := recvWithin(t, setc, "SetMode at the grace limit")
	if res.err != nil || len(res.stopped) != 0 {
		t.Fatalf("SetMode = %+v, %v; want (nil, nil): the stop was B's", res.stopped, res.err)
	}
	if c := leaseCut(p, leaseAlive(t, p, "at the grace limit")); c != "" {
		t.Fatalf("lease cut %q at the grace limit, want no cut: nothing was owed", c)
	}
	close(releaseB)
	if err := recvWithin(t, errB, "B"); err != nil {
		t.Fatalf("B: %v, want its own clean result", err)
	}
	if got := vmID(leaseAlive(t, p, "after B").vm); got != vm {
		t.Fatalf("lease VM = %s, want %s kept", got, vm)
	}
	if ev := p.LeaseStatus("k").Pending; ev != nil && ev.State == leaseEventEnd {
		t.Fatalf("pending = %+v, want no end", ev)
	}
	if n := pinnedCount(p, "k"); n != 0 {
		t.Fatalf("pins at the end = %d, want 0", n)
	}
}

// The stop the set_mode owes is bounded by the grace limit, as a downgrade to per-exec's
// end is: a level-2 Exec still in flight then is cut, the lease ends mode_change (which
// stops everything with it), no process_stop_all is sent, and SetMode returns (nil, nil).
func TestDowngradeStopIsBoundedByTheGraceLimit(t *testing.T) {
	p, lc, clk := processPool(t)
	tab := &fakeTable{}
	entered := make(chan struct{}, 1)
	lc.setRunFn(func(_ *fakeVM, c Command, out Sink) (Result, error) {
		switch {
		case c.Kind == execKindProcessStopAll:
			answerStopAll(tab, out)
		case c.Command == "long":
			entered <- struct{}{}
			<-c.ctxDone
			return Result{}, ErrAborted
		}
		return Result{Tracked: tab.get()}, nil
	})
	mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
	tab.set(running("1", "web", 412, clk.Now()))
	mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
	errc := execAsync(p, "k", Exec{Command: "long", TimeoutS: MaxExecTimeoutS, Mode: ModeLeaseProcesses, ModeEpoch: 1})
	recvWithin(t, entered, "the in-flight Exec's Run")

	type setResult struct {
		stopped []TrackedProcess
		err     error
	}
	setc := make(chan setResult, 1)
	deadline := clk.Now().Add(p.cfg.LeaseGraceLimit)
	go func() {
		stopped, err := p.SetMode("k", ModeLease, 2)
		setc <- setResult{stopped, err}
	}()
	waitFor(t, `timerArmed(clk, deadline)`, func() bool { return timerArmed(clk, deadline) })
	clk.Advance(p.cfg.LeaseGraceLimit)

	var le *LeaseEndedError
	if err := recvWithin(t, errc, "the cut Exec"); !errors.As(err, &le) || le.Reason != LeaseEndModeChange {
		t.Fatalf("the in-flight Exec: %v, want lease_ended(mode_change)", err)
	}
	res := recvWithin(t, setc, "SetMode")
	if res.err != nil || res.stopped != nil {
		t.Fatalf("SetMode = %+v, %v; want (nil, nil)", res.stopped, res.err)
	}
	if slices.Contains(commandKinds(lc), execKindProcessStopAll) {
		t.Fatalf("guest requests = %q, want no process_stop_all: the end stopped them", commandKinds(lc))
	}
	leaseEnded(t, p, lc, LeaseEndModeChange)
	if ev := p.LeaseStatus("k").Pending; ev == nil || !slices.Equal(ev.Processes, []string{"web (pid 412)"}) {
		t.Fatalf("pending = %+v, want the mode_change end listing web", ev)
	}
}

// Task 11 fix round 1 (item 2, durability): an Exec's own wrapper syncs at its end, but a
// tracked process writes between Execs, and process kinds are sent unwrapped (P5-R34), so
// a level-2 lease's end syncs the guest before its VM is destroyed: every end whose guest
// may still be alive, the closed pool's detach (worker_restart) included. A level-1 lease
// needs none (nothing outlives an Exec's sync), nor does a guest whose teardown failed. An
// agent_dead end still syncs (ruling P5-R36): it covers the host's own deadline and an abort,
// where the guest usually lives, and a dead agent refuses at once. A sandbox_deleted end
// does not sync (ruling P5-R39).
func TestLevel2LeaseEndSyncsBeforeDestroy(t *testing.T) {
	started := time.Unix(1_700_000_000, 0)
	for _, tc := range []struct {
		name     string
		level2   bool
		end      func(t *testing.T, p *pool, lc *leaseLauncher, tab *fakeTable)
		wantSync bool
	}{
		{"reset", true, func(t *testing.T, p *pool, _ *leaseLauncher, _ *fakeTable) {
			if err := p.EndLease("k", LeaseEndReset); err != nil {
				t.Fatalf("EndLease: %v", err)
			}
		}, true},
		{"mode_change to per-exec", true, func(t *testing.T, p *pool, _ *leaseLauncher, _ *fakeTable) {
			mustSetMode(t, p, "k", ModePerExec, 2)
		}, true},
		{"worker_restart (Close)", true, func(t *testing.T, p *pool, _ *leaseLauncher, _ *fakeTable) {
			if err := p.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}
		}, true},
		{"teardown_failed", true, func(t *testing.T, p *pool, lc *leaseLauncher, tab *fakeTable) {
			lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
				return Result{TeardownFailed: true, Tracked: tab.get()}, nil
			})
			_, _ = p.Exec(t.Context(), "k", level2Exec("ls", 1), &capturingSink{})
		}, false},
		{"agent_dead (a guest error the agent may have survived)", true, func(t *testing.T, p *pool, lc *leaseLauncher, _ *fakeTable) {
			lc.setRunFn(func(_ *fakeVM, c Command, _ Sink) (Result, error) {
				return Result{}, errors.Join(ErrGuest, errors.New("the host's deadline passed"))
			})
			_, _ = p.Exec(t.Context(), "k", level2Exec("ls", 1), &capturingSink{})
		}, true},
		// Ruling P5-R39 (final review M5): the workspace of a deleted sandbox is going away,
		// so its writes need no sync, and the end does not wait on the guest for them.
		{"sandbox_deleted", true, func(t *testing.T, p *pool, _ *leaseLauncher, _ *fakeTable) {
			if err := p.EndLease("k", LeaseEndSandboxDeleted); err != nil {
				t.Fatalf("EndLease: %v", err)
			}
		}, false},
		{"level 1 reset", false, func(t *testing.T, p *pool, _ *leaseLauncher, _ *fakeTable) {
			if err := p.EndLease("k", LeaseEndReset); err != nil {
				t.Fatalf("EndLease: %v", err)
			}
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, lc, _ := processPool(t)
			tab := &fakeTable{}
			reportTable(lc, tab)
			if tc.level2 {
				mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
				tab.set(running("1", "web", 412, started))
				mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
			} else {
				mustSetMode(t, p, "k", ModeLease, 1)
				mustExec(t, p, "k", leaseExec("ls", 1))
			}
			vm := vmID(leaseAlive(t, p, "before the end").vm)
			tc.end(t, p, lc, tab)

			var syncAt, destroyAt = -1, -1
			for i, ev := range lc.eventLog() {
				switch ev {
				case "sync " + vm:
					syncAt = i
				case "destroyed " + vm:
					destroyAt = i
				}
			}
			if destroyAt < 0 {
				t.Fatalf("events %q: the lease VM was not destroyed", lc.eventLog())
			}
			if !tc.wantSync {
				if syncAt >= 0 {
					t.Fatalf("events %q: a sync step, want none", lc.eventLog())
				}
				return
			}
			if syncAt < 0 || syncAt > destroyAt {
				t.Fatalf("events %q: want the sync step before the destroy", lc.eventLog())
			}
			if s := lc.syncCommands(); len(s) != 1 || !s[0].Lease || s[0].Kind != ExecKindCommand || s[0].TimeoutS == 0 {
				t.Fatalf("sync steps %+v, want one bounded lease command", s)
			}
		})
	}
}

// Ruling P5-R38 (final review I1): the mirror learns of an exit only from a lease End, so a
// tracked process that died between calls would be listed as stopped by the end and never
// get its exit record. The level-2 end's sync step answers with the guest's whole table: it
// refreshes the mirror before the end is reported. A process that table shows exited is not
// in the end's stopped list -- in the pending event or on disk -- and gets its lease_process
// exit record, once. The worker_restart detach (Close) refreshes the open lease's mirror
// instead, so the next process's end lists only what was still running.
func TestLeaseEndSyncRefreshesTheMirror(t *testing.T) {
	started := time.Unix(1_700_000_000, 0)
	web := running("1", "web", 412, started)
	api := running("2", "api", 413, started)
	webDied := web
	webDied.State, webDied.Code = "exited", 3

	t.Run("reset", func(t *testing.T) {
		logs := captureLog(t)
		p, lc, _ := processPool(t)
		tab := &fakeTable{}
		reportTable(lc, tab)
		mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
		tab.set(web, api)
		mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "api"}, 1))
		// web dies between calls: only the end's sync step sees it.
		lc.setSyncFn(func(Command) (Result, error) { return Result{Tracked: []TrackedProcess{webDied, api}}, nil })

		if err := p.EndLease("k", LeaseEndReset); err != nil {
			t.Fatalf("EndLease: %v", err)
		}
		ev := p.LeaseStatus("k").Pending
		if ev == nil || ev.Reason != LeaseEndReset {
			t.Fatalf("pending = %+v, want the reset end", ev)
		}
		if want := []string{"api (pid 413)"}; !slices.Equal(ev.Processes, want) || !trackedIDsEqual(ev.Tracked, "2") {
			t.Fatalf("end lists %q / %+v, want only api: web had exited before the end", ev.Processes, ev.Tracked)
		}
		if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending == nil || !s.Pending.At.Equal(ev.At) ||
			!slices.Equal(s.Pending.Processes, ev.Processes) || !trackedIDsEqual(s.Pending.Tracked, "2") {
			t.Fatalf("state file pending = %+v, want the refreshed end persisted", s.Pending)
		}
		exits := auditRecords(logs, "exit")
		if len(exits) != 1 || !strings.Contains(exits[0], `id="1"`) || !strings.Contains(exits[0], "code=3") {
			t.Fatalf("exit records %q, want one for web, exited(3)", exits)
		}
		// The next lease's first Exec delivers it; nothing writes the record again.
		mustExec(t, p, "k", level2Exec("ls", 1))
		if n := len(auditRecords(logs, "exit")); n != 1 {
			t.Fatalf("exit records = %d after the next lease, want still 1", n)
		}
	})

	t.Run("worker_restart", func(t *testing.T) {
		root := t.TempDir()
		clk := newFakeClock()
		p1, lc1 := processPoolOn(t, root, clk)
		tab := &fakeTable{}
		reportTable(lc1, tab)
		mustSetMode(t, p1, "k", ModeLeaseProcesses, 1)
		tab.set(web, api)
		mustExec(t, p1, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "api"}, 1))
		lc1.setSyncFn(func(Command) (Result, error) { return Result{Tracked: []TrackedProcess{webDied, api}}, nil })
		if err := p1.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
		p2, _ := processPoolOn(t, root, clk)
		ev := p2.LeaseStatus("k").Pending
		if ev == nil || ev.Reason != LeaseEndWorkerRestart || !slices.Equal(ev.Processes, []string{"api (pid 413)"}) {
			t.Fatalf("pending after the restart = %+v, want the worker_restart end listing only api", ev)
		}
	})

	// A client that read and acknowledged the end while the sync ran has seen it: the
	// refresh must not bring it back, nor write a second one.
	t.Run("acknowledged during the sync", func(t *testing.T) {
		p, lc, _ := processPool(t)
		tab := &fakeTable{}
		reportTable(lc, tab)
		mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
		tab.set(web)
		mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
		lc.setSyncFn(func(Command) (Result, error) {
			if ev := p.LeaseStatus("k").Pending; ev != nil {
				p.AckLeaseEvent("k", ev.At)
			}
			return Result{Tracked: []TrackedProcess{webDied}}, nil
		})
		if err := p.EndLease("k", LeaseEndReset); err != nil {
			t.Fatalf("EndLease: %v", err)
		}
		if ev := p.LeaseStatus("k").Pending; ev != nil {
			t.Fatalf("pending = %+v, want none: the end was acknowledged during the sync", ev)
		}
		if s := loadLeaseState(p.cfg.WorkspaceRoot, "k"); s.Pending != nil {
			t.Fatalf("state file pending = %+v, want none", s.Pending)
		}
	})

	// A failed sync says nothing about the table: the end keeps what the mirror showed,
	// with no exit record (today's behaviour).
	for name, answer := range map[string]func(Command) (Result, error){
		"sync error": func(Command) (Result, error) {
			return Result{}, errors.Join(ErrGuest, errors.New("vsock: connection reset"))
		},
		"sync exit 1": func(Command) (Result, error) {
			return Result{ExitCode: 1, Tracked: []TrackedProcess{webDied}}, nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			logs := captureLog(t)
			p, lc, _ := processPool(t)
			tab := &fakeTable{}
			reportTable(lc, tab)
			mustSetMode(t, p, "k", ModeLeaseProcesses, 1)
			tab.set(web)
			mustExec(t, p, "k", processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
			lc.setSyncFn(answer)
			if err := p.EndLease("k", LeaseEndReset); err != nil {
				t.Fatalf("EndLease: %v", err)
			}
			ev := p.LeaseStatus("k").Pending
			if ev == nil || !slices.Equal(ev.Processes, []string{"web (pid 412)"}) || !trackedIDsEqual(ev.Tracked, "1") {
				t.Fatalf("pending = %+v, want the end listing web as the mirror had it", ev)
			}
			if exits := auditRecords(logs, "exit"); len(exits) != 0 {
				t.Fatalf("exit records %q, want none after a failed sync", exits)
			}
		})
	}
}

// level2On makes key's lease a level-2 one with web running: an end syncs its guest.
func level2On(t *testing.T, p *pool, lc *leaseLauncher, key string) {
	t.Helper()
	tab := &fakeTable{}
	tab.set(running("1", "web", 412, time.Unix(1_700_000_000, 0)))
	reportTable(lc, tab)
	mustSetMode(t, p, key, ModeLeaseProcesses, 1)
	mustExec(t, p, key, processExec(ExecKindProcessStart, ProcessArgs{Name: "web"}, 1))
}

// syncedBeforeDestroyed reports whether every destroyed VM was synced first.
func syncedBeforeDestroyed(events []string) (synced, destroyed int, ok bool) {
	seen := map[string]bool{}
	ok = true
	for _, ev := range events {
		switch {
		case strings.HasPrefix(ev, "sync "):
			seen[strings.TrimPrefix(ev, "sync ")] = true
			synced++
		case strings.HasPrefix(ev, "destroyed "):
			destroyed++
			if !seen[strings.TrimPrefix(ev, "destroyed ")] {
				ok = false
			}
		}
	}
	return synced, destroyed, ok
}

// PR #814 review: Close syncs the level-2 leases it detaches concurrently, under one overall
// bound (LeaseCloseSyncTimeout, below the units' TimeoutStopSec=30), then destroys them all.
// One wedged guest neither holds Close past the bound nor keeps the others from their sync.
func TestCloseSyncsLeasesConcurrentlyUnderOneBound(t *testing.T) {
	if LeaseCloseSyncTimeout != 20*time.Second || LeaseCloseSyncTimeout >= LeaseEndSyncTimeout {
		t.Fatalf("LeaseCloseSyncTimeout = %s, want 20 s, below TimeoutStopSec=30", LeaseCloseSyncTimeout)
	}
	p, lc, _ := processPool(t)
	keys := []string{"a", "b", "c", "d"}
	for _, k := range keys {
		level2On(t, p, lc, k)
	}
	var calls atomic.Int32
	lc.setSyncFn(func(c Command) (Result, error) {
		if calls.Add(1) == 1 {
			<-c.ctxDone // the wedged guest: it answers nothing until the bound
			return Result{}, ErrAborted
		}
		return Result{}, nil
	})
	p.closeSyncBound = 300 * time.Millisecond
	start := time.Now()
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// A Close that ignored closeSyncBound would wait out LeaseCloseSyncTimeout at least.
	if el := time.Since(start); el >= LeaseCloseSyncTimeout {
		t.Fatalf("Close took %s with one wedged guest: it waited out a default bound, not the %s closeSyncBound", el, p.closeSyncBound)
	}
	synced, destroyed, ok := syncedBeforeDestroyed(lc.eventLog())
	if synced != len(keys) || destroyed != len(keys) || !ok {
		t.Fatalf("events %q: want every lease VM synced, then destroyed", lc.eventLog())
	}
	if lc.liveCount() != 0 {
		t.Fatalf("live VMs after Close = %d, want 0", lc.liveCount())
	}
}

// PR #814 review: a sweep's victims (idle here; memory_reclaim takes the same path) sync in
// parallel, each releasing its gate once its own VM is destroyed. A wedged first guest does
// not hold the others' destroys, nor an Exec waiting on another key's gate.
func TestSweptLeasesSyncInParallel(t *testing.T) {
	p, lc, clk := processPool(t)
	keys := []string{"a", "b", "c"}
	for _, k := range keys {
		level2On(t, p, lc, k)
	}
	wedge := make(chan struct{})
	var unwedge sync.Once
	release := func() { unwedge.Do(func() { close(wedge) }) }
	t.Cleanup(release) // before the pool's Close, which waits for the reclaim goroutine
	var calls atomic.Int32
	lc.setSyncFn(func(c Command) (Result, error) {
		if calls.Add(1) == 1 {
			<-wedge
			return Result{}, ErrAborted
		}
		return Result{}, nil
	})
	clk.Advance(p.cfg.LeaseIdleDefault) // every lease is idle at this tick
	// The keys whose VMs are gone have their gates back (and the sweep's pin dropped) while
	// the wedged one still holds its own: a fresh lease starts at once on them.
	var free string
	waitFor(t, "every victim synced, all but the wedged one destroyed and unpinned", func() bool {
		var released []string
		for _, k := range keys {
			if pinnedCount(p, k) == 0 {
				released = append(released, k)
			}
		}
		if calls.Load() != int32(len(keys)) || lc.liveCount() != 1 || len(released) != len(keys)-1 {
			return false
		}
		free = released[0]
		return true
	})
	reportTable(lc, &fakeTable{})
	errc := execAsync(p, free, level2Exec("ls", 1))
	if err := recvWithin(t, errc, "an Exec on a swept key while another victim's sync is wedged"); err != nil {
		t.Fatalf("Exec on %s: %v", free, err)
	}
	release()
	waitForValue(t, `lc.liveCount()`, func() int { return lc.liveCount() }, 1) // the wedged one, destroyed; free's new lease
}

// PR #814 follow-up review: a sweep batch already queued when Close starts shares Close's
// bound. Its victim's wedged sync is cancelled when the bound passes, so Close does not wait
// a further LeaseEndSyncTimeout for it (past the units' TimeoutStopSec=30).
func TestCloseBoundsAQueuedSweepBatchsSync(t *testing.T) {
	p, lc, clk := processPool(t)
	level2On(t, p, lc, "a")
	lc.setSyncFn(func(c Command) (Result, error) {
		<-c.ctxDone // wedged: answers nothing until its context is cancelled
		return Result{}, ErrAborted
	})
	p.closeSyncBound = 300 * time.Millisecond
	clk.Advance(p.cfg.LeaseIdleDefault) // the lease is idle: its victim is queued for the reclaim goroutine
	waitForValue(t, `len(lc.syncCommands())`, func() int { return len(lc.syncCommands()) }, 1)
	start := time.Now()
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Unbounded by Close, the batch's sync would run its own LeaseEndSyncTimeout, which is longer.
	if el := time.Since(start); el >= LeaseCloseSyncTimeout {
		t.Fatalf("Close took %s with a wedged queued batch: it waited out a default bound, not the %s closeSyncBound", el, p.closeSyncBound)
	}
	if lc.liveCount() != 0 {
		t.Fatalf("live VMs after Close = %d, want 0", lc.liveCount())
	}
}
