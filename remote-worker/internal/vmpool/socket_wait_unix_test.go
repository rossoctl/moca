//go:build unix

package vmpool

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/shortdir"
)

// A base with room for "/fc.sock", not t.TempDir(): sun_path caps at 104 bytes on darwin (108 on
// linux), and t.TempDir() on darwin is already ~70 before any suffix -- the same reason
// launcher_firecracker_collision_unix_test.go's collisionLauncher does this. shortdir picks TMPDIR
// when a directory under it leaves that room, and falls back to /tmp when it does not.
func sockBase(t *testing.T) string {
	t.Helper()
	base := shortdir.New(t, "sockwait", len("/fc.sock"))
	return base
}

// Issue #304. waitForUnixSocket retried on a FIXED 20 ms sleep, so every restore paid at
// least one full quantum however fast Firecracker actually bound its socket.
//
// Measured on srv-r16b14s16 over 1,625 restores on an idle box: sockwait 24.92 ms of a
// 27.73 ms restore -- 89.9% -- over 2.80 ms of real work (prep 0.22 + wsimg 0.05 + jailer
// 0.39 + loadsnap 2.14). The distribution was quantized with no tail below the quantum:
// min 20.06 ms, ZERO of 1,625 under 20 ms, 78.2% in [20,40), 21.8% in [40,60).
//
// The quantum was a measurement FLOOR, and removing it was worth ~11% on the mean (24.92 ->
// 22.24 ms), NOT the ~5x #304 predicted: the socket genuinely takes ~10-40 ms to bind on that
// host, so most of sockwait was never our sleep. TestWaitForUnixSocketBackoffGrowsAndIsCapped pins
// that the floor is gone; this test is the end-to-end half, that a real bind on a real filesystem
// is noticed at all.
func TestWaitForUnixSocketNoticesARealBind(t *testing.T) {
	path := filepath.Join(sockBase(t), "fc.sock")

	// Stands in for Firecracker binding its API socket a couple of ms after the jailer
	// execs it. The bind error comes BACK rather than being swallowed: a failed bind (an
	// unwritable /tmp, a sun_path overflow -- the hazard sockBase exists to avoid) would
	// otherwise surface as a 5 s timeout and read as "the production poll is broken", which
	// is exactly the wrong diagnosis. Close happens inside this goroutine too: t.Cleanup
	// registered from a non-test goroutine races the test's return, and waitForUnixSocket can
	// return the instant the bind is visible, so a cleanup registered after tRunner drained
	// the list never runs and the listener fd leaks for the life of the test binary.
	bindErr := make(chan error, 1)
	done := make(chan struct{})
	defer close(done)
	go func() {
		time.Sleep(2 * time.Millisecond)
		l, err := net.Listen("unix", path)
		bindErr <- err
		if err == nil {
			defer func() { _ = l.Close() }()
			<-done
		}
	}()

	err := waitForUnixSocket(context.Background(), path, testWaitBound)
	if be := <-bindErr; be != nil {
		t.Fatalf("FIXTURE failed to bind %s: %v (not a failure of waitForUnixSocket)", path, be)
	}
	if err != nil {
		t.Fatalf("waitForUnixSocket: %v", err)
	}
}

// The overall timeout is a refusal path and must not be loosened by finer polling. It is
// also reachable in practice: the c=64 rung behind #255 took 396 of these.
func TestWaitForUnixSocketStillHonoursItsOverallTimeout(t *testing.T) {
	path := filepath.Join(sockBase(t), "never.sock")
	start := time.Now()
	errc := make(chan error, 1)
	go func() { errc <- waitForUnixSocket(context.Background(), path, 80*time.Millisecond) }()
	err := recvWithin(t, errc, "a wait for a socket that never appears")
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("waitForUnixSocket succeeded against a socket that never appeared")
	}
	// Names the budget and the path, so a run log says what was waited for.
	for _, want := range []string{"80ms", path} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("timeout error omits %q: %v", want, err)
		}
	}
	if elapsed < 80*time.Millisecond {
		t.Fatalf("returned after %v, before its own %v budget", elapsed, 80*time.Millisecond)
	}
}

// ctx cancellation is the other refusal path: Restore's cleanup() depends on it to unwind
// promptly rather than sitting out the full timeout.
func TestWaitForUnixSocketStillHonoursContextCancellation(t *testing.T) {
	path := filepath.Join(sockBase(t), "never.sock")
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(5 * time.Millisecond); cancel() }()

	// A wait that ignored ctx would sit out testWaitBound and fail with its timeout error.
	err := waitForUnixSocket(ctx, path, testWaitBound)
	if err == nil {
		t.Fatal("waitForUnixSocket succeeded despite a cancelled context")
	}
	if !strings.Contains(err.Error(), context.Canceled.Error()) {
		t.Fatalf("want a context error, got: %v", err)
	}
}

// It must DIAL, not stat. Firecracker creates the socket file before it accept()s, and
// fcJailOccupied's id-collision guard rests on the same distinction -- so a path that
// exists but answers nothing must NOT read as ready, or a restore proceeds against a
// socket no VMM is serving.
func TestWaitForUnixSocketDialsRatherThanStats(t *testing.T) {
	path := filepath.Join(sockBase(t), "plain-file.sock")
	if err := os.WriteFile(path, []byte("not a socket"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Non-vacuousness: stat must succeed, or this proves nothing about dial-vs-stat.
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("fixture: the path must exist for stat: %v", err)
	}
	if err := waitForUnixSocket(context.Background(), path, 60*time.Millisecond); err == nil {
		t.Fatal("a plain file at the socket path was accepted as ready -- this stats instead of dialling")
	}
}

// The backoff schedule itself, pinned from the SLEEP REQUESTS rather than by wall clock
// or probe count. Both alternatives provably cannot do this on CI's shared runners:
// deleting the growth and the cap outright (a flat 250 us poll) left every other test
// in this file green at -count=2, and setting socketPollMax to 2s left the timeout test
// green at -count=3; meanwhile CI recorded 97 probes over a nominal ~197 with the
// schedule INTACT, because time.Sleep on a loaded runner overshoots by more than the
// intervals being pinned. The requested durations are the only deterministic signal:
// the loop must ask for socketPollMin first, grow it by Num/Den, and never exceed
// socketPollMax -- which is exactly the property the pacing rationale says the growth
// exists to prevent (a flat fine poll burns ~4,000 probes/s per waiter).
func TestWaitForUnixSocketBackoffGrowsAndIsCapped(t *testing.T) {
	path := filepath.Join(sockBase(t), "never.sock")

	// 64 samples is ample — the growth phase is 9 requests before the cap first
	// applies -- and bounded, because a stubbed sleep makes the loop spin as fast
	// as probing allows: an unbounded run would collect millions of samples in one
	// budget. Ending the sleep early returns an error from the wait, which ends
	// this test's business; the error's value is the cancellation path's own test.
	var asked []time.Duration
	restore := socketSleep
	socketSleep = func(_ context.Context, d time.Duration) error {
		asked = append(asked, d)
		if len(asked) < 64 {
			return nil
		}
		return context.Canceled
	}
	t.Cleanup(func() { socketSleep = restore })

	// The probe never answers, which is what drives the loop to keep sleeping.
	restoreProbe := socketProbe
	socketProbe = func(string) bool { return false }
	t.Cleanup(func() { socketProbe = restoreProbe })

	if err := waitForUnixSocket(context.Background(), path, time.Second); err == nil {
		t.Fatal("waitForUnixSocket succeeded against a probe that never answers")
	}
	if len(asked) < 10 {
		t.Fatalf("only %d sleep requests collected; the loop exited before the schedule could be pinned", len(asked))
	}

	// The FIRST retry must stay fine, which is the property the measured distribution
	// actually cares about: a socket binding inside the first millisecond must not wait
	// a coarse interval for its second look.
	if asked[0] != socketPollMin {
		t.Fatalf("first sleep request = %v, want socketPollMin = %v", asked[0], socketPollMin)
	}
	if socketPollMin > 500*time.Microsecond {
		t.Fatalf("socketPollMin = %v: the first retry is no longer fine-grained", socketPollMin)
	}
	if socketPollMax > 2*time.Millisecond {
		t.Fatalf("socketPollMax = %v: coarser than this re-inflates every sockwait measurement "+
			"by up to the cap, which is what made the 5 ms version read as a continuous distribution",
			socketPollMax)
	}
	// Every request below the plateau is the previous grown by Num/Den, or the cap
	// itself — the same integer arithmetic the loop uses. A flat fine poll (growth
	// removed) fails on the second request; a runaway growth fails the bound below.
	capped := false
	for i, d := range asked {
		if d > socketPollMax {
			t.Fatalf("sleep request %d = %v, above the socketPollMax = %v cap", i, d, socketPollMax)
		}
		if d == socketPollMax {
			capped = true
		}
		if i == 0 {
			continue
		}
		if d == socketPollMax && asked[i-1] == socketPollMax {
			break // the plateau; nothing further to pin
		}
		if want := min(asked[i-1]*socketPollGrowthNum/socketPollGrowthDen, socketPollMax); d != want {
			t.Fatalf("sleep request %d = %v, want %v (previous %v grown %d/%d, capped at %v)",
				i, d, want, asked[i-1], socketPollGrowthNum, socketPollGrowthDen, socketPollMax)
		}
	}
	// And the cap must actually be reached, not merely obeyed: a growth that stalls
	// below it would leave the loop fine-polling forever.
	if !capped {
		t.Fatalf("the schedule never reached socketPollMax = %v; requests were %v",
			socketPollMax, asked)
	}
}
