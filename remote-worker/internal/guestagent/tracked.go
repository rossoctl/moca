package guestagent

import (
	"bytes"
	"cmp"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The OS-independent parts of level 2, tracked processes (spec §7): each process's
// ring log, the table of tracked processes, and the allocator of their uids. The
// Linux handlers (process_start, list, logs, stop) are built on these.

// trackedLogCap is each tracked process's ring log: stdout and stderr combined, held in
// the agent's memory (global constraints).
const trackedLogCap = 4 << 20

// Ruling P5-R5 bounds what exited processes hold, since every lease End carries the
// whole table in one frame (MaxFrame) and each ring lives in agent memory: the table
// keeps at most trackedExitedKeep exited entries, evicting the oldest exited first, and
// an exited process's ring is trimmed to its last trackedExitedLogCap bytes.
const (
	trackedExitedKeep   = 8
	trackedExitedLogCap = 64 << 10
)

// defaultMaxProcesses is SH_LEASE_MAX_PROCESSES's default, the running cap when the
// host sends none (max_processes is omitempty).
const defaultMaxProcesses = 4

// ring keeps the last max bytes of a byte stream. It is an io.Writer, safe for the
// concurrent stdout and stderr drains of one process and a reader of its Tail.
// Memory grows with what was written, up to max, never past it.
type ring struct {
	mu  sync.Mutex
	max int
	// buf holds the bytes kept. While len(buf) < max nothing has been dropped and head
	// is 0; once full, buf is circular and the oldest byte is at head.
	buf  []byte
	head int
}

func newRing(max int) *ring { return &ring{max: max} }

// Write keeps p, dropping the oldest bytes past max. It never fails and always reports
// all of p written, so a drain never stops on it.
func (r *ring) Write(p []byte) (int, error) {
	n := len(p)
	// max included: shrink lowers it while a process's leftovers may still write.
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.max <= 0 {
		return n, nil
	}
	if len(p) > r.max {
		p = p[len(p)-r.max:]
	}
	if len(r.buf) < r.max {
		k := min(r.max-len(r.buf), len(p))
		if need := len(r.buf) + k; need > cap(r.buf) {
			// Grown by hand, not by append, so the capacity never passes max.
			nb := make([]byte, len(r.buf), min(max(2*cap(r.buf), need), r.max))
			copy(nb, r.buf)
			r.buf = nb
		}
		r.buf = append(r.buf, p[:k]...)
		p = p[k:]
	}
	for len(p) > 0 {
		k := copy(r.buf[r.head:], p)
		p = p[k:]
		r.head = (r.head + k) % r.max
	}
	return n, nil
}

// Tail returns a copy of the last lines lines held: a trailing newline ends the last
// line rather than starting an empty one, and an unterminated last line counts as a
// line. Asked for more lines than are held, it returns everything held; once the ring
// has dropped bytes, that first line may start mid-line. lines <= 0 returns nothing.
func (r *ring) Tail(lines int) []byte {
	if lines <= 0 {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	// The held bytes, oldest first, are a then b.
	a, b := r.buf[r.head:], r.buf[:r.head]
	total := len(a) + len(b)
	if total == 0 {
		return nil
	}
	last := a[len(a)-1]
	if len(b) > 0 {
		last = b[len(b)-1]
	}
	end := total // a newline before end starts a line
	if last == '\n' {
		end--
	}
	start := 0
	segs := [2]struct {
		s   []byte
		off int
	}{{b, len(a)}, {a, 0}}
search:
	for _, sg := range segs {
		seg := sg.s[:min(max(end-sg.off, 0), len(sg.s))]
		for {
			i := bytes.LastIndexByte(seg, '\n')
			if i < 0 {
				break
			}
			if lines--; lines == 0 {
				start = sg.off + i + 1
				break search
			}
			seg = seg[:i]
		}
	}
	return r.suffix(start)
}

// suffix copies the held bytes from logical offset start (0 is the oldest) to the end.
// The caller holds mu.
func (r *ring) suffix(start int) []byte {
	a, b := r.buf[r.head:], r.buf[:r.head]
	out := make([]byte, 0, len(a)+len(b)-start)
	if start < len(a) {
		out = append(out, a[start:]...)
		return append(out, b...)
	}
	return append(out, b[start-len(a):]...)
}

// shrink lowers the ring's cap to max, keeping the newest max bytes and freeing the
// rest. Later writes are held to the new cap. A max at or above the current cap is a
// no-op.
func (r *ring) shrink(max int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if max >= r.max {
		return
	}
	held := len(r.buf)
	r.buf = r.suffix(held - min(held, max)) // a fresh slice, cap == len <= max
	r.head, r.max = 0, max
}

// trackedEntry is one tracked process: its row in the table, plus what the handlers
// need and the host is not shown.
type trackedEntry struct {
	TrackedProcess
	UID int   // the tracked uid it runs as; the uidAllocator's to release
	Log *ring // its combined stdout and stderr
	// exitSeq orders the exited entries by when they exited (markExit), 1, 2, 3, …; 0
	// while running. Eviction goes by it, not by start order.
	exitSeq uint64
}

// trackedTable is the agent's table of tracked processes, oldest first. A running
// process's name is unique among the running ones; starting a name that only an exited
// entry holds replaces that entry. An exited entry otherwise stays, so the agent can
// read why it died (spec §7), until the lease ends or it is the first to have exited of
// more than trackedExitedKeep exited entries (ruling P5-R5, markExit). Ids are 1, 2, 3, …
// in start order, never reused within the agent's life.
type trackedTable struct {
	mu      sync.Mutex
	seq     uint64
	exitSeq uint64
	entries []*trackedEntry
}

// start applies the name and limit rules, then calls launch to start the process, and
// records it. maxRunning caps the running processes (SH_LEASE_MAX_PROCESSES); an exited
// one does not count, and maxRunning <= 0 means defaultMaxProcesses. An empty name is
// allowed and never clashes.
//
// launch gets the new entry's id and ring, and returns the process's pid and uid. It
// runs without the table's lock, with the entry already in the table as running, so a
// markExit for the id that arrives while launch runs (the process died at once) is
// kept, and a concurrent start sees the name and the slot as taken. If launch fails the
// entry is removed and its error returned; an exited entry of the same name is kept.
func (t *trackedTable) start(name string, maxRunning int, launch func(id string, log *ring) (pid, uid int, err error)) (TrackedProcess, error) {
	if maxRunning <= 0 {
		maxRunning = defaultMaxProcesses
	}
	t.mu.Lock()
	running := 0
	for _, e := range t.entries {
		if e.State != TrackedRunning {
			continue
		}
		if name != "" && e.Name == name {
			t.mu.Unlock()
			return TrackedProcess{}, fmt.Errorf("process_name_taken: %s", name)
		}
		running++
	}
	if running >= maxRunning {
		t.mu.Unlock()
		return TrackedProcess{}, fmt.Errorf("process_limit: %d running (SH_LEASE_MAX_PROCESSES)", maxRunning)
	}
	t.seq++
	e := &trackedEntry{
		TrackedProcess: TrackedProcess{
			ID: strconv.FormatUint(t.seq, 10), Name: name, State: TrackedRunning,
			StartedUnixMs: time.Now().UnixMilli(),
		},
		Log: newRing(trackedLogCap),
	}
	t.entries = append(t.entries, e)
	t.mu.Unlock()

	pid, uid, err := launch(e.ID, e.Log)

	t.mu.Lock()
	defer t.mu.Unlock()
	t.entries = removeEntries(t.entries, func(o *trackedEntry) bool {
		if o == e {
			return err != nil
		}
		return err == nil && name != "" && o.Name == name && o.State != TrackedRunning
	})
	if err != nil {
		return TrackedProcess{}, err
	}
	e.PID, e.UID = pid, uid
	return e.TrackedProcess, nil
}

func removeEntries(es []*trackedEntry, drop func(*trackedEntry) bool) []*trackedEntry {
	out := es[:0]
	for _, e := range es {
		if !drop(e) {
			out = append(out, e)
		}
	}
	clear(es[len(out):])
	return out
}

// lookup finds an entry by id, or else by name, and returns a copy of it. An id wins
// over a name: a process named "2" is found by its name only when no entry has id 2.
func (t *trackedTable) lookup(idOrName string) (trackedEntry, bool) {
	if idOrName == "" {
		return trackedEntry{}, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, e := range t.entries {
		if e.ID == idOrName {
			return *e, true
		}
	}
	for _, e := range t.entries {
		if e.Name == idOrName {
			return *e, true
		}
	}
	return trackedEntry{}, false
}

// list returns the table's rows, oldest first. MemoryBytes is left 0: it is the
// caller's to read from each process's cgroup.
func (t *trackedTable) list() []TrackedProcess {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]TrackedProcess, len(t.entries))
	for i, e := range t.entries {
		out[i] = e.TrackedProcess
	}
	return out
}

// markExit records that the process id exited: killed(signal) when signal > 0, else
// exited(code). Only a running entry changes, so a second report is ignored; so is an
// unknown id. Ruling P5-R5: the exited process's ring is trimmed to its last
// trackedExitedLogCap bytes, and past trackedExitedKeep exited entries the one that
// exited first is evicted, ring and all. That goes by the order of exits, not of starts,
// and never takes the entry this call marked: a long-lived process that dies after many
// short ones stays, so the agent can read why it died (PR #814 review). A running entry
// is never evicted.
//
// It returns the marked entry's final row and whether it marked one, and copies of the
// evicted entries (ruling P5-R9). Eviction forgets a process
// whose cgroup may still hold its children, so the caller must keep that cgroup, and
// the uid's hold on it, until it is empty: the uidAllocator's populated is answered
// from the cgroup of every uid ever handed out, never from this table.
func (t *trackedTable) markExit(id string, code, signal int) (TrackedProcess, bool, []trackedEntry) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, e := range t.entries {
		if e.ID != id || e.State != TrackedRunning {
			continue
		}
		if signal > 0 {
			e.State, e.Code = TrackedKilled, signal
		} else {
			e.State, e.Code = TrackedExited, code
		}
		t.exitSeq++
		e.exitSeq = t.exitSeq
		e.Log.shrink(trackedExitedLogCap)
		return e.TrackedProcess, true, t.evictExited(e)
	}
	return TrackedProcess{}, false, nil
}

// evictExited drops the exited entries that exited first, past trackedExitedKeep, never
// keep, and returns copies of them. The caller holds mu.
func (t *trackedTable) evictExited(keep *trackedEntry) []trackedEntry {
	var exited []*trackedEntry
	for _, e := range t.entries {
		if e.State != TrackedRunning && e != keep {
			exited = append(exited, e)
		}
	}
	// keep is exited too, and counts towards the cap.
	excess := len(exited) + 1 - trackedExitedKeep
	if excess <= 0 {
		return nil
	}
	slices.SortFunc(exited, func(a, b *trackedEntry) int { return cmp.Compare(a.exitSeq, b.exitSeq) })
	drop := make(map[*trackedEntry]bool, excess)
	var evicted []trackedEntry
	for _, e := range exited[:min(excess, len(exited))] {
		drop[e] = true
		evicted = append(evicted, *e)
	}
	t.entries = removeEntries(t.entries, func(e *trackedEntry) bool { return drop[e] })
	return evicted
}

// uidAllocator hands out the tracked uids base .. base+n-1, one per tracked process
// (spec §3.3). A uid is held from take until release, and take also skips any uid the
// caller reports populated: a tracked process's children can outlive it in its cgroup,
// and a new process under the same uid could then ptrace them. The caller answers
// populated from real cgroups, through a uid -> cgroup map of its own that outlives the
// trackedTable's entries (ruling P5-R9: an evicted entry's cgroup can still be
// populated). Uids are handed out in turn, so a released one is the last to be reused.
type uidAllocator struct {
	mu    sync.Mutex
	base  int
	n     int
	next  int // the index take starts searching at
	inUse map[int]bool
}

func newUIDAllocator(base, n int) *uidAllocator {
	return &uidAllocator{base: base, n: n, inUse: map[int]bool{}}
}

// take returns a free uid whose cgroup populated does not report populated, or an error
// when there is none. populated is called with the allocator's lock held.
func (a *uidAllocator) take(populated func(uid int) bool) (int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i := 0; i < a.n; i++ {
		idx := (a.next + i) % a.n
		uid := a.base + idx
		if a.inUse[uid] || populated(uid) {
			continue
		}
		a.inUse[uid] = true
		a.next = (idx + 1) % a.n
		return uid, nil
	}
	return 0, fmt.Errorf("guest-agent: no free tracked uid: all %d from %d are in use or still populated", a.n, a.base)
}

// release returns uid to the pool. A uid outside the range, or not held, is ignored.
func (a *uidAllocator) release(uid int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.inUse, uid)
}

// user is the passwd name of a tracked uid, sbxp<n> for base+n, as the image's passwd
// lines name them (global constraints).
func (a *uidAllocator) user(uid int) string { return "sbxp" + strconv.Itoa(uid-a.base) }

// processNameRE is ruling P5-R8's name rule: 1-64 characters of [A-Za-z0-9._-]. It
// bounds the End frame and keeps a name safe in logs and in `<name> (pid <n>)`.
var processNameRE = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// idShapedNameRE is ruling P5-R33: a name shaped like an id (n, or p<n> as clients show
// ids) is refused, because an id wins over a name in lookups (P5-R6), so such a name
// could make a client's p<n> address another process than the one it shows.
var idShapedNameRE = regexp.MustCompile(`^p?[0-9]+$`)

// processNameWant is the rule as a refusal names it. The clients' check (sandbox-client
// processNameProblem) accepts the same set of names, with the same text; the quoting of a
// refused control character may differ (Go %q vs JSON).
const processNameWant = "want 1-64 characters of [A-Za-z0-9._-], not shaped like an id (p<n>)"

// validateProcessName refuses a name outside rulings P5-R8 and P5-R33 with
// process_name_invalid. An empty name is an unnamed process, which is allowed. A name too
// long is described, not echoed, so the refusal always fits one frame.
func validateProcessName(name string) error {
	if name == "" || (processNameRE.MatchString(name) && !idShapedNameRE.MatchString(name)) {
		return nil
	}
	if len(name) > 64 {
		return fmt.Errorf("process_name_invalid: a name of %d bytes: %s", len(name), processNameWant)
	}
	return fmt.Errorf("process_name_invalid: %q: %s", name, processNameWant)
}

// clip shortens s for an error message, which must fit one frame (MaxFrame).
func clip(s string) string {
	const n = 64
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// checkRequestKind is ruling P5-R6's kind rule, applied before anything runs: an unset
// kind or `command` is a command, a process kind needs a lease request, and any other
// kind is refused, never run as a command. An older agent ignored the field and ran the
// command, which is why the host sends a process kind only to a snapshot that
// advertises lease-processes-v1.
func checkRequestKind(req Request) error {
	switch req.Kind {
	case "", RequestKindCommand:
		return nil
	case RequestKindProcessStart, RequestKindProcessList, RequestKindProcessLogs,
		RequestKindProcessStop, RequestKindProcessStopAll:
		if !req.Lease {
			return fmt.Errorf("lease_unsupported: %s needs a lease request", req.Kind)
		}
		return nil
	}
	return fmt.Errorf("lease_unsupported: unknown kind %s", clip(req.Kind))
}

// displayName is how a tracked process is shown (ruling P5-R6): its name, or p<id> when
// it has none. The table keeps an unnamed process's name empty, so it never clashes.
func displayName(p TrackedProcess) string {
	if p.Name == "" {
		return "p" + p.ID
	}
	return p.Name
}

// resolveProcessCwd is process_start's cwd: the workspace when cwd is empty, relative
// paths taken from the workspace. It resolves every symlink and refuses, with
// process_cwd, anything that does not then lie inside the workspace or is not a
// directory. The result is symlink-free. This is the tool's contract, not a boundary:
// the process runs unprivileged and may cd anywhere its uid can reach.
func resolveProcessCwd(workDir, cwd string) (string, error) {
	root, err := filepath.EvalSymlinks(workDir)
	if err != nil {
		return "", fmt.Errorf("process_cwd: the workspace: %v", err)
	}
	p := cwd
	switch {
	case p == "":
		p = workDir
	case !filepath.IsAbs(p):
		p = filepath.Join(workDir, p)
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("process_cwd: %s: no such directory", clip(cwd))
		}
		return "", fmt.Errorf("process_cwd: %s: %v", clip(cwd), pathErrCause(err))
	}
	if real != root && !strings.HasPrefix(real, root+string(filepath.Separator)) {
		return "", fmt.Errorf("process_cwd: %s: outside the workspace", clip(cwd))
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", fmt.Errorf("process_cwd: %s: %v", clip(cwd), pathErrCause(err))
	}
	if !fi.IsDir() {
		return "", fmt.Errorf("process_cwd: %s: not a directory", clip(cwd))
	}
	return real, nil
}

// pathErrCause is err without the path a *fs.PathError carries, which may be as long as
// the request allowed: the caller names the path, clipped, itself.
func pathErrCause(err error) error {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

// newestWithin keeps the newest bytes of b that fit in max and returns them with the
// count of bytes cut. A cut inside a line moves on to the next line start, when there is
// one; a b that fits is returned whole.
func newestWithin(b []byte, max int64) ([]byte, int64) {
	if max <= 0 || int64(len(b)) <= max {
		return b, 0
	}
	cut := int64(len(b)) - max
	keep := b[cut:]
	if b[cut-1] != '\n' {
		if i := bytes.IndexByte(keep, '\n'); i >= 0 && i+1 < len(keep) {
			keep = keep[i+1:]
		}
	}
	return keep, int64(len(b) - len(keep))
}

// cgroupPopulated reads a cgroup's cgroup.events. A cgroup that no longer exists is
// empty; a file without a populated line is an error.
func cgroupPopulated(path string) (bool, error) {
	ev, err := os.ReadFile(filepath.Join(path, "cgroup.events"))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for line := range bytes.Lines(ev) {
		switch string(bytes.TrimSpace(line)) {
		case "populated 0":
			return false, nil
		case "populated 1":
			return true, nil
		}
	}
	return false, fmt.Errorf("%s/cgroup.events: no populated line", path)
}

// trackedCgroups is ruling P5-R9's map: for every tracked uid ever handed out, the
// cgroup of the last process that ran under it. It is independent of the trackedTable,
// which forgets entries (eviction, name replacement) whose cgroups may still hold
// children, so the uidAllocator's populated is answered from here. Its lock is its own:
// populated runs under the allocator's lock, so nothing here may call the allocator.
type trackedCgroups struct {
	mu    sync.Mutex
	byUID map[int]string
}

// populated reports whether uid's cgroup still holds a process. A cgroup that cannot be
// read counts as populated: the uid is then not reused, which is the safe side.
func (c *trackedCgroups) populated(uid int) bool {
	c.mu.Lock()
	path, ok := c.byUID[uid]
	c.mu.Unlock()
	if !ok {
		return false
	}
	p, err := cgroupPopulated(path)
	return p || err != nil
}

// assign records path as uid's cgroup. The uid's previous cgroup was empty when take
// handed the uid out, and nothing enters a tracked cgroup but its own process at clone
// time, so it is removed and forgotten (a failed rmdir leaves an empty directory).
func (c *trackedCgroups) assign(uid int, path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.byUID == nil {
		c.byUID = map[int]string{}
	}
	if old, ok := c.byUID[uid]; ok && old != path {
		_ = os.Remove(old)
	}
	c.byUID[uid] = path
}

// paths returns every recorded cgroup, one per uid ever handed out; some may be gone.
func (c *trackedCgroups) paths() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.byUID))
	for _, p := range c.byUID {
		out = append(out, p)
	}
	return out
}

// exitSignals holds, per tracked id, a channel closed once its process has been reaped,
// and the final row the reaper recorded then, so process_stop can answer the exit status
// even when the table has already evicted the entry (ruling P5-R5).
type exitSignals struct {
	mu sync.Mutex
	m  map[string]*exitSignal
}

type exitSignal struct {
	ch       chan struct{}
	final    TrackedProcess
	recorded bool
}

func (s *exitSignals) add(id string) chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m == nil {
		s.m = map[string]*exitSignal{}
	}
	sig := &exitSignal{ch: make(chan struct{})}
	s.m[id] = sig
	return sig.ch
}

// fire records final, the row markExit returned (when marked, it changed a running entry),
// and closes id's channel. A second call, or an unknown id, does nothing.
func (s *exitSignals) fire(id string, final TrackedProcess, marked bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sig, ok := s.m[id]
	if !ok {
		return
	}
	select {
	case <-sig.ch:
	default:
		sig.final, sig.recorded = final, marked
		close(sig.ch)
	}
}

// get returns id's channel, or nil.
func (s *exitSignals) get(id string) chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sig, ok := s.m[id]; ok {
		return sig.ch
	}
	return nil
}

// final returns the row the reaper recorded at id's exit, if it recorded one.
func (s *exitSignals) final(id string) (TrackedProcess, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sig, ok := s.m[id]; ok && sig.recorded {
		return sig.final, true
	}
	return TrackedProcess{}, false
}

// retain forgets every id not in keep.
func (s *exitSignals) retain(keep map[string]bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.m {
		if !keep[id] {
			delete(s.m, id)
		}
	}
}

// finalRow is p's row once its exit has been waited for, at most wait: the table's row
// while the entry is there, else (the table evicted it, P5-R5) the row the reaper
// recorded at its exit, never the row taken before a stop. p itself is left only when
// neither exists, which no caller reaches: a running entry stays in the table until its
// exit is recorded, and its signal is kept until the next prune.
func finalRow(t *trackedTable, s *exitSignals, p TrackedProcess, wait time.Duration) TrackedProcess {
	if p.State == TrackedRunning {
		if ch := s.get(p.ID); ch != nil {
			select {
			case <-ch:
			case <-time.After(wait):
			}
		}
	}
	if e, ok := t.lookup(p.ID); ok && e.ID == p.ID {
		return e.TrackedProcess
	}
	if final, ok := s.final(p.ID); ok {
		return final
	}
	return p
}
