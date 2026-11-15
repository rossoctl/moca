package vmpool

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	ga "github.com/rossoctl/moca/remote-worker/internal/guestagent"
)

// The host-side tracked mirror of a level-2 lease (plan 5): the tracked-process entry, the
// mirror's refresh from every lease End, its lease_process audit records, the lease end's
// audit field, and the stop of every tracked process when a lease leaves level 2.

// TrackedProcess is one entry of a lease guest's tracked-process table (plan 5), as the
// guest's End reports it (guestagent.TrackedProcess). State is running, exited or killed;
// Code is the exit code, or the signal number when killed. Started is the guest's clock,
// which every lease request sets from the host's (Request.HostUnixNanos).
type TrackedProcess struct {
	ID          string    `json:"id"`
	Name        string    `json:"name,omitempty"`
	PID         int       `json:"pid"`
	State       string    `json:"state"`
	Code        int       `json:"code,omitempty"`
	Started     time.Time `json:"started"`
	MemoryBytes int64     `json:"memory_bytes,omitempty"`
}

// DisplayName is how the process is shown: its name, or p<id> when it has none (ruling
// P5-R6). The guest already reports an unnamed process as p<id>; this is the same rule.
func (tp TrackedProcess) DisplayName() string {
	if tp.Name == "" {
		return "p" + tp.ID
	}
	return tp.Name
}

// Display is the process as clients render it: "<name> (pid <n>)".
func (tp TrackedProcess) Display() string {
	return fmt.Sprintf("%s (pid %d)", tp.DisplayName(), tp.PID)
}

// stateText is the process's state as process_list spells it (spec §7): running,
// exited(<code>) or killed(<signal>).
func (tp TrackedProcess) stateText() string {
	if tp.State == ga.TrackedRunning {
		return tp.State
	}
	return fmt.Sprintf("%s(%d)", tp.State, tp.Code)
}

func (tp TrackedProcess) running() bool { return tp.State == ga.TrackedRunning }

// runningTracked is the running entries of ps, nil when there are none.
func runningTracked(ps []TrackedProcess) []TrackedProcess {
	var out []TrackedProcess
	for _, tp := range ps {
		if tp.running() {
			out = append(out, tp)
		}
	}
	return out
}

// displays is each process's Display, nil for none.
func displays(ps []TrackedProcess) []string {
	var out []string
	for _, tp := range ps {
		out = append(out, tp.Display())
	}
	return out
}

// refreshTrackedLocked replaces l's tracked mirror with next, the table a lease End of
// Exec e reported (plan 5): every lease End carries the whole table, so the mirror is
// never stale, and an End without one (an empty table, or a level-1 agent) empties it. It
// writes a lease_process record for each start, stop and exit the change shows
// (auditTracked), and saves the mirror with the open lease when one did, so a
// worker_restart end lists what was running (endLeasesOpenAtStart). A change in memory
// alone is not saved: the file is fsynced under p.mu, and a worker_restart end has no use
// for a footprint. Caller holds p.mu and rp's gate, with l live.
func (p *pool) refreshTrackedLocked(rp *runPool, l *vmLease, e Exec, next []TrackedProcess) {
	var stopped map[string]bool
	if e.Kind == ExecKindProcessStop {
		if i := findTracked(next, e.Process); i >= 0 {
			stopped = map[string]bool{next[i].ID: true}
		}
	}
	p.replaceTrackedLocked(rp, l, l.mode, next, stopped)
}

// replaceTrackedLocked is refreshTrackedLocked's work: the mirror becomes next, the change
// is audited at mode, as a stop for each entry whose id is in stopped, and saved with the
// open lease when it changed. Caller holds p.mu and rp's gate, with l live.
func (p *pool) replaceTrackedLocked(rp *runPool, l *vmLease, mode Mode, next []TrackedProcess, stopped map[string]bool) {
	prev := l.tracked
	l.tracked = next
	if !auditTracked(rp.key, mode, stopped, prev, next) {
		return
	}
	s := p.leaseStateLocked(rp)
	if s.Open == nil {
		return
	}
	o := *s.Open // copied, not written through: the cached state may share it
	o.Tracked = next
	s.Open = &o
	if err := saveLeaseState(p.cfg.WorkspaceRoot, rp.key, s); err != nil {
		// The open record only lets a worker_restart end list the processes: losing it
		// loses that list, not safety (startLease's trade).
		log.Printf("vmpool: lease tracked processes for %q: %v", rp.key, err)
	}
	rp.state = s
}

// auditTracked writes the lease_process records (spec §7) for the change from prev to next,
// the mirror before and after a lease End, and reports whether the table changed in
// anything but memory. A new entry is a start; an entry that left running is an exit, or
// the stop when its id is in stopped (the process_stop that named it, or what a
// process_stop_all stopped), which is recorded even when the process had already exited
// (the stop still signals what its cgroup holds). A running entry that vanished is an exit
// with state gone (the guest never drops a running one), or a stop with state gone when
// it was stopped (the guest may evict an entry it has just stopped, ruling P5-R5). Each
// record carries the id, name, mode and workspace key, never the command text.
func auditTracked(key string, mode Mode, stopped map[string]bool, prev, next []TrackedProcess) bool {
	rec := func(event string, tp TrackedProcess, state string) {
		log.Printf("vmpool: lease_process event=%s workspace_key=%q mode=%s id=%q name=%q pid=%d state=%s code=%d",
			event, key, mode, tp.ID, tp.DisplayName(), tp.PID, state, tp.Code)
	}
	old := make(map[string]TrackedProcess, len(prev))
	for _, tp := range prev {
		old[tp.ID] = tp
	}
	changed := len(prev) != len(next)
	for _, tp := range next {
		was, ok := old[tp.ID]
		delete(old, tp.ID)
		if !ok {
			changed = true
			rec("start", tp, tp.State)
		} else {
			was.MemoryBytes, was.Started = tp.MemoryBytes, tp.Started
			changed = changed || was != tp
		}
		switch {
		case stopped[tp.ID]:
			// A guest that answers the stop before the process
			// dies leaves it running here, and a later End then writes its exit as well.
			rec("stop", tp, tp.State)
		case !tp.running() && (!ok || was.running()):
			rec("exit", tp, tp.State)
		}
	}
	for _, tp := range prev {
		if _, gone := old[tp.ID]; gone {
			changed = true
			switch {
			case stopped[tp.ID]:
				rec("stop", tp, "gone")
			case tp.running():
				rec("exit", tp, "gone")
			}
		}
	}
	return changed
}

// findTracked is the index in ps of the entry args names, as the guest finds it: by id when
// one is given, else by name, an id winning over an equal name (ruling P5-R6); -1 if none.
func findTracked(ps []TrackedProcess, args ProcessArgs) int {
	key := args.ID
	if key == "" {
		key = args.Name
	}
	if key == "" {
		return -1
	}
	for i, tp := range ps {
		if tp.ID == key {
			return i
		}
	}
	for i, tp := range ps {
		if tp.DisplayName() == key {
			return i
		}
	}
	return -1
}

// trackedAuditField is a lease end's audit field for its tracked processes (spec §4.1:
// id, name and exit state), " processes=[<id>:<name>:<state> ...]", or "" for none. Its
// parts are safe unquoted: every row came through trackedFromGuest, which keeps only ids
// of digits, names of [A-Za-z0-9._-] and the three states.
func trackedAuditField(ps []TrackedProcess) string {
	if len(ps) == 0 {
		return ""
	}
	parts := make([]string, len(ps))
	for i, tp := range ps {
		parts[i] = tp.ID + ":" + tp.DisplayName() + ":" + tp.stateText()
	}
	return " processes=[" + strings.Join(parts, " ") + "]"
}

// stopTrackedUnderGate stops l's tracked processes once the lease has left level 2 (spec
// §8.2: "from lease+processes to lease it stops every tracked process"). It sends the
// host-only process_stop_all, which stops every running tracked process and kills what
// exited ones left behind, so it is sent even when the mirror shows nothing running.
//
// On a clean End the lease is kept: the mirror is refreshed from the End, with a
// lease_process stop record for each process stopped (at lease+processes, the level they
// ran at), and notice is the processes_stopped event listing them -- what the guest
// reports it stopped, its stdout -- or nil when it stopped none. Otherwise the lease ends,
// and v is its victim, for the caller to destroy before it releases the gate:
// teardown_failed when the guest's teardown failed or the call itself failed (P5-R19; the
// end lists what the mirror shows running), mode_change when the guest refused the
// request (the processes must not outlive the downgrade at level 1), a cut's reason when
// one cut the stop, and a detach on a pool closed meanwhile.
//
// The stop runs under no caller's context: neither an Exec's abort nor its budget cuts it
// short (runLease's budget check sees the time it took). It gets ProcessKindMinTimeoutS
// (TERM, 10 s, cgroup.kill and the teardown bound), the host giving up LeaseTimeoutSlack
// later, and a cut (the sweep's grace limit, endLeaseWaiting's bound) cancels it as it
// would an Exec. Caller holds rp's gate, not p.mu, with l live and l.stopTracked set.
func (p *pool) stopTrackedUnderGate(rp *runPool, l *vmLease) (notice *LeaseEvent, v *leaseVictim) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tm := p.clk.AfterFunc(time.Duration(ProcessKindMinTimeoutS)*time.Second+LeaseTimeoutSlack, cancel)
	defer tm.Stop()
	p.mu.Lock()
	if cut := l.cut; cut != "" {
		// As runLease: a request written on a cancelled context could still reach the guest.
		v = p.endLeaseLocked(rp, cut)
		p.mu.Unlock()
		return nil, v
	}
	l.running, l.cancel = true, cancel
	p.mu.Unlock()

	var out stdoutBuffer
	res, err := l.vm.Run(ctx, Command{
		TimeoutS: ProcessKindMinTimeoutS,
		CapBytes: OutputCapBytes,
		Lease:    true,
		Kind:     execKindProcessStopAll,
	}, &out)

	p.mu.Lock()
	defer p.mu.Unlock()
	// Still rp's lease: only the gate's holder detaches one, and Close skips a held gate.
	l.running, l.cancel = false, nil
	l.stopTracked = false
	var reason LeaseEndReason
	_, refused := guestKeepsLease(err)
	switch {
	case l.cut != "":
		reason = l.cut
	case err != nil && refused:
		reason = LeaseEndModeChange
	case err != nil:
		reason = LeaseEndTeardownFailed
	}
	if err != nil {
		log.Printf("vmpool: lease process_stop_all workspace_key=%q vm=%s: %v", rp.key, vmID(l.vm), err)
	}
	var stopped []TrackedProcess
	if reason == "" {
		var ids map[string]bool
		if res.TeardownFailed {
			reason = LeaseEndTeardownFailed
		} else {
			stopped = stopAllAnswer(rp.key, out.b.Bytes())
			ids = make(map[string]bool, len(stopped))
			for _, tp := range stopped {
				ids[tp.ID] = true
			}
		}
		// Before the end below, so that it lists what the guest still shows running.
		p.replaceTrackedLocked(rp, l, ModeLeaseProcesses, res.Tracked, ids)
	}
	switch {
	case reason != "":
		return nil, p.endLeaseLocked(rp, reason)
	case p.closed:
		return nil, p.detachLeaseLocked(rp)
	}
	log.Printf("vmpool: lease processes stopped workspace_key=%q vm=%s mode=%s reason=%s%s",
		rp.key, vmID(l.vm), l.mode, LeaseEndModeChange, trackedAuditField(stopped))
	if len(stopped) == 0 {
		return nil, nil
	}
	now := p.clk.Now()
	return &LeaseEvent{State: leaseEventProcessesStopped, Reason: LeaseEndModeChange, At: leaseEventAt(now), Mode: l.mode,
		Age: now.Sub(l.started), Processes: displays(stopped), Tracked: stopped}, nil
}

// stopAllAnswer is what a process_stop_all's stdout says it stopped: the final rows of the
// processes that were running, a JSON array. One that does not parse is logged and lists
// none; the mirror, refreshed from the End's table, still holds every final state.
func stopAllAnswer(key string, stdout []byte) []TrackedProcess {
	var rows []ga.TrackedProcess
	if err := json.Unmarshal(stdout, &rows); err != nil {
		log.Printf("vmpool: lease process_stop_all workspace_key=%q: unreadable answer: %v", key, err)
		return nil
	}
	return trackedFromGuest(rows)
}

// stdoutBuffer is a Sink that keeps stdout and drops stderr. The guest caps each stream at
// the Command's CapBytes.
type stdoutBuffer struct{ b bytes.Buffer }

func (s *stdoutBuffer) Stdout(b []byte) { s.b.Write(b) }
func (s *stdoutBuffer) Stderr([]byte)   {}
