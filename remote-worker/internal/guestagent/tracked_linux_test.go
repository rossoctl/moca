//go:build linux

package guestagent

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Level 2's root tests: tracked processes (process_start, list, logs, stop, stop_all).
// They run on newLeaseAgent (lease_linux_test.go) and need root and cgroup v2.

// The tracked uids of the default range (global constraints).
const (
	trackedUID0 = 20000
	trackedUID1 = 20001
)

func procReq(kind string, args ProcessArgs) Request {
	return Request{Lease: true, Kind: kind, Process: &args, CapBytes: 1 << 20}
}

// startedProcess is process_start's stdout.
type startedProcess struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	PID  int    `json:"pid"`
}

// startProc runs process_start and returns its result; maxProcs 0 sends none.
func startProc(t *testing.T, a *Agent, name, cmd string, maxProcs int) startedProcess {
	t.Helper()
	p, errMsg := tryStartProc(t, a, ProcessArgs{Name: name}, cmd, maxProcs)
	if errMsg != "" {
		t.Fatalf("process_start %q (%s): %s", name, cmd, errMsg)
	}
	return p
}

func tryStartProc(t *testing.T, a *Agent, args ProcessArgs, cmd string, maxProcs int) (startedProcess, string) {
	t.Helper()
	req := procReq(RequestKindProcessStart, args)
	req.Command, req.MaxProcesses = cmd, maxProcs
	out, stderr, end, errMsg := drive(t, a, req, nil)
	if errMsg != "" {
		return startedProcess{}, errMsg
	}
	var p startedProcess
	if err := json.Unmarshal([]byte(out), &p); err != nil || p.ID == "" || p.PID <= 0 {
		t.Fatalf("process_start stdout %q (stderr %q): %v; want {id,name,pid}", out, stderr, err)
	}
	if !slices.ContainsFunc(end.Tracked, func(tp TrackedProcess) bool { return tp.ID == p.ID }) {
		t.Fatalf("process_start End.Tracked %+v lacks the new process %s", end.Tracked, p.ID)
	}
	return p, ""
}

func listProcs(t *testing.T, a *Agent) []TrackedProcess {
	t.Helper()
	out, stderr, end, errMsg := drive(t, a, procReq(RequestKindProcessList, ProcessArgs{}), nil)
	if errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("process_list: end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	var ps []TrackedProcess
	if err := json.Unmarshal([]byte(out), &ps); err != nil || ps == nil {
		t.Fatalf("process_list stdout %q: %v; want a JSON array", out, err)
	}
	return ps
}

func procByID(ps []TrackedProcess, id string) (TrackedProcess, bool) {
	for _, p := range ps {
		if p.ID == id {
			return p, true
		}
	}
	return TrackedProcess{}, false
}

// waitProcExit polls process_list until id is no longer running.
func waitProcExit(t *testing.T, a *Agent, id string) TrackedProcess {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		p, ok := procByID(listProcs(t, a), id)
		if !ok {
			t.Fatalf("process %s is not in process_list", id)
		}
		if p.State != TrackedRunning {
			return p
		}
		if time.Now().After(deadline) {
			t.Fatalf("process %s still running after 10s", id)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func procLogs(t *testing.T, a *Agent, args ProcessArgs) (string, string) {
	t.Helper()
	out, _, _, errMsg := drive(t, a, procReq(RequestKindProcessLogs, args), nil)
	return out, errMsg
}

// waitLog polls process_logs until the process's log contains want.
func waitLog(t *testing.T, a *Agent, id, want string) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		out, errMsg := procLogs(t, a, ProcessArgs{ID: id, Tail: 10000})
		if errMsg != "" {
			t.Fatalf("process_logs %s: %s", id, errMsg)
		}
		if strings.Contains(out, want) {
			return out
		}
		if time.Now().After(deadline) {
			t.Fatalf("process %s log never showed %q; it is %q", id, want, out)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func stopProc(t *testing.T, a *Agent, args ProcessArgs) TrackedProcess {
	t.Helper()
	out, stderr, end, errMsg := drive(t, a, procReq(RequestKindProcessStop, args), nil)
	if errMsg != "" || end.TeardownFailed {
		t.Fatalf("process_stop %+v: end %+v, err %q, stderr %q", args, end, errMsg, stderr)
	}
	var p TrackedProcess
	if err := json.Unmarshal([]byte(out), &p); err != nil {
		t.Fatalf("process_stop stdout %q: %v", out, err)
	}
	return p
}

// pidAlive reports whether pid is a live process (not gone, not a zombie).
func pidAlive(pid int) bool {
	st, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return false
	}
	i := strings.LastIndexByte(string(st), ')')
	return i >= 0 && !strings.HasPrefix(strings.TrimSpace(string(st[i+1:])), "Z")
}

// waitPidsGone waits until none of pids is alive.
func waitPidsGone(t *testing.T, what string, pids ...int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var alive []int
		for _, p := range pids {
			if pidAlive(p) {
				alive = append(alive, p)
			}
		}
		if len(alive) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: pids %v still alive", what, alive)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// pidsOf returns the pids of procsMatching's results.
func pidsOf(t *testing.T, re *regexp.Regexp, uid int) []int {
	t.Helper()
	var out []int
	for _, p := range procsMatching(t, re, uid) {
		n, _ := strconv.Atoi(strings.SplitN(p, ":", 2)[0])
		out = append(out, n)
	}
	return out
}

// waitPidOf polls until exactly one live process matches re under uid, and returns it.
func waitPidOf(t *testing.T, re *regexp.Regexp, uid int) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if ps := pidsOf(t, re, uid); len(ps) == 1 {
			return ps[0]
		} else if time.Now().After(deadline) {
			t.Fatalf("processes matching %s as uid %d: %v, want exactly one", re, uid, ps)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func cgroupProcs(t *testing.T, dir string) []int {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "cgroup.procs"))
	if err != nil {
		t.Fatalf("read %s/cgroup.procs: %v", dir, err)
	}
	var out []int
	for _, f := range strings.Fields(string(raw)) {
		n, _ := strconv.Atoi(f)
		out = append(out, n)
	}
	return out
}

// A tracked process runs under its own uid, the sbx-ws group, its own HOME (0700, its
// own), in tracked/p<id> with the Exec caps, in its own session, stdin /dev/null,
// umask 0002, and with stdout and stderr in its ring.
func TestProcessStartRunsUnderItsOwnUIDAndCgroup(t *testing.T) {
	a, root := newLeaseAgent(t)
	p := startProc(t, a, "probe", `echo "uid=$(id -u) gid=$(id -g) groups=$(id -G)"; echo "home=$HOME user=$USER"; `+
		`echo "umask=$(umask)"; echo "stdin=$(readlink /proc/self/fd/0)"; echo "pid=$$ sid=$(cut -d' ' -f6 /proc/$$/stat)"; `+
		`echo "cg=$(cat /proc/self/cgroup)"; grep -E '^Sig(Ign|Blk):' /proc/self/status; `+
		`p=$BASHPID; ls /proc/$p/fd >"$HOME/fdl"; echo "fds=$(sort -n "$HOME/fdl" | tr '\n' ' ')"; `+
		`echo to-stderr >&2; echo ready; exec sleep 3001`, 0)
	if p.Name != "probe" {
		t.Errorf("name %q, want probe", p.Name)
	}
	logs := waitLog(t, a, p.ID, "ready")
	home := filepath.Join(trackedHomeParent, "20000")
	if uid, gid, mode := statOwner(t, trackedHomeParent); uid != 0 || gid != 0 || mode&0o7777 != 0o711 {
		t.Errorf("tracked homes %s: %d:%d %o, want root 0711 (ruling P5-R12)", trackedHomeParent, uid, gid, mode&0o7777)
	}
	for _, want := range []string{
		"uid=20000 gid=7000 groups=7000\n", "home=" + home + " user=sbxp0\n", "umask=0002\n", "stdin=/dev/null\n",
		fmt.Sprintf("pid=%d sid=%d\n", p.PID, p.PID), "cg=0::/" + filepath.Base(root) + "/tracked/p" + p.ID + "\n", "to-stderr\n",
		"SigBlk:\t0000000000000000\nSigIgn:\t0000000000000000\n", "fds=0 1 2 \n",
	} {
		if !strings.Contains(logs, want) {
			t.Errorf("logs lack %q:\n%s", want, logs)
		}
	}
	if uid, gid, mode := statOwner(t, home); uid != trackedUID0 || gid != 7000 || mode&0o7777 != 0o700 {
		t.Errorf("home %s: %d:%d %o, want 20000:7000 0700", home, uid, gid, mode&0o7777)
	}
	cg := filepath.Join(root, "tracked", "p"+p.ID)
	memMax, err := execMemoryMax()
	if err != nil {
		t.Fatal(err)
	}
	// The kernel rounds memory.max down to a page.
	page := int64(os.Getpagesize())
	for f, want := range map[string]string{"memory.max": strconv.FormatInt(memMax/page*page, 10), "pids.max": strconv.Itoa(execCgroupPidsMax)} {
		if got, err := os.ReadFile(filepath.Join(cg, f)); err != nil || strings.TrimSpace(string(got)) != want {
			t.Errorf("%s/%s = %q, %v; want %s", cg, f, got, err, want)
		}
	}
	if uid, gid, _ := statOwner(t, cg); uid != 0 || gid != 0 {
		t.Errorf("%s owned by %d:%d, want root: the tracked tree is not delegated", cg, uid, gid)
	}
	ps := listProcs(t, a)
	if len(ps) != 1 || ps[0].ID != p.ID || ps[0].Name != "probe" || ps[0].PID != p.PID || ps[0].State != TrackedRunning ||
		ps[0].MemoryBytes <= 0 || ps[0].StartedUnixMs <= 0 {
		t.Errorf("process_list %+v, want one running probe with its pid and memory", ps)
	}
	stopProc(t, a, ProcessArgs{Name: "probe"})
}

// Spec §3.1: the end-of-Exec kill touches only e<seq>; a tracked process outlives every
// later Exec, and every lease End, a command's included, carries the table.
func TestTrackedSurvivesExecKill(t *testing.T) {
	a, root := newLeaseAgent(t)
	p := startProc(t, a, "sleeper", `exec sleep 3002`, 0)
	for i := range 3 {
		out, stderr, end, errMsg := drive(t, a, leaseReq(`sleep 300 & echo hi`), nil)
		if errMsg != "" || end.ExitCode != 0 || out != "hi\n" {
			t.Fatalf("Exec %d: end %+v, err %q, stdout %q, stderr %q", i, end, errMsg, out, stderr)
		}
		if len(end.Tracked) != 1 || end.Tracked[0].ID != p.ID || end.Tracked[0].State != TrackedRunning || end.Tracked[0].Name != "sleeper" {
			t.Errorf("Exec %d End.Tracked %+v, want the running sleeper", i, end.Tracked)
		}
		if !pidAlive(p.PID) {
			t.Fatalf("the tracked process %d died with Exec %d's teardown", p.PID, i)
		}
		if !slices.Contains(cgroupProcs(t, filepath.Join(root, "tracked", "p"+p.ID)), p.PID) {
			t.Fatalf("pid %d left tracked/p%s", p.PID, p.ID)
		}
	}
	// The Execs' own background sleeps went with their cgroups.
	if left := procsMatching(t, regexp.MustCompile(`^sleep 300$`), 7000); len(left) > 0 {
		t.Errorf("Exec processes survived: %v", left)
	}
}

// Review Focus 1: a tracked process that double-forks a daemon keeps it in its cgroup.
// Execs do not kill it, process_list shows only the original entry, and process_stop
// kills the daemon too.
func TestTrackedDoubleForkStaysInCgroup(t *testing.T) {
	a, root := newLeaseAgent(t)
	p := startProc(t, a, "forker", `( setsid bash -c 'sleep 3011 &' ); exec sleep 3010`, 0)
	daemon := waitPidOf(t, regexp.MustCompile(`^sleep 3011$`), trackedUID0)
	cg := filepath.Join(root, "tracked", "p"+p.ID)
	if procs := cgroupProcs(t, cg); !slices.Contains(procs, daemon) || !slices.Contains(procs, p.PID) {
		t.Fatalf("%s holds %v; want the main %d and the daemon %d", cg, procs, p.PID, daemon)
	}
	if _, _, end, errMsg := drive(t, a, leaseReq(`true`), nil); errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("Exec: end %+v, err %q", end, errMsg)
	}
	if !pidAlive(daemon) {
		t.Fatal("an Exec's teardown killed the tracked daemon")
	}
	if ps := listProcs(t, a); len(ps) != 1 || ps[0].ID != p.ID || ps[0].PID != p.PID {
		t.Errorf("process_list %+v, want only the original entry", ps)
	}
	final := stopProc(t, a, ProcessArgs{ID: p.ID})
	if final.State != TrackedKilled || final.Code != int(syscall.SIGTERM) {
		t.Errorf("final state %+v, want killed(15)", final)
	}
	waitPidsGone(t, "process_stop", p.PID, daemon)
}

// Review Focus 2: a later Exec cannot signal, ptrace, process_vm_writev or write the
// /proc/<pid>/mem of a running tracked process, and its argv and memory are unchanged.
// The probe runs twice: as an Exec (uid split plus seccomp), and as uid 7000 with no
// seccomp, which shows the uid split alone refuses all four.
const attackTrackedScript = `
import ctypes, os, sys
pid = int(sys.argv[1])
libc = ctypes.CDLL(None, use_errno=True)
try:
    os.kill(pid, 19)  # SIGSTOP
    print("kill ok")
except OSError as e:
    print("kill", e.errno)
libc.ptrace.restype = ctypes.c_long
ctypes.set_errno(0)
r = libc.ptrace(16, pid, None, None)  # PTRACE_ATTACH
print("ptrace", "ok" if r != -1 else ctypes.get_errno())
class iovec(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]
buf = ctypes.create_string_buffer(b"XXXXXXXX", 8)
local = iovec(ctypes.cast(buf, ctypes.c_void_p), 8)
remote = iovec(ctypes.c_void_p(0x400000), 8)
libc.process_vm_writev.restype = ctypes.c_ssize_t
ctypes.set_errno(0)
r = libc.process_vm_writev(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
print("process_vm_writev", "ok" if r != -1 else ctypes.get_errno())
try:
    fd = os.open("/proc/%d/mem" % pid, os.O_RDWR)
    print("mem ok")
except OSError as e:
    print("mem", e.errno)
`

func checkAttackRefused(t *testing.T, who, out string) {
	t.Helper()
	for _, step := range []string{"kill", "ptrace", "process_vm_writev", "mem"} {
		m := regexp.MustCompile(`(?m)^` + step + ` (\S+)$`).FindStringSubmatch(out)
		// EPERM (1) or EACCES (13): refused at the permission check, not by a bad address.
		if m == nil || (m[1] != "1" && m[1] != "13") {
			t.Errorf("%s: %s: %v, want refused with EPERM or EACCES\n%s", who, step, m, out)
		}
	}
}

func TestExecCannotTouchTrackedProcess(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("needs python3")
	}
	a, _ := newLeaseAgent(t)
	p := startProc(t, a, "victim", `v=intact; while :; do echo "v=$v"; sleep 0.1; done`, 0)
	waitLog(t, a, p.ID, "v=intact")
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", p.PID))
	if err != nil {
		t.Fatal(err)
	}

	script := filepath.Join(a.WorkDir(), "attack.py")
	if err := os.WriteFile(script, []byte(attackTrackedScript), 0o644); err != nil {
		t.Fatal(err)
	}
	out, stderr, end, errMsg := drive(t, a, leaseReq(fmt.Sprintf(`python3 attack.py %d`, p.PID)), nil)
	if errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("attack Exec: end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	t.Logf("as an Exec:\n%s", out)
	checkAttackRefused(t, "Exec", out)

	probe := exec.Command("python3", script, strconv.Itoa(p.PID))
	probe.Dir = "/"
	probe.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 7000, Gid: 7000, Groups: []uint32{7000}}}
	pout, err := probe.CombinedOutput()
	if err != nil {
		t.Fatalf("uid-7000 probe: %v\n%s", err, pout)
	}
	t.Logf("as uid 7000 without seccomp:\n%s", pout)
	checkAttackRefused(t, "uid 7000 without seccomp", string(pout))

	if !pidAlive(p.PID) {
		t.Fatal("the tracked process died")
	}
	if st, _ := os.ReadFile(fmt.Sprintf("/proc/%d/stat", p.PID)); strings.Contains(string(st), ") T ") {
		t.Fatal("the tracked process was stopped")
	}
	if now, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", p.PID)); string(now) != string(cmdline) {
		t.Errorf("argv changed: %q, was %q", now, cmdline)
	}
	// Still printing, and only what it printed before: three more lines at least.
	before, _ := procLogs(t, a, ProcessArgs{ID: p.ID, Tail: 100000})
	after := before
	for deadline := time.Now().Add(5 * time.Second); strings.Count(after, "\n") < strings.Count(before, "\n")+3; {
		if time.Now().After(deadline) {
			t.Fatal("the tracked process stopped printing")
		}
		time.Sleep(50 * time.Millisecond)
		after, _ = procLogs(t, a, ProcessArgs{ID: p.ID, Tail: 100000})
	}
	for _, line := range strings.Split(strings.TrimSpace(after), "\n") {
		if line != "v=intact" {
			t.Fatalf("the tracked process's output changed: %q", line)
		}
	}
}

// Review Focus 3: a tracked process that OOMs inside its cgroup shows killed(9), and
// the lease survives: the next Exec runs. The test lowers memory.max on the tracked
// cgroup, then lets the process allocate.
func TestTrackedOOMKeepsTheLease(t *testing.T) {
	a, root := newLeaseAgent(t)
	p := startProc(t, a, "hog", `while [ ! -e go ]; do sleep 0.05; done; x=$(head -c 400000000 /dev/zero | tr '\0' a); echo survived`, 0)
	cg := filepath.Join(root, "tracked", "p"+p.ID)
	if err := os.WriteFile(filepath.Join(cg, "memory.max"), []byte("33554432"), 0); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(cg, "memory.swap.max"), []byte("0"), 0)
	if err := os.WriteFile(filepath.Join(a.WorkDir(), "go"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	final := waitProcExit(t, a, p.ID)
	if final.State != TrackedKilled || final.Code != 9 {
		t.Fatalf("hog %+v, want killed(9)", final)
	}
	out, stderr, end, errMsg := drive(t, a, leaseReq(`echo ok`), nil)
	if errMsg != "" || end.ExitCode != 0 || out != "ok\n" || end.TeardownFailed {
		t.Fatalf("Exec after the OOM: end %+v, err %q, stdout %q, stderr %q", end, errMsg, out, stderr)
	}
	if logs, _ := procLogs(t, a, ProcessArgs{Name: "hog"}); strings.Contains(logs, "survived") {
		t.Errorf("the hog was not killed: %q", logs)
	}
}

// Spec §3.3: a tracked uid is not reused while its cgroup is populated, even once its
// process has exited and left a child behind; the allocator's refusal is process_limit.
func TestTrackedUIDNotReusedWhilePopulated(t *testing.T) {
	a, _ := newLeaseAgentWith(t, func(lo *LeaseOptions) { lo.MaxTrackedUIDs = 2 })
	p1 := startProc(t, a, "leaver", `( setsid sleep 3020 & ); exit 0`, 0)
	if st := waitProcExit(t, a, p1.ID); st.State != TrackedExited || st.Code != 0 {
		t.Fatalf("leaver %+v, want exited(0)", st)
	}
	left := waitPidOf(t, regexp.MustCompile(`^sleep 3020$`), trackedUID0)
	// Its uid is read once the shim has exec'd the command, so after the drop.
	p2 := startProc(t, a, "", `exec sleep 3021`, 0)
	if uid := procUID(fmt.Sprintf("/proc/%d", waitPidOf(t, regexp.MustCompile(`^sleep 3021$`), -1))); uid != trackedUID1 {
		t.Fatalf("second process runs as %d, want 20001: 20000 is still populated", uid)
	}
	// One running of four allowed, but no uid is free: 20000 still holds the leftover.
	if _, errMsg := tryStartProc(t, a, ProcessArgs{}, `exec sleep 3022`, 0); errMsg != "process_limit: 4 running (SH_LEASE_MAX_PROCESSES)" {
		t.Fatalf("third start: %q, want the process_limit refusal", errMsg)
	}
	stopProc(t, a, ProcessArgs{ID: p2.ID})
	startProc(t, a, "", `exec sleep 3023`, 0)
	if uid := procUID(fmt.Sprintf("/proc/%d", waitPidOf(t, regexp.MustCompile(`^sleep 3023$`), -1))); uid != trackedUID1 {
		t.Fatalf("after stopping 20001's process, the next runs as %d, want 20001 (20000 is still populated)", uid)
	}
	// process_stop of the exited entry kills what it left, which frees 20000.
	if st := stopProc(t, a, ProcessArgs{Name: "leaver"}); st.State != TrackedExited || st.Code != 0 {
		t.Errorf("stopping the exited leaver answered %+v, want its exited(0)", st)
	}
	waitPidsGone(t, "process_stop of an exited entry", left)
	startProc(t, a, "", `exec sleep 3024`, 0)
	if uid := procUID(fmt.Sprintf("/proc/%d", waitPidOf(t, regexp.MustCompile(`^sleep 3024$`), -1))); uid != trackedUID0 {
		t.Fatalf("after the leftover is gone, the next runs as %d, want 20000", uid)
	}
}

// SH_LEASE_MAX_PROCESSES counts running processes only.
func TestProcessLimitCountsRunningOnly(t *testing.T) {
	a, _ := newLeaseAgent(t)
	startProc(t, a, "a", `exec sleep 3030`, 2)
	b := startProc(t, a, "b", `exit 3`, 2)
	if st := waitProcExit(t, a, b.ID); st.State != TrackedExited || st.Code != 3 {
		t.Fatalf("b %+v, want exited(3)", st)
	}
	startProc(t, a, "c", `exec sleep 3031`, 2)
	if _, errMsg := tryStartProc(t, a, ProcessArgs{Name: "d"}, `exec sleep 3032`, 2); errMsg != "process_limit: 2 running (SH_LEASE_MAX_PROCESSES)" {
		t.Fatalf("third running process: %q, want process_limit: 2 running (SH_LEASE_MAX_PROCESSES)", errMsg)
	}
	if ps := listProcs(t, a); len(ps) != 3 {
		t.Errorf("process_list %+v, want a, b and c", ps)
	}
}

// PR #814 review (must-fix), the reviewer's scenario: a long-lived p1, then eight short
// jobs that finish (eight exited entries kept), then p1 is stopped. Its exit must not evict
// p1 itself: process_stop answers its true final state, killed(15), never the running row
// it took before the stop, and process_list keeps it, exited entries evicted by exit order.
func TestProcessStopAfterOtherExitsAnswersTheFinalState(t *testing.T) {
	a, _ := newLeaseAgent(t)
	p1 := startProc(t, a, "server", `exec sleep 3050`, 0)
	var jobs []string
	for i := 0; i < trackedExitedKeep; i++ {
		j := startProc(t, a, fmt.Sprintf("job%d", i), `exit 0`, 0)
		waitProcExit(t, a, j.ID)
		jobs = append(jobs, j.ID)
	}
	final := stopProc(t, a, ProcessArgs{ID: p1.ID})
	if final.ID != p1.ID || final.State != TrackedKilled || final.Code != int(syscall.SIGTERM) {
		t.Fatalf("process_stop of p1 answered %+v, want its final state killed(15)", final)
	}
	ps := listProcs(t, a)
	if got, ok := procByID(ps, p1.ID); !ok || got.State != TrackedKilled {
		t.Fatalf("process_list %+v: want p1 kept, killed(15)", ps)
	}
	if _, ok := procByID(ps, jobs[0]); ok {
		t.Fatalf("process_list %+v: the first job to exit should be the one evicted", ps)
	}
	if len(ps) != trackedExitedKeep {
		t.Fatalf("process_list has %d entries, want %d exited ones", len(ps), trackedExitedKeep)
	}
}

// process_stop sends the signal (TERM by default) to the process's cgroup, waits out
// the grace, then kills the cgroup.
func TestProcessStopTermThenKill(t *testing.T) {
	a, _ := newLeaseAgent(t)
	if trackedStopGrace != 10*time.Second {
		t.Fatalf("trackedStopGrace %s, want 10s (global constraints)", trackedStopGrace)
	}
	orig := trackedStopGrace
	trackedStopGrace = time.Second
	t.Cleanup(func() { trackedStopGrace = orig })

	stubborn := startProc(t, a, "stubborn", `trap '' TERM; echo ready; while :; do sleep 0.1; done`, 0)
	waitLog(t, a, stubborn.ID, "ready")
	start := time.Now()
	final := stopProc(t, a, ProcessArgs{Name: "stubborn"})
	if el := time.Since(start); el < time.Second || el > 4*time.Second {
		t.Errorf("stopping a TERM-ignoring process took %s, want the 1s grace and then the kill", el)
	}
	if final.State != TrackedKilled || final.Code != 9 || final.ID != stubborn.ID {
		t.Errorf("final state %+v, want killed(9)", final)
	}
	waitPidsGone(t, "the stubborn process", stubborn.PID)

	polite := startProc(t, a, "polite", `exec sleep 3040`, 0)
	start = time.Now()
	if final := stopProc(t, a, ProcessArgs{ID: polite.ID}); final.State != TrackedKilled || final.Code != int(syscall.SIGTERM) {
		t.Errorf("final state %+v, want killed(15)", final)
	}
	if el := time.Since(start); el >= time.Second {
		t.Errorf("stopping a TERM-honouring process took %s, want well under the grace", el)
	}

	sig := startProc(t, a, "", `exec sleep 3041`, 0)
	if final := stopProc(t, a, ProcessArgs{ID: sig.ID, Signal: "INT"}); final.State != TrackedKilled || final.Code != int(syscall.SIGINT) {
		t.Errorf("signal INT: final state %+v, want killed(2)", final)
	}
	if _, _, _, errMsg := drive(t, a, procReq(RequestKindProcessStop, ProcessArgs{ID: sig.ID, Signal: "NOPE"}), nil); errMsg != "process_signal: unknown signal NOPE" {
		t.Errorf("signal NOPE: %q, want process_signal: unknown signal NOPE (ruling P5-R13)", errMsg)
	}
	if _, _, _, errMsg := drive(t, a, procReq(RequestKindProcessStop, ProcessArgs{Name: "ghost"}), nil); errMsg != "process_not_found: ghost" {
		t.Errorf("stop ghost: %q, want process_not_found: ghost", errMsg)
	}
}

// A stop right after a start ends the process with the signal, under the agent's own
// signal setup: cmd/guest-agent ignores TERM, INT and HUP, so the shim starts with
// them ignored, and a TERM that landed before the shim's exec would be dropped and the
// stop would wait out the grace and kill. process_start answers only once the command
// has replaced the shim (its exec barrier), and the shim resets what it inherited.
//
// The shim is started through a wrapper that ignores them, as a child of the guest's
// agent inherits them, rather than by ignoring them in this test binary: signal.Reset
// does not undo signal.Ignore, so that would leak into every later test.
func TestProcessStopRightAfterStartDeliversTheSignal(t *testing.T) {
	wrapper := filepath.Join(t.TempDir(), "ignoring-shim")
	// The sleep holds the window open, so a stop 100 ms after a start that did not wait
	// for the exec always lands in it.
	if err := os.WriteFile(wrapper, []byte("#!/bin/sh\ntrap '' TERM INT HUP\nsleep 0.3\nexec "+os.Args[0]+` "$@"`+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	a, _ := newLeaseAgentWith(t, func(lo *LeaseOptions) { lo.ShimPath = wrapper })
	orig := trackedStopGrace
	trackedStopGrace = 3 * time.Second
	t.Cleanup(func() { trackedStopGrace = orig })
	for i := range 5 {
		p := startProc(t, a, "", `exec sleep 3100`, 0)
		// Inside the wrapper's sleep, had process_start not waited for the exec.
		time.Sleep(100 * time.Millisecond)
		start := time.Now()
		final := stopProc(t, a, ProcessArgs{ID: p.ID})
		if el := time.Since(start); final.State != TrackedKilled || final.Code != int(syscall.SIGTERM) || el > 2*time.Second {
			t.Fatalf("round %d: stop right after start: %+v in %s, want killed(15) well inside the grace", i, final, el)
		}
	}
}

// The cwd must resolve inside the workspace, with no symlink escape.
func TestProcessCwdMustStayInWorkspace(t *testing.T) {
	a, _ := newLeaseAgent(t)
	work := a.WorkDir()
	if err := os.Mkdir(filepath.Join(work, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc", filepath.Join(work, "esc")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("sub", filepath.Join(work, "in")); err != nil {
		t.Fatal(err)
	}
	for _, cwd := range []string{"/etc", work + "/..", "esc", filepath.Join(work, "esc"), "nope", "../" + filepath.Base(work) + "x"} {
		if _, errMsg := tryStartProc(t, a, ProcessArgs{Cwd: cwd}, `touch /tmp/never; pwd`, 0); !strings.HasPrefix(errMsg, "process_cwd: ") {
			t.Errorf("cwd %q: %q, want a process_cwd: refusal", cwd, errMsg)
		}
	}
	if ps := listProcs(t, a); len(ps) != 0 {
		t.Errorf("refused starts left entries: %+v", ps)
	}
	for cwd, want := range map[string]string{"": work, "sub": work + "/sub", "in": work + "/sub", work + "/in": work + "/sub"} {
		p, errMsg := tryStartProc(t, a, ProcessArgs{Cwd: cwd}, `pwd -P`, 0)
		if errMsg != "" {
			t.Errorf("cwd %q: %s", cwd, errMsg)
			continue
		}
		waitProcExit(t, a, p.ID)
		if out, _ := procLogs(t, a, ProcessArgs{ID: p.ID}); out != want+"\n" {
			t.Errorf("cwd %q: pwd %q, want %q", cwd, out, want)
		}
	}
}

// Spec §3.3: the sbx-ws group and umask 0002 let a later Exec edit what a tracked
// process wrote in the (setgid, group-writable) workspace.
func TestTrackedFileEditableByLaterExec(t *testing.T) {
	a, _ := newLeaseAgent(t)
	if err := os.Chown(a.WorkDir(), 7000, 7000); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(a.WorkDir(), 0o2775); err != nil {
		t.Fatal(err)
	}
	p := startProc(t, a, "writer", `mkdir -p build && echo one > build/out.txt`, 0)
	if st := waitProcExit(t, a, p.ID); st.State != TrackedExited || st.Code != 0 {
		logs, _ := procLogs(t, a, ProcessArgs{ID: p.ID})
		t.Fatalf("writer %+v, want exited(0); logs %q", st, logs)
	}
	out := filepath.Join(a.WorkDir(), "build", "out.txt")
	if uid, gid, mode := statOwner(t, out); uid != trackedUID0 || gid != 7000 || mode&0o777 != 0o664 {
		t.Errorf("out.txt %d:%d %o, want 20000:7000 0664", uid, gid, mode&0o777)
	}
	_, stderr, end, errMsg := drive(t, a, leaseReq(`echo two >> build/out.txt && touch build/new`), nil)
	if errMsg != "" || end.ExitCode != 0 {
		t.Fatalf("the Exec could not edit the tracked process's file: end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	if got, _ := os.ReadFile(out); string(got) != "one\ntwo\n" {
		t.Errorf("out.txt = %q, want one, two", got)
	}
}

// process_logs answers the ring's tail (default 200 lines), stdout and stderr together;
// an unnamed process is shown and found as p<id>; process_list is a JSON array even
// when empty.
func TestProcessLogsAndNames(t *testing.T) {
	a, _ := newLeaseAgent(t)
	if ps := listProcs(t, a); len(ps) != 0 {
		t.Fatalf("a fresh lease lists %+v", ps)
	}
	p := startProc(t, a, "", `for i in $(seq 1 500); do echo line$i; done; echo oops >&2`, 0)
	if p.Name != "p"+p.ID {
		t.Errorf("an unnamed process is named %q, want p%s", p.Name, p.ID)
	}
	waitProcExit(t, a, p.ID)
	if out, errMsg := procLogs(t, a, ProcessArgs{ID: p.ID, Tail: 3}); errMsg != "" || out != "line499\nline500\noops\n" {
		t.Errorf("tail 3: %q, %q", out, errMsg)
	}
	out, errMsg := procLogs(t, a, ProcessArgs{Name: "p" + p.ID})
	if errMsg != "" || strings.Count(out, "\n") != 200 || !strings.HasPrefix(out, "line302\n") {
		t.Errorf("default tail by display name: %d lines from %.10q, err %q; want 200 from line302", strings.Count(out, "\n"), out, errMsg)
	}
	if ps := listProcs(t, a); len(ps) != 1 || ps[0].Name != "p"+p.ID {
		t.Errorf("process_list %+v, want the unnamed process shown as p%s", ps, p.ID)
	}
	// A tail longer than the stream's cap keeps the newest lines, cut at a line start.
	req := procReq(RequestKindProcessLogs, ProcessArgs{ID: p.ID, Tail: 500})
	req.CapBytes = 24
	out, _, end, errMsg := drive(t, a, req, nil)
	if errMsg != "" || out != "line499\nline500\noops\n" || end.DroppedStdout <= 0 {
		t.Errorf("logs at a 24-byte cap: %q, dropped %d, err %q; want the newest lines and a drop count", out, end.DroppedStdout, errMsg)
	}
	if _, errMsg := procLogs(t, a, ProcessArgs{Name: "nope"}); errMsg != "process_not_found: nope" {
		t.Errorf("logs of nope: %q", errMsg)
	}

	startProc(t, a, "web", `exec sleep 3050`, 0)
	if _, errMsg := tryStartProc(t, a, ProcessArgs{Name: "web"}, `exec sleep 3051`, 0); errMsg != "process_name_taken: web" {
		t.Errorf("second web: %q, want process_name_taken: web", errMsg)
	}
	if _, errMsg := tryStartProc(t, a, ProcessArgs{Name: "a b"}, `true`, 0); !strings.HasPrefix(errMsg, "process_name_invalid: ") {
		t.Errorf("name 'a b': %q, want process_name_invalid:", errMsg)
	}
}

// process_stop_all (host-only) stops every running process and anything an exited one
// left behind, and answers the final states of the processes that were running.
func TestProcessStopAllStopsEveryProcessAndLeftover(t *testing.T) {
	a, root := newLeaseAgent(t)
	leaver := startProc(t, a, "leaver", `( setsid sleep 3060 & ); exit 0`, 0)
	waitProcExit(t, a, leaver.ID)
	left := waitPidOf(t, regexp.MustCompile(`^sleep 3060$`), trackedUID0)
	a1 := startProc(t, a, "a1", `exec sleep 3061`, 0)
	a2 := startProc(t, a, "a2", `exec sleep 3062`, 0)
	out, stderr, end, errMsg := drive(t, a, procReq(RequestKindProcessStopAll, ProcessArgs{}), nil)
	if errMsg != "" || end.TeardownFailed {
		t.Fatalf("process_stop_all: end %+v, err %q, stderr %q", end, errMsg, stderr)
	}
	var stopped []TrackedProcess
	if err := json.Unmarshal([]byte(out), &stopped); err != nil {
		t.Fatalf("process_stop_all stdout %q: %v", out, err)
	}
	if len(stopped) != 2 || stopped[0].ID != a1.ID || stopped[1].ID != a2.ID {
		t.Errorf("stopped %+v, want a1 and a2", stopped)
	}
	for _, s := range stopped {
		if s.State != TrackedKilled || s.Code != int(syscall.SIGTERM) {
			t.Errorf("stopped %+v, want killed(15)", s)
		}
	}
	waitPidsGone(t, "process_stop_all", a1.PID, a2.PID, left)
	for _, tp := range end.Tracked {
		if tp.State == TrackedRunning {
			t.Errorf("End.Tracked after stop_all still has %+v running", tp)
		}
	}
	if pcs, _ := filepath.Glob(filepath.Join(root, "tracked", "p[0-9]*")); len(pcs) != 0 {
		t.Errorf("tracked cgroups left after stop_all: %v", pcs)
	}
	if out, _, _, errMsg := drive(t, a, procReq(RequestKindProcessStopAll, ProcessArgs{}), nil); errMsg != "" || out != "[]" {
		t.Errorf("stop_all with nothing running: %q, %q; want []", out, errMsg)
	}
}

// A cgroup that does not empty after the kill answers End{TeardownFailed}, and the agent
// is dead, as for an Exec.
func TestProcessStopTeardownFailureMarksTheAgentDead(t *testing.T) {
	a, _ := newLeaseAgent(t)
	p := startProc(t, a, "", `exec sleep 3070`, 0)
	orig := waitCgroupEmpty
	waitCgroupEmpty = func(*execCgroup, time.Duration) error { return errors.New("injected: still populated") }
	t.Cleanup(func() { waitCgroupEmpty = orig })
	_, _, end, errMsg := drive(t, a, procReq(RequestKindProcessStop, ProcessArgs{ID: p.ID}), nil)
	if errMsg != "" || !end.TeardownFailed {
		t.Fatalf("end %+v, err %q; want teardown_failed", end, errMsg)
	}
	if _, _, _, errMsg := drive(t, a, leaseReq(`true`), nil); !strings.Contains(errMsg, "teardown failed") {
		t.Fatalf("next request's error %q, want it to say teardown failed", errMsg)
	}
}

// Ruling P5-R9 and the strict rule: an entry the table drops (the ninth exit evicts the
// oldest exited; a new process takes an exited one's name) leaves nothing running, and
// its uid is free again once its cgroup is empty.
func TestTrackedDroppedEntryLeavesNothingRunning(t *testing.T) {
	a, root := newLeaseAgent(t)
	old := startProc(t, a, "web", `( setsid sleep 3080 & ); exit 0`, 0)
	waitProcExit(t, a, old.ID)
	left := waitPidOf(t, regexp.MustCompile(`^sleep 3080$`), trackedUID0)
	if !pidAlive(left) {
		t.Fatal("the leftover is not running")
	}
	// Replacing the name drops the exited entry, and with it what it left.
	repl := startProc(t, a, "web", `exec sleep 3081`, 0)
	waitPidsGone(t, "the replaced entry's leftover", left)
	if ps := listProcs(t, a); len(ps) != 1 || ps[0].ID != repl.ID {
		t.Errorf("process_list %+v, want only the new web", ps)
	}
	if _, err := os.Stat(filepath.Join(root, "tracked", "p"+old.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the replaced entry's cgroup is still there (stat err %v)", err)
	}

	// Eviction: one exited leaver, then trackedExitedKeep more exits evict it.
	ev := startProc(t, a, "ev", `( setsid sleep 3082 & ); exit 0`, 0)
	waitProcExit(t, a, ev.ID)
	evLeft := waitPidOf(t, regexp.MustCompile(`^sleep 3082$`), -1)
	for range trackedExitedKeep {
		p := startProc(t, a, "", `exit 0`, 0)
		waitProcExit(t, a, p.ID)
	}
	if _, ok := procByID(listProcs(t, a), ev.ID); ok {
		t.Fatalf("entry %s was not evicted", ev.ID)
	}
	waitPidsGone(t, "the evicted entry's leftover", evLeft)
}

// Ruling P5-R6: an unknown kind is refused and never runs as a command.
func TestLeaseUnknownKindIsRefusedNotRun(t *testing.T) {
	a, _ := newLeaseAgent(t)
	marker := filepath.Join(a.WorkDir(), "ran")
	req := leaseReq(`touch ` + marker)
	req.Kind = "process_restart"
	if _, _, _, errMsg := drive(t, a, req, nil); errMsg != "lease_unsupported: unknown kind process_restart" {
		t.Fatalf("error %q, want lease_unsupported: unknown kind process_restart", errMsg)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the unknown kind ran as a command (stat err %v)", err)
	}
}

// A start that fails after its uid was taken releases the uid and leaves no cgroup: with
// one tracked uid, the next start still gets it.
func TestProcessStartFailureReleasesItsUID(t *testing.T) {
	a, root := newLeaseAgentWith(t, func(lo *LeaseOptions) { lo.MaxTrackedUIDs = 1 })
	good := trackedHomeParent
	trackedHomeParent = filepath.Join(t.TempDir(), "no", "such")
	_, errMsg := tryStartProc(t, a, ProcessArgs{Name: "x"}, `exec sleep 3090`, 0)
	trackedHomeParent = good
	if !strings.Contains(errMsg, "home") {
		t.Fatalf("start with no home parent: %q, want a home error", errMsg)
	}
	if pcs, _ := filepath.Glob(filepath.Join(root, "tracked", "p[0-9]*")); len(pcs) != 0 {
		t.Errorf("a failed start left cgroups %v", pcs)
	}
	if ps := listProcs(t, a); len(ps) != 0 {
		t.Errorf("a failed start left entries %+v", ps)
	}
	p := startProc(t, a, "x", `exec sleep 3091`, 0)
	if uid := procUID(fmt.Sprintf("/proc/%d", waitPidOf(t, regexp.MustCompile(`^sleep 3091$`), -1))); uid != trackedUID0 {
		t.Fatalf("the start after a failed one runs as %d, want 20000", uid)
	}
	stopProc(t, a, ProcessArgs{ID: p.ID})
}

// Task 3 review I1: the cwd is checked, then the process starts in it. A running tracked
// process can write the (group-writable) workspace, so it can swap the directory for a
// symlink in between. The start must then be refused or land inside the workspace,
// never in the symlink's target: a root chdir there would hand the process a cwd its
// uid could not reach.
func TestProcessCwdSwapAfterTheCheckCannotLeaveTheWorkspace(t *testing.T) {
	a, _ := newLeaseAgent(t)
	sub := filepath.Join(a.WorkDir(), "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	// /root is 0700 root: a cwd the tracked uid can never reach by itself.
	trackedAfterCwdCheck = func() {
		if err := os.Rename(sub, sub+".old"); err != nil {
			t.Error(err)
		}
		if err := os.Symlink("/root", sub); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { trackedAfterCwdCheck = nil })
	p, errMsg := tryStartProc(t, a, ProcessArgs{Cwd: "sub"}, `pwd -P; ls >/dev/null 2>&1 && echo listed`, 0)
	if errMsg != "" {
		if !strings.HasPrefix(errMsg, "process_cwd: ") {
			t.Fatalf("start after the swap: %q, want a process_cwd: refusal", errMsg)
		}
		t.Logf("refused: %s", errMsg)
		return
	}
	waitProcExit(t, a, p.ID)
	out, _ := procLogs(t, a, ProcessArgs{ID: p.ID})
	if !strings.HasPrefix(out, a.WorkDir()+"/") {
		t.Fatalf("the process started in %q, outside the workspace %s", out, a.WorkDir())
	}
}
