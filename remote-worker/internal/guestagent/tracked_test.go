package guestagent

import (
	"bytes"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// ringReference is what a ring of capacity max must hold after the writes: the last max
// bytes of their concatenation.
func ringReference(all []byte, max int) []byte {
	if len(all) > max {
		return all[len(all)-max:]
	}
	return all
}

// tailReference is Tail's contract, written the slow way: split into lines (a trailing
// newline ends the last line rather than starting an empty one), keep the last n.
func tailReference(held []byte, n int) []byte {
	if n <= 0 || len(held) == 0 {
		return nil
	}
	lines := strings.SplitAfter(string(held), "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if n < len(lines) {
		lines = lines[len(lines)-n:]
	}
	return []byte(strings.Join(lines, ""))
}

func TestRingCapIs4MiB(t *testing.T) {
	if trackedLogCap != 4<<20 {
		t.Fatalf("trackedLogCap = %d, want 4 MiB (global constraints)", trackedLogCap)
	}
}

// 8-byte lines, so the 4 MiB cap holds exactly 524288 whole lines.
func numberedLines(from, to int) []byte {
	var b bytes.Buffer
	for i := from; i < to; i++ {
		fmt.Fprintf(&b, "%07d\n", i)
	}
	return b.Bytes()
}

func TestRingKeepsTheLast4MiBAndTailsAtTheCap(t *testing.T) {
	const perCap = trackedLogCap / 8 // 524288 lines fill the ring exactly
	r := newRing(trackedLogCap)

	// Exactly at the cap: nothing is dropped.
	all := numberedLines(0, perCap)
	for off := 0; off < len(all); off += 32 << 10 {
		_, _ = r.Write(all[off:min(off+32<<10, len(all))])
	}
	if got := r.Tail(perCap + 10); !bytes.Equal(got, all) {
		t.Fatalf("at the cap: Tail(more than held) returned %d bytes, want all %d", len(got), len(all))
	}
	if got := r.Tail(perCap); !bytes.Equal(got, all) {
		t.Fatalf("at the cap: Tail(%d) returned %d bytes, want %d", perCap, len(got), len(all))
	}
	if got := string(r.Tail(1)); got != fmt.Sprintf("%07d\n", perCap-1) {
		t.Fatalf("at the cap: Tail(1) = %q", got)
	}

	// One more MiB: the oldest MiB goes, whole lines, since 1 MiB is a multiple of 8.
	more := numberedLines(perCap, perCap+perCap/4)
	_, _ = r.Write(more)
	want := ringReference(append(all, more...), trackedLogCap)
	if !bytes.HasPrefix(want, []byte(fmt.Sprintf("%07d\n", perCap/4))) {
		t.Fatalf("test arithmetic: held data starts %q", want[:8])
	}
	if got := r.Tail(perCap); !bytes.Equal(got, want) {
		t.Fatalf("past the cap: Tail(%d) returned %d bytes, want the last 4 MiB", perCap, len(got))
	}
	if got := r.Tail(perCap - 1); !bytes.Equal(got, want[8:]) {
		t.Fatalf("past the cap: Tail(%d) is not the held data less its first line", perCap-1)
	}
	if got := string(r.Tail(2)); got != fmt.Sprintf("%07d\n%07d\n", perCap+perCap/4-2, perCap+perCap/4-1) {
		t.Fatalf("past the cap: Tail(2) = %q", got)
	}

	// Three bytes more: the held data now starts in the middle of a line, which Tail
	// returns as it is, a cut first line.
	_, _ = r.Write([]byte("xyz"))
	want = ringReference(append(append(all, more...), "xyz"...), trackedLogCap)
	if got := r.Tail(perCap + 1); !bytes.Equal(got, want) {
		t.Fatalf("cut first line: Tail(%d) returned %d bytes, want %d", perCap+1, len(got), len(want))
	}
	if got := string(r.Tail(1)); got != "xyz" {
		t.Fatalf("Tail(1) = %q, want the unterminated last line", got)
	}
}

func TestRingTailLineCounts(t *testing.T) {
	cases := []struct {
		data string
		n    int
		want string
	}{
		{"", 3, ""},
		{"a\nb\nc\n", 0, ""},
		{"a\nb\nc\n", -1, ""},
		{"a\nb\nc\n", 1, "c\n"},
		{"a\nb\nc\n", 2, "b\nc\n"},
		{"a\nb\nc\n", 3, "a\nb\nc\n"},
		{"a\nb\nc\n", 4, "a\nb\nc\n"},
		{"a\nb\nc", 1, "c"},
		{"a\nb\nc", 2, "b\nc"},
		{"\n\n\n", 2, "\n\n"},
		{"no newline", 1, "no newline"},
	}
	for _, c := range cases {
		r := newRing(64)
		_, _ = r.Write([]byte(c.data))
		if got := string(r.Tail(c.n)); got != c.want {
			t.Errorf("Tail(%d) of %q = %q, want %q", c.n, c.data, got, c.want)
		}
	}
}

func TestRingWriteLargerThanTheCapKeepsItsEnd(t *testing.T) {
	r := newRing(8)
	n, err := r.Write([]byte("0123456789abcdef"))
	if n != 16 || err != nil {
		t.Fatalf("Write = %d, %v; want every byte accepted", n, err)
	}
	if got := string(r.Tail(5)); got != "89abcdef" {
		t.Fatalf("Tail = %q, want the last 8 bytes", got)
	}
}

// Random write sizes against small caps, so the wrap lands at every offset.
func TestRingMatchesTheReferenceAcrossWraps(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for _, max := range []int{1, 2, 7, 16, 61} {
		r := newRing(max)
		var all []byte
		for i := 0; i < 400; i++ {
			p := make([]byte, rng.Intn(2*max+2))
			for j := range p {
				p[j] = "ab\n"[rng.Intn(3)]
			}
			if n, err := r.Write(p); n != len(p) || err != nil {
				t.Fatalf("Write = %d, %v", n, err)
			}
			all = append(all, p...)
			held := ringReference(all, max)
			for _, n := range []int{1, 2, 3, max, max + 1} {
				if got, want := r.Tail(n), tailReference(held, n); !bytes.Equal(got, want) {
					t.Fatalf("cap %d, write %d: Tail(%d) = %q, want %q", max, i, n, got, want)
				}
			}
		}
	}
}

func TestRingNeverHoldsMoreThanItsCap(t *testing.T) {
	r := newRing(1000)
	for i := 0; i < 50; i++ {
		_, _ = r.Write(make([]byte, 333))
	}
	if c := cap(r.buf); c > 1000 {
		t.Fatalf("ring buffer capacity %d, over the 1000-byte cap", c)
	}
}

// launchOK is a launch that starts nothing, so the table can be tested alone.
func launchOK(pid, uid int) func(string, *ring) (int, int, error) {
	return func(string, *ring) (int, int, error) { return pid, uid, nil }
}

func mustStart(t *testing.T, tt *trackedTable, name string, max, pid int) TrackedProcess {
	t.Helper()
	p, err := tt.start(name, max, launchOK(pid, 20000))
	if err != nil {
		t.Fatalf("start %q: %v", name, err)
	}
	return p
}

func TestTrackedNameTakenByARunningProcessIsRefused(t *testing.T) {
	var tt trackedTable
	mustStart(t, &tt, "web", 4, 100)
	launched := false
	_, err := tt.start("web", 4, func(string, *ring) (int, int, error) { launched = true; return 101, 20001, nil })
	if err == nil || err.Error() != "process_name_taken: web" {
		t.Fatalf("err = %v, want process_name_taken: web", err)
	}
	if launched {
		t.Fatal("a refused start launched its process")
	}
	if n := len(tt.list()); n != 1 {
		t.Fatalf("list has %d entries, want 1", n)
	}
}

func TestTrackedNameHeldOnlyByAnExitedEntryIsReplaced(t *testing.T) {
	var tt trackedTable
	old := mustStart(t, &tt, "web", 4, 100)
	other := mustStart(t, &tt, "db", 4, 101)
	tt.markExit(old.ID, 1, 0)
	nu := mustStart(t, &tt, "web", 4, 102)
	if nu.ID == old.ID {
		t.Fatalf("the replacement reused id %s", nu.ID)
	}
	got := tt.list()
	if len(got) != 2 || got[0].ID != other.ID || got[1].ID != nu.ID {
		t.Fatalf("list = %+v, want db then the new web", got)
	}
	if _, ok := tt.lookup(old.ID); ok {
		t.Fatal("the replaced entry is still found by its id")
	}
}

func TestTrackedFailedLaunchKeepsTheExitedEntry(t *testing.T) {
	var tt trackedTable
	old := mustStart(t, &tt, "web", 4, 100)
	tt.markExit(old.ID, 0, 0)
	_, err := tt.start("web", 4, func(string, *ring) (int, int, error) { return 0, 0, errors.New("fork failed") })
	if err == nil || err.Error() != "fork failed" {
		t.Fatalf("err = %v, want the launch's error", err)
	}
	got := tt.list()
	if len(got) != 1 || got[0].ID != old.ID || got[0].State != TrackedExited {
		t.Fatalf("list = %+v, want only the old, exited web", got)
	}
}

func TestTrackedUnnamedProcessesNeverClash(t *testing.T) {
	var tt trackedTable
	a := mustStart(t, &tt, "", 4, 100)
	b := mustStart(t, &tt, "", 4, 101)
	if a.ID == b.ID {
		t.Fatalf("two starts share id %s", a.ID)
	}
	if n := len(tt.list()); n != 2 {
		t.Fatalf("list has %d entries, want 2", n)
	}
}

func TestTrackedLimitCountsRunningOnly(t *testing.T) {
	var tt trackedTable
	a := mustStart(t, &tt, "a", 2, 100)
	mustStart(t, &tt, "b", 2, 101)
	_, err := tt.start("c", 2, launchOK(102, 20002))
	if err == nil || err.Error() != "process_limit: 2 running (SH_LEASE_MAX_PROCESSES)" {
		t.Fatalf("err = %v, want process_limit: 2 running (SH_LEASE_MAX_PROCESSES)", err)
	}
	tt.markExit(a.ID, 0, 0)
	mustStart(t, &tt, "c", 2, 102)
	if n := len(tt.list()); n != 3 {
		t.Fatalf("list has %d entries, want 3 (the exited a is kept)", n)
	}
}

func TestTrackedLookupByIDOrName(t *testing.T) {
	var tt trackedTable
	web := mustStart(t, &tt, "web", 4, 100)
	tt.markExit(web.ID, 0, 0)
	db := mustStart(t, &tt, "db", 4, 101)

	for _, key := range []string{db.ID, "db"} {
		e, ok := tt.lookup(key)
		if !ok || e.ID != db.ID || e.PID != 101 || e.UID != 20000 || e.Log == nil {
			t.Fatalf("lookup(%q) = %+v, %v", key, e, ok)
		}
	}
	if e, ok := tt.lookup("web"); !ok || e.ID != web.ID || e.State != TrackedExited {
		t.Fatalf("lookup(web) = %+v, %v; want the exited entry", e, ok)
	}
	for _, key := range []string{"", "nope", "999"} {
		if _, ok := tt.lookup(key); ok {
			t.Fatalf("lookup(%q) found an entry", key)
		}
	}
}

func TestTrackedMarkExitStates(t *testing.T) {
	var tt trackedTable
	before := time.Now().UnixMilli()
	a := mustStart(t, &tt, "a", 4, 100)
	b := mustStart(t, &tt, "b", 4, 101)
	after := time.Now().UnixMilli()
	if a.State != TrackedRunning || a.PID != 100 || a.StartedUnixMs < before || a.StartedUnixMs > after {
		t.Fatalf("started entry = %+v", a)
	}
	tt.markExit(a.ID, 3, 0)
	tt.markExit(b.ID, 0, 9)
	tt.markExit("999", 0, 0) // unknown: ignored
	got := tt.list()
	if got[0].State != TrackedExited || got[0].Code != 3 {
		t.Fatalf("a = %+v, want exited(3)", got[0])
	}
	if got[1].State != TrackedKilled || got[1].Code != 9 {
		t.Fatalf("b = %+v, want killed(9)", got[1])
	}
	// A second exit report for the same entry changes nothing.
	tt.markExit(a.ID, 0, 15)
	if e, _ := tt.lookup(a.ID); e.State != TrackedExited || e.Code != 3 {
		t.Fatalf("a after a second markExit = %+v", e)
	}
}

// The reaper can report an exit while launch is still running (the process died at
// once): the entry must already exist, so the exit is not lost.
func TestTrackedExitDuringLaunchIsKept(t *testing.T) {
	var tt trackedTable
	p, err := tt.start("quick", 4, func(id string, _ *ring) (int, int, error) {
		tt.markExit(id, 0, 9)
		return 100, 20000, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if e, _ := tt.lookup(p.ID); e.State != TrackedKilled || e.Code != 9 || e.PID != 100 {
		t.Fatalf("entry = %+v, want killed(9) with its pid", e)
	}
}

func TestTrackedLaunchGetsTheEntryRing(t *testing.T) {
	var tt trackedTable
	p, err := tt.start("w", 4, func(_ string, log *ring) (int, int, error) {
		_, _ = log.Write([]byte("hello\n"))
		return 100, 20000, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	e, _ := tt.lookup(p.ID)
	if got := string(e.Log.Tail(1)); got != "hello\n" {
		t.Fatalf("Tail = %q", got)
	}
}

func TestUIDAllocatorRefusesAtMax(t *testing.T) {
	a := newUIDAllocator(20000, 4)
	none := func(int) bool { return false }
	seen := map[int]bool{}
	for i := 0; i < 4; i++ {
		uid, err := a.take(none)
		if err != nil {
			t.Fatalf("take %d: %v", i, err)
		}
		if uid < 20000 || uid > 20003 || seen[uid] {
			t.Fatalf("take %d = %d: out of range or a repeat (%v)", i, uid, seen)
		}
		seen[uid] = true
	}
	if uid, err := a.take(none); err == nil {
		t.Fatalf("a fifth take returned %d", uid)
	}
	a.release(20002)
	if uid, err := a.take(none); err != nil || uid != 20002 {
		t.Fatalf("take after release = %d, %v; want 20002", uid, err)
	}
}

func TestUIDAllocatorSkipsPopulatedUIDs(t *testing.T) {
	a := newUIDAllocator(20000, 4)
	populated := map[int]bool{20000: true, 20002: true}
	for i := 0; i < 10; i++ {
		uid, err := a.take(func(u int) bool { return populated[u] })
		if err != nil {
			t.Fatal(err)
		}
		if populated[uid] {
			t.Fatalf("take handed out %d, whose cgroup is populated", uid)
		}
		a.release(uid)
	}
	all := func(int) bool { return true }
	if uid, err := a.take(all); err == nil {
		t.Fatalf("take returned %d with every uid populated", uid)
	}
}

// PR #814 review nit: the uid allocator's refusal says what holds the uids, so a user with
// one running process and leftovers holding the rest is not told "4 running".
func TestUIDAllocatorRefusalCountsRunningAndLeftovers(t *testing.T) {
	a := newUIDAllocator(20000, 4)
	none := func(int) bool { return false }
	if _, err := a.take(none); err != nil {
		t.Fatal(err)
	}
	leftovers := func(uid int) bool { return uid != 20000 }
	_, err := a.take(leftovers)
	var ex *uidsExhausted
	if !errors.As(err, &ex) || ex.inUse != 1 || ex.leftover != 3 {
		t.Fatalf("take = %v (%+v), want 1 in use and 3 held by leftovers", err, ex)
	}
	got := processLimitError(4, err).Error()
	if want := "process_limit: 1 running, 3 uids held by leftover children of exited processes (process_stop them)"; got != want {
		t.Fatalf("refusal %q, want %q", got, want)
	}
	for i := 0; i < 3; i++ {
		if _, err := a.take(none); err != nil {
			t.Fatal(err)
		}
	}
	_, err = a.take(none)
	if got, want := processLimitError(4, err).Error(), "process_limit: 4 running (SH_LEASE_MAX_PROCESSES)"; got != want {
		t.Fatalf("every uid held by a running process: %q, want %q", got, want)
	}
	if !strings.HasPrefix(processLimitError(4, errors.New("other")).Error(), "process_limit: ") {
		t.Fatal("any refusal of take keeps the process_limit: prefix")
	}
}

// Fresh: a released uid is not the next one handed out while another is free.
func TestUIDAllocatorRotates(t *testing.T) {
	a := newUIDAllocator(20000, 3)
	none := func(int) bool { return false }
	var got []int
	for i := 0; i < 4; i++ {
		uid, err := a.take(none)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, uid)
		a.release(uid)
	}
	if fmt.Sprint(got) != "[20000 20001 20002 20000]" {
		t.Fatalf("uids = %v, want each in turn", got)
	}
	a.release(12345) // outside the range: ignored
}

func TestUIDAllocatorUserNames(t *testing.T) {
	a := newUIDAllocator(20000, 4)
	for uid, want := range map[int]string{20000: "sbxp0", 20003: "sbxp3"} {
		if got := a.user(uid); got != want {
			t.Errorf("user(%d) = %q, want %q", uid, got, want)
		}
	}
}

func TestUIDAllocatorWithNoUIDsRefuses(t *testing.T) {
	a := newUIDAllocator(20000, 0)
	if uid, err := a.take(func(int) bool { return false }); err == nil {
		t.Fatalf("take returned %d from an empty range", uid)
	}
}

func TestTrackedExitedBoundsAreTheRuling(t *testing.T) {
	if trackedExitedKeep != 8 || trackedExitedLogCap != 64<<10 {
		t.Fatalf("trackedExitedKeep %d, trackedExitedLogCap %d; want 8 and 64 KiB (ruling P5-R5)", trackedExitedKeep, trackedExitedLogCap)
	}
}

// Ruling P5-R5: at most trackedExitedKeep exited entries are kept; a 9th exit evicts the
// oldest exited entry, ring and all, and never a running one, however old.
func TestTrackedNinthExitEvictsTheOldestExited(t *testing.T) {
	var tt trackedTable
	var running, exited []string
	for i := 0; i < trackedExitedKeep+1; i++ {
		if i%3 == 0 { // running entries interleaved, the first older than every exited one
			running = append(running, mustStart(t, &tt, fmt.Sprintf("r%d", i), 100, 1000+i).ID)
		}
		e := mustStart(t, &tt, fmt.Sprintf("e%d", i), 100, 2000+i)
		exited = append(exited, e.ID)
		tt.markExit(e.ID, 0, 0)
	}
	if _, ok := tt.lookup(exited[0]); ok {
		t.Fatal("the oldest exited entry survived the 9th exit")
	}
	var gotRunning, gotExited []string
	for _, p := range tt.list() {
		if p.State == TrackedRunning {
			gotRunning = append(gotRunning, p.ID)
		} else {
			gotExited = append(gotExited, p.ID)
		}
	}
	if fmt.Sprint(gotRunning) != fmt.Sprint(running) {
		t.Fatalf("running ids %v, want every running one kept: %v", gotRunning, running)
	}
	if fmt.Sprint(gotExited) != fmt.Sprint(exited[1:]) {
		t.Fatalf("exited ids %v, want the newest %d: %v", gotExited, trackedExitedKeep, exited[1:])
	}
}

// PR #814 review (must-fix): eviction goes by exit order, not start order. A long-lived
// p1 that exits after p2..p9 have finished is the newest exited entry, so its own exit
// evicts p2, never p1: p1 stays so the agent can read why it died (spec §7).
func TestTrackedExitsOutOfStartOrderEvictTheOldestExited(t *testing.T) {
	var tt trackedTable
	p1 := mustStart(t, &tt, "server", 100, 1000)
	var short []string
	for i := 0; i < trackedExitedKeep; i++ {
		p := mustStart(t, &tt, fmt.Sprintf("job%d", i), 100, 2000+i)
		short = append(short, p.ID)
		if _, _, ev := tt.markExit(p.ID, 0, 0); len(ev) != 0 {
			t.Fatalf("job %d's exit evicted %+v, under the cap", i, ev)
		}
	}
	final, marked, ev := tt.markExit(p1.ID, 0, 9)
	if !marked || final.ID != p1.ID || final.State != TrackedKilled || final.Code != 9 || final.PID != 1000 {
		t.Fatalf("markExit(p1) = %+v, %t; want p1's final row, killed(9)", final, marked)
	}
	if len(ev) != 1 || ev[0].ID != short[0] {
		t.Fatalf("p1's exit evicted %+v, want only the first job to exit (%s)", ev, short[0])
	}
	if e, ok := tt.lookup(p1.ID); !ok || e.State != TrackedKilled || e.Code != 9 {
		t.Fatalf("p1 after its own exit: %+v, %t; want it kept, killed(9)", e, ok)
	}
	// The next exit evicts the oldest EXITED, job 1, not p1, which started first.
	p := mustStart(t, &tt, "late", 100, 3000)
	if _, _, ev := tt.markExit(p.ID, 0, 0); len(ev) != 1 || ev[0].ID != short[1] {
		t.Fatalf("the next exit evicted %+v, want job 1 (%s)", ev, short[1])
	}
	if _, ok := tt.lookup(p1.ID); !ok {
		t.Fatal("p1 was evicted before older exits")
	}
}

// The entry an exit marks is never the one that exit evicts, even when every other exited
// entry exited earlier and the order of exits is scrambled.
func TestTrackedExitNeverEvictsTheEntryItMarks(t *testing.T) {
	var tt trackedTable
	var ids []string
	for i := 0; i < 3*trackedExitedKeep; i++ {
		ids = append(ids, mustStart(t, &tt, fmt.Sprintf("p%dx", i), 100, 1000+i).ID)
	}
	rng := rand.New(rand.NewSource(1))
	rng.Shuffle(len(ids), func(i, j int) { ids[i], ids[j] = ids[j], ids[i] })
	for n, id := range ids {
		_, marked, ev := tt.markExit(id, n, 0)
		if !marked {
			t.Fatalf("exit %d (%s) not marked", n, id)
		}
		for _, e := range ev {
			if e.ID == id {
				t.Fatalf("exit %d evicted the entry it marked, %s", n, id)
			}
		}
		// The kept exited entries are exactly the last trackedExitedKeep to exit.
		want := ids[max(0, n+1-trackedExitedKeep) : n+1]
		var got []string
		for _, p := range tt.list() {
			if p.State != TrackedRunning {
				got = append(got, p.ID)
			}
		}
		if !sameSet(got, want) {
			t.Fatalf("after exit %d: exited %v, want the last to exit %v", n, got, want)
		}
	}
}

func sameSet(a, b []string) bool {
	a, b = slices.Clone(a), slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}

// process_stop's answer (awaitFinal) after the exit it waited for: the table's row while the
// entry is there, else the final row the reaper recorded with the exit signal, never the
// row taken before the stop (PR #814 review must-fix).
func TestTrackedFinalRowAfterTheExit(t *testing.T) {
	t.Run("the entry is still in the table", func(t *testing.T) {
		var tt trackedTable
		var s exitSignals
		p := mustStart(t, &tt, "web", 100, 412)
		s.add(p.ID)
		go func() {
			final, ok, _ := tt.markExit(p.ID, 0, 15)
			s.fire(p.ID, final, ok)
		}()
		got := finalRow(&tt, &s, p, 5*time.Second)
		if got.State != TrackedKilled || got.Code != 15 {
			t.Fatalf("final row %+v, want killed(15)", got)
		}
	})
	t.Run("the entry was evicted after its exit", func(t *testing.T) {
		var tt trackedTable
		var s exitSignals
		p1 := mustStart(t, &tt, "server", 100, 1000)
		s.add(p1.ID)
		final, ok, _ := tt.markExit(p1.ID, 0, 15)
		s.fire(p1.ID, final, ok)
		// Eight later exits push p1 out of the table.
		for i := 0; i < trackedExitedKeep; i++ {
			p := mustStart(t, &tt, fmt.Sprintf("job%d", i), 100, 2000+i)
			tt.markExit(p.ID, 0, 0)
		}
		if _, ok := tt.lookup(p1.ID); ok {
			t.Fatal("test setup: p1 should have been evicted")
		}
		got := finalRow(&tt, &s, p1, 5*time.Second)
		if got.ID != p1.ID || got.State != TrackedKilled || got.Code != 15 || got.PID != 1000 {
			t.Fatalf("final row %+v, want p1's recorded exit, killed(15), not the pre-stop row", got)
		}
	})
	t.Run("an exit wait that times out shows the table as it is", func(t *testing.T) {
		var tt trackedTable
		var s exitSignals
		p := mustStart(t, &tt, "stuck", 100, 7)
		s.add(p.ID)
		got := finalRow(&tt, &s, p, 10*time.Millisecond)
		if got.State != TrackedRunning || got.ID != p.ID {
			t.Fatalf("final row %+v, want the table's running row", got)
		}
	})
}

// Ruling P5-R5: at exit the ring is trimmed to its last 64 KiB, and stays bounded by
// that for what the process's leftovers still write.
func TestTrackedExitTrimsTheRingToItsTail(t *testing.T) {
	var tt trackedTable
	p := mustStart(t, &tt, "chatty", 4, 100)
	e, _ := tt.lookup(p.ID)
	all := numberedLines(0, (1<<20)/8) // 1 MiB of 8-byte lines
	_, _ = e.Log.Write(all)
	tt.markExit(p.ID, 0, 0)

	e, _ = tt.lookup(p.ID)
	held := e.Log.Tail(len(all))
	if len(held) != trackedExitedLogCap || !bytes.Equal(held, all[len(all)-trackedExitedLogCap:]) {
		t.Fatalf("exited ring holds %d bytes, want the last %d", len(held), trackedExitedLogCap)
	}
	if c := cap(e.Log.buf); c > trackedExitedLogCap {
		t.Fatalf("exited ring capacity %d, over %d", c, trackedExitedLogCap)
	}
	_, _ = e.Log.Write([]byte("late\n"))
	held = e.Log.Tail(len(all))
	if len(held) != trackedExitedLogCap || !bytes.HasSuffix(held, []byte("late\n")) {
		t.Fatalf("after a late write the ring holds %d bytes ending %q", len(held), held[len(held)-5:])
	}
	if c := cap(e.Log.buf); c > trackedExitedLogCap {
		t.Fatalf("exited ring capacity %d after a late write, over %d", c, trackedExitedLogCap)
	}
}

func TestTrackedExitTrimKeepsASmallRingWhole(t *testing.T) {
	var tt trackedTable
	p := mustStart(t, &tt, "quiet", 4, 100)
	e, _ := tt.lookup(p.ID)
	_, _ = e.Log.Write([]byte("a\nb\n"))
	tt.markExit(p.ID, 1, 0)
	if e, _ = tt.lookup(p.ID); string(e.Log.Tail(10)) != "a\nb\n" {
		t.Fatalf("Tail = %q", e.Log.Tail(10))
	}
}

// The table at its cap, MAX running (4) plus trackedExitedKeep exited, every field at its
// widest, still fits one End frame. Names are 255 bytes of '<', which encoding/json
// writes as <, six bytes each: the worst case for a 255-byte name.
func TestTrackedEndAtTheCapFitsAFrame(t *testing.T) {
	var tt trackedTable
	name := func(i int) string { return fmt.Sprintf("%03d", i) + strings.Repeat("<", 252) }
	const maxRunning = 4
	for i := 0; i < trackedExitedKeep+3; i++ {
		e := mustStart(t, &tt, name(i), maxRunning, 1<<22)
		tt.markExit(e.ID, 0, 1<<30)
	}
	for i := 0; i < maxRunning; i++ {
		mustStart(t, &tt, name(100+i), maxRunning, 1<<22)
	}
	end := End{ExitCode: -1 << 31, DroppedStdout: 1 << 62, DroppedStderr: 1 << 62, TeardownFailed: true, Tracked: tt.list()}
	if len(end.Tracked) != maxRunning+trackedExitedKeep {
		t.Fatalf("table holds %d entries, want %d", len(end.Tracked), maxRunning+trackedExitedKeep)
	}
	for i := range end.Tracked {
		end.Tracked[i].Code, end.Tracked[i].StartedUnixMs, end.Tracked[i].MemoryBytes = -1<<62, -1<<62, -1<<62
		end.Tracked[i].ID = "18446744073709551615"
	}
	var buf bytes.Buffer
	if err := WriteJSON(&buf, KindEnd, end); err != nil {
		t.Fatalf("the End at the cap does not fit a frame: %v", err)
	}
	t.Logf("End at the cap: %d of %d bytes", buf.Len()-5, MaxFrame)
}

// A tracked process's leftover children can still write through the drains while
// markExit shrinks its ring, and process_logs can Tail it at any time: -race must see
// every access to the ring under its lock.
func TestRingConcurrentWriteShrinkAndTail(t *testing.T) {
	for round := 0; round < 20; round++ {
		r := newRing(1 << 16)
		var wg sync.WaitGroup
		stop := make(chan struct{})
		for w := 0; w < 2; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				line := []byte("0123456789abcdef\n")
				for {
					select {
					case <-stop:
						return
					default:
						_, _ = r.Write(line)
					}
				}
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				_ = r.Tail(5)
			}
		}()
		r.shrink(1 << 10)
		r.shrink(1 << 8)
		close(stop)
		wg.Wait()
		if got := len(r.Tail(1 << 20)); got > 1<<8 {
			t.Fatalf("round %d: the ring holds %d bytes after shrinking to 256", round, got)
		}
	}
}

// Ruling P5-R9: the eviction returns what it dropped, so the caller can keep each
// evicted process's cgroup (and so its uid) until that cgroup is empty.
func TestTrackedMarkExitReturnsTheEvictedEntries(t *testing.T) {
	var tt trackedTable
	var ids []string
	for i := 0; i < trackedExitedKeep; i++ {
		p := mustStart(t, &tt, fmt.Sprintf("e%d", i), 100, 2000+i)
		ids = append(ids, p.ID)
		if _, _, ev := tt.markExit(p.ID, 0, 0); len(ev) != 0 {
			t.Fatalf("exit %d evicted %+v, under the cap", i, ev)
		}
	}
	p, err := tt.start("e-last", 100, launchOK(3000, 20003))
	if err != nil {
		t.Fatal(err)
	}
	_, _, ev := tt.markExit(p.ID, 0, 9)
	if len(ev) != 1 || ev[0].ID != ids[0] || ev[0].PID != 2000 || ev[0].UID != 20000 || ev[0].State != TrackedExited {
		t.Fatalf("evicted = %+v, want the oldest exited entry, with its pid and uid", ev)
	}
	if final, marked, ev := tt.markExit(p.ID, 0, 0); marked || len(ev) != 0 || final != (TrackedProcess{}) {
		t.Fatalf("a repeated markExit marked %t, evicted %+v, final %+v", marked, ev, final)
	}
	if _, _, ev := tt.markExit("999", 0, 0); len(ev) != 0 {
		t.Fatalf("an unknown id evicted %+v", ev)
	}
}

// An old host sends no max_processes (omitempty), which means the default, 4: not a
// cap of 0 that refuses every start.
func TestTrackedMaxRunningZeroMeansTheDefault(t *testing.T) {
	if defaultMaxProcesses != 4 {
		t.Fatalf("defaultMaxProcesses = %d, want 4 (SH_LEASE_MAX_PROCESSES)", defaultMaxProcesses)
	}
	var tt trackedTable
	for i := 0; i < 4; i++ {
		mustStart(t, &tt, "", 0, 100+i)
	}
	_, err := tt.start("", 0, launchOK(200, 20000))
	if err == nil || err.Error() != "process_limit: 4 running (SH_LEASE_MAX_PROCESSES)" {
		t.Fatalf("fifth start err = %v, want process_limit: 4 running (SH_LEASE_MAX_PROCESSES)", err)
	}
}

// Ruling P5-R8: a name is 1-64 chars of [A-Za-z0-9._-]; empty means unnamed. A long
// name is described, not echoed, so the refusal always fits one frame. Ruling P5-R33: a
// name shaped like an id (p<n> or n) is refused, so an id-wins lookup cannot address
// another process than the one the user named.
func TestProcessNameRules(t *testing.T) {
	for _, ok := range []string{"", "web", "a", "dev-server_2.1", strings.Repeat("x", 64), "p", "p3x", "3p", "P3", "p-3", "1.5"} {
		if err := validateProcessName(ok); err != nil {
			t.Errorf("validateProcessName(%q) = %v, want nil", ok, err)
		}
	}
	for _, bad := range []string{strings.Repeat("x", 65), "a b", "a/b", "../x", "név", "a\nb", "$(id)", strings.Repeat("y", 1<<20), "123", "3", "p3", "p0", "p007"} {
		err := validateProcessName(bad)
		if err == nil || !strings.HasPrefix(err.Error(), "process_name_invalid: ") {
			t.Errorf("validateProcessName(%.20q) = %v, want process_name_invalid:", bad, err)
			continue
		}
		if len(err.Error()) > 200 {
			t.Errorf("refusal of a %d-byte name is %d bytes: it must not echo the name", len(bad), len(err.Error()))
		}
		if !strings.HasSuffix(err.Error(), "want 1-64 characters of [A-Za-z0-9._-], not shaped like an id (p<n>)") {
			t.Errorf("validateProcessName(%.20q) = %v: the refusal must name the rule", bad, err)
		}
	}
	if err := validateProcessName("p3"); err == nil || err.Error() != `process_name_invalid: "p3": want 1-64 characters of [A-Za-z0-9._-], not shaped like an id (p<n>)` {
		t.Errorf("validateProcessName(p3) = %v", err)
	}
}

// Ruling P5-R6: an unknown kind is refused with lease_unsupported and never runs as a
// command; a process kind is a lease request or nothing.
func TestRequestKindRules(t *testing.T) {
	for _, req := range []Request{
		{}, {Kind: RequestKindCommand}, {Lease: true}, {Lease: true, Kind: RequestKindCommand},
		{Lease: true, Kind: RequestKindProcessStart}, {Lease: true, Kind: RequestKindProcessList},
		{Lease: true, Kind: RequestKindProcessLogs}, {Lease: true, Kind: RequestKindProcessStop},
		{Lease: true, Kind: RequestKindProcessStopAll},
	} {
		if err := checkRequestKind(req); err != nil {
			t.Errorf("checkRequestKind(%+v) = %v, want nil", req, err)
		}
	}
	for _, tc := range []struct {
		req  Request
		want string
	}{
		{Request{Kind: "bogus"}, "lease_unsupported: unknown kind bogus"},
		{Request{Lease: true, Kind: "bogus"}, "lease_unsupported: unknown kind bogus"},
		{Request{Lease: true, Kind: "Command"}, "lease_unsupported: unknown kind Command"},
		{Request{Kind: RequestKindProcessStart}, "lease_unsupported: process_start needs a lease request"},
		{Request{Kind: RequestKindProcessStopAll}, "lease_unsupported: process_stop_all needs a lease request"},
	} {
		if err := checkRequestKind(tc.req); err == nil || err.Error() != tc.want {
			t.Errorf("checkRequestKind(%+v) = %v, want %q", tc.req, err, tc.want)
		}
	}
	long := strings.Repeat("k", MaxFrame)
	if err := checkRequestKind(Request{Lease: true, Kind: long}); err == nil || len(err.Error()) > 200 ||
		!strings.HasPrefix(err.Error(), "lease_unsupported: unknown kind kkk") {
		t.Errorf("a %d-byte kind: %.80v; want a clipped lease_unsupported refusal", len(long), err)
	}
}

func TestDisplayNameFallsBackToTheID(t *testing.T) {
	if got := displayName(TrackedProcess{ID: "3"}); got != "p3" {
		t.Errorf("unnamed: %q, want p3", got)
	}
	if got := displayName(TrackedProcess{ID: "3", Name: "web"}); got != "web" {
		t.Errorf("named: %q, want web", got)
	}
}

// The cwd must resolve inside the workspace, symlinks included; relative is relative
// to the workspace, and empty is the workspace itself. The result is symlink-free.
func TestResolveProcessCwd(t *testing.T) {
	work := t.TempDir()
	outside := t.TempDir()
	realWork, err := filepath.EvalSymlinks(work)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"sub", "sub/deep"} {
		if err := os.Mkdir(filepath.Join(work, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(work, "file"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	for name, target := range map[string]string{"in": "sub", "esc": outside, "up": "..", "dangling": "nope"} {
		if err := os.Symlink(target, filepath.Join(work, name)); err != nil {
			t.Fatal(err)
		}
	}
	for cwd, want := range map[string]string{
		"":                                realWork,
		work:                              realWork,
		"sub":                             filepath.Join(realWork, "sub"),
		"sub/deep/..":                     filepath.Join(realWork, "sub"),
		filepath.Join(work, "sub/deep"):   filepath.Join(realWork, "sub/deep"),
		"in":                              filepath.Join(realWork, "sub"),
		filepath.Join(work, "in", "deep"): filepath.Join(realWork, "sub/deep"),
	} {
		got, err := resolveProcessCwd(work, cwd)
		if err != nil || got != want {
			t.Errorf("resolveProcessCwd(%q) = %q, %v; want %q", cwd, got, err, want)
		}
	}
	for _, cwd := range []string{
		"/", outside, filepath.Dir(work), "..", "sub/../..", "esc", "up", "dangling", "nope", "file",
		filepath.Join(work, "esc"), work + "x",
	} {
		got, err := resolveProcessCwd(work, cwd)
		if err == nil || !strings.HasPrefix(err.Error(), "process_cwd: ") {
			t.Errorf("resolveProcessCwd(%q) = %q, %v; want a process_cwd: refusal", cwd, got, err)
		}
	}
}

// writeCgroupEvents fakes a cgroup directory's cgroup.events.
func writeCgroupEvents(t *testing.T, dir string, populated bool) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	v := "0"
	if populated {
		v = "1"
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.events"), []byte("populated "+v+"\nfrozen 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCgroupPopulated(t *testing.T) {
	dir := t.TempDir()
	if p, err := cgroupPopulated(filepath.Join(dir, "gone")); p || err != nil {
		t.Errorf("a removed cgroup: %v, %v; want false, nil", p, err)
	}
	writeCgroupEvents(t, filepath.Join(dir, "a"), true)
	writeCgroupEvents(t, filepath.Join(dir, "b"), false)
	if p, err := cgroupPopulated(filepath.Join(dir, "a")); !p || err != nil {
		t.Errorf("populated 1: %v, %v", p, err)
	}
	if p, err := cgroupPopulated(filepath.Join(dir, "b")); p || err != nil {
		t.Errorf("populated 0: %v, %v", p, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a", "cgroup.events"), []byte("frozen 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := cgroupPopulated(filepath.Join(dir, "a")); err == nil {
		t.Error("cgroup.events without a populated line: want an error")
	}
}

// Ruling P5-R9: populated is answered from the cgroup of every uid ever handed out, not
// from the table; an unreadable cgroup counts as populated (fail closed), a removed one
// as empty, and a uid's record moves to its new cgroup only once the old one is empty.
func TestTrackedCgroupsAnswerPopulatedPerUID(t *testing.T) {
	dir := t.TempDir()
	var c trackedCgroups
	if c.populated(20000) {
		t.Error("a uid never handed out reports populated")
	}
	p1 := filepath.Join(dir, "p1")
	writeCgroupEvents(t, p1, true)
	c.assign(20000, p1)
	if !c.populated(20000) {
		t.Error("uid 20000's cgroup is populated, but populated says no")
	}
	writeCgroupEvents(t, p1, false)
	if c.populated(20000) {
		t.Error("uid 20000's cgroup emptied, but populated says yes")
	}
	if err := os.WriteFile(filepath.Join(p1, "cgroup.events"), []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !c.populated(20000) {
		t.Error("an unreadable cgroup.events must count as populated")
	}
	writeCgroupEvents(t, p1, false)
	// A fake cgroup dir holds a regular file, so the old dir's rmdir fails here; the
	// record moves regardless (take saw it empty, and nothing can enter it again).
	p5 := filepath.Join(dir, "p5")
	writeCgroupEvents(t, p5, true)
	c.assign(20000, p5)
	if !c.populated(20000) {
		t.Error("after reassigning uid 20000 to p5, its populated cgroup is not seen")
	}
	c.assign(20001, filepath.Join(dir, "p6"))
	got := c.paths()
	slices.Sort(got)
	if want := []string{p5, filepath.Join(dir, "p6")}; !slices.Equal(got, want) {
		t.Errorf("paths = %q, want %q", got, want)
	}
}

func TestTrackedExitSignals(t *testing.T) {
	var s exitSignals
	ch := s.add("1")
	select {
	case <-ch:
		t.Fatal("fired before the exit")
	default:
	}
	if _, ok := s.final("1"); ok {
		t.Fatal("a final row before the exit")
	}
	row := TrackedProcess{ID: "1", Name: "web", PID: 412, State: TrackedExited, Code: 3}
	s.fire("1", row, true)
	s.fire("1", TrackedProcess{ID: "1", State: TrackedKilled}, true) // a second report is harmless
	s.fire("9", row, true)                                           // so is an unknown id
	select {
	case <-ch:
	default:
		t.Fatal("not fired after the exit")
	}
	if got, ok := s.final("1"); !ok || got != row {
		t.Fatalf("final row %+v, %t; want the first report's %+v", got, ok, row)
	}
	if _, ok := s.final("9"); ok {
		t.Fatal("an unknown id has a final row")
	}
	s.add("3")
	s.fire("3", TrackedProcess{}, false) // reaped, but the table had no running entry
	if _, ok := s.final("3"); ok {
		t.Fatal("an exit the table did not mark recorded a final row")
	}
	if s.get("1") != ch || s.get("2") != nil {
		t.Error("get returns the wrong channel")
	}
	s.add("2")
	s.retain(map[string]bool{"2": true})
	if s.get("1") != nil || s.get("2") == nil {
		t.Error("retain kept the wrong ids")
	}
}

func TestTrackedCgroupsAndExitSignalsUnderRace(t *testing.T) {
	dir := t.TempDir()
	var c trackedCgroups
	var s exitSignals
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := fmt.Sprint(i)
			p := filepath.Join(dir, id)
			writeCgroupEvents(t, p, i%2 == 0)
			c.assign(20000+i%4, p)
			_ = c.populated(20000 + i%4)
			_ = c.paths()
			s.add(id)
			s.fire(id, TrackedProcess{ID: id}, true)
			_ = s.get(id)
			_, _ = s.final(id)
		}()
	}
	wg.Wait()
}

func TestNewestWithinKeepsTheNewestLines(t *testing.T) {
	b := []byte("one\ntwo\nthree\n")
	for _, tc := range []struct {
		max     int64
		want    string
		dropped int64
	}{
		{100, "one\ntwo\nthree\n", 0},
		{int64(len(b)), "one\ntwo\nthree\n", 0},
		{10, "two\nthree\n", 4}, // the cut is a line start: nothing more goes
		{8, "three\n", 8},       // "o\nthree\n": moved on to the line start
		{6, "three\n", 8},       // exactly the last line
		{4, "ree\n", 10},        // a line longer than the cap: its raw end
	} {
		got, dropped := newestWithin(b, tc.max)
		if string(got) != tc.want || dropped != tc.dropped {
			t.Errorf("newestWithin(%d) = %q, %d; want %q, %d", tc.max, got, dropped, tc.want, tc.dropped)
		}
	}
}

// Task 3 review minor 2: a cwd error names the cwd clipped, and never the whole path
// again through the underlying error, so the frame stays small whatever was sent.
func TestResolveProcessCwdErrorsAreBounded(t *testing.T) {
	work := t.TempDir()
	long := strings.Repeat("d", 200) + "/" + strings.Repeat("e", 200)
	if err := os.MkdirAll(filepath.Join(work, long), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, long, "f"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, cwd := range []string{long + "/f/x", long + "/nope", strings.Repeat("x/", MaxFrame/2)} {
		_, err := resolveProcessCwd(work, cwd)
		if err == nil || !strings.HasPrefix(err.Error(), "process_cwd: ") || len(err.Error()) > 200 {
			t.Errorf("cwd of %d bytes: %d-byte error %.120q; want a process_cwd: refusal under 200 bytes", len(cwd), len(err.Error()), err)
		}
	}
}

func TestFrameWriterDropStdoutCountsTheCut(t *testing.T) {
	var buf bytes.Buffer
	w := &frameWriter{rw: &buf, cap: 1 << 20}
	w.dropStdout(5)
	w.dropStdout(0)
	w.dropStdout(-3)
	if w.droppedStdout != 5 {
		t.Fatalf("droppedStdout = %d, want 5", w.droppedStdout)
	}
}
