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

// collisionLauncher builds a Firecracker launcher whose JailerBin is a script that
// records every invocation, so a test can assert that nothing was spawned. No KVM and
// no real Firecracker: everything asserted here happens strictly before jailer would
// be exec'd, which is the whole point — the guard has to refuse BEFORE it creates,
// spawns or removes anything.
//
// The chroot base comes from shortdir rather than t.TempDir() on purpose: the jail's
// API socket path is a unix socket, and sun_path caps out at 104 bytes on darwin (108
// on linux). t.TempDir() on darwin is already ~70 bytes before the
// /firecracker/<id>/root/run/firecracker.socket suffix is appended, which would make
// this test fail on path length rather than on the property under test. The suffix
// passed to shortdir.New is the worst case, with the longest id nextIDLocked can mint
// (vm- plus 20 digits), because that is what NewFirecrackerLauncher's validate checks:
// a TMPDIR too long to hold it costs a fallback to /tmp rather than a refused launcher.
func collisionLauncher(t *testing.T) (Launcher, string, string) {
	t.Helper()
	base := shortdir.New(t, "fcguard", len("/firecracker/vm-99999999999999999999/root/run/firecracker.socket"))

	marker := filepath.Join(base, "jailer-was-spawned")
	jailer := filepath.Join(base, "jailer")
	script := "#!/bin/sh\necho \"$@\" >>" + marker + "\nexit 0\n"
	if err := os.WriteFile(jailer, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake jailer: %v", err)
	}
	// Basename "firecracker" is load-bearing: it is the middle segment of jailer's own
	// chroot convention, <chroot-base>/<exec-file basename>/<id>/root.
	lc, err := NewFirecrackerLauncher(FirecrackerOptions{
		JailerBin:      jailer,
		FirecrackerBin: filepath.Join(base, "firecracker"),
		ChrootBase:     base,
		SnapshotDir:    base,
	})
	if err != nil {
		t.Fatalf("NewFirecrackerLauncher: %v", err)
	}
	return lc, base, marker
}

// occupyJail creates the jail layout for id and binds a LIVE unix listener at the API
// socket path — standing in for exactly what the rig produced: a leaked firecracker
// from an earlier process still accept()ing on that id's socket. Returns the socket
// path.
func occupyJail(t *testing.T, base, id string) string {
	t.Helper()
	jailRoot := filepath.Join(base, "firecracker", id, "root")
	if err := os.MkdirAll(filepath.Join(jailRoot, "run"), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	sock := filepath.Join(jailRoot, apiSockRelPath)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen on %s: %v", sock, err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	return sock
}

// TestFirecrackerRefusesAJailALiveVMMStillHolds is the second half of the teardown-bulk
// diagnosis (see the ledger). A leaked VMM from an earlier process leaves a LIVE
// listener on its VM id's API socket. waitForUnixSocket DIALS rather than stats — that
// is correct, since Firecracker creates the socket file before accept()ing on it — so a
// leftover live listener reads as a successful restore, and LoadSnapshot then lands on a
// microVM that is already loaded: "not supported after starting the microVM" (400).
//
// Two harms, both fixed by refusing early. The 400 names neither the collision nor the
// leaked id, so it points the reader at the snapshot rather than at the real cause. And
// Restore's own cleanup() then does os.RemoveAll(jailRoot) on the LIVE foreign VM's jail
// while killing only the process group of the jailer IT started — deleting a running
// VM's files and leaving the VM itself alive, which is precisely why the E10 run found a
// leaked firecracker that had supposedly been cleaned up.
//
// A collision can arise from causes no amount of Close-side tidiness can prevent
// (SIGKILL, OOM-kill, a crash), so this guard is not redundant with fixing the leak:
// it is what makes the next run fail honestly instead of hijacking a stranger.
func TestFirecrackerRefusesAJailALiveVMMStillHolds(t *testing.T) {
	lc, base, marker := collisionLauncher(t)
	sock := occupyJail(t, base, "vm-6")

	_, err := lc.Restore(context.Background(), RestoreRequest{
		ID: "vm-6", Key: "run-a", WorkspaceDir: t.TempDir(), GuestRAMBytes: 256 << 20,
	})
	if err == nil {
		t.Fatal("Restore succeeded into a jail a live VMM still holds — it loaded a snapshot into a stranger's microVM")
	}
	// The message must name the id and the socket: the whole defect of the 400 is that
	// it named neither, so the reader looked at the snapshot for a day.
	for _, want := range []string{"vm-6", sock} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("Restore error does not mention %q, so it cannot point at the collision: %v", want, err)
		}
	}
	// Nothing spawned: the guard must precede exec.Command, not merely precede
	// LoadSnapshot.
	if _, statErr := os.Stat(marker); statErr == nil {
		t.Error("Restore spawned jailer before refusing — the guard runs too late to be a refusal")
	}
	// And the live VM's jail must be intact. cleanup()'s RemoveAll must never reach a
	// jail this Restore did not create.
	if _, statErr := os.Stat(sock); statErr != nil {
		t.Errorf("Restore removed the live VMM's API socket: %v", statErr)
	}
}

// TestFirecrackerProceedsPastTheCollisionGuardWhenTheJailIsFree is the reachability
// half of the pair (branch discipline #3: a test for an absence must first prove the
// presence is reachable). A guard that refused unconditionally would satisfy the test
// above while breaking every restore — several defects on this branch were guards that
// were present but unreachable, so the converse gets asserted too.
//
// With no listener on the socket, Restore must get PAST the guard. It still fails after
// that, on the fake jailer's absent snapshot, and the distinction between the two
// failures is the assertion: reaching jailer at all proves the guard did not fire.
func TestFirecrackerProceedsPastTheCollisionGuardWhenTheJailIsFree(t *testing.T) {
	lc, base, marker := collisionLauncher(t)

	// Same jail layout as the occupied case, minus the listener — so the ONLY
	// difference between the two arms is the property under test (discipline #1c),
	// not the label on it.
	jailRoot := filepath.Join(base, "firecracker", "vm-6", "root")
	if err := os.MkdirAll(filepath.Join(jailRoot, "run"), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	_, err := lc.Restore(context.Background(), RestoreRequest{
		ID: "vm-6", Key: "run-a", WorkspaceDir: t.TempDir(), GuestRAMBytes: 256 << 20,
	})
	if err == nil {
		t.Fatal("Restore succeeded against a fake jailer and an empty snapshot dir, which cannot happen")
	}
	if strings.Contains(err.Error(), "already holds") {
		t.Fatalf("the collision guard fired on a FREE jail, so it would refuse every restore: %v", err)
	}
	// Reaching the hardlink step (or jailer itself) is what proves the guard did not
	// fire. The snapshot dir is empty, so this restore dies on the first hardlink,
	// before jailer — assert on the error's identity rather than on the marker.
	if !strings.Contains(err.Error(), "hardlink") {
		t.Errorf("expected a free jail to fail at the hardlink step, past the guard; got: %v", err)
	}
	_ = marker
}

// #255's failure path, now under #258's pooling. cleanup() runs after cmd.Start(), so a sockwait
// timeout or a failed LoadSnapshot reaches it with a cgroup already acquired -- and every replenish
// retry draws a FRESH id, so what used to leak here was unbounded. Pooling removes that leak by
// construction: there is nothing per-VM to leak, and the only requirement is that a failed restore
// RETURNS its cgroup rather than stranding it.
//
// Driven through the REAL path: the fake jailer exits 0 without ever creating the API socket, so
// Restore reaches waitForUnixSocket, and a cancelled context makes that return in ~20 ms instead of
// its 5 s timeout. opts.cgroupRoot points the pool at a temp tree because Cgroup2Root names the
// host's real cgroupfs.
func TestRestoreCleanupReturnsThePooledCgroupOnAFailedRestore(t *testing.T) {
	base := shortdir.New(t, "fccg", len("/firecracker/vm-99999999999999999999/root/run/firecracker.socket"))

	jailer := filepath.Join(base, "jailer")
	if err := os.WriteFile(jailer, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write fake jailer: %v", err)
	}
	cgRoot := filepath.Join(base, "cgroup")
	const parent = "microvm.slice/microvm-vms.slice"
	if err := os.MkdirAll(filepath.Join(cgRoot, parent), 0o755); err != nil {
		t.Fatal(err)
	}
	lc, err := NewFirecrackerLauncher(FirecrackerOptions{
		JailerBin:            jailer,
		FirecrackerBin:       filepath.Join(base, "firecracker"),
		ChrootBase:           base,
		SnapshotDir:          base,
		ParentCgroup:         parent,
		CgroupMemoryMaxBytes: 256 << 20,
		cgroupRoot:           cgRoot,
	})
	if err != nil {
		t.Fatalf("NewFirecrackerLauncher: %v", err)
	}
	pool := lc.(*firecrackerLauncher).cgroups
	if pool == nil {
		t.Fatal("launcher built no cgroup pool despite a ParentCgroup")
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	if _, err := lc.Restore(ctx, RestoreRequest{
		ID: "vm-42", Key: "run-a", WorkspaceDir: t.TempDir(), GuestRAMBytes: 256 << 20,
	}); err == nil {
		t.Fatal("Restore succeeded against a jailer that never creates an API socket")
	}

	// The whole property: the cgroup is back for reuse, not stranded.
	if pool.idle() != 1 {
		t.Fatalf("after a failed restore the pool holds %d idle cgroups, want 1 -- cleanup() "+
			"stranded it, which is the unbounded leak #255 found on this path", pool.idle())
	}
	if pool.mintedCount() != 1 {
		t.Fatalf("minted %d cgroups for one attempt", pool.mintedCount())
	}
	// And the next attempt reuses it rather than minting.
	if _, err := pool.acquire(); err != nil {
		t.Fatalf("acquire after a failed restore: %v", err)
	}
	if pool.mintedCount() != 1 {
		t.Fatalf("minted=%d; the returned cgroup should have been reused", pool.mintedCount())
	}
}
