package main

// The lease notices sbx run prints to stderr. This is a Go port of leaseNotice, noticeLines and NoticeDedupe in
// packages/sandbox-client/src/lease.ts, which is the source of truth for the copy (spec §5): keep the two in step.
// The one deliberate difference is the dedupe of expiring events (see noticeDedupe).

import (
	"fmt"
	"io"
	"math"
	"strings"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

// hhmm is the event's time as local 24-hour HH:MM.
func hhmm(atUnixMs int64) string {
	t := time.UnixMilli(atUnixMs).Local()
	return fmt.Sprintf("%02d:%02d", t.Hour(), t.Minute())
}

// modeName is the mode's name on the wire and in the copy, as TS modeName: anything but lease modes is per-exec.
func modeName(m pb.SandboxMode) string {
	switch m {
	case pb.SandboxMode_SANDBOX_MODE_LEASE:
		return "lease"
	case pb.SandboxMode_SANDBOX_MODE_LEASE_PROCESSES:
		return "lease+processes"
	}
	return "per-exec"
}

// leaseNotice is the one line for a lease event (spec §5), or false for a state it does not know.
func leaseNotice(ev *pb.LeaseEvent, now time.Time) (string, bool) {
	switch ev.GetState() {
	case "end":
		var b strings.Builder
		fmt.Fprintf(&b, "[sandbox] guest restarted (%s, %s): /tmp, installs outside /workspace and background processes are gone",
			ev.GetReason(), hhmm(ev.GetAtUnixMs()))
		for _, p := range ev.GetProcesses() {
			fmt.Fprintf(&b, "; stopped: %s", p)
		}
		return b.String(), true
	case "expiring":
		// Only max_duration expires a lease, so the copy names it whatever reason says (P4-R8).
		// A worker that predates ends_by_unix_ms sends 0: no deadline to count down to.
		if ev.GetEndsByUnixMs() <= 0 {
			return "[sandbox] guest restarts soon (max_duration)", true
		}
		left := float64(ev.GetEndsByUnixMs()-now.UnixMilli()) / 60_000
		min := max(1, int64(math.Ceil(left)))
		return fmt.Sprintf("[sandbox] guest restarts within %d min (max_duration)", min), true
	case "start":
		return fmt.Sprintf("[sandbox] new guest (%s, %s)", modeName(ev.GetMode()), hhmm(ev.GetAtUnixMs())), true
	case "processes_stopped":
		// A downgrade from lease+processes stopped them (plan 5); the lease itself goes on.
		who := ""
		if ps := ev.GetProcesses(); len(ps) > 0 {
			who = ": " + strings.Join(ps, ", ")
		}
		return fmt.Sprintf("[sandbox] tracked processes stopped (%s, %s)%s", ev.GetReason(), hhmm(ev.GetAtUnixMs()), who), true
	}
	return "", false
}

// noticeLines is the notice lines for one result's lease events, already deduped (see noticeDedupe): a start only
// when no end is shown with it, and only the last expiring event (one result's Execs may straddle a minute boundary).
func noticeLines(fresh []*pb.LeaseEvent, now time.Time) []string {
	ended := false
	lastExpiring := -1
	for i, ev := range fresh {
		switch ev.GetState() {
		case "end":
			ended = true
		case "expiring":
			lastExpiring = i
		}
	}
	var lines []string
	for i, ev := range fresh {
		state := ev.GetState()
		if state == "start" && ended || state == "expiring" && i != lastExpiring {
			continue
		}
		if l, ok := leaseNotice(ev, now); ok {
			lines = append(lines, l)
		}
	}
	return lines
}

// noticeDedupe holds each event already printed in this run, by its state and at_unix_ms, as TS NoticeDedupe keys
// it: lease events are best-effort and may repeat (spec §5). Unlike TS NoticeDedupe, which shows an expiring event
// on every MCP result, an expiring event is deduped too: the spec prints each event once per run, and an expiring
// event's at_unix_ms is constant per lease (P4-R2), so a retried attempt's repeat is the same event.
type noticeDedupe map[string]bool

// take returns the events not printed before, marking them printed.
func (d noticeDedupe) take(evs []*pb.LeaseEvent) []*pb.LeaseEvent {
	var out []*pb.LeaseEvent
	for _, ev := range evs {
		key := fmt.Sprintf("%s:%d", ev.GetState(), ev.GetAtUnixMs())
		if d[key] {
			continue
		}
		d[key] = true
		out = append(out, ev)
	}
	return out
}

// printNotices writes one attempt's lease notices to w, each event once per run (d).
func printNotices(w io.Writer, d noticeDedupe, evs []*pb.LeaseEvent, now time.Time) {
	for _, l := range noticeLines(d.take(evs), now) {
		fmt.Fprintln(w, l)
	}
}
