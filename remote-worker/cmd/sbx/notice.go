package main

// The lease notices sbx run prints to stderr. This is a Go port of leaseNotice, noticeLines and NoticeDedupe in
// packages/sandbox-client/src/lease.ts, which is the source of truth for the copy (spec §5): keep the two in step.

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

// noticeDedupe holds the at_unix_ms of each event already printed in this run: lease events are best-effort and may
// repeat (spec §5). An expiring event is never deduped, since every result carries it while the lease is expiring.
type noticeDedupe map[int64]bool

// take returns the events not printed before, marking them printed.
func (d noticeDedupe) take(evs []*pb.LeaseEvent) []*pb.LeaseEvent {
	var out []*pb.LeaseEvent
	for _, ev := range evs {
		if ev.GetState() == "expiring" {
			out = append(out, ev)
			continue
		}
		if d[ev.GetAtUnixMs()] {
			continue
		}
		d[ev.GetAtUnixMs()] = true
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
